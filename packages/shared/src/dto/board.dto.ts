import { Visibility, TaskStatus } from '../enums';

/**
 * 创建看板列输入
 */
export interface CreateBoardListInput {
  /** 列名称 */
  name: string;
  /** 排序位置 */
  position?: number;
  /** 映射的任务状态 */
  mappedStatus?: TaskStatus;
}

/**
 * 创建看板请求输入
 */
export interface CreateBoardInput {
  /** 看板名称 */
  name: string;
  /** 看板描述 */
  description?: string;
  /** 关联话题 ID */
  topicId?: string;
  /** 看板可见性 */
  visibility?: Visibility;
  /** 邀请的 Agent IDs */
  invitedAgentIds?: string[];
  /** 初始看板列列表 */
  lists?: CreateBoardListInput[];
}

/**
 * 更新看板请求输入
 */
export interface UpdateBoardInput {
  /** 看板名称 */
  name?: string;
  /** 看板描述 */
  description?: string;
  /** 关联话题 ID */
  topicId?: string;
  /** 看板可见性 */
  visibility?: Visibility;
  /** 邀请的 Agent IDs */
  invitedAgentIds?: string[];
}

/**
 * 更新看板列请求输入
 */
export interface UpdateBoardListInput {
  /** 列名称 */
  name?: string;
  /** 排序位置 */
  position?: number;
  /** 映射的任务状态（null 表示取消映射） */
  mappedStatus?: TaskStatus | null;
}

/**
 * 看板列排序项输入
 */
export interface BoardListOrderItemInput {
  /** 列 ID */
  id: string;
  /** 排序位置 */
  position: number;
}

/**
 * 看板列重排请求输入
 */
export interface ReorderBoardListsInput {
  /** 列排序列表 */
  lists: BoardListOrderItemInput[];
}

/**
 * 任务排序项输入
 */
export interface TaskOrderItemInput {
  /** 任务 ID */
  id: string;
  /** 排序位置 */
  position: number;
}

/**
 * 任务重排请求输入
 */
export interface ReorderTasksInput {
  /** 任务排序列表 */
  tasks: TaskOrderItemInput[];
}
