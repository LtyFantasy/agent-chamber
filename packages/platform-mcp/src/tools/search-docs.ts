/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §5 W5 (search_docs 契约)
 *   - 补充: plan §4.5 (双路检索 + snippet), plan §1.1-13 (position 定位),
 *     plan §4-C3 (意图融合检索：boosts 可解释性透出)
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
import { projectDocHits } from './project';

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
 * search_docs — 文档语义搜索
 *
 * 解析 spaceName → 调用双路检索 → 投影 hits 为紧凑摘要。
 * 返回 top-k hits：{docId, docPath, docTitle, headingPath, position, snippet, score, boosts?}。
 * boosts 为三路融合加权来源（plan §4-C3）：route = 策展路由命中（primary ×1.5 / secondary ×1.2）、
 * taskLinks = 关联任务数（×1+min(c,5)×0.05 封顶 ×1.25）；无 boost 的命中省略该键。
 * docId + position 保留供 read_doc 接续定位。
 */
export const searchDocsTool: CustomTool = {
  tool: {
    name: 'search_docs',
    description:
      'Search documents in a DocSpace using dual-scoring (ts_rank + pg_trgm) ' +
      'plus intent fusion boosts (curated routes ×1.5/×1.2 and task-link count ×1..×1.25). ' +
      'Resolves spaceName via three-layer match. ' +
      'Returns top-k hits projected to {docId, docPath, docTitle, headingPath, position, snippet, score, boosts?}. ' +
      'boosts: {route: "primary"|"secondary", taskLinks} explains why a hit ranked high. ' +
      'Hits are SECTION-level: multiple sections of the same doc occupy separate hit rows — ' +
      'when you need "which docs are relevant" or page exhaustively, dedupe by docId (consumer\'s job). ' +
      'docId + position are preserved for read_doc follow-up. ' +
      'Pagination: offset (skip N hits) pairs with limit for exhaustive retrieval. ' +
      'Time window: createdAfter/createdBefore (ISO 8601, inclusive) filter docs.created_at; ' +
      'combine with sort="createdAt_desc"/"createdAt_asc" to order by creation time ' +
      '(time sort takes over ranking — boost fusion is skipped, score stays raw composite). ' +
      'Example "read diaries of the last 7 days": q="日记", type="memory", ' +
      'sort="createdAt_desc", createdAfter=<now minus 7 days ISO>, limit=20.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        q: {
          type: 'string',
          description: 'Search query string (required)',
        },
        type: {
          type: 'string',
          description: 'Optional: filter by document type',
        },
        tag: {
          type: 'string',
          description: 'Optional: filter by tag',
        },
        category: {
          type: 'string',
          description: 'Optional: filter by category slug',
        },
        limit: {
          type: 'integer',
          description: 'Max hits (1-20, default 5)',
        },
        offset: {
          type: 'integer',
          description:
            'Optional: pagination offset — number of hits to skip (default 0). ' +
            'Pages over SECTION hits, not docs (same doc may appear on multiple rows — dedupe by docId). ' +
            'Pair with limit to page through all matches exhaustively.',
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'createdAt_desc', 'createdAt_asc'],
          description:
            'Optional: sort mode (default "relevance" = dual-scoring + boost fusion). ' +
            '"createdAt_desc"/"createdAt_asc" order by doc creation time and skip boost fusion. ' +
            'Use with createdAfter/createdBefore for time-window queries (e.g. recent diaries).',
        },
        createdAfter: {
          type: 'string',
          description:
            'Optional: only docs created at/after this ISO 8601 time (inclusive), e.g. "2026-08-08T00:00:00.000Z"',
        },
        createdBefore: {
          type: 'string',
          description: 'Optional: only docs created at/before this ISO 8601 time (inclusive)',
        },
      },
      required: ['spaceName', 'q'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const q = args.q as string;
    const docType = args.type as string | undefined;
    const tag = args.tag as string | undefined;
    const category = args.category as string | undefined;
    const limit = (args.limit as number) ?? 5;
    // v1.55 翻页/时间序参数：仅在调用方显式传入时透传（缺省保持后端默认行为）
    const offset = args.offset as number | undefined;
    const sort = args.sort as string | undefined;
    const createdAfter = args.createdAfter as string | undefined;
    const createdBefore = args.createdBefore as string | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

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

    // 步骤 2：搜索
    const spaceId = matches[0].id;
    const params: Record<string, unknown> = { q, limit };
    if (docType) params.type = docType;
    if (tag) params.tag = tag;
    if (category) params.category = category;
    if (offset !== undefined) params.offset = offset;
    if (sort !== undefined) params.sort = sort;
    if (createdAfter !== undefined) params.createdAfter = createdAfter;
    if (createdBefore !== undefined) params.createdBefore = createdBefore;

    try {
      const hits = await client.request<unknown[]>('GET', `/doc-spaces/${spaceId}/search`, {
        params,
      });
      const projected = projectDocHits(hits);

      return {
        content: [{ type: 'text', text: JSON.stringify({ hits: projected }) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'search_docs');
    }
  },
};
