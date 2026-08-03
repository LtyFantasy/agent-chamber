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

const skills = {
  /** 获取公开 Skill 列表 */
  list: () => publicApiRequest<SkillListItem[]>('GET', '/skills'),

  /** 获取 Skill 详情（支持 JSON / raw Markdown） */
  get: getSkill,

  /** 获取子 Skill（如 taskboard、topics） */
  getSub: (name: string, subpath: string) =>
    publicApiRequest<SkillDetail>('GET', `/skills/${name}/${subpath}`),
};

// ═══════════════════════════════════════════════
// Unified API aggregate object
// ═══════════════════════════════════════════════
export const Api = {
  auth,
  users,
  agents,
  topics,
  boards,
  tasks,
  docs,
  dashboard,
  avatars,
  search,
  webhooks,
  monitoring,
  skills,
};

export default Api;
