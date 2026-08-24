/**
 * move_doc 单元测试
 *
 * 覆盖：双通道定位（spaceName+fromPath / docId）、缺参数校验、resolve 失败、
 * fromPath 定位失败、body 直透（toPath/expectedContentHash/dryRun 可选字段）、
 * move HTTP 失败、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { moveDocTool } from './move-doc';
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

describe('move_doc', () => {
  it('description 契约回归（v1.61.0）：声明 outboundPathLinksToRewrite 字段语义', () => {
    const desc = moveDocTool.tool.description;
    expect(desc).toContain('outboundPathLinksToRewrite');
    expect(desc).toContain('oldResolvedTarget');
    expect(desc).toContain('targetExists');
  });

  it('happy path（spaceName + fromPath 双通道定位 + toPath）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      docId: 'd1',
      oldPath: 'docs/old.md',
      newPath: 'docs/new.md',
      contentHash: 'h',
      moved: true,
      impact: { inboundLinks: [], docRoutes: [], taskLinks: [], pathBasedLinksToRewrite: [] },
    });

    const result = await moveDocTool.handler(
      { spaceName: 'My Docs', fromPath: 'docs/old.md', toPath: 'docs/new.md' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.moved).toBe(true);
    expect(body.oldPath).toBe('docs/old.md');
    expect(body.newPath).toBe('docs/new.md');

    // 验证 POST /docs/:id/move 调用与 body 直透
    const moveCall = request.mock.calls[2];
    expect(moveCall[0]).toBe('POST');
    expect(moveCall[1]).toContain('/docs/d1/move');
    expect(moveCall[2]).toMatchObject({ body: { toPath: 'docs/new.md' } });
  });

  it('happy path（docId 直接定位，不调 list spaces）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd2',
      oldPath: 'docs/x.md',
      newPath: 'docs/y.md',
      contentHash: 'h',
      moved: true,
      impact: { inboundLinks: [], docRoutes: [], taskLinks: [], pathBasedLinksToRewrite: [] },
    });

    const result = await moveDocTool.handler({ docId: 'd2', toPath: 'docs/y.md' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).newPath).toBe('docs/y.md');
    expect(request.mock.calls.length).toBe(1);
    expect(request.mock.calls[0][2]).toMatchObject({ body: { toPath: 'docs/y.md' } });
  });

  it('dryRun + expectedContentHash 可选字段透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd3',
      oldPath: 'a.md',
      newPath: 'b.md',
      moved: false,
      wouldMove: true,
      // v1.62.0：dryRun 响应带同源 contentHash = revision 获取 + preflight 合一
      contentHash: 'hash-d3',
      impact: {
        contentHash: 'hash-d3',
        inboundLinks: [],
        docRoutes: [],
        taskLinks: [],
        pathBasedLinksToRewrite: [],
      },
    });

    const result = await moveDocTool.handler(
      {
        docId: 'd3',
        toPath: 'b.md',
        expectedContentHash: 'abc123',
        dryRun: true,
      },
      ctx(),
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.wouldMove).toBe(true);
    // dryRun 响应透出 contentHash（正式 move 时用同一 token 做 expectedContentHash）
    expect(body.contentHash).toBe('hash-d3');
    expect(request.mock.calls[0][2]).toMatchObject({
      body: { toPath: 'b.md', expectedContentHash: 'abc123', dryRun: true },
    });
  });

  it('缺少定位参数 → isError', async () => {
    const result = await moveDocTool.handler({ toPath: 'docs/x.md' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Either docId or (spaceName + fromPath)');
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await moveDocTool.handler(
      { spaceName: 'Ghost', fromPath: 'x.md', toPath: 'y.md' },
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

    const result = await moveDocTool.handler(
      { spaceName: 'Project', fromPath: 'x.md', toPath: 'y.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('fromPath 定位失败（文档不存在）→ isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await moveDocTool.handler(
      { spaceName: 'My Docs', fromPath: 'nonexistent.md', toPath: 'y.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Document not found');
  });

  it('move HTTP 失败 → isError（409 冲突结构化透传）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        message: 'Target path is already taken by another document',
        code: 'RESOURCE_CONFLICT',
      }),
    );

    const result = await moveDocTool.handler(
      { spaceName: 'My Docs', fromPath: 'docs/old.md', toPath: 'docs/taken.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('move_doc');
    expect(body.status).toBe(409);
    expect(body.code).toBe('RESOURCE_CONFLICT');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd3',
      oldPath: 'a.md',
      newPath: 'b.md',
      moved: true,
      impact: { inboundLinks: [], docRoutes: [], taskLinks: [], pathBasedLinksToRewrite: [] },
    });

    const result = await moveDocTool.handler({ docId: 'd3', toPath: 'b.md' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
