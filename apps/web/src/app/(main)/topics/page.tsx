'use client';

import { useState } from 'react';
import { Visibility, TopicKind, WakePolicy, ATTACHMENT_TTL_VALUES } from '@agent-chamber/shared';
import type { AttachmentTtl, Topic, TopicConfigInput } from '@agent-chamber/shared';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
import { topicStatusMap as statusMap } from '@/lib/status-visuals';
import { formatRelativeTime } from '@/lib/utils';
import {
  Plus,
  MessageSquare,
  Users,
  UsersRound,
  ArrowRight,
  Pencil,
  Trash2,
  Lock,
  Globe,
} from 'lucide-react';

/**
 * 附件有效期档位 → i18n 词条（表单下拉文案；值域单源 = shared
 * `ATTACHMENT_TTL_VALUES`，此处只做「值 → 词条」映射，禁止再抄一遍字面量清单）。
 */
const TTL_LABEL_KEYS: Record<AttachmentTtl, string> = {
  '1d': 'form.attachmentTtl1d',
  '7d': 'form.attachmentTtl7d',
  '30d': 'form.attachmentTtl30d',
  never: 'form.attachmentTtlNever',
};

/** 附件有效期缺省档（与后端 fail-closed 缺省 7d 对齐，plan §1.1） */
const TTL_DEFAULT: AttachmentTtl = '7d';

export default function TopicsPage() {
  const queryClient = useQueryClient();
  const t = useTranslations('topics');
  const locale = useLocale();
  const tGlobal = useTranslations();
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>(Visibility.OPEN);
  // 圆桌创建入口（v1.49.0）：kind 创建后不可变（后端 topic.service update 忽略 kind），
  // 仅创建表单提供选择；wakePolicy/maxRoundsWithoutHuman 落 topic.settings jsonb，
  // 缺省值由后端兜底（mention / 8），表单留空即不提交
  const [newKind, setNewKind] = useState<TopicKind>(TopicKind.NORMAL);
  const [newWakePolicy, setNewWakePolicy] = useState<WakePolicy>(WakePolicy.MENTION);
  const [newMaxRounds, setNewMaxRounds] = useState('');
  // 附件有效期（v1.90.0-dev 附件 TTL 批）：topic 级设置，写 settings.attachmentTtl，
  // 上传时冻结（只影响新上传，不追溯既有附件）；缺省 7d 与后端 fail-closed 一致
  const [newAttachmentTtl, setNewAttachmentTtl] = useState<AttachmentTtl>(TTL_DEFAULT);

  const [editTopic, setEditTopic] = useState<{
    id: string;
    title: string;
    description?: string;
    visibility?: Visibility;
    /** 附件有效期档位（编辑态初值 = 详情 settings.attachmentTtl，缺省回退 7d） */
    attachmentTtl: AttachmentTtl;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['topics', 'list'],
    queryFn: () => Api.topics.list({ pageSize: 100, status: 'all' }),
  });

  const createMutation = useMutation({
    mutationFn: Api.topics.create,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      setCreateOpen(false);
      setNewTitle('');
      setNewDesc('');
      setNewKind(TopicKind.NORMAL);
      setNewWakePolicy(WakePolicy.MENTION);
      setNewMaxRounds('');
      setNewAttachmentTtl(TTL_DEFAULT);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        title: string;
        description?: string;
        visibility?: Visibility;
        config?: TopicConfigInput;
      };
    }) => Api.topics.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      setEditTopic(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => Api.topics.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics'] });
      setDeleteId(null);
    },
  });

  const topics = data?.items ?? [];
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  const unreadResults = useQueries({
    queries: topics.map((topic) => ({
      queryKey: ['topics', 'unread', topic.id],
      queryFn: () => Api.topics.getUnread(topic.id),
      enabled: isAuthenticated,
    })),
  });

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    // config 现在两个用途都要：① 圆桌专属（kind/wakePolicy/maxRounds）；
    // ② 附件有效期（所有 topic 通用——普通话题也消费）。maxRoundsWithoutHuman
    // 留空 = 后端缺省 8，显式 0 = 关闭安全阀（shared DTO 契约）。
    const config: TopicConfigInput = { attachmentTtl: newAttachmentTtl };
    if (newKind === TopicKind.ROUNDTABLE) {
      config.kind = TopicKind.ROUNDTABLE;
      config.wakePolicy = newWakePolicy;
      if (newMaxRounds.trim()) config.maxRoundsWithoutHuman = Number(newMaxRounds);
    }
    createMutation.mutate({
      title: newTitle,
      description: newDesc,
      visibility: newVisibility,
      config,
    });
  };

  const handleUpdate = () => {
    if (!editTopic || !editTopic.title.trim()) return;
    updateMutation.mutate({
      id: editTopic.id,
      data: {
        title: editTopic.title,
        description: editTopic.description,
        visibility: editTopic.visibility,
        // 后端 update 把 config 并进 settings（kind 被忽略——创建后不可变），
        // 只带 attachmentTtl：不覆盖用户历史写入的其他 settings 键
        config: { attachmentTtl: editTopic.attachmentTtl },
      },
    });
  };

  const openEdit = async (topic: Topic) => {
    // 列表项只有 descriptionSnippet（截断值），编辑表单需完整描述，
    // 通过详情接口拉取避免数据截断风险（spec.md §7.4a）；settings 也只在详情
    // 响应里透出（列表刻意剔除）——附件有效期初值同源取自 detail.settings
    const detail = await Api.topics.getById(topic.id);
    setEditTopic({
      id: topic.id,
      title: topic.title,
      description: detail.description ?? undefined,
      visibility: topic.visibility,
      attachmentTtl: detail.settings?.attachmentTtl ?? TTL_DEFAULT,
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
      ) : topics.length === 0 ? (
        <EmptyState
          title={t('noTopics')}
          description={t('noTopicsDesc')}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('create')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {topics.map((topic, index) => {
            const status = statusMap[topic.status] || {
              labelKey: topic.status,
              variant: 'default' as const,
            };
            const unreadCount = unreadResults[index]?.data?.unreadCount ?? 0;
            return (
              <Link key={topic.id} href={`/topics/${topic.id}`}>
                {/* 工作区克制：hoverGlow 青光描边微光（同 Batch 4 任务卡手法）+ tilt 3D 悬停倾斜（默认 max 6°） */}
                <Card hoverGlow tilt className="h-full cursor-pointer">
                  <CardHeader className="pb-3">
                    {/* 标题行：flex-1 防止挤压右侧操作区 */}
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-lg flex items-center flex-1 min-w-0">
                        <span className="truncate">{topic.title}</span>
                        {topic.visibility === Visibility.PRIVATE && (
                          <Lock
                            className="ml-2 h-4 w-4 shrink-0 text-amber-500"
                            aria-label={t('visibility.privateAria')}
                          />
                        )}
                        {topic.visibility === Visibility.OPEN && (
                          <Globe
                            className="ml-2 h-4 w-4 shrink-0 text-emerald-500"
                            aria-label={t('visibility.publicAria')}
                          />
                        )}
                        {/* 圆桌标识 badge（v1.49.0）：紫色系与 visibility（琥珀/绿）、
                            status/unread badge 区分，不抢视觉优先级 */}
                        {topic.kind === TopicKind.ROUNDTABLE && (
                          <Badge
                            variant="outline"
                            className="ml-2 shrink-0 gap-1 border-violet-500/40 bg-violet-500/10 text-violet-300"
                          >
                            <UsersRound className="h-3 w-3" />
                            {t('kind.roundtable')}
                          </Badge>
                        )}
                        {unreadCount > 0 && (
                          <Badge variant="destructive" className="ml-2 shrink-0">
                            {unreadCount}
                          </Badge>
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void openEdit(topic);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDeleteId(topic.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                        <Badge variant={status.variant} className="shrink-0 whitespace-nowrap">
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {tGlobal(status.labelKey as any)}
                        </Badge>
                      </div>
                    </div>
                    <CardDescription className="line-clamp-2">
                      {topic.descriptionSnippet || t('noDescription')}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <div className="flex min-w-0 items-center gap-4">
                        <span className="flex items-center gap-1">
                          <Users className="h-4 w-4" />
                          {topic.participantCount ?? 0}
                        </span>
                        <span className="flex items-center gap-1">
                          <MessageSquare className="h-4 w-4" />
                          {topic.messageCount ?? 0}
                        </span>
                      </div>
                      <span className="shrink-0 whitespace-nowrap">
                        {formatRelativeTime(topic.lastMessageAt, locale)}
                      </span>
                    </div>
                    <div className="mt-4 flex items-center text-sm text-primary">
                      {t('viewDetail')} <ArrowRight className="ml-1 h-4 w-4" />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogHeader>
          <DialogTitle>{t('form.createTitle')}</DialogTitle>
          <DialogDescription>{t('form.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.title')}</label>
            <Input
              placeholder={t('form.titlePlaceholder')}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
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
                  name="visibility"
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
                  name="visibility"
                  value="private"
                  checked={newVisibility === Visibility.PRIVATE}
                  onChange={() => setNewVisibility(Visibility.PRIVATE)}
                />
                <Lock className="h-4 w-4 text-amber-500" />
                <span className="text-sm">{t('visibility.privateDesc')}</span>
              </label>
            </div>
          </div>
          {/* 话题类型（v1.49.0 圆桌 web 创建入口）：radio 模式与 visibility 同规；
              kind 创建后不可变（后端契约），选中圆桌时展开圆桌专属配置 */}
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="create-attachment-ttl">
              {t('form.attachmentTtl')}
            </label>
            <select
              id="create-attachment-ttl"
              data-testid="create-attachment-ttl"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={newAttachmentTtl}
              onChange={(e) => setNewAttachmentTtl(e.target.value as AttachmentTtl)}
            >
              {ATTACHMENT_TTL_VALUES.map((ttl) => (
                <option key={ttl} value={ttl}>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {t(TTL_LABEL_KEYS[ttl] as any)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('form.attachmentTtlHint')}</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.kind')}</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="kind"
                  value="normal"
                  checked={newKind === TopicKind.NORMAL}
                  onChange={() => setNewKind(TopicKind.NORMAL)}
                />
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{t('form.kindNormalDesc')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="kind"
                  value="roundtable"
                  checked={newKind === TopicKind.ROUNDTABLE}
                  onChange={() => setNewKind(TopicKind.ROUNDTABLE)}
                />
                <UsersRound className="h-4 w-4 text-violet-400" />
                <span className="text-sm">{t('form.kindRoundtableDesc')}</span>
              </label>
            </div>
          </div>
          {newKind === TopicKind.ROUNDTABLE && (
            <div className="space-y-4 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
              <p className="text-xs text-muted-foreground">{t('form.kindImmutableHint')}</p>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('form.wakePolicy')}</label>
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="wakePolicy"
                      value="mention"
                      checked={newWakePolicy === WakePolicy.MENTION}
                      onChange={() => setNewWakePolicy(WakePolicy.MENTION)}
                    />
                    <span className="text-sm">{t('form.wakeMention')}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="wakePolicy"
                      value="broadcast"
                      checked={newWakePolicy === WakePolicy.BROADCAST}
                      onChange={() => setNewWakePolicy(WakePolicy.BROADCAST)}
                    />
                    <span className="text-sm">{t('form.wakeBroadcast')}</span>
                  </label>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('form.maxRounds')}</label>
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  placeholder={t('form.maxRoundsPlaceholder')}
                  value={newMaxRounds}
                  onChange={(e) => setNewMaxRounds(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleCreate} isLoading={createMutation.isPending}>
            {t('create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTopic} onOpenChange={() => setEditTopic(null)}>
        <DialogHeader>
          <DialogTitle>{t('form.editTitle')}</DialogTitle>
          <DialogDescription>{t('form.editDesc')}</DialogDescription>
        </DialogHeader>
        {editTopic && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.title')}</label>
              <Input
                placeholder={t('form.titlePlaceholder')}
                value={editTopic.title}
                onChange={(e) => setEditTopic({ ...editTopic, title: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.description')}</label>
              <Input
                placeholder={t('form.descPlaceholder')}
                value={editTopic.description || ''}
                onChange={(e) => setEditTopic({ ...editTopic, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.visibility')}</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="edit-visibility"
                    value="open"
                    checked={editTopic.visibility === Visibility.OPEN}
                    onChange={() => setEditTopic({ ...editTopic, visibility: Visibility.OPEN })}
                  />
                  <Globe className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm">{t('visibility.public')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="edit-visibility"
                    value="private"
                    checked={editTopic.visibility === Visibility.PRIVATE}
                    onChange={() => setEditTopic({ ...editTopic, visibility: Visibility.PRIVATE })}
                  />
                  <Lock className="h-4 w-4 text-amber-500" />
                  <span className="text-sm">{t('visibility.private')}</span>
                </label>
              </div>
            </div>
            {/* 附件有效期（编辑态）：初值 = detail.settings.attachmentTtl；只影响新上传 */}
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="edit-attachment-ttl">
                {t('form.attachmentTtl')}
              </label>
              <select
                id="edit-attachment-ttl"
                data-testid="edit-attachment-ttl"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={editTopic.attachmentTtl}
                onChange={(e) =>
                  setEditTopic({ ...editTopic, attachmentTtl: e.target.value as AttachmentTtl })
                }
              >
                {ATTACHMENT_TTL_VALUES.map((ttl) => (
                  <option key={ttl} value={ttl}>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {t(TTL_LABEL_KEYS[ttl] as any)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t('form.attachmentTtlHint')}</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditTopic(null)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleUpdate} isLoading={updateMutation.isPending}>
            {tGlobal('common.save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>{t('delete.confirmTitle')}</DialogTitle>
          <DialogDescription>{t('delete.confirmDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteId(null)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            isLoading={deleteMutation.isPending}
          >
            {tGlobal('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
