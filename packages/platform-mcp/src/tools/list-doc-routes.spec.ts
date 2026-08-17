/**
 * list_doc_routes 单元测试（v1.55 任务 T2）
 *
 * 覆盖：happy path（全量数组透传）、分页参数透传（信封透传）、
 * q/category 透传、0 候选→isError+availableNames、>1 候选→isError+candidates、
 * list_doc_spaces HTTP 失败、list_routes HTTP 失败、空值忽略。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { listDocRoutesTool } from './list-doc-routes';
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

const routeRow = {
  id: 'route-1',
  spaceId: 'sp-1',
  intent: '我要了解系统架构',
  category: 'architecture',
  primaryDocId: 'doc-1',
  sortOrder: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('list_doc_routes', () => {
  it('happy path：不传分页参数 → 全量数组原样透传（传统契约）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([routeRow]);

    const result = await listDocRoutesTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].intent).toBe('我要了解系统架构');

    const listCall = request.mock.calls[1];
    expect(listCall[0]).toBe('GET');
    expect(listCall[1]).toContain('sp-1/routes');
    // 未传参数 → 空 params（不触发后端分页模式）
    expect(listCall[2].params).toEqual({});
  });

  it('分页参数透传 → 后端分页信封原样返回', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    const envelope = {
      items: [routeRow],
      total: 191,
      page: 2,
      pageSize: 100,
      totalPages: 2,
      hasNext: false,
      hasPrev: true,
    };
    request.mockResolvedValueOnce(envelope);

    const result = await listDocRoutesTool.handler(
      { spaceName: 'My Docs', page: 2, pageSize: 100 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.total).toBe(191);
    expect(body.hasNext).toBe(false);
    const listCall = request.mock.calls[1];
    expect(listCall[2].params).toEqual({ page: 2, pageSize: 100 });
  });

  it('q/category 过滤透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([]);

    await listDocRoutesTool.handler(
      { spaceName: 'My Docs', q: '架构', category: 'architecture' },
      ctx(),
    );

    const listCall = request.mock.calls[1];
    expect(listCall[2].params).toEqual({ q: '架构', category: 'architecture' });
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await listDocRoutesTool.handler({ spaceName: 'Ghost' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Alpha']);
  });

  it('>1 候选 → isError + candidates（绝不静默挑选）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project A', slug: 'project-a' },
        { id: 'sp-2', name: 'Project B', slug: 'project-b' },
      ],
    });

    const result = await listDocRoutesTool.handler({ spaceName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('list_doc_spaces HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await listDocRoutesTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_spaces');
  });

  it('list_routes HTTP 失败 → isError（状态码透传，不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(new PlatformApiError({ status: 403, message: 'denied' }));

    const result = await listDocRoutesTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_routes');
    expect(body.status).toBe(403);
  });

  it('空串/null 参数被忽略（不携带）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([]);

    await listDocRoutesTool.handler(
      { spaceName: 'My Docs', q: '', category: null, page: undefined },
      ctx(),
    );

    const listCall = request.mock.calls[1];
    expect(listCall[2].params).toEqual({});
  });
});
