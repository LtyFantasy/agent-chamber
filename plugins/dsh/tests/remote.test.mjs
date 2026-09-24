// remote.test.mjs — dsh-agent-chamber Remote namespace（批 1）测试。
// 风格范式沿用 chamber.test.mjs：node:test + 捕获式 logger + 假 ctx + mock fetch（无真实网络）。
// 协议相关用例（Remote markers 官方读法）优先用真实 @deepseek-ai/dsh-typert-protocol
// （经 PATH 上的 dsh bin 软链锚定解析，同生产通路）；机器无 dsh 时 t.skip 优雅跳过。
// 运行法（仓根）：node --test plugins/dsh/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_TTL_MS,
  PARTIAL_CACHE_TTL_MS,
  PanelError,
  REMOTE_NAMESPACE,
  combineSignals,
  createPanelStateProvider,
  defineChamberService,
  deriveWebBaseUrl,
  resolveBinding,
  resolveProtocolModule,
  setupChamberRemote,
  sortTasks,
  toTaskEntry,
} from '../lib/remote.mjs';

/** 测试绑定常量：resolveBinding 注入形态的公共输入（https 合法 scheme） */
const BINDING = { apiBaseUrl: 'https://platform.example.com/api/v1', apiKey: 'ask_testkey_remote', boardId: 'b-main' };

/** TaskEntry 契约九键（plan §3 逐字）——键集漂移即契约漂移，测试硬断言 */
const TASK_ENTRY_KEYS = ['assigneeName', 'dueDate', 'id', 'isMine', 'labels', 'listName', 'priority', 'status', 'title', 'updatedAt'];

// ———————————————————————————— 测试基础设施 ————————————————————————————

/** 捕获式日志器（与 chamber.test.mjs 同款）：三严重度分行收集；has() 子串断言 */
function makeLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: () => {},
    has(level, needle) {
      return lines[level].some((line) => line.includes(needle));
    },
  };
}

/** 假 Cordis ctx（任务书指定形态）：reflect.provide 收注册、interval 空操作——dsh 本体不进测试进程 */
function makeCtx() {
  const logger = makeLogger();
  const provided = [];
  const ctx = {
    logger,
    reflect: {
      provide: (name, instance) => {
        provided.push({ name, instance });
        return () => {};
      },
    },
    interval: () => () => {},
  };
  return { ctx, logger, provided };
}

/** 假时钟：TTL 断言的确定性来源（禁 sleep 猜时序） */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/** 平台信封与响应构造（已实证形状 {code,message,data:{items,...}}） */
const envelope = (data) => ({ code: 200, message: 'ok', data });
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** mock fetch：handler 路由 + 调用记录（url/init 都记，header/signal 断言用） */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const out = await handler(String(url), init);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetchImpl, calls };
}

/**
 * 标准 mock platform 路由：/boards、/agents/me、/tasks 三路。
 * tasksByBoard 值支持三种形态：数组（成功项）| {status, body}（HTTP 错误）| Error（fetch 抛错）。
 */
function platformHandler({ boards, me, tasksByBoard = {} }) {
  return (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/boards')) return jsonRes(envelope({ items: boards }));
    if (u.pathname.endsWith('/agents/me')) return jsonRes(envelope(me));
    if (u.pathname.endsWith('/tasks')) {
      const r = tasksByBoard[u.searchParams.get('boardId')];
      if (r instanceof Error) throw r;
      if (r && typeof r === 'object' && !Array.isArray(r)) return jsonRes(r.body ?? { code: r.status, message: 'err', data: null }, r.status);
      const items = r ?? [];
      return jsonRes(envelope({ items, total: items.length }));
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

/**  deferred：single-flight 并发窗口的精确控制（先发两调用，再放行 boards 响应） */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 经 PATH 找 dsh bin 软链作协议解析锚点（生产通路 = process.argv[1]，测试进程锚点是 test runner 必然失败） */
function findDshAnchor() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'dsh');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 真实协议装载（与生产同通路 resolveProtocolModule）；不可解析 → null（调用方 t.skip） */
async function loadRealProtocol() {
  const anchor = findDshAnchor();
  if (!anchor) return null;
  try {
    return await resolveProtocolModule(anchor);
  } catch {
    return null;
  }
}

/** 最小假协议：不依赖 dsh 的故障隔离语义验证（RemoteError 结构标记 + provide 注册对齐真实行为） */
function makeFakeProtocol() {
  return {
    Remote: (_method, context) => context.addInitializer(function () {}),
    RemoteError: class extends Error {
      constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.isDSHRemoteError = true;
      }
    },
    TypertRemoteService: class {
      constructor(ctx, key) {
        this.ctx = ctx;
        this.name = key;
        ctx.reflect.provide(key, this);
        this.typertRemote = { service: this, serviceKey: key, namespace: key };
      }
    },
    remoteMethods: () => [],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ———————————————————————————— 正常聚合 ————————————————————————————

test('聚合：多 board 混合五态 + isMine trim/大小写不敏感 + 契约字段形状', async () => {
  const boards = [
    { id: 'b1', name: 'Alpha', visibility: 'private', taskCount: 5, completedTaskCount: 2 },
    { id: 'b2', name: 'Beta', visibility: 'topic', taskCount: 3, completedTaskCount: 1 },
  ];
  const tasksB1 = [
    { id: 't-todo', title: 'Todo task', status: 'todo', priority: 'medium', listName: 'Todo', labels: ['ui'], assigneeName: 'other-agent', dueDate: null, updatedAt: '2026-09-17T01:00:00.000Z' },
    { id: 't-review', title: 'Review task', status: 'review', priority: 'high', listName: 'Review', labels: [], assigneeName: ' test-agent ', dueDate: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-17T05:00:00.000Z' },
    { id: 't-blocked', title: 'Blocked task', status: 'blocked', priority: 'urgent', listName: 'Doing', labels: ['backend', 'p0'], assigneeName: 'TEST-AGENT', dueDate: null, updatedAt: '2026-09-17T04:00:00.000Z' },
    { id: 't-doing', title: 'Doing task', status: 'in_progress', priority: 'high', listName: 'Doing', labels: [], assigneeName: null, dueDate: null, updatedAt: '2026-09-17T03:00:00.000Z' },
    { id: 't-backlog', title: 'Backlog task', status: 'backlog', priority: 'low', listName: 'Backlog', labels: [], assigneeName: 'someone', dueDate: null, updatedAt: '2026-09-17T06:00:00.000Z' },
  ];
  const tasksB2 = [{ id: 't-b2', title: 'Beta todo', status: 'todo', priority: 'low', listName: 'Todo', labels: [], assigneeName: null, dueDate: null, updatedAt: '2026-09-16T01:00:00.000Z' }];
  const { fetchImpl, calls } = makeFetch(platformHandler({ boards, me: { name: 'Test-Agent' }, tasksByBoard: { b1: tasksB1, b2: tasksB2 } }));
  const clock = makeClock();
  const logger = makeLogger();
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl, now: clock.now, logger });

  const value = await provider.getPanelState(new AbortController().signal);
  assert.equal(value.bound, true);
  assert.equal(value.partial, false);
  assert.ok(!Number.isNaN(Date.parse(value.fetchedAt)), 'fetchedAt 应为 ISO 时间串');
  assert.equal(value.boards.length, 2);

  // BoardEntry 白名单投影：visibility 等多余字段不下发（契约五键 = 四字段 + tasks）
  const [e1, e2] = value.boards;
  assert.deepEqual(Object.keys(e1).sort(), ['completedTaskCount', 'id', 'name', 'taskCount', 'tasks']);
  assert.equal(e1.id, 'b1');
  assert.equal(e1.name, 'Alpha');
  assert.equal(e1.taskCount, 5);
  assert.equal(e1.completedTaskCount, 2);
  assert.equal(e1.tasks.length, 5);
  assert.equal(e2.tasks.length, 1);

  // TaskEntry 九键契约 + 五态排序（review 最前、backlog 最后）
  for (const task of e1.tasks) assert.deepEqual(Object.keys(task).sort(), TASK_ENTRY_KEYS);
  assert.deepEqual(
    e1.tasks.map((t) => t.status),
    ['review', 'blocked', 'in_progress', 'todo', 'backlog'],
  );

  // isMine：' test-agent '（含空格）与 'TEST-AGENT'（大写）均应命中 me='Test-Agent'（trim + 大小写不敏感）
  const byId = Object.fromEntries(e1.tasks.map((t) => [t.id, t]));
  assert.equal(byId['t-review'].isMine, true, '含空格的 assigneeName 应 trim 后命中');
  assert.equal(byId['t-blocked'].isMine, true, '大小写差异应不敏感命中');
  assert.equal(byId['t-doing'].isMine, false, 'assigneeName null → false');
  assert.equal(byId['t-todo'].isMine, false, '他人 → false');

  // REST 形状断言：boards 1 次 + me 1 次 + tasks 2 次；查询参数与 X-API-Key 逐字
  const urls = calls.map((c) => c.url);
  assert.equal(urls.filter((u) => u.includes('/boards')).length, 1);
  assert.ok(urls.some((u) => u.includes('/boards?pageSize=50')));
  assert.equal(urls.filter((u) => u.includes('/agents/me')).length, 1);
  const taskUrls = urls.filter((u) => u.includes('/tasks'));
  assert.equal(taskUrls.length, 2);
  for (const u of taskUrls) {
    assert.ok(u.includes('status=backlog,todo,in_progress,blocked,review'), '五态过滤逐字');
    assert.ok(u.includes('pageSize=100'));
  }
  assert.ok(taskUrls.some((u) => u.includes('boardId=b1')) && taskUrls.some((u) => u.includes('boardId=b2')));
  for (const c of calls) {
    assert.equal(c.init.headers['X-API-Key'], BINDING.apiKey, '每路带 X-API-Key');
    assert.ok(c.init.signal instanceof AbortSignal, '每路带合并取消信号');
  }
  assert.ok(logger.has('info', '[agent-chamber] panel=fetch boards=2 partial=0'), 'plan §9 成功判定日志');
});

// ———————————————————————————— bound:false 家族 ————————————————————————————

test('未绑定：resolveBinding null → bound:false/unbound，零 fetch', async () => {
  const provider = createPanelStateProvider({
    resolveBinding: () => null,
    fetchImpl: () => {
      throw new Error('must not fetch');
    },
  });
  assert.deepEqual(await provider.getPanelState(), { bound: false, reason: 'unbound' });
});

test('401 → bound:false/unauthorized（HTTP 401 与信封 code 401 双形态）', async () => {
  // 形态①：HTTP 401
  const http401 = makeFetch(() => jsonRes({ code: 401, message: 'unauthorized', data: null }, 401));
  const p1 = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl: http401.fetchImpl });
  assert.deepEqual(await p1.getPanelState(), { bound: false, reason: 'unauthorized' });
  // 形态②：HTTP 200 但信封 code 401
  const code401 = makeFetch(() => jsonRes({ code: 401, message: 'unauthorized', data: null }, 200));
  const p2 = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl: code401.fetchImpl });
  assert.deepEqual(await p2.getPanelState(), { bound: false, reason: 'unauthorized' });
});

test('boards fetch 网络抛错 → throw PanelError(unreachable)（details 带 reason/status）', async () => {
  const { fetchImpl } = makeFetch(() => new TypeError('fetch failed'));
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl });
  await assert.rejects(provider.getPanelState(), (error) => {
    assert.ok(error instanceof PanelError);
    assert.equal(error.code, 'unreachable');
    assert.equal(error.details.reason, 'network-error');
    return true;
  });
  // throw 不进缓存：下一轮立即重试（unreachable 由浏览器 30s 轮询自然恢复）
  await assert.rejects(provider.getPanelState(), (error) => error.code === 'unreachable');
});

// ———————————————————————————— 缓存与 single-flight ————————————————————————————

test('单 board 失败 → partial:true + 该 entry error.code + TTL 缩至 5s', async () => {
  const boards = [
    { id: 'b1', name: 'Alpha', taskCount: 2, completedTaskCount: 0 },
    { id: 'b2', name: 'Beta', taskCount: 1, completedTaskCount: 1 },
  ];
  const tasksByBoard = {
    b1: { status: 500 }, // HTTP 错误形态
    b2: [{ id: 't-ok', title: 'ok', status: 'todo', priority: 'low', listName: 'Todo', labels: [], assigneeName: null, dueDate: null, updatedAt: '2026-09-17T00:00:00.000Z' }],
  };
  const { fetchImpl, calls } = makeFetch(platformHandler({ boards, me: { name: 'me' }, tasksByBoard }));
  const clock = makeClock();
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl, now: clock.now });

  const v1 = await provider.getPanelState();
  assert.equal(v1.partial, true);
  const [e1, e2] = v1.boards;
  assert.deepEqual(e1.error, { code: 'http-500' }, '失败 board 带 error.code');
  assert.equal(e1.tasks, undefined, '失败 board 无 tasks 键');
  assert.ok(Array.isArray(e2.tasks), '成功 board 正常聚合');

  const boardsCalls = () => calls.filter((c) => c.url.includes('/boards')).length;
  assert.equal(boardsCalls(), 1);
  clock.advance(4_000); // partial TTL(5s) 内 → 缓存命中
  assert.equal(await provider.getPanelState(), v1, 'partial TTL 内返回同一对象');
  assert.equal(boardsCalls(), 1, '命中不重抓');
  clock.advance(1_500); // 总计 5.5s > 5s → 过期重抓
  await provider.getPanelState();
  assert.equal(boardsCalls(), 2, 'partial TTL 过期后重抓');
});

test('TTL 命中不重复抓：60s 内返回同一对象；过期后重抓', async () => {
  const boards = [{ id: 'b1', name: 'Alpha', taskCount: 0, completedTaskCount: 0 }];
  const { fetchImpl, calls } = makeFetch(platformHandler({ boards, me: { name: 'me' }, tasksByBoard: { b1: [] } }));
  const clock = makeClock();
  const logger = makeLogger();
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl, now: clock.now, logger });

  const v1 = await provider.getPanelState();
  const v2 = await provider.getPanelState();
  assert.equal(v2, v1, 'TTL 内引用相等（幂等）');
  assert.equal(calls.filter((c) => c.url.includes('/boards')).length, 1);
  assert.equal(logger.lines.info.filter((l) => l.includes('panel=fetch')).length, 1, '缓存命中不打 fetch 日志');

  clock.advance(CACHE_TTL_MS + 1);
  const v3 = await provider.getPanelState();
  assert.notEqual(v3, v1, '过期后是新对象');
  assert.equal(calls.filter((c) => c.url.includes('/boards')).length, 2);
});

test('single-flight：TTL 未命中并发调用共享同一 in-flight Promise（多 tab 首击不穿透）', async () => {
  const boardsGate = deferred();
  const boards = [{ id: 'b1', name: 'Alpha', taskCount: 1, completedTaskCount: 0 }];
  const { fetchImpl, calls } = makeFetch((url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/boards')) return boardsGate.promise; // 挂住 boards，制造并发窗口
    return platformHandler({ boards, me: { name: 'me' }, tasksByBoard: { b1: [] } })(url);
  });
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl });

  const p1 = provider.getPanelState();
  const p2 = provider.getPanelState();
  assert.equal(p2, p1, '并发调用返回同一 in-flight Promise');
  await sleep(20); // 给误穿透留窗口
  assert.equal(calls.filter((c) => c.url.includes('/boards')).length, 1, 'boards 只抓一次');

  boardsGate.resolve(jsonRes(envelope({ items: boards })));
  const [v1, v2] = await Promise.all([p1, p2]);
  assert.equal(v1, v2);
  assert.equal(v1.bound, true);
});

test('bustCache 后重抓（手动刷新语义）', async () => {
  const boards = [{ id: 'b1', name: 'Alpha', taskCount: 0, completedTaskCount: 0 }];
  const { fetchImpl, calls } = makeFetch(platformHandler({ boards, me: { name: 'me' }, tasksByBoard: { b1: [] } }));
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl });

  const v1 = await provider.getPanelState();
  provider.bustCache();
  const v2 = await provider.getPanelState();
  assert.notEqual(v2, v1, 'bust 后重抓产新对象');
  assert.equal(calls.filter((c) => c.url.includes('/boards')).length, 2);
  // 进程期缓存不受 bust 影响：agents/me 仍只抓一次
  assert.equal(calls.filter((c) => c.url.includes('/agents/me')).length, 1, 'me 进程期缓存不随 bust 失效');
});

// ———————————————————————————— 排序与映射 ————————————————————————————

test('组内排序：review > blocked > in_progress > todo > backlog；同态 updatedAt desc；未知态垫底', async () => {
  const mk = (id, status, updatedAt) => ({ id, title: id, status, priority: 'low', listName: null, labels: [], assigneeName: null, dueDate: null, updatedAt });
  const boards = [{ id: 'b1', name: 'Alpha', taskCount: 7, completedTaskCount: 0 }];
  const shuffled = [
    mk('backlog-new', 'backlog', '2026-09-17T09:00:00.000Z'),
    mk('todo', 'todo', '2026-09-17T01:00:00.000Z'),
    mk('doing-old', 'in_progress', '2026-09-17T02:00:00.000Z'),
    mk('weird', 'some_future_status', '2026-09-17T10:00:00.000Z'),
    mk('blocked', 'blocked', '2026-09-17T03:00:00.000Z'),
    mk('doing-new', 'in_progress', '2026-09-17T08:00:00.000Z'),
    mk('review', 'review', '2026-09-16T00:00:00.000Z'),
  ];
  const { fetchImpl } = makeFetch(platformHandler({ boards, me: { name: 'me' }, tasksByBoard: { b1: shuffled } }));
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl });
  const value = await provider.getPanelState();
  assert.deepEqual(
    value.boards[0].tasks.map((t) => t.id),
    ['review', 'blocked', 'doing-new', 'doing-old', 'todo', 'backlog-new', 'weird'],
    '行动优先 + 同态 updatedAt desc + 未知态垫底',
  );
});

test('sortTasks 不 mutate 入参；toTaskEntry 空对象防御（九键默认值，isMine=false）', () => {
  const input = [toTaskEntry({ id: 'a', status: 'backlog', updatedAt: '2026-09-17T01:00:00Z' }, null), toTaskEntry({ id: 'b', status: 'review', updatedAt: '2026-09-17T00:00:00Z' }, null)];
  const sorted = sortTasks(input);
  assert.deepEqual(input.map((t) => t.id), ['a', 'b'], '入参顺序不变');
  assert.deepEqual(sorted.map((t) => t.id), ['b', 'a']);
  const empty = toTaskEntry({}, 'me');
  assert.deepEqual(Object.keys(empty).sort(), TASK_ENTRY_KEYS);
  assert.equal(empty.id, '');
  assert.deepEqual(empty.labels, []);
  assert.equal(empty.isMine, false);
});

test('combineSignals：无入参仅超时信号；入参已 abort → 合并信号立即 abort', () => {
  const s1 = combineSignals(undefined, 8000);
  assert.ok(s1 instanceof AbortSignal);
  assert.equal(s1.aborted, false);
  const ac = new AbortController();
  ac.abort('cancelled');
  const merged = combineSignals(ac.signal, 8000);
  assert.equal(merged.aborted, true, '已 abort 的入参信号应立即传导');
});

// ———————————————————————————— 绑定解析（真实文件系统） ————————————————————————————

test('resolveBinding：向上查找命中 + 字段/JSON/scheme 校验矩阵', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-remote-'));
  try {
    const nested = path.join(dir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    mkdirSync(path.join(dir, '.agent-chamber'));
    writeFileSync(
      path.join(dir, '.agent-chamber', 'agent-chamber.json'),
      JSON.stringify({ apiBaseUrl: 'https://platform.example.com/api/v1/', apiKey: ' ask_key ', boardId: 'b-1' }),
    );
    const hit = resolveBinding(nested);
    assert.ok(hit, '嵌套子目录应向上命中');
    assert.equal(hit.apiBaseUrl, 'https://platform.example.com/api/v1', '尾斜杠归一');
    assert.equal(hit.apiKey, 'ask_key', 'key trim');
    assert.equal(hit.boardId, 'b-1', '其余字段透传');

    // 未命中：无绑定文件的全新目录
    const orphan = mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-orphan-'));
    try {
      assert.equal(resolveBinding(orphan), null);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }

    // 损坏 JSON / 缺字段 / scheme 违例 一律 null（fail-open 按未绑定处理）
    const cases = ['not-json{', JSON.stringify({ apiBaseUrl: 'https://x.com/api/v1' }), JSON.stringify({ apiBaseUrl: 'http://evil.example.com/api/v1', apiKey: 'k' }), JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:8743/api/v1', apiKey: 'k' })];
    const expected = [null, null, null, 'object']; // 最后一条：localhost http 白名单放行
    cases.forEach((content, i) => {
      writeFileSync(path.join(dir, '.agent-chamber', 'agent-chamber.json'), content);
      const got = resolveBinding(nested);
      if (expected[i] === null) assert.equal(got, null, `case ${i} 应判未绑定`);
      else assert.equal(typeof got, 'object', 'localhost http 例外放行');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ———————————————————————————— web 基座推导与深链基座（taskUrlBase 契约） ————————————————————————————

test('resolveBinding：webBaseUrl 可选键——合法透传归一 / 非法丢键不拖垮绑定', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-webbase-'));
  try {
    mkdirSync(path.join(dir, '.agent-chamber'));
    const file = path.join(dir, '.agent-chamber', 'agent-chamber.json');
    // 合法显式覆盖：trim + 去尾斜杠
    writeFileSync(file, JSON.stringify({ apiBaseUrl: 'https://platform.example.com/api/v1', apiKey: 'k', webBaseUrl: ' https://console.example.com/ ' }));
    let hit = resolveBinding(dir);
    assert.equal(hit.webBaseUrl, 'https://console.example.com');
    // localhost http 白名单对 webBaseUrl 同口径生效（白名单按 hostname 判定、端口无关，
    // 夹具用非真实端口 9999——oss-export plugins/ 守卫禁出现真实 dev 端口 localhost:874x）
    writeFileSync(file, JSON.stringify({ apiBaseUrl: 'http://127.0.0.1:8743/api/v1', apiKey: 'k', webBaseUrl: 'http://localhost:9999' }));
    hit = resolveBinding(dir);
    assert.equal(hit.webBaseUrl, 'http://localhost:9999');
    // 非法 scheme（http 非 localhost）：只丢该键，绑定整体仍有效（可选键单向降级）
    writeFileSync(file, JSON.stringify({ apiBaseUrl: 'https://platform.example.com/api/v1', apiKey: 'k', webBaseUrl: 'http://evil.example.com' }));
    hit = resolveBinding(dir);
    assert.ok(hit, '非法可选键不得拖垮整个绑定');
    assert.equal(hit.webBaseUrl, undefined, '非法 webBaseUrl 归一为未配置');
    // 未配置：undefined（推导回落 apiBaseUrl）
    writeFileSync(file, JSON.stringify({ apiBaseUrl: 'https://platform.example.com/api/v1', apiKey: 'k' }));
    hit = resolveBinding(dir);
    assert.equal(hit.webBaseUrl, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveWebBaseUrl 三路优先级 + PanelState.taskUrlBase 随聚合上 wire', async () => {
  // ② 默认：apiBaseUrl 剥 /api/v1 尾段（同域部署零配置）
  assert.equal(deriveWebBaseUrl(BINDING), 'https://platform.example.com');
  // ① 显式 webBaseUrl 覆盖优先（web 与 API 分域部署）
  assert.equal(deriveWebBaseUrl({ ...BINDING, webBaseUrl: 'https://app.example.com/' }), 'https://app.example.com');
  // ③ apiBaseUrl 非 /api/v1 尾段（自定义反代前缀）→ 退 origin
  assert.equal(deriveWebBaseUrl({ ...BINDING, apiBaseUrl: 'https://gw.example.com/chamber/v2' }), 'https://gw.example.com');

  // taskUrlBase 随 PanelState 上 wire：web 基座 + /tasks/（含尾斜杠，client 直接拼 taskId）
  const boards = [{ id: 'b1', name: 'A', taskCount: 0, completedTaskCount: 0 }];
  const { fetchImpl } = makeFetch(platformHandler({ boards, me: { name: 'me' }, tasksByBoard: { b1: [] } }));
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl });
  const value = await provider.getPanelState();
  assert.equal(value.bound, true);
  assert.equal(value.taskUrlBase, 'https://platform.example.com/tasks/');
});

// ———————————————————————————— Remote markers 官方读法（真实协议） ————————————————————————————

test('Remote markers 官方读法 + 服务方法行为（真实 typert-protocol；无 dsh 则 skip）', async (t) => {
  const proto = await loadRealProtocol();
  if (!proto) {
    t.skip('dsh 未安装：@deepseek-ai/dsh-typert-protocol 不可解析');
    return;
  }
  const boards = [{ id: 'b1', name: 'Alpha', taskCount: 0, completedTaskCount: 0 }];
  const { fetchImpl } = makeFetch(platformHandler({ boards, me: { name: 'me' }, tasksByBoard: { b1: [] } }));
  const provider = createPanelStateProvider({ resolveBinding: () => BINDING, fetchImpl });
  const Chamber = defineChamberService(proto, provider);
  const { ctx, provided } = makeCtx();
  const instance = new Chamber(ctx);

  // 批 0 spike 官方读法断言：remoteMethods(instance) === [{method, invocation:{kind:'direct'}}]
  assert.deepEqual(proto.remoteMethods(instance), [{ method: 'getPanelState', invocation: { kind: 'direct' } }]);
  // cordis 注册副作用：provide 以 'chamber' 为名被调用（gateway SRC 发现的入口）
  assert.equal(provided.length, 1);
  assert.equal(provided[0].name, REMOTE_NAMESPACE);
  // 签名约束回归闸：gateway SRC 按 toString 解析参数名——signal 末位纯标识符
  const source = Function.prototype.toString.call(instance.getPanelState);
  const params = source.slice(source.indexOf('(') + 1, source.indexOf(')')).trim();
  assert.equal(params, 'signal', '方法签名必须保持 getPanelState(signal)（禁解构/默认值/rest）');

  // 正常路径：服务方法直通 provider
  const value = await instance.getPanelState(new AbortController().signal);
  assert.equal(value.bound, true);

  // 错误上翻：provider PanelError → 真 RemoteError（isDSHRemoteError 结构标记 + code 保留）
  const failing = createPanelStateProvider({
    resolveBinding: () => BINDING,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const FailingChamber = defineChamberService(proto, failing);
  const failingInstance = new FailingChamber(makeCtx().ctx);
  await assert.rejects(failingInstance.getPanelState(new AbortController().signal), (error) => {
    assert.equal(error.isDSHRemoteError, true, '跨 realm 结构标记');
    assert.equal(error.code, 'unreachable');
    assert.equal(error.name, 'RemoteError');
    return true;
  });

  // 出口纯 JSON 防御（architect-m3）：circular 结果 → RemoteError('internal')
  const circular = { getPanelState: async () => {
    const o = {};
    o.self = o;
    return o;
  } };
  const CircularChamber = defineChamberService(proto, circular);
  await assert.rejects(new CircularChamber(makeCtx().ctx).getPanelState(new AbortController().signal), (error) => error.code === 'internal');

  // 幂等：二次实例化不炸（mark() 同形状早返回）
  new Chamber(makeCtx().ctx);
});

// ———————————————————————————— setupChamberRemote 总装（故障隔离） ————————————————————————————

test('setupChamberRemote：假 ctx + 注入协议 → installed:true + remote=installed 日志 + bustCache 暴露', async () => {
  const { ctx, logger, provided } = makeCtx();
  const result = await setupChamberRemote(ctx, logger, { protocol: makeFakeProtocol(), resolveBinding: () => null });
  assert.equal(result.installed, true);
  assert.equal(typeof result.bustCache, 'function', '手动刷新入口暴露（PM-M4）');
  assert.equal(provided[0]?.name, REMOTE_NAMESPACE);
  assert.ok(logger.has('info', '[agent-chamber] remote=installed'));
  // 服务方法可调用（unbound 值路径）
  assert.deepEqual(await result.service.getPanelState(new AbortController().signal), { bound: false, reason: 'unbound' });
});

test('setupChamberRemote：协议锚点失败 → installed:false + remote=unavailable:protocol，零 throw', async () => {
  const { ctx, logger } = makeCtx();
  const result = await setupChamberRemote(ctx, logger, { protocolAnchor: '/nonexistent/dsh-bin.js' });
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'protocol');
  assert.ok(logger.has('error', '[agent-chamber] remote=unavailable:protocol'));
});

test('setupChamberRemote：实例化失败（ctx 缺 reflect / ctx 为 null）→ unavailable:instantiate，零 throw', async () => {
  const logger = makeLogger();
  const badCtx = { logger }; // 无 reflect
  const r1 = await setupChamberRemote(badCtx, logger, { protocol: makeFakeProtocol(), resolveBinding: () => null });
  assert.equal(r1.installed, false);
  assert.equal(r1.reason, 'instantiate');
  assert.ok(logger.has('error', '[agent-chamber] remote=unavailable:instantiate'));
  const r2 = await setupChamberRemote(null, null, { protocol: makeFakeProtocol(), resolveBinding: () => null });
  assert.equal(r2.installed, false, 'ctx 为 null 也不 throw');
});

// ———————————————————————————— index.mjs 接线 ————————————————————————————

test('index.mjs 接线：apply 含 remote 装载（零 throw + remote= 日志词表在场）', async () => {
  const entry = await import('../lib/index.mjs');
  const { ctx, logger } = makeCtx();
  // 补齐 chamber.mjs 三功能所需的最小面（on/agents/systemPrompt），聚焦验证 remote 接线
  ctx.on = () => {};
  ctx.systemPrompt = { section: () => () => {} };
  await entry.apply(ctx); // 零 throw 即过（测试进程 argv[1] 锚点必失败 → 演练 unavailable 降级路径）
  const hasRemoteLine = logger.has('error', '[agent-chamber] remote=unavailable:') || logger.has('info', '[agent-chamber] remote=installed');
  assert.ok(hasRemoteLine, '日志词表 remote=installed|unavailable:<reason> 必居其一');
});
