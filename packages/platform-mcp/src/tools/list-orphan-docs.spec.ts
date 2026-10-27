/**
 * list_orphan_docs 单元测试（v1.92.0-dev，DocSpace 元数据治理 3 期）
 *
 * 覆盖：happy path（spaceName 解析 → orphan 信封原样透传）、spaceId 直传（跳过列表拉取）、
 * query 直透（includeExcluded / pathPrefix / page / pageSize）、0/>1 候选 → 结构化信封、
 * 缺参 → isError、HTTP 失败透传（铁律 #9）。响应**原样透传**（含 stats/appliedFilters）
 * 是本工具的契约，spec 显式钉住不补默认值。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { listOrphanDocsTool } from './list-orphan-docs';
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

/** orphan 响应样本（OrphanDocsResponse） */
function orphanEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      {
        id: 'd1',
        path: 'world/npc/x.md',
        title: 'NPC X',
        docType: 'lore',
        categorySlug: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    total: 190,
    page: 1,
    pageSize: 20,
    appliedFilters: { excludeTypes: ['memory'], pathPrefix: 'world/' },
    stats: {
      totalDocs: 500,
      routedDocs: 310,
      orphanDocs: 190,
      excludedOrphanDocs: 0,
      byTopDir: [{ dir: 'world', count: 190 }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('list_orphan_docs', () => {
  it('happy path：spaceName 解析 → orphan 信封原样透传（stats/byTopDir 不丢）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Wayward', slug: 'wayward' }] });
    request.mockResolvedValueOnce(orphanEnvelope());

    const result = await listOrphanDocsTool.handler({ spaceName: 'Wayward' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.total).toBe(190);
    expect(body.stats.byTopDir).toEqual([{ dir: 'world', count: 190 }]);
    expect(body.appliedFilters.excludeTypes).toEqual(['memory']);

    const call = request.mock.calls[1];
    expect(call[0]).toBe('GET');
    expect(call[1]).toContain('sp-1/docs/orphans');
  });

  it('spaceId 直传 + query 直透：跳过列表拉取，params 逐项透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(orphanEnvelope());

    const result = await listOrphanDocsTool.handler(
      { spaceId: 'sp-direct', includeExcluded: true, pathPrefix: 'world/', page: 2, pageSize: 50 },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toContain('sp-direct/docs/orphans');
    expect(request.mock.calls[0][2].params).toEqual({
      includeExcluded: true,
      pathPrefix: 'world/',
      page: 2,
      pageSize: 50,
    });
  });

  it('无过滤参数：params 为空对象（不杜撰默认值）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(orphanEnvelope());

    await listOrphanDocsTool.handler({ spaceId: 'sp-1' }, ctx());

    expect(request.mock.calls[0][2].params).toEqual({});
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Alpha', slug: 'alpha' }] });

    const result = await listOrphanDocsTool.handler({ spaceName: 'Ghost' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Alpha']);
  });

  it('>1 候选 → isError + candidates（绝不静默挑选）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'Project A', slug: 'project-a' },
        { id: 'sp-2', name: 'Project B', slug: 'project-b' },
      ],
    });

    const result = await listOrphanDocsTool.handler({ spaceName: 'Project' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.candidates).toHaveLength(2);
    expect(body.isAmbiguous).toBe(true);
  });

  it('spaceName 与 spaceId 均缺失 → isError（不发任何请求）', async () => {
    const request = mockRequest();

    const result = await listOrphanDocsTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('list_doc_spaces / list_orphan_docs HTTP 失败 → 状态码透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));
    let result = await listOrphanDocsTool.handler({ spaceName: 'My Docs' }, ctx());
    expect(JSON.parse(result.content[0].text).failedStep).toBe('list_doc_spaces');

    const request2 = mockRequest();
    request2.mockRejectedValueOnce(new PlatformApiError({ status: 404, message: 'not found' }));
    result = await listOrphanDocsTool.handler({ spaceId: 'sp-1' }, ctx());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_orphan_docs');
    expect(body.status).toBe(404);
  });
});
