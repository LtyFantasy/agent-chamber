/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ①
 *   - 补充: docs/platform-mcp.md §2.1 + 看板任务 fdc1851b（Batch F：me 投影 + 紧凑序列化）
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
import { PlatformApiClient, PlatformApiError } from '../platform-client';
import { omitFields } from './project';

/**
 * get_my_briefing — Agent 启动简报
 *
 * 一次调用建立工作上下文：获取当前 Agent 信息、活跃任务、近期动态。
 * 替代 get_me + list my tasks + get my activities 三次原子调用。
 */
export const getMyBriefingTool: CustomTool = {
  tool: {
    name: 'get_my_briefing',
    description:
      'Agent startup briefing: fetch the current agent profile, my active tasks (backlog/todo/in_progress/blocked), ' +
      'and recent activities. Replaces 3 individual API calls in a single round trip.',
    inputSchema: {
      type: 'object',
      properties: {
        taskLimit: {
          type: 'integer',
          description: 'Max active tasks to return (1~50, default 20)',
        },
        activityLimit: {
          type: 'integer',
          description: 'Number of recent activities to return (1~50, default 10)',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const taskLimit = (args.taskLimit as number) ?? 20;
    const activityLimit = (args.activityLimit as number) ?? 10;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    try {
      // 步骤 1：获取当前 Agent 信息
      const me = await client.request<Record<string, unknown>>('GET', '/agents/me');

      // 步骤 2 & 3：并行查询活跃任务 + 近期动态
      const [activeTasks, recentActivities] = await Promise.all([
        client.request<{ items: unknown[]; total: number }>('GET', '/tasks', {
          params: {
            assigneeId: me.id as string,
            // backlog 是平台的默认待办状态（看板默认列），必须纳入活跃任务，
            // 否则 Agent 会漏掉尚未开工的已分配任务（本地集成验证实测暴露）
            status: 'backlog,todo,in_progress,blocked',
            pageSize: taskLimit,
          },
        }),
        client.request<unknown[]>('GET', '/agents/me/activities', {
          params: { limit: activityLimit },
        }),
      ]);

      return {
        content: [
          {
            type: 'text',
            // Batch F（看板任务 fdc1851b）：me 剔除 avatarUrl/apiKeyPrefix（人类 UI / 认证元数据，
            // 对 Agent 消费无价值），其余字段原样保留；全量输出改紧凑序列化（去 pretty-print 缩进）
            text: JSON.stringify({
              me: omitFields(me, ['avatarUrl', 'apiKeyPrefix']),
              activeTasks,
              recentActivities,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_me');
    }
  },
};

/**
 * 统一的 PlatformApiError 兜底处理
 *
 * 将上游错误归一化为 isError:true + failedStep 的文本结果，
 * 格式对齐 automcp http-proxy.formatErrorResponse。
 *
 * @param err        - 捕获的错误
 * @param failedStep - 失败的编排步骤名称
 * @param partial    - 可选的已完成步骤的部分结果（用于部分成功语义）
 */
export function handlePlatformError(
  err: unknown,
  failedStep: string,
  partial?: Record<string, unknown>,
): ToolCallResult {
  if (err instanceof PlatformApiError) {
    const body: Record<string, unknown> = {
      error: true,
      failedStep,
      status: err.status,
      message: err.message,
      ...(err.code !== undefined ? { code: err.code } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
      ...partial,
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
  }

  // 未知异常兜底
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          failedStep,
          message: err instanceof Error ? err.message : String(err),
        }),
      },
    ],
    isError: true,
  };
}
