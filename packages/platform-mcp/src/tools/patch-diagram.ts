/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：patch_diagram 写入口——RFC 6901 pointer + RFC 6902 子集
 *     （replace/add/remove），多 op 原子应用（全或无，一败全拒），patch 后 IR 仍过
 *     完整校验渲染门（422 诊断指向 patch 后状态）
 *
 * [代码职责]
 *   - patch_diagram MCP 工具：双通道定位（spaceName+path 精确匹配 或 裸 docId）→
 *     PATCH /docs/:id/diagram——patches 直传 + expectedContentHash 必填（read_diagram
 *     响应携带；409 冲突 → 重读 rebase 重试）+ clientRequestId 幂等键透传
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md diagram 小节（read_doc）— REST/错误码契约
 *   - 补充: plan .kimi/plans/diagram-ir-v1-plan.md §0 D8（patch 语义拍板 = 复用乐观锁/
 *     幂等机械层）§4.2 ㊲（内嵌最小示例 + 下标口径——高频错点 = 数组下标计数）
 *
 * [关键不变量]
 *   - 描述预算：description + inputSchema 字段描述合计 ≤2.5KB（评审逐字读）
 *   - expectedContentHash 必填（工具侧校验缺省即 isError，不发 HTTP）——圆桌多 Agent
 *     共改的裁判机制：409 DOC_CONTENT_CONFLICT → 重读 rebase 重试
 *   - 入口幂等指纹 = patch payload（patches+expectedContentHash），非派生全文
 *   - 指针语义：路径 '/components/2/label' 的下标 = read_diagram 返回 ir.components 的
 *     0-based 位置；~0/~1 转义；根路径拒绝（整体替换走 upsert_diagram）
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/diagram.service.ts — patchDiagram
 *   - apps/backend/src/modules/docspace/diagram-patch.ts — 指针语义纯函数实现
 *   - packages/shared/src/dto/diagram.dto.ts — DiagramPatchOp/UpsertDiagramResult
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

interface DiagramPatchOpArg {
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
 * patch_diagram — 原子 JSON patch 改图（RFC 6901/6902 子集）
 *
 * 双通道定位：(spaceName+path) 精确匹配 或 裸 docId。
 * 对当前 IR 深拷贝原子应用全部 op（一败全拒）→ 规范化 → 重跑完整校验渲染门
 * （422 诊断指向 patch 后状态）。expectedContentHash 必填。
 */
export const patchDiagramTool: CustomTool = {
  tool: {
    name: 'patch_diagram',
    description:
      'Atomically JSON-patch a diagram IR (RFC 6901 pointer + RFC 6902 subset: replace / ' +
      'add / remove). Dual-channel location: (spaceName + path) via exact path match, or ' +
      'bare docId. ' +
      'Applies all ops to the current IR at once (all-or-nothing, one failure rejects all) ' +
      'then re-runs the full render gate — 422 diagnostics describe the PATCHED state. ' +
      'expectedContentHash is REQUIRED (from read_diagram response) — the staleness referee ' +
      'for concurrent agents: 409 DOC_CONTENT_CONFLICT → re-read, rebase your patches, retry. ' +
      'Minimal example: [{"op":"replace","path":"/components/2/label","value":"API 网关"}] — ' +
      'the index is the 0-based position in ir.components as returned by read_diagram. ' +
      'Bad pointer → 422 DIAGRAM_PATCH_FAILED {pointer, reason, supportedOps}; non-diagram ' +
      'doc → 400 (use read_doc/upsert_diagram). ' +
      'Full IR contract: see skill `diagrams` / docs/api-definition diagram section. ' +
      'Error layering: details.diagnostics / details.checks keys (not "data"); ' +
      'schema/geometry → supportedFixes, composition → checks[].details prose. ' +
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
            'JSON patch list applied atomically (all-or-nothing). ' +
            'Minimal example: [{"op":"replace","path":"/components/2/label","value":"API 网关"}]',
        },
        expectedContentHash: {
          type: 'string',
          description:
            'REQUIRED optimistic lock: contentHash from the read_diagram response. ' +
            'Stale → 409 DOC_CONTENT_CONFLICT (re-read, rebase, retry).',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars). Fingerprint = patch payload, so a retry ' +
            'after success replays the first response instead of false-conflicting. Same key ' +
            'with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['patches', 'expectedContentHash'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const patchesRaw = args.patches as unknown;
    const expectedContentHash = args.expectedContentHash as string;
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

    // patches 形状校验（工具侧快速失败，不发 HTTP；服务端另有双层校验）
    const isPatchArray =
      Array.isArray(patchesRaw) &&
      (patchesRaw as unknown[]).every(
        (p) =>
          p !== null &&
          typeof p === 'object' &&
          typeof (p as DiagramPatchOpArg).op === 'string' &&
          typeof (p as DiagramPatchOpArg).path === 'string',
      );
    if (!isPatchArray || (patchesRaw as unknown[]).length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message:
                'patches must be a non-empty array of {op: "replace"|"add"|"remove", path: string, value?: any}',
            }),
          },
        ],
        isError: true,
      };
    }
    const patches = patchesRaw as DiagramPatchOpArg[];

    // expectedContentHash 必填（roundtable 共改裁判机制缺省 = 盲写，工具侧拒绝）
    if (!expectedContentHash) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message:
                'expectedContentHash is REQUIRED — copy it from the read_diagram response ' +
                '(the staleness referee for concurrent edits)',
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

    // 原子 patch（body 直透；服务端 fail-closed：指针校验 + 渲染门，错误结构化透传）
    try {
      const body: Record<string, unknown> = {
        patches,
        expectedContentHash,
      };
      const clientRequestId = args.clientRequestId as string | undefined;
      if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;

      const result = await client.request<Record<string, unknown>>(
        'PATCH',
        `/docs/${resolvedDocId}/diagram`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'patch_diagram');
    }
  },
};
