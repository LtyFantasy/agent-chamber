/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**画布**：SVG 渲染（节点 + 边 + 孤立区 + 角落控件）+ 画布上方信息区次序
 *
 * [代码职责]
 *   - 唯一渲染方：几何全部来自 `layoutMemoryGraph`（纯函数），本组件不做任何布局计算
 *   - 拥有视口（`useGraphViewport`）、auto-fit 时机、zoom-LOD 分档与"点空白清选中"
 *   - 强制画布上方信息的**固定次序**：治理条 → snapshot 状态条 → 图例 → 空态说明条
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §5（动效红线）/§6.2（边线型 + non-scaling-stroke + LOD）
 *   - 实现蓝本: plan §4.1「memory-graph-canvas」段 + N2/N3/N5/N9/N10/N14/N15/N18
 *
 * [关键不变量]
 *   - **高度语义**：容器 `flex flex-col` + 画布 `flex-1 min-h-[560px]`，**禁 calc 魔法数**
 *     ——画布上方的横条是 0~4 条可变的，用 calc 减一个固定高度必错（先例 diagram-viewer）
 *   - **`viewBox` = 容器像素空间，不是布局内容盒**：`<g transform>` 的数学（缩放锚点、
 *     平移量、auto-fit 居中）全部在像素空间推导；用内容盒当 viewBox 会引入第二层缩放，
 *     表现为 auto-fit 双重缩放、平移速度被除以缩放比、缩放锚点偏移、LOD 阈值错位
 *   - **auto-fit 必须等容器量出尺寸再跑**（`size.width > 0`）：`fitTo` 对 0 尺寸是空操作，
 *     首帧静默失效后**永不重试**（ResizeObserver 不回调 = 没有第二次机会）
 *   - **全量边与描边 `vector-effect="non-scaling-stroke"`**：线型默认随 transform 缩放，
 *     0.2 档下 `1 2` 点线会压成亚像素、**线型这个主通道直接失效**
 *   - **边的 DOM 结构（2026-10-11 走查修复批）**：每条边包一层 `<g>` 持 `opacity`/key/testid，
 *     内含 `<line>` +（仅 supersedes）`<polygon>` 箭头——SVG `opacity` 不继承到兄弟元素，
 *     dim 态箭头必须与线同暗（通道分离 N10 的破口红线）。箭头 = 纯函数 polygon
 *     （`memoryGraphArrowhead`，尺寸 ÷scale 屏幕恒定），**不用 `<marker>`**（userSpaceOnUse
 *     随 `<g scale>` 缩放、strokeWidth 会把箭头尺寸耦合进提亮通道）。仅 supersedes 出箭头
 *     （其余四类方向仓内无据），`shape` 档不画
 *   - **边端点裁到盒边界**（`memoryGraphEdgeEndpoints`）：裸中心连线会让箭头尖被节点 fill
 *     埋掉（节点后画）；修剪后箭尖落在盒边上
 *   - **共享 clipPath（单份 `<defs>`）**：`clipPathUnits` 默认 userSpaceOnUse 在引用元素自身
 *     user space 里解释，rect 写节点局部坐标即对全部节点生效；`useId()` **必须在组件体顶部**
 *     无条件调用（SVG 在 `size>0` 条件分支内，写进分支 = 条件 Hook 崩溃）
 *   - **画布背景 = `bg-background/80`「下沉舞台」**（globals.css「页面容器不刷不透明背景」的
 *     **登记例外**）：低 alpha 会让全局 grid-beam 光带透射叠在边上（「发光竖线」错觉）；
 *     浮层 chip（hint / zoom 控件）用 `bg-card/85` 保持比画布亮一档
 *   - **auto-fit 只在首次拿到节点与新数据集时跑**：追加页不重跑（改为"新增 N 个节点在图外"
 *     + 「重新适配」按钮——每次追加都重排会把读者刚摆好的视野冲掉）；snapshot 重置时数据集
 *     未变 ⇒ **保留 transform**
 *   - **点空白清选中靠 `isClick()`（位移 < 4px）**：只判 `click` 事件会让每次平移收手都误清选中
 *   - **dim 与 hover 通道分离**：降透明只动 `opacity`，提亮只动 `stroke-width`——同一属性
 *     争用会让高亮在指针下抖动（N10）
 *   - **入场 stagger 只在前 30 个节点播一次**、且 **边只用 opacity 渐显**（禁 dashoffset /
 *     pathLength 新原语，见 correction-timeline 文件头）
 *   - `role="status"` 播报用 `sr-only` 承载：数字在治理条上已经可见，再画一遍是视觉噪音
 *
 * [关联代码]
 *   - ./memory-graph-layout.ts — 几何唯一来源（含节点尺寸与 LOD 阈值常量）
 *   - ./memory-graph-node.tsx / ./memory-graph-legend.tsx — 子渲染件
 *   - ./use-graph-viewport.ts — 变换与交互
 *   - ./memory-graph-view.tsx — 挂载点（本组件是纯渲染，数据与三态由容器管）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增渲染未绕过 layout、未引入新的动效原语
 *   □ 新增"程序性移动"必须走 viewport 的 fit/center（不要直接写 transform）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { memoryViewEdgeVisual, type MemoryViewEdge, type MemoryViewGraphNode } from '@/lib/memory';
import { cn } from '@/lib/utils';
import {
  MEMORY_GRAPH_GROUP_LABEL_OFFSET,
  MEMORY_GRAPH_NODE_H,
  MEMORY_GRAPH_NODE_W,
  MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET,
  layoutMemoryGraph,
  memoryGraphArrowhead,
  memoryGraphEdgeEndpoints,
  memoryGraphLod,
  memoryGraphScreenRect,
} from './memory-graph-layout';
import { MemoryGraphLegend } from './memory-graph-legend';
import { MemoryGraphNode, type MemoryGraphLod } from './memory-graph-node';
import { memoryKindLabel } from './graph-labels';
import { useGraphViewport } from './use-graph-viewport';

/**
 * 入场 stagger 的封顶数（plan §4.1）：200 个节点 × 80ms ≈ 16s 不可接受。
 * 前 30 个按 30ms 递延（最迟约 0.9s 收尾），其余直接落终帧。
 */
export const MEMORY_GRAPH_STAGGER_LIMIT = 30;

/** 单个节点的入场递延（秒） */
const STAGGER_STEP = 0.03;

/** 跳过链接的落点 id（图之后的第一个可聚焦区域的锚） */
export const MEMORY_GRAPH_AFTER_ID = 'memory-graph-after';

interface MemoryGraphCanvasProps {
  nodes: readonly MemoryViewGraphNode[];
  edges: readonly MemoryViewEdge[];
  /** 选中节点（`memory_id`；null = 未选中） */
  selectedId: string | null;
  onSelect: (memoryId: string | null) => void;
  /** 数据集标识（过滤器元组序列化）：变化即视为新数据集（重跑 auto-fit） */
  datasetKey: string;
  /** 是否播入场动效（只在首次拿到数据时为 true） */
  playEntrance: boolean;
  /** 是否还有下一页（决定「加载更多」是否可点） */
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** 任一分页被截断 / 部分返回（读屏播报里要念出来） */
  truncated: boolean;
  /** 信息区第 1 条：治理条（含信任框尾部） */
  governance?: ReactNode;
  /** 信息区第 2 条：snapshot 状态条 */
  statusBanner?: ReactNode;
  /** 信息区第 4 条：说明条（有记忆无边时的常态说明） */
  noteBar?: ReactNode;
}

/**
 * 关系图画布。
 *
 * 视口与布局都归本组件所有（容器只管数据与三态）——理由是二者要在同一棵子树里共享
 * 「内容包围盒」与「何时重跑适配」的判定，拆开只会多一层 props 往返。
 */
export function MemoryGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  datasetKey,
  playEntrance,
  hasMore,
  loadingMore,
  onLoadMore,
  truncated,
  governance,
  statusBanner,
  noteBar,
}: MemoryGraphCanvasProps) {
  const t = useTranslations('memory');
  const viewport = useGraphViewport();
  const [legendExpanded, setLegendExpanded] = useState(true);
  /** 追加页后落在视口外的节点数（auto-fit 不重跑的补偿提示）；0 = 不显示 */
  const [outsideCount, setOutsideCount] = useState(0);
  /**
   * 共享 clipPath 的 id。**必须在组件体顶部无条件调用**——下方 SVG 在
   * `size > 0` 条件分支内渲染，hook 写进分支 = 条件调用 = React 抛 invariant。
   */
  // 同时洗掉 `useId` 的冒号（`:r0:` → `r0`）：`url(#…)` 走 CSS IRI 解析，裸冒号在严格
  // 解析器下非法（SVG 1.1 语义 = 元素整体不渲染）。Chromium 实测可解，洗掉零成本消险。
  const clipId = useId().replace(/:/g, '');

  const layout = useMemo(() => layoutMemoryGraph(nodes, edges), [nodes, edges]);

  /** 节点盒矩形表（画边的端点修剪用；`Map` 只用于查表，不参与排序 ⇒ 不影响确定性） */
  const rects = useMemo(() => {
    const map = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const item of layout.nodes) {
      map.set(item.node.memory_id, {
        x: item.x,
        y: item.y,
        width: MEMORY_GRAPH_NODE_W,
        height: MEMORY_GRAPH_NODE_H,
      });
    }
    return map;
  }, [layout]);

  /** auto-fit 记账（数据集键 + 已见节点数） */
  const fitRef = useRef<{ datasetKey: string | null; count: number }>({
    datasetKey: null,
    count: 0,
  });
  const { fitTo, size } = viewport;
  useEffect(() => {
    if (layout.nodes.length === 0) return;
    // 容器还没量出来（首帧 size = 0）⇒ 直接返回，等 ResizeObserver 回调把它填上再跑。
    // 少了这道守卫，首屏那次 fit 会静默失效且**永不重试**（fitTo 内部对 0 尺寸也是空操作）。
    if (size.width <= 0 || size.height <= 0) return;
    const previous = fitRef.current;
    // `previous.count === 0` 也是"新数据集"：重置后累积页被清空过（0 → N），
    // 那不是"追加页"，把它当追加会让读者面对一张飞到视口外的图。
    if (previous.datasetKey !== datasetKey || previous.count === 0) {
      // 首次 / 过滤器变更 / 重置回填（= 新数据集）→ 重跑适配；`instant` 让首帧不闪
      fitTo(layout, true);
      fitRef.current = { datasetKey, count: layout.nodes.length };
      setOutsideCount(0);
      return;
    }
    if (layout.nodes.length > previous.count) {
      // 追加页：**不重跑**（否则读者刚摆好的视野被冲掉），改为提示 + 手动「重新适配」
      setOutsideCount(layout.nodes.length - previous.count);
      fitRef.current = { datasetKey, count: layout.nodes.length };
    } else if (layout.nodes.length < previous.count) {
      // 节点消失：数据集未变 ⇒ 保留 transform，只更新记账
      fitRef.current = { datasetKey, count: layout.nodes.length };
    }
  }, [datasetKey, layout, fitTo, size.width, size.height]);

  /** zoom-LOD 分档（阈值与判定收在 layout 模块的纯函数里，可单测） */
  const lod: MemoryGraphLod = memoryGraphLod(viewport.transform.scale);

  const orphanCount = useMemo(
    () => layout.nodes.filter((item) => item.groupId.startsWith('orphan:')).length,
    [layout],
  );

  /**
   * 焦点进入节点 → **视口跟随**（规格：Tab 到**视口外**的节点时才平移）。
   *
   * 无条件 centerOn 会让键盘用户每按一次 Tab 画布就跳一次——明明已经看得见那个节点，
   * 画面却被推到别处，反而丢失上下文。判据用节点在世界坐标里的矩形经当前 transform 映射
   * 到屏幕后的可见性（留 8px 余量）。
   */
  const handleFocusNode = (node: MemoryViewGraphNode) => {
    const item = layout.nodes.find((entry) => entry.node.memory_id === node.memory_id);
    if (!item) return;
    const rect = memoryGraphScreenRect(item, viewport.transform);
    const margin = 8;
    const visible =
      rect.right > margin &&
      rect.bottom > margin &&
      rect.left < size.width - margin &&
      rect.top < size.height - margin;
    if (visible) return;
    viewport.centerOn(item.x + MEMORY_GRAPH_NODE_W / 2, item.y + MEMORY_GRAPH_NODE_H / 2);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="memory-graph-canvas">
      {/*
        信息区固定次序（N3）：治理条 → status 条 → 图例 → 说明条。
        次序不写死在调用方，而是由本组件决定——四条横条的相对位置是版式约定，
        散在容器里改一处就会漏改另一处。
      */}
      {governance}
      {statusBanner}
      <MemoryGraphLegend
        expanded={legendExpanded}
        onToggle={() => setLegendExpanded((value) => !value)}
      />
      {noteBar}
      {outsideCount > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="memory-graph-outside-hint">
          {t('graph.status.outOfView', { count: outsideCount })}
        </p>
      )}

      {/* 画布：flex-1 撑满剩余高度 + min-h 兜底（禁 calc 魔法数，先例 diagram-viewer） */}
      <div
        ref={viewport.containerRef}
        onPointerDown={viewport.onPointerDown}
        onPointerMove={viewport.onPointerMove}
        onPointerUp={viewport.onPointerUp}
        onPointerCancel={viewport.onPointerCancel}
        onDoubleClick={() => fitTo(layout)}
        className={cn(
          // 「下沉舞台」：bg-background/80 压住全局 grid-beam 光带（低 alpha 下光带透射
          // 叠加在边上 = 「发光竖线」错觉，2026-10-11 走查实证；globals.css「页面容器不刷
          // 不透明背景」规则的登记例外——图渲染区必须压光束）
          'relative min-h-[560px] flex-1 touch-none overflow-hidden rounded-lg border border-border/60 bg-background/80',
          viewport.panning ? 'cursor-grabbing' : 'cursor-grab',
        )}
        data-testid="memory-graph-viewport"
      >
        {/*
          尺寸没量出来之前**不挂 SVG**：那一帧 viewBox 只能是 `0 0 0 0`，
          任何兜底小尺寸（1×1）都会把内容放大近千倍——读者看到的是"空白一闪"。
          骨架占位比一帧假画面诚实。
        */}
        {size.width > 0 && size.height > 0 ? (
          <svg
            className="h-full w-full"
            /*
              viewBox = **容器像素空间**（1 单位 = 1 CSS 像素），不是布局内容盒。
              内容 → 像素的映射全部交给下面 `<g transform>` 做（`{x, y, scale}` 的数学都在
              像素空间里推导：缩放锚点、平移量、auto-fit 居中）。
              早先用内容盒当 viewBox 会引入**第二层缩放**：SVG 自己先把 content-fit 一遍，
              `<g>` 再缩一遍 ⇒ auto-fit 双重缩放、平移速度变成 1/6、缩放锚点偏移、
              zoom-LOD 的阈值与实际视觉比例错位。
              `preserveAspectRatio` 在 1:1 viewBox 下是恒等的（保留是为了显式声明语义，
              先例 plan §4.1 N14）。
            */
            viewBox={`0 0 ${Math.round(size.width)} ${Math.round(size.height)}`}
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label={t('graph.title')}
            // 点空白 = 清选中；`isClick()` 排除拖拽收手（N9）
            onClick={() => {
              if (viewport.isClick()) onSelect(null);
            }}
            data-testid="memory-graph-svg"
          >
            {/*
              共享 clipPath（**单份**，所有节点文字共用）：`clipPathUnits` 默认
              `userSpaceOnUse` 会在**引用元素自己的 user space**（含 translate/scale）里
              解释几何——rect 写节点局部坐标即对所有节点生效（活体验证 scale 1/2 均裁在
              自己盒内）。只挂 label/角标 `<text>`，**绝不挂节点 `<g>`**（焦点环在盒外）。
            */}
            <defs>
              <clipPath id={clipId}>
                <rect
                  x={1}
                  y={1}
                  width={MEMORY_GRAPH_NODE_W - 2}
                  height={MEMORY_GRAPH_NODE_H - 2}
                  rx={9}
                />
              </clipPath>
            </defs>
            <g
              transform={`translate(${viewport.transform.x} ${viewport.transform.y}) scale(${viewport.transform.scale})`}
              style={{
                // 程序性移动（适配/焦点跟随）才开过渡；拖拽与滚轮期间必须关掉，
                // 否则指针与画面之间会拖出一条橡皮筋。动效红线：只动 transform，300ms ease-out
                transition: viewport.smooth ? 'transform 300ms ease-out' : 'none',
              }}
            >
              {/* 孤立区底板 + 标题（与连通分量视觉分区；虚线框不抢节点注意力） */}
              {layout.orphanRegion && (
                <g aria-hidden="true">
                  <rect
                    x={layout.orphanRegion.x}
                    y={layout.orphanRegion.y}
                    width={layout.orphanRegion.width}
                    height={layout.orphanRegion.height}
                    rx={12}
                    fill="none"
                    strokeDasharray="4 4"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    className="stroke-border"
                  />
                  <text
                    x={layout.orphanRegion.x + 8}
                    y={layout.orphanRegion.y + MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET}
                    fontSize={11}
                    className="fill-muted-foreground"
                  >
                    {t('graph.canvas.orphanGroup', { count: orphanCount })}
                  </text>
                  {layout.groups.map((group) => (
                    <text
                      key={group.id}
                      // 缩进 12px：与区域标题拉开层级（解撞后两行仍是同权文本会读成一行）
                      x={group.x + 12}
                      y={group.y - MEMORY_GRAPH_GROUP_LABEL_OFFSET}
                      fontSize={10}
                      className="fill-muted-foreground/80"
                    >
                      {`${memoryKindLabel(t, group.kind)} · ${group.count}`}
                    </text>
                  ))}
                </g>
              )}

              {/*
              边：只 opacity 渐显（禁 dashoffset/pathLength）。非缩放描边是硬要求——
              0.2 档下 `1 2` 点线会被压成亚像素，线型这个主通道就没了。
              通道分离（N10）：降透明只动 opacity，提亮只动 stroke-width。
              每条边包一层 `<g>` 持 opacity/key/testid——polygon 箭头与线**共用同一
              opacity**（SVG opacity 不继承到兄弟元素，dim 态箭头独自发亮 = 通道破口）。
              箭头不用 `<marker>`：userSpaceOnUse 会随 `<g scale>` 缩放、strokeWidth 会把
              箭头尺寸耦合进提亮通道；纯函数 polygon（尺寸 ÷scale）两条坑都不沾。
              仅 supersedes 出箭头（其余四类方向仓内无据），shape 档不画（200 节点零噪点）。
            */}
              <motion.g
                aria-hidden="true"
                initial={playEntrance ? { opacity: 0 } : false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="pointer-events-none"
              >
                {edges.map((edge) => {
                  const fromRect = rects.get(edge.from_id);
                  const toRect = rects.get(edge.to_id);
                  if (!fromRect || !toRect) return null;
                  const visual = memoryViewEdgeVisual(edge.type);
                  const adjacent =
                    !selectedId || edge.from_id === selectedId || edge.to_id === selectedId;
                  const { from, to } = memoryGraphEdgeEndpoints(fromRect, toRect);
                  const angle = Math.atan2(
                    toRect.y + toRect.height / 2 - (fromRect.y + fromRect.height / 2),
                    toRect.x + toRect.width / 2 - (fromRect.x + fromRect.width / 2),
                  );
                  return (
                    <g
                      key={edge.relation_id}
                      opacity={adjacent ? 0.75 : 0.15}
                      data-testid="memory-graph-edge"
                      data-relation-type={edge.type}
                    >
                      <line
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        strokeWidth={selectedId && adjacent ? 2.4 : 1.2}
                        strokeDasharray={visual.dash ?? undefined}
                        vectorEffect="non-scaling-stroke"
                        className={cn(visual.stroke, 'transition-[stroke-width] duration-200')}
                      />
                      {/* 箭头尖落在 to 端盒边界上（不内缩：节点后画，内缩会被节点 fill 埋掉）。
                          自环边（from=to）不画箭头：退化端点会让箭头落在节点正中朝右（终审 P2-5） */}
                      {edge.type === 'supersedes' &&
                        edge.from_id !== edge.to_id &&
                        lod !== 'shape' &&
                        visual.fill && (
                          <polygon
                            points={memoryGraphArrowhead(to, angle, viewport.transform.scale)}
                            className={visual.fill}
                          />
                        )}
                    </g>
                  );
                })}
              </motion.g>

              {/* 节点：Tab 序 = 布局输出序（DOM 序即输出序，画布不再排序） */}
              {layout.nodes.map((item, index) => {
                const staggered = playEntrance && index < MEMORY_GRAPH_STAGGER_LIMIT;
                return (
                  <motion.g
                    key={item.node.memory_id}
                    initial={staggered ? { opacity: 0 } : false}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.3, ease: 'easeOut', delay: index * STAGGER_STEP }}
                  >
                    {/*
                    点击守卫与 stopPropagation 都在节点组件里（B5）：本元素在冒泡链上
                    晚于节点自身的 `<g>`，把判定放在这里等于没放——拖拽收手照样开抽屉。
                  */}
                    <MemoryGraphNode
                      node={item.node}
                      x={item.x}
                      y={item.y}
                      index={index + 1}
                      total={layout.nodes.length}
                      selected={item.node.memory_id === selectedId}
                      dimmed={!!selectedId && item.node.memory_id !== selectedId}
                      lod={lod}
                      clipId={clipId}
                      onActivate={(node) => onSelect(node.memory_id)}
                      onFocusNode={handleFocusNode}
                      canClick={viewport.isClick}
                    />
                  </motion.g>
                );
              })}
            </g>
          </svg>
        ) : (
          <Skeleton className="h-full w-full" data-testid="memory-graph-canvas-skeleton" />
        )}

        {/*
          角落常驻操作提示（U3/N15）：砍掉节点拖拽后，"这幅图怎么操作"更依赖它。
          与右下角的缩放控件 chrome 同款（bg-background/80 + backdrop-blur），
          放**左下角**避开缩放控件与孤立区标题。
        */}
        <p
          data-testid="memory-graph-hint"
          // chip 必须比画布亮（bg-card/85 > bg-background/80），分离由 border 承担；
          // backdrop-blur 在近不透明画布上是 no-op（保留不删：画布 alpha 回退时仍需要）
          className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border bg-card/85 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur"
        >
          {t('graph.canvas.hint')}
        </p>

        {/* 角落控件 chrome 照 diagram-viewer：bg-card/85 + backdrop-blur + title↔aria-label 成对（比画布亮一档） */}
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border bg-card/85 p-1.5 backdrop-blur">
          <button
            type="button"
            data-testid="memory-graph-zoom-out"
            title={t('graph.canvas.zoomOut')}
            aria-label={t('graph.canvas.zoomOut')}
            // 锚点取**容器中心**：用 (0, 0)（容器左上角）做锚会让每次放大都把内容往左上拉走
            onClick={() => viewport.zoomAt(1 / 1.25, size.width / 2, size.height / 2)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="memory-graph-zoom-in"
            title={t('graph.canvas.zoomIn')}
            aria-label={t('graph.canvas.zoomIn')}
            onClick={() => viewport.zoomAt(1.25, size.width / 2, size.height / 2)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="memory-graph-fit"
            title={t('graph.canvas.fit')}
            aria-label={t('graph.canvas.fit')}
            onClick={() => {
              fitTo(layout);
              setOutsideCount(0);
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/*
        跳过链接的落点（图之后的第一个可聚焦区域）。`tabIndex=-1` 让它在没有「加载更多」
        按钮时也可被片段导航聚焦——跳到一个不存在的元素上等于链接失效。
      */}
      <div
        id={MEMORY_GRAPH_AFTER_ID}
        tabIndex={-1}
        className="flex items-center gap-3 focus-visible:outline-none"
      >
        {hasMore && (
          <button
            type="button"
            data-testid="memory-graph-load-more"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            {loadingMore ? t('graph.canvas.loadingMore') : t('graph.canvas.loadMore')}
          </button>
        )}
        {/* 读屏播报：数字在治理条上已可见，这里不重复画（sr-only） */}
        <span role="status" className="sr-only" data-testid="memory-graph-role-status">
          {t('graph.canvas.roleStatus', {
            nodes: layout.nodes.length,
            edges: edges.length,
            truncated: truncated ? t('graph.canvas.roleStatusTruncated') : '',
          })}
        </span>
      </div>
    </div>
  );
}
