'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 只读视图的**状态角标族**：账本状态 / 形成态 / category chip /
 *     投影降级标记 / 延迟形成标记 / 召回条目出处标记
 *
 * [代码职责]
 *   - 把 lib/memory 的展示映射（variant / 静态类名）落成**可复用 JSX**，
 *     避免卡片墙、详情页、召回结果三处各写一套徽章分支
 *   - 语义文案（label + title 释义）走 `memory` 命名空间，显式字面量 key（禁动态拼 key）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §4（Badge 七变体；success/warning 用半透明语义色）
 *     + §2.2（禁亮主题硬编码）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §5 第 5/7/8/9/19/46 条
 *
 * [关键不变量]
 *   - **语义不得只靠颜色**（WCAG 1.4.1）：每个 Badge 的文字恒在，颜色只是加强；
 *     `opacity-60` 降权（withdrawn）同样与 Badge 文字并存，不用删除线、不用纯色点
 *   - **category chip 用自定义 span 而不是 Badge**：它是"分类标签"不是"状态"，
 *     走 Badge 会与状态徽章抢同一套语义色（plan §5 第 8 条）
 *   - 所有 Tailwind 类名来自 lib/memory 的**静态字面量池**（禁模板拼接）
 *
 * [关联代码]
 *   - ../../lib/memory.ts — variant 映射 / chip 类名池 / 摘要读取规则的唯一实现
 *   - ./memory-card.tsx — 卡片墙与紧凑锁态行的消费方
 *   - ../../app/(main)/memory/[id]/page.tsx — 详情页消费方
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认变体选择符合设计系统（不自造 variant）
 *   □ 新增徽章必须同时给出"下一步"语义（title 释义或行内说明），不做纯装饰
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useTranslations } from 'next-intl';
import { Clock, FileClock, Layers } from 'lucide-react';
import {
  MEMORY_NOMINATION_STATUS,
  type MemoryFormationState,
  type MemoryNominationStatus,
} from '@agent-chamber/shared';
import { Badge } from '@/components/ui/badge';
import {
  memoryCategoryChipClass,
  memoryFormationStateBadgeVariant,
  memoryStatusBadgeVariant,
  memoryStatusIsDimmed,
} from '@/lib/memory';
import { cn } from '@/lib/utils';

/**
 * category chip（记忆类别）——**自定义 span，不是 Badge**。
 *
 * 配色由 `memoryCategoryChipClass` 从静态字面量池按 hash 取（`ruling` 钉死第一槽），
 * 同一类别全站恒同色；`title` 给类别原文，便于 hover 复核（不做 Tooltip 原语——
 * 仓内没有，原生 title 是既有先例，见 experiences 卡的 creator 行）。
 */
function MemoryCategoryChip({ category, className }: { category: string; className?: string }) {
  return (
    <span
      data-testid="memory-category-chip"
      title={category}
      className={cn(
        'inline-block shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
        memoryCategoryChipClass(category),
        className,
      )}
    >
      {category}
    </span>
  );
}

/**
 * 账本状态徽章（生效中 / 已更正 / 已撤销）。
 *
 * 三态与设计系统的语义色一一对应（plan §5 第 5 条）：
 * - 生效中 → `success`；已更正 → `subtle`（中性，不是错误）；已撤销 → `outline` + `opacity-60`。
 *
 * ⚠️ withdrawn 的降权**不作用于卡片标题的删除线**（那会被读成"数据被删了"）——
 * 本组件的 `dimmed` 只交给调用方决定要不要给容器叠加透明度，文字语义始终靠 Badge 表达。
 *
 * @param status - 账本行状态
 * @param className - 追加类名（调用方控制位置）
 */
function MemoryStatusBadge({
  status,
  className,
}: {
  status: MemoryNominationStatus;
  className?: string;
}) {
  const t = useTranslations('memory');
  /** 显式字面量映射（next-intl key 有编译期校验，禁动态拼） */
  const LABELS: Record<MemoryNominationStatus, string> = {
    [MEMORY_NOMINATION_STATUS.ACTIVE]: t('status.active'),
    [MEMORY_NOMINATION_STATUS.SUPERSEDED]: t('status.superseded'),
    [MEMORY_NOMINATION_STATUS.WITHDRAWN]: t('status.withdrawn'),
  };
  const HINTS: Record<MemoryNominationStatus, string> = {
    [MEMORY_NOMINATION_STATUS.ACTIVE]: t('status.hint.active'),
    [MEMORY_NOMINATION_STATUS.SUPERSEDED]: t('status.hint.superseded'),
    [MEMORY_NOMINATION_STATUS.WITHDRAWN]: t('status.hint.withdrawn'),
  };
  return (
    <Badge
      variant={memoryStatusBadgeVariant(status)}
      title={HINTS[status]}
      data-testid="memory-status-badge"
      className={cn(memoryStatusIsDimmed(status) && 'opacity-60', className)}
    >
      {LABELS[status]}
    </Badge>
  );
}

/**
 * 形成态徽章（七态；「提名记录」行内与详情页共用）。
 *
 * 分档 = "是否还在动"：非终态（submitted/failed）与需人工（conflict）用可行动色，
 * 终态正常（committed）正向，终态异常（rejected）负向，`no_memory`/`unknown` 中性。
 */
function MemoryFormationStateBadge({
  state,
  className,
}: {
  state: MemoryFormationState;
  className?: string;
}) {
  const t = useTranslations('memory');
  /** 显式字面量映射（七态全覆盖；缺一态就是漏渲染，类型上不可能） */
  const LABELS: Record<MemoryFormationState, string> = {
    submitted: t('formationState.submitted'),
    committed: t('formationState.committed'),
    no_memory: t('formationState.no_memory'),
    rejected: t('formationState.rejected'),
    failed: t('formationState.failed'),
    unknown: t('formationState.unknown'),
    conflict: t('formationState.conflict'),
  };
  return (
    <Badge
      variant={memoryFormationStateBadgeVariant(state)}
      data-testid="memory-formation-badge"
      className={className}
    >
      {LABELS[state]}
    </Badge>
  );
}

/**
 * 「仅元数据」标记（治理观察者的降级投影）。
 *
 * 存在的意义是**让降级可见**：没有它，读者会把"看不到正文"当成"本来就没有正文"。
 * 与页面级降级横幅（`degraded.pageBanner`）分工：横幅解释成因与下一步，本标记标住具体行。
 */
function MemoryMetadataBadge({ className }: { className?: string }) {
  const t = useTranslations('memory');
  return (
    <Badge
      variant="outline"
      title={t('project.metadataOnlyHint')}
      data-testid="memory-metadata-badge"
      className={className}
    >
      <Layers className="mr-1 h-3 w-3" />
      {t('card.metadataOnly')}
    </Badge>
  );
}

/**
 * 「稍后形成」徽章（`deferred === true`）。
 *
 * `deferred` 是**独立布尔列**（不在 formationState 七态里）——引擎明示延后，
 * 行仍是非终态。单独一枚徽章比把它塞进形成态更诚实（两个事实正交，不是二选一）。
 */
function MemoryDeferredBadge({ className }: { className?: string }) {
  const t = useTranslations('memory');
  return (
    <Badge variant="warning" data-testid="memory-deferred-badge" className={className}>
      <Clock className="mr-1 h-3 w-3" />
      {t('card.deferred')}
    </Badge>
  );
}

/**
 * 召回条目出处徽章（**只保留差异化的那两档**）。
 *
 * plan §5 第 14 条：条目级只标注"有出处 / 无出处（自述）"——其余维度（kind/resolution/
 * status）不是召回条目之间**有差异的判断依据**，堆上来只会稀释真正有信息量的那枚。
 */
function MemoryDerivationBadge({
  derivation,
  sourceCount,
  className,
}: {
  derivation: 'sourced' | 'authorship';
  /** 来源条数（`sourced` 时用于文案里的 N） */
  sourceCount: number;
  className?: string;
}) {
  const t = useTranslations('memory');
  // 出处两态用 shared 值域字面量比对（值域小且无单源常量，见 lib/memory 的 derivation 注释）
  const sourced = derivation === 'sourced';
  return (
    <Badge
      variant={sourced ? 'subtle' : 'outline'}
      data-testid="memory-derivation-badge"
      className={className}
    >
      {sourced ? (
        <>
          <FileClock className="mr-1 h-3 w-3" />
          {t('card.sourceCount', { count: sourceCount })}
        </>
      ) : (
        t('card.authorship')
      )}
    </Badge>
  );
}

export {
  MemoryCategoryChip,
  MemoryStatusBadge,
  MemoryFormationStateBadge,
  MemoryMetadataBadge,
  MemoryDeferredBadge,
  MemoryDerivationBadge,
};
