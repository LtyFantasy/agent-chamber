/**
 * merge_doc_category 单元测试（v1.92.0-dev，DocSpace 元数据治理 3 期）
 *
 * 覆盖：description 的 dryRun 强引导（P3）+ **不杜撰 expectedBatchToken**（merge 不接
 * 该参数，plan D2）、dryRun 信封透传、body 直透（targetId / dryRun / idempotencyKey）、
 * 缺参 → isError、404/422 状态码与分码透传（铁律 #9：不包装）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { mergeDocCategoryTool } from './merge-doc-category';
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

/** dryRun 响应样本（MergeDocCategoryResult） */
function dryRunEnvelope() {
  return {
    dryRun: true,
    batchToken: 'c'.repeat(64),
    source: { id: 'cat-a', slug: 'npc-old', name: 'NPC' },
    target: { id: 'cat-b', slug: 'npc', name: 'npc' },
    affectedDocs: { total: 3, sample: [], truncated: false },
    softRefs: { routesCategoryCount: 2, excludeCategories: true },
    ingestAffected: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('merge_doc_category', () => {
  it('description 含 dryRun 先行强引导，且不杜撰 expectedBatchToken（merge 不接该参数）', () => {
    expect(mergeDocCategoryTool.tool.description).toContain('Always run with dryRun=true first');
    expect(mergeDocCategoryTool.tool.description).toContain('NO alias mechanism');
    expect(mergeDocCategoryTool.tool.description).not.toContain('expectedBatchToken:');
    expect(mergeDocCategoryTool.tool.inputSchema.required).toEqual(['categoryId', 'targetId']);
  });

  it('happy path：dryRun 信封原样返回（含软引用影响面）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(dryRunEnvelope());

    const result = await mergeDocCategoryTool.handler(
      { categoryId: 'cat-a', targetId: 'cat-b', dryRun: true },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.softRefs).toEqual({ routesCategoryCount: 2, excludeCategories: true });
    expect(request.mock.calls[0][0]).toBe('POST');
    expect(request.mock.calls[0][1]).toContain('cat-a/merge');
    expect(request.mock.calls[0][2].body).toEqual({ targetId: 'cat-b', dryRun: true });
  });

  it('execute：body 含 targetId + idempotencyKey（无 dryRun）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ dryRun: false, merged: { fromSlug: 'a', toSlug: 'b' } });

    const result = await mergeDocCategoryTool.handler(
      { categoryId: 'cat-a', targetId: 'cat-b', idempotencyKey: 'k-2' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[0][2].body).toEqual({ targetId: 'cat-b', idempotencyKey: 'k-2' });
  });

  it('缺 categoryId / targetId → isError（不发任何请求）', async () => {
    const request = mockRequest();

    for (const args of [
      {},
      { categoryId: 'cat-a' },
      { targetId: 'cat-b' },
      { categoryId: 1, targetId: 2 },
    ]) {
      const result = await mergeDocCategoryTool.handler(args as Record<string, unknown>, ctx());
      expect(result.isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('404 分类不存在 → 状态码与分码透传', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 404, message: 'Category not found', code: 10002 }),
    );

    const result = await mergeDocCategoryTool.handler(
      { categoryId: 'cat-a', targetId: 'cat-missing' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('merge_doc_category');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10002);
  });

  it('422 target 已软删 / 同源 / 跨空间 → 422 透传（不包装成 500）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({ status: 422, message: 'Target category is soft-deleted', code: 9000 }),
    );

    const result = await mergeDocCategoryTool.handler(
      { categoryId: 'cat-a', targetId: 'cat-dead' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.code).toBe(9000);
  });
});
