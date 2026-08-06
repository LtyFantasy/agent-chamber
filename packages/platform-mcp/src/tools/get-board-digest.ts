/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-info-online-batch-a.md §4 A2-5（get_board_digest 契约）
 *   - 补充: docs/api-definition.md §7（GET /boards/:id/digest 端点契约与 docs 段权限语义）
 *   - 模式参照: get-docs-overview.ts（三层匹配 + 透传 + 紧凑 JSON）
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

interface BoardListItem {
  id: string;
  name: string;
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
 * get_board_digest — 项目总揽（Board Digest）
 *
 * 按 boardId 直接取，或按 boardName 三层匹配解析 → 返回 GET /boards/:id/digest
 * 实时装配的项目总揽视图（替代 PROJECT.md 人工快照，会话初始化主入口）。
 *
 * boardId / boardName 二缺一必填（同时给时 boardId 优先）。
 * boardName 0 或 >1 候选均 isError + candidates，绝不静默挑选。
 * 响应包含 board.description 图例全文（缺省）；includeDescription=false 省略。
 * limits 段截断时 truncated=true 透传。
 */
export const getBoardDigestTool: CustomTool = {
  tool: {
    name: 'get_board_digest',
    description:
      'Board digest: real-time assembled project overview (v1.41). ' +
      'Replaces the manual PROJECT.md snapshot for session initialization. ' +
      'Resolves boardName via three-layer match (exact → prefix → substring, case-insensitive); ' +
      '0 or >1 candidates returns isError:true + structured candidate info — never silently picks one. ' +
      'Pass boardId (UUID) to skip name resolution; boardId takes priority when both are given. ' +
      'Response includes board description (legend) in full by default; ' +
      'pass includeDescription=false to omit it. ' +
      'Sections: lists / milestones / versions (release version registry: ' +
      'production=currently deployed version, development=in-development version, ' +
      'history=version history with deploy timestamps, total) / metrics (machine facts ' +
      'such as test baselines and MCP tool counts) / priorityDistribution / ' +
      'risks (labels bug|debt) / nextUp / recentDone / docs (bound DocSpace metadata: ' +
      'spaceName + recently updated docs, no bodies). ' +
      'truncated is set when any section was cut by its limit.',
    inputSchema: {
      type: 'object',
      properties: {
        boardId: {
          type: 'string',
          description: 'Board ID (UUID). Either boardId or boardName is required.',
        },
        boardName: {
          type: 'string',
          description:
            'Board name (resolved via three-layer match). Either boardId or boardName is required.',
        },
        openLimit: {
          type: 'integer',
          description: 'Max nextUp items (default 10; 0 = empty)',
        },
        doneLimit: {
          type: 'integer',
          description: 'Max recentDone items (default 5; 0 = empty)',
        },
        riskLimit: {
          type: 'integer',
          description: 'Max risks items (default 10; 0 = empty)',
        },
        docsLimit: {
          type: 'integer',
          description: 'Max docs.recentlyUpdated items (default 5; 0 = empty)',
        },
        versionLimit: {
          type: 'integer',
          description: 'Max versions.history items (default 5; 0 = empty)',
        },
        includeDescription: {
          type: 'boolean',
          description:
            'Include the board description (legend) in the response. Default true; ' +
            'pass false to set description to null.',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 步骤 1：解析 boardId（boardId 优先；缺省时按 boardName 三层匹配）
    let boardId = args.boardId as string | undefined;
    if (!boardId) {
      const boardName = args.boardName as string | undefined;
      if (!boardName) {
        const err = Object.assign(
          new Error('Either "boardId" or "boardName" must be provided.'),
          { isAmbiguous: false },
        );
        const body = resolutionFailureBody(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: true, failedStep: 'resolve_board', ...body }) }],
          isError: true,
        };
      }

      // 候选来源：boards 列表（pageSize=100；board 数超 100 时较老 board 解析不到，已知取舍）
      let boards: BoardListItem[];
      try {
        const resp = await client.request<{ items: BoardListItem[] }>('GET', '/boards', {
          params: { pageSize: 100 },
        });
        boards = resp.items ?? [];
      } catch (err: unknown) {
        return handlePlatformError(err, 'list_boards');
      }

      // 三层匹配解析 boardName
      const { layer, matches } = matchByLayers(boardName, boards, (b) => b.name);

      if (matches.length === 0) {
        const names = boards.map((b) => b.name);
        const err = Object.assign(
          new Error(
            `boardName "${boardName}" did not match any board. ` +
              `Available boards: ${names.length > 0 ? names.join(', ') : '(none)'}`,
          ),
          { isAmbiguous: false, availableNames: names },
        );
        const body = resolutionFailureBody(err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: true, failedStep: 'resolve_board', ...body }),
            },
          ],
          isError: true,
        };
      }

      if (matches.length > 1) {
        const candidates = matches.map((b) => ({ id: b.id, name: b.name }));
        const layerLabel = layer === 1 ? 'exact' : layer === 2 ? 'prefix' : 'substring';
        const err = Object.assign(
          new Error(
            `boardName "${boardName}" matched ${matches.length} boards (${layerLabel}). ` +
              `Please refine: ${candidates.map((c) => c.name).join(', ')}`,
          ),
          { candidates, layer: layerLabel, isAmbiguous: true },
        );
        const body = resolutionFailureBody(err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: true, failedStep: 'resolve_board', ...body }),
            },
          ],
          isError: true,
        };
      }

      boardId = matches[0].id;
    }

    // 步骤 2：获取 digest（limit 参数透传；空值不携带，保持请求干净）
    const filterKeys = [
      'openLimit',
      'doneLimit',
      'riskLimit',
      'docsLimit',
      'versionLimit',
      'includeDescription',
    ] as const;
    const params: Record<string, unknown> = {};
    for (const key of filterKeys) {
      const value = args[key];
      if (value !== undefined && value !== null && value !== '') params[key] = value;
    }
    try {
      const digest = await client.request<Record<string, unknown>>('GET', `/boards/${boardId}/digest`, {
        params,
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(digest) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_board_digest');
    }
  },
};
