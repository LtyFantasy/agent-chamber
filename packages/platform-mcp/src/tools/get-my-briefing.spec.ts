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
});
