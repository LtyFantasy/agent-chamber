/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 关系图的**容器**：cursor 累积分页 + 三态 + 治理条 + snapshot 状态条 + 抽屉接线
 *
 * [代码职责]
 *   - 唯一的数据所有者：query（`refetchOnWindowFocus:false, retry:1`）+ 累积页 state
 *     + 选中态；画布与抽屉都是纯展示
 *   - 把"平台计数 + 引擎计数"合并成**一条**治理条（不并排四条横幅）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §2.2（告警条写法）/§5（动效）
 *   - 实现蓝本: plan §4.1「memory-graph-view.tsx 容器」段 + N2/N3/N6/N11/N18
 *
 * [关键不变量]
 *   - **cursor 存 ref 不入 queryKey**：cursor 同时绑 `snapshot_digest` 与 `query_digest`，
 *     进 key 会让"同一份数据"分裂成 N 个缓存条目，也会让过滤器元组失去"清空累积页"的语义
 *   - **过滤器元组变更 = 新数据集**：清空 cursor 与累积页 + 关抽屉 + 重跑 auto-fit（由画布的
 *     `datasetKey` 承接）。少了清空，携旧 cursor 打新过滤器会被引擎拒成 400 invalid_argument
 *   - **任何带 cursor 的分页请求收到 502/14004 → 丢弃累积页 + 重拉第一页**（谓词只看 HTTP 码
 *     与业务码，**不看 engineCode**）；且**只对带 cursor 的请求生效**——否则首页失败会与
 *     重置互相触发成死循环
 *   - **重置期间不得退化成空态**：判据是 `firstPageLoaded && !resetPending && nodes === 0`。
 *     少了 `resetPending`，重置（清累积页 → 重拉）会被渲染分支早退成「还没有引擎记忆」，
 *     把状态条/治理条/画布整棵换掉、`transform` 销毁，恰好与 plan「保留画布 transform」相反
 *   - **在途光标标记在成功响应后必须复位**：不复位会让"翻过页之后"的任何 refetch 都一直
 *     显示 Loading 并禁用「加载更多」
 *   - **换项目由挂载点的 `key` 负责**（见 graph/page.tsx）：项目不在 `datasetKey` 里
 *   - **节点 / 边 / `ledgerMapping` 三者同步累积**（N3）：只累积节点会让早期页的节点点不开详情
 *   - **抽屉内容零请求**（N6）：关系边就地过滤已加载的 edges
 *   - **Esc 只有一个所有者**（N1）：本容器监听；语义 = 有选中就清选中（抽屉开关与选中态同源，
 *     故"关抽屉"与"清选中"是同一个动作）
 *   - 重置反馈走**双通道但只播一次**（N18）：toast 首次一次 + 状态条常驻到下一次成功请求
 *
 * [关联代码]
 *   - ./memory-graph-canvas.tsx — 画布（布局与视口在它里面）
 *   - ./graph-node-drawer.tsx — 节点抽屉（非模态右栏）
 *   - ../../lib/memory.ts — 累积合并 / 错误分叉 / 重置谓词的唯一实现
 *   - ../../app/(main)/memory/graph/page.tsx — 挂载点（项目上下文与 URL 过滤器）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增请求仍带 retry / refetchOnWindowFocus 的显式配置
 *   □ 新增"重置"路径必须同时清 cursor 与累积页，且不会与首屏失败互相触发
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { MemoryEngineBanner } from '@/components/memory/engine-status';
import { toast } from '@/lib/notify';
import {
  emptyMemoryGraphPages,
  memoryErrorKind,
  memoryGraphLedgerId,
  memoryUnavailableReasonKind,
  memoryUnavailableReasonOf,
  memoryViewErrorKind,
  memoryViewNeedsReset,
  memoryViewResetKind,
  mergeMemoryGraphPages,
  type MemoryGraphFilters,
  type MemoryGraphPages,
} from '@/lib/memory';
import { MemoryGraphCanvas } from './memory-graph-canvas';
import { GraphNodeDrawer } from './graph-node-drawer';

interface MemoryGraphViewProps {
  projectId: string;
  filters: MemoryGraphFilters;
  /** 回记忆账本的动作（错误态 / 空态 / 不可读态都用它） */
  onBack: () => void;
}

/**
 * 关系图容器。
 *
 * @param projectId - 记忆项目 id（页面已从 URL / 列表首项解析好）
 * @param filters - kind / status / relation_type（由页面从 URL 解析，进 `datasetKey`）
 * @param backHref - 回账本的 href（错误态出口）
 * @param onBack - 回账本的动作（`router.push(backHref)`）
 */
export function MemoryGraphView({ projectId, filters, onBack }: MemoryGraphViewProps) {
  const t = useTranslations('memory');
  const [pages, setPages] = useState<MemoryGraphPages>(() => emptyMemoryGraphPages());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [governanceOpen, setGovernanceOpen] = useState(false);
  /** snapshot 重置状态条（常驻至下一次成功请求）；null = 不显示 */
  const [resetNotice, setResetNotice] = useState<{
    kind: 'stale' | 'other';
    code: string | null;
  } | null>(null);
  /** 重置时是否连带清了选中（状态条要说明"选中项已清除"） */
  const [resetClearedSelection, setResetClearedSelection] = useState(false);
  /**
   * 502 重置进行中（累积页已清、第一页在途）。
   *
   * 少了它，重置路径会在渲染分支里早退成「还没有引擎记忆」的空态——把状态条、治理条、
   * 画布整棵换掉，`transform` 随之销毁，恰好与 plan「保留画布 transform（不重挂组件）」
   * 相反；读者还会把"引擎刚出过错"读成"这里本来就空"。
   */
  const [resetPending, setResetPending] = useState(false);

  /** 下一页游标（**不入 queryKey**，见文件头不变量） */
  const cursorRef = useRef<string | undefined>(undefined);
  /** 本次在途请求是否带 cursor（决定 502 是否触发重置，防首屏失败与重置互相触发） */
  const requestedCursorRef = useRef(false);
  /** 重置后紧跟的那次重拉（消费掉它，让状态条活到再下一次成功请求） */
  const recoveryRef = useRef(false);
  /** 已播过重置 toast 的 engineCode（N18：双通道只播一次） */
  const toastedRef = useRef<string | null>(null);

  /** 数据集标识 = 过滤器元组（进画布的 auto-fit 判定） */
  const datasetKey = `${filters.kind ?? ''}|${filters.status ?? ''}|${filters.relationType ?? ''}`;
  const previousKeyRef = useRef(datasetKey);

  // 过滤器变更 = 新数据集：清 cursor + 清累积页 + 关抽屉（画布的 datasetKey 变化会重跑适配）
  useEffect(() => {
    if (previousKeyRef.current === datasetKey) return;
    previousKeyRef.current = datasetKey;
    cursorRef.current = undefined;
    requestedCursorRef.current = false;
    setPages(emptyMemoryGraphPages());
    setSelectedId(null);
    setResetNotice(null);
  }, [datasetKey]);

  const query = useQuery({
    queryKey: ['memory', 'graph', projectId, datasetKey],
    queryFn: () => Api.memory.graphView(projectId, filters, cursorRef.current),
    enabled: !!projectId,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  /**
   * 首屏是否**成功加载过**（`nodes.length === 0` 时区分"空项目"与"重置中/加载中"）。
   *
   * 直接派生自 `query.data !== undefined` 而不是自己维护一个 state：react-query 在
   * 重新取数期间保留最后一次 `data`，所以"有过 data"恰好等于"曾经成功过"，
   * 且比 state 少一次渲染延迟（不会先闪一帧空画布再换成空态）。
   */
  const firstPageLoaded = query.data !== undefined;

  // 累积合并（节点 / 边 / ledgerMapping 三者同步；见 lib/memory）
  useEffect(() => {
    // 先落到局部常量：`query.data` 的收窄不会穿过 setState 回调（可变引用），
    // 直接在里面用就得写 `as` 断言，那等于把类型系统关掉
    const page = query.data;
    if (!page) return;
    setPages((previous) => mergeMemoryGraphPages(previous, page));
    // 重置后的第一页已到 ⇒ 退出"重置中"（画布子树全程未卸载，transform 得以保留）
    setResetPending(false);
    // 在途标记复位：不复位会让"翻过页之后"的任何 refetch 都一直显示 Loading 并禁用「加载更多」
    requestedCursorRef.current = false;
    // 成功请求后收掉重置状态条：紧跟重置的那次重拉要放行（否则状态条刚出就被自己清掉）
    if (recoveryRef.current) recoveryRef.current = false;
    else setResetNotice(null);
  }, [query.data]);

  // 带 cursor 的分页 502/14004 → 丢弃累积页 + 重拉第一页 + 常驻状态条 + 首次 toast
  const refetch = query.refetch;
  useEffect(() => {
    if (!query.isError || !query.error) return;
    if (!memoryViewNeedsReset(query.error)) return;
    // 只对带 cursor 的请求生效：首屏就 502 时重置会与失败互相触发成死循环
    if (!requestedCursorRef.current) return;
    requestedCursorRef.current = false;
    cursorRef.current = undefined;
    recoveryRef.current = true;
    const kind = memoryViewErrorKind(query.error);
    const resetKind = memoryViewResetKind(kind.engineCode);
    setPages(emptyMemoryGraphPages());
    setResetPending(true);
    setSelectedId((current) => {
      setResetClearedSelection(current !== null);
      return null;
    });
    setResetNotice({ kind: resetKind, code: kind.engineCode });
    if (toastedRef.current !== kind.engineCode) {
      toastedRef.current = kind.engineCode;
      toast.error({
        title:
          resetKind === 'stale'
            ? t('graph.status.resetStale')
            : t('graph.status.resetOther', { code: kind.engineCode ?? kind.code ?? '-' }),
      });
    }
    void refetch();
  }, [query.isError, query.error, refetch, t]);

  /** 选中节点从新数据里消失（快照重置后的常态）→ 关闭抽屉并说明 */
  useEffect(() => {
    if (!selectedId) return;
    if (pages.nodes.some((node) => node.memory_id === selectedId)) return;
    setSelectedId(null);
    setResetClearedSelection(true);
  }, [pages.nodes, selectedId]);

  // Esc：单点所有者（有选中就清选中 —— 抽屉开关与选中态同源）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!selectedId) return;
      event.preventDefault();
      setSelectedId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  /** 首屏播放入场动效一次（`entrancePlayedRef` 先例；追加页 / 过滤器变更不重播） */
  const entrancePlayedRef = useRef(false);
  useEffect(() => {
    if (pages.nodes.length > 0) entrancePlayedRef.current = true;
  }, [pages.nodes.length]);

  const loadMore = useCallback(() => {
    const next = pages.nextCursor;
    if (!next) return;
    cursorRef.current = next;
    requestedCursorRef.current = true;
    void refetch();
  }, [pages.nextCursor, refetch]);

  const selectedNode = useMemo(
    () => pages.nodes.find((node) => node.memory_id === selectedId) ?? null,
    [pages.nodes, selectedId],
  );

  const errorKind = memoryErrorKind(query.error);
  const viewErrorKind = memoryViewErrorKind(query.error);

  // ── 三态 ────────────────────────────────────────────────────────────────────
  /*
    ⚠️ 两个早退都带 `!resetPending`（B3 残留修复）。
    重置在途期间（累积页已清、第一页重拉中）react-query 仍保留上一次的 `status`：
    失败的 cursor 请求让 `isError` 为真，于是**错误分支**会把整页替换成错误卡片
    ——状态条渲染不出、画布卸载、`transform`/`fitRef` 随之销毁，"保留画布 transform"
    这条 plan 契约再次落空。空态分支同理会走错，故两处对称加守卫。
  */
  if (query.isLoading && pages.nodes.length === 0 && !resetPending) {
    return (
      <div className="flex min-h-[560px] flex-1 flex-col gap-2" data-testid="memory-graph-loading">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="min-h-[560px] flex-1 rounded-lg" />
      </div>
    );
  }

  if (query.isError && pages.nodes.length === 0 && !resetPending) {
    // 403/1009（无内容读权限）与 503/14000（引擎不可用）各自独立成态；其余走通用错误
    if (errorKind.permissionDenied) {
      return (
        <div className="py-8" data-testid="memory-graph-unavailable">
          <EmptyState
            title={t('graph.unavailableTitle')}
            description={t('graph.unavailableDesc')}
            action={<Button onClick={onBack}>{t('graph.back')}</Button>}
          />
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 py-12" data-testid="memory-graph-error">
        {viewErrorKind.engineUnavailable ? (
          // 引擎不可用：文案复用 engine-status 的三分叉映射（与列表页横幅同一个来源）
          <MemoryEngineBanner
            kind={memoryUnavailableReasonKind(memoryUnavailableReasonOf(query.error))}
            runtime
            className="w-full"
          />
        ) : (
          <p className="text-sm text-destructive">{t('graph.errorTitle')}</p>
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('graph.retry')}
          </Button>
          <Button variant="outline" onClick={onBack}>
            {t('graph.back')}
          </Button>
        </div>
      </div>
    );
  }

  if (firstPageLoaded && !resetPending && pages.nodes.length === 0) {
    return (
      <div className="py-8" data-testid="memory-graph-empty">
        <EmptyState
          title={t('graph.canvas.noNodesTitle')}
          description={t('graph.canvas.noNodesDesc')}
          action={<Button onClick={onBack}>{t('graph.back')}</Button>}
        />
      </div>
    );
  }

  /** 治理条摘要：可见节点 / 可见边 + 两个"缺了多少"（只在 >0 时出） */
  const summary = t('graph.governance.summary', {
    nodes: pages.nodes.length,
    edges: pages.edges.length,
  });
  /** 引擎口径的省略边数（并入累积态取最大值；见 lib/memory 的 mergeMemoryGraphPages） */
  const omittedCount = pages.omittedEdgeCount;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex min-h-0 flex-1 gap-3">
        <MemoryGraphCanvas
          nodes={pages.nodes}
          edges={pages.edges}
          selectedId={selectedId}
          onSelect={setSelectedId}
          datasetKey={datasetKey}
          playEntrance={!entrancePlayedRef.current}
          hasMore={!!pages.nextCursor}
          loadingMore={query.isFetching && requestedCursorRef.current}
          onLoadMore={loadMore}
          truncated={pages.truncated}
          noteBar={
            pages.edges.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="memory-graph-no-edges-note">
                {t('graph.canvas.noEdgesNote')}
              </p>
            ) : undefined
          }
          governance={
            // 单条合并（N3）：四个数字 + 可展开明细，不并排四条横幅
            <section
              className="glass-flat space-y-1.5 rounded-md border border-border/60 p-2.5 text-xs"
              data-testid="memory-graph-governance"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span data-testid="memory-graph-governance-summary">
                  {summary}
                  {pages.filteredNodeCount > 0 &&
                    t('graph.governance.hiddenNodes', { count: pages.filteredNodeCount })}
                  {omittedCount > 0 && t('graph.governance.omittedEdges', { count: omittedCount })}
                </span>
                <button
                  type="button"
                  data-testid="memory-graph-governance-toggle"
                  aria-expanded={governanceOpen}
                  onClick={() => setGovernanceOpen((value) => !value)}
                  className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {governanceOpen ? (
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  )}
                  {t('graph.governance.toggle')}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('graph.governance.scopeNote')}</p>
              {governanceOpen && (
                <ul
                  className="space-y-1 text-[11px] text-muted-foreground"
                  data-testid="memory-graph-governance-details"
                >
                  {omittedCount > 0 && <li>{t('graph.governance.omittedDetail')}</li>}
                  {(pages.filteredNodeCount > 0 || pages.filteredEdgeCount > 0) && (
                    <li>{t('graph.governance.permissionNote')}</li>
                  )}
                  {pages.unmappedCount > 0 && <li>{t('graph.governance.suspectNote')}</li>}
                  {pages.truncated && <li>{t('graph.governance.truncatedNote')}</li>}
                  {pages.partial && <li>{t('graph.governance.partialNote')}</li>}
                </ul>
              )}
              {/* 信任框并入治理条尾部（P4；文案复用 memory.search.trustNote，禁新写第二份） */}
              <p
                className="text-[11px] text-muted-foreground"
                data-testid="memory-graph-trust-note"
              >
                {t('search.trustNote')}
              </p>
              {pages.unmappedCount > 0 && (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {t('search.engineDataSuspect')}
                </p>
              )}
            </section>
          }
          statusBanner={
            resetNotice ? (
              <div
                role="status"
                data-testid="memory-graph-reset-notice"
                data-kind={resetNotice.kind}
                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {resetNotice.kind === 'stale'
                    ? t('graph.status.resetStale')
                    : t('graph.status.resetOther', { code: resetNotice.code ?? '-' })}
                  {resetClearedSelection ? ` ${t('graph.status.cleared')}` : ''}
                </span>
              </div>
            ) : undefined
          }
        />
        {selectedNode && (
          <GraphNodeDrawer
            node={selectedNode}
            edges={pages.edges}
            nodes={pages.nodes}
            ledgerId={memoryGraphLedgerId(pages.ledgerMapping, selectedNode.memory_id)}
            projectId={projectId}
            relationsPartial={pages.partial}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
      {/* 错误但有旧数据：重置状态条已经说清楚，这里只补一个重试出口 */}
      {query.isError && pages.nodes.length > 0 && !resetNotice && (
        <div
          role="status"
          className="flex items-center gap-2 text-xs text-amber-300"
          data-testid="memory-graph-stale-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t('search.staleResults')}
          <Button variant="outline" size="sm" className="h-6 px-2" onClick={() => void refetch()}>
            {t('graph.retry')}
          </Button>
        </div>
      )}
    </div>
  );
}
