// bin.test.mjs — /agent-chamber:kanban /agent-chamber:topic 命令入口级测试（plan §3.2 / §4 批 2;测试即文档，铁律 #19）
// child_process spawn 跑 bin 脚本（cwd=临时项目目录），断言 stdout golden 逐字 + exit code。
// REST 响应由本地 node:http mock server 提供（真实网络路径，非 mock 注入——沿用 prompt-briefing.test.mjs 模式）。
// 场景路由 = apiBaseUrl 的 path 前缀（/api-v1-{scene}）：无状态、测试并行安全（不依赖共享可变状态）。
// 场景清单：basic(主干+混字段) / zero(0 个) / many(12 候选) / mine400(旧后端) / tasks404(显式 tasks 404)
//           / board404(显式 board 404) / topic404(显式 topic 404) / noauth(全部 401) / empty(空列表)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KANBAN = path.join(PLUGIN_DIR, 'bin', 'kanban.mjs');
const TOPIC = path.join(PLUGIN_DIR, 'bin', 'topic.mjs');
const TEST_KEY = 'ask_testkey1234567890';
/** content 超长截断基准（与 bin/topic.mjs CONTENT_MAX 对齐；断言用） */
const CONTENT_MAX = 160;

// —— fixtures（与 bin 输出格式一一对应）——
const BOARD_SINGLE = [{ id: 'board-1', name: 'Test Board' }];
const TOPIC_SINGLE = [{ id: 'topic-1', title: 'T1 Demo' }];
/** 3 项覆盖 formatTaskLine 缺字段三态：全字段 / 无 dueDate / 无 priority+assignee */
const TASKS_FIXTURE = [
  { id: 'task-1', title: 'Task One', status: 'todo', priority: 'p1', assigneeName: 'Alice', dueDate: '2026-09-01T10:00:00.000Z' },
  { id: 'task-2', title: 'Task Two', status: 'todo', priority: 'p2', assigneeName: 'Bob' },
  { id: 'task-3', title: 'Task Three', status: 'todo', dueDate: '2026-09-02' },
];
/** 3 条覆盖消息行三态：普通 / 多行压平 / 超 160 字截断 */
const LONG_CONTENT = '超长消息'.repeat(41); // 4 字 × 41 = 164 字 > CONTENT_MAX，触发截断
const MESSAGES_FIXTURE = [
  { id: 'msg-1', senderName: 'Alice', content: '第一个消息', createdAt: '2026-09-01T10:00:00.000Z' },
  { id: 'msg-2', senderName: 'Bob', content: '多行\n第二行', createdAt: '2026-09-01T10:05:00.000Z' },
  { id: 'msg-3', senderName: 'Carol', content: LONG_CONTENT, createdAt: '2026-09-01T10:10:00.000Z' },
];
/** 12 个 board（推断歧义候选，验证 ≤10 截断） */
const MANY_BOARDS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
  .map((name, i) => ({ id: `board-${i + 1}`, name: `Board ${name}` }));
/** 12 个 topic（推断歧义候选）；信封 total 刻意 = 150 ≠ items.length，验证 M-1 修订（文案取全量 total 而非当前页条数） */
const MANY_TOPICS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
  .map((name, i) => ({ id: `topic-${i + 1}`, title: `Topic ${name}` }));

/** REST 信封：{code,message,data}——bin 依赖 code===200 unwrap data */
function envelope(data, code = 200, message = 'ok') {
  return JSON.stringify({ code, message, data: code === 200 ? data : null });
}

/**
 * mock server 单请求处理器：按 scene（apiBaseUrl 路径前缀）→ 端点路径分派。
 * 为什么前缀而非共享状态：node:test 顶层用例理论上可并行，共享可变 state 会竞态；
 * scene 编码进 URL 后每个用例独立寻址，失败也不污染后续用例。
 */
// eslint-disable-next-line no-unused-vars
async function handleRequest(req, res) {
  res.setHeader('content-type', 'application/json');
  const m = /^\/(api-v1-[a-z0-9]+)(\/[^?]*)(\?.*)?$/.exec(req.url);
  if (!m) {
    res.statusCode = 404;
    res.end(envelope(null, 404, 'not found'));
    return;
  }
  const [, rawScene, pathName] = m;
  // scene = apiBaseUrl 路径前缀去掉 /api-v1-（如 api-v1-basic → basic），与 switch case 对齐
  const scene = rawScene.replace(/^api-v1-/, '');
  const ok = (data) => res.end(envelope(data));
  const err = (status) => {
    res.statusCode = status;
    res.end(envelope(null, status, `${status} error`));
  };

  switch (scene) {
    case 'basic': {
      if (pathName === '/boards') return ok({ items: BOARD_SINGLE, total: 1 });
      if (pathName === '/boards/board-1') return ok({ id: 'board-1', name: 'Test Board' });
      if (pathName === '/tasks') return ok({ items: TASKS_FIXTURE, total: TASKS_FIXTURE.length, page: 1, pageSize: 20, totalPages: 1, hasNext: false, hasPrev: false });
      if (pathName === '/topics') return ok({ items: TOPIC_SINGLE, total: 1 });
      if (pathName === '/topics/topic-1') return ok({ id: 'topic-1', title: 'T1 Demo' });
      if (pathName === '/topics/topic-1/messages') return ok({ messages: MESSAGES_FIXTURE, nextCursor: null, hasMore: false });
      return err(404);
    }
    case 'zero': {
      if (pathName === '/boards') return ok({ items: [], total: 0 });
      if (pathName === '/topics') return ok({ items: [], total: 0 });
      return err(404);
    }
    case 'many':
      if (pathName === '/boards') return ok({ items: MANY_BOARDS, total: MANY_BOARDS.length });
      return err(404);
    case 'manytopic':
      // M-1 验证场景：items 只给第一页（12 个），信封 total=150 —— 文案应报 150 而非 12
      if (pathName === '/topics') return ok({ items: MANY_TOPICS, total: 150 });
      return err(404);
    case 'mine400':
      // 旧后端（无 mine 声明的 DTO）：ValidationPipe forbidNonWhitelisted → 400
      if (pathName === '/boards' || pathName === '/topics') return err(400);
      return err(404);
    case 'tasks404':
      if (pathName === '/boards/board-1') return ok({ id: 'board-1', name: 'Test Board' });
      if (pathName === '/tasks') return err(404); // 显式 id 路径 tasks 404 = 绑定失效（P3）
      return err(404);
    case 'board404':
      if (pathName === '/boards/board-404') return err(404); // 显式 board fetch 404 = 绑定失效
      return err(404);
    case 'topic404':
      if (pathName === '/topics/topic-404') return err(404); // 显式 topic fetch 404 = 绑定失效
      return err(404);
    case 'noauth':
      return err(401); // 全面 401（连接异常路径）
    case 'empty':
      if (pathName === '/boards') return ok({ items: BOARD_SINGLE, total: 1 });
      if (pathName === '/tasks') return ok({ items: [], total: 0 });
      if (pathName === '/topics') return ok({ items: TOPIC_SINGLE, total: 1 });
      if (pathName === '/topics/topic-1/messages') return ok({ messages: [], nextCursor: null, hasMore: false });
      return err(404);
    default:
      return err(404);
  }
}

let server;
let port;

before(async () => {
  server = http.createServer(handleRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => new Promise((r) => server.close(r)));

// —— 工具 ——

/** 构造临时项目目录；config=null 表示「未接入」（无 .kimi-code/）；返回目录路径 */
function makeProject(config) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ac-bin-'));
  if (config !== null) {
    mkdirSync(path.join(dir, '.kimi-code'), { recursive: true });
    writeFileSync(path.join(dir, '.kimi-code', 'agent-chamber.json'), JSON.stringify(config));
  }
  return dir;
}

/** scene 专属 apiBaseUrl（127.0.0.1:随机端口 + scene 前缀，绕过 scheme 白名单且场景隔离） */
function baseOf(scene) {
  return `http://127.0.0.1:${port}/api-v1-${scene}`;
}

/** REST-only 绑定配置（config.mjs resolveKey 分支①：apiBaseUrl+apiKey 直用） */
function bind(scene, extra = {}) {
  return { schemaVersion: 1, apiBaseUrl: baseOf(scene), apiKey: TEST_KEY, ...extra };
}

/** spawn bin 脚本：cwd=临时项目（bin 用 process.cwd() 找 .kimi-code/），收集 stdout/stderr + exit code */
function runBin(script, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// —— golden 输出（与 plan §3.2 / bin 实现逐字一致）——
const KANBAN_GOLDEN = `board「Test Board」待办（todo）：共 3 项
- [p1] Task One（Alice，截止 2026-09-01T10:00:00.000Z）
- [p2] Task Two（Bob）
- Task Three（截止 2026-09-02）
`;
const KANBAN_GOLDEN_INFERRED = `board「Test Board」待办（todo）：共 3 项，自动推断自唯一参与 board
- [p1] Task One（Alice，截止 2026-09-01T10:00:00.000Z）
- [p2] Task Two（Bob）
- Task Three（截止 2026-09-02）
`;
const KANBAN_NONE_TEXT =
  '[agent-chamber] 绑定未配置且未能推断：你的 agent 当前创建/参与 0 个 board。请先创建或加入一个 board（或在 .kimi-code/agent-chamber.json 显式填写 boardId）后重试 /agent-chamber:kanban。\n';
const KANBAN_MINE_UNSUPPORTED_TEXT =
  '[agent-chamber] 当前 chamber 后端版本不支持绑定推断（列表接口缺少 mine 参数）。请在 .kimi-code/agent-chamber.json 显式填写 boardId，或升级 chamber 后端后再试。\n';
const KANBAN_BINDING_INVALID_TEXT =
  '[agent-chamber] 绑定的 board 不存在或已被删除，请检查 .kimi-code/agent-chamber.json 的 boardId。\n';
const NOT_CONFIGURED_TEXT =
  '[agent-chamber] 未检测到接入配置：项目无 .kimi-code/agent-chamber.json（或 mcp.json 未配 chamber server）。\n' +
  '接入三步：① 登录 chamber（无账号找管理员申请，注册是 admin-only）→ Agents 页创建 agent 复制 API key；② 按插件 README「接入 playbook」初始化（MCP 模式/ REST-only 任一）；③ 重启会话生效。\n';
const CONNECT_401_TEXT =
  '[agent-chamber] chamber 连接异常（HTTP 401）：检查 .kimi-code/agent-chamber.json 的 apiBaseUrl / apiKey 与 mcp.json 配置。\n';
const STATUS_INVALID_TEXT = '非法 status「wat」，合法值：backlog, todo, in_progress, review, done, blocked, archived, all\n';
const KANBAN_EMPTY_GOLDEN = `board「Test Board」待办（todo）：共 0 项，自动推断自唯一参与 board
无待办任务
`;
const TOPIC_MSG_LINES = [
  '- [2026-09-01 10:00] Alice: 第一个消息',
  '- [2026-09-01 10:05] Bob: 多行 第二行',
  `- [2026-09-01 10:10] Carol: ${LONG_CONTENT.slice(0, CONTENT_MAX)}…`,
].join('\n');
const TOPIC_GOLDEN = `topic「T1 Demo」最近 10 条消息
${TOPIC_MSG_LINES}
`;
const TOPIC_GOLDEN_INFERRED = `topic「T1 Demo」最近 10 条消息，自动推断自唯一参与 topic
${TOPIC_MSG_LINES}
`;
const TOPIC_EMPTY_GOLDEN = `topic「T1 Demo」最近 10 条消息，自动推断自唯一参与 topic
暂无消息
`;
const TOPIC_BINDING_INVALID_TEXT =
  '[agent-chamber] 绑定的 topic 不存在或已被删除，请检查 .kimi-code/agent-chamber.json 的 topicId。\n';
const TOPIC_NONE_TEXT =
  '[agent-chamber] 绑定未配置且未能推断：你的 agent 当前创建/参与 0 个活跃 topic。请先创建或加入一个 topic（或在 .kimi-code/agent-chamber.json 显式填写 topicId）后重试 /agent-chamber:topic。\n';

// —— kanban：显式绑定 / 推断 / 空 / 错误路径 ——
test('kanban 显式绑定成功：golden 逐字、exit 0、stderr 空', async () => {
  const dir = makeProject(bind('basic', { boardId: 'board-1' }));
  try {
    const { code, stdout, stderr } = await runBin(KANBAN, [], dir);
    assert.equal(code, 0);
    assert.equal(stdout, KANBAN_GOLDEN, 'stdout 应与 plan §3.2 输出规格逐字一致');
    assert.equal(stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 推断成功（恰 1 个）：列表命中 → 首行带自动推断标注', async () => {
  const dir = makeProject(bind('basic')); // 无 boardId → 推断
  try {
    const { code, stdout, stderr } = await runBin(KANBAN, [], dir);
    assert.equal(code, 0);
    assert.equal(stdout, KANBAN_GOLDEN_INFERRED, '推断路径首行应带「，自动推断自唯一参与 board」');
    assert.equal(stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 推断 0 个：none 文案 + exit 1', async () => {
  const dir = makeProject(bind('zero'));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, KANBAN_NONE_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 推断多个：候选列表 ≤10 + 省略标注（12 个 → 列 10）+ exit 1', async () => {
  const dir = makeProject(bind('many'));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.ok(stdout.includes('存在多个候选 board（共 12 个，仅列出前 10 个）'), '候选总数与截断标注应在首行');
    for (let i = 1; i <= 10; i++) {
      assert.ok(stdout.includes(`- board-${i} Board ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][i - 1]}`), `候选 ${i} 应列出`);
    }
    assert.ok(!stdout.includes('board-11'), '第 11 个候选不得列出（≤10 截断）');
    assert.ok(!stdout.includes('Board Eleven'), '第 11 个候选 name 不得出现');
    assert.ok(stdout.includes('请在 .kimi-code/agent-chamber.json 显式填写 boardId'), '结尾应引导显式绑定');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban mine-unsupported（旧后端 400）：降级文案 + 不回退候选 + exit 1', async () => {
  const dir = makeProject(bind('mine400'));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, KANBAN_MINE_UNSUPPORTED_TEXT, '400 应映射为 mine-unsupported 文案（A2）');
    assert.ok(!stdout.includes('候选'), '禁止回退非 mine 列表（不得出现候选引导）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban boardId 类型非法（数字）：invalid-config 文案 + exit 1，不静默落入推断（M-3）', async () => {
  // boardId 写成数字 123——非字符串非空配置，应报配置错误而非走 mine 推断
  const dir = makeProject(bind('basic', { boardId: 123 }));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.ok(stdout.includes('boardId 必须是字符串'), '非字符串 id 应报配置错误');
    assert.ok(!stdout.includes('候选') && !stdout.includes('未能推断'), '不得静默落入推断分支');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic topicId 类型非法（数字）：invalid-config 文案 + exit 1，不静默落入推断（M-3）', async () => {
  const dir = makeProject(bind('basic', { topicId: 123 }));
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 1);
    assert.ok(stdout.includes('topicId 必须是字符串'), '非字符串 id 应报配置错误');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 显式 id board fetch 404：绑定失效文案（P3）', async () => {
  const dir = makeProject(bind('board404', { boardId: 'board-404' }));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, KANBAN_BINDING_INVALID_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 显式 id tasks 404：绑定失效文案（P3，不混用连接异常）', async () => {
  const dir = makeProject(bind('tasks404', { boardId: 'board-1' }));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, KANBAN_BINDING_INVALID_TEXT, '显式 id 路径 tasks 404 = 绑定失效');
    assert.ok(!stdout.includes('连接异常'), '不得走连接异常文案');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 未接入（无配置）：接入三步文案 + exit 1', async () => {
  const dir = makeProject(null);
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, NOT_CONFIGURED_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 401：连接异常文案 + exit 1（确定性错误）', async () => {
  const dir = makeProject(bind('noauth', { boardId: 'board-1' }));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, CONNECT_401_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 参数非法：status 非合法值 → 列合法值清单 + exit 1（请求前拦截）', async () => {
  const dir = makeProject(bind('basic', { boardId: 'board-1' }));
  try {
    const { code, stdout } = await runBin(KANBAN, ['wat'], dir);
    assert.equal(code, 1);
    assert.equal(stdout, STATUS_INVALID_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kanban 空任务：共 0 项 + 无待办任务', async () => {
  const dir = makeProject(bind('empty'));
  try {
    const { code, stdout } = await runBin(KANBAN, [], dir);
    assert.equal(code, 0);
    assert.equal(stdout, KANBAN_EMPTY_GOLDEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— topic：显式 / 推断 / 空 / 错误路径 ——
test('topic 显式绑定成功：golden 逐字（含时间格式化/多行压平/160 截断）+ exit 0', async () => {
  // topicId 带首尾空白（' topic-1 '）→ 验证显式 id trim 逻辑
  const dir = makeProject(bind('basic', { topicId: ' topic-1 ' }));
  try {
    const { code, stdout, stderr } = await runBin(TOPIC, [], dir);
    assert.equal(code, 0);
    assert.equal(stdout, TOPIC_GOLDEN, 'stdout 应与 plan §3.2 输出规格逐字一致');
    assert.equal(stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 推断成功（恰 1 个）：列表命中 → 首行带自动推断标注', async () => {
  const dir = makeProject(bind('basic')); // 无 topicId → 推断
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 0);
    assert.equal(stdout, TOPIC_GOLDEN_INFERRED);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 空消息：暂无消息', async () => {
  const dir = makeProject(bind('empty'));
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 0);
    assert.equal(stdout, TOPIC_EMPTY_GOLDEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 显式 id 404：绑定失效文案（P3）', async () => {
  const dir = makeProject(bind('topic404', { topicId: 'topic-404' }));
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, TOPIC_BINDING_INVALID_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 推断 0 个：none 文案（topic 口径）+ exit 1', async () => {
  const dir = makeProject(bind('zero'));
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 1);
    assert.equal(stdout, TOPIC_NONE_TEXT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 推断多个：候选 ≤10 + 省略标注取信封全量 total（M-1：150 ≠ 当前页 12）+ exit 1', async () => {
  const dir = makeProject(bind('manytopic'));
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 1);
    assert.ok(stdout.includes('存在多个候选 topic（共 150 个，仅列出前 10 个）'), '总数应取信封 total=150（M-1）');
    for (let i = 1; i <= 10; i++) {
      assert.ok(stdout.includes(`- topic-${i} Topic ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][i - 1]}`), `候选 ${i} 应列出`);
    }
    assert.ok(!stdout.includes('topic-11'), '第 11 个候选不得列出（≤10 截断）');
    assert.ok(stdout.includes('请在 .kimi-code/agent-chamber.json 显式填写 topicId'), '结尾应引导显式绑定');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic mine-unsupported（旧后端 400）：降级文案 + 不回退候选 + exit 1（M-2 补 topic 侧直测）', async () => {
  const dir = makeProject(bind('mine400'));
  try {
    const { code, stdout } = await runBin(TOPIC, [], dir);
    assert.equal(code, 1);
    assert.ok(stdout.includes('不支持绑定推断'), '400 应映射为 mine-unsupported 文案（A2）');
    assert.ok(!stdout.includes('候选'), '禁止回退非 mine 列表（不得出现候选引导）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 参数非法：N 越界/非数字 → 报错列出合法区间 + exit 1（请求前拦截）', async () => {
  const dir = makeProject(bind('basic', { topicId: 'topic-1' }));
  try {
    for (const bad of ['0', '51', 'abc', '-1']) {
      const { code, stdout } = await runBin(TOPIC, [bad], dir);
      assert.equal(code, 1, `N=${bad} 应 exit 1`);
      assert.equal(stdout, `N 必须为 1-50 的整数（收到「${bad}」）\n`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('topic 消息行 content 截断边界：160 字截断加单个省略号', async () => {
  // 复用 basic fixtures：LONG_CONTENT = 164 字 > CONTENT_MAX → 截为 160 + 「…」，且只有一个省略号（无叠加）
  const dir = makeProject(bind('basic', { topicId: 'topic-1' }));
  try {
    const { code, stdout } = await runBin(TOPIC, ['10'], dir);
    assert.equal(code, 0);
    assert.ok(LONG_CONTENT.length > CONTENT_MAX, 'fixture 应超过 160 字触发截断');
    const line3 = stdout.split('\n')[3]; // 0-base 第 3 行 = Carol 行
    assert.equal(line3, `- [2026-09-01 10:10] Carol: ${LONG_CONTENT.slice(0, CONTENT_MAX)}…`);
    assert.equal(line3.split('…').length - 1, 1, '省略号只能有一个（无叠加截断）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
