import { MessageType, Visibility, ParticipantStatus } from '../enums';

/**
 * 话题参与者
 */
export interface TopicParticipant {
  /** 参与者 ID */
  participantId: string;
  /** 参与者类型 */
  participantType: 'human' | 'agent';
  /** 参与者名称 */
  name: string;
  /** 头像 URL */
  avatarUrl?: string | null;
  /** 描述 */
  description: string | null;
  /** 角色（member/moderator） */
  role: string;
  /** 参与者状态（Batch 2: 替代 isActive） */
  status: ParticipantStatus;
  /** 最近一次实际激活（加入）时间；受邀（invited）时为空，激活时写入，重新加入时刷新 */
  joinedAt?: string | Date | null;
}

/**
 * 话题基本信息（列表视图）
 */
export interface Topic {
  /** 话题 ID */
  id: string;
  /** 话题标题 */
  title: string;
  /** 描述摘要片段：≤200 字符截断，无描述时 null，仅列表视图返回 */
  descriptionSnippet?: string | null;
  /** 话题状态 */
  status: 'draft' | 'open' | 'active' | 'voting' | 'paused' | 'closed' | 'archived';
  /** 话题类型 */
  type?: string;
  /** 可见性 */
  visibility?: Visibility;
  /** 创建者 ID */
  creatorId?: string;
  /** 创建者 ID（遗留字段，请使用 creatorId） */
  createdBy?: string;
  /** 参与者数量 */
  participantCount?: number;
  /** 消息数量 */
  messageCount?: number;
  /** 最后消息时间 */
  lastMessageAt?: string | Date | null;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 话题详情（聚合视图）
 * 字段来自 Topic + participants + 计数统计
 */
export interface TopicDetail extends Topic {
  /** 详情完整描述 */
  description: string | null;
  /** 邀请的 Agent IDs（派生字段：participants 中 status='invited' 且 type=agent 的 id 列表） */
  invitedAgentIds?: string[];
  /** 参与者列表（status≠'left' 的全部行，透出 role+status+actor 公开信息） */
  participants?: TopicParticipant[];
  /** 未读消息数 */
  unreadCount?: number;
  /** 看板数量 */
  boardCount?: number;
  /** 任务数量 */
  taskCount?: number;
  /** 未完成任务数量 */
  openTaskCount?: number;
  /** 已完成任务数量 */
  doneTaskCount?: number;
  /** 关联看板列表 */
  boards?: { id: string; name: string; taskCount?: number }[];
  /** 关联任务列表 */
  tasks?: { id: string; title: string; status: string; priority: string }[];
}

/**
 * 消息
 * senderName/senderAvatar 由 Service 层注入，Entity 中不存在
 */
export interface Message {
  /** 消息 ID */
  id: string;
  /** 所属话题 ID */
  topicId: string;
  /** 发送者类型 */
  senderType: 'human' | 'agent' | 'system';
  /** 发送者 ID */
  senderId: string;
  /** 发送者名称 */
  senderName: string;
  /** 发送者头像 */
  senderAvatar?: string;
  /** 消息内容 */
  content: string;
  /** 内容类型 */
  contentType?: string;
  /** 消息类型 */
  type?: MessageType;
  /** 回复的消息 ID */
  replyTo?: string;
  /** 创建时间 */
  createdAt: string | Date;
  /** 编辑时间 */
  editedAt?: string | Date;
}

/**
 * 未读消息摘要与增量消息
 */
export interface UnreadSummary {
  /** 话题 ID */
  topicId: string;
  /** 未读数量（全量，不受 limit 影响） */
  unreadCount: number;
  /** 最后阅读的消息 ID */
  lastReadMessageId?: string;
  /** 增量未读消息列表（按全序 ASC 的前 limit 条） */
  messages: Message[];
  /** 是否还有更多未读消息（unreadCount > messages.length） */
  hasMore: boolean;
}
