/**
 * [前端视图层包装器] 统一 API 响应格式
 * [说明] 前端特有类型，不从 shared 包迁移
 */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
  requestId: string;
}

/**
 * [前端查询参数抽象] 列表查询通用参数
 * [说明] 前端特有类型，不从 shared 包迁移
 */
export interface ListQueryParams {
  page?: number;
  pageSize?: number;
  sort?: string;
  q?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * [Admin 专用] 创建用户请求
 * [注意] 该类型暂未纳入 shared 包，前端本地维护
 */
export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
  // 角色值域单源 = shared UserRole（review-0831 任务 e013af33 收敛，本文件已 re-export）
  role?: UserRole;
}

/**
 * [Admin 专用] 更新用户请求
 * [注意] 该类型暂未纳入 shared 包，前端本地维护
 */
export interface UpdateUserRequest {
  name?: string;
  // 角色值域单源 = shared UserRole（review-0831 任务 e013af33 收敛，本文件已 re-export）
  role?: UserRole;
  status?: string;
}

// ──────────────────────────────────────────────
// Re-exports from @agent-chamber/shared
// ──────────────────────────────────────────────

// 分页响应（已从 shared 包统一）
export type { PaginatedResponse } from '@agent-chamber/shared';
// 存活探针响应（@SkipTransform 裸响应，无 data 包装）
export type { HealthStatus } from '@agent-chamber/shared';
// 系统观测总览（GET /system/overview，admin-only）
export type { SystemOverview, RunnerOverviewItem, SeatOverviewItem } from '@agent-chamber/shared';
// UserRole 本地 import（CreateUserRequest/UpdateUserRequest 的 role 字段引用，见上）+ re-export
import { UserRole } from '@agent-chamber/shared';
export { UserRole };

// 枚举类型
export {
  MessageType,
  BoardMemberRole,
  DocSpaceMemberRole,
  ParticipantStatus,
} from '@agent-chamber/shared';
// 枚举类型（review-0831 任务 8b57f5a5 补全：web 侧魔法字符串比较单源化所需）
export {
  AgentStatus,
  TopicStatus,
  Visibility,
  TaskStatus,
  ActorType,
  EventType,
  TopicParticipantRole,
  MilestoneStatus,
  ActivityAction,
} from '@agent-chamber/shared';
// 事件资源类型（review-0831 任务 8fab2a9d：events/SSE resourceType 值域枚举化）
export { ResourceType } from '@agent-chamber/shared';
// 文档源哨兵（review-0831 任务 8fab2a9d：上移 shared 后 web 侧改引单源）
export { DOC_SOURCE_NATIVE } from '@agent-chamber/shared';
// 活动日志（GET /activity-logs，活动日志系统 Phase 4 web 页）
export type {
  ActivityLogItem,
  ActivityLogListResponse,
  ActivityLogQuery,
} from '@agent-chamber/shared';
export { AuditAction } from '@agent-chamber/shared';

// DocSpace Input DTO
export type {
  CreateDocSpaceInput,
  UpdateDocSpaceInput,
  CreateDocCategoryInput,
  UpdateDocCategoryInput,
  UpsertDocInput,
  SpaceMemberInput,
  TaskDocLinkInput,
} from '@agent-chamber/shared';

// Input DTO 别名（前端习惯用 Request 后缀）
export type {
  CreateTopicInput as CreateTopicRequest,
  UpdateTopicInput as UpdateTopicRequest,
  SendMessageInput as SendMessageRequest,
  AgendaItemInput,
  TopicConfigInput,
  UpdateAgendaInput,
  MarkAsReadInput,
  CreateBoardInput as CreateBoardRequest,
  UpdateBoardInput as UpdateBoardRequest,
  CreateBoardListInput,
  UpdateBoardListInput,
  ReorderBoardListsInput,
  ReorderTasksInput,
  CreateTaskInput as CreateTaskRequest,
  UpdateTaskInput as UpdateTaskRequest,
  MoveTaskInput as MoveTaskRequest,
  AssignTaskInput as AssignTaskRequest,
  AddCommentInput,
  AddTaskDependencyInput,
  BatchCreateTasksInput,
  CreateMilestoneInput,
  UpdateMilestoneInput,
  QueryTaskInput,
  CreateAgentInput as CreateAgentRequest,
  UpdateAgentInput as UpdateAgentRequest,
  AgentConfigInput,
  AgentHeartbeatInput,
  CreateAgentKeyInput,
  LoginInput as LoginRequest,
  RegisterInput as RegisterRequest,
  RefreshTokenInput,
  ChangePasswordInput as ChangePasswordRequest,
  UpdateSettingsInput,
} from '@agent-chamber/shared';

// 前端沿用 shared 的 UpdateProfileInput 别名：avatar 为 string | null（传 null 清空头像，
// 回落确定性生成头像并联动清除 avatar_svg；后端 @IsOptional() 对 null 跳过 @IsUrl 校验）。
import type { UpdateProfileInput } from '@agent-chamber/shared';
export type UpdateUserProfileRequest = UpdateProfileInput;

// Response / Entity 类型（统一从 shared 包 re-export）
export type {
  User,
  AdminUser,
  AuthResponse,
  Agent,
  AgentDetail,
  AgentStats,
  Topic,
  TopicDetail,
  TopicParticipant,
  Message,
  UnreadSummary,
  Board,
  BoardDetail,
  BoardList,
  BoardListSummary,
  BoardMember,
  TaskSummary,
  TaskDetail,
  TaskDependencyItem,
  Label,
  ChecklistItem,
  Attachment,
  Comment,
  Activity,
  Milestone,
  SearchResult,
  MessageSearchResult,
  TaskSearchResult,
  SearchQuery,
  SearchType,
  DashboardStats,
  AgentActivity,
  AgentLeaderboardItem,
  // 删除影响面（GET /agents/:id/deletion-impact，统一批 B）
  AgentDeletionImpact,
  AuditLog,
  ApiLogListResponse,
  // DocSpace 响应类型
  DocSpaceSummary,
  DocSpaceDetail,
  DocSpaceMemberDto,
  DocCategoryDto,
  DocSummary,
  DocDetail,
  DocSectionOutline,
  DocSectionContent,
  DocFullContent,
  DocSearchHit,
  DocSearchHitWithSpace,
  DocSpaceOverview,
  DocCategoryOverview,
  TaskDocLinkItem,
  UpsertDocResult,
  // 链接健康巡检结果
  LinkHealth,
} from '@agent-chamber/shared';
