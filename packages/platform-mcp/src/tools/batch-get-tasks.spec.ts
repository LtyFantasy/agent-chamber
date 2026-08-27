/**
 * batch_get_tasks 单元测试
 *
 * 覆盖：混合成败、非法 UUID 短路、>50 拒绝、顺序保持。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { batchGetTasksTool } from './batch-get-tasks';
import { PlatformApiClient, PlatformApiError } from '../platform-client';

jest.mock('../platform-client', () => {
  const actual = jest.requireActual('../platform-client');
  return { ...actual, PlatformApiClient: jest.fn() };
});
const MockClient = PlatformApiClient as jest.MockedClass<typeof PlatformApiClient>;

function ctx(): CustomToolContext {
  return { baseUrl: 'http://localhost:8743/api/v1' };
}

function mockRequest() {
  const mockFn = jest.fn();
  MockClient.prototype.request = mockFn;
  return mockFn;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('batch_get_tasks', () => {
  it('全部成功', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1', title: 'Task 1' })
      .mockResolvedValueOnce({ id: 't2', title: 'Task 2' });

    const result = await batchGetTasksTool.handler(
      { ids: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'] },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.items[0].ok).toBe(true);
    expect(body.items[0].task.id).toBe('t1');
    expect(body.items[1].task.id).toBe('t2');
  });

  it('混合成败：部分 404', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1', title: 'Task 1' })
      .mockRejectedValueOnce(new PlatformApiError({ status: 404, message: 'Not found' }));

    const result = await batchGetTasksTool.handler(
      { ids: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'] },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.items[0].ok).toBe(true);
    expect(body.items[1].ok).toBe(false);
    expect(body.items[1].error.message).toContain('Not found');
  });

  it('顺序保持：succeeded 按 id 原始顺序', async () => {
    const request = mockRequest();
    // 故意让第二个先 resolve
    let resolveSecond: (v: unknown) => void;
    const p2 = new Promise((r) => {
      resolveSecond = r;
    });
    request.mockResolvedValueOnce(Promise.resolve({ id: 't1' })).mockResolvedValueOnce(p2);

    const resultPromise = batchGetTasksTool.handler(
      { ids: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'] },
      ctx(),
    );

    // 稍等一下让第一个 resolve
    await new Promise((r) => setTimeout(r, 20));
    resolveSecond!({ id: 't2' });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body.items[0].task.id).toBe('t1');
    expect(body.items[1].task.id).toBe('t2');
  });

  it('非法 UUID → 本地短路，不发 HTTP', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1' }).mockResolvedValueOnce({ id: 't2' });

    const result = await batchGetTasksTool.handler(
      {
        ids: [
          '550e8400-e29b-41d4-a716-446655440001',
          'not-a-uuid',
          '550e8400-e29b-41d4-a716-446655440002',
        ],
      },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.total).toBe(3);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.items[0].ok).toBe(true);
    expect(body.items[1].ok).toBe(false);
    expect(body.items[1].error.message).toContain('Invalid UUID format');
    expect(body.items[2].ok).toBe(true);

    // 只应发 2 次 HTTP（非法的不发）
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ids 为空 → isError', async () => {
    const result = await batchGetTasksTool.handler({ ids: [] }, ctx());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('non-empty array');
  });

  it('ids > 50 → isError', async () => {
    const ids = Array.from({ length: 51 }, (_, i) =>
      `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}`.slice(0, 36),
    );
    const result = await batchGetTasksTool.handler({ ids }, ctx());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('exceeds limit of 50');
  });

  it('并发上限 10 生效（一次只发 10 个请求）', async () => {
    // 创建 25 个合法 UUID 的任务请求
    const ids = Array.from({ length: 25 }, (_, i) =>
      `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}`.slice(0, 36),
    );

    const request = mockRequest();
    // 每个都返回成功
    for (let i = 0; i < 25; i++) {
      request.mockResolvedValueOnce({ id: ids[i] });
    }

    const result = await batchGetTasksTool.handler({ ids }, ctx());
    const body = JSON.parse(result.content[0].text);
    expect(body.succeeded).toBe(25);
    expect(body.total).toBe(25);
    // 应发 25 次 HTTP
    expect(request).toHaveBeenCalledTimes(25);
  });

  it('slim 默认：白名单投影 + descriptionSnippet 截断（无 description 全文/commentCount）', async () => {
    const request = mockRequest();
    const longDesc = 'x'.repeat(500);
    request.mockResolvedValueOnce({
      id: 't1',
      title: 'Task 1',
      status: 'in_progress',
      priority: 'p1',
      labels: ['bug'],
      boardId: 'b1',
      listId: 'l1',
      assigneeName: 'agent-a',
      assigneeDeletedAt: null,
      dueDate: '2026-09-01',
      updatedAt: '2026-08-27T00:00:00Z',
      description: longDesc,
      commentCount: 3, // 应被剔除（findOne 运行时不产出）
      customFields: { x: 1 }, // 应被剔除
      list: { name: 'In Progress' }, // 应被剔除
    });

    const result = await batchGetTasksTool.handler(
      { ids: ['550e8400-e29b-41d4-a716-446655440001'] },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    const task = body.items[0].task;
    // 字段恰为白名单集 + descriptionSnippet/descriptionTruncated
    expect(task).toEqual({
      id: 't1',
      title: 'Task 1',
      status: 'in_progress',
      priority: 'p1',
      labels: ['bug'],
      boardId: 'b1',
      listId: 'l1',
      assigneeName: 'agent-a',
      assigneeDeletedAt: null,
      dueDate: '2026-09-01',
      updatedAt: '2026-08-27T00:00:00Z',
      descriptionSnippet: 'x'.repeat(300),
      descriptionTruncated: true,
    });
    // 无 description 全文、无 commentCount
    expect(task.description).toBeUndefined();
    expect(task.commentCount).toBeUndefined();
  });

  it('slim:false → 全文通道透传（含 description/commentCount）', async () => {
    const request = mockRequest();
    const full = {
      id: 't1',
      title: 'Task 1',
      description: 'full text',
      commentCount: 3,
      customFields: { x: 1 },
    };
    request.mockResolvedValueOnce(full);

    const result = await batchGetTasksTool.handler(
      { ids: ['550e8400-e29b-41d4-a716-446655440001'], slim: false },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.items[0].task).toEqual(full);
  });

  it('description ≤300 → 不打 descriptionTruncated', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1', description: 'short' });

    const result = await batchGetTasksTool.handler(
      { ids: ['550e8400-e29b-41d4-a716-446655440001'] },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    const task = body.items[0].task;
    expect(task.descriptionSnippet).toBe('short');
    expect(task.descriptionTruncated).toBeUndefined();
  });
});
