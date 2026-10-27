/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **分辨率阶梯**：一条记忆在 R0–R4 五个层级上各自的状态（有当前正文 / 只有旧版本 /
 *     引擎侧数据不完整 / 尚未晋升）
 *
 * [代码职责]
 *   - 把 detail 投影的 `sections.representations.ladder`（恒 5 槽）渲染成可点的层级列表；
 *     点"有当前"的槽 → 打开正文 Dialog（**数据已在手，零请求**）；点"只有旧版本"的槽 →
 *     切到版本历史块
 *
 * [权威文档]
 *   - 主文档: 线上 docs/spec.md Memory 节（R0–R4 与 ladder 四态的值域与语义）
 *   - 实现蓝本: plan §4.2「resolution-ladder.tsx」段 + F4/N1/N7
 *
 * [关键不变量]
 *   - **四态必须分开呈现**：`missing_within_available`（引擎侧数据不完整）与
 *     `beyond_available`（尚未晋升）是两件完全不同的事——合并会**抹平异常信号**
 *     （前者要转运维，后者是正常态）
 *   - **常驻 legend 行**：形成默认只产 R0，全 R0 是**正常态**。没有这一行，走查第一眼
 *     会把"全 R0"读成功能坏了（F4 的产品裁决）
 *   - **`active`（默认呈现层级）必须显式标记**：它和 `available_resolution` 不是一回事，
 *     少了标记读者只能猜"引擎默认给我看哪一层"
 *   - **`current` 槽带 `historical_count` 是常态**（重新形成后"有当前"与"有旧版本"并存）：
 *     故当前槽上也要出历史徽标与历史出口，否则版本历史块在常态下永远没有入口（N1）
 *   - 颜色不独载语义：每个槽恒带 R 标签 + 状态短文案，颜色只是加强
 *
 * [关联代码]
 *   - ./representation-body-dialog.tsx — 当前槽正文的落点（① 直给态）
 *   - ../representation-history.tsx — 历史出口的落点
 *   - ../../lib/memory.ts — `memoryLadderSlotKind` / `memoryLadderActiveResolution`
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认四态仍未合并、legend 行仍在
 *   □ 新增可点元素必须给出"点了会怎样"（打开正文 / 切历史），不做无反馈的死按钮
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Clock, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { MemoryEngineBanner } from '@/components/memory/engine-status';
import {
  MEMORY_GRAPH_RESOLUTIONS,
  memoryLadderSlotKind,
  memoryUnavailableReasonKind,
  memoryUnavailableReasonOf,
  memoryViewErrorKind,
  type MemoryViewLadderSlot,
} from '@/lib/memory';
import { cn } from '@/lib/utils';

interface ResolutionLadderProps {
  loading: boolean;
  error: unknown;
  ladder: readonly MemoryViewLadderSlot[];
  /** 本行是否已有引擎记忆（false ⇒ 只显示说明，零请求；见 F2） */
  hasEngineMemory: boolean;
  /**
   * 没有引擎记忆的**成因**（m6）：两种成因的下一步动作不同，共用一句文案会误导。
   *
   * - `notFormed`：这条主张还没形成引擎记忆（withdrawn / no_memory / 未终态）——等它形成；
   * - `metadataOnly`：这条是治理白名单降级投影，引擎投影同样要内容读权限——要去申请权限。
   */
  noEngineCause?: 'notFormed' | 'metadataOnly';
  /** 引擎记忆条数（>1 时标注"此处显示第 1 条"） */
  engineMemoryCount: number;
  /** 点"有当前"的槽（正文已在 detail 响应里，调用方负责零请求地开 Dialog） */
  onOpenCurrent: (slot: MemoryViewLadderSlot) => void;
  /** 点"只有旧版本"的槽 / 历史徽标：切到版本历史块并选该 resolution */
  onOpenHistory: (resolution: string) => void;
  onRefresh: () => void;
  className?: string;
}

/** R0–R4 的层级名（i18n 显式字面量；禁动态拼 key） */
function resolutionLabel(
  t: ReturnType<typeof useTranslations<'memory'>>,
  resolution: string,
): string {
  switch (resolution) {
    case 'R0':
      return t('resolution.label.R0');
    case 'R1':
      return t('resolution.label.R1');
    case 'R2':
      return t('resolution.label.R2');
    case 'R3':
      return t('resolution.label.R3');
    case 'R4':
      return t('resolution.label.R4');
    default:
      return resolution;
  }
}

/**
 * 分辨率阶梯块（详情页右栏第二段）。
 *
 * 位置在右栏紧跟 meta、在版本历史与更正链之上：它是"这条记忆现在长什么样"的
 * 最直接回答，历史与更正链都是它的下钻。
 */
export function ResolutionLadder({
  loading,
  error,
  ladder,
  hasEngineMemory,
  noEngineCause = 'notFormed',
  engineMemoryCount,
  onOpenCurrent,
  onOpenHistory,
  onRefresh,
  className,
}: ResolutionLadderProps) {
  const t = useTranslations('memory');
  const errorKind = memoryViewErrorKind(error);
  /** 域外 resolution 兜底追加在 R0–R4 之后（引擎新增层级时不能丢） */
  const ordered = [
    ...MEMORY_GRAPH_RESOLUTIONS.map((resolution) =>
      ladder.find((slot) => slot.resolution === resolution),
    ).filter((slot): slot is MemoryViewLadderSlot => !!slot),
    ...ladder.filter(
      (slot) => !(MEMORY_GRAPH_RESOLUTIONS as readonly string[]).includes(slot.resolution),
    ),
  ];

  // 本行还没有引擎记忆（withdrawn / no_memory / 未形成）：**零请求**，只说明（F2）
  if (!hasEngineMemory) {
    return (
      <section
        className={cn('glass-flat space-y-3 rounded-lg border border-border/60 p-4', className)}
        data-testid="memory-resolution-ladder"
      >
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium text-muted-foreground">{t('resolution.title')}</h2>
          <p className="text-[11px] text-muted-foreground/80">{t('resolution.subtitle')}</p>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="memory-resolution-no-engine">
          {noEngineCause === 'metadataOnly'
            ? t('detail.noEngineMemoryMetadata')
            : t('detail.noEngineMemory')}
        </p>
      </section>
    );
  }

  return (
    <section
      className={cn('glass-flat space-y-3 rounded-lg border border-border/60 p-4', className)}
      data-testid="memory-resolution-ladder"
    >
      {/* 常驻副标题（F8）：说清这个块与"版本历史""更正链"不是同一件事 */}
      <div className="space-y-0.5">
        <h2 className="text-sm font-medium text-muted-foreground">{t('resolution.title')}</h2>
        <p className="text-[11px] text-muted-foreground/80">{t('resolution.subtitle')}</p>
      </div>

      {loading && (
        <div className="space-y-2" data-testid="memory-resolution-loading">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      )}

      {!loading && !!error && errorKind.engineUnavailable && (
        <MemoryEngineBanner
          kind={memoryUnavailableReasonKind(memoryUnavailableReasonOf(error))}
          runtime
        />
      )}

      {!loading && !!error && !errorKind.engineUnavailable && (
        <div className="space-y-2" data-testid="memory-resolution-error">
          {/* 404 = 映射缺失 / 来源不可见（常态路径）：只说明，不给重试 */}
          <p className="text-xs text-muted-foreground">
            {errorKind.notFound
              ? t('detail.engineViewUnavailable')
              : t('representations.dialog.errorOther')}
          </p>
          {!errorKind.notFound && (
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('representations.retry')}
            </Button>
          )}
        </div>
      )}

      {!loading && !error && (
        <>
          {engineMemoryCount > 1 && (
            <p className="text-[11px] text-amber-300" data-testid="memory-resolution-mapped-count">
              {t('resolution.mappedCount', { count: engineMemoryCount })}
            </p>
          )}
          <ul className="space-y-1.5">
            {ordered.map((slot) => {
              const kind = memoryLadderSlotKind(slot.state);
              const clickable =
                kind === 'current' || (kind === 'historical' && slot.historical_count > 0);
              const stateText =
                kind === 'current'
                  ? t('resolution.state.current')
                  : kind === 'historical'
                    ? t('resolution.state.historical')
                    : kind === 'missing'
                      ? t('resolution.state.missing')
                      : t('resolution.state.beyond');
              const content = (
                <>
                  <span className="w-7 shrink-0 font-mono text-[11px] text-muted-foreground">
                    {slot.resolution}
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block text-xs">{resolutionLabel(t, slot.resolution)}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {/* 四态各一档：missing 用 Clock 图标强化"这是异常"（不独靠颜色） */}
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 text-[11px]',
                          kind === 'missing' ? 'text-amber-300' : 'text-muted-foreground',
                        )}
                      >
                        {kind === 'missing' && (
                          <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                        )}
                        {stateText}
                      </span>
                      {/* 默认呈现层级（N7）：与 available_resolution 不是一回事，必须显式标 */}
                      {slot.active && (
                        <Badge variant="outline" data-testid="memory-resolution-active">
                          {t('resolution.active')}
                        </Badge>
                      )}
                      {/* 「有当前 + 有旧版本」是重新形成后的常态（N1）：历史出口挂在槽上 */}
                      {slot.historical_count > 0 && (
                        <span
                          className="text-[10px] tabular-nums text-muted-foreground/80"
                          data-testid="memory-resolution-historical-count"
                        >
                          {t('resolution.historicalCount', { count: slot.historical_count })}
                        </span>
                      )}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={slot.resolution}>
                  {clickable ? (
                    <button
                      type="button"
                      data-testid={`memory-resolution-slot-${slot.resolution}`}
                      data-kind={kind}
                      onClick={() =>
                        kind === 'current' ? onOpenCurrent(slot) : onOpenHistory(slot.resolution)
                      }
                      title={
                        kind === 'current'
                          ? t('resolution.openCurrent', { resolution: slot.resolution })
                          : t('resolution.openHistorical', { resolution: slot.resolution })
                      }
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      {content}
                    </button>
                  ) : (
                    // 不可点态：保持同样的行结构（不换成另一种排版），只是不可交互
                    <span
                      data-testid={`memory-resolution-slot-${slot.resolution}`}
                      data-kind={kind}
                      aria-disabled="true"
                      title={t('resolution.openDisabled')}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-70"
                    >
                      {content}
                    </span>
                  )}
                  {/* 当前槽的历史出口（N1：常态下 history 块没有入口，这里补一个） */}
                  {kind === 'current' && slot.historical_count > 0 && (
                    <button
                      type="button"
                      data-testid={`memory-resolution-history-jump-${slot.resolution}`}
                      onClick={() => onOpenHistory(slot.resolution)}
                      className="ml-9 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t('resolution.historyJump', {
                        resolution: slot.resolution,
                        count: slot.historical_count,
                      })}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {/* 常驻 legend（F4）：全 R0 是正常态，没有这一行会被读成功能坏了 */}
          <p
            className="inline-flex items-start gap-1.5 text-[11px] text-muted-foreground/80"
            data-testid="memory-resolution-legend"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            {t('resolution.legend')}
          </p>
        </>
      )}
    </section>
  );
}
