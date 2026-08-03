/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-batch-e3-read-cursor.md §2.4
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
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';

/**
 * mark_topic_read — 推进已读游标
 *
 * 将话题内已读位置推进到最新消息（不传 messageId）或指定消息。
 * 幂等且单调递增——回退请求会被服务端忽略（响应 advanced=false）。
 *
 * 典型用法：处理完增量消息后调用，标记处理到的位置；
 * get_topic_digest（markRead 默认 true）已自动标记，无需额外调用。
 * 手动场景：翻完 unread 增量消息后显式推进游标。
 */
export const markTopicReadTool: CustomTool = {
  tool: {
    name: 'mark_topic_read',
    description:
      'Advance the read cursor: move the read position in a topic to the latest message ' +
      '(when messageId is omitted) or to a specific message. ' +
      'Idempotent and monotonically increasing — backward requests are silently ignored by the server ' +
      '(response advanced=false). Typical usage: call after processing all unread incremental messages. ' +
      'Division of labor with get_topic_digest: digest fetches an overview and auto-marks as read by default; ' +
      'this tool performs manual, precise marking.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: {
          type: 'string',
          description: 'Topic ID (UUID)',
        },
        messageId: {
          type: 'string',
          description:
            'Optional. Advance the cursor to this specific message. ' +
            'When omitted, advance to the latest message in the topic.',
        },
      },
      required: ['topicId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const topicId = args.topicId as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    try {
      // 不传 messageId → 无 body，标到最新
      const options =
        args.messageId !== undefined ? { body: { messageId: args.messageId } } : undefined;

      const result = await client.request<Record<string, unknown>>(
        'POST',
        `/topics/${topicId}/read`,
        options,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'mark_topic_read');
    }
  },
};
