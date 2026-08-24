/**
 * get_doc_move_impact 单元测试
 *
 * 覆盖：双通道定位（spaceName+path / docId）、proposedPath 透传、缺参数校验、
 * resolve 失败、path 定位失败、impact 查询 HTTP 失败、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { getDocMoveImpactTool } from './get-doc-move-impact';
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

/** 完整 impact 响应骨架（与后端 DocMoveImpact 同形） */
function impactBody(overrides: Record<string, unknown> = {}) {
  return {
    docId: 'd1',
    path: 'docs/a.md',
    contentHash: 'hash-impact', // v1.62.0：root 透传乐观锁 token
    inboundLinks: [],
    docRoutes: [],
    taskLinks: [],
    pathBasedLinksToRewrite: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('get_doc_move_impact', () => {
  it('description 契约回归（v1.61.0）：声明 outboundPathLinksToRewrite 字段语义', () => {
    const desc = getDocMoveImpactTool.tool.description;
    expect(desc).toContain('outboundPathLinksToRewrite');
    expect(desc).toContain('oldResolvedTarget');
    expect(desc).toContain('oldTargetExists');
  });

  it('happy path（spaceName + path 双通道 + proposedPath 透传为 query 参数）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce(
      impactBody({
        proposedPath: 'docs/b.md',
        inboundLinks: [
          {
            sourceDocId: 's1',
            sourcePath: 'docs/source.md',
            href: 'docs/a.md',
            isPathBased: true,
            sectionPosition: 2,
            headingPath: 'Src § 引用段',
          },
        ],
        pathBasedLinksToRewrite: [
          {
            sourceDocId: 's1',
            sourcePath: 'docs/source.md',
            href: 'docs/a.md',
            isPathBased: true,
          },
        ],
      }),
    );

    const result = await getDocMoveImpactTool.handler(
      { spaceName: 'My Docs', path: 'docs/a.md', proposedPath: 'docs/b.md' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    // v1.62.0：impact root 透传 contentHash（乐观锁 token）
    expect(body.contentHash).toBe('hash-impact');
    expect(body.inboundLinks).toHaveLength(1);
    expect(body.inboundLinks[0]).toMatchObject({
      href: 'docs/a.md',
      isPathBased: true,
      sectionPosition: 2,
    });
    expect(body.pathBasedLinksToRewrite).toHaveLength(1);

    // 验证 GET /docs/:id/move-impact 调用 + proposedPath query 透传
    const impactCall = request.mock.calls[2];
    expect(impactCall[0]).toBe('GET');
    expect(impactCall[1]).toContain('/docs/d1/move-impact');
    expect(impactCall[2]).toMatchObject({ params: { proposedPath: 'docs/b.md' } });
  });

  it('happy path（docId 直接定位，无 proposedPath 时不带 query）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(impactBody({ docId: 'd2' }));

    const result = await getDocMoveImpactTool.handler({ docId: 'd2' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).docId).toBe('d2');
    expect(request.mock.calls.length).toBe(1);
    expect(request.mock.calls[0][2]).toMatchObject({ params: {} });
  });

  it('缺少定位参数 → isError', async () => {
    const result = await getDocMoveImpactTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Either docId or (spaceName + path)');
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await getDocMoveImpactTool.handler({ spaceName: 'Ghost', path: 'x.md' }, ctx());

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

    const result = await getDocMoveImpactTool.handler(
      { spaceName: 'Project', path: 'x.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('path 定位失败（文档不存在）→ isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await getDocMoveImpactTool.handler(
      { spaceName: 'My Docs', path: 'nonexistent.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Document not found');
  });

  it('impact 查询 HTTP 失败 → isError（404 结构化透传）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Document not found', code: 'DOC_NOT_FOUND' }),
    );

    const result = await getDocMoveImpactTool.handler(
      { spaceName: 'My Docs', path: 'docs/a.md' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('get_doc_move_impact');
    expect(body.status).toBe(404);
    expect(body.code).toBe('DOC_NOT_FOUND');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(impactBody());

    const result = await getDocMoveImpactTool.handler({ docId: 'd3' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
