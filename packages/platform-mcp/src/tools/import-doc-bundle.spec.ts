/**
 * import_doc_bundle 单元测试（任务 T6：空间级全量导出/回导）
 *
 * 覆盖：bundle 非对象预检、spaceName 三层匹配（happy / 0 候选 / >1 候选）、
 * 回导端点透传（bundle 作 body、overwriteSpaceMeta 显式透传/缺省不带）、
 * HTTP 失败透传。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { importDocBundleTool } from './import-doc-bundle';
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

/** 最小合法 bundle（导出产物同形） */
function makeBundle(): Record<string, unknown> {
  return {
    formatVersion: 1,
    exportedAt: '2026-08-16T00:00:00.000Z',
    space: { name: 'My Docs', description: null, visibility: 'open', settings: {} },
    categories: [],
    routes: [],
    docs: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('import_doc_bundle', () => {
  it('happy path：解析 spaceName 后 bundle 作 body 调用回导端点', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      formatVersion: 1,
      importedAt: '2026-08-16T00:00:00.000Z',
      docs: { results: [], summary: { total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 } },
      categories: { results: [], summary: { total: 0, created: 0, updated: 0, failed: 0 } },
      routes: { results: [], summary: { total: 0, created: 0, updated: 0, failed: 0 } },
      spaceMeta: { applied: false, status: 'skipped' },
    });

    const bundle = makeBundle();
    const result = await importDocBundleTool.handler({ spaceName: 'My Docs', bundle }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.spaceMeta.status).toBe('skipped');

    const postCall = request.mock.calls[1];
    expect(postCall[0]).toBe('POST');
    expect(postCall[1]).toBe('/doc-spaces/sp-1/import-bundle');
    // bundle 原样透传（不包 envelope）
    expect(postCall[2].body).toEqual(bundle);
    // 缺省不带 overwriteSpaceMeta 参数（服务端默认 false）
    expect(postCall[2].params).toEqual({});
  });

  it('overwriteSpaceMeta=true 显式透传为查询参数', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      formatVersion: 1,
      importedAt: 'x',
      docs: {},
      categories: {},
      routes: {},
      spaceMeta: { applied: true, status: 'updated' },
    });

    await importDocBundleTool.handler(
      { spaceName: 'My Docs', bundle: makeBundle(), overwriteSpaceMeta: true },
      ctx(),
    );

    const postCall = request.mock.calls[1];
    expect(postCall[2].params).toEqual({ overwriteSpaceMeta: 'true' });
  });

  it('bundle 非对象 → isError 预检，不发请求', async () => {
    const request = mockRequest();

    const result = await importDocBundleTool.handler(
      { spaceName: 'My Docs', bundle: 'not-an-object' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('validate_bundle');
    expect(request).not.toHaveBeenCalled();
  });

  it('0 候选 → isError + availableNames，绝不静默挑选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Other', slug: 'other' }] });

    const result = await importDocBundleTool.handler(
      { spaceName: 'NoSuch', bundle: makeBundle() },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Other']);
    expect(request.mock.calls).toHaveLength(1);
  });

  it('>1 候选 → isError + candidates，绝不静默挑选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'My Docs Alpha', slug: 'my-docs-alpha' },
        { id: 'sp-2', name: 'My Docs Beta', slug: 'my-docs-beta' },
      ],
    });

    const result = await importDocBundleTool.handler(
      { spaceName: 'My Docs', bundle: makeBundle() },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.isAmbiguous).toBe(true);
    expect(request.mock.calls).toHaveLength(1);
  });

  it('HTTP 失败（400 formatVersion）→ isError 透传 status/code，不包装', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        code: 9000,
        message: 'Unsupported bundle formatVersion 99',
        details: { path: '/doc-spaces/sp-1/import-bundle' },
      }),
    );

    const result = await importDocBundleTool.handler(
      { spaceName: 'My Docs', bundle: makeBundle() },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(400);
    expect(body.code).toBe(9000);
    expect(body.failedStep).toBe('import_doc_bundle');
  });
});
