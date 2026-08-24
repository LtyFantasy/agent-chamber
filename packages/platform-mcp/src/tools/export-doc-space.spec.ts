/**
 * export_doc_space 单元测试（任务 T6：空间级全量导出/回导）
 *
 * 覆盖：spaceName 三层匹配（happy / 0 候选 / >1 候选）、导出端点透传
 * （bundle 原样返回）、HTTP 失败透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { exportDocSpaceTool } from './export-doc-space';
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

describe('export_doc_space', () => {
  it('happy path：解析 spaceName 后调用导出端点，bundle 原样透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    const bundle = {
      formatVersion: 1,
      exportedAt: '2026-08-16T00:00:00.000Z',
      space: { name: 'My Docs', description: '图例', visibility: 'open', settings: {} },
      categories: [],
      routes: [],
      // v1.62.0：docs[] item 增 docId + contentHash（contentHash = 原始写入 payload 的
      // SHA-256，权威 revision 标识——content 是重建产物，其 SHA-256 ≠ contentHash）
      docs: [
        {
          docId: 'd1',
          path: 'docs/a.md',
          title: 'A',
          summary: 'S',
          docType: 'guide',
          tags: [],
          category: null,
          content: '# A',
          contentHash: 'hash-a',
        },
      ],
    };
    request.mockResolvedValueOnce(bundle);

    const result = await exportDocSpaceTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.formatVersion).toBe(1);
    expect(body.docs).toHaveLength(1);
    expect(body.docs[0].docId).toBe('d1');
    expect(body.docs[0].contentHash).toBe('hash-a');

    const getCall = request.mock.calls[1];
    expect(getCall[0]).toBe('GET');
    expect(getCall[1]).toBe('/doc-spaces/sp-1/export');
  });

  it('0 候选 → isError + availableNames，绝不静默挑选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [{ id: 'sp-1', name: 'Other', slug: 'other' }] });

    const result = await exportDocSpaceTool.handler({ spaceName: 'NoSuch' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.availableNames).toEqual(['Other']);
    expect(body.isAmbiguous).toBe(false);
    expect(request.mock.calls).toHaveLength(1); // 未继续调用导出端点
  });

  it('>1 候选 → isError + candidates（含匹配层），绝不静默挑选', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [
        { id: 'sp-1', name: 'My Docs Alpha', slug: 'my-docs-alpha' },
        { id: 'sp-2', name: 'My Docs Beta', slug: 'my-docs-beta' },
      ],
    });

    const result = await exportDocSpaceTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.isAmbiguous).toBe(true);
    expect(body.candidates).toHaveLength(2);
    expect(body.layer).toBe('prefix');
    expect(request.mock.calls).toHaveLength(1);
  });

  it('HTTP 失败（403 等）→ isError 透传 status/code，不包装', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 403,
        code: 1009,
        message: 'Permission denied',
        details: { path: '/doc-spaces/sp-1/export' },
      }),
    );

    const result = await exportDocSpaceTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(403);
    expect(body.code).toBe(1009);
    expect(body.failedStep).toBe('export_doc_space');
  });

  it('列表获取失败 → isError（failedStep=list_doc_spaces）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new Error('network down'));

    const result = await exportDocSpaceTool.handler({ spaceName: 'My Docs' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_spaces');
  });
});
