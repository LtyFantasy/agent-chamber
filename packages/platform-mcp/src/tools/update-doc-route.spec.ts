/**
 * update_doc_route 单元测试（v1.55 任务 T3）
 *
 * 覆盖：happy path（PATCH 透传 Partial 字段）、nullable 字段 null=清空语义、
 * 非空字段 null 丢弃、routeId 缺失守卫、上游 404/400 透传。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { updateDocRouteTool } from './update-doc-route';
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

const updatedRoute = {
  id: 'route-1',
  spaceId: 'sp-1',
  intent: '新意图',
  primaryDocId: 'doc-1',
  sortOrder: 5,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('update_doc_route', () => {
  it('happy path：PATCH /doc-routes/:id 透传 Partial 字段', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(updatedRoute);

    const result = await updateDocRouteTool.handler(
      { routeId: 'route-1', intent: '新意图', sortOrder: 5 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).intent).toBe('新意图');

    const call = request.mock.calls[0];
    expect(call[0]).toBe('PATCH');
    expect(call[1]).toBe('/doc-routes/route-1');
    expect(call[2].body).toEqual({ intent: '新意图', sortOrder: 5 });
  });

  it('nullable 字段显式 null = 清空（透传给服务端 Partial 合并语义）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(updatedRoute);

    await updateDocRouteTool.handler(
      {
        routeId: 'route-1',
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: null,
        category: null,
        primaryHeadingPath: null,
      },
      ctx(),
    );

    const call = request.mock.calls[0];
    expect(call[2].body).toEqual({
      category: null,
      primaryHeadingPath: null,
      secondaryDocId: null,
      secondaryHeadingPath: null,
      codeEntry: null,
    });
  });

  it('非空约束字段（intent/primaryDocId/sortOrder）null 丢弃，避免透传 DB 非空违约', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(updatedRoute);

    await updateDocRouteTool.handler(
      { routeId: 'route-1', intent: null, primaryDocId: null, sortOrder: null, category: 'ops' },
      ctx(),
    );

    const call = request.mock.calls[0];
    expect(call[2].body).toEqual({ category: 'ops' });
  });

  it('codeEntryType 透传（T5），null 丢弃（非空枚举列）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(updatedRoute);

    await updateDocRouteTool.handler(
      { routeId: 'route-1', codeEntryType: 'pattern', sortOrder: null },
      ctx(),
    );

    const call = request.mock.calls[0];
    expect(call[2].body).toEqual({ codeEntryType: 'pattern' });
  });

  it('routeId 缺失 → isError（不发请求）', async () => {
    const request = mockRequest();

    const result = await updateDocRouteTool.handler({ intent: 'x' }, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('routeId');
    expect(request).not.toHaveBeenCalled();
  });

  it('上游 404 DOC_ROUTE_NOT_FOUND 结构化透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, code: 10008, message: 'Doc route not found' }),
    );

    const result = await updateDocRouteTool.handler({ routeId: 'ghost', intent: 'x' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('update_doc_route');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10008);
  });

  it('上游写时校验 400 结构化透传（改 refs 触发合并校验）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        code: 10005,
        message: "Document 'doc-x' does not exist or does not belong to this space",
      }),
    );

    const result = await updateDocRouteTool.handler(
      { routeId: 'route-1', primaryDocId: 'doc-x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(400);
    expect(body.code).toBe(10005);
  });
});
