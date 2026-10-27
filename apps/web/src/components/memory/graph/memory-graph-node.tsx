/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图里的**单个记忆节点**：形状 + 状态色 + 两行 label + 角标 + 状态点 + 焦点环
 *
 * [代码职责]
 *   - 纯渲染：位置由 `transform` 决定，本组件不参与任何几何计算
 *   - 键盘可达：真 `tabIndex=0` + Enter 激活 + `role="button"`；焦点进入时通知外层做视口跟随
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §4（不独载语义）/§6.2（节点状态点与 focus 环登记）
 *   - 实现蓝本: plan §4.1「memory-graph-node.tsx」段 + N14（viewBox）
 *
 * [关键不变量]
 *   - **焦点可见环 = stroke 加粗 + 外圈 rect**，**不是** Tailwind `ring-*`：`ring` 走
 *     `box-shadow`，对 SVG 元素不生效——写了等于没写，键盘用户会彻底失去位置感
 *   - **`aria-label` 互不相同**（plan §4.1）：标签位只写"打开详情"会让两百个节点读成同一个
 *     链接名（WCAG 2.4.4 Link Purpose），故必须带序号 + label + kind + status
 *   - **颜色不独载语义**：kind 色、status 透明度、状态点颜色全部有文字/`<title>` 兜底；
 *     状态点本身 `aria-hidden`（它的含义由 label 与 `<title>` 承担）
 *   - **zoom-LOD**：`shape` 档只画形状 + status 色；`label` 档加单行 label（**截断显式补
 *     `…`**——静默截断会让读者把半截 label 当成全文）；`full` 档出角标 + 状态点 + 两行 label。
 *     文字全开在 200 节点档下会糊成灰噪点
 *   - **文字裁剪 clipPath（共享单份，画布 `<defs>` 提供）**：只挂 label/角标两个 `<text>`，
 *     **绝不挂节点 `<g>`**——焦点环 rect 画在盒外（x=-4,y=-4），挂 `<g>` 会把它整条裁掉，
 *     键盘用户彻底失去位置感（与焦点环不变量同级红线）
 *   - label 切片口径 = **px 预算**（`MEMORY_GRAPH_LABEL_LINE_PX`，4 类宽度表估算器负责"好看"，
 *     clip 负责"不越界"的正确性兜底；字符数口径对 CJK 必溢出，2026-10-11 走查实证的教训）
 *   - 全量信息（label / preview / 两个计数 / anchor_state / boundary）走**原生 `<title>`**
 *     ——仓内没有 Tooltip 原语，原生 title 是既有先例（`memory-badges.tsx`）
 *
 * [关联代码]
 *   - ./memory-graph-canvas.tsx — 挂载点（提供 x/y/lod/选中态）
 *   - ./graph-labels.ts — kind / status / anchor 文案的唯一映射
 *   - ../../lib/memory.ts — `memoryViewKindVisual` / `memoryViewNodeOpacity` / `memoryViewLabelLines`
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认焦点环仍是"stroke + 外圈"而不是 ring
 *   □ 新增视觉通道必须有文字或 title 兜底（颜色不独载语义）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useTranslations } from 'next-intl';
import {
  MEMORY_GRAPH_LABEL_LINE_PX,
  memoryViewKindVisual,
  memoryViewLabelLines,
  memoryViewLabelSingleLine,
  memoryViewNodeOpacity,
  type MemoryViewGraphNode,
} from '@/lib/memory';
import { MEMORY_GRAPH_NODE_H, MEMORY_GRAPH_NODE_W } from './memory-graph-layout';
import { memoryAnchorLabel, memoryKindLabel, memoryStatusLabelOf } from './graph-labels';
import { cn } from '@/lib/utils';

/** zoom-LOD 三档（阈值见 `memory-graph-layout.ts`） */
export type MemoryGraphLod = 'shape' | 'label' | 'full';

interface MemoryGraphNodeProps {
  node: MemoryViewGraphNode;
  x: number;
  y: number;
  /** Tab 序里的 1-based 序号（`aria-label` 里要互不相同，这是主键） */
  index: number;
  total: number;
  selected: boolean;
  /** 选中了**别的**节点时降透明（非邻接降权；与 hover 提亮通道分离，见画布注释） */
  dimmed: boolean;
  lod: MemoryGraphLod;
  /**
   * 共享 clipPath 的 id（画布 `<defs>` 里**单份**，节点局部坐标 1,1,138,54）。
   * 只挂 label/角标两个 `<text>`——**绝不挂节点 `<g>`**：焦点环 rect 画在盒外
   * （x=-4,y=-4），挂 `<g>` 会把键盘用户的位置指示环整条裁掉（红线）。
   */
  clipId: string;
  onActivate: (node: MemoryViewGraphNode) => void;
  /** 焦点进入节点（外层据此做视口跟随） */
  onFocusNode: (node: MemoryViewGraphNode) => void;
  /**
   * 点击判定：这次 pointerup 是不是"点击"（位移 < 4px）。
   *
   * ⚠️ 判定**必须在本组件里**执行：拖拽收手也会派发 `click`，而这个 `<g>` 的 onClick 在
   * 冒泡链上**先于**外层包装元素触发——把守卫放在外层等于没放（拖完一松手照样开抽屉）。
   */
  canClick: () => boolean;
}

/**
 * 单个记忆节点。
 *
 * 尺寸取自 `MEMORY_GRAPH_NODE_W/H`（布局与断言同源）；所有坐标写在 `transform` 上，
 * 故本组件只认自己的局部坐标系（左上角为原点）。
 */
export function MemoryGraphNode({
  node,
  x,
  y,
  index,
  total,
  selected,
  dimmed,
  lod,
  clipId,
  onActivate,
  onFocusNode,
  canClick,
}: MemoryGraphNodeProps) {
  const t = useTranslations('memory');
  const visual = memoryViewKindVisual(node.kind);
  // 两行档：px 预算切片（默认预算 = 盒内容宽 − 安全边）；单行档：截断显式补省略号
  const lines = memoryViewLabelLines(node.label, MEMORY_GRAPH_LABEL_LINE_PX);
  const singleLine = memoryViewLabelSingleLine(node.label, MEMORY_GRAPH_LABEL_LINE_PX);
  const kindLabel = memoryKindLabel(t, node.kind);
  const statusLabel = memoryStatusLabelOf(t, node.status);
  const anchorLabel = memoryAnchorLabel(t, node.anchor_state);
  const opacity = memoryViewNodeOpacity(node.status) * (dimmed ? 0.25 : 1);
  /** 角标：矛盾 / 取代计数（>0 才出，0 是绝大多数，画出来只会满屏 0） */
  const badges = [
    node.contradiction_count > 0
      ? t('graph.node.contradictions', { count: node.contradiction_count })
      : null,
    node.supersession_count > 0
      ? t('graph.node.supersessions', { count: node.supersession_count })
      : null,
  ].filter((item): item is string => item !== null);
  /** `anchor_state !== fresh` 才出状态点：fresh 是常态，常态不装饰 */
  const showAnchorDot = node.anchor_state !== 'fresh';
  /** 原生 title：全量信息（含被 label 切片与 LOD 省掉的部分） */
  const title = [
    node.label,
    `${kindLabel} · ${statusLabel}`,
    `${t('graph.drawer.anchor')}: ${anchorLabel}`,
    node.preview,
    badges.join(' · '),
  ]
    .filter((line) => line && line.length > 0)
    .join('\n');

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={t('graph.node.aria', {
        index,
        total,
        label: node.label,
        kind: kindLabel,
        status: statusLabel,
      })}
      aria-pressed={selected}
      transform={`translate(${x} ${y})`}
      opacity={opacity}
      data-testid="memory-graph-node"
      data-memory-id={node.memory_id}
      data-selected={selected}
      className="group cursor-pointer outline-none"
      onClick={(event) => {
        // 阻断冒泡：svg 的"点空白清选中"不能吃掉节点点击
        event.stopPropagation();
        // 拖拽收手也会派发 click（N9）：位移超阈值时不开抽屉
        if (!canClick()) return;
        onActivate(node);
      }}
      onFocus={() => onFocusNode(node)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          // 空格在页面上是滚动键：SVG 节点被聚焦时必须吃掉它，否则按一下跳半屏
          event.preventDefault();
          onActivate(node);
        }
      }}
    >
      <title>{title}</title>
      {/*
        焦点可见环：外圈 rect（stroke 加粗，**不是** ring——box-shadow 对 SVG 不生效）。
        与选中态共用同一枚 rect：二者都是"这是当前的节点"的表达，叠两枚只会互相打架。
      */}
      <rect
        aria-hidden="true"
        x={-4}
        y={-4}
        width={MEMORY_GRAPH_NODE_W + 8}
        height={MEMORY_GRAPH_NODE_H + 8}
        rx={12}
        fill="none"
        strokeWidth={2}
        // 描边不随 transform 缩放（M3）：缩小到 0.2 档时，这条 2px 的焦点环会被压成
        // 亚像素——那正是键盘用户最需要看见它的时候
        vectorEffect="non-scaling-stroke"
        className={cn(
          'stroke-primary transition-opacity duration-200',
          selected ? 'opacity-100' : 'opacity-0 group-focus-visible:opacity-100',
        )}
      />
      <rect
        width={MEMORY_GRAPH_NODE_W}
        height={MEMORY_GRAPH_NODE_H}
        rx={10}
        strokeWidth={selected ? 2.5 : 1.2}
        vectorEffect="non-scaling-stroke"
        className={cn(
          visual.fill,
          visual.stroke,
          'transition-[stroke-width] duration-200 group-hover:[stroke-width:2.5]',
        )}
      />
      {/* 状态点：anchor_state ≠ fresh（文字出口在 label/title/抽屉） */}
      {showAnchorDot && (
        <circle
          aria-hidden="true"
          cx={MEMORY_GRAPH_NODE_W - 10}
          cy={10}
          r={3}
          className="fill-amber-400"
        />
      )}
      {lod !== 'shape' && (
        <text
          aria-hidden="true"
          x={10}
          y={lod === 'full' ? 24 : 33}
          fontSize={11}
          // clip 兜底：估算器失准也不许渲染出盒子（裁的是文字，不是焦点环——见 props 注释）
          clipPath={`url(#${clipId})`}
          className={cn('pointer-events-none select-none', visual.text)}
        >
          {(lod === 'full' ? lines : [singleLine]).map((line, lineIndex) => (
            // key 用索引不用文本：两行可能全等（如「记」×20 → 两行各 10 字）撞 key（终审 P2-1）
            <tspan key={lineIndex} x={10} dy={lineIndex === 0 ? 0 : 13}>
              {line}
            </tspan>
          ))}
        </text>
      )}
      {lod === 'full' && badges.length > 0 && (
        <text
          aria-hidden="true"
          x={10}
          y={MEMORY_GRAPH_NODE_H - 8}
          fontSize={9}
          // 角标构造上有界（两个小整数计数，实测远窄于 116px），clip 仅作防御
          clipPath={`url(#${clipId})`}
          className="pointer-events-none select-none fill-amber-300"
        >
          {badges.join(' · ')}
        </text>
      )}
    </g>
  );
}
