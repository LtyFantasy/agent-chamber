/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (POST /doc-spaces/:id/routes)
 *   - 补充: 任务 T3（routes 写三件套入 MCP——高频策展动作免走裸 REST）
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
// 工具函数（照抄 list-doc-routes.ts 的 matchByLayers / resolutionFailureBody）
// ---------------------------------------------------------------------------

/**
 * 三层匹配（大小写不敏感）：① 精确 → ② 前缀 → ③ 子串。
 * 取最先产生匹配的那一层；该层 0 个 → []，>1 个 → 该层全部。
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
 * create_doc_route — 创建意图路由（v1.55 任务 T3）
 *
 * 薄包装 POST /doc-spaces/:id/routes：spaceName 三层匹配解析空间 → 原样透传
 * CreateDocRouteDto 字段。写时校验（doc 归属/headingPath 命中/codeEntry 格式）
 * 由服务端完成，400 结构化错误透传（铁律 #9 不包装）。
 */
export const createDocRouteTool: CustomTool = {
  tool: {
    name: 'create_doc_route',
    description:
      'Create an intent route (doc_route) in a DocSpace — the curated intent→doc navigation entry ' +
      '(wrapper of POST /doc-spaces/:id/routes). ' +
      'Resolves spaceName via three-layer match (exact → prefix → substring, case-insensitive). ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Write-time validation runs server-side: primary/secondary docs must exist in the space ' +
      '(400 DOC_ROUTE_DOC_NOT_FOUND), non-empty headingPath must resolve exactly in the doc sections ' +
      '(400 DOC_ROUTE_HEADING_UNRESOLVED), codeEntry must be a repo-relative path ' +
      '(400 DOC_ROUTE_INVALID_CODE_ENTRY). ' +
      'Use read_doc (outline mode) or list_docs to obtain docIds; headingPath must be the FULL ' +
      'heading path string as shown in outline sections[].headingPath (nested segments use ` § `). ' +
      'Returns the created route row.',
    inputSchema: {
      type: 'object',
      properties: {
        spaceName: {
          type: 'string',
          description: 'DocSpace name (resolved via three-layer match)',
        },
        intent: {
          type: 'string',
          description: 'User intent description ("我要…"), e.g. "我要了解系统架构" (≤200 chars)',
        },
        category: {
          type: 'string',
          description: 'Optional: route group, e.g. "architecture", "troubleshooting" (≤100 chars)',
        },
        primaryDocId: {
          type: 'string',
          description: 'Primary doc ID (UUID) — first jump target; must exist in the space',
        },
        primaryHeadingPath: {
          type: 'string',
          description:
            'Optional: anchor in the primary doc (exact match on doc_sections heading_path; ' +
            'omit for doc-level jump)',
        },
        secondaryDocId: {
          type: 'string',
          description: 'Optional: secondary doc ID (UUID) for follow-up reading',
        },
        secondaryHeadingPath: {
          type: 'string',
          description: 'Optional: anchor in the secondary doc',
        },
        codeEntry: {
          type: 'string',
          description:
            'Optional: code entry point — repository-relative path (no absolute path or `..` segments)',
        },
        codeEntryType: {
          type: 'string',
          enum: ['exact', 'pattern'],
          description:
            'Optional: codeEntry kind (default "exact"). "exact" = precise file/dir path, health ' +
            'recheck validates it against the repo manifest. "pattern" = glob-style pattern ' +
            '(e.g. `apps/web/app/**` + `/page.tsx`), existence check is EXEMPTED during recheck ' +
            '(health marked exempt, never reported broken). Only meaningful when codeEntry is set.',
        },
        sortOrder: {
          type: 'integer',
          description: 'Optional: curation weight (ASC within space, default 0, range 0..10000)',
        },
      },
      required: ['spaceName', 'intent', 'primaryDocId'],
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

    // 步骤 3：透传 CreateDocRouteDto 字段（空值不携带，保持请求干净；字段名与 DTO 一一对应）
    const spaceId = matches[0].id;
    const bodyKeys = [
      'intent',
      'category',
      'primaryDocId',
      'primaryHeadingPath',
      'secondaryDocId',
      'secondaryHeadingPath',
      'codeEntry',
      'codeEntryType',
      'sortOrder',
    ] as const;
    const body: Record<string, unknown> = {};
    for (const key of bodyKeys) {
      const value = args[key];
      if (value !== undefined && value !== null) body[key] = value;
    }

    try {
      const resp = await client.request<Record<string, unknown>>(
        'POST',
        `/doc-spaces/${spaceId}/routes`,
        { body },
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'create_doc_route');
    }
  },
};
