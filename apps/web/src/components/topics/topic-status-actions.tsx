'use client';

/**
 * 话题状态操作按钮组（TopicStatusActions）：暂停/恢复/关闭/归档。
 *
 * 自 topics/[id]/page.tsx renderStatusActions 抽取（前端债包批次 4 子项 2 commit 7）。
 * captured 依赖全部显式 props 下传：topic.status / pauseMutation / resumeMutation /
 * openConfirm（页面级函数）/ t——openConfirm 漏传会导致 close/archive 按钮失效，
 * 验收重点。备选抽取对象（MessageSquareIcon 纯 SVG / 编辑 dialog）已否决，不换。
 */

import type { ReactNode } from 'react';
import type { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { TopicStatus } from '@/types';

/** topics namespace 的 t 函数类型（与页面 useTranslations('topics') 返回精确匹配） */
type TopicsT = ReturnType<typeof useTranslations<'topics'>>;

interface TopicStatusActionsProps {
  /** 话题当前状态（驱动按钮组显隐：archived 零渲染 / active 出暂停 / paused 出恢复 / closed 不出关闭） */
  status: TopicStatus;
  /** 暂停回调（页面 pauseMutation.mutate） */
  onPause: () => void;
  /** 暂停请求中（按钮 loading） */
  pausePending: boolean;
  /** 恢复回调（页面 resumeMutation.mutate） */
  onResume: () => void;
  /** 恢复请求中（按钮 loading） */
  resumePending: boolean;
  /** 关闭话题确认回调（页面 openConfirm('close')） */
  onClose: () => void;
  /** 归档话题确认回调（页面 openConfirm('archive')） */
  onArchive: () => void;
  /** 文案函数（页面 useTranslations('topics') 下传） */
  t: TopicsT;
}

/**
 * 话题状态操作按钮组（更多操作浮层内）：按状态显隐暂停/恢复，关闭（closed 除外）
 * 与归档常驻；close/archive 只触发页面级确认弹框（openConfirm），不直接 mutate。
 */
function TopicStatusActions({
  status,
  onPause,
  pausePending,
  onResume,
  resumePending,
  onClose,
  onArchive,
  t,
}: TopicStatusActionsProps) {
  if (status === TopicStatus.ARCHIVED) {
    return null;
  }

  const buttons: ReactNode[] = [];

  if (status === TopicStatus.ACTIVE) {
    buttons.push(
      <Button
        key="pause"
        size="sm"
        variant="outline"
        onClick={onPause}
        isLoading={pausePending}
        className="w-full justify-start"
      >
        {t('pause')}
      </Button>,
    );
  }

  if (status === TopicStatus.PAUSED) {
    buttons.push(
      <Button
        key="resume"
        size="sm"
        variant="outline"
        onClick={onResume}
        isLoading={resumePending}
        className="w-full justify-start"
      >
        {t('resume')}
      </Button>,
    );
  }

  if (status !== TopicStatus.CLOSED) {
    buttons.push(
      <Button
        key="close"
        size="sm"
        variant="secondary"
        onClick={onClose}
        className="w-full justify-start"
      >
        {t('closeTopic')}
      </Button>,
    );
  }

  buttons.push(
    <Button
      key="archive"
      size="sm"
      variant="outline"
      onClick={onArchive}
      className="w-full justify-start"
    >
      {t('archive')}
    </Button>,
  );

  return <div className="flex flex-col gap-1">{buttons}</div>;
}

export { TopicStatusActions };
