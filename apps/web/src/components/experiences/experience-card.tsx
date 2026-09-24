'use client';

/**
 * 经验库条目卡片（列表流）
 *
 * 只消费 `ExperienceSummary`（**不含 content 全文**）——列表投影的信任与新鲜度信号
 * 全在这里透出：`quality`（可信度）、`distinctHelpedCount`（N 位使用者反馈有效）、
 * `expired`（时效）、`signals`/`domains`（命中原因可解释性）。
 *
 * v1.81.0 新增**归属元信息行**（录入者头像 + 名字 + 类型 + 录入时间）：归属是可信度的
 * 上游判据（"谁录的、什么时候"），故排在信任行之前。三态渲染（活/软删/孤儿）不在本组件
 * 判定——统一由 `lib/experience` 的 `experienceActorLabel` 裁决，三处消费同一实现。
 */
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Clock } from 'lucide-react';
import { ActorType, type ExperienceSummary } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import {
  experienceActorLabel,
  experienceIntentBadgeVariant,
  experienceQualityBadgeVariant,
} from '@/lib/experience';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

interface ExperienceCardProps {
  /** 列表投影条目（后端 ExperienceSummary） */
  entry: ExperienceSummary;
}

/** intent 值 → i18n 标签（显式字面量：next-intl key 有编译期校验，禁动态拼） */
function ExperienceCard({ entry }: ExperienceCardProps) {
  const t = useTranslations('experiences');
  // 跨命名空间复用既有「已删除」文案（member-row 同款），不在 experiences 命名空间重复一份
  const tCommon = useTranslations('common');
  const locale = useLocale();

  /** 类型标签（与表单下拉同源词表，标签文案逐值显式） */
  const INTENT_LABELS: Record<ExperienceSummary['intent'], string> = {
    pitfall: t('intent.pitfall'),
    repair: t('intent.repair'),
    howto: t('intent.howto'),
    optimize: t('intent.optimize'),
    decision: t('intent.decision'),
  };

  /** 质量标签 + 释义（释义放 title，鼠标悬停即可看到"未终审意味着什么"） */
  const QUALITY_LABELS: Record<ExperienceSummary['quality'], { label: string; hint: string }> = {
    unverified: { label: t('quality.unverified'), hint: t('qualityHint.unverified') },
    verified: { label: t('quality.verified'), hint: t('qualityHint.verified') },
    suspect: { label: t('quality.suspect'), hint: t('qualityHint.suspect') },
  };

  /** 录入者类型小字（xs 头像不显示 Bot 角标 → 类型只能用文字表达，避免与角标重复） */
  const ACTOR_TYPE_LABELS: Record<ActorType, string> = {
    [ActorType.HUMAN]: t('creator.type.human'),
    [ActorType.AGENT]: t('creator.type.agent'),
    [ActorType.SYSTEM]: t('creator.type.system'),
  };

  const intentLabel = INTENT_LABELS[entry.intent];
  const quality = QUALITY_LABELS[entry.quality];
  /** 录入者三态（活/软删/孤儿）——规则唯一实现在 lib/experience，卡片/详情/下拉共用 */
  const creator = experienceActorLabel({
    id: entry.createdById,
    name: entry.createdByName,
    deletedAt: entry.createdByDeletedAt,
  });
  const creatorTypeLabel = entry.createdByType ? ACTOR_TYPE_LABELS[entry.createdByType] : '';

  return (
    <Link
      href={`/experiences/${entry.id}`}
      data-testid="experience-card"
      className="glass-flat block rounded-lg border border-border/60 p-4 transition-colors hover:border-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold leading-snug text-foreground">{entry.title}</h3>
        {/* 质量 + 过期：可信度与时效是"要不要读"的第一判据，右上角固定位 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {entry.expired && (
            <Badge variant="destructive" data-testid="experience-card-expired">
              <Clock className="mr-1 h-3 w-3" />
              {t('expired')}
            </Badge>
          )}
          <Badge variant={experienceQualityBadgeVariant(entry.quality)} title={quality.hint}>
            {quality.label}
          </Badge>
        </div>
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{entry.summary}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Badge variant={experienceIntentBadgeVariant(entry.intent)}>{intentLabel}</Badge>
        {entry.domains.map((domain) => (
          <span
            key={domain}
            className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] text-foreground/70"
          >
            {domain}
          </span>
        ))}
      </div>

      {entry.signals.length > 0 && (
        <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground/80">
          {entry.signals.join(' · ')}
        </p>
      )}

      {/*
        录入者元信息行（v1.81.0）。**位置刻意在信任行之前**：取舍是"谁录的"属于判断
        可信度的**上游**信息（归属 + 时间），信任行（distinctHelpedCount）是它下游的
        结果信号——先归属后结果，与"先看是谁写的再看多少人有用"的阅读顺序一致。

        三态渲染（活/软删/孤儿）由 `experienceActorLabel` 统一裁决，本行只做布局：
        - 软删：名字保留 + 「已删除」小字（title = 解释），头像灰化（Avatar deleted）；
        - 孤儿：显示 id 前 8 位、**不加兜底词**，解释挂头像 title（完整 UUID 留给名字 title）；
        - 双缺失：整行不渲染（`creator.visible` 门）。
      */}
      {creator.visible && (
        <div
          className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
          data-testid="experience-card-creator"
        >
          <Avatar
            size="xs"
            seed={entry.createdById}
            // 刻意不传 actorType：xs 规格本就不显示 Bot 角标，类型由右侧文字表达
            // （传了也只是让 Avatar 内部走一遍"角标不显示"的分支，无收益）
            fallback={creator.name}
            deleted={creator.deleted}
            // 孤儿态的说明放在头像上：名字元素的 title 恒留给完整 UUID（唯一排查通道）
            title={creator.orphan ? t('creator.orphanHint') : undefined}
            data-testid="experience-card-creator-avatar"
          />
          <span
            className={cn('min-w-0 truncate', creator.deleted && 'opacity-60')}
            title={creator.title}
            data-testid="experience-card-creator-name"
          >
            {creator.name}
          </span>
          {creator.deleted && (
            <span
              className="shrink-0 text-[10px] text-muted-foreground/70"
              title={t('creator.deletedHint')}
              data-testid="experience-card-creator-deleted"
            >
              {tCommon('deleted')}
            </span>
          )}
          {creatorTypeLabel && (
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {creatorTypeLabel}
            </span>
          )}
          {/*
            录入时间：带标签的相对时间（task-detail-panel 同款文案形态）+ 绝对时间的
            双通道——`aria-label` 给读屏（相对时间对读屏用户是噪音），`datetime` 给机器。
            已知偏差（`formatRelativeTime` 的固有档位，非本处引入）：≥30 天回落绝对日期、
            "昨天"按 24h 整除而非自然日，故它只当"多近"的粗略信号。
          */}
          <time
            className="ml-auto shrink-0"
            dateTime={
              typeof entry.createdAt === 'string' ? entry.createdAt : entry.createdAt.toISOString()
            }
            aria-label={formatDate(entry.createdAt, locale)}
            data-testid="experience-card-created-at"
          >
            {t('card.createdAt', { time: formatRelativeTime(entry.createdAt, locale) })}
          </time>
        </div>
      )}

      {/* 信任信号：去重后的有效命中数（most_used 排序权重列；自报数据，可在列表页看到提示） */}
      <p className="mt-2 text-[11px] text-emerald-300/80" data-testid="experience-card-trust">
        {t('trustSignal', { count: entry.distinctHelpedCount })}
      </p>
    </Link>
  );
}

export { ExperienceCard };
