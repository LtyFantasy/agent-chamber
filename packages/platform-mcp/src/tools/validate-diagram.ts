/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：validate_diagram dry-run 校验通道——与写通道同一道
 *     渲染门（schema/geometry/composition），零写入零事件零幂等，纯修复凭据通道
 *
 * [代码职责]
 *   - validate_diagram MCP 工具：两模式互斥（裸 ir / path 或 docId + patches 预演），
 *     工具侧快速失败照 patch-doc.ts 范式 → POST /doc-spaces/:id/diagrams/validate——
 *     docId 通道与 read/patch 对齐（裸 docId 可用，空间经 GET /docs/:docId 反查）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md diagram 小节（read_doc）— REST/错误码契约
 *   - 补充: plan .kimi/plans/diagram-ir-v1-plan.md §4.1（validate 端点 + M-e docId 通道）
 *     §4.2 ㊳（修复顺序：schema → 节点重叠/越界 → 边穿节点 → 交叉/走廊 → 间距/标签）
 *
 * [关键不变量]
 *   - 描述预算：description + inputSchema 字段描述合计 ≤2.5KB（评审逐字读）
 *   - 零副作用：本工具只发 POST validate，无任何写端点调用
 *   - 互斥语义：ir 与 path/docId/patches 互斥；path 与 docId 互斥；
 *     必须提供 ir | path | docId 三选一（工具侧快速失败，不发 HTTP）
 *   - 错误消费分层键名 = details（MCP 层 platform-client.ts:200 把 REST data 槽改名）
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/diagram.service.ts — validateDiagram
 *   - packages/shared/src/dto/diagram.dto.ts — DiagramValidationResult/DiagramDiagnostic
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
import { DIAGRAM_PATCH_OPS } from '@agent-chamber/shared';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface DocSpaceListItem {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

interface ValidatePatchArg {
  op: 'replace' | 'add' | 'remove';
  path: string;
  value?: unknown;
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
 * validate_diagram — dry-run 校验图 IR（零副作用修复凭据）
 *
 * 两模式互斥：裸 ir 校验 / 对存量 diagram doc 模拟 patch 后校验（path 或 docId）。
 * 与写通道同一道渲染门，但零写入零事件——ok=false 时 diagnostics 是修复凭据。
 */
export const validateDiagramTool: CustomTool = {
  tool: {
    name: 'validate_diagram',
    description:
      'Dry-run validation of a diagram IR (zero side effects: no doc row, no version, no ' +
      'event). Uses the same render gate as writes. ' +
      'Two mutually exclusive modes: (a) pass ir alone to validate a bare IR object; ' +
      '(b) pass path (with spaceName) or docId, optionally with patches, to simulate JSON ' +
      'patches on the stored IR of an existing diagram doc and validate the result. ' +
      'Returns {ok, stage?, diagnostics[], checks[], composition, profile}. ' +
      'When ok=false, fix in this order: schema → node overlap / out-of-bounds → edges ' +
      'crossing nodes → crossings / corridors → spacing / labels. ' +
      'Error layering: schema/geometry failures → follow details.diagnostics[].supportedFixes; ' +
      'composition failures → follow the prose guidance in details.checks[].details ' +
      '(the MCP result key is "details", not "data"). ' +
      'Full IR contract: see skill `diagrams` / docs/api-definition diagram section. ' +
      'If two fix rounds do not converge, stop and report the remaining diagnostics verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). Required for mode (a) bare IR ' +
            'and the path channel; optional for docId channel (resolved from the doc if omitted).',
        },
        path: {
          type: 'string',
          description:
            'Mode (b): doc path within the space (mutually exclusive with ir / docId). ' +
            'Requires spaceName.',
        },
        docId: {
          type: 'string',
          description:
            'Mode (b): document ID (mutually exclusive with ir / path). Works without ' +
            'spaceName — the space is resolved from the document.',
        },
        ir: {
          type: 'object',
          description:
            'Mode (a): bare diagram IR object to validate (mutually exclusive with ' +
            'path/docId/patches).',
        },
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                // 枚举值从 shared DIAGRAM_PATCH_OPS 单源取值（防 backend DTO 加值后此处漂移）
                enum: [...DIAGRAM_PATCH_OPS],
                description: "RFC 6902 operation: 'replace' | 'add' | 'remove'",
              },
              path: {
                type: 'string',
                description:
                  'RFC 6901 JSON pointer, e.g. "/components/2/label" (0-based index into ' +
                  'ir.components from read_diagram; root path "" / "/" rejected)',
              },
              value: {
                type: ['string', 'number', 'boolean', 'object', 'array', 'null'],
                description:
                  'New value for replace/add (required for those ops; ignored by remove)',
              },
            },
            required: ['op', 'path'],
          },
          description:
            'Mode (b) only: simulate these JSON patches on the stored IR before validating ' +
            '(omit to validate the stored IR as-is). Mutually exclusive with ir.',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const ir = args.ir as Record<string, unknown> | undefined;
    const patchesRaw = args.patches as unknown;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 0：两模式互斥/三选一快速失败（工具侧失败，不发 HTTP；服务端另有同等校验）
    const hasIr = ir !== undefined;
    const hasPath = path !== undefined;
    const hasDocId = docId !== undefined;
    const hasPatches = patchesRaw !== undefined;
    const modeError = (message: string): ToolCallResult => ({
      content: [{ type: 'text', text: JSON.stringify({ error: true, message }) }],
      isError: true,
    });

    if (hasIr && (hasPath || hasDocId || hasPatches)) {
      return modeError(
        'Mode (a) ir is mutually exclusive with mode (b) path / docId / patches — pass ir alone, or path|docId with optional patches',
      );
    }
    if (hasPath && hasDocId) {
      return modeError('path and docId are mutually exclusive locators — pass one only');
    }
    if (!hasIr && !hasPath && !hasDocId) {
      return modeError(
        'Provide exactly one target: ir (bare IR) or path | docId (stored doc, optional patches)',
      );
    }
    if (hasPatches) {
      const isPatchArray =
        Array.isArray(patchesRaw) &&
        (patchesRaw as unknown[]).every(
          (p) =>
            p !== null &&
            typeof p === 'object' &&
            typeof (p as ValidatePatchArg).op === 'string' &&
            typeof (p as ValidatePatchArg).path === 'string',
        );
      if (!isPatchArray || (patchesRaw as unknown[]).length === 0) {
        return modeError(
          'patches must be a non-empty array of {op: "replace"|"add"|"remove", path: string, value?: any}',
        );
      }
    }
    if (hasIr && (ir === null || typeof ir !== 'object' || Array.isArray(ir))) {
      return modeError('ir must be a JSON object (the diagram IR itself)');
    }

    let resolvedSpaceId: string;

    if (hasPath) {
      // 通道 A：path 模式 — spaceName 必填
      if (!spaceName) {
        return modeError('Mode (b) path requires spaceName (the space the doc lives in)');
      }
      const space = await resolveSpace(client, spaceName);
      if (space.isError) return space.result;
      resolvedSpaceId = space.id;
    } else if (hasDocId) {
      // 通道 B：docId 通道（与 read/patch 对齐）——spaceName 可选，缺省从 doc 反查
      if (spaceName) {
        const space = await resolveSpace(client, spaceName);
        if (space.isError) return space.result;
        resolvedSpaceId = space.id;
      } else {
        try {
          const doc = await client.request<{ spaceId?: string }>('GET', `/docs/${docId}`);
          if (!doc.spaceId) {
            return modeError('Could not resolve the DocSpace of the given docId');
          }
          resolvedSpaceId = doc.spaceId;
        } catch (err: unknown) {
          return handlePlatformError(err, 'locate_doc_space');
        }
      }
    } else {
      // 通道 C：裸 ir 模式 — spaceName 必填（端点空间级，必须解析 spaceId）
      if (!spaceName) {
        return modeError(
          'Mode (a) bare ir requires spaceName — the dry-run endpoint is space-scoped, ' +
            'so a DocSpace context is needed even for a bare IR',
        );
      }
      const space = await resolveSpace(client, spaceName);
      if (space.isError) return space.result;
      resolvedSpaceId = space.id;
    }

    // 组装 body（ir 模式 = {ir}；存量模式 = {path | docId, patches?}）
    const body: Record<string, unknown> = {};
    if (hasIr) {
      body.ir = ir;
    } else {
      if (hasPath) body.path = path;
      if (hasDocId) body.docId = docId;
      if (hasPatches) body.patches = patchesRaw;
    }

    // 校验（零写入零事件——dry-run 端点，错误结构化透传）
    try {
      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/doc-spaces/${resolvedSpaceId}/diagrams/validate`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'validate_diagram');
    }
  },
};

// ---------------------------------------------------------------------------
// 辅助：spaceName 三层匹配解析（upsert-doc.ts 同款，抽出复用）
// ---------------------------------------------------------------------------

/**
 * 解析 spaceName → spaceId（三层匹配：exact → prefix → substring）
 *
 * @param client - PlatformApiClient 实例
 * @param spaceName - 目标空间名
 * @returns 解析结果 —— 成功 { id }；失败 { isError: true, result: ToolCallResult }
 */
async function resolveSpace(
  client: PlatformApiClient,
  spaceName: string,
): Promise<{ id: string; isError?: false } | { isError: true; result: ToolCallResult }> {
  let spaces: DocSpaceListItem[];
  try {
    const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
      params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
    });
    spaces = resp.items ?? [];
  } catch (err: unknown) {
    return { isError: true, result: handlePlatformError(err, 'list_doc_spaces') };
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
      isError: true,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_space', ...body }),
          },
        ],
        isError: true,
      },
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
      isError: true,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, failedStep: 'resolve_space', ...body }),
          },
        ],
        isError: true,
      },
    };
  }

  return { id: matches[0].id };
}
