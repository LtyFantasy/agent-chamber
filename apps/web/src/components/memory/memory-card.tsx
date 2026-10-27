'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆账本的**卡片**（列表/召回/降级三态同族）与两种降级呈现（紧凑锁态行、
 *     页面级元数据三列表）
 *
 * [代码职责]
 *   - 把一行 `MemoryNominationDto` 渲染成可点整卡：category chip / 状态角标 /
 *     主张 subject / 摘要 2-3 行 / 归属元信息行（头像 + 提名者 + 相对时间）/ 钻取提示
 *   - 三态分叉：`full` 档 → 完整卡；`metadata` 档且**列表整体降级** → 页面级三列表；
 *     `metadata` 档混在 full 行里（逐行降级）→ 同高紧凑锁态行
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3（滚动区用 `.glass-flat`，禁 blur）/§5（动效）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §5 第 2/3/4/6/7/19/46/48 条
 *
 * [关键不变量]
 *   - **整卡一个链接**：卡内**不得**出现第二个可点元素（按钮/链接/嵌套 `<a>` 是非法 HTML，
 *     且会与"整卡即钻取"的单一点击语义冲突）。钻取提示是 `span`，不是按钮（第 6/48 条）
 *   - **摘要只读 `contentExcerpt`**：卡片截断**不读不写** `contentTruncated`（那是
 *     "形成时摘录区被截"的行级语义，与展示截断是两件事，第 46 条）
 *   - **`metadata` 行不渲染摘要位与来源计数**：那些字段整键缺席，渲染出来就是幻觉
 *   - withdrawn 行**不加删除线**：`opacity-60` 降权 + Badge 文字（第 7 条）
 *   - 卡片必须 `.glass-flat`（滚动区重复元素禁 `.glass`/backdrop-blur，第 3 条）
 *
 * [关联代码]
 *   - ./memory-badges.tsx — category chip 与三族角标
 *   - ../../lib/memory.ts — 字段存在性 / 摘要读取 / 归属三态的唯一实现
 *   - ../../app/(main)/memory/page.tsx — 卡片墙与降级两态的挂载点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增元素仍不破坏"整卡单一可点"约束
 *   □ 新增字段消费必须先判定 `projection`（metadata 档没有 full 档字段）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Layers, Lock } from 'lucide-react';
import { MEMORY_FORMATION_STATE } from '@agent-chamber/shared';
import { ActorType } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { MemoryRecoveryNote } from '@/components/memory/memory-recovery-note';
import {
  MemoryCategoryChip,
  MemoryDeferredBadge,
  MemoryFormationStateBadge,
  MemoryMetadataBadge,
  MemoryStatusBadge,
} from '@/components/memory/memory-badges';
import {
  memoryExcerptOf,
  memoryHasField,
  memoryNominatorLabel,
  memoryStatusIsDimmed,
  type MemoryNominationDto,
} from '@/lib/memory';
import { cn, formatDate, formatRelativeTime } from '@/lib/utils';

/**
 * 卡片最小高度类（full 卡与紧凑锁态行**共用**）。
 *
 * rationale（plan §5 第 19 条）：逐行降级时锁态行会与完整卡同处一个网格——
 * 高度差太多会在墙面上开洞/错列（网格行按最高元素对齐，矮的会留白）。
 * 用一个共享常量而不是各写各的，是为了让"改高度必须两处同步"这件事不可能被忘掉。
 */
const MEMORY_CARD_HEIGHT_CLASS = 'min-h-[7.5rem]';

/**
 * 归属元信息行（提名者头像 + 名字 + 类型 + 相对时间）。
 *
 * 四态渲染规则（唯一实现在 `memoryNominatorLabel`）：
 * - 活：真名 + 类型小字；
 * - 软删：真名保留 + 「已删除」小字（头像灰化）；
 * - system 哨兵：i18n 静态文案（后端刻意不给名字——"系统"要按语言渲染）；
 * - 真孤儿：id 前 8 位（不加兜底词，解释挂头像 title）。
 *
 * 头像一律 `size="xs"` 且**不传 actorType**：xs 规格本就不显示 Bot 角标，
 * 类型由右侧文字表达（先例 experience-card.tsx，plan §5 第 4/47 条）。
 */
function MemoryNominatorRow({ entry }: { entry: MemoryNominationDto }) {
  const t = useTranslations('memory');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const nominator = memoryNominatorLabel({
    id: entry.nominatorId,
    name: entry.nominatorName,
    deletedAt: entry.nominatorDeletedAt,
    type: entry.nominatorType,
  });
  /** 类型小字（显式字面量映射：next-intl key 有编译期校验，禁动态拼） */
  const TYPE_LABELS: Record<string, string> = {
    [ActorType.HUMAN]: t('nominator.type.human'),
    [ActorType.AGENT]: t('nominator.type.agent'),
    [ActorType.SYSTEM]: t('nominator.type.system'),
  };
  const typeLabel = TYPE_LABELS[entry.nominatorType] ?? '';

  if (!nominator.visible) return null;

  return (
    <div
      className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="memory-card-nominator"
    >
      <Avatar
        size="xs"
        seed={entry.nominatorId}
        fallback={nominator.system ? t('nominator.system') : nominator.name}
        deleted={nominator.deleted}
        // system 哨兵不挂"档案解析不到"的 title：它压根没有档案，那句解释是误导（n2）
        title={nominator.orphan && !nominator.system ? t('nominator.orphanHint') : undefined}
      />
      <span
        className={cn('min-w-0 truncate', nominator.deleted && 'opacity-60')}
        title={nominator.title}
        data-testid="memory-card-nominator-name"
      >
        {nominator.system ? t('nominator.system') : nominator.name}
      </span>
      {nominator.deleted && (
        <span
          className="shrink-0 text-[10px] text-muted-foreground/70"
          title={t('nominator.deletedHint')}
          data-testid="memory-card-nominator-deleted"
        >
          {tCommon('deleted')}
        </span>
      )}
      {typeLabel && (
        <span className="shrink-0 text-[10px] text-muted-foreground/70">{typeLabel}</span>
      )}
      <time
        className="ml-auto shrink-0"
        dateTime={entry.createdAt}
        aria-label={formatDate(entry.createdAt, locale)}
        data-testid="memory-card-created-at"
        title={t('card.recordedAt', { time: formatRelativeTime(entry.createdAt, locale) })}
      >
        {formatRelativeTime(entry.createdAt, locale)}
      </time>
    </div>
  );
}

/**
 * 记忆卡片（full 档）。
 *
 * 分层（plan §5 第 2 条）：
 * - 首屏层：category chip / 状态角标 / subject / 摘要 2-3 行；
 * - 次级层：归属元信息行（头像 + 提名者 + 时间）；
 * - 钻取提示：来源计数（`text-[11px] text-muted-foreground` + 图标 + 数字，**不做徽章**）。
 *
 * 整卡 = 一个 `<Link>`（第 6/48 条：卡内不得有独立可点元素）。
 *
 * @param entry - full 档账本行投影
 */
function MemoryCard({ entry }: { entry: MemoryNominationDto }) {
  const t = useTranslations('memory');
  const excerpt = memoryExcerptOf(entry);
  const dimmed = memoryStatusIsDimmed(entry.status);
  /** 来源条数：只有 full 档才有 `sources[]`，metadata 行这里恒 0（不渲染该位） */
  const sourceCount = memoryHasField(entry, 'sources') ? (entry.sources?.length ?? 0) : 0;

  return (
    <Link
      href={`/memory/${entry.id}?project=${entry.projectId}`}
      data-testid="memory-card"
      /*
        ⚠️ **刻意不写 `aria-label`**（M3）：读屏的链接列表模式只用可访问名做区分，
        给 N 张卡同一个 aria-label（如"打开详情"）会让整面墙读成同名链接（WCAG 2.4.4
        Link Purpose 失守）。卡内文本（category/状态/主张/摘要/归属）自动组成链接名，
        天然可区分——比手写的通用名信息量更大。
      */
      className={cn(
        'glass-flat block rounded-lg border border-border/60 p-4 transition-colors hover:border-primary/40',
        MEMORY_CARD_HEIGHT_CLASS,
        dimmed && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <MemoryCategoryChip category={entry.category} />
          <MemoryStatusBadge status={entry.status} />
          {/*
            形成态徽章只在**非 committed** 时渲染：commit 是「已记住」Tab 的定义性取值
            （整片墙都是它），人人都有 = 没有信息量；而「提名记录」里的六态与「已失效」里的
            failed/rejected 行恰恰靠它区分"卡在哪一步"，缺了它读者只能看到一排"生效中"。
          */}
          {entry.formationState !== MEMORY_FORMATION_STATE.COMMITTED && (
            <MemoryFormationStateBadge state={entry.formationState} />
          )}
          {entry.deferred === true && <MemoryDeferredBadge />}
        </div>
      </div>

      {/* 主张：**不用删除线**（删除线会被读成"数据被删了"），降权只靠容器 opacity + Badge */}
      <h3
        className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-foreground"
        data-testid="memory-card-subject"
      >
        {entry.subject ?? ''}
      </h3>

      {excerpt ? (
        <p
          className="mt-1.5 line-clamp-3 text-xs text-muted-foreground"
          data-testid="memory-card-excerpt"
        >
          {excerpt}
        </p>
      ) : (
        // 空串是"后端抽不出摘要"的显式值 —— 用一句灰字说明，不留一个空白洞
        <p
          className="mt-1.5 text-xs text-muted-foreground/70"
          data-testid="memory-card-excerpt-empty"
        >
          {t('card.excerptEmpty')}
        </p>
      )}

      <MemoryNominatorRow entry={entry} />

      {/*
        「提名记录」行的下一步出口（第 26 条）：只对 full 档且**真有** recoveryPath 的行渲染
        （键缺席 = metadata 降级行；值为 null = 这条没记下一步，渲染"无"只会让人怀疑数据丢了）。
        复制按钮在详情页——卡内不得有独立可点元素（第 48 条），见 memory-recovery-note 的不变量。
      */}
      {memoryHasField(entry, 'recoveryPath') && entry.recoveryPath && (
        <MemoryRecoveryNote
          recoveryPath={entry.recoveryPath}
          ledgerId={entry.id}
          className="mt-1.5"
          testId="memory-card-recovery"
        />
      )}

      {sourceCount > 0 && (
        // 钻取提示：不是徽章（第 2 条），只是一个"点进去有东西"的暗示
        <p
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          data-testid="memory-card-source-count"
        >
          <Layers className="h-3 w-3" />
          {t('card.sourceCount', { count: sourceCount })}
        </p>
      )}
    </Link>
  );
}

/**
 * 紧凑锁态行（**逐行降级**：同一列表里混着 full 与 metadata 行）。
 *
 * 为什么不做成"锁态卡"：卡片的主体（subject/摘要/来源）整键缺席，画一张有头像有排版的
 * 空卡会让读者以为"这条没内容"，而事实是"你没有内容读权限"。故只保留三件真实存在的
 * 元数据：category / 状态 / 时间，外加一句"正文已隐去"（plan §5 第 19/25 条）。
 *
 * @param entry - `metadata` 档账本行投影
 */
function MemoryLockedRow({ entry }: { entry: MemoryNominationDto }) {
  const t = useTranslations('memory');
  const locale = useLocale();
  return (
    <Link
      href={`/memory/${entry.id}?project=${entry.projectId}`}
      data-testid="memory-locked-row"
      className={cn(
        'glass-flat flex flex-col justify-center rounded-lg border border-border/60 p-4',
        MEMORY_CARD_HEIGHT_CLASS,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <MemoryCategoryChip category={entry.category} />
        <MemoryStatusBadge status={entry.status} />
        <MemoryMetadataBadge />
      </div>
      <p
        className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        title={t('degraded.rowLockedHint')}
      >
        <Lock className="h-3 w-3 shrink-0" />
        {t('degraded.rowLocked')}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground/70">
        {formatDate(entry.createdAt, locale)}
      </p>
    </Link>
  );
}

/**
 * 页面级元数据列表（**整个列表都是 metadata 投影** = 治理观察者，或项目级无内容读权限）。
 *
 * 与逐行降级的分工（plan §5 第 19 条）：整片降级时**不渲染 N 张锁态卡**（那是 N 次
 * 说同一句话），改成一个紧凑三列表：category / state / 时间。行仍是链接——
 * 详情页有自己的"仅元数据可见"独立态（第 20 条）。
 *
 * @param entries - metadata 档账本行
 */
function MemoryMetadataList({ entries }: { entries: readonly MemoryNominationDto[] }) {
  const t = useTranslations('memory');
  const locale = useLocale();
  return (
    <ul
      className="glass-flat divide-y divide-border/60 rounded-lg border border-border/60"
      data-testid="memory-metadata-list"
    >
      {/* 表头：三列语义在窄屏也会被读到（不用 aria-hidden）——列名即信息 */}
      <li className="hidden grid-cols-[minmax(0,10rem)_minmax(0,8rem)_minmax(0,1fr)] gap-3 px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground sm:grid">
        <span>{t('degraded.compactCategory')}</span>
        <span>{t('degraded.compactState')}</span>
        <span>{t('degraded.compactTime')}</span>
      </li>
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link
            href={`/memory/${entry.id}?project=${entry.projectId}`}
            data-testid="memory-metadata-row"
            className="grid grid-cols-1 gap-1.5 px-4 py-2.5 transition-colors hover:bg-accent/40 sm:grid-cols-[minmax(0,10rem)_minmax(0,8rem)_minmax(0,1fr)] sm:items-center sm:gap-3"
          >
            <MemoryCategoryChip category={entry.category} className="w-fit" />
            <span className="w-fit">
              <MemoryStatusBadge status={entry.status} />
            </span>
            <span
              className="text-[11px] text-muted-foreground"
              title={formatDate(entry.createdAt, locale)}
            >
              {formatRelativeTime(entry.createdAt, locale)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export { MemoryCard, MemoryLockedRow, MemoryMetadataList, MEMORY_CARD_HEIGHT_CLASS };
