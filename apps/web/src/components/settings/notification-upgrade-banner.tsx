'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import { fadeSlideUp } from '@/lib/animations';

/**
 * NotificationUpgradeBanner — 升级日一次性横幅（plan §D6 第 5 条）。
 *
 * 判据完全在前端（`channels` 为空 + localStorage 未读标记）——**零新后端面**是本批硬约束，
 * 所以不需要"已读"字段；代价是标记按浏览器记（换设备重现），已在 lib 的键注释里声明。
 *
 * 位置说明：plan 写「dashboard/通知 tab 顶部」，本批的改动边界**不含 dashboard**，
 * 故落在通知 tab 顶部（见交付说明的假设条目）。
 *
 * 动效：仅 `opacity + y`（fadeSlideUp），200-400ms ease-out；reduced-motion 由页面根的
 * `<MotionConfig reducedMotion="user">` 降级为静态显示。
 */
export function NotificationUpgradeBanner({ onDismiss }: { onDismiss: () => void }) {
  const t = useTranslations('settings.notifications');

  return (
    <motion.div
      variants={fadeSlideUp}
      initial="hidden"
      animate="show"
      data-testid="notification-upgrade-banner"
      className="relative overflow-hidden rounded-xl border border-primary/30 bg-primary/[0.07] p-4 pr-12"
    >
      {/* 左侧光条：状态点缀（工作区级允许的发光只有选中/状态点级别） */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-primary to-violet-glow"
      />
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t('upgradeBanner.title')}</p>
          <p className="text-sm text-muted-foreground">{t('upgradeBanner.description')}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('upgradeBanner.dismiss')}
        className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </motion.div>
  );
}
