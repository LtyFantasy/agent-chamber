import { Priority, TaskStatus, TaskDependencyType, MilestoneStatus } from '../enums';

/**
 * 创建任务请求输入
 */
export interface CreateTaskInput {
  /** 所属看板 ID */
  boardId?: string;
  /** 所属列 ID */
  listId: string;
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
 */
export interface CreateMilestoneInput {
  /** 里程碑名称 */
  name: string;
  /** 里程碑描述 */
  description?: string;
  /** 关联看板 ID（必填，禁止孤立里程碑） */
  boardId: string;
  /** 状态 */
  status?: MilestoneStatus;
  /** 开始日期（ISO 8601） */
  startDate?: string;
  /** 目标日期（ISO 8601） */
  targetDate?: string;
}

/**
 * 更新里程碑请求输入
 */
export type UpdateMilestoneInput = Partial<CreateMilestoneInput>;

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
