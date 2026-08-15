/**
 * OpencodeAcpDriver 测试（假 stdio 子进程按录制 NDJSON fixture 应答——复用 fake-acp.js harness）
 *
 * 覆盖：全链路（initialize/new/prompt/流式）、bin 解析三优先级（构造选项 > OPENCODE_BIN
 * > PATH 探测，探测不到 start 明确失败不静默兜底）、权限钉死 env（O1：default/plan→ask、
 * auto/yolo→allow）、档位映射（O2：四档 → mode=build/plan 单条）、initialize 不声明
 * fs caps、seat_info 从 opencode configOptions {id,currentValue} 形状解析、resume 降级 new。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig, SeatEvent } from '@agent-chamber/roundtable-protocol';
import { OpencodeAcpDriver } from './opencode-acp';
import { NoopLogger } from '../logger';

/** 假 ACP 子进程脚本（ts-jest 内存编译，__dirname 保持源码相对路径） */
const FAKE_ACP_SCRIPT = path.resolve(__dirname, '../__fixtures__/fake-acp.js');

/** 测试座位配置（vendor=opencode，permissionMode=auto；档位用例逐个覆盖） */
const OPENCODE_CONFIG: SeatConfig = {
  seatId: 'seat-1',
  label: 'opencode-1',
  vendor: 'opencode',
  cwd: '/tmp/roundtable-runner-opencode-test',
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

/** initialize 成功响应（opencode 1.18.9 真机形状：authMethods=[opencode-login]） */
const INIT_RESPOND = {
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'OpenCode', version: '1.18.9' },
    authMethods: [{ id: 'opencode-login', name: 'Login with opencode' }],
    agentCapabilities: { loadSession: true },
  },
};

/** set_config_option 成功响应 */
const CONFIG_RESPOND = { result: {} };

/** 测试夹具：临时目录 + fixture 文件 + requestsLog + driver 实例 */
interface Harness {
  dir: string;
  fixturePath: string;
  logPath: string;
  driver: OpencodeAcpDriver;
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
const createdDrivers: OpencodeAcpDriver[] = [];

function makeHarness(
  options: {
    persistedSessionId?: string;
    permissionMode?: PermissionMode;
    bin?: string;
    cancelKillTimeoutMs?: number;
  } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-acp-spec-'));
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'requests.json');
  const events: SeatEvent[] = [];
  const sessionIds: string[] = [];
  const driver = new OpencodeAcpDriver({
    // spawn 直连 `opencode acp`（无桥）——bin 注入 node、spawnArgs 携带假脚本 +
    // fixture/log 路径（kimi 规格同款，跳过 PATH 探测；探测分支有专测）
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
 * 标准 start 前置 fixture（initialize + session/new + set mode 一条——opencode 四档
 * 均单条 mode，权限差异在 spawn env 不走 configOptions，见 opencode-acp.ts O1/O2）。
 */
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
  // bin 解析用例改过 OPENCODE_BIN/PATH：一律恢复
  delete process.env.OPENCODE_BIN;
  jest.restoreAllMocks();
});

describe('OpencodeAcpDriver 全链路（initialize/new/prompt/流式）', () => {
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
    await h.driver.start(OPENCODE_CONFIG);
    await h.driver.inject('seat-1', { text: 'hi' });
    const complete = (await waitForEvent(
      h.events,
      (e) => e.type === 'message_complete',
    )) as Extract<SeatEvent, { type: 'message_complete' }>;
    expect(complete.stopReason).toBe('end_turn');
    expect(complete.text).toBe('Hello world');
    expect(complete.silent).toBe(false);
    // 请求序列：initialize → session/new → set_config_option(mode) → session/prompt
    const methods = h
      .getLog()
      .map((r) => r.method)
      .filter(Boolean);
    expect(methods).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
    ]);
  });

  it('initialize 不声明 fs caps（行为档案 #4 安全线沿用），clientInfo 正确', async () => {
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(OPENCODE_CONFIG);
    const initReq = h.getLog().find((r) => r.method === 'initialize');
    expect(initReq).toBeDefined();
    const caps = initReq!.params!.clientCapabilities as Record<string, unknown>;
    expect('fs' in caps).toBe(false);
    expect(caps.terminal).toBe(false);
    expect(initReq!.params!.clientInfo).toMatchObject({ name: 'agent-chamber-roundtable-runner' });
  });
});

describe('OpencodeAcpDriver bin 解析（构造选项 > OPENCODE_BIN > PATH 探测）', () => {
  it('OPENCODE_BIN env 命中（无构造选项 bin 时）→ 正常 start', async () => {
    process.env.OPENCODE_BIN = process.execPath;
    const h = makeHarness({ bin: undefined });
    // makeHarness 默认 bin=process.execPath——本例显式造无 bin 的 driver
    const driver = new OpencodeAcpDriver({
      spawnArgs: [FAKE_ACP_SCRIPT, h.fixturePath, h.logPath],
      getSessionId: () => undefined,
      logger: new NoopLogger(),
    });
    createdDrivers.push(driver);
    h.setFixture(startFixture());
    await driver.start(OPENCODE_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('构造选项 bin 优先于 OPENCODE_BIN（env 指向不存在路径仍正常 start）', async () => {
    process.env.OPENCODE_BIN = '/nonexistent/opencode';
    const h = makeHarness(); // bin=process.execPath 应压过 bogus env
    h.setFixture(startFixture());
    await h.driver.start(OPENCODE_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('PATH 探测不到且无 bin/OPENCODE_BIN → start 失败带明确引导（R3 不静默兜底）', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nopath-'));
    try {
      const driver = new OpencodeAcpDriver({
        getSessionId: () => undefined,
        logger: new NoopLogger(),
      });
      createdDrivers.push(driver);
      await expect(driver.start(OPENCODE_CONFIG)).rejects.toThrow(
        'opencode CLI not found: install (https://opencode.ai) + `opencode auth login` first',
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe('OpencodeAcpDriver 权限钉死（O1：OPENCODE_CONFIG_CONTENT 按档位注入 spawn env）', () => {
  it.each([
    ['default', '{"permission":{"*":"ask"}}'],
    ['plan', '{"permission":{"*":"ask"}}'],
    ['auto', '{"permission":{"*":"allow"}}'],
    ['yolo', '{"permission":{"*":"allow"}}'],
  ] as Array<[PermissionMode, string]>)(
    '档位 %s → OPENCODE_CONFIG_CONTENT=%s',
    async (permissionMode, expectedContent) => {
      const h = makeHarness({ permissionMode });
      h.setFixture(startFixture());
      await h.driver.start({ ...OPENCODE_CONFIG, permissionMode });
      const envEntry = h.getLog().find((r) => r.direction === 'env');
      expect(envEntry!.env!.OPENCODE_CONFIG_CONTENT).toBe(expectedContent);
    },
  );
});

describe('OpencodeAcpDriver 档位映射（O2：单条 mode，opencode 仅 build/plan 原语）', () => {
  it.each([
    ['default', 'build'],
    ['plan', 'plan'],
    ['auto', 'build'],
    ['yolo', 'build'],
  ] as Array<[PermissionMode, string]>)(
    '档位 %s → set_config_option mode=%s',
    async (permissionMode, expectedMode) => {
      const h = makeHarness({ permissionMode });
      h.setFixture(startFixture());
      await h.driver.start({ ...OPENCODE_CONFIG, permissionMode });
      const modeReqs = h.getLog().filter((r) => r.method === 'session/set_config_option');
      expect(modeReqs).toHaveLength(1);
      expect(modeReqs[0]!.params).toMatchObject({ configId: 'mode', value: expectedMode });
    },
  );
});

describe('OpencodeAcpDriver seat_info 观测（configOptions {id,currentValue} 形状）', () => {
  it('session/new 响应 configOptions（opencode 1.18.9 真机形状）→ seat_info 上行 model/mode', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                type: 'select',
                currentValue: 'opencode/big-pickle',
                options: [],
              },
              {
                id: 'mode',
                name: 'Mode',
                category: 'mode',
                type: 'select',
                currentValue: 'build',
                options: [
                  { value: 'build', name: 'build' },
                  { value: 'plan', name: 'plan' },
                ],
              },
            ],
          },
        },
      },
      { respond: CONFIG_RESPOND },
    ]);
    await h.driver.start(OPENCODE_CONFIG);
    const info = (await waitForEvent(h.events, (e) => e.type === 'seat_info')) as Extract<
      SeatEvent,
      { type: 'seat_info' }
    >;
    expect(info.model).toBe('opencode/big-pickle');
    // mode 以平台钉死档位为准（基座刻意设计，档案 #5：configOptions 展示值可能是
    // 用户 config 泄漏值——「显示 default 实为 yolo」，钉死后的实际在跑 = permissionMode）；
    // 本例 permissionMode=auto（映射到 opencode mode=build 由档位映射用例覆盖）
    expect(info.mode).toBe('auto');
  });
});

describe('OpencodeAcpDriver resume 复活（基座行为在 opencode profile 下回归）', () => {
  it('resume 失败（缓存 sessionId 失效）→ 降级 session/new，落盘新 id + warn 日志', async () => {
    const warnSpy = jest.spyOn(NoopLogger.prototype, 'warn').mockImplementation(() => {});
    const h = makeHarness({ persistedSessionId: 'sess-stale' });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { error: { code: -32602, message: 'session not found' } } }, // session/resume 失败
      { respond: { result: { sessionId: 'sess-new' } } }, // 降级 session/new
      { respond: CONFIG_RESPOND }, // mode
    ]);
    await h.driver.start(OPENCODE_CONFIG);
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'session/resume')).toHaveLength(1);
    expect(log.filter((r) => r.method === 'session/new')).toHaveLength(1);
    expect(h.sessionIds).toEqual(['sess-new']);
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('session/resume failed'))).toBe(true);
  });
});
