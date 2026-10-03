import {
  MessageType,
  TopicKind,
  TopicStatus,
  Visibility,
  ParticipantStatus,
  WakePolicy,
} from '../enums';
import type { AttachmentTtl } from '../constants';

/**
 * 话题配置（settings jsonb 的**已声明子集**）。
 *
 * 为什么显式声明而不是 `Record<string, unknown>`：settings 是 jsonb，实体透传时
 * 形状不稳定；把消费方真正读取的键收敛成类型，读侧就有编译期保护（web 表单 /
 * API 文档 / 后端解析点共用）。未列出的键仍可能存在于运行时对象中（历史遗留配置），
 * 消费方不得依赖本接口的完备性。
 */
export interface TopicSettings {
  /** 可见性（settings 冗余副本；顶层 visibility 是权威出口） */
  visibility?: Visibility;
  /** 圆桌唤醒策略（设计 docs/roundtable-design.md §6） */
  wakePolicy?: WakePolicy;
  /** 圆桌安全阀阈值（§6） */
  maxRoundsWithoutHuman?: number;
  /** 附件有效期档位（附件 TTL 批 v1.90.0-dev）——上传时冻结，见 TopicConfigInput.attachmentTtl */
  attachmentTtl?: AttachmentTtl;
}

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
  /** 话题状态（值域单源 TopicStatus，2026-08-31 起删 draft/voting 死值） */
  status: TopicStatus;
  /**
   * 话题类型：normal（普通，缺省）/ roundtable（圆桌，设计 docs/roundtable-design.md §5）。
   * 由 topics.kind 列透传（entity spread 自动带上），web/digest 据此渲染圆桌 UI。
   */
  kind?: TopicKind;
  /**
   * 圆桌唤醒策略 effective 值（派生字段，仅详情视图且 kind='roundtable' 时返回）：
   * settings.wakePolicy 显式值优先，缺省 'mention'——与 roundtable.service
   * resolveWakePolicy 同规（设计 docs/roundtable-design.md §6 路由与唤醒策略）。
   * normal topic 不输出该字段。
   */
  wakePolicy?: WakePolicy;
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
  /**
   * 话题配置（settings jsonb）。
   *
   * 出现面：`GET /topics/:id`（详情，`...topic` 透传）与 `POST /topics` / `PATCH /topics/:id`
   * 的写响应；列表 `GET /topics` **刻意剔除**（接口瘦身，web 列表页零消费——见
   * topic.service findAll 的解构），故本字段可选。
   */
  settings?: TopicSettings;
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
 * 消息附件投影条目（P1）：源 = 服务端背书的 metadata.attachments 索引
 */
export interface MessageAttachment {
  /** 附件 ID */
  id: string;
  /** 原始文件名 */
  originalName: string;
  /**
   * MIME 类型（**字节证据**，非客户端声明值）。
   *
   * v1.90.0-dev 起：4 种嗅探图片 mime 之一，或非图片恒 `application/octet-stream`。
   * ⚠️ 对图标/呈现形态分类**无信息量**（非图片全是 octet-stream）——展示层请用
   * `clientMimeType` + `originalName` 扩展名（clientMimeType 是纯展示信息，不参与服务决策）。
   */
  mimeType: string;
  /** 字节数（number，P0 起 sizeBytes 转换点钉死为显式 Number()） */
  sizeBytes: number;
  /**
   * 客户端声明的 mime（sanitize 后；非法/缺失 → null）——**纯展示信息**
   * （卡片图标参考），不参与任何服务决策。索引快照自发送时刻。
   */
  clientMimeType: string | null;
  /**
   * 过期时刻（ISO 8601）；null = 永久（doc 绑定 / topic 设置 never / 存量迁移行）。
   *
   * **静态事实**：发送时刻从附件行取快照写进索引，事后改 topic TTL 不追溯。
   * 索引缺该键（存量消息）= null（永久）。
   */
  expiresAt: string | null;
  /**
   * 是否已过期——**响应时纯函数**（`expiresAt < now()`），不入索引快照。
   *
   * 墓碑式语义：消息不动，投影带 expired + expiresAt；过期附件的字节面返回 410
   * （已过期附件被 GC 物理回收后行已硬删，字节面随之 404）。展示层据此置灰禁用下载。
   */
  expired: boolean;
  /** 下载/引用直达 URL（相对路径，buildContentUrl 单一拼装点派生） */
  contentUrl: string;
  /**
   * 缩略图 URL（相对路径，buildThumbnailUrl 单一拼装点派生）。
   *
   * 缺席语义（P2 批 1 逐字钉死，防漂移）：Present ⇔ 该附件发送时已有缩略图；
   * absent = 无缩略图，回退 contentUrl；永不为 null/空串
   * （服务端仅在索引 hasThumbnail === true 时条件展开该键）。
   */
  thumbnailContentUrl?: string;
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
  /**
   * 附件投影：恒存在数组（无附件 = []），机器消费方免判空、免解析 markdown。
   * 快照语义：发送时刻索引，不 join 附件表——附件事后删除则 contentUrl 404
   * （与 content 里 markdown 链接行为一致）；附件**过期**则条目 `expired=true`
   * （墓碑：消息不动、投影标注、字节面 410），`expiresAt` 是发送时刻的静态快照
   * （v1.90.0-dev 附件 TTL 批；事后改 topic TTL 不追溯历史消息）。
   *
   * 恒存在是机器契约约定（与 seatLabel? 条件缺省的双契约风格区分）：
   * 展示层 badge 才用 seatLabel 式条件缺省，勿按该先例把本字段"简化"回可选。
   * 注意：contentUrl 是相对路径——下载需拼 base URL，且 GET /content 端点
   * 携带消费方凭证（API Key/JWT）鉴权。
   */
  attachments: MessageAttachment[];
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
  /**
   * 未读数量（全量，不受 limit 影响）；**自己发的消息不计入未读**（v1.85，
   * 与 messages/hasMore 同口径，覆盖无游标/锚点悬空的降级路径）
   */
  unreadCount: number;
  /** 最后阅读的消息 ID */
  lastReadMessageId?: string;
  /** 增量未读消息列表（按全序 ASC 的前 limit 条） */
  messages: Message[];
  /** 是否还有更多未读消息（unreadCount > messages.length） */
  hasMore: boolean;
}
