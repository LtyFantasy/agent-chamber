/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.10 (DocSpace Module) + plan venom-longshot-ragman.md
 *     （v1.60.0-dev P1 双件：73cadb0d 原子 move_doc / 8d763914 move impact）
 *   - 补充: docs/api-definition.md §16（GET /docs/:id/move-impact 契约）
 *   - 补充: v1.62.0（contentHash 读路径透传）——响应 root 透传 contentHash（原始写入
 *     payload 的 SHA-256，乐观锁 token，与读出重建正文不可互算）
 *
 * [踩坑索引] -
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
 * get_doc_move_impact — 移动影响预演（backlinks 反查；v1.60.0-dev P1 8d763914）
 *
 * 双通道定位：spaceName+path 精确匹配，或裸 docId → GET /docs/:id/move-impact。
 * 与 move_doc 的 dryRun 共用同一服务端内核（computeMoveImpact）——dryRun 预演视图
 * 与真实移动前的状态一致；本工具是只读版（read 权限），适合先盘点再决策。
 */
export const getDocMoveImpactTool: CustomTool = {
  tool: {
    name: 'get_doc_move_impact',
    description:
      'Pre-move impact query (backlinks + reference inventory) — wrapper of ' +
      'GET /docs/:id/move-impact. Dual-channel location: (spaceName + path) via exact ' +
      'path match, or bare docId. Read-only (requires the same read permission as the ' +
      'document). Scans the WHOLE space for inbound Markdown links (backlinks) pointing ' +
      'at this doc — inboundLinks[] entries carry sourceDocId/sourcePath/href/' +
      'isPathBased (true = relative .md path link that WILL break if the doc moves; ' +
      'false = platform /docs/<spaceId>?doc=<docId> link, unaffected by moves) plus ' +
      'section position/headingPath of the first match. Also lists docRoutes references ' +
      '(primary/secondary role) and taskLinks (associated task IDs). ' +
      'Pass proposedPath to compute targetCollision (409-guard preview: is the new path ' +
      'already taken by another doc? → targetCollision.conflictDocId) and samePath ' +
      '(proposedPath == current path → no-op). ' +
      'pathBasedLinksToRewrite = the backlinks subset needing manual rewriting after a ' +
      'move. With proposedPath, outboundPathLinksToRewrite (v1.61.0) lists the MOVED ' +
      "doc's OWN relative .md links that will break or drift when its base directory " +
      'changes: each entry carries oldResolvedTarget/newResolvedTarget (strict ' +
      'source-relative POSIX resolution), oldTargetExists (broken BEFORE the move?), ' +
      'targetExists (alive AFTER the move — the moved doc itself counts under the new ' +
      'path, so self-references resolve correctly) and targetDocId when alive. ' +
      'The response root carries contentHash (SHA-256 of the original upsert payload — the ' +
      'optimistic-lock token for expectedContentHash on move/upsert/patch; NOT the hash of ' +
      'any read text, never self-compute). ' +
      'Share the exact same server-side kernel as move_doc dryRun — use this ' +
      'first for the impact picture, then move_doc with dryRun=true as the final rehearsal.',
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
            'Document path within the space (exact match, e.g. "docs/api-definition.md"). ' +
            'Required when using path channel.',
        },
        docId: {
          type: 'string',
          description:
            'Document ID (UUID). Required when using direct docId channel; mutually ' +
            'exclusive with (spaceName + path).',
        },
        proposedPath: {
          type: 'string',
          description:
            'Optional: proposed target path — when present the response additionally ' +
            'computes targetCollision (target path already taken → targetCollision.conflictDocId) ' +
            'and samePath (proposedPath equals the current path → no-op) — the same checks ' +
            'move_doc enforces with 409s.',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const proposedPath = args.proposedPath as string | undefined;
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

    // 只读 impact 查询（proposedPath 透传触发 collision/samePath 判定）
    try {
      const result = await client.request<Record<string, unknown>>(
        'GET',
        `/docs/${resolvedDocId}/move-impact`,
        { params: proposedPath !== undefined ? { proposedPath } : {} },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_doc_move_impact');
    }
  },
};
