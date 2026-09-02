/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 懒加载目录树（v1.70.0-dev）：按 prefix 分层浏览空间目录——
 *     当前层直接子目录（递归 docCount/latestDocAt 聚合）+ 当前层直挂文档
 *     （slim 分页），子目录内容由下一层请求（prefix = folder.path）展开。
 *
 * [代码职责]
 *   - 本文件实现 MCP 语义工具 list_doc_tree：spaceName 三层匹配解析 →
 *     GET /doc-spaces/:id/docs/tree（prefix/sort/docsLimit/docsOffset/
 *     foldersLimit/foldersOffset 透传）→ 结构化错误透传。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（GET /doc-spaces/:id/docs/tree
 *     小节——参数表/响应结构/错误码，v1.70.0-dev 懒加载目录树契约）
 *   - 补充: plan docspace-lazy-tree-v1.md（端点契约节——SQL 形态硬约束、
 *     folders/docs 分页信封语义、sort 只影响 folders）
 *
 * [关键不变量]
 *   - 响应信封：{ prefix, folders: {items,total,hasMore}, docs: {items,total,hasMore} }
 *     ——folders 与 docs 各自独立分页，total 不受 limit/offset 影响；
 *   - folder.path 含尾部 "/"（如 "memory/2026-08-29/"），是下一层请求的
 *     prefix 直接取值，禁止拼接/改写；
 *   - sort 只影响 folders 排序（recent=latestDocAt DESC / name=段名 ASC），
 *     docs 恒按 path ASC；
 *   - 参数透传空值不携带（对齐 list_docs 先例），保持请求干净。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc.controller.ts — findTree 路由
 *     （权限 ensureCan(space, actor, 'read')，与 findAll 同款）
 *   - apps/backend/src/modules/docspace/doc.service.ts — findTree SQL 实现
 *     （WHERE 只用 LIKE、substring/split_part 只进 SELECT/GROUP BY）
 *   - packages/shared/src/dto/docspace-response.dto.ts — DocTreeResponse/
 *     DocTreeFolder/DocTreeDoc/DocTreePage 契约类型
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
import { DOC_TREE_SORT_VALUES } from '@agent-chamber/shared';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface DocSpaceListItem {
  id: string;
  name: string;
  slug: string;
  [key: string]: unknown;
}

/** 目录树子目录项（后端 DocTreeFolder） */
interface DocTreeFolder {
  /** 子目录完整路径（含尾部 /，如 "memory/2026-08-29/"）——下一层请求的 prefix */
  path: string;
  /** 子目录段名（末段） */
  name: string;
  /** 该子目录下（含递归后代）未删文档数 */
  docCount: number;
  /** 该子目录下（含递归后代）最近更新的未删文档时间（无文档时 null） */
  latestDocAt: string | null;
}

/** 目录树直挂文档项（后端 DocTreeDoc，slim 投影） */
interface DocTreeDoc {
  id: string;
  path: string;
  title: string;
  docType?: string | null;
  updatedAt?: string | Date;
}

/** 目录树分页信封（folders/docs 共用；total 不受 limit/offset 影响） */
interface DocTreePage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** 目录树响应（后端 DocTreeResponse） */
interface DocTreeResponse {
  /** 归一化后的前缀（去前导 /、非空补尾部 /；根层为 ""） */
  prefix: string;
  /** 当前层子目录（分页） */
  folders: DocTreePage<DocTreeFolder>;
  /** 当前层直挂文档（slim，分页） */
  docs: DocTreePage<DocTreeDoc>;
}

// ---------------------------------------------------------------------------
// 工具函数（照抄 list-docs.ts 的 matchByLayers / resolutionFailureBody）
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
 * list_doc_tree — DocSpace 懒加载目录树（按层钻取，v1.70.0-dev）
 *
 * 按 spaceName 三层匹配解析 DocSpace → 包装 GET /doc-spaces/:id/docs/tree。
 * 0 或 >1 候选均 isError + candidates，绝不静默挑选。
 *
 * 与 list_docs 的分工：list_docs 是平铺清单（可过滤/翻页拉全），本工具是
 * 分层目录——一次调用只返回「当前层」：直接子目录（含递归 docCount/
 * latestDocAt 聚合）+ 直挂文档（slim 分页）。钻取下一层用返回的
 * folder.path 作为下一次调用的 prefix（目录树懒加载，避免全量拉取）。
 */
export const listDocTreeTool: CustomTool = {
  tool: {
    name: 'list_doc_tree',
    description:
      'Lazy directory-tree browsing of a DocSpace (wrapper of GET /doc-spaces/:id/docs/tree). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive). ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Drill down level by level: each call returns the DIRECT sub-folders of the given prefix ' +
      '(each folder carries recursive docCount/latestDocAt aggregation) plus the direct docs ' +
      'attached at this level (slim projection, paginated). ' +
      "Use a returned folder.path as the next call's prefix to descend one level — " +
      'folders are NOT expanded recursively, so large spaces stay cheap. ' +
      'prefix defaults to "" (root level); server normalizes it (leading "/" stripped, ' +
      'trailing "/" appended when non-empty). ' +
      'sort=recent (default, folders by latestDocAt DESC) | name (folders by segment name ASC); ' +
      'docs are always ordered by path ASC. ' +
      'docsLimit max 200 / foldersLimit max 500 (400 when exceeded). ' +
      'Response: { prefix, folders: {items,total,hasMore}, docs: {items,total,hasMore} } — ' +
      'folders and docs page independently; total is the full count at this level, ' +
      'unaffected by limit/offset. ' +
      'For flat inventory (filters, full pagination) use list_docs; for content use read_doc.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        prefix: {
          type: 'string',
          description:
            'Optional: path prefix to browse (default "" = root level). ' +
            'Pass a folder.path from a previous call to descend into that folder.',
        },
        sort: {
          type: 'string',
          // 枚举值从 shared DOC_TREE_SORT_VALUES 单源取值（防 backend DTO 加值后此处漂移）
          enum: [...DOC_TREE_SORT_VALUES],
          description:
            'Optional: folder sort — recent (default, latestDocAt DESC) | name (segment name ASC).',
        },
        docsLimit: {
          type: 'number',
          description: 'Optional: max direct docs per page (default 50, max 200).',
        },
        docsOffset: {
          type: 'number',
          description: 'Optional: docs offset (default 0).',
        },
        foldersLimit: {
          type: 'number',
          description: 'Optional: max folders per page (default 200, max 500).',
        },
        foldersOffset: {
          type: 'number',
          description: 'Optional: folders offset (default 0).',
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

    // 步骤 3：拉取目录树（prefix/sort/分页参数透传；空值不携带，保持请求干净）
    const spaceId = matches[0].id;
    const treeKeys = [
      'prefix',
      'sort',
      'docsLimit',
      'docsOffset',
      'foldersLimit',
      'foldersOffset',
    ] as const;
    const params: Record<string, unknown> = {};
    for (const key of treeKeys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== '') params[key] = value;
    }

    try {
      const resp = await client.request<DocTreeResponse>(
        'GET',
        `/doc-spaces/${spaceId}/docs/tree`,
        {
          params,
        },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'list_doc_tree');
    }
  },
};
