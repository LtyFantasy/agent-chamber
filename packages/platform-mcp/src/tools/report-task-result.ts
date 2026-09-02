/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ⑤
 *   - 补充: docs/api-definition.md §7 Tasks（POST /tasks/:id/report 端点）
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
import { TaskStatus } from '@agent-chamber/shared';

/**
 * report_task_result — 任务结果汇报（薄透传 POST /tasks/:id/report）
 *
 * 三步编排（发评论→改状态→关联文档）已后端化为 TaskService.reportResult；
 * 本工具只做参数透传 + 响应透传，保留既有返回形状 {task, comment?, docLinks?}，
 * 并透传后端幂等标记 idempotentReplay（同 clientRequestId 重试时返回首次快照）。
 *
 * 评论拼接规则（后端执行，本工具不再本地拼接）：
 * - 仅 comment → 评论文本 = comment
 * - 仅 commitSha → 评论文本 = "Commit: <sha>"
 * - 二者都有 → 评论文本 = comment + "\n\nCommit: <sha>"
 */
export const reportTaskResultTool: CustomTool = {
  tool: {
    name: 'report_task_result',
    description:
      'Report task result: post a work-result comment (optional, can include a commit SHA) ' +
      'and update the task status. Comment is posted first, then status is updated — ' +
      'producing a logical timeline. ' +
      'Optional docIds: after report succeeds, link each docId to the task. ' +
      'Per-doc failures are embedded in docLinks.failed — never fails the whole report. ' +
      'Optional clientRequestId: same actor + same key retries return the first response ' +
      'snapshot (idempotentReplay: true) without re-posting the comment.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID (UUID, required)',
        },
        status: {
          type: 'string',
          description: 'Target status (required)',
          // 枚举值从 shared TaskStatus 单源取值（防 backend DTO 加值后此处漂移）
          enum: Object.values(TaskStatus),
        },
        comment: {
          type: 'string',
          description:
            'Report content (optional). At least one of comment or commitSha must be provided ' +
            'for a comment to be posted.',
        },
        commitSha: {
          type: 'string',
          description: 'Associated commit SHA, appended to the comment text (optional)',
        },
        docIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: array of document IDs (UUIDs) to link to this task. ' +
            'Each doc is linked via the report endpoint; single failures are embedded in ' +
            'docLinks.failed — the main report is not affected.',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Idempotency key (optional, 1–64 chars). Retry with the same key returns the ' +
            'first response snapshot with idempotentReplay: true — no duplicate comment.',
        },
      },
      required: ['taskId', 'status'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 薄透传：非 undefined 字段原样转发，评论拼接/编排全由后端承担
    const body: Record<string, unknown> = { status: args.status };
    if (args.comment !== undefined) body.comment = args.comment;
    if (args.commitSha !== undefined) body.commitSha = args.commitSha;
    if (args.docIds !== undefined) body.docIds = args.docIds;
    if (args.clientRequestId !== undefined) body.clientRequestId = args.clientRequestId;

    try {
      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/tasks/${args.taskId}/report`,
        { body },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      // 上游错误透传（status/code/details 保留，铁律 #9）；后端已整体编排，
      // 单一 failedStep 标记为 report
      return handlePlatformError(err, 'report_task_result');
    }
  },
};
