// prompt-briefing.test.mjs — UserPromptSubmit hook 入口级测试（实验 d；测试即文档，铁律 #19）
// child_process spawn 喂 stdin 断言 stdout：模板 A/C golden string 快照 + 会话级去重 + transient 不写 marker + fail-open。
// 分支②③④ 用本地 node:http mock server 提供 REST 响应（真实网络路径，非 mock 注入）。
// 与 hooks.test.mjs 的关键差异：UserPromptSubmit stdout 是纯文本（文档承诺的注入通路），无 hookSpecificOutput JSON 包装。
// marker 目录经 CHAMBER_HOOK_STATE_DIR 重定向到 tmp（测试隔离，不碰真实 ~/.kimi-code）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const PROMPT_BRIEFING = path.join(HOOKS_DIR, 'prompt-briefing.mjs');
const TEST_KEY = 'ask_testkey1234567890';

// —— golden string 快照（与 lib/format.mjs 逐字一致；纯文本，无 JSON 包装）——
const GOLDEN_A = [
  '[agent-chamber] 未检测到接入配置：项目无 .kimi-code/agent-chamber.json（或 mcp.json 未配 chamber server）。',
  '接入三步：① 登录 chamber（无账号找管理员申请，注册是 admin-only）→ Agents 页创建 agent 复制 API key；② 按插件 README「接入 playbook」初始化（MCP 模式/ REST-only 任一）；③ 重启会话生效。',
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
const GOLDEN_D_NETWORK =
  '[agent-chamber] chamber 连接异常（network-error）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。';
const GOLDEN_D_401 =
  '[agent-chamber] chamber 连接异常（HTTP 401）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。';

// —— 本地 mock server（bound / 401 场景的 REST 响应源）——
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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-pb-'));
  if (Object.keys(files).length > 0) {
    mkdirSync(path.join(dir, '.kimi-code'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, '.kimi-code', name), typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  return dir;
}

/** 独立 marker 目录（CHAMBER_HOOK_STATE_DIR 重定向，测试隔离） */
function makeStateDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'ac-pb-state-'));
}

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

/** UserPromptSubmit payload（session_id 可覆盖） */
const promptPayload = (cwd, sessionId = 'sess-001') =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd });

// —— 首条消息注入 + 会话级去重 ——
test('首条消息注入：bound → 纯文本模板 C、exit 0、marker 已创建', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-1', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  const stateDir = makeStateDir();
  try {
    const { code, stdout, stderr } = await runHook(PROMPT_BRIEFING, promptPayload(dir), {
      KIMI_CODE_HOME: path.join(dir, 'home'),
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, GOLDEN_C, 'stdout 应为纯文本模板 C（无 hookSpecificOutput JSON 包装）');
    assert.equal(stderr, '', 'stderr 必须为空（stderr 是阻塞语义）');
    const markerPath = path.join(stateDir, 'sess-001');
    assert.ok(existsSync(markerPath), 'marker 应已创建');
    assert.ok(readFileSync(markerPath, 'utf8').includes('bound'), 'marker 内容应含注入结果类别 bound');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('digest 失败降级：briefing 200 + digest 500 → 简报照出、无 nextUp 行、marker 照写（bound）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-digest-fail', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  const stateDir = makeStateDir();
  try {
    const { code, stdout, stderr } = await runHook(PROMPT_BRIEFING, promptPayload(dir), {
      KIMI_CODE_HOME: path.join(dir, 'home'),
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stderr, '', 'stderr 必须为空（stderr 是阻塞语义）');
    // 简报照出：summary（digest 失败 → 省「项目「」」段）+ bound + board 分组 + topic + 深拉通道
    assert.ok(stdout.includes('[agent-chamber] test-agent · 活跃任务 3 · 未读 2'), 'summary 应照出且省项目名段');
    assert.ok(stdout.includes('bound: board=board-digest-fail'), 'bound 行应照出');
    assert.ok(stdout.includes('board「Test Board」: 我的待办 2 — Task One / Task Two'), 'board 分组行应照出');
    assert.ok(stdout.includes('topic「T1」: 未读 2'), 'topic 行应照出');
    assert.ok(!stdout.includes('nextUp'), 'digest 失败 → 无 nextUp 行');
    assert.ok(
      stdout.includes('深拉通道：get_topic_digest(topicId) / get_board_digest / get_docs_overview（或 REST 等价，见 skill）。'),
      '深拉通道行应照出',
    );
    const markerPath = path.join(stateDir, 'sess-001');
    assert.ok(existsSync(markerPath), 'digest 失败降级仍应写 marker（bound，下个 session 自然重试）');
    assert.ok(readFileSync(markerPath, 'utf8').includes('bound'), 'marker 内容应含 bound');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('同 session_id 第二条消息 → stdout 为空、exit 0（会话级去重）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-1', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  const stateDir = makeStateDir();
  try {
    const env = { KIMI_CODE_HOME: path.join(dir, 'home'), CHAMBER_HOOK_STATE_DIR: stateDir };
    const first = await runHook(PROMPT_BRIEFING, promptPayload(dir), env);
    assert.equal(first.code, 0);
    assert.ok(first.stdout.includes('[agent-chamber]'), '首条应注入');
    const second = await runHook(PROMPT_BRIEFING, promptPayload(dir), env);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', '第二条 stdout 必须为空');
    assert.equal(second.stderr, '', 'stderr 必须为空');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('session_id 缺失 → fallback cwd 做 key：同 cwd 第二条静默', async () => {
  const dir = makeProject({});
  const stateDir = makeStateDir();
  try {
    const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: dir });
    const env = { KIMI_CODE_HOME: path.join(dir, 'home'), CHAMBER_HOOK_STATE_DIR: stateDir };
    const first = await runHook(PROMPT_BRIEFING, payload, env);
    assert.equal(first.code, 0);
    assert.ok(first.stdout.includes('[agent-chamber]'), '首条应注入（未接入 → 模板 A）');
    assert.ok(existsSync(path.join(stateDir, dir.replace(/[^a-zA-Z0-9_-]/g, '_'))), 'marker 名应为消毒后的 cwd');
    const second = await runHook(PROMPT_BRIEFING, payload, env);
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '', '同 cwd 第二条应静默');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// —— transient 不写 marker（下条消息重试）——
test('transient：网络错误 → 模板 D 输出但 marker 不写（下条消息可重试）', async () => {
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'b1', apiBaseUrl: 'http://127.0.0.1:1/api/v1', apiKey: TEST_KEY },
  });
  const stateDir = makeStateDir();
  try {
    const { code, stdout } = await runHook(PROMPT_BRIEFING, promptPayload(dir), {
      KIMI_CODE_HOME: path.join(dir, 'home'),
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, GOLDEN_D_NETWORK, '网络错误 → 模板 D（不静默但 exit 0）');
    assert.ok(!existsSync(path.join(stateDir, 'sess-001')), 'transient 失败不得写 marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// —— 确定性结果写 marker ——
test('未接入 → 模板 A + marker 写入（确定性，避免每条消息重复提示）', async () => {
  const dir = makeProject({});
  const stateDir = makeStateDir();
  try {
    const { code, stdout } = await runHook(PROMPT_BRIEFING, promptPayload(dir), {
      KIMI_CODE_HOME: path.join(dir, 'home'),
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, GOLDEN_A);
    const markerPath = path.join(stateDir, 'sess-001');
    assert.ok(existsSync(markerPath), '未接入是确定性结果，应写 marker');
    assert.ok(readFileSync(markerPath, 'utf8').includes('not-configured'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('401 → 模板 D + marker 写入（确定性，key 错重试无意义）', async () => {
  const auth = await startAuthServer();
  const dir = makeProject({
    'agent-chamber.json': { schemaVersion: 1, boardId: 'board-1', mcpServer: 'platform' },
    'mcp.json': { mcpServers: { platform: { url: auth.mcpUrl, headers: { 'X-API-Key': TEST_KEY } } } },
  });
  const stateDir = makeStateDir();
  try {
    const { code, stdout } = await runHook(PROMPT_BRIEFING, promptPayload(dir), {
      KIMI_CODE_HOME: path.join(dir, 'home'),
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, GOLDEN_D_401);
    const markerPath = path.join(stateDir, 'sess-001');
    assert.ok(existsSync(markerPath), '401 是确定性结果，应写 marker');
    assert.ok(readFileSync(markerPath, 'utf8').includes('config-error'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    await new Promise((r) => auth.server.close(r));
  }
});

// —— fail-open 矩阵 ——
test('fail-open：坏 stdin JSON → exit 0 无输出、无 marker', async () => {
  const stateDir = makeStateDir();
  const homeDir = makeStateDir(); // 独立 home（logger 会写日志，避免污染 stateDir 断言）
  try {
    const { code, stdout, stderr } = await runHook(PROMPT_BRIEFING, 'not-json{{{', {
      KIMI_CODE_HOME: homeDir,
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.equal(readdirSyncSafe(stateDir).length, 0, '坏 stdin 不应产生 marker');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// —— 超期 marker 清理（best-effort）——
test('清理：mtime 超 7 天的 marker 被删，新 marker 保留', async () => {
  const dir = makeProject({});
  const stateDir = makeStateDir();
  try {
    // 伪造一个 8 天前的旧 marker + 一个 1 天前的新 marker
    const stale = path.join(stateDir, 'stale-sess');
    const fresh = path.join(stateDir, 'fresh-sess');
    writeFileSync(stale, 'old');
    writeFileSync(fresh, 'new');
    const now = Date.now();
    utimesSync(stale, new Date(now - 8 * 24 * 60 * 60 * 1000), new Date(now - 8 * 24 * 60 * 60 * 1000));
    utimesSync(fresh, new Date(now - 24 * 60 * 60 * 1000), new Date(now - 24 * 60 * 60 * 1000));
    // 跑一次 hook（未接入 → 模板 A + 写当前 marker）
    const { code, stdout } = await runHook(PROMPT_BRIEFING, promptPayload(dir, 'sess-clean'), {
      KIMI_CODE_HOME: path.join(dir, 'home'),
      CHAMBER_HOOK_STATE_DIR: stateDir,
    });
    assert.equal(code, 0);
    assert.equal(stdout, GOLDEN_A);
    assert.ok(!existsSync(stale), '超期 marker 应被清理');
    assert.ok(existsSync(fresh), '未超期 marker 应保留');
    assert.ok(existsSync(path.join(stateDir, 'sess-clean')), '本次注入的 marker 应存在');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

/** 安全列目录（坏 stdin 用例断言用；目录不存在返回空数组） */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
