/**
 * get_doc_facets 单元测试（v1.92.0-dev，DocSpace 元数据治理 1 期）
 *
 * 覆盖：happy path（精确匹配 → facets 信封含词表状态与 vocabulary）、spaceId 直传
 * （跳过空间列表拉取）、三层匹配（前缀/子串/大小写不敏感）、0 候选 → isError +
 * availableNames、>1 候选 → isError + candidates、缺参 → isError、
 * list_doc_spaces HTTP 失败、get_doc_facets HTTP 失败（状态码透传）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getDocFacetsTool } from './get-doc-facets';
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

/** 后端 facets 响应样本（DocFacetsResponse，含词表状态与 vocabulary 回显） */
function facetsEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    types: [{ value: 'guide', count: 42, vocabStatus: 'declared' }],
    tags: [
      { value: 'openviking', count: 5, vocabStatus: 'canonical' },
      { value: 'OpenViking', count: 2, vocabStatus: 'alias', canonicalValue: 'openviking' },
      { value: 'misc', count: 1, vocabStatus: 'undeclared' },
    ],
    categories: [{ slug: 'architecture', name: '架构', count: 5 }],
    vocabulary: {
      docTypes: ['guide', 'reference'],
      canonicalTags: [{ value: 'openviking', aliases: ['OpenViking'] }],
      pathTypes: [{ pathPrefix: 'memory/', docType: 'memory' }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('get_doc_facets', () => {
  it('happy path：精确匹配 → 返回 facets 信封（含 vocabStatus 与 vocabulary 回显）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce(facetsEnvelope());

    const result = await getDocFacetsTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.types[0]).toEqual({ value: 'guide', count: 42, vocabStatus: 'declared' });
    expect(body.tags[1]).toEqual({
      value: 'OpenViking',
      count: 2,
      vocabStatus: 'alias',
      canonicalValue: 'openviking',
    });
    expect(body.categories[0]).toEqual({ slug: 'architecture', name: '架构', count: 5 });
    expect(body.vocabulary.canonicalTags[0].value).toBe('openviking');

    const facetsCall = request.mock.calls[1];
    expect(facetsCall[0]).toBe('GET');
    expect(facetsCall[1]).toContain('sp-1/docs/facets');
  });

  it('spaceId 直传：跳过空间列表解析（仅一次请求）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(facetsEnvelope());

    const result = await getDocFacetsTool.handler({ spaceId: 'sp-direct' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toContain('sp-direct/docs/facets');
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
      request.mockResolvedValueOnce(facetsEnvelope());

      const result = await getDocFacetsTool.handler({ spaceName: needle }, ctx());
      expect(result.isError).toBeFalsy();
      expect(request.mock.calls[1][1]).toContain('sp-1/docs/facets');
    }
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await getDocFacetsTool.handler({ spaceName: 'Ghost' }, ctx());

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

    const result = await getDocFacetsTool.handler({ spaceName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('spaceName 与 spaceId 均缺失 → isError（不发任何请求）', async () => {
    const request = mockRequest();

    const result = await getDocFacetsTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(request).not.toHaveBeenCalled();
  });

  it('list_doc_spaces HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await getDocFacetsTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_spaces');
  });

  it('get_doc_facets HTTP 失败 → isError（状态码透传，不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(new PlatformApiError({ status: 404, message: 'not found' }));

    const result = await getDocFacetsTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_doc_facets');
    expect(body.status).toBe(404);
  });

  it('未配置词表：响应无 vocabulary / vocabStatus（原样透传，不补默认值）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(facetsEnvelope({ vocabulary: undefined }));

    const result = await getDocFacetsTool.handler({ spaceId: 'sp-1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.vocabulary).toBeUndefined();
  });
});
