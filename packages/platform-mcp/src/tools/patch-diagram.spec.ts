/**
 * patch_diagram 单元测试
 *
 * 覆盖：双通道定位、patches 形状校验、expectedContentHash 必填（工具侧拒绝）、
 * happy path（PATCH body 直透 + appliedPatches）、409 透传（rebase 重试语义）、
 * 422 DIAGRAM_PATCH_FAILED 透传、422 diagnostics 透传（details 键）、紧凑 JSON。
 */

import type { CustomToolContext } from '@agent-chamber/automcp';
import { patchDiagramTool } from './patch-diagram';
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

describe('patch_diagram', () => {
  it('happy path（docId 直接定位）：patches + expectedContentHash body 直透，appliedPatches 透出', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd1',
      path: 'diagrams/web-app.json',
      diagramType: 'architecture',
      sectionCount: 1,
      tokenEstimate: 1200,
      contentHash: 'new-hash',
      appliedPatches: 1,
      render: {
        qualityProfile: 'standard',
        composition: { errors: 0, warnings: 0 },
        htmlBytes: 2100,
        htmlSha256: 'sha-2',
        renderedAt: '2026-08-30T00:00:00.000Z',
      },
    });

    const patches = [{ op: 'replace', path: '/components/2/label', value: 'API 网关' }];
    const result = await patchDiagramTool.handler(
      { docId: 'd1', patches, expectedContentHash: 'base-hash' },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.appliedPatches).toBe(1);
    expect(body.contentHash).toBe('new-hash');

    const patchCall = request.mock.calls[0];
    expect(patchCall[0]).toBe('PATCH');
    expect(patchCall[1]).toBe('/docs/d1/diagram');
    expect(patchCall[2].body.patches).toEqual(patches);
    expect(patchCall[2].body.expectedContentHash).toBe('base-hash');
  });

  it('expectedContentHash 必填（缺省 → 工具侧拒绝，不发 HTTP）', async () => {
    const request = mockRequest();

    const result = await patchDiagramTool.handler(
      { docId: 'd1', patches: [{ op: 'replace', path: '/components/1/label', value: 'x' }] },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('expectedContentHash is REQUIRED');
    expect(request).not.toHaveBeenCalled();
  });

  it('patches 非数组/空数组/形状错误 → 工具侧快速失败，不发 HTTP', async () => {
    const request = mockRequest();

    const cases: unknown[][] = [
      ['not-array'],
      [{ op: 'replace' }, { op: 'delete', path: '/a', value: 1 }],
    ];
    for (const patches of cases) {
      const result = await patchDiagramTool.handler(
        { docId: 'd1', patches, expectedContentHash: 'h' },
        ctx(),
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.message).toContain('patches must be a non-empty array');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('缺参数（无 spaceName+path 也无 docId）→ isError，不发 HTTP', async () => {
    const request = mockRequest();

    const result = await patchDiagramTool.handler(
      {
        patches: [{ op: 'add', path: '/components/-', value: { id: 'z' } }],
        expectedContentHash: 'h',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toContain('Either docId or (spaceName + path) must be provided');
    expect(request).not.toHaveBeenCalled();
  });

  it('happy path（spaceName + path 双通道定位）', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      items: [{ id: 'sp-1', name: 'My Docs', slug: 'my-docs' }],
    });
    request.mockResolvedValueOnce({
      items: [{ id: 'd2' }],
    });
    request.mockResolvedValueOnce({
      id: 'd2',
      path: 'diagrams/x.json',
      diagramType: 'sequence',
      appliedPatches: 2,
      contentHash: 'new-hash-2',
    });

    const result = await patchDiagramTool.handler(
      {
        spaceName: 'My Docs',
        path: 'diagrams/x.json',
        patches: [
          { op: 'remove', path: '/components/0' },
          { op: 'add', path: '/components/-', value: { id: 'new' } },
        ],
        expectedContentHash: 'base-hash',
      },
      ctx(),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).appliedPatches).toBe(2);
    const patchCall = request.mock.calls[2];
    expect(patchCall[0]).toBe('PATCH');
    expect(patchCall[1]).toBe('/docs/d2/diagram');
    expect(patchCall[2].body.patches).toHaveLength(2);
  });

  it('409 DOC_CONTENT_CONFLICT 透传（rebase 语义：重读 → 重改 → 重试）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 409,
        message: 'Content hash mismatch — re-read the diagram, rebase your patches, retry',
        code: 10009,
        details: { expected: 'base-hash', current: 'other-hash' },
      }),
    );

    const result = await patchDiagramTool.handler(
      {
        docId: 'd1',
        patches: [{ op: 'replace', path: '/components/2/label', value: 'API 网关' }],
        expectedContentHash: 'stale-hash',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(409);
    expect(body.code).toBe(10009);
    expect(body.details.current).toBe('other-hash');
  });

  it('422 DIAGRAM_PATCH_FAILED 透传（坏 pointer → 带 pointer/reason/supportedOps）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 422,
        message: 'JSON patch failed',
        code: 10011,
        details: {
          pointer: '/components/99/label',
          reason: 'index out of bounds',
          supportedOps: ['replace', 'add', 'remove'],
        },
      }),
    );

    const result = await patchDiagramTool.handler(
      {
        docId: 'd1',
        patches: [{ op: 'replace', path: '/components/99/label', value: 'x' }],
        expectedContentHash: 'h',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.code).toBe(10011);
    expect(body.details.pointer).toBe('/components/99/label');
    expect(body.details.supportedOps).toContain('replace');
  });

  it('422 diagnostics 在工具结果 details 键下原样可读（R5 回归：patch 后状态诊断）', async () => {
    const request = mockRequest();
    request.mockRejectedValueOnce(
      new PlatformApiError({
        status: 422,
        message: 'Diagram validation failed',
        code: 10010,
        details: {
          stage: 'composition',
          diagnostics: [],
          checks: [
            {
              name: 'node-overlap',
              ok: false,
              details: ['overlap between nodes a and b; move b down by 4 cells'],
            },
          ],
          composition: { errors: 1, warnings: 2 },
          profile: 'standard',
        },
      }),
    );

    const result = await patchDiagramTool.handler(
      {
        docId: 'd1',
        patches: [{ op: 'replace', path: '/components/2/label', value: 'API 网关' }],
        expectedContentHash: 'h',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.details.stage).toBe('composition');
    expect(body.details.checks[0].details[0]).toContain('move b down');
  });

  it('紧凑 JSON', async () => {
    const request = mockRequest();
    request.mockResolvedValueOnce({
      id: 'd3',
      path: 'diagrams/y.json',
      diagramType: 'lifecycle',
      appliedPatches: 1,
      contentHash: 'hash-3',
    });

    const result = await patchDiagramTool.handler(
      {
        docId: 'd3',
        patches: [{ op: 'replace', path: '/meta/title', value: 'T' }],
        expectedContentHash: 'h',
      },
      ctx(),
    );

    const text = result.content[0].text;
    expect(text).not.toContain('\n  ');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});
