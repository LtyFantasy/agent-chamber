/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**节点详情抽屉**：非模态右栏（无遮罩），展示单节点的全部本地派生信息
 *
 * [代码职责]
 *   - 内容**全部本地派生**自己加载的 `nodes` / `edges`：零请求（`relations` 就是就地过滤
 *     该节点的关联边）
 *   - 关闭时的焦点回归：按 `data-memory-id` 重新定位触发节点（翻页后 DOM 会重挂）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3（卡片基线）/§4（不独载语义）
 *   - 实现蓝本: plan §4.1「节点出口 = 详情抽屉」段 + N1/N4/N6/N13
 *
 * [关键不变量]
 *   - **非模态**（N1/M2）：无遮罩、不锁滚动、不 trap 焦点。模态遮罩会把画布整个盖住，
 *     "保图上下文"这条裁决理由就没了；`sheet.tsx` / `dialog.tsx` 都是全屏遮罩，**不可复用**
 *   - **内容次序 = label → 预览 → 关系 → meta**（机器值殿后）：人类首眼要的是"它说了什么、
 *     跟谁有关"，七行 meta 不该抢在正文前面（2026-10-11 走查修复批）
 *   - **预览去重仅判全等**（`preview.trim() === label.trim()`）：label 与 preview 是同一段
 *     正文的两个截断（前缀共享是构造必然），**前缀重叠不视为重复**；label 全量换行**不 clamp**
 *     （`title` 属性对键盘/触屏不可见，不是信息出口）
 *   - **零请求**（N6）：抽屉打开不发 axios。节点字段全在 graph 响应里，关系边也在——
 *     再打一次 detail 端点是拿延迟换一份已经到手的数据
 *   - **Esc 不在本组件里处理**：语义是"开→关抽屉，关→清选中"，两态归一个所有者（容器），
 *     分散监听会让同一次 Esc 触发两个动作
 *   - **关闭后焦点按 `memory_id` 重新定位**（N13）：点「加载更多」会让节点 DOM 重挂，
 *     直接聚焦旧元素引用会落到 `document.body` 上（Tab 序被打回页面开头）
 *   - `ledgerId` 为 null ⇒ 「打开完整详情」渲染成禁用说明而不是死链（映射缺失/来源不可见
 *     的节点本不该出现在图上，防御性兜底）
 *
 * [关联代码]
 *   - ./memory-graph-view.tsx — 挂载点（选中态、ledgerMapping、边集都由它传进来）
 *   - ./graph-labels.ts — kind / status / relation / anchor 文案的唯一映射
 *   - ../../app/(main)/memory/[id]/page.tsx — 「打开完整详情」的落点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增内容仍然零请求（数据都从 props 派生）
 *   □ 焦点回归必须先按 memory_id 查 DOM、再退回打开前的 activeElement
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { useDismissableLayer } from '@/lib/use-dismissable-layer';
import { memoryViewEdgeVisual, type MemoryViewEdge, type MemoryViewGraphNode } from '@/lib/memory';
import {
  memoryAnchorLabel,
  memoryKindLabel,
  memoryRelationLabel,
  memoryScopeLabel,
  memoryStatusLabelOf,
} from './graph-labels';
import { cn } from '@/lib/utils';

interface GraphNodeDrawerProps {
  node: MemoryViewGraphNode;
  /** 全部已加载的边（就地过滤出本节点的关联边；**不发请求**） */
  edges: readonly MemoryViewEdge[];
  /** 全部已加载的节点（关系列表里显示对端标签） */
  nodes: readonly MemoryViewGraphNode[];
  /** 本节点对应的账本行 id（来自 `ledgerMapping`；null = 钻取不可用） */
  ledgerId: string | null;
  /** 当前项目 id（拼详情页链接的 `?project=`） */
  projectId: string | null;
  /** 边集是否部分返回（`node_page.partial`）——关系列表要注明可能不完整 */
  relationsPartial: boolean;
  onClose: () => void;
}

/**
 * 节点详情抽屉（非模态右栏）。
 *
 * 布局：`w-80 shrink-0` 的在流右栏。**在流**而不是 `fixed` 覆盖：覆盖式右栏会压掉画布
 * 右侧一列节点却仍然让它们可被 Tab 聚焦（看不见但能聚焦 = 键盘用户的陷阱）。
 */
export function GraphNodeDrawer({
  node,
  edges,
  nodes,
  ledgerId,
  projectId,
  relationsPartial,
  onClose,
}: GraphNodeDrawerProps) {
  const t = useTranslations('memory');
  /*
    焦点回归：按 `memory_id` 重新定位触发节点（N13——点「加载更多」会让节点 DOM 重挂，
    直接聚焦打开时存下来的元素引用会落到 document.body 上，Tab 序被打回页面开头）。
    Esc 不在本组件里处理：语义是"开→关抽屉，关→清选中"，两态归容器统一持有。
  */
  useDismissableLayer({
    open: true,
    restoreFocusTo: () =>
      document.querySelector<HTMLElement>(`[data-memory-id="${node.memory_id}"]`),
  });

  /** 本节点的关联边（就地过滤，零请求）；对端标签从 nodes 查表 */
  const relations = useMemo(() => {
    const byId = new Map(nodes.map((item) => [item.memory_id, item]));
    return edges
      .filter((edge) => edge.from_id === node.memory_id || edge.to_id === node.memory_id)
      .map((edge) => {
        const outgoing = edge.from_id === node.memory_id;
        const otherId = outgoing ? edge.to_id : edge.from_id;
        const other = byId.get(otherId);
        return {
          id: edge.relation_id,
          type: edge.type,
          outgoing,
          otherLabel: other?.label ?? otherId,
          visual: memoryViewEdgeVisual(edge.type),
        };
      });
  }, [edges, node.memory_id, nodes]);

  const detailHref = ledgerId
    ? `/memory/${ledgerId}${projectId ? `?project=${projectId}` : ''}`
    : null;

  return (
    <aside
      aria-label={t('graph.drawer.title')}
      data-testid="memory-graph-drawer"
      className="glass-flat flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border/60 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t('graph.drawer.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          data-testid="memory-graph-drawer-close"
          title={t('graph.drawer.close')}
          aria-label={t('graph.drawer.close')}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/*
        label 全量换行、不 clamp：它是抽屉里唯一常驻渲染的 label 全文出口——
        `title` 属性对键盘/触屏用户不可见，不算出口（复核裁决）；空串不渲染。
      */}
      {node.label.trim().length > 0 && (
        <p className="text-sm font-medium leading-snug" data-testid="memory-graph-drawer-label">
          {node.label}
        </p>
      )}

      {/*
        预览去重 = **仅全等**：label 与 preview 本就是同一段正文的两个截断
        （fake 引擎 slice(0,80)/slice(0,160)），前缀重叠是构造必然、**不视为重复**；
        只有逐字全等（短内容）时预览节才冗余。
      */}
      {node.preview.trim().length > 0 && node.preview.trim() !== node.label.trim() && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('graph.drawer.preview')}</p>
          {/* 引擎给的预览是纯文本快照：pre-wrap 保行，与详情页正文同一手法 */}
          <p
            className="whitespace-pre-wrap break-words text-xs leading-relaxed"
            data-testid="memory-graph-drawer-preview"
          >
            {node.preview}
          </p>
        </div>
      )}

      <div className="space-y-1.5" data-testid="memory-graph-drawer-relations">
        <p className="text-xs text-muted-foreground">{t('graph.drawer.relations')}</p>
        {relationsPartial && (
          <p className="text-[11px] text-amber-300" data-testid="memory-graph-drawer-partial">
            {t('graph.drawer.relationsPartial')}
          </p>
        )}
        {relations.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('graph.drawer.relationsEmpty')}</p>
        ) : (
          <ul className="space-y-1">
            {relations.map((relation) => (
              <li key={relation.id} className="flex items-center gap-1.5 text-xs">
                <svg
                  aria-hidden="true"
                  width={16}
                  height={8}
                  viewBox="0 0 16 8"
                  className="shrink-0"
                >
                  <line
                    x1={0}
                    y1={4}
                    x2={16}
                    y2={4}
                    strokeWidth={1.6}
                    strokeDasharray={relation.visual.dash ?? undefined}
                    className={cn(relation.visual.stroke)}
                  />
                </svg>
                <span className="text-muted-foreground">
                  {relation.outgoing ? '→' : '←'} {memoryRelationLabel(t, relation.type)}
                </span>
                <span className="min-w-0 flex-1 truncate">{relation.otherLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        meta 放最后：人类首眼要的是「它说了什么、跟谁有关」，七行机器值殿后。
        scope/分辨率走人话文案（裸机器值 `actor_private` / `R0 / R0` 读不出意思）。
      */}
      <dl className="space-y-1.5 text-xs" data-testid="memory-graph-drawer-meta">
        {[
          { key: 'kind', label: t('graph.drawer.kind'), value: memoryKindLabel(t, node.kind) },
          {
            key: 'status',
            label: t('graph.drawer.status'),
            value: memoryStatusLabelOf(t, node.status),
          },
          { key: 'scope', label: t('graph.drawer.scope'), value: memoryScopeLabel(t, node.scope) },
          {
            key: 'resolution',
            label: t('graph.drawer.resolution'),
            value: t('graph.drawer.resolutionValue', {
              active: node.active_resolution,
              available: node.available_resolution,
            }),
          },
          {
            key: 'anchor',
            label: t('graph.drawer.anchor'),
            value: memoryAnchorLabel(t, node.anchor_state),
          },
          {
            key: 'boundary',
            label: t('graph.drawer.boundary'),
            value: node.boundary ? t('graph.drawer.yes') : t('graph.drawer.no'),
          },
          {
            key: 'confidence',
            label: t('graph.drawer.confidence'),
            value: node.confidence_present
              ? t('graph.drawer.confidencePresent')
              : t('graph.drawer.confidenceAbsent'),
          },
        ].map((row) => (
          <div key={row.key} className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 flex-1 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>

      {detailHref ? (
        <Link
          href={detailHref}
          data-testid="memory-graph-drawer-open-detail"
          className="inline-flex items-center justify-center rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {t('graph.drawer.openDetail')}
        </Link>
      ) : (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="memory-graph-drawer-no-ledger"
        >
          {t('graph.drawer.noLedger')}
        </p>
      )}
    </aside>
  );
}
