/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: plan patriot-cyclone-deadman.md §1.7（v1.61.0 批次 1：link-health recheck
 *     手动重检入口——严格 POSIX 源目录解析语义变更后的迁移收口工具）
 *
 * [踩坑索引]
 *   - v1.61.0 路径语义漂移（d0569c83）：resolveHrefToDocPath 从启发式切严格解析后，
 *     「文档不编辑但断链面变化」需要手动重检入口（本工具）——部署后跑一次收敛，
 *     消费端不要再依赖旧 docs/ 前缀补全写法
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
 * recheck_doc_link_health — linkHealth 手动重检（v1.61.0 批次 1 新增第 29 个工具）
 *
 * 三通道定位：
 * - spaceName + path（双参数）→ 单文档重检（POST /docs/:id/link-health/recheck）；
 * - 裸 docId → 单文档重检（同上）；
 * - 仅 spaceName（无 path）→ 空间级全量重检（POST /doc-spaces/:id/docs/link-health/recheck），
 *   返回 { checked, broken } 计数。
 * 用途：严格 POSIX 源目录解析语义上线后（v1.61.0 行为变更），文档不编辑但断链面
 * 已变化——对单文档或整个空间手动重跑一次，刷新 link_health 落库值，无需 upsert。
 */
export const recheckDocLinkHealthTool: CustomTool = {
  tool: {
    name: 'recheck_doc_link_health',
    description:
      'Manually recompute and persist link_health (broken-link view) — wrapper of ' +
      'POST /docs/:id/link-health/recheck (single doc) and ' +
      'POST /doc-spaces/:id/docs/link-health/recheck (whole space). ' +
      'Three location channels: (spaceName + path) or bare docId for a single document; ' +
      'spaceName alone (no path) for a space-wide recheck that returns { checked, broken } ' +
      'counts (checked = docs re-scanned, broken = total broken links). ' +
      'Requires write access. Single-doc recheck returns the latest LinkHealth ' +
      '{ total, broken, checkedAt }. Use after the v1.61.0 strict source-relative POSIX ' +
      'path resolution change to converge the broken-link view without editing docs ' +
      ' — deployment-time reconciliation entry (see also docs/api-definition.md §16).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description:
            'DocSpace name (resolved via three-layer match). With path → single-doc ' +
            'recheck; ALONE (path omitted) → space-wide recheck of every non-deleted doc.',
        },
        path: {
          type: 'string',
          description:
            'Document path within the space (exact match, e.g. "docs/api-definition.md"). ' +
            'Optional: when present (with spaceName) or combined with docId channel, ' +
            'rechecks that single document only.',
        },
        docId: {
          type: 'string',
          description:
            'Document ID (UUID). Single-doc recheck via direct docId channel; mutually ' +
            'exclusive with (spaceName + path).',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string | undefined;
    const path = args.path as string | undefined;
    const docId = args.docId as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 参数校验：spaceName 单参（空间级）或 (spaceName+path) / docId（单文档）三者取一
    const singleDoc = !!(docId || (spaceName && path));
    if (!singleDoc && !(spaceName && !path)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message:
                'Either docId, (spaceName + path) for a single doc, or spaceName alone for a ' +
                'space-wide recheck must be provided',
            }),
          },
        ],
        isError: true,
      };
    }

    // ── 单文档通道：docId 定位 / spaceName+path 定位 → POST /docs/:id/link-health/recheck ──
    if (singleDoc) {
      let resolvedDocId: string;

      if (docId) {
        resolvedDocId = docId;
      } else {
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

      try {
        const result = await client.request<Record<string, unknown>>(
          'POST',
          `/docs/${resolvedDocId}/link-health/recheck`,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err: unknown) {
        return handlePlatformError(err, 'recheck_doc_link_health');
      }
    }

    // ── 空间级通道：仅 spaceName → POST /doc-spaces/:id/docs/link-health/recheck ──
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 },
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

    try {
      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/doc-spaces/${matches[0].id}/docs/link-health/recheck`,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'recheck_doc_link_health');
    }
  },
};
