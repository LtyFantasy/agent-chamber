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

// ──────────────────────────────────────────────
// 经验库（Experience Base，批 1 shared 单源）
// ──────────────────────────────────────────────

/**
 * 经验库值域（受控词表 / 反馈结果 / env 键白名单）
 *
 * 单源 = `packages/shared/src/enums/index.ts` 与 `dto/experience.dto.ts`——web 侧
 * 一律经本 barrel 引用（禁在页面/组件内手抄词表）：Badge 分支、表单下拉、
 * 过滤控件候选全部由这些常量派生。
 */
export {
  EXPERIENCE_INTENTS,
  EXPERIENCE_INTENT,
  EXPERIENCE_QUALITIES,
  EXPERIENCE_QUALITY,
  EXPERIENCE_FEEDBACK_OUTCOMES,
  EXPERIENCE_FEEDBACK_OUTCOME,
  EXPERIENCE_ENV_KEYS,
} from '@agent-chamber/shared';

/**
 * 经验库输入侧常量与值域类型
 *
 * `EXPERIENCE_TITLE_MAX_LENGTH` / `SUMMARY` / `CONTENT` 是**列宽单源**（entity 列长
 * + 后端 DTO `@MaxLength` 共用同一常量）⇒ 前端表单的 `maxLength` 直接取用，禁硬编码。
 * 注意：signals/domains 的元素数与元素长度上限**不在 shared**（后端模块内常量），
 * web 侧镜像在 `@/lib/experience`。
 */
export {
  EXPERIENCE_TITLE_MAX_LENGTH,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
  EXPERIENCE_CONTENT_MAX_LENGTH,
  EXPERIENCE_SORT_VALUES,
} from '@agent-chamber/shared';
export type { ExperienceEnv, ExperienceEnvKey, ExperienceSort } from '@agent-chamber/shared';

/** 经验库值域类型（与上面的值常量配对：类型用于 props/接口签名，常量用于渲染分支） */
export type {
  ExperienceIntent,
  ExperienceQuality,
  ExperienceFeedbackOutcome,
  ExperienceMemberRole,
} from '@agent-chamber/shared';

/**
 * 经验库响应投影类型（列表 / 详情 / 分面 / 写入结果）
 *
 * 形状来源 = `packages/shared/src/dto/experience-response.dto.ts`（批 1 交付）。
 * 列表投影**不含 content 全文**——凡是"要不要展开正文"的判断，都以 `ExperienceSummary`
 * 为界：卡片渲染用 Summary，正文只有详情端点返回的 `ExperienceDetail` 才有。
 */
export type {
  ExperienceDuplicateCandidate,
  ExperienceSummary,
  ExperienceDetail,
  ExperienceAppliedFilters,
  ExperienceListResponse,
  ExperienceFacetsResponse,
  // v1.81.0：分面「按录入者」元素（筛选下拉的选项源）
  ExperienceCreatorFacet,
  RecordExperienceResponse,
  ExperienceFeedbackResponse,
  ExperienceQualityReviewResponse,
  // 第二期：成员面（`ExperienceMemberDto`/`ExperienceMembersResponse`）+ 判别快照
  ExperienceMemberDto,
  ExperienceMembersResponse,
  ExperienceJudgment,
} from '@agent-chamber/shared';

// ──────────────────────────────────────────────
// DocSpace 空间级导出 / 回导 bundle（web 视图层本地类型）
// ──────────────────────────────────────────────

import type { Visibility } from '@agent-chamber/shared';

/**
 * 空间级导出 bundle（`GET /doc-spaces/:id/export`，formatVersion 2）。
 *
 * 形状来源 = `apps/backend/src/modules/docspace/doc-bundle.service.ts:126-177`
 * （导出侧 DocSpaceExportBundle / DocBundleDocItem）。
 * web 只消费 `space.name` / `space.visibility` / `docs[].path` / 各段长度——
 * 其余字段一律原样回传回导端点，不在前端解释（解析后的对象即回导请求体）。
 */
export interface DocSpaceExportBundle {
  /** bundle 格式版本（当前 2；1 = 无 media 段，回导仍接受） */
  formatVersion: number;
  /** 导出时刻（ISO 8601，informational） */
  exportedAt?: string;
  /** 空间元数据（name 必填：回导 DTO 校验要求） */
  space: {
    name: string;
    description?: string | null;
    visibility?: Visibility;
    /** 原始 settings jsonb（overwriteSpaceMeta=true 时整对象替换目标空间） */
    settings?: Record<string, unknown>;
  };
  /** 分类段（业务键 = name） */
  categories?: Record<string, unknown>[];
  /** intent 路由段（业务键 = intent + primaryDocPath） */
  routes?: Record<string, unknown>[];
  /** 文档段（可缺席 = 合法的 0 篇包；回导 DTO 中为可选字段） */
  docs?: DocSpaceBundleDocItem[];
  /**
   * 媒体段（formatVersion 2；条目可能是完整项或 `{skipped}` 标记）。
   *
   * 形状刻意保持 `Record<string, unknown>[]`（回导 = 原样回传，web 不解释字段）；
   * 需要读字段的消费方（人类可读 ZIP 导出）在 `@/lib/doc-human-export` 内自查窄化 + 谓词。
   */
  media?: Record<string, unknown>[];
  /** 正文引用但刻意未打包的附件（informational，回导后为断链） */
  mediaOmitted?: Record<string, unknown>[];
}

/** bundle.docs[] 条目（web 只读 path；其余字段原样回传） */
export interface DocSpaceBundleDocItem {
  path: string;
}

/** 回导 per-item 结果（categories / routes 段通用） */
export interface DocSpaceBundleItemResult {
  status: 'created' | 'updated' | 'failed';
  id?: string;
  error?: { message: string; code?: number };
}

/** 回导结果：docs 段（复用批量 upsert 结果形状，四态含 unchanged） */
export interface DocSpaceBundleDocsSection {
  results: {
    path: string;
    status: 'created' | 'updated' | 'unchanged' | 'failed';
    id?: string;
    error?: { message: string; code?: number };
  }[];
  summary: { total: number; created: number; updated: number; unchanged: number; failed: number };
}

/** 回导结果：categories 段（三态，**无 unchanged**） */
export interface DocSpaceBundleCategoriesSection {
  results: (DocSpaceBundleItemResult & { name: string })[];
  summary: { total: number; created: number; updated: number; failed: number };
}

/** 回导结果：routes 段（三态，**无 unchanged**；业务键 = intent + primaryDocPath） */
export interface DocSpaceBundleRoutesSection {
  results: (DocSpaceBundleItemResult & { intent: string; primaryDocPath: string | null })[];
  summary: { total: number; created: number; updated: number; failed: number };
}

/**
 * 回导结果：media 段（formatVersion 2 才有内容；v1 包恒全零值形状）。
 * `failed[].originalName` 可空 → 展示时回退 `docPath`。
 */
export interface DocSpaceBundleMediaSection {
  created: number;
  reused: number;
  skipped: number;
  failed: { docPath: string; originalName: string | null; reason: string }[];
}

/**
 * 回导结果：space meta 段（默认 skipped；overwriteSpaceMeta=true 才写）。
 *
 * `error` 声明存在但**当前实现无产出路径**（`doc-bundle.service.ts:973-991` 无 try/catch，
 * phase ⑥ 抛错 = 请求级 500 且 ①–⑤ 可能已落库）——UI 做防御性渲染，勿据此设计流程。
 */
export interface DocSpaceBundleSpaceMetaSection {
  applied: boolean;
  status: 'updated' | 'skipped';
  error?: { message: string; code?: number };
}

/**
 * 空间级回导结果（`POST /doc-spaces/:id/import-bundle`）。
 *
 * 形状来源 = `doc-bundle.service.ts:226-283`（回导结果信封）；
 * per-doc error 形状 = `packages/shared/src/dto/docspace-response.dto.ts:926-938`。
 */
export interface DocSpaceImportBundleResult {
  formatVersion: number;
  importedAt: string;
  docs: DocSpaceBundleDocsSection;
  categories: DocSpaceBundleCategoriesSection;
  routes: DocSpaceBundleRoutesSection;
  media: DocSpaceBundleMediaSection;
  spaceMeta: DocSpaceBundleSpaceMetaSection;
}
