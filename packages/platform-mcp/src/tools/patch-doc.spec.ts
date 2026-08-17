/**
 * patch_doc 单元测试（v1.55 任务 T3）
 *
 * 覆盖：happy path（space 解析 → doc 定位 → PATCH 透传）、非法 position 前置拦截、
 * 0 候选/多候选 space 解析失败、doc 未找到、上游错误透传（404/409）、list_doc_spaces 失败。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { patchDocTool } from './patch-doc';
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

describe('patch_doc', () => {
  it('happy path：space 三层匹配 → path 定位 docId → PATCH section（body 只带 content）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockResolvedValueOnce({
      id: 'doc-1',
      path: 'docs/api.md',
      sectionCount: 5,
      tokenEstimate: 900,
    });

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/api.md', position: 2, content: '## 节\n\n新正文' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.sectionCount).toBe(5);

    // 定位请求：path 精确匹配
    const locateCall = request.mock.calls[1];
    expect(locateCall[0]).toBe('GET');
    expect(locateCall[1]).toContain('sp-1/docs');
    expect(locateCall[2].params).toEqual({ path: 'docs/api.md', pageSize: 1 });

    // 写请求：PATCH /docs/:docId/sections/:position，body 仅 content
    const patchCall = request.mock.calls[2];
    expect(patchCall[0]).toBe('PATCH');
    expect(patchCall[1]).toBe('/docs/doc-1/sections/2');
    expect(patchCall[2].body).toEqual({ content: '## 节\n\n新正文' });
  });

  it('非法 position（负数/非整数）→ isError 前置拦截，不发请求', async () => {
    const request = mockRequest();

    for (const position of [-1, 1.5]) {
      const result = await patchDocTool.handler(
        { spaceName: 'My Docs', path: 'a.md', position, content: 'x' },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).message).toContain('non-negative integer');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await patchDocTool.handler(
      { spaceName: 'Ghost', path: 'a.md', position: 0, content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Alpha']);
  });

  it('>1 候选 → isError + candidates（绝不静默挑选）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Docs A', slug: 'docs-a' },
        { id: 'sp-2', name: 'Docs B', slug: 'docs-b' },
      ],
    });

    const result = await patchDocTool.handler(
      { spaceName: 'Docs', path: 'a.md', position: 0, content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.isAmbiguous).toBe(true);
    expect(body.candidates).toHaveLength(2);
  });

  it('path 未找到文档 → isError locate_doc', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'ghost.md', position: 0, content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('locate_doc');
    expect(body.message).toContain('ghost.md');
  });

  it('上游 404（position 越界）结构化透传（铁律 #9 不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        code: 10001,
        message: 'Section position 99 out of range (document has 3 sections, valid range 0-2)',
      }),
    );

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', position: 99, content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('patch_doc');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10001);
    expect(body.message).toContain('out of range');
  });

  it('上游 409 DOC_SOURCE_MISMATCH 结构化透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 409, code: 10003, message: 'source conflict' }),
    );

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', position: 0, content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(409);
    expect(body.code).toBe(10003);
  });

  it('list_doc_spaces 失败 → isError list_doc_spaces', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', position: 0, content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).failedStep).toBe('list_doc_spaces');
  });

  // ─── fail-closed 改造：双模式（section / match）+ expectedSectionHash ───

  it('section 模式 + expectedSectionHash → body 透传（fail-closed 前提校验）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockResolvedValueOnce({
      id: 'doc-1',
      path: 'a.md',
      sectionCount: 3,
      tokenEstimate: 100,
    });

    const result = await patchDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'a.md',
        position: 1,
        content: '## 节\n\n新正文',
        expectedSectionHash: 'abc123',
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const patchCall = request.mock.calls[2];
    expect(patchCall[1]).toBe('/docs/doc-1/sections/1');
    expect(patchCall[2].body).toEqual({
      content: '## 节\n\n新正文',
      expectedSectionHash: 'abc123',
    });
  });

  it('match 模式 happy → PATCH /docs/:id/content（body 只带 oldString/newString）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockResolvedValueOnce({
      id: 'doc-1',
      path: 'a.md',
      sectionCount: 2,
      tokenEstimate: 50,
    });

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', oldString: '旧文本', newString: '新文本' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const patchCall = request.mock.calls[2];
    expect(patchCall[0]).toBe('PATCH');
    expect(patchCall[1]).toBe('/docs/doc-1/content');
    expect(patchCall[2].body).toEqual({ oldString: '旧文本', newString: '新文本' });
  });

  it('双模式混传 → isError 前置拦截（不发请求）', async () => {
    const request = mockRequest();

    const result = await patchDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'a.md',
        position: 0,
        content: 'x',
        oldString: 'a',
        newString: 'b',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('mutually exclusive');
    expect(request).not.toHaveBeenCalled();
  });

  it('模式缺件（position 缺 content / oldString 缺 newString / 全无）→ isError（不发请求）', async () => {
    const request = mockRequest();

    for (const args of [
      { spaceName: 'My Docs', path: 'a.md', position: 0 },
      { spaceName: 'My Docs', path: 'a.md', content: 'x' },
      { spaceName: 'My Docs', path: 'a.md', oldString: 'a' },
      { spaceName: 'My Docs', path: 'a.md', newString: 'b' },
      { spaceName: 'My Docs', path: 'a.md' },
    ]) {
      const result = await patchDocTool.handler(args, ctx());
      expect(result.isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('expectedSectionHash 误用于 match 模式 → isError（不发请求）', async () => {
    const request = mockRequest();

    const result = await patchDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'a.md',
        oldString: 'a',
        newString: 'b',
        expectedSectionHash: 'h',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('section mode');
    expect(request).not.toHaveBeenCalled();
  });

  it('match 模式上游 409 多命中（matchCount）结构化透传（铁律 #9 不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 409, code: 9001, message: 'oldString matches 3 locations' }),
    );

    const result = await patchDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', oldString: 'a', newString: 'b' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(409);
    expect(body.code).toBe(9001);
  });
});
