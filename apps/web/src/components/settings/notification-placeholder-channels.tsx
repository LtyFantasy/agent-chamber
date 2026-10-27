'use client';

import { useTranslations } from 'next-intl';
import { ChevronRight, Hash, MessageSquare, Send } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/** 占位渠道（plan §D6：钉钉 / 企微 / Slack 折进 `<details>`，声明扩展面） */
const PLACEHOLDER_PROVIDERS = [
  { key: 'dingtalk', icon: Send },
  { key: 'wecom', icon: MessageSquare },
  { key: 'slack', icon: Hash },
] as const;

/**
 * NotificationPlaceholderChannels — 「更多渠道（即将支持）」折叠区。
 *
 * 为什么用 `<details>` 而不是 Dialog/Sheet：它要回答的是"以后还有别的吗"这一个问题，
 * 用弹层回答等于把一次好奇心变成一次操作；原生 `<details>` 零 JS、键盘可达
 * （summary 天然可聚焦可 Enter/Space 展开），且**不引入新状态**。
 *
 * `aria-disabled` 而不是 `disabled`：占位卡没有可交互控件，`aria-disabled` 表达
 * "这整块现在不可用"，读屏会播报但不能聚焦——比放一个点不动的按钮诚实。
 */
export function NotificationPlaceholderChannels() {
  const t = useTranslations('settings.notifications');

  return (
    <details data-testid="notification-more-channels" className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-4 w-4 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {t('moreChannels.summary')}
      </summary>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {PLACEHOLDER_PROVIDERS.map(({ key, icon: Icon }) => (
          <Card
            key={key}
            aria-disabled="true"
            data-testid={`notification-placeholder-${key}`}
            className="border-dashed border-border/60 bg-card/40 opacity-70"
          >
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(`moreChannels.${key}`)}
                </span>
                <Badge variant="secondary">{t('moreChannels.soon')}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{t('moreChannels.description')}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </details>
  );
}
