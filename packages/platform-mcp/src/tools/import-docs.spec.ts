/**
 * import_docs 单元测试（A4：补齐 15 个工具中唯一缺失的 spec，铁律 17）
 *
 * 覆盖：docs 1–50 预检（0 篇 / 51 篇 / 非数组）、spaceName 三层匹配
 * （0 候选 / >1 候选）、batch 端点透传、source 固定 native、
 * 可选字段透传、部分失败内嵌（per-item error 不升级为整体 isError）、
 * HTTP 失败透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { importDocsTool } from './import-docs';
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

/** 生成 n 篇最小合法文档 */
function makeDocs(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    path: `docs/doc-${i}.md`,
    content: `# Doc ${i}`,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('import_docs', () => {
  it('happy path：解析 spaceName 后调用 batch 端点', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      results: [{ path: 'docs/a.md', status: 'created' }],
      summary: { created: 1, updated: 0, unchanged: 0, failed: 0 },
    });

    const result = await importDocsTool.handler(
      { spaceName: 'My Docs', docs: [{ path: 'docs/a.md', content: '# A' }] },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.summary.created).toBe(1);

    // 验证 batch 端点与请求体
    const putCall = request.mock.calls[1];
    expect(putCall[0]).toBe('PUT');
    expect(putCall[1]).toBe('/doc-spaces/sp-1/docs/batch');
    expect(putCall[2].body.docs).toHaveLength(1);
  });

  it('source 固定 native（每篇文档注入，不透出 inputSchema）', async () => {
    // inputSchema 不暴露 source 参数
    expect(importDocsTool.tool.inputSchema.properties?.['source']).toBeUndefined();

    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ results: [], summary: {} });

    await importDocsTool.handler(
      { spaceName: 'My Docs', docs: [{ path: 'a.md', content: 'x', source: 'git:evil' }] },
      ctx(),
    );

    const putCall = request.mock.calls[1];
    // 即使调用方塞入 source 也被覆盖为 native
    expect(putCall[2].body.docs[0].source).toBe('native');
  });

  it('可选字段透传（title/summary/docType/category/tags）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ results: [], summary: {} });

    await importDocsTool.handler(
      {
        spaceName: 'My Docs',
        docs: [
          {
            path: 'a.md',
            content: 'x',
            title: 'T',
            summary: 'S',
            docType: 'guide',
            category: 'docs',
            tags: ['backend'],
          },
        ],
      },
      ctx(),
    );

    const doc = request.mock.calls[1][2].body.docs[0];
    expect(doc.title).toBe('T');
    expect(doc.summary).toBe('S');
    expect(doc.docType).toBe('guide');
    expect(doc.category).toBe('docs');
    expect(doc.tags).toEqual(['backend']);
  });

  it('非数组 docs → isError（validate_docs）', async () => {
    const result = await importDocsTool.handler(
      { spaceName: 'My Docs', docs: 'not-an-array' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('validate_docs');
  });

  it('0 篇 → isError（1–50 预检下限）', async () => {
    const result = await importDocsTool.handler({ spaceName: 'My Docs', docs: [] }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('validate_docs');
    expect(body.message).toContain('1–50');
  });

  it('51 篇 → isError（1–50 预检上限）', async () => {
    const result = await importDocsTool.handler(
      { spaceName: 'My Docs', docs: makeDocs(51) },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('validate_docs');
    expect(body.message).toContain('51');
  });

  it('spaceName 0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Other', slug: 'other' }] });

    const result = await importDocsTool.handler(
      { spaceName: 'Ghost', docs: makeDocs(1) },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Other']);
  });

  it('spaceName >1 候选 → isError + candidates（三层匹配歧义）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project Alpha', slug: 'project-alpha' },
        { id: 'sp-2', name: 'Project Beta', slug: 'project-beta' },
      ],
    });

    const result = await importDocsTool.handler(
      { spaceName: 'Project', docs: makeDocs(1) },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates).toHaveLength(2);
  });

  it('部分失败内嵌：results 中的 per-item error 原样透传，不升级为整体 isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    // batch 端点契约：单篇失败不中断，error 内嵌在 results 对应项中
    request.mockResolvedValueOnce({
      results: [
        { path: 'docs/ok.md', status: 'created' },
        { path: 'docs/bad.md', status: 'failed', error: { status: 400, message: 'invalid path' } },
      ],
      summary: { created: 1, updated: 0, unchanged: 0, failed: 1 },
    });

    const result = await importDocsTool.handler(
      { spaceName: 'My Docs', docs: makeDocs(2) },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.results[1].status).toBe('failed');
    expect(body.results[1].error.message).toBe('invalid path');
    expect(body.summary.failed).toBe(1);
  });

  it('batch HTTP 失败 → isError（透传状态码）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(new PlatformApiError({ status: 403, message: 'Forbidden' }));

    const result = await importDocsTool.handler(
      { spaceName: 'My Docs', docs: makeDocs(1) },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('import_docs');
    expect(body.status).toBe(403);
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ results: [], summary: {} });

    const result = await importDocsTool.handler(
      { spaceName: 'My Docs', docs: makeDocs(1) },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
