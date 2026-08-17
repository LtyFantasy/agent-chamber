/**
 * delete_doc_route 单元测试（v1.55 任务 T3）
 *
 * 覆盖：happy path（DELETE 透传 {deleted:true}）、routeId 缺失守卫、
 * 上游 404 DOC_ROUTE_NOT_FOUND 透传、网络错误透传。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { deleteDocRouteTool } from './delete-doc-route';
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

describe('delete_doc_route', () => {
  it('happy path：DELETE /doc-routes/:id → {deleted:true} 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ deleted: true });

    const result = await deleteDocRouteTool.handler({ routeId: 'route-1' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true });

    const call = request.mock.calls[0];
    expect(call[0]).toBe('DELETE');
    expect(call[1]).toBe('/doc-routes/route-1');
  });

  it('routeId 缺失 → isError（不发请求）', async () => {
    const request = mockRequest();

    const result = await deleteDocRouteTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('routeId');
    expect(request).not.toHaveBeenCalled();
  });

  it('上游 404 DOC_ROUTE_NOT_FOUND 结构化透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, code: 10008, message: 'Doc route not found' }),
    );

    const result = await deleteDocRouteTool.handler({ routeId: 'ghost' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('delete_doc_route');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10008);
  });

  it('网络错误透传（无 status）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ message: 'Request failed: ECONNREFUSED' }),
    );

    const result = await deleteDocRouteTool.handler({ routeId: 'route-1' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('delete_doc_route');
    expect(body.status).toBeUndefined();
    expect(body.message).toContain('ECONNREFUSED');
  });
});
