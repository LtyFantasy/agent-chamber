'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { AlertTriangle, Check, Send, ShieldAlert, Unlink } from 'lucide-react';
import { Api } from '@/lib/api';
import { confirm, toast } from '@/lib/notify';
import {
  NOTIFICATION_FEISHU_PROVIDER,
  NOTIFICATION_SETTINGS_QUERY_KEY,
  isChannelVerified,
  isFeishuProviderUnconfigured,
  isValidFeishuOpenId,
  needsChannelVerification,
  resolveChannelBadgeState,
  type NotificationChannelBadgeState,
  type NotificationChannelView,
  type NotificationSettingsView,
} from '@/lib/notification-settings';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useNotificationErrorText } from './notification-error-text';

/** 徽标状态 → 文案键（用 Record 而非模板串拼键：键写错要变成编译期错误） */
const BADGE_LABEL_KEYS = {
  unbound: 'channel.badgeLabel.unbound',
  unverified: 'channel.badgeLabel.unverified',
  seeded: 'channel.badgeLabel.seeded',
  verified: 'channel.badgeLabel.verified',
  failed: 'channel.badgeLabel.failed',
} as const;

/** 徽标状态 → Badge 变体（四态：未绑定 secondary / 未验证 warning / 已验证 success / 验证失败 destructive） */
const BADGE_VARIANTS: Record<NotificationChannelBadgeState, BadgeProps['variant']> = {
  unbound: 'secondary',
  unverified: 'warning',
  seeded: 'warning',
  verified: 'success',
  failed: 'destructive',
};

/**
 * NotificationChannelCard — 飞书渠道卡（plan §D6 第 2/3 条）。
 *
 * 一张卡承载四件事，顺序即用户的决策顺序：
 * ① **验证状态条**（`lastTestStatus !== 'ok'` 时出现）——先说"还差什么"；
 * ② **地址表单**（回显 + 格式预检 + 保存）——改地址；
 * ③ **发送测试消息**——验证（成功后服务端自动把渠道置为启用，前端刷新数据后徽标翻「已验证」）；
 * ④ **启用开关 / 解绑**——日常使用与退出（"临时静音"与"通知立即停止"两种语义刻意分开）。
 *
 * 关键取舍（都有后端契约背书，不是前端发明）：
 * - **换地址 ⇒ 保存后必须重新测试**：后端在地址变化时清空验证态，前端据此禁用"发送测试消息"
 *   （地址未保存时按旧地址测试 = 测了个不是你想测的东西，必须挡掉）；
 * - **未验证地址不能"启用"**：后端 400 是服务端不变量，前端把开关做成禁用态 + 说明文案
 *   （把必然失败的操作做成可点的按钮，只会制造一次无谓的失败）；
 * - **所有写操作都刷新设置数据**：状态（`enabled` / `lastTestStatus`）是服务端事实，
 *   本地"猜"出来的状态迟早与真相对不上。
 *
 * @param channel 当前飞书绑定（null = 未绑定）
 * @param providers 平台 provider 能力（`configured=false` ⇒ 表单整体禁用）
 * @param onRefresh 写完刷新设置 query（服务端状态是唯一真相）
 */
export function NotificationChannelCard({
  channel,
  providers,
  onRefresh,
}: {
  channel: NotificationChannelView | null;
  providers: { key: string; configured: boolean }[];
  onRefresh: () => void;
}) {
  const t = useTranslations('settings.notifications');
  const { channelErrorText, testFailureText } = useNotificationErrorText();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();

  /** 地址输入（受控；channel 地址变化时回填——服务端是唯一真相） */
  const [openId, setOpenId] = useState(channel?.recipientAddress ?? '');
  /** 是否已展示格式错误（blur 或提交后才有——边打边骂是糟糕的表单体验） */
  const [formatErrorShown, setFormatErrorShown] = useState(false);
  /** 徽标 pulse 的重播计数（key 变化即重播；比定时器干净，卸载无残留） */
  const [badgePulseKey, setBadgePulseKey] = useState(0);

  const providerUnconfigured = isFeishuProviderUnconfigured(providers);

  // 服务端地址变了（保存成功 / 换设备回来）就回填并清掉格式报错
  useEffect(() => {
    setOpenId(channel?.recipientAddress ?? '');
    setFormatErrorShown(false);
  }, [channel?.recipientAddress]);

  const trimmedOpenId = openId.trim();
  /** 地址是否有未保存的改动（决定"保存"是否可用、以及是否允许发测试消息） */
  const addressDirty = trimmedOpenId !== (channel?.recipientAddress ?? '');
  const addressValid = isValidFeishuOpenId(trimmedOpenId);
  const verified = isChannelVerified(channel);
  const requiresVerification = needsChannelVerification(channel);
  const badgeState = resolveChannelBadgeState(channel);

  /** 写操作失败的统一出口：分类 → 人话 → toast（错误分类器单源，见 notification-error-text） */
  const reportChannelError = (err: unknown) => {
    const text = channelErrorText(err);
    toast.error({ title: text.title, description: text.description });
  };

  /** 保存地址（PUT upsert；省略 enabled —— 地址变更由服务端清验证态，状态不在此处一并改） */
  const saveMutation = useMutation({
    mutationFn: () =>
      Api.notificationSettings.upsertChannel(NOTIFICATION_FEISHU_PROVIDER, {
        recipientOpenId: trimmedOpenId,
      }),
    onSuccess: () => {
      toast.success({
        title: t('channel.savedToast'),
        description: t('channel.savedToastDescription'),
      });
      onRefresh();
    },
    onError: reportChannelError,
  });

  /** 发送测试消息（真出境；成功后服务端自动置 enabled=true ⇒ 必须刷新数据） */
  const testMutation = useMutation({
    mutationFn: () => Api.notificationSettings.testChannel(NOTIFICATION_FEISHU_PROVIDER),
    onSuccess: (envelope) => {
      if (envelope.delivered === 1) {
        toast.success({
          title: t('channel.testSuccessToast'),
          description: t('channel.testSuccessToastDescription'),
        });
        setBadgePulseKey((n) => n + 1);
      } else {
        const text = testFailureText(envelope.reason);
        toast.warning({ title: text.title, description: text.description });
      }
      onRefresh();
    },
    onError: reportChannelError,
  });

  /**
   * 启用 / 临时静音（PUT enabled）。
   *
   * optimistic：开关是"手感"控件，等一个往返会显得卡；失败时用 `onMutate` 快照回滚，
   * 并让 toast 说明原因（后端拒绝对未验证地址置 true）。
   */
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      Api.notificationSettings.upsertChannel(NOTIFICATION_FEISHU_PROVIDER, { enabled }),
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATION_SETTINGS_QUERY_KEY });
      const previous = queryClient.getQueryData<NotificationSettingsView>(
        NOTIFICATION_SETTINGS_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<NotificationSettingsView>(NOTIFICATION_SETTINGS_QUERY_KEY, {
          ...previous,
          channels: previous.channels.map((c) =>
            c.provider === NOTIFICATION_FEISHU_PROVIDER ? { ...c, enabled } : c,
          ),
        });
      }
      return { previous };
    },
    onError: (err, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(NOTIFICATION_SETTINGS_QUERY_KEY, context.previous);
      }
      reportChannelError(err);
    },
    onSuccess: (_data, enabled) => {
      toast.success({ title: enabled ? t('channel.unmutedToast') : t('channel.mutedToast') });
    },
    onSettled: onRefresh,
  });

  /** 解绑（DELETE = tombstone，通知立即停止；重绑同一地址保留验证态） */
  const unbindMutation = useMutation({
    mutationFn: () => Api.notificationSettings.deleteChannel(NOTIFICATION_FEISHU_PROVIDER),
    onSuccess: () => {
      toast.success({ title: t('channel.unboundToast') });
      onRefresh();
    },
    onError: reportChannelError,
  });

  const handleSave = () => {
    setFormatErrorShown(true);
    if (!addressValid) return;
    saveMutation.mutate();
  };

  const handleUnbind = async () => {
    const ok = await confirm({
      title: t('channel.unbindConfirmTitle'),
      description: t('channel.unbindConfirmDescription'),
      confirmText: t('channel.unbindConfirm'),
      cancelText: t('channel.unbindCancel'),
      confirmVariant: 'danger',
    });
    if (ok) unbindMutation.mutate();
  };

  const formDisabled = providerUnconfigured;

  return (
    <Card hoverGlow tilt data-testid="notification-feishu-card" className="scroll-mt-24">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Send className="h-5 w-5 text-primary" aria-hidden="true" />
              {t('channel.feishuName')}
            </CardTitle>
            <CardDescription>{t('channel.feishuDescription')}</CardDescription>
          </div>
          {/*
            徽标 pulse：测试成功后重播一次 scale 动效（key 变化即重播）。
            MotionConfig reducedMotion="user" 会把 transform 动画降级为静态（动效红线）。
          */}
          <motion.span
            key={badgePulseKey}
            initial={false}
            animate={{ scale: [1, 1.08, 1] }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="inline-flex"
          >
            <Badge
              variant={BADGE_VARIANTS[badgeState]}
              data-testid="notification-channel-badge"
              data-state={badgeState}
            >
              {t(BADGE_LABEL_KEYS[badgeState])}
            </Badge>
          </motion.span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ① 验证状态条：`lastTestStatus !== 'ok'`（含 NULL / failed / seeded）时说明"还差一步" */}
        {requiresVerification && !providerUnconfigured && (
          <div
            data-testid="notification-channel-status-bar"
            className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              {channel?.source === 'env_seed'
                ? t('channel.statusBar.seeded')
                : t('channel.statusBar.pending')}
            </p>
          </div>
        )}

        {/* 平台未配置飞书应用：表单整体禁用（后端 configured 只回布尔，凭据永不下发） */}
        {providerUnconfigured && (
          <div
            data-testid="notification-provider-unconfigured"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{t('channel.unconfigured')}</p>
          </div>
        )}

        {/* ② 地址表单 */}
        <div className="space-y-2">
          <label htmlFor={fieldId} className="text-sm font-medium">
            {t('channel.openIdLabel')}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={fieldId}
              value={openId}
              disabled={formDisabled}
              onChange={(e) => setOpenId(e.target.value)}
              onBlur={() => setFormatErrorShown(true)}
              placeholder={t('channel.openIdPlaceholder')}
              aria-invalid={formatErrorShown && !addressValid ? true : undefined}
              aria-describedby={formatErrorShown && !addressValid ? errorId : hintId}
              // 输入框**不要**常驻发光（动效禁区），只保留组件基线的 focus 青光
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="outline"
              className="shrink-0"
              disabled={formDisabled || !addressDirty || !addressValid}
              isLoading={saveMutation.isPending}
              onClick={handleSave}
            >
              {t('channel.save')}
            </Button>
          </div>
          {formatErrorShown && !addressValid ? (
            <p id={errorId} className="text-xs text-destructive">
              {t('channel.openIdInvalid')}
            </p>
          ) : (
            <p id={hintId} className="text-xs text-muted-foreground">
              {t('channel.openIdHint')}
            </p>
          )}
        </div>

        {/* ③ 发送测试消息（地址未保存时禁用——否则测的是旧地址） */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={formDisabled || !channel || addressDirty || !addressValid}
            isLoading={testMutation.isPending}
            onClick={() => testMutation.mutate()}
            title={addressDirty ? t('channel.testNeedsSave') : undefined}
          >
            <Check className="mr-1 h-4 w-4" aria-hidden="true" />
            {testMutation.isPending ? t('channel.testSending') : t('channel.test')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('channel.testHint')}</p>
        </div>

        {/* ④ 启用（临时静音）/ 解绑 —— 两种"停"的语义必须能被区分 */}
        {channel && (
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t('channel.muteLabel')}</p>
                <p className="text-xs text-muted-foreground">
                  {!channel.enabled && !verified
                    ? t('channel.muteRequiresVerified')
                    : t('channel.muteHint')}
                </p>
              </div>
              <Switch
                checked={channel.enabled}
                aria-label={t('channel.muteLabel')}
                disabled={
                  formDisabled || toggleMutation.isPending || (!channel.enabled && !verified)
                }
                onCheckedChange={(next) => toggleMutation.mutate(next)}
                data-testid="notification-channel-switch"
              />
            </div>
            <div className="flex justify-end border-t border-border/40 pt-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={formDisabled}
                isLoading={unbindMutation.isPending}
                onClick={handleUnbind}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Unlink className="mr-1 h-4 w-4" aria-hidden="true" />
                {t('channel.unbind')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
