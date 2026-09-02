/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.4（看板详情页-任务详情抽屉）
 *
 * [踩坑索引] （暂无）
 *
 * [铁律关联] #1(暗色主题-单套令牌)
 *
 * [详细踩坑]（暂无）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { taskStatusMap as statusMap, taskPriorityMap as priorityMap } from '@/lib/status-visuals';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { TaskDetailPanel } from '@/components/tasks/task-detail-panel';
import { ArrowLeft } from 'lucide-react';

/**
 * TaskDetailPage — 任务独立详情页
 *
 * 心智模型：独立页 = 深链/分享入口，渲染同一 TaskDetailPanel 组件，
 * 与看板抽屉能力永远一致。不传 onNavigateTask → 依赖链接保持整页跳转。
 */
export default function TaskDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const t = useTranslations('tasks');
  const tGlobal = useTranslations();

  /** 任务详情（仅用于头部展示和加载/404 态判断） */
  const { data: task, isLoading } = useQuery({
    queryKey: ['tasks', 'detail', id],
    queryFn: () => Api.tasks.getById(id),
    enabled: !!id,
  });

  // ── 加载态 ────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  // ── 404 态 ────────────────────────────────────

  if (!task) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">{t('notFound')}</h2>
        <Link href="/boards" className="mt-4 text-primary hover:underline">
          {t('backToBoards')}
        </Link>
      </div>
    );
  }

  const status = statusMap[task.status] || { labelKey: task.status, variant: 'default' as const };
  const priority = priorityMap[task.priority] || { label: task.priority, color: '' };

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)]">
      {/* ── 返回头部（固定） ── */}
      <div className="shrink-0 flex items-start gap-4 mb-4">
        <Link href="/boards">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold truncate">{task.title}</h1>
            <Badge variant={status.variant}>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {tGlobal(status.labelKey as any)}
            </Badge>
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${priority.color}`}
            >
              {priority.label}
            </span>
          </div>
          {task.description && (
            <p className="text-muted-foreground mt-2 line-clamp-2">{task.description}</p>
          )}
        </div>
      </div>

      {/* ── 主体：共享 TaskDetailPanel ── */}
      <div className="flex-1 overflow-hidden">
        <TaskDetailPanel taskId={id} />
      </div>
    </div>
  );
}
