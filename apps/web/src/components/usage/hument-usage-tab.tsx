'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `/usage` **Hument Tab**：项目 + 时间预设 + 汇总卡 → coverage → Groups →
 *     折叠懒加载 Trace；operation/provider/model 收进 advanced filters
 *
 * [代码职责]
 *   - 项目默认项**钉住**并写入 URL `project`；翻页/搜索/列表失败只影响 picker，
 *     不静默切换 activeProject、不卸载 summary/trace 主体
 *   - `canReadUsage=false` / 无引擎 / 引擎不可用 → 不发 engine 请求，给说明面板
 *   - 默认 7 天、最大 90 天；绝对窗口**只在 Apply/预设时物化一次**，summary 与 trace 共用
 *   - summary/groups 与 trace 各自独立 loading/error；刷新失败保留旧数据 + stale + 旧 as_of
 *   - summary 已明确空窗 / 被共享或权限阻断时，trace 不再发昂贵请求
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3 / §3.4.6
 *   - 后端 `memory-usage.service.ts` / `memory-usage.dto.ts` / `memory-contract.ts`
 *
 * [关键不变量]
 *   - **activeProject 只由 selectedProjectId 决定**：列表翻页/搜索/失败不得 fallback 到首项。
 *   - **queryKey 含 project+filterKey**；切项目/过滤不裸显旧数字。
 *   - **totals 不从 groups 重算**；null 不当 0。
 *   - **URL 参数命名空间 `h_*`**（与平台 Tab `p_*` 隔离）；过滤 `replace`。
 *   - **同一 filter 的 Apply 也开启新 trace session**（显式重拉首页，不留死重试）。
 *
 * [关联代码]
 *   - ../../lib/usage.ts — 合同镜像/时间窗/错误分桶/空态
 *   - ./use-hument-trace.ts — trace 分页状态机
 *   - ./hument-summary.tsx / ./hument-trace.tsx / ./usage-primitives.tsx
 * =============================================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemoryUnavailableReason } from '@agent-chamber/shared';
import { ChevronLeft, ChevronRight, Play } from 'lucide-react';
import { Api } from '@/lib/api';
import { memoryUnavailableReasonKind, type MemoryProjectDto } from '@/lib/memory';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { parseUuidParam } from '@/lib/utils';
import {
  buildUsageSummaryQuery,
  usageDatetimeLocalToIso,
  usageErrorBlocksQueries,
  usageErrorInfo,
  usageFilterKey,
  usageFormatUtcMinute,
  usageHumentEmptyKind,
  usageIsoToDatetimeLocal,
  usageValidateWindow,
  usageWindow,
  usageWindowFromUrl,
  USAGE_DEFAULT_WINDOW_DAYS,
  USAGE_MAX_WINDOW_DAYS,
  USAGE_TRACE_DEFAULT_LIMIT,
  USAGE_TRACE_LIMITS,
  type UsageFilter,
} from '@/lib/usage';
import {
  UsageCoverageChip,
  UsageErrorPanel,
  UsageNotice,
  UsageRetryButton,
  UsageStatus,
} from './usage-primitives';
import { HumentGroups, HumentSummaryCards } from './hument-summary';
import { HumentTrace } from './hument-trace';
import { useHumentTrace } from './use-hument-trace';

/** URL 命名空间（Hument Tab 独占） */
const URL_KEYS = {
  project: 'project',
  since: 'h_from',
  until: 'h_to',
  operation: 'h_op',
  provider: 'h_provider',
  model: 'h_model',
  limit: 'h_limit',
} as const;

const PROJECT_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** trace 禁用原因（避免魔法字符串比较） */
const TRACE_DISABLED = { BLOCKED: 'blocked', EMPTY: 'empty' } as const;

/** 预设天数 → 字面量 key（next-intl 的 key 校验不接受模板拼接） */
const PRESET_DAYS = [7, 28, 90] as const;
const PRESET_LABEL = {
  7: 'filters.preset7',
  28: 'filters.preset28',
  90: 'filters.preset90',
} as const;

/** summary 错误文案键（显式字面量，避免 next-intl 动态 key 绕过编译期校验） */
const SUMMARY_ERROR_TITLE = {
  version: 'error.versionTitle',
  data: 'error.dataTitle',
  identity: 'error.identityTitle',
  unreachable: 'error.unreachableTitle',
  timeout: 'error.timeoutTitle',
  rateLimited: 'error.rateLimitedTitle',
  network: 'error.networkTitle',
  notFound: 'error.notFoundTitle',
  unauthorized: 'error.unauthorizedTitle',
  generic: 'error.genericTitle',
} as const;

const SUMMARY_ERROR_DESC = {
  version: 'error.versionDesc',
  data: 'error.dataDesc',
  identity: 'error.identityDesc',
  unreachable: 'error.unreachableDesc',
  timeout: 'error.timeoutDesc',
  rateLimited: 'error.rateLimitedDesc',
  network: 'error.networkDesc',
  notFound: 'error.notFoundDesc',
  unauthorized: 'error.unauthorizedDesc',
  generic: 'error.genericDesc',
} as const;

type SummaryErrorKey = keyof typeof SUMMARY_ERROR_TITLE;

/** 从 URL 初始化过滤（窗口非法才回落默认 7 天；本函数只调用一次） */
function initialFilter(searchParams: URLSearchParams): UsageFilter & { limit: number } {
  const window = usageWindowFromUrl(
    searchParams.get(URL_KEYS.since),
    searchParams.get(URL_KEYS.until),
  );
  const urlLimit = Number(searchParams.get(URL_KEYS.limit));
  return {
    operation: searchParams.get(URL_KEYS.operation) ?? undefined,
    providerOperation: searchParams.get(URL_KEYS.provider) ?? undefined,
    model: searchParams.get(URL_KEYS.model) ?? undefined,
    since: window.since,
    until: window.until,
    limit: (USAGE_TRACE_LIMITS as readonly number[]).includes(urlLimit)
      ? urlLimit
      : USAGE_TRACE_DEFAULT_LIMIT,
  };
}

export function HumentUsageTab() {
  const t = useTranslations('usage.hument');
  const tState = useTranslations('usage.state');
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlProject = parseUuidParam(searchParams.get(URL_KEYS.project));
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(urlProject);
  const [projectPage, setProjectPage] = useState(1);
  const [projectFilter, setProjectFilter] = useState('');

  /** 默认窗口/过滤**只物化一次**；committed 与 draft 从同一对象出发 */
  const [initial] = useState(() => initialFilter(searchParams));
  const [committed, setCommitted] = useState<UsageFilter & { limit: number }>(initial);
  const [draft, setDraft] = useState(() => ({
    operation: initial.operation ?? '',
    providerOperation: initial.providerOperation ?? '',
    model: initial.model ?? '',
    since: initial.since as string,
    until: initial.until as string,
    limit: initial.limit,
  }));
  const [filterError, setFilterError] = useState<string | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceSession, setTraceSession] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 最近一次渲染的 URL（异步 action 合并参数时读，不闭包旧 searchParams） */
  const searchParamsRef = useRef(searchParams);
  /** 列表翻页/失败时保留的最后一个已知项目快照（避免主体被卸载） */
  const lastProjectRef = useRef<MemoryProjectDto | null>(null);

  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  const replaceParams = (next: Record<string, string | null>) => {
    // 读最近一次渲染的 URL：连续 replace（窗口 + 默认项目）不会互相覆盖
    const params = new URLSearchParams(Array.from(searchParamsRef.current.entries()));
    params.set('tab', 'hument');
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  /** 项目列表（pageSize=100；翻页/搜索只影响 picker） */
  const projectsQuery = useQuery({
    queryKey: ['usage', 'projects', projectPage],
    queryFn: () => Api.memory.projects({ page: projectPage, pageSize: PROJECT_PAGE_SIZE }),
    retry: 1,
    refetchOnWindowFocus: false,
  });
  const projects = useMemo(() => projectsQuery.data?.items ?? [], [projectsQuery.data]);
  const filteredProjects = useMemo(() => {
    const needle = projectFilter.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) || project.slug.toLowerCase().includes(needle),
    );
  }, [projects, projectFilter]);

  /** 深链项目不在当前页时按 id 读详情；列表失败也照样读（picker 错误不阻断主体） */
  const listedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId)
    : undefined;
  const deepLinkQuery = useQuery({
    queryKey: ['usage', 'project', selectedProjectId],
    queryFn: () => Api.memory.project(selectedProjectId as string),
    enabled: !!selectedProjectId && !listedProject,
    retry: false,
    refetchOnWindowFocus: false,
  });

  /** **activeProject 只由 selectedProjectId 决定**（不做首项 fallback） */
  const activeProject = selectedProjectId
    ? (listedProject ??
      deepLinkQuery.data ??
      (lastProjectRef.current?.id === selectedProjectId ? lastProjectRef.current : null))
    : null;
  const activeProjectId = activeProject?.id ?? null;

  useEffect(() => {
    if (activeProject) lastProjectRef.current = activeProject;
  }, [activeProject]);

  /**
   * **单一 URL 归一化**（B2）：窗口回填与默认 project pin 在同一个 replace 里写。
   *
   * 热缓存首挂载时，两个独立 effect 会基于同一份旧 searchParams 连续 replace，
   * 后者把前者的 h_from/h_to 覆盖掉。这里一次算出 desiredProject + desiredWindow，
   * 只发一次 replace；之后 searchParams 变化再比对，相同则不再写。
   */
  useEffect(() => {
    const current = new URLSearchParams(Array.from(searchParams.entries()));
    const urlSince = current.get(URL_KEYS.since);
    const urlUntil = current.get(URL_KEYS.until);
    const urlWindowValid =
      !!urlSince && !!urlUntil && usageValidateWindow(urlSince, urlUntil) === null;
    const desiredProject =
      selectedProjectId ?? (projectsQuery.isSuccess && projects.length > 0 ? projects[0].id : null);
    const projectDiff = !!desiredProject && current.get(URL_KEYS.project) !== desiredProject;
    // 只补缺失/非法窗口：显式 Apply/Preset/Reset/changeLimit 自己写窗口。
    // 若在这里比较 committed，真实 Next 的异步 replace 会让 effect 用旧 searchParams
    // 再写一次，把刚删/新写的过滤覆盖掉。
    const windowDiff = !urlWindowValid;

    if (!projectDiff && !windowDiff) return;
    if (!selectedProjectId && desiredProject) setSelectedProjectId(desiredProject);

    const params = new URLSearchParams(Array.from(current.entries()));
    params.set('tab', 'hument');
    if (desiredProject) params.set(URL_KEYS.project, desiredProject);
    if (windowDiff) {
      params.set(URL_KEYS.since, committed.since as string);
      params.set(URL_KEYS.until, committed.until as string);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 URL/默认项目/窗口不一致时归一
  }, [
    selectedProjectId,
    projectsQuery.isSuccess,
    projects,
    committed.since,
    committed.until,
    searchParams,
  ]);

  const hasEngine =
    activeProject?.engine === 'hument' && activeProject.engineAvailability.available === true;
  const canQuery = Boolean(activeProjectId && activeProject?.canReadUsage === true && hasEngine);

  const selectProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    replaceParams({ [URL_KEYS.project]: projectId });
  };

  /** 深链失败出口：清除 project 并回到默认项目/picker */
  const clearProject = () => {
    setSelectedProjectId(null);
    setProjectPage(1);
    setProjectFilter('');
    replaceParams({ [URL_KEYS.project]: null });
  };

  /** 提交过滤：**一次**物化绝对窗口，summary 与 trace 共用；同 filter 也开启新 trace session */
  const applyFilters = (overrideWindow?: { since: string; until: string }) => {
    const since = overrideWindow?.since ?? draft.since;
    const until = overrideWindow?.until ?? draft.until;
    const windowError = usageValidateWindow(since, until);
    if (windowError) {
      setFilterError(t(`filters.windowError.${windowError}`));
      return;
    }
    setFilterError(null);
    const next: UsageFilter & { limit: number } = {
      operation: draft.operation.trim() || undefined,
      providerOperation: draft.providerOperation.trim() || undefined,
      model: draft.model.trim() || undefined,
      since,
      until,
      limit: draft.limit,
    };
    setCommitted(next);
    setDraft((previous) => ({ ...previous, since, until }));
    // Apply = 新的 trace session：同一 filter 也真的重发首页（不靠 key 变化）
    setTraceSession((value) => value + 1);
    replaceParams({
      [URL_KEYS.since]: since,
      [URL_KEYS.until]: until,
      [URL_KEYS.operation]: next.operation ?? null,
      [URL_KEYS.provider]: next.providerOperation ?? null,
      [URL_KEYS.model]: next.model ?? null,
      [URL_KEYS.limit]: String(next.limit),
    });
    // 同 filter Apply 也要刷新 summary（as_of 才会前进），不只是重启 trace
    void queryClient.refetchQueries({
      queryKey: ['usage', 'memory', 'summary', activeProjectId, usageFilterKey(next)],
    });
  };

  const applyPreset = (days: 7 | 28 | 90) => {
    const window = usageWindow(days);
    setDraft((previous) => ({ ...previous, since: window.since, until: window.until }));
    applyFilters(window);
  };

  const changeLimit = (nextLimit: number) => {
    setDraft((previous) => ({ ...previous, limit: nextLimit }));
    setCommitted((previous) => ({ ...previous, limit: nextLimit }));
    setTraceSession((value) => value + 1);
    // limit 也算显式动作：自己带窗口，不依赖归一化 effect
    replaceParams({
      [URL_KEYS.limit]: String(nextLimit),
      [URL_KEYS.since]: committed.since as string,
      [URL_KEYS.until]: committed.until as string,
    });
  };

  const resetFilters = () => {
    const window = usageWindow(USAGE_DEFAULT_WINDOW_DAYS);
    setDraft({
      operation: '',
      providerOperation: '',
      model: '',
      since: window.since,
      until: window.until,
      limit: USAGE_TRACE_DEFAULT_LIMIT,
    });
    setCommitted({
      since: window.since,
      until: window.until,
      limit: USAGE_TRACE_DEFAULT_LIMIT,
    });
    setFilterError(null);
    setTraceSession((value) => value + 1);
    replaceParams({
      [URL_KEYS.since]: window.since,
      [URL_KEYS.until]: window.until,
      [URL_KEYS.operation]: null,
      [URL_KEYS.provider]: null,
      [URL_KEYS.model]: null,
      [URL_KEYS.limit]: String(USAGE_TRACE_DEFAULT_LIMIT),
    });
  };

  const summaryQuery = useQuery({
    queryKey: ['usage', 'memory', 'summary', activeProjectId, usageFilterKey(committed)],
    queryFn: () => Api.usage.summary(activeProjectId as string, buildUsageSummaryQuery(committed)),
    enabled: canQuery,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const summaryErrorKind = summaryQuery.isError ? usageErrorInfo(summaryQuery.error).kind : null;
  const summaryBlocked =
    summaryQuery.isError && summaryErrorKind ? usageErrorBlocksQueries(summaryErrorKind) : false;

  const summaryData = summaryQuery.data?.engine;
  const summaryTarget = summaryQuery.data?.target;
  const emptyKind = summaryData ? usageHumentEmptyKind(summaryData, committed) : null;
  const traceDisabledReason: 'blocked' | 'empty' | null = summaryBlocked
    ? TRACE_DISABLED.BLOCKED
    : summaryData && emptyKind
      ? TRACE_DISABLED.EMPTY
      : null;
  const traceEnabled = canQuery && !traceDisabledReason;

  const traceIsOpen = traceOpen && traceEnabled;
  const trace = useHumentTrace(
    activeProjectId,
    committed,
    committed.limit,
    traceIsOpen,
    traceSession,
  );

  const activeFilterCount = [
    committed.operation,
    committed.providerOperation,
    committed.model,
  ].filter((value) => (value ?? '').trim().length > 0).length;

  // 预设选中态由 **committed 实际窗口**推导，而不是本地点击状态（自定义 7 天也如实选中）
  const activePreset = useMemo(() => {
    const span = Date.parse(committed.until as string) - Date.parse(committed.since as string);
    const days = Math.round(span / DAY_MS);
    return days === 7 || days === 28 || days === 90 ? days : null;
  }, [committed.since, committed.until]);

  /** 零项目：只显示真实空态 + 去 /memory 创建/加入；不渲染无意义的 search/pager/select */
  const zeroProjects =
    projectsQuery.isSuccess && (projectsQuery.data?.total ?? 0) === 0 && !selectedProjectId;
  if (zeroProjects) {
    return (
      <div data-testid="hument-projects-empty">
        <EmptyState
          title={t('project.emptyTitle')}
          description={t('project.emptyDesc')}
          action={
            <Link
              href="/memory"
              data-testid="hument-empty-memory-link"
              className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('project.emptyAction')}
            </Link>
          }
        />
      </div>
    );
  }

  // ── 项目 picker + 主体（picker 的 loading/error 不卸载主体）───────────────────
  return (
    <div className="space-y-3">
      <ProjectPicker
        projects={filteredProjects}
        selectedProjectId={selectedProjectId}
        onSelect={selectProject}
        search={projectFilter}
        onSearch={setProjectFilter}
        page={projectPage}
        total={projectsQuery.data?.total ?? 0}
        onPage={setProjectPage}
        loading={projectsQuery.isLoading}
        error={projectsQuery.isError ? projectsQuery.error : null}
        onRetry={() => void projectsQuery.refetch()}
      />

      {selectedProjectId && !listedProject && !activeProject && deepLinkQuery.isLoading ? (
        <div className="space-y-2" data-testid="hument-project-loading">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : selectedProjectId && !listedProject && deepLinkQuery.isError ? (
        <UsageNotice
          tone="danger"
          testId="hument-project-not-found"
          title={t('project.notFoundTitle')}
          description={t('project.notFoundDesc')}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="hument-clear-project"
              onClick={clearProject}
            >
              {t('project.browseAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="hument-retry-project"
              onClick={() => void deepLinkQuery.refetch()}
            >
              {tState('retry')}
            </Button>
          </div>
        </UsageNotice>
      ) : !activeProject ? (
        <UsageNotice
          tone="info"
          testId="hument-no-project"
          title={t('project.selectTitle')}
          description={t('project.selectDesc')}
        />
      ) : activeProject.canReadUsage === false ? (
        <UsageNotice
          tone="warning"
          testId="hument-permission"
          title={t('permission.title')}
          description={t('permission.desc')}
        />
      ) : activeProject.engine !== 'hument' ? (
        <UsageNotice
          tone="info"
          testId="hument-engine-projectUnbound"
          title={t('engine.projectUnboundTitle')}
          description={t('engine.projectUnboundDesc')}
        />
      ) : !hasEngine ? (
        <EngineUnavailableNotice
          testId={memoryUnavailableReasonKind(activeProject.engineAvailability.reason)}
          reason={activeProject.engineAvailability.reason}
        />
      ) : (
        <>
          {/* 首屏收敛：时间预设 + advanced filters（advanced 默认折叠） */}
          <div className="glass-flat space-y-2 rounded-lg border border-border/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('filters.time')}</span>
              {PRESET_DAYS.map((days) => (
                <Button
                  key={days}
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid={`hument-preset-${days}`}
                  aria-pressed={activePreset === days}
                  onClick={() => applyPreset(days)}
                >
                  {t(PRESET_LABEL[days])}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="hument-advanced-toggle"
                aria-expanded={advancedOpen}
                aria-controls="hument-advanced-filters"
                onClick={() => setAdvancedOpen((value) => !value)}
              >
                {activeFilterCount > 0
                  ? t('filters.advancedActive', { count: activeFilterCount })
                  : t('filters.advanced')}
              </Button>
            </div>

            {advancedOpen && (
              <div
                id="hument-advanced-filters"
                data-testid="hument-advanced-filters"
                className="space-y-2 border-t border-border/60 pt-2"
              >
                <div className="flex flex-wrap items-end gap-x-3 gap-y-2 text-xs">
                  <label className="space-y-1">
                    <span className="block text-muted-foreground">{t('filters.operation')}</span>
                    <input
                      value={draft.operation}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, operation: event.target.value }))
                      }
                      className="h-8 w-40 rounded-md border border-input bg-background/60 px-2 text-xs"
                      placeholder="formation"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-muted-foreground">{t('filters.provider')}</span>
                    <input
                      value={draft.providerOperation}
                      onChange={(event) =>
                        setDraft((previous) => ({
                          ...previous,
                          providerOperation: event.target.value,
                        }))
                      }
                      className="h-8 w-40 rounded-md border border-input bg-background/60 px-2 text-xs"
                      placeholder="generation"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-muted-foreground">{t('filters.model')}</span>
                    <input
                      value={draft.model}
                      onChange={(event) =>
                        setDraft((previous) => ({ ...previous, model: event.target.value }))
                      }
                      className="h-8 w-48 rounded-md border border-input bg-background/60 px-2 text-xs"
                      placeholder="deepseek-chat"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-muted-foreground">{t('filters.from')}</span>
                    <input
                      type="datetime-local"
                      data-testid="hument-window-from"
                      value={usageIsoToDatetimeLocal(draft.since)}
                      onChange={(event) => {
                        const iso = usageDatetimeLocalToIso(event.target.value) ?? '';
                        setDraft((previous) => ({ ...previous, since: iso }));
                      }}
                      className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-muted-foreground">{t('filters.to')}</span>
                    <input
                      type="datetime-local"
                      data-testid="hument-window-to"
                      value={usageIsoToDatetimeLocal(draft.until)}
                      onChange={(event) => {
                        const iso = usageDatetimeLocalToIso(event.target.value) ?? '';
                        setDraft((previous) => ({ ...previous, until: iso }));
                      }}
                      className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="hument-filter-apply"
                    onClick={() => applyFilters()}
                  >
                    {t('filters.apply')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="hument-filter-reset"
                    onClick={resetFilters}
                  >
                    {t('filters.reset')}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t('filters.modelHint')}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t('filters.windowHint', { max: USAGE_MAX_WINDOW_DAYS })}
                </p>
                {filterError && (
                  <p
                    role="alert"
                    data-testid="hument-filter-error"
                    className="text-xs text-destructive"
                  >
                    {filterError}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* summary / groups 独立于 trace */}
          {summaryQuery.isLoading && summaryQuery.data === undefined ? (
            <div className="space-y-2" data-testid="hument-summary-loading">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-24 w-full rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-40 w-full rounded-lg" />
            </div>
          ) : summaryQuery.isError && summaryQuery.data === undefined ? (
            <SummaryError error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
          ) : summaryData ? (
            <>
              {summaryQuery.isError && (
                <div className="flex flex-wrap items-center gap-2">
                  <UsageStatus tone="warning" live testId="hument-summary-stale">
                    {t('summary.stale', { asOf: usageFormatUtcMinute(summaryData.as_of) })}
                  </UsageStatus>
                  <UsageRetryButton
                    error={summaryQuery.error}
                    testId="hument-summary-retry"
                    onClick={() => void summaryQuery.refetch()}
                  />
                </div>
              )}

              <HumentSummaryCards summary={summaryData} />
              <UsageCoverageChip coverage={summaryData.coverage} />

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <UsageStatus testId="hument-caveat">{t('summary.caveat')}</UsageStatus>
                <UsageStatus testId="hument-as-of">
                  {t('summary.asOf', { asOf: usageFormatUtcMinute(summaryData.as_of) })}
                </UsageStatus>
                <UsageStatus testId="hument-totals-note">{t('summary.totalsNote')}</UsageStatus>
                <UsageStatus testId="hument-ledger-scope">{t('summary.ledgerScope')}</UsageStatus>
              </div>

              <details
                data-testid="hument-summary-details"
                className="rounded-lg border border-border/60 p-2 text-xs text-muted-foreground"
              >
                <summary className="cursor-pointer select-none">{t('summary.details')}</summary>
                <div className="mt-2 space-y-1">
                  {summaryTarget && (
                    <p data-testid="hument-target">
                      {t('summary.target', {
                        workspace: summaryTarget.workspaceId,
                        actor: summaryTarget.actorId,
                        scope: summaryTarget.scope,
                      })}
                    </p>
                  )}
                  <p data-testid="hument-window-echo">
                    {t('summary.window', {
                      since: summaryData.filter.since ?? (committed.since as string),
                      until: summaryData.filter.until ?? (committed.until as string),
                    })}
                  </p>
                  <p data-testid="hument-usage-caveat">{summaryQuery.data?.usageCaveat}</p>
                </div>
              </details>

              {emptyKind ? (
                <div
                  data-testid={`hument-empty-${emptyKind}`}
                  className="rounded-lg border border-border/60"
                >
                  <EmptyState
                    title={t(`empty.${emptyKind}Title`)}
                    description={t(`empty.${emptyKind}Desc`)}
                  />
                </div>
              ) : (
                <HumentGroups groups={summaryData.groups} />
              )}
            </>
          ) : null}

          {/* Trace 区：limit 移到这里；summary 阻断/空窗时禁用并说明 */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs">
                <span className="block text-muted-foreground">{t('trace.limit')}</span>
                <select
                  data-testid="hument-trace-limit"
                  value={String(draft.limit)}
                  onChange={(event) => changeLimit(Number(event.target.value))}
                  className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
                >
                  {USAGE_TRACE_LIMITS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                size="sm"
                data-testid="hument-trace-toggle"
                aria-expanded={traceIsOpen}
                aria-controls="hument-trace-region"
                disabled={!traceEnabled}
                onClick={() => setTraceOpen((value) => !value)}
              >
                <Play className="mr-1 h-3.5 w-3.5" />
                {traceIsOpen ? t('trace.collapse') : t('trace.open')}
              </Button>
              {traceDisabledReason && (
                <UsageStatus testId="hument-trace-disabled">
                  {traceDisabledReason === TRACE_DISABLED.BLOCKED
                    ? t('trace.disabledBlocked')
                    : t('trace.disabledEmpty')}
                </UsageStatus>
              )}
            </div>
            <div id="hument-trace-region">
              {traceIsOpen && (
                <HumentTrace
                  trace={trace}
                  onRestart={() => setTraceSession((value) => value + 1)}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 引擎不可用面板（reason → 三分叉文案） */
function EngineUnavailableNotice({
  reason,
  testId,
}: {
  reason: MemoryUnavailableReason | null;
  testId: string;
}) {
  const t = useTranslations('usage.hument');
  const kind = memoryUnavailableReasonKind(reason);
  return (
    <UsageNotice
      tone="warning"
      testId={`hument-engine-${testId}`}
      title={t(`engine.${kind}Title`)}
      description={t(`engine.${kind}Desc`)}
    />
  );
}

/** 项目选择器（搜索 + 分页；loading/error 只局部显示） */
function ProjectPicker({
  projects,
  selectedProjectId,
  onSelect,
  search,
  onSearch,
  page,
  total,
  onPage,
  loading,
  error,
  onRetry,
}: {
  projects: Array<{
    id: string;
    name: string;
    slug: string;
    canReadUsage: boolean;
    engine: string;
    engineAvailability: { available: boolean };
  }>;
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  page: number;
  total: number;
  onPage: (page: number) => void;
  loading: boolean;
  error: unknown | null;
  onRetry: () => void;
}) {
  const t = useTranslations('usage.hument.project');
  const tState = useTranslations('usage.state');
  const totalPages = Math.max(1, Math.ceil(total / PROJECT_PAGE_SIZE));
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 text-xs">
        <label className="w-full min-w-0 space-y-1 sm:w-auto">
          <span className="block text-muted-foreground">{t('label')}</span>
          <select
            data-testid="hument-project-select"
            aria-label={t('aria')}
            value={selectedProjectId ?? ''}
            onChange={(event) => onSelect(event.target.value)}
            disabled={loading || !!error}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-background/60 px-2 text-xs sm:w-auto sm:max-w-[22rem]"
          >
            {projects.map((project) => {
              const note = !project.canReadUsage
                ? t('disabledUsage')
                : project.engine !== 'hument'
                  ? t('noEngine')
                  : !project.engineAvailability.available
                    ? t('unavailable')
                    : null;
              return (
                <option key={project.id} value={project.id} disabled={!project.canReadUsage}>
                  {`${project.name} (${project.slug})${note ? ` · ${note}` : ''}`}
                </option>
              );
            })}
            {selectedProjectId && !projects.some((project) => project.id === selectedProjectId) && (
              <option value={selectedProjectId}>
                {search.trim() ? t('filteredOut') : t('outsidePage')}
              </option>
            )}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-muted-foreground">{t('search')}</span>
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            data-testid="hument-project-search"
            placeholder={t('searchPlaceholder')}
            className="h-8 w-48 rounded-md border border-input bg-background/60 px-2 text-xs"
          />
        </label>
        <div className="flex items-center gap-1 pb-0.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            data-testid="hument-project-prev"
            disabled={page <= 1 || loading || !!error}
            aria-label={t('prev')}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[11px] text-muted-foreground" data-testid="hument-project-page">
            {t('page', { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            data-testid="hument-project-next"
            disabled={page >= totalPages || loading || !!error}
            aria-label={t('next')}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="w-full text-[11px] text-muted-foreground">{t('searchHint')}</p>
      </div>
      {loading && (
        <p
          role="status"
          data-testid="hument-projects-loading"
          className="text-[11px] text-muted-foreground"
        >
          {t('loading')}
        </p>
      )}
      {error !== null && (
        <div
          role="alert"
          data-testid="hument-projects-error"
          className="flex flex-wrap items-center gap-2 text-[11px] text-destructive"
        >
          <span>{t('listErrorTitle')}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {tState('retry')}
          </Button>
        </div>
      )}
      {!loading && !error && projects.length === 0 && (
        <p data-testid="hument-projects-empty" className="text-[11px] text-muted-foreground">
          {t('emptyDesc')}
        </p>
      )}
    </div>
  );
}

/** summary 错误分叉：权限/共享/版本/身份各有明确下一步；其余走可重试面板 */
function SummaryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('usage.hument');
  const tState = useTranslations('usage.state');
  const info = usageErrorInfo(error);
  if (info.kind === 'shared') {
    return (
      <UsageNotice
        tone="danger"
        testId="hument-shared"
        title={t('shared.title')}
        description={t('shared.desc')}
      />
    );
  }
  if (info.kind === 'permission') {
    return (
      <UsageNotice
        tone="warning"
        testId="hument-error-permission"
        title={t('permission.title')}
        description={t('permission.desc')}
      />
    );
  }
  const keyByKind: Partial<Record<typeof info.kind, SummaryErrorKey>> = {
    version: 'version',
    data: 'data',
    identity: 'identity',
    engineUnavailable: info.reason === 'engine_timeout' ? 'timeout' : 'unreachable',
    rateLimited: 'rateLimited',
    network: 'network',
    notFound: 'notFound',
    unauthorized: 'unauthorized',
  };
  const key = keyByKind[info.kind] ?? 'generic';
  return (
    <UsageErrorPanel
      error={error}
      title={t(SUMMARY_ERROR_TITLE[key])}
      description={t(SUMMARY_ERROR_DESC[key])}
      retryLabel={tState('retry')}
      onRetry={onRetry}
      testId={`hument-error-${info.kind}`}
    />
  );
}
