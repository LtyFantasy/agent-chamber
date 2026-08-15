import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { useAuthStore } from '@/stores/auth.store';
import { getApiMessage } from '@/i18n/api-messages';
import type {
  ApiResponse,
  LoginRequest,
  RegisterRequest,
  AuthResponse,
  User,
  PaginatedResponse,
  ListQueryParams,
  Agent,
  AgentDetail,
  CreateAgentRequest,
  UpdateAgentRequest,
  Topic,
  TopicDetail,
  CreateTopicRequest,
  UpdateTopicRequest,
  Message,
  SendMessageRequest,
  Board,
  BoardDetail,
  BoardList,
  BoardListSummary,
  CreateBoardRequest,
  UpdateBoardRequest,
  TaskSummary,
  TaskDetail,
  TaskDependencyItem,
  Milestone,
  CreateTaskRequest,
  UpdateTaskRequest,
  MoveTaskRequest,
  AssignTaskRequest,
  DashboardStats,
  AgentActivity,
  AgentLeaderboardItem,
  AgentStats,
  UpdateUserProfileRequest,
  ChangePasswordRequest,
  AdminUser,
  CreateUserRequest,
  UpdateUserRequest,
  AuditLog,
  HealthStatus,
  UnreadSummary,
  SearchResult,
  SearchQuery,
  AgendaItemInput,
  DocSpaceSummary,
  DocSpaceDetail,
  DocCategoryDto,
  DocSummary,
  DocDetail,
  DocSectionContent,
  DocFullContent,
  DocSearchHit,
  DocSpaceOverview,
  TaskDocLinkItem,
  CreateDocSpaceInput,
  UpdateDocSpaceInput,
  CreateDocCategoryInput,
  UpdateDocCategoryInput,
  UpsertDocInput,
  UpsertDocResult,
} from '@/types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

export const axiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * 公开 axios 实例，用于无需认证的 API（如 Skill 下载页）。
 *
 * 与 `axiosInstance` 的区别：
 * - 不注入 JWT token
 * - 不拦截 401 跳转登录，避免公开页面被意外重定向
 */
export const publicAxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: inject JWT token
axiosInstance.interceptors.request.use(
  (config) => {
    const token = useAuthStore.getState().accessToken;
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// Response interceptor: unified error handling
axiosInstance.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError<ApiResponse<unknown>>) => {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      const message = data?.message || getApiMessage('requestFailed');
      const code = data?.code;

      // Attach code to error for business layer handling
      (error as unknown as { code?: string | number }).code = code;

      switch (status) {
        case 401:
          useAuthStore.getState().logout();
          if (typeof window !== 'undefined') {
            window.location.href = '/login';
          }
          break;
        case 403:
          console.error('权限不足:', message, 'code:', code);
          break;
        case 404:
          // 404 多为预期业务态（文档已删/坏链直达），warn 足以留痕；
          // console.error 会被 Next dev 浮层弹成整页报错，误导用户
          console.warn('资源不存在:', message, 'code:', code);
          break;
        case 422:
          // Validation errors handled by business layer
          break;
        default:
          console.error('服务器错误:', message, 'code:', code);
      }
    }
    return Promise.reject(error);
  },
);

async function apiRequest<T>(
  method: string,
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const response = await axiosInstance.request<ApiResponse<T>>({
    method,
    url,
    data,
    ...config,
  });
  return response.data.data;
}

/**
 * 公开 API 请求封装，使用 `publicAxiosInstance`。
 *
 * 用于无需认证的接口，返回后端统一响应体中的 `data` 字段。
 */
async function publicApiRequest<T>(
  method: string,
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  const response = await publicAxiosInstance.request<ApiResponse<T>>({
    method,
    url,
    data,
    ...config,
  });
  return response.data.data;
}

/**
 * 座位近况活动条目（M4b-1，落 seat.state.recentActivity——participant 全可读，
 * 故服务端已 R5 摘要化：剥离 rawInput/locations 等敏感载荷、title 截断 + cwd 前缀剥离；
 * 形状对齐 backend roundtable.service.ts RecentActivityItem，cap 10 环形）
 */
export interface RoundtableRecentActivityItem {
  /** 活动发生时间（ISO 8601） */
  at: string;
  /** 活动类别：tool_call（工具调用）/ turn（一轮发言终结）/ permission（审批请求） */
  kind: 'tool_call' | 'turn' | 'permission';
  /** 摘要文本（工具标题或「回复 n 字/沉默」——服务端摘要语义，原文透传不翻译） */
  summary: string;
  /** 结果态（工具 status / stopReason / 'pending'，原文透传不翻译） */
  result: string;
}

/**
 * 座位实时相位（M4b-1，chamber 内存派生视图：不落库、不进 events 表，
 * listSeats 响应时 overlay——形状对齐 backend roundtable.service.ts SeatPresence；
 * 无 presence 字段 = 座位从未活动（服务端不加字段））
 */
export interface RoundtableSeatPresence {
  /** 相位：thinking 思考中 / tool 工具调用中 / replying 回复中 / idle 空闲 / offline 离线 */
  phase: 'thinking' | 'tool' | 'replying' | 'idle' | 'offline';
  /** 相位变更时间（ISO 8601） */
  at: string;
  /** 工具标题（仅 phase='tool' 时存在；已摘要化，供 chip 展示） */
  toolTitle?: string;
}

/**
 * 圆桌座位（web 侧最小投影：补全候选只消费 label/status，审批卡片消费 id→label 映射；
 * 完整实体在 backend database/entities/roundtable-seat.entity.ts，M3 管理 UI 再收口）
 */
export interface RoundtableSeatItem {
  /** 座位 UUID（审批请求 seatId→label 映射键） */
  id: string;
  /** 座位展示名（seatLabel 身份模型，@ 补全候选） */
  label: string;
  /** 生命周期状态：active / paused / parked / offline（已移除座位不出现在列表） */
  status: string;
  /** 厂商（'kimi'，M4a 起扩展至 codex/opencode/claude-code） */
  vendor: string;
  /**
   * 认领 runner UUID（backend 实体字段原样透出；null = 未被任何 runner 认领）。
   * 连接向导验收环的「座位被认领」直接信号（roundtable-design §8c）。
   */
  runnerId: string | null;
  /** 主脑座位标记（M3 阶段 3，r13 座位管理 UI 展示用；backend listSeats 返回全实体） */
  coordinator?: boolean;
  /**
   * 运行时状态（backend 实体 state jsonb 原样透出；M3 阶段 5 起含 modelInfo——
   * 座位**实际在跑**的配置观测 model/thinking/mode（地面真相，非 config 创建声明），
   * 字段全可选：不同 vendor 可能有缺；lastUsage 同款嵌套在 state 内）
   */
  state?: {
    modelInfo?: { model?: string; thinking?: string; mode?: string };
    /** M4b-1 近况时间线（cap 10 环形，服务端摘要化——participant 全可读） */
    recentActivity?: RoundtableRecentActivityItem[];
    /** 沉默轮计数（圆桌安全阀 r7，沉默拦截时 +1） */
    silentCount?: number;
    /** 最近一次 usage 通知（M1 顺手存，M3 预算熔断数据源）：used/size 为 token 计数 */
    lastUsage?: { used: number; size: number; at: string };
  };
  /**
   * M4b-1 实时相位（chamber 内存推导 overlay：随 listSeats 响应合并，
   * 不落库；无条目 = 从未活动，后端不加字段）
   */
  presence?: RoundtableSeatPresence;
  /**
   * 静态配置（backend 实体 config jsonb 原样透出，shape 未冻结——宽松读取，只投影
   * web 用到的字段）。bindActorId：座位绑定的 agent actor id（runner 用该 agent 的
   * API Key 拨号时才会领到这些座位，roundtable-design §7）；参与者面板按它把座位
   * chip 归组到对应 agent 行（roundtable-design §6 座位管理，M3 阶段 3 改版）。
   */
  config?: {
    /** 绑定的 agent actor id（agent 创建者缺省绑自己；人类创建必须显式指定） */
    bindActorId?: string;
  };
}

/**
 * 圆桌审批请求（web 侧投影，字段对齐 backend RoundtablePermissionRequest entity +
 * api-definition.md §7a；tool/options 是 jsonb 原样透传——**形状未冻结**：
 * tool = ToolBrief（宽松 `{ name?/title?/kind? }`），options 实测 ACP 形状
 * `{ optionId, kind, name }`（kimi/codex 真机两侧均无 label；kind ∈
 * allow_once/allow_always/reject 之类），裁决 optionId 按 optionId/id 双键匹配
 * （后端同规，铁律 #20 契约即设计）
 */
export interface RoundtablePermissionRequestItem {
  /** 审批请求行 id（裁决端点 Path 参数） */
  id: string;
  /** runner 侧请求 ID（ACP JSON-RPC id，仅展示/对账用） */
  requestId: string;
  /** 发起请求的座位 UUID（→ seats 数据映射 label） */
  seatId: string;
  /** 所属圆桌 topic UUID */
  topicId: string;
  /** 工具摘要（ToolBrief jsonb，形状未冻结，宽松读取） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: Record<string, any>;
  /** 审批选项（PermissionOption[] jsonb，形状未冻结；name 渲染按钮文案，label 为历史兼容回退） */
  options: { optionId?: string; id?: string; kind?: string; label?: string; name?: string }[];
  /** pending / approved / rejected / orphaned（orphaned = runner 断连作废） */
  status: 'pending' | 'approved' | 'rejected' | 'orphaned';
  /** 裁决选中的选项 id（pending/orphaned 时为 null） */
  verdictOptionId: string | null;
  /** 裁决者 actor id（仅人类裁决写入） */
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

/** Skill 列表项 */
export interface SkillListItem {
  name: string;
  description: string;
  version: string;
  updatedAt: string;
}

/** Skill 详情 */
export interface SkillDetail extends SkillListItem {
  content: string;
}

/**
 * 事件轮询项（GET /events/poll 返回的事件投影；字段对齐 backend Event entity——
 * event.entity.ts，cursor 为微秒时间戳 bigint 字符串，单调递增，直接回传下一轮 poll）
 */
export interface EventItem {
  id: string;
  /** 事件类型（'new_message' / 'task_created' 等；全量枚举见 @agent-chamber/shared EventType） */
  eventType: string;
  /** 资源类型（如 'topic' / 'board' / 'task'） */
  resourceType: string;
  resourceId: string;
  actorId: string | null;
  topicId: string | null;
  boardId: string | null;
  /** 事件负载（jsonb 原样透出，形状按 eventType 解释、未冻结；new_message 含 messageId） */
  payload: Record<string, unknown>;
  /** 轮询游标：微秒时间戳 bigint 字符串，服务端保证单调递增，作为下一轮 poll 的 cursor */
  cursor: string;
  delivered: boolean;
  deliveredAt: string | null;
  createdAt: string;
}

// ──────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────
const auth = {
  login: (data: LoginRequest) => apiRequest<AuthResponse>('POST', '/auth/login', data),
  register: (data: RegisterRequest) => apiRequest<AuthResponse>('POST', '/auth/register', data),
  logout: () => apiRequest<void>('POST', '/auth/logout'),
  refresh: (refreshToken: string) =>
    apiRequest<{ accessToken: string; refreshToken: string; expiresIn: number }>(
      'POST',
      '/auth/refresh',
      { refreshToken },
    ),
};

// ──────────────────────────────────────────────
// User
// ──────────────────────────────────────────────
const users = {
  me: () => apiRequest<User>('GET', '/users/me'),
  updateMe: (data: UpdateUserProfileRequest) => apiRequest<User>('PATCH', '/users/me', data),
  changePassword: (data: ChangePasswordRequest) =>
    apiRequest<void>('POST', '/users/me/change-password', data),

  // Admin 用户管理 API
  list: (params?: ListQueryParams) =>
    apiRequest<PaginatedResponse<AdminUser>>('GET', '/admin/users', undefined, { params }),
  create: (data: CreateUserRequest) => apiRequest<AdminUser>('POST', '/admin/users', data),
  update: (id: string, data: UpdateUserRequest) =>
    apiRequest<AdminUser>('PATCH', `/admin/users/${id}`, data),
  delete: (id: string) => apiRequest<void>('DELETE', `/admin/users/${id}`),

  /** 查询用户列表（轻量，用于邀请下拉选择） */
  listUsers: (params?: { page?: number; pageSize?: number; q?: string }) =>
    apiRequest<PaginatedResponse<User>>('GET', '/users', undefined, { params }),
};

// ──────────────────────────────────────────────
// Agent
// ──────────────────────────────────────────────
const agents = {
  list: (params?: ListQueryParams) =>
    apiRequest<PaginatedResponse<Agent>>('GET', '/agents', undefined, { params }),
  /**
   * 循环翻页拉取全部 agents（评审 M-e）
   *
   * 后端分页上限 100：一次性 pageSize:100 在拥有 >100 个 agent 时静默丢失尾部，
   * 导致 owner 代理判定（myAgentIds）/邀请选择器缺项。此处按 hasNext/total 翻页收齐。
   */
  listAll: async (): Promise<Agent[]> => {
    const pageSize = 100;
    const all: Agent[] = [];
    for (let page = 1; ; page++) {
      const res = await apiRequest<PaginatedResponse<Agent>>('GET', '/agents', undefined, {
        params: { page, pageSize },
      });
      all.push(...res.items);
      // 终止条件：后端已声明无下一页，或本页已收齐 total 条
      if (!res.hasNext || all.length >= res.total) break;
    }
    return all;
  },
  getById: (id: string) => apiRequest<AgentDetail>('GET', `/agents/${id}`),
  getStats: (id: string) => apiRequest<AgentStats>('GET', `/agents/${id}/stats`),
  create: (data: CreateAgentRequest) => apiRequest<Agent>('POST', '/agents', data),
  update: (id: string, data: UpdateAgentRequest) =>
    apiRequest<Agent>('PATCH', `/agents/${id}`, data),
  delete: (id: string) => apiRequest<void>('DELETE', `/agents/${id}`),
  toggle: (id: string) =>
    apiRequest<{ id: string; status: string }>('POST', `/agents/${id}/toggle`),
  resetKey: (id: string) => apiRequest<{ apiKey: string }>('POST', `/agents/${id}/reset-key`),
  findKeys: (id: string) =>
    apiRequest<
      { id: string; name: string; keyPrefix: string; createdAt: string; revokedAt: string | null }[]
    >('GET', `/agents/${id}/keys`),
  createKey: (id: string, data: { name: string }) =>
    apiRequest<{ id: string; name: string; apiKey: string }>('POST', `/agents/${id}/keys`, data),
  revokeKey: (id: string, keyId: string) =>
    apiRequest<void>('DELETE', `/agents/${id}/keys/${keyId}`),
};

// ──────────────────────────────────────────────
// Topic
// ──────────────────────────────────────────────
const topics = {
  list: (params?: ListQueryParams) =>
    apiRequest<PaginatedResponse<Topic>>('GET', '/topics', undefined, { params }),
  getById: (id: string) => apiRequest<TopicDetail>('GET', `/topics/${id}`),
  create: (data: CreateTopicRequest) => apiRequest<TopicDetail>('POST', '/topics', data),
  update: (id: string, data: UpdateTopicRequest) =>
    apiRequest<TopicDetail>('PATCH', `/topics/${id}`, data),
  delete: (id: string) => apiRequest<void>('DELETE', `/topics/${id}`),
  open: (id: string) => apiRequest<{ id: string; status: string }>('POST', `/topics/${id}/open`),
  close: (id: string) => apiRequest<{ id: string; status: string }>('POST', `/topics/${id}/close`),
  pause: (id: string) => apiRequest<{ id: string; status: string }>('POST', `/topics/${id}/pause`),
  resume: (id: string) =>
    apiRequest<{ id: string; status: string }>('POST', `/topics/${id}/resume`),
  archive: (id: string) =>
    apiRequest<{ id: string; status: string }>('POST', `/topics/${id}/archive`),
  join: (id: string) => apiRequest<unknown>('POST', `/topics/${id}/join`),
  leave: (id: string) => apiRequest<unknown>('POST', `/topics/${id}/leave`),
  removeParticipant: (id: string, participantId: string) =>
    apiRequest<unknown>('POST', `/topics/${id}/remove-participant`, {
      participantId,
    }),
  getMessages: (
    id: string,
    params?: {
      after?: string;
      before?: string;
      since?: string;
      /** 消息 ID，返回该消息本身及之后的消息（与 `after` 互斥） */
      start?: string;
      /** 消息 ID，返回该消息本身及之前的消息（与 `before` 互斥） */
      end?: string;
      limit?: number;
      senderId?: string;
    },
  ) =>
    apiRequest<{ messages: Message[]; nextCursor: string | null; hasMore: boolean }>(
      'GET',
      `/topics/${id}/messages`,
      undefined,
      { params },
    ),
  sendMessage: (id: string, data: SendMessageRequest) =>
    apiRequest<Message>('POST', `/topics/${id}/messages`, data),
  removeMessage: (topicId: string, messageId: string) =>
    apiRequest<void>('DELETE', `/topics/${topicId}/messages/${messageId}`),
  updateAgenda: (id: string, data: { agenda: AgendaItemInput[] }) =>
    apiRequest<Topic>('POST', `/topics/${id}/agenda`, data),
  getUnread: (id: string) => apiRequest<UnreadSummary>('GET', `/topics/${id}/messages/unread`),
  markAsRead: (id: string, messageId?: string) =>
    apiRequest<{ topicId: string; lastReadMessageId: string | null }>(
      'POST',
      `/topics/${id}/read`,
      messageId ? { messageId } : undefined,
    ),
  inviteAgent: (id: string, data: { agentId: string }) =>
    apiRequest<TopicDetail>('POST', `/topics/${id}/invite-agent`, data),
  uninviteAgent: (id: string, data: { agentId: string }) =>
    apiRequest<TopicDetail>('POST', `/topics/${id}/uninvite-agent`, data),
  inviteUser: (id: string, data: { userId: string }) =>
    apiRequest<unknown>('POST', `/topics/${id}/invite-user`, data),
  uninviteUser: (id: string, data: { userId: string }) =>
    apiRequest<unknown>('POST', `/topics/${id}/uninvite-user`, data),
};

/**
 * 圆桌 runner（web 侧投影，v1.49.0 座位管理 runner 状态块数据源）：
 * 后端 GET /roundtable/runners 的字段投影（不透 actorId，最小暴露面——
 * 见 backend roundtable.service.ts listRunners）；排序已由后端完成
 * （online 优先 + lastSeenAt 倒序），web 按序直接渲染
 */
export interface RoundtableRunnerItem {
  /** runner UUID */
  id: string;
  /** runner 展示名（hello 上报的 runner-name） */
  name: string;
  /** 在线状态：online / offline（协议值不翻译，UI 用状态点颜色区分） */
  status: string;
  /** runner 软件版本（排障用，可空） */
  version: string | null;
  /** 支持的厂商列表（如 ["kimi","codex","opencode","claude-code"]；建座 vendor 提示的数据源） */
  vendors: string[];
  /** 最近心跳/连接时间（ISO 8601，可空；web 渲染相对时间） */
  lastSeenAt: string | null;
}

/**
 * 建座位请求（POST /roundtable/seats，v1.49.0 web 建座 UI）：
 * 字段契约对齐 backend CreateSeatDto（格式校验在 DTO，存在性/权限在 Service）。
 * bindActorId：web（人类 JWT）创建时必须显式指定（DTO 缺省只兜 agent 创建者绑自己）。
 */
export interface CreateSeatRequest {
  /** 所属圆桌 topic id */
  topicId: string;
  /** 座位展示名（seatLabel 身份模型，@ 补全候选） */
  label: string;
  /** 厂商（kimi / codex / opencode / claude-code——协议值，SEAT_VENDORS） */
  vendor: string;
  /** 座位工作目录（runner 所在机器上的路径，agent 环境边界） */
  cwd: string;
  /** 权限模式：default / plan / auto / yolo（协议值不翻译） */
  permissionMode: string;
  /** 可选模型覆盖（ACP set_config_option） */
  model?: string;
  /** 绑定目标 agent actor id（runner 用该 agent 的 API Key 拨号时认领座位） */
  bindActorId?: string;
  /** 主脑座位标记 */
  coordinator?: boolean;
  /** 攒批窗口毫秒（0=直通；缺省后端兜底 30000，上限 300000） */
  batchWindowMs?: number;
}

// ──────────────────────────────────────────────
// Roundtable（圆桌座位，M1 控制面最小面）
// ──────────────────────────────────────────────
const roundtable = {
  /**
   * 列出圆桌 topic 的座位（需 topic 读权限；返回全量实体投影，
   * 前端只消费 id/label/status——active 座位 label 是 @ 补全候选源；
   * 已移除座位（status='removed'）由后端排除，不返回）
   */
  listSeats: (topicId: string) =>
    apiRequest<RoundtableSeatItem[]>('GET', '/roundtable/seats', undefined, {
      params: { topicId },
    }),

  /**
   * 创建圆桌座位（v1.49.0 web 建座 UI；需 topic 写权限——后端 Service 层
   * 存在性/权限判定，403/404 透传）。成功后调用方需 invalidate seats 查询。
   */
  createSeat: (data: CreateSeatRequest) =>
    apiRequest<RoundtableSeatItem>('POST', '/roundtable/seats', data),

  /**
   * runner 列表（v1.49.0 座位管理 runner 状态块；任意认证 actor 可读，
   * 字段投影不透 actorId；后端已排序 online 优先 + lastSeenAt 倒序）。
   */
  listRunners: () => apiRequest<RoundtableRunnerItem[]>('GET', '/roundtable/runners'),

  /**
   * 移除圆桌座位（M3 阶段 3，仅人类 topic 管理员/平台管理员；后端软删 +
   * seat.revoke 下行 + topic 公告）。成功后调用方需 invalidate seats 查询。
   */
  deleteSeat: (seatId: string) =>
    apiRequest<RoundtableSeatItem>('DELETE', `/roundtable/seats/${seatId}`),

  /**
   * 取消座位当前发言（M4b-1，仅治理身份 creator/admin/ownerProxy；busy 门控）：
   * 后端立即返回 accepted（优雅取消结果异步，web 经 presence 轮询观察相位变化）；
   * 空闲/离线座位 409 RESOURCE_CONFLICT（busy gate，防误杀健康会话）；
   * 非治理身份 403；座位/topic 不存在 404。
   */
  cancelSeat: (seatId: string) =>
    apiRequest<{ accepted: true; seatId: string }>('POST', `/roundtable/seats/${seatId}/cancel`),

  /**
   * 审批请求列表（M3 阶段 2 web 裁决 UI 数据源；topic 参与者可见，
   * 按创建时间倒序分页）。status 过滤 pending/approved/rejected/orphaned，
   * 缺省 = 全部。
   */
  listPermissionRequests: (
    topicId: string,
    params?: {
      status?: 'pending' | 'approved' | 'rejected' | 'orphaned';
      page?: number;
      pageSize?: number;
    },
  ) =>
    apiRequest<PaginatedResponse<RoundtablePermissionRequestItem>>(
      'GET',
      '/roundtable/permission-requests',
      undefined,
      { params: { topicId, ...params } },
    ),

  /**
   * 当前用户（active 参与者口径）可见的 pending 审批总数——全局待办角标
   * 数据源。响应为 `{ count }` 包装（非裸 number，见 controller）。
   */
  pendingPermissionRequestCount: () =>
    apiRequest<{ count: number }>('GET', '/roundtable/permission-requests/pending-count'),

  /**
   * 裁决审批请求（仅人类 JWT + topic 参与者；agent 403）。optionId 必须 ∈
   * 该请求 options 的 optionId/id。非 pending 409；非法 optionId 422。
   * 成功后后端下行 seat.permission_verdict + 落 topic 系统公告。
   */
  verdictPermissionRequest: (id: string, optionId: string) =>
    apiRequest<RoundtablePermissionRequestItem>(
      'POST',
      `/roundtable/permission-requests/${id}/verdict`,
      { optionId },
    ),
};

// ──────────────────────────────────────────────
// Board
// ──────────────────────────────────────────────
const boards = {
  list: (params?: ListQueryParams) =>
    apiRequest<PaginatedResponse<Board>>('GET', '/boards', undefined, { params }),
  getById: (id: string) => apiRequest<BoardDetail>('GET', `/boards/${id}`),
  create: (data: CreateBoardRequest) => apiRequest<BoardDetail>('POST', '/boards', data),
  update: (id: string, data: UpdateBoardRequest) =>
    apiRequest<BoardDetail>('PATCH', `/boards/${id}`, data),
  delete: (id: string) => apiRequest<void>('DELETE', `/boards/${id}`),
  inviteAgent: (id: string, data: { agentId: string }) =>
    apiRequest<BoardDetail>('POST', `/boards/${id}/invite-agent`, data),
  uninviteAgent: (id: string, data: { agentId: string }) =>
    apiRequest<BoardDetail>('POST', `/boards/${id}/uninvite-agent`, data),
  addEditor: (id: string, data: { agentId: string }) =>
    apiRequest<BoardDetail>('POST', `/boards/${id}/add-editor`, data),
  removeEditor: (id: string, data: { agentId: string }) =>
    apiRequest<BoardDetail>('POST', `/boards/${id}/remove-editor`, data),
  createList: (id: string, data: { name: string; mappedStatus?: string }) =>
    apiRequest<BoardList>('POST', `/boards/${id}/lists`, data),
  reorderLists: (id: string, data: { lists: { id: string; position: number }[] }) =>
    apiRequest<BoardDetail>('POST', `/boards/${id}/lists/reorder`, data),
  updateList: (
    id: string,
    data: { name?: string; position?: number; mappedStatus?: string | null },
  ) => apiRequest<BoardList>('PATCH', `/boards/lists/${id}`, data),
  deleteList: (id: string, moveTasksTo?: string) =>
    apiRequest<void>('DELETE', `/boards/lists/${id}`, moveTasksTo ? { moveTasksTo } : undefined),
  reorderTasks: (id: string, data: { tasks: { id: string; position: number }[] }) =>
    apiRequest<TaskSummary[]>('POST', `/boards/lists/${id}/reorder`, data),

  /** 获取看板下的所有列元数据（不含 tasks） */
  getLists: (id: string) => apiRequest<BoardListSummary[]>('GET', `/boards/${id}/lists`),

  /** 获取指定列下的任务列表（默认只返回 backlog 和 in_progress；传 status=all 返回全部） */
  getListTasks: (
    id: string,
    listId: string,
    params?: {
      status?: string | string[] | 'all';
      page?: number;
      pageSize?: number;
    },
  ) =>
    apiRequest<PaginatedResponse<TaskSummary>>(
      'GET',
      `/boards/${id}/lists/${listId}/tasks`,
      undefined,
      { params },
    ),
};

// ──────────────────────────────────────────────
// Task
// ──────────────────────────────────────────────
const tasks = {
  list: (params?: ListQueryParams) =>
    apiRequest<PaginatedResponse<TaskSummary>>('GET', '/tasks', undefined, { params }),
  getById: (id: string) => apiRequest<TaskDetail>('GET', `/tasks/${id}`),
  create: (data: CreateTaskRequest) => apiRequest<TaskDetail>('POST', '/tasks', data),
  update: (id: string, data: UpdateTaskRequest) =>
    apiRequest<TaskDetail>('PATCH', `/tasks/${id}`, data),
  delete: (id: string) => apiRequest<void>('DELETE', `/tasks/${id}`),
  move: (id: string, data: MoveTaskRequest) =>
    apiRequest<TaskDetail>('POST', `/tasks/${id}/move`, data),
  assign: (id: string, data: AssignTaskRequest) =>
    apiRequest<TaskDetail>('POST', `/tasks/${id}/assign`, data),
  getComments: (id: string) =>
    apiRequest<
      {
        id: string;
        authorId: string;
        authorName: string;
        authorType: 'human' | 'agent' | 'system';
        content: string;
        createdAt: string;
      }[]
    >('GET', `/tasks/${id}/comments`),
  addComment: (id: string, data: { content: string }) =>
    apiRequest<void>('POST', `/tasks/${id}/comments`, data),
  getActivities: (id: string) =>
    apiRequest<
      {
        id: string;
        action: string;
        actorId: string;
        actorName: string;
        details?: Record<string, unknown>;
        createdAt: string;
      }[]
    >('GET', `/tasks/${id}/activities`),
  getDependencies: (id: string) =>
    apiRequest<TaskDependencyItem[]>('GET', `/tasks/${id}/dependencies`),
  getDependents: (id: string) => apiRequest<TaskDependencyItem[]>('GET', `/tasks/${id}/dependents`),
  addDependency: (id: string, data: { dependsOnTaskId: string; type?: string }) =>
    apiRequest<TaskDependencyItem>('POST', `/tasks/${id}/dependencies`, data),
  removeDependency: (id: string, depId: string) =>
    apiRequest<void>('DELETE', `/tasks/${id}/dependencies/${depId}`),
  getBlockers: (id: string) => apiRequest<TaskDependencyItem[]>('GET', `/tasks/${id}/blockers`),
  getBatchBlockers: (ids: string[]) =>
    apiRequest<Record<string, boolean>>('GET', '/tasks/blockers/batch', undefined, {
      params: { ids: ids.join(',') },
    }),
  getMilestones: (params?: { boardId?: string; page?: number; pageSize?: number }) =>
    apiRequest<PaginatedResponse<Milestone>>('GET', '/tasks/milestones', undefined, { params }),
  getMilestone: (id: string) => apiRequest<Milestone>('GET', `/tasks/milestones/${id}`),
  createMilestone: (data: {
    name: string;
    boardId: string;
    description?: string;
    status?: string;
    startDate?: string;
    targetDate?: string;
  }) => apiRequest<Milestone>('POST', '/tasks/milestones', data),
  updateMilestone: (
    id: string,
    data: Partial<{
      name: string;
      description?: string;
      boardId?: string;
      status?: string;
      startDate?: string;
      targetDate?: string;
    }>,
  ) => apiRequest<Milestone>('PATCH', `/tasks/milestones/${id}`, data),
  deleteMilestone: (id: string) => apiRequest<void>('DELETE', `/tasks/milestones/${id}`),

  /** 任务关联文档（N:M）：添加链接，幂等 */
  addDocLink: (id: string, docId: string) =>
    apiRequest<TaskDocLinkItem>('POST', `/tasks/${id}/doc-links`, { docId }),
  /** 任务关联文档（N:M）：移除链接 */
  removeDocLink: (id: string, docId: string) =>
    apiRequest<boolean>('DELETE', `/tasks/${id}/doc-links/${docId}`),
};

// ──────────────────────────────────────────────
// Docs（DocSpace 文档知识库）
// ──────────────────────────────────────────────
const docs = {
  // ── 空间 ──
  listSpaces: (params?: { page?: number; pageSize?: number; boardId?: string; topicId?: string }) =>
    apiRequest<PaginatedResponse<DocSpaceSummary>>('GET', '/doc-spaces', undefined, { params }),
  getSpace: (id: string) => apiRequest<DocSpaceDetail>('GET', `/doc-spaces/${id}`),
  createSpace: (data: CreateDocSpaceInput) =>
    apiRequest<DocSpaceDetail>('POST', '/doc-spaces', data),
  updateSpace: (id: string, data: UpdateDocSpaceInput) =>
    apiRequest<DocSpaceDetail>('PATCH', `/doc-spaces/${id}`, data),
  deleteSpace: (id: string) => apiRequest<void>('DELETE', `/doc-spaces/${id}`),

  // ── 成员（creator-only 端点语义对齐 board v1.23） ──
  inviteAgent: (id: string, agentId: string) =>
    apiRequest<DocSpaceDetail>('POST', `/doc-spaces/${id}/invite-agent`, { agentId }),
  uninviteAgent: (id: string, agentId: string) =>
    apiRequest<DocSpaceDetail>('POST', `/doc-spaces/${id}/uninvite-agent`, { agentId }),
  addEditor: (id: string, agentId: string) =>
    apiRequest<DocSpaceDetail>('POST', `/doc-spaces/${id}/add-editor`, { agentId }),
  removeEditor: (id: string, agentId: string) =>
    apiRequest<DocSpaceDetail>('POST', `/doc-spaces/${id}/remove-editor`, { agentId }),
  // v1.45 DOCSPACE-PERM：creator 转让（creator-only；返回 enrich 后的 DocSpaceDetail）
  transferCreator: (id: string, newCreatorId: string) =>
    apiRequest<DocSpaceDetail>('POST', `/doc-spaces/${id}/transfer-creator`, { newCreatorId }),

  // ── 分类 ──
  createCategory: (spaceId: string, data: CreateDocCategoryInput) =>
    apiRequest<DocCategoryDto>('POST', `/doc-spaces/${spaceId}/categories`, data),
  updateCategory: (categoryId: string, data: UpdateDocCategoryInput) =>
    apiRequest<DocCategoryDto>('PATCH', `/doc-categories/${categoryId}`, data),
  deleteCategory: (categoryId: string) =>
    apiRequest<void>('DELETE', `/doc-categories/${categoryId}`),

  // ── 概览 / 文档读写 / 检索 ──
  getOverview: (spaceId: string) =>
    apiRequest<DocSpaceOverview>('GET', `/doc-spaces/${spaceId}/overview`),
  listDocs: (
    spaceId: string,
    params?: {
      category?: string;
      tag?: string;
      type?: string;
      q?: string;
      path?: string;
      page?: number;
      pageSize?: number;
    },
  ) =>
    apiRequest<PaginatedResponse<DocSummary>>('GET', `/doc-spaces/${spaceId}/docs`, undefined, {
      params,
    }),
  search: (
    spaceId: string,
    params: { q: string; type?: string; tag?: string; category?: string; limit?: number },
  ) => apiRequest<DocSearchHit[]>('GET', `/doc-spaces/${spaceId}/search`, undefined, { params }),

  // ── 单文档 ──
  getDoc: (docId: string) => apiRequest<DocDetail>('GET', `/docs/${docId}`),
  /** Web 全文通道：拼接全文一次返回，仅供 web 渲染（Agent 走 section 精读）。
   *  full=true 返回含首标题行的完整原文（编辑器回写专用，防丢标题行） */
  getDocContent: (docId: string, full?: boolean) =>
    apiRequest<DocFullContent>('GET', `/docs/${docId}/content${full ? '?full=true' : ''}`),
  getSection: (docId: string, position: number) =>
    apiRequest<DocSectionContent>('GET', `/docs/${docId}/sections/${position}`),
  upsertDoc: (spaceId: string, data: UpsertDocInput) =>
    apiRequest<UpsertDocResult>('PUT', `/doc-spaces/${spaceId}/docs`, data),
  deleteDoc: (docId: string) => apiRequest<void>('DELETE', `/docs/${docId}`),

  // ── 批量上传 ──
  batchUpsertDocs: (
    spaceId: string,
    docs: {
      path: string;
      content: string;
      title?: string;
      summary?: string;
      docType?: string;
      category?: string;
      tags?: string[];
    }[],
  ) =>
    apiRequest<{
      results: {
        path: string;
        status: 'created' | 'updated' | 'unchanged' | 'failed';
        id?: string;
        error?: { message: string; code?: number };
      }[];
      summary: {
        total: number;
        created: number;
        updated: number;
        unchanged: number;
        failed: number;
      };
    }>('PUT', `/doc-spaces/${spaceId}/docs/batch`, { docs }),
};

// ──────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────
const dashboard = {
  getStats: () => apiRequest<DashboardStats>('GET', '/dashboard/stats'),
  getAgentActivity: () => apiRequest<AgentActivity[]>('GET', '/dashboard/agent-activity'),
  getLeaderboard: () => apiRequest<AgentLeaderboardItem[]>('GET', '/dashboard/leaderboard'),
  getRecentTopics: () => apiRequest<Topic[]>('GET', '/dashboard/recent-topics'),
};

// ──────────────────────────────────────────────
// Avatar（SVG 自绘头像通道，人类 JWT / Agent API Key 共用）
// ──────────────────────────────────────────────
const avatars = {
  /**
   * 上传当前 Actor 的 SVG 自绘头像。
   * 后端 sanitize（拒绝式，上限 32KB）通过后把 avatarUrl 联动置为
   * /api/v1/avatars/:actorId.svg 短链并返回；400 时 message 带具体拒绝原因。
   */
  uploadSvg: (svg: string) => apiRequest<{ avatarUrl: string }>('PUT', '/avatars/me/svg', { svg }),
};

// ──────────────────────────────────────────────
// Search
// ──────────────────────────────────────────────
const search = {
  query: (params: SearchQuery) => apiRequest<SearchResult>('GET', '/search', undefined, { params }),
};

// ──────────────────────────────────────────────
// Events（统一事件层轮询通道，web 实时刷新兜底）
// ──────────────────────────────────────────────
const events = {
  /**
   * 轮询事件流（GET /events/poll）。
   * cursor 语义（后端契约）：只返回 cursor 之后的事件；'now' = 从当前时刻开始
   * （跳过全部历史）。服务端按当前 actor 可访问资源过滤，返回 events + nextCursor，
   * 下一轮把 nextCursor 原样透传。
   */
  poll: (cursor: string, limit = 100) =>
    apiRequest<{ events: EventItem[]; nextCursor: string }>('GET', '/events/poll', undefined, {
      params: { cursor, limit },
    }),
};

// ──────────────────────────────────────────────
// Webhook
// ──────────────────────────────────────────────
const webhooks = {
  test: (data: { url: string; payload: unknown }) =>
    apiRequest<{ success: boolean; message: string }>('POST', '/webhooks/test', data),
};

// ──────────────────────────────────────────────
// Monitoring
// ──────────────────────────────────────────────
const monitoring = {
  getApiLogs: (params?: { page?: number; pageSize?: number }) =>
    apiRequest<PaginatedResponse<AuditLog>>('GET', '/system/api-logs', undefined, { params }),
  exportApiLogs: () =>
    apiRequest<{ data: AuditLog[]; count: number; exportedAt: string }>(
      'GET',
      '/system/api-logs/export',
    ),
  /**
   * 存活探针（含平台版本 version + git commit，供 sidebar 版本角标）。
   * 注意：/health 是 @SkipTransform 裸响应（无 {data} 包装），
   * 不能走 apiRequest 解包，直接取响应体。
   */
  getHealth: () => publicAxiosInstance.get<HealthStatus>('/health').then((r) => r.data),
};

// ──────────────────────────────────────────────
// Skills（公开访问，无需认证）
// ──────────────────────────────────────────────

/** 获取 Skill 详情（JSON 格式） */
function getSkill(name: string): Promise<SkillDetail>;
/** 获取 Skill 原始 Markdown 内容 */
function getSkill(name: string, format: 'raw'): Promise<string>;
function getSkill(name: string, format?: 'raw'): Promise<SkillDetail | string> {
  if (format === 'raw') {
    // raw 格式直接返回 text/markdown，不走统一响应包装
    return publicAxiosInstance
      .get<string>(`/skills/${name}`, { params: { format: 'raw' }, responseType: 'text' })
      .then((res) => res.data);
  }
  return publicApiRequest<SkillDetail>('GET', `/skills/${name}`);
}

/** 获取子 Skill 详情（JSON 格式） */
function getSubSkill(name: string, subpath: string): Promise<SkillDetail>;
/** 获取子 Skill 原始 Markdown 内容（含 frontmatter） */
function getSubSkill(name: string, subpath: string, format: 'raw'): Promise<string>;
function getSubSkill(name: string, subpath: string, format?: 'raw'): Promise<SkillDetail | string> {
  if (format === 'raw') {
    // raw 格式直接返回 text/markdown，不走统一响应包装
    return publicAxiosInstance
      .get<string>(`/skills/${name}/${subpath}`, {
        params: { format: 'raw' },
        responseType: 'text',
      })
      .then((res) => res.data);
  }
  return publicApiRequest<SkillDetail>('GET', `/skills/${name}/${subpath}`);
}

const skills = {
  /** 获取公开 Skill 列表 */
  list: () => publicApiRequest<SkillListItem[]>('GET', '/skills'),

  /** 获取 Skill 详情（支持 JSON / raw Markdown） */
  get: getSkill,

  /** 获取子 Skill 列表（如 topics、taskboard、docs） */
  getSubs: (name: string) => publicApiRequest<SkillListItem[]>('GET', `/skills/${name}/subs`),

  /** 获取子 Skill（支持 JSON / raw Markdown） */
  getSub: getSubSkill,
};

// ═══════════════════════════════════════════════
// Unified API aggregate object
// ═══════════════════════════════════════════════
export const Api = {
  auth,
  users,
  agents,
  topics,
  roundtable,
  boards,
  tasks,
  docs,
  dashboard,
  avatars,
  search,
  events,
  webhooks,
  monitoring,
  skills,
};

export default Api;
