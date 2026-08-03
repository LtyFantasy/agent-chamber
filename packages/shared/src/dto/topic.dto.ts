import { MessageType, TopicStatus, Visibility } from '../enums';

/**
 * 话题议程项输入
 */
export interface AgendaItemInput {
  /** 议程项 ID（更新时提供） */
  id?: string;
  /** 议程标题 */
  title: string;
  /** 议程状态 */
  status: 'pending' | 'in_progress' | 'completed';
  /** 分配给的用户/Agent ID */
  assignedTo?: string;
  /** 排序顺序 */
  order: number;
}

/**
 * 话题配置输入
 */
export interface TopicConfigInput {
  /** 是否自动归档 */
  autoArchive?: boolean;
  /** 归档前天数 */
  archiveAfterDays?: number;
  /** 是否允许 Agent 加入 */
  allowAgentJoin?: boolean;
  /** 是否开启 moderation */
  moderationEnabled?: boolean;
  /** 话题可见性 */
  visibility?: Visibility;
  /** 私密话题的白名单 Agent IDs */
  invitedAgentIds?: string[];
}

/**
 * 创建话题请求输入
 */
export interface CreateTopicInput {
  /** 话题标题 */
  title: string;
  /** 话题描述 */
  description?: string;
  /** 议程列表 */
  agenda?: AgendaItemInput[];
  /** 邀请的 Agent IDs */
  invitedAgentIds?: string[];
  /** 话题可见性 */
  visibility?: Visibility;
  /** 话题配置 */
  config?: TopicConfigInput;
  /** 幂等键（可选，1~64 字符）。同一 actor 重复提交相同 clientRequestId 时返回首个已创建实体 + idempotentReplay 标记 */
  clientRequestId?: string;
}

/**
 * 更新话题请求输入
 */
export interface UpdateTopicInput {
  /** 话题标题 */
  title?: string;
  /** 话题描述 */
  description?: string;
  /** 话题状态 */
  status?: TopicStatus;
  /** 议程列表 */
  agenda?: AgendaItemInput[];
  /** 话题可见性 */
  visibility?: Visibility;
  /** 邀请的 Agent IDs */
  invitedAgentIds?: string[];
  /** 话题配置 */
  config?: TopicConfigInput;
}

/**
 * 发送消息请求输入
 */
export interface SendMessageInput {
  /** 消息内容 */
  content: string;
  /** 消息类型 */
  type?: MessageType;
  /** 内容格式 */
  contentType?: 'text' | 'code' | 'image' | 'file';
  /** 回复的消息 ID */
  replyTo?: string;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
  /** 幂等键（可选，1~64 字符）。同一 actor 重复提交相同 clientRequestId 时返回首个已创建实体 + idempotentReplay 标记 */
  clientRequestId?: string;
}

/**
 * 更新话题议程请求输入
 */
export interface UpdateAgendaInput {
  /** 完整的议程列表 */
  agenda: AgendaItemInput[];
}

/**
 * 标记消息已读请求输入
 */
export interface MarkAsReadInput {
  /** 要标记为已读的消息 ID，不传则标记到该话题最新消息 */
  messageId?: string;
}
