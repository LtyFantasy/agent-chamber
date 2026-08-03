/**
 * Agent 基本信息（列表视图）
 */
export interface Agent {
  /** Agent ID */
  id: string;
  /** Agent 名称 */
  name: string;
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
