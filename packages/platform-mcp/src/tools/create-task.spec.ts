/**
 * create_task 单元测试
 *
 * 覆盖：happy path（mappedStatus 解析）、列名精确兜底、0 候选报错、
 * 多候选报错、assignee 解析与歧义报错、mappedStatus=null 不带 status。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { createTaskTool } from './create-task';
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

describe('create_task', () => {
  it('happy path：mappedStatus 精确匹配 → 建任务成功', async () => {
    const request = mockRequest();
    // GET /boards/:id/lists
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
      { id: 'lst-2', name: '进行中', mappedStatus: 'in_progress' },
      { id: 'lst-3', name: 'Done', mappedStatus: 'done' },
    ]);
    // POST /tasks
    request.mockResolvedValueOnce({ id: 't1', title: 'Test Task' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'Test Task', status: 'in_progress' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.task.id).toBe('t1');
    expect(body.resolution.matchedBy).toBe('mappedStatus=in_progress');
    expect(body.resolution.listId).toBe('lst-2');

    // POST body 应带 status=in_progress
    const postCall = request.mock.calls.find((c: any[]) => c[0] === 'POST');
    expect(postCall[2].body.listId).toBe('lst-2');
    expect(postCall[2].body.status).toBe('in_progress');
    expect(postCall[2].body.title).toBe('Test Task');
  });

  it('status 默认 "backlog"', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    await createTaskTool.handler({ boardId: 'b1', title: 'T' }, ctx());

    const postCall = request.mock.calls.find((c: any[]) => c[0] === 'POST');
    expect(postCall[2].body.status).toBe('backlog');
    expect(postCall[2].body.listId).toBe('lst-1');
  });

  it('列名精确兜底（无 mappedStatus 命中时）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'todo', mappedStatus: null },
      { id: 'lst-2', name: 'done', mappedStatus: 'done' },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', status: 'todo' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.resolution.listId).toBe('lst-1');
    expect(body.resolution.matchedBy).toBe('listName exact');
    // mappedStatus=null → POST body 不带 status
    const postCall = request.mock.calls.find((c: any[]) => c[0] === 'POST');
    expect(postCall[2].body.status).toBeUndefined();
  });

  it('列名字串兜底', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Sprint Backlog', mappedStatus: null },
      { id: 'lst-2', name: 'Done', mappedStatus: 'done' },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', status: 'backlog' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.resolution.listId).toBe('lst-1');
    expect(body.resolution.matchedBy).toBe('listName substring');
  });

  it('status 0 候选 → isError + 列出可选项', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
      { id: 'lst-2', name: 'Done', mappedStatus: 'done' },
    ]);

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', status: 'review' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_list');
    expect(body.options).toBeDefined();
    expect(body.options.length).toBe(2);
  });

  it('status 多候选 → isError + 候选列表', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Dev Todo', mappedStatus: null },
      { id: 'lst-2', name: 'QA Todo', mappedStatus: null },
    ]);

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', status: 'todo' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_list');
    expect(body.candidates).toBeDefined();
    expect(body.candidates.length).toBe(2);
  });

  it('assigneeName 精确匹配', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({
      members: [
        { id: 'u-1', name: 'Alice', type: 'agent', role: 'editor' },
        { id: 'u-2', name: 'Bob', type: 'agent', role: 'member' },
      ],
    });
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', assigneeName: 'Bob' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.resolution.assigneeId).toBe('u-2');
    expect(body.resolution.assigneeName).toBe('Bob');
    expect(body.resolution.assigneeMatchedBy).toContain('exact');

    const postCall = request.mock.calls.find((c: any[]) => c[0] === 'POST');
    expect(postCall[2].body.assigneeId).toBe('u-2');
  });

  it('assigneeName 大小写不敏感', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({
      members: [{ id: 'u-1', name: 'Alice', type: 'agent', role: 'editor' }],
    });
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', assigneeName: 'alice' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.resolution.assigneeId).toBe('u-1');
  });

  it('assigneeName 歧义 → isError + 候选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({
      members: [
        { id: 'u-1', name: 'Alice', type: 'agent', role: 'editor' },
        { id: 'u-2', name: 'Alex', type: 'agent', role: 'member' },
      ],
    });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', assigneeName: 'Al' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_assignee');
    expect(body.candidates).toBeDefined();
    expect(body.candidates.length).toBe(2);
    // 不应调 POST /tasks
    const postCall = request.mock.calls.find((c: any[]) => c[0] === 'POST');
    expect(postCall).toBeUndefined();
  });

  it('assigneeName 0 候选 → isError + 列出成员名', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({
      members: [{ id: 'u-1', name: 'Alice', type: 'agent', role: 'editor' }],
    });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', assigneeName: 'Ghost' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_assignee');
    expect(body.availableNames).toEqual(['Alice']);
  });

  it('mappedStatus=null 时不带 status', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Custom Col', mappedStatus: null },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', status: 'cust' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.resolution.listId).toBe('lst-1');
    expect(body.resolution.matchedBy).toBe('listName substring');

    const postCall = request.mock.calls.find((c: any[]) => c[0] === 'POST');
    expect(postCall[2].body.status).toBeUndefined();
  });

  it('get_board_lists HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Board not found' }),
    );

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_board_lists');
  });

  it('create_task HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 400, message: 'Validation failed' }),
    );

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('create_task');
  });

  it('输出含幂等键提示 note', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.note).toContain('idempotency key');
  });

  it('传入 clientRequestId 时不输出 note 提示', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', clientRequestId: 'req-001' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.note).toBeUndefined();
  });

  it('后端返回 idempotentReplay:true 时透传标记', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({ id: 't1', idempotentReplay: true, title: 'Existing' });

    const result = await createTaskTool.handler(
      { boardId: 'b1', title: 'T', clientRequestId: 'req-002' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.idempotentReplay).toBe(true);
    expect(body.note).toBeUndefined();
  });

  it('clientRequestId 传入时透传给 POST /tasks', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      { id: 'lst-1', name: 'Backlog', mappedStatus: 'backlog' },
    ]);
    request.mockResolvedValueOnce({ id: 't1' });

    await createTaskTool.handler(
      { boardId: 'b1', title: 'T', clientRequestId: 'req-003' },
      ctx(),
    );

    const createCall = request.mock.calls[1] as [string, string, { body?: Record<string, unknown> }];
    expect(createCall[2].body?.clientRequestId).toBe('req-003');
  });
});
