/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**确定性布局纯函数**：把引擎返回的 nodes/edges 算成 (x, y) 与分组包围盒
 *
 * [代码职责]
 *   - 纯函数、零 React、零副作用：同一份数据恒得同一份坐标（可单测、可断言）
 *   - 输出数组的**顺序同时是 Tab 序**（画布按输出序渲染 ⇒ DOM 序 = 布局序）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §6.2（关系边配色与线型登记）
 *   - 实现蓝本: plan §4.1「memory-graph-layout.ts 纯函数」段
 *
 * [关键不变量]
 *   - **确定性**：排序键全部显式（坐标不由遍历顺序决定），否则同一份数据在不同
 *     引擎返回序下会重排出不同的图，读者的空间记忆每次刷新都被打乱
 *   - **无重叠**：节点盒之间恒不相交（分带 + 分列 + 网格三处都留了间距，见各常量）。
 *     这是布局最硬的一条——重叠的节点既读不出来也点不准
 *   - **Tab 序 = 输出序**：分量序 → 分量内（层序 → createdAt 升序 → id 升序）→ 孤立网格序。
 *     单测钉死；画布不得再排序（再排一次两处就会漂移）
 *   - **无边是常态**：孤立节点不是边角情况，故它有**专属网格**与视觉分区，不是丢弃或
 *     堆成一列
 *   - 节点尺寸常量（`MEMORY_GRAPH_NODE_W/H`）是布局与"无重叠"断言的**共同输入基准**：
 *     改尺寸必须同时改单测的期望，否则渲染与断言各说各话
 *   - **孤立区标题/组标签偏移同源**（`MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET` /
 *     `MEMORY_GRAPH_GROUP_LABEL_OFFSET`）：画布渲染与"间距 ≥12px"断言都消费这两个常量——
 *     跨模块各拍一个数（`+20` / `-8`）是 2026-10-11 走查里标题与标签相撞的病根
 *
 * [关联代码]
 *   - ./memory-graph-canvas.tsx — 唯一消费方（只渲染，不参与几何计算）
 *   - ./memory-graph-layout.test.ts — 覆盖布局六面（连通 / 分层 / 孤立 / 空图 / 无重叠 / Tab 序）
 *     + 视口几何三件（auto-fit / 屏幕矩形 / LOD），共 16 例
 *   - ../../lib/memory.ts — `MemoryViewGraphNode` / `MemoryViewEdge` 类型与 kind 值域
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认改动不引入随机性（禁 Math.random / 时间戳 / Map 遍历序当排序键）
 *   □ 改动坐标规则必须同步 layout 单测（尤其"无重叠"与"Tab 序"）；改动视口几何必须同步 auto-fit / 屏幕矩形 / LOD 三组断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

import {
  MEMORY_GRAPH_NODE_KINDS,
  type MemoryViewEdge,
  type MemoryViewGraphNode,
} from '@/lib/memory';

/**
 * 节点盒宽（px）。
 *
 * 依据：label 两行各 ≤20 字符 ≈ 120px（12px 字号）+ 左右内边距与角标位。
 * ⚠️ 与 `MEMORY_GRAPH_LABEL_LINE_PX` 配对——改预算不改盒宽会让文字溢出盒子。
 */
export const MEMORY_GRAPH_NODE_W = 140;

/** 节点盒高（px）：两行 tspan + 状态点/角标行 */
export const MEMORY_GRAPH_NODE_H = 56;

/** 节点水平间距（px）——无重叠断言的地基之一 */
export const MEMORY_GRAPH_GAP_X = 32;

/** 节点垂直间距（px） */
export const MEMORY_GRAPH_GAP_Y = 28;

/** 画布四周留白（px） */
export const MEMORY_GRAPH_PADDING = 24;

/** 连通分量之间的垂直间距（px）：视觉上把每个分量切成一条独立的带 */
export const MEMORY_GRAPH_BAND_GAP = 48;

/**
 * 孤立区标题行高（px）。
 *
 * 44 = 标题 baseline（`MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET` 20）与首组标签
 * baseline（`group.y − MEMORY_GRAPH_GROUP_LABEL_OFFSET`）之间留出 ≥12px 的最小间距——
 * 32 时代两条基线只差 4px，标题与组标签字面重叠（2026-10-11 走查实证）。
 */
export const MEMORY_GRAPH_GROUP_HEADER_H = 44;

/** 孤立区标题 baseline 相对 regionTop 的偏移（px）——画布不得再硬编码 `+20` */
export const MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET = 20;

/** 孤立区组标签 baseline 相对 `group.y` 的偏移（px）——画布不得再硬编码 `-8` */
export const MEMORY_GRAPH_GROUP_LABEL_OFFSET = 8;

/** 孤立区每个 kind 子分组内的网格列数 */
export const MEMORY_GRAPH_ORPHAN_COLS = 4;

/** 孤立区与其上方连通分量之间的额外间距（视觉分区） */
export const MEMORY_GRAPH_ORPHAN_GAP = 40;

/**
 * zoom-LOD 阈值（缩放维度的**信息分层**）。
 *
 * 三档（plan §4.1）：`scale < 0.5` 只画节点形状 + status 色；`0.5 ≤ scale < 1` 加单行 label；
 * `scale ≥ 1` 出角标 + 状态点 + 两行 label。目的：200 节点档下缩到最小时，文字全部消失、
 * 只剩可辨识的形状与状态色，避免糊成一片灰噪点。
 */
export const MEMORY_GRAPH_LOD_SHAPE_ONLY = 0.5;

/** zoom-LOD 第二档阈值（≥ 此值出角标 / 状态点 / 两行 label） */
export const MEMORY_GRAPH_LOD_FULL = 1;

/** 缩放下限（0.2 档下 `1 2` 点线会压成亚像素 ⇒ 全量 `non-scaling-stroke` 兜底） */
export const MEMORY_GRAPH_SCALE_MIN = 0.2;

/** 缩放上限 */
export const MEMORY_GRAPH_SCALE_MAX = 2.5;

/** 布局后的节点（`x` / `y` = 盒左上角） */
export interface MemoryGraphLayoutNode {
  node: MemoryViewGraphNode;
  x: number;
  y: number;
  /** 所属分组 id（连通分量 `c<n>` / 孤立子分组 `orphan:<kind>`）——调试与包围盒断言用 */
  groupId: string;
}

/** 孤立区的一个 kind 子分组（画虚线框 + 标题） */
export interface MemoryGraphLayoutGroup {
  id: string;
  /** 该组的 kind（域外 kind 原样透传） */
  kind: string;
  /** 组内节点数 */
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 矩形（包围盒 / 视口适配用） */
export interface MemoryGraphLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 视口变换（与 `useGraphViewport` 的 `GraphViewportTransform` 同形；此处零依赖地声明一份） */
export interface MemoryGraphTransform {
  scale: number;
  x: number;
  y: number;
}

/** 屏幕矩形（`left/top/right/bottom` 都是容器像素坐标） */
export interface MemoryGraphScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 节点（世界坐标左上角）经变换后的**屏幕矩形**。
 *
 * 用途：焦点跟随时判断"这个节点是不是已经在视口外"。判断必须在**屏幕空间**做——
 * 世界坐标看不出可见性，而 `x/scale` 的换算散落各处就是几何漂移的开始。
 *
 * @param item - 节点的世界坐标左上角
 * @param transform - 当前视口变换
 * @param width - 节点盒宽（默认 `MEMORY_GRAPH_NODE_W`）
 * @param height - 节点盒高（默认 `MEMORY_GRAPH_NODE_H`）
 * @returns 屏幕矩形
 */
export function memoryGraphScreenRect(
  item: { x: number; y: number },
  transform: MemoryGraphTransform,
  width: number = MEMORY_GRAPH_NODE_W,
  height: number = MEMORY_GRAPH_NODE_H,
): MemoryGraphScreenRect {
  const left = transform.x + item.x * transform.scale;
  const top = transform.y + item.y * transform.scale;
  return {
    left,
    top,
    right: left + width * transform.scale,
    bottom: top + height * transform.scale,
  };
}

/**
 * 计算"内容适配进容器"的变换（auto-fit 的几何，**纯函数**）。
 *
 * 三条规则：
 * - **不放大**（`scale ≤ 1`）：三五个节点被拉到占满整屏既难看也失真；
 * - **钳制在 `[0.2, 2.5]`**：下界与画布统一（描边用 `non-scaling-stroke` 兜底），
 *   上界防止极端比例把内容缩成一个点；
 * - **居中**：`x/y` 取剩余空间的一半，内容落在视口正中。
 *
 * @param content - 内容包围盒（`layoutMemoryGraph` 的 `width` / `height`）
 * @param viewport - 容器尺寸（像素）
 * @returns 变换；任一尺寸非正时返回 `null`（调用方跳过——**不要**返回一个 0 尺寸的假变换）
 */
export function computeFitTransform(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): MemoryGraphTransform | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  if (content.width <= 0 || content.height <= 0) return null;
  const scale = Math.min(
    MEMORY_GRAPH_SCALE_MAX,
    Math.max(
      MEMORY_GRAPH_SCALE_MIN,
      Math.min(viewport.width / content.width, viewport.height / content.height, 1),
    ),
  );
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  };
}

/**
 * zoom-LOD 分档（缩放维度的信息分层；阈值见上方常量）。
 *
 * @param scale - 当前缩放
 * @returns `shape`（只画形状 + 状态色）/ `label`（加单行 label）/ `full`（角标 + 状态点 + 两行 label）
 */
export function memoryGraphLod(scale: number): 'shape' | 'label' | 'full' {
  if (scale >= MEMORY_GRAPH_LOD_FULL) return 'full';
  if (scale >= MEMORY_GRAPH_LOD_SHAPE_ONLY) return 'label';
  return 'shape';
}

/** 布局结果（`nodes` 的顺序**即 Tab 序**） */
export interface MemoryGraphLayout {
  nodes: MemoryGraphLayoutNode[];
  /** 孤立区的 kind 子分组（连通分量不画框，故不出现在这里） */
  groups: MemoryGraphLayoutGroup[];
  /** 孤立区整体包围盒（画底板 + 「未连接（N）」标题）；无孤立节点时为 null */
  orphanRegion: MemoryGraphLayoutRect | null;
  width: number;
  height: number;
}

/** 组内的列数（把 n 个盒子按 cols 列排开需要的行数） */
function rowCount(count: number, cols: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, cols)));
}

/** 一行的宽度：n 个盒子 + n-1 个间距 */
function rowWidth(count: number): number {
  if (count <= 0) return 0;
  return count * MEMORY_GRAPH_NODE_W + (count - 1) * MEMORY_GRAPH_GAP_X;
}

/**
 * 节点排序键（**全显式**，不依赖 Map 遍历序）。
 *
 * 时间用字符串比较：引擎给的是 RFC3339（同格式同长度），字典序等于时间序；
 * 转 Date 再比会引入时区/解析歧义（`createdAt` 缺失时更会得到 NaN 比较）。
 */
function compareNodes(a: MemoryViewGraphNode, b: MemoryViewGraphNode): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.memory_id !== b.memory_id) return a.memory_id < b.memory_id ? -1 : 1;
  return 0;
}

/**
 * 边的修剪端点：中心连线与**节点盒矩形**求交，两端各裁到盒边界。
 *
 * 为什么裁：裸中心到中心的连线在节点之后渲染时，线头被埋在盒子里；要让箭头尖正好落在
 * 盒边上（而不是伸进盒内被节点 fill 盖住——节点画在边之后），端点必须先裁到边界。
 * 算法 = 参数化射线-矩形出界解：从中心出发，`t = min(hw/|dx|, hh/|dy|)`，两端对称。
 *
 * @param fromRect - 源节点盒（世界坐标左上角 + 尺寸）
 * @param toRect - 目标节点盒
 * @returns 修剪后的两端点；**退化例**（两盒同心，dx=dy=0）回落为中心点连线，不返回 null/NaN
 */
export function memoryGraphEdgeEndpoints(
  fromRect: { x: number; y: number; width: number; height: number },
  toRect: { x: number; y: number; width: number; height: number },
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const fromCenter = { x: fromRect.x + fromRect.width / 2, y: fromRect.y + fromRect.height / 2 };
  const toCenter = { x: toRect.x + toRect.width / 2, y: toRect.y + toRect.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (dx === 0 && dy === 0) return { from: fromCenter, to: toCenter };
  /** 从 from 中心指向 to 中心的射线，射出 from 盒的参数 t ∈ (0, 0.5] */
  const exitFrom = Math.min(
    fromRect.width / 2 / Math.max(Math.abs(dx), 1e-9),
    fromRect.height / 2 / Math.max(Math.abs(dy), 1e-9),
  );
  /** 对称地，从 to 中心指向 from 中心的射线射出 to 盒（即连线进入 to 盒的点） */
  const exitTo = Math.min(
    toRect.width / 2 / Math.max(Math.abs(dx), 1e-9),
    toRect.height / 2 / Math.max(Math.abs(dy), 1e-9),
  );
  return {
    from: { x: fromCenter.x + dx * exitFrom, y: fromCenter.y + dy * exitFrom },
    to: { x: toCenter.x - dx * exitTo, y: toCenter.y - dy * exitTo },
  };
}

/** 箭头尺寸基准（px，scale=1 时）：5 长 × 4 宽——相对 1.2px 的线不喧宾夺主 */
export const MEMORY_GRAPH_ARROW_LENGTH = 5;
export const MEMORY_GRAPH_ARROW_WIDTH = 4;

/**
 * 箭头 polygon 三点（**不用 `<marker>`**：marker 的 `userSpaceOnUse` 会随 `<g scale>` 缩放、
 * `strokeWidth` 会把箭头尺寸耦合进"提亮通道"——选中边时箭头翻倍，破坏通道分离 N10）。
 *
 * 尺寸按 `÷ scale` 反算 ⇒ 屏幕像素尺寸恒定（与 `non-scaling-stroke` 同一语义），
 * 且 scale 是显式参数 ⇒ 纯函数可单测。
 *
 * @param tip - 箭尖（世界坐标；调用方传 `memoryGraphEdgeEndpoints` 的 `to` 端 = 盒边界点）
 * @param angle - 边的方向角（`Math.atan2(dy, dx)`，从 from 指向 to）
 * @param scale - 当前缩放（`viewport.transform.scale`）
 * @returns 三点坐标字符串（`<polygon points>` 直接用）
 */
export function memoryGraphArrowhead(
  tip: { x: number; y: number },
  angle: number,
  scale: number,
): string {
  const safeScale = scale > 0 ? scale : 1;
  const length = MEMORY_GRAPH_ARROW_LENGTH / safeScale;
  const halfWidth = MEMORY_GRAPH_ARROW_WIDTH / 2 / safeScale;
  const backX = tip.x - Math.cos(angle) * length;
  const backY = tip.y - Math.sin(angle) * length;
  const perpX = -Math.sin(angle);
  const perpY = Math.cos(angle);
  const p1 = `${backX + perpX * halfWidth} ${backY + perpY * halfWidth}`;
  const p2 = `${backX - perpX * halfWidth} ${backY - perpY * halfWidth}`;
  return `${tip.x} ${tip.y} ${p1} ${p2}`;
}

/**
 * 计算关系图的确定性布局。
 *
 * 算法（三段，顺序即输出序）：
 * 1. **连通分量**：按无向邻接 DFS 分组（边按"两端点都在本次节点集内"过滤——跨页边引擎
 *    根本不返回，但"加载更多"后早期页的边可能指向新页节点，防御性过滤一遍）。
 * 2. **分量内分层**：`supersedes` 边（有向）做最长路径分层，同层按 createdAt 升序；
 *    坐标 = (层 → 列, 层内序 → 行)。分量的顺序 = 最早 createdAt → id（确定性）。
 * 3. **孤立区**：单节点分量按 kind 分组（`MEMORY_GRAPH_NODE_KINDS` 顺序，域外 kind 按名
 *    追加在后），组内按 createdAt 升序走网格；各组纵向堆叠，整体包一个包围盒。
 *
 * @param nodes - 已加载的节点（**过滤后**的可见集合）
 * @param edges - 已加载的边
 * @returns 布局结果（空输入时返回零尺寸空布局）
 */
export function layoutMemoryGraph(
  nodes: readonly MemoryViewGraphNode[],
  edges: readonly MemoryViewEdge[],
): MemoryGraphLayout {
  if (nodes.length === 0) {
    return { nodes: [], groups: [], orphanRegion: null, width: 0, height: 0 };
  }

  const byId = new Map(nodes.map((node) => [node.memory_id, node]));

  /** 无向邻接（连通分量用） + 有向 supersedes 前驱（分层用） */
  const adjacency = new Map<string, string[]>();
  const supersedesPreds = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, from: string, to: string) => {
    const list = map.get(from);
    if (list) list.push(to);
    else map.set(from, [to]);
  };
  for (const edge of edges) {
    // 端点不全在已加载集合里的边直接丢弃（防御性：跨页边引擎不返回，但追加页后
    // 早期页的边可能指向尚未加载的节点）
    if (!byId.has(edge.from_id) || !byId.has(edge.to_id)) continue;
    link(adjacency, edge.from_id, edge.to_id);
    link(adjacency, edge.to_id, edge.from_id);
    if (edge.type === 'supersedes') link(supersedesPreds, edge.to_id, edge.from_id);
  }

  /** 连通分量（迭代式 DFS；节点数上限 200，递归没必要） */
  const seen = new Set<string>();
  const components: MemoryViewGraphNode[][] = [];
  for (const node of nodes) {
    if (seen.has(node.memory_id)) continue;
    const component: MemoryViewGraphNode[] = [];
    const stack = [node.memory_id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const current = byId.get(id);
      if (current) component.push(current);
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    components.push(component);
  }

  /** 切分：size > 1 = 连通分量；size === 1 = 孤立节点（无边是常态，另有网格） */
  const connected = components
    .filter((component) => component.length > 1)
    .sort((a, b) => {
      const minA = a.reduce((acc, n) => (compareNodes(n, acc) < 0 ? n : acc), a[0]);
      const minB = b.reduce((acc, n) => (compareNodes(n, acc) < 0 ? n : acc), b[0]);
      return compareNodes(minA, minB);
    });
  const orphans = components
    .filter((component) => component.length === 1)
    .map((component) => component[0]);

  const layoutNodes: MemoryGraphLayoutNode[] = [];
  let cursorY = MEMORY_GRAPH_PADDING;
  let maxRight = 0;

  // ── 第一段：连通分量（每个分量一条横带；带内按 supersedes 层分列）──────────────
  connected.forEach((component, index) => {
    const groupId = `c${index}`;
    const ids = new Set(component.map((node) => node.memory_id));
    /** 最长路径分层：迭代松弛到稳定或触顶（环 = 脏数据，触顶后按当前值落位，不抛错） */
    const depth = new Map<string, number>();
    for (const node of component) depth.set(node.memory_id, 0);
    for (let round = 0; round < component.length; round++) {
      let changed = false;
      for (const node of component) {
        let next = 0;
        for (const pred of supersedesPreds.get(node.memory_id) ?? []) {
          if (!ids.has(pred)) continue;
          next = Math.max(next, (depth.get(pred) ?? 0) + 1);
        }
        if (next > (depth.get(node.memory_id) ?? 0)) {
          depth.set(node.memory_id, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
    /** 层 → 该层节点（层内 createdAt 升序，确定性） */
    const layers = new Map<number, MemoryViewGraphNode[]>();
    for (const node of component) {
      const level = depth.get(node.memory_id) ?? 0;
      const list = layers.get(level);
      if (list) list.push(node);
      else layers.set(level, [node]);
    }
    const levels = Array.from(layers.keys()).sort((a, b) => a - b);
    let bandBottom = cursorY;
    levels.forEach((level) => {
      const row = (layers.get(level) ?? []).slice().sort(compareNodes);
      row.forEach((node, index) => {
        const x = MEMORY_GRAPH_PADDING + level * (MEMORY_GRAPH_NODE_W + MEMORY_GRAPH_GAP_X);
        const y = cursorY + index * (MEMORY_GRAPH_NODE_H + MEMORY_GRAPH_GAP_Y);
        layoutNodes.push({ node, x, y, groupId });
        bandBottom = Math.max(bandBottom, y + MEMORY_GRAPH_NODE_H);
        maxRight = Math.max(maxRight, x + MEMORY_GRAPH_NODE_W);
      });
    });
    cursorY = bandBottom + MEMORY_GRAPH_BAND_GAP;
  });

  // ── 第二段：孤立区（按 kind 分组 → 组内网格 → 纵向堆叠 + 整体包围盒）──────────
  const groups: MemoryGraphLayoutGroup[] = [];
  let orphanRegion: MemoryGraphLayoutRect | null = null;
  if (orphans.length > 0) {
    const regionTop = connected.length > 0 ? cursorY + MEMORY_GRAPH_ORPHAN_GAP : cursorY;
    // kind 分组顺序：共享值域顺序在前，域外 kind 按字典序追加（确定性，不依赖引擎返回序）
    const known = new Set<string>(MEMORY_GRAPH_NODE_KINDS);
    const extraKinds = Array.from(
      new Set(orphans.map((node) => node.kind).filter((kind) => !known.has(kind))),
    ).sort();
    const kindOrder = [...MEMORY_GRAPH_NODE_KINDS, ...extraKinds];
    let groupY = regionTop + MEMORY_GRAPH_GROUP_HEADER_H;
    let regionWidth = 0;
    for (const kind of kindOrder) {
      const members = orphans.filter((node) => node.kind === kind).sort(compareNodes);
      if (members.length === 0) continue;
      const rows = rowCount(members.length, MEMORY_GRAPH_ORPHAN_COLS);
      const width = rowWidth(Math.min(members.length, MEMORY_GRAPH_ORPHAN_COLS));
      const height = rows * MEMORY_GRAPH_NODE_H + (rows - 1) * MEMORY_GRAPH_GAP_Y;
      members.forEach((node, index) => {
        const col = index % MEMORY_GRAPH_ORPHAN_COLS;
        const row = Math.floor(index / MEMORY_GRAPH_ORPHAN_COLS);
        layoutNodes.push({
          node,
          x: MEMORY_GRAPH_PADDING + col * (MEMORY_GRAPH_NODE_W + MEMORY_GRAPH_GAP_X),
          y: groupY + row * (MEMORY_GRAPH_NODE_H + MEMORY_GRAPH_GAP_Y),
          groupId: `orphan:${kind}`,
        });
      });
      groups.push({
        id: `orphan:${kind}`,
        kind,
        count: members.length,
        x: MEMORY_GRAPH_PADDING,
        y: groupY,
        width,
        height,
      });
      regionWidth = Math.max(regionWidth, width);
      groupY += height + MEMORY_GRAPH_BAND_GAP;
    }
    const regionHeight = groupY - MEMORY_GRAPH_BAND_GAP - regionTop;
    orphanRegion = {
      x: MEMORY_GRAPH_PADDING - MEMORY_GRAPH_PADDING / 2,
      y: regionTop,
      width: regionWidth + MEMORY_GRAPH_PADDING,
      height: regionHeight,
    };
    maxRight = Math.max(maxRight, orphanRegion.x + orphanRegion.width);
    cursorY = regionTop + regionHeight + MEMORY_GRAPH_PADDING;
  } else {
    // 无孤立区时把最后一条带的间距收回（否则底部多一截空白）
    cursorY =
      Math.max(cursorY - MEMORY_GRAPH_BAND_GAP, MEMORY_GRAPH_PADDING) + MEMORY_GRAPH_PADDING;
  }

  return {
    nodes: layoutNodes,
    groups,
    orphanRegion,
    width: Math.max(maxRight + MEMORY_GRAPH_PADDING, 1),
    height: Math.max(cursorY, 1),
  };
}
