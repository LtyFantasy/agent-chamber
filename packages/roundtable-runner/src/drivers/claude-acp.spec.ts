/**
 * ClaudeAcpDriver 测试（假 stdio 子进程按录制 NDJSON fixture 应答——复用 fake-acp.js harness）
 *
 * 覆盖（M4b-3 规格）：全链路（initialize/new/prompt/流式）、桥 bin 解析两分支
 * （acpBinPath 注入优先 / 真实依赖解析前置）、四档 mode 映射（C2：default/plan/
 * acceptEdits/bypassPermissions 单条）、ANTHROPIC_MODEL env 注入有无（C1 模型注册
 * 保险）、认证预检三分支（C3：API_KEY 有 / 仅 AUTH_TOKEN+BASE_URL 有 / 全无 →
 * start 失败带引导）、initialize 不声明 fs caps、seat_info（claude 形状：
 * currentModelId 恒 default，configOptions 缺失 → model 用钉死值）、resume 降级 new。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionMode, SeatConfig, SeatEvent } from '@agent-chamber/roundtable-protocol';
import { ClaudeAcpDriver } from './claude-acp';
import { NoopLogger } from '../logger';

/** 假 ACP 子进程脚本（ts-jest 内存编译，__dirname 保持源码相对路径） */
const FAKE_ACP_SCRIPT = path.resolve(__dirname, '../__fixtures__/fake-acp.js');

/** 测试座位配置（vendor=claude-code，permissionMode=auto；档位用例逐个覆盖） */
const CLAUDE_CONFIG: SeatConfig = {
  seatId: 'seat-1',
  label: 'claude-1',
  vendor: 'claude-code',
  cwd: '/tmp/roundtable-runner-claude-test',
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

/** initialize 成功响应（claude 桥 0.23.1 实测形状：authMethods=[] 纯 env key +
 * sessionCapabilities 四件套；C3） */
const INIT_RESPOND = {
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'Claude Code', version: '2.1.232' },
    authMethods: [],
    sessionCapabilities: { fork: true, list: true, resume: true, close: true },
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
  driver: ClaudeAcpDriver;
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
const createdDrivers: ClaudeAcpDriver[] = [];

/** 认证预检用例会改 ANTHROPIC_* env：记录原值，afterEach 恢复 */
const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'HOME',
] as const;

function makeHarness(
  options: {
    persistedSessionId?: string;
    model?: string;
    permissionMode?: PermissionMode;
    acpBinPath?: string;
    cancelKillTimeoutMs?: number;
  } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-acp-spec-'));
  const fixturePath = path.join(dir, 'fixture.json');
  const logPath = path.join(dir, 'requests.json');
  // 桥 spawn 命令只有脚本一个参数——fixture/log 经 env 传给 fake-acp（FAKE_ACP_FIXTURE/LOG 兜底）
  process.env.FAKE_ACP_FIXTURE = fixturePath;
  process.env.FAKE_ACP_LOG = logPath;
  const events: SeatEvent[] = [];
  const sessionIds: string[] = [];
  const driver = new ClaudeAcpDriver({
    acpBinPath: options.acpBinPath ?? FAKE_ACP_SCRIPT, // 跳过真实桥 bin 解析（依赖包在 prod 解析）
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
 * 标准 start 前置 fixture（initialize + session/new + set mode 一条——claude 四档
 * 均单条 mode；带 model 的用例额外追加 set_config_option model，见 claude-acp.ts C1）。
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
  // 认证预检用例改过 ANTHROPIC_*/HOME env：一律恢复
  for (const key of AUTH_ENV_KEYS) {
    delete process.env[key];
  }
  jest.restoreAllMocks();
});

describe('ClaudeAcpDriver 全链路（initialize/new/prompt/流式）', () => {
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
    await h.driver.start(CLAUDE_CONFIG);
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
    await h.driver.start(CLAUDE_CONFIG);
    const initReq = h.getLog().find((r) => r.method === 'initialize');
    expect(initReq).toBeDefined();
    const caps = initReq!.params!.clientCapabilities as Record<string, unknown>;
    expect('fs' in caps).toBe(false);
    expect(caps.terminal).toBe(false);
    expect(initReq!.params!.clientInfo).toMatchObject({ name: 'agent-chamber-roundtable-runner' });
  });
});

describe('ClaudeAcpDriver 桥 bin 解析（acpBinPath 注入 > 真实依赖解析）', () => {
  it('acpBinPath 注入优先：自定义桥路径被 spawn（不经真实依赖解析）', async () => {
    // 把假桥复制到独立「自定义桥路径」，证明 driver 走注入而非 require.resolve
    const customBridge = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bridge-')),
      'custom-bridge.js',
    );
    fs.copyFileSync(FAKE_ACP_SCRIPT, customBridge);
    const h = makeHarness({ acpBinPath: customBridge });
    h.setFixture(startFixture());
    await h.driver.start(CLAUDE_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('真实依赖解析前置（包 0.23.1 已钉）：bin 字段 claude-agent-acp → 绝对路径存在', () => {
    // 与 driver 内 resolveAcpBinPath 同款解析链（codex 规格同级别：注入路径由上一
    // 用例覆盖，此处验证依赖钉对版本 + bin 键名 + 解析产物存在）
    const pkgJsonPath = require.resolve('@zed-industries/claude-agent-acp/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      version?: string;
      bin?: string | Record<string, string>;
    };
    expect(pkg.version).toBe('0.23.1'); // 精确钉版（防依赖漂移）
    const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['claude-agent-acp'];
    expect(binEntry).toBe('dist/index.js');
    expect(fs.existsSync(path.resolve(path.dirname(pkgJsonPath), binEntry!))).toBe(true);
  });
});

describe('ClaudeAcpDriver 档位映射（C2：claude 五值原语，平台四档单条 mode）', () => {
  it.each([
    ['default', 'default'],
    ['plan', 'plan'],
    ['auto', 'acceptEdits'],
    ['yolo', 'bypassPermissions'],
  ] as Array<[PermissionMode, string]>)(
    '档位 %s → set_config_option mode=%s',
    async (permissionMode, expectedMode) => {
      const h = makeHarness({ permissionMode });
      h.setFixture(startFixture());
      await h.driver.start({ ...CLAUDE_CONFIG, permissionMode });
      const modeReqs = h.getLog().filter((r) => r.method === 'session/set_config_option');
      expect(modeReqs).toHaveLength(1);
      expect(modeReqs[0]!.params).toMatchObject({ configId: 'mode', value: expectedMode });
    },
  );
});

describe('ClaudeAcpDriver ANTHROPIC_MODEL env（C1 模型注册保险：seat config 带 model 才注入）', () => {
  it('seat config 带 model → spawn env 注入 ANTHROPIC_MODEL=config.model', async () => {
    const h = makeHarness({ model: 'minimax-m3' });
    h.setFixture([...startFixture([{ respond: CONFIG_RESPOND }])]); // set_config_option model
    await h.driver.start({ ...CLAUDE_CONFIG, model: 'minimax-m3' });
    // 双保险落点：env 注册（availableModels 注册表入口）+ set_config_option 钉死（实际在跑）
    const envEntry = h.getLog().find((r) => r.direction === 'env');
    expect(envEntry!.env!.ANTHROPIC_MODEL).toBe('minimax-m3');
    const modelReq = h
      .getLog()
      .find((r) => r.method === 'session/set_config_option' && r.params!.configId === 'model');
    expect(modelReq!.params).toMatchObject({ configId: 'model', value: 'minimax-m3' });
  });

  it('seat config 无 model → env 不注入（ANTHROPIC_MODEL=null，会话跑默认模型）', async () => {
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(CLAUDE_CONFIG);
    const envEntry = h.getLog().find((r) => r.direction === 'env');
    expect(envEntry!.env!.ANTHROPIC_MODEL).toBeNull();
  });
});

describe('ClaudeAcpDriver 认证预检（C3：纯 env key，三分支）', () => {
  it('ANTHROPIC_API_KEY 存在（无 token、HOME 无 ~/.claude）→ start 正常', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-123';
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(CLAUDE_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('仅 ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL（兼容端点姿态）→ start 正常', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-test-123';
    process.env.ANTHROPIC_BASE_URL = 'https://compatible-gateway.example';
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(CLAUDE_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });

  it('key/token 皆无且 HOME 无 ~/.claude → start 失败带引导（R3 不静默兜底）', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-empty-'));
    const driver = new ClaudeAcpDriver({
      acpBinPath: FAKE_ACP_SCRIPT,
      getSessionId: () => undefined,
      logger: new NoopLogger(),
    });
    createdDrivers.push(driver);
    await expect(driver.start(CLAUDE_CONFIG)).rejects.toThrow(
      'claude-code auth not found: set ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL+key for compatible gateway) or run `claude /login` first',
    );
  });

  it('~/.claude 登录态目录存在（无 key/token）→ start 正常（`claude /login` 姿态）', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-login-'));
    fs.mkdirSync(path.join(homeDir, '.claude')); // 模拟 `claude /login` 后的登录态目录
    process.env.HOME = homeDir;
    const h = makeHarness();
    h.setFixture(startFixture());
    await h.driver.start(CLAUDE_CONFIG);
    expect(h.getLog().find((r) => r.method === 'initialize')).toBeDefined();
  });
});

describe('ClaudeAcpDriver seat_info 观测（claude 形状：currentModelId 恒 default，无 configOptions）', () => {
  it('session/new 响应 currentModelId=default + availableModels（C1 实测形状）→ seat_info model 用钉死值', async () => {
    const h = makeHarness({ model: 'minimax-m3' });
    h.setFixture([
      { respond: INIT_RESPOND },
      {
        respond: {
          result: {
            sessionId: 'sess-1',
            // C1：currentModelId 恒为 'default'（=Sonnet）；自定义模型只经
            // ANTHROPIC_MODEL env 进 availableModels 注册表——基座不认这两个键
            // （extractConfigSnapshot 只解析 configOptions），seat_info model 以
            // seat.assign 显式钉死值为准
            currentModelId: 'default',
            availableModels: ['default', 'minimax-m3'],
          },
        },
      },
      { respond: CONFIG_RESPOND }, // set_config_option mode
      { respond: CONFIG_RESPOND }, // set_config_option model
    ]);
    await h.driver.start({ ...CLAUDE_CONFIG, model: 'minimax-m3' });
    const info = (await waitForEvent(h.events, (e) => e.type === 'seat_info')) as Extract<
      SeatEvent,
      { type: 'seat_info' }
    >;
    expect(info.model).toBe('minimax-m3'); // 钉死值优先（C1 双保险的观测端）
    expect(info.mode).toBe('auto'); // 钉死档位为准
  });

  it('无显式 model → seat_info 不上报 model（会话默认模型不可观测，mode 恒上报）', async () => {
    const h = makeHarness();
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { result: { sessionId: 'sess-1', currentModelId: 'default' } } },
      { respond: CONFIG_RESPOND },
    ]);
    await h.driver.start(CLAUDE_CONFIG);
    const info = (await waitForEvent(h.events, (e) => e.type === 'seat_info')) as Extract<
      SeatEvent,
      { type: 'seat_info' }
    >;
    expect(info.model).toBeUndefined();
    expect(info.mode).toBe('auto');
  });
});

describe('ClaudeAcpDriver resume 复活（基座行为在 claude-code profile 下回归）', () => {
  it('resume 失败（缓存 sessionId 失效）→ 降级 session/new，落盘新 id + warn 日志', async () => {
    const warnSpy = jest.spyOn(NoopLogger.prototype, 'warn').mockImplementation(() => {});
    const h = makeHarness({ persistedSessionId: 'sess-stale' });
    h.setFixture([
      { respond: INIT_RESPOND },
      { respond: { error: { code: -32602, message: 'session not found' } } }, // session/resume 失败
      { respond: { result: { sessionId: 'sess-new' } } }, // 降级 session/new
      { respond: CONFIG_RESPOND }, // mode
    ]);
    await h.driver.start(CLAUDE_CONFIG);
    const log = h.getLog();
    expect(log.filter((r) => r.method === 'session/resume')).toHaveLength(1);
    expect(log.filter((r) => r.method === 'session/new')).toHaveLength(1);
    expect(h.sessionIds).toEqual(['sess-new']);
    const warnCalls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('session/resume failed'))).toBe(true);
  });
});
