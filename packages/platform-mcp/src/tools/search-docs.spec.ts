/**
 * search_docs 单元测试
 *
 * 覆盖：happy path + 投影白名单、resolve 失败（0/>1）、search 失败、
 * 可选过滤参数透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { searchDocsTool } from './search-docs';
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

describe('search_docs', () => {
  it('happy path：搜索返回投影 hits', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([
      {
        docId: 'd1',
        docPath: 'docs/arch.md',
        docTitle: 'Architecture',
        headingPath: '§2 Design',
        position: 1,
        snippet: 'The system uses...',
        contentTruncated: false,
        score: 0.95,
        internalField: 'should-be-stripped',
      },
    ]);

    const result = await searchDocsTool.handler(
      { spaceName: 'My Docs', q: 'architecture' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.hits).toBeDefined();
    expect(body.hits.length).toBe(1);

    const hit = body.hits[0];
    // 投影白名单断言
    expect(hit.docId).toBe('d1');
    expect(hit.docPath).toBe('docs/arch.md');
    expect(hit.docTitle).toBe('Architecture');
    expect(hit.headingPath).toBe('§2 Design');
    expect(hit.position).toBe(1);
    expect(hit.snippet).toBe('The system uses...');
    expect(hit.score).toBe(0.95);
    // 非白名单字段不应存在
    expect(hit.internalField).toBeUndefined();
  });

  it('contentTruncated 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([
      {
        docId: 'd1',
        docPath: 'docs/x.md',
        docTitle: 'X',
        headingPath: null,
        position: 0,
        snippet: 'long...',
        contentTruncated: true,
        score: 0.5,
      },
    ]);

    const result = await searchDocsTool.handler(
      { spaceName: 'My Docs', q: 'test' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.hits[0].contentTruncated).toBe(true);
  });

  it('可选过滤参数透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([]);

    await searchDocsTool.handler(
      { spaceName: 'My Docs', q: 'test', type: 'spec', tag: 'backend', category: 'docs', limit: 10 },
      ctx(),
    );

    // 验证 search 调用包含全部过滤参数
    const searchCall = request.mock.calls[1];
    expect(searchCall[0]).toBe('GET');
    expect(searchCall[2].params.q).toBe('test');
    expect(searchCall[2].params.type).toBe('spec');
    expect(searchCall[2].params.tag).toBe('backend');
    expect(searchCall[2].params.category).toBe('docs');
    expect(searchCall[2].params.limit).toBe(10);
  });

  it('默认 limit=5', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([]);

    await searchDocsTool.handler(
      { spaceName: 'My Docs', q: 'test' },
      ctx(),
    );

    const searchCall = request.mock.calls[1];
    expect(searchCall[2].params.limit).toBe(5);
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await searchDocsTool.handler(
      { spaceName: 'Ghost', q: 'test' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual([]);
  });

  it('>1 候选 → isError + candidates', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'A Space', slug: 'a-space' },
        { id: 'sp-2', name: 'A Zone', slug: 'a-zone' },
      ],
    });

    const result = await searchDocsTool.handler(
      { spaceName: 'A', q: 'test' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('search HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 500, message: 'Search failed' }),
    );

    const result = await searchDocsTool.handler(
      { spaceName: 'My Docs', q: 'test' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('search_docs');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce([]);

    const result = await searchDocsTool.handler(
      { spaceName: 'My Docs', q: 'test' },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
