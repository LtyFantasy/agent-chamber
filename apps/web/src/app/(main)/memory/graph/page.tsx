'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆**关系图页**（/memory/graph）：引擎侧记忆的节点与关系，与账本页是两个面
 *
 * [代码职责]
 *   - 项目上下文契约：`?project=<uuid>` → 白名单校验；缺省取项目列表首项并**回写 URL**
 *     （分享 / 刷新能恢复同一张图）
 *   - 过滤器（kind / status / relation_type）**进 URL**（瞬时浏览态可刷新恢复，D11 纪律）
 *   - 视口门槛：≥xl 才渲染图；<xl 显示明示说明 + 保底入口回 `/memory`
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §2.2/§3/§5 + docs/frontend/frontend-architecture.md §3.2.9
 *   - 实现蓝本: plan §4.1「关系图页」段 + B1/F7/N9/N21
 *
 * [关键不变量]
 *   - **`(main)` 路由组不能丢**：本文件在 `app/(main)/memory/graph/` 下，丢了就掉出应用壳
 *     （没有侧栏与鉴权守卫）
 *   - **项目上下文必须兜底**（B1）：`?project=` 缺失时取列表首项**并回写 URL**。少了回写，
 *     刷新一次就退化成"首项"语义，分享链接也会指向别人的首项
 *   - **URL 参数一律白名单校验**：脏参数不能把整页打进错误态（`parseUuidParam` /
 *     `parseEnumParam` 是唯二实现，在 `lib/utils.ts`）
 *   - **<xl 明示而不是硬撑**（N21/M21）：本版不做窄屏图（触屏布局/力导向都砍了），
 *     给一个缩到看不出东西的画布比说明白更糟
 *   - **skip link 指向图之后**（N7）：筛选器在画布**上方**，"跳到筛选器"对想跳过 200 个
 *     tab stop 的人毫无帮助
 *   - 页面高度用 `xl:h-[calc(100vh-9rem)]`（先例 `docs/[id]/page.tsx`）——这是**页面级**
 *     定高；画布**内部**的横条高度一律走 flex，禁止再来一个 calc（横条是 0~4 条可变的）
 *
 * [关联代码]
 *   - ../../../../components/memory/graph/memory-graph-view.tsx — 图的主体（数据/三态/抽屉）
 *   - ../page.tsx — 记忆账本页（页头有本页的入口按钮）
 *   - ../../../../lib/memory.ts — 类型与值域单源
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增 URL 参数仍走白名单校验
 *   □ 新增过滤器必须同时进 `datasetKey`（否则携旧 cursor 打新过滤器 = 引擎 400）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import {
  MEMORY_VIEW_MEMORY_KINDS,
  MEMORY_VIEW_MEMORY_STATUSES,
  MEMORY_VIEW_RELATION_TYPES,
} from '@agent-chamber/shared';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { MemoryGraphView } from '@/components/memory/graph/memory-graph-view';
import { MEMORY_GRAPH_AFTER_ID } from '@/components/memory/graph/memory-graph-canvas';
import {
  memoryKindLabel,
  memoryRelationLabel,
  memoryStatusLabelOf,
} from '@/components/memory/graph/graph-labels';
import { MEMORY_MAX_PAGE_SIZE, type MemoryGraphFilters } from '@/lib/memory';
import { parseEnumParam, parseUuidParam } from '@/lib/utils';

/**
 * 图页的视口门槛（px）：Tailwind `xl` 的默认断点。
 *
 * 与 CSS 的 `xl:` 变体同源但**必须各写一份**：CSS 只负责"看不看得见"，JS 这一份决定
 * "要不要发请求"——窄屏仍把整张图拉下来再藏起来，是白烧一次引擎调用。
 */
const MEMORY_GRAPH_MIN_WIDTH = 1280;

/**
 * 视口是否 ≥xl。
 *
 * 三态：`null` = 尚未测量（SSR / 首帧），调用方据此先渲染占位骨架——直接按窄屏渲染会让
 * 宽屏用户在首帧看到一次"屏宽不足"的假告警。
 *
 * jsdom 没有 `matchMedia`：按"可用"处理，否则图页的所有单测都只会测到那个占位骨架。
 *
 * @returns true / false / null（未测量）
 */
function useWideViewport(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      setWide(true);
      return;
    }
    const query = window.matchMedia(`(min-width: ${MEMORY_GRAPH_MIN_WIDTH}px)`);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

export default function MemoryGraphPage() {
  const t = useTranslations('memory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const wide = useWideViewport();

  const projectsQuery = useQuery({
    queryKey: ['memory', 'projects'],
    queryFn: () => Api.memory.projects({ page: 1, pageSize: MEMORY_MAX_PAGE_SIZE }),
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const projects = useMemo(() => projectsQuery.data?.items ?? [], [projectsQuery.data]);

  /** URL 值一律白名单校验（脏值回落缺省，避免后端 400 把整页打进错误态） */
  const urlProject = parseUuidParam(searchParams.get('project'));
  const urlKind = parseEnumParam(searchParams.get('kind'), MEMORY_VIEW_MEMORY_KINDS) ?? '';
  const urlStatus = parseEnumParam(searchParams.get('status'), MEMORY_VIEW_MEMORY_STATUSES) ?? '';
  const urlRelation =
    parseEnumParam(searchParams.get('relation_type'), MEMORY_VIEW_RELATION_TYPES) ?? '';

  /**
   * 生效项目：URL 指定优先；缺省取列表首项。
   *
   * URL 指定但**不在列表里**时不静默回退（与账本页同纪律）：照旧请求，让服务端裁决
   * ——悄悄换成另一个项目会让"图上少了东西"变成无法解释的现象。
   */
  const activeProjectId = urlProject ?? projects[0]?.id ?? null;

  // 缺省项目回写 URL（分享 / 刷新能恢复同一张图；`replace` 因为它不是一次导航）
  useEffect(() => {
    if (urlProject || !projects[0]) return;
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set('project', projects[0].id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [urlProject, projects, pathname, router, searchParams]);

  /** 过滤器写 URL（`replace`：瞬时浏览态，不进历史） */
  const setFilter = (key: 'kind' | 'status' | 'relation_type', value: string) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (value) params.set(key, value);
    else params.delete(key);
    const queryString = params.toString();
    router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
  };

  const filters: MemoryGraphFilters = {
    kind: urlKind || undefined,
    status: urlStatus || undefined,
    relationType: urlRelation || undefined,
  };

  const backHref = activeProjectId ? `/memory?project=${activeProjectId}` : '/memory';
  const backToLedger = () => router.push(backHref);

  // ── 项目列表三态（图页是纯引擎面：没有项目就没有图）────────────────────────────
  if (projectsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4" data-testid="memory-graph-page-loading">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-[560px] w-full rounded-lg" />
      </div>
    );
  }

  if (projectsQuery.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-12" data-testid="memory-graph-page-error">
        <p className="text-sm text-destructive">{t('graph.errorTitle')}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void projectsQuery.refetch()}>
            {t('graph.retry')}
          </Button>
          <Button variant="outline" onClick={backToLedger}>
            {t('graph.back')}
          </Button>
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="py-8" data-testid="memory-graph-page-empty">
        <EmptyState
          title={t('graph.canvas.noNodesTitle')}
          description={t('graph.canvas.noNodesDesc')}
          action={<Button onClick={backToLedger}>{t('graph.back')}</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 xl:h-[calc(100vh-9rem)]">
      {/*
        skip link：指向**图之后**的第一个可聚焦区域（N7）。
        默认视觉隐藏，聚焦时现形（键盘用户按第一次 Tab 就拿到它）。
      */}
      <a
        href={`#${MEMORY_GRAPH_AFTER_ID}`}
        data-testid="memory-graph-skip"
        className="sr-only focus:not-sr-only focus:inline-flex focus:w-fit focus:items-center focus:rounded-md focus:border focus:border-input focus:bg-background focus:px-3 focus:py-1.5 focus:text-xs focus:text-foreground"
      >
        {t('graph.skipCanvas')}
      </a>

      <header className="space-y-2">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('graph.back')}
        </Link>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold leading-snug">{t('graph.title')}</h1>
          <p className="text-xs text-muted-foreground">{t('graph.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <label className="inline-flex items-center gap-2">
            <span>{t('project.label')}</span>
            <select
              data-testid="memory-graph-project-select"
              aria-label={t('project.aria')}
              value={activeProjectId ?? ''}
              onChange={(event) => {
                const params = new URLSearchParams(Array.from(searchParams.entries()));
                params.set('project', event.target.value);
                router.push(`${pathname}?${params.toString()}`, { scroll: false });
              }}
              className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {`${project.name} (${project.slug})`}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-2">
            <span>{t('graph.filters.kind')}</span>
            <select
              data-testid="memory-graph-filter-kind"
              value={urlKind}
              onChange={(event) => setFilter('kind', event.target.value)}
              className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
            >
              <option value="">{t('graph.filters.kindAll')}</option>
              {MEMORY_VIEW_MEMORY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {memoryKindLabel(t, kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-2">
            <span>{t('graph.filters.status')}</span>
            <select
              data-testid="memory-graph-filter-status"
              value={urlStatus}
              onChange={(event) => setFilter('status', event.target.value)}
              className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
            >
              <option value="">{t('graph.filters.statusAll')}</option>
              {MEMORY_VIEW_MEMORY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {memoryStatusLabelOf(t, status)}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-2">
            <span>{t('graph.filters.relation')}</span>
            <select
              data-testid="memory-graph-filter-relation"
              value={urlRelation}
              onChange={(event) => setFilter('relation_type', event.target.value)}
              className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
            >
              <option value="">{t('graph.filters.relationAll')}</option>
              {MEMORY_VIEW_RELATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {memoryRelationLabel(t, type)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {wide === null && (
        <Skeleton
          className="min-h-[560px] flex-1 rounded-lg"
          data-testid="memory-graph-measuring"
        />
      )}

      {wide === false && (
        // <xl：明示 + 保底回账本（本版不做触屏 / 窄屏图，见 plan §9）
        <div className="py-8" data-testid="memory-graph-narrow">
          <EmptyState
            title={t('graph.narrowTitle')}
            description={t('graph.narrowDesc')}
            action={<Button onClick={backToLedger}>{t('graph.back')}</Button>}
          />
        </div>
      )}

      {wide === true && activeProjectId && (
        /*
          `key = activeProjectId`：换项目 = 换一份数据源，**整体重挂**。
          只靠 datasetKey（过滤器元组）不够——项目不在元组里，切项目时 A 的节点/边/
          ledgerMapping 会留在图上，抽屉还会用 A 的映射拼出跨项目的详情链接。
          重挂天然连带三件事：累积页清空、auto-fit 重跑、抽屉关闭。
        */
        <MemoryGraphView
          key={activeProjectId}
          projectId={activeProjectId}
          filters={filters}
          onBack={backToLedger}
        />
      )}
    </div>
  );
}
