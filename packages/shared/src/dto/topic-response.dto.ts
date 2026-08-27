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
  /** 软删时间；非空 = 该 actor 已删除，name 仍可显示（历史归因保留） */
  deletedAt?: string | null;
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
  /**
   * 话题类型：normal（普通，缺省）/ roundtable（圆桌，设计 docs/roundtable-design.md §5）。
   * 由 topics.kind 列透传（entity spread 自动带上），web/digest 据此渲染圆桌 UI。
   */
  kind?: 'normal' | 'roundtable';
  /**
   * 圆桌唤醒策略 effective 值（派生字段，仅详情视图且 kind='roundtable' 时返回）：
   * settings.wakePolicy 显式值优先，缺省 'mention'——与 roundtable.service
   * resolveWakePolicy 同规（设计 docs/roundtable-design.md §6 路由与唤醒策略）。
   * normal topic 不输出该字段。
   */
  wakePolicy?: 'mention' | 'broadcast';
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
  /**
   * 圆桌座位标签（座位子身份展示语义，设计 docs/roundtable-design.md §6/§7）：
   * 仅透传 metadata.seatLabel 单键，不透全量 metadata（隐私/体积）；无该键时字段缺省。
   * badge 是展示层语义，权限边界仍是 actor 级。
   */
  seatLabel?: string;
  /**
   * 圆桌主脑座位标记（设计 §6/§3：主脑座位的发言携带 `from.coordinator: true`，
   * web 消息流据此渲染主脑 badge——人类一眼区分主脑指令）。仅透传
   * metadata.seatCoordinator 单键（仅 coordinator 座位落库时写入，缺省不写），
   * 无该键时字段缺省（普通座位/人类/系统消息响应无此字段，保持载荷瘦）。
   */
  seatCoordinator?: boolean;
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
  /** 软删时间；非空 = 发送者已删除，senderName 仍可显示（历史归因保留） */
  deletedAt?: string | null;
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
