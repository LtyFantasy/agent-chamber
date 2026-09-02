'use client';

/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 看板里程碑管理弹窗（MilestoneManageDialog）：里程碑 CRUD + Release 版本管理
 *
 * [代码职责]
 *   - 里程碑列表查询（pageSize:100 全量）+ create/update/delete mutation + invalidate
 *   - 后端状态机（B1）前端镜像：version 非空 → 仅 release 状态组（dev/ready/verified/cancelled）；
 *     deployed 只能经 POST /tasks/milestones/:id/deployed 端点写入，PATCH status=deployed 后端 400
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md — 里程碑端点与状态机（B1）
 *   - 补充: docs/frontend-architecture.md — 看板详情页 UI 结构
 *
 * [关键不变量]
 *   - version 非空时 status 必须落在 release 组（创建态自动切 dev；编辑态 version 只读）
 *   - 编辑 deployed 里程碑时提交不传 status（PATCH 保留原值）
 *   - body 不回填（列表投影只返回 bodySnippet 截断），提交留空 = 不传（PATCH 保留原值）
 *
 * [关联代码]
 *   - app/(main)/boards/[id]/page.tsx — 调用点（boardId/open/onClose 三 props）
 *   - lib/status-visuals.ts — milestoneStatusColors/milestoneStatusLabelKeys 视觉映射
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { X, Pencil, Trash2 } from 'lucide-react';
import { Api } from '@/lib/api';
import { confirm } from '@/lib/notify';
import { milestoneStatusLabelKeys, milestoneStatusColors } from '@/lib/status-visuals';
import type { Milestone } from '@/types';
import { MilestoneStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface MilestoneManageDialogProps {
  /** 看板 UUID（里程碑查询 + invalidate 键） */
  boardId: string;
  /** 弹窗开关（父组件持有） */
  open: boolean;
  /** 关闭回调（父组件 setState） */
  onClose: () => void;
}

/**
 * 看板里程碑管理弹窗（v1.42 B6 起）：创建/编辑/删除里程碑，Release 版本管理。
 * 自 boards/[id]/page.tsx 抽取（前端债包批次 4 子项 2 commit 5）——useQuery/useMutation
 * 逻辑随组件整体搬移，captured 依赖全部自持（queryClient/t/tGlobal/useState/useQuery/
 * useMutation/useEffect），无闭包泄漏；页面只留 boardId/open/onClose 三 props 调用。
 */
function MilestoneManageDialog({ boardId, open, onClose }: MilestoneManageDialogProps) {
  const queryClient = useQueryClient();
  const t = useTranslations('boards');
  const tGlobal = useTranslations();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    status: 'planned',
    startDate: '',
    targetDate: '',
    // Release 字段（v1.42 B6）：version 创建时可填、编辑只读（release 身份标识，避免唯一索引冲突 UX 复杂化）；body 任何时候可编辑
    version: '',
    body: '',
  });

  const { data: milestonesData } = useQuery({
    queryKey: ['milestones', 'list', boardId],
    queryFn: () => Api.tasks.getMilestones({ boardId, pageSize: 100 }),
    enabled: !!boardId,
  });

  // 正在编辑的里程碑对象（deployed 状态：select 禁用占位 + 提交保态用）
  const editingMilestone = (milestonesData?.items ?? []).find((m: Milestone) => m.id === editingId);

  /**
   * 后端状态机（B1）：version 非空 → 禁普通态（planned/active/completed）；version 空 → 禁 release 态。
   * 创建态填了 version 后自动把不在 release 组的 status 切到 dev（后端 create 缺省 dev 同语义）；
   * 编辑态 version 只读不会变，状态由后端约束，前端不干预。
   */
  useEffect(() => {
    if (editingId) return;
    const releaseStatuses = ['dev', 'ready', 'verified', 'cancelled'];
    if (form.version.trim() && !releaseStatuses.includes(form.status)) {
      setForm((f) => ({ ...f, status: 'dev' }));
    }
  }, [form.version, form.status, editingId]);

  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof Api.tasks.createMilestone>[0]) =>
      Api.tasks.createMilestone(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['milestones', 'list', boardId] });
      setForm({
        name: '',
        description: '',
        status: 'planned',
        startDate: '',
        targetDate: '',
        version: '',
        body: '',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof Api.tasks.updateMilestone>[1];
    }) => Api.tasks.updateMilestone(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['milestones', 'list', boardId] });
      setEditingId(null);
      setForm({
        name: '',
        description: '',
        status: 'planned',
        startDate: '',
        targetDate: '',
        version: '',
        body: '',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => Api.tasks.deleteMilestone(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['milestones', 'list', boardId] });
    },
  });

  const handleSubmit = () => {
    if (!form.name.trim()) return;
    const payload = {
      name: form.name,
      description: form.description || undefined,
      boardId,
      // deployed 只能经 POST /tasks/milestones/:id/deployed 端点写入（PATCH status=deployed 后端 400）；
      // 编辑 deployed 里程碑时保持原状态（不传 status，PATCH 保留原值）
      status: editingMilestone?.status === MilestoneStatus.DEPLOYED ? undefined : form.status,
      startDate: form.startDate || undefined,
      targetDate: form.targetDate || undefined,
      // version 仅创建时可填（编辑只读展示，不允许改挂/改 version——部分唯一索引冲突 UX 复杂化）
      ...(!editingId && form.version.trim() ? { version: form.version.trim() } : {}),
      ...(form.body.trim() ? { body: form.body.trim() } : {}),
    };
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const startEdit = (m: Milestone) => {
    setEditingId(m.id);
    setForm({
      name: m.name || '',
      description: m.description || '',
      status: m.status || 'planned',
      startDate: m.startDate ? String(m.startDate).slice(0, 10) : '',
      targetDate: m.targetDate ? String(m.targetDate).slice(0, 10) : '',
      version: m.version ?? '',
      // body 不回填：列表投影只返回 bodySnippet（300 字符截断），回填会覆盖截断原正文；
      // 提交时 body 留空 = 不传（PATCH 保留原值），安全
      body: '',
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogHeader>
        <DialogTitle>{t('milestone.title')}</DialogTitle>
        <DialogDescription>{t('milestone.description')}</DialogDescription>
      </DialogHeader>
      <div className="py-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {/* 表单 */}
        <div className="space-y-3 rounded-lg border p-3">
          <Input
            placeholder={t('milestone.namePlaceholder')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            placeholder={t('milestone.descPlaceholder')}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="flex gap-2">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm flex-1"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {form.version.trim() !== '' ? (
                /* Release 里程碑（version 非空）：release 状态组——deployed 不出现在选项（端点专属，
                   PATCH 会被后端 400 MILESTONE_DEPLOY_VIA_ENDPOINT）；当前 status=deployed 时以 disabled
                   占位展示（不可选，编辑保存时保态不传 status） */
                <>
                  <option value="dev">{t('milestone.status.dev')}</option>
                  <option value="ready">{t('milestone.status.ready')}</option>
                  <option value="verified">{t('milestone.status.verified')}</option>
                  <option value="cancelled">{t('milestone.status.cancelled')}</option>
                  {editingMilestone?.status === MilestoneStatus.DEPLOYED && (
                    <option value="deployed" disabled>
                      {t('milestone.status.deployed')}
                    </option>
                  )}
                </>
              ) : (
                /* 普通里程碑（version 空）：普通四态，行为零变更 */
                <>
                  <option value="planned">{t('milestone.status.planned')}</option>
                  <option value="active">{t('milestone.status.active')}</option>
                  <option value="completed">{t('milestone.status.completed')}</option>
                  <option value="cancelled">{t('milestone.status.cancelled')}</option>
                </>
              )}
            </select>
            <Input
              type="date"
              placeholder={t('milestone.startDate')}
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              className="flex-1"
            />
            <Input
              type="date"
              placeholder={t('milestone.targetDate')}
              value={form.targetDate}
              onChange={(e) => setForm({ ...form, targetDate: e.target.value })}
              className="flex-1"
            />
          </div>
          <Input
            placeholder={t('milestone.versionPlaceholder')}
            value={form.version}
            disabled={!!editingId}
            title={editingId ? t('milestone.versionReadonlyHint') : undefined}
            onChange={(e) => setForm({ ...form, version: e.target.value })}
          />
          <textarea
            placeholder={t('milestone.bodyPlaceholder')}
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                setEditingId(null);
                setForm({
                  name: '',
                  description: '',
                  status: 'planned',
                  startDate: '',
                  targetDate: '',
                  version: '',
                  body: '',
                });
              }}
            >
              <X className="mr-1 h-3 w-3" />
              {t('milestone.reset')}
            </Button>
            <Button
              size="sm"
              className="flex-1"
              onClick={handleSubmit}
              isLoading={createMutation.isPending || updateMutation.isPending}
              disabled={!form.name.trim()}
            >
              {editingId ? t('milestone.saveChanges') : t('milestone.create')}
            </Button>
          </div>
        </div>

        {/* 列表 */}
        <div className="space-y-2">
          {(milestonesData?.items ?? []).length === 0 && (
            <EmptyState
              title={t('milestone.noMilestones')}
              description={t('milestone.noMilestonesDesc')}
            />
          )}
          {(milestonesData?.items ?? []).map((m: Milestone) => (
            <div
              key={m.id}
              className={`flex items-center justify-between rounded-md border p-2 ${editingId === m.id ? 'ring-2 ring-primary bg-primary/5' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{m.name}</span>
                  {m.version && (
                    <Badge
                      variant="outline"
                      className="shrink-0 text-xs font-mono text-primary border-primary/40 bg-primary/10"
                      title={m.version}
                    >
                      v{m.version.replace(/^v/i, '')}
                    </Badge>
                  )}
                  <Badge
                    variant="secondary"
                    className={`text-xs ${milestoneStatusColors[m.status] || ''}`}
                  >
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {tGlobal((milestoneStatusLabelKeys[m.status] || m.status) as any)}
                  </Badge>
                </div>
                {m.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{m.description}</p>
                )}
                {(m.startDate || m.targetDate) && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {m.startDate ? String(m.startDate).slice(0, 10) : ''}
                    {m.startDate && m.targetDate ? ' → ' : ''}
                    {m.targetDate ? String(m.targetDate).slice(0, 10) : ''}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={() => startEdit(m)}
                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={tGlobal('common.edit')}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  onClick={async () => {
                    // 删除里程碑（破坏性，danger 确认弹框，v1.48.1 收尾）
                    if (
                      await confirm({
                        title: t('milestone.deleteConfirm', { name: m.name }),
                        confirmText: tGlobal('common.confirm'),
                        cancelText: tGlobal('common.cancel'),
                        confirmVariant: 'danger',
                      })
                    ) {
                      deleteMutation.mutate(m.id);
                    }
                  }}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title={tGlobal('common.delete')}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {tGlobal('common.close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export { MilestoneManageDialog };
