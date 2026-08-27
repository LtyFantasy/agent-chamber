/**
 * get_my_briefing 单元测试
 *
 * 验证：编排顺序、默认值、并行调用、错误处理。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getMyBriefingTool } from './get-my-briefing';
import { PlatformApiClient, PlatformApiError } from '../platform-client';

// Mock PlatformApiClient，但保留真实的 PlatformApiError（jest.mock 会自动 mock 全部导出）
jest.mock('../platform-client', () => {
  const actual = jest.requireActual('../platform-client');
  return { ...actual, PlatformApiClient: jest.fn() };
});
const MockClient = PlatformApiClient as jest.MockedClass<typeof PlatformApiClient>;

/** 快捷构造 ctx */
function ctx(auth?: CustomToolContext['auth']): CustomToolContext {
  return { baseUrl: 'http://localhost:8743/api/v1', auth };
}

/** 创建 mock request 函数并返回它 */
function mockRequest() {
  const mockFn = jest.fn();
  MockClient.prototype.request = mockFn;
  return mockFn;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('get_my_briefing', () => {
  it('默认值：taskLimit=20, activityLimit=10', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1', name: 'Test' }) // get_me
      .mockResolvedValueOnce({ items: [], total: 0 }) // tasks
      .mockResolvedValueOnce([{ id: 'a1' }]); // activities

    await getMyBriefingTool.handler({}, ctx());

    // task 查询应带 pageSize=20
    const tasksCall = request.mock.calls.find(([, path, opts]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.pageSize).toBe(20);

    // activity 查询应带 limit=10
    const actCall = request.mock.calls.find(
      ([, path, opts]: any[]) => path === '/agents/me/activities',
    );
    expect(actCall[2].params.limit).toBe(10);
  });

  it('自定义参数透传', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([]);

    await getMyBriefingTool.handler({ taskLimit: 5, activityLimit: 3 }, ctx());

    const tasksCall = request.mock.calls.find(([, path]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.pageSize).toBe(5);

    const actCall = request.mock.calls.find(([, path]: any[]) => path === '/agents/me/activities');
    expect(actCall[2].params.limit).toBe(3);
  });

  it('编排步骤：先 get_me，再并行 tasks + activities', async () => {
    const request = mockRequest();
    const getMePromise = Promise.resolve({ id: 'agent-1' });
    const tasksPromise = Promise.resolve({ items: [{ id: 't1' }], total: 1 });
    const actPromise = Promise.resolve([{ id: 'a1' }]);

    request
      .mockResolvedValueOnce(getMePromise)
      .mockResolvedValueOnce(tasksPromise)
      .mockResolvedValueOnce(actPromise);

    await getMyBriefingTool.handler({}, ctx());

    // 验证调用顺序：第一个必须是 /agents/me
    expect(request.mock.calls[0][0]).toBe('GET');
    expect(request.mock.calls[0][1]).toBe('/agents/me');

    // 后两个是 /tasks 和 /agents/me/activities
    const paths = request.mock.calls.slice(1).map((c: any[]) => c[1]);
    expect(paths).toContain('/tasks');
    expect(paths).toContain('/agents/me/activities');
  });

  it('tasks 查询带正确的 assigneeId 和 status', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-uuid' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([]);

    await getMyBriefingTool.handler({}, ctx());

    const tasksCall = request.mock.calls.find(([, path]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.assigneeId).toBe('agent-uuid');
    expect(tasksCall[2].params.status).toBe('backlog,todo,in_progress,blocked');
  });

  // ==================== statuses 参数化（看板任务 12cd2a92） ====================

  it('自定义 statuses 替换默认状态集（join 成逗号分隔透传）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([]);

    await getMyBriefingTool.handler({ statuses: ['todo', 'review'] }, ctx());

    const tasksCall = request.mock.calls.find(([, path]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.status).toBe('todo,review');
  });

  it('statuses 含非法枚举值 → 400 + failedStep=validate_statuses，且不发起任何请求', async () => {
    const request = mockRequest();

    const result = await getMyBriefingTool.handler({ statuses: ['todo', 'bogus'] }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(400);
    expect(body.failedStep).toBe('validate_statuses');
    expect(request).not.toHaveBeenCalled();
  });

  it('statuses 空数组 → 400（避免替换后退化为全量状态查询的静默语义漂移）', async () => {
    const request = mockRequest();

    const result = await getMyBriefingTool.handler({ statuses: [] }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(400);
    expect(body.failedStep).toBe('validate_statuses');
    expect(request).not.toHaveBeenCalled();
  });

  it('statuses 非数组（字符串）→ 400', async () => {
    const request = mockRequest();

    const result = await getMyBriefingTool.handler({ statuses: 'todo' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(400);
    expect(body.failedStep).toBe('validate_statuses');
    expect(request).not.toHaveBeenCalled();
  });

  it('get_me 步骤失败 → isError + failedStep=get_me', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 401, code: 1009, message: 'Invalid API Key' }),
    );

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_me');
    expect(body.status).toBe(401);
    expect(body.code).toBe(1009);
    // Batch F：错误分支（handlePlatformError）同样紧凑序列化
    expect(result.content[0].text).not.toContain('\n  ');
  });

  it('ctx.auth 透传到 PlatformApiClient 构造', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([]);

    const auth = { type: 'apiKey' as const, apiKey: 'key-x' };
    await getMyBriefingTool.handler({}, ctx(auth));

    expect(MockClient).toHaveBeenCalledWith('http://localhost:8743/api/v1', auth);
  });

  // ==================== Batch F：me 投影 + 紧凑序列化 ====================

  it('Batch F：me 剔除 avatarUrl/apiKeyPrefix，其余字段保留；输出紧凑 JSON', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({
        id: 'agent-1',
        name: 'Test',
        description: 'desc',
        status: 'active',
        avatarUrl: '/me.png',
        apiKeyPrefix: 'ask_abc',
      })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({}, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.me.avatarUrl).toBeUndefined();
    expect(body.me.apiKeyPrefix).toBeUndefined();
    // 其余字段原样保留
    expect(body.me).toEqual({
      id: 'agent-1',
      name: 'Test',
      description: 'desc',
      status: 'active',
    });
    // 紧凑序列化（无 pretty-print 缩进）
    expect(result.content[0].text).not.toContain('\n  ');
  });

  // ==================== WS-C：两段式编排 + 12 字段投影 + unread/blockers 降级 ====================
  // ⚠️ mock 链按调用顺序消费：me → tasks → activities → unread → blockers（两段式后顺序对齐）

  it('WS-C：activeTasks 12 字段白名单投影（无 description/list/board/customFields/position 等多余键）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1', name: 'Test' }) // me
      .mockResolvedValueOnce({
        // tasks（含应被剔除的多余键 + 分页信封）
        items: [
          {
            id: 't1',
            title: 'Task 1',
            status: 'in_progress',
            priority: 'p1',
            labels: ['bug'],
            boardId: 'b1',
            boardName: 'Board A',
            listId: 'l1',
            listName: 'List A',
            dueDate: '2026-09-01',
            updatedAt: '2026-08-27T00:00:00.000Z',
            description: 'should not leak',
            list: { id: 'l1', name: 'List A', board: { id: 'b1', name: 'Board A' } },
            board: { id: 'b1', name: 'Board A' },
            customFields: { foo: 1 },
            position: 3,
            assigneeId: 'agent-1',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      })
      .mockResolvedValueOnce([{ id: 'a1', content: 'hi' }]) // activities
      .mockResolvedValueOnce([]) // unread
      .mockResolvedValueOnce({ t1: false }); // blockers

    const result = await getMyBriefingTool.handler({}, ctx());
    const body = JSON.parse(result.content[0].text);

    // 12 字段白名单：多余键全部剔除
    expect(body.activeTasks.items[0]).toEqual({
      id: 't1',
      title: 'Task 1',
      status: 'in_progress',
      priority: 'p1',
      labels: ['bug'],
      boardId: 'b1',
      boardName: 'Board A',
      listId: 'l1',
      listName: 'List A',
      dueDate: '2026-09-01',
      updatedAt: '2026-08-27T00:00:00.000Z',
      hasBlockers: false,
    });
    // 分页信封其余键被砍掉，只留 {items, total}
    expect(Object.keys(body.activeTasks).sort()).toEqual(['items', 'total']);
  });

  it('WS-C：hasBlockers 从 blockers map 正确合并（true/false/缺失）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], total: 3 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ t1: true, t2: false }); // t3 缺失

    const result = await getMyBriefingTool.handler({}, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.activeTasks.items[0].hasBlockers).toBe(true);
    expect(body.activeTasks.items[1].hasBlockers).toBe(false);
    // map 缺失的 id 不补 false（未知 ≠ 无 blocker）
    expect(body.activeTasks.items[2].hasBlockers).toBeUndefined();
  });

  it('WS-C：blockers 是 GET 且 params.ids 为逗号分隔 csv', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [{ id: 't1' }, { id: 't2' }, { id: 't3' }], total: 3 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ t1: true, t2: false, t3: false });

    await getMyBriefingTool.handler({}, ctx());

    const blockersCall = request.mock.calls.find(
      ([, path]: any[]) => path === '/tasks/blockers/batch',
    );
    expect(blockersCall[0]).toBe('GET');
    expect(blockersCall[2].params.ids).toBe('t1,t2,t3');
  });

  it('WS-C：blockers 失败降级 → hasBlockers undefined 且整体不挂', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [{ id: 't1', title: 'T' }], total: 1 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.activeTasks.items[0].id).toBe('t1');
    expect(body.activeTasks.items[0].hasBlockers).toBeUndefined();
  });

  it('WS-C：空 items 跳过 blockers 请求', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(result.isError).toBeFalsy();
    expect(request.mock.calls.some((c: any[]) => c[1] === '/tasks/blockers/batch')).toBe(false);
    const body = JSON.parse(result.content[0].text);
    expect(body.activeTasks).toEqual({ items: [], total: 0 });
  });

  it('WS-C：unreadCounts 正常合并', async () => {
    const request = mockRequest();
    const unread = [
      { topicId: 'tp1', topicName: 'Topic One', unreadCount: 3 },
      { topicId: 'tp2', topicName: 'Topic Two', unreadCount: 1 },
    ];
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(unread);

    const result = await getMyBriefingTool.handler({}, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.unreadCounts).toEqual(unread);
  });

  it('WS-C：unread 404/失败 → 响应无 unreadCounts 键且整体不挂', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([{ id: 'a1' }])
      .mockRejectedValueOnce(new PlatformApiError({ status: 404, message: 'Not Found' }));

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.unreadCounts).toBeUndefined();
    expect(body.me.id).toBe('agent-1');
    expect(body.recentActivities).toEqual([{ id: 'a1' }]);
  });

  // ==================== WS-C：recentActivities content 截断 ====================

  it('WS-C：activity content >300 → 截断到 300 + contentTruncated；≤300 原样不加标记', async () => {
    const request = mockRequest();
    const longContent = 'x'.repeat(500);
    const shortContent = 'y'.repeat(300);
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([
        { id: 'a1', content: longContent },
        { id: 'a2', content: shortContent },
      ])
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({}, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.recentActivities[0].content).toBe('x'.repeat(300));
    expect(body.recentActivities[0].contentTruncated).toBe(true);
    expect(body.recentActivities[1].content).toBe(shortContent);
    expect(body.recentActivities[1].contentTruncated).toBeUndefined();
  });

  it('WS-C：maxContentLength=1000 → 500 字符不截断；1500 字符截到 1000 + contentTruncated', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([
        { id: 'a1', content: 'a'.repeat(500) },
        { id: 'a2', content: 'b'.repeat(1500) },
      ])
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({ maxContentLength: 1000 }, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.recentActivities[0].content).toBe('a'.repeat(500));
    expect(body.recentActivities[0].contentTruncated).toBeUndefined();
    expect(body.recentActivities[1].content).toBe('b'.repeat(1000));
    expect(body.recentActivities[1].contentTruncated).toBe(true);
  });

  it('WS-C：maxContentLength=0 → 不截断返全文、不加 contentTruncated', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(500);
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([{ id: 'a1', content: longContent }])
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({ maxContentLength: 0 }, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.recentActivities[0].content).toBe(longContent);
    expect(body.recentActivities[0].contentTruncated).toBeUndefined();
  });

  it('WS-C：maxContentLength 负数/非数字 → 按缺省 300 截断', async () => {
    const request = mockRequest();
    const longContent = 'd'.repeat(500);

    // 场景 1：负数
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([{ id: 'a1', content: longContent }])
      .mockResolvedValueOnce([]);

    const r1 = await getMyBriefingTool.handler({ maxContentLength: -5 }, ctx());
    const b1 = JSON.parse(r1.content[0].text);
    expect(b1.recentActivities[0].content).toBe('d'.repeat(300));
    expect(b1.recentActivities[0].contentTruncated).toBe(true);

    // 场景 2：非数字（字符串）
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([{ id: 'a1', content: longContent }])
      .mockResolvedValueOnce([]);

    const r2 = await getMyBriefingTool.handler({ maxContentLength: 'abc' }, ctx());
    const b2 = JSON.parse(r2.content[0].text);
    expect(b2.recentActivities[0].content).toBe('d'.repeat(300));
    expect(b2.recentActivities[0].contentTruncated).toBe(true);
  });

  it('WS-C：maxContentLength 超 50000 → 钳到 50000', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([{ id: 'a1', content: 'e'.repeat(50001) }])
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({ maxContentLength: 999999 }, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.recentActivities[0].content).toBe('e'.repeat(50000));
    expect(body.recentActivities[0].contentTruncated).toBe(true);
  });

  it('WS-C：无 content 的 task 型 activity 不打 contentTruncated', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([
        { id: 'a1', type: 'task', taskId: 't1', createdAt: '2026-08-27T00:00:00.000Z' },
      ])
      .mockResolvedValueOnce([]);

    const result = await getMyBriefingTool.handler({}, ctx());
    const body = JSON.parse(result.content[0].text);

    expect(body.recentActivities[0].contentTruncated).toBeUndefined();
    expect(body.recentActivities[0].taskId).toBe('t1');
  });

  // ==================== WS-C：sort 参数 + limits 钳制 ====================

  it('WS-C：/tasks 请求带 sort=statusPriority', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await getMyBriefingTool.handler({}, ctx());

    const tasksCall = request.mock.calls.find(([, path]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.sort).toBe('statusPriority');
  });

  it('WS-C：taskLimit/activityLimit 钳制 1~50（超出钳到边界）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await getMyBriefingTool.handler({ taskLimit: 100, activityLimit: 0 }, ctx());

    const tasksCall = request.mock.calls.find(([, path]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.pageSize).toBe(50);
    const actCall = request.mock.calls.find(([, path]: any[]) => path === '/agents/me/activities');
    expect(actCall[2].params.limit).toBe(1);
  });

  it('WS-C：taskLimit/activityLimit 非数字 → 回退缺省（20/10）', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'agent-1' })
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await getMyBriefingTool.handler({ taskLimit: 'abc', activityLimit: 'xyz' }, ctx());

    const tasksCall = request.mock.calls.find(([, path]: any[]) => path === '/tasks');
    expect(tasksCall[2].params.pageSize).toBe(20);
    const actCall = request.mock.calls.find(([, path]: any[]) => path === '/agents/me/activities');
    expect(actCall[2].params.limit).toBe(10);
  });

  // ==================== WS-C：尺寸回归 ====================

  it('WS-C：尺寸回归——20 任务 + 10 动态 → 序列化 < 15000 字符', async () => {
    const request = mockRequest();
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `task-${i}-${'0'.repeat(28)}`,
      title: `Task ${i}: ${'x'.repeat(20)}`,
      status: 'in_progress',
      priority: 'p1',
      labels: ['bug', 'combat'],
      boardId: `board-${i}-${'0'.repeat(26)}`,
      boardName: `Board ${i}`,
      listId: `list-${i}-${'0'.repeat(27)}`,
      listName: `List ${i}`,
      dueDate: '2026-09-01',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }));
    const activities = Array.from({ length: 10 }, (_, i) => ({
      id: `act-${i}`,
      type: 'chat',
      content: `Activity ${i}: ${'y'.repeat(80)}`,
      createdAt: '2026-08-27T00:00:00.000Z',
    }));

    request
      .mockResolvedValueOnce({ id: 'agent-1', name: 'Test Agent', description: 'd'.repeat(200) })
      .mockResolvedValueOnce({ items: tasks, total: 20 })
      .mockResolvedValueOnce(activities)
      .mockResolvedValueOnce([{ topicId: 'tp1', topicName: 'Topic One', unreadCount: 3 }])
      .mockResolvedValueOnce(Object.fromEntries(tasks.map((t) => [t.id, false])));

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(result.content[0].text.length).toBeLessThan(15000);
  });
});
