'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `/usage` **平台 Tab**：`GET /system/api-usage` 的 Web 消费面
 *     （REST 路由 / MCP 工具 / 调用者 三维聚合）
 *
 * [代码职责]
 *   - **仅 admin 发请求**；非 admin 渲染权限面板（零请求、零空态伪装）
 *   - 默认 `groupBy=tool`、7 天、limit 20；窗口上限 90 天、limit 上限 100
 *   - `metric` 只在 `groupBy=tool` 出现且随请求发送
 *   - 展示 `earliestBucketStart` / 覆盖天数 / <28 天警示 / Top-N 非全量警示 /
 *     actor 混合单位警示
 *   - 区分「全表无数据」「窗口零记录」「过滤零匹配」
 *
 * [权威文档]
 *   - 后端 `api-usage.controller.ts` + `api-usage-query.service.ts` + DTO/常量
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3
 *
 * [关键不变量]
 *   - **Top-N 不是全量**：`items` 只是排序后的前 N 个键，禁止求和当总量。
 *   - **actor 维度单位混用**：invocation 行与扇出 REST 行求和，只能做活跃度排序。
 *   - **`earliestBucketStart === null` = 全表无数据**；有值但 items 空才是窗口零/过滤零。
 *   - 过滤状态走 URL（`p_*` 命名空间，`replace`），与 Hument Tab 的 `h_*` 隔离。
 *
 * [关联代码]
 *   - ../../lib/usage.ts — 响应镜像 + 空态分叉 + 三态展示
 *   - ../../lib/api.ts — `Api.usage.apiUsage`
 *   - ./usage-primitives.tsx — 错误/未知/状态原语
 *
 * [修改检查]
 *   □ 新增过滤参数必须同时更新 URL 命名空间与 queryKey
 *   □ 不得新增图表库依赖（计划明确）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-CODE-HOOK
 * =============================================================================
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { parseEnumParam } from '@/lib/utils';
import {
  API_USAGE_GROUP_BYS,
  API_USAGE_LIMITS,
  API_USAGE_METRICS,
  API_USAGE_RANGES,
  usageNumber,
  usageFormatUtcMinute,
  usagePlatformCoverageShort,
  usagePlatformEmptyKind,
  usagePlatformKeyLabel,
  usagePlatformMixedUnits,
  usageValidateWindow,
  usageWindow,
  type ApiUsageActorType,
  type ApiUsageGroupBy,
  type ApiUsageItem,
  type ApiUsageMetric,
  type ApiUsageResponse,
} from '@/lib/usage';
import {
  UsageErrorPanel,
  UsageNotice,
  UsageRetryButton,
  UsageStatus,
  UsageValue,
} from './usage-primitives';

/** 平台窗口档位（URL 字符串；后端只接受 ≤90 天） */
const RANGE_VALUES = API_USAGE_RANGES.map((days) => String(days)) as readonly string[];
type PlatformRange = '7' | '28' | '90' | 'custom';
const PLATFORM_DAY_MS = 24 * 60 * 60 * 1000;

/** URL 参数命名空间（平台 Tab 独占；与 Hument 的 h_* 隔离） */
const URL_KEYS = {
  groupBy: 'p_group',
  metric: 'p_metric',
  range: 'p_range',
  actorType: 'p_actor',
  limit: 'p_limit',
  from: 'p_from',
  to: 'p_to',
} as const;

const ACTOR_TYPE_VALUES = ['all', 'agent', 'human', 'system', 'anonymous'] as const;

/** 动态 key → 字面量（next-intl 的编译期 key 校验需要联合字面量，不能直接拼字符串） */
const GROUP_BY_LABEL = {
  tool: 'groupBy.tool',
  route: 'groupBy.route',
  actor: 'groupBy.actor',
} as const;

const METRIC_LABEL = {
  invocations: 'metric.invocations',
  rest_calls: 'metric.rest_calls',
} as const;

const RANGE_LABEL = {
  '7': 'range.7',
  '28': 'range.28',
  '90': 'range.90',
} as const;

const ACTOR_TYPE_LABEL = {
  all: 'actorType.all',
  agent: 'actorType.agent',
  human: 'actorType.human',
  system: 'actorType.system',
  anonymous: 'actorType.anonymous',
} as const;

const EMPTY_LABEL = {
  noTableData: { title: 'empty.noTableDataTitle', desc: 'empty.noTableDataDesc' },
  window: { title: 'empty.windowTitle', desc: 'empty.windowDesc' },
  filtered: { title: 'empty.filteredTitle', desc: 'empty.filteredDesc' },
} as const;

const KEY_LABEL = {
  tool: 'key.tool',
  route: 'key.route',
  actor: 'key.actor',
} as const;

const ACTOR_TYPE_VALUE_LABEL = {
  agent: 'actorTypeValue.agent',
  human: 'actorTypeValue.human',
  system: 'actorTypeValue.system',
  anonymous: 'actorTypeValue.anonymous',
} as const;

function rangeDays(range: Exclude<PlatformRange, 'custom'>): number {
  return Number(range);
}

/** 实际窗口 → range 档位（精确匹配 7/28/90，否则 custom） */
function rangeFromWindow(window: { since: string; until: string }): PlatformRange {
  const days = Math.round((Date.parse(window.until) - Date.parse(window.since)) / PLATFORM_DAY_MS);
  if (days === 7) return '7';
  if (days === 28) return '28';
  if (days === 90) return '90';
  return 'custom';
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * 平台窗口初始化：URL `p_from`/`p_to` 合法（带时区且 ≤90 天）则**逐字复用**；
 * 缺失/脏值才按 `p_range` 物化一次。返回 `needsBackfill` 供首帧写回合法窗口。
 */
function initialPlatformWindow(searchParams: URLSearchParams): {
  range: PlatformRange;
  window: ReturnType<typeof usageWindow>;
  needsBackfill: boolean;
} {
  const since = searchParams.get(URL_KEYS.from);
  const until = searchParams.get(URL_KEYS.to);
  if (since && until && usageValidateWindow(since, until) === null) {
    const window = { since, until };
    // p_from/p_to 是真相源：p_range 与真实跨度不一致时按实际窗口推导/显示 custom
    return { range: rangeFromWindow(window), window, needsBackfill: false };
  }
  const range =
    (parseEnumParam(searchParams.get(URL_KEYS.range), RANGE_VALUES) as Exclude<
      PlatformRange,
      'custom'
    > | null) ?? '7';
  return { range, window: usageWindow(rangeDays(range)), needsBackfill: true };
}

/** 主行 key（匿名行用固定串，避免 null 参与 React key） */
function rowKey(item: ApiUsageItem, index: number): string {
  return item.key ?? `anonymous-${index}`;
}

export function PlatformUsageTab({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('usage.platform');
  const tState = useTranslations('usage.state');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlGroupBy =
    parseEnumParam(searchParams.get(URL_KEYS.groupBy), API_USAGE_GROUP_BYS) ?? 'tool';
  const urlMetric = parseEnumParam(searchParams.get(URL_KEYS.metric), API_USAGE_METRICS);
  const urlActorType =
    parseEnumParam(searchParams.get(URL_KEYS.actorType), ACTOR_TYPE_VALUES) ?? 'all';
  const urlLimit = Number(searchParams.get(URL_KEYS.limit));
  const initialLimit = (API_USAGE_LIMITS as readonly number[]).includes(urlLimit) ? urlLimit : 20;

  const [groupBy, setGroupBy] = useState<ApiUsageGroupBy>(urlGroupBy);
  const [metric, setMetric] = useState<ApiUsageMetric>(urlMetric ?? 'invocations');
  const [initial] = useState(() => initialPlatformWindow(searchParams));
  const [range, setRange] = useState<PlatformRange>(initial.range);
  const [actorType, setActorType] = useState<ApiUsageActorType>(urlActorType);
  const [limit, setLimit] = useState<number>(initialLimit);
  /** 绝对窗口只物化一次（URL 合法则复用；否则首帧物化并回填） */
  const [window, setWindow] = useState(initial.window);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const backfilledRef = useRef(false);

  /** 过滤变化 = `replace`（瞬时浏览态）；两个 Tab 的参数各用各的前缀 */
  const replaceParams = (next: Record<string, string | null>) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set('tab', 'platform');
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  /** 缺失/脏窗口：首帧写回**合法** p_from/p_to/p_range，之后切 Tab 往返不漂窗 */
  useEffect(() => {
    if (backfilledRef.current) return;
    backfilledRef.current = true;
    if (!initial.needsBackfill) return;
    replaceParams({
      [URL_KEYS.range]: initial.range,
      [URL_KEYS.from]: initial.window.since,
      [URL_KEYS.to]: initial.window.until,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在首帧回填一次
  }, []);

  const changeGroupBy = (next: ApiUsageGroupBy) => {
    setGroupBy(next);
    // metric 只对 tool 有意义：切走时从 URL 删除，避免"看起来还在生效"
    replaceParams({ [URL_KEYS.groupBy]: next, [URL_KEYS.metric]: next === 'tool' ? metric : null });
  };

  const changeMetric = (next: ApiUsageMetric) => {
    setMetric(next);
    replaceParams({ [URL_KEYS.metric]: next });
  };

  const changeRange = (next: Exclude<PlatformRange, 'custom'>) => {
    setRange(next);
    // 用户动作触发一次新的绝对窗口（不是每帧重算）
    const nextWindow = usageWindow(rangeDays(next));
    setWindow(nextWindow);
    replaceParams({
      [URL_KEYS.range]: next,
      [URL_KEYS.from]: nextWindow.since,
      [URL_KEYS.to]: nextWindow.until,
    });
  };

  /** Jump to now：按**当前实际跨度**重新物化窗口（custom 保留毫秒级跨度） */
  const jumpToNow = () => {
    const spanMs =
      range === 'custom'
        ? Date.parse(window.until) - Date.parse(window.since)
        : rangeDays(range) * PLATFORM_DAY_MS;
    const now = new Date();
    const nextWindow = {
      since: new Date(now.getTime() - spanMs).toISOString(),
      until: now.toISOString(),
    };
    setWindow(nextWindow);
    setRange(rangeFromWindow(nextWindow));
    replaceParams({
      [URL_KEYS.range]: rangeFromWindow(nextWindow),
      [URL_KEYS.from]: nextWindow.since,
      [URL_KEYS.to]: nextWindow.until,
    });
  };

  const changeActorType = (next: string) => {
    const value = next as ApiUsageActorType;
    setActorType(value);
    replaceParams({ [URL_KEYS.actorType]: value === 'all' ? null : value });
  };

  const changeLimit = (next: string) => {
    const numeric = Number(next) as (typeof API_USAGE_LIMITS)[number];
    setLimit(numeric);
    replaceParams({ [URL_KEYS.limit]: String(numeric) });
  };

  const query = useMemo(
    () => ({
      groupBy,
      from: window.since,
      to: window.until,
      limit,
      ...(groupBy === 'tool' ? { metric } : {}),
      ...(actorType !== 'all' ? { actorType } : {}),
    }),
    [groupBy, metric, window.since, window.until, limit, actorType],
  );

  const usageQuery = useQuery({
    queryKey: ['usage', 'platform', groupBy, metric, actorType, limit, window.since, window.until],
    queryFn: () => Api.usage.apiUsage(query),
    enabled: isAdmin,
    // 统计是时点快照：不吃全局 retry/refetchOnWindowFocus（计划：不自动轮询）
    retry: false,
    refetchOnWindowFocus: false,
  });

  if (!isAdmin) {
    return (
      <UsageNotice
        tone="warning"
        testId="platform-permission"
        title={t('adminOnlyTitle')}
        description={t('adminOnlyDesc')}
      />
    );
  }

  const data = usageQuery.data;
  const hasFilter = actorType !== 'all';
  const emptyKind = data ? usagePlatformEmptyKind(data, hasFilter) : null;

  const toggleRow = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 text-xs">
        <label className="space-y-1">
          <span className="block text-muted-foreground">{t('filters.groupBy')}</span>
          <select
            data-testid="platform-group-by"
            aria-label={t('filters.groupBy')}
            value={groupBy}
            onChange={(event) => changeGroupBy(event.target.value as ApiUsageGroupBy)}
            className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
          >
            {API_USAGE_GROUP_BYS.map((value) => (
              <option key={value} value={value}>
                {t(GROUP_BY_LABEL[value])}
              </option>
            ))}
          </select>
        </label>

        {groupBy === 'tool' && (
          <label className="space-y-1">
            <span className="block text-muted-foreground">{t('filters.metric')}</span>
            <select
              data-testid="platform-metric"
              aria-label={t('filters.metric')}
              value={metric}
              onChange={(event) => changeMetric(event.target.value as ApiUsageMetric)}
              className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
            >
              {API_USAGE_METRICS.map((value) => (
                <option key={value} value={value}>
                  {t(METRIC_LABEL[value])}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="space-y-1">
          <span className="block text-muted-foreground">{t('filters.range')}</span>
          <select
            data-testid="platform-range"
            aria-label={t('filters.range')}
            value={range}
            onChange={(event) => {
              const value = event.target.value;
              if (value !== 'custom') {
                changeRange(value as Exclude<PlatformRange, 'custom'>);
              }
            }}
            className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
          >
            {RANGE_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(RANGE_LABEL[value as Exclude<PlatformRange, 'custom'>])}
              </option>
            ))}
            {range === 'custom' && <option value="custom">{t('range.custom')}</option>}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-muted-foreground">{t('filters.actorType')}</span>
          <select
            data-testid="platform-actor-type"
            aria-label={t('filters.actorType')}
            value={actorType}
            onChange={(event) => changeActorType(event.target.value)}
            className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
          >
            {ACTOR_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {t(ACTOR_TYPE_LABEL[value])}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="block text-muted-foreground">{t('filters.limit')}</span>
          <select
            data-testid="platform-limit"
            aria-label={t('filters.limit')}
            value={String(limit)}
            onChange={(event) => changeLimit(event.target.value)}
            className="h-8 rounded-md border border-input bg-background/60 px-2 text-xs"
          >
            {API_USAGE_LIMITS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          data-testid="platform-refresh"
          disabled={usageQuery.isFetching}
          aria-busy={usageQuery.isFetching}
          onClick={() => void usageQuery.refetch()}
        >
          {t('filters.refresh')}
        </Button>
        <Button variant="ghost" size="sm" data-testid="platform-jump-now" onClick={jumpToNow}>
          {t('filters.jumpNow')}
        </Button>
      </div>

      {usageQuery.isLoading && data === undefined ? (
        <div className="space-y-2" data-testid="platform-loading">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : usageQuery.isError && data === undefined ? (
        <UsageErrorPanel
          error={usageQuery.error}
          title={t('error.title')}
          retryLabel={tState('retry')}
          onRetry={() => void usageQuery.refetch()}
          testId="platform-error"
        />
      ) : data ? (
        <>
          {usageQuery.isError && (
            <div className="flex flex-wrap items-center gap-2">
              <UsageStatus tone="warning" live testId="platform-stale">
                {t('stale')}
              </UsageStatus>
              <UsageRetryButton
                error={usageQuery.error}
                testId="platform-stale-retry"
                onClick={() => void usageQuery.refetch()}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <UsageStatus testId="platform-window">
              {t('note.window', {
                from: usageFormatUtcMinute(data.meta.windowFrom),
                to: usageFormatUtcMinute(data.meta.windowTo),
              })}
            </UsageStatus>
            <UsageStatus testId="platform-earliest">
              {data.meta.earliestBucketStart
                ? data.meta.dataCoverageDays === null
                  ? t('note.coverageUnknown', {
                      start: usageFormatUtcMinute(data.meta.earliestBucketStart),
                    })
                  : t('note.coverage', {
                      start: usageFormatUtcMinute(data.meta.earliestBucketStart),
                      days: data.meta.dataCoverageDays,
                    })
                : t('note.noTableData')}
            </UsageStatus>
          </div>

          {data.meta.earliestBucketStart !== null && data.meta.dataCoverageDays === null && (
            <UsageStatus tone="warning" testId="platform-coverage-warning">
              {t('note.coverageUnknownWarn')}
            </UsageStatus>
          )}
          {usagePlatformCoverageShort(data.meta.dataCoverageDays) && (
            <UsageStatus tone="warning" testId="platform-coverage-warning">
              {t('note.coverageWarn')}
            </UsageStatus>
          )}

          {data.items.length > 0 && data.items.length >= limit && (
            <UsageStatus testId="platform-topn-note">{t('note.topN', { limit })}</UsageStatus>
          )}

          {usagePlatformMixedUnits(groupBy) && (
            <UsageStatus tone="warning" testId="platform-mixed-units">
              {t('note.mixedUnits')}
            </UsageStatus>
          )}

          <UsageStatus testId="platform-ledger-scope">{t('note.ledgerScope')}</UsageStatus>

          <details data-testid="platform-window-raw" className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer select-none">{t('note.raw')}</summary>
            <p className="mt-1 font-mono">
              {data.meta.windowFrom} → {data.meta.windowTo}
            </p>
            {data.meta.earliestBucketStart && (
              <p className="font-mono">{data.meta.earliestBucketStart}</p>
            )}
          </details>

          {emptyKind !== null ? (
            <div
              data-testid={`platform-empty-${emptyKind}`}
              className="rounded-lg border border-border/60"
            >
              <EmptyState
                title={t(EMPTY_LABEL[emptyKind].title)}
                description={t(EMPTY_LABEL[emptyKind].desc)}
              />
            </div>
          ) : (
            <PlatformTable
              data={data}
              groupBy={groupBy}
              expanded={expanded}
              onToggle={toggleRow}
              caption={t('table.caption', { groupBy: t(GROUP_BY_LABEL[groupBy]) })}
            />
          )}

          <p className="text-[11px] text-muted-foreground">{t('note.noSum')}</p>
        </>
      ) : null}
    </div>
  );
}

function PlatformTable({
  data,
  groupBy,
  expanded,
  onToggle,
  caption,
}: {
  data: ApiUsageResponse;
  groupBy: ApiUsageGroupBy;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  caption: string;
}) {
  const t = useTranslations('usage.platform.table');
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-lg border border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Table data-testid="platform-usage-table" className="min-w-[44rem]">
        <TableCaption>{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>{t(KEY_LABEL[groupBy])}</TableHead>
            <TableHead className="text-right">{t('calls')}</TableHead>
            <TableHead className="text-right">{t('actors')}</TableHead>
            <TableHead className="text-right">{t('avg')}</TableHead>
            <TableHead className="text-right">{t('errorRate')}</TableHead>
            {groupBy === 'actor' && <TableHead>{t('type')}</TableHead>}
            <TableHead className="w-10">
              <span className="sr-only">{t('details')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((item, index) => {
            const key = rowKey(item, index);
            const open = expanded.has(key);
            const label = usagePlatformKeyLabel(item, groupBy);
            return (
              <PlatformRow
                key={key}
                item={item}
                isActor={groupBy === 'actor'}
                open={open}
                rowId={`platform-row-${index}`}
                label={label}
                onToggle={() => onToggle(key)}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function PlatformRow({
  item,
  isActor,
  open,
  rowId,
  label,
  onToggle,
}: {
  item: ApiUsageItem;
  isActor: boolean;
  open: boolean;
  rowId: string;
  label: string;
  onToggle: () => void;
}) {
  const t = useTranslations('usage.platform.table');
  const displayLabel = !isActor
    ? label
    : item.key === null
      ? t('anonymous')
      : item.actorName === 'deleted actor'
        ? t('deletedActor')
        : (item.actorName ?? item.key);
  const actorTypeKey =
    item.actorType !== undefined
      ? ACTOR_TYPE_VALUE_LABEL[item.actorType as keyof typeof ACTOR_TYPE_VALUE_LABEL]
      : undefined;
  const actorTypeLabel =
    item.actorType === undefined ? '—' : actorTypeKey ? t(actorTypeKey) : item.actorType;
  const actorNameLabel =
    item.actorName === 'deleted actor' ? t('deletedActor') : (item.actorName ?? '—');
  const calls = usageNumber(item.callCount);
  const actors = usageNumber(item.distinctActors);
  const avg = usageNumber(item.avgLatencyMs);
  const max = usageNumber(item.maxLatencyMs);
  const errorRate = usageNumber(item.errorRate, percent);
  return (
    <>
      <TableRow data-testid={`platform-row-${item.key ?? 'anonymous'}`}>
        <TableCell className="font-mono text-xs">{displayLabel}</TableCell>
        <TableCell className="text-right">
          <UsageValue value={calls} />
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={actors} />
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={avg} />
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={errorRate} />
        </TableCell>
        {isActor && (
          <TableCell className="text-xs text-muted-foreground">{actorTypeLabel}</TableCell>
        )}
        <TableCell>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={rowId}
            aria-label={t('expand', { key: displayLabel })}
            onClick={onToggle}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow id={rowId} data-testid={`platform-row-detail-${item.key ?? 'anonymous'}`}>
          <TableCell colSpan={isActor ? 7 : 6} className="bg-muted/30 text-xs">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">{t('max')}</dt>
                <dd>
                  <UsageValue value={max} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('groupKey')}</dt>
                <dd className="break-all font-mono">{item.key ?? t('anonymous')}</dd>
              </div>
              {isActor && (
                <>
                  <div>
                    <dt className="text-muted-foreground">{t('actorName')}</dt>
                    <dd>{actorNameLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('actorType')}</dt>
                    <dd>{actorTypeLabel}</dd>
                  </div>
                </>
              )}
            </dl>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
