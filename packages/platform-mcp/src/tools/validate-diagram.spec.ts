/**
 * validate_diagram 单元测试
 *
 * 覆盖：三通道（ir / path+spaceName / docId，docId 可缺省 spaceName 反查空间）、
 * 互斥快速失败（ir vs path/docId/patches、path vs docId、三选一）、patches 形状校验、
 * 422 diagnostics 透传（details 键）、dry-run 零写端点断言（只发 POST validate）。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { validateDiagramTool } from './validate-diagram';
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

const OK_IR = { schema_version: 1, diagram_type: 'architecture', components: [{ id: 'a' }] };

describe('validate_diagram', () => {
  it('模式 (a) 裸 ir：spaceName 解析 + POST validate {ir}，ok=false 诊断透传', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      ok: false,
      stage: 'geometry',
      diagnostics: [
        {
          code: 'geometry/overlap',
          severity: 'error',
          message: 'nodes overlap',
          subject: { diagramType: 'architecture', path: '/components/1' },
          supportedFixes: ['move b below a'],
        },
      ],
      checks: [{ name: 'node-overlap', ok: false, details: ['overlap between a and b'] }],
      composition: { errors: 1, warnings: 0 },
      profile: 'standard',
    });

    const result = await validateDiagramTool.handler({ spaceName: 'My Docs', ir: OK_IR }, ctx());

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.stage).toBe('geometry');
    expect(body.diagnostics[0].supportedFixes[0]).toContain('move');

    const postCall = request.mock.calls[1];
    expect(postCall[0]).toBe('POST');
    expect(postCall[1]).toBe('/doc-spaces/sp-1/diagrams/validate');
    expect(postCall[2].body.ir).toEqual(OK_IR);
    expect(postCall[2].body).not.toHaveProperty('path');
    expect(postCall[2].body).not.toHaveProperty('docId');
  });

  it('模式 (a) 裸 ir + patches → 工具侧快速失败（互斥，不发 HTTP）', async () => {
    const request = mockRequest();

    const result = await validateDiagramTool.handler(
      {
        spaceName: 'My Docs',
        ir: OK_IR,
        patches: [{ op: 'replace', path: '/components/0/id', value: 'x' }],
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('mutually exclusive');
    expect(request).not.toHaveBeenCalled();
  });

  it('模式 (b) path + spaceName：patches 预演直透', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      ok: true,
      diagnostics: [],
      checks: [],
      composition: { errors: 0, warnings: 0 },
      profile: 'showcase',
    });

    const result = await validateDiagramTool.handler(
      {
        spaceName: 'My Docs',
        path: 'diagrams/web-app.json',
        patches: [{ op: 'replace', path: '/meta/title', value: 'T' }],
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).profile).toBe('showcase');

    const postCall = request.mock.calls[1];
    expect(postCall[0]).toBe('POST');
    expect(postCall[2].body.path).toBe('diagrams/web-app.json');
    expect(postCall[2].body.patches).toEqual([{ op: 'replace', path: '/meta/title', value: 'T' }]);
  });

  it('模式 (b) path 缺 spaceName → 工具侧快速失败', async () => {
    const request = mockRequest();

    const result = await validateDiagramTool.handler({ path: 'diagrams/x.json' }, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('path requires spaceName');
    expect(request).not.toHaveBeenCalled();
  });

  it('模式 (b) docId + spaceName：用 spaceName 解析空间', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-2', name: 'Other Space', slug: 'other-space' }],
    });
    request.mockResolvedValueOnce({
      ok: true,
      diagnostics: [],
      checks: [],
      composition: { errors: 0, warnings: 0 },
      profile: 'standard',
    });

    const result = await validateDiagramTool.handler(
      { spaceName: 'Other Space', docId: 'd1' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const postCall = request.mock.calls[1];
    expect(postCall[1]).toBe('/doc-spaces/sp-2/diagrams/validate');
    expect(postCall[2].body.docId).toBe('d1');
  });

  it('模式 (b) docId 缺 spaceName：GET /docs/:docId 反查 spaceId（与 read/patch docId 通道对齐）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({ id: 'd1', spaceId: 'sp-9' });
    request.mockResolvedValueOnce({
      ok: false,
      stage: 'composition',
      diagnostics: [],
      checks: [],
      composition: { errors: 1, warnings: 0 },
      profile: 'standard',
    });

    const result = await validateDiagramTool.handler({ docId: 'd1' }, ctx());

    expect(result.isError).toBeFalsy();
    expect(request.mock.calls[0][0]).toBe('GET');
    expect(request.mock.calls[0][1]).toBe('/docs/d1');
    const postCall = request.mock.calls[1];
    expect(postCall[1]).toBe('/doc-spaces/sp-9/diagrams/validate');
    expect(postCall[2].body.docId).toBe('d1');
  });

  it('三个定位参数全缺 → 工具侧快速失败', async () => {
    const request = mockRequest();

    const result = await validateDiagramTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Provide exactly one target');
    expect(request).not.toHaveBeenCalled();
  });

  it('path 与 docId 互斥 → 工具侧快速失败', async () => {
    const request = mockRequest();

    const result = await validateDiagramTool.handler(
      { spaceName: 'My Docs', path: 'a.json', docId: 'd1' },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('mutually exclusive locators');
    expect(request).not.toHaveBeenCalled();
  });

  it('422 diagnostics 在工具结果 details 键下原样可读（R5 回归）', async () => {
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
          stage: 'schema',
          diagnostics: [
            {
              code: 'schema/required',
              severity: 'error',
              message: "must have required property 'diagram_type'",
              subject: { diagramType: undefined, path: '/' },
              supportedFixes: [
                "add 'diagram_type' with one of: architecture, workflow, sequence, dataflow, lifecycle",
              ],
            },
          ],
        },
      }),
    );

    const result = await validateDiagramTool.handler(
      { spaceName: 'My Docs', ir: { schema_version: 1 } },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.code).toBe(10010);
    expect(body.details.stage).toBe('schema');
    expect(body.details.diagnostics[0].code).toBe('schema/required');
    expect(body.details.diagnostics[0].supportedFixes[0]).toContain('diagram_type');
  });

  it('dry-run 零副作用：只发 POST validate，不出现任何写端点调用', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      ok: true,
      diagnostics: [],
      checks: [],
      composition: { errors: 0, warnings: 0 },
      profile: 'standard',
    });

    const result = await validateDiagramTool.handler({ spaceName: 'My Docs', ir: OK_IR }, ctx());

    expect(result.isError).toBeFalsy();
    const methods = request.mock.calls.map((c) => c[0]);
    expect(methods).toEqual(['GET', 'POST']);
    const urls = request.mock.calls.map((c) => String(c[1]));
    expect(urls.every((u) => u.endsWith('/diagrams/validate') || u.includes('/doc-spaces'))).toBe(
      true,
    );
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      ok: true,
      diagnostics: [],
      checks: [],
      composition: { errors: 0, warnings: 0 },
      profile: 'standard',
    });

    const result = await validateDiagramTool.handler({ spaceName: 'My Docs', ir: OK_IR }, ctx());

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
