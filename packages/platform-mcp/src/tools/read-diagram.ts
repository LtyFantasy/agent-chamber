/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：docType='diagram' 的图文档（content = 规范化 IR JSON
 *     文本），渲染产物 HTML 快照 + render_meta 落 docs 表三列
 *
 * [代码职责]
 *   - read_diagram MCP 工具：双通道定位（spaceName+path 精确匹配 或 裸 docId）→
 *     GET /docs/:id/diagram——返回解析后的 IR 对象（非字符串）+ contentHash（乐观锁
 *     token）+ render 元数据；非 diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED 指路 read_doc
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md diagram 小节（read_doc）— REST/错误码契约
 *   - 补充: plan .kimi/plans/diagram-ir-v1-plan.md §4.1（GET diagram 形状）§4.2 ㊱
 *     （与 read_doc 分工消歧：read_doc 只给 IR 文本全文，无解析对象/render meta/非图守卫）
 *
 * [关键不变量]
 *   - 描述预算：description + inputSchema 字段描述合计 ≤2.5KB（评审逐字读）
 *   - contentHash 是原始写入 payload 的 SHA-256——仅透传响应 token，禁止自算
 *   - 错误消费分层键名 = details（MCP 层 platform-client.ts:200 把 REST data 槽改名）
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/diagram.service.ts — readDiagram
 *   - packages/shared/src/dto/diagram.dto.ts — DiagramDetail/DiagramWriteRenderInfo
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
 * read_diagram — 读图文档（解析后 IR + render 元数据）
 *
 * 双通道定位：(spaceName+path) 精确匹配 或 裸 docId。
 * 返回解析后的 IR 对象（非字符串——Agent 直接消费结构；patch 指针下标以此为准）
 * + contentHash（patch/upsert 乐观锁 token）+ render 元数据。
 */
export const readDiagramTool: CustomTool = {
  tool: {
    name: 'read_diagram',
    description:
      'Read a diagram document by dual-channel location: (spaceName + path) via exact ' +
      'path match, or bare docId via direct lookup. ' +
      'Returns the PARSED IR object (not a string — consume the structure directly; ' +
      'patch_diagram pointer indexes refer to ir.components positions in this object) ' +
      'plus contentHash (the optimistic-lock token required by patch_diagram / upsert_diagram ' +
      'expectedContentHash) and render metadata {qualityProfile, composition, htmlBytes, ' +
      'htmlSha256, renderedAt}. ' +
      'Division of labor with read_doc: read_doc also returns the IR as raw JSON text for a ' +
      'diagram doc, but without the parsed object, render metadata, or the non-diagram guard. ' +
      'Non-diagram doc → 400 DIAGRAM_DOC_TYPE_LOCKED (use read_doc instead). ' +
      'Diagram doc missing a snapshot (legacy data) → 409 DIAGRAM_SNAPSHOT_MISSING ' +
      '(re-upsert to regenerate). ' +
      'Full IR contract: see skill `diagrams` / docs/api-definition diagram section. ' +
      'Error layering: schema/geometry failures → details.diagnostics[].supportedFixes; ' +
      'composition failures → prose in details.checks[].details (key is "details", not "data"). ' +
      'If two fix rounds do not converge, stop and report the remaining diagnostics verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). Required when using path channel.',
        },
        path: {
          type: 'string',
          description:
            'Document path within the space (exact match). Required when using path channel.',
        },
        docId: {
          type: 'string',
          description: 'Document ID (UUID). Required when using direct docId channel.',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 参数校验：至少提供 (spaceName+path) 或 docId
    if (!docId && !(spaceName && path)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'Either docId or (spaceName + path) must be provided',
            }),
          },
        ],
        isError: true,
      };
    }

    let resolvedDocId: string;

    if (docId) {
      // 通道 2：裸 docId 直接定位
      resolvedDocId = docId;
    } else {
      // 通道 1：spaceName+path 精确匹配
      let spaces: DocSpaceListItem[];
      try {
        const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
          params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
        });
        spaces = resp.items ?? [];
      } catch (err: unknown) {
        return handlePlatformError(err, 'list_doc_spaces');
      }

      const { layer, matches } = matchByLayers(spaceName!, spaces, (s) => s.name);

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

      const spaceId = matches[0].id;

      // 精确 path 匹配
      try {
        const result = await client.request<{ items: Array<{ id: string }> }>(
          'GET',
          `/doc-spaces/${spaceId}/docs`,
          { params: { path: path!, pageSize: 1 } },
        );
        const docs = result.items ?? [];
        if (docs.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  message: `Document not found at path "${path}" in space "${spaceName}"`,
                }),
              },
            ],
            isError: true,
          };
        }
        resolvedDocId = docs[0].id;
      } catch (err: unknown) {
        return handlePlatformError(err, 'locate_doc');
      }
    }

    // 读取图（响应用解析后 IR 对象 + contentHash + render 元数据，直出）
    try {
      const result = await client.request<Record<string, unknown>>(
        'GET',
        `/docs/${resolvedDocId}/diagram`,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'read_diagram');
    }
  },
};
