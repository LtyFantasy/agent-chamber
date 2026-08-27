'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
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
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { UserRole } from '@/types';
import { Plus, Power, Trash2, KeyRound, Pencil, Eye } from 'lucide-react';
import type { Agent, AgentDeletionImpact } from '@/types';

const AGENT_STATUS_LABEL_KEY = {
  active: 'agents.status.active',
  pending: 'agents.status.pending',
  disabled: 'agents.status.disabled',
} as const;

export default function AgentsPage() {
  const t = useTranslations('agents');
  const tCommon = useTranslations('common');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tGlobal = useTranslations() as any;
  const queryClient = useQueryClient();
  // 仅 admin 需要查看 Agent 所有者列
  const currentUser = useAuthStore((state) => state.user);
  const isAdmin = currentUser?.role === UserRole.ADMIN;
  const [createOpen, setCreateOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  const [editAgent, setEditAgent] = useState<{
    id: string;
    name: string;
    description?: string;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [resetKeyId, setResetKeyId] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['agents', 'list'],
    // listAll 循环翻页拉全：单页 pageSize:100 在 >100 个 agent 时静默丢数据（评审 M-e 同类缺口 B6）；
    // 本页无分页 UI（全量渲染表格），必须拉全
    queryFn: () => Api.agents.listAll(),
  });

  const createMutation = useMutation({
    mutationFn: Api.agents.create,
    onSuccess: (data: Agent) => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setErrorMsg(null);
      // apiKey 仅在创建时返回一次，关闭创建表单后通过独立的 API Key 展示弹窗显示
      const key = data?.apiKey || (data as unknown as { data?: { apiKey?: string } })?.data?.apiKey;
      if (key) {
        handleCloseCreate();
        setNewApiKey(key);
      } else {
        // 兜底：万一 apiKey 没返回，给提示但不消失
        setErrorMsg(t('createSuccessNoKey'));
      }
    },
    onError: (err: unknown) => {
      setErrorMsg(
        (err as { response?: { data?: { message?: string } }; message?: string }).response?.data
          ?.message || t('createFailed'),
      );
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => Api.agents.toggle(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name: string; description?: string } }) =>
      Api.agents.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setEditAgent(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => Api.agents.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      setDeleteId(null);
    },
  });

  /** 删除影响面（统一批 B）：确认弹窗打开时拉取计数——提示是增强不是门禁：
   *  接口失败（isError）→ 回退现文案不阻塞删除；弹窗关闭时 enabled=false 停止查询 */
  const { data: deletionImpact, isError: deletionImpactFailed } = useQuery({
    queryKey: ['agents', 'deletion-impact', deleteId],
    queryFn: () => Api.agents.getDeletionImpact(deleteId as string),
    enabled: !!deleteId,
    staleTime: 30_000,
  });

  /** 删除影响面弹窗分支（统一批 B 四细则）：
   *  ① seatCount>0 → 追加「圆桌座位不会自动释放…」提示；
   *  ② openTaskCount>0 → 追加「未完成任务不会自动改派」提示；
   *  ③ 四项全 0 → 简化文案（不展示"0 条"冗余列表）；
   *  ④ 接口失败/加载中 → 回退现文案（提示是增强不是门禁） */
  const deletionImpactResolved = deletionImpact && !deletionImpactFailed ? deletionImpact : null;
  const hasAnyImpact =
    !!deletionImpactResolved &&
    deletionImpactResolved.seatCount +
      deletionImpactResolved.openTaskCount +
      deletionImpactResolved.messageCount +
      deletionImpactResolved.topicCount >
      0;

  const resetKeyMutation = useMutation({
    mutationFn: (id: string) => Api.agents.resetKey(id),
    onSuccess: (data) => {
      setNewApiKey(data.apiKey);
      setResetKeyId(null);
      // 重置后刷新列表，使新的 apiKeyPrefix 立即生效
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  // listAll 返回 Agent[]（非 PaginatedResponse）：直接取全量
  const agents = data ?? [];

  const handleCreate = () => {
    if (!newAgentName.trim()) return;
    createMutation.mutate({ name: newAgentName, description: newAgentDesc });
  };

  const handleUpdate = () => {
    if (!editAgent || !editAgent.name.trim()) return;
    updateMutation.mutate({
      id: editAgent.id,
      data: { name: editAgent.name, description: editAgent.description },
    });
  };

  const openEdit = async (agent: Agent) => {
    // 列表项只有 descriptionSnippet（截断值），编辑表单需完整描述，
    // 通过详情接口拉取避免数据截断风险（spec.md §7.4a）
    const detail = await Api.agents.getById(agent.id);
    setEditAgent({
      id: agent.id,
      name: agent.name,
      description: detail.description ?? undefined,
    });
  };

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setNewAgentName('');
    setNewAgentDesc('');
    setErrorMsg(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('create')}
        </Button>
      </div>

      {isLoading ? (
        <Loading />
      ) : agents.length === 0 ? (
        <EmptyState
          title={t('empty')}
          description={t('emptyDesc')}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('create')}
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-sm">
                <thead className="[&_tr]:border-b">
                  <tr className="border-b transition-colors hover:bg-muted/50">
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.name')}
                    </th>
                    {/* 介绍列：桌面专属（P1）——hover 在移动端不存在，移动端由名字下小字兜底，故 md 以下隐藏 */}
                    <th className="hidden h-12 px-4 text-left align-middle font-medium text-muted-foreground md:table-cell">
                      {t('table.description')}
                    </th>
                    {isAdmin && (
                      <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                        {t('table.owner')}
                      </th>
                    )}
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.status')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.apiKey')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.topicCount')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.messageCount')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.lastActive')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.createdAt')}
                    </th>
                    <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">
                      {tCommon('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {agents.map((agent) => (
                    <tr key={agent.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-4 align-middle">
                        <div className="flex items-center gap-3">
                          {/* 头像：actorType="agent" 带 Bot 角标，无头像时回落 seed 确定性底色（与 dashboard 排行榜一致） */}
                          <Avatar
                            src={agent.avatarUrl}
                            fallback={agent.name}
                            size="sm"
                            actorType="agent"
                            seed={agent.id}
                          />
                          <div>
                            <div className="font-medium">{agent.name}</div>
                            {/* 移动端兜底小字（P1）：桌面由介绍列接管，md 以下才显示 */}
                            <div className="text-xs text-muted-foreground md:hidden">
                              {agent.descriptionSnippet}
                            </div>
                          </div>
                        </div>
                      </td>
                      {/* 介绍列单元格：桌面专属，snippet truncate + hover popover 懒加载完整介绍 */}
                      <td className="hidden p-4 align-middle md:table-cell">
                        <AgentDescriptionCell agent={agent} />
                      </td>
                      {isAdmin && <td className="p-4 align-middle">{agent.ownerName ?? '-'}</td>}
                      <td className="p-4 align-middle">
                        <Badge variant={agent.status === 'active' ? 'success' : 'secondary'}>
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {tGlobal(
                            AGENT_STATUS_LABEL_KEY[
                              agent.status as keyof typeof AGENT_STATUS_LABEL_KEY
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            ] ?? ('agents.status.disabled' as any),
                          )}
                        </Badge>
                      </td>
                      <td className="p-4 align-middle">
                        {agent.apiKeyPrefix ? (
                          <div className="flex items-center gap-2">
                            <code className="rounded bg-muted px-2 py-1 text-xs">
                              {agent.apiKeyPrefix}****
                            </code>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => setResetKeyId(agent.id)}
                              title={t('viewFullKey')}
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-4 align-middle">{agent.topicCount ?? 0}</td>
                      <td className="p-4 align-middle">{agent.messageCount ?? 0}</td>
                      <td className="p-4 align-middle text-muted-foreground">
                        {formatRelativeTime(agent.lastActiveAt)}
                      </td>
                      <td className="p-4 align-middle text-muted-foreground">
                        {formatDate(agent.createdAt)}
                      </td>
                      <td className="p-4 align-middle">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => void openEdit(agent)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleMutation.mutate(agent.id)}
                            isLoading={toggleMutation.isPending}
                          >
                            <Power className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setResetKeyId(agent.id)}>
                            <KeyRound className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`delete-agent-${agent.id}`}
                            onClick={() => setDeleteId(agent.id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) handleCloseCreate();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('form.createTitle')}</DialogTitle>
          <DialogDescription>{t('form.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.name')}</label>
            <Input
              placeholder={t('form.namePlaceholder')}
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.description')}</label>
            <Input
              placeholder={t('form.descPlaceholder')}
              value={newAgentDesc}
              onChange={(e) => setNewAgentDesc(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          {errorMsg && <p className="text-sm text-destructive mr-auto">{errorMsg}</p>}
          <Button variant="outline" onClick={handleCloseCreate}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleCreate} isLoading={createMutation.isPending}>
            {tCommon('create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editAgent} onOpenChange={() => setEditAgent(null)}>
        <DialogHeader>
          <DialogTitle>{t('form.editTitle')}</DialogTitle>
          <DialogDescription>{t('form.editDesc')}</DialogDescription>
        </DialogHeader>
        {editAgent && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.name')}</label>
              <Input
                placeholder={t('form.namePlaceholder')}
                value={editAgent.name}
                onChange={(e) => setEditAgent({ ...editAgent, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.description')}</label>
              <Input
                placeholder={t('form.descPlaceholder')}
                value={editAgent.description || ''}
                onChange={(e) => setEditAgent({ ...editAgent, description: e.target.value })}
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditAgent(null)}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleUpdate} isLoading={updateMutation.isPending}>
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>{t('delete.title')}</DialogTitle>
          {/* 删除影响面（统一批 B）：非全 0 保持原文案 + 下方追加提示列表；全 0 简化
              文案；接口失败/加载中回退原文案（提示是增强不是门禁） */}
          <DialogDescription>
            {deletionImpactResolved && !hasAnyImpact
              ? t('delete.noImpact')
              : t('delete.description')}
          </DialogDescription>
        </DialogHeader>
        {deletionImpactResolved && hasAnyImpact && (
          <ul className="-mt-1 list-disc space-y-1 px-6 text-sm text-muted-foreground">
            {deletionImpactResolved.seatCount > 0 && <li>{t('delete.impactSeat')}</li>}
            {deletionImpactResolved.openTaskCount > 0 && <li>{t('delete.impactTasks')}</li>}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteId(null)}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            isLoading={deleteMutation.isPending}
          >
            {tCommon('delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Reset Key Dialog */}
      <Dialog open={!!resetKeyId} onOpenChange={() => setResetKeyId(null)}>
        <DialogHeader>
          <DialogTitle>{t('resetKey.title')}</DialogTitle>
          <DialogDescription>{t('resetKey.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setResetKeyId(null)}>
            {tCommon('cancel')}
          </Button>
          <Button
            onClick={() => resetKeyId && resetKeyMutation.mutate(resetKeyId)}
            isLoading={resetKeyMutation.isPending}
          >
            {t('resetKey.confirm')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Show New API Key */}
      <Dialog open={!!newApiKey} onOpenChange={() => setNewApiKey(null)}>
        <DialogHeader>
          <DialogTitle>{t('newKey.title')}</DialogTitle>
          <DialogDescription>{t('newKey.description')}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <code className="block rounded bg-muted p-3 text-sm break-all">{newApiKey}</code>
        </div>
        <DialogFooter>
          <Button onClick={() => setNewApiKey(null)}>{t('newKey.saved')}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

/**
 * 介绍列单元格（R1：表格行是 map 渲染，hooks 禁止写在 map 回调里，故提取为子组件）。
 *
 * 交互设计：
 * - 常态：descriptionSnippet truncate（无 snippet 显 `-`）；
 * - hover：懒加载完整 description（`['agents','detail',id]` 与详情页共享缓存），
 *   加载完成前用 snippet 兜底；完整 description 为空时同样兜底 snippet/`-`
 * - popover 纯 CSS group-hover（抄 boards 列名范式，实色 bg-popover 底）；
 *   有意不用 pointer-events-none——R5 要求 overflow-y-auto 可滚动，必须允许鼠标进入 popover
 *   （pointer-events-none 下滚动事件穿透，超长介绍无法看完）
 */
function AgentDescriptionCell({ agent }: { agent: Agent }) {
  const [hovered, setHovered] = useState(false);
  const { data: detail } = useQuery({
    queryKey: ['agents', 'detail', agent.id],
    queryFn: () => Api.agents.getById(agent.id),
    // 仅 hover 时触发请求（懒加载）；5 分钟缓存：重复 hover 不重复请求
    enabled: hovered,
    staleTime: 5 * 60 * 1000,
  });
  // hover 且完整 description 已加载 → 用全文替换展示；未加载/为空 → snippet/`-` 兜底
  const displayText = (hovered ? detail?.description : null) || agent.descriptionSnippet || '-';

  return (
    <span
      className="group relative inline-block max-w-[220px] align-middle"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="block truncate">{agent.descriptionSnippet || '-'}</span>
      {/* popover 紧贴 trigger 顶部（top-full 无 gap）：鼠标移入时可滚动/选中文本而不触发 mouseleave 闪断 */}
      <span className="absolute left-0 top-full z-50 hidden max-w-[320px] max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-popover px-2 pt-2 pb-1 text-xs font-normal text-popover-foreground shadow-lg group-hover:block">
        {displayText}
      </span>
    </span>
  );
}
