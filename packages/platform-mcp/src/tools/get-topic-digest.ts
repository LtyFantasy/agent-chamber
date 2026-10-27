/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 话题速览、附件发现与未读多轮排空
 *
 * [代码职责]
 *   - 并行装配 topic/recent/unread，调用共用投影并精确推进已读游标
 *
 * [权威文档]
 *   - 主文档: 线上 docs/integrations/platform-mcp.md §2.3 — digest 投影/截断/去重与 markRead
 *   - 补充: 线上 docs/api-definition.md §6.11 — 上游 MessageAttachment 投影
 *
 * [关键不变量]
 *   - recent/unread 共用消息投影并完整保留上游附件；只截断 recent 正文
 *   - markRead 默认 true，只标本次最后一条未读；空列表不标，未返回余量继续未读
 *   - unread/mark 失败降级；unreadCount>0 默认省略 recent，includeRecent 可强制携带
 *
 * [关联代码]
 *   - packages/platform-mcp/src/tools/project.ts — 共用投影与正文截断
 *   - packages/platform-mcp/src/tools/get-topic-digest.spec.ts — 投影/降级/精确标读验证
 *
 * [铁律关联] #9(代理层透传) #11(注释强制)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
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
 * 三路并行执行，减少往返延迟。markRead 默认 true，但**只推进到本次返回的最后一条未读**
 * （D6 精确化，见下）。
 *
 * Batch F token 瘦身（看板任务 fdc1851b）——返回按 Agent 消费模型做投影：
 * - topic：participants 剔除 avatarUrl/joinedAt/description，顶层剔除 invitedAgentIds
 * - 消息（recent + unread 统一）：剔除 senderAvatar/topicId
 * - recent/unread 原样保留上游 attachments 元数据，免解析正文即可发现仅附件消息
 * - recentMessages.messages 的 content 默认 >300 字符截断为 snippet（contentTruncated: true），
 *   可用 maxContentLength 调整截断长度（0=不截断返全文）；需要全文的 Agent 用原子工具
 *   topic_controller_get_messages 翻页
 * - unread.messages 保持全文不截断（可行动增量）
 * - 起步去重：unreadCount > 0 时省略 recentMessages（与 unread 增量重叠）；
 *   显式传 includeRecent=true 强制携带；unread 端点失败降级（unreadCount 未知）时保留 recentMessages
 *   注（v1.85 unread 口径）：unreadCount 不含自己发的消息（服务端 sender 排除），
 *   故自己刚发完消息时 unreadCount 为 0、recentMessages **不会**被去重省略——
 *   这正是 agent 确认自己刚发出内容的位置。
 *   注（v1.96.0-dev D1 行为变更）：**发送消息不再推进你自己的已读游标**——游标只经
 *   markAsRead / 本工具的 markRead 推进。所以"刚发完消息"与"已读完之前的话"不再等价。
 *
 * **D6 多轮排空（markRead 语义，v1.96.0-dev）**：
 * markRead=true 时本工具把游标推进到**本次返回的未读列表最后一条 messageId**，而不是
 * 话题最新消息——`unreadCount > messageLimit` 时余量保持未读，需**再次调用继续 drain**。
 * 未读列表为空 → **跳过 mark**（没有可推进的目标；旧行为会标到最新 = 凭空清零）。
 * 需要一次清空（含本次未返回的余量）→ 用 `mark_topic_read`（不传 messageId）。
 *
 * 返回形状：{ topic, recentMessages?, unread? }
 * - recentMessages 为分页对象 { messages, nextCursor, hasMore }
 * - unread 仅 unread 端点成功时出现：
 *   { unreadCount, lastReadMessageId?, messages, hasMore, mentionsOnly, advanced? }
 *   - mentionsOnly（恒存在）：本次计数采用的提及过滤模式（true = 你开了静默，
 *     只数提及你/@all 的消息）——调用方据此知道自己看到的是哪种口径
 *   - advanced 仅在 markRead=true 且标记调用**真的发出且成功**时携带
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
      'recentMessages.messages and unread.messages preserve upstream attachments metadata for ' +
      'discovery; enumerate attachments without parsing content, including attachment-only messages. ' +
      'recentMessages is a paginated object { messages, nextCursor, hasMore }; ' +
      'message content exceeding 300 characters (configurable via maxContentLength; ' +
      '0 = no truncation, full text) is truncated to a snippet ' +
      '(contentTruncated: true) — use topic_controller_get_messages to page through full text. ' +
      'unread includes unread count and incremental messages (full text, never truncated), ' +
      'plus mentionsOnly: the filter mode the count was computed with (true = you enabled ' +
      'notification-settings mentionsOnly for this topic, so only messages mentioning you or ' +
      '@all are counted). ' +
      'unreadCount excludes messages you sent yourself (the server excludes self-sent rows), ' +
      'so right after you post a message unreadCount stays 0 and recentMessages is NOT omitted — ' +
      'that is where you confirm your own just-sent message. ' +
      'Note (behavior change): sending a message does NOT advance your own read cursor — the cursor ' +
      'moves only via markRead here or mark_topic_read. ' +
      'When unreadCount > 0, recentMessages is omitted for deduplication; ' +
      'pass includeRecent=true explicitly to force inclusion. ' +
      'markRead defaults to true — but it advances the cursor only to the NEWEST UNREAD MESSAGE ' +
      'RETURNED, not to the topic latest: when unreadCount > messageLimit the remainder stays unread, ' +
      'so call again to drain (or use mark_topic_read with no messageId for a one-shot full clear). ' +
      'An empty unread list skips the mark entirely. ' +
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
            'Whether to advance the read cursor (default true). It advances the cursor to the ' +
            'NEWEST UNREAD MESSAGE RETURNED (not to the topic latest) — when ' +
            'unreadCount > messageLimit the remainder stays unread, so call again to drain; ' +
            'use mark_topic_read with no messageId for a one-shot full clear. ' +
            'An empty unread list skips the mark entirely. ' +
            'Set to false to peek without advancing. ' +
            'Note: default true means calling digest advances the cursor past the unread messages ' +
            'it returned — if you only want to view messages without marking them as read, ' +
            'explicitly pass false.',
        },
        includeRecent: {
          type: 'boolean',
          description:
            'Whether to force inclusion of recentMessages (default false). ' +
            'Default behavior: when unreadCount > 0, recentMessages is omitted ' +
            '(overlaps with unread incrementals; deduplication from the start); ' +
            'pass true to return recent messages even when there are unread.',
        },
        maxContentLength: {
          type: 'integer',
          description:
            'Max chars per recent message content before snippet truncation ' +
            '(default 300; 0 = no truncation, full text; recommended max 50000). ' +
            'Only affects recentMessages; unread messages are always full text.',
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

    // maxContentLength：recentMessages content 截断长度（可选，缺省 300 行为不变）。
    // 防御性解析（MCP 层无 DTO 校验，必须 handler 内兜底）：
    // 非数字/负数按缺省 300 处理（undefined → project 侧用默认值）；>50000 钳到 50000
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

      // markRead=true 且 unread 成功 → 标到**本次返回的未读列表最后一条**（D6 精确化）。
      //
      // 为什么不传 messageId（旧行为：标到话题最新）：会把**本次没返回**的未读一起标掉——
      // unreadCount > messageLimit 时（多轮排空场景）列表只给了前 messageLimit 条，标到最新
      // 等于宣称"全读完了"，剩余未读被静默吞掉。改为传列表最后一条 = 只推进到**真正看到**的位置，
      // 余量保持未读，下次调用继续排空（多轮 drain）。
      //
      // 空列表跳过 mark：没有未读就没有可推进的目标——不传 messageId 的调用会标到最新消息，
      // 那恰恰是"凭空清零"（正是本批 D1 要消灭的语义）。
      // 需要一次清空（含未返回的余量）的调用方走 mark_topic_read（不传 messageId）。
      if (markRead && unread !== undefined) {
        const unreadMessages = unread.messages;
        const lastUnreadId =
          Array.isArray(unreadMessages) && unreadMessages.length > 0
            ? (unreadMessages[unreadMessages.length - 1] as { id?: unknown } | undefined)?.id
            : undefined;
        if (typeof lastUnreadId === 'string') {
          try {
            const markResult = await client.request<{ advanced: boolean }>(
              'POST',
              `/topics/${topicId}/read`,
              { body: { messageId: lastUnreadId } },
            );
            advanced = markResult.advanced;
          } catch {
            // mark 失败降级：保留 unread 计数，省略 advanced
          }
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
        // recent 消息 content 截断为 snippet（长度 maxContentLength 可调，缺省 300；0=全文；全文走原子工具翻页）
        result.recentMessages = projectMessagesPage(recentMessages, true, maxContentLength);
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
