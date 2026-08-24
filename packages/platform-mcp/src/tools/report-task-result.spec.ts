/**
 * report_task_result 单元测试（薄透传 POST /tasks/:id/report）
 *
 * 验证：单次 POST /tasks/:id/report、非 undefined 字段原样透传（comment/commitSha/
 * docIds/clientRequestId）、响应体透传（含 idempotentReplay 标记）、错误透传
 * （failedStep=report_task_result + status/code）。评论拼接/三步编排已后端化，
 * 不在本层验证。
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
  it('无 comment/commitSha/docIds/clientRequestId → body 仅 status，单次 POST /tasks/:id/report', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1', status: 'done' } });

    const result = await reportTaskResultTool.handler({ taskId: 't1', status: 'done' }, ctx());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/tasks/t1/report');
    expect(request.mock.calls[0][2].body).toEqual({ status: 'done' });

    expect(result.isError).toBeFalsy();
  });

  it('comment/commitSha 原样透传（不在本层拼接）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1' }, comment: { id: 'c1' } });

    await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', comment: '修复完成', commitSha: 'abc123' },
      ctx(),
    );

    expect(request.mock.calls[0][2].body).toEqual({
      status: 'done',
      comment: '修复完成',
      commitSha: 'abc123',
    });
  });

  it('docIds 与 clientRequestId 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1' } });

    await reportTaskResultTool.handler(
      {
        taskId: 't1',
        status: 'done',
        docIds: ['d1', 'd2'],
        clientRequestId: 'key-001',
      },
      ctx(),
    );

    expect(request.mock.calls[0][2].body).toEqual({
      status: 'done',
      docIds: ['d1', 'd2'],
      clientRequestId: 'key-001',
    });
  });

  it('空字符串 comment 原样透传（后端按未提供处理，跳过评论步骤）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1', status: 'done' } });

    await reportTaskResultTool.handler({ taskId: 't1', status: 'done', comment: '' }, ctx());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][2].body).toEqual({ status: 'done', comment: '' });
  });

  it('成功返回透传 {task, comment?, docLinks?}', async () => {
    const request = mockRequest();
    const backendResult = {
      task: { id: 't1', status: 'done' },
      comment: { id: 'c1', content: 'done' },
      docLinks: { succeeded: ['d1'], failed: [] },
    };
    request.mockResolvedValueOnce(backendResult);

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', comment: 'done', docIds: ['d1'] },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(backendResult);
    expect(body.docLinks.succeeded).toEqual(['d1']);
  });

  it('后端幂等重放标记 idempotentReplay 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      task: { id: 't1', status: 'done' },
      comment: { id: 'c1' },
      idempotentReplay: true,
    });

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', comment: 'done', clientRequestId: 'key-001' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.idempotentReplay).toBe(true);
  });

  it('后端错误透传 → failedStep=report_task_result + status/code 保留', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        code: 9002,
        message: 'clientRequestId was already used by a different request',
      }),
    );

    const result = await reportTaskResultTool.handler(
      { taskId: 't1', status: 'done', clientRequestId: 'key-001' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('report_task_result');
    expect(body.status).toBe(409);
    expect(body.code).toBe(9002);
  });

  it('PATCH 风格错误（无 code 的上游 400）→ failedStep=report_task_result', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 400, message: 'Invalid status' }));

    const result = await reportTaskResultTool.handler({ taskId: 't1', status: 'backlog' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('report_task_result');
    expect(body.status).toBe(400);
    expect(body.code).toBeUndefined();
  });
});
