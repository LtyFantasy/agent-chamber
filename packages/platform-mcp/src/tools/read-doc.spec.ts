/**
 * read_doc 单元测试
 *
 * 覆盖：大纲模式（spaceName+path）、大纲模式（docId）、position→section、
 * headingPath→section（先取大纲匹配再读 section）、双通道校验（缺参数→isError）、
 * path 定位失败（文档不存在）、doc not found、紧凑 JSON、不收 sectionId。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { readDocTool } from './read-doc';
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

describe('read_doc', () => {
  it('inputSchema 不收 sectionId', () => {
    const schema = readDocTool.tool.inputSchema;
    expect(schema.properties?.['sectionId']).toBeUndefined();
  });

  it('大纲模式（spaceName+path 定位）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/arch.md',
      title: 'Architecture',
      sections: [
        { position: 0, headingPath: null, headingLevel: 0, tokenEstimate: 50 },
        { position: 1, headingPath: '§1 Intro', headingLevel: 1, tokenEstimate: 30 },
      ],
      linkHealth: { total: 2, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/arch.md' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe('d1');
    expect(body.sections).toBeDefined();
    expect(body.sections.length).toBe(2);
    expect(body.linkHealth).toEqual({ total: 2, broken: [], checkedAt: '2026-07-30T00:00:00Z' });

    // 验证调用链：list spaces → docs?path= → /docs/:id
    expect(request.mock.calls.length).toBe(3);
  });

  it('大纲模式（docId 直接定位）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      title: 'X',
      sections: [],
      linkHealth: { total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
    });

    const result = await readDocTool.handler(
      { docId: 'd1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe('d1');
    expect(body.linkHealth).toEqual({ total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' });

    // 单次调用（不调 list spaces）
    expect(request.mock.calls.length).toBe(1);
  });

  it('position 定位 → section 正文', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    // doc 元数据（linkHealth）
    request.mockResolvedValueOnce({
      id: 'd1',
      linkHealth: { total: 1, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
    });
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 1,
      headingPath: '§1 Intro',
      headingLevel: 1,
      content: 'Section content here',
      tokenEstimate: 30,
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', position: 1 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.content).toBe('Section content here');
    expect(body.position).toBe(1);
    expect(body.linkHealth).toEqual({ total: 1, broken: [], checkedAt: '2026-07-30T00:00:00Z' });

    // 调用链应包含 sections/:position + 前一步 doc 元数据 fetch
    const sectionCall = request.mock.calls[3];
    expect(sectionCall[1]).toContain('sections/1');
  });

  it('headingPath 定位 → 先取大纲匹配 position 再读 section', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    // 大纲
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      sections: [
        { position: 0, headingPath: null, headingLevel: 0 },
        { position: 1, headingPath: '§1 Intro', headingLevel: 1 },
        { position: 2, headingPath: '§2 Design', headingLevel: 1 },
      ],
      linkHealth: { total: 3, broken: ['refs/old.md'], checkedAt: '2026-07-30T00:00:00Z' },
    });
    // section
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 2,
      headingPath: '§2 Design',
      headingLevel: 1,
      content: 'Design section content',
      tokenEstimate: 42,
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', headingPath: '§2 Design' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.content).toBe('Design section content');
    expect(body.position).toBe(2);
    expect(body.headingPath).toBe('§2 Design');
    expect(body.linkHealth).toEqual({
      total: 3,
      broken: ['refs/old.md'],
      checkedAt: '2026-07-30T00:00:00Z',
    });
  });

  it('headingPath 在大纲中未匹配 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      sections: [{ position: 0, headingPath: null, headingLevel: 0 }],
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', headingPath: 'Nonexistent' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('headingPath');
  });

  it('headingPath 命中多条 → isError + candidates，绝不静默挑选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      sections: [
        { position: 1, headingPath: 'A § 总结', headingLevel: 2 },
        { position: 5, headingPath: 'A § 总结', headingLevel: 2 },
      ],
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', headingPath: 'A § 总结' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('matches 2 sections');
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0].position).toBe(1);
    // 未发起 section 读取请求（仅 3 次：space 解析 + path 定位 + 大纲）
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('缺少定位参数 → isError', async () => {
    const result = await readDocTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Either docId or (spaceName + path)');
  });

  it('path 定位失败（文档不存在）→ isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'nonexistent.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Document not found');
  });

  it('read_doc_outline HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Not found' }),
    );

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_outline');
  });

  it('read_doc_section HTTP 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    // doc 元数据（linkHealth）成功
    request.mockResolvedValueOnce({
      id: 'd1',
      linkHealth: { total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 500, message: 'DB error' }),
    );

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', position: 0 },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_section');
  });

  it('大纲模式 linkHealth 为 null（旧数据未检查）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      sections: [],
      linkHealth: null,
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.linkHealth).toBeNull();
  });

  it('section 模式（position）linkHealth 为 null', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    // doc 元数据 linkHealth 为 null
    request.mockResolvedValueOnce({
      id: 'd1',
      linkHealth: null,
    });
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 0,
      headingPath: null,
      headingLevel: 0,
      content: 'Content',
      tokenEstimate: 10,
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', position: 0 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.content).toBe('Content');
    expect(body.linkHealth).toBeNull();
  });

  it('section 模式（position）doc 元数据 fetch 失败 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    // doc 元数据 fetch 失败
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Doc not found' }),
    );

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', position: 0 },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_outline');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      sections: [],
      linkHealth: { total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
