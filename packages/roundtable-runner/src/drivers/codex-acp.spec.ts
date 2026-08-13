/**
 * CodexAcpDriver 测试（假 stdio 子进程按录制 NDJSON fixture 应答——复用 fake-acp.js harness）
 *
 * 覆盖（plan M4a §4）：spawn env（CODEX_CONFIG 钉死 / CODEX_PATH 探测两分支 R3）、
 * mode 四档映射 set_config_option 序列（plan 档两条）、model 钉死（quirk②）、
 * seat_info 从 codex configOptions {id,currentValue} 形状解析（thinking←reasoning_effort，R2）、
 * 审批（反向 RPC id 从 0 起 + options 带 _meta）、resume 降级 new、单飞行 busy、
 * 沉默判定、usage。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig, SeatEvent } from '@agent-chamber/roundtable-protocol';
import { BusyError } from './seat-driver';
import { CodexAcpDriver } from './codex-acp';
import { NoopLogger } from '../logger';

/** 假 ACP 子进程脚本（ts-jest 内存编译，__dirname 保持源码相对路径） */
const FAKE_ACP_SCRIPT = path.resolve(__dirname, '../__fixtures__/fake-acp.js');

/** 测试座位配置（vendor=codex，permissionMode=auto） */
const CODEX_CONFIG: SeatConfig = {
  seatId: 'seat-1',
  label: 'codex-1',
  vendor: 'codex',
  cwd: '/tmp/roundtable-runner-codex-test',
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

/** initialize 成功响应（codex 桥实测形状） */
const INIT_RESPOND = {
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'codex', version: '0.147.0' },
    authMethods: [],
    agentCapabilities: {},
  },
};

/** set_config_option 成功响应 */
const CONFIG_RESPOND = { result: {} };

/** 测试夹具：临时目录 + fixture 文件 + requestsLog + driver 实例（codexBin 默认指向假 codex） */
interface Harness {
  dir: string;
  fixturePath: string;
  logPath: string;
  driver: CodexAcpDriver;
  events: SeatEvent[];
  /** onSessionId 落盘回调收到的 sessionId 序列（断言 resume/new 后落盘值用） */
  sessionIds: string[];
  setFixture(entries: unknown[]): void;
  getLog(): Array<{
    direction: string;
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: unknown;
    env?: Record<string, string | null>;
  }>;
}

/** 全部测试创建的 driver（afterEach 统一 stop，杀子进程防 jest worker 泄漏） */
const createdDrivers: CodexAcpDriver[] = [];

/** 原始 PATH（探测分支测试改动后恢复） */
const ORIGINAL_PATH = process.env.PATH;

function makeHarness(
  options: { persistedSessionId?: string; model?: string; codexBin?: string; cancelKillTimeoutMs?: number } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-spec-'));
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'requests.json');
  // 桥 spawn 命令只有脚本一个参数——fixture/log 经 env 传给 fake-acp（FAKE_ACP_FIXTURE/LOG 兜底）
  process.env.FAKE_ACP_FIXTURE = fixturePath;
  process.env.FAKE_ACP_LOG = logPath;
  const events: SeatEvent[] = [];
  const sessionIds: string[] = [];
  // 默认造一个假 codex CLI（shell 空脚本即可——桥 spawn 的是 node fake-acp，
  // CODEX_PATH 只是环境变量，不会被真正执行）
  const codexBin = options.codexBin ?? path.join(dir, 'codex');
  if (!options.codexBin) {
    fs.writeFileSync(codexBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(codexBin, 0o755);
  }
  const driver = new CodexAcpDriver({
    acpBinPath: FAKE_ACP_SCRIPT, // 跳过真实桥 bin 解析（依赖包在 prod 解析）
    codexBin, // 跳过 PATH 探测（探测两分支有专测）
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

/**
 * 标准 start 前置 fixture（initialize + session/new + set mode + 可选 extra）。
 * mode 请求数按档位定：非 plan 一条（mode），plan 两条（mode + collaboration_mode）。
 */
function startFixture(permissionMode: PermissionMode, extra: unknown[] = []): unknown[] {
  return [
    { respond: INIT_RESPOND },
    { respond: { result: { sessionId: 'sess-1' } } }, // session/new
    { respond: CONFIG_RESPOND }, // set_config_option mode
    ...(permissionMode === 'plan' ? [{ respond: CONFIG_RESPOND }] : []), // collaboration_mode
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
  // 探测分支测试改过 PATH：一律恢复（即使用例内 try/finally 失败兜底）
  if (ORIGINAL_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
  jest.restoreAllMocks();
});

describe('CodexAcpDriver 全链路（initialize/new/prompt/流式）', () => {
  it('start → inject：status online → message_chunk → message_complete（end_turn, silent=false）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [chunkNotification('Hello '), chunkNotification('world')],
          respond: { result: { stopReason: 'end_turn' } }, // session/prompt
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    expect(h.events).toContainEqual({ type: 'status', seatId: 'seat-1', status: 'online' });

    const completePromise = waitForEvent(h.events, (e) => e.type === 'message_complete');
    await h.driver.inject('seat-1', { text: '第一轮问题' });
    const complete = (await completePromise) as Extract<SeatEvent, { type: 'message_complete' }>;
    expect(complete).toMatchObject({ seatId: 'seat-1', stopReason: 'end_turn' });
    expect(complete.silent).toBe(false);
    // complete 携带本侧累积全文（chamber 重启清空 chunk buffer 后仍能落库）
    expect(complete.text).toBe('Hello world');

    const chunks = h.events.filter((e) => e.type === 'message_chunk') as Extract<SeatEvent, { type: 'message_chunk' }>[];
    expect(chunks.map((c) => c.text).join('')).toBe('Hello world');
  });

  it('spawn env：CODEX_CONFIG 恒钉死 approvals_reviewer=user；CODEX_PATH 为 PATH 探测到的 codex（探测到分支）', async () => {
    // 不传 codexBin → 走 PATH 探测：临时目录放一个名为 codex 的可执行文件并前置 PATH
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
    const fakeCodex = path.join(binDir, 'codex');
    fs.writeFileSync(fakeCodex, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeCodex, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-probe-'));
      const fixturePath = path.join(dir, 'fixture.json');
      const logPath = path.join(dir, 'requests.json');
      process.env.FAKE_ACP_FIXTURE = fixturePath;
      process.env.FAKE_ACP_LOG = logPath;
      fs.writeFileSync(fixturePath, JSON.stringify(startFixture('auto')));
      const driver = new CodexAcpDriver({
        acpBinPath: FAKE_ACP_SCRIPT,
        getSessionId: () => undefined,
        logger: new NoopLogger(),
      });
      createdDrivers.push(driver);
      await driver.start(CODEX_CONFIG);
      const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      const envEntry = log.find((r: { direction: string }) => r.direction === 'env');
      expect(envEntry!.env.CODEX_CONFIG).toBe('{"approvals_reviewer":"user"}');
      expect(envEntry!.env.CODEX_PATH).toBe(fakeCodex);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('CODEX_PATH 探测不到 → start 失败 detail「codex CLI not found: install + login first」（R3 不静默兜底）', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-nopath-'));
    const oldPath = process.env.PATH;
    process.env.PATH = emptyDir; // PATH 里无 codex
    try {
      const driver = new CodexAcpDriver({
        acpBinPath: FAKE_ACP_SCRIPT,
        getSessionId: () => undefined,
        logger: new NoopLogger(),
      });
      createdDrivers.push(driver);
      await expect(driver.start(CODEX_CONFIG)).rejects.toThrow(
        'codex CLI not found: install + login first',
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('initialize 不声明 fs caps（行为档案 #4 安全线沿用），clientInfo 正确', async () => {
    const h = makeHarness();
    h.setFixture(startFixture('auto', [{ emit: [chunkNotification('ok')], respond: { result: { stopReason: 'end_turn' } } }]));
    await h.driver.start(CODEX_CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const initReq = h.getLog().find((r) => r.method === 'initialize');
    expect(initReq).toBeDefined();
    const caps = initReq!.params!.clientCapabilities as Record<string, unknown>;
    expect('fs' in caps).toBe(false);
    expect(caps.terminal).toBe(false);
    expect(initReq!.params!.clientInfo).toMatchObject({ name: 'agent-chamber-roundtable-runner' });
  });
});

describe('CodexAcpDriver 权限档位映射（mode + collaboration_mode）', () => {
  it.each([
    ['default', [['mode', 'read-only']]],
    ['plan', [['mode', 'read-only'], ['collaboration_mode', 'plan']]],
    ['auto', [['mode', 'agent']]],
    ['yolo', [['mode', 'agent-full-access']]],
  ] as Array<[PermissionMode, Array<[string, string]>]>)(
    '档位 %s → set_config_option 序列 %j（plan 档两条：mode + collaboration_mode）',
    async (permissionMode, expected) => {
      const h = makeHarness();
      h.setFixture(startFixture(permissionMode));
      await h.driver.start({ ...CODEX_CONFIG, permissionMode });
      const log = h.getLog();
      const calls = log
        .filter((r) => r.method === 'session/set_config_option')
        .map((r) => [String(r.params!.configId), String(r.params!.value)]);
      expect(calls).toEqual(expected);
    },
  );

  it('model 钉死（quirk②）：seat.assign model → set_config_option model（如 gpt-5.6-luna）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [{ respond: CONFIG_RESPOND }]), // set_config_option model
    ]);
    await h.driver.start({ ...CODEX_CONFIG, model: 'gpt-5.6-luna' });
    const log = h.getLog();
    const calls = log
      .filter((r) => r.method === 'session/set_config_option')
      .map((r) => [String(r.params!.configId), String(r.params!.value)]);
    expect(calls).toEqual([
      ['mode', 'agent'],
      ['model', 'gpt-5.6-luna'],
    ]);
  });
});

describe('CodexAcpDriver seat_info（codex configOptions {id,currentValue} 形状）', () => {
  it('session/new 响应 configOptions（id/currentValue 数组）→ model/mode/thinking←reasoning_effort（R2）', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            // codex 实测形状：{id, currentValue, options:[{value,name}]}
            configOptions: [
              { id: 'mode', currentValue: 'read-only', options: [] },
              { id: 'model', currentValue: 'gpt-5.6-luna', options: [] },
              { id: 'reasoning_effort', currentValue: 'high', options: [] },
              { id: 'fast-mode', currentValue: 'off', options: [] },
            ],
          },
        },
      },
      { respond: CONFIG_RESPOND }, // set_config_option mode
    ]);
    await h.driver.start(CODEX_CONFIG); // permissionMode='auto'
    expect(h.events).toContainEqual({
      type: 'seat_info',
      seatId: 'seat-1',
      model: 'gpt-5.6-luna',
      thinking: 'high', // reasoning_effort → thinking（R2）
      mode: 'auto', // 钉死档位优先（configOptions 展示值 read-only 不上报）
    });
  });

  it('seat.assign 显式 model → seat_info model 用钉死值', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            configOptions: [{ id: 'model', currentValue: 'gpt-default' }],
          },
        },
      },
      { respond: CONFIG_RESPOND }, // mode
      { respond: CONFIG_RESPOND }, // model
    ]);
    await h.driver.start({ ...CODEX_CONFIG, model: 'gpt-5.6-luna' });
    expect(h.events).toContainEqual({
      type: 'seat_info',
      seatId: 'seat-1',
      model: 'gpt-5.6-luna',
      mode: 'auto',
    });
  });
});

describe('CodexAcpDriver resume 复活（基座行为在 codex profile 下回归）', () => {
  it('resume 失败（缓存 sessionId 失效）→ 降级 session/new，落盘新 id + warn 日志', async () => {
    const warnSpy = jest.spyOn(NoopLogger.prototype, 'warn').mockImplementation(() => {});
    const h = makeHarness({ persistedSessionId: 'sess-stale' });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { error: { code: -32602, message: 'session not found' } } }, // session/resume 失败
      { respond: { result: { sessionId: 'sess-new' } } }, // 降级 session/new
      { respond: CONFIG_RESPOND }, // mode
    ]);
    await h.driver.start(CODEX_CONFIG);
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'session/resume')).toHaveLength(1);
    expect(log.filter((r) => r.method === 'session/new')).toHaveLength(1);
    expect(h.sessionIds).toEqual(['sess-new']);
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('session/resume failed'))).toBe(true);
  });
});

describe('CodexAcpDriver 单飞行（per-seat）', () => {
  it('busy 期间并发 inject 抛 BusyError；turn 结束后可再注入', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        { respond: { result: { stopReason: 'end_turn' } } }, // prompt #1
        { emit: [chunkNotification('b-start')] }, // prompt #2（只 emit 不 respond → 挂起）
        { respond: { result: { stopReason: 'end_turn' } } }, // prompt #3（b 停止后新进程用）
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    await h.driver.inject('seat-1', { text: 'a' });
    const p1 = h.driver.inject('seat-1', { text: 'b' });
    await waitForEvent(
      h.events,
      (e) => e.type === 'status' && (e as Extract<SeatEvent, { type: 'status' }>).status === 'busy',
    );
    await expect(h.driver.inject('seat-1', { text: 'c' })).rejects.toBeInstanceOf(BusyError);
    await h.driver.stop('seat-1');
    await expect(p1).rejects.toThrow('exited');
    const completes = h.events.filter((e) => e.type === 'message_complete');
    expect(completes).toHaveLength(2);
  });
});

describe('CodexAcpDriver 审批（codex 形状：反向 RPC id 从 0 起 + options 带 _meta）', () => {
  const PERMISSION_EMIT = {
    jsonrpc: '2.0',
    id: 0, // codex 桥反向 RPC id 从 0 自增（R1 跨座位撞键风险源）
    method: 'session/request_permission',
    params: {
      toolCall: { id: 'tc-1', title: 'run 危险命令', status: 'pending' },
      // codex 实测形状：options 带 _meta，kind 与 kimi 同命名空间（allow_*）
      options: [
        { optionId: 'allow_once', kind: 'allow_once', _meta: { actionId: 'act-1' } },
        { optionId: 'allow_always', kind: 'allow_always', _meta: { actionId: 'act-2' } },
        { optionId: 'reject_once', kind: 'reject_once', _meta: { actionId: 'act-3' } },
      ],
    },
  };

  it('request_permission（requestId=0）→ permission_request 事件挂起 → answerPermission 按 optionId 精确匹配应答', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [PERMISSION_EMIT],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    const injectPromise = h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.requestId).toBe('0');
    expect(perm.tool).toMatchObject({ id: 'tc-1' });
    expect(perm.options).toHaveLength(3);
    await h.driver.answerPermission('seat-1', '0', 'allow_always');
    await injectPromise;
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 0));
    const response = h.getLog().find((r) => r.direction === 'response' && r.id === 0);
    expect(response!.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    });
  });

  it('optionId 未命中 → cancelled（RT-PERM-1 同一逻辑：kind 命名不参与匹配）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [PERMISSION_EMIT],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    const injectPromise = h.driver.inject('seat-1', { text: '跑一下' });
    await permPromise;
    await h.driver.answerPermission('seat-1', '0', 'no-such-option');
    await injectPromise;
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 0));
    expect(h.getLog().find((r) => r.direction === 'response' && r.id === 0)!.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

describe('CodexAcpDriver toolMeta 缓存补全（M4b-1 ②：request_permission 缺 title → 查缓存补缺省，只补不覆盖）', () => {
  /** 无 title 的审批载荷（codex 真机形状：仅 {kind,status,toolCallId}——DB 实测铁证） */
  function permissionEmit(toolCall: Record<string, unknown>, id: number): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id, // codex 桥反向 RPC id 从 0 自增
      method: 'session/request_permission',
      params: {
        toolCall,
        options: [{ optionId: 'allow_once', kind: 'allow_once', _meta: { actionId: 'act-1' } }],
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
      ...startFixture('auto', [
        {
          emit: [
            toolCallNotification('tc-1', 'ls'),
            permissionEmit({ toolCallId: 'tc-1', kind: 'bash', status: 'pending' }, 0),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.requestId).toBe('0');
    expect(perm.tool).toMatchObject({ toolCallId: 'tc-1', title: 'ls' });
  });

  it('缓存 miss（前置无 tool_call）→ tool 原样透传不崩（重启/resume 后优雅降级为现状）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [permissionEmit({ toolCallId: 'tc-unknown', status: 'pending' }, 1)],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.tool).toEqual({ toolCallId: 'tc-unknown', status: 'pending' });
  });

  it('自带 title → 不被缓存值覆盖（只补缺省不覆盖，kimi 路径零影响）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [
            toolCallNotification('tc-1', 'ls'), // 缓存里有冲突 title
            permissionEmit({ toolCallId: 'tc-1', title: 'run 危险命令', status: 'pending' }, 2),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
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
    calls.push(permissionEmit({ toolCallId: 'tc-0', status: 'pending' }, 0)); // 最旧：已被淘汰
    calls.push(permissionEmit({ toolCallId: 'tc-100', status: 'pending' }, 1)); // 最新：仍在缓存
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: calls,
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const permPromise = waitForEvent(
      h.events,
      (e) =>
        e.type === 'permission_request' &&
        (e as Extract<SeatEvent, { type: 'permission_request' }>).requestId === '0',
    );
    await h.driver.inject('seat-1', { text: '跑一下' });
    await permPromise;
    await waitFor(() => h.events.filter((e) => e.type === 'permission_request').length >= 2);
    const perms = h.events.filter((e) => e.type === 'permission_request') as Array<
      Extract<SeatEvent, { type: 'permission_request' }>
    >;
    expect(perms[0].requestId).toBe('0');
    expect(perms[0].tool).toEqual({ toolCallId: 'tc-0', status: 'pending' }); // 最旧键已淘汰：不补
    expect(perms[1].requestId).toBe('1');
    expect(perms[1].tool).toMatchObject({ toolCallId: 'tc-100', title: 'tool-100' }); // 最新键在缓存内：补全
  });
});

describe('CodexAcpDriver usage / 沉默判定（基座行为回归）', () => {
  it('usage_update 通知 → usage 事件（used/size 宽松读取）', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [
            {
              method: 'usage_update',
              params: { sessionId: 'sess-1', usage: { used: 4321, size: 128000 } },
            },
            chunkNotification('done'),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    expect(h.events).toContainEqual({ type: 'usage', seatId: 'seat-1', used: 4321, size: 128000 });
  });

  it('全文仅 {"silent": true} → message_complete silent=true；正文藏 JSON → 不判定沉默', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [chunkNotification(' {"silent": '), chunkNotification('true} \n')],
          respond: { result: { stopReason: 'end_turn' } },
        },
        {
          emit: [chunkNotification('好的，参考: {"silent": true}')],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const silentComplete = h.events.find((e) => e.type === 'message_complete') as Extract<
      SeatEvent,
      { type: 'message_complete' }
    >;
    expect(silentComplete.silent).toBe(true);
    await h.driver.inject('seat-1', { text: 'y' });
    const completes = h.events.filter((e) => e.type === 'message_complete') as Array<
      Extract<SeatEvent, { type: 'message_complete' }>
    >;
    expect(completes[1].silent).toBe(false);
  });
});

describe('CodexAcpDriver 优雅取消（M4b-1：基座 session/cancel 通知在 codex profile 下回归）', () => {
  // codex 形状：反向 RPC id 从 0 自增 + options 带 _meta
  const PERMISSION_EMIT = {
    jsonrpc: '2.0',
    id: 0,
    method: 'session/request_permission',
    params: {
      toolCall: { id: 'tc-1', title: 'run 危险命令', status: 'pending' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', _meta: { actionId: 'act-1' } },
        { optionId: 'allow_always', kind: 'allow_always', _meta: { actionId: 'act-2' } },
        { optionId: 'reject_once', kind: 'reject_once', _meta: { actionId: 'act-3' } },
      ],
    },
  };

  it('in-flight cancel：session/cancel 通知 → prompt resolve cancelled（单条 message_complete，会话存活续聊）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 500 });
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [chunkNotification('数到一半…')],
          respond: { result: { stopReason: 'cancelled' } },
          delayMs: 150, // prompt 在途：cancel 通知到达后延迟 resolve cancelled
        },
        { emit: [] }, // session/cancel 通知占位（fixture 按请求序号消费，通知也占条目）
        { respond: { result: { stopReason: 'end_turn' } } }, // 续聊第二轮
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: '数到 100' });
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1');
    await injectPromise;
    const completes = h.events.filter((e) => e.type === 'message_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ seatId: 'seat-1', stopReason: 'cancelled' });
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ type: 'status', status: 'offline' }),
    );
    // 通知无 id（通知语义）；载荷带 sessionId
    const cancelReq = h.getLog().find((r) => r.method === 'session/cancel');
    expect(cancelReq).toBeDefined();
    expect(cancelReq!.params).toEqual({ sessionId: 'sess-1' });
    expect(cancelReq!.id).toBeUndefined();
    // 会话存活：续聊第二轮正常 end_turn
    await h.driver.inject('seat-1', { text: '续聊' });
    const completes2 = h.events.filter((e) => e.type === 'message_complete');
    expect(completes2).toHaveLength(2);
    expect(completes2[1]).toMatchObject({ stopReason: 'end_turn' });
  });

  it('空闲取消（busy=false）→ 幂等 no-op：不发通知、不 kill（R1 busy 门控）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 100 });
    h.setFixture(startFixture('auto', [{ respond: { result: { stopReason: 'end_turn' } } }]));
    await h.driver.start(CODEX_CONFIG);
    await h.driver.cancel('seat-1');
    await delay(150); // 超过兜底超时：确认未触发 kill
    expect(h.getLog().some((r) => r.method === 'session/cancel')).toBe(false);
    expect(h.events).not.toContainEqual(
      expect.objectContaining({ type: 'status', status: 'offline' }),
    );
    // 会话存活：同一子进程可再注入
    await h.driver.inject('seat-1', { text: 'x' });
    expect(h.getLog().filter((r) => r.method === 'initialize')).toHaveLength(1);
  });

  it('cancel 后 agent 在超时前自然 end_turn → 不触发兜底 kill（R2：resolve 已清超时句柄）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 200 });
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [chunkNotification('快完成了…')],
          respond: { result: { stopReason: 'end_turn' } }, // 忽略 cancel，自然收尾
          delayMs: 100, // 100ms < 200ms 兜底超时：不 kill
        },
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: 'x' });
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1');
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
      ...startFixture('auto', [
        { emit: [chunkNotification('卡住了…')] }, // prompt 挂起（不应答）
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const injectPromise = h.driver.inject('seat-1', { text: 'x' });
    // 立即挂拒绝处理器：拒绝发生在 cancel 兜底 kill 之后，迟挂会触发 jest unhandled rejection
    const rejection = injectPromise.then(
      () => null,
      (err: unknown) => err as Error,
    );
    await waitForEvent(h.events, (e) => e.type === 'message_chunk');
    await h.driver.cancel('seat-1');
    const offlineEvent = await waitForEvent(
      h.events,
      (e) =>
        e.type === 'status' &&
        (e as Extract<SeatEvent, { type: 'status' }>).status === 'offline' &&
        (e as Extract<SeatEvent, { type: 'status' }>).detail === 'cancelled',
    );
    expect(offlineEvent).toMatchObject({ seatId: 'seat-1' });
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('exited');
    expect(h.events).toContainEqual({
      type: 'message_complete',
      seatId: 'seat-1',
      stopReason: 'error',
    });
  });

  it('cancel 时挂起审批（requestId=0）逐个应答 Cancelled（ACP 规范 MUST）', async () => {
    const h = makeHarness({ cancelKillTimeoutMs: 500 });
    h.setFixture([
      ...startFixture('auto', [
        {
          emit: [PERMISSION_EMIT],
          respond: { result: { stopReason: 'cancelled' } },
          delayMs: 150,
        },
        { emit: [] }, // session/cancel 通知占位
      ]),
    ]);
    await h.driver.start(CODEX_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    const injectPromise = h.driver.inject('seat-1', { text: '跑一下' });
    await permPromise;
    await h.driver.cancel('seat-1');
    await injectPromise;
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 0));
    const response = h.getLog().find((r) => r.direction === 'response' && r.id === 0);
    expect(response!.result).toEqual({ outcome: { outcome: 'cancelled' } });
    const complete = h.events.find((e) => e.type === 'message_complete');
    expect(complete).toMatchObject({ stopReason: 'cancelled' });
  });
});
