/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ①
 *   - 补充: docs/platform-mcp.md §2.1 + 看板任务 fdc1851b（Batch F：me 投影 + 紧凑序列化）
 *   - 补充: plan forge-jubilee-robin（WS-C：两段式编排 + 12 字段投影 + unread/blockers 降级）
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
import { omitFields, truncateField, SNIPPET_MAX_CHARS } from './project';
import { TaskStatus } from '@agent-chamber/shared';

/**
 * 活跃任务缺省状态集（get_my_briefing 的 active tasks 口径）。
 *
 * backlog 是平台的默认待办状态（看板默认列），必须纳入活跃任务，
 * 否则 Agent 会漏掉尚未开工的已分配任务（本地集成验证实测暴露）。
 * 调用方可传 statuses 覆盖（替换而非追加，缺省保持本集合）。
 */
const DEFAULT_ACTIVE_STATUSES: TaskStatus[] = [
  TaskStatus.BACKLOG,
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.BLOCKED,
];

/** 任务/动态数量钳制边界（WS-C 编排层补钳制，现状无钳） */
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

/**
 * activeTasks 12 字段白名单（plan forge-jubilee-robin 目标契约，用户拍板 r2）。
 *
 * 只透传 Agent 消费模型需要的字段；description/list/board/customFields/position
 * 等多余键一律剔除（87% 的 72K 体积来自每条 task 重复内嵌完整 list.board）。
 */
const ACTIVE_TASK_KEPT_FIELDS = [
  'id',
  'title',
  'status',
  'priority',
  'labels',
  'boardId',
  'boardName',
  'listId',
  'listName',
  'dueDate',
  'updatedAt',
] as const;

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
 * get_my_briefing — Agent 启动简报
 *
 * 一次调用建立工作上下文：获取当前 Agent 信息、活跃任务、未读计数、近期动态。
 * 替代 get_me + list my tasks + get my activities + unread 多次原子调用。
 *
 * WS-C（plan forge-jubilee-robin）两段式编排：
 * - 阶段 1：me 先行（tasks 的 assigneeId 依赖 me.id），随后 tasks/activities/unread 三路并行
 * - 阶段 2：tasks 非空时补查 blockers（GET /tasks/blockers/batch?ids=<csv>）
 * - unread/blockers 均为非关键路径：失败降级省略对应字段，不挂主流程
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
  topic_controller_get_messages.`,
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
    // 非数字/负数按缺省 300 处理（undefined → 截断侧用默认值）；>50000 钳到 50000
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
    // 空数组同样拒绝——替换默认集后 status 参数为空，后端 /tasks 会退化为
    // "全部状态"查询，静默违背 active tasks 语义（禁止静默语义漂移）。
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
    // 传入时替换默认集合（join 成后端 /tasks 的逗号分隔 status 参数）
    const statusParam = statuses
      ? (statuses as string[]).join(',')
      : DEFAULT_ACTIVE_STATUSES.join(',');

    try {
      // 阶段 1：me 先行（tasks 的 assigneeId 依赖 me.id），随后 tasks/activities/unread 三路并行。
      // unread 是非关键路径：.catch 降级为 undefined（省略 unreadCounts 字段，防部署时序
      // 404 拖垮整个 briefing，对齐 get-topic-digest 先例）。Promise.resolve 包裹：
      // 保证非 promise 返回值（如测试 mock）也不会同步抛 TypeError。
      const me = await client.request<Record<string, unknown>>('GET', '/agents/me');
      const [activeTasks, recentActivities, unread] = await Promise.all([
        client.request<{ items: unknown[]; total: number }>('GET', '/tasks', {
          params: {
            assigneeId: me.id as string,
            status: statusParam,
            pageSize: taskLimit,
            // WS-A 新增 opt-in 排序：in_progress > todo > blocked > backlog > 其余
            sort: 'statusPriority',
          },
        }),
        client.request<unknown[]>('GET', '/agents/me/activities', {
          params: { limit: activityLimit },
        }),
        Promise.resolve(client.request<unknown[]>('GET', '/agents/me/unread')).catch(
          () => undefined,
        ),
      ]);

      // 阶段 2：blockers 补查（GET /tasks/blockers/batch?ids=<csv>，返回 Record<taskId, boolean>）。
      // 非关键路径：失败降级为 undefined（hasBlockers 省略，不挂主流程）；空 items 跳过。
      const taskItems = Array.isArray(activeTasks.items) ? activeTasks.items : [];
      let blockersMap: Record<string, boolean> | undefined;
      if (taskItems.length > 0) {
        const ids = taskItems
          .map((t) => (t as Record<string, unknown>).id as string)
          .filter(Boolean)
          .join(',');
        blockersMap = await Promise.resolve(
          client.request<Record<string, boolean>>('GET', '/tasks/blockers/batch', {
            params: { ids },
          }),
        ).catch(() => undefined);
      }

      // activeTasks：12 字段白名单投影 + hasBlockers 合并（map 缺失/降级时省略该键，
      // 不补 false——未知 ≠ 无 blocker）
      const items = taskItems.map((t) => {
        const task = t !== null && typeof t === 'object' ? (t as Record<string, unknown>) : {};
        const projected: Record<string, unknown> = {};
        for (const field of ACTIVE_TASK_KEPT_FIELDS) {
          if (task[field] !== undefined) {
            projected[field] = task[field];
          }
        }
        if (blockersMap !== undefined) {
          const hasBlockers = blockersMap[task.id as string];
          if (hasBlockers !== undefined) {
            projected.hasBlockers = hasBlockers;
          }
        }
        return projected;
      });

      // recentActivities：原形状透传，仅逐项截断 content（无 content 的 task 型条目
      // 经 truncateField 的 typeof string 检查天然豁免，不打 contentTruncated）
      const activities = Array.isArray(recentActivities)
        ? recentActivities.map((a) => {
            const item =
              a !== null && typeof a === 'object' ? { ...(a as Record<string, unknown>) } : {};
            truncateField(item, 'content', maxContentLength ?? SNIPPET_MAX_CHARS);
            return item;
          })
        : recentActivities;

      const result: Record<string, unknown> = {
        me: omitFields(me, ['avatarUrl', 'apiKeyPrefix']),
        // 只透传 {items, total}，砍分页信封其余键（page/pageSize/totalPages/hasNext/hasPrev）
        activeTasks: { items, total: activeTasks.total },
        ...(unread !== undefined ? { unreadCounts: unread } : {}),
        recentActivities: activities,
      };

      return {
        content: [
          {
            type: 'text',
            // Batch F（看板任务 fdc1851b）：me 剔除 avatarUrl/apiKeyPrefix（人类 UI / 认证元数据，
            // 对 Agent 消费无价值），其余字段原样保留；全量输出改紧凑序列化（去 pretty-print 缩进）
            text: JSON.stringify(result),
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
