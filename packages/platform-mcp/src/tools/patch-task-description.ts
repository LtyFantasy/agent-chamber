/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §7 Tasks（PATCH /tasks/:id/description 端点）
 *   - 补充: docs/spec.md §3.2 TaskStatus
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

/**
 * patch_task_description — 任务描述局部 patch（薄透传 PATCH /tasks/:id/description）
 *
 * match 模式精确串替换（契约对齐 DocSpace patch_doc 的 match 通道）：
 * - oldString 必须恰好命中 1 处：0 命中 → 404、>1 命中 → 409 + matchCount
 *   （扩大 oldString 上下文后重试，绝不静默挑选）；
 * - newString 可为空串 = 删除该片段；$ 模式按字面量处理；
 * - expectedDescriptionHash 可选乐观锁：先 findOne 拿 descriptionHash 再传，
 *   并发改动后不符 → 409 + currentDescriptionHash（重读后重试）；
 * - clientRequestId 可选幂等键：同 key 重试返回首次快照 + idempotentReplay。
 *
 * 多 Agent 并发改描述首选此通道（替代整段 PATCH /tasks/:id 的 description 全量覆盖）。
 */
export const patchTaskDescriptionTool: CustomTool = {
  tool: {
    name: 'patch_task_description',
    description:
      'Patch a task description via exact substring replacement (match mode) — the ' +
      'preferred channel for concurrent multi-agent description edits, replacing ' +
      'whole-description PATCH. oldString must match exactly once: 0 matches → 404, ' +
      '>1 matches → 409 with matchCount (expand context and retry). newString may be ' +
      'empty to delete the fragment. Optional expectedDescriptionHash (capture from the ' +
      'task detail response descriptionHash) is an optimistic-lock precondition: ' +
      'mismatch → 409 with currentDescriptionHash. Optional clientRequestId: same actor ' +
      '+ same key retries return the first response snapshot (idempotentReplay: true).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID (UUID, required)',
        },
        oldString: {
          type: 'string',
          description:
            'Exact substring to replace in the task description (required, non-empty). ' +
            '0 matches → 404; >1 matches → 409 with matchCount.',
        },
        newString: {
          type: 'string',
          description:
            'Replacement text (required; empty string deletes the matched fragment). ' +
            '$ patterns are treated literally.',
        },
        expectedDescriptionHash: {
          type: 'string',
          description:
            'Optional optimistic-lock precondition: descriptionHash from the task detail ' +
            'response (sha256 of description). Mismatch → 409 with currentDescriptionHash.',
        },
        clientRequestId: {
          type: 'string',
          description:
            'Idempotency key (optional, 1–64 chars). Retry with the same key returns the ' +
            'first response snapshot with idempotentReplay: true.',
        },
      },
      required: ['taskId', 'oldString', 'newString'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    // 薄透传：非 undefined 字段原样转发，match/乐观锁/幂等语义全由后端承担
    const body: Record<string, unknown> = { oldString: args.oldString, newString: args.newString };
    if (args.expectedDescriptionHash !== undefined) {
      body.expectedDescriptionHash = args.expectedDescriptionHash;
    }
    if (args.clientRequestId !== undefined) body.clientRequestId = args.clientRequestId;

    try {
      const result = await client.request<Record<string, unknown>>(
        'PATCH',
        `/tasks/${args.taskId}/description`,
        { body },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err: unknown) {
      // 上游错误透传（status/code/details 保留，铁律 #9）
      return handlePlatformError(err, 'patch_task_description');
    }
  },
};
