/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.10 (DocSpace Module) + plan venom-longshot-ragman.md
 *     （v1.60.0-dev P1 双件：73cadb0d 原子 move_doc / 8d763914 move impact）
 *   - 补充: docs/api-definition.md §16（POST /docs/:id/move 契约）
 *   - 补充: v1.62.0（contentHash 读路径透传）——dryRun=true 可省略 expectedContentHash，
 *     响应含同源 contentHash = revision 获取 + preflight 合一；正式链 = 无 token dryRun
 *     取 hash → 带 token 二次 dryRun → 带同一 token 正式 move
 *
 * [踩坑索引]
 *   - audit_action 枚举缺口（v1.60.0-dev 新坑）：move 事务后写审计日志，PG 枚举
 *     audit_action 缺 move_doc 值会 500（migration 1787045000000 补齐）——本工具
 *     面无需处理，但涉及 move 的报错排查先核对 DB 枚举
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
// 工具函数（照抄 delete-doc.ts 的 matchByLayers / resolutionFailureBody——仓内惯例）
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
 * move_doc — 原子移动文档（v1.60.0-dev P1 73cadb0d）
 *
 * 双通道定位：spaceName+fromPath 精确匹配（服务器必填格式），或裸 docId。
 * 同一 docId 单事务只改 docs.path：docId/versions/task links/doc_routes 引用全部
 * 按 docId 自然连续（move 不受影响）；不触碰 content/sections/contentHash/title。
 * ✓ dryRun=true 跑完整校验链 + impact 预演视图，不写库。
 * 响应含 impact 摘要（inboundLinks/docRoutes/taskLinks/pathBasedLinksToRewrite），
 * pathBasedLinksToRewrite = 指向旧 path 的 Markdown 入链（move 后即断，需人工改写）。
 * 服务端 fail-closed 校验链（错误结构化透传，铁律 #9）：
 * 404（不存在/软删）→ 409 DOC_SOURCE_MISMATCH（非 native）→
 * 409 RESOURCE_CONFLICT（toPath == 当前 path）→
 * 409 DOC_CONTENT_CONFLICT（expectedContentHash 不符）→
 * 409 RESOURCE_CONFLICT（目标 path 已占用，data.conflictDocId）。
 */
export const moveDocTool: CustomTool = {
  tool: {
    name: 'move_doc',
    description:
      'Atomically move (rename) a document — wrapper of POST /docs/:id/move. ' +
      'Dual-channel location: (spaceName + fromPath) via exact path match, or bare docId. ' +
      'Single transaction, same docId, only docs.path is updated — docId/versions/task doc ' +
      'links/doc_routes references are preserved (all reference by docId). ' +
      'toPath is required (space-unique target path, same validation scale as upsert: ' +
      'non-empty string ≤512 chars). dryRun=true validates fully and returns the impact ' +
      'preview {moved:false, wouldMove:true} WITHOUT writing — pair impact preview then ' +
      'execute. ' +
      '🔒 REVISION-FETCH + PREFLIGHT IN ONE: dryRun=true may omit expectedContentHash; the ' +
      'response carries the same-source contentHash (SHA-256 of the original upsert payload, ' +
      'same token used by upsert/patch/read — never compute it from read text). The documented ' +
      '"no-token dryRun → second dryRun WITH the token → formal move with the SAME token" chain ' +
      'lets you confirm the hash, preflight the move, then execute atomically. ' +
      'The response includes the impact summary: inboundLinks (backlinks from ' +
      'other docs), docRoutes, taskLinks, and pathBasedLinksToRewrite (Markdown links ' +
      'pointing at the OLD path that will break and need manual rewriting after the move; ' +
      'platform /docs/<spaceId>?doc=<docId> links are NOT affected). ' +
      'With toPath the impact also carries outboundPathLinksToRewrite (v1.61.0): the ' +
      "MOVED doc's OWN relative .md links whose resolution drifts when its base directory " +
      'changes — each entry has oldResolvedTarget/newResolvedTarget (strict source-relative ' +
      'POSIX resolution), oldTargetExists (broken BEFORE the move?), targetExists (alive ' +
      'AFTER the move — the moved doc itself counts under the new path, so self-references ' +
      'resolve correctly) and targetDocId when alive. ' +
      'Fail-closed order: 404 (missing/soft-deleted) → 409 DOC_SOURCE_MISMATCH (non-native ' +
      'source) → 409 RESOURCE_CONFLICT (toPath == current path, no-op rejected) → ' +
      '409 DOC_CONTENT_CONFLICT (expectedContentHash mismatch) → 409 RESOURCE_CONFLICT ' +
      '(target path taken, data.conflictDocId). After commit: DOC_MOVED event, audit log, ' +
      'and async link_health recalculation. Requires write access (creator or editor).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). Required when using path channel.',
        },
        fromPath: {
          type: 'string',
          description:
            'Current document path within the space (exact match, e.g. "docs/old-name.md"). ' +
            'Required when using path channel; mutually exclusive with docId.',
        },
        docId: {
          type: 'string',
          description:
            'Document ID (UUID) of the doc to move. Required when using direct docId channel; ' +
            'mutually exclusive with (spaceName + fromPath).',
        },
        toPath: {
          type: 'string',
          description:
            'Target path (space-unique, required). Same validation scale as upsert: ' +
            'string ≤512 chars. Moving to the current path → 409 RESOURCE_CONFLICT.',
        },
        expectedContentHash: {
          type: 'string',
          description:
            'Optional optimistic-lock precondition (same semantics as upsert): the contentHash ' +
            'captured at read time. Mismatch → 409 DOC_CONTENT_CONFLICT (checked fast outside ' +
            'the transaction + rechecked under FOR UPDATE inside — TOCTOU-guarded). ' +
            'Note: move itself does NOT change contentHash; only a concurrent content edit ' +
            'would invalidate it.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'true = run the full validation chain + impact preview {moved:false, wouldMove:true} ' +
            'without writing — migrate first with dryRun, then re-submit without it.',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Optional idempotency key (1–64 chars, write calls only — dryRun never registers ' +
            'idempotency). RECOMMENDED for writes: on transport error / timeout, retry with ' +
            'the SAME key — the server returns the FIRST DocMoveResult snapshot with ' +
            'idempotentReplay:true (the document is NOT moved again; no event, no linkHealth ' +
            'recalc). Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
        },
      },
      required: ['toPath'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const fromPath = args.fromPath as string | undefined;
    const docId = args.docId as string | undefined;
    const toPath = args.toPath as string;
    const expectedContentHash = args.expectedContentHash as string | undefined;
    const dryRun = args.dryRun as boolean | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 参数校验：至少提供 docId 或 (spaceName + fromPath)
    if (!docId && !(spaceName && fromPath)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: 'Either docId or (spaceName + fromPath) must be provided',
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
      // 通道 1：spaceName+fromPath 精确匹配
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

      // fromPath 精确匹配定位 docId
      try {
        const result = await client.request<{ items: Array<{ id: string }> }>(
          'GET',
          `/doc-spaces/${spaceId}/docs`,
          { params: { path: fromPath!, pageSize: 1 } },
        );
        const docs = result.items ?? [];
        if (docs.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: true,
                  message: `Document not found at path "${fromPath}" in space "${spaceName}"`,
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

    // 移动（body 直透；服务端 fail-closed 校验链，错误结构化透传）
    try {
      const body: Record<string, unknown> = { toPath };
      if (expectedContentHash !== undefined) body.expectedContentHash = expectedContentHash;
      if (dryRun !== undefined) body.dryRun = dryRun;
      // v1.63.0：幂等键透传——transport error 后同 key 重试返回首次 DocMoveResult 快照
      const clientRequestId = args.clientRequestId as string | undefined;
      if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;

      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/docs/${resolvedDocId}/move`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'move_doc');
    }
  },
};
