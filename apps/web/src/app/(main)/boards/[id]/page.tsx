'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Priority, TaskStatus, Visibility } from '@agent-chamber/shared';
import { UserRole, BoardMemberRole, AgentStatus, ActorType } from '@/types';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Api } from '@/lib/api';
import { isCreatorOrOwner } from '@/lib/is-resource-owner';
import { MARKDOWN_CLASSES } from '@/lib/markdown-classes';
import { confirm, toast } from '@/lib/notify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet } from '@/components/ui/sheet';
import { useAuthStore } from '@/stores/auth.store';
import { TaskDetailPanel } from '@/components/tasks/task-detail-panel';
import { MembersSheet } from '@/components/members/members-sheet';
import type { MemberItem, MembersSheetLabels } from '@/components/members/types';
import {
  ArrowLeft,
  Plus,
  GripVertical,
  Trash2,
  Lock,
  Globe,
  Pencil,
  Flag,
  Users,
  FileText,
  BookOpen,
  Settings,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  useDroppable,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { BoardListSummary, TaskSummary, TaskDetail, Agent, Milestone } from '@/types';
// 任务卡视觉映射与徽章行（统一批 B 抽取自本页：SortableTask/DragOverlay 共用，独立可测）
import { TaskCardBadges, statusLabelKeys, statusStyles } from '@/components/tasks/task-card-badges';
// 里程碑管理弹窗（前端债包批次 4 子项 2 commit 5 抽取自本页：useQuery/useMutation 逻辑随组件搬移）
import { MilestoneManageDialog } from '@/components/boards/milestone-manage-dialog';

/**
 * mutation 错误统一提示（范式照抄 docs/[id]/page.tsx alertMutationError）：
 * 优先透传服务端 error.response.data.message（4xx 业务原因），兜底 axios message / 领域文案。
 */
const alertMutationError = (fallback: string) => (err: unknown) => {
  const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
  alert(axiosErr?.response?.data?.message || axiosErr?.message || fallback);
};

// ──────────────────────────────────────────────
// 任务卡视觉映射（statusStyles/statusLabelKeys/priorityColors）与 TaskCardBadges
// 已抽取至 components/tasks/task-card-badges.tsx（统一批 B）——SortableTask 与
// DragOverlay 拖拽预览共用，防配色漂移；独立文件可脱离页面重依赖单独测试。
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// SortableTask — 可拖拽的任务卡片
// ──────────────────────────────────────────────
function SortableTask({
  task,
  listId,
  onSelect,
  hasBlockers,
}: {
  task: TaskSummary;
  listId: string;
  onSelect: (taskId: string) => void;
  hasBlockers?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', listId },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const statusStyle = statusStyles[task.status] || statusStyles.todo;
  const isDone = task.status === TaskStatus.DONE || task.status === TaskStatus.ARCHIVED;

  return (
    // 滚动区重复元素红线：半透实色底（bg-card/60），禁 backdrop-blur；
    // hover 微光 = 边框提亮 + 小号青光投影（shadow-glow-sm）
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-md border border-border/60 bg-card/60 p-3 shadow-sm cursor-pointer transition-shadow hover:border-primary/40 hover:shadow-glow-sm ${statusStyle.border}`}
      onClick={() => onSelect(task.id)}
    >
      <div className="flex items-start gap-2">
        <div
          {...attributes}
          {...listeners}
          className="mt-0.5 text-muted-foreground cursor-grab active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={`text-sm font-medium truncate ${isDone ? 'line-through text-muted-foreground' : ''}`}
          >
            {task.title}
          </p>
          <TaskCardBadges task={task} hasBlockers={hasBlockers} />
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// SortableBoardColumn — 可拖拽的看板列
// ──────────────────────────────────────────────
function SortableBoardColumn({
  list,
  boardId,
  tasks,
  onSelectTask,
  agents,
  allLists,
  blockersMap,
  onLoadMore,
  hasNext,
  onTaskCreated,
}: {
  list: BoardListSummary;
  boardId: string;
  tasks: TaskSummary[];
  onSelectTask: (taskId: string) => void;
  agents: { id: string; name: string; status: string }[];
  allLists: BoardListSummary[];
  blockersMap?: Record<string, boolean>;
  onLoadMore?: () => void;
  hasNext?: boolean;
  onTaskCreated?: () => void;
}) {
  const queryClient = useQueryClient();
  const t = useTranslations('boards');
  const tGlobal = useTranslations();
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<Priority>(Priority.P2);
  const [newTaskAssigneeId, setNewTaskAssigneeId] = useState('');
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editName, setEditName] = useState(list.name);
  const [editMappedStatus, setEditMappedStatus] = useState<TaskStatus | null>(
    list.mappedStatus as TaskStatus | null,
  );
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [targetListId, setTargetListId] = useState<string | null>(null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
    data: { type: 'column', listId: list.id },
  });

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `droppable-${list.id}`,
    data: { type: 'column-droppable', listId: list.id },
  });

  const columnStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const createTaskMutation = useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      priority: Priority;
      assigneeId?: string;
    }) => {
      const payload: Parameters<typeof Api.tasks.create>[0] = {
        boardId,
        listId: list.id,
        title: data.title,
        description: data.description,
        priority: data.priority,
      };
      if (data.assigneeId) {
        payload.assigneeId = data.assigneeId;
      }
      return Api.tasks.create(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', boardId] });
      onTaskCreated?.();
      setCreateTaskOpen(false);
      setNewTaskTitle('');
      setNewTaskDesc('');
      setNewTaskPriority(Priority.P2);
      setNewTaskAssigneeId('');
    },
  });

  const updateListMutation = useMutation({
    mutationFn: (data: { name: string; mappedStatus?: TaskStatus | null }) =>
      Api.boards.updateList(list.id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', boardId] });
      setEditDialogOpen(false);
    },
  });

  const deleteListMutation = useMutation({
    mutationFn: (moveTasksTo?: string) => Api.boards.deleteList(list.id, moveTasksTo),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', boardId] });
      setDeleteDialogOpen(false);
      setTargetListId(null);
    },
  });

  const handleCreateTask = () => {
    if (!newTaskTitle.trim()) return;
    createTaskMutation.mutate({
      title: newTaskTitle,
      description: newTaskDesc || undefined,
      priority: newTaskPriority,
      assigneeId: newTaskAssigneeId || undefined,
    });
  };

  const handleSave = () => {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditName(list.name);
      setEditMappedStatus((list.mappedStatus as TaskStatus) || null);
      return;
    }
    if (trimmed === list.name && editMappedStatus === list.mappedStatus) {
      setEditDialogOpen(false);
      return;
    }
    updateListMutation.mutate({ name: trimmed, mappedStatus: editMappedStatus });
  };

  const handleCancel = () => {
    setEditDialogOpen(false);
    setEditName(list.name);
    setEditMappedStatus((list.mappedStatus as TaskStatus) || null);
  };

  const handleDeleteList = async () => {
    const totalTasks = list.taskCount ?? tasks.length;
    if (totalTasks === 0) {
      // 空列直接删：全局确认弹框（v1.48.1 收尾，替代 window.confirm）
      if (
        !(await confirm({
          title: t('list.deleteConfirmSimple', { name: list.name }),
          confirmText: tGlobal('common.confirm'),
          cancelText: tGlobal('common.cancel'),
          confirmVariant: 'danger',
        }))
      )
        return;
      deleteListMutation.mutate(undefined);
      return;
    }

    // 列中有任务
    if (allLists.length === 0) {
      alert(t('list.cannotDelete', { count: totalTasks }));
      return;
    }

    // 有其他列可转移，打开选择对话框
    setTargetListId(allLists[0]?.id || null);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDeleteWithTransfer = () => {
    if (!targetListId) return;
    deleteListMutation.mutate(targetListId);
  };

  return (
    <div
      ref={setNodeRef}
      style={columnStyle}
      // 看板列：横向滚动区重复元素红线——半透实色底（bg-card/60），禁 backdrop-blur
      className={`flex min-w-[280px] max-w-[280px] flex-col rounded-lg border border-border/60 bg-card/60 p-3 h-full max-h-full overflow-hidden ${isOver ? 'ring-2 ring-primary' : ''}`}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground shrink-0"
          >
            <GripVertical className="h-4 w-4" />
          </div>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {/* 列名截断时 hover 显示全称：实色 popover 底（横向滚动区禁 blur），纯 CSS group-hover */}
            <span className="group relative min-w-0">
              <h3 className="text-sm font-semibold truncate">{list.name}</h3>
              <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden max-w-[240px] whitespace-normal break-all rounded-md border border-border/60 bg-popover px-2 py-1 text-xs font-normal text-popover-foreground shadow-lg group-hover:block">
                {list.name}
              </span>
            </span>
            {list.mappedStatus && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {tGlobal((statusLabelKeys[list.mappedStatus] || list.mappedStatus) as any)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => {
              setEditName(list.name);
              setEditMappedStatus((list.mappedStatus as TaskStatus) || null);
              setEditDialogOpen(true);
            }}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            title={t('list.edit')}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={handleDeleteList}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            title={t('list.delete')}
          >
            <Trash2 className="h-3 w-3" />
          </button>
          {/* 列头计数 badge：主光色青微发光点缀（工作区级克制） */}
          <Badge
            variant="outline"
            className="text-xs ml-1 border-primary/40 bg-primary/10 text-primary"
            title={t('list.taskCount')}
          >
            {list.taskCount ?? tasks.length}
          </Badge>
        </div>
      </div>

      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setDroppableRef}
          className="flex flex-col gap-2 flex-1 min-h-[100px] overflow-y-auto scroll-fade"
        >
          {tasks.map((task) => (
            <SortableTask
              key={task.id}
              task={task}
              listId={list.id}
              onSelect={onSelectTask}
              hasBlockers={blockersMap?.[task.id]}
            />
          ))}
        </div>
      </SortableContext>

      {hasNext && onLoadMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start text-muted-foreground"
          onClick={onLoadMore}
        >
          {t('list.loadMore')}
        </Button>
      )}

      <Button
        variant="ghost"
        size="sm"
        className="mt-2 w-full justify-start text-muted-foreground"
        onClick={() => setCreateTaskOpen(true)}
      >
        <Plus className="mr-2 h-4 w-4" />
        {t('list.addTask')}
      </Button>

      <Dialog open={createTaskOpen} onOpenChange={setCreateTaskOpen}>
        <DialogHeader>
          <DialogTitle>{t('list.createTask')}</DialogTitle>
          <DialogDescription>{t('list.createTaskDesc', { name: list.name })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{tGlobal('tasks.form.title')}</label>
            <Input
              placeholder={tGlobal('tasks.form.titlePlaceholder')}
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateTask();
              }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{tGlobal('tasks.form.description')}</label>
            <textarea
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder={tGlobal('tasks.form.descPlaceholder')}
              value={newTaskDesc}
              onChange={(e) => setNewTaskDesc(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{tGlobal('tasks.form.priority')}</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={newTaskPriority}
              onChange={(e) => setNewTaskPriority(e.target.value as Priority)}
            >
              <option value="p0">{tGlobal('tasks.priority.p0')}</option>
              <option value="p1">{tGlobal('tasks.priority.p1')}</option>
              <option value="p2">{tGlobal('tasks.priority.p2')}</option>
              <option value="p3">{tGlobal('tasks.priority.p3')}</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{tGlobal('tasks.form.assignee')}</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={newTaskAssigneeId}
              onChange={(e) => setNewTaskAssigneeId(e.target.value)}
            >
              <option value="">{tGlobal('tasks.form.unassigned')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateTaskOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleCreateTask} isLoading={createTaskMutation.isPending}>
            {tGlobal('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Edit List Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(v) => !v && handleCancel()}>
        <DialogHeader>
          <DialogTitle>{t('list.editTitle', { name: list.name })}</DialogTitle>
          <DialogDescription>{t('list.editDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('list.name')}</label>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
              }}
              placeholder={t('list.namePlaceholder')}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('list.statusBinding')}</label>
            <select
              value={editMappedStatus || ''}
              onChange={(e) =>
                setEditMappedStatus(e.target.value ? (e.target.value as TaskStatus) : null)
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="">{t('list.noBinding')}</option>
              <option value="backlog">{tGlobal('tasks.status.backlog')}</option>
              <option value="todo">{tGlobal('tasks.status.todo')}</option>
              <option value="in_progress">{tGlobal('tasks.status.in_progress')}</option>
              <option value="review">{tGlobal('tasks.status.review')}</option>
              <option value="done">{tGlobal('tasks.status.done')}</option>
              <option value="blocked">{tGlobal('tasks.status.blocked')}</option>
            </select>
            <p className="text-xs text-muted-foreground">{t('list.statusBindingHint')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleSave} isLoading={updateListMutation.isPending}>
            {tGlobal('common.save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete List Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogHeader>
          <DialogTitle>{t('list.deleteTitle', { name: list.name })}</DialogTitle>
          <DialogDescription>
            {t('list.deleteDesc', { count: list.taskCount ?? tasks.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-4">
          {allLists.map((l) => (
            <label
              key={l.id}
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                targetListId === l.id
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <input
                type="radio"
                name="targetList"
                value={l.id}
                checked={targetListId === l.id}
                onChange={() => setTargetListId(l.id)}
                className="h-4 w-4 text-primary"
              />
              <span className="text-sm font-medium">{l.name}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirmDeleteWithTransfer}
            isLoading={deleteListMutation.isPending}
            disabled={!targetListId}
          >
            {t('list.confirmDeleteAndTransfer')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ──────────────────────────────────────────────
// BoardDetailPage — 看板详情页
// ──────────────────────────────────────────────
export default function BoardDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuthStore();
  const t = useTranslations('boards');
  const tGlobal = useTranslations();

  const [createListOpen, setCreateListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [milestoneManageOpen, setMilestoneManageOpen] = useState(false);
  const [lists, setLists] = useState<BoardListSummary[]>([]);
  const [listTasks, setListTasks] = useState<Record<string, TaskSummary[]>>({});
  const [listPagination, setListPagination] = useState<
    Record<string, { page: number; hasNext: boolean }>
  >({});
  const [tasksLoading, setTasksLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const originalTaskListIdRef = useRef<string | null>(null);
  /** 抽屉内任务导航栈：点任务卡 setTaskStack([id])，点依赖链接压栈 */
  const [taskStack, setTaskStack] = useState<string[]>([]);
  /** 抽屉内面板是否有未保存修改（用于关闭 confirm 拦截） */
  const [isPanelDirty, setIsPanelDirty] = useState(false);
  const [blockersMap, setBlockersMap] = useState<Record<string, boolean>>({});
  const [milestoneFilter, setMilestoneFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [labelFilter, setLabelFilter] = useState<string>('');
  const [inviteSheetOpen, setInviteSheetOpen] = useState(false);
  /** Docs 徽章：无绑定空间时 creator/admin 可新建绑定空间 */
  const [docsDialogOpen, setDocsDialogOpen] = useState(false);
  const [docsSpaceName, setDocsSpaceName] = useState('');

  const { data: board, isLoading } = useQuery({
    queryKey: ['boards', 'detail', id],
    queryFn: () => Api.boards.getById(id),
    enabled: !!id,
  });

  /** 看板图例（description）只读查看模态框（v1.47.0-dev UX 统一）：编辑入口 = 设置 Dialog */
  const [descModalOpen, setDescModalOpen] = useState(false);

  /** 看板设置 Dialog（v1.47.0-dev UX 统一，对齐 DocSpace 空间设置）：name + description（图例）+ visibility（结构字段） */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    name: '',
    description: '',
    visibility: Visibility.PRIVATE,
  });

  /** 打开设置 Dialog 并预填当前值（canManage 内容字段；结构字段仅 creator/admin 可编辑） */
  const openSettings = useCallback(() => {
    if (!board) return;
    setSettingsForm({
      name: board.name,
      description: board.description ?? '',
      visibility: board.visibility === Visibility.OPEN ? Visibility.OPEN : Visibility.PRIVATE,
    });
    setSettingsOpen(true);
  }, [board]);

  /** 绑定本看板的文档空间（头部 Docs 徽章用） */
  const { data: boardSpacesData } = useQuery({
    queryKey: ['docs', 'spaces', 'board', id],
    queryFn: () => Api.docs.listSpaces({ boardId: id, pageSize: 10 }),
    enabled: !!id,
  });
  const linkedSpace = boardSpacesData?.items?.[0];

  const createSpaceMutation = useMutation({
    mutationFn: (name: string) => Api.docs.createSpace({ name, boardId: id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces', 'board', id] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces'] });
      setDocsDialogOpen(false);
      setDocsSpaceName('');
    },
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    // listAll 循环翻页拉全：单页 pageSize:100 在 >100 个 agent 时静默丢数据（评审 M-e）
    queryFn: () => Api.agents.listAll(),
  });

  /** v1.37 owner 代理：我的 agent id 集合（agent 创建的 board 视同我创建） */
  const myAgentIds = useMemo(() => (agentsData ?? []).map((a) => a.id), [agentsData]);

  /**
   * 管理权（v1.46 D9，对齐 docs/[id] canManage）：admin | creator（含 owner 代理）|
   * editor 成员（BoardMember 字段是 id/role，非 actorId——注意 board.members 投影形状）。
   * canManage 决定图例模态框的编辑能力（查看态人人可开，编辑态仅 canManage）。
   */
  const canManage =
    !!currentUser &&
    (currentUser.role === UserRole.ADMIN ||
      isCreatorOrOwner(board?.creatorId, currentUser.id, myAgentIds) ||
      board?.members?.some((m) => m.id === currentUser.id && m.role === BoardMemberRole.EDITOR));

  /**
   * 结构字段门控（v1.47.0-dev，对齐 DocSpace isOwnerLike）：admin | creator（含 owner 代理）——
   * editor 不包含（结构字段 creator-only，与 PATCH /boards 后端分权一致）。
   * canManage 管内容字段（name/description），isBoardOwnerLike 管结构字段（visibility）。
   */
  const isBoardOwnerLike = useMemo(
    () =>
      !!currentUser &&
      (currentUser.role === UserRole.ADMIN ||
        isCreatorOrOwner(board?.creatorId, currentUser.id, myAgentIds)),
    [currentUser, board?.creatorId, myAgentIds],
  );

  /** 设置保存 mutation（v1.47.0-dev）：name + description + visibility（仅 owner-like 发）一次提交；description 清空发 ''（UpdateBoardDto 无 MinLength，'' 合法） */
  const updateBoardSettingsMutation = useMutation({
    mutationFn: (payload: { name: string; description: string; visibility?: Visibility }) =>
      Api.boards.update(id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
      void queryClient.invalidateQueries({ queryKey: ['boards', 'list'] });
      setSettingsOpen(false);
    },
    onError: alertMutationError(t('legend.saveError')),
  });

  const activeAgents = (agentsData ?? []).filter((a) => a.status === AgentStatus.ACTIVE);

  const { data: milestonesData } = useQuery({
    queryKey: ['milestones', 'list', board?.id],
    queryFn: () => Api.tasks.getMilestones({ boardId: board!.id!, pageSize: 100 }),
    enabled: !!board?.id,
  });

  // 从 board detail 初始化 lists（board detail 不再携带 tasks）
  useEffect(() => {
    if (board?.lists && !activeId) {
      setLists(board.lists);
    }
  }, [board?.lists, activeId]);

  /**
   * 根据当前筛选器构造请求后端的 status 参数。
   * 空值表示使用后端默认值（todo + in_progress），对应 UI 的「活跃任务」。
   * 显式 'all' 才返回全部状态。
   */
  const resolveStatusParam = useCallback((): string | 'all' | undefined => {
    if (statusFilter === 'all') return 'all';
    if (statusFilter) return statusFilter;
    // 不传 status，后端默认只返回 todo / in_progress
    return undefined;
  }, [statusFilter]);

  // 并发加载每个 list 的 tasks；status 过滤必须传到后端，milestone 仍保留本地过滤
  useEffect(() => {
    if (!lists.length || !id) return;

    const status = resolveStatusParam();
    setTasksLoading(true);

    const loadTasks = async () => {
      const results = await Promise.all(
        lists.map((list) =>
          Api.boards
            .getListTasks(id, list.id, {
              status,
              pageSize: 100,
            })
            .catch(() => null),
        ),
      );

      const tasksMap: Record<string, TaskSummary[]> = {};
      const paginationMap: Record<string, { page: number; hasNext: boolean }> = {};

      lists.forEach((list, index) => {
        const result = results[index];
        if (result) {
          tasksMap[list.id] = result.items;
          paginationMap[list.id] = { page: result.page, hasNext: result.hasNext };
        } else {
          tasksMap[list.id] = [];
          paginationMap[list.id] = { page: 1, hasNext: false };
        }
      });

      setListTasks(tasksMap);
      setListPagination(paginationMap);
      setTasksLoading(false);
    };

    void loadTasks();
  }, [lists, id, statusFilter, resolveStatusParam]);

  /** 当前已加载任务中出现过的全部标签（去重排序，供标签筛选下拉） */
  const allLabels = useMemo(() => {
    const set = new Set<string>();
    for (const tasks of Object.values(listTasks)) {
      for (const t of tasks) {
        for (const label of t.labels ?? []) set.add(label);
      }
    }
    return Array.from(set).sort();
  }, [listTasks]);

  // 本地对 milestone / label 做过滤（status 已由后端过滤）
  const filteredTasks = useMemo(() => {
    const result: Record<string, TaskSummary[]> = {};
    for (const [listId, tasks] of Object.entries(listTasks)) {
      result[listId] = tasks.filter((t) => {
        const milestoneMatch = milestoneFilter
          ? milestoneFilter === 'none'
            ? !t.milestoneId
            : t.milestoneId === milestoneFilter
          : true;
        const labelMatch = labelFilter ? (t.labels ?? []).includes(labelFilter) : true;
        return milestoneMatch && labelMatch;
      });
    }
    return result;
  }, [listTasks, milestoneFilter, labelFilter]);

  // 用于拖拽的 working state：list 元数据 + 过滤后的 tasks
  const [workingLists, setWorkingLists] = useState<
    { list: BoardListSummary; tasks: TaskSummary[] }[]
  >([]);

  useEffect(() => {
    setWorkingLists(
      lists.map((list) => ({
        list,
        tasks: filteredTasks[list.id] || [],
      })),
    );
  }, [lists, filteredTasks]);

  // 批量查询所有任务的 blockers 状态
  useEffect(() => {
    const allTaskIds = Object.values(listTasks).flatMap((tasks) => tasks.map((t) => t.id));
    if (allTaskIds.length === 0) return;
    Api.tasks
      .getBatchBlockers(allTaskIds)
      .then(setBlockersMap)
      .catch(() => {});
  }, [listTasks]);

  /** 重新加载某一列的 tasks（mutation 成功后调用） */
  const refetchListTasks = useCallback(
    async (listId: string) => {
      const result = await Api.boards.getListTasks(id, listId, {
        status: resolveStatusParam(),
        pageSize: 100,
      });
      setListTasks((prev) => ({ ...prev, [listId]: result.items }));
      setListPagination((prev) => ({
        ...prev,
        [listId]: { page: result.page, hasNext: result.hasNext },
      }));
    },
    [id, resolveStatusParam],
  );

  /** 刷新全部可见列的 tasks（状态变更经 mappedStatus 联动可能换列，全列刷最稳） */
  const refetchAllLists = useCallback(() => {
    lists.forEach((list) => {
      void refetchListTasks(list.id);
    });
  }, [lists, refetchListTasks]);

  /** 加载更多任务 */
  const loadMoreTasks = useCallback(
    async (listId: string) => {
      const nextPage = (listPagination[listId]?.page || 1) + 1;
      const result = await Api.boards.getListTasks(id, listId, {
        status: resolveStatusParam(),
        page: nextPage,
        pageSize: 20,
      });
      setListTasks((prev) => ({
        ...prev,
        [listId]: [...(prev[listId] || []), ...result.items],
      }));
      setListPagination((prev) => ({
        ...prev,
        [listId]: { page: result.page, hasNext: result.hasNext },
      }));
    },
    [id, listPagination, resolveStatusParam],
  );

  const createListMutation = useMutation({
    mutationFn: (name: string) => Api.boards.createList(id, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
      setCreateListOpen(false);
      setNewListName('');
    },
  });

  /** 邀请 Agent 加入看板（R2 Promise 契约：页面层 allSettled 循环调用；
      选择集已移交 MembersSheet 内部管理，onSuccess 只负责刷新详情） */
  const inviteAgentMutation = useMutation({
    mutationFn: (agentId: string) => Api.boards.inviteAgent(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
    },
  });

  const uninviteAgentMutation = useMutation({
    mutationFn: (agentId: string) => Api.boards.uninviteAgent(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
    },
  });

  const addEditorMutation = useMutation({
    mutationFn: (agentId: string) => Api.boards.addEditor(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
    },
  });

  const removeEditorMutation = useMutation({
    mutationFn: (agentId: string) => Api.boards.removeEditor(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
    },
  });

  // ── MembersSheet 数据装配（批次 C2：内联成员 Sheet → 共享组件；页面层负责
  //    DTO → MemberItem 映射与权限 gate，组件纯受控不感知业务）──

  /** 成员管理权限闸（照抄旧内联 Sheet 各 section 的 gate：平台 admin ｜ 看板
   *  创建者/owner 代理——体验层闸，后端同样 403；与页面级 canManage（内容管理，
   *  含 editor 成员）区分，勿混用） */
  const canManageMembers =
    currentUser?.role === UserRole.ADMIN ||
    isCreatorOrOwner(board?.creatorId, currentUser?.id, myAgentIds);

  /** 活跃成员 → MemberItem（board.members 已按 DTO 投影：id/name/type/role；
   *  行级移除排除照抄旧 UI——所有行（含自己/创建者）都显示操作入口，不设
   *  canRemove（缺省跟随 capabilities.remove），创建者行由后端 409 守卫兜底
   *  （既存行为，重构不改行为）） */
  const memberItems = useMemo((): MemberItem[] => {
    if (!board) return [];
    return (board.members ?? []).map((m) => ({
      actorId: m.id,
      name: m.name,
      actorType: m.type,
      role: m.role,
      avatarUrl: m.avatarUrl ?? undefined,
      // 已删除信号透传（统一批 B）：软删 actor 带 deletedAt → member-row 灰化+badge
      deletedAt: m.deletedAt ?? null,
      status: 'active',
    }));
  }, [board]);

  /** 可邀请 agent 候选（照抄旧「添加邀请」checkbox 列表：全量 active agent 排除
   *  现有成员；board 无 invited 概念，无需兜底集合） */
  const candidateItems = useMemo((): MemberItem[] => {
    if (!board) return [];
    const memberIds = new Set((board.members ?? []).map((m) => m.id));
    return (agentsData ?? [])
      .filter((a: Agent) => a.status === AgentStatus.ACTIVE && !memberIds.has(a.id))
      .map((a) => ({
        actorId: a.id,
        name: a.name,
        actorType: 'agent',
        role: 'member',
        avatarUrl: a.avatarUrl ?? undefined,
        status: 'active',
      }));
  }, [board, agentsData]);

  /** member id → role 索引（移除分发按角色路由：editor → removeEditor /
   *  member → uninviteAgent，照抄旧 UI 行内判断） */
  const memberRoleById = useMemo(() => {
    const map = new Map<string, string>();
    (board?.members ?? []).forEach((m) => map.set(m.id, m.role));
    return map;
  }, [board]);

  /** 差异化文案：复用页面现有 boards.members.* key（title/角色/类别） */
  const memberLabels: MembersSheetLabels = {
    title: t('members.title'),
    roleLabels: {
      editor: t('members.editor'),
      member: t('members.member'),
    },
    typeLabels: {
      human: t('members.human'),
      agent: t('members.agent'),
    },
  };

  /** R2 邀请提交（Promise 契约）：mutateAsync 循环 + allSettled——全成功 resolve
   *  （组件切回主视图并清空选择）；任一失败 reject（组件留在邀请视图保留选择）+
   *  失败汇总 toast（成功 N / 失败 M）。board 无人类候选，kind 恒为 'agent'，
   *  非 agent 防御性短路（不 resolve 也不 reject） */
  const handleInvite = async (actorIds: string[], kind: 'agent' | 'human') => {
    if (kind !== ActorType.AGENT) return;
    const results = await Promise.allSettled(
      actorIds.map((actorId) => inviteAgentMutation.mutateAsync(actorId)),
    );
    // eslint-disable-next-line rulesdir/no-magic-string-compare -- PromiseSettledResult 内置状态（'fulfilled'|'rejected'），非圆桌权限请求状态
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed > 0) {
      toast.error({
        title: t('members.inviteFailed', { succeeded, failed }),
      });
      throw new Error(`invite agent partial failure: ${failed}/${results.length}`);
    }
  };

  /** 移除活跃成员（组件 AlertDialog 确认后回调）：照抄旧 UI 按角色分发——
   *  editor 行 → removeEditor（后端语义 = 完全移除）；member 行 → uninviteAgent */
  const handleRemoveMember = (actorId: string) => {
    if (memberRoleById.get(actorId) === BoardMemberRole.EDITOR) {
      removeEditorMutation.mutate(actorId);
    } else {
      uninviteAgentMutation.mutate(actorId);
    }
  };

  /** 升降级（主脑裁决 A）：board 仅单向升级 member → editor（addEditor）；
   *  editor → member 降级后端无 demote 端点（removeEditor = 完全移除非降级），
   *  故 changeRole 配置只含 fromRole='member' 一项，此回调只接 'editor' */
  const handleChangeRole = (actorId: string, newRole: string) => {
    if (newRole === BoardMemberRole.EDITOR) {
      addEditorMutation.mutate(actorId);
    }
  };

  const reorderListsMutation = useMutation({
    mutationFn: (lists: { id: string; position: number }[]) =>
      Api.boards.reorderLists(id, { lists }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
    },
  });

  const reorderTasksMutation = useMutation({
    mutationFn: ({
      listId,
      tasks,
    }: {
      listId: string;
      tasks: { id: string; position: number }[];
    }) => Api.boards.reorderTasks(listId, { tasks }),
    onSuccess: (_, { listId }) => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
      void refetchListTasks(listId);
    },
  });

  const moveTaskMutation = useMutation({
    mutationFn: ({
      taskId,
      listId,
      order,
    }: {
      taskId: string;
      listId: string;
      order: number;
      sourceListId?: string;
    }) => Api.tasks.move(taskId, { listId, order }),
    onSuccess: (_, { listId, sourceListId }) => {
      void queryClient.invalidateQueries({ queryKey: ['boards', 'detail', id] });
      void refetchListTasks(listId);
      if (sourceListId && sourceListId !== listId) {
        void refetchListTasks(sourceListId);
      }
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const activeIdValue = event.active.id as string;
    const activeType = event.active.data.current?.type as string;
    setActiveId(activeIdValue);

    // eslint-disable-next-line rulesdir/no-magic-string-compare -- dnd-kit 拖拽 data.type 标记（'task'|'column'），非 MessageType.TASK
    if (activeType === 'task') {
      const item = workingLists.find((item) => item.tasks.some((t) => t.id === activeIdValue));
      originalTaskListIdRef.current = item?.list.id || null;
    } else {
      originalTaskListIdRef.current = null;
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeIdValue = active.id as string;
    const overId = over.id as string;

    // eslint-disable-next-line rulesdir/no-magic-string-compare -- dnd-kit 拖拽 data.type 标记（'task'|'column'），非 MessageType.TASK
    if (active.data.current?.type !== 'task') return;
    if (activeIdValue === overId) return;

    const activeListId = active.data.current?.listId as string;
    const overListId = over.data.current?.listId as string;

    if (!activeListId || !overListId) return;

    setWorkingLists((prev) => {
      const newLists = prev.map((item) => ({
        ...item,
        tasks: [...item.tasks],
      }));

      const source = newLists.find((item) => item.list.id === activeListId);
      if (!source) return prev;

      const taskIndex = source.tasks.findIndex((t) => t.id === activeIdValue);
      if (taskIndex === -1) return prev;

      const [movedTask] = source.tasks.splice(taskIndex, 1);

      if (activeListId === overListId) {
        const overTaskIndex = source.tasks.findIndex((t) => t.id === overId);
        // overId 不是任务 id（可能是列本身）→ 放回原位
        if (overTaskIndex === -1) {
          source.tasks.splice(taskIndex, 0, movedTask);
          return newLists;
        }
        // 先把 removed task 放回去，再用 arrayMove 正确排序
        // 因为已经 splice 掉了 active，overTaskIndex 比原索引小了1（如果 over 在 active 之后）
        source.tasks.splice(taskIndex, 0, movedTask);
        const toIndex = overTaskIndex >= taskIndex ? overTaskIndex + 1 : overTaskIndex;
        const newTasks = arrayMove(source.tasks, taskIndex, toIndex);
        source.tasks.length = 0;
        source.tasks.push(...newTasks);
      } else {
        const target = newLists.find((item) => item.list.id === overListId);
        if (!target) {
          source.tasks.splice(taskIndex, 0, movedTask);
          return prev;
        }
        const overTaskIndex = target.tasks.findIndex((t) => t.id === overId);
        // 放到 over 的后面（overTaskIndex + 1），如果 over 不是任务则放到末尾
        const insertIndex = overTaskIndex !== -1 ? overTaskIndex + 1 : target.tasks.length;
        target.tasks.splice(insertIndex, 0, movedTask);
      }

      return newLists;
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over) {
      return;
    }

    const activeIdValue = active.id as string;
    const overId = over.id as string;
    const activeType = active.data.current?.type as string;

    if (activeType === 'column') {
      const oldIndex = workingLists.findIndex((item) => item.list.id === activeIdValue);
      const newIndex = workingLists.findIndex((item) => item.list.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newLists = arrayMove(workingLists, oldIndex, newIndex);
        setWorkingLists(newLists);
        setLists(newLists.map((item) => item.list));
        reorderListsMutation.mutate(newLists.map((item, i) => ({ id: item.list.id, position: i })));
      }
      // eslint-disable-next-line rulesdir/no-magic-string-compare -- dnd-kit 拖拽 data.type 标记（'task'|'column'），非 MessageType.TASK
    } else if (activeType === 'task') {
      const sourceListId = originalTaskListIdRef.current;
      const targetListId = over.data.current?.listId as string;

      if (!sourceListId || !targetListId) {
        return;
      }

      const targetItem = workingLists.find((item) => item.list.id === targetListId);
      if (!targetItem) {
        return;
      }

      const tasks = targetItem.tasks || [];
      const overTaskIndex = tasks.findIndex((t) => t.id === overId);
      const finalIndex =
        overTaskIndex !== -1 ? overTaskIndex : tasks.length > 0 ? tasks.length - 1 : 0;

      if (sourceListId === targetListId) {
        reorderTasksMutation.mutate({
          listId: targetListId,
          tasks: tasks.map((t, i) => ({ id: t.id, position: i })),
        });
      } else {
        moveTaskMutation.mutate({
          taskId: activeIdValue,
          listId: targetListId,
          order: finalIndex,
          sourceListId,
        });
      }
    } else {
    }
  };

  const handleCreateList = () => {
    if (!newListName.trim()) return;
    createListMutation.mutate(newListName);
  };

  // 拖拽预览派生（纯渲染层）：DragOverlay 只展示当前拖拽的任务卡，
  // 列拖拽时无匹配任务 → 不渲染预览；不参与任何数据流
  const activeTask = activeId
    ? workingLists.flatMap((item) => item.tasks).find((t) => t.id === activeId)
    : undefined;

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  if (!board) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">{t('notFound')}</h2>
        <Link href="/boards" className="mt-4 text-primary hover:underline">
          {t('backToList')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col">
      {/* 看板头部：移动端垂直堆叠，桌面端水平排列，防止操作按钮溢出视口 */}
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/boards" className="shrink-0">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold flex items-center min-w-0">
              <span className="truncate">{board.name}</span>
              {board.visibility === Visibility.PRIVATE && (
                <Badge
                  variant="outline"
                  className="ml-2 shrink-0 text-amber-300 border-amber-500/40 bg-amber-500/10"
                >
                  <Lock className="h-3 w-3 mr-1" /> {t('visibility.private')}
                </Badge>
              )}
              {board.visibility === Visibility.OPEN && (
                <Badge
                  variant="outline"
                  className="ml-2 shrink-0 text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
                >
                  <Globe className="h-3 w-3 mr-1" /> {t('visibility.public')}
                </Badge>
              )}
            </h1>
            {/*
              看板图例（description）收纳（v1.46 D9，用户拍板）：默认完全不渲染在标题下
              （可达 20000 字符的长 markdown 挤压视觉空间）；按钮点开统一模态框查看/编辑。
              canManage → 恒显示（空 description 也可点开新增）；非 canManage → 仅非空显示。
            */}
            {(canManage || board.description) && (
              <button
                type="button"
                onClick={() => setDescModalOpen(true)}
                className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-primary"
              >
                <BookOpen className="h-3.5 w-3.5" />
                {board.description ? t('legend.view') : t('legend.add')}
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 看板设置（v1.47.0-dev UX 统一，对齐 DocSpace 空间设置）：name/description/visibility */}
          {canManage && (
            <Button variant="outline" size="sm" onClick={openSettings}>
              <Settings className="mr-1 h-4 w-4" />
              {t('settings.title')}
            </Button>
          )}
          {/* Docs 徽章：有绑定空间 → 名称+docCount 点击直达；无 → creator/admin 显示新建小 Dialog */}
          {linkedSpace ? (
            <Link
              href={`/docs/${linkedSpace.id}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 text-sm text-primary transition-colors hover:bg-primary/20"
              title={linkedSpace.name}
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="max-w-[120px] truncate">{linkedSpace.name}</span>
              <span className="text-xs opacity-80">
                {t('docs.docCount', { count: linkedSpace.docCount ?? 0 })}
              </span>
            </Link>
          ) : (
            (currentUser?.role === UserRole.ADMIN ||
              isCreatorOrOwner(board.creatorId, currentUser?.id, myAgentIds)) && (
              <Button variant="outline" size="sm" onClick={() => setDocsDialogOpen(true)}>
                <FileText className="mr-1 h-4 w-4" />
                {t('docs.bind')}
              </Button>
            )
          )}
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm max-w-[140px] sm:max-w-none"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">{t('filter.activeTasks')}</option>
            <option value="backlog">{tGlobal('tasks.status.backlog')}</option>
            <option value="todo">{tGlobal('tasks.status.todo')}</option>
            <option value="in_progress">{tGlobal('tasks.status.in_progress')}</option>
            <option value="review">{tGlobal('tasks.status.review')}</option>
            <option value="done">{tGlobal('tasks.status.done')}</option>
            <option value="blocked">{tGlobal('tasks.status.blocked')}</option>
            <option value="all">{t('filter.allStatuses')}</option>
          </select>
          {board.id && (
            <>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm max-w-[140px] sm:max-w-none"
                value={milestoneFilter}
                onChange={(e) => setMilestoneFilter(e.target.value)}
              >
                <option value="">{t('filter.allMilestones')}</option>
                <option value="none">{t('filter.unassigned')}</option>
                {(milestonesData?.items ?? []).map((m: Milestone) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {allLabels.length > 0 && (
                <select
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm max-w-[140px] sm:max-w-none"
                  value={labelFilter}
                  onChange={(e) => setLabelFilter(e.target.value)}
                >
                  <option value="">{t('filter.allLabels')}</option>
                  {allLabels.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
              <Button variant="outline" size="sm" onClick={() => setMilestoneManageOpen(true)}>
                <Flag className="mr-1 h-4 w-4" />
                {t('milestone.button')}
              </Button>
            </>
          )}
          {(currentUser?.role === UserRole.ADMIN ||
            isCreatorOrOwner(board.creatorId, currentUser?.id, myAgentIds)) && (
            <Button variant="outline" size="sm" onClick={() => setInviteSheetOpen(true)}>
              <Users className="mr-1 h-4 w-4" />
              {(() => {
                const total = board.members?.length || 0;
                return total > 0 ? t('members.count', { count: total }) : t('members.permissions');
              })()}
            </Button>
          )}
          <Button size="sm" onClick={() => setCreateListOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            {t('list.addColumn')}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-x-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={workingLists.map((item) => item.list.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex h-full gap-4 pb-4">
              {workingLists.length > 0 ? (
                workingLists.map((item) => (
                  <SortableBoardColumn
                    key={item.list.id}
                    list={item.list}
                    boardId={id}
                    tasks={item.tasks}
                    onSelectTask={(taskId) => setTaskStack([taskId])}
                    agents={activeAgents}
                    allLists={lists.filter((l) => l.id !== item.list.id)}
                    blockersMap={blockersMap}
                    onLoadMore={() => loadMoreTasks(item.list.id)}
                    hasNext={listPagination[item.list.id]?.hasNext}
                    onTaskCreated={() => refetchListTasks(item.list.id)}
                  />
                ))
              ) : (
                <EmptyState title={t('list.noLists')} description={t('list.noListsDesc')} />
              )}
            </div>
          </SortableContext>
          {/* 拖拽中卡片预览：青色发光投影（shadow-glow-cyan）+ 主光色描边提亮。
              纯视觉层叠加，dnd-kit 拖拽/排序逻辑零改动；列拖拽时 activeTask 为空不渲染 */}
          <DragOverlay>
            {activeTask ? (
              <div
                className={`w-[280px] rounded-md border border-primary/50 bg-card p-3 shadow-glow-cyan ${(statusStyles[activeTask.status] || statusStyles.todo).border}`}
              >
                <div className="flex items-start gap-2">
                  <GripVertical className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm font-medium truncate ${activeTask.status === TaskStatus.DONE || activeTask.status === TaskStatus.ARCHIVED ? 'line-through text-muted-foreground' : ''}`}
                    >
                      {activeTask.title}
                    </p>
                    <TaskCardBadges task={activeTask} hasBlockers={blockersMap[activeTask.id]} />
                  </div>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* 任务详情右侧 Sheet 抽屉 */}
      <Sheet
        open={taskStack.length > 0}
        onOpenChange={async (open) => {
          if (!open) {
            if (isPanelDirty) {
              // 未保存守卫（v1.48.1 收尾）：全局确认弹框替代 window.confirm
              if (
                !(await confirm({
                  title: t('unsavedConfirm'),
                  confirmText: tGlobal('common.confirm'),
                  cancelText: tGlobal('common.cancel'),
                }))
              )
                return;
            }
            setTaskStack([]);
            setIsPanelDirty(false);
          }
        }}
        className="sm:max-w-2xl"
      >
        {taskStack.length > 0 && (
          <TaskDetailPanel
            key={taskStack[taskStack.length - 1]}
            taskId={taskStack[taskStack.length - 1]}
            onChanged={() => {
              void refetchAllLists();
            }}
            onDirtyChange={setIsPanelDirty}
            onNavigateTask={(tid) => setTaskStack((s) => [...s, tid])}
            onNavigateBack={() => setTaskStack((s) => s.slice(0, -1))}
            showBack={taskStack.length > 1}
            previousTaskTitle={
              taskStack.length > 1
                ? (() => {
                    const prevId = taskStack[taskStack.length - 2];
                    const cached = queryClient.getQueryData<TaskDetail>([
                      'tasks',
                      'detail',
                      prevId,
                    ]);
                    return cached?.title ?? tGlobal('tasks.previousTask');
                  })()
                : undefined
            }
          />
        )}
      </Sheet>

      {tasksLoading && (
        // 浮层提示属壳层元素：glass 玻璃化（允许 blur）
        <div className="glass fixed bottom-4 right-4 text-xs text-muted-foreground px-2 py-1 rounded-md">
          {t('loadingTasks')}
        </div>
      )}

      <Dialog open={createListOpen} onOpenChange={setCreateListOpen}>
        <DialogHeader>
          <DialogTitle>{t('list.addColumnTitle')}</DialogTitle>
          <DialogDescription>{t('list.addColumnDesc')}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Input
            placeholder={t('list.namePlaceholder')}
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateList();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateListOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleCreateList} isLoading={createListMutation.isPending}>
            {tGlobal('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 里程碑管理弹窗 */}
      {board.id && (
        <MilestoneManageDialog
          boardId={board.id}
          open={milestoneManageOpen}
          onClose={() => setMilestoneManageOpen(false)}
        />
      )}

      {/* 看板图例只读查看模态框（v1.47.0-dev UX 统一）：markdown 渲染；编辑入口 = 设置 Dialog */}
      <Dialog open={descModalOpen} onOpenChange={setDescModalOpen}>
        <DialogHeader>
          <DialogTitle>{t('legend.title')}</DialogTitle>
          <DialogDescription>{board.name}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <div className={`text-sm text-muted-foreground ${MARKDOWN_CLASSES}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{board.description ?? ''}</ReactMarkdown>
          </div>
        </div>
        <DialogFooter>
          {canManage ? (
            <Button
              variant="outline"
              onClick={() => {
                setDescModalOpen(false);
                openSettings();
              }}
            >
              {t('legend.edit')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setDescModalOpen(false)}>
              {tGlobal('common.close')}
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {/* 看板设置 Dialog（v1.47.0-dev UX 统一，对齐 DocSpace 空间设置）：name/description 内容字段 canManage 可改；visibility 结构字段仅 creator/admin */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('settings.name')}</label>
            <Input
              value={settingsForm.name}
              onChange={(e) => setSettingsForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('settings.namePlaceholder')}
              maxLength={100}
              className="h-9"
            />
          </div>
          {/* description（图例，长 markdown 可达 20000 字符：min-h≈240px，不用 docs 的 rows=3 小输入框） */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('settings.description')}</label>
            <textarea
              value={settingsForm.description}
              onChange={(e) =>
                setSettingsForm((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder={t('settings.descPlaceholder')}
              maxLength={20000}
              className="flex min-h-[240px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          {/* editor 提示（v1.47.0-dev 拆权）：结构字段（可见性）仅 creator 可改 */}
          {!isBoardOwnerLike && (
            <p className="text-xs text-muted-foreground">{t('settings.editorHint')}</p>
          )}
          {/* visibility（结构字段，creator-only——editor 隐藏，payload 也不发） */}
          {isBoardOwnerLike && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('settings.visibility')}</label>
              <div className="flex gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="board-visibility"
                    value={Visibility.OPEN}
                    checked={settingsForm.visibility === Visibility.OPEN}
                    onChange={() =>
                      setSettingsForm((prev) => ({ ...prev, visibility: Visibility.OPEN }))
                    }
                  />
                  {t('settings.visibilityPublic')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="board-visibility"
                    value={Visibility.PRIVATE}
                    checked={settingsForm.visibility === Visibility.PRIVATE}
                    onChange={() =>
                      setSettingsForm((prev) => ({ ...prev, visibility: Visibility.PRIVATE }))
                    }
                  />
                  {t('settings.visibilityPrivate')}
                </label>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSettingsOpen(false)}>
            {tGlobal('common.close')}
          </Button>
          <Button
            disabled={!settingsForm.name.trim()}
            isLoading={updateBoardSettingsMutation.isPending}
            onClick={() =>
              updateBoardSettingsMutation.mutate({
                name: settingsForm.name,
                description: settingsForm.description,
                // 结构字段仅 owner-like 发送（editor 不发 visibility，避免 403）
                ...(isBoardOwnerLike ? { visibility: settingsForm.visibility } : {}),
              })
            }
          >
            {tGlobal('common.save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 看板成员管理（批次 C2：内联成员 Sheet → 共享 MembersSheet——信息架构
          主视图 + 邀请二级视图；权限 gate 照抄旧各 section（平台 admin ｜ 看板
          创建者/owner 代理）；board 无 invited 区、无人类候选，不传
          invited/humanCandidates；升降级仅单向升级 member→editor（后端
          removeEditor = 完全移除非降级，主脑裁决 A）；行级 gate 照抄旧 UI——
          所有行显示操作（canRemove 不设），创建者行由后端 409 守卫兜底 */}
      <MembersSheet
        open={inviteSheetOpen}
        onOpenChange={setInviteSheetOpen}
        labels={memberLabels}
        members={memberItems}
        candidates={candidateItems}
        capabilities={{
          invite: canManageMembers,
          remove: canManageMembers,
          changeRole: canManageMembers
            ? [{ fromRole: 'member', toRole: 'editor', label: t('members.setEditor') }]
            : [],
        }}
        onInvite={handleInvite}
        onRemove={handleRemoveMember}
        onChangeRole={handleChangeRole}
        inviting={inviteAgentMutation.isPending}
      />

      {/* Docs 徽章：新建绑定本看板的文档空间 */}
      <Dialog open={docsDialogOpen} onOpenChange={setDocsDialogOpen}>
        <DialogHeader>
          <DialogTitle>{t('docs.createTitle')}</DialogTitle>
          <DialogDescription>{t('docs.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <Input
            placeholder={t('docs.namePlaceholder')}
            value={docsSpaceName}
            onChange={(e) => setDocsSpaceName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && docsSpaceName.trim()) {
                createSpaceMutation.mutate(docsSpaceName.trim());
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDocsDialogOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button
            onClick={() => docsSpaceName.trim() && createSpaceMutation.mutate(docsSpaceName.trim())}
            isLoading={createSpaceMutation.isPending}
            disabled={!docsSpaceName.trim()}
          >
            {tGlobal('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
