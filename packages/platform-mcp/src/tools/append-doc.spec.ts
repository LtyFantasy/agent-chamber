/**
 * append_doc 单元测试（v1.65.0 消费者反馈批 7601e2f5）
 *
 * 覆盖：happy path（space 解析 → doc 定位 → POST 透传）、under-heading 参数组合、
 * 缺 headingPath 前置拦截、0 候选/多候选 space 解析失败、doc 未找到、上游错误透传
 * （404/409）、list_doc_spaces 失败、clientRequestId 透传。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { appendDocTool } from './append-doc';
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

describe('append_doc', () => {
  it('happy path：space 三层匹配 → path 定位 docId → POST /docs/:id/append（body 只带 content）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockResolvedValueOnce({
      id: 'doc-1',
      path: 'docs/api.md',
      sectionCount: 6,
      tokenEstimate: 1200,
      contentHash: 'new-hash',
    });

    const result = await appendDocTool.handler(
      { spaceName: 'My Docs', path: 'docs/api.md', content: '追加内容' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.sectionCount).toBe(6);
    expect(body.contentHash).toBe('new-hash');

    // 定位请求：path 精确匹配
    const locateCall = request.mock.calls[1];
    expect(locateCall[0]).toBe('GET');
    expect(locateCall[1]).toContain('sp-1/docs');
    expect(locateCall[2].params).toEqual({ path: 'docs/api.md', pageSize: 1 });

    // 写请求：POST /docs/:docId/append，body 仅 content（position 缺省 = 服务端 'end'）
    const appendCall = request.mock.calls[2];
    expect(appendCall[0]).toBe('POST');
    expect(appendCall[1]).toBe('/docs/doc-1/append');
    expect(appendCall[2].body).toEqual({ content: '追加内容' });
  });

  it('under-heading 模式：position + headingPath + clientRequestId 透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockResolvedValueOnce({
      id: 'doc-1',
      path: 'a.md',
      sectionCount: 3,
      tokenEstimate: 100,
    });

    const result = await appendDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'a.md',
        content: '新内容',
        position: 'under-heading',
        headingPath: 'Test § 目标节',
        clientRequestId: 'key-1',
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const appendCall = request.mock.calls[2];
    expect(appendCall[1]).toBe('/docs/doc-1/append');
    expect(appendCall[2].body).toEqual({
      content: '新内容',
      position: 'under-heading',
      headingPath: 'Test § 目标节',
      clientRequestId: 'key-1',
    });
  });

  it('under-heading 缺 headingPath → isError 前置拦截，不发请求', async () => {
    const request = mockRequest();

    const result = await appendDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', content: 'x', position: 'under-heading' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toContain('headingPath');
    expect(request).not.toHaveBeenCalled();
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }],
    });

    const result = await appendDocTool.handler(
      { spaceName: 'Ghost', path: 'a.md', content: 'x' },
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

    const result = await appendDocTool.handler(
      { spaceName: 'Docs', path: 'a.md', content: 'x' },
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

    const result = await appendDocTool.handler(
      { spaceName: 'My Docs', path: 'ghost.md', content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('locate_doc');
    expect(body.message).toContain('ghost.md');
  });

  it('上游 404（headingPath 0 命中）结构化透传（铁律 #9 不包装）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        code: 10001,
        message: 'headingPath "不存在的节" not found in document; available headingPaths: Test § A',
      }),
    );

    const result = await appendDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'a.md',
        content: 'x',
        position: 'under-heading',
        headingPath: '不存在的节',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('append_doc');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10001);
    expect(body.message).toContain('not found');
  });

  it('上游 409（headingPath 多命中）结构化透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }] });
    request.mockResolvedValueOnce({ items: [{ id: 'doc-1' }] });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 409, code: 9001, message: 'headingPath matches 2 sections' }),
    );

    const result = await appendDocTool.handler(
      {
        spaceName: 'My Docs',
        path: 'a.md',
        content: 'x',
        position: 'under-heading',
        headingPath: 'Test § 同名节',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(409);
    expect(body.code).toBe(9001);
  });

  it('list_doc_spaces 失败 → isError list_doc_spaces', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await appendDocTool.handler(
      { spaceName: 'My Docs', path: 'a.md', content: 'x' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).failedStep).toBe('list_doc_spaces');
  });
});
