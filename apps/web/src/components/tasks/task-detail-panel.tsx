/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.4（看板详情页-任务详情抽屉）
 *   - 补充: docs/ui-design-system.md §3（overlay 抽屉先例）
 *
 * [踩坑索引] （暂无）
 *
 * [铁律关联] #1(暗色主题-单套令牌) #4(表单脏状态-本地useState) #5(看板刷新-显式回调)
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

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Priority, TaskStatus } from '@agent-chamber/shared';
import { AgentStatus, ActivityAction } from '@/types';
import { Api } from '@/lib/api';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loading } from '@/components/ui/loading';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Copy,
  Trash2,
  Send,
  Lock,
  Plus,
  X,
  Clock,
  Tag,
  Users,
  Milestone,
  MessageCircle,
  FileText,
} from 'lucide-react';
import type { Milestone as MilestoneType, TaskDependencyItem, Comment, Activity } from '@/types';
import { DocPicker } from '@/components/docs/doc-picker';
import { TaskPicker, type TaskPick } from '@/components/tasks/task-picker';
import { confirm } from '@/lib/notify';

/** 组件 Props */
export interface TaskDetailPanelProps {
  /** 要展示的任务 ID */
  taskId: string;
  /** 保存/删除/依赖变更成功后回调（看板传入显式刷新；独立页不传） */
  onChanged?: () => void;
  /** 抽屉内导航：点依赖链接压栈。独立页不传则回退 <Link> 整页跳转 */
  onNavigateTask?: (taskId: string) => void;
  /** 导航栈上一级任务标题（从 react-query 缓存读，零成本） */
  previousTaskTitle?: string;
  /** 导航栈返回上一级回调 */
  onNavigateBack?: () => void;
  /** 栈深 > 1 时显示返回按钮 */
  showBack?: boolean;
  /** 暴露脏状态给父级（用于关闭抽屉时的 confirm 拦截） */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * TaskDetailPanel — 任务详情共享组件
 *
 * 看板右侧抽屉与独立页 /tasks/:id 共用同一个组件，根治双实现漂移。
 * 顶部 Tab 分页：详情/依赖/评论/活动；评论/活动/依赖 Tab 激活才发请求（懒加载）。
 */
export function TaskDetailPanel({
  taskId,
  onChanged,
  onNavigateTask,
  previousTaskTitle,
  onNavigateBack,
  showBack,
  onDirtyChange,
}: TaskDetailPanelProps) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const t = useTranslations('tasks');
  const locale = useLocale();
  const tGlobal = useTranslations();
  // 删除确认弹窗打开期间置 true（双击防护：异步 confirm 无原生同步阻塞，
  // 不防则连点排队两个确认框——确认两次 = 重复删除任务）
  const deleteConfirmPendingRef = useRef(false);

  /** 当前激活的 Tab */
  const [activeTab, setActiveTab] = useState('detail');

  /** taskId 变更时复位 Tab 到「详情」 */
  useEffect(() => {
    setActiveTab('detail');
  }, [taskId]);

  // ── 数据查询 ────────────────────────────────────

  /** 任务详情（始终加载） */
  const { data: task, isLoading: taskLoading } = useQuery({
    queryKey: ['tasks', 'detail', taskId],
    queryFn: () => Api.tasks.getById(taskId),
    enabled: !!taskId,
  });

  /** Agent 列表（分配人下拉用） */
  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    // listAll 循环翻页拉全：单页 pageSize:100 在 >100 个 agent 时静默丢数据（评审 M-e 同类缺口 B6）
    queryFn: () => Api.agents.listAll(),
  });
  const activeAgents = (agentsData ?? []).filter((a) => a.status === AgentStatus.ACTIVE);

  /** 看板详情（「所在列」显示 +「在看板中查看」链接） */
  const { data: boardData } = useQuery({
    queryKey: ['boards', 'detail', task?.boardId],
    queryFn: () => Api.boards.getById(task!.boardId!),
    enabled: !!task?.boardId,
  });

  /** 关联话题（「所属话题」链接） */
  const { data: topicData } = useQuery({
    queryKey: ['topics', 'detail', task?.topicId],
    queryFn: () => Api.topics.getById(task!.topicId!),
    enabled: !!task?.topicId,
  });

  /** 里程碑列表（详情 Tab 激活才拉） */
  const { data: milestonesData } = useQuery({
    queryKey: ['milestones', 'list', task?.boardId],
    queryFn: () => Api.tasks.getMilestones({ boardId: task!.boardId!, pageSize: 100 }),
    enabled: activeTab === 'detail' && !!task?.boardId,
  });

  /** 评论（评论 Tab 激活才拉） */
  const { data: commentsData } = useQuery({
    queryKey: ['tasks', 'comments', taskId],
    queryFn: () => Api.tasks.getComments(taskId),
    enabled: activeTab === 'comments' && !!taskId,
  });

  /** 活动日志（活动 Tab 激活才拉） */
  const { data: activitiesData } = useQuery({
    queryKey: ['tasks', 'activities', taskId],
    queryFn: () => Api.tasks.getActivities(taskId),
    enabled: activeTab === 'activities' && !!taskId,
  });

  /** 依赖列表（依赖 Tab 激活才拉） */
  const { data: dependenciesData } = useQuery({
    queryKey: ['tasks', 'dependencies', taskId],
    queryFn: () => Api.tasks.getDependencies(taskId),
    enabled: activeTab === 'dependencies' && !!taskId,
  });

  /** 阻塞项列表（依赖 Tab 激活才拉） */
  const { data: blockersData } = useQuery({
    queryKey: ['tasks', 'blockers', taskId],
    queryFn: () => Api.tasks.getBlockers(taskId),
    enabled: activeTab === 'dependencies' && !!taskId,
  });

  // ── 表单脏状态（本地 useState，不继承 setQueryData 旧坑） ──

  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftStatus, setDraftStatus] = useState<string>('todo');
  const [draftPriority, setDraftPriority] = useState<string>('p2');
  const [draftAssigneeId, setDraftAssigneeId] = useState('');
  const [draftLabels, setDraftLabels] = useState<string[]>([]);
  /** 标签输入框当前文本（回车/逗号确认为一个标签） */
  const [labelInput, setLabelInput] = useState('');

  /** task 加载完成后同步服务端数据到本地草稿 */
  useEffect(() => {
    if (task) {
      setDraftTitle(task.title);
      setDraftDescription(task.description || '');
      setDraftStatus(task.status);
      setDraftPriority(task.priority);
      setDraftAssigneeId(task.assigneeId || '');
      setDraftLabels(task.labels ?? []);
    }
  }, [task]);

  /** 计算是否有未保存修改 */
  const isDirty = useMemo(() => {
    if (!task) return false;
    return (
      draftTitle !== task.title ||
      draftDescription !== (task.description || '') ||
      draftStatus !== task.status ||
      draftPriority !== task.priority ||
      draftAssigneeId !== (task.assigneeId || '') ||
      JSON.stringify(draftLabels) !== JSON.stringify(task.labels ?? [])
    );
  }, [
    task,
    draftTitle,
    draftDescription,
    draftStatus,
    draftPriority,
    draftAssigneeId,
    draftLabels,
  ]);

  /** 通知父级脏状态变化（用于关闭抽屉 confirm 拦截） */
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // ── Mutations ────────────────────────────────────

  /** 保存任务 */
  const updateMutation = useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      priority: Priority;
      status: TaskStatus;
      assigneeId?: string;
      labels?: string[];
    }) => Api.tasks.update(taskId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', taskId] });
      onChanged?.();
    },
  });

  /** 删除任务 */
  const deleteMutation = useMutation({
    mutationFn: () => Api.tasks.delete(taskId),
    onSuccess: () => {
      onChanged?.();
    },
  });

  /** 更新里程碑 */
  const updateMilestoneMutation = useMutation({
    mutationFn: (milestoneId: string | null) =>
      Api.tasks.update(taskId, { milestoneId: milestoneId || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', taskId] });
      onChanged?.();
    },
  });

  /** 添加评论 */
  const [commentText, setCommentText] = useState('');
  const addCommentMutation = useMutation({
    mutationFn: (content: string) => Api.tasks.addComment(taskId, { content }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'comments', taskId] });
      setCommentText('');
    },
  });

  /** 添加依赖（U5：搜索选择器替代裸 UUID 输入） */
  const [depPick, setDepPick] = useState<TaskPick | null>(null);
  const [newDepType, setNewDepType] = useState<'blocks' | 'relates_to' | 'duplicates'>('blocks');
  const addDependencyMutation = useMutation({
    mutationFn: (data: { dependsOnTaskId: string; type?: string }) =>
      Api.tasks.addDependency(taskId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'dependencies', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'blockers', taskId] });
      onChanged?.();
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
      const msg =
        axiosErr?.response?.data?.message || axiosErr?.message || t('dependency.addFailed');
      alert(msg);
    },
  });

  /** 移除依赖 */
  const removeDependencyMutation = useMutation({
    mutationFn: (depId: string) => Api.tasks.removeDependency(taskId, depId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'dependencies', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'blockers', taskId] });
      onChanged?.();
    },
  });

  /** 关联文档：添加（幂等） */
  const addDocLinkMutation = useMutation({
    mutationFn: (docId: string) => Api.tasks.addDocLink(taskId, docId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', taskId] });
    },
    onError: (err: unknown) => {
      const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
      const msg = axiosErr?.response?.data?.message || axiosErr?.message || t('docs.addFailed');
      alert(msg);
    },
  });

  /** 关联文档：移除 */
  const removeDocLinkMutation = useMutation({
    mutationFn: (docId: string) => Api.tasks.removeDocLink(taskId, docId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', taskId] });
    },
  });

  // ── 派生数据 ────────────────────────────────────

  const statusOptions = [
    { value: 'backlog', labelKey: 'tasks.status.backlog' as const },
    { value: 'todo', labelKey: 'tasks.status.todo' as const },
    { value: 'in_progress', labelKey: 'tasks.status.in_progress' as const },
    { value: 'review', labelKey: 'tasks.status.review' as const },
    { value: 'done', labelKey: 'tasks.status.done' as const },
    { value: 'blocked', labelKey: 'tasks.status.blocked' as const },
  ];

  const comments: Comment[] = Array.isArray(commentsData) ? commentsData : [];
  const activities: Activity[] = Array.isArray(activitiesData) ? activitiesData : [];
  const dependencies: TaskDependencyItem[] = Array.isArray(dependenciesData)
    ? dependenciesData
    : [];
  const blockers: TaskDependencyItem[] = Array.isArray(blockersData) ? blockersData : [];
  const listName =
    boardData?.lists?.find((l: { id: string; name: string }) => l.id === task?.listId)?.name ||
    t('unknownList');

  /** 保存操作 */
  const handleSave = () => {
    if (!task) return;
    const payload: {
      title: string;
      description?: string;
      priority: Priority;
      status: TaskStatus;
      assigneeId?: string;
      labels?: string[];
    } = {
      title: draftTitle,
      description: draftDescription || undefined,
      priority: draftPriority as Priority,
      status: draftStatus as TaskStatus,
      labels: draftLabels,
    };
    if (draftAssigneeId) {
      payload.assigneeId = draftAssigneeId;
    }
    updateMutation.mutate(payload);
  };

  /** 发送评论 */
  const handleAddComment = () => {
    if (!commentText.trim()) return;
    addCommentMutation.mutate(commentText);
  };

  // ── 加载态 ──────────────────────────────────────

  if (taskLoading || !task) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loading size="sm" />
      </div>
    );
  }

  // ── 渲染 ────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      {/* ── 头部（固定） ── */}
      <div className="shrink-0 space-y-2">
        {/* 导航栈返回按钮 */}
        {showBack && previousTaskTitle && (
          <button
            onClick={onNavigateBack}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="truncate max-w-[200px]">
              {t('backToTask', { title: previousTaskTitle })}
            </span>
          </button>
        )}

        {/* 标题（truncate） */}
        <h2 className="text-lg font-semibold truncate">{task.title}</h2>

        {/* 元信息条：短 ID + 复制 + 创建/更新时间 + 打开完整页 */}
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md border border-border/50 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[11px] select-all">{task.id.slice(0, 8)}</span>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(task.id);
              }}
              className="hover:text-foreground transition-colors"
              title={t('copyTaskId')}
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate" title={formatDate(task.createdAt, locale)}>
              {t('created', { time: formatRelativeTime(task.createdAt, locale) })}
            </span>
            <span className="text-border">·</span>
            <span className="truncate" title={formatDate(task.updatedAt, locale)}>
              {t('updated', { time: formatRelativeTime(task.updatedAt, locale) })}
            </span>
          </div>
        </div>
      </div>

      {/* ── Tab 切换栏（固定） ── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="shrink-0 mt-3">
        <TabsList className="w-full">
          <TabsTrigger value="detail" className="flex-1">
            {t('tab.detail')}
          </TabsTrigger>
          <TabsTrigger value="dependencies" className="flex-1">
            {t('tab.dependencies')}
          </TabsTrigger>
          <TabsTrigger value="comments" className="flex-1">
            {t('tab.comments')}
          </TabsTrigger>
          <TabsTrigger value="activities" className="flex-1">
            {t('tab.activities')}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 内容区（可滚动） ── */}
        <div className="flex-1 overflow-y-auto mt-2 pr-1">
          {/* 详情 Tab */}
          <TabsContent value="detail" className="mt-0 space-y-4">
            {/* 标题 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.title')}</label>
              <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
            </div>

            {/* 状态 + 优先级 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('form.status')}</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={draftStatus}
                  onChange={(e) => setDraftStatus(e.target.value)}
                >
                  {statusOptions.map((s) => (
                    <option key={s.value} value={s.value}>
                      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                      {tGlobal(s.labelKey as any)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('form.priority')}</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  value={draftPriority}
                  onChange={(e) => setDraftPriority(e.target.value)}
                >
                  <option value="p0">{t('priority.p0')}</option>
                  <option value="p1">{t('priority.p1')}</option>
                  <option value="p2">{t('priority.p2')}</option>
                  <option value="p3">{t('priority.p3')}</option>
                </select>
              </div>
            </div>

            {/* 分配人 */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1">
                <Users className="h-3 w-3" />
                {t('form.assignee')}
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={draftAssigneeId}
                onChange={(e) => setDraftAssigneeId(e.target.value)}
              >
                <option value="">{t('form.unassigned')}</option>
                {activeAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 里程碑 */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1">
                <Milestone className="h-3 w-3" />
                {t('form.milestone')}
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={task.milestoneId || ''}
                onChange={(e) => updateMilestoneMutation.mutate(e.target.value || null)}
                disabled={updateMilestoneMutation.isPending}
              >
                <option value="">{t('form.unassigned')}</option>
                {(milestonesData?.items ?? []).map((m: MilestoneType) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 标签（可编辑：回车/逗号添加，点 × 移除，随保存提交） */}
            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-1">
                <Tag className="h-3 w-3" />
                {t('form.labels')}
              </label>
              <div className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5">
                {draftLabels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-blue-500/15 text-blue-300"
                  >
                    {label}
                    <button
                      type="button"
                      onClick={() => setDraftLabels(draftLabels.filter((l) => l !== label))}
                      className="hover:text-foreground"
                      title={t('label.remove')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <input
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ',') && labelInput.trim()) {
                      e.preventDefault();
                      const value = labelInput.trim().replace(/,+$/, '');
                      if (value && !draftLabels.includes(value)) {
                        setDraftLabels([...draftLabels, value]);
                      }
                      setLabelInput('');
                    }
                  }}
                  placeholder={draftLabels.length === 0 ? t('label.placeholder') : ''}
                  className="flex-1 min-w-[80px] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>

            {/* 描述 */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.description')}</label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder={t('form.descPlaceholder')}
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
              />
            </div>

            {/* 属性摘要（独立页补充项） */}
            <div className="space-y-2 pt-2 border-t border-border/50">
              <h3 className="text-sm font-medium">{t('attributes.title')}</h3>
              <div className="space-y-2 text-sm">
                {task.dueDate && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {t('attributes.dueDate')}
                    </span>
                    <span>{formatDate(task.dueDate, locale)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('attributes.list')}</span>
                  <span>{listName}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('attributes.createdAt')}</span>
                  <span>{formatDate(task.createdAt, locale)}</span>
                </div>
                {task.updatedAt && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t('attributes.updatedAt')}</span>
                    <span>{formatDate(task.updatedAt, locale)}</span>
                  </div>
                )}
                {task.topicId && topicData && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <MessageCircle className="h-3 w-3" />
                      {t('attributes.topic')}
                    </span>
                    <Link
                      href={`/topics/${task.topicId}`}
                      className="text-primary hover:underline truncate max-w-[150px]"
                    >
                      {topicData.title}
                    </Link>
                  </div>
                )}
                {/* 「在看板中查看」仅供独立页回跳看板；抽屉场景（onNavigateTask 存在）已经在看板上，隐藏避免冗余 */}
                {task.boardId && !onNavigateTask && (
                  <div className="pt-2 border-t border-border/50">
                    <Link
                      href={`/boards/${task.boardId}`}
                      className="text-sm text-primary hover:underline"
                    >
                      {t('viewInBoard')}
                    </Link>
                  </div>
                )}
              </div>
            </div>

            {/* 关联文档区块：chip 列表 + 移除 + 文档搜索选择器添加 */}
            <div className="space-y-2 pt-2 border-t border-border/50">
              <h3 className="text-sm font-medium flex items-center gap-1">
                <FileText className="h-3 w-3" />
                {t('docs.title')}
              </h3>
              {(task.docs ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('docs.empty')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(task.docs ?? []).map((docLink) => (
                    <span
                      key={docLink.docId}
                      className="group inline-flex items-center gap-1 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-xs"
                    >
                      <button
                        onClick={async () => {
                          // TaskDocLinkItem 不含 spaceId，点击时按 docId 查详情拿空间再跳转。
                          // 文档可能已被删除/无权访问：拉取失败时提示并停留当前页，不裸跳 /docs/undefined
                          try {
                            const detail = await Api.docs.getDoc(docLink.docId);
                            router.push(`/docs/${detail.spaceId}?doc=${docLink.docId}`);
                          } catch (err) {
                            const axiosErr = err as {
                              response?: { data?: { message?: string } };
                              message?: string;
                            };
                            alert(
                              axiosErr?.response?.data?.message ||
                                axiosErr?.message ||
                                t('docs.openFailed'),
                            );
                          }
                        }}
                        className="flex items-center gap-1 hover:text-primary"
                        title={docLink.path}
                      >
                        <FileText className="h-3 w-3 opacity-70" />
                        <span className="max-w-[140px] truncate">{docLink.title}</span>
                      </button>
                      <button
                        onClick={() => removeDocLinkMutation.mutate(docLink.docId)}
                        className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        title={t('docs.remove')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <DocPicker
                boardId={task.boardId ?? undefined}
                disabled={addDocLinkMutation.isPending}
                onSelect={(pick) => addDocLinkMutation.mutate(pick.docId)}
              />
            </div>
          </TabsContent>

          {/* 依赖 Tab */}
          <TabsContent value="dependencies" className="mt-0 space-y-4">
            {/* 计数仅在内容区显示 */}
            <div className="text-xs text-muted-foreground">
              {t('dependency.summary', { blocked: blockers.length, depends: dependencies.length })}
            </div>

            {/* 阻塞中 */}
            {blockers.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Lock className="h-3 w-3 text-amber-500" />
                  {t('dependency.blocking')}
                </p>
                <div className="space-y-1">
                  {blockers.map((dep) => (
                    <div key={dep.id} className="flex items-center justify-between group">
                      {onNavigateTask ? (
                        <button
                          onClick={() => onNavigateTask(dep.dependsOnTaskId)}
                          className="text-sm text-amber-300 hover:underline truncate flex-1 text-left"
                        >
                          {dep.dependsOnTask?.title || dep.dependsOnTaskId}
                        </button>
                      ) : (
                        <Link
                          href={`/tasks/${dep.dependsOnTaskId}`}
                          className="text-sm text-amber-300 hover:underline truncate flex-1"
                        >
                          {dep.dependsOnTask?.title || dep.dependsOnTaskId}
                        </Link>
                      )}
                      <button
                        onClick={() => removeDependencyMutation.mutate(dep.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity ml-2"
                        title={t('dependency.remove')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 我依赖 */}
            {dependencies.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('dependency.dependsOn')}</p>
                <div className="space-y-1">
                  {dependencies.map((dep) => (
                    <div key={dep.id} className="flex items-center justify-between group">
                      {onNavigateTask ? (
                        <button
                          onClick={() => onNavigateTask(dep.dependsOnTaskId)}
                          className="text-sm text-primary hover:underline truncate flex-1 text-left"
                        >
                          {dep.dependsOnTask?.title || dep.dependsOnTaskId}
                        </button>
                      ) : (
                        <Link
                          href={`/tasks/${dep.dependsOnTaskId}`}
                          className="text-sm text-primary hover:underline truncate flex-1"
                        >
                          {dep.dependsOnTask?.title || dep.dependsOnTaskId}
                        </Link>
                      )}
                      <button
                        onClick={() => removeDependencyMutation.mutate(dep.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity ml-2"
                        title={t('dependency.remove')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 添加依赖（U5：任务搜索选择器替代裸 UUID 输入，与 doc-picker 共用 SearchSelectPopover） */}
            <div className="flex gap-2 items-start pt-1">
              <TaskPicker
                excludeTaskId={taskId}
                placeholder={t('dependency.searchPlaceholder')}
                selectedTitle={depPick?.title}
                onSelect={setDepPick}
              />
              <select
                className="h-10 rounded-md border border-input bg-background px-2 py-2 text-sm"
                value={newDepType}
                onChange={(e) =>
                  setNewDepType(e.target.value as 'blocks' | 'relates_to' | 'duplicates')
                }
              >
                <option value="blocks">{t('dependencyType.blocks')}</option>
                <option value="relates_to">{t('dependencyType.relates_to')}</option>
                <option value="duplicates">{t('dependencyType.duplicates')}</option>
              </select>
              <Button
                size="sm"
                onClick={() => {
                  if (!depPick) return;
                  addDependencyMutation.mutate(
                    { dependsOnTaskId: depPick.id, type: newDepType },
                    {
                      onSuccess: () => {
                        setDepPick(null);
                        setNewDepType('blocks');
                      },
                    },
                  );
                }}
                isLoading={addDependencyMutation.isPending}
                disabled={!depPick}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </TabsContent>

          {/* 评论 Tab */}
          <TabsContent value="comments" className="mt-0 space-y-4">
            {/* 计数仅在内容区显示 */}
            <div className="text-xs text-muted-foreground">
              {t('comment.count', { count: comments.length })}
            </div>

            <div className="space-y-3 max-h-[300px] overflow-y-auto">
              {comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('comment.empty')}</p>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="rounded-md border bg-muted/30 p-3 text-sm">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <span className="font-medium">{c.authorName}</span>
                      <span>{new Date(c.createdAt).toLocaleString('zh-CN')}</span>
                    </div>
                    <p className="whitespace-pre-wrap">{c.content}</p>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder={t('comment.placeholder')}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAddComment();
                  }
                }}
                className="flex-1"
              />
              <Button size="sm" onClick={handleAddComment} isLoading={addCommentMutation.isPending}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </TabsContent>

          {/* 活动 Tab */}
          <TabsContent value="activities" className="mt-0 space-y-3">
            {/* 计数仅在内容区显示 */}
            <div className="text-xs text-muted-foreground">
              {t('activity.count', { count: activities.length })}
            </div>

            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('activity.empty')}</p>
            ) : (
              <div className="space-y-3">
                {activities.map((a) => (
                  <div key={a.id} className="flex gap-2">
                    <div className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <div className="space-y-0.5">
                      {/* 活动 actor（统一批 B）：actorName 已由后端注入（A2），去掉裸
                          UUID fallback；actorDeletedAt 非空 → 灰化（快照语义评论不动） */}
                      <p className="text-sm">
                        <span className={`font-medium ${a.actorDeletedAt ? 'opacity-60' : ''}`}>
                          {a.actorName}
                        </span>{' '}
                        {a.action === ActivityAction.CREATED && t('activity.action.created')}
                        {a.action === ActivityAction.UPDATED && t('activity.action.updated')}
                        {a.action === ActivityAction.MOVED && t('activity.action.moved')}
                        {a.action === ActivityAction.ASSIGNED && t('activity.action.assigned')}
                        {a.action === ActivityAction.COMMENTED && t('activity.action.commented')}
                        {a.action === ActivityAction.STATUS_CHANGED &&
                          t('activity.action.status_changed')}
                        {![
                          'created',
                          'updated',
                          'moved',
                          'assigned',
                          'commented',
                          'status_changed',
                        ].includes(a.action) && a.action}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelativeTime(a.createdAt, locale)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>

      {/* ── Footer（固定钉底，仅详情 Tab 显示保存/删除按钮） ── */}
      {activeTab === 'detail' && (
        <div className="shrink-0 flex items-center gap-2 pt-3 border-t border-border/50 mt-2">
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={async () => {
              if (deleteConfirmPendingRef.current || deleteMutation.isPending) return;
              deleteConfirmPendingRef.current = true;
              try {
                const ok = await confirm({
                  title: t('deleteTitle'),
                  description: t('delete.confirm'),
                  confirmText: tGlobal('common.confirm'),
                  cancelText: tGlobal('common.cancel'),
                  confirmVariant: 'danger',
                });
                if (!ok) return;
                deleteMutation.mutate();
              } finally {
                deleteConfirmPendingRef.current = false;
              }
            }}
            isLoading={deleteMutation.isPending}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            {tGlobal('common.delete')}
          </Button>
          <div className="flex-1" />
          <Button onClick={handleSave} isLoading={updateMutation.isPending}>
            {tGlobal('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
