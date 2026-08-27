/**
 * Agent 基本信息（列表视图）
 */
export interface Agent {
  /** Agent ID */
  id: string;
  /** Agent 名称 */
  name: string;
  /** 头像短链/URL（SVG 头像为 /api/v1/avatars/:actorId.svg） */
  avatarUrl?: string | null;
  /** 描述摘要片段：≤200 字符截断，无描述时 null，仅列表视图返回 */
  descriptionSnippet?: string | null;
  /** Agent 状态 */
  status: 'active' | 'disabled' | 'pending';
  /** 所有者 ID */
  ownerId?: string;
  /** 所有者名称（admin 视角下显示） */
  ownerName?: string;
  /** API Key（仅创建/重置时返回一次完整明文） */
  apiKey?: string;
  /** API Key 前缀（列表展示用，如 ask_xxxx） */
  apiKeyPrefix?: string;
  /** 最后活跃时间 */
  lastActiveAt?: string | Date | null;
  /** 关联话题数量 */
  topicCount?: number;
  /** 消息数量 */
  messageCount?: number;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * Agent 详情（聚合视图）
 * 字段来自 Agent + actor / owner 关联
 */
export interface AgentDetail extends Agent {
  /** 详情完整描述 */
  description: string | null;
}

/**
 * 删除影响面（GET /agents/:id/deletion-impact 响应，统一批 A3）
 *
 * 权限语义 = 与 DELETE 同权（调用者即删除者）：聚合计数会向只读协作者泄露
 * 该 agent 的活跃痕迹，故不开放 'read'。删除确认弹窗展示用：
 * - seatCount > 0 → 圆桌座位不会自动释放，删除后该 Agent 无法再发言；
 * - openTaskCount > 0 → 未完成任务不会自动改派。
 */
export interface AgentDeletionImpact {
  /** 未完成任务数：assignee = 该 agent 且 status 非 done/archived 的 tasks（未软删） */
  openTaskCount: number;
  /** 该 agent 发送的消息数（未软删） */
  messageCount: number;
  /** 参与话题数：participant status IN ('invited','active') */
  topicCount: number;
  /** 绑定座位数：roundtable_seats.config->>'bindActorId' = 该 agent 且 status != 'removed'（对齐座位唯一约束语义） */
  seatCount: number;
}

/**
 * 跨 topic 未读消息计数（GET /agents/me/unread 响应，plan forge-jubilee-robin.md WS-B）
 *
 * 语义与 TopicService.getUnread 对齐（topic.service.ts:1241-1309）：
 * - 无游标（last_read_message_id IS NULL）或游标消息已软删 → 该 topic 全量未删消息计数；
 * - 自己发的消息计入（无 sender 过滤，与 getUnread 同语义）；
 * - 仅统计 status IN ('invited','active') 的参与行（left 排除）；
 * - 只列 unreadCount > 0 的 topic，最多 50 条；结果为调用时刻快照
 *   （get_topic_digest 默认 markRead=true 会推进游标清零计数）。
 */
export interface TopicUnreadCount {
  /** 话题 ID */
  topicId: string;
  /** 话题标题 */
  topicName: string;
  /** 未读消息数（>0） */
  unreadCount: number;
}

/**
 * Agent 统计
 */
export interface AgentStats {
  /** Agent ID */
  agentId: string;
  /** 统计周期 */
  period: string;
  /** 消息数量 */
  messageCount: number;
  /** 话题数量 */
  topicCount: number;
  /** 任务数量 */
  taskCount: number;
  /** 平均响应时间 */
  avgResponseTime: number;
  /** Token 使用量 */
  tokenUsage: number;
  /** 每日活动 */
  dailyActivity: Array<{ date: string; messageCount: number; tokenUsage: number }>;
}
