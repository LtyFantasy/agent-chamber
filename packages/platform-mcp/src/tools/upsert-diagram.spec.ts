/**
 * upsert_diagram 单元测试
 *
 * 覆盖：happy path（ir 对象直传 body）、ir 非对象快速失败、spaceName 解析失败/歧义、
 * 可选参数透传、422 diagnostics 透传（details 键下原样可读，R5 回归）、409 透传、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { upsertDiagramTool } from './upsert-diagram';
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

describe('upsert_diagram', () => {
  it('happy path：ir 对象直传 body（不 stringify），返回写结果', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'diagrams/web-app.json',
      diagramType: 'architecture',
      sectionCount: 1,
      tokenEstimate: 1200,
      contentHash: 'hash-1',
      render: {
        qualityProfile: 'standard',
        composition: { errors: 0, warnings: 2 },
        htmlBytes: 2048,
        htmlSha256: 'sha-1',
        renderedAt: '2026-08-30T00:00:00.000Z',
      },
    });

    const ir = { schema_version: 1, diagram_type: 'architecture', meta: { title: 'Web App' } };
    const result = await upsertDiagramTool.handler(
      { spaceName: 'My Docs', path: 'diagrams/web-app.json', ir },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe('d1');
    expect(body.diagramType).toBe('architecture');
    expect(body.render.qualityProfile).toBe('standard');

    // ir 对象直传 body（JSON 序列化保持对象形态，工具不解串/重编）
    const putCall = request.mock.calls[1];
    expect(putCall[0]).toBe('PUT');
    expect(putCall[1]).toBe('/doc-spaces/sp-1/diagrams');
    expect(putCall[2].body.path).toBe('diagrams/web-app.json');
    expect(putCall[2].body.ir).toEqual(ir);
  });

  it('ir 非对象（数组/字符串/空）→ 工具侧快速失败，不发 HTTP', async () => {
    const request = mockRequest();

    for (const bad of [[], '{"a":1}', null, 42]) {
      const result = await upsertDiagramTool.handler(
        { spaceName: 'My Docs', path: 'x.json', ir: bad },
        ctx(),
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.message).toContain('ir must be a JSON object');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('可选参数透传（title/summary/category/tags/expectedContentHash/clientRequestId）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ id: 'd1', path: 'x.json', diagramType: 'workflow' });

    await upsertDiagramTool.handler(
      {
        spaceName: 'My Docs',
        path: 'x.json',
        ir: { diagram_type: 'workflow' },
        title: 'Order Flow',
        summary: 'A flow',
        category: 'diagrams',
        tags: ['flow', 'orders'],
        expectedContentHash: 'base-hash',
        clientRequestId: 'upsert-diagram-001',
      },
      ctx(),
    );

    const putCall = request.mock.calls[1];
    expect(putCall[2].body.title).toBe('Order Flow');
    expect(putCall[2].body.summary).toBe('A flow');
    expect(putCall[2].body.category).toBe('diagrams');
    expect(putCall[2].body.tags).toEqual(['flow', 'orders']);
    expect(putCall[2].body.expectedContentHash).toBe('base-hash');
    expect(putCall[2].body.clientRequestId).toBe('upsert-diagram-001');
  });

  it('0 候选 → isError + availableNames', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ items: [] });

    const result = await upsertDiagramTool.handler(
      { spaceName: 'Ghost', path: 'x.json', ir: { diagram_type: 'architecture' } },
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

    const result = await upsertDiagramTool.handler(
      { spaceName: 'Project', path: 'x.json', ir: { diagram_type: 'architecture' } },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('resolve_space');
    expect(body.candidates.length).toBe(2);
  });

  it('422 diagnostics 在工具结果 details 键下原样可读（R5 回归：MCP 层键名是 details 不是 data）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 422,
        message: 'Diagram validation failed',
        code: 10010,
        details: {
          stage: 'geometry',
          diagnostics: [
            {
              code: 'geometry/overlap',
              severity: 'error',
              message: 'nodes overlap',
              subject: { diagramType: 'architecture', path: '/components/1', identity: 'b' },
              supportedFixes: ['move node b below a with a 4-cell gap'],
            },
          ],
        },
      }),
    );

    const result = await upsertDiagramTool.handler(
      { spaceName: 'My Docs', path: 'x.json', ir: { diagram_type: 'architecture' } },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.code).toBe(10010);
    // R5：LLM 实际可读的键是 details（不是 data），diagnostics 在其下原样透传
    expect(body.details).toBeDefined();
    expect(body.details.stage).toBe('geometry');
    expect(body.details.diagnostics[0].code).toBe('geometry/overlap');
    expect(body.details.diagnostics[0].subject.identity).toBe('b');
    expect(body.details.diagnostics[0].supportedFixes[0]).toContain('move');
  });

  it('409 DOC_CONTENT_CONFLICT 透传 → isError', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        message: 'Content hash mismatch',
        code: 10009,
      }),
    );

    const result = await upsertDiagramTool.handler(
      { spaceName: 'My Docs', path: 'x.json', ir: { diagram_type: 'architecture' } },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.failedStep).toBe('upsert_diagram');
    expect(body.status).toBe(409);
    expect(body.code).toBe(10009);
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({ id: 'd1', path: 'x.json', diagramType: 'lifecycle' });

    const result = await upsertDiagramTool.handler(
      { spaceName: 'My Docs', path: 'x.json', ir: { diagram_type: 'lifecycle' } },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
