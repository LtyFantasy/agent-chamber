/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `/usage` 两个一级 Tab 的**契约翻译层**：平台 API/MCP 调用统计（`GET /system/api-usage`）
 *     + Hument 模型调用用量（`GET /memory/projects/:id/usage/summary|trace`）
 *
 * [代码职责]
 *   - 逐字镜像后端响应形状（后端是唯一真相源；web 不能 import backend 包）：
 *     `api-usage-query.service.ts` 的 `ApiUsageResponse` /
 *     `memory-contract.ts` 的 `MemoryUsageSummaryResponse` / `MemoryUsageTraceResponse` /
 *     `memory-engine.interface.ts` 的 `HumentUsage*`
 *   - 时间窗物化与校验（UTC `[since, until)`；默认 7 天、硬上限 90 天）
 *   - `null / absent / 0` 三态的展示判定（**unknown ≠ 0**）
 *   - 错误分桶（权限 / 共享 / 版本 / 数据 / 身份 / 限流 / 游标复位 / 网络）
 *
 * [权威文档]
 *   - 合同源: `apps/backend/src/modules/memory/dto/memory-contract.ts`
 *     + `apps/backend/src/modules/memory/engines/memory-engine.interface.ts`
 *     + `apps/backend/src/modules/usage-stats/api-usage-query.service.ts`
 *   - 实现蓝本: 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3 / §3.4.6
 *   - UI: 线上 `docs/frontend/ui-design-system.md`（Mission Control 深空主题）
 *
 * [关键不变量]
 *   - **`engine` 不含 `target`**：身份回声只在外层 camelCase `target`，且不暴露
 *     binding / namespace / credentialRef。
 *   - **`null` = 未知，不是 0**：actual cost / physical calls / total tokens 等可空字段
 *     一律 `— (unknown)`，不参与求和、不换算币种（合同未声明 currency）。
 *   - **`totals` 覆盖完整匹配集**：与 trace 页大小无关；**禁止**从 `groups` / `rows` 重算。
 *   - **平台 Top-N 不是全量**：`items` 只是 top-N，不能求和当总量。
 *   - **查询键不含 `as_of` / `request_id`**：它们每次刷新都会变，入 key 会让缓存永远失效。
 *   - **默认时间窗每个数据集只物化一次**：summary 与 trace 共用同一对绝对 `since/until`；
 *     带 cursor 翻页必须回送首页原值（含精度）。
 *   - **错误动作码优先于文案**：`hintCode` / `reason` / HTTP 状态是唯一分支依据。
 *
 * [关联代码]
 *   - ../lib/api.ts — usage 命名空间的请求编排
 *   - ../components/usage/* — 页面/表格/coverage/trace 的消费方
 *   - ../app/(main)/usage/page.tsx — 两个 Tab 的 URL/权限/默认窗口
 *
 * [修改检查]
 *   □ 改响应形状必须同步后端合同文件与 `lib/usage.test.ts`
 *   □ 新增可空数值字段必须走 `usageNumber()`（禁止 `?? 0`）
 *   □ 新增错误分支必须给出「是否可重试」与下一步动作
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { MemoryEngine, MemoryUnavailableReason } from '@agent-chamber/shared';

// ═══════════════════════════════════════════════════════════════════════
// 一、常量（与后端单源对齐）
// ═══════════════════════════════════════════════════════════════════════

/** Tab 值域（URL `tab`；两个一级 Tab） */
export const USAGE_TABS = ['platform', 'hument'] as const;

/** Tab 类型 */
export type UsageTab = (typeof USAGE_TABS)[number];

/** 命名访问（避免页面里散落字符串字面量） */
export const USAGE_TAB = {
  PLATFORM: 'platform',
  HUMENT: 'hument',
} as const;

/** 默认时间窗（天）= 后端 `MEMORY_USAGE_DEFAULT_WINDOW_DAYS` / `API_USAGE_DEFAULT_WINDOW_DAYS` */
export const USAGE_DEFAULT_WINDOW_DAYS = 7;

/** 时间窗硬上限（天）= 后端 `MEMORY_USAGE_WINDOW_MAX_DAYS` / `API_USAGE_MAX_SPAN_DAYS` */
export const USAGE_MAX_WINDOW_DAYS = 90;

/** Hument trace 默认页大小（后端 `MEMORY_USAGE_TRACE_DEFAULT_LIMIT`） */
export const USAGE_TRACE_DEFAULT_LIMIT = 100;

/** Hument trace 页大小可选值（后端接受 1–200，UI 只给三个稳值） */
export const USAGE_TRACE_LIMITS = [50, 100, 200] as const;

/** 平台 Top-N 可选值（后端缺省 20、上限 100） */
export const API_USAGE_LIMITS = [20, 50, 100] as const;

/** 平台窗口可选天数（UI 只给三档；后端上限 90） */
export const API_USAGE_RANGES = [7, 28, 90] as const;

/** 平台分组维度（必填） */
export const API_USAGE_GROUP_BYS = ['tool', 'route', 'actor'] as const;
export type ApiUsageGroupBy = (typeof API_USAGE_GROUP_BYS)[number];

/** 平台 tool 口径 */
export const API_USAGE_METRICS = ['invocations', 'rest_calls'] as const;
export type ApiUsageMetric = (typeof API_USAGE_METRICS)[number];

/** 平台 actor 身份过滤（`all` = 不带参数） */
export const API_USAGE_ACTOR_TYPES = ['all', 'agent', 'human', 'system', 'anonymous'] as const;
export type ApiUsageActorType = (typeof API_USAGE_ACTOR_TYPES)[number];

/** 平台排序键（页面不暴露排序选择，但响应/类型必须完整） */
export type ApiUsageSortBy = 'callCount' | 'avgLatencyMs' | 'errorRate';
export type ApiUsageOrder = 'asc' | 'desc';

/** 平台最小观察窗口（后端文档口径：≥4 周） */
export const API_USAGE_MIN_OBSERVATION_DAYS = 28;

/** `Cache-Control: no-store` 的两种响应都含此头；前端不缓存、不持久化。 */

// ═══════════════════════════════════════════════════════════════════════
// 二、平台 `/system/api-usage` 响应镜像
// ═══════════════════════════════════════════════════════════════════════

/** 平台聚合行（`key=null` 只出现在 groupBy=actor 的匿名行） */
export interface ApiUsageItem {
  key: string | null;
  callCount: number;
  distinctActors: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  errorRate: number;
  actorName?: string;
  actorType?: string;
}

/** 平台响应 meta（口径 + 窗口 + 覆盖度回声） */
export interface ApiUsageMeta {
  windowFrom: string;
  windowTo: string;
  /** 全表最早桶起点；**空表 → null**（这是"全表无数据"的唯一判据） */
  earliestBucketStart: string | null;
  dataCoverageDays: number | null;
  groupBy: ApiUsageGroupBy;
  /** 仅 groupBy=tool；其余为 null */
  metric: ApiUsageMetric | null;
}

/** `GET /system/api-usage` 响应 */
export interface ApiUsageResponse {
  items: ApiUsageItem[];
  meta: ApiUsageMeta;
}

/** 平台查询参数（与 DTO 同名；`all` 不发送） */
export interface ApiUsageQuery {
  groupBy: ApiUsageGroupBy;
  from?: string;
  to?: string;
  channel?: string;
  surface?: string;
  actorType?: string;
  actorId?: string;
  route?: string;
  tool?: string;
  method?: string;
  metric?: ApiUsageMetric;
  sortBy?: ApiUsageSortBy;
  order?: ApiUsageOrder;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 三、Hument usage 响应镜像（引擎块逐字 snake_case；外层 camelCase）
// ═══════════════════════════════════════════════════════════════════════

/** Usage 身份回声（**外层 camelCase**；引擎块没有 target） */
export interface MemoryUsageTarget {
  workspaceId: string;
  actorId: string;
  scope: 'actor_private';
}

/** 引擎过滤器回声（开放字符串；平台不收窄） */
export interface HumentUsageFilter {
  operation?: string;
  provider_operation?: string;
  model?: string;
  since?: string;
  until?: string;
}

/** 计数块（12 键；可空字段 = 未知） */
export interface HumentUsageCounts {
  evidence_rows: number;
  entities: number;
  logical_calls: number;
  generations: number;
  batches: number;
  known_physical_calls: number;
  physical_calls: number | null;
  unknown_physical_units: number;
  http_429: number;
  retries: number;
  cache_reuses: number | null;
  replay_count: number | null;
}

/** token 块（9 键；合计可空） */
export interface HumentUsageTokens {
  known_input_tokens: number;
  input_tokens: number | null;
  unknown_input_rows: number;
  known_output_tokens: number;
  output_tokens: number | null;
  unknown_output_rows: number;
  known_total_tokens: number;
  total_tokens: number | null;
  unknown_total_rows: number;
}

/** 成本块（actual 未知不是 0；币种合同未声明） */
export interface HumentUsageCost {
  status: string;
  actual_micros: number | null;
  known_estimated_micros: number;
  estimated_micros: number | null;
  unknown_estimated_rows: number;
}

/** 时长块 */
export interface HumentUsageDuration {
  known_physical_ms: number;
  physical_ms: number | null;
  unknown_physical_rows: number;
}

/** totals（覆盖完整匹配集） */
export interface HumentUsageTotals {
  counts: HumentUsageCounts;
  tokens: HumentUsageTokens;
  cost: HumentUsageCost;
  duration: HumentUsageDuration;
}

/** summary groups 条目 */
export interface HumentUsageGroup {
  operation: string;
  provider_operation: string;
  model?: string;
  model_basis: string;
  totals: HumentUsageTotals;
}

/** coverage.source */
export interface HumentUsageCoverageSource {
  source: string;
  status: string;
  reasons: string[];
}

/** coverage（`excluded_untimed_rows` 是覆盖债） */
export interface HumentUsageCoverage {
  status: string;
  scope: string;
  sources: HumentUsageCoverageSource[];
  excluded_untimed_rows: number;
}

/** sumamry engine 块（合同全文去掉 target） */
export interface HumentUsageSummary {
  schema_version: string;
  filter: HumentUsageFilter;
  time_basis: string;
  snapshot: string;
  as_of: string;
  totals: HumentUsageTotals;
  groups: HumentUsageGroup[];
  coverage: HumentUsageCoverage;
}

/** trace 行（required + optional 逐字镜像） */
export interface HumentUsageTraceRow {
  id: string;
  evidence_kind: string;
  source: string;
  operation: string;
  provider_operation: string;
  entity_id: string;
  model_basis: string;
  elapsed_ms: number | null;
  time_source: string;
  request_bytes: number | null;
  response_bytes: number | null;
  response_complete: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_source: string;
  token_basis: string;
  actual_cost_micros: number | null;
  estimated_cost_micros: number | null;
  cost_status: string;
  physical_calls_unknown: boolean;
  cache_reuses: number | null;
  adapter_elapsed_ms: number | null;
  logical_call_id?: string;
  generation_id?: string;
  generation_number?: number;
  batch_id?: string;
  batch_ordinal?: number;
  invocation_id?: string;
  attempt_id?: string;
  attempt_ordinal?: number;
  call_id?: string;
  physical_ordinal?: number;
  provider?: string;
  profile_id?: string;
  requested_model?: string;
  resolved_model?: string;
  model?: string;
  state?: string;
  started_at?: string;
  finished_at?: string;
  request_digest?: string;
  response_digest?: string;
  bytes_source?: string;
  request_disposition?: string;
  http_status?: number;
  quota_exhausted?: boolean;
  retry_not_before?: string;
  cost_source?: string;
}

/** trace engine 块（合同全文去掉 target） */
export interface HumentUsageTrace {
  schema_version: string;
  filter: HumentUsageFilter;
  time_basis: string;
  snapshot: string;
  as_of: string;
  rows: HumentUsageTraceRow[];
  total_rows: number;
  limit: number;
  next_cursor?: string;
  has_more: boolean;
  totals: HumentUsageTotals;
  coverage: HumentUsageCoverage;
}

/** summary 响应（外层 identity + caveat） */
export interface MemoryUsageSummaryResponse {
  engine: HumentUsageSummary;
  target: MemoryUsageTarget;
  usageCaveat: string;
}

/** trace 响应（外层 identity + caveat） */
export interface MemoryUsageTraceResponse {
  engine: HumentUsageTrace;
  target: MemoryUsageTarget;
  usageCaveat: string;
}

/** Usage 过滤（summary / trace 共用；时间两侧同时给或同时不给） */
export interface UsageFilter {
  operation?: string;
  providerOperation?: string;
  model?: string;
  since?: string;
  until?: string;
}

/** summary 请求参数（无 limit/cursor） */
export type UsageSummaryQuery = UsageFilter;

/** trace 请求参数（limit 1–200；cursor 必须与 since/until 同送） */
export interface UsageTraceQuery extends UsageFilter {
  limit?: number;
  cursor?: string;
}

/** 项目投影里与 Usage 相关的三态（消费方避免猜字段） */
export interface UsageProjectGate {
  canReadUsage: boolean;
  engine: MemoryEngine;
  engineAvailable: boolean;
  engineReason: MemoryUnavailableReason | null;
}

// ═══════════════════════════════════════════════════════════════════════
// 四、时间窗（UTC `[since, until)`；每个数据集只物化一次）
// ═══════════════════════════════════════════════════════════════════════

/** 时间窗（绝对、含时区 RFC3339 字符串） */
export interface UsageWindow {
  since: string;
  until: string;
}

/**
 * 生成默认绝对窗口：`now - days` → `now`（毫秒精度 UTC `Z`）。
 *
 * ⚠️ **一个数据集只调用一次**：summary 与 trace 共用同一窗口；禁止在每页/每渲染重算。
 *
 * @param days 窗口天数（默认 7）
 * @param now 当前时刻（注入以便测试）
 * @returns 绝对窗口
 */
export function usageWindow(days = USAGE_DEFAULT_WINDOW_DAYS, now: Date = new Date()): UsageWindow {
  const until = now;
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString() };
}

/** 时间窗校验结果 */
export type UsageWindowError = 'sinceRequired' | 'untilRequired' | 'invalid' | 'order' | 'span';

/**
 * 校验用户输入的绝对时间窗。
 *
 * @param since 左端（含）
 * @param until 右端（不含）
 * @returns null = 合法；否则为文案分叉键
 */
export function usageValidateWindow(
  since: string | null | undefined,
  until: string | null | undefined,
): UsageWindowError | null {
  if (!since) return 'sinceRequired';
  if (!until) return 'untilRequired';
  const start = Date.parse(since);
  const end = Date.parse(until);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'invalid';
  if (end <= start) return 'order';
  if (end - start > USAGE_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) return 'span';
  return null;
}

/**
 * 解析 URL 里的绝对时间窗；非法/缺失时回落到默认 7 天。
 *
 * @param since URL `h_from`
 * @param until URL `h_to`
 * @param now 当前时刻（注入）
 * @returns 绝对窗口（保证合法）
 */
export function usageWindowFromUrl(
  since: string | null,
  until: string | null,
  now: Date = new Date(),
): UsageWindow {
  if (since && until && usageValidateWindow(since, until) === null) return { since, until };
  return usageWindow(USAGE_DEFAULT_WINDOW_DAYS, now);
}

/**
 * ISO → 主展示用的 UTC 分钟串（如 `2026-10-01 00:00 UTC`）。
 *
 * 主界面不铺原始 ISO；完整原值保留在详情行里（可复制、可核对精度）。
 */
export function usageFormatUtcMinute(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ` +
    `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())} UTC`
  );
}

/**
 * `datetime-local` 输入 → UTC ISO（空串 → null）。
 *
 * ⚠️ **按 UTC 解释输入**：`datetime-local` 本身不带时区，浏览器默认按本地时区解析；
 * 本页标签明确写 UTC，因此这里手工补 `Z`，避免"看着 00:00、实际发的是本地 00:00"。
 */
export function usageDatetimeLocalToIso(value: string): string | null {
  if (!value) return null;
  // datetime-local 的典型形态是 YYYY-MM-DDTHH:mm；补秒与 Z 后按 UTC 解析。
  const normalized = value.length === 16 ? `${value}:00Z` : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * ISO → `datetime-local` 的 **UTC** 展示值（用于回填自定义输入框）。
 *
 * 与 `usageDatetimeLocalToIso` 成对：展示用 UTC 分量，提交按 UTC 解释。
 */
export function usageIsoToDatetimeLocal(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}` +
    `T${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 五、过滤器与查询键
// ═══════════════════════════════════════════════════════════════════════

/** 清掉空白值（模型名 trim 由后端做，前端只去空串） */
function compact(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 组装 summary 请求参数（省略空值，时间两侧同时给） */
export function buildUsageSummaryQuery(filter: UsageFilter): UsageSummaryQuery {
  return {
    operation: compact(filter.operation),
    providerOperation: compact(filter.providerOperation),
    model: compact(filter.model),
    since: filter.since,
    until: filter.until,
  };
}

/** 组装 trace 请求参数（summary 全集 + limit/cursor） */
export function buildUsageTraceQuery(
  filter: UsageFilter,
  limit: number,
  cursor?: string,
): UsageTraceQuery {
  return {
    ...buildUsageSummaryQuery(filter),
    limit,
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * 稳定过滤键（进 queryKey）。
 *
 * ⚠️ **不含 `as_of` / `request_id`**（每次响应都会变）；也不含 `limit`——
 * trace 的 key 由调用方额外拼 limit，summary 没有 limit。
 *
 * @param filter 生效过滤（含绝对时间窗）
 * @returns 稳定字符串
 */
export function usageFilterKey(filter: UsageFilter): string {
  return JSON.stringify([
    compact(filter.operation) ?? '',
    compact(filter.providerOperation) ?? '',
    compact(filter.model) ?? '',
    filter.since ?? '',
    filter.until ?? '',
  ]);
}

/** 是否有任何非时间过滤（用于区分"窗口零"与"过滤零"） */
export function usageHasFilters(filter: UsageFilter): boolean {
  return Boolean(
    compact(filter.operation) || compact(filter.providerOperation) || compact(filter.model),
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 六、三态展示（null = 未知，不是 0）
// ═══════════════════════════════════════════════════════════════════════

/** 可空数值的展示结果 */
export interface UsageNumberView {
  /** 展示文本；未知时为空串（由调用方渲染 `—` + unknown 提示） */
  text: string;
  /** true = null/undefined（未知），不是零 */
  unknown: boolean;
}

/**
 * 可空数值 → 展示文本。
 *
 * **禁止**把 null 当 0：`usageNumber(null).unknown === true`，调用方必须渲染未知态。
 *
 * @param value 可空数值
 * @param format 数字格式化（默认 `toLocaleString('en-US')`，保证千分位稳定）
 * @returns 展示结果
 */
export function usageNumber(
  value: number | null | undefined,
  format: (n: number) => string = (n) => n.toLocaleString('en-US'),
): UsageNumberView {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { text: '', unknown: true };
  }
  return { text: format(value), unknown: false };
}

/** 成本展示（micros 原值 + 明确"币种未声明"，不换算 USD） */
export function usageMicros(value: number | null | undefined): UsageNumberView {
  return usageNumber(value, (n) => `${n.toLocaleString('en-US')} µ`);
}

/** totals 是否"全零/无记录"（用于窗口零 / 过滤零判定；不把 null 当 0） */
export function usageTotalsEmpty(totals: HumentUsageTotals | undefined): boolean {
  if (!totals) return true;
  return (
    totals.counts.evidence_rows === 0 &&
    totals.counts.logical_calls === 0 &&
    totals.counts.generations === 0 &&
    totals.tokens.known_total_tokens === 0
  );
}

/**
 * "无时刻全排除"：有时间窗过滤时，没有物理开始时间的证据行不计入 totals。
 *
 * 判据 = `excluded_untimed_rows > 0` 且 totals 为空——此时界面必须说"被排除"，
 * 不能显示成"零使用"。
 */
export function usageAllRowsExcluded(
  coverage: HumentUsageCoverage | undefined,
  totals: HumentUsageTotals | undefined,
): boolean {
  return Boolean(coverage && coverage.excluded_untimed_rows > 0 && usageTotalsEmpty(totals));
}

/** Hument 空态分叉键 */
export type UsageHumentEmptyKind = 'filter' | 'allExcluded' | 'window';

/**
 * Hument summary 的空态分叉。
 *
 * @param summary 成功的 summary（engine 块）
 * @param filter 生效过滤
 * @returns 空态键；有数据时 null
 */
export function usageHumentEmptyKind(
  summary: HumentUsageSummary,
  filter: UsageFilter,
): UsageHumentEmptyKind | null {
  if (summary.groups.length > 0 || !usageTotalsEmpty(summary.totals)) return null;
  // 先判"全被排除"：它是覆盖债（比"过滤零/窗口零"更具体），有过滤时也不能被 filter 盖住
  if (usageAllRowsExcluded(summary.coverage, summary.totals)) return 'allExcluded';
  if (usageHasFilters(filter)) return 'filter';
  return 'window';
}

/** 平台空态分叉键 */
export type UsagePlatformEmptyKind = 'noTableData' | 'filtered' | 'window';

/**
 * 平台空态分叉（三件事的下一步动作完全不同）。
 *
 * @param response 成功的平台响应
 * @param hasFilter 是否带了 actorType 等过滤
 * @returns 空态键；有数据时 null
 */
export function usagePlatformEmptyKind(
  response: ApiUsageResponse,
  hasFilter: boolean,
): UsagePlatformEmptyKind | null {
  if (response.items.length > 0) return null;
  if (response.meta.earliestBucketStart === null) return 'noTableData';
  if (hasFilter) return 'filtered';
  return 'window';
}

/** 平台数据覆盖是否不足最小观察窗口（<28 天） */
export function usagePlatformCoverageShort(days: number | null): boolean {
  return days !== null && days < API_USAGE_MIN_OBSERVATION_DAYS;
}

/** 平台 groupBy=actor 的单位混用警示（invocation 行与扇出 REST 行求和） */
export function usagePlatformMixedUnits(groupBy: ApiUsageGroupBy): boolean {
  return groupBy === 'actor';
}

/** 平台行展示名（匿名/已删除 actor 与 key 原值分叉） */
export function usagePlatformKeyLabel(item: ApiUsageItem, groupBy: ApiUsageGroupBy): string {
  if (groupBy !== 'actor') return item.key ?? '—';
  if (item.key === null) return 'anonymous';
  return item.actorName ?? item.key;
}

/** 平台行是否匿名 */
export function usagePlatformRowAnonymous(item: ApiUsageItem, groupBy: ApiUsageGroupBy): boolean {
  return groupBy === 'actor' && item.key === null;
}

/** coverage 是否有可展开内容 */
export function usageCoverageHasDetail(coverage: HumentUsageCoverage | undefined): boolean {
  return Boolean(coverage && coverage.sources.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════
// 七、错误分桶（动作码优先）
// ═══════════════════════════════════════════════════════════════════════

/** 后端错误码子集（shared `ErrorCode`；只列本页分叉需要的） */
export const USAGE_ERROR_CODE = {
  PERMISSION_DENIED: 1009,
  RATE_LIMITED: 429,
  MEMORY_UNAVAILABLE: 14000,
  MEMORY_ENGINE_ERROR: 14004,
  MEMORY_USAGE_CONFLICT: 14006,
} as const;

/** Usage 错误分桶键 */
export type UsageErrorKind =
  | 'permission'
  | 'notFound'
  | 'shared'
  | 'identity'
  | 'version'
  | 'data'
  | 'engineUnavailable'
  | 'rateLimited'
  | 'cursorReset'
  | 'unauthorized'
  | 'network'
  | 'generic';

/** 错误读数（页面按它选文案/重试动作/调试信息） */
export interface UsageErrorInfo {
  status: number | null;
  code: number | null;
  reason: string | null;
  engineCode: string | null;
  hintCode: string | null;
  requestId: string | null;
  retryAfterSeconds: number | null;
  kind: UsageErrorKind;
  /** 是否值得用户手动重试（权限/版本/身份/共享 = false） */
  retryable: boolean;
}

/** 读取响应头（兼容 AxiosHeaders 的 get() 与普通对象；大小写不敏感） */
function readResponseHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const bag = headers as {
    get?: (key: string) => unknown;
    [key: string]: unknown;
  };
  if (typeof bag.get === 'function') {
    const value = bag.get(name);
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  const lower = name.toLowerCase();
  const value =
    bag[name] ??
    bag[lower] ??
    bag[name.toUpperCase()] ??
    Object.entries(bag).find(([key]) => key.toLowerCase() === lower)?.[1];
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

/** Retry-After（秒数或 HTTP date）→ 等待秒数；非法返回 null */
function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** 从错误里读 Retry-After（body 优先，其次 retry-after，再次 retry-after-actor） */
function readRetryAfter(error: unknown, data: Record<string, unknown>): number | null {
  const body = data.retryAfterSeconds;
  if (typeof body === 'number' && Number.isFinite(body) && body >= 0) return Math.ceil(body);
  const response = (error as { response?: { headers?: unknown } })?.response;
  return (
    parseRetryAfter(readResponseHeader(response?.headers, 'retry-after')) ??
    parseRetryAfter(readResponseHeader(response?.headers, 'retry-after-actor'))
  );
}

/** 从 axios 错误里读嵌套 `data` 槽（只读，不做类型断言之外的清洗） */
function errorData(error: unknown): Record<string, unknown> {
  const response = (error as { response?: { data?: { data?: unknown } } })?.response;
  const data = response?.data?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 错误 → 分桶（唯一实现）。
 *
 * 优先级（与后端 `throwUsageFailure` 对齐）：
 * 权限/404 → 409 共享 → 429 → 502 cursor → 503 reason → 其它 5xx/网络。
 *
 * @param error 任意抛出物
 * @returns 分桶读数
 */
export function usageErrorInfo(error: unknown): UsageErrorInfo {
  const response = (
    error as {
      response?: { status?: unknown; data?: { code?: unknown; message?: unknown } };
    }
  )?.response;
  const status = typeof response?.status === 'number' ? response.status : null;
  const code = typeof response?.data?.code === 'number' ? response.data.code : null;
  const data = errorData(error);
  const reason = stringOrNull(data.reason);
  const engineCode = stringOrNull(data.engineCode);
  const hintCode = stringOrNull(data.hintCode);
  const requestId = stringOrNull(
    (data.engineDiagnostics as { requestId?: unknown } | undefined)?.requestId,
  );
  const retryAfterSeconds = readRetryAfter(error, data);

  let kind: UsageErrorKind = 'generic';
  let retryable = status === null || status >= 500;

  if (status === null) {
    kind = 'network';
    retryable = true;
  } else if (status === 401) {
    kind = 'unauthorized';
    retryable = false;
  } else if (status === 403 && code === USAGE_ERROR_CODE.PERMISSION_DENIED) {
    kind = 'permission';
    retryable = false;
  } else if (status === 404) {
    kind = 'notFound';
    retryable = false;
  } else if (status === 409 && code === USAGE_ERROR_CODE.MEMORY_USAGE_CONFLICT) {
    kind = 'shared';
    retryable = false;
  } else if (status === 429) {
    kind = 'rateLimited';
    retryable = true;
  } else if (
    status === 502 &&
    code === USAGE_ERROR_CODE.MEMORY_ENGINE_ERROR &&
    hintCode === 'cursor_reset_required'
  ) {
    kind = 'cursorReset';
    retryable = true;
  } else if (status === 503 && code === USAGE_ERROR_CODE.MEMORY_UNAVAILABLE) {
    retryable = false;
    if (reason === 'engine_version_unsupported') kind = 'version';
    else if (reason === 'engine_data_incompatible') kind = 'data';
    else if (reason === 'engine_identity_invalid') kind = 'identity';
    else if (reason === 'engine_unreachable' || reason === 'engine_timeout') {
      kind = 'engineUnavailable';
      retryable = true;
    } else {
      // not_configured / project_engine_unbound / engine_error
      kind = 'engineUnavailable';
      retryable = reason === 'engine_error';
    }
  }

  return {
    status,
    code,
    reason,
    engineCode,
    hintCode,
    requestId,
    retryAfterSeconds,
    kind,
    retryable,
  };
}

/** 是否"阻断级"错误（权限/共享/版本/数据/身份）：此时不应对同一过滤再打 trace */
export function usageErrorBlocksQueries(kind: UsageErrorKind): boolean {
  return (
    kind === 'permission' ||
    kind === 'notFound' ||
    kind === 'shared' ||
    kind === 'identity' ||
    kind === 'version' ||
    kind === 'data' ||
    kind === 'unauthorized'
  );
}

/** 游标复位错误（trace 专用） */
export function usageIsCursorReset(error: unknown): boolean {
  return usageErrorInfo(error).kind === 'cursorReset';
}
