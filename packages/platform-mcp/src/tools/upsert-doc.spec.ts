/**
 * upsert_doc 单元测试
 *
 * 覆盖：happy path、source 固定 native 不透出、409 透传、resolve 失败、
 * 可选参数透传、unchanged 标记、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { upsertDocTool } from './upsert-doc';
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

describe('upsert_doc', () => {
  it('happy path：upsert 成功返回结果', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/test.md',
      sectionCount: 3,
      tokenEstimate: 150,
    });

    const result = await upsertDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/test.md', content: '# Hello\n\nWorld' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe('d1');
    expect(body.path).toBe('docs/test.md');
    expect(body.sectionCount).toBe(3);
    expect(body.tokenEstimate).toBe(150);

    // 验证 source 固定为 native
    const putCall = request.mock.calls[1];
    expect(putCall[0]).toBe('PUT');
    expect(putCall[2].body.source).toBe('native');
    expect(putCall[2].body.path).toBe('docs/test.md');
    expect(putCall[2].body.content).toBe('# Hello\n\nWorld');
  });

  it('source 参数不透出（inputSchema 不含 source）', () => {
    const schema = upsertDocTool.tool.inputSchema;
    expect(schema.properties?.['source']).toBeUndefined();
  });

  it('可选参数透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ id: 'd1', path: 'x.md', sectionCount: 1, tokenEstimate: 10 });

    await upsertDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'docs/x.md',
        content: '# X',
        title: 'Custom Title',
        summary: 'A summary',
        docType: 'spec',
        category: 'docs',
        tags: ['backend', 'api'],
      },
      ctx(),
    );

    const putCall = request.mock.calls[1];
    expect(putCall[2].body.title).toBe('Custom Title');
    expect(putCall[2].body.summary).toBe('A summary');
    expect(putCall[2].body.docType).toBe('spec');
    expect(putCall[2].body.category).toBe('docs');
    expect(putCall[2].body.tags).toEqual(['backend', 'api']);
  });

  it('unchanged 标记透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      sectionCount: 1,
      tokenEstimate: 10,
      unchanged: true,
    });

    const result = await upsertDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', content: '# X' },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.unchanged).toBe(true);
  });

  it('409 DOC_SOURCE_MISMATCH 透传 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        message: 'Document source mismatch',
        code: 10003,
        details: { existingSource: 'git:repo', requestedSource: 'native' },
      }),
    );

    const result = await upsertDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', content: '# X' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('upsert_doc');
    expect(body.status).toBe(409);
    expect(body.code).toBe(10003);
    expect(body.details).toBeDefined();
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await upsertDocTool.handler(
      { spaceName: 'Ghost', path: 'x.md', content: 'x' },
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

    const result = await upsertDocTool.handler(
      { spaceName: 'Project', path: 'x.md', content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('upsert HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 500, message: 'DB error' }),
    );

    const result = await upsertDocTool.handler(
      { spaceName: 'My Docs', path: 'x.md', content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('upsert_doc');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ id: 'd1', path: 'x.md', sectionCount: 1, tokenEstimate: 10 });

    const result = await upsertDocTool.handler(
      { spaceName: 'My Docs', path: 'x.md', content: 'x' },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
