'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { Check, RotateCcw } from 'lucide-react';
import { Api } from '@/lib/api';
import { confirm, toast } from '@/lib/notify';
import {
  NOTIFICATION_CATEGORY_GROUPS,
  NOTIFICATION_SETTINGS_QUERY_KEY,
  NOTIFICATION_TOPIC_CATEGORY,
  type NotificationCategoryKey,
  type NotificationCategoryPrefs,
  type NotificationSettingsView,
} from '@/lib/notification-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

/** 行内「已保存」微反馈的展示时长（ms）——够被看见，不喧宾夺主 */
const SAVED_FLASH_MS = 1600;

/**
 * 类别 → i18n 键（Record 而非拼串：新增类别时编译期就会报缺项）。
 * ⚠️ 10 个类别的**顺序**由 `NOTIFICATION_CATEGORY_KEYS` 决定，本表只管文案取键。
 */
const CATEGORY_NAME_KEYS = {
  task_done: 'prefs.categories.task_done.name',
  task_created: 'prefs.categories.task_created.name',
  task_updated: 'prefs.categories.task_updated.name',
  task_assigned: 'prefs.categories.task_assigned.name',
  topic: 'prefs.categories.topic.name',
  doc_created: 'prefs.categories.doc_created.name',
  doc_updated: 'prefs.categories.doc_updated.name',
  doc_deleted: 'prefs.categories.doc_deleted.name',
  doc_moved: 'prefs.categories.doc_moved.name',
  direct: 'prefs.categories.direct.name',
} as const;

/** 同上的"一句话说明"取键表 */
const CATEGORY_DESC_KEYS = {
  task_done: 'prefs.categories.task_done.description',
  task_created: 'prefs.categories.task_created.description',
  task_updated: 'prefs.categories.task_updated.description',
  task_assigned: 'prefs.categories.task_assigned.description',
  topic: 'prefs.categories.topic.description',
  doc_created: 'prefs.categories.doc_created.description',
  doc_updated: 'prefs.categories.doc_updated.description',
  doc_deleted: 'prefs.categories.doc_deleted.description',
  doc_moved: 'prefs.categories.doc_moved.description',
  direct: 'prefs.categories.direct.description',
} as const;

/** 分组标题取键表（组 id → 键，同样是字面量联合而非拼串） */
const GROUP_TITLE_KEYS = {
  tasks: 'prefs.groups.tasks.title',
  topics: 'prefs.groups.topics.title',
  docs: 'prefs.groups.docs.title',
  direct: 'prefs.groups.direct.title',
} as const;

/** 分组副标题取键表 */
const GROUP_DESC_KEYS = {
  tasks: 'prefs.groups.tasks.description',
  topics: 'prefs.groups.topics.description',
  docs: 'prefs.groups.docs.description',
  direct: 'prefs.groups.direct.description',
} as const;

/**
 * NotificationPrefsSection — 通知偏好区（plan §D6 第 4 条）。
 *
 * 三件事在这一屏必须同时说清，否则用户会把"我开了开关"误当成"我一定会收到"：
 * ① **过滤模型**（区顶部一句话）：开关只是"我想不想收"；平台还会叠加「部署是否启用」与
 *    「相关性（只通知你参与或有权读的资源）」两层。这是产品语义，不是免责声明；
 * ② **平台未启用**的行：开关 disabled + 徽标（部署配置关掉的类别，用户改不了）；
 * ③ **相关性为零**的行：**只有 `topic` 行**加灰字提示。task/doc 行刻意不加——它们有
 *    creator/assignee 旁路，画灰字会撒谎（有任务被指派给我时照样会通知）。
 *
 * 即改即存：optimistic 写入 → 失败回滚 + toast → 成功后服务端返回的全量归一映射落回缓存
 * （以服务端为准，避免本地拼出来的状态和真相对不上），并给该行一个 check 微反馈。
 *
 * @param categories 归一偏好（10 键恒在）
 * @param platformCategories 部署启用的类别集
 * @param relevantScopes 作用域触发面（`topics === 0` 决定 topic 行灰字）
 * @param hasChannel 是否已绑定至少一个渠道（顶部常驻提示的开关）
 */
export function NotificationPrefsSection({
  categories,
  platformCategories,
  relevantScopes,
  hasChannel,
}: {
  categories: NotificationCategoryPrefs;
  platformCategories: readonly NotificationCategoryKey[];
  relevantScopes: { topics: number; boards: number; spaces: number };
  hasChannel: boolean;
}) {
  const t = useTranslations('settings.notifications');
  const queryClient = useQueryClient();

  /** 刚保存成功的类别（行内 check 微反馈；按 key 记录，多行同时闪也互不干扰） */
  const [flashed, setFlashed] = useState<NotificationCategoryKey[]>([]);
  /** 正在写入的类别（防连点：乐观更新已翻转 UI，写入期间再点会产生乱序回包） */
  const [pending, setPending] = useState<NotificationCategoryKey[]>([]);
  /** 每行 check 的清除定时器（卸载时统一清理，避免卸载后 setState） */
  const flashTimers = useRef<
    Partial<Record<NotificationCategoryKey, ReturnType<typeof setTimeout>>>
  >({});

  useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      for (const timer of Object.values(timers)) if (timer) clearTimeout(timer);
    };
  }, []);

  /** 闪一次"已保存"（同一行重复触发会重置计时，不叠加） */
  const flashSaved = useCallback((key: NotificationCategoryKey) => {
    setFlashed((prev) => (prev.includes(key) ? prev : [...prev, key]));
    const existing = flashTimers.current[key];
    if (existing) clearTimeout(existing);
    flashTimers.current[key] = setTimeout(
      () => setFlashed((prev) => prev.filter((k) => k !== key)),
      SAVED_FLASH_MS,
    );
  }, []);

  const prefsMutation = useMutation({
    mutationFn: (patch: Partial<NotificationCategoryPrefs>) =>
      Api.notificationSettings.updatePrefs(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATION_SETTINGS_QUERY_KEY });
      const previous = queryClient.getQueryData<NotificationSettingsView>(
        NOTIFICATION_SETTINGS_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<NotificationSettingsView>(NOTIFICATION_SETTINGS_QUERY_KEY, {
          ...previous,
          prefs: {
            ...previous.prefs,
            categories: { ...previous.prefs.categories, ...patch },
          },
        });
      }
      const keys = Object.keys(patch) as NotificationCategoryKey[];
      setPending((prev) => [...prev, ...keys.filter((k) => !prev.includes(k))]);
      return { previous, keys };
    },
    onError: (_err, _patch, context) => {
      // 回滚到快照（服务端拒绝了这次改动：把界面恢复成"用户没点过"的样子）
      if (context?.previous) {
        queryClient.setQueryData(NOTIFICATION_SETTINGS_QUERY_KEY, context.previous);
      }
      toast.error({
        title: t('prefs.saveFailed.title'),
        description: t('prefs.saveFailed.description'),
      });
    },
    onSuccess: (normalized, _patch, context) => {
      // 以服务端归一结果为准落缓存（不做第二份本地合并——读取归一可能在服务端丢弃了键）
      const previous = queryClient.getQueryData<NotificationSettingsView>(
        NOTIFICATION_SETTINGS_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<NotificationSettingsView>(NOTIFICATION_SETTINGS_QUERY_KEY, {
          ...previous,
          prefs: { ...previous.prefs, categories: normalized },
        });
      }
      for (const key of context?.keys ?? []) flashSaved(key);
    },
    onSettled: (_data, _err, _patch, context) => {
      const keys = context?.keys ?? [];
      setPending((prev) => prev.filter((k) => !keys.includes(k)));
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => Api.notificationSettings.deletePrefs(),
    onSuccess: (normalized) => {
      const previous = queryClient.getQueryData<NotificationSettingsView>(
        NOTIFICATION_SETTINGS_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<NotificationSettingsView>(NOTIFICATION_SETTINGS_QUERY_KEY, {
          ...previous,
          prefs: { ...previous.prefs, categories: normalized },
        });
      }
      toast.success({ title: t('prefs.resetDone') });
    },
    onError: () => {
      toast.error({
        title: t('prefs.resetFailed.title'),
        description: t('prefs.resetFailed.description'),
      });
    },
  });

  const handleReset = async () => {
    const ok = await confirm({
      title: t('prefs.resetConfirmTitle'),
      description: t('prefs.resetConfirmDescription'),
      confirmText: t('prefs.resetConfirm'),
      cancelText: t('prefs.resetCancel'),
    });
    if (ok) resetMutation.mutate();
  };

  return (
    <Card data-testid="notification-prefs-section">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">{t('prefs.sectionTitle')}</CardTitle>
            <CardDescription>{t('prefs.sectionDescription')}</CardDescription>
          </div>
          <Button
            variant="ghost"
            size="sm"
            isLoading={resetMutation.isPending}
            onClick={handleReset}
          >
            <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />
            {t('prefs.resetDefaults')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 未绑定渠道时常驻提示：开关全部照转，但一封信也发不出去 */}
        {!hasChannel && (
          <p
            data-testid="notification-prefs-no-channel-hint"
            className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            {t('prefs.unverifiedHint')}
          </p>
        )}

        {NOTIFICATION_CATEGORY_GROUPS.map((group) => (
          <section
            key={group.id}
            className="space-y-1"
            data-testid={`notification-prefs-group-${group.id}`}
          >
            <div className="space-y-0.5">
              <h3 className="text-sm font-semibold text-foreground">
                {t(GROUP_TITLE_KEYS[group.id])}
              </h3>
              <p className="text-xs text-muted-foreground">{t(GROUP_DESC_KEYS[group.id])}</p>
            </div>
            <ul className="divide-y divide-border/40">
              {group.keys.map((key) => {
                const platformDisabled = !platformCategories.includes(key);
                // 相关性灰字**只用于 topic 行**（task/doc 有 creator/assignee 旁路，灰字会撒谎）
                const showScopeHint =
                  key === NOTIFICATION_TOPIC_CATEGORY && relevantScopes.topics === 0;
                const name = t(CATEGORY_NAME_KEYS[key]);
                return (
                  <li
                    key={key}
                    data-testid={`notification-pref-row-${key}`}
                    data-disabled={platformDisabled || undefined}
                    className="flex items-start justify-between gap-4 py-3"
                  >
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{name}</span>
                        {platformDisabled && (
                          <Badge
                            variant="secondary"
                            data-testid={`notification-pref-platform-off-${key}`}
                          >
                            {t('prefs.disabledBadge')}
                          </Badge>
                        )}
                        {/* 行内「已保存」微反馈：只做 opacity/scale，reduced-motion 下由页面根降级 */}
                        {flashed.includes(key) && (
                          <motion.span
                            key={`saved-${key}`}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.2, ease: 'easeOut' }}
                            data-testid={`notification-pref-saved-${key}`}
                            className="inline-flex items-center gap-1 text-xs text-emerald-300"
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('prefs.saved')}
                          </motion.span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{t(CATEGORY_DESC_KEYS[key])}</p>
                      {showScopeHint && (
                        <p
                          data-testid="notification-pref-topic-scope-hint"
                          className="text-xs text-muted-foreground/70"
                        >
                          {t('prefs.topicEmptyHint')}
                        </p>
                      )}
                    </div>
                    <Switch
                      size="sm"
                      checked={categories[key]}
                      disabled={platformDisabled || pending.includes(key)}
                      aria-label={name}
                      onCheckedChange={(next) => prefsMutation.mutate({ [key]: next })}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
