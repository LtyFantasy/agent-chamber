/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念] 任务编辑的字段意图、版本基线与部分写响应。
 * [代码职责] 纯函数负责规范化、差异、逐字段接受、读校验及投影失效。
 * [权威文档] DocSpace Agent Chamber: docs/frontend/frontend-architecture.md §8.3/§12；
 *   docs/api-definition.md §7.13。
 * [关键不变量] 省略保持，清空显式发送；只接受实际读出的目标与字符串 token；
 *   写响应不是完整 GET，未提交输入和仍有效的展示字段不可丢失。
 * [关联代码] task-detail-panel.tsx；task-editor.test.ts。
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { ErrorCode, Priority, TaskStatus } from '@agent-chamber/shared';
import type { TaskDetail, UpdateTaskRequest } from '@/types';
import { businessErrorCode, httpStatusOf } from '@/lib/error-message';

/** Form values normalize nullable server empties once, so reverting is a real net-zero edit. */
export interface TaskEditValues {
  /** Task title, preserved verbatim until the server normalizes it. */
  title: string;
  /** Empty string is the description clear intent. */
  description: string;
  /** Status value; request validation remains the server's responsibility. */
  status: string;
  /** Priority value from the existing shared vocabulary. */
  priority: string;
  /** Empty selection becomes an explicit null only when changed. */
  assigneeId: string;
  /** Labels retain their existing order. */
  labels: string[];
  /** Milestone is part of the same draft and Save boundary. */
  milestoneId: string;
}

/** Stable iteration order supports the same field comparison in payloads and the review disclosure. */
export const TASK_EDIT_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assigneeId',
  'labels',
  'milestoneId',
] as const;
/** Field keys are derived from the single form shape rather than a second domain vocabulary. */
export type TaskEditField = (typeof TASK_EDIT_FIELDS)[number];

/** Initial values are used only before a server snapshot is accepted. */
export const EMPTY_TASK_DRAFT: TaskEditValues = {
  title: '',
  description: '',
  status: TaskStatus.TODO,
  priority: Priority.P2,
  assigneeId: '',
  labels: [],
  milestoneId: '',
};

/** Read actual present fields; a partial write keeps confirmed fallback fields instead of inventing empties. */
export function draftFromTask(
  task: Partial<TaskDetail>,
  fallback = EMPTY_TASK_DRAFT,
): TaskEditValues {
  return {
    title: typeof task.title === 'string' ? task.title : fallback.title,
    description:
      task.description === null
        ? ''
        : typeof task.description === 'string'
          ? task.description
          : fallback.description,
    status: typeof task.status === 'string' ? task.status : fallback.status,
    priority: typeof task.priority === 'string' ? task.priority : fallback.priority,
    assigneeId:
      task.assigneeId === null
        ? ''
        : typeof task.assigneeId === 'string'
          ? task.assigneeId
          : fallback.assigneeId,
    labels:
      task.labels === null
        ? []
        : Array.isArray(task.labels)
          ? [...task.labels]
          : [...fallback.labels],
    milestoneId:
      task.milestoneId === null
        ? ''
        : typeof task.milestoneId === 'string'
          ? task.milestoneId
          : fallback.milestoneId,
  };
}

/** Arrays compare by value; strings already use the canonical form representation. */
function sameField(left: TaskEditValues, right: TaskEditValues, field: TaskEditField): boolean {
  return field === 'labels'
    ? JSON.stringify(left.labels) === JSON.stringify(right.labels)
    : left[field] === right[field];
}

/** Net differences, not permanent touched flags, define both dirty state and conflict intent. */
export function changedFields(current: TaskEditValues, baseline: TaskEditValues): TaskEditField[] {
  return TASK_EDIT_FIELDS.filter((field) => !sameField(current, baseline, field));
}

/** Only changed fields are written; null survives JSON while undefined would erase the clear intent. */
export function buildTaskPatch(
  current: TaskEditValues,
  baseline: TaskEditValues,
  token: string,
): UpdateTaskRequest | null {
  const fields = changedFields(current, baseline);
  if (fields.length === 0) return null;
  const patch: UpdateTaskRequest = { expectedUpdatedAt: token };
  for (const field of fields) {
    switch (field) {
      case 'status':
        patch.status = current.status as TaskStatus;
        break;
      case 'priority':
        patch.priority = current.priority as Priority;
        break;
      case 'assigneeId':
        patch.assigneeId = current.assigneeId || null;
        break;
      case 'milestoneId':
        patch.milestoneId = current.milestoneId || null;
        break;
      case 'labels':
        patch.labels = [...current.labels];
        break;
      case 'title':
        patch.title = current.title;
        break;
      case 'description':
        patch.description = current.description;
        break;
    }
  }
  return patch;
}

/** Compare with the submitted draft on save, or the old baseline on read, preserving only current local intent. */
export function mergeDraftFields(
  current: TaskEditValues,
  comparison: TaskEditValues,
  server: TaskEditValues,
): TaskEditValues {
  const merged = { ...server, labels: [...server.labels] };
  for (const field of changedFields(current, comparison))
    Object.assign(merged, { [field]: current[field] });
  return merged;
}

/** Tokens remain opaque response strings; never stringify Dates or take a replacement from an error body. */
export function taskTokenOf(task: Partial<TaskDetail>): string | null {
  return typeof task.updatedAt === 'string' && task.updatedAt.trim().length > 0
    ? task.updatedAt
    : null;
}

/** Recovery requires a real complete target read, not cached last-good data after a failed request. */
export function isEditableTaskRead(value: unknown, taskId: string): value is TaskDetail {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TaskDetail>;
  return (
    task.id === taskId &&
    taskTokenOf(task) !== null &&
    typeof task.title === 'string' &&
    (typeof task.description === 'string' || task.description === null) &&
    Object.values(TaskStatus).includes(task.status as TaskStatus) &&
    Object.values(Priority).includes(task.priority as Priority) &&
    (typeof task.assigneeId === 'string' || task.assigneeId === null) &&
    (typeof task.milestoneId === 'string' || task.milestoneId === null) &&
    (task.labels === null ||
      (Array.isArray(task.labels) && task.labels.every((label) => typeof label === 'string')))
  );
}

/** 9001 is shared by other conflicts: only this exact status/code/detail envelope means a stale task version. */
export function isTaskVersionConflict(error: unknown): boolean {
  if (httpStatusOf(error) !== 409 || businessErrorCode(error) !== ErrorCode.RESOURCE_CONFLICT)
    return false;
  const token = (error as { response?: { data?: { data?: { currentUpdatedAt?: unknown } } } })
    ?.response?.data?.data?.currentUpdatedAt;
  return typeof token === 'string' && token.trim().length > 0;
}

/** Keep last-good GET-only fields, but remove projections made false by changed entity fields until GET refreshes them. */
export function mergeTaskWrite(
  previous: TaskDetail | undefined,
  saved: TaskDetail,
): TaskDetail | undefined {
  if (!previous) return undefined;
  const merged = { ...previous, ...saved };
  if (saved.assigneeId !== undefined && saved.assigneeId !== previous.assigneeId) {
    delete merged.assigneeName;
    delete merged.assigneeDeletedAt;
  }
  if (saved.description !== undefined && saved.description !== previous.description)
    delete merged.descriptionHash;
  if (saved.milestoneId !== undefined && saved.milestoneId !== previous.milestoneId)
    delete merged.milestone;
  if (saved.listId !== undefined && saved.listId !== previous.listId) delete merged.listName;
  return merged;
}
