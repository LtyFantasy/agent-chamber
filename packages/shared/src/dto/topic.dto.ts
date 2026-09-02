import { MessageType, TopicKind, TopicStatus, Visibility, WakePolicy } from '../enums';

/**
 * 议程项状态值域（AgendaItemInput.status 单一事实来源；review-0831 任务 a8a295df
 * 收口——backend agenda-item.dto.ts 此前内联 @IsEnum 字面量，与 shared union 双源）
 */
export const AGENDA_ITEM_STATUS_VALUES = ['pending', 'in_progress', 'completed'] as const;

/** 议程项状态联合（'pending' | 'in_progress' | 'completed'） */
export type AgendaItemStatus = (typeof AGENDA_ITEM_STATUS_VALUES)[number];

/**
 * 话题议程项输入
 */
export interface AgendaItemInput {
  /** 议程项 ID（更新时提供） */
  id?: string;
  /** 议程标题 */
  title: string;
  /** 议程状态 */
  status: AgendaItemStatus;
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
  /**
   * 话题类型：'normal'（普通，缺省）/ 'roundtable'（圆桌，设计 docs/roundtable-design.md §5）。
   * 仅创建时生效——创建后不可变，update 忽略该字段（互转在 M2 推迟清单）。
   */
  kind?: TopicKind;
  /**
   * 圆桌唤醒策略（设计 §6，r4 修订 + R1 拍板）：
   * 'mention'（缺省——仅 @座位label / @all 唤醒对应座位，新桌默认省钱安全）/
   * 'broadcast'（新消息唤醒全部 active 座位，高强度讨论桌可选）。
   * 普通话题（kind='normal'）不消费该值，但按「配置原样存储」语义照常写入 settings。
   */
  wakePolicy?: WakePolicy;
  /**
   * 圆桌安全阀阈值（设计 §6，M2 阶段 4 落地）：topic 内座位间连续 N 轮非沉默
   * agent 发言无人类消息 → 暂停注入 + topic 公告（防 agent 间礼貌/抬杠循环）。
   * 缺省 8（roundtable.service 一处常量 DEFAULT_MAX_ROUNDS_WITHOUT_HUMAN）；
   * 显式 0 = 关闭安全阀（dogfood 对照）；合法范围 0~1000（DTO whitelist 校验，
   * service 读取处防御性解析，非法值兜底缺省）。普通话题不消费该值，但按
   * 「配置原样存储」语义照常写入 settings。
   */
  maxRoundsWithoutHuman?: number;
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
