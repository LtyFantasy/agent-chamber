/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ②
 *   - 补充: 看板任务 fdc1851b（Batch F：紧凑序列化）
 *   - 补充: plan forge-jubilee-robin（WS-C2' C4：recentComments 截断，commentMaxLength 复用 truncateField）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #9(代理层透传) #11(注释强制) #17(测试契约)
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
import { projectDocSummaries, truncateField } from './project';

/** recentComments 单条 content 截断上限（字符，plan forge-jubilee-robin C4）。超出截到此长度并标记 contentTruncated */
const COMMENT_MAX_CHARS = 500;

/**
 * follow_up_task — 任务跟进全景
 *
 * 一次调用获取任务详情（含关联 docs 摘要投影）+ 活跃阻塞 + 最近讨论，
 * 替代 3 次原子调用。TaskDetail.docs 已在内嵌响应中，直接投影，零新增请求。
 */
export const followUpTaskTool: CustomTool = {
  tool: {
    name: 'follow_up_task',
    description:
      'Task follow-up panorama: fetch task details (with linked docs summary), active blockers, ' +
      'and recent comments. Replaces 3 individual API calls in a single round trip. ' +
      'Linked docs are projected from the embedded TaskDetail.docs field — zero extra requests. ' +
      'recentComments content is truncated to commentMaxLength chars (default 500, 0=full, max 50000) ' +
      'with per-item contentTruncated; full text via task_controller_get_comments.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID (UUID)',
        },
        commentLimit: {
          type: 'integer',
          description: 'Number of recent comments to return (1~50, default 10)',
        },
        commentMaxLength: {
          type: 'integer',
          description:
            'Max chars per recent comment content before truncation (default 500; ' +
            '0 = no truncation, full text; max 50000). Full text via task_controller_get_comments.',
        },
      },
      required: ['taskId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const taskId = args.taskId as string;
    const commentLimit = (args.commentLimit as number) ?? 10;

    // commentMaxLength：recentComments content 截断长度（可选，缺省 500 行为不变）。
    // 防御性解析（MCP 层无 DTO 校验，必须 handler 内兜底，照 get-topic-digest.ts:115-127 先例）：
    // 非数字/负数按缺省 500 处理；>50000 钳到 50000（防止放量返回超长字符串）；
    // 0 是合法值 = 不截断返全文。
    let commentMaxLength: number | undefined;
    const rawCommentMaxLength = args.commentMaxLength;
    if (
      typeof rawCommentMaxLength === 'number' &&
      Number.isFinite(rawCommentMaxLength) &&
      rawCommentMaxLength >= 0
    ) {
      commentMaxLength = Math.min(Math.floor(rawCommentMaxLength), 50000);
    }
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    try {
      // 步骤 1：获取任务详情
      const task = await client.request<Record<string, unknown>>('GET', `/tasks/${taskId}`);

      // 投影内嵌关联文档摘要（零新增请求）
      if (Array.isArray(task.docs)) {
        task.docs = projectDocSummaries(task.docs as Array<Record<string, unknown>>);
      }

      // 步骤 2 & 3：并行查阻塞 + 评论
      const [blockers, recentComments] = await Promise.all([
        client.request<unknown[]>('GET', `/tasks/${taskId}/blockers`),
        client.request<unknown[]>('GET', `/tasks/${taskId}/comments`, {
          params: { limit: commentLimit },
        }),
      ]);

      // 评论逐条截断：content 超过 commentMaxLength（缺省 500）截到该长度 + contentTruncated 标记；
      // ≤500 原样不加标记；0 是「不截断」哨兵（truncateField 语义）返全文。
      // 需要全文的 Agent 自行用原子工具 task_controller_get_comments 翻页。
      const maxChars = commentMaxLength ?? COMMENT_MAX_CHARS;
      for (const comment of recentComments) {
        if (comment !== null && typeof comment === 'object') {
          truncateField(comment as Record<string, unknown>, 'content', maxChars);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ task, blockers, recentComments }),
          },
        ],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_task');
    }
  },
};
