'use client';

import { useTranslations } from 'next-intl';
import {
  classifyChannelError,
  classifyTestReason,
  parseNotificationError,
  type NotificationChannelErrorKind,
  type NotificationTestFailureKind,
} from '@/lib/notification-settings';

/**
 * notification-error-text.ts — 通知设置面的**错误文案单一映射点**。
 *
 * 为什么收成一个 hook 而不是散在组件里：后端返回的是**英文长文案**（面向 agent/运维写的），
 * 直接回显给人类用户既读不懂也暴露内部措辞。所有"错误 → 人话"的转换必须只有一份，
 * 否则两处会渐渐不一致（一处改了另一处忘）。
 *
 * 判据（分类）在 `@/lib/notification-settings`（纯函数、可单测）；本文件只负责
 * **分类 → 文案**，用字面量键调 `t()`，从而拿到 `global.d.ts` 的编译期键校验
 * （动态拼键会让键写错变成运行期才发现）。
 *
 * [关联代码]
 * - lib/notification-settings.ts — classifyChannelError / classifyTestReason（判据单源）
 * - components/settings/notification-channel-card.tsx — 唯一消费方
 */
export function useNotificationErrorText() {
  const t = useTranslations('settings.notifications');

  /**
   * 渠道操作失败的文案（`rateLimited` 单独处理——它要插值秒数，无法进静态表）。
   *
   * 用 `Record<...>` 而不是 switch：新增一个错误分类时**编译期**就会报"缺一项"，
   * switch 只会静默走 default（这正是错误文案最容易漂移的地方）。
   */
  const channelErrors: Record<Exclude<NotificationChannelErrorKind, 'rateLimited'>, string> = {
    addressTaken: t('channel.errors.addressTaken.title'),
    channelExists: t('channel.errors.channelExists.title'),
    invalidAddress: t('channel.errors.invalidAddress.title'),
    notVerified: t('channel.errors.notVerified.title'),
    missingAddress: t('channel.errors.missingAddress.title'),
    noBinding: t('channel.errors.noBinding.title'),
    unknown: t('channel.errors.unknown.title'),
  };

  /** 同上的失败描述（toast 的第二行；说明"下一步做什么"） */
  const channelErrorDescriptions: Record<
    Exclude<NotificationChannelErrorKind, 'rateLimited'>,
    string
  > = {
    addressTaken: t('channel.errors.addressTaken.description'),
    channelExists: t('channel.errors.channelExists.description'),
    invalidAddress: t('channel.errors.invalidAddress.description'),
    notVerified: t('channel.errors.notVerified.description'),
    missingAddress: t('channel.errors.missingAddress.description'),
    noBinding: t('channel.errors.noBinding.description'),
    unknown: t('channel.errors.unknown.description'),
  };

  /** 测试消息 delivered=0 的文案（按后端 reason 分类） */
  const testFailures: Record<NotificationTestFailureKind, { title: string; description: string }> =
    {
      noProvider: {
        title: t('channel.testFailures.noProvider.title'),
        description: t('channel.testFailures.noProvider.description'),
      },
      notifyDisabled: {
        title: t('channel.testFailures.notifyDisabled.title'),
        description: t('channel.testFailures.notifyDisabled.description'),
      },
      categoryDisabled: {
        title: t('channel.testFailures.categoryDisabled.title'),
        description: t('channel.testFailures.categoryDisabled.description'),
      },
      deliveryFailed: {
        title: t('channel.testFailures.deliveryFailed.title'),
        description: t('channel.testFailures.deliveryFailed.description'),
      },
      rateLimited: {
        title: t('channel.testFailures.rateLimited.title'),
        description: t('channel.testFailures.rateLimited.description'),
      },
      other: {
        title: t('channel.testFailures.other.title'),
        description: t('channel.testFailures.other.description'),
      },
    };

  /**
   * 渠道错误 → toast 文案对。
   *
   * 429 的秒数取 `data.retryAfterSeconds`（缺失时按 60 兜底：宁可可保守地让用户多等，
   * 也不要显示"请 0 秒后重试"这种显然错的指引）。
   */
  function channelErrorText(err: unknown): { title: string; description: string } {
    const kind = classifyChannelError(err);
    if (kind === 'rateLimited') {
      const { retryAfterSeconds } = parseNotificationError(err);
      return {
        title: t('channel.errors.rateLimited.title'),
        description: t('channel.errors.rateLimited.description', {
          seconds: retryAfterSeconds ?? 60,
        }),
      };
    }
    return { title: channelErrors[kind], description: channelErrorDescriptions[kind] };
  }

  /** 测试消息降级原因 → 文案对 */
  function testFailureText(reason: string | undefined): { title: string; description: string } {
    return testFailures[classifyTestReason(reason)];
  }

  return { channelErrorText, testFailureText };
}
