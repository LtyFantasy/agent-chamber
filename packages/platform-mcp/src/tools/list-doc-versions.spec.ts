/**
 * list_doc_versions 单元测试（doc history MVP）
 *
 * 覆盖：happy path（元数据数组 + docId 回显）、docId 缺失/非 UUID → MCP 层拒绝
 * （不发 HTTP）、404 透传（status/code 保留，不包装成 500）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { listDocVersionsTool } from './list-doc-versions';
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

/** 后端版本元数据样本（version DESC，与 findVersions 同形） */
function versionSummary(version: number, overrides: Record<string, unknown> = {}) {
  return {
    version,
    contentHash: `sha256-${version}`,
    authorActorId: '123e4567-e89b-12d3-a456-426614174000',
    source: 'upsert',
    createdAt: `2026-08-17T0${version}:00:00.000Z`,
    contentSize: 1000 + version,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('list_doc_versions', () => {
  it('happy path：返回 docId 回显 + 版本元数据数组（version DESC）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce([
      versionSummary(3, { source: 'patch' }),
      versionSummary(2),
      versionSummary(1, { source: 'import', authorActorId: 'system-uuid' }),
    ]);

    const result = await listDocVersionsTool.handler(
      { docId: '123e4567-e89b-12d3-a456-426614174000' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.docId).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(body.versions).toHaveLength(3);
    // 后端点名排序（响应体来自后端，工具不重排；断言版本号保持原样透传）
    expect(body.versions[0].version).toBe(3);
    expect(body.versions[0].source).toBe('patch');
    expect(body.versions[2].source).toBe('import');
    expect(body.versions[2].content).toBeUndefined(); // 列表不含全文大字段

    const call = request.mock.calls[0];
    expect(call[0]).toBe('GET');
    expect(call[1]).toBe('/docs/123e4567-e89b-12d3-a456-426614174000/versions');
  });

  it('docId 缺失 → isError + message，不发 HTTP', async () => {
    const request = mockRequest();

    const result = await listDocVersionsTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('UUID');
    expect(request).not.toHaveBeenCalled();
  });

  it('docId 非 UUID（合法字符串但格式错）→ MCP 层拒绝，不发 HTTP', async () => {
    const request = mockRequest();

    for (const bad of ['not-a-uuid', '123e4567e89b12d3a456426614174000', '']) {
      jest.clearAllMocks();
      const result = await listDocVersionsTool.handler({ docId: bad }, ctx());
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.message).toContain('UUID');
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('404 → 透传 status/code（文档不存在/无权限私密空间），不包装成 500', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        code: 10001,
        message: 'Document not found',
      }),
    );

    const result = await listDocVersionsTool.handler(
      { docId: '123e4567-e89b-12d3-a456-426614174000' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_versions');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10001);
  });

  it('上游 500 → 透传 status，不吞错误', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(new PlatformApiError({ status: 500, message: 'boom' }));

    const result = await listDocVersionsTool.handler(
      { docId: '123e4567-e89b-12d3-a456-426614174000' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('list_doc_versions');
    expect(body.status).toBe(500);
  });
});
