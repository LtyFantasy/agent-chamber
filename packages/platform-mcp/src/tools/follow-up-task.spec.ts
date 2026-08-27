/**
 * follow_up_task 单元测试
 *
 * 验证：编排顺序、并行 blockers+comments、默认 commentLimit、错误处理。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { followUpTaskTool } from './follow-up-task';
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

describe('follow_up_task', () => {
  it('默认 commentLimit=10', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1', title: 'Task' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    const commentsCall = request.mock.calls.find(
      ([, path]: any[]) => path === '/tasks/t1/comments',
    );
    expect(commentsCall[2].params.limit).toBe(10);
  });

  it('自定义 commentLimit 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1' }).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await followUpTaskTool.handler({ taskId: 't1', commentLimit: 5 }, ctx());

    const commentsCall = request.mock.calls.find(
      ([, path]: any[]) => path === '/tasks/t1/comments',
    );
    expect(commentsCall[2].params.limit).toBe(5);
  });

  it('编排顺序：先 get_task，再并行 blockers + comments', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([{ id: 'b1' }])
      .mockResolvedValueOnce([{ id: 'c1' }]);

    await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    // 第一个调用必须是 get_task
    expect(request.mock.calls[0][0]).toBe('GET');
    expect(request.mock.calls[0][1]).toBe('/tasks/t1');

    // 后续是 blockers + comments
    const paths = request.mock.calls.slice(1).map((c: any[]) => c[1]);
    expect(paths).toContain('/tasks/t1/blockers');
    expect(paths).toContain('/tasks/t1/comments');
  });

  it('get_task 失败 → failedStep=get_task', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, code: 2001, message: 'Task not found' }),
    );

    const result = await followUpTaskTool.handler({ taskId: 'missing' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_task');
    expect(body.status).toBe(404);
  });

  it('成功 → 返回 task, blockers, recentComments', async () => {
    const request = mockRequest();
    const task = { id: 't1', title: 'Fix bug' };
    const blockers = [{ id: 'b1' }];
    const comments = [{ id: 'c1', content: 'done' }];

    request
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(blockers)
      .mockResolvedValueOnce(comments);

    const result = await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.task).toEqual(task);
    expect(body.blockers).toEqual(blockers);
    expect(body.recentComments).toEqual(comments);
  });

  it('task.docs 投影白名单：多余字段剔除，只留 docId/path/title/summary', async () => {
    const request = mockRequest();
    const task = {
      id: 't1',
      title: 'Fix bug',
      docs: [
        {
          docId: 'd1',
          path: 'docs/arch.md',
          title: '架构',
          summary: '摘要',
          spaceId: 's1', // 应被剔除
          createdBy: 'u1', // 应被剔除
          internalField: 'x', // 应被剔除
        },
      ],
    };

    request.mockResolvedValueOnce(task).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.task.docs).toEqual([
      { docId: 'd1', path: 'docs/arch.md', title: '架构', summary: '摘要' },
    ]);
  });

  it('评论 >500 字符 → 截断到 500 + contentTruncated', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(600);
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: longContent }]);

    const result = await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.recentComments[0].content).toBe('c'.repeat(500));
    expect(body.recentComments[0].contentTruncated).toBe(true);
  });

  it('评论 ≤500 → 不截断无标记', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: 'short' }]);

    const result = await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.recentComments[0].content).toBe('short');
    expect(body.recentComments[0].contentTruncated).toBeUndefined();
  });

  it('commentMaxLength=1000 → 按 1000 截断', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(1200);
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: longContent }]);

    const result = await followUpTaskTool.handler({ taskId: 't1', commentMaxLength: 1000 }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.recentComments[0].content).toBe('c'.repeat(1000));
    expect(body.recentComments[0].contentTruncated).toBe(true);
  });

  it('commentMaxLength=0 → 全文不截断', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(600);
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: longContent }]);

    const result = await followUpTaskTool.handler({ taskId: 't1', commentMaxLength: 0 }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.recentComments[0].content).toBe(longContent);
    expect(body.recentComments[0].contentTruncated).toBeUndefined();
  });

  it('commentMaxLength 非法（非数字）→ 回落默认 500', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(600);
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: longContent }]);

    const result = await followUpTaskTool.handler(
      { taskId: 't1', commentMaxLength: 'abc' as unknown as number },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.recentComments[0].content).toBe('c'.repeat(500));
    expect(body.recentComments[0].contentTruncated).toBe(true);
  });

  it('commentMaxLength >50000 → 钳到 50000', async () => {
    const request = mockRequest();
    const longContent = 'c'.repeat(60000);
    request
      .mockResolvedValueOnce({ id: 't1' })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: longContent }]);

    const result = await followUpTaskTool.handler({ taskId: 't1', commentMaxLength: 99999 }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.recentComments[0].content).toBe('c'.repeat(50000));
    expect(body.recentComments[0].contentTruncated).toBe(true);
  });

  it('task.description 全文不动（深入通道 by design）', async () => {
    const request = mockRequest();
    const longDesc = 'd'.repeat(2000);
    request
      .mockResolvedValueOnce({ id: 't1', description: longDesc })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c1', content: 'short' }]);

    const result = await followUpTaskTool.handler({ taskId: 't1' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.task.description).toBe(longDesc);
  });
});
