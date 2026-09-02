// hooks.test.mjs — 入口级测试（计划 §7；测试即文档，铁律 #19）
// child_process spawn 喂 stdin 断言 stdout：模板 A-E golden string 快照 + fail-open 矩阵 + 日志行为。
// 分支②③④ 用本地 node:http mock server 提供 REST 响应（真实网络路径，非 mock 注入）。
// golden 与 lib/format.mjs 模板逐字一致（快照语义：模板文案变更需同步本文件）。
// SessionStart stdout 形态 = hookSpecificOutput JSON（实验 c，wrapSession 与 toHookJson 逐字一致）；
// PreCompact 仍是纯文本（其决策门单独观察，见 resume-context）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const SESSION_START = path.join(HOOKS_DIR, 'session-start.mjs');
const PRECOMPACT = path.join(HOOKS_DIR, 'precompact.mjs');
const TEST_KEY = 'ask_testkey1234567890';

// —— golden string 快照（与 lib/format.mjs 逐字一致）——
const GOLDEN_A = [
  '[agent-chamber] 未检测到接入配置：项目无 .kimi-code/agent-chamber.json（或 mcp.json 未配 chamber server）。',
  '接入三步：① 登录 chamber（无账号找管理员申请，注册是 admin-only）→ Agents 页创建 agent 复制 API key；② 按插件 README「接入 playbook」初始化（MCP 模式/ REST-only 任一）；③ 重启会话生效。',
].join('\n');
const GOLDEN_B = [
  '[agent-chamber] 已认证 chamber（agent: test-agent）· 活跃任务 3 · 未读 2',
  '本项目未绑定 board：在 .kimi-code/agent-chamber.json 填入 boardId / docSpaceId / topicId 后重启会话，即可注入项目 digest。没有 board 就先去 web 建一个。',
].join('\n');
const GOLDEN_C = [
  '[agent-chamber] test-agent · 项目「Test Board」· 活跃任务 3 · 未读 2',
  'bound: board=board-1',
  'board「Test Board」: 我的待办 2 — Task One / Task Two',
  'board「Other Board」: 我的待办 1 — Task Three',
  'topic「T1」: 未读 2',
  'nextUp（board 策展队列）: Task One',
  '深拉通道：get_topic_digest(topicId) / get_board_digest / get_docs_overview（或 REST 等价，见 skill）。',
].join('\n');
const GOLDEN_E =
  '[agent-chamber] 会话即将压缩。持久化提示：把当前工作状态（改动的文件、下一步、遗留问题）写入项目约定的交接记录（如 AGENTS.md 指定的位置），并同步 board 任务状态。';

// —— 本地 mock server（分支②③④ 的 REST 响应源）——
let server;
let baseUrl; // http://127.0.0.1:<port>/api/v1
let mcpUrl; //  http://127.0.0.1:<port>/mcp（推导回 baseUrl）

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/v1/boards/board-digest-fail/')) {
      // digest 失败降级场景：briefing 200 + digest 500
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 500, message: 'internal error', data: null }));
      return;
    }
    if (req.url.startsWith('/api/v1/agents/me/briefing')) {
      res.end(
        JSON.stringify({
          code: 200,
          message: 'ok',
          data: {
            me: { id: 'a1', name: 'test-agent', status: 'active' },
            activeTasks: {
              items: [
                { id: 't1', title: 'Task One', status: 'in_progress', boardId: 'board-1', boardName: 'Test Board' },
                { id: 't2', title: 'Task Two', status: 'todo', boardId: 'board-1', boardName: 'Test Board' },
                { id: 't3', title: 'Task Three', status: 'todo', boardId: 'board-2', boardName: 'Other Board' },
              ],
              total: 3,
            },
            unreadCounts: [{ topicId: 't1', topicName: 'T1', unreadCount: 2 }],
            recentActivities: [],
          },
        }),
      );
      return;
    }
    if (req.url.startsWith('/api/v1/boards/')) {
      res.end(
        JSON.stringify({
          code: 200,
          message: 'ok',
          data: {
            boardName: 'Test Board',
            nextUp: [{ id: 'x', title: 'Task One', priority: 'p1', status: 'todo', assigneeName: 'a' }],
            nextUpTotal: 1,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 404, message: 'not found', data: null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  mcpUrl = baseUrl.replace(/\/api\/v1$/, '/mcp');
});

after(() => new Promise((r) => server.close(r)));

// —— 工具 ——
/** spawn hook 喂 stdin，返回 { code, stdout, stderr } */
function runHook(script, stdin, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** 构造临时项目目录：files 的 { 文件名: 内容 } 写入 <tmp>/.kimi-code/；返回目录路径 */
function makeProject(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-hook-'));
  if (Object.keys(files).length > 0) {
    mkdirSync(path.join(dir, '.kimi-code'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, '.kimi-code', name), typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  return dir;
}

const sessionPayload = (cwd) => JSON.stringify({ hook_event_name: 'SessionStart', cwd });

/**
 * 专用 401 server：key 错场景——briefing 与 digest 全部 401（briefing 失败 → 模板 D）。
 * 为什么不用共享 server：共享 server 的 briefing 端点恒 200，allSettled 下 briefing 成功 + digest 401
 * 是降级路径（简报照出）而非模板 D；「key 错」必须两个端点都失败。
 */
async function startAuthServer() {
  const s = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ code: 401, message: 'unauthorized', data: null }));
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}/api/v1`;
  return { server: s, baseUrl: base, mcpUrl: base.replace(/\/api\/v1$/, '/mcp') };
}

/** 实验 c golden 包装：SessionStart stdout 应为单行 hookSpecificOutput JSON（与 lib/format.mjs toHookJson 逐字一致） */
const wrapSession = (text) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });

// —— 模板 golden 快照（三分支 + 配置异常 + PreCompact）——
test('分支①：无配置 → 模板 A（未接入）', async () => {
  const dir = makeProject({});
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession(GOLDEN_A));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分支②：有 key 无绑定 → 模板 B（已认证未绑定）', async () => {
  const dir = makeProject({
    'mcp.json': { mcpServers: { chamber: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession(GOLDEN_B));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分支③：有 key + 绑定 → 模板 C（全绑定，并行两 GET）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-1', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession(GOLDEN_C));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分支③ digest 失败降级：briefing 200 + digest 500 → 简报照出、无 nextUp 行（session-start 共用管线）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-digest-fail', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    const out = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.ok(out.includes('[agent-chamber] test-agent · 活跃任务 3 · 未读 2'), 'summary 应照出且省项目名段');
    assert.ok(out.includes('bound: board=board-digest-fail'), 'bound 行应照出');
    assert.ok(out.includes('board「Test Board」: 我的待办 2 — Task One / Task Two'), 'board 分组行应照出');
    assert.ok(!out.includes('nextUp'), 'digest 失败 → 无 nextUp 行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('分支④：REST 401 → 模板 D（配置异常，不静默但 exit 0）', async () => {
  const auth = await startAuthServer();
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-1', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: auth.mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession('[agent-chamber] chamber 连接异常（HTTP 401）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => auth.server.close(r));
  }
});

test('分支④：mcpServer 指针错配 → 模板 D（A4：与分支①完全未配置区分文案）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'b1', mcpServer: 'nonexistent-server' },
    'mcp.json': { mcpServers: { platform: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(
      stdout,
      wrapSession('[agent-chamber] chamber 连接异常（mcpServer 指针 "nonexistent-server" 未命中（server 不存在/非 HTTP/被禁用））：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('模板 E：PreCompact → 提醒文本（无 REST，常 fail-open）', async () => {
  const { code, stdout } = await runHook(PRECOMPACT, JSON.stringify({ hook_event_name: 'PreCompact', cwd: '/tmp' }));
  assert.equal(code, 0);
  assert.equal(stdout, GOLDEN_E);
});

// —— fail-open 矩阵（均 exit 0）——
test('fail-open：坏 stdin JSON → exit 0 无输出（静默）', async () => {
  const { code, stdout } = await runHook(SESSION_START, 'not-json{{{');
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('fail-open：绑定文件损坏 → exit 0（按无绑定处理 → 分支②）', async () => {
  const dir = makeProject({
    'agent-chamber.json': '{ bad json',
    'mcp.json': { mcpServers: { chamber: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession(GOLDEN_B));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-open：mcp.json 损坏 → exit 0（无 key → 分支①）', async () => {
  const dir = makeProject({ 'mcp.json': '{ bad json' });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession(GOLDEN_A));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-open：网络错误 → exit 0（分支④ 模板 D；端口 1 必连接拒绝）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'b1', apiBaseUrl: 'http://127.0.0.1:1/api/v1', apiKey: TEST_KEY },
  });
  try {
    const { code, stdout } = await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: path.join(dir, 'home') });
    assert.equal(code, 0);
    assert.equal(stdout, wrapSession('[agent-chamber] chamber 连接异常（network-error）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-open：内部抛异常（cwd 非字符串 → path.resolve 抛 TypeError）→ exit 0 无输出（静默）', async () => {
  // 畸形 payload 是真实场景：JSON 允许 cwd 为数字，path.resolve(123) 抛 TypeError → 顶层 catch 兜底
  const home = mkdtempSync(path.join(os.tmpdir(), 'ac-throw-'));
  try {
    const { code, stdout } = await runHook(
      SESSION_START,
      JSON.stringify({ hook_event_name: 'SessionStart', cwd: 123 }),
      { KIMI_CODE_HOME: home },
    );
    assert.equal(code, 0);
    assert.equal(stdout, '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('fail-open：PreCompact 坏 stdin JSON → exit 0 无输出', async () => {
  const { code, stdout } = await runHook(PRECOMPACT, 'not-json{{{');
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

// —— 日志行为（S5 脱敏 + A4 路径统一）——
test('日志：KIMI_CODE_HOME 临时目录隔离；不含 key、不含完整 URL；含错误消息与 status', async () => {
  const auth = await startAuthServer();
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-1', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: auth.mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  const home = path.join(dir, 'home');
  try {
    await runHook(SESSION_START, sessionPayload(dir), { KIMI_CODE_HOME: home });
    const logPath = path.join(home, 'logs', 'agent-chamber-hooks.log');
    assert.ok(existsSync(logPath), '日志文件应存在');
    const log = readFileSync(logPath, 'utf8');
    assert.ok(!log.includes(TEST_KEY), '日志不得含 key 值');
    assert.ok(!log.includes('http://'), '日志不得含完整 URL');
    assert.ok(log.includes('HTTP 401'), '日志应含错误消息');
    assert.ok(log.includes('"status":401'), '日志应含 HTTP status（白名单字段）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => auth.server.close(r));
  }
});

test('日志：坏 stdin JSON 不写日志（静默 fail-open 无噪音）', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ac-log-'));
  try {
    await runHook(SESSION_START, 'not-json{{{', { KIMI_CODE_HOME: home });
    assert.ok(!existsSync(path.join(home, 'logs', 'agent-chamber-hooks.log')), '坏 stdin 不应产生日志');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
