/**
 * report_task_result 单元测试
 *
 * 验证：无 comment/commitSha 跳过评论、comment 拼接、commitSha 拼接、
 * 先评论后状态顺序、错误处理。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { reportTaskResultTool } from './report-task-result';
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

describe('report_task_result', () => {
  it('无 comment 且无 commitSha → 跳过评论，直接 PATCH 状态', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1', status: 'done' });

    const result = await reportTaskResultTool.handler({ taskId: 't1', status: 'done' }, ctx());

    // 只应有一次调用（PATCH status）
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('PATCH');
    expect(request.mock.calls[0][1]).toBe('/tasks/t1');
    expect(request.mock.calls[0][2].body).toEqual({ status: 'done' });

    expect(result.isError).toBeFalsy();
  });

  it('仅 comment → 发评论，文本=comment', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'c1', content: '已完成' }) // comment
      .mockResolvedValueOnce({ id: 't1', status: 'done' }); // PATCH

    await reportTaskResultTool.handler({ taskId: 't1', status: 'done', comment: '已完成' }, ctx());

    const commentBody = request.mock.calls[0][2].body;
    expect(commentBody.content).toBe('已完成');
  });

  it('仅 commitSha → 发评论，文本="Commit: <sha>"', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 't1', status: 'done' });

    await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', commitSha: 'abc123' },
      ctx(),
    );

    const commentBody = request.mock.calls[0][2].body;
    expect(commentBody.content).toBe('Commit: abc123');
  });

  it('comment + commitSha → 拼接为 "comment\\n\\nCommit: <sha>"', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 't1', status: 'done' });

    await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', comment: '修复完成', commitSha: 'abc123' },
      ctx(),
    );

    const commentBody = request.mock.calls[0][2].body;
    expect(commentBody.content).toBe('修复完成\n\nCommit: abc123');
  });

  it('先评论后改状态的顺序正确', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 't1', status: 'done' });

    await reportTaskResultTool.handler({ taskId: 't1', status: 'done', comment: 'done' }, ctx());

    expect(request).toHaveBeenCalledTimes(2);
    // 第一步：POST /tasks/t1/comments
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/tasks/t1/comments');
    // 第二步：PATCH /tasks/t1
    expect(request.mock.calls[1][0]).toBe('PATCH');
    expect(request.mock.calls[1][1]).toBe('/tasks/t1');
  });

  it('评论步骤失败 → failedStep=add_comment', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 400, message: 'Comment too long' }),
    );

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', comment: 'too long...' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('add_comment');
  });

  it('PATCH 状态失败 → failedStep=update_status', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 'c1' })
      .mockRejectedValueOnce(
        new PlatformApiError({ status: 400, code: 2002, message: 'Invalid status transition' }),
      );

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'backlog', comment: 'done' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('update_status');
    expect(body.code).toBe(2002);
  });

  it('成功返回包含 task 和 comment', async () => {
    const request = mockRequest();
    const commentResult = { id: 'c1', content: 'done' };
    const taskResult = { id: 't1', status: 'done' };

    request.mockResolvedValueOnce(commentResult).mockResolvedValueOnce(taskResult);

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', comment: 'done' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.task).toEqual(taskResult);
    expect(body.comment).toEqual(commentResult);
  });

  it('无评论且无 commitSha 时返回不含 comment 字段', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1', status: 'done' });

    const result = await reportTaskResultTool.handler({ taskId: 't1', status: 'done' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.task).toEqual({ id: 't1', status: 'done' });
    expect(body.comment).toBeUndefined();
  });

  it('空字符串 comment 被视为无 comment', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1', status: 'done' });

    await reportTaskResultTool.handler({ taskId: 't1', status: 'done', comment: '' }, ctx());

    // 空字符串 → 跳过评论，直接 PATCH
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('PATCH');
  });

  // ─── docIds 关联文档增强 ─────────────────────────────────

  it('docIds 全部关联成功 → docLinks.succeeded 含全部、failed 为空', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1', status: 'done' }) // PATCH
      .mockResolvedValueOnce({}) // link d1
      .mockResolvedValueOnce({}); // link d2

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', docIds: ['d1', 'd2'] },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][0]).toBe('POST');
    expect(request.mock.calls[1][1]).toBe('/tasks/t1/doc-links');
    expect(request.mock.calls[1][2].body).toEqual({ docId: 'd1' });

    const body = JSON.parse(result.content[0].text);
    expect(body.docLinks).toEqual({ succeeded: ['d1', 'd2'], failed: [] });
  });

  it('docIds 部分失败 → 失败内嵌 docLinks.failed（含 status/code），主体仍成功', async () => {
    const request = mockRequest();
    request
      .mockResolvedValueOnce({ id: 't1', status: 'done' }) // PATCH
      .mockResolvedValueOnce({}) // link d1 ok
      .mockRejectedValueOnce(
        new PlatformApiError({ status: 404, code: 10001, message: 'Document not found' }),
      ); // link d2 fail

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', docIds: ['d1', 'd2'] },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.task).toEqual({ id: 't1', status: 'done' });
    expect(body.docLinks.succeeded).toEqual(['d1']);
    expect(body.docLinks.failed).toEqual([
      { docId: 'd2', status: 404, code: 10001, error: 'Document not found' },
    ]);
  });

  it('docIds 为空数组 → 不发起 link 请求，返回无 docLinks 字段', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 't1', status: 'done' });

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', docIds: [] },
      ctx(),
    );

    expect(request).toHaveBeenCalledTimes(1);
    const body = JSON.parse(result.content[0].text);
    expect(body.docLinks).toBeUndefined();
  });
});
