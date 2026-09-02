/**
 * list_doc_tree 单元测试（v1.70.0-dev 懒加载目录树 Phase 3）
 *
 * 覆盖：happy path（精确匹配→目录树信封）、三层匹配（前缀/子串/大小写不敏感）、
 * 0 候选→isError+availableNames、>1 候选→isError+candidates、
 * list_doc_spaces HTTP 失败、list_doc_tree HTTP 失败、
 * prefix/sort/分页参数透传、空值忽略。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { listDocTreeTool } from './list-doc-tree';
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

/** 后端目录树响应样本（DocTreeResponse） */
function docTreeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    prefix: '',
    folders: { items: [], total: 0, hasMore: false },
    docs: { items: [], total: 0, hasMore: false },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('list_doc_tree', () => {
  it('happy path：精确匹配 → 返回目录树信封（folders/docs 独立分页）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(
      docTreeEnvelope({
        prefix: 'memory/',
        folders: {
          items: [
            {
              path: 'memory/2026-08-29/',
              name: '2026-08-29',
              docCount: 187,
              latestDocAt: '2026-08-29T08:00:00.000Z',
            },
          ],
          total: 365,
          hasMore: true,
        },
        docs: {
          items: [
            {
              id: 'd1',
              path: 'memory/note.md',
              title: 'Note',
              docType: 'memory',
              updatedAt: '2026-08-29T08:00:00.000Z',
            },
          ],
          total: 3,
          hasMore: false,
        },
      }),
    );

    const result = await listDocTreeTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.prefix).toBe('memory/');
    expect(body.folders.items[0]).toEqual({
      path: 'memory/2026-08-29/',
      name: '2026-08-29',
      docCount: 187,
      latestDocAt: '2026-08-29T08:00:00.000Z',
    });
    expect(body.folders.total).toBe(365);
    expect(body.folders.hasMore).toBe(true);
    expect(body.docs.items[0].id).toBe('d1');
    expect(body.docs.total).toBe(3);
    expect(body.docs.hasMore).toBe(false);

    const treeCall = request.mock.calls[1];
    expect(treeCall[0]).toBe('GET');
    expect(treeCall[1]).toContain('sp-1/docs/tree');
  });

  it('三层匹配：前缀/子串/大小写不敏感均可解析', async () => {
    for (const needle of ['Proj', 'Docs Space', 'docs space']) {
      const request = mockRequest();
      request.mockResolvedValueOnce({
        items: [
          { id: 'sp-1', name: 'Project Docs Space', slug: 'pds' },
          { id: 'sp-2', name: 'Other', slug: 'other' },
        ],
      });
      request.mockResolvedValueOnce(docTreeEnvelope());

      const result = await listDocTreeTool.handler({ spaceName: needle }, ctx());
      expect(result.isError).toBeFalsy();
      // 三种 needle 都解析到 sp-1（前缀层或子串层命中）
      const treeCall = request.mock.calls[1];
      expect(treeCall[1]).toContain('sp-1/docs/tree');
    }
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await listDocTreeTool.handler({ spaceName: 'Ghost' }, ctx());

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

    const result = await listDocTreeTool.handler({ spaceName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('list_doc_spaces HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await listDocTreeTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_spaces');
  });

  it('list_doc_tree HTTP 失败 → isError（状态码透传，不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(new PlatformApiError({ status: 400, message: 'limit exceeded' }));

    const result = await listDocTreeTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_tree');
    expect(body.status).toBe(400);
  });

  it('prefix/sort/分页参数透传（原样携带）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(docTreeEnvelope());

    const result = await listDocTreeTool.handler(
      {
        spaceName: 'My Docs',
        prefix: 'memory/2026-08-29/',
        sort: 'name',
        docsLimit: 100,
        docsOffset: 10,
        foldersLimit: 300,
        foldersOffset: 20,
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const treeCall = request.mock.calls[1];
    expect(treeCall[2].params).toEqual({
      prefix: 'memory/2026-08-29/',
      sort: 'name',
      docsLimit: 100,
      docsOffset: 10,
      foldersLimit: 300,
      foldersOffset: 20,
    });
  });

  it('空串/null 参数被忽略（不携带）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(docTreeEnvelope());

    await listDocTreeTool.handler(
      { spaceName: 'My Docs', prefix: '', sort: null, docsLimit: undefined },
      ctx(),
    );

    const treeCall = request.mock.calls[1];
    expect(treeCall[2].params).toEqual({});
  });
});
