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

export enum TopicStatus {
  DRAFT = 'draft',
  OPEN = 'open',
  ACTIVE = 'active',
  VOTING = 'voting',
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
  TOPIC_NOT_FOUND = 2000,
  TOPIC_ALREADY_CLOSED = 2001,
  TOPIC_ALREADY_ARCHIVED = 2002,
  TOPIC_CANNOT_SEND_MESSAGE = 2003,

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
  TASK_MOVE_INVALID_LIST = 4002,
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

  // Roundtable (11000-11099)
  /** 404 — 审批请求不存在（裁决/查询目标缺失） */
  ROUNDTABLE_PERMISSION_REQUEST_NOT_FOUND = 11000,
  /** 404 — 圆桌座位不存在（座位移除等操作目标缺失） */
  ROUNDTABLE_SEAT_NOT_FOUND = 11001,
  /** 409 — 同一 topic 下该 actor 已有 active 座位（r17 唯一约束：一 agent 一 topic 一 active 座位；removed 软删豁免可重建） */
  ROUNDTABLE_SEAT_BIND_ACTOR_CONFLICT = 11002,
}
