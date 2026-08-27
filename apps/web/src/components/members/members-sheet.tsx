'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Search, UserPlus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { InvitePanel } from './invite-panel';
import { MemberRow } from './member-row';
import type { MemberItem, MembersSheetProps } from './types';

/** 主视图搜索框阈值（P2）：活跃成员 ≥8 才渲染搜索（仅计活跃成员，invited 不计入） */
const MAIN_SEARCH_THRESHOLD = 8;

/**
 * MembersSheet — topic / board / docs 三处成员管理统一组件（批次 B）。
 *
 * 信息架构：主视图（浏览/搜索/管理，默认）+ 邀请二级视图（任务型，按需进入）；
 * 三段式布局（R4）：SheetContent 内 flex flex-col h-full，滚动区 flex-1 overflow-y-auto，
 * footer shrink-0 border-t——主操作（邀请成员 / 确认邀请）永远可达，根治移动端沉底。
 *
 * 组件纯受控：不发自家请求；视图状态机 / 选择集 / 搜索词是内部 state，其余数据全走 props。
 * 视图重置（R4）：Sheet 关闭（onOpenChange(false)）→ 回主视图 + 清空选择，再打开永远是主视图。
 * 邀请提交（R2）：await onInvite —— 全成功 → 切回主视图 + 清空选择；任一失败 → 留在
 * 邀请视图保留选择（失败汇总 toast 由页面层负责，组件不管错误展示）。
 */
export function MembersSheet({
  open,
  onOpenChange,
  labels,
  members,
  invited,
  candidates,
  humanCandidates,
  capabilities,
  onInvite,
  onRemove,
  onChangeRole,
  onTransferCreator,
  onCancelInvite,
  renderRowExtra,
  topSlot,
  inviting,
}: MembersSheetProps) {
  const t = useTranslations('members');
  /** 视图状态机：main ↔ invite（Sheet 内内容替换，不换容器、不做路由/动画——KISS） */
  const [view, setView] = useState<'main' | 'invite'>('main');
  /** 邀请选择集（actorId；invite 视图 footer 计数与提交依据） */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 主视图搜索词（仅活跃成员 ≥8 时才有输入框） */
  const [mainQuery, setMainQuery] = useState('');
  /** 已邀请区折叠态（默认展开） */
  const [invitedOpen, setInvitedOpen] = useState(true);

  const showMainSearch = members.length >= MAIN_SEARCH_THRESHOLD;

  /** 主视图过滤：搜索词只作用于活跃成员列表（已邀请区独立展示、不参与过滤） */
  const filteredMembers = useMemo(() => {
    const q = mainQuery.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, mainQuery]);

  /** 候选 id 索引（提交时按 kind 拆分 agent / human 两组 onInvite） */
  const candidateIds = useMemo(() => new Set(candidates.map((c) => c.actorId)), [candidates]);
  const humanCandidateIds = useMemo(
    () => new Set((humanCandidates ?? []).map((c) => c.actorId)),
    [humanCandidates],
  );

  /** R4 视图重置：Sheet 关闭 → 回主视图 + 清空选择/搜索（再打开永远是主视图） */
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setView('main');
      setSelectedIds([]);
      setMainQuery('');
    }
    onOpenChange(next);
  };

  const handleToggle = (actorId: string, checked: boolean) => {
    setSelectedIds((prev) => (checked ? [...prev, actorId] : prev.filter((id) => id !== actorId)));
  };

  /**
   * R2 邀请提交：按 kind 分组 await onInvite（agent / human 各一次，页面层各自
   * allSettled 循环单端点）。全部 resolve → 切回主视图 + 清空选择；任一 reject →
   * 留在邀请视图保留选择（页面层已出失败汇总 toast）。
   */
  const handleInvite = async () => {
    const agentIds = selectedIds.filter((id) => candidateIds.has(id));
    const humanIds = selectedIds.filter((id) => humanCandidateIds.has(id));
    try {
      if (agentIds.length > 0) await onInvite(agentIds, 'agent');
      if (humanIds.length > 0) await onInvite(humanIds, 'human');
      setView('main');
      setSelectedIds([]);
    } catch {
      // 停留 invite 视图，选择集保留
    }
  };

  /** 返回主视图（用户主动放弃：清空选择，避免下次进入 invite 残留旧选择） */
  const handleBack = () => {
    setView('main');
    setSelectedIds([]);
  };

  const countSummary =
    invited && invited.length > 0
      ? t('countSummaryWithInvited', { count: members.length, invited: invited.length })
      : t('countSummary', { count: members.length });

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {view === 'main' ? (
        <div className="flex h-full flex-col">
          {/* 头部（shrink-0）：topSlot + 标题/计数 + 搜索（≥8 活跃成员才渲染） */}
          <div className="shrink-0 space-y-3">
            {topSlot}
            <SheetHeader className="pr-8">
              <SheetTitle>{labels.title}</SheetTitle>
              <SheetDescription data-testid="members-count">{countSummary}</SheetDescription>
            </SheetHeader>
            {showMainSearch && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={mainQuery}
                  onChange={(e) => setMainQuery(e.target.value)}
                  placeholder={t('searchMembers')}
                  className="pl-9"
                  data-testid="members-search"
                />
              </div>
            )}
          </div>

          {/* 唯一滚动区（flex-1 overflow-y-auto）：成员列表 / 空态 / 已邀请区 */}
          <div className="mt-3 flex-1 overflow-y-auto pr-1">
            {members.length === 0 ? (
              /* 空态：统一虚线框 + 引导文案（指向底部邀请按钮） */
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                <p>{t('emptyTitle')}</p>
                <p className="mt-1">{t('emptyDesc')}</p>
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                {t('noSearchResults')}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredMembers.map((member) => (
                  <MemberRow
                    key={member.actorId}
                    member={member}
                    labels={labels}
                    capabilities={capabilities}
                    onRemove={onRemove}
                    onChangeRole={onChangeRole}
                    onTransferCreator={onTransferCreator}
                    renderRowExtra={renderRowExtra}
                  />
                ))}
              </div>
            )}

            {/* 已邀请区（仅 topic 传 invited）：有内容才显示、可折叠默认展开；
                取消邀请 X 单次点击不加确认（对象尚未成为成员，误点可重邀——有意设计） */}
            {invited && invited.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  data-testid="invited-toggle"
                  aria-expanded={invitedOpen}
                  onClick={() => setInvitedOpen((v) => !v)}
                  className="flex items-center gap-1 text-sm font-medium text-foreground"
                >
                  <ChevronDown
                    className={cn('h-4 w-4 transition-transform', invitedOpen ? '' : '-rotate-90')}
                  />
                  {t('invitedSection', { count: invited.length })}
                </button>
                {invitedOpen && (
                  <div className="mt-2 space-y-2">
                    {invited.map((m) => (
                      <div
                        key={m.actorId}
                        data-testid={`invited-row-${m.actorId}`}
                        className="flex items-center gap-3 rounded-lg border p-2.5"
                      >
                        <Avatar
                          src={m.avatarUrl ?? undefined}
                          fallback={m.name}
                          size="sm"
                          actorType={m.actorType}
                          seed={m.actorId}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{m.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {labels.typeLabels[m.actorType] ?? m.actorType} ·{' '}
                            {labels.roleLabels[m.role] ?? m.role}
                          </p>
                        </div>
                        {capabilities.cancelInvite && (
                          <button
                            type="button"
                            data-testid={`cancel-invite-${m.actorId}`}
                            aria-label={t('cancelInviteAria', { name: m.name })}
                            onClick={() => onCancelInvite?.(m.actorId)}
                            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* sticky footer（shrink-0 border-t）：全宽「邀请成员」主按钮——根治移动端入口沉底 */}
          {capabilities.invite !== false && (
            <div className="shrink-0 border-t p-3">
              <Button
                type="button"
                className="w-full"
                onClick={() => setView('invite')}
                data-testid="open-invite"
              >
                <UserPlus className="mr-1 h-4 w-4" />
                {t('invite')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <InvitePanel
          candidates={candidates}
          humanCandidates={humanCandidates}
          selectedIds={selectedIds}
          onToggle={handleToggle}
          onBack={handleBack}
          onSubmit={() => void handleInvite()}
          inviting={inviting}
        />
      )}
    </Sheet>
  );
}
