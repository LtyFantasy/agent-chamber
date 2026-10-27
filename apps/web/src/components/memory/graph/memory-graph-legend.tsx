/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**图例工具条**：五类关系边的"实物样例 + 名称"
 *
 * [代码职责]
 *   - 把 `MEMORY_GRAPH_EDGE_VISUALS` 的线型与颜色画成实物样例——图例是**边类型文字的唯一出口**
 *     （图上不逐条标文字，200 条边带标签会糊死画布）
 *   - 可收起（默认展开）——收起态只是一个按钮，不占画布
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §6.2（关系边配色与线型登记）
 *   - 实现蓝本: plan §4.1「memory-graph-legend / 图例工具条」段 + m9（默认展开可收起）
 *
 * [关键不变量]
 *   - **样例必须取自 `memoryViewEdgeVisual` 而非本地再写一份 dash**：图例与画布同源是这条
 *     设计能成立的前提（两处各写一份 = 迟早一边改了另一边没改，读者学到的是错的编码）
 *   - **supersedes 样例带箭头**（内联 `<path>`，fill 读 `visual.fill` 字段；不用 `<marker>`
 *     ——独立小 SVG 各带 `<defs>` 的 id 漂移是白送的风险）。方向约定：箭头指向被取代的
 *     旧版（to 端），与画布/抽屉 `→/←` 文字符三处同语义（登记在 §6.2）
 *   - 图例放**画布上方**（工具条），不浮在画布上：浮层会遮住节点又跟着缩放，两头不讨好
 *   - 默认展开：线型是自定义编码，不给样例等于让人猜（m9 的裁决）
 *
 * [关联代码]
 *   - ./memory-graph-canvas.tsx — 挂载点（信息区固定次序里的第三条）
 *   - ../../lib/memory.ts — `MEMORY_GRAPH_EDGE_TYPES` / `memoryViewEdgeVisual`
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认图例样例仍与画布同源
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { MEMORY_GRAPH_EDGE_TYPES, memoryViewEdgeVisual } from '@/lib/memory';
import { MEMORY_GRAPH_ARROW_LENGTH, MEMORY_GRAPH_ARROW_WIDTH } from './memory-graph-layout';
import { memoryRelationLabel } from './graph-labels';
import { cn } from '@/lib/utils';

interface MemoryGraphLegendProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * 关系类型图例（可收起，默认展开）。
 *
 * 每项 = 一枚 24×8 的实物线样例 + 关系名称。样例用**独立小 SVG**（不是画布内的元素）：
 * 放在工具条里就不受画布 transform 影响，缩放画布时图例的线型仍然清晰可辨。
 */
export function MemoryGraphLegend({ expanded, onToggle }: MemoryGraphLegendProps) {
  const t = useTranslations('memory');
  return (
    <div
      className="glass-flat flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border/60 px-2.5 py-1.5"
      data-testid="memory-graph-legend"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="memory-graph-legend-toggle"
        title={expanded ? t('graph.legend.collapse') : t('graph.legend.expand')}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        {t('graph.legend.title')}
      </button>
      {expanded &&
        MEMORY_GRAPH_EDGE_TYPES.map((type) => {
          const visual = memoryViewEdgeVisual(type);
          return (
            <span
              key={type}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              data-testid={`memory-graph-legend-item-${type}`}
            >
              <svg aria-hidden="true" width={24} height={8} viewBox="0 0 24 8" className="shrink-0">
                <line
                  x1={0}
                  y1={4}
                  x2={visual.fill ? 24 - MEMORY_GRAPH_ARROW_LENGTH : 24}
                  y2={4}
                  strokeWidth={1.6}
                  strokeDasharray={visual.dash ?? undefined}
                  className={cn(visual.stroke)}
                />
                {/*
                  箭头样例与画布同源（fill 字段 + `MEMORY_GRAPH_ARROW_*` 几何常量；只有
                  supersedes 有）。内联 `<path>` 而非 `<marker>`：每个样例是独立 SVG，
                  用 marker 要各带 `<defs>`，id 漂移白送。
                  方向约定：from（取代者）→ to（被取代的旧版），箭头落在样例右端。
                */}
                {visual.fill && (
                  <path
                    d={`M 23 4 L ${23 - MEMORY_GRAPH_ARROW_LENGTH} ${4 - MEMORY_GRAPH_ARROW_WIDTH / 2} L ${23 - MEMORY_GRAPH_ARROW_LENGTH} ${4 + MEMORY_GRAPH_ARROW_WIDTH / 2} Z`}
                    className={visual.fill}
                  />
                )}
              </svg>
              {memoryRelationLabel(t, type)}
            </span>
          );
        })}
      {expanded && (
        <span
          className="text-[11px] text-muted-foreground/70"
          data-testid="memory-graph-legend-arrow-note"
        >
          {t('graph.legend.arrowNote')}
        </span>
      )}
    </div>
  );
}
