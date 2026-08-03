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

export enum MilestoneStatus {
  PLANNED = 'planned',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
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

  // DocSpace (10000-10099)
  DOC_SPACE_NOT_FOUND = 10000,
  DOC_NOT_FOUND = 10001,
  DOC_CATEGORY_NOT_FOUND = 10002,
  /** 409 — 只读来源或 source 冲突 */
  DOC_SOURCE_MISMATCH = 10003,
  DOC_LINK_NOT_FOUND = 10004,
}
