/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: .kimi/plan-mcp-phase2.md §3.3 ③
 *   - 补充: .kimi/plan-batch-e3-read-cursor.md §2.4（markRead + unread 集成）
 *   - 补充: docs/platform-mcp.md §2.3 + 看板任务 fdc1851b（Batch F：digest 投影/截断/去重）
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
import { projectMessages, projectMessagesPage, projectTopic } from './project';

/**
 * get_topic_digest — 话题速览
 *
 * 进入话题前一次调用了解话题详情 + 最近消息 + 未读状态。
 * 三路并行执行，减少往返延迟。markRead 默认 true（看速览即视为读到最新）。
 *
 * Batch F token 瘦身（看板任务 fdc1851b）——返回按 Agent 消费模型做投影：
 * - topic：participants 剔除 avatarUrl/joinedAt/description，顶层剔除 invitedAgentIds
 * - 消息（recent + unread 统一）：剔除 senderAvatar/topicId
 * - recentMessages.messages 的 content >300 字符截断为 snippet（contentTruncated: true），
 *   需要全文的 Agent 用原子工具 topic_controller_get_messages 翻页
 * - unread.messages 保持全文不截断（可行动增量）
 * - 起步去重：unreadCount > 0 时省略 recentMessages（与 unread 增量重叠）；
 *   显式传 includeRecent=true 强制携带；unread 端点失败降级（unreadCount 未知）时保留 recentMessages
 *
 * 返回形状：{ topic, recentMessages?, unread? }
 * - recentMessages 为分页对象 { messages, nextCursor, hasMore }
 * - unread 仅 unread 端点成功时出现：{ unreadCount, lastReadMessageId?, messages, hasMore, advanced? }
 *   advanced 仅在 markRead=true 且标记调用成功时携带
 * - unread 端点失败时省略 unread 字段（降级，不让 digest 整体失败）
 * - mark 调用失败时保留 unread 计数、省略 advanced（降级）
 */
export const getTopicDigestTool: CustomTool = {
  tool: {
    name: 'get_topic_digest',
    description:
      'Topic digest: fetch topic details, recent messages, and unread status. ' +
      'Replaces 3 individual API calls with a single round trip via 3-way parallel execution. ' +
      'Projected for Agent consumption model: participants omit avatar/join-time fields; ' +
      'messages omit senderAvatar/topicId. ' +
      'recentMessages is a paginated object { messages, nextCursor, hasMore }; ' +
      'message content exceeding 300 characters is truncated to a snippet ' +
      '(contentTruncated: true) — use topic_controller_get_messages to page through full text. ' +
      'unread includes unread count and incremental messages (full text, never truncated). ' +
      'When unreadCount > 0, recentMessages is omitted for deduplication; ' +
      'pass includeRecent=true explicitly to force inclusion. ' +
      'markRead defaults to true — viewing the digest is treated as having read up to the latest; ' +
      'set to false to peek without advancing the read cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: {
          type: 'string',
          description: 'Topic ID (UUID)',
        },
        messageLimit: {
          type: 'integer',
          description:
            'Number of recent messages and unread messages to fetch each (1~50, default 20)',
        },
        markRead: {
          type: 'boolean',
          description:
            'Whether to advance the read cursor to the latest message (default true). ' +
            'Set to false to peek without advancing. ' +
            'Note: default true means calling digest clears the topic unread count — ' +
            'if you only want to view messages without marking them as read, explicitly pass false.',
        },
        includeRecent: {
          type: 'boolean',
          description:
            'Whether to force inclusion of recentMessages (default false). ' +
            'Default behavior: when unreadCount > 0, recentMessages is omitted ' +
            '(overlaps with unread incrementals; deduplication from the start); ' +
            'pass true to return recent messages even when there are unread.',
        },
      },
      required: ['topicId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const topicId = args.topicId as string;
    const messageLimit = (args.messageLimit as number) ?? 20;
    const markRead = args.markRead !== false; // 默认 true
    const includeRecent = args.includeRecent === true; // 默认 false
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);

    try {
      // 三路并行：topic 详情 + 最近消息 + 未读状态。
      // topic/messages 是关键路径（失败走 handlePlatformError）；
      // unread 是非关键路径，.catch 降级为 undefined（省略 unread 字段，不让 digest 整体失败）。
      // Promise.resolve 包裹：保证非 promise 返回值（如测试 mock）也不会同步抛 TypeError。
      const [topic, recentMessages, unread] = await Promise.all([
        client.request<Record<string, unknown>>('GET', `/topics/${topicId}`),
        client.request<unknown>('GET', `/topics/${topicId}/messages`, {
          params: { limit: messageLimit },
        }),
        Promise.resolve(
          client.request<Record<string, unknown>>('GET', `/topics/${topicId}/messages/unread`, {
            params: { limit: messageLimit },
          }),
        ).catch(() => undefined),
      ]);

      let advanced: boolean | undefined;

      // markRead=true 且 unread 成功 → 调 mark 标到最新
      if (markRead && unread !== undefined) {
        try {
          const markResult = await client.request<{ advanced: boolean }>(
            'POST',
            `/topics/${topicId}/read`,
          );
          advanced = markResult.advanced;
        } catch {
          // mark 失败降级：保留 unread 计数，省略 advanced
        }
      }

      // 起步去重：unreadCount > 0 时 recent 与 unread 增量重叠，省略 recentMessages；
      // unread 降级为 undefined（unreadCount 未知）时保守保留 recent。
      const unreadCount =
        unread !== undefined && typeof unread.unreadCount === 'number'
          ? unread.unreadCount
          : undefined;
      const omitRecent = !includeRecent && unreadCount !== undefined && unreadCount > 0;

      const result: Record<string, unknown> = { topic: projectTopic(topic) };
      if (!omitRecent) {
        // recent 消息 content 截断为 snippet（全文走原子工具翻页）
        result.recentMessages = projectMessagesPage(recentMessages, true);
      }
      if (unread !== undefined) {
        // unread 增量消息保持全文（可行动增量，不截断）
        const { messages: unreadMessages, ...unreadRest } = unread;
        result.unread = {
          ...unreadRest,
          ...(Array.isArray(unreadMessages)
            ? { messages: projectMessages(unreadMessages, false) }
            : {}),
          ...(advanced !== undefined ? { advanced } : {}),
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: unknown) {
      return handlePlatformError(err, 'get_topic');
    }
  },
};
