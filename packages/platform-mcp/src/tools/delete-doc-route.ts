/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DELETE /doc-routes/:id)
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
// 工具定义
// ---------------------------------------------------------------------------

/**
 * delete_doc_route — 删除意图路由（v1.55 任务 T3）
 *
 * 薄包装 DELETE /doc-routes/:id：routeId 直接定位（list_doc_routes 拿 id）。
 * 硬删路由行，不影响被引用文档（bare-uuid 链接无 FK）。404 DOC_ROUTE_NOT_FOUND 透传。
 */
export const deleteDocRouteTool: CustomTool = {
  tool: {
    name: 'delete_doc_route',
    description:
      'Delete an intent route (doc_route) by routeId (wrapper of DELETE /doc-routes/:id). ' +
      'Get the routeId from list_doc_routes. Hard-deletes the route row only — referenced docs are ' +
      'untouched (bare-uuid links, no FK). Route not found → 404 DOC_ROUTE_NOT_FOUND. ' +
      'Returns {deleted:true}.',
    inputSchema: {
      type: 'object',
      properties: {
        routeId: {
          type: 'string',
          description: 'DocRoute ID (UUID) — from list_doc_routes',
        },
      },
      required: ['routeId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const routeId = args.routeId as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // routeId 必填守卫（inputSchema required 之外的防御：MCP 客户端不保证强制）
    if (!routeId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: true, message: 'routeId is required' }),
          },
        ],
        isError: true,
      };
    }

    try {
      const resp = await client.request<Record<string, unknown>>(
        'DELETE',
        `/doc-routes/${routeId}`,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(resp) }],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'delete_doc_route');
    }
  },
};
