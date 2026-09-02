/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: 线上 docs/api-definition.md §5 Agents（briefing 端点小节）
 *   - 补充: plan captain-atom-crimson-avenger-rocket-dc.md §2.4 — MCP 薄透传
 *     （编排/投影/降级已后端化 AgentService.getMyBriefing，本层退化为单次
 *     GET /agents/me/briefing 透传）
 *   - 历史: plan forge-jubilee-robin（WS-C 两段式编排 + 12 字段投影 + 降级，
 *     2026-08-29 后端化后本层不再实现）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #21(双层校验)
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
import { TaskStatus } from '@agent-chamber/shared';

/** 任务/动态数量钳制边界（透传前钳制，后端 DTO 越界 400 严格语义） */
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

/**
 * 数量参数钳制：非数字/非有限值回退缺省，其余钳到 [1, 50]。
 *
 * @param raw      - 调用方传入的原始值
 * @param fallback - 非法值回退的缺省（taskLimit=20 / activityLimit=10）
 */
function clampLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.floor(raw)));
}

/**
 * get_my_briefing — Agent 启动简报（薄透传 GET /agents/me/briefing）
 *
 * 一次调用建立工作上下文：获取当前 Agent 信息、活跃任务、未读计数、近期动态。
 * 替代 get_me + list my tasks + get my activities + unread 多次原子调用。
 *
 * 编排已后端化（AgentService.getMyBriefing，v1.65 report_task_result 先例）：
 * - 后端负责 me 白名单投影（omit avatarUrl/apiKeyPrefix）、activeTasks 12 字段
 *   投影 + hasBlockers 补查、recentActivities content 截断、unread/blockers
 *   非关键路径降级（键省略）
 * - 本层只做参数校验/钳制 + 单次请求 + 响应透传，成功路径输出契约逐字段不变
 */
export const getMyBriefingTool: CustomTool = {
  tool: {
    name: 'get_my_briefing',
    description: `Agent startup briefing: current agent profile, my active tasks (slim
projection), unread message counts across my topics, and recent activities.
Replaces 4+ individual API calls in one round trip. ~10K chars at defaults.

Response contract:
- me: identity card (avatarUrl/apiKeyPrefix omitted)
- activeTasks: {items, total}. items carry only id/title/status/priority/
  labels/boardId/boardName/listId/listName/dueDate/updatedAt/hasBlockers.
  items may be fewer than total (default 20, max 50 via taskLimit) — fetch
  the complete list via task_controller_find_all with the same filters.
  hasBlockers=true means unresolved blockers exist even when status is not
  blocked; use unblocked=true on task_controller_find_all for actionable only.
- unreadCounts: [{topicId, topicName, unreadCount}] — only topics with
  unreadCount>0 (max 50, count desc). Counts INCLUDE messages sent by
  myself (read cursor advances only via get_topic_digest default markRead
  or explicit mark_topic_read); get_topic_digest(markRead=true) resets
  them; snapshot at call time. Topics only: task comments are not covered.
- recentActivities: my recent output; content truncated to maxContentLength
  chars (default 300, 0=full, max 50000) with per-item contentTruncated.
  Full text via follow_up_task / task_controller_get_comments /
  topic_controller_get_messages.

Degradation semantics: unreadCounts/hasBlockers keys are OMITTED on
non-critical-path failure (≠ no unread / no blockers); [] means truly no
unread.`,
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
        statuses: {
          type: 'array',
          items: { type: 'string', enum: Object.values(TaskStatus) },
          description:
            'Active task statuses to include (default: backlog/todo/in_progress/blocked). ' +
            'Pass to override the default set (replaces, not appends).',
        },
        maxContentLength: {
          type: 'integer',
          description:
            'Max chars per recent activity content before truncation ' +
            '(default 300; 0 = no truncation, full text; recommended max 50000). ' +
            'Only affects recentActivities.',
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const taskLimit = clampLimit(args.taskLimit, 20);
    const activityLimit = clampLimit(args.activityLimit, 10);
    const statuses = args.statuses as unknown;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // maxContentLength：recentActivities content 截断长度（可选，缺省 300 行为不变）。
    // 防御性解析（MCP 层无 DTO 校验，必须 handler 内兜底，照 get-topic-digest 先例）：
    // 非数字/负数按缺省 300 处理（undefined → 不传，后端用缺省）；>50000 钳到 50000
    // （防止放量返回超长字符串）；0 是合法值 = 不截断返全文。
    let maxContentLength: number | undefined;
    const rawMaxContentLength = args.maxContentLength;
    if (
      typeof rawMaxContentLength === 'number' &&
      Number.isFinite(rawMaxContentLength) &&
      rawMaxContentLength >= 0
    ) {
      maxContentLength = Math.min(Math.floor(rawMaxContentLength), 50000);
    }

    // 格式校验（铁律 #21）：statuses 必须是合法 TaskStatus 枚举值数组。
    // automcp 不做运行时参数校验，非法值在此快速失败返回 400，不发起任何请求。
    // 空数组同样拒绝——替换默认集后 status 参数为空，后端会退化为"全部状态"
    // 查询，静默违背 active tasks 语义（禁止静默语义漂移）。
    if (statuses !== undefined) {
      const valid =
        Array.isArray(statuses) &&
        statuses.length > 0 &&
        statuses.every(
          (s) => typeof s === 'string' && (Object.values(TaskStatus) as string[]).includes(s),
        );
      if (!valid) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: true,
                failedStep: 'validate_statuses',
                status: 400,
                message: `statuses must be a non-empty array of TaskStatus values (${Object.values(TaskStatus).join(', ')}).`,
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // 薄透传：非 undefined 字段原样转发（statuses 数组 → 逗号分隔字符串，照
    // report-task-result 字段透传方式）。缺省不传 → 后端用缺省集
    // （backlog/todo/in_progress/blocked）与缺省 limit，行为与旧编排等价。
    const params: Record<string, unknown> = {};
    if (statuses !== undefined) params.statuses = (statuses as string[]).join(',');
    if (args.taskLimit !== undefined) params.taskLimit = taskLimit;
    if (args.activityLimit !== undefined) params.activityLimit = activityLimit;
    if (maxContentLength !== undefined) params.maxContentLength = maxContentLength;

    try {
      const result = await client.request<Record<string, unknown>>('GET', '/agents/me/briefing', {
        params,
      });
      return {
        content: [
          {
            type: 'text',
            // 响应原样透传（紧凑序列化，无 pretty-print 缩进）
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: unknown) {
      // failedStep 从 'get_me' 改为 'get_my_briefing' 是刻意修正（2026-08-29）：
      // 编排时代任何步骤失败都误标 get_me（旧实现 get-my-briefing.ts:286），
      // 薄透传后单一端点，failedStep 必须指向真实端点
      return handlePlatformError(err, 'get_my_briefing');
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
