/**
 * list_docs 单元测试（v1.55 任务 T2）
 *
 * 覆盖：happy path（精确匹配→清单信封）、三层匹配（前缀/子串/大小写不敏感）、
 * 0 候选→isError+availableNames、>1 候选→isError+candidates、
 * list_doc_spaces HTTP 失败、list_docs HTTP 失败、
 * 过滤/分页参数透传（docType→type 映射）、slim 投影、空值忽略。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { listDocsTool } from './list-docs';
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

/** 后端 docs 列表信封样本 */
function docListEnvelope(items: Record<string, unknown>[] = []) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('list_docs', () => {
  it('happy path：精确匹配 → 返回文档清单信封', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(
      docListEnvelope([
        {
          id: 'd1',
          path: 'docs/a.md',
          title: 'A',
          summary: 'long summary',
          updatedAt: '2024-01-01',
        },
      ]),
    );

    const result = await listDocsTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    // 默认非 slim：summary 等元数据保留
    expect(body.items[0].summary).toBe('long summary');

    const listCall = request.mock.calls[1];
    expect(listCall[0]).toBe('GET');
    expect(listCall[1]).toContain('sp-1/docs');
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
      request.mockResolvedValueOnce(docListEnvelope());

      const result = await listDocsTool.handler({ spaceName: needle }, ctx());
      expect(result.isError).toBeFalsy();
      // 三种 needle 都解析到 sp-1（前缀层或子串层命中）
      const listCall = request.mock.calls[1];
      expect(listCall[1]).toContain('sp-1/docs');
    }
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await listDocsTool.handler({ spaceName: 'Ghost' }, ctx());

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

    const result = await listDocsTool.handler({ spaceName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('list_doc_spaces HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await listDocsTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_spaces');
  });

  it('list_docs HTTP 失败 → isError（状态码透传，不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Space not found' }),
    );

    const result = await listDocsTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_docs');
    expect(body.status).toBe(404);
  });

  it('过滤/分页参数透传：docType 映射为后端 type，其余原样', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(docListEnvelope());

    const result = await listDocsTool.handler(
      {
        spaceName: 'My Docs',
        pathPrefix: 'memory/',
        category: 'diary',
        docType: 'memory',
        tag: 'prod',
        q: '部署',
        page: 2,
        pageSize: 50,
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const listCall = request.mock.calls[1];
    expect(listCall[2].params).toEqual({
      pathPrefix: 'memory/',
      category: 'diary',
      tag: 'prod',
      q: '部署',
      page: 2,
      pageSize: 50,
      type: 'memory', // docType → type 映射
    });
  });

  it('slim=true → 只保留 path/title/updatedAt，分页元信息保留', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(
      docListEnvelope([
        {
          id: 'd1',
          path: 'docs/a.md',
          title: 'A',
          summary: 'x'.repeat(500), // 摘要是清单场景的 token 大头
          docType: 'guide',
          tags: ['t'],
          tokenEstimate: 999,
          updatedAt: '2024-01-02',
        },
      ]),
    );

    const result = await listDocsTool.handler({ spaceName: 'My Docs', slim: true }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.items[0]).toEqual({ path: 'docs/a.md', title: 'A', updatedAt: '2024-01-02' });
    // summary/docType/tokenEstimate 等全部被投影掉
    expect(body.items[0].summary).toBeUndefined();
    expect(body.items[0].tokenEstimate).toBeUndefined();
    // 分页元信息保留（供循环翻页拉全）+ slim 标记
    expect(body.total).toBe(1);
    expect(body.hasNext).toBe(false);
    expect(body.slim).toBe(true);
  });

  it('slim 缺省 → 不投影（完整条目透传）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(
      docListEnvelope([{ id: 'd1', path: 'docs/a.md', title: 'A', summary: 'keep-me' }]),
    );

    const result = await listDocsTool.handler({ spaceName: 'My Docs' }, ctx());

    const body = JSON.parse(result.content[0].text);
    expect(body.items[0].summary).toBe('keep-me');
    expect(body.slim).toBeUndefined();
  });

  it('空串/null 过滤参数被忽略（不携带）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(docListEnvelope());

    await listDocsTool.handler(
      { spaceName: 'My Docs', pathPrefix: '', docType: null, q: '', page: undefined },
      ctx(),
    );

    const listCall = request.mock.calls[1];
    expect(listCall[2].params).toEqual({});
  });
});
