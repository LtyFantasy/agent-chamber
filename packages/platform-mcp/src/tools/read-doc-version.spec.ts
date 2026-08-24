/**
 * read_doc_version 单元测试（doc history MVP）
 *
 * 覆盖：happy path（全文 + diff 原样透传）、docId 非 UUID / version 非正整数
 * （0 / 负数 / 小数 / 字符串）→ MCP 层拒绝（不发 HTTP）、404/400 透传
 * （status/code 保留，不包装成 500）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { readDocVersionTool } from './read-doc-version';
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

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

/** 后端版本详情样本（与 findVersion 同形：元数据 + content 全文 + diff） */
function versionDetail(version: number, diff: unknown = null) {
  return {
    version,
    contentHash: `sha256-${version}`,
    authorActorId: '123e4567-e89b-12d3-a456-426614174000',
    source: 'patch',
    createdAt: `2026-08-17T0${version}:00:00.000Z`,
    contentSize: 120,
    content: '# Doc\n\nline one\nline two',
    diff,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('read_doc_version', () => {
  it('happy path：返回全文 + diff 原样透传（含 unified diff 文本）', async () => {
    const request = mockRequest();
    const diff = {
      fromVersion: 2,
      added: 1,
      removed: 1,
      unified: '@@ -1,3 +1,3 @@\n line one\n-line two\n+line three',
    };
    request.mockResolvedValueOnce(versionDetail(3, diff));

    const result = await readDocVersionTool.handler({ docId: DOC_ID, version: 3 }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.version).toBe(3);
    expect(body.content).toContain('# Doc');
    expect(body.diff).toEqual(diff);
    expect(body.diff.unified).toContain('-line two');

    const call = request.mock.calls[0];
    expect(call[0]).toBe('GET');
    expect(call[1]).toBe(`/docs/${DOC_ID}/versions/3`);
  });

  it('最早一版 diff=null 原样透传（与有前版但无差异区分）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce(versionDetail(1));

    const result = await readDocVersionTool.handler({ docId: DOC_ID, version: 1 }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.diff).toBeNull();
  });

  it('docId 非 UUID → MCP 层拒绝，不发 HTTP', async () => {
    const request = mockRequest();

    const result = await readDocVersionTool.handler({ docId: 'not-a-uuid', version: 3 }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('UUID');
    expect(request).not.toHaveBeenCalled();
  });

  it('version 非正整数（0 / 负数 / 小数 / 字符串）→ MCP 层拒绝，不发 HTTP', async () => {
    const request = mockRequest();

    for (const bad of [0, -1, 1.5, '3', NaN]) {
      jest.clearAllMocks();
      const result = await readDocVersionTool.handler(
        { docId: DOC_ID, version: bad as number },
        ctx(),
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.message).toContain('positive integer');
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('404 → 透传 status/code（文档或版本不存在），不包装成 500', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 404,
        code: 10001,
        message: 'Document version 99 not found',
      }),
    );

    const result = await readDocVersionTool.handler({ docId: DOC_ID, version: 99 }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_version');
    expect(body.status).toBe(404);
    expect(body.code).toBe(10001);
  });

  it('400 → 透传 status/code（防御性：后端 VALIDATION_ERROR 不被包装成 500）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        code: 9000,
        message: 'version must be a positive integer',
      }),
    );

    const result = await readDocVersionTool.handler({ docId: DOC_ID, version: 3 }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('read_doc_version');
    expect(body.status).toBe(400);
    expect(body.code).toBe(9000);
  });
});
