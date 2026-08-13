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
  role?: 'admin' | 'editor';
}

/**
 * [Admin 专用] 更新用户请求
 * [注意] 该类型暂未纳入 shared 包，前端本地维护
 */
export interface UpdateUserRequest {
  name?: string;
  role?: 'admin' | 'editor';
  status?: string;
}

// ──────────────────────────────────────────────
// Re-exports from @agent-chamber/shared
// ──────────────────────────────────────────────

// 分页响应（已从 shared 包统一）
export type { PaginatedResponse } from '@agent-chamber/shared';
export { UserRole } from '@agent-chamber/shared';

// 枚举类型
export { MessageType, BoardMemberRole, ParticipantStatus } from '@agent-chamber/shared';

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
  AuditLog,
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
