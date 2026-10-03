/**
 * DshAcpDriver 测试（假 stdio 子进程按录制 NDJSON fixture 应答——复用 fake-acp.js harness）
 *
 * 覆盖（§8f 行为档案 + D1/D2/D3 决策）：全链路（initialize/new/prompt/流式）、spawn env
 * 四档钉死矩阵（DSH_PERMISSION_MODE）、「不发 mode」断言（dsh 无 mode 面 → 无
 * configId=mode 的 set_config_option）、bin 解析三优先级与探测失败引导、model 包装三形态
 * （裸名 / provider-model 两段式 / 已 JSON 串幂等）、tool_call_update 映射、审批
 * toolCallId-only → toolMeta 补缺 + 缓存 miss 降级、resume（响应不带 sessionId 时按
 * persisted 兜底）、cancel 优雅取消、busy 单飞行。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig, SeatEvent } from '@agent-chamber/roundtable-protocol';
import { BusyError } from './seat-driver';
import { DshAcpDriver } from './dsh-acp';
import { NoopLogger } from '../logger';

/** 假 ACP 子进程脚本（ts-jest 内存编译，__dirname 保持源码相对路径） */
const FAKE_ACP_SCRIPT = path.resolve(__dirname, '../__fixtures__/fake-acp.js');

/** 测试座位配置（vendor=dsh，permissionMode=default；档位用例逐个覆盖） */
const DSH_CONFIG: SeatConfig = {
  seatId: 'seat-1',
  label: 'dsh-1',
  vendor: 'dsh',
  cwd: '/tmp/roundtable-runner-dsh-test',
  permissionMode: 'default',
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

/** initialize 成功响应（dsh 0.2.0-rc.1 实测形状：protocolVersion=1 兼容、authMethods=[]、
 * session caps 含 close/list/resume、mcp http=true） */
const INIT_RESPOND = {
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'dsh', version: '0.2.0-rc.1' },
    authMethods: [],
    sessionCapabilities: { close: true, list: true, resume: true },
    agentCapabilities: { loadSession: true, mcp: { http: true } },
  },
};

/** set_config_option 成功响应 */
const CONFIG_RESPOND = { result: {} };

/** 测试夹具：临时目录 + fixture 文件 + requestsLog + driver 实例 */
interface Harness {
  dir: string;
  fixturePath: string;
  logPath: string;
  driver: DshAcpDriver;
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
const createdDrivers: DshAcpDriver[] = [];

function makeHarness(
  options: {
    persistedSessionId?: string;
    permissionMode?: PermissionMode;
    bin?: string;
    cancelKillTimeoutMs?: number;
  } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-spec-'));
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'requests.json');
  const events: SeatEvent[] = [];
  const sessionIds: string[] = [];
  const driver = new DshAcpDriver({
    // spawn 直连 `dsh acp`（无桥）——bin 注入 node、spawnArgs 携带假脚本 + fixture/log
    // 路径（kimi/opencode 规格同款，跳过 PATH 探测；探测分支有专测）
    bin: options.bin ?? process.execPath,
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

/**
 * 标准 start 前置 fixture（initialize + session/new——注意**没有 set_config_option**：
 * dsh 无 mode 面，档位由 spawn env 承载，见 dsh-acp.ts D2；带 model 的用例另行追加
 * set_config_option model 条目）。
 */
function startFixture(extra: unknown[] = []): unknown[] {
  return [
    { respond: INIT_RESPOND },
    { respond: { result: { sessionId: 'sess-1' } } }, // session/new
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
  createdDrivers.length = 0;
  // bin 解析用例改过 DSH_BIN/PATH：一律恢复
  delete process.env.DSH_BIN;
  jest.restoreAllMocks();
});

describe('DshAcpDriver 全链路（initialize/new/prompt/流式）', () => {
  it('start → inject：status online → message_chunk → message_complete（end_turn, silent=false）', async () => {
    const h = makeHarness();
    h.setFixture(
      startFixture([
        {
          emit: [chunkNotification('Hello '), chunkNotification('world')],
          respond: { result: { stopReason: 'end_turn' } }, // session/prompt
        },
      ]),
    );
    await h.driver.start(DSH_CONFIG);
    expect(h.events).toContainEqual({ type: 'status', seatId: 'seat-1', status: 'online' });
    await h.driver.inject('seat-1', { text: 'hi' });
    const complete = (await waitForEvent(
      h.events,
      (e) => e.type === 'message_complete',
    )) as Extract<SeatEvent, { type: 'message_complete' }>;
    expect(complete.stopReason).toBe('end_turn');
    expect(complete.text).toBe('Hello world');
    expect(complete.silent).toBe(false);
    // 请求序列：initialize → session/new → session/prompt（无 set_config_option）
    const methods = h
      .getLog()
      .map((r) => r.method)
      .filter(Boolean);
    expect(methods).toEqual(['initialize', 'session/new', 'session/prompt']);
  });

  it('initialize 不声明 fs caps（行为档案 #4 安全线沿用），clientInfo 正确', async () => {
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(DSH_CONFIG);
    const initReq = h.getLog().find((r) => r.method === 'initialize');
    expect(initReq).toBeDefined();
    const caps = initReq!.params!.clientCapabilities as Record<string, unknown>;
    expect('fs' in caps).toBe(false);
    expect(caps.terminal).toBe(false);
    expect(initReq!.params!.clientInfo).toMatchObject({ name: 'agent-chamber-roundtable-runner' });
  });

  it('session/new 参数：cwd 透传座位工作目录（= dsh 沙箱根，§8f 安全语义所在）', async () => {
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(DSH_CONFIG);
    const newReq = h.getLog().find((r) => r.method === 'session/new');
    expect(newReq!.params).toMatchObject({ cwd: DSH_CONFIG.cwd, mcpServers: [] });
  });
});

describe('DshAcpDriver 权限钉死（D2：DSH_PERMISSION_MODE 按档位注入 spawn env）', () => {
  it.each([
    ['default', 'workspace-write'],
    ['plan', 'read-only'],
    ['auto', 'danger-full-access'],
    ['yolo', 'danger-full-access'],
  ] as Array<[PermissionMode, string]>)(
    '档位 %s → DSH_PERMISSION_MODE=%s',
    async (permissionMode, expectedMode) => {
      const h = makeHarness({ permissionMode });
      h.setFixture(startFixture());
      await h.driver.start({ ...DSH_CONFIG, permissionMode });
      const envEntry = h.getLog().find((r) => r.direction === 'env');
      expect(envEntry!.env!.DSH_PERMISSION_MODE).toBe(expectedMode);
    },
  );

  it.each(['default', 'plan', 'auto', 'yolo'] as PermissionMode[])(
    '档位 %s 不发任何 set_config_option（dsh 无 mode 面，档位只走 spawn env）',
    async (permissionMode) => {
      const h = makeHarness({ permissionMode });
      h.setFixture(startFixture());
      await h.driver.start({ ...DSH_CONFIG, permissionMode });
      const setConfigReqs = h.getLog().filter((r) => r.method === 'session/set_config_option');
      expect(setConfigReqs).toHaveLength(0);
      expect(setConfigReqs.some((r) => r.params!.configId === 'mode')).toBe(false);
    },
  );
});

describe('DshAcpDriver model 包装（D3：dsh 只认 JSON 两段数组串）', () => {
  it.each([
    // 裸名 → 补默认 provider
    ['deepseek-v4-flash', '["deepseek-official","deepseek-v4-flash"]'],
    // provider/model 两段式 → 拆包后重包
    ['siliconflow/deepseek-v4-flash', '["siliconflow","deepseek-v4-flash"]'],
    // 已 JSON 串 → 原样（幂等：重复包装不叠加）
    ['["custom-provider","some-model"]', '["custom-provider","some-model"]'],
    // 带空白的 JSON 串 → trim 后透传（不修剪会把非法值原样下发 → unknown model fail-closed）
    ['  ["custom-provider","some-model"]  ', '["custom-provider","some-model"]'],
    // 带空白的裸名 → trim 后补默认 provider
    ['  deepseek-v4-flash ', '["deepseek-official","deepseek-v4-flash"]'],
  ] as Array<[string, string]>)(
    'model=%s → set_config_option(configId=model) value=%s',
    async (model, expectedValue) => {
      const h = makeHarness();
      h.setFixture(startFixture([{ respond: CONFIG_RESPOND }])); // set_config_option model
      await h.driver.start({ ...DSH_CONFIG, model });
      const modelReq = h
        .getLog()
        .find((r) => r.method === 'session/set_config_option' && r.params!.configId === 'model');
      expect(modelReq!.params).toMatchObject({ configId: 'model', value: expectedValue });
    },
  );

  it('无 model → 不发 model 钉死（会话跑 dsh 默认模型）', async () => {
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(DSH_CONFIG);
    expect(h.getLog().filter((r) => r.method === 'session/set_config_option')).toHaveLength(0);
  });
});

describe('DshAcpDriver bin 解析（构造选项 > DSH_BIN > PATH 探测）', () => {
  it('DSH_BIN env 命中（无构造选项 bin 时）→ 正常 start', async () => {
    process.env.DSH_BIN = process.execPath;
    const h = makeHarness({ bin: undefined });
    // makeHarness 默认 bin=process.execPath——本例显式造无 bin 的 driver
    const driver = new DshAcpDriver({
      spawnArgs: [FAKE_ACP_SCRIPT, h.fixturePath, h.logPath],
      getSessionId: () => undefined,
      logger: new NoopLogger(),
    });
    createdDrivers.push(driver);
    h.setFixture(startFixture());
    await driver.start(DSH_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('构造选项 bin 优先于 DSH_BIN（env 指向不存在路径仍正常 start）', async () => {
    process.env.DSH_BIN = '/nonexistent/dsh';
    const h = makeHarness(); // bin=process.execPath 应压过 bogus env
    h.setFixture(startFixture());
    await h.driver.start(DSH_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('PATH 探测不到且无 bin/DSH_BIN → start 失败带明确引导（R3 不静默兜底）', async () => {
    const oldPath = process.env.PATH;
    delete process.env.DSH_BIN;
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nopath-'));
    try {
      const driver = new DshAcpDriver({
        getSessionId: () => undefined,
        logger: new NoopLogger(),
      });
      createdDrivers.push(driver);
      await expect(driver.start(DSH_CONFIG)).rejects.toThrow(
        'dsh CLI not found: npm i -g @deepseek-ai/dsh@0.2.0-rc.1 (or set DSH_BIN) first',
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe('DshAcpDriver 工具事件（tool_call_update 与审批补缺）', () => {
  it('tool_call_update 流式块 → tool_event 事件（工具生命周期增量同路径透传）', async () => {
    const h = makeHarness();
    h.setFixture(
      startFixture([
        {
          emit: [
            {
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'tc-1',
                  title: 'bash',
                  kind: 'execute',
                  status: 'pending',
                },
              },
            },
            {
              method: 'session/update',
              params: {
                // ACP patch 语义：只带变更字段
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-1',
                  status: 'completed',
                },
              },
            },
            chunkNotification('ok'),
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    );
    await h.driver.start(DSH_CONFIG);
    await h.driver.inject('seat-1', { text: 'x' });
    const toolEvents = h.events.filter((e) => e.type === 'tool_event') as Array<
      Extract<SeatEvent, { type: 'tool_event' }>
    >;
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[1]!.tool).toEqual({ toolCallId: 'tc-1', status: 'completed' });
    expect(toolEvents[1]!.tool).not.toHaveProperty('sessionUpdate');
  });

  it('审批 toolCall 只带 toolCallId → 从 toolMeta 缓存补 title 与 kind（dsh 真机形状）', async () => {
    const h = makeHarness();
    h.setFixture(
      startFixture([
        {
          emit: [
            {
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'tc-7',
                  title: '写文件 /etc/hosts',
                  kind: 'execute',
                  status: 'pending',
                },
              },
            },
            {
              jsonrpc: '2.0',
              id: 0, // dsh 反向 RPC id 从 0 起
              method: 'session/request_permission',
              params: {
                toolCall: { toolCallId: 'tc-7' }, // 只带 toolCallId，无 title/kind
                options: [
                  { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
                  { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
                ],
              },
            },
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    );
    await h.driver.start(DSH_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.requestId).toBe('0');
    // dsh 审批载荷只有 toolCallId：title 由缓存补缺（否则 UI 显示 unknown tool）
    expect(perm.tool).toMatchObject({ toolCallId: 'tc-7', title: '写文件 /etc/hosts' });
    // optionId 连字形态原样透传（RT-PERM-1：不做 kind 猜测）
    expect(perm.options.map((o) => String(o.optionId))).toEqual(['allow-once', 'reject-once']);
    // 审批应答可送达（optionId 精确匹配）
    await h.driver.answerPermission('seat-1', '0', 'allow-once');
    await waitFor(() => h.getLog().some((r) => r.direction === 'response' && r.id === 0));
    expect(h.getLog().find((r) => r.direction === 'response' && r.id === 0)!.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
  });

  it('缓存 miss（前置无 tool_call）→ tool 原样透传不崩（重启/resume 后优雅降级）', async () => {
    const h = makeHarness();
    h.setFixture(
      startFixture([
        {
          emit: [
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'session/request_permission',
              params: {
                toolCall: { toolCallId: 'tc-unknown' },
                options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }],
              },
            },
          ],
          respond: { result: { stopReason: 'end_turn' } },
        },
      ]),
    );
    await h.driver.start(DSH_CONFIG);
    const permPromise = waitForEvent(h.events, (e) => e.type === 'permission_request');
    await h.driver.inject('seat-1', { text: '跑一下' });
    const perm = (await permPromise) as Extract<SeatEvent, { type: 'permission_request' }>;
    expect(perm.tool).toEqual({ toolCallId: 'tc-unknown' });
  });
});

describe('DshAcpDriver resume 复活（基座行为在 dsh profile 下回归）', () => {
  it('有落盘 sessionId → session/resume；响应不带 sessionId 时按 persisted 兜底落盘', async () => {
    const h = makeHarness({ persistedSessionId: 'sess-old' });
    h.setFixture([
      { respond: INIT_RESPOND },
      // dsh 实测：resume 响应**不带 sessionId**（只有 result 对象）——基座 `?? persisted` 兼容
      { respond: { result: {} } },
    ]);
    await h.driver.start(DSH_CONFIG);
    const log = h.getLog();
    expect(log.some((r) => r.method === 'session/new')).toBe(false);
    const resumeReq = log.find((r) => r.method === 'session/resume');
    expect(resumeReq!.params).toMatchObject({ sessionId: 'sess-old', cwd: DSH_CONFIG.cwd });
    // 落盘的 id 仍是原 persisted（不是 undefined / 空串）
    expect(h.sessionIds).toEqual(['sess-old']);
  });

  it('resume 失败（缓存 sessionId 失效）→ 降级 session/new，落盘新 id + warn 日志', async () => {
    const warnSpy = jest.spyOn(NoopLogger.prototype, 'warn').mockImplementation(() => {});
    const h = makeHarness({ persistedSessionId: 'sess-stale' });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { error: { code: -32602, message: 'session not found' } } }, // resume 失败
      { respond: { result: { sessionId: 'sess-new' } } }, // 降级 session/new
    ]);
    await h.driver.start(DSH_CONFIG);
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'session/resume')).toHaveLength(1);
    expect(log.filter((r) => r.method === 'session/new')).toHaveLength(1);
    expect(h.sessionIds).toEqual(['sess-new']);
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('session/resume failed'))).toBe(true);
  });
});

describe('DshAcpDriver cancel / 单飞行', () => {
  it('in-flight cancel：session/cancel 通知 → prompt resolve cancelled（会话存活可续聊）', async () => {
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
    await h.driver.start(DSH_CONFIG);
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
    const cancelReq = h.getLog().find((r) => r.method === 'session/cancel');
    expect(cancelReq!.params).toEqual({ sessionId: 'sess-1' });
    expect(cancelReq!.id).toBeUndefined();
    // 会话存活：cancel 后可再注入
    await h.driver.inject('seat-1', { text: '续聊' });
    expect(h.events.filter((e) => e.type === 'message_complete')).toHaveLength(2);
  });

  it('busy 期间并发 inject 抛 BusyError；turn 结束后可再注入', async () => {
    const h = makeHarness();
    h.setFixture([
      ...startFixture([
        { respond: { result: { stopReason: 'end_turn' } } }, // prompt #1（完成）
        { emit: [chunkNotification('b-start')] }, // prompt #2（只 emit 不 respond → 挂起）
      ]),
    ]);
    await h.driver.start(DSH_CONFIG);
    await h.driver.inject('seat-1', { text: 'a' }); // 第一轮完成
    const p1 = h.driver.inject('seat-1', { text: 'b' });
    await waitForEvent(
      h.events,
      (e) => e.type === 'status' && (e as Extract<SeatEvent, { type: 'status' }>).status === 'busy',
    );
    await expect(h.driver.inject('seat-1', { text: 'c' })).rejects.toBeInstanceOf(BusyError);
    // 收尾：杀进程释放 b 的挂起
    await h.driver.stop('seat-1');
    await expect(p1).rejects.toThrow('exited');
    expect(h.events.filter((e) => e.type === 'message_complete')).toHaveLength(2);
  });
});
