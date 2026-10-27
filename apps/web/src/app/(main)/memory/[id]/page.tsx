'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆账本行详情页（/memory/[id]）：正文 + 元信息 + 来源 + **更正链时间线**
 *
 * [代码职责]
 *   - 把"这一行"与"它在更正链里的位置"分开渲染：正文来自 `GET /memory/nominations/:id`
 *     （零副作用），链来自该项目账本列表的前若干页（D2 串链，纯元数据）
 *   - `?v=<ledgerId>` 承载"当前看的是哪个**版本**"（D8：用账本行 id 寻址，不用序号——
 *     cap 触顶或并发更正都会让序号漂移，用序号等于把"看的是哪一版"交给运气）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3/§4/§5
 *   - 实现蓝本: Memory web 二期 plan v2.1 §1 D2/D8/D10 + §5 第 20/26/27-33 条
 *   - 合同源: apps/backend/src/modules/memory/dto/memory-contract.ts
 *
 * [关键不变量]
 *   - **引擎投影（views 族）与账本/链三者互不 gate**：右栏新增的分辨率阶梯与版本历史来自
 *     `views/memories/:eid`，它只依赖本行的 `engineMemoryIds[0]`。把它挂在链查询上会让
 *     "看这条记忆的层级"依赖"链拉完了没"——拿主信息给增强信息做抵押
 *   - **本行没有引擎记忆（`engineMemoryIds` 为空）⇒ 两块显示说明且零请求**（F2）：
 *     withdrawn / no_memory / 未形成三种成因都是常态，给"重试"是死胡同
 *   - **正文/header 不 gate 于链查询**（第 33 条）：链是增强信息，链挂了/超时了正文照常渲染。
 *     把两者耦合会让"看一条记忆"依赖"拉全项目账本"，那是拿正文给链做抵押
 *   - **`?project=` 与响应 `projectId` 比对以响应为准**（第 33 条）：URL 参数只在响应到达前
 *     当占位。参数写错项目会让链恒空（`correctionOf` 边跨项目不存在）——有链的记忆会被
 *     静默伪装成单版本，这正是"以响应为准"要防的错误
 *   - **`?v=` 指向链外节点**：正文照常 + 时间线注明「该版本不在当前链视图内」（第 31 条）
 *   - **`metadata` 投影是独立态，不是通用错误**（第 20 条）：治理观察者看得到行、看不到正文，
 *     给他"重试"是死胡同——要给"仅元数据可见 + 权限说明 + 返回账本"
 *   - **单版本记忆不画时间线**（第 32 条）：一条线的"版本树"是噪音
 *
 * [关联代码]
 *   - ../../lib/memory.ts — 类型镜像 / 错误分叉 / 字段存在性判定的唯一实现
 *   - ../../components/memory/correction-timeline.tsx — 链的渲染（含 D10 动效合规）
 *   - ../memory/page.tsx — 列表页（**键位刻意不同**：列表是 `['memory','nominations',...]`
 *     的分面查询、本页链是 `['memory','chain',projectId]`。链要的是"全项目取代关系图"，
 *     与列表的 tab/category 过滤语义相反，命中同一缓存只会互相污染——这里**不共用**）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增内容仍不 gate 于链查询
 *   □ 改链构建逻辑必须同步 [关键不变量] 的 cap/孤儿/自环三条处置
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { motion, MotionConfig, useReducedMotion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';
import { MEMORY_NOMINATION_STATUS } from '@agent-chamber/shared';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  MemoryCategoryChip,
  MemoryDeferredBadge,
  MemoryFormationStateBadge,
  MemoryMetadataBadge,
  MemoryStatusBadge,
} from '@/components/memory/memory-badges';
import { CorrectionTimeline, type MemoryChainView } from '@/components/memory/correction-timeline';
import { MemoryRecoveryNote } from '@/components/memory/memory-recovery-note';
import { ResolutionLadder } from '@/components/memory/resolution-ladder';
import { RepresentationHistory } from '@/components/memory/representation-history';
import { RepresentationBodyDialog } from '@/components/memory/representation-body-dialog';
import { fadeSlideUp } from '@/lib/animations';
import {
  MEMORY_CHAIN_MAX_PAGES,
  MEMORY_CHAIN_PAGE_SIZE,
  memoryErrorKind,
  memoryHasField,
  memoryIsMetadataProjection,
  memoryLadderActiveResolution,
  memoryNominatorLabel,
  memoryViewEngineMemoryCount,
  memoryViewEngineMemoryId,
  type MemoryNominationDto,
  type MemoryViewHistoryItem,
  type MemoryViewLadderSlot,
} from '@/lib/memory';
import { cn, formatDate, parseUuidParam } from '@/lib/utils';

export default function MemoryDetailPage() {
  const params = useParams<{ id: string }>();
  const rowId = params?.id ?? '';
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations('memory');
  const tCommon = useTranslations('common');
  const shouldReduce = useReducedMotion();

  const urlProject = parseUuidParam(searchParams.get('project'));
  const urlVersion = parseUuidParam(searchParams.get('v'));
  /** 当前展示的版本（`?v=` 优先；缺省 = 路由里的那一行） */
  const selectedId = urlVersion ?? rowId;

  /**
   * 正文/header 的唯一数据源（**零副作用**、不依赖链）。
   *
   * queryKey 用 `selectedId`：切版本 = 换一次详情请求；缓存按行 id 分开保存，
   * 来回切版本不会互相覆盖。
   */
  const detailQuery = useQuery({
    queryKey: ['memory', 'nomination', selectedId],
    queryFn: () => Api.memory.nomination(selectedId),
    enabled: !!selectedId,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const detail = detailQuery.data;
  /** 项目 id **以响应为准**（URL 仅在响应到达前当占位，见文件头不变量） */
  const projectId = detail?.projectId ?? urlProject;

  /**
   * 链查询（D2）：拉该项目**全部**账本行（不带 tab/category 过滤，pageSize=100 翻页，
   * cap 5 页，触顶标记不完整）。
   *
   * `enabled` 只看详情是否到达（而不是 `!!projectId`）：`?project=` 只是**加载前占位**，
   * 拿它去请求会让"参数错项目"时先打一次错误项目的账本（浪费一次请求，且那一瞬的链
   * 是另一个项目的——有链记忆会被伪装成别的形状）。等详情回来拿到响应里的 projectId
   * 再打，依赖顺序才是对的；正文不受影响（它只依赖详情）。
   *
   * `refetchOnWindowFocus:false` 是 D10 的取舍：链的变化会让 `layoutId` pill 在版本间横跳，
   * 干扰正在读正文的人；并发更正期间链可能陈旧 ⇒ 用时间线上的手动刷新入口兜底。
   */
  const chainQuery = useQuery({
    queryKey: ['memory', 'chain', projectId],
    queryFn: () => fetchChain(projectId as string),
    enabled: !!detail,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  /** 链视图（连通分量 + 主链排序 + withdrawn 单列 + 现行版本判定） */
  const chain = useMemo(
    (): MemoryChainView =>
      buildChain(
        chainQuery.data?.rows ?? [],
        rowId,
        selectedId,
        chainQuery.data?.truncated === true,
      ),
    [chainQuery.data, rowId, selectedId],
  );

  // ── 引擎投影（views 族）：与账本查询**互不 gate** ─────────────────────────────
  //
  // `?project=`/`?v=` 与链三者都不参与本查询的 gate：它是"这条记忆的引擎投影"，
  // 只依赖这一行自己的 `engineMemoryIds[0]`。把三者串起来会让"看一条记忆的层级"
  // 依赖"链拉完了没"，那是拿主信息给增强信息做抵押。
  //
  // `engineMemoryIds` 取 `[0]`：与 `completeCorrectionLink` 的兜底同口径（见 lib/memory）。
  // 空数组（withdrawn / no_memory / 未形成）⇒ enabled=false **零请求**，两块显示说明（F2）。
  const engineMemoryId = detail ? memoryViewEngineMemoryId(detail) : null;
  const engineMemoryCount = detail ? memoryViewEngineMemoryCount(detail) : 0;
  const viewQuery = useQuery({
    queryKey: ['memory', 'engine-view', projectId, engineMemoryId],
    queryFn: () => Api.memory.memoryView(projectId as string, engineMemoryId as string),
    enabled: !!projectId && !!engineMemoryId,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  /** 阶梯的 resolution 覆盖值（null = 跟随 detail 的 active 槽；点历史出口时被写死） */
  const [ladderResolution, setLadderResolution] = useState<string | null>(null);
  /** 版本历史块是否展开（默认折叠；点阶梯的槽会把它展开） */
  const [historyExpanded, setHistoryExpanded] = useState(false);
  /** 正文 Dialog 的二态（当前槽直给 / 历史条目按 id 取） */
  const [bodyDialog, setBodyDialog] = useState<
    | { kind: 'current'; slot: MemoryViewLadderSlot }
    | { kind: 'historical'; item: MemoryViewHistoryItem }
    | null
  >(null);

  const ladder = viewQuery.data?.engine.sections.representations.ladder ?? [];
  /** history 块默认 resolution = ladder 的 `active` 槽（N12；缺失回落 R0） */
  const activeResolution = memoryLadderActiveResolution(ladder) ?? 'R0';
  const selectedResolution = ladderResolution ?? activeResolution;

  /**
   * 右栏下钻态的**生命周期**（终审 nit）：沿更正链 A → B 跳转时路由不变、组件不重挂，
   * 于是 B 的版本历史块会带着 A 选过的 resolution、抽屉里可能还挂着 A 的正文。
   * 这些态描述的是"**这一行**的下钻位置"，行一换就必须归零。
   * 以 `selectedId`（= 当前看的是哪一版）为界，而不是 `engineMemoryId`——后者在两行都没有
   * 引擎记忆时都是 null，effect 不会重跑。
   */
  useEffect(() => {
    setLadderResolution(null);
    setHistoryExpanded(false);
    setBodyDialog(null);
  }, [selectedId]);

  /** 阶梯的历史出口：切到该 resolution 并展开历史块 */
  const openHistory = (resolution: string) => {
    setLadderResolution(resolution);
    setHistoryExpanded(true);
  };

  /**
   * `?v=` 指向链外节点：正文照常，时间线只做说明（第 31 条）。
   *
   * 判据 = 不在 `nodes` **也不在** `withdrawn`：被撤回的更正行确实不在主链上，
   * 但它就渲染在下方「未达成尝试」区里 ⇒ 说它"不在链视图内"是错的（读者一眼能看到它）。
   */
  const outsideChain =
    !!urlVersion &&
    chain.nodes.length + chain.withdrawn.length > 0 &&
    !chain.nodes.some((node) => node.id === urlVersion) &&
    !chain.withdrawn.some((node) => node.id === urlVersion);

  /** 选中版本（写 URL 用 **push**：位置语义，后退能回上一版，D11） */
  const selectVersion = (ledgerId: string) => {
    const next = new URLSearchParams(Array.from(searchParams.entries()));
    next.set('v', ledgerId);
    if (projectId) next.set('project', projectId);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const backHref = projectId ? `/memory?project=${projectId}` : '/memory';

  // ── 三态：加载 / 独立降级（403、404、metadata） / 通用错误 / 正常 ────────────────
  if (detailQuery.isLoading) {
    return (
      <div className="space-y-4 p-4 md:p-6" data-testid="memory-detail-loading">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  const errorKind = memoryErrorKind(detailQuery.error);

  if (detailQuery.isError && (errorKind.permissionDenied || errorKind.notFound)) {
    // 权限不足 / 行不存在：**独立态**（不是通用重试——重试这两者都还是同样的结果）
    return (
      <div className="p-4 md:p-6" data-testid="memory-detail-unavailable">
        <EmptyState
          title={t('detail.notFound')}
          description={t('detail.notFoundDesc')}
          action={<Button onClick={() => router.push(backHref)}>{t('detail.notFoundBack')}</Button>}
        />
      </div>
    );
  }

  if (detailQuery.isError || !detail) {
    return (
      <div
        className="flex flex-col items-center gap-3 p-4 py-12 md:p-6"
        data-testid="memory-detail-error"
      >
        <p className="text-sm text-destructive">{t('detail.errorTitle')}</p>
        <Button variant="outline" onClick={() => void detailQuery.refetch()}>
          {t('detail.retry')}
        </Button>
      </div>
    );
  }

  /** 治理白名单降级投影：看得见行、看不见正文（第 20 条：独立态，不是错误） */
  const metadataOnly = memoryIsMetadataProjection(detail);
  const nominator = memoryNominatorLabel({
    id: detail.nominatorId,
    name: detail.nominatorName,
    deletedAt: detail.nominatorDeletedAt,
    type: detail.nominatorType,
  });
  /** 复核到期 = 本地时间戳比较（与后端 `reviewBefore` 同一判据口径；仅提示，不改变可见性） */
  const reviewDue = !!detail.reviewAt && Date.parse(detail.reviewAt) <= Date.now();

  return (
    // 页面根包 MotionConfig reducedMotion="user"（第 34 条）
    <MotionConfig reducedMotion="user">
      <div className="space-y-4 p-4 md:p-6">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('detail.back')}
        </Link>

        {/*
          header 与正文同源（都来自 detailQuery）——**两者都不 gate 于链**（第 33 条）：
          链在下面独立 loading / error，正文不等它。
        */}
        <header className="space-y-2" data-testid="memory-detail-header">
          <div className="flex flex-wrap items-center gap-1.5">
            <MemoryCategoryChip category={detail.category} />
            <MemoryStatusBadge status={detail.status} />
            <MemoryFormationStateBadge state={detail.formationState} />
            {detail.deferred === true && <MemoryDeferredBadge />}
            {metadataOnly && <MemoryMetadataBadge />}
          </div>
          <h1 className="text-xl font-semibold leading-snug" data-testid="memory-detail-subject">
            {detail.subject ?? `${detail.category} · ${t('timeline.metadataNode')}`}
          </h1>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <div className="inline-flex gap-1.5">
              <dt>{t('nomination.ledgerId')}</dt>
              <dd className="font-mono" data-testid="memory-detail-ledger-id">
                {detail.id}
              </dd>
            </div>
            <div className="inline-flex gap-1.5">
              <dt>{t('nomination.createdAt')}</dt>
              <dd>{formatDate(detail.createdAt, locale)}</dd>
            </div>
            <div className="inline-flex gap-1.5">
              <dt>{t('nomination.updatedAt')}</dt>
              <dd>{formatDate(detail.updatedAt, locale)}</dd>
            </div>
            {detail.reviewAt && (
              <div className="inline-flex gap-1.5">
                <dt>{t('nomination.reviewAt')}</dt>
                {/* 到期用文字 + 图标双通道（颜色不独载语义） */}
                <dd className={cn(reviewDue && 'inline-flex items-center gap-1 text-amber-300')}>
                  {formatDate(detail.reviewAt, locale)}
                  {reviewDue && (
                    <>
                      <AlertTriangle className="h-3 w-3" />
                      {t('nomination.reviewDue')}
                    </>
                  )}
                </dd>
              </div>
            )}
          </dl>
        </header>

        {/* xl 以上两栏（正文 + 元信息/时间线），xl 以下单栏堆叠 */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            {metadataOnly ? (
              // 独立降级态（第 20 条）：说清"为什么看不到"和"下一步去哪"，不给重试
              <section
                className="glass-flat space-y-2 rounded-lg border border-border/60 p-4"
                data-testid="memory-detail-metadata-only"
              >
                <p className="text-sm font-medium">{t('detail.metadataOnlyTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('detail.metadataOnlyDesc')}</p>
                <p className="font-mono text-[11px] text-muted-foreground/70">
                  {t('detail.metadataOnlyHint', { id: detail.id })}
                </p>
                <Button variant="outline" size="sm" onClick={() => router.push(backHref)}>
                  {t('detail.metadataOnlyBack')}
                </Button>
              </section>
            ) : (
              <motion.article
                // key = 选中版本：切版本时内容区重播一次 fadeSlideUp（第 28/31 条）
                key={selectedId}
                variants={fadeSlideUp}
                initial={shouldReduce ? false : 'hidden'}
                animate="show"
                className="glass-flat rounded-lg border border-border/60 p-4"
              >
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                  {t('detail.content')}
                </h2>
                {/*
                  正文是**装配好的模板文本**（`[category] subject` + `范围:` + `生效/撤销:` +
                  `理由:` + 摘录区），行结构本身就是信息 ⇒ 用 pre-wrap 保行，不走 markdown
                  （markdown 会把单换行折叠成空格，把模板的行结构吃掉）
                */}
                {detail.content && detail.content.length > 0 ? (
                  <div
                    className="whitespace-pre-wrap break-words text-sm leading-relaxed"
                    data-testid="memory-detail-content"
                  >
                    {detail.content}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('detail.noContent')}</p>
                )}
              </motion.article>
            )}

            {/* 来源（仅 full 档）：locator / 标题路径 / 是否已变化 / 回查入口 */}
            {!metadataOnly && memoryHasField(detail, 'sources') && (
              <section
                className="glass-flat space-y-2 rounded-lg border border-border/60 p-4"
                data-testid="memory-detail-sources"
              >
                <h2 className="text-sm font-medium text-muted-foreground">{t('detail.sources')}</h2>
                {(detail.sources ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('detail.sourcesEmpty')}</p>
                ) : (
                  <ul className="space-y-2">
                    {(detail.sources ?? []).map((source, index) => (
                      <li
                        key={`${source.type}:${source.id}`}
                        className="space-y-0.5 text-xs"
                        data-testid="memory-detail-source"
                      >
                        <p className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {t('detail.sourceHeading', { index: index + 1 })}
                          </span>
                          <span className="font-mono text-[11px]">{source.locator}</span>
                          {source.moved && (
                            <span
                              className="text-amber-300"
                              data-testid="memory-detail-source-moved"
                            >
                              {t('detail.sourceMoved')}
                            </span>
                          )}
                        </p>
                        {source.headingPath && (
                          <p className="text-[11px] text-muted-foreground/80">
                            {source.headingPath}
                          </p>
                        )}
                        {/* 回查入口：正文是形成时快照，关键使用前要用这个工具回查当前版本 */}
                        <p className="text-[11px] text-muted-foreground/70">
                          {t('detail.sourceReadTool', { tool: source.readWith.tool })}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>

          <aside className="space-y-3">
            {/* 元信息（仅 full 档有 scope/effectiveNote） */}
            <section
              className="glass-flat space-y-2 rounded-lg border border-border/60 p-4 text-xs"
              data-testid="memory-detail-meta"
            >
              {!metadataOnly && (
                <>
                  <div>
                    <p className="text-muted-foreground">{t('detail.scope')}</p>
                    <p className="mt-1">{detail.scope || t('detail.none')}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">{t('detail.effectiveNote')}</p>
                    <p className="mt-1">{detail.effectiveNote || t('detail.none')}</p>
                  </div>
                </>
              )}
              <div>
                <p className="text-muted-foreground">{t('nominator.label')}</p>
                <p className="mt-1" data-testid="memory-detail-nominator">
                  {nominator.system
                    ? t('nominator.system')
                    : nominator.visible
                      ? nominator.name
                      : t('detail.none')}
                  {nominator.deleted && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                      {tCommon('deleted')}
                    </span>
                  )}
                </p>
              </div>
              {/*
                「提名记录」那类未终态行的**下一步出口**（第 26 条）：recoveryPath 的白名单
                映射与账本 id 出口统一实现在 memory-recovery-note（卡片与详情共用一份，
                禁两处各写）。
              */}
              {memoryHasField(detail, 'recoveryPath') && detail.recoveryPath && (
                // 详情页可以放复制按钮（不在"整卡链接"上下文里）——第 26 条的只读出口
                <MemoryRecoveryNote
                  recoveryPath={detail.recoveryPath}
                  ledgerId={detail.id}
                  copyable
                  testId="memory-detail-recovery"
                />
              )}
            </section>

            {/*
              右栏四段的次序钉死（N/M7）：meta（上）→ 分辨率阶梯 → 版本历史（默认折叠）→ 更正链。
              排序理由：前两块都是"**这条记忆自己**"（现在的层级状态、同层的旧版本），
              更正链是"**跨记忆**"的取代关系——把跨记忆的东西夹在同记忆的两块中间，
              读者会分不清"旧版本"与"被更正"（官方口径：这是两件事）。
            */}
            <ResolutionLadder
              loading={viewQuery.isLoading && !!engineMemoryId}
              error={viewQuery.error}
              ladder={ladder}
              hasEngineMemory={!!engineMemoryId}
              noEngineCause={metadataOnly ? 'metadataOnly' : 'notFormed'}
              engineMemoryCount={engineMemoryCount}
              onOpenCurrent={(slot) => setBodyDialog({ kind: 'current', slot })}
              onOpenHistory={openHistory}
              onRefresh={() => void viewQuery.refetch()}
            />

            <RepresentationHistory
              projectId={projectId ?? ''}
              engineMemoryId={engineMemoryId}
              noEngineCause={metadataOnly ? 'metadataOnly' : 'notFormed'}
              resolution={selectedResolution}
              onResolutionChange={setLadderResolution}
              expanded={historyExpanded}
              onExpandedChange={setHistoryExpanded}
              onOpenBody={(item) => setBodyDialog({ kind: 'historical', item })}
            />

            {/*
              更正链时间线：与正文**并行加载**（互不 gate）。
              链查询失败 → 时间线自己报错 + 手动刷新；正文毫发无损。
            */}
            <CorrectionTimeline
              chain={chain}
              selectedId={selectedId}
              outsideChain={outsideChain}
              loading={chainQuery.isLoading}
              isError={chainQuery.isError}
              onSelect={selectVersion}
              onRefresh={() => void chainQuery.refetch()}
            />

            {/* 链查询失败的补偿入口（时间线未渲染时也能刷——但只在真的有链查询且失败时给） */}
            {chainQuery.isError && chain.nodes.length === 0 && (
              <Button
                variant="outline"
                size="sm"
                data-testid="memory-detail-chain-refresh"
                onClick={() => void chainQuery.refetch()}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('timeline.retry')}
              </Button>
            )}
          </aside>
        </div>

        {/*
          正文 Dialog：两块共用一份实现（plan §4.2 N11）。
          当前槽 = `body` 直给（数据已在 detail 响应里 ⇒ **零请求**）；历史条目 = 按 id 取。
          `open=false` 时组件直接返回 null，故 `title` 里的空串兜底到不了渲染面。
        */}
        <RepresentationBodyDialog
          open={!!bodyDialog}
          onOpenChange={(next) => {
            if (!next) setBodyDialog(null);
          }}
          title={
            bodyDialog?.kind === 'current'
              ? t('representations.dialog.titleCurrent', { resolution: bodyDialog.slot.resolution })
              : t('representations.dialog.titleHistorical', {
                  createdAt: bodyDialog ? formatDate(bodyDialog.item.created_at, locale) : '',
                })
          }
          body={
            bodyDialog?.kind === 'current'
              ? {
                  text: bodyDialog.slot.current?.body ?? '',
                  truncated: bodyDialog.slot.current?.body_truncated ?? false,
                  bytes: bodyDialog.slot.current?.original_bytes ?? 0,
                }
              : undefined
          }
          fetchTarget={
            bodyDialog?.kind === 'historical' && engineMemoryId && projectId
              ? {
                  projectId,
                  engineMemoryId,
                  representationId: bodyDialog.item.representation_id,
                }
              : undefined
          }
        />
      </div>
    </MotionConfig>
  );
}

/**
 * 拉该项目**全部**账本行（串链原料）。
 *
 * 三条纪律（D2）：
 * - **不带 tab/category 过滤**：链要的是"这个项目的取代关系全图"，按 tab 过滤会让链断在
 *   中途（一条链的中间版本可能落在别的 tab 里）；
 * - `pageSize = MEMORY_CHAIN_PAGE_SIZE`（= 服务端上限）+ 从 1 页顺序翻；
 * - **cap `MEMORY_CHAIN_MAX_PAGES` 页**：触顶返回 `truncated:true`，界面必须显式说"链可能不完整"
 *   ——静默截断会让"现行版本"指向错误节点，那是**错误的治理结论**，不只是少画几条。
 *
 * @param projectId - 项目 id
 * @returns 已取到的行 + 是否触顶
 */
async function fetchChain(
  projectId: string,
): Promise<{ rows: MemoryNominationDto[]; truncated: boolean }> {
  const rows: MemoryNominationDto[] = [];
  let page = 1;
  while (page <= MEMORY_CHAIN_MAX_PAGES) {
    const response = await Api.memory.nominations(projectId, {
      page,
      pageSize: MEMORY_CHAIN_PAGE_SIZE,
    });
    rows.push(...response.items);
    // `total` 是裁剪前全量行数 ⇒ 取满即收手（不做无谓的下一页请求）
    if (rows.length >= response.total) return { rows, truncated: false };
    page += 1;
  }
  return { rows, truncated: true };
}

/**
 * 链视图构建（无向连通分量 + 主链排序 + withdrawn 单列 + 现行版本判定）。
 *
 * 为什么用**无向连通分量**而不是沿边单向走：单向走遇到"锚点在链中间"时要知道该往哪边走、
 * 遇到分叉（同一旧行有多个更正子行——withdrawn 释放唯一位后允许重建）会丢掉一支。
 * 连通分量天然包含锚点所在的整棵树，分叉只是让它变成"按时间排序的一串"，不会丢节点。
 *
 * 三条 fail-soft（D2）：`correctionOf` 指向未加载行（孤儿：源行被软删/超出 cap）→ 该行当作链根；
 * 自环（`correctionOf === id`，脏数据）→ 忽略该边；withdrawn 行**不进主链**，单列"未达成尝试"。
 *
 * @param rows - 该项目已加载的全部账本行
 * @param anchorId - 路由里的行 id（链视图的锚点）
 * @param fallbackId - `?v=` 指定的版本（锚点不在加载集时退它）
 * @param truncated - 账本查询是否触顶（cap 5 页）
 * @returns 链视图
 */
function buildChain(
  rows: readonly MemoryNominationDto[],
  anchorId: string,
  fallbackId: string,
  truncated: boolean,
): MemoryChainView {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const anchor = byId.get(anchorId) ?? byId.get(fallbackId);
  if (!anchor) return { nodes: [], withdrawn: [], currentId: null, truncated };

  /** 无向邻接（`correctionOf` 边）；自环与指向未加载行的边被丢弃（fail-soft） */
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const row of rows) {
    const parent = row.correctionOf;
    if (!parent || parent === row.id) continue;
    if (!byId.has(parent)) continue;
    link(parent, row.id);
    link(row.id, parent);
  }

  /** 锚点所在连通分量（迭代式 DFS：账本行数上限 = 5×100，递归没必要） */
  const component: MemoryNominationDto[] = [];
  const visited = new Set<string>();
  const stack = [anchor.id];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (node) component.push(node);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }

  /** 主链：`status !== withdrawn`，按 createdAt 升序（旧 → 新 = 链序） */
  const nodes = component
    .filter((row) => row.status !== MEMORY_NOMINATION_STATUS.WITHDRAWN)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  /** 未达成尝试：withdrawn 行且其 `correctionOf` 指向主链上的节点（孤立的排除，fail-soft） */
  const nodeIds = new Set(nodes.map((node) => node.id));
  const withdrawn = rows
    .filter(
      (row) =>
        row.status === MEMORY_NOMINATION_STATUS.WITHDRAWN &&
        !!row.correctionOf &&
        nodeIds.has(row.correctionOf),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  /** 现行版本 = 主链上**没有**被任何其它主链节点取代的那个；多端（分叉）取最新，环则退最新 */
  const correctedIds = new Set(nodes.map((node) => node.correctionOf).filter(Boolean));
  const heads = nodes.filter((node) => !correctedIds.has(node.id));
  const currentId = (heads[heads.length - 1] ?? nodes[nodes.length - 1])?.id ?? null;

  return { nodes, withdrawn, currentId, truncated };
}
