/**
 * delete_doc 单元测试
 *
 * 覆盖：双通道（spaceName+path / docId）、resolve 失败、path 定位失败、
 * 缺参数校验、delete HTTP 失败、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { deleteDocTool } from './delete-doc';
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

describe('delete_doc', () => {
  it('happy path（spaceName + path）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      deleted: true,
      path: 'docs/x.md',
    });

    const result = await deleteDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.deleted).toBe(true);
    expect(body.path).toBe('docs/x.md');

    // 验证 DELETE /docs/:id 调用
    const deleteCall = request.mock.calls[2];
    expect(deleteCall[0]).toBe('DELETE');
    expect(deleteCall[1]).toContain('/docs/d1');
  });

  it('happy path（docId 直接定位）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      deleted: true,
      path: 'docs/y.md',
    });

    const result = await deleteDocTool.handler(
      { docId: 'd2' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.deleted).toBe(true);
    expect(body.path).toBe('docs/y.md');

    // 不调 list spaces
    expect(request.mock.calls.length).toBe(1);
  });

  it('缺少定位参数 → isError', async () => {
    const result = await deleteDocTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Either docId or (spaceName + path)');
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await deleteDocTool.handler(
      { spaceName: 'Ghost', path: 'x.md' },
      ctx(),
    );

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

    const result = await deleteDocTool.handler(
      { spaceName: 'Project', path: 'x.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('path 定位失败（文档不存在）→ isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await deleteDocTool.handler(
      { spaceName: 'My Docs', path: 'nonexistent.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Document not found');
  });

  it('delete HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 403, message: 'Permission denied' }),
    );

    const result = await deleteDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('delete_doc');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      deleted: true,
      path: 'docs/z.md',
    });

    const result = await deleteDocTool.handler({ docId: 'd3' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
