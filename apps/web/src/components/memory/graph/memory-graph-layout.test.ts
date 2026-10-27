/**
 * memory-graph-layout.test.ts — 关系图布局纯函数（plan §4.1 / §4.3 点名的六例）
 * + 视口几何三组（B4 回归）：auto-fit / 屏幕矩形 / LOD
 *
 * 覆盖：① 连通分量 ② 分量内 supersedes 分层 ③ 孤立节点按 kind×createdAt 网格
 * ④ 空图 ⑤ **无重叠**（节点盒两两不相交——布局最硬的一条）⑥ **Tab 序 = 输出序**。
 *
 * 为什么这些是纯函数单测而不是页面测试：200/600 密度档在 dev 种子（≤10 节点）上根本
 * 跑不出来（plan §9），布局正确性只能由纯函数承担；页面测试里再验一遍既慢又验不真。
 */

import {
  MEMORY_GRAPH_GAP_X,
  MEMORY_GRAPH_GROUP_LABEL_OFFSET,
  MEMORY_GRAPH_NODE_H,
  MEMORY_GRAPH_NODE_W,
  MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET,
  MEMORY_GRAPH_SCALE_MAX,
  MEMORY_GRAPH_SCALE_MIN,
  computeFitTransform,
  layoutMemoryGraph,
  memoryGraphArrowhead,
  memoryGraphEdgeEndpoints,
  memoryGraphLod,
  memoryGraphScreenRect,
} from './memory-graph-layout';
import type { MemoryViewEdge, MemoryViewGraphNode } from '@/lib/memory';

/** 节点夹具（只需布局消费的字段；其余给稳定默认值） */
function node(
  overrides: Partial<MemoryViewGraphNode> & { memory_id: string },
): MemoryViewGraphNode {
  return {
    kind: 'observation',
    scope: 'actor_private',
    status: 'active',
    active_resolution: 'R0',
    available_resolution: 'R0',
    label: 'label',
    preview: 'preview',
    label_resolution: 'R0',
    confidence_present: false,
    contradiction_count: 0,
    supersession_count: 0,
    anchor_state: 'fresh',
    boundary: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 边夹具 */
function edge(from: string, to: string, type: string, id = `${from}->${to}`): MemoryViewEdge {
  return {
    relation_id: id,
    from_id: from,
    to_id: to,
    type,
    created_at: '2026-10-01T00:00:00.000Z',
    audit_locator: { status: 'ok', journal_event_id: 'j', revision_id: 'r', mutation_id: 'm' },
  };
}

/** 两个节点盒是否相交（半开区间；共边不算重叠） */
function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
  w = MEMORY_GRAPH_NODE_W,
  h = MEMORY_GRAPH_NODE_H,
): boolean {
  const xOverlap = Math.min(a.x + w, b.x + w) - Math.max(a.x, b.x) > 0;
  const yOverlap = Math.min(a.y + h, b.y + h) - Math.max(a.y, b.y) > 0;
  return xOverlap && yOverlap;
}

describe('layoutMemoryGraph', () => {
  it('① 同一连通分量的节点共享一个 groupId，不同分量分开', () => {
    const nodes = [
      node({ memory_id: 'a' }),
      node({ memory_id: 'b' }),
      node({ memory_id: 'c' }),
      node({ memory_id: 'd' }),
    ];
    // a-b 相连；c-d 相连；四个节点 ⇒ 两个分量
    const layout = layoutMemoryGraph(nodes, [
      edge('a', 'b', 'supports'),
      edge('c', 'd', 'supports'),
    ]);
    const groups = new Set(layout.nodes.map((item) => item.groupId));
    expect(groups.size).toBe(2);
    expect(layout.nodes.find((item) => item.node.memory_id === 'a')?.groupId).toBe(
      layout.nodes.find((item) => item.node.memory_id === 'b')?.groupId,
    );
    expect(layout.nodes.find((item) => item.node.memory_id === 'c')?.groupId).not.toBe(
      layout.nodes.find((item) => item.node.memory_id === 'a')?.groupId,
    );
  });

  it('② supersedes 边把**被取代者**（to 端）推到下一列（同列 x 相同、跨列 x 递增）', () => {
    // 方向语义（双源实证）：supersedes 的 from=新版（取代者）、to=旧版（被取代者）——
    // hument `memory_corrections.go`（NewMemoryID→from / OldMemoryID→to）+ `fake.engine.ts` 注释。
    // 故分层后**新版在左、旧版在右**，画布箭头指向右（to 端）。fixture 不许写反：
    // 写反等于教后来人「old 取代 new」，方向断言会跟着错（2026-10-11 复核发现旧 fixture 写反）。
    const newer = node({ memory_id: 'new', created_at: '2026-10-02T00:00:00.000Z' });
    const older = node({ memory_id: 'old', created_at: '2026-10-01T00:00:00.000Z' });
    const layout = layoutMemoryGraph([newer, older], [edge('new', 'old', 'supersedes')]);
    const oldItem = layout.nodes.find((item) => item.node.memory_id === 'old');
    const newItem = layout.nodes.find((item) => item.node.memory_id === 'new');
    expect(oldItem && newItem).toBeTruthy();
    expect(oldItem!.x).toBe(newItem!.x + MEMORY_GRAPH_NODE_W + MEMORY_GRAPH_GAP_X);
    expect(oldItem!.y).toBe(newItem!.y);
  });

  it('③ 孤立节点按 kind 分组，各组有包围盒且不互相重叠', () => {
    const layout = layoutMemoryGraph(
      [
        node({ memory_id: 'o1', kind: 'observation', created_at: '2026-10-03T00:00:00.000Z' }),
        node({ memory_id: 'o2', kind: 'observation', created_at: '2026-10-01T00:00:00.000Z' }),
        node({ memory_id: 'c1', kind: 'concept', created_at: '2026-10-02T00:00:00.000Z' }),
      ],
      [],
    );
    expect(layout.groups.map((group) => group.kind)).toEqual(['observation', 'concept']);
    expect(layout.orphanRegion).not.toBeNull();
    // 组内按 createdAt 升序：o2（10-01）在 o1（10-03）之前
    const first = layout.nodes.find((item) => item.node.memory_id === 'o2');
    const second = layout.nodes.find((item) => item.node.memory_id === 'o1');
    expect(first!.x).toBeLessThan(second!.x);
    // 组间纵向分离：concept 组的 y 在 observation 组之外
    const observation = layout.groups[0];
    const concept = layout.groups[1];
    expect(concept.y).toBeGreaterThanOrEqual(observation.y + observation.height);
  });

  it('④ 空图返回零尺寸空布局（不抛错）', () => {
    const layout = layoutMemoryGraph([], []);
    expect(layout).toEqual({ nodes: [], groups: [], orphanRegion: null, width: 0, height: 0 });
  });

  it('⑤ 节点盒两两不相交（含跨分量 / 跨孤立组 / 孤立与分量之间）', () => {
    const nodes = [
      node({ memory_id: 'a', created_at: '2026-10-01T00:00:00.000Z' }),
      node({ memory_id: 'b', created_at: '2026-10-02T00:00:00.000Z' }),
      node({ memory_id: 'c', created_at: '2026-10-03T00:00:00.000Z' }),
      node({ memory_id: 'd', kind: 'belief', created_at: '2026-10-04T00:00:00.000Z' }),
      node({ memory_id: 'e', kind: 'belief', created_at: '2026-10-05T00:00:00.000Z' }),
      node({ memory_id: 'f', kind: 'procedure', created_at: '2026-10-06T00:00:00.000Z' }),
    ];
    // a-b-c 一个分量（两条 supersedes）；d/e/f 孤立
    const layout = layoutMemoryGraph(nodes, [
      edge('a', 'b', 'supersedes'),
      edge('b', 'c', 'supersedes'),
    ]);
    expect(layout.nodes).toHaveLength(6);
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        expect(overlaps(layout.nodes[i], layout.nodes[j])).toBe(false);
      }
    }
    // 包围盒也必须容得下所有节点
    for (const item of layout.nodes) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.x + MEMORY_GRAPH_NODE_W).toBeLessThanOrEqual(layout.width);
      expect(item.y + MEMORY_GRAPH_NODE_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it('⑥ Tab 序 = 输出序：分量序 → 分量内层序 → createdAt 升序 → id 升序 → 孤立组序', () => {
    const nodes = [
      // 分量 1（created_at 更早 ⇒ 排在前面）：两层
      node({ memory_id: 'a1', created_at: '2026-10-01T00:00:00.000Z' }),
      node({ memory_id: 'a2', created_at: '2026-10-02T00:00:00.000Z' }),
      // 分量 2（created_at 更晚）：单层两节点，同 created_at ⇒ 按 id
      node({ memory_id: 'b2', created_at: '2026-10-05T00:00:00.000Z' }),
      node({ memory_id: 'b1', created_at: '2026-10-05T00:00:00.000Z' }),
      // 孤立：observation 在前（值域顺序），episode 在后
      node({ memory_id: 'o1', kind: 'observation', created_at: '2026-10-07T00:00:00.000Z' }),
      node({ memory_id: 'e1', kind: 'episode', created_at: '2026-10-07T00:00:00.000Z' }),
    ];
    const layout = layoutMemoryGraph(nodes, [
      edge('a1', 'a2', 'supersedes'),
      edge('b1', 'b2', 'supports'),
    ]);
    expect(layout.nodes.map((item) => item.node.memory_id)).toEqual([
      'a1',
      'a2',
      'b1',
      'b2',
      'o1',
      'e1',
    ]);
  });

  it('⑦ 域外 kind 的孤立节点不丢：按字典序追加在已知 kind 之后', () => {
    const layout = layoutMemoryGraph(
      [node({ memory_id: 'z1', kind: 'zzz_new_kind' }), node({ memory_id: 'k1', kind: 'concept' })],
      [],
    );
    expect(layout.groups.map((group) => group.kind)).toEqual(['concept', 'zzz_new_kind']);
    expect(layout.nodes).toHaveLength(2);
  });

  it('⑧ 指向未加载节点的边被丢弃（不产生幽灵节点、不影响布局）', () => {
    const layout = layoutMemoryGraph([node({ memory_id: 'a' })], [edge('a', 'ghost', 'supports')]);
    expect(layout.nodes).toHaveLength(1);
    // 只有 a 一个节点且边被丢弃 ⇒ a 是孤立节点（进孤立区）
    expect(layout.orphanRegion).not.toBeNull();
    expect(layout.groups[0].kind).toBe('observation');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 视口几何（B4：viewBox 改成容器像素空间后，auto-fit / 屏幕矩形 / LOD 三件几何
// 必须由**纯函数**承担——它们是"画布看起来对不对"的全部依据，且真机小数据看不出错）
// ══════════════════════════════════════════════════════════════════════════

describe('computeFitTransform（auto-fit 几何）', () => {
  it('内容大于容器：缩放后内容**完整落在容器内**且居中', () => {
    const content = { width: 2000, height: 1000 };
    const viewport = { width: 800, height: 600 };
    const next = computeFitTransform(content, viewport);
    expect(next).not.toBeNull();
    const { scale, x, y } = next!;
    // 不放大 + 钳制下界
    expect(scale).toBeLessThanOrEqual(1);
    expect(scale).toBeGreaterThanOrEqual(MEMORY_GRAPH_SCALE_MIN);
    // 完整可见：内容映射后的右/下边界都在容器内（含左右留白非负）
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + content.width * scale).toBeLessThanOrEqual(viewport.width + 0.001);
    expect(y + content.height * scale).toBeLessThanOrEqual(viewport.height + 0.001);
    // 居中：两侧留白相等
    expect(x).toBeCloseTo((viewport.width - content.width * scale) / 2, 6);
    expect(y).toBeCloseTo((viewport.height - content.height * scale) / 2, 6);
  });

  it('内容小于容器：**不放大**（scale = 1）且居中', () => {
    const next = computeFitTransform({ width: 200, height: 100 }, { width: 800, height: 600 });
    expect(next!.scale).toBe(1);
    expect(next!.x).toBe(300);
    expect(next!.y).toBe(250);
  });

  it('极端比例：缩放下界**钳制在 0.2**（描边有 non-scaling-stroke 兜底）', () => {
    const next = computeFitTransform({ width: 100000, height: 10 }, { width: 800, height: 600 });
    // 容器/内容 = 0.008 会被钳到下界——不钳的话内容缩成一个点，线型与文字全部失效
    expect(800 / 100000).toBeLessThan(MEMORY_GRAPH_SCALE_MIN);
    expect(next!.scale).toBe(MEMORY_GRAPH_SCALE_MIN);
    // 钳制只影响缩放，居中公式照旧（可能溢出容器，那是极端数据的必然）
    expect(next!.x).toBeCloseTo((800 - 100000 * MEMORY_GRAPH_SCALE_MIN) / 2, 6);
  });

  it('退化输入（容器或内容尺寸 ≤ 0）→ null，不给 0 尺寸假变换', () => {
    expect(computeFitTransform({ width: 100, height: 100 }, { width: 0, height: 600 })).toBeNull();
    expect(computeFitTransform({ width: 100, height: 100 }, { width: 800, height: 0 })).toBeNull();
    expect(computeFitTransform({ width: 0, height: 0 }, { width: 800, height: 600 })).toBeNull();
  });

  it('缩放的钳制上界与常量同源（容器远大于内容时也不会超过上限）', () => {
    const next = computeFitTransform({ width: 1, height: 1 }, { width: 99999, height: 99999 });
    expect(next!.scale).toBeLessThanOrEqual(MEMORY_GRAPH_SCALE_MAX);
  });
});

describe('memoryGraphScreenRect（焦点跟随的可见性判据）', () => {
  it('世界坐标 → 屏幕坐标：平移与缩放都算进去', () => {
    const rect = memoryGraphScreenRect({ x: 100, y: 50 }, { scale: 2, x: -30, y: 10 });
    expect(rect.left).toBe(170);
    expect(rect.top).toBe(110);
    expect(rect.right).toBe(170 + MEMORY_GRAPH_NODE_W * 2);
    expect(rect.bottom).toBe(110 + MEMORY_GRAPH_NODE_H * 2);
  });

  it('缩放 1、无平移时退化为恒等映射（首屏未 fit 前的默认态）', () => {
    const rect = memoryGraphScreenRect({ x: 12, y: 34 }, { scale: 1, x: 0, y: 0 });
    expect(rect.left).toBe(12);
    expect(rect.top).toBe(34);
  });
});

describe('memoryGraphLod（zoom-LOD 三档）', () => {
  it('三档与两个阈值边界都钉死', () => {
    expect(memoryGraphLod(0.2)).toBe('shape');
    expect(memoryGraphLod(0.49)).toBe('shape');
    // 阈值本身归下一档（>= 判定）
    expect(memoryGraphLod(0.5)).toBe('label');
    expect(memoryGraphLod(0.99)).toBe('label');
    expect(memoryGraphLod(1)).toBe('full');
    expect(memoryGraphLod(2.5)).toBe('full');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 边几何（2026-10-11 走查修复批）：端点修剪 + 箭头 polygon + 孤立区标签间距。
// 全部是纯函数——画布只渲染，几何正确性在这里钉死。
// ══════════════════════════════════════════════════════════════════════════

describe('memoryGraphEdgeEndpoints（端点裁到盒边界）', () => {
  /** 标准节点盒：140×56，给左上角 */
  const rect = (x: number, y: number) => ({
    x,
    y,
    width: MEMORY_GRAPH_NODE_W,
    height: MEMORY_GRAPH_NODE_H,
  });

  it('水平相邻：from 出右边界、to 入左边界（y 恒为中线）', () => {
    const { from, to } = memoryGraphEdgeEndpoints(rect(0, 0), rect(172, 0));
    expect(from).toEqual({ x: 140, y: 28 });
    expect(to).toEqual({ x: 172, y: 28 });
  });

  it('垂直相邻：from 出下边界、to 入上边界', () => {
    const { from, to } = memoryGraphEdgeEndpoints(rect(0, 0), rect(0, 84));
    expect(from.x).toBeCloseTo(70, 6);
    expect(from.y).toBeCloseTo(56, 6);
    expect(to.x).toBeCloseTo(70, 6);
    expect(to.y).toBeCloseTo(84, 6);
  });

  it('对角：两端都落在盒边界上（from 下边、to 上边）', () => {
    const { from, to } = memoryGraphEdgeEndpoints(rect(0, 0), rect(172, 84));
    // 中心 (70,28)→(242,112)：dx=172, dy=84；t = min(70/172, 28/84) = 1/3 ⇒ 从下边出、从上边入
    expect(from.y).toBeCloseTo(56, 6);
    expect(from.x).toBeCloseTo(70 + 172 / 3, 6);
    expect(to.y).toBeCloseTo(84, 6);
    expect(to.x).toBeCloseTo(242 - 172 / 3, 6);
  });

  it('同层反向（to 在 from 左侧）：from 出左边界、to 入右边界', () => {
    const { from, to } = memoryGraphEdgeEndpoints(rect(172, 0), rect(0, 0));
    expect(from).toEqual({ x: 172, y: 28 });
    expect(to).toEqual({ x: 140, y: 28 });
  });

  it('退化：两盒同心（dx=dy=0）回落中心连线，不返回 null/NaN', () => {
    const { from, to } = memoryGraphEdgeEndpoints(rect(10, 10), rect(10, 10));
    expect(from).toEqual({ x: 80, y: 38 });
    expect(to).toEqual({ x: 80, y: 38 });
    expect(Number.isNaN(from.x) || Number.isNaN(to.y)).toBe(false);
  });
});

describe('memoryGraphArrowhead（箭头 polygon）', () => {
  /** points 字符串 → 三个坐标点 */
  function parsePoints(points: string): { x: number; y: number }[] {
    const nums = points.trim().split(/\s+/).map(Number);
    return [
      { x: nums[0], y: nums[1] },
      { x: nums[2], y: nums[3] },
      { x: nums[4], y: nums[5] },
    ];
  }

  it('向右的边：箭尖是 (tip)，两个底点落后 5px 且上下对称 4px 宽', () => {
    const [tip, p1, p2] = parsePoints(memoryGraphArrowhead({ x: 100, y: 50 }, 0, 1));
    expect(tip).toEqual({ x: 100, y: 50 });
    expect(p1.x).toBeCloseTo(95, 6);
    expect(p2.x).toBeCloseTo(95, 6);
    expect(Math.abs(p1.y - p2.y)).toBeCloseTo(4, 6); // 宽 4
    expect((p1.y + p2.y) / 2).toBeCloseTo(50, 6); // 底边中线对正边线
  });

  it('屏幕尺寸与 zoom 解耦：scale=2 时世界坐标尺寸 ÷2（屏幕像素恒定）', () => {
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    /** 底边中点（两个底点的均值）——箭长 = 箭尖到底边中点的距离 */
    const baseMid = (pts: { x: number; y: number }[]) => ({
      x: (pts[1].x + pts[2].x) / 2,
      y: (pts[1].y + pts[2].y) / 2,
    });
    const atScale1 = parsePoints(memoryGraphArrowhead({ x: 100, y: 50 }, Math.PI / 2, 1));
    const atScale2 = parsePoints(memoryGraphArrowhead({ x: 100, y: 50 }, Math.PI / 2, 2));
    expect(dist(atScale1[0], baseMid(atScale1))).toBeCloseTo(5, 6);
    expect(dist(atScale2[0], baseMid(atScale2))).toBeCloseTo(2.5, 6);
    // 方向：向下的边（angle=π/2），底点在箭尖上方
    expect(atScale1[1].y).toBeLessThan(atScale1[0].y);
  });
});

describe('孤立区标题/组标签间距（P1-4 回归：两行文字不得再相撞）', () => {
  it('标题 baseline 与首组标签 baseline 间距 ≥ 12px（两端都由导出常量算出）', () => {
    const layout = layoutMemoryGraph([node({ memory_id: 'o1' })], []);
    expect(layout.orphanRegion).not.toBeNull();
    const titleBaseline = layout.orphanRegion!.y + MEMORY_GRAPH_ORPHAN_TITLE_BASELINE_OFFSET;
    const labelBaseline = layout.groups[0].y - MEMORY_GRAPH_GROUP_LABEL_OFFSET;
    expect(labelBaseline - titleBaseline).toBeGreaterThanOrEqual(12);
  });
});
