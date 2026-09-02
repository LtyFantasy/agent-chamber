export enum UserRole {
  ADMIN = 'admin',
  EDITOR = 'editor',
}

export enum AgentStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  PENDING = 'pending',
}

export enum ApiKeyStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
}

/**
 * 话题状态（2026-08-31 死契约清理：删除 DRAFT/VOTING——topic 现实定位 = 常驻聊天室，
 * create 恒写 ACTIVE，draft/voting 无入口死状态；生产实证 10 个 topic 全部 active。
 * 流转矩阵见 topic.service.ts TOPIC_STATUS_TRANSITIONS）
 */
export enum TopicStatus {
  OPEN = 'open',
  ACTIVE = 'active',
  PAUSED = 'paused',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

export enum Visibility {
  OPEN = 'open',
  PRIVATE = 'private',
}

export enum MessageType {
  CHAT = 'chat',
  PROPOSAL = 'proposal',
  VOTE = 'vote',
  TASK = 'task',
  SYSTEM = 'system',
  ARTIFACT = 'artifact',
  STATUS_UPDATE = 'status_update',
  THINKING = 'thinking',
}

export enum TaskStatus {
  BACKLOG = 'backlog',
  TODO = 'todo',
  IN_PROGRESS = 'in_progress',
  REVIEW = 'review',
  DONE = 'done',
  BLOCKED = 'blocked',
  ARCHIVED = 'archived',
}

export enum TaskDependencyType {
  BLOCKS = 'blocks',
  RELATES_TO = 'relates_to',
  DUPLICATES = 'duplicates',
}

/**
 * 里程碑状态（v1.42 起扩展为 Release 载体，普通里程碑与 Release 里程碑共存一枚举）
 * - 普通生命周期：planned → active → completed / cancelled（version 为空时使用）
 * - Release 生命周期：dev → ready → deployed → verified（version 非空时使用，流转矩阵见
 *   docs/spec.md §3.2 MilestoneStatus；dev/ready 可直落 cancelled，deployed 只能经
 *   POST /tasks/milestones/:id/deployed 写入，verified 为终态）
 * - 两类生命周期由 MilestoneService 流转矩阵隔离：version 非空禁落普通态，
 *   version 为空禁落 Release 四态（cancelled 为共享终态）
 */
export enum MilestoneStatus {
  PLANNED = 'planned',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  /** Release 生命周期初始态（create 带 version 时的缺省状态） */
  DEV = 'dev',
  /** 可发布候选（等待部署） */
  READY = 'ready',
  /** 已部署（只能经 deployed 端点写入，PATCH 一律 400） */
  DEPLOYED = 'deployed',
  /** 已验收（终态，前置 status=deployed） */
  VERIFIED = 'verified',
}

export enum Priority {
  P0 = 'p0',
  P1 = 'p1',
  P2 = 'p2',
  P3 = 'p3',
}

export enum EventType {
  NEW_MESSAGE = 'new_message',
  TASK_UPDATE = 'task_update',
  MENTION = 'mention',
  TOPIC_STATUS_CHANGE = 'topic_status_change',
  SYSTEM = 'system',
  AGENT_JOINED = 'agent_joined',
  AGENT_LEFT = 'agent_left',
  TASK_ASSIGNED = 'task_assigned',
  /** DocSpace 文档事件 */
  DOC_CREATED = 'doc_created',
  DOC_UPDATED = 'doc_updated',
  DOC_DELETED = 'doc_deleted',
  /** v1.60.0-dev：原子 move（同 docId 改 path，保留引用面） */
  DOC_MOVED = 'doc_moved',
}

/**
 * 事件资源类型（events.resourceType 值域；review-0831 任务 8fab2a9d 枚举化）
 * - 与 EventType 同等级的外部契约字段（events/SSE API 载荷顶层），此前无枚举保护；
 *   全仓 eventService.create 调用点实测取值集合 = {task, topic, message, board, doc}。
 * - ⚠️ 与 audit.entityType（开放 free varchar，写入侧已知取值清单 AUDIT_ENTITY_TYPES）
 *   是两套词汇：audit 专有值（board_list/board_member/topic_participant 等）不入本枚举。
 * - DTO 校验保持 @IsString() 开放（外部契约不变），本枚举供内部写入点命名引用。
 */
export enum ResourceType {
  TASK = 'task',
  TOPIC = 'topic',
  MESSAGE = 'message',
  BOARD = 'board',
  DOC = 'doc',
}

export enum ActorType {
  HUMAN = 'human',
  AGENT = 'agent',
  SYSTEM = 'system',
}

export enum ActivityAction {
  CREATED = 'created',
  UPDATED = 'updated',
  MOVED = 'moved',
  ASSIGNED = 'assigned',
  COMMENTED = 'commented',
  STATUS_CHANGED = 'status_changed',
}

export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LOGIN = 'login',
  LOGOUT = 'logout',
  RESET_API_KEY = 'reset_api_key',
  TOGGLE_AGENT = 'toggle_agent',
  PAUSE_TOPIC = 'pause_topic',
  RESUME_TOPIC = 'resume_topic',
  /** v1.60.0-dev：文档原子移动（verb_noun 风格对齐 reset_api_key/pause_topic 先例） */
  MOVE_DOC = 'move_doc',
}

export enum WebhookStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * 话题参与者状态
 * - invited: 已被邀请但尚未 join
 * - active: 活跃参与者（已 join）
 * - left: 已离开/被移除（保留历史行）
 */
export enum ParticipantStatus {
  INVITED = 'invited',
  ACTIVE = 'active',
  LEFT = 'left',
}

/**
 * 看板成员角色
 * - editor: 可编辑看板内容（列/任务）
 * - member: 只读访问
 */
export enum BoardMemberRole {
  EDITOR = 'editor',
  MEMBER = 'member',
}

/**
 * DocSpace 成员角色（doc_space_members.role 值域；review-0831 任务 a8a295df 枚举化）
 * - editor: 可编辑空间内容（文档/分类），由 addEditor 授予，或 create() 时 creator 自动写入
 * - member: 只读访问，由 inviteAgent 授予
 * creator 行约定：role='editor' 且 invitedBy=null（非授予产生），removeEditor/uninviteAgent
 * 对 creator 拒绝操作。值域与 BoardMemberRole 相同但语义独立（docspace 成员体系专属枚举，
 * 此前 service 裸字面量 + 借用 BoardMemberRole 比较，见 docspace.service.ts）。
 * role 列是裸 varchar(20)，新增枚举值无需 migration
 */
export enum DocSpaceMemberRole {
  EDITOR = 'editor',
  MEMBER = 'member',
}

/**
 * 话题参与者角色（v1.46 TOPIC-PERM 新增 editor，对齐 Board/DocSpace）
 * - moderator: 创建者行标记（topic_participants 中 creator 的 role，历史约定）
 * - editor: 可编辑话题内容字段（title/description）；结构字段/状态流转/成员管理仍 creator-only
 * - member: 普通参与者（只读 + 发言）
 * role 列是裸 varchar(30)，新增枚举值无需 migration
 */
export enum TopicParticipantRole {
  MODERATOR = 'moderator',
  EDITOR = 'editor',
  MEMBER = 'member',
}

export enum ErrorCode {
  // HTTP 基础映射
  SUCCESS = 200,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  RATE_LIMITED = 429,
  INTERNAL_ERROR = 500,

  // 认证/授权 (1000-1999)
  AGENT_DISABLED = 1001,
  TOPIC_PAUSED = 1002,
  INVALID_API_KEY = 1003,
  TASK_NOT_ASSIGNED = 1004,
  TOPIC_CLOSED = 1005,
  AGENT_NOT_IN_TOPIC = 1006,
  TOKEN_EXPIRED = 1007,
  TOKEN_INVALID = 1008,
  PERMISSION_DENIED = 1009,
  /** 404 — 目标 actor（人/agent 统一 actors 行）不存在：DocSpace creator 转让等按 actor 寻址的操作 */
  ACTOR_NOT_FOUND = 1010,

  // Topic (2000-2099)
  // ⚠️ 2001（TOPIC_ALREADY_CLOSED）/ 2003（TOPIC_CANNOT_SEND_MESSAGE）/ 4002（TASK_MOVE_INVALID_LIST）
  //    已退役（2026-08-31 死契约清理），编号永不复用——占位防复用
  TOPIC_NOT_FOUND = 2000,
  TOPIC_ALREADY_ARCHIVED = 2002,

  // Message (2100-2199)
  MESSAGE_NOT_FOUND = 2100,
  MESSAGE_CANNOT_DELETE = 2101,
  TOPIC_MESSAGE_NOT_FOUND = 2102,

  // Board/List (3000-3099)
  BOARD_NOT_FOUND = 3000,
  LIST_NOT_FOUND = 3001,
  LIST_NOT_EMPTY = 3002,

  // Task (4000-4099)
  TASK_NOT_FOUND = 4000,
  TASK_STATUS_INVALID = 4001,
  TASK_DEPENDENCY_CYCLE = 4003,
  TASK_DEPENDENCY_SELF = 4004,
  TASK_DEPENDENCY_NOT_FOUND = 4005,
  TASK_ALREADY_DEPENDS = 4006,

  // Milestone (7000-7099)
  MILESTONE_NOT_FOUND = 7000,
  MILESTONE_NAME_EXISTS = 7001,
  /** 400 — 状态流转非法（含 version 与状态类别不匹配、前置态不满足） */
  MILESTONE_INVALID_TRANSITION = 7002,
  /** 400 — deployed 只能经 POST /tasks/milestones/:id/deployed 写入，PATCH 一律拒绝 */
  MILESTONE_DEPLOY_VIA_ENDPOINT = 7003,
  /** 409 — 同 board 内 version 重复（部分唯一索引 uq_milestones_board_version 23505） */
  MILESTONE_VERSION_CONFLICT = 7004,

  // Agent (5000-5099)
  AGENT_NOT_FOUND = 5000,
  AGENT_NAME_EXISTS = 5001,

  // User (6000-6099)
  USER_NOT_FOUND = 6000,
  USER_EMAIL_EXISTS = 6001,
  USER_PASSWORD_INVALID = 6002,

  // Skill (8000-8099)
  SKILL_NOT_FOUND = 8000,

  // 通用业务 (9000-9099)
  VALIDATION_ERROR = 9000,
  RESOURCE_CONFLICT = 9001,
  /** 409 — 幂等键冲突：同 clientRequestId 但 request_hash 不符（payload 与首次请求不同），拒绝重放（v1.63.0 DocSpace 写族） */
  IDEMPOTENCY_KEY_CONFLICT = 9002,

  // DocSpace (10000-10099)
  DOC_SPACE_NOT_FOUND = 10000,
  DOC_NOT_FOUND = 10001,
  DOC_CATEGORY_NOT_FOUND = 10002,
  /** 409 — 只读来源或 source 冲突 */
  DOC_SOURCE_MISMATCH = 10003,
  DOC_LINK_NOT_FOUND = 10004,
  /** 400 — doc_routes 写时校验：primary/secondary doc 不存在、已软删或不属于该空间 */
  DOC_ROUTE_DOC_NOT_FOUND = 10005,
  /** 400 — doc_routes 写时校验：headingPath 非空但未精确命中该 doc 的 doc_sections.heading_path */
  DOC_ROUTE_HEADING_UNRESOLVED = 10006,
  /** 400 — doc_routes 写时校验：codeEntry 超长、绝对路径或含 `..` 段 */
  DOC_ROUTE_INVALID_CODE_ENTRY = 10007,
  /** 404 — doc_routes 目标路由不存在 */
  DOC_ROUTE_NOT_FOUND = 10008,
  /** 409 — 文档写前提校验失败（stale expectedContentHash / expectedSectionHash，调用方须重读后重试） */
  DOC_CONTENT_CONFLICT = 10009,
  /** 422 — Diagram IR 校验/渲染门不过（parse/schema/render/composition 阶段），data 带 {stage, diagnostics[]} 修复凭据 */
  DIAGRAM_VALIDATION_FAILED = 10010,
  /** 422 — diagram JSON patch 应用失败（指针不存在/类型不符/根操作），data 带 {pointer, reason, supportedOps} */
  DIAGRAM_PATCH_FAILED = 10011,
  /** 400 — markdown 写通道触及 diagram doc（patch_section/patch_match/append/metadata docType 双向转换）或图工具命中非 diagram doc */
  DIAGRAM_DOC_TYPE_LOCKED = 10012,
  /** 409 — 存量 diagram doc 无渲染快照（历史数据），指路 re-upsert / forceRechunk 重渲染 */
  DIAGRAM_SNAPSHOT_MISSING = 10013,

  // Roundtable (11000-11099)
  /** 404 — 审批请求不存在（裁决/查询目标缺失） */
  ROUNDTABLE_PERMISSION_REQUEST_NOT_FOUND = 11000,
  /** 404 — 圆桌座位不存在（座位移除等操作目标缺失） */
  ROUNDTABLE_SEAT_NOT_FOUND = 11001,
  /** 409 — 同一 topic 下该 actor 已有 active 座位（r17 唯一约束：一 agent 一 topic 一 active 座位；removed 软删豁免可重建） */
  ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT = 11002,
}

/**
 * 话题类型（topics.kind 列值域，设计 docs/roundtable-design.md §5；review-0831 任务 150bf876）
 * - normal：普通话题（缺省，存量行零感知）
 * - roundtable：圆桌模式（席位 + 会话层规则 wakePolicy/攒批生效）
 * 创建后不可变——update 忽略 kind，normal↔roundtable 互转在 M2 推迟清单
 */
export enum TopicKind {
  NORMAL = 'normal',
  ROUNDTABLE = 'roundtable',
}

/**
 * 圆桌唤醒策略（topic.settings.wakePolicy 值域，设计 §6，r4 + R1 拍板）
 * - mention：仅 @座位label / @all 唤醒对应座位（缺省，新桌默认省钱安全）
 * - broadcast：新消息唤醒全部 active 座位（高强度讨论桌可选）
 * 普通话题（kind=normal）不消费该值，但按「配置原样存储」语义照常写入 settings
 */
export enum WakePolicy {
  MENTION = 'mention',
  BROADCAST = 'broadcast',
}

/**
 * 圆桌座位生命周期状态值域（roundtable_seats.status，五值全量；review-0831 任务 150bf876）
 * - active：座位已启用、待 runner 认领（默认）
 * - paused：暂停（座位管理操作 M3 落地）
 * - parked：非唤醒消息暂存（攒批收集器语义）
 * - offline：runner 断连/主动离线
 * - removed：软删（M3 阶段 3 座位移除，行保留供溯源）
 * ⚠️ 与协议包 SEAT_RUNTIME_STATUSES（online/busy/offline，SeatEvent 运行态）是两套词汇，勿混
 */
export const SEAT_LIFECYCLE_STATUSES = ['active', 'paused', 'parked', 'offline', 'removed'] as const;

/** 圆桌座位生命周期状态类型 */
export type SeatLifecycleStatus = (typeof SEAT_LIFECYCLE_STATUSES)[number];

/**
 * 命名访问视图（单源派生自 SEAT_LIFECYCLE_STATUSES；与 docspace CODE_ENTRY_TYPE 同款
 * 「值域数组 + 命名化派生」模式，供 entity/query/save 命名引用）
 */
export const SEAT_LIFECYCLE_STATUS = {
  ACTIVE: SEAT_LIFECYCLE_STATUSES[0],
  PAUSED: SEAT_LIFECYCLE_STATUSES[1],
  PARKED: SEAT_LIFECYCLE_STATUSES[2],
  OFFLINE: SEAT_LIFECYCLE_STATUSES[3],
  REMOVED: SEAT_LIFECYCLE_STATUSES[4],
} as const;

/**
 * 座位实时相位值域（M4b-1 presence 派生视图，不落库；review-0831 任务 150bf876）
 * - thinking：思考中（busy 相位 / activity 边沿）
 * - tool：工具调用中（带 toolTitle）
 * - replying：回复中（message_chunk 流式增量）
 * - idle：空闲（message_complete 终结）
 * - offline：离线（runner 断连/主动报离线）
 */
export const PRESENCE_PHASES = ['thinking', 'tool', 'replying', 'idle', 'offline'] as const;

/** 座位实时相位类型 */
export type PresencePhase = (typeof PRESENCE_PHASES)[number];

/** 命名访问视图（单源派生自 PRESENCE_PHASES，供 presence 比较/赋值命名引用） */
export const PRESENCE_PHASE = {
  THINKING: PRESENCE_PHASES[0],
  TOOL: PRESENCE_PHASES[1],
  REPLYING: PRESENCE_PHASES[2],
  IDLE: PRESENCE_PHASES[3],
  OFFLINE: PRESENCE_PHASES[4],
} as const;
