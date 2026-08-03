'use client';

import { useState } from 'react';
import { Visibility } from '@agent-chamber/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Plus,
  FileText,
  ArrowRight,
  Trash2,
  Lock,
  Globe,
  MessageSquare,
  KanbanSquare,
} from 'lucide-react';

/** 新建空间的绑定对象类型 */
type BindType = 'none' | 'topic' | 'board';

export default function DocsPage() {
  const queryClient = useQueryClient();
  const t = useTranslations('docs');
  const tGlobal = useTranslations();

  // ── 新建空间表单状态（脏状态本地 useState，铁律 #4） ──
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>(Visibility.OPEN);
  const [bindType, setBindType] = useState<BindType>('none');
  const [bindTargetId, setBindTargetId] = useState('');
  const [deleteSpace, setDeleteSpace] = useState<{
    id: string;
    name: string;
    docCount: number;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['docs', 'spaces'],
    queryFn: () => Api.docs.listSpaces({ pageSize: 100 }),
  });

  /** 绑定对象候选：选了 topic/board 类型才拉对应列表 */
  const { data: topicsData } = useQuery({
    queryKey: ['topics', 'list'],
    queryFn: () => Api.topics.list({ pageSize: 100 }),
    enabled: createOpen && bindType === 'topic',
  });
  const { data: boardsData } = useQuery({
    queryKey: ['boards', 'list'],
    queryFn: () => Api.boards.list({ pageSize: 100 }),
    enabled: createOpen && bindType === 'board',
  });

  /** mutation 错误统一提示：优先透传服务端 message（范式照抄 task-detail-panel.tsx），兜底领域文案 */
  const alertMutationError = (fallback: string) => (err: unknown) => {
    const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
    alert(axiosErr?.response?.data?.message || axiosErr?.message || fallback);
  };

  const createMutation = useMutation({
    mutationFn: Api.docs.createSpace,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces'] });
      setCreateOpen(false);
      setNewName('');
      setNewDesc('');
      setNewVisibility(Visibility.OPEN);
      setBindType('none');
      setBindTargetId('');
    },
    onError: alertMutationError(t('form.createError')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => Api.docs.deleteSpace(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces'] });
      setDeleteSpace(null);
    },
    onError: alertMutationError(t('delete.error')),
  });

  /** 删除确认详情：打开 Dialog 时按 spaceId 拉详情拿 linkedTaskCount（B2：确认文案展示关联任务数） */
  const { data: deleteSpaceDetail, isLoading: deleteDetailLoading } = useQuery({
    queryKey: ['docs', 'space', deleteSpace?.id],
    queryFn: () => Api.docs.getSpace(deleteSpace!.id),
    enabled: !!deleteSpace,
  });

  const spaces = data?.items ?? [];

  const handleCreate = () => {
    if (!newName.trim()) return;
    createMutation.mutate({
      name: newName,
      description: newDesc || undefined,
      visibility: newVisibility,
      topicId: bindType === 'topic' && bindTargetId ? bindTargetId : undefined,
      boardId: bindType === 'board' && bindTargetId ? bindTargetId : undefined,
    });
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
      ) : spaces.length === 0 ? (
        <EmptyState
          title={t('noSpaces')}
          description={t('noSpacesDesc')}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('create')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {spaces.map((space) => (
            <Link key={space.id} href={`/docs/${space.id}`}>
              {/* 卡片语言照抄 boards 列表页：hoverGlow 青光描边微光 + tilt 3D 悬停倾斜（默认 max 6°） */}
              <Card hoverGlow tilt className="h-full cursor-pointer">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-lg flex items-center">
                      {space.name}
                      {space.visibility === 'private' && (
                        <Lock className="ml-2 h-4 w-4 text-amber-500" />
                      )}
                      {(space.visibility === 'open' || !space.visibility) && (
                        <Globe className="ml-2 h-4 w-4 text-emerald-500" />
                      )}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeleteSpace({
                            id: space.id,
                            name: space.name,
                            docCount: space.docCount ?? 0,
                          });
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                        <FileText className="h-4 w-4 text-primary" />
                      </div>
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {space.descriptionSnippet || t('noDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <FileText className="h-4 w-4" />
                      {t('docCount', { count: space.docCount ?? 0 })}
                    </span>
                    {/* 绑定归属 badge：topic / board / 独立 */}
                    {space.topicId ? (
                      <span className="flex items-center gap-1 text-xs">
                        <MessageSquare className="h-3.5 w-3.5" />
                        {t('boundTopic')}
                      </span>
                    ) : space.boardId ? (
                      <span className="flex items-center gap-1 text-xs">
                        <KanbanSquare className="h-3.5 w-3.5" />
                        {t('boundBoard')}
                      </span>
                    ) : (
                      <span className="text-xs">{t('unbound')}</span>
                    )}
                  </div>
                  <div className="mt-4 flex items-center justify-between text-sm">
                    <span className="flex items-center text-primary">
                      {t('viewSpace')} <ArrowRight className="ml-1 h-4 w-4" />
                    </span>
                    {space.updatedAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(space.updatedAt)}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* 新建空间 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogHeader>
          <DialogTitle>{t('form.createTitle')}</DialogTitle>
          <DialogDescription>{t('form.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.name')}</label>
            <Input
              placeholder={t('form.namePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.description')}</label>
            <Input
              placeholder={t('form.descPlaceholder')}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.visibility')}</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="docs-visibility"
                  value="open"
                  checked={newVisibility === Visibility.OPEN}
                  onChange={() => setNewVisibility(Visibility.OPEN)}
                />
                <Globe className="h-4 w-4 text-emerald-500" />
                <span className="text-sm">{t('visibility.publicDesc')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="docs-visibility"
                  value="private"
                  checked={newVisibility === Visibility.PRIVATE}
                  onChange={() => setNewVisibility(Visibility.PRIVATE)}
                />
                <Lock className="h-4 w-4 text-amber-500" />
                <span className="text-sm">{t('visibility.privateDesc')}</span>
              </label>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.bindTarget')}</label>
            {/* 绑定类型：无 | topic | board（原生 select 先例） */}
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={bindType}
              onChange={(e) => {
                setBindType(e.target.value as BindType);
                setBindTargetId('');
              }}
            >
              <option value="none">{t('form.bindNone')}</option>
              <option value="topic">{t('form.bindTopic')}</option>
              <option value="board">{t('form.bindBoard')}</option>
            </select>
            {bindType !== 'none' && (
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={bindTargetId}
                onChange={(e) => setBindTargetId(e.target.value)}
              >
                <option value="">{t('form.selectTarget')}</option>
                {/* 两路分开渲染：Topic 用 title、Board 用 name，规避联合类型窄化 */}
                {bindType === 'topic'
                  ? (topicsData?.items ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))
                  : (boardsData?.items ?? []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
              </select>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleCreate} isLoading={createMutation.isPending}>
            {tGlobal('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 删除空间 Dialog（提示引用文档计数 + 关联任务数；详情拉取中显示加载态） */}
      <Dialog open={!!deleteSpace} onOpenChange={() => setDeleteSpace(null)}>
        <DialogHeader>
          <DialogTitle>{t('delete.confirmTitle')}</DialogTitle>
          <DialogDescription>
            {deleteDetailLoading
              ? t('delete.loadingDetail')
              : t('delete.confirmDesc', {
                  count: deleteSpace?.docCount ?? 0,
                  linkedCount: deleteSpaceDetail?.linkedTaskCount ?? 0,
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteSpace(null)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteSpace && deleteMutation.mutate(deleteSpace.id)}
            isLoading={deleteMutation.isPending}
          >
            {tGlobal('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
