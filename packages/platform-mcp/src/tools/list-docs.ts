/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (GET /doc-spaces/:id/docs)
 *   - 补充: 任务 T2（工具面管理/盘点视角补齐——doc_routes/docs 的 MCP 读通道）
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

/** 后端 docs 列表条目（仅声明 slim 投影与透传所需字段） */
interface DocListItem {
  path: string;
  title: string;
  updatedAt?: string | Date;
  [key: string]: unknown;
}

/** 后端 docs 列表分页信封（shared PaginatedResponse<DocSummary>） */
interface DocListResponse {
  items: DocListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
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
 * list_docs — DocSpace 文档清单（盘点视角，v1.55 任务 T2）
 *
 * 按 spaceName 三层匹配解析 DocSpace → 包装 GET /doc-spaces/:id/docs。
 * 0 或 >1 候选均 isError + candidates，绝不静默挑选。
 *
 * 与 get_docs_overview 的分工：overview 是分类树地图（含图例/路由/token 预算），
 * 本工具是平铺清单——支持分页翻页拉全、pathPrefix/docType/category 过滤，
 * slim 模式只回 path+title+updatedAt（摘要是清单场景的 token 大头）。
 */
export const listDocsTool: CustomTool = {
  tool: {
    name: 'list_docs',
    description:
      'List documents in a DocSpace as a flat paginated inventory (wrapper of GET /doc-spaces/:id/docs). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive). ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Filters: pathPrefix (e.g. "memory/"), category (slug), docType, tag, q (ILIKE on title/path). ' +
      'Paginated: page (default 1) + pageSize (default 20, max 100); response is ' +
      '{items,total,page,pageSize,totalPages,hasNext,hasPrev} — loop on hasNext to fetch everything. ' +
      'slim=true projects each item to {path,title,updatedAt} only (summaries are the token bulk ' +
      'in inventory scenarios). Use get_docs_overview for the categorized map, read_doc for content.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        pathPrefix: {
          type: 'string',
          description: 'Optional: keep docs whose path starts with this prefix (e.g. "docs/").',
        },
        category: {
          type: 'string',
          description: 'Optional: filter by category slug (exact match).',
        },
        docType: {
          type: 'string',
          description:
            'Optional: filter by document type (e.g. "guide", "memory"). Sent to the backend as type=.',
        },
        tag: {
          type: 'string',
          description: 'Optional: keep docs whose tags array contains this tag.',
        },
        q: {
          type: 'string',
          description:
            'Optional: full-text keyword (ILIKE on title + path). Mutually exclusive with exact path lookups.',
        },
        page: {
          type: 'number',
          description: 'Optional: page number (default 1).',
        },
        pageSize: {
          type: 'number',
          description: 'Optional: items per page (default 20, max 100).',
        },
        slim: {
          type: 'boolean',
          description:
            'Optional: project each item to {path,title,updatedAt} only, dropping summary and ' +
            'other metadata to minimize tokens. Default false.',
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

    // 步骤 3：拉取文档清单（过滤/分页参数透传；空值不携带，保持请求干净）
    // 参数名映射：工具面 docType → 后端 type（对齐 QueryDocDto 既有契约）
    const spaceId = matches[0].id;
    const filterKeys = ['pathPrefix', 'category', 'tag', 'q', 'page', 'pageSize'] as const;
    const params: Record<string, unknown> = {};
    for (const key of filterKeys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== '') params[key] = value;
    }
    if (args.docType !== undefined && args.docType !== null && args.docType !== '') {
      params.type = args.docType;
    }

    try {
      const resp = await client.request<DocListResponse>('GET', `/doc-spaces/${spaceId}/docs`, {
        params,
      });

      // slim 模式：只保留 path+title+updatedAt（摘要是清单场景的 token 大头）；
      // 分页元信息原样保留，调用方仍可循环翻页拉全
      if (args.slim === true) {
        const slimItems = (resp.items ?? []).map((item) => ({
          path: item.path,
          title: item.title,
          updatedAt: item.updatedAt,
        }));
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ...resp, items: slimItems, slim: true }) },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_docs');
    }
  },
};
