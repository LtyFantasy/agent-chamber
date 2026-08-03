/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ⑤
 *   - 补充: 看板任务 fdc1851b（Batch F：紧凑序列化）
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
import { handlePlatformError } from './get-my-briefing';

/**
 * report_task_result — 任务结果汇报
 *
 * 工作流最后一公里：发表评论（可选）→ 更新任务状态 → 关联文档（可选）。
 * 仅当 comment 或 commitSha 提供时才发评论，二者皆缺省时跳过评论直接改状态。
 * docIds 可选：report 成功后逐个 POST /tasks/:id/doc-links，单条失败内嵌不拖垮主体。
 *
 * 拼接规则：
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
      'Per-doc failures are embedded in docLinks.failed — never fails the whole report.',
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
          enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked', 'archived'],
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
            'Each doc is linked via POST /tasks/:id/doc-links. Single failures are embedded in ' +
            'docLinks.failed — the main report is not affected.',
        },
      },
      required: ['taskId', 'status'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const taskId = args.taskId as string;
    const status = args.status as string;
    const comment = args.comment as string | undefined;
    const commitSha = args.commitSha as string | undefined;
    const docIds = args.docIds as string[] | undefined;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    let commentResult: unknown = undefined;
    const hasComment = comment !== undefined && comment !== '';
    const hasCommitSha = commitSha !== undefined && commitSha !== '';

    // 步骤 1：发评论（仅当 comment 或 commitSha 提供）
    if (hasComment || hasCommitSha) {
      let commentText = '';
      if (hasComment && hasCommitSha) {
        commentText = `${comment}\n\nCommit: ${commitSha}`;
      } else if (hasComment) {
        commentText = comment!;
      } else {
        commentText = `Commit: ${commitSha}`;
      }

      try {
        commentResult = await client.request<Record<string, unknown>>(
          'POST',
          `/tasks/${taskId}/comments`,
          { body: { content: commentText } },
        );
      } catch (err: unknown) {
        return handlePlatformError(err, 'add_comment');
      }
    }

    // 步骤 2：更新任务状态
    let task: Record<string, unknown>;
    try {
      task = await client.request<Record<string, unknown>>('PATCH', `/tasks/${taskId}`, {
        body: { status },
      });
    } catch (err: unknown) {
      return handlePlatformError(err, 'update_status');
    }

    const result: Record<string, unknown> = { task };
    if (commentResult !== undefined) {
      result.comment = commentResult;
    }

    // 步骤 3（可选）：关联文档
    if (docIds && docIds.length > 0) {
      const succeeded: string[] = [];
      // 单条失败内嵌不拖垮主体；PlatformApiError 透传 status/code 供 Agent 判因（404 文档不存在 / 403 无空间权限）
      const failed: Array<{
        docId: string;
        status?: number;
        code?: number | string;
        error: string;
      }> = [];

      for (const docId of docIds) {
        try {
          await client.request<unknown>('POST', `/tasks/${taskId}/doc-links`, {
            body: { docId },
          });
          succeeded.push(docId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (err instanceof PlatformApiError) {
            failed.push({ docId, status: err.status, code: err.code, error: msg });
          } else {
            failed.push({ docId, error: msg });
          }
        }
      }

      result.docLinks = { succeeded, failed };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
};
