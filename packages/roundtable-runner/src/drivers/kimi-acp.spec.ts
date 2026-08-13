/**
 * KimiAcpDriver 测试（假 stdio 子进程按录制 NDJSON fixture 应答）
 *
 * 覆盖：initialize/new/resume/prompt 全链路、单飞行 busy、流式 chunk、审批挂起+应答、
 * usage、畸形响应、silent 判定、tool_event、权限模式钉死、不声明 fs caps、cancel/stop。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SeatConfig, SeatEvent } from '@agent-chamber/roundtable-protocol';
import { BusyError } from './seat-driver';
import { KimiAcpDriver, MalformedResponseError } from './kimi-acp';
import { NoopLogger } from '../logger';

/** 假 ACP 子进程脚本（ts-jest 内存编译，__dirname 保持源码相对路径） */
const FAKE_ACP_SCRIPT = path.resolve(__dirname, '../__fixtures__/fake-acp.js');

/** 测试座位配置 */
const CONFIG: SeatConfig = {
  seatId: 'seat-1',
  label: 'kimi-1',
  vendor: 'kimi',
  cwd: '/tmp/roundtable-runner-test',
  permissionMode: 'auto',
};

/** 流式文本块通知（agent → client） */
function chunkNotification(text: string): Record<string, unknown> {
  return {
    method: 'session/update',
    params: {
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  };
}

/** initialize 成功响应 */
const INIT_RESPOND = {
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'kimi', version: '0.34.0' },
    authMethods: [],
    agentCapabilities: {},
  },
};

/** set_config_option 成功响应 */
const CONFIG_RESPOND = { result: {} };

/** 测试夹具：临时目录 + fixture 文件 + requestsLog + driver 实例 */
interface Harness {
  dir: string;
  fixturePath: string;
  logPath: string;
  driver: KimiAcpDriver;
  events: SeatEvent[];
  /** onSessionId 落盘回调收到的 sessionId 序列（断言 resume/new 后落盘值用） */
  sessionIds: string[];
  setFixture(entries: unknown[]): void;
  getLog(): Array<{ direction: string; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }>;
}

/** 全部测试创建的 driver（afterEach 统一 stop，杀子进程防 jest worker 泄漏） */
const createdDrivers: KimiAcpDriver[] = [];

function makeHarness(
  options: { persistedSessionId?: string; model?: string; cancelKillTimeoutMs?: number } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-spec-'));
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'requests.json');
  const events: SeatEvent[] = [];
  const sessionIds: string[] = [];
  const driver = new KimiAcpDriver({
    bin: process.execPath,
    spawnArgs: [FAKE_ACP_SCRIPT, fixturePath, logPath],
    getSessionId: () => options.persistedSessionId,
    onSessionId: (_seatId: string, sessionId: string) => {
      sessionIds.push(sessionId);
    },
    logger: new NoopLogger(),
    cancelKillTimeoutMs: options.cancelKillTimeoutMs,
  });
  createdDrivers.push(driver);
  driver.onEvent((event) => events.push(event));
  return {
    dir,
    fixturePath,
    logPath,
    driver,
    events,
    sessionIds,
    setFixture(entries: unknown[]) {
      fs.writeFileSync(fixturePath, JSON.stringify(entries));
    },
    getLog() {
      return JSON.parse(fs.readFileSync(logPath, 'utf8'));
    },
  };
}

/** 标准 start 前置 fixture（initialize + session/new + set mode + 可选 model） */
function startFixture(extra: unknown[] = []): unknown[] {
  return [
    { respond: INIT_RESPOND },
    { respond: { result: { sessionId: 'sess-1' } } }, // session/new
    { respond: CONFIG_RESPOND }, // set_config_option mode
    ...extra,
  ];
}

/** 等待事件出现（超时 3s） */
function waitForEvent(
  events: SeatEvent[],
  predicate: (e: SeatEvent) => boolean,
  timeoutMs = 3000,
): Promise<SeatEvent> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout waiting for event'));
      }
    }, 10);
  });
}

/** 轮询等待条件成立（fake 异步处理竞态窗口用） */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timeout');
    }
    await delay(10);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  // 清理全部残留 fake-acp 子进程（部分用例未显式 stop，防 jest worker 无法退出）
  for (const driver of createdDrivers) {
    try {
      await driver.stopAll();
    } catch {
      // 清理失败不阻断测试结果
    }
  }
  jest.restoreAllMocks();
});

describe('KimiAcpDriver 全链路（initialize/new/prompt/流式）', () => {
  it('start → inject：status online → message_chunk → message_complete（end_turn, silent=false）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [chunkNotification('Hello '), chunkNotification('world')],
          respond: { result: { stopReason: 'end_turn' } }, // session/prompt
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    expect(h.events).toContainEqual({ type: 'status', seatId: 'seat-1', status: 'online' });

    const completePromise = waitForEvent(h.events, (e) => e.type === 'message_complete');
    await h.driver.inject('seat-1', { text: '第一轮问题' });
    const complete = (await completePromise) as Extract<SeatEvent, { type: 'message_complete' }>;
    expect(complete).toMatchObject({ seatId: 'seat-1', stopReason: 'end_turn' });
    expect(complete.silent).toBe(false);
    // complete 携带本侧累积全文（chamber 重启清空 chunk buffer 后仍能落库）
    expect(complete.text).toBe('Hello world');

    // 事件顺序：chunk 在 complete 之前
    const chunkIdx = h.events.findIndex((e) => e.type === 'message_chunk' && e.text === 'Hello ');
    const completeIdx = h.events.findIndex((e) => e.type === 'message_complete');
    expect(chunkIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(chunkIdx);
    // 流式文本拼装完整
    const chunks = h.events.filter((e) => e.type === 'message_chunk') as Extract<SeatEvent, { type: 'message_chunk' }>[];
    expect(chunks.map((c) => c.text).join('')).toBe('Hello world');
  });

  it('initialize 不声明 fs caps（行为档案 #4），clientInfo 正确', async () => {
    const h = makeHarness();
    h.setFixture(startFixture([{ emit: [chunkNotification('ok')], respond: { result: { stopReason: 'end_turn' } } }]));
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const initReq = h.getLog().find((r) => r.method === 'initialize');
    expect(initReq).toBeDefined();
    const caps = initReq!.params!.clientCapabilities as Record<string, unknown>;
    expect('fs' in caps).toBe(false);
    expect(caps.terminal).toBe(false);
    expect(initReq!.params!.clientInfo).toMatchObject({ name: 'agent-chamber-roundtable-runner' });
  });

  it('session/new 参数：cwd 透传座位工作目录（座位环境边界）', async () => {
    const h = makeHarness();
    h.setFixture(startFixture([{ emit: [chunkNotification('ok')], respond: { result: { stopReason: 'end_turn' } } }]));
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const newReq = h.getLog().find((r) => r.method === 'session/new');
    expect(newReq!.params).toMatchObject({ cwd: CONFIG.cwd, mcpServers: [] });
  });

  it('权限模式钉死（行为档案 #5）：set_config_option mode=座位 permissionMode；model 可选覆盖（档案 #6）', async () => {
    const h = makeHarness({ model: 'kimi-k2' });
    // model 配置时 start 会多一个 set_config_option model 请求，fixture 需对应条目
    h.setFixture([
      ...startFixture([
        { respond: CONFIG_RESPOND }, // set_config_option model
        { emit: [chunkNotification('ok')], respond: { result: { stopReason: 'end_turn' } } },
      ]),
    ]);
    await h.driver.start({ ...CONFIG, model: 'kimi-k2' });
    await h.driver.inject('seat-1', { text: 'x' });
    const log = h.getLog();
    const modeReq = log.find((r) => r.method === 'session/set_config_option' && r.params!.configId === 'mode');
    expect(modeReq!.params!.value).toBe('auto');
    const modelReq = log.find((r) => r.method === 'session/set_config_option' && r.params!.configId === 'model');
    expect(modelReq!.params!.value).toBe('kimi-k2');
  });
});

describe('KimiAcpDriver resume 复活（行为档案 #1）', () => {
  it('有落盘 sessionId → session/resume 而非 session/new，sessionId 透传', async () => {
    const h = makeHarness({ persistedSessionId: 'sess-old' });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { result: { sessionId: 'sess-old' } } }, // session/resume
      { respond: CONFIG_RESPOND },
      { respond: { result: { stopReason: 'end_turn' } } },
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: '追问' });
    const log = h.getLog();
    expect(log.some((r) => r.method === 'session/new')).toBe(false);
    const resumeReq = log.find((r) => r.method === 'session/resume');
    expect(resumeReq!.params).toMatchObject({ sessionId: 'sess-old', cwd: CONFIG.cwd });
  });

  it('start 幂等：二次 start 复用活跃会话（不重复 spawn/initialize）', async () => {
    const h = makeHarness();
    h.setFixture(startFixture([{ respond: { result: { stopReason: 'end_turn' } } }]));
    await h.driver.start(CONFIG);
    await h.driver.start(CONFIG);
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'initialize')).toHaveLength(1);
  });

  it('inject 时座位无活进程（cancel 超时兜底 kill 后）→ 自动 spawn + resume 复活（叫醒语义）', async () => {
    const h = makeHarness({ persistedSessionId: 'sess-old', cancelKillTimeoutMs: 100 });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { result: { sessionId: 'sess-old' } } }, // 第一次 resume
      { respond: CONFIG_RESPOND },
      { respond: { result: { stopReason: 'end_turn' } } }, // prompt #1
      { emit: [chunkNotification('第二轮…')] }, // prompt #2 在途（挂起不应答）
      { emit: [] }, // session/cancel 通知占位（fixture 按请求序号消费，通知也占条目）
      { respond: INIT_RESPOND }, // 复活后的第三轮
      { respond: { result: { sessionId: 'sess-old' } } },
      { respond: CONFIG_RESPOND },
      { respond: { result: { stopReason: 'end_turn' } } },
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: '第一轮' });
    // 第二轮在途 → cancel：优雅通知无响应，超时兜底 kill（优雅取消的防御分支）
    const p2 = h.driver.inject('seat-1', { text: '第二轮' });
    // 立即挂拒绝处理器：拒绝发生在 cancel 兜底 kill 之后，迟挂会触发 jest unhandled rejection
    const p2Err = p2.then(
      () => null,
      (err: unknown) => err as Error,
    );
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1');
    const err = await p2Err;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('exited'); // 挂起 turn 因子进程退出而异常终结
    // 子进程已死 → inject 触发重新 spawn + resume
    await h.driver.inject('seat-1', { text: '第三轮' });
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'initialize')).toHaveLength(2);
    expect(log.filter((r) => r.method === 'session/resume')).toHaveLength(2);
  });

  it('resume 失败（缓存 sessionId 失效）→ 降级 session/new，落盘新 id + warn 日志', async () => {
    const warnSpy = jest.spyOn(NoopLogger.prototype, 'warn').mockImplementation(() => {});
    const h = makeHarness({ persistedSessionId: 'sess-stale' });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { error: { code: -32602, message: 'session not found' } } }, // session/resume 失败
      { respond: { result: { sessionId: 'sess-new' } } }, // 降级 session/new
      { respond: CONFIG_RESPOND },
      { respond: { result: { stopReason: 'end_turn' } } },
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const log = h.getLog();
    // 先 resume 后 new（回退顺序：不因 resume 失败而放弃该座位）
    expect(log.filter((r) => r.method === 'session/resume')).toHaveLength(1);
    expect(log.filter((r) => r.method === 'session/new')).toHaveLength(1);
    const resumeReq = log.find((r) => r.method === 'session/resume');
    expect(resumeReq!.params).toMatchObject({ sessionId: 'sess-stale' });
    // 落盘的是新 id（覆盖失效旧 id）
    expect(h.sessionIds).toEqual(['sess-new']);
    // resume 失败有 warn：说明降级 + 原 sessionId + 错误信息
    expect(warnSpy).toHaveBeenCalled();
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('session/resume failed'))).toBe(true);
    expect(warnCalls.some((m) => m.includes('sess-stale'))).toBe(true);
  });
});

describe('KimiAcpDriver 单飞行（per-seat）', () => {
  it('busy 期间并发 inject 抛 BusyError；turn 结束后可再注入', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        { respond: { result: { stopReason: 'end_turn' } } }, // prompt #1（a：第一轮完成）
        { emit: [chunkNotification('b-start')] }, // prompt #2（b：只 emit 不 respond → 挂起）
        { respond: { result: { stopReason: 'end_turn' } } }, // prompt #3（d：b 停止后新进程用）
      ]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'a' }); // 第一轮完成
    // b 挂起期间并发注入 → BusyError（单飞行）
    const p1 = h.driver.inject('seat-1', { text: 'b' });
    await waitForEvent(
      h.events,
      (e) => e.type === 'status' && (e as Extract<SeatEvent, { type: 'status' }>).status === 'busy',
    );
    await expect(h.driver.inject('seat-1', { text: 'c' })).rejects.toBeInstanceOf(BusyError);
    // 收尾：杀进程释放 b 的挂起；然后新进程上可再注入（busy 已释放语义由畸形测试覆盖）
    await h.driver.stop('seat-1');
    await expect(p1).rejects.toThrow('exited');
    const completes = h.events.filter((e) => e.type === 'message_complete');
    expect(completes).toHaveLength(2); // a 完成 + b 异常终结
  });
});

describe('KimiAcpDriver 审批（行为档案 #2）', () => {
  const PERMISSION_EMIT = {
    jsonrpc: '2.0',
    id: 9001,
    method: 'session/request_permission',
    params: {
      toolCall: { id: 'tc-1', title: 'run 危险命令', status: 'pending' },
      // 真机形状（RT-PERM-1）：ACP 真实 kind（allow_*），平台 optionId（approve_*/reject）
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    },
  };

  it('request_permission → permission_request 事件（挂起不自动应答）→ answerPermission 按 optionId 精确匹配应答', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [PERMISSION_EMIT],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    const injectPromise = h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.requestId).toBe('9001');
    expect(perm.tool).toMatchObject({ id: 'tc-1' });
    expect(perm.options).toHaveLength(3);
    // 挂起：未应答前 prompt 不应完成（应答后才 end_turn）
    await h.driver.answerPermission('seat-1', '9001', 'approve_always');
    await injectPromise;
    // fake 处理应答是异步的（stdin/stdout 竞态窗口），轮询等待应答记录
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 9001));
    const response = h.getLog().find((r) => r.direction === 'response' && r.id === 9001);
    // 命中 ACP 选项（kind=allow_always 不参与匹配，optionId 精确命中）
    expect(response!.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'approve_always' },
    });
  });

  it('optionId 精确匹配：reject → reject 选项；未命中 optionId 回 cancelled（RT-PERM-1）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [PERMISSION_EMIT],
          respond: { result: { stopReason: 'end_turn' } },
        },
        {
          // turn 2：新审批请求（id 9002），用于 cancelled 分支（挂起表独立）
          emit: [{ ...PERMISSION_EMIT, id: 9002 }],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);

    // turn 1：reject 按 optionId 精确命中（ACP kind=reject_once 不参与匹配）
    const permPromise1 = waitForEvent(h.events, (e) => e.type === 'permission_request');
    const injectPromise1 = h.driver.inject('seat-1', { text: '跑一下' });
    await permPromise1;
    await h.driver.answerPermission('seat-1', '9001', 'reject');
    await injectPromise1;
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 9001));
    expect(h.getLog().find((r) => r.direction === 'response' && r.id === 9001)!.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });

    // turn 2：optionId 未命中挂起选项 → cancelled（不选任何选项）+ warn
    const warnSpy = jest.spyOn(NoopLogger.prototype, 'warn').mockImplementation(() => {});
    const permPromise2 = waitForEvent(
      h.events,
      (e) =>
        e.type === 'permission_request' &&
        (e as Extract<SeatEvent, { type: 'permission_request' }>).requestId === '9002',
    );
    const injectPromise2 = h.driver.inject('seat-1', { text: '再跑一下' });
    await permPromise2;
    await h.driver.answerPermission('seat-1', '9002', 'no-such-option');
    await injectPromise2;
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 9002));
    expect(h.getLog().find((r) => r.direction === 'response' && r.id === 9002)!.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('optionId no-such-option')),
    ).toBe(true);

    // 未知 requestId（审批已关闭）：幂等忽略不抛错
    await expect(
      h.driver.answerPermission('seat-1', '9999', 'approve_once'),
    ).resolves.toBeUndefined();
  });
});

describe('KimiAcpDriver toolMeta 缓存补全（M4b-1 ②：request_permission 缺 title → 查缓存补缺省，只补不覆盖）', () => {
  /** 无 title 的审批载荷（codex 真机形状：仅 {kind,status,toolCallId}——DB 实测；基座同一修复路径） */
  function permissionEmit(toolCall: Record<string, unknown>, id: number): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        toolCall,
        options: [{ optionId: 'approve_once', kind: 'allow_once' }],
      },
    };
  }

  /** tool_call 通知（toolMeta 缓存写入源：toolCallId+title 在 update 本体，RT-PERM-2） */
  function toolCallNotification(toolCallId: string, title: string): Record<string, unknown> {
    return {
      method: 'session/update',
      params: {
        update: { sessionUpdate: 'tool_call', toolCallId, title, kind: 'bash', status: 'pending' },
      },
    };
  }

  it('先 tool_call（toolCallId+title）后 request_permission（同 id 无 title）→ permission_request.tool.title 已补', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [
            toolCallNotification('tc-1', 'ls'),
            permissionEmit({ toolCallId: 'tc-1', kind: 'bash', status: 'pending' }, 9001),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.tool).toMatchObject({ toolCallId: 'tc-1', title: 'ls' });
  });

  it('缓存 miss（前置无 tool_call）→ tool 原样透传不崩（重启/resume 后优雅降级为现状）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [permissionEmit({ toolCallId: 'tc-unknown', status: 'pending' }, 9002)],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.tool).toEqual({ toolCallId: 'tc-unknown', status: 'pending' });
  });

  it('自带 title → 不被缓存值覆盖（只补缺省不覆盖，kimi 路径零影响）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [
            toolCallNotification('tc-1', 'ls'), // 缓存里有冲突 title
            permissionEmit({ toolCallId: 'tc-1', title: 'run 危险命令', status: 'pending' }, 9003),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.tool).toMatchObject({ toolCallId: 'tc-1', title: 'run 危险命令' });
  });

  it('cap 100：第 101 条 tool_call 淘汰最旧键（tc-0 不再补全，tc-100 正常补全）', async () => {
    const h = makeHarness();
    const calls: Record<string, unknown>[] = [];
    for (let i = 0; i < 101; i++) {
      calls.push(toolCallNotification(`tc-${i}`, `tool-${i}`));
    }
    calls.push(permissionEmit({ toolCallId: 'tc-0', status: 'pending' }, 9100)); // 最旧：已被淘汰
    calls.push(permissionEmit({ toolCallId: 'tc-100', status: 'pending' }, 9101)); // 最新：仍在缓存
    h.setFixture([
      ...startFixture([
        {
          emit: calls,
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    const permPromise = waitForEvent(
      h.events,
      (e) =>
        e.type === 'permission_request' &&
        (e as Extract<SeatEvent, { type: 'permission_request' }>).requestId === '9100',
    );
    await h.driver.inject('seat-1', { text: '跑一下' });
    await permPromise;
    await waitFor(() => h.events.filter((e) => e.type === 'permission_request').length >= 2);
    const perms = h.events.filter((e) => e.type === 'permission_request') as Array<
      Extract<SeatEvent, { type: 'permission_request' }>
    >;
    expect(perms[0].requestId).toBe('9100');
    expect(perms[0].tool).toEqual({ toolCallId: 'tc-0', status: 'pending' }); // 最旧键已淘汰：不补
    expect(perms[1].requestId).toBe('9101');
    expect(perms[1].tool).toMatchObject({ toolCallId: 'tc-100', title: 'tool-100' }); // 最新键在缓存内：补全
  });
});

describe('KimiAcpDriver usage / tool_event（行为档案 #3）', () => {
  it('usage_update 通知 → usage 事件（used/size 宽松读取：嵌套 usage 与直挂均支持）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [
            {
              method: 'usage_update',
              params: { sessionId: 'sess-1', usage: { used: 1234, size: 64000 } },
            },
            chunkNotification('done'),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    expect(h.events).toContainEqual({ type: 'usage', seatId: 'seat-1', used: 1234, size: 64000 });
  });

  it('tool_call 流式块 → tool_event 事件（RT-PERM-2：元数据在 update 本体，content 是内容块数组）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [
            {
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'tc-9',
                  title: 'ls',
                  kind: 'bash',
                  status: 'pending',
                  locations: ['/tmp'],
                  rawInput: { command: 'ls' },
                  content: [{ type: 'text', text: '运行 ls' }],
                },
              },
            },
            chunkNotification('ok'),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    // 载荷 = 整个 update 对象（工具元数据在本体，content 是内容块数组原样透传）
    expect(h.events).toContainEqual({
      type: 'tool_event',
      seatId: 'seat-1',
      tool: {
        toolCallId: 'tc-9',
        title: 'ls',
        kind: 'bash',
        status: 'pending',
        locations: ['/tmp'],
        rawInput: { command: 'ls' },
        content: [{ type: 'text', text: '运行 ls' }],
      },
    });
    // sessionUpdate 键已剥离（透传前浅拷贝 delete），不进载荷
    const toolEvent = h.events.find((e) => e.type === 'tool_event') as Extract<
      SeatEvent,
      { type: 'tool_event' }
    >;
    expect(toolEvent.tool).not.toHaveProperty('sessionUpdate');
  });
});

describe('KimiAcpDriver seat_info（M3 阶段 5：实际在跑配置观测上行）', () => {
  it('session/new 响应 configOptions（数组形态）→ seat_info 带 model/thinking；mode 以钉死值上报（档案 #5 泄漏展示值不误报）', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            configOptions: [
              { configId: 'model', value: 'kimi-k2' },
              { configId: 'thinking', value: 'high' },
              { configId: 'mode', value: 'default' }, // config.toml 泄漏展示值（档案 #5）
            ],
          },
        },
      },
      { respond: CONFIG_RESPOND }, // set_config_option mode
    ]);
    await h.driver.start(CONFIG); // permissionMode='auto'
    expect(h.events).toContainEqual({
      type: 'seat_info',
      seatId: 'seat-1',
      model: 'kimi-k2',
      thinking: 'high',
      mode: 'auto', // 钉死值优先：泄漏展示值 default 不上报
    });
  });

  it('session/new 响应 configOptions（对象形态 value/current 键）→ 同样解析', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            configOptions: {
              model: { value: 'kimi-k2', choices: ['kimi-k2', 'kimi-k2-thinking'] },
              thinking: { value: 'max' },
              mode: { current: 'auto' },
            },
          },
        },
      },
      { respond: CONFIG_RESPOND },
    ]);
    await h.driver.start(CONFIG);
    expect(h.events).toContainEqual({
      type: 'seat_info',
      seatId: 'seat-1',
      model: 'kimi-k2',
      thinking: 'max',
      mode: 'auto',
    });
  });

  it('session/new 无 configOptions（fixture 现状）→ 防御性缺省：seat_info 仅 mode=钉死值，model/thinking 缺省不出现', async () => {
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(CONFIG);
    expect(h.events).toContainEqual({ type: 'seat_info', seatId: 'seat-1', mode: 'auto' });
  });

  it('seat.assign 显式 model → model 上行用钉死值（set_config_option 后实际在跑）', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            configOptions: [
              { configId: 'model', value: 'kimi-default' },
              { configId: 'thinking', value: 'high' },
            ],
          },
        },
      },
      { respond: CONFIG_RESPOND }, // mode
      { respond: CONFIG_RESPOND }, // model
    ]);
    await h.driver.start({ ...CONFIG, model: 'kimi-k2' });
    expect(h.events).toContainEqual({
      type: 'seat_info',
      seatId: 'seat-1',
      model: 'kimi-k2', // 钉死值优先于 configOptions 展示值
      thinking: 'high',
      mode: 'auto',
    });
  });

  it('resume 路径：session/resume 响应 configOptions → seat_info 上行同样覆盖', async () => {
    const h = makeHarness({ persistedSessionId: 'sess-old' });
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-old',
            configOptions: [
              { configId: 'model', value: 'kimi-r1' },
              { configId: 'thinking', value: 'low' },
            ],
          },
        },
      },
      { respond: CONFIG_RESPOND },
    ]);
    await h.driver.start(CONFIG);
    expect(h.events).toContainEqual({
      type: 'seat_info',
      seatId: 'seat-1',
      model: 'kimi-r1',
      thinking: 'low',
      mode: 'auto',
    });
  });

  it('current_mode_update 通知（configId+value 形态）→ 热更新：再上行一次 seat_info，mode 用确认值', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [
            { method: 'current_mode_update', params: { sessionId: 'sess-1', configId: 'mode', value: 'yolo' } },
            chunkNotification('ok'),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    const hotPromise = waitForEvent(
      h.events,
      (e) =>
        e.type === 'seat_info' &&
        (e as Extract<SeatEvent, { type: 'seat_info' }>).mode === 'yolo',
    );
    await h.driver.inject('seat-1', { text: 'x' });
    const hot = (await hotPromise) as Extract<SeatEvent, { type: 'seat_info' }>;
    expect(hot).toMatchObject({ seatId: 'seat-1', mode: 'yolo' });
  });

  it('current_mode_update 载荷不可解析 mode → 不触发 seat_info（仅日志），只保留初始上报', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [
            { method: 'current_mode_update', params: { sessionId: 'sess-1' } },
            chunkNotification('ok'),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const infos = h.events.filter((e) => e.type === 'seat_info');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ seatId: 'seat-1', mode: 'auto' });
  });
});

describe('KimiAcpDriver 畸形响应 / 异常路径', () => {
  it('畸形响应（无 result 无 error）→ inject 拒绝 MalformedResponseError + message_complete(stopReason=error) 释放单飞行', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        { respond: {} }, // 畸形响应（行为档案 #4 的 wire 表现）
        { emit: [chunkNotification('ok')], respond: { result: { stopReason: 'end_turn' } } }, // 恢复后正常注入
      ]),
    ]);
    await h.driver.start(CONFIG);
    await expect(h.driver.inject('seat-1', { text: 'x' })).rejects.toBeInstanceOf(
      MalformedResponseError,
    );
    expect(h.events).toContainEqual({
      type: 'message_complete',
      seatId: 'seat-1',
      stopReason: 'error',
    });
    // 单飞行已释放：可再注入
    await h.driver.inject('seat-1', { text: 'y' });
    const completes = h.events.filter((e) => e.type === 'message_complete');
    expect(completes).toHaveLength(2);
  });

  it('子进程中途退出 → pending 拒绝 + status offline', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([{ emit: [chunkNotification('part')] }]), // prompt 挂起（无 respond）
    ]);
    await h.driver.start(CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: 'x' });
    await delay(100);
    await h.driver.stop('seat-1'); // 杀子进程 → pending reject
    await expect(injectPromise).rejects.toThrow('exited');
    expect(h.events).toContainEqual({
      type: 'message_complete',
      seatId: 'seat-1',
      stopReason: 'error',
    });
    expect(h.events).toContainEqual({
      type: 'status',
      seatId: 'seat-1',
      status: 'offline',
      detail: 'kimi acp exited',
    });
  });

  it('kimi 二进制不存在 → start 拒绝（spawn error 不挂起）', async () => {
    const h = makeHarness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-acp-fail-'));
    const driver = new KimiAcpDriver({
      bin: '/nonexistent/kimi-binary-xyz',
      spawnArgs: [],
      logger: new NoopLogger(),
    });
    await expect(driver.start(CONFIG)).rejects.toThrow('spawn failed');
    expect(fs.existsSync(dir)).toBe(true); // 仅保证 fixture 目录用法一致（占位断言）
  });
});

describe('KimiAcpDriver 沉默判定（§3/§4 r3 冻结）', () => {
  it('全文仅 {"silent": true}（带空白）→ message_complete silent=true', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [chunkNotification(' {"silent": '), chunkNotification('true} \n')],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const complete = h.events.find((e) => e.type === 'message_complete') as Extract<
      SeatEvent,
      { type: 'message_complete' }
    >;
    expect(complete.silent).toBe(true);
  });

  it('正文里藏 JSON（非整体可 parse）→ 不判定沉默', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        {
          emit: [chunkNotification('好的，已处理。参考: {"silent": true}')],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const complete = h.events.find((e) => e.type === 'message_complete') as Extract<
      SeatEvent,
      { type: 'message_complete' }
    >;
    expect(complete.silent).toBe(false);
  });
});

describe('KimiAcpDriver stop/cancel', () => {
  it('stop：杀子进程 + status offline；再 start 重新拉起（新会话）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([{ respond: { result: { stopReason: 'end_turn' } } }]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.stop('seat-1');
    expect(h.events).toContainEqual({ type: 'status', seatId: 'seat-1', status: 'offline' });
    // 停止后重新 start（本次无落盘 sessionId → session/new）
    h.setFixture([
      ...startFixture([{ respond: { result: { stopReason: 'end_turn' } } }]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    expect(h.getLog().filter((r) => r.method === 'session/new')).toHaveLength(2);
  });

  it('未知 seatId 的 stop/cancel：幂等不抛错', async () => {
    const h = makeHarness();
    await expect(h.driver.stop('unknown-seat')).resolves.toBeUndefined();
    await expect(h.driver.cancel('unknown-seat')).resolves.toBeUndefined();
  });
});

describe('KimiAcpDriver 优雅取消（M4b-1：session/cancel 通知 + 超时兜底 kill）', () => {
  // 挂起审批形状（kimi 真机：反向 RPC id 大整数 + kind=allow_*，optionId 才是稳定键）
  const PERMISSION_EMIT = {
    jsonrpc: '2.0',
    id: 9001,
    method: 'session/request_permission',
    params: {
      toolCall: { id: 'tc-1', title: 'run 危险命令', status: 'pending' },
      options: [
        { optionId: 'approve_once', kind: 'allow_once' },
        { optionId: 'approve_always', kind: 'allow_always' },
        { optionId: 'reject', kind: 'reject_once' },
      ],
    },
  };

  it('in-flight cancel：session/cancel 通知（无 id）→ prompt resolve cancelled（单条 message_complete，会话存活续聊）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 500 });
    h.setFixture([
      ...startFixture([
        {
          emit: [chunkNotification('数到一半…')],
          respond: { result: { stopReason: 'cancelled' } },
          delayMs: 150, // prompt 在途：cancel 通知到达后延迟 resolve cancelled
        },
        { emit: [] }, // session/cancel 通知占位（fixture 按请求序号消费，通知也占条目）
        { respond: { result: { stopReason: 'end_turn' } } }, // 续聊第二轮
      ]),
    ]);
    await h.driver.start(CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: '数到 100' });
    // 等 turn 在途（chunk 上行）→ 发 cancel
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1');
    await injectPromise;
    // 事件序列：仅单条 message_complete(stopReason=cancelled)，无 kill 级联（无 offline）
    const completes = h.events.filter((e) => e.type === 'message_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ seatId: 'seat-1', stopReason: 'cancelled' });
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ type: 'status', status: 'offline' }),
    );
    // 通知已发出：method=session/cancel、载荷带 sessionId、无 id（通知语义）
    const cancelReq = h.getLog().find((r) => r.method === 'session/cancel');
    expect(cancelReq).toBeDefined();
    expect(cancelReq!.params).toEqual({ sessionId: 'sess-1' });
    expect(cancelReq!.id).toBeUndefined();
    // 会话存活：cancel 后可再注入（第二轮正常 end_turn）
    await h.driver.inject('seat-1', { text: '续聊' });
    const completes2 = h.events.filter((e) => e.type === 'message_complete');
    expect(completes2).toHaveLength(2);
    expect(completes2[1]).toMatchObject({ stopReason: 'end_turn' });
  });

  it('空闲取消（busy=false）→ 幂等 no-op：不发通知、不 kill、会话存活（R1 busy 门控）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 100 });
    h.setFixture([
      ...startFixture([{ respond: { result: { stopReason: 'end_turn' } } }]),
    ]);
    await h.driver.start(CONFIG);
    await h.driver.cancel('seat-1'); // 无 in-flight prompt → 直接返回
    // 等待超过兜底超时：确认未触发任何 kill（busy 门控禁止 kill 空闲会话）
    await delay(150);
    expect(h.getLog().some((r) => r.method === 'session/cancel')).toBe(false);
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ type: 'status', status: 'offline' }),
    );
    // 会话存活：可正常注入（同一子进程，无重新 spawn）
    await h.driver.inject('seat-1', { text: 'x' });
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'initialize')).toHaveLength(1);
    expect(log.filter((r) => r.method === 'session/new')).toHaveLength(1);
  });

  it('cancel 后 agent 在超时前自然 end_turn → 不触发兜底 kill（R2：resolve 已清超时句柄）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 200 });
    h.setFixture([
      ...startFixture([
        {
          emit: [chunkNotification('快完成了…')],
          respond: { result: { stopReason: 'end_turn' } }, // 忽略 cancel，自然收尾
          delayMs: 100, // 100ms < 200ms 兜底超时：不 kill
        },
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: 'x' });
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1'); // 等 turn resolve → 清超时器 → 返回
    await injectPromise;
    const completes = h.events.filter((e) => e.type === 'message_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ stopReason: 'end_turn' });
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ type: 'status', status: 'offline' }),
    );
  });

  it('10s 兜底：cancel 后 agent 无响应 → kill（offline cancelled + 挂起 turn 异常终结）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 100 });
    h.setFixture([
      ...startFixture([
        { emit: [chunkNotification('卡住了…')] }, // prompt 挂起（不应答）
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: 'x' });
    // 立即挂拒绝处理器：拒绝发生在 cancel 兜底 kill 之后，迟挂会触发 jest unhandled rejection
    const rejection = injectPromise.then(
      () => null,
      (err: unknown) => err as Error,
    );
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1');
    // 兜底 kill：offline(cancelled) 上行（触发前再查 busy——turn 仍挂起，命中）
    const offlineEvent = await waitForEvent(
      h.events,
      (e) =>
        e.type === 'status' &&
        (e as Extract<SeatEvent, { type: 'status' }>).status === 'offline' &&
        (e as Extract<SeatEvent, { type: 'status' }>).detail === 'cancelled',
    );
    expect(offlineEvent).toMatchObject({ seatId: 'seat-1' });
    // 挂起的 prompt 因子进程被杀而异常终结（既有 kill 级联语义：complete(error)）
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('exited');
    expect(h.events).toContainEqual({
      type: 'message_complete',
      seatId: 'seat-1',
      stopReason: 'error',
    });
  });

  it('cancel 时挂起审批逐个应答 Cancelled（ACP 规范 MUST）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 500 });
    h.setFixture([
      ...startFixture([
        {
          emit: [PERMISSION_EMIT],
          respond: { result: { stopReason: 'cancelled' } },
          delayMs: 150,
        },
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    const injectPromise = h.driver.inject('seat-1', { text: '跑一下' });
    await permPromise; // 审批挂起中 → cancel
    await h.driver.cancel('seat-1');
    await injectPromise;
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 9001));
    const response = h.getLog().find((r) => r.direction === 'response' && r.id === 9001);
    expect(response!.result).toEqual({ outcome: { outcome: 'cancelled' } });
    const complete = h.events.find((e) => e.type === 'message_complete');
    expect(complete).toMatchObject({ stopReason: 'cancelled' });
  });

  it('重复 cancel：第二次 no-op（cancelling 幂等，仅一条 session/cancel 通知）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 150 });
    h.setFixture([
      ...startFixture([
        { emit: [chunkNotification('在途…')] }, // prompt 挂起（不应答 → 超时 kill）
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: 'x' });
    // 立即挂拒绝处理器：拒绝发生在 cancel 兜底 kill 之后，迟挂会触发 jest unhandled rejection
    const rejection = injectPromise.then(
      () => null,
      (err: unknown) => err as Error,
    );
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    const first = h.driver.cancel('seat-1');
    const second = h.driver.cancel('seat-1'); // cancelling=true → 立即返回
    await Promise.all([first, second]);
    expect(h.getLog().filter((r) => r.method === 'session/cancel')).toHaveLength(1);
    // 超时兜底照常触发（挂起 turn → kill）
    await waitForEvent(
      h.events,
      (e) =>
        e.type === 'status' &&
        (e as Extract<SeatEvent, { type: 'status' }>).status === 'offline' &&
        (e as Extract<SeatEvent, { type: 'status' }>).detail === 'cancelled',
    );
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('exited');
  });
});
