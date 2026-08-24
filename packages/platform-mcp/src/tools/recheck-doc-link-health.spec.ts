/**
 * recheck_doc_link_health 单元测试
 *
 * 覆盖：三通道定位（spaceName+path 单文档 / 裸 docId 单文档 / 仅 spaceName 空间级）、
 * 缺失参数校验、space resolve 失败、path 定位失败、HTTP 失败、紧凑 JSON、
 * 单文档与空间级端点调用路径。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { recheckDocLinkHealthTool } from './recheck-doc-link-health';
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

describe('recheck_doc_link_health', () => {
  it('单文档通道（spaceName + path）：resolve space → resolve doc → POST /docs/:id/link-health/recheck', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'd1' }] });
    request.mockResolvedValueOnce({
      total: 2,
      broken: ['ghost.md'],
      checkedAt: '2026-08-18T00:00:00.000Z',
    });

    const result = await recheckDocLinkHealthTool.handler(
      { spaceName: 'My Docs', path: 'docs/a.md' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ total: 2, broken: ['ghost.md'] });
    const call = request.mock.calls[2];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/docs/d1/link-health/recheck');
  });

  it('单文档通道（docId）：直接 POST /docs/:id/link-health/recheck（一次请求）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ total: 0, broken: [], checkedAt: 'x' });

    const result = await recheckDocLinkHealthTool.handler({ docId: 'd2' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).total).toBe(0);
    expect(request.mock.calls.length).toBe(1);
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toBe('/docs/d2/link-health/recheck');
  });

  it('空间级通道（仅 spaceName）：resolve space → POST /doc-spaces/:id/docs/link-health/recheck', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-9', name: 'Big Docs', slug: 'big-docs' }] });
    request.mockResolvedValueOnce({ checked: 42, broken: 3 });

    const result = await recheckDocLinkHealthTool.handler({ spaceName: 'Big Docs' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ checked: 42, broken: 3 });
    const call = request.mock.calls[1];
    expect(call[0]).toBe('POST');
    expect(call[1]).toBe('/doc-spaces/sp-9/docs/link-health/recheck');
  });

  it('缺少定位参数 → isError（三通道都未提供）', async () => {
    const result = await recheckDocLinkHealthTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('spaceName alone for a space-wide recheck');
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await recheckDocLinkHealthTool.handler({ spaceName: 'Ghost' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
  });

  it('>1 候选 → isError + candidates', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project Alpha', slug: 'project-alpha' },
        { id: 'sp-2', name: 'Project Beta', slug: 'project-beta' },
      ],
    });

    const result = await recheckDocLinkHealthTool.handler({ spaceName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('单文档 path 定位失败（文档不存在）→ isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [] });

    const result = await recheckDocLinkHealthTool.handler(
      { spaceName: 'My Docs', path: 'nonexistent.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Document not found');
  });

  it('单文档 recheck HTTP 失败 → isError（404 结构化透传）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'd1' }] });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Document not found', code: 'DOC_NOT_FOUND' }),
    );

    const result = await recheckDocLinkHealthTool.handler(
      { spaceName: 'My Docs', path: 'docs/a.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('recheck_doc_link_health');
    expect(body.status).toBe(404);
    expect(body.code).toBe('DOC_NOT_FOUND');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ total: 1, broken: ['x.md'], checkedAt: 't' });

    const result = await recheckDocLinkHealthTool.handler({ docId: 'd3' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
