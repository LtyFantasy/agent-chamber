/**
 * read_diagram 单元测试
 *
 * 覆盖：双通道定位（spaceName+path / docId）、缺参数校验、path 定位失败、
 * 返回解析后 IR 对象 + contentHash + render 元数据、400 指路透传（非 diagram doc）、
 * 409 DIAGRAM_SNAPSHOT_MISSING 透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { readDiagramTool } from './read-diagram';
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

describe('read_diagram', () => {
  it('happy path（spaceName + path 双通道定位）：返回解析后 IR 对象 + contentHash + render 元数据', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd1' }],
    });
    request.mockResolvedValueOnce({
      docId: 'd1',
      path: 'diagrams/web-app.json',
      title: 'Web App',
      docType: 'diagram',
      diagramType: 'architecture',
      ir: { schema_version: 1, diagram_type: 'architecture', components: [{ id: 'a' }] },
      contentHash: 'hash-1',
      render: {
        qualityProfile: 'standard',
        composition: { errors: 0, warnings: 0 },
        htmlBytes: 2048,
        htmlSha256: 'sha-1',
        renderedAt: '2026-08-30T00:00:00.000Z',
      },
      updatedAt: '2026-08-30T00:00:00.000Z',
    });

    const result = await readDiagramTool.handler(
      { spaceName: 'My Docs', path: 'diagrams/web-app.json' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    // 返回解析后 IR 对象（对象形态，非字符串）+ contentHash（乐观锁 token）
    expect(body.ir).toEqual({
      schema_version: 1,
      diagram_type: 'architecture',
      components: [{ id: 'a' }],
    });
    expect(typeof body.ir).toBe('object');
    expect(body.contentHash).toBe('hash-1');
    expect(body.diagramType).toBe('architecture');
    expect(body.render.htmlSha256).toBe('sha-1');

    const getCall = request.mock.calls[2];
    expect(getCall[0]).toBe('GET');
    expect(getCall[1]).toBe('/docs/d1/diagram');
  });

  it('happy path（docId 直接定位，不调 list spaces）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd2',
      path: 'diagrams/x.json',
      title: 'X',
      docType: 'diagram',
      diagramType: 'sequence',
      ir: { diagram_type: 'sequence' },
      contentHash: 'hash-2',
      render: null,
    });

    const result = await readDiagramTool.handler({ docId: 'd2' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).ir.diagram_type).toBe('sequence');
    expect(request.mock.calls.length).toBe(1);
    expect(request.mock.calls[0][1]).toBe('/docs/d2/diagram');
  });

  it('缺参数（无 spaceName+path 也无 docId）→ isError，不发 HTTP', async () => {
    const request = mockRequest();

    const result = await readDiagramTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Either docId or (spaceName + path) must be provided');
    expect(request).not.toHaveBeenCalled();
  });

  it('path 定位失败（文档不存在）→ isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ items: [] });

    const result = await readDiagramTool.handler(
      { spaceName: 'My Docs', path: 'diagrams/ghost.json' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('not found');
  });

  it('非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED 透传（指路 read_doc）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 400,
        message: 'Document is not a diagram — use read_doc instead',
        code: 10012,
        details: { docType: 'note' },
      }),
    );

    const result = await readDiagramTool.handler({ docId: 'd9' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(400);
    expect(body.code).toBe(10012);
    expect(body.details.docType).toBe('note');
    expect(body.message).toContain('read_doc');
  });

  it('409 DIAGRAM_SNAPSHOT_MISSING 透传（存量 diagram 无快照，指路 re-upsert）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        message: 'Legacy diagram without a rendered snapshot — re-upsert to regenerate',
        code: 10013,
      }),
    );

    const result = await readDiagramTool.handler({ docId: 'd10' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(409);
    expect(body.code).toBe(10013);
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      docId: 'd3',
      path: 'diagrams/y.json',
      title: 'Y',
      docType: 'diagram',
      diagramType: 'dataflow',
      ir: { diagram_type: 'dataflow' },
      contentHash: 'hash-3',
      render: null,
    });

    const result = await readDiagramTool.handler({ docId: 'd3' }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
