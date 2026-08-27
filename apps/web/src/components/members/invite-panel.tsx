'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Search, UserPlus } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { MemberItem } from './types';

interface InvitePanelProps {
  /** 可邀请 agent 候选（页面层已排除现有成员与已邀请） */
  candidates: MemberItem[];
  /** 可邀请人类（仅 private topic 传；不传则不渲染人类区） */
  humanCandidates?: MemberItem[];
  /** 当前已选 actorId 集（受控于 MembersSheet 视图状态） */
  selectedIds: string[];
  onToggle: (actorId: string, checked: boolean) => void;
  /** 返回主视图（MembersSheet 内实现：用户主动放弃，清空选择） */
  onBack: () => void;
  /** 提交邀请（MembersSheet 层 await onInvite Promise 后决定去留） */
  onSubmit: () => void;
  /** mutation pending：按钮 loading + disabled（防重复提交） */
  inviting?: boolean;
}

/**
 * 邀请二级视图（任务型，按需进入）：返回 + 候选搜索 + checkbox 候选列表
 * （agent 区 + 可选人类区）+ sticky 确认栏（「已选 N 个 · 邀请 N 个」）。
 * 三段式布局同主视图：头部 shrink-0 / 候选列表 flex-1 overflow-y-auto / footer
 * shrink-0 border-t（主操作永远可达——根治移动端确认按钮沉底）。
 * 组件内部只持搜索词 state，候选/选择集/提交全受控。
 */
export function InvitePanel({
  candidates,
  humanCandidates,
  selectedIds,
  onToggle,
  onBack,
  onSubmit,
  inviting,
}: InvitePanelProps) {
  const t = useTranslations('members');
  const [query, setQuery] = useState('');

  /** 客户端过滤（name 小写包含；候选量级小，无服务端搜索需求） */
  const filteredCandidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((m) => m.name.toLowerCase().includes(q));
  }, [candidates, query]);
  const filteredHumans = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return humanCandidates ?? [];
    return (humanCandidates ?? []).filter((m) => m.name.toLowerCase().includes(q));
  }, [humanCandidates, query]);

  return (
    <div className="flex h-full flex-col">
      {/* 头部（shrink-0）：返回 + 标题 + 候选搜索框 */}
      <div className="shrink-0 space-y-3">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            data-testid="invite-back"
            className="-ml-2 h-10 px-2"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('back')}
          </Button>
          <h3 className="text-lg font-semibold leading-none">{t('invite')}</h3>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchCandidates')}
            className="pl-9"
            data-testid="invite-search"
          />
        </div>
      </div>

      {/* 候选列表（唯一滚动区）：agent 区 + 可选人类用户区 */}
      <div className="mt-3 flex-1 space-y-4 overflow-y-auto pr-1">
        <CandidateSection
          title={t('agentSection')}
          items={filteredCandidates}
          allEmpty={candidates.length === 0}
          emptyText={t('candidatesEmpty')}
          searchEmptyText={t('noSearchResults')}
          selectedIds={selectedIds}
          onToggle={onToggle}
        />
        {humanCandidates !== undefined && (
          <CandidateSection
            title={t('humanSection')}
            items={filteredHumans}
            allEmpty={humanCandidates.length === 0}
            emptyText={t('humansEmpty')}
            searchEmptyText={t('noSearchResults')}
            selectedIds={selectedIds}
            onToggle={onToggle}
          />
        )}
      </div>

      {/* sticky footer：已选计数 + 全宽邀请按钮（N=0 禁用；提交中 loading） */}
      <div className="shrink-0 border-t p-3">
        <div className="flex items-center gap-3">
          <span
            data-testid="invite-selected-count"
            className="whitespace-nowrap text-sm text-muted-foreground"
          >
            {t('selectedCount', { count: selectedIds.length })}
          </span>
          <Button
            type="button"
            className="flex-1"
            disabled={selectedIds.length === 0}
            isLoading={inviting}
            onClick={onSubmit}
            data-testid="invite-submit"
          >
            <UserPlus className="mr-1 h-4 w-4" />
            {t('inviteCount', { count: selectedIds.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CandidateSectionProps {
  title: string;
  items: MemberItem[];
  /** 候选本身为空（区别于搜索过滤后为空）——空态文案不同（P3：避免空白列表误解） */
  allEmpty: boolean;
  emptyText: string;
  searchEmptyText: string;
  selectedIds: string[];
  onToggle: (actorId: string, checked: boolean) => void;
}

/** 候选区（agent / 人类通用）：标题 + checkbox 行列表 + 两种空态（原始空 / 搜索无果） */
function CandidateSection({
  title,
  items,
  allEmpty,
  emptyText,
  searchEmptyText,
  selectedIds,
  onToggle,
}: CandidateSectionProps) {
  return (
    <div>
      <h4 className="text-sm font-medium">{title}</h4>
      {allEmpty ? (
        <EmptyHint text={emptyText} />
      ) : items.length === 0 ? (
        <EmptyHint text={searchEmptyText} />
      ) : (
        <div className="mt-2 space-y-2">
          {items.map((c) => (
            <label
              key={c.actorId}
              data-testid={`invite-candidate-${c.actorId}`}
              className="flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 transition-colors hover:bg-muted/50"
            >
              {/* checkbox 沿用项目惯例：原生 input（ui 无 checkbox 基元） */}
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0"
                checked={selectedIds.includes(c.actorId)}
                onChange={(e) => onToggle(c.actorId, e.target.checked)}
              />
              <Avatar fallback={c.name} size="sm" actorType={c.actorType} seed={c.actorId} />
              <span className="flex-1 truncate text-sm">{c.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** 统一虚线框空态（与三处页面现状样式一致） */
function EmptyHint({ text }: { text: string }) {
  return (
    <div className="mt-2 rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
