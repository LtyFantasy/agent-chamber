/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, PATCH /docs/:id/metadata)
 *   - 补充: plan patriot-cyclone-deadman.md §2.2（v1.61.0 批次 2：MCP patch_doc_metadata
 *     双通道定位 docId | spaceName+path，worker+full 双 profile 注册）
 *
 * [踩坑索引]
 *   - Partial 三态直透（本工具立）：body 只携带调用方**显式提供**的字段——
 *     undefined 字段禁止写入 body（服务端三态契约：缺席=不动 / null=400 / 值=更新），
 *     把 undefined 显式塞进 JSON 会被 JSON.stringify 自然丢弃，但 undefined 判定
 *     必须先于赋值（`!== undefined` 守卫），否则 null 与缺席的区分会被工具层抹掉
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
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
// 工具函数（照抄 move-doc.ts 的 matchByLayers / resolutionFailureBody——仓内惯例）
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
 * patch_doc_metadata — metadata-only 文档写（v1.61.0 批次 2，Board 任务 201ae04f）
 *
 * 双通道定位：spaceName+path 精确匹配（服务器必填格式），或裸 docId。
 * 服务端契约 6 条（游戏方 Pilot 1b proposal）：Partial 三态（缺席=不动 /
 * null=400 / 值=更新，tags: [] = 清空）、expectedContentHash 必填（事务外快速失败 +
 * 事务内 FOR UPDATE 复核）、不重切 sections/不落 doc_versions/不动 contentHash、
 * native-only、响应带 changedFields/unchanged/最终元数据、category 默认只解析既有。
 * body 直透仅显式字段（三态契约，见 AGENT-HOOK），错误结构化透传（铁律 #9）。
 */
export const patchDocMetadataTool: CustomTool = {
  tool: {
    name: 'patch_doc_metadata',
    description:
      'Patch document METADATA ONLY — wrapper of PATCH /docs/:id/metadata. ' +
      'Dual-channel location: (spaceName + path) via exact path match, or bare docId. ' +
      'Updates ONLY the docs row metadata columns — NO section re-chunk, NO doc_versions ' +
      'row, contentHash/docId/task_doc_links/doc_routes all untouched. ' +
      'PARTIAL three-state semantics: only explicit fields are updated (title/summary/' +
      'docType/tags/category); absent field = keep current; tags: [] = CLEAR all tags; ' +
      'null = 400 rejected (unambiguous three-state). ' +
      'expectedContentHash is REQUIRED: mismatch → 409 DOC_CONTENT_CONFLICT with ' +
      'currentContentHash (checked fast outside the transaction + rechecked under FOR ' +
      'UPDATE inside — TOCTOU-guarded). metadata-only writes never change contentHash, ' +
      'so a matching hash stays valid across chained metadata writes. ' +
      'category resolves EXISTING space categories only by default — an unknown name → ' +
      '404 DOC_CATEGORY_NOT_FOUND (prevents typo-born near-duplicate categories); pass ' +
      'allowCreateCategory=true to auto-create via the existing upsert resolution path. ' +
      'Non-native documents → 409 DOC_SOURCE_MISMATCH. When every explicit field equals ' +
      'the current value the call short-circuits: unchanged:true, empty changedFields, ' +
      'no write. Response: { docId, path, contentHash, changedFields, unchanged, metadata } ' +
      '— the final metadata view for single-call verification. ' +
      'Requires write access (creator or editor).',
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
            'Document path within the space (exact match, e.g. "docs/architecture.md"). ' +
            'Required when using path channel; mutually exclusive with docId.',
        },
        docId: {
          type: 'string',
          description:
            'Document ID (UUID) of the doc to patch. Required when using direct docId channel; ' +
            'mutually exclusive with (spaceName + path).',
        },
        expectedContentHash: {
          type: 'string',
          description:
            'REQUIRED optimistic-lock precondition: the contentHash captured at read time ' +
            '(read_doc / upsert_doc responses carry contentHash). Mismatch → 409 ' +
            'DOC_CONTENT_CONFLICT (TOCTOU-guarded). metadata-only patch never changes ' +
            'contentHash — only a concurrent CONTENT edit invalidates it.',
        },
        title: {
          type: 'string',
          description: 'New title (≤200 chars). Absent = keep current; null = 400.',
        },
        summary: {
          type: 'string',
          description:
            'New summary (≤500 chars). Absent = keep current; empty string = store empty; null = 400.',
        },
        docType: {
          type: 'string',
          description: 'New docType (≤64 chars). Absent = keep current; null = 400.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'New tags list (max 20 items, each ≤50 chars). Absent = keep current; ' +
            '[] = CLEAR all tags; null = 400.',
        },
        category: {
          type: 'string',
          description:
            'Category name (≤100 chars). Absent = keep current; null = 400. DEFAULT ' +
            'resolve-only: unknown name → 404 DOC_CATEGORY_NOT_FOUND; pass ' +
            'allowCreateCategory=true to auto-create.',
        },
        allowCreateCategory: {
          type: 'boolean',
          description:
            'true = category resolution may auto-create when the name is unknown ' +
            '(default false = resolve-only against existing space categories).',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars). RECOMMENDED for writes: on transport ' +
            'error / timeout, retry with the SAME key — the server returns the FIRST ' +
            'response snapshot with idempotentReplay:true (no audit, no event, no side ' +
            'effects). Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['expectedContentHash'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const expectedContentHash = args.expectedContentHash as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 参数校验：至少提供 docId 或 (spaceName + path)
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

    // expectedContentHash 必填（服务端 DTO 同判，工具层先行快速失败省一次往返）
    if (expectedContentHash === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message:
                'expectedContentHash is required (optimistic-lock precondition); ' +
                'read the document first and pass the contentHash from the read response',
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
          params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，同 move-doc）
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                failedStep: 'resolve_space',
                ...resolutionFailureBody(err),
              }),
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                failedStep: 'resolve_space',
                ...resolutionFailureBody(err),
              }),
            },
          ],
          isError: true,
        };
      }

      const spaceId = matches[0].id;

      // path 精确匹配定位 docId
      try {
        const result = await client.request<{ items: Array<{ id: string }> }>(
          'GET',
          `/doc-spaces/${spaceId}/docs`,
          { params: { path, pageSize: 1 } },
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

    // metadata patch（body 仅携带显式字段——Partial 三态契约：缺席字段不进 body，
    // 服务端才能区分「不动」与「更新」；null 直透由服务端 400 拒绝）
    try {
      const body: Record<string, unknown> = { expectedContentHash };
      if (args.title !== undefined) body.title = args.title;
      if (args.summary !== undefined) body.summary = args.summary;
      if (args.docType !== undefined) body.docType = args.docType;
      if (args.tags !== undefined) body.tags = args.tags;
      if (args.category !== undefined) body.category = args.category;
      if (args.allowCreateCategory !== undefined)
        body.allowCreateCategory = args.allowCreateCategory;
      // v1.63.0：幂等键透传——transport error 后同 key 重试返回首次响应快照 + idempotentReplay
      if (args.clientRequestId !== undefined) body.clientRequestId = args.clientRequestId;

      const result = await client.request<Record<string, unknown>>(
        'PATCH',
        `/docs/${resolvedDocId}/metadata`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'patch_doc_metadata');
    }
  },
};
