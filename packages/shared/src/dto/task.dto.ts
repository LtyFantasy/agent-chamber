import { Priority, TaskStatus, TaskDependencyType, MilestoneStatus } from '../enums';

/**
 * 创建任务请求输入
 */
export interface CreateTaskInput {
  /** 所属看板 ID（使用 statusName 解析列时必填） */
  boardId?: string;
  /**
   * 所属列 ID。与 statusName 二选一：两者都提供时 listId 优先、statusName 忽略；
   * 两者都缺省时创建请求被 400 拒绝。
   */
  listId?: string;
  /**
   * 目标列名（三层匹配，与 MCP create_task 的 resolveList 契约对齐）：
   * ① mappedStatus 大小写不敏感精确 → ② 列名 ci 精确 → ③ 列名 ci 子串。
   * 0 命中或 >1 命中返回 400 并附可选项/候选，绝不静默挑选；仅当 listId 缺失时生效。
   */
  statusName?: string;
  /** 任务标题 */
  title: string;
  /** 任务描述 */
  description?: string;
  /** 优先级 */
  priority?: Priority;
  /** 任务状态 */
  status?: TaskStatus;
  /** 单个分配对象 ID，传 null/undefined 表示取消分配 */
  assigneeId?: string | null;
  /** 截止日期 */
  dueDate?: string;
  /** 标签列表 */
  labels?: string[];
  /** 里程碑 ID */
  milestoneId?: string;
  /** 自定义字段 */
  customFields?: Record<string, unknown>;
  /** 幂等键（可选，1~64 字符）。同一 actor 重复提交相同 clientRequestId 时返回首个已创建实体 + idempotentReplay 标记 */
  clientRequestId?: string;
}

/**
 * 更新任务请求输入
 */
export interface UpdateTaskInput {
  /** 任务标题 */
  title?: string;
  /** 任务描述 */
  description?: string;
  /** 优先级 */
  priority?: Priority;
  /** 任务状态 */
  status?: TaskStatus;
  /** 单个分配对象 ID，传 null/undefined 表示取消分配 */
  assigneeId?: string | null;
  /** 截止日期 */
  dueDate?: string;
  /** 标签列表 */
  labels?: string[];
  /** 所属列 ID */
  listId?: string;
  /** 里程碑 ID */
  milestoneId?: string;
  /** 自定义字段 */
  customFields?: Record<string, unknown>;
}

/**
 * 任务结果汇报请求输入（POST /tasks/:id/report）
 *
 * 三步编排：发评论（comment/commitSha 任一提供）→ 改状态 → 逐 doc 关联文档。
 * clientRequestId 幂等键：同 actor 同 key 重试返回首次快照 + idempotentReplay 标记；
 * 同 key 不同 payload → 409 IDEMPOTENCY_KEY_CONFLICT。
 */
export interface ReportTaskResultInput {
  /** 目标状态（必填） */
  status: TaskStatus;
  /** 汇报正文（可选；与 commitSha 任一提供即发评论） */
  comment?: string;
  /** 关联 commit SHA（可选；追加为 "Commit: <sha>"） */
  commitSha?: string;
  /** 关联文档 ID 列表（可选；单条失败内嵌 docLinks.failed 不拖垮主体） */
  docIds?: string[];
  /** 幂等键（可选，1~64 字符） */
  clientRequestId?: string;
}

/**
 * 任务描述局部 patch 请求输入（PATCH /tasks/:id/description）
 *
 * match 模式精确串替换（契约对齐 DocSpace patchByMatch）：
 * - oldString 必须恰好命中 1 处：0 命中 → 404 DOC_NOT_FOUND、>1 命中 →
 *   409 RESOURCE_CONFLICT + data.matchCount（绝不静默挑选）；
 * - newString 可为空串 = 删除该片段；$ 模式按字面量处理（函数式 replacer）；
 * - expectedDescriptionHash 可选乐观锁前提 = sha256(description ?? '')，
 *   从任务详情响应 descriptionHash 捕获；不符 → 409 DOC_CONTENT_CONFLICT
 *   + data.currentDescriptionHash 提示重读；
 * - clientRequestId 幂等键：同 actor 同 key 重试返回首次快照 + idempotentReplay。
 */
export interface PatchTaskDescriptionInput {
  /** 待替换的精确子串（必填非空） */
  oldString: string;
  /** 替换内容（必填；空串 = 删除该片段） */
  newString: string;
  /** 乐观锁前提（可选）：任务详情响应的 descriptionHash */
  expectedDescriptionHash?: string;
  /** 幂等键（可选，1~64 字符） */
  clientRequestId?: string;
}

/**
 * 移动任务请求输入
 */
export interface MoveTaskInput {
  /** 目标列 ID */
  listId: string;
  /** 排序位置（数值） */
  order?: number;
  /** 排序位置（别名） */
  position?: number;
}

/**
 * 分配任务请求输入
 */
export interface AssignTaskInput {
  /** 分配对象 ID，传空/null/undefined 表示取消分配 */
  assigneeId?: string | null;
  /** 是否追加分配（false=覆盖） */
  append?: boolean;
}

/**
 * 添加任务评论请求输入
 */
export interface AddCommentInput {
  /** 评论内容 */
  content: string;
}

/**
 * 添加任务依赖请求输入
 */
export interface AddTaskDependencyInput {
  /** 依赖的任务 ID */
  dependsOnTaskId: string;
  /** 依赖类型 */
  type?: TaskDependencyType;
}

/**
 * 批量创建任务请求输入
 */
export interface BatchCreateTasksInput {
  /** 任务列表（1-50个） */
  tasks: CreateTaskInput[];
}

/**
 * 创建里程碑请求输入
 * - version 非空 = Release 里程碑：status 缺省 dev，显式仅可 dev/ready
 * - version 为空 = 普通里程碑：status 任意普通态，行为零变更
 */
export interface CreateMilestoneInput {
  /** 里程碑名称 */
  name: string;
  /** 里程碑描述 */
  description?: string;
  /** 关联看板 ID（必填，禁止孤立里程碑） */
  boardId: string;
  /** 状态（version 非空时缺省 dev；显式仅可 dev/ready，其余 400） */
  status?: MilestoneStatus;
  /** 开始日期（ISO 8601） */
  startDate?: string;
  /** 目标日期（ISO 8601） */
  targetDate?: string;
  /**
   * Release 版本号（形如 v1.42.0 / 1.42.0 / 1.42.0-rc.1）。
   * 同 board 内唯一（部分唯一索引，version IS NOT NULL）；唯一性冲突返回 409。
   */
  version?: string;
  /** Release 变更说明/发布说明（Markdown；详情接口全量返回，列表接口投影为 bodySnippet） */
  body?: string;
}

/**
 * 更新里程碑请求输入
 */
export type UpdateMilestoneInput = Partial<CreateMilestoneInput>;

/**
 * 部署里程碑请求输入（POST /tasks/milestones/:id/deployed）
 * 全可选——热修重部署幂等：只覆盖 payload 中显式提供的字段，deployMeta 合并写入。
 * deployMeta/deployedAt/verifiedAt 本身不可经本类型写入（whitelist 拦截，部署事实只能由端点产生）。
 */
export interface MarkMilestoneDeployedInput {
  /** 部署锚点（如 health ok / web ok / migration 防呆结果），对象透传 */
  anchors?: Record<string, unknown>;
  /** 部署前备份文件名 */
  backup?: string;
  /** 本次执行的 migration 名称清单 */
  migrations?: string[];
  /** 部署时间（ISO 8601），缺省 = 服务器当前时间 */
  deployedAt?: string;
}

/**
 * 任务列表查询输入
 */
export interface QueryTaskInput {
  /** 看板 ID */
  boardId?: string;
  /** 列 ID */
  listId?: string;
  /** 话题 ID */
  topicId?: string;
  /** 里程碑 ID */
  milestoneId?: string;
  /** 任务状态（支持单个值、数组或 all） */
  status?: TaskStatus | TaskStatus[] | 'all';
  /** 分配对象 ID */
  assigneeId?: string;
  /** 标签列表 */
  labels?: string[];
  /** 全文搜索关键词 */
  q?: string;
  /** 页码 */
  page?: number;
  /** 每页数量 */
  pageSize?: number;
  /** 兼容参数：limit */
  limit?: number;
  /** 仅返回无阻塞的任务 */
  unblocked?: boolean;
}

/**
 * 里程碑列表查询输入
 */
export interface QueryMilestoneInput {
  /** 看板 ID */
  boardId?: string;
  /** 页码 */
  page?: number;
  /** 每页数量 */
  pageSize?: number;
}
