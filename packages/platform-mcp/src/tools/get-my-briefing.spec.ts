/**
 * get_my_briefing 单元测试（薄透传 GET /agents/me/briefing）
 *
 * 验证：单次 GET /agents/me/briefing、参数透传（statuses 数组 → 逗号分隔字符串、
 * 钳制后值、非 undefined 才传）、响应原样透传（含降级键省略）、错误透传
 * （failedStep=get_my_briefing + status/code）。编排/投影/降级已后端化
 * （AgentService.getMyBriefing），不在本层验证。
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
  it('无参数 → 单次 GET /agents/me/briefing，params 为空（缺省由后端承担）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('GET');
    expect(request.mock.calls[0][1]).toBe('/agents/me/briefing');
    expect(request.mock.calls[0][2].params).toEqual({});

    expect(result.isError).toBeFalsy();
  });

  it('statuses 数组 → 逗号分隔字符串透传（替换默认集）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    await getMyBriefingTool.handler({ statuses: ['todo', 'review'] }, ctx());

    expect(request.mock.calls[0][2].params).toEqual({ statuses: 'todo,review' });
  });

  it('taskLimit/activityLimit 钳制后透传（100→50、0→1）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    await getMyBriefingTool.handler({ taskLimit: 100, activityLimit: 0 }, ctx());

    expect(request.mock.calls[0][2].params).toEqual({ taskLimit: 50, activityLimit: 1 });
  });

  it('taskLimit/activityLimit 非数字 → 回退缺省透传（20/10）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    await getMyBriefingTool.handler({ taskLimit: 'abc', activityLimit: 'xyz' }, ctx());

    expect(request.mock.calls[0][2].params).toEqual({ taskLimit: 20, activityLimit: 10 });
  });

  it('maxContentLength 透传（含 0 = 不截断）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    await getMyBriefingTool.handler({ maxContentLength: 0 }, ctx());

    expect(request.mock.calls[0][2].params).toEqual({ maxContentLength: 0 });
  });

  it('maxContentLength 负数/非数字 → 不传（后端用缺省 300）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    await getMyBriefingTool.handler({ maxContentLength: -5 }, ctx());
    expect(request.mock.calls[0][2].params).toEqual({});

    await getMyBriefingTool.handler({ maxContentLength: 'abc' }, ctx());
    expect(request.mock.calls[1][2].params).toEqual({});
  });

  it('maxContentLength 超 50000 → 钳到 50000', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    await getMyBriefingTool.handler({ maxContentLength: 999999 }, ctx());

    expect(request.mock.calls[0][2].params).toEqual({ maxContentLength: 50000 });
  });

  it('成功返回原样透传（me/activeTasks/unreadCounts/recentActivities 全形状）', async () => {
    const request = mockRequest();
    const backendResult = {
      me: {
        id: 'agent-1',
        name: 'Test',
        status: 'active',
        ownerId: 'owner-1',
        ownerName: 'Owner',
        description: 'desc',
        descriptionSnippet: undefined,
        capabilities: ['read'],
        createdAt: '2026-08-01T00:00:00.000Z',
        lastActiveAt: '2026-08-29T00:00:00.000Z',
        topicCount: 3,
        messageCount: 10,
      },
      activeTasks: {
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
            hasBlockers: false,
          },
        ],
        total: 1,
      },
      unreadCounts: [{ topicId: 'tp1', topicName: 'Topic One', unreadCount: 3 }],
      recentActivities: [{ id: 'a1', type: 'chat', content: 'hi', contentTruncated: false }],
    };
    request.mockResolvedValueOnce(backendResult);

    const result = await getMyBriefingTool.handler({}, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(backendResult);
    expect(body.me.avatarUrl).toBeUndefined();
    expect(body.me.apiKeyPrefix).toBeUndefined();
    expect(body.activeTasks.items[0].hasBlockers).toBe(false);
    // 紧凑序列化（无 pretty-print 缩进）
    expect(result.content[0].text).not.toContain('\n  ');
  });

  it('降级键省略原样透传（后端响应无 unreadCounts/hasBlockers → 输出无该键）', async () => {
    const request = mockRequest();
    const backendResult = {
      me: { id: 'agent-1', name: 'Test' },
      activeTasks: { items: [{ id: 't1', title: 'T' }], total: 1 },
      recentActivities: [],
    };
    request.mockResolvedValueOnce(backendResult);

    const result = await getMyBriefingTool.handler({}, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(backendResult);
    expect(body.unreadCounts).toBeUndefined();
    expect(body.activeTasks.items[0].hasBlockers).toBeUndefined();
  });

  it('后端错误透传 → failedStep=get_my_briefing + status/code 保留', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 401, code: 1009, message: 'Invalid API Key' }),
    );

    const result = await getMyBriefingTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_my_briefing');
    expect(body.status).toBe(401);
    expect(body.code).toBe(1009);
  });

  it('无 code 的上游 400 → failedStep=get_my_briefing', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 400, message: 'Invalid statuses' }),
    );

    const result = await getMyBriefingTool.handler({ statuses: ['todo'] }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_my_briefing');
    expect(body.status).toBe(400);
    expect(body.code).toBeUndefined();
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

  it('ctx.auth 透传到 PlatformApiClient 构造', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ me: { id: 'agent-1' }, activeTasks: { items: [], total: 0 } });

    const auth = { type: 'apiKey' as const, apiKey: 'key-x' };
    await getMyBriefingTool.handler({}, ctx(auth));

    expect(MockClient).toHaveBeenCalledWith('http://localhost:8743/api/v1', auth);
  });
});
