import { MilestoneStatus } from '../enums';
import type { TaskDocLinkItem } from './docspace-response.dto';

/**
 * 任务摘要
 */
export interface TaskSummary {
  /** 任务 ID */
  id: string;
  /** 任务标题 */
  title: string;
  /** 任务状态 */
  status: string;
  /** 优先级 */
  priority: string;
  /** 分配对象 ID */
  assigneeId?: string | null;
  /** 分配对象类型 */
  assigneeType?: string | null;
  /** 分配对象名称 */
  assigneeName?: string | null;
  /** 排序位置 */
  position?: number;
  /** 截止日期 */
  dueDate?: string | Date | null;
  /** 标签列表（数据库存储为 TEXT[]） */
  labels?: string[] | null;
  /** 里程碑 ID */
  milestoneId?: string | null;
  /** 所属看板 ID（由 list.boardId 推断，非数据库直接字段） */
  boardId?: string | null;
  /** 关联话题 ID */
  topicId?: string | null;
  /** 是否有阻塞项 */
  hasBlockers?: boolean;
  /** 评论数量 */
  commentCount?: number;
  /** 活动数量 */
  activityCount?: number;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 任务依赖项
 * findOne 响应中 dependsOnTask / task 仅包含 {id, title, status} 摘要（非完整 Task 实体）。
 */
export interface TaskDependencyItem {
  /** 依赖 ID */
  id: string;
  /** 任务 ID */
  taskId: string;
  /** 被依赖的任务 ID */
  dependsOnTaskId: string;
  /** 依赖类型 */
  type: 'blocks' | 'relates_to' | 'duplicates';
  /** 创建时间 */
  createdAt: string | Date;
  /** 被依赖的任务 */
  dependsOnTask?: TaskSummary;
  /** 当前任务 */
  task?: TaskSummary;
}

/**
 * 任务详情（聚合视图）
 * 包含 Task + dependencies + blockers。评论/活动按需通过 GET /tasks/:id/comments、/activities 独立获取。
 */
export interface TaskDetail extends TaskSummary {
  /** 所属看板 ID（由 listId 推断，非数据库直接字段） */
  boardId?: string;
  /** 所属列 ID */
  listId: string;
  /** 关联话题 ID */
  topicId?: string | null;
  /** 创建者 ID */
  createdBy?: string;
  /** 检查清单 */
  checklist?: ChecklistItem[];
  /** 附件列表 */
  attachments?: Attachment[];
  /** 依赖列表 */
  dependencies?: TaskDependencyItem[];
  /** 被依赖列表 */
  dependents?: TaskDependencyItem[];
  /** 阻塞项列表 */
  blockers?: TaskDependencyItem[];
  /** 里程碑 */
  milestone?: Milestone;
  /** 关联文档列表（join 时过滤已删除文档和空间） */
  docs?: TaskDocLinkItem[];
  /** 任务描述（详情视图显式保留） */
  description: string | null;
}

/**
 * 标签
 */
export interface Label {
  /** 标签 ID */
  id: string;
  /** 标签名称 */
  name: string;
  /** 标签颜色 */
  color: string;
}

/**
 * 检查清单项
 */
export interface ChecklistItem {
  /** 项 ID */
  id: string;
  /** 文本内容 */
  text: string;
  /** 是否已完成 */
  checked: boolean;
  /** 排序顺序 */
  order: number;
}

/**
 * 附件
 */
export interface Attachment {
  /** 附件名称 */
  name: string;
  /** 附件 URL */
  url: string;
  /** 文件大小 */
  size: number;
  /** MIME 类型 */
  mimeType: string;
}

/**
 * 评论
 */
export interface Comment {
  /** 评论 ID */
  id: string;
  /** 作者 ID */
  authorId: string;
  /** 作者名称 */
  authorName: string;
  /** 作者类型 */
  authorType: 'human' | 'agent' | 'system';
  /** 评论内容 */
  content: string;
  /** 创建时间 */
  createdAt: string | Date;
}

/**
 * 活动记录
 */
export interface Activity {
  /** 记录 ID */
  id: string;
  /** 动作类型 */
  action: string;
  /** 执行者 ID */
  actorId: string;
  /** 执行者名称 */
  actorName: string;
  /** 详情 */
  details?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: string | Date;
}

/**
 * 里程碑（v1.42 起可承载 Release 信息）
 * 列表投影（findAll）：body → bodySnippet(300 字符)，不返回 deployMeta；
 * 详情（findOne / deployed 端点响应）：body 与 deployMeta 全量返回。
 */
export interface Milestone {
  /** 里程碑 ID */
  id: string;
  /** 里程碑名称 */
  name: string;
  /** 里程碑描述 */
  description?: string | null;
  /** 关联看板 ID */
  boardId?: string | null;
  /** 里程碑状态 */
  status: MilestoneStatus;
  /** 开始日期 */
  startDate?: string | Date | null;
  /** 目标日期 */
  targetDate?: string | Date | null;
  /** 创建者 Actor ID（human/agent 通用；历史数据为 null） */
  creatorId?: string | null;
  /** Release 版本号（null = 普通里程碑） */
  version?: string | null;
  /** Release 变更说明全量（仅详情返回） */
  body?: string | null;
  /** Release 变更说明摘要（仅列表投影：body 前 300 字符） */
  bodySnippet?: string | null;
  /** 部署元数据（anchors/backup/migrations，仅详情返回；写入只经 deployed 端点合并） */
  deployMeta?: Record<string, unknown> | null;
  /** 最近一次部署时间（deployed 端点写入） */
  deployedAt?: string | Date | null;
  /** 验收时间（PATCH status=verified 时写入） */
  verifiedAt?: string | Date | null;
  /** 统计信息 */
  stats?: {
    total: number;
    done: number;
    inProgress: number;
    open: number;
  };
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 任务及其依赖关系（Service 层 plain object）
 * 由 toPlain() 从 TypeORM Task 实体展开得到
 */
export interface TaskWithDependencies extends TaskSummary {
  /** 所属看板 ID */
  boardId?: string;
  /** 所属列 ID */
  listId?: string;
  /** 关联话题 ID */
  topicId?: string | null;
  /** 创建者 ID */
  createdBy?: string;
  /** 依赖列表 */
  dependencies?: TaskDependencyItem[];
  /** 被依赖列表 */
  dependents?: TaskDependencyItem[];
  /** 阻塞项列表 */
  blockers?: TaskDependencyItem[];
}
