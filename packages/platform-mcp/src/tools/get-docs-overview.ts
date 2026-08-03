/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan §5 W5 (get_docs_overview 契约)
 *   - 补充: plan §1.1-13 (sectionId 不稳定), plan §4.3 (overview 端点)
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
// 工具函数（照抄 create-task.ts 的 matchByLayers / resolutionFailureBody）
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
 * get_docs_overview — DocSpace 紧凑地图
 *
 * 按 spaceName 三层匹配解析 DocSpace → 返回 overview 紧凑地图。
 * 0 或 >1 候选均 isError + candidates，绝不静默挑选。
 */
export const getDocsOverviewTool: CustomTool = {
  tool: {
    name: 'get_docs_overview',
    description:
      'Get a compact overview map of a DocSpace. ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive). ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Returns categories → docs[{path,title,summary,docType,tags,tokenEstimate}] + uncategorized docs. ' +
      'Truncated flag is passed through when token cap is exceeded. ' +
      'Default is the full map; filtering (v1.38): excludeType=memory filters diary-type noise out, ' +
      'type=guide,reference shows only curated docs, applySpaceDefaults=false ignores space-level default filters. ' +
      'The response echoes effective filters as appliedFilters.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        type: {
          type: 'string',
          description:
            'Optional: comma-separated docType whitelist (e.g. "guide,reference"). ' +
            'Combined with excludeType = include-then-exclude (intersection).',
        },
        excludeType: {
          type: 'string',
          description:
            'Optional: comma-separated docType blacklist (e.g. "memory" to filter diary noise).',
        },
        category: {
          type: 'string',
          description:
            'Optional: comma-separated category slug whitelist; when set, the uncategorized section is omitted.',
        },
        excludeCategory: {
          type: 'string',
          description: 'Optional: comma-separated category slug blacklist.',
        },
        tag: {
          type: 'string',
          description: 'Optional: keep docs whose tags array contains this tag.',
        },
        pathPrefix: {
          type: 'string',
          description: 'Optional: keep docs whose path starts with this prefix (e.g. "docs/").',
        },
        maxTokens: {
          type: 'number',
          description: 'Optional: override the ~4000 default token cap (range 500–16000).',
        },
        applySpaceDefaults: {
          type: 'boolean',
          description:
            'Optional: apply space-level default filters (settings.overviewFilter). Default true; ' +
            'pass false to ignore space defaults (escape hatch for "I want everything this time").',
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

    // 步骤 3：获取 overview（可选过滤参数透传；空值不携带，保持请求干净）
    const spaceId = matches[0].id;
    const filterKeys = [
      'type',
      'excludeType',
      'category',
      'excludeCategory',
      'tag',
      'pathPrefix',
      'maxTokens',
      'applySpaceDefaults',
    ] as const;
    const params: Record<string, unknown> = {};
    for (const key of filterKeys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== '') params[key] = value;
    }
    try {
      const overview = await client.request<Record<string, unknown>>(
        'GET',
        `/doc-spaces/${spaceId}/overview`,
        { params },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(overview) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_overview');
    }
  },
};
