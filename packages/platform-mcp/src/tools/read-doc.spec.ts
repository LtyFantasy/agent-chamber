/**
 * read_doc 单元测试
 *
 * 覆盖：outline 模式（spaceName+path / docId 定位）精简 JSON 投影字段集合（砍掉
 * spaceId/categoryId/source/sourceSha/createdBy/createdAt/mode）、full 模式原始
 * markdown 纯文本、position/headingPath → section 原始 markdown（标题行重建：
 * headingLevel>6 截断为 6 个 #、headingLevel=0 无标题行）、headingPath 未命中/多候选、
 * 双通道校验（缺参数→isError）、path 定位失败、HTTP 失败、maxFullTokens 透传、
 * 紧凑 JSON（outline 单行）、不收 sectionId、债 A 降级渲染双通道（headingText
 * 列直读优先 / 老服务端 extract 兜底）。
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

  it('大纲模式（spaceName+path 定位）→ 精简 JSON 字段集合', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      spaceId: 'sp-1',
      categoryId: 'cat-1',
      path: 'docs/arch.md',
      title: 'Architecture',
      summary: 'Architecture overview doc',
      docType: 'architecture',
      tags: ['arch', 'design'],
      source: 'git:github.com/foo/bar',
      sourceSha: 'abc123',
      sectionCount: 2,
      tokenEstimate: 5000,
      createdBy: 'agent-1',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-30T00:00:00Z',
      contentHash: 'hash-arch', // v1.62.0：读路径透出的乐观锁 token
      sections: [
        { position: 0, headingPath: null, headingLevel: 0, tokenEstimate: 50 },
        { position: 1, headingPath: '1 Intro', headingLevel: 1, tokenEstimate: 30 },
      ],
      linkHealth: { total: 2, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
      mode: 'outline',
    });

    const result = await readDocTool.handler({ spaceName: 'My Docs', path: 'docs/arch.md' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    // 投影后字段集合 = 白名单 12 字段（docId 取自后端响应 id；v1.62.0 增 contentHash）
    expect(Object.keys(body).sort()).toEqual(
      [
        'docId',
        'path',
        'title',
        'summary',
        'docType',
        'tags',
        'tokenEstimate',
        'sectionCount',
        'updatedAt',
        'contentHash',
        'linkHealth',
        'sections',
      ].sort(),
    );
    expect(body.docId).toBe('d1');
    expect(body.contentHash).toBe('hash-arch');
    expect(body.sections).toBeDefined();
    expect(body.sections.length).toBe(2);
    expect(body.sections[1]).toEqual({
      position: 1,
      headingPath: '1 Intro',
      headingLevel: 1,
      tokenEstimate: 30,
    });
    expect(body.linkHealth).toEqual({ total: 2, broken: [], checkedAt: '2026-07-30T00:00:00Z' });
    // 被砍掉的低价值字段
    expect(body.spaceId).toBeUndefined();
    expect(body.categoryId).toBeUndefined();
    expect(body.source).toBeUndefined();
    expect(body.sourceSha).toBeUndefined();
    expect(body.createdBy).toBeUndefined();
    expect(body.createdAt).toBeUndefined();
    expect(body.mode).toBeUndefined();
    expect(body.content).toBeUndefined();

    // 验证调用链：list spaces → docs?path= → /docs/:id
    expect(request.mock.calls.length).toBe(3);
  });

  it('大纲模式（docId 直接定位）→ 精简 JSON 字段集合', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      spaceId: 'sp-1',
      path: 'docs/x.md',
      title: 'X',
      summary: 'X doc summary',
      docType: 'guide',
      tags: ['x'],
      source: 'native',
      sectionCount: 0,
      tokenEstimate: 0,
      createdBy: 'agent-1',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      contentHash: 'hash-x', // v1.62.0：outline 投影透出乐观锁 token
      sections: [],
      linkHealth: { total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
      mode: 'outline',
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(Object.keys(body).sort()).toEqual(
      [
        'docId',
        'path',
        'title',
        'summary',
        'docType',
        'tags',
        'tokenEstimate',
        'sectionCount',
        'updatedAt',
        'contentHash',
        'linkHealth',
        'sections',
      ].sort(),
    );
    expect(body.docId).toBe('d1');
    expect(body.contentHash).toBe('hash-x');
    expect(body.sections).toEqual([]);
    expect(body.linkHealth).toEqual({ total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' });

    // 单次调用（不调 list spaces）
    expect(request.mock.calls.length).toBe(1);
  });

  it('大纲模式 linkHealth 为 null（旧数据未检查）→ 投影仍含 linkHealth 键', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      summary: 'X summary',
      docType: 'note',
      tags: [],
      tokenEstimate: 100,
      sectionCount: 0,
      updatedAt: '2026-07-02T00:00:00Z',
      sections: [],
      linkHealth: null,
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toHaveProperty('linkHealth');
    expect(body.linkHealth).toBeNull();
  });

  it('full 模式（小文档内联全文）→ 返回 content 原始 markdown 纯文本', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      title: 'X',
      mode: 'full',
      content: '# X\n\nInlined full content.',
      sections: [{ position: 0, headingPath: 'X', headingLevel: 1, tokenEstimate: 50 }],
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    expect(result.isError).toBeFalsy();
    // 不 JSON 包装、不加任何头部——text 就是 content 原值
    expect(result.content[0].text).toBe('# X\n\nInlined full content.');
  });

  it('outline 模式（mode:outline 大文档）→ 精简 JSON 且无 content', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      title: 'X',
      summary: 'X summary',
      docType: 'guide',
      tags: [],
      tokenEstimate: 5000,
      sectionCount: 1,
      updatedAt: '2026-07-02T00:00:00Z',
      mode: 'outline',
      sections: [{ position: 0, headingPath: null, headingLevel: 0, tokenEstimate: 5000 }],
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.docId).toBe('d1');
    expect(body.sections).toHaveLength(1);
    expect(body).not.toHaveProperty('content');
    expect(body).not.toHaveProperty('mode');
  });

  it('position 定位 → 原始 markdown = 标题行 + 空行 + content，且不再多打 linkHealth 请求', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 1,
      headingPath: '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）',
      headingLevel: 3,
      content: 'Section content here',
      tokenEstimate: 30,
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', position: 1 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    // 裸 §3.2 属于标题正文，不是 headingPath 层级分隔符；fallback 必须完整保真。
    expect(result.content[0].text).toBe(
      '### 2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）\n\nSection content here',
    );

    // 调用链仅 3 次：space 解析 + path 定位 + sections/:position
    // （旧实现 position 直给时还多打一次 doc 元数据请求取 linkHealth——已砍）
    expect(request).toHaveBeenCalledTimes(3);
    const sectionCall = request.mock.calls[2];
    expect(sectionCall[1]).toContain('sections/1');
  });

  it('旧服务端无 isContinuation 时 fallback 保留标题行，避免误吞同名 sibling', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 1,
      headingPath: 'Parent § Same',
      headingLevel: 4,
      content: 'Sibling body',
    });

    const result = await readDocTool.handler({ docId: 'd1', position: 1 }, ctx());

    expect(result.content[0].text).toBe('#### Same\n\nSibling body');
  });

  it('isContinuation=true 时 fallback 只返回正文，不插幻影标题', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 2,
      headingPath: 'Parent § Same',
      headingLevel: 4,
      isContinuation: true,
      content: 'Continuation body',
    });

    const result = await readDocTool.handler({ docId: 'd1', position: 2 }, ctx());

    expect(result.content[0].text).toBe('Continuation body');
  });

  // ─── 债 A：降级渲染双通道（headingText 列直读优先 → extract 反解析兜底）───

  it('新服务端带 headingText → 降级渲染用列直读标题（标题正文含 ` § ` 也不切错）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 1,
      headingPath: '价格区间 § 含 § 分隔符', // 反解析取末段会得到错误的 "分隔符"
      headingText: '价格区间 § 含 § 分隔符',
      headingLevel: 3,
      content: 'Section body',
      tokenEstimate: 10,
    });

    const result = await readDocTool.handler({ docId: 'd1', position: 1 }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('### 价格区间 § 含 § 分隔符\n\nSection body');
  });

  it('老服务端无 headingText → 降级 extractLastHeadingSegment 反解析末段', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 1,
      headingPath: 'Parent § Child',
      headingLevel: 2,
      content: 'Legacy body',
      tokenEstimate: 10,
    });

    const result = await readDocTool.handler({ docId: 'd1', position: 1 }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('## Child\n\nLegacy body');
  });

  it('headingPath 定位 → 先取大纲匹配 position 再读 section，返回含标题行 markdown', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    // 大纲（linkHealth 不再透传给 section 响应）
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'docs/x.md',
      sections: [
        { position: 0, headingPath: null, headingLevel: 0 },
        { position: 1, headingPath: 'Intro', headingLevel: 1 },
        { position: 2, headingPath: 'Design', headingLevel: 2 },
      ],
      linkHealth: { total: 3, broken: ['refs/old.md'], checkedAt: '2026-07-30T00:00:00Z' },
    });
    // section
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 2,
      headingPath: 'Design',
      headingLevel: 2,
      content: 'Design section content',
      tokenEstimate: 42,
    });

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', headingPath: 'Design' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('## Design\n\nDesign section content');

    // 调用链：space 解析 + path 定位 + 大纲解析 + section 读取 = 4 次
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[3][1]).toContain('sections/2');
  });

  it('headingLevel > 6 时标题行截断为 6 个 #', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 3,
      headingPath: 'A § B § Deep',
      headingLevel: 7,
      content: 'Deep content',
      tokenEstimate: 10,
    });

    const result = await readDocTool.handler({ docId: 'd1', position: 3 }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('###### Deep\n\nDeep content');
  });

  it('headingLevel=0 无标题行 → 只返回 content', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 0,
      headingPath: null,
      headingLevel: 0,
      content: 'Plain content.',
      tokenEstimate: 10,
    });

    const result = await readDocTool.handler({ docId: 'd1', position: 0 }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Plain content.');
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
    request.mockRejectedValueOnce(new PlatformApiError({ status: 404, message: 'Not found' }));

    const result = await readDocTool.handler({ spaceName: 'My Docs', path: 'docs/x.md' }, ctx());

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
    // section 读取失败（旧实现此处还有一步 doc 元数据 fetch——已砍）
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'DB error' }));

    const result = await readDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/x.md', position: 0 },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_section');
  });

  it('紧凑 JSON：outline 模式响应是单行 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      summary: 'X summary',
      docType: 'note',
      tags: [],
      tokenEstimate: 100,
      sectionCount: 0,
      updatedAt: '2026-07-02T00:00:00Z',
      mode: 'outline',
      sections: [],
      linkHealth: { total: 0, broken: [], checkedAt: '2026-07-30T00:00:00Z' },
    });

    const result = await readDocTool.handler({ docId: 'd1' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  // ─── 小文档内联全文（后端 mode/content + maxFullTokens 透传）───

  it('maxFullTokens 透传到后端 query；threshold 覆盖后 mode:full → 纯文本', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      mode: 'full',
      content: 'Inlined via threshold override.',
      sections: [],
    });

    const result = await readDocTool.handler({ docId: 'd1', maxFullTokens: 5000 }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Inlined via threshold override.');
    // GET /docs/:id 必须带 params { maxFullTokens: 5000 }
    const outlineCall = request.mock.calls[0];
    expect(outlineCall[1]).toBe('/docs/d1');
    expect(outlineCall[2]).toEqual({ params: { maxFullTokens: 5000 } });
  });

  it('maxFullTokens=0 强制 outline 亦透传（0 是合法显式值）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      mode: 'outline',
      sections: [{ position: 0, headingPath: null, headingLevel: 0, tokenEstimate: 100 }],
    });

    const result = await readDocTool.handler({ docId: 'd1', maxFullTokens: 0 }, ctx());

    expect(result.isError).toBeFalsy();
    const outlineCall = request.mock.calls[0];
    expect(outlineCall[2]).toEqual({ params: { maxFullTokens: 0 } });
    const body = JSON.parse(result.content[0].text);
    expect(body.sections).toHaveLength(1);
    expect(body).not.toHaveProperty('content');
  });

  it('大纲模式未传 maxFullTokens 时不带 options（保持原调用形态）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'x.md',
      title: 'X',
      sections: [],
    });

    await readDocTool.handler({ docId: 'd1' }, ctx());

    const outlineCall = request.mock.calls[0];
    expect(outlineCall[2]).toBeUndefined();
  });

  // ─── v1.55 positions[] 批量通道 ───────────────────────────────

  it('positions[] 批量 → 单次请求读多节，sections 渲染 markdown + missing 透出', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      sections: [
        {
          position: 1,
          headingPath: 'A § Intro',
          headingLevel: 2,
          content: 'Intro body',
          tokenEstimate: 30,
          sectionHash: 'hash-sec-1',
        },
        {
          position: 3,
          headingPath: null,
          headingLevel: 0,
          content: 'Plain body',
          tokenEstimate: 20,
        },
      ],
      missing: [9],
    });

    const result = await readDocTool.handler({ docId: 'd1', positions: [1, 3, 9] }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.docId).toBe('d1');
    expect(body.docPath).toBe('docs/x.md');
    expect(body.sections).toHaveLength(2);
    // 标题行重建与单节通道同款：headingLevel>0 + headingPath 末段；null headingPath → 纯 content
    expect(body.sections[0]).toEqual({
      position: 1,
      headingPath: 'A § Intro',
      headingLevel: 2,
      tokenEstimate: 30,
      sectionHash: 'hash-sec-1',
      markdown: '## Intro\n\nIntro body',
    });
    // sectionHash 透传（patch_doc expectedSectionHash 的取数通道，fail-closed 改造）；
    // 后端未返回时该项为 undefined（向后兼容旧后端）
    expect(body.sections[1].markdown).toBe('Plain body');
    expect(body.sections[1].sectionHash).toBeUndefined();
    // 越界 position 单独列出，不整体报错（部分失败友好）
    expect(body.missing).toEqual([9]);
    // 后端契约：数组序列化为逗号分隔字符串
    const batchCall = request.mock.calls[0];
    expect(batchCall[1]).toBe('/docs/d1/sections');
    expect(batchCall[2]).toEqual({ params: { positions: '1,3,9' } });
  });

  it('positions[] 与其他定位参数混用 → isError（不发 HTTP）', async () => {
    const request = mockRequest();

    for (const args of [
      { docId: 'd1', positions: [1], position: 0 },
      { docId: 'd1', positions: [1], headingPath: 'A' },
      { docId: 'd1', positions: [1], headingQuery: 'x' },
    ]) {
      const result = await readDocTool.handler(args, ctx());
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.message).toContain('mutually exclusive');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('positions[] 格式错误（非数组/空数组/非整数/超 100）→ isError', async () => {
    const request = mockRequest();

    for (const bad of [
      '1,3,5', // 字符串而非数组
      [], // 空数组
      [1, 'a'], // 非整数
      [1.5], // 非整数
      Array.from({ length: 101 }, (_, i) => i), // 超上限
    ]) {
      const result = await readDocTool.handler({ docId: 'd1', positions: bad }, ctx());
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).message).toContain('positions');
    }
    expect(request).not.toHaveBeenCalled();
  });

  // ─── v1.55 headingQuery 模糊通道 ──────────────────────────────

  it('headingQuery 唯一命中 → 返回该节 markdown（与单节通道同渲染）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd1',
      docPath: 'docs/x.md',
      position: 2,
      headingPath: 'A § 设计',
      headingLevel: 2,
      content: 'Design body',
      tokenEstimate: 42,
    });

    const result = await readDocTool.handler({ docId: 'd1', headingQuery: '设计' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('## 设计\n\nDesign body');
    const fuzzyCall = request.mock.calls[0];
    expect(fuzzyCall[1]).toBe('/docs/d1/sections');
    expect(fuzzyCall[2]).toEqual({ params: { headingQuery: '设计' } });
  });

  it('headingQuery 多命中（409）→ isError + candidates 提升到顶层（不静默挑选）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        code: 9007,
        message:
          'headingQuery "总结" matches 2 sections; retry with an exact position or headingPath',
        details: {
          candidates: [
            { position: 1, headingPath: 'A § 总结' },
            { position: 5, headingPath: 'B § 总结' },
          ],
        },
      }),
    );

    const result = await readDocTool.handler({ docId: 'd1', headingQuery: '总结' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(409);
    expect(body.failedStep).toBe('read_doc_heading_query');
    expect(body.message).toContain('matches 2 sections');
    // candidates 从错误 details 提升到响应顶层（Agent 直接读 position/headingPath 改用精确定位）
    expect(body.candidates).toEqual([
      { position: 1, headingPath: 'A § 总结' },
      { position: 5, headingPath: 'B § 总结' },
    ]);
  });

  it('headingQuery 零命中（404）→ isError + failedStep', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        message: 'No section headingPath contains "无此标题"',
      }),
    );

    const result = await readDocTool.handler({ docId: 'd1', headingQuery: '无此标题' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_heading_query');
    expect(body.status).toBe(404);
  });
});
