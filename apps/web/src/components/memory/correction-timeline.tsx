'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆的**更正链时间线**：一条主张被取代/撤回的版本树，以及"当前生效版本"的定位
 *
 * [代码职责]
 *   - 把 `correctionOf` 自引用边渲染成一条可点的时间线（节点 = 版本），当前版本用唯一
 *     指示器高亮、选中版本由 URL `?v=` 承载
 *   - 呈现三件"链不完整/降级"的诚实信号：cap 触顶、链外选中、metadata 节点
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §5（动效规范：只动 transform/opacity、
 *     200-400ms、尊重 prefers-reduced-motion）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §1 D2/D8/D10 + §5 第 27/28/29/30/31/32/33 条
 *
 * [关键不变量]
 *   - **连接线用 div + `scaleY(0→1)`（transform-origin: top）+ opacity**，不用 SVG
 *     `stroke` 描边（第 27 条）：描边要动画 `stroke-dashoffset`（属 pathLength 面），
 *     那是设计系统里**没有先例**的机制，本批不引入新动效原语
 *   - **显式 `useReducedMotion()`**（第 28 条）：`MotionConfig reducedMotion="user"` 管得住
 *     transform/opacity，但"要不要挂初始态"这种分支它管不到；显式判断才能保证
 *     reduced-motion 用户看到的是**静态终态**而不是一次 0 高度的闪烁
 *   - **`layoutId` 指示器全树只有一个**（第 29 条）：它只在选中节点上渲染，
 *     两个同时存在会让 framer-motion 的共享布局动画打架（pill 在节点间"飞"错方向）
 *   - **节点必须是真 `<button>`**（第 30 条）：键盘可达 + `focus-visible` 环 +
 *     `aria-current` 标记当前版本；Tab 序 = 链序（DOM 顺序即链序，不额外排序）
 *   - **链长 > 8 时窄屏退化为纯列表 + 状态点**（第 29 条）：窄屏画编排线只会把节点挤成
 *     两行一个，可读性反而更差
 *
 * [关联代码]
 *   - ../../lib/memory.ts — 链节点的字段语义（subject 缺席 / status / projection）
 *   - ./memory-badges.tsx — 状态与降级徽章
 *   - ../app/(main)/memory/[id]/page.tsx — 链的构建者（本组件只负责渲染）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增动效仍是 transform/opacity 且 200-400ms
 *   □ 新增可点元素必须保持"Tab 序 = 链序"与单一指示器
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useTranslations } from 'next-intl';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MemoryStatusBadge } from '@/components/memory/memory-badges';
import {
  MEMORY_CHAIN_COMPACT_THRESHOLD,
  memoryIsMetadataProjection,
  memoryStatusIsDimmed,
  type MemoryNominationDto,
} from '@/lib/memory';
import { cn } from '@/lib/utils';

/** 链视图（列表页/详情页共用形状；构建逻辑在详情页，见文件头 [关联代码]） */
export interface MemoryChainView {
  /** 主链节点（`status !== withdrawn`），按链序（旧 → 新） */
  nodes: MemoryNominationDto[];
  /** 未达成的更正尝试（withdrawn）：**单列**，不进主链 */
  withdrawn: MemoryNominationDto[];
  /** 当前生效版本（主链末端；主链为空时 null） */
  currentId: string | null;
  /** cap 触顶：链**可能不完整**（必须显式说出来，否则"现行版本"可能指错） */
  truncated: boolean;
}

interface CorrectionTimelineProps {
  chain: MemoryChainView;
  /** 当前选中的版本（= URL `?v=` 或 `[id]`） */
  selectedId: string;
  /** `?v=` 指向链外节点（正文照常渲染，时间线只做说明） */
  outsideChain: boolean;
  loading: boolean;
  isError: boolean;
  /** 选中某版本（调用方负责写 URL，`?v=` 用 push） */
  onSelect: (ledgerId: string) => void;
  /** 手动刷新链（`refetchOnWindowFocus:false` 的补偿出口，第 29 条） */
  onRefresh: () => void;
}

/** 节点标签：full 档给 subject；metadata 档没有 subject，只报"(仅元数据)"（第 32 条） */
function nodeLabel(node: MemoryNominationDto, metadataLabel: string): string {
  if (node.subject && node.subject.trim().length > 0) return node.subject;
  return `${node.category} · ${metadataLabel}`;
}

/**
 * 更正链时间线。
 *
 * 三段式布局：主链（编号 + 连接线 + 唯一指示器）→ 未达成尝试（单列）→ 链不完整/链外说明。
 * 链为空且不 loading 时整段不渲染（**单版本记忆不画时间线**：一条线的"树"是噪音，第 32 条）。
 */
function CorrectionTimeline({
  chain,
  selectedId,
  outsideChain,
  loading,
  isError,
  onSelect,
  onRefresh,
}: CorrectionTimelineProps) {
  const t = useTranslations('memory');
  const shouldReduce = useReducedMotion();
  /** 窄屏退化判据（第 29 条）：链长超过阈值时窄屏只给纯列表 + 状态点 */
  const compact = chain.nodes.length > MEMORY_CHAIN_COMPACT_THRESHOLD;

  if (loading) {
    return (
      <section className="space-y-2" data-testid="memory-timeline-loading">
        <Skeleton className="h-4 w-28" />
        {/* 预留高度：链异步到达时不让下方的正文跳版（先例 experiences/[id]/page.tsx） */}
        <Skeleton className="h-24 w-full rounded-lg" />
      </section>
    );
  }

  // 链查询失败：**正文不受影响**（正文/header 不 gate 于链，第 33 条）
  if (isError) {
    return (
      <section
        className="glass-flat space-y-2 rounded-lg border border-border/60 p-3 text-xs text-muted-foreground"
        data-testid="memory-timeline-error"
      >
        <p>{t('timeline.unavailable')}</p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t('timeline.retry')}
        </Button>
      </section>
    );
  }

  // 单版本（或链上找不到锚点）：不渲染时间线——一条线的"版本树"是纯噪音。
  // ⚠️ 但**触顶（truncated）时不能省**：我们看到 1 个节点不代表链上只有它，
  //    省略警示会让"现行版本"看起来是确定的，那是错误的治理结论（第 32 条）。
  if (chain.nodes.length <= 1 && chain.withdrawn.length === 0 && !chain.truncated) return null;

  return (
    <section className="space-y-3" data-testid="memory-timeline">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t('timeline.title')}</h2>
        {/* refetchOnWindowFocus:false 的补偿出口（第 29 条：取舍 = 并发更正期间链可能陈旧） */}
        <Button variant="ghost" size="sm" data-testid="memory-timeline-refresh" onClick={onRefresh}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t('timeline.retry')}
        </Button>
      </div>

      {/* 链外选中：正文照常展示，这里只做说明（第 31 条） */}
      {outsideChain && (
        <p className="text-xs text-amber-300" data-testid="memory-timeline-outside-chain">
          {t('timeline.outsideChain')}
        </p>
      )}

      {/* cap 触顶：链可能不完整（第 32 条） */}
      {chain.truncated && (
        <p
          className="inline-flex items-center gap-1.5 text-xs text-amber-300"
          data-testid="memory-timeline-truncated"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {t('timeline.chainIncomplete')}
        </p>
      )}

      <div className="relative">
        {/*
          连接线：div + scaleY(0→1) + opacity，transform-origin: top（第 27 条）。
          reduced-motion → 直接落终态（不挂 initial），避免一次 0 高度闪烁（第 28 条）。
        */}
        <motion.div
          aria-hidden="true"
          className={cn(
            'absolute bottom-2 left-[7px] top-2 w-px origin-top bg-border',
            compact && 'hidden lg:block',
          )}
          initial={shouldReduce ? false : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        />

        <ol className="space-y-1.5">
          {chain.nodes.map((node, index) => {
            const selected = node.id === selectedId;
            const isCurrent = node.id === chain.currentId;
            return (
              <li key={node.id} className="relative">
                {/* 窄屏纯列表模式的状态点（第 29 条；颜色不独载语义，旁边永远有文字） */}
                {compact && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute left-[4px] top-3 h-1.5 w-1.5 rounded-full lg:hidden',
                      isCurrent ? 'bg-primary' : 'bg-muted-foreground/50',
                    )}
                  />
                )}
                <button
                  type="button"
                  // 当前版本对读屏明确标记（颜色之外的第二个通道）
                  aria-current={isCurrent ? 'true' : undefined}
                  aria-label={t('timeline.nodeAria', {
                    index: index + 1,
                    total: chain.nodes.length,
                    label: nodeLabel(node, t('timeline.metadataNode')),
                  })}
                  data-testid="memory-timeline-node"
                  data-selected={selected}
                  onClick={() => onSelect(node.id)}
                  className={cn(
                    'relative flex w-full items-start gap-2 rounded-md py-1.5 pl-5 pr-2 text-left transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    selected ? 'text-foreground' : 'text-muted-foreground hover:bg-accent/40',
                  )}
                >
                  {/*
                    唯一指示器（layoutId 全树仅 1 个）：版本切换时 pill 在节点间平滑移动，
                    reduced-motion 下 MotionConfig 会把它降级为静态高亮（第 29 条）。
                  */}
                  {selected && (
                    <motion.span
                      layoutId="memory-timeline-indicator"
                      className="absolute inset-0 rounded-md border border-primary/50 bg-primary/10"
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                    />
                  )}
                  <span className="relative w-5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                    {index + 1}
                  </span>
                  <span className="relative min-w-0 flex-1 space-y-1">
                    <span
                      className={cn(
                        'block truncate text-xs',
                        memoryStatusIsDimmed(node.status) && 'opacity-60',
                      )}
                    >
                      {nodeLabel(node, t('timeline.metadataNode'))}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <MemoryStatusBadge status={node.status} />
                      {isCurrent && (
                        <Badge variant="outline" data-testid="memory-timeline-current">
                          {t('timeline.current')}
                        </Badge>
                      )}
                      {/* 链上 metadata 节点：base 档没有 subject/effectiveNote（第 32 条） */}
                      {memoryIsMetadataProjection(node) && (
                        <Badge variant="outline">{t('timeline.metadataNode')}</Badge>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* 未达成尝试：withdrawn 更正行**单列**（不进主链，但仍可见——审计轨迹，第 32 条） */}
      {chain.withdrawn.length > 0 && (
        <div className="space-y-1.5" data-testid="memory-timeline-withdrawn">
          <p className="text-xs font-medium text-muted-foreground">
            {t('timeline.withdrawnTitle')}
          </p>
          <p className="text-[11px] text-muted-foreground/70">{t('timeline.withdrawnHint')}</p>
          <ul className="space-y-1">
            {chain.withdrawn.map((node) => (
              <li key={node.id} className="flex items-center gap-1.5 opacity-60">
                <MemoryStatusBadge status={node.status} />
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                  {nodeLabel(node, t('timeline.metadataNode'))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 回到现行版本（选中不在末端时才给——点了没反应的控制是噪音） */}
      {chain.currentId && chain.currentId !== selectedId && (
        <Button
          variant="outline"
          size="sm"
          data-testid="memory-timeline-back-to-current"
          onClick={() => onSelect(chain.currentId as string)}
        >
          {t('timeline.backToCurrent')}
        </Button>
      )}
    </section>
  );
}

export { CorrectionTimeline };
