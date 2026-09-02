/**
 * =============================================================================
 * 枚举值 → UI 文案 key / 徽章色 唯一映射源（单源收敛，review-0831）
 *
 * 历史：任务状态 / 优先级 / Topic 状态 / 里程碑状态的视觉映射曾以 6+ 份逐字
 * 一致的副本散落于 search / tasks/[id] / topics / admin-dashboard /
 * boards/[id] / task-card-badges 各文件，必然漂移。本文件为唯一事实来源，
 * 各消费点只 import，禁止再写本地副本。
 *
 * 铁律：改显示文案 key / 颜色 / variant 只允许改这里；新增枚举值必须同步
 * 本文件（satisfies 约束在编译期拦截遗漏）。key 集合 = @agent-chamber/shared
 * 枚举值（TaskStatus / Priority / TopicStatus / MilestoneStatus），不新造枚举。
 * =============================================================================
 */
import type { TaskStatus, TopicStatus, Priority, MilestoneStatus } from '@agent-chamber/shared';

/** Badge 组件支持的全部语义 variant（与 components/ui/badge 的 variant 联合一致） */
export type StatusVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning';

/** 任务状态 → (i18n 文案 key, 徽章 variant)。key 集合 = TaskStatus 枚举值 */
export const taskStatusMap: Record<string, { labelKey: string; variant: StatusVariant }> = {
  backlog: { labelKey: 'tasks.status.backlog', variant: 'secondary' },
  todo: { labelKey: 'tasks.status.todo', variant: 'default' },
  in_progress: { labelKey: 'tasks.status.in_progress', variant: 'warning' },
  review: { labelKey: 'tasks.status.review', variant: 'outline' },
  done: { labelKey: 'tasks.status.done', variant: 'success' },
  blocked: { labelKey: 'tasks.status.blocked', variant: 'destructive' },
  archived: { labelKey: 'tasks.status.archived', variant: 'secondary' },
} satisfies Record<TaskStatus, { labelKey: string; variant: StatusVariant }>;

/** 优先级 → (显示 label, 徽章色)。key 集合 = Priority 枚举值 */
export const taskPriorityMap: Record<string, { label: string; color: string }> = {
  p0: { label: 'P0', color: 'bg-red-500/15 text-red-300' },
  p1: { label: 'P1', color: 'bg-orange-500/15 text-orange-300' },
  p2: { label: 'P2', color: 'bg-blue-500/15 text-blue-300' },
  p3: { label: 'P3', color: 'bg-muted/50 text-muted-foreground' },
} satisfies Record<Priority, { label: string; color: string }>;

/**
 * 优先级 → 徽章色（taskPriorityMap 的颜色投影，供仅需颜色的消费点使用，
 * 如 task-card-badges 的 priorityColors——历史副本，现指向本投影防漂移）。
 */
export const priorityColors: Record<string, string> = Object.fromEntries(
  Object.entries(taskPriorityMap).map(([key, value]) => [key, value.color]),
);

/** Topic 状态 → (i18n 文案 key, 徽章 variant)。key 集合 = TopicStatus 枚举值
 *  （2026-08-31 死契约清理：draft/voting 已删，映射同步收敛） */
export const topicStatusMap: Record<string, { labelKey: string; variant: StatusVariant }> = {
  open: { labelKey: 'topics.status.open', variant: 'default' },
  active: { labelKey: 'topics.status.active', variant: 'success' },
  paused: { labelKey: 'topics.status.paused', variant: 'warning' },
  closed: { labelKey: 'topics.status.closed', variant: 'destructive' },
  archived: { labelKey: 'topics.status.archived', variant: 'outline' },
} satisfies Record<TopicStatus, { labelKey: string; variant: StatusVariant }>;

/** 里程碑状态 → i18n 文案 key。key 集合 = MilestoneStatus 枚举值 */
export const milestoneStatusLabelKeys: Record<string, string> = {
  planned: 'boards.milestone.status.planned',
  active: 'boards.milestone.status.active',
  completed: 'boards.milestone.status.completed',
  cancelled: 'boards.milestone.status.cancelled',
  dev: 'boards.milestone.status.dev',
  ready: 'boards.milestone.status.ready',
  deployed: 'boards.milestone.status.deployed',
  verified: 'boards.milestone.status.verified',
} satisfies Record<MilestoneStatus, string>;

/** 里程碑状态 → 徽章色（新色板暗色适配：半透明语义色底 + 亮阶文字） */
export const milestoneStatusColors: Record<string, string> = {
  planned: 'bg-muted/50 text-muted-foreground',
  active: 'bg-blue-500/15 text-blue-300',
  completed: 'bg-emerald-500/15 text-emerald-300',
  cancelled: 'bg-muted/40 text-muted-foreground line-through',
  dev: 'bg-amber-500/15 text-amber-300',
  ready: 'bg-cyan-500/15 text-cyan-300',
  deployed: 'bg-violet-500/15 text-violet-300',
  verified: 'bg-emerald-500/15 text-emerald-300',
} satisfies Record<MilestoneStatus, string>;
