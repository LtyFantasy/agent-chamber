/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：docType='diagram' 的图文档（content = 规范化 IR JSON
 *     文本），5 型（architecture/workflow/sequence/dataflow/lifecycle），写通道
 *     fail-closed 渲染门（schema/geometry/composition 校验不过不入库）
 *
 * [代码职责]
 *   - upsert_diagram MCP 工具：spaceName 三层匹配 → PUT /doc-spaces/:id/diagrams——
 *     ir 对象直传 body（服务端规范化 + 渲染门），透传 title/summary/category/tags/
 *     expectedContentHash/clientRequestId；错误经 handlePlatformError 结构化透传
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md diagram 小节（read_doc）— REST/错误码契约
 *   - 补充: plan .kimi/plans/diagram-ir-v1-plan.md §4.2 ㉟（工具签名/描述要点/预算口径）
 *     + §2.2（D7 profile 门 / R4 缺省注入）§2.3 R5（MCP 错误键名 details 非 data）
 *
 * [关键不变量]
 *   - 描述预算：description + inputSchema 字段描述合计 ≤2.5KB（评审逐字读）
 *   - 错误消费分层：schema/geometry 按 details.diagnostics[].supportedFixes 修；
 *     composition 按 details.checks[].details 散文修（MCP 层键名是 details 不是 data）
 *   - quality_profile：standard | showcase；showcase=0 警告才过门，缺省服务端按
 *     standard 注入（描述引导显式写，创作纪律）
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/diagram.service.ts — upsertDiagram
 *   - packages/shared/src/dto/diagram.dto.ts — UpsertDiagramResult/DiagramWriteRenderInfo
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface DocSpaceListItem {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 工具函数（照抄 create-task.ts）
// ---------------------------------------------------------------------------

function matchByLayers<T>(
  needle: string,
  candidates: T[],
  keyFn: (c: T) => string,
): { layer: number; matches: T[] } {
  const lower = needle.toLowerCase();

  const exact = candidates.filter((c) => keyFn(c).toLowerCase() === lower);
  if (exact.length > 0) return { layer: 1, matches: exact };

  const prefix = candidates.filter((c) => keyFn(c).toLowerCase().startsWith(lower));
  if (prefix.length > 0) return { layer: 2, matches: prefix };

  const substring = candidates.filter((c) => keyFn(c).toLowerCase().includes(lower));
  return { layer: 3, matches: substring };
}

function resolutionFailureBody(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const failure = err as Error & {
    candidates?: unknown[];
    options?: unknown[];
    availableNames?: string[];
    isAmbiguous?: boolean;
    layer?: string;
  };
  return {
    message: failure.message,
    candidates: failure.candidates,
    options: failure.options,
    availableNames: failure.availableNames,
    isAmbiguous: failure.isAmbiguous,
    layer: failure.layer,
  };
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/**
 * upsert_diagram — 创建/更新图文档（Diagram IR v1）
 *
 * 解析 spaceName → PUT /doc-spaces/:id/diagrams。
 * 服务端规范化 IR（2 空格 JSON）后走 fail-closed 渲染门，
 * 校验不过不入库（422 DIAGRAM_VALIDATION_FAILED 携带修复凭据）。
 */
export const upsertDiagramTool: CustomTool = {
  tool: {
    name: 'upsert_diagram',
    description:
      'Create or update a diagram document by spaceName + path. ' +
      'Resolves spaceName via three-layer match. ' +
      'Five diagram types (pick by intent): architecture = system structure / component ' +
      'topology; workflow = business process / state transitions; sequence = message ' +
      'interactions in time order; dataflow = data movement through stages; lifecycle = ' +
      'stage cycle of an entity. ' +
      'quality_profile (ir.meta.quality_profile): standard | showcase — showcase requires 0 ' +
      'warnings to pass (stricter); the default is standard (warnings do NOT block) and a ' +
      'missing/invalid value is injected as standard server-side — write it explicitly anyway. ' +
      'Authoring: ONE main path, ≤12 primary nodes, prefer automatic routing (fix from ' +
      'diagnostics, not manual coordinates). ' +
      'Error layering: schema/geometry failures → fix via details.diagnostics[].supportedFixes; ' +
      'composition failures → prose in details.checks[].details (key is "details", not "data"). ' +
      'Full IR contract: see skill `diagrams` / docs/api-definition diagram section. ' +
      'Stop after 2 non-converging fix rounds; report remaining diagnostics verbatim. ' +
      'Returns {id, path, diagramType, sectionCount, tokenEstimate, unchanged?, created?, ' +
      'contentHash, render:{qualityProfile, composition, htmlBytes, htmlSha256, renderedAt}, ' +
      'idempotentReplay?} — contentHash feeds expectedContentHash on the next write. ' +
      'Repository evidence (meta.repository / components[].sources) is rejected upfront.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        path: {
          type: 'string',
          description: 'Document path within the space (exact match, e.g. "docs/architecture.md")',
        },
        ir: {
          type: 'object',
          description:
            'Diagram IR object (schema_version/diagram_type/meta/...). Server canonicalizes ' +
            'it (JSON.stringify 2-space indent) before hashing/storage; the fail-closed render ' +
            'gate rejects invalid IR (422 with diagnostics) and nothing is persisted.',
        },
        title: {
          type: 'string',
          description:
            'Optional: document title (defaults to ir.meta.title, then path; ≤200 chars)',
        },
        summary: {
          type: 'string',
          description:
            'Optional: summary (≤500 chars, defaults to "<diagramType> 图：<ir.meta.title>")',
        },
        category: {
          type: 'string',
          description:
            'Optional: category name (auto-created if not found). Reuse existing; avoid near-duplicates.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: 3–5 tags, identifiers/technical terms first (search anchors)',
        },
        expectedContentHash: {
          type: 'string',
          description:
            'Optional optimistic lock (fail-closed): contentHash from a previous read/write ' +
            'response. Doc missing or current hash mismatch → 409 DOC_CONTENT_CONFLICT; ' +
            're-read and retry. Omit = no precondition.',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars): retry with SAME key → first snapshot ' +
            'idempotentReplay:true; same key + different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['spaceName', 'path', 'ir'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const path = args.path as string;
    const ir = args.ir as Record<string, unknown>;
    const title = args.title as string | undefined;
    const summary = args.summary as string | undefined;
    const category = args.category as string | undefined;
    const tags = args.tags as string[] | undefined;
    const expectedContentHash = args.expectedContentHash as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // ir 必须是对象（inputSchema 已声明 object；JSON-RPC 层会把对象直传，这里防御性兜底）
    if (ir === null || typeof ir !== 'object' || Array.isArray(ir)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'ir must be a JSON object (the diagram IR itself)',
            }),
          },
        ],
        isError: true,
      };
    }

    // 步骤 1：解析 spaceName
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
      });
      spaces = resp.items ?? [];
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_doc_spaces');
    }

    const { layer, matches } = matchByLayers(spaceName, spaces, (s) => s.name);

    if (matches.length === 0) {
      const names = spaces.map((s) => s.name);
      const err = Object.assign(
        new Error(
          `spaceName "${spaceName}" did not match any DocSpace. ` +
            `Available spaces: ${names.length > 0 ? names.join(', ') : '(none)'}`,
        ),
        { isAmbiguous: false, availableNames: names },
      );
      const body = resolutionFailureBody(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_space', ...body }),
          },
        ],
        isError: true,
      };
    }

    if (matches.length > 1) {
      const candidates = matches.map((s) => ({ id: s.id, name: s.name, slug: s.slug }));
      const layerLabel = layer === 1 ? 'exact' : layer === 2 ? 'prefix' : 'substring';
      const err = Object.assign(
        new Error(
          `spaceName "${spaceName}" matched ${matches.length} DocSpaces (${layerLabel}). ` +
            `Please refine: ${candidates.map((c) => c.name).join(', ')}`,
        ),
        { candidates, layer: layerLabel, isAmbiguous: true },
      );
      const body = resolutionFailureBody(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_space', ...body }),
          },
        ],
        isError: true,
      };
    }

    // 步骤 2：upsert diagram（ir 对象直传 body，服务端负责规范化）
    const spaceId = matches[0].id;
    const body: Record<string, unknown> = {
      path,
      ir,
    };
    if (title !== undefined) body.title = title;
    if (summary !== undefined) body.summary = summary;
    if (category !== undefined) body.category = category;
    if (tags !== undefined) body.tags = tags;
    if (expectedContentHash !== undefined) body.expectedContentHash = expectedContentHash;
    const clientRequestId = args.clientRequestId as string | undefined;
    if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;

    try {
      const result = await client.request<Record<string, unknown>>(
        'PUT',
        `/doc-spaces/${spaceId}/diagrams`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'upsert_diagram');
    }
  },
};
