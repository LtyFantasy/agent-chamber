'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import type { TaskSummary } from '@/types';

/**
 * =============================================================================
 * 任务卡徽章行（TaskCardBadges）—— 看板任务卡/拖拽预览共用的纯展示片段。
 *
 * 从 boards/[id]/page.tsx 抽取（统一批 B）：SortableTask 与 DragOverlay 共用
 * 的视觉映射常量（状态色/优先级色）随组件内聚，页面只引用，防配色漂移；
 * 独立文件使组件可脱离页面重依赖（dnd-kit/next-navigation/Api）单独测试。
 * ──────────────────────────────────────────────
 * 任务卡视觉映射 — 新色板状态色/优先级色（docs/ui-design-system.md §2.2：
 * 半透明语义色底 + 亮阶文字，禁止亮主题 -100/-800 硬编码）。
 * ──────────────────────────────────────────────
 */

/** 任务优先级徽章色 */
export const priorityColors: Record<string, string> = {
  p3: 'bg-muted/50 text-muted-foreground',
  p2: 'bg-blue-500/15 text-blue-300',
  p1: 'bg-orange-500/15 text-orange-300',
  p0: 'bg-red-500/15 text-red-300',
};

/** 任务状态 icon key 映射（供 tGlobal 翻译） */
export const statusLabelKeys: Record<string, string> = {
  done: 'tasks.status.done',
  blocked: 'tasks.status.blocked',
  in_progress: 'tasks.status.in_progress',
  review: 'tasks.status.review',
  backlog: 'tasks.status.backlog',
  todo: 'tasks.status.todo',
  archived: 'tasks.status.archived',
};

/** 任务状态对应的视觉样式：左侧 2px 状态色边条 + 状态徽章色 */
export const statusStyles: Record<string, { border: string; labelColor: string }> = {
  done: {
    border: 'border-l-2 border-l-emerald-400',
    labelColor: 'text-emerald-300 bg-emerald-500/15',
  },
  blocked: {
    border: 'border-l-2 border-l-red-400',
    labelColor: 'text-red-300 bg-red-500/15',
  },
  in_progress: {
    border: 'border-l-2 border-l-blue-400',
    labelColor: 'text-blue-300 bg-blue-500/15',
  },
  review: {
    border: 'border-l-2 border-l-violet-400',
    labelColor: 'text-violet-300 bg-violet-glow/15',
  },
  backlog: {
    border: 'border-l-2 border-l-slate-500',
    labelColor: 'text-muted-foreground bg-muted/50',
  },
  todo: {
    border: 'border-l-2 border-l-slate-500',
    labelColor: 'text-muted-foreground bg-muted/50',
  },
  archived: {
    border: 'border-l-2 border-l-slate-600 opacity-60',
    labelColor: 'text-muted-foreground bg-muted/40',
  },
};

/**
 * TaskCardBadges — 任务卡徽章行（状态/优先级/负责人/阻塞）。
 * SortableTask 与 DragOverlay 拖拽预览共用的纯展示片段，无逻辑。
 */
export function TaskCardBadges({
  task,
  hasBlockers,
}: {
  task: TaskSummary;
  hasBlockers?: boolean;
}) {
  const tGlobal = useTranslations();
  const statusKey = statusLabelKeys[task.status] || 'tasks.status.todo';
  const statusColor = (statusStyles[task.status] || statusStyles.todo).labelColor;
  return (
    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
      {/* 状态标签 */}
      <span
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusColor}`}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {tGlobal(statusKey as any)}
      </span>
      {task.priority && (
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${priorityColors[task.priority] || ''}`}
        >
          {task.priority}
        </span>
      )}
      {/* 负责人：已删除（assigneeDeletedAt 非空）只灰化——8 字符截断场景不加 badge
          （统一批 B R16 分级：任务卡信息密度中，灰化即可辨识） */}
      {task.assigneeName && (
        <span
          className={`inline-flex items-center rounded bg-indigo-500/15 px-1.5 py-0.5 text-xs font-medium text-indigo-300 ${
            task.assigneeDeletedAt ? 'opacity-50' : ''
          }`}
          title={task.assigneeDeletedAt ? tGlobal('common.deleted') : undefined}
        >
          {task.assigneeName.slice(0, 8)}
        </span>
      )}
      {hasBlockers && (
        <span
          className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-300"
          title={tGlobal('tasks.hasBlockers')}
        >
          <Lock className="h-3 w-3 mr-0.5" />
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {tGlobal('tasks.status.blocked' as any)}
        </span>
      )}
    </div>
  );
}
