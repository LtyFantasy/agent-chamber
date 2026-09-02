// briefing.test.mjs — REST 拉取 + shaping 截断矩阵（计划 §7；测试即文档，铁律 #19）
// 覆盖：URL 推导三 case（显式 / 从 /mcp、/mcp-full 推导 / 推导局限 R8）、fetch mock
// （200/401/网络 error/超时）、信封 unwrap、code!==200 异常分支、nextUp ≤3、标题超长截断、字符护栏。
// 分支标注：④=配置异常（BriefingError → 模板 D）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBriefing, fetchDigest, BriefingError } from '../hooks/lib/briefing.mjs';
import { resolveApiBase } from '../hooks/lib/config.mjs';
import { formatBound, enforceGuardrail, MAX_CHARS, MAX_LINES, TITLE_MAX } from '../hooks/lib/format.mjs';

// —— fetch mock 工具 ——
const okResponse = (data) => ({ ok: true, status: 200, json: async () => ({ code: 200, message: 'ok', data }) });
const httpErrorResponse = (status) => ({ ok: false, status, json: async () => ({}) });
const codeErrorResponse = (code) => ({ ok: true, status: 200, json: async () => ({ code, message: 'err', data: null }) });

// —— URL 推导三 case（resolveApiBase，§2.3）——
test('URL 推导①：显式 apiBaseUrl → 直接用（不推导）', () => {
  // 夹具用 example.com 占位域名（品牌红线：plugins/ 全树不含生产域名）
  const r = resolveApiBase({ apiBaseUrl: 'https://chamber.example.com/api/v1' }, 'https://chamber.example.com/mcp');
  assert.equal(r.baseUrl, 'https://chamber.example.com/api/v1');
  assert.equal(r.derived, false);
  assert.equal(r.status, 'ok');
});

test('URL 推导②：从 /mcp 去尾 → 拼 /api/v1', () => {
  const r = resolveApiBase(null, 'https://chamber.example.com/mcp');
  assert.equal(r.baseUrl, 'https://chamber.example.com/api/v1');
  assert.equal(r.derived, true);
});

test('URL 推导③：从 /mcp-full 去尾 → 拼 /api/v1', () => {
  const r = resolveApiBase(null, 'https://host.example/mcp-full');
  assert.equal(r.baseUrl, 'https://host.example/api/v1');
  assert.equal(r.derived, true);
});

test('URL 推导局限（R8）文档化断言：推导只改路径不改端口——自建 automcp 端口与 REST 端口不同时推导必错', () => {
  // 9876(automcp) 推导出 9876/api/v1 而非 REST 端口 —— 这正是 playbook「apiBaseUrl 恒显式写」的理由
  //（端口刻意不用 874x：plugins/ 全树守卫拦截本地开发端口模式）
  const r = resolveApiBase(null, 'https://localhost:9876/mcp');
  assert.equal(r.baseUrl, 'https://localhost:9876/api/v1');
});

// —— fetch mock：200 信封 unwrap ——
test('fetch 200：信封 unwrap → name/activeTasksTotal/activeItems/unreadTotal/unreadCounts（新形状）', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(
      url,
      /\/agents\/me\/briefing\?statuses=todo,in_progress&taskLimit=20&activityLimit=3&maxContentLength=160$/,
    );
    assert.equal(init.headers['X-API-Key'], 'ask_test1234567890');
    return okResponse({
      me: { id: 'a1', name: 'alice', status: 'active' },
      activeTasks: {
        items: [
          { id: 't1', title: 'Task One', status: 'in_progress', boardId: 'b1', boardName: 'Board A' },
          { id: 't2', title: 'Task Two', status: 'todo', boardId: 'b2', boardName: 'Board B' },
        ],
        total: 3,
      },
      unreadCounts: [
        { topicId: 't1', topicName: 'T1', unreadCount: 2 },
        { topicId: 't2', topicName: 'T2', unreadCount: 5 },
      ],
      recentActivities: [],
    });
  };
  const b = await fetchBriefing('https://x/api/v1', 'ask_test1234567890', { fetchImpl });
  assert.equal(b.name, 'alice');
  assert.equal(b.activeTasksTotal, 3);
  assert.equal(b.activeItems.length, 2, 'activeItems 应原样透传（分组/排序收归 format 层）');
  assert.equal(b.activeItems[0].boardId, 'b1');
  assert.equal(b.unreadTotal, 7); // 2+5 求和 = 未读 M
  assert.equal(b.unreadCounts.length, 2, 'unreadCounts 应原样透传');
});

test('fetch 200：briefing 缺数组字段 → 防御性默认空数组', async () => {
  const fetchImpl = async () =>
    okResponse({
      me: { id: 'a1', name: 'alice', status: 'active' },
      activeTasks: { total: 3 }, // 无 items
      // 无 unreadCounts
    });
  const b = await fetchBriefing('https://x/api/v1', 'k', { fetchImpl });
  assert.deepEqual(b.activeItems, []);
  assert.deepEqual(b.unreadCounts, []);
  assert.equal(b.activeTasksTotal, 3);
  assert.equal(b.unreadTotal, 0);
});

test('fetch 200：digest 信封 unwrap → boardName + nextUp 透传', async () => {
  const fetchImpl = async (url) => {
    assert.match(
      url,
      /\/boards\/b1\/digest\?openLimit=3&doneLimit=0&riskLimit=0&docsLimit=0&versionLimit=0&includeDescription=false$/,
    );
    return okResponse({
      boardName: 'My Board',
      nextUp: [{ id: 'x', title: 'T1', priority: 'p1', status: 'todo', assigneeName: 'a' }],
      nextUpTotal: 1,
    });
  };
  const d = await fetchDigest('https://x/api/v1', 'b1', 'k', { fetchImpl });
  assert.equal(d.boardName, 'My Board');
  assert.equal(d.nextUp.length, 1);
  assert.equal(d.nextUp[0].title, 'T1');
});

// —— fetch mock：失败分支（分支④）——
test('fetch 401 → BriefingError HTTP 401（分支④）', async () => {
  const fetchImpl = async () => httpErrorResponse(401);
  await assert.rejects(fetchBriefing('https://x/api/v1', 'k', { fetchImpl }), (err) => {
    assert.ok(err instanceof BriefingError);
    assert.equal(err.reason, 'HTTP 401');
    assert.equal(err.status, 401);
    return true;
  });
});

test('fetch 网络错误 → BriefingError network-error（分支④）', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(fetchBriefing('https://x/api/v1', 'k', { fetchImpl }), (err) => {
    assert.equal(err.reason, 'network-error');
    assert.equal(err.status, null);
    return true;
  });
});

test('fetch 超时（AbortSignal.timeout 抛 TimeoutError）→ BriefingError timeout（分支④）', async () => {
  const fetchImpl = async () => {
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  };
  await assert.rejects(fetchBriefing('https://x/api/v1', 'k', { fetchImpl }), (err) => {
    assert.equal(err.reason, 'timeout');
    return true;
  });
});

test('信封 code!==200 → BriefingError code N（分支④）', async () => {
  const fetchImpl = async () => codeErrorResponse(500);
  await assert.rejects(fetchDigest('https://x/api/v1', 'b1', 'k', { fetchImpl }), (err) => {
    assert.equal(err.reason, 'code 500');
    assert.equal(err.status, 500);
    return true;
  });
});

// —— shaping 截断断言（formatBound 新签名：briefing 对象 + digest 对象 + binding 对象）——
/** 构造 briefing 对象（默认空任务/空未读） */
const mkBriefing = (overrides = {}) => ({
  name: 'alice',
  activeTasksTotal: 0,
  activeItems: [],
  unreadTotal: 0,
  unreadCounts: [],
  ...overrides,
});
/** 构造 digest 对象（默认空 nextUp） */
const mkDigest = (overrides = {}) => ({ boardName: 'Main Board', nextUp: [], ...overrides });
/** 构造 binding 对象（默认三 ID 齐全） */
const mkBinding = (overrides = {}) => ({ boardId: 'b-main', topicId: 't-main', docSpaceId: 's-main', ...overrides });

test('shaping：nextUp 超过 3 条 → 模板 C 只取前 3（服务端 openLimit=3 + 客户端防御）', () => {
  const digest = mkDigest({ nextUp: [1, 2, 3, 4, 5].map((i) => ({ title: `Task ${i}` })) });
  const out = formatBound(mkBriefing(), digest, mkBinding());
  assert.match(
    out,
    /^\[agent-chamber\] alice · 项目「Main Board」· 活跃任务 0 · 未读 0\nbound: board=b-main topic=t-main space=s-main\nnextUp（board 策展队列）: Task 1 \/ Task 2 \/ Task 3\n深拉通道/,
  );
  assert.ok(!out.includes('Task 4'));
});

test('shaping：标题超长 → 截断 TITLE_MAX + 省略号', () => {
  const longTitle = '长'.repeat(TITLE_MAX + 20);
  const briefing = mkBriefing({
    activeTasksTotal: 1,
    activeItems: [{ boardId: 'b-main', boardName: 'B', title: longTitle, status: 'todo' }],
  });
  const out = formatBound(briefing, mkDigest(), mkBinding());
  assert.ok(out.includes(`${'长'.repeat(TITLE_MAX)}…`));
  assert.ok(!out.includes('长'.repeat(TITLE_MAX + 1)));
});

test('shaping：nextUp 空 → 「nextUp（board 策展队列）: 无」', () => {
  const out = formatBound(mkBriefing(), mkDigest(), mkBinding());
  assert.match(out, /nextUp（board 策展队列）: 无/);
});

// —— formatBound 新模板：分组 / 折叠 / 截断标注 / bound 行 / 空段省略 / topic 行 ——
test('formatBound：board 分组——绑定 board 第一、其余按任务数 DESC、组内标题服务端顺序不重排', () => {
  const briefing = mkBriefing({
    activeTasksTotal: 6,
    activeItems: [
      { boardId: 'b-other2', boardName: 'Other2', title: 'O2-1', status: 'todo' },
      { boardId: 'b-main', boardName: 'Main', title: 'M1', status: 'in_progress' },
      { boardId: 'b-other1', boardName: 'Other1', title: 'O1-1', status: 'todo' },
      { boardId: 'b-main', boardName: 'Main', title: 'M2', status: 'todo' },
      { boardId: 'b-other1', boardName: 'Other1', title: 'O1-2', status: 'todo' },
      { boardId: 'b-other1', boardName: 'Other1', title: 'O1-3', status: 'todo' },
    ],
  });
  const out = formatBound(briefing, mkDigest(), mkBinding());
  const lines = out.split('\n');
  // 绑定 board（2 项）排第一，即使 Other1（3 项）更多；组内标题保持服务端顺序
  assert.ok(lines[2].startsWith('board「Main」: 我的待办 2 — M1 / M2'));
  assert.ok(lines[3].startsWith('board「Other1」: 我的待办 3 — O1-1 / O1-2 / O1-3'));
  assert.ok(lines[4].startsWith('board「Other2」: 我的待办 1 — O2-1'));
});

test('formatBound：绑定 boardId 含手写空白 → trim 后仍排第一（回归：code-review 问题 #1）', () => {
  const briefing = mkBriefing({
    activeTasksTotal: 4,
    activeItems: [
      { boardId: 'b-other', boardName: 'Other', title: 'O1', status: 'todo' },
      { boardId: 'b-other', boardName: 'Other', title: 'O2', status: 'todo' },
      { boardId: 'b-other', boardName: 'Other', title: 'O3', status: 'todo' },
      { boardId: 'b-main', boardName: 'Main', title: 'M1', status: 'in_progress' },
    ],
  });
  // 绑定文件手写带空白的 boardId——不 trim 时 ' b-main ' 永不命中，绑定 board 失序
  const out = formatBound(briefing, mkDigest(), mkBinding({ boardId: ' b-main ' }));
  const lines = out.split('\n');
  assert.ok(lines[2].startsWith('board「Main」: 我的待办 1 — M1'), '空白 boardId trim 后绑定 board 应排第一');
});

test('formatBound：board 折叠——超过 3 个 board → 「其余 k 个 board 共 m 项」并入最后一行', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    boardId: `b${i}`,
    boardName: `Board${i}`,
    title: `T${i}`,
    status: 'todo',
  }));
  const briefing = mkBriefing({ activeTasksTotal: 5, activeItems: items });
  const out = formatBound(briefing, mkDigest(), mkBinding({ boardId: 'b0' }));
  const lines = out.split('\n');
  assert.ok(lines[2].startsWith('board「Board0」: 我的待办 1 — T0'));
  assert.ok(lines[3].startsWith('board「Board1」: 我的待办 1 — T1'));
  assert.ok(lines[4].includes('其余 2 个 board 共 2 项'), '折叠文本应并入最后一个 board 行尾部');
});

test('formatBound：截断标注——total > items.length → board 段尾部追加（另有 N 项未分组列出）', () => {
  const briefing = mkBriefing({
    activeTasksTotal: 5,
    activeItems: [
      { boardId: 'b-main', boardName: 'Main', title: 'M1', status: 'todo' },
      { boardId: 'b-main', boardName: 'Main', title: 'M2', status: 'todo' },
    ],
  });
  const out = formatBound(briefing, mkDigest(), mkBinding());
  const lines = out.split('\n');
  assert.ok(lines[3].includes('（另有 3 项未分组列出）'), '截断标注应在 board 段尾部（最后一行 board 之后）');
});

test('formatBound：bound 行缺省——只列非空 id，键固定顺序 board/topic/space', () => {
  const out1 = formatBound(mkBriefing(), mkDigest(), { boardId: 'b1' });
  assert.ok(out1.includes('\nbound: board=b1\n'));
  const out2 = formatBound(mkBriefing(), mkDigest(), { boardId: 'b1', topicId: 't1' });
  assert.ok(out2.includes('\nbound: board=b1 topic=t1\n'));
  const out3 = formatBound(mkBriefing(), mkDigest(), { boardId: 'b1', topicId: 't1', docSpaceId: 's1' });
  assert.ok(out3.includes('\nbound: board=b1 topic=t1 space=s1\n'));
});

test('formatBound：空段省略——无活跃任务 → 无 board 行；无未读 → 无 topic 行', () => {
  const out = formatBound(mkBriefing(), mkDigest(), mkBinding());
  const lines = out.split('\n');
  assert.ok(!lines.some((l) => l.startsWith('board「')), '无活跃任务 → board 段整段省略');
  assert.ok(!lines.some((l) => l.startsWith('topic「')), '无未读 → topic 行省略');
  assert.equal(lines.length, 4, '结构应为 summary / bound / nextUp / 深拉通道');
});

test('formatBound：nextUp 消歧文案——「nextUp（board 策展队列）」与「我的待办」区分两个数据源', () => {
  const digest = mkDigest({ nextUp: [{ title: 'N1' }, { title: 'N2' }] });
  const out = formatBound(mkBriefing(), digest, mkBinding());
  assert.ok(out.includes('nextUp（board 策展队列）: N1 / N2'));
});

test('formatBound：topic 行——前 3 + 折叠其余、全部一行', () => {
  const unreadCounts = [
    { topicId: 't1', topicName: 'Topic One', unreadCount: 2 },
    { topicId: 't2', topicName: 'Topic Two', unreadCount: 5 },
    { topicId: 't3', topicName: 'Topic Three', unreadCount: 1 },
    { topicId: 't4', topicName: 'Topic Four', unreadCount: 3 },
    { topicId: 't5', topicName: 'Topic Five', unreadCount: 4 },
  ];
  const briefing = mkBriefing({ unreadTotal: 15, unreadCounts });
  const out = formatBound(briefing, mkDigest(), mkBinding());
  const topicLine = out.split('\n').find((l) => l.startsWith('topic「'));
  assert.equal(
    topicLine,
    'topic「Topic One」: 未读 2 / topic「Topic Two」: 未读 5 / topic「Topic Three」: 未读 1 / 其余 2 个 topic 共 7 条',
  );
});

test('formatBound：topic 名超长 → 截断 TITLE_MAX + 省略号', () => {
  const longName = '长'.repeat(TITLE_MAX + 10);
  const briefing = mkBriefing({
    unreadTotal: 1,
    unreadCounts: [{ topicId: 't1', topicName: longName, unreadCount: 1 }],
  });
  const out = formatBound(briefing, mkDigest(), mkBinding());
  assert.ok(out.includes(`topic「${'长'.repeat(TITLE_MAX)}…」: 未读 1`));
});

test('formatBound：digest 失败降级（digest=null）→ 省 nextUp 行、summary 省「项目「」」段', () => {
  const briefing = mkBriefing({
    activeTasksTotal: 2,
    activeItems: [
      { boardId: 'b-main', boardName: 'Main', title: 'M1', status: 'todo' },
      { boardId: 'b-main', boardName: 'Main', title: 'M2', status: 'todo' },
    ],
  });
  const out = formatBound(briefing, null, mkBinding());
  const lines = out.split('\n');
  assert.ok(lines[0].startsWith('[agent-chamber] alice · 活跃任务 2 · 未读 0'), 'digest 失败 → summary 省项目名段');
  assert.ok(!out.includes('nextUp'), 'digest 失败 → 无 nextUp 行');
  assert.ok(lines[2].startsWith('board「Main」: 我的待办 2 — M1 / M2'), 'board 分组行照出');
});

test('护栏实测：50 topic + 20 任务极端夹具 → 输出 ≤ MAX_CHARS / ≤ MAX_LINES', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    boardId: `b${i % 5}`,
    boardName: `Board ${i % 5}`,
    title: `Task ${i} ` + '长'.repeat(30),
    status: 'todo',
  }));
  const unreadCounts = Array.from({ length: 50 }, (_, i) => ({
    topicId: `t${i}`,
    topicName: `Topic ${i} ` + '长'.repeat(30),
    unreadCount: i + 1,
  }));
  const briefing = mkBriefing({
    activeTasksTotal: 20,
    activeItems: items,
    unreadTotal: unreadCounts.reduce((s, t) => s + t.unreadCount, 0),
    unreadCounts,
  });
  const digest = mkDigest({
    nextUp: Array.from({ length: 3 }, (_, i) => ({ title: `Next ${i} ` + '长'.repeat(30) })),
  });
  const out = formatBound(briefing, digest, mkBinding());
  assert.ok(out.length <= MAX_CHARS, `输出 ${out.length} 字符 > MAX_CHARS ${MAX_CHARS}`);
  assert.ok(out.split('\n').length <= MAX_LINES, `输出 ${out.split('\n').length} 行 > MAX_LINES ${MAX_LINES}`);
});

test('shaping：字符护栏 ≤ MAX_CHARS / 行护栏 ≤ MAX_LINES', () => {
  const huge = 'x'.repeat(MAX_CHARS + 500);
  const out = enforceGuardrail(huge);
  assert.ok(out.length <= MAX_CHARS);
  const manyLines = Array.from({ length: MAX_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
  const out2 = enforceGuardrail(manyLines);
  assert.equal(out2.split('\n').length, MAX_LINES);
});
