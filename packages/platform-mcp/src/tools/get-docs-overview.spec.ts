/**
 * get_docs_overview 单元测试
 *
 * 覆盖：happy path（精确匹配→概览）、0 候选→isError+candidates、
 * >1 候选→isError+candidates、list_doc_spaces HTTP 失败、
 * get_overview HTTP 失败、truncated 透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getDocsOverviewTool } from './get-docs-overview';
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

describe('get_docs_overview', () => {
  it('happy path：精确匹配 → 返回概览', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'My Docs', slug: 'my-docs' },
        { id: 'sp-2', name: 'Other Space', slug: 'other-space' },
      ],
    });
    request.mockResolvedValueOnce({
      spaceId: 'sp-1',
      spaceName: 'My Docs',
      categories: [],
      uncategorized: [],
      truncated: false,
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'My Docs' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.spaceId).toBe('sp-1');
    expect(body.truncated).toBe(false);

    // 验证 GET /doc-spaces/:id/overview 调用
    const overviewCall = request.mock.calls[1];
    expect(overviewCall[0]).toBe('GET');
    expect(overviewCall[1]).toContain('sp-1/overview');
  });

  it('前缀匹配', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project Docs', slug: 'project-docs' },
        { id: 'sp-2', name: 'Other', slug: 'other' },
      ],
    });
    request.mockResolvedValueOnce({
      spaceId: 'sp-1',
      spaceName: 'Project Docs',
      categories: [],
      uncategorized: [],
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'Proj' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.spaceId).toBe('sp-1');
  });

  it('子串匹配', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Alpha Beta', slug: 'alpha-beta' },
        { id: 'sp-2', name: 'Gamma', slug: 'gamma' },
      ],
    });
    request.mockResolvedValueOnce({
      spaceId: 'sp-1',
      spaceName: 'Alpha Beta',
      categories: [],
      uncategorized: [],
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'Beta' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.spaceId).toBe('sp-1');
  });

  it('大小写不敏感', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'My Docs', slug: 'my-docs' },
      ],
    });
    request.mockResolvedValueOnce({
      spaceId: 'sp-1',
      spaceName: 'My Docs',
      categories: [],
      uncategorized: [],
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'my docs' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.spaceId).toBe('sp-1');
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Alpha', slug: 'alpha' },
      ],
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'Ghost' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Alpha']);
  });

  it('>1 候选 → isError + candidates', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project A', slug: 'project-a' },
        { id: 'sp-2', name: 'Project B', slug: 'project-b' },
      ],
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'Project' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates).toBeDefined();
    expect(body.candidates.length).toBe(2);
  });

  it('list_doc_spaces HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 500, message: 'Internal error' }),
    );

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'My Docs' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_spaces');
  });

  it('get_overview HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Space not found' }),
    );

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'My Docs' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_overview');
  });

  it('truncated 标记透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      spaceId: 'sp-1',
      spaceName: 'My Docs',
      categories: [],
      uncategorized: [],
      truncated: true,
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'My Docs' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.truncated).toBe(true);
  });

  it('紧凑 JSON（无缩进）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      spaceId: 'sp-1',
      spaceName: 'My Docs',
    });

    const result = await getDocsOverviewTool.handler(
      { spaceName: 'My Docs' },
      ctx(),
    );

    const text = result.content[0].text;
    // 紧凑 JSON 不应含换行缩进
    expect(text).not.toContain('\n  ');
    // 验证可解析
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('过滤参数透传：type/excludeType/category/tag/maxTokens/applySpaceDefaults 原样传给 REST', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ spaceId: 'sp-1', spaceName: 'My Docs' });

    const result = await getDocsOverviewTool.handler(
      {
        spaceName: 'My Docs',
        type: 'guide,reference',
        excludeType: 'memory',
        category: 'arch',
        excludeCategory: 'archive',
        tag: 'prod',
        pathPrefix: 'docs/',
        maxTokens: 6000,
        applySpaceDefaults: false,
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const overviewCall = request.mock.calls[1];
    expect(overviewCall[0]).toBe('GET');
    expect(overviewCall[2].params).toEqual({
      type: 'guide,reference',
      excludeType: 'memory',
      category: 'arch',
      excludeCategory: 'archive',
      tag: 'prod',
      pathPrefix: 'docs/',
      maxTokens: 6000,
      applySpaceDefaults: false,
    });
  });

  it('未传过滤参数 → 空 params（不携带多余键）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ spaceId: 'sp-1', spaceName: 'My Docs' });

    await getDocsOverviewTool.handler({ spaceName: 'My Docs' }, ctx());

    const overviewCall = request.mock.calls[1];
    expect(overviewCall[2].params).toEqual({});
  });

  it('空串/空值过滤参数被忽略（不携带）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ spaceId: 'sp-1', spaceName: 'My Docs' });

    await getDocsOverviewTool.handler(
      { spaceName: 'My Docs', type: '', excludeType: '', maxTokens: null },
      ctx(),
    );

    const overviewCall = request.mock.calls[1];
    expect(overviewCall[2].params).toEqual({});
  });
});
