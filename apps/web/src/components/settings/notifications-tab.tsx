'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { BellRing, Info } from 'lucide-react';
import { Api } from '@/lib/api';
import { QueryFeedback } from '@/components/ui/query-feedback';
import { errorMessageOf } from '@/lib/error-message';
import { staggerContainer, fadeSlideUp } from '@/lib/animations';
import {
  NOTIFICATION_FEISHU_PROVIDER,
  NOTIFICATION_NOTICE_STORAGE_KEYS,
  NOTIFICATION_SETTINGS_QUERY_KEY,
  isNoticeDismissed,
  markNoticeDismissed,
  type NotificationSettingsView,
} from '@/lib/notification-settings';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { NotificationChannelCard } from './notification-channel-card';
import { NotificationPlaceholderChannels } from './notification-placeholder-channels';
import { NotificationPrefsSection } from './notification-prefs-section';
import { NotificationUpgradeBanner } from './notification-upgrade-banner';

/**
 * NotificationsTab — 「通知」tab（plan §D6 全量）。
 *
 * 页面结构（从上到下就是用户的决策链）：
 * ① 升级横幅（`channels` 为空 + 未读标记）/ `env_seed` 一次性告知；
 * ② 空态引导（`empty-state.tsx` + action 滚动到绑定卡）；
 * ③ 渠道区（飞书卡 + 折叠的占位渠道）；
 * ④ 偏好区（4 组 10 类 + 即改即存 + 恢复默认）。
 *
 * 动效（plan §D6 动效清单）：
 * - 卡片区入场 `staggerContainer` + `fadeSlideUp`，**仅首载播一次**——`entrancePlayedRef`
 *   由 settings 页持有并跨 tab 切换保留，所以"切走再切回"不会重播（重播会让整屏闪一下，
 *   是"动效做了但没做对"的典型）；
 * - 只动 opacity + transform；reduced-motion 由页面根 `<MotionConfig reducedMotion="user">` 降级。
 *
 * 数据：单一 query（`GET /notification-settings/me`）。**不做本地状态镜像**——渠道与偏好都是
 * 服务端事实，本地再存一份必然出现"界面说我开了、后端说没开"的双真相。
 *
 * @param entrancePlayedRef 页级"入场已播"标记（跨 tab 切换保留）
 */
export function NotificationsTab({
  entrancePlayedRef,
}: {
  entrancePlayedRef: React.MutableRefObject<boolean>;
}) {
  const t = useTranslations('settings.notifications');
  const tRead = useTranslations('common');
  const queryClient = useQueryClient();
  /** 绑定卡的滚动锚点（空态 CTA 用） */
  const channelAnchorRef = useRef<HTMLDivElement>(null);

  const settingsQuery = useQuery({
    queryKey: NOTIFICATION_SETTINGS_QUERY_KEY,
    queryFn: () => Api.notificationSettings.getMe(),
  });
  const { data, isLoading, isError } = settingsQuery;

  /** 升级横幅是否已关（本地读一次；SSR 一律当"未读"，见 lib 注释） */
  const [bannerDismissed, setBannerDismissed] = useState(true);
  /** `env_seed` 一次性告知是否已读 */
  const [seedNoticeRead, setSeedNoticeRead] = useState(true);

  // localStorage 只能在客户端读：挂载后再决定是否显示，避免 hydration 不一致
  useEffect(() => {
    setBannerDismissed(isNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner));
    setSeedNoticeRead(isNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.envSeedNotice));
  }, []);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: NOTIFICATION_SETTINGS_QUERY_KEY });
  }, [queryClient]);

  // 入场只播一次：首帧未载完时先停在 hidden，数据到位后才 show（否则骨架屏播完、内容不播）
  const playEntrance = !isLoading && !entrancePlayedRef.current;
  useEffect(() => {
    if (playEntrance) entrancePlayedRef.current = true;
  }, [playEntrance, entrancePlayedRef]);

  /** 滚动到绑定卡（空态 CTA）。reduced-motion 下取消平滑滚动（不是"缩短"，是不动） */
  const scrollToChannelCard = () => {
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    channelAnchorRef.current?.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth',
      block: 'start',
    });
  };

  if (isLoading) {
    // 骨架屏形状 = 最终布局形状（不给用户一次"页面跳一下"的体验）
    return (
      <div className="space-y-4" data-testid="notification-settings-skeleton">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }

  if (isError && data === undefined)
    return (
      <div data-testid="notification-settings-error">
        <QueryFeedback
          compact={settingsQuery.data !== undefined}
          message={errorMessageOf(
            settingsQuery.error,
            settingsQuery.data !== undefined ? tRead('refreshFailed') : t('loadFailed'),
          )}
          onRetry={() => void settingsQuery.refetch()}
          busy={settingsQuery.isFetching}
        />
      </div>
    );
  if (!data) return null;

  const settings: NotificationSettingsView = data;
  const hasChannel = settings.channels.length > 0;
  const feishuChannel =
    settings.channels.find((c) => c.provider === NOTIFICATION_FEISHU_PROVIDER) ?? null;
  const hasSeededChannel = settings.channels.some((c) => c.source === 'env_seed');

  return (
    <motion.div
      variants={staggerContainer}
      initial={playEntrance ? 'hidden' : false}
      animate="show"
      className="space-y-6"
    >
      {isError && (
        <QueryFeedback
          compact={settingsQuery.data !== undefined}
          message={errorMessageOf(
            settingsQuery.error,
            settingsQuery.data !== undefined ? tRead('refreshFailed') : t('loadFailed'),
          )}
          onRetry={() => void settingsQuery.refetch()}
          busy={settingsQuery.isFetching}
        />
      )}
      {/* ① 升级日一次性横幅（前端自判：channels 为空；零新后端面） */}
      {!hasChannel && !bannerDismissed && (
        <NotificationUpgradeBanner
          onDismiss={() => {
            markNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.upgradeBanner);
            setBannerDismissed(true);
          }}
        />
      )}

      {/* ①' `env_seed` 行的一次性告知（部署配置导入的绑定值得被解释一次） */}
      {hasSeededChannel && !seedNoticeRead && (
        <motion.div
          variants={fadeSlideUp}
          data-testid="notification-env-seed-notice"
          className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/60 p-4"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium">{t('envSeedNotice.title')}</p>
            <p className="text-sm text-muted-foreground">{t('envSeedNotice.description')}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              markNoticeDismissed(NOTIFICATION_NOTICE_STORAGE_KEYS.envSeedNotice);
              setSeedNoticeRead(true);
            }}
          >
            {t('envSeedNotice.dismiss')}
          </Button>
        </motion.div>
      )}

      {/* ② 空态引导：action 滚动到绑定卡（同一屏内导航，不做弹层） */}
      {!hasChannel && (
        <motion.div variants={fadeSlideUp}>
          <EmptyState
            icon={
              <BellRing className="mb-4 h-12 w-12 text-muted-foreground/50" aria-hidden="true" />
            }
            title={t('empty.title')}
            description={t('empty.description')}
            action={<Button onClick={scrollToChannelCard}>{t('empty.action')}</Button>}
          />
        </motion.div>
      )}

      {/* ③ 渠道区 */}
      <motion.section
        variants={fadeSlideUp}
        className="space-y-3"
        aria-labelledby="notification-channels-heading"
      >
        <div className="space-y-1">
          <h2 id="notification-channels-heading" className="text-lg font-semibold tracking-tight">
            {t('channel.sectionTitle')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('channel.sectionDescription')}</p>
        </div>
        <div ref={channelAnchorRef}>
          <NotificationChannelCard
            channel={feishuChannel}
            providers={settings.platform.providers}
            onRefresh={refresh}
          />
        </div>
        <NotificationPlaceholderChannels />
      </motion.section>

      {/* ④ 偏好区 */}
      <motion.div variants={fadeSlideUp}>
        <NotificationPrefsSection
          categories={settings.prefs.categories}
          platformCategories={settings.platform.categories}
          relevantScopes={settings.prefs.relevantScopes}
          hasChannel={hasChannel}
        />
      </motion.div>
    </motion.div>
  );
}
