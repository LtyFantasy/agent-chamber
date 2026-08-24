/**
 * patch_task_description 单元测试（薄透传 PATCH /tasks/:id/description）
 *
 * 验证：单次 PATCH /tasks/:id/description、非 undefined 字段原样透传
 * （expectedDescriptionHash/clientRequestId）、响应体透传（含 idempotentReplay 标记）、
 * 错误透传（failedStep=patch_task_description + status/code）。match 三态/乐观锁/
 * 幂等语义已后端化，不在本层验证。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { patchTaskDescriptionTool } from './patch-task-description';
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

describe('patch_task_description', () => {
  it('仅必填字段 → body 仅 oldString/newString，单次 PATCH /tasks/:id/description', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1', description: '新' } });

    const result = await patchTaskDescriptionTool.handler(
      { taskId: 't1', oldString: '旧', newString: '新' },
      ctx(),
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('PATCH');
    expect(request.mock.calls[0][1]).toBe('/tasks/t1/description');
    expect(request.mock.calls[0][2].body).toEqual({ oldString: '旧', newString: '新' });

    expect(result.isError).toBeFalsy();
  });

  it('expectedDescriptionHash 与 clientRequestId 原样透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1' } });

    await patchTaskDescriptionTool.handler(
      {
        taskId: 't1',
        oldString: '旧',
        newString: '新',
        expectedDescriptionHash: 'abc123',
        clientRequestId: 'key-001',
      },
      ctx(),
    );

    expect(request.mock.calls[0][2].body).toEqual({
      oldString: '旧',
      newString: '新',
      expectedDescriptionHash: 'abc123',
      clientRequestId: 'key-001',
    });
  });

  it('空字符串 newString 原样透传（后端按删除片段处理）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ task: { id: 't1', description: '新' } });

    await patchTaskDescriptionTool.handler({ taskId: 't1', oldString: '旧', newString: '' }, ctx());

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][2].body).toEqual({ oldString: '旧', newString: '' });
  });

  it('成功返回透传 {task, idempotentReplay?}', async () => {
    const request = mockRequest();
    const backendResult = {
      task: { id: 't1', description: '新', descriptionHash: 'hash-1' },
    };
    request.mockResolvedValueOnce(backendResult);

    const result = await patchTaskDescriptionTool.handler(
      { taskId: 't1', oldString: '旧', newString: '新' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(backendResult);
    expect(body.task.descriptionHash).toBe('hash-1');
  });

  it('后端幂等重放标记 idempotentReplay 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      task: { id: 't1', description: '新' },
      idempotentReplay: true,
    });

    const result = await patchTaskDescriptionTool.handler(
      { taskId: 't1', oldString: '旧', newString: '新', clientRequestId: 'key-001' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.idempotentReplay).toBe(true);
  });

  it('后端错误透传 → failedStep=patch_task_description + status/code 保留', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        code: 10009,
        message: 'Task description has changed since the expected hash was captured',
      }),
    );

    const result = await patchTaskDescriptionTool.handler(
      { taskId: 't1', oldString: '旧', newString: '新', expectedDescriptionHash: 'stale' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('patch_task_description');
    expect(body.status).toBe(409);
    expect(body.code).toBe(10009);
  });

  it('PATCH 风格错误（无 code 的上游 404）→ failedStep=patch_task_description', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'oldString not found' }),
    );

    const result = await patchTaskDescriptionTool.handler(
      { taskId: 't1', oldString: '不存在', newString: '新' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('patch_task_description');
    expect(body.status).toBe(404);
    expect(body.code).toBeUndefined();
  });
});
