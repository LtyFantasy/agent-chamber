import { Visibility, BoardMemberRole } from '../enums';
import type { TaskSummary } from './task-response.dto';

/**
 * 看板成员（关系表聚合视图）
 * 由 board_members join actors 实时组装
 */
export interface BoardMember {
  /** 成员 Actor ID */
  id: string;
  /** 成员名称 */
  name: string;
  /** 成员类型 */
  type: 'human' | 'agent';
  /** 头像 URL */
  avatarUrl?: string | null;
  /** 成员角色：editor 可编辑看板内容，member 只读 */
  role: BoardMemberRole;
  /** 邀请者 Actor ID（可空） */
  invitedBy?: string | null;
  /** 加入时间 */
  createdAt?: string | Date;
}

/**
 * 看板基本信息（列表视图）
 */
export interface Board {
  /** 看板 ID */
  id: string;
  /** 看板名称 */
  name: string;
  /** 描述摘要片段：≤200 字符截断，无描述时 null，仅列表视图返回 */
  descriptionSnippet?: string | null;
  /** 关联话题 ID */
  topicId?: string | null;
  /** 可见性 */
  visibility?: Visibility;
  /** 创建者 ID */
  creatorId?: string;
  /** 创建者类型 */
  creatorType?: 'human' | 'agent' | 'system';
  /** 创建者 ID（遗留字段，部分历史代码仍在使用） */
  createdBy?: string;
  /** 任务数量 */
  taskCount?: number;
  /** 已完成任务数量 */
  completedTaskCount?: number;
  /** 成员数量（替代 invitedAgentCount） */
  memberCount?: number;
  /** 创建时间 */
  createdAt?: string | Date;
  /** 更新时间 */
  updatedAt?: string | Date;
}

/**
 * 看板详情（聚合视图）
 * 字段来自 Board + board_members + lists
 */
export interface BoardDetail extends Board {
  /** 详情完整描述 */
  description: string | null;
  /** 看板列列表（仅含 list 元数据，不再嵌套 tasks） */
  lists: BoardListSummary[];
  /** 成员列表（替代 invitedAgentIds/editorIds/editorAgents/invitedAgents/topicParticipants/topicParticipantAgents/topicParticipantHumans） */
  members?: BoardMember[];
  /** 列数量（动态计算） */
  listCount?: number;
}

/**
 * 看板列摘要（不含 tasks）
 */
export interface BoardListSummary {
  /** 列 ID */
  id: string;
  /** 所属看板 ID */
  boardId: string;
  /** 列名称 */
  name: string;
  /** 排序位置 */
  position: number;
  /** 颜色 */
  color?: string;
  /** 映射的任务状态（null 表示取消映射） */
  mappedStatus?: string | null;
  /** 该列未删除任务总数 */
  taskCount: number;
  /** 创建时间 */
  createdAt: string | Date;
  /** 更新时间 */
  updatedAt: string | Date;
}

/**
 * 看板列
 */
export interface BoardList {
  /** 列 ID */
  id: string;
  /** 所属看板 ID */
  boardId: string;
  /** 列名称 */
  name: string;
  /** 排序位置 */
  position: number;
  /** 颜色 */
  color?: string;
  /** 映射的任务状态（null 表示取消映射） */
  mappedStatus?: string | null;
  /** 任务数量 */
  taskCount?: number;
  /** 任务列表 */
  tasks: TaskSummary[];
}
