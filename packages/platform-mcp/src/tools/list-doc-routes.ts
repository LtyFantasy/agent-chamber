/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (GET /doc-spaces/:id/routes)
 *   - 补充: 任务 T2（工具面管理/盘点视角补齐——doc_routes 的 MCP 读通道）
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
// 工具函数（照抄 get-docs-overview.ts 的 matchByLayers / resolutionFailureBody）
// ---------------------------------------------------------------------------

/**
 * 三层匹配（大小写不敏感）：
 * ① 精确匹配（ci）
 * ② 前缀匹配（ci）
 * ③ 子串匹配（ci）
 *
 * 取最先产生匹配的那一层。该层内 0 个 → 返回 []，>1 个 → 返回该层全部。
 */
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
 * list_doc_routes — DocSpace 意图路由清单（盘点视角，v1.55 任务 T2）
 *
 * 按 spaceName 三层匹配解析 DocSpace → 包装 GET /doc-spaces/:id/routes。
 * 0 或 >1 候选均 isError + candidates，绝不静默挑选。
 *
 * 响应形状随后端分页模式切换：不传 page/pageSize → 全量数组（上限 1000 条兜底）；
 * 传 page 或 pageSize → 标准分页信封 {items,total,page,pageSize,totalPages,hasNext,hasPrev}。
 * 大空间（>100 条路由）盘点请显式分页。
 */
export const listDocRoutesTool: CustomTool = {
  tool: {
    name: 'list_doc_routes',
    description:
      'List the intent routes (doc_routes) of a DocSpace — the curated intent→doc navigation table ' +
      '(wrapper of GET /doc-spaces/:id/routes). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive). ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Filters: q (ILIKE fuzzy match on intent), category (exact match). ' +
      'Pagination: omitting page/pageSize returns the full array (capped at 1000); ' +
      'passing page (default 1) or pageSize (default 20, max 100) switches to the paginated envelope ' +
      '{items,total,page,pageSize,totalPages,hasNext,hasPrev}. ' +
      'For large spaces (>100 routes) always paginate. ' +
      'Routes are sorted by curation order (sortOrder ASC, createdAt ASC).',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        q: {
          type: 'string',
          description: 'Optional: fuzzy match on intent (ILIKE, case-insensitive).',
        },
        category: {
          type: 'string',
          description: 'Optional: filter by route category (exact match).',
        },
        page: {
          type: 'number',
          description:
            'Optional: page number (default 1). Passing page or pageSize switches the response to the paginated envelope.',
        },
        pageSize: {
          type: 'number',
          description: 'Optional: items per page (default 20, max 100).',
        },
      },
      required: ['spaceName'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const spaceName = args.spaceName as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：获取空间列表（候选来源）
    let spaces: DocSpaceListItem[];
    try {
      const resp = await client.request<{ items: DocSpaceListItem[] }>('GET', '/doc-spaces', {
        params: { pageSize: 100 }, // 后端上限 100；空间数超 100 时较老空间解析不到（已知取舍，空间量级远低于此）
      });
      spaces = resp.items ?? [];
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_doc_spaces');
    }

    // 步骤 2：三层匹配解析 spaceName
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

    // 步骤 3：拉取路由清单（过滤/分页参数透传；空值不携带，保持请求干净）
    const spaceId = matches[0].id;
    const filterKeys = ['q', 'category', 'page', 'pageSize'] as const;
    const params: Record<string, unknown> = {};
    for (const key of filterKeys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== '') params[key] = value;
    }

    try {
      const resp = await client.request<unknown>('GET', `/doc-spaces/${spaceId}/routes`, {
        params,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_routes');
    }
  },
};
