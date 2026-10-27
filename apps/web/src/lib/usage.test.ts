/**
 * lib/usage.test.ts — `/usage` 契约翻译层的判别性单测。
 *
 * 覆盖计划 §3.4.6 中**纯函数可证伪**的部分：默认/上限时间窗、过滤键稳定性、
 * `null ≠ 0`、空态三分叉、错误动作码分桶、平台 Top-N/actor 单位混用。
 * 组件与请求次数在 `app/(main)/usage/page.test.tsx`。
 */
import {
  buildUsageSummaryQuery,
  usageAllRowsExcluded,
  usageDatetimeLocalToIso,
  usageIsoToDatetimeLocal,
  usageErrorBlocksQueries,
  usageErrorInfo,
  usageFilterKey,
  usageHumentEmptyKind,
  usageMicros,
  usageNumber,
  usagePlatformCoverageShort,
  usagePlatformEmptyKind,
  usagePlatformKeyLabel,
  usagePlatformMixedUnits,
  usageTotalsEmpty,
  usageValidateWindow,
  usageWindow,
  usageWindowFromUrl,
  USAGE_DEFAULT_WINDOW_DAYS,
  USAGE_MAX_WINDOW_DAYS,
  type HumentUsageCoverage,
  type HumentUsageSummary,
  type HumentUsageTotals,
  type ApiUsageResponse,
} from '@/lib/usage';

const DAY = 24 * 60 * 60 * 1000;

function totals(overrides: Partial<HumentUsageTotals> = {}): HumentUsageTotals {
  const base: HumentUsageTotals = {
    counts: {
      evidence_rows: 0,
      entities: 0,
      logical_calls: 0,
      generations: 0,
      batches: 0,
      known_physical_calls: 0,
      physical_calls: null,
      unknown_physical_units: 0,
      http_429: 0,
      retries: 0,
      cache_reuses: null,
      replay_count: null,
    },
    tokens: {
      known_input_tokens: 0,
      input_tokens: null,
      unknown_input_rows: 0,
      known_output_tokens: 0,
      output_tokens: null,
      unknown_output_rows: 0,
      known_total_tokens: 0,
      total_tokens: null,
      unknown_total_rows: 0,
    },
    cost: {
      status: 'unknown',
      actual_micros: null,
      known_estimated_micros: 0,
      estimated_micros: null,
      unknown_estimated_rows: 0,
    },
    duration: {
      known_physical_ms: 0,
      physical_ms: null,
      unknown_physical_rows: 0,
    },
  };
  return { ...base, ...overrides };
}

function coverage(overrides: Partial<HumentUsageCoverage> = {}): HumentUsageCoverage {
  return {
    status: 'partial',
    scope: 'actor_private',
    sources: [],
    excluded_untimed_rows: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<HumentUsageSummary> = {}): HumentUsageSummary {
  return {
    schema_version: 'usage-summary-v1',
    filter: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z' },
    time_basis: 'physical_request_start',
    snapshot: 's1',
    as_of: '2026-10-08T00:00:01.000Z',
    totals: totals(),
    groups: [],
    coverage: coverage(),
    ...overrides,
  };
}

describe('时间窗（UTC [since, until)）', () => {
  it('默认窗口 = 恰好 7 天，毫秒精度 UTC Z', () => {
    const now = new Date('2026-10-24T12:34:56.789Z');
    const window = usageWindow(USAGE_DEFAULT_WINDOW_DAYS, now);
    expect(window.until).toBe('2026-10-24T12:34:56.789Z');
    expect(Date.parse(window.until) - Date.parse(window.since)).toBe(7 * DAY);
  });

  it('90 天合法；超过 90 天 → span', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const exactly90 = new Date(Date.parse(start) + USAGE_MAX_WINDOW_DAYS * DAY).toISOString();
    expect(usageValidateWindow(start, exactly90)).toBeNull();
    const over90 = new Date(Date.parse(exactly90) + 1).toISOString();
    expect(usageValidateWindow(start, over90)).toBe('span');
  });

  it('缺失/非法/顺序错误逐项分叉', () => {
    expect(usageValidateWindow(null, '2026-01-02T00:00:00Z')).toBe('sinceRequired');
    expect(usageValidateWindow('2026-01-01T00:00:00Z', null)).toBe('untilRequired');
    expect(usageValidateWindow('nope', '2026-01-02T00:00:00Z')).toBe('invalid');
    expect(usageValidateWindow('2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')).toBe('order');
  });

  it('datetime-local 输入按 UTC 解释，回填也用 UTC 分量（不是浏览器本地时区）', () => {
    expect(usageDatetimeLocalToIso('2026-10-01T00:00')).toBe('2026-10-01T00:00:00.000Z');
    expect(usageIsoToDatetimeLocal('2026-10-01T00:00:00.000Z')).toBe('2026-10-01T00:00');
    expect(usageDatetimeLocalToIso('')).toBeNull();
  });

  it('URL 窗口非法时回落默认 7 天（不把脏参数发给端点）', () => {
    const now = new Date('2026-10-24T00:00:00.000Z');
    const window = usageWindowFromUrl('2026-01-01T00:00:00Z', '2026-20-01T00:00:00Z', now);
    expect(window.until).toBe(now.toISOString());
    expect(Date.parse(window.until) - Date.parse(window.since)).toBe(7 * DAY);
  });
});

describe('null ≠ 0（三态）', () => {
  it('null / undefined = 未知；0 = 已知零', () => {
    expect(usageNumber(null)).toEqual({ text: '', unknown: true });
    expect(usageNumber(undefined)).toEqual({ text: '', unknown: true });
    expect(usageNumber(0)).toEqual({ text: '0', unknown: false });
  });

  it('成本 micros：null 未知、0 不是未知、不出现币种符号', () => {
    expect(usageMicros(null)).toEqual({ text: '', unknown: true });
    expect(usageMicros(0)).toEqual({ text: '0 µ', unknown: false });
    expect(usageMicros(1234).text).toBe('1,234 µ');
    expect(usageMicros(1234).text).not.toMatch(/[$€£¥]/);
  });
});

describe('Hument 空态三分叉', () => {
  it('totals 全零 = 空；任一已知计数/总量非零 = 有数据', () => {
    expect(usageTotalsEmpty(totals())).toBe(true);
    expect(
      usageTotalsEmpty(
        totals({
          counts: { ...totals().counts, logical_calls: 1 },
        }),
      ),
    ).toBe(false);
    expect(
      usageTotalsEmpty(
        totals({
          tokens: { ...totals().tokens, known_total_tokens: 3 },
        }),
      ),
    ).toBe(false);
  });

  it('有过滤 → filter；无过滤但全部无时刻行被排除 → allExcluded；否则 window', () => {
    const base = { since: '2026-10-01T00:00:00Z', until: '2026-10-08T00:00:00Z' };
    expect(usageHumentEmptyKind(summary(), { ...base, operation: 'formation' })).toBe('filter');
    expect(
      usageHumentEmptyKind(summary({ coverage: coverage({ excluded_untimed_rows: 3 }) }), base),
    ).toBe('allExcluded');
    expect(usageHumentEmptyKind(summary(), base)).toBe('window');
    // allExcluded 优先于 filters（覆盖债比"过滤零"更具体）
    expect(
      usageHumentEmptyKind(summary({ coverage: coverage({ excluded_untimed_rows: 3 }) }), {
        ...base,
        operation: 'formation',
      }),
    ).toBe('allExcluded');
  });

  it('有 groups 或 totals 非零时不为空', () => {
    const withGroup = summary({
      groups: [
        {
          operation: 'formation',
          provider_operation: 'generation',
          model: 'm',
          model_basis: 'requested',
          totals: totals(),
        },
      ],
    });
    expect(usageHumentEmptyKind(withGroup, {})).toBeNull();
  });

  it('allRowsExcluded 只在 excluded>0 且 totals 空时成立', () => {
    expect(usageAllRowsExcluded(coverage({ excluded_untimed_rows: 2 }), totals())).toBe(true);
    expect(
      usageAllRowsExcluded(
        coverage({ excluded_untimed_rows: 2 }),
        totals({ counts: { ...totals().counts, evidence_rows: 1 } }),
      ),
    ).toBe(false);
  });
});

describe('平台 Top-N / 覆盖 / 单位混用', () => {
  const response = (overrides: Partial<ApiUsageResponse['meta']> = {}): ApiUsageResponse => ({
    items: [],
    meta: {
      windowFrom: '2026-10-01T00:00:00.000Z',
      windowTo: '2026-10-08T00:00:00.000Z',
      earliestBucketStart: '2026-09-01T00:00:00.000Z',
      dataCoverageDays: 30,
      groupBy: 'tool',
      metric: 'invocations',
      ...overrides,
    },
  });

  it('全表无数据 / 窗口零 / 过滤零三分叉', () => {
    expect(usagePlatformEmptyKind(response({ earliestBucketStart: null }), false)).toBe(
      'noTableData',
    );
    expect(usagePlatformEmptyKind(response(), false)).toBe('window');
    expect(usagePlatformEmptyKind(response(), true)).toBe('filtered');
    expect(
      usagePlatformEmptyKind(
        {
          ...response(),
          items: [
            {
              key: 'x',
              callCount: 1,
              distinctActors: 1,
              avgLatencyMs: 1,
              maxLatencyMs: 1,
              errorRate: 0,
            },
          ],
        },
        true,
      ),
    ).toBeNull();
  });

  it('<28 天覆盖不足警示（含边界 27.9 / 28）', () => {
    expect(usagePlatformCoverageShort(27.9)).toBe(true);
    expect(usagePlatformCoverageShort(28)).toBe(false);
    expect(usagePlatformCoverageShort(null)).toBe(false);
  });

  it('actor 维度标记混合单位；其他维度不标', () => {
    expect(usagePlatformMixedUnits('actor')).toBe(true);
    expect(usagePlatformMixedUnits('tool')).toBe(false);
    expect(usagePlatformMixedUnits('route')).toBe(false);
  });

  it('匿名行不显示 UUID，已删除 actor 用后端占位名', () => {
    const item = {
      key: null,
      callCount: 1,
      distinctActors: 0,
      avgLatencyMs: 0,
      maxLatencyMs: 0,
      errorRate: 0,
    };
    expect(usagePlatformKeyLabel(item, 'actor')).toBe('anonymous');
    expect(usagePlatformKeyLabel({ ...item, key: 'a1', actorName: 'deleted actor' }, 'actor')).toBe(
      'deleted actor',
    );
    expect(usagePlatformKeyLabel({ ...item, key: 'mcp__x' }, 'tool')).toBe('mcp__x');
  });
});

describe('过滤键（queryKey 稳定性）', () => {
  it('不含 as_of / request_id / limit；空白字段不改变键', () => {
    const filter = {
      operation: 'formation',
      providerOperation: 'generation',
      model: 'm',
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-08T00:00:00.000Z',
    };
    const key = usageFilterKey(filter);
    expect(key).not.toContain('as_of');
    expect(key).not.toContain('request_id');
    expect(key).not.toContain('limit');
    expect(usageFilterKey({ ...filter, operation: '  formation  ' })).toBe(key);
  });

  it('summary 参数省略空白值并保留绝对时间窗', () => {
    expect(
      buildUsageSummaryQuery({
        operation: ' ',
        providerOperation: undefined,
        model: '  model-a ',
        since: '2026-10-01T00:00:00Z',
        until: '2026-10-08T00:00:00Z',
      }),
    ).toEqual({
      operation: undefined,
      providerOperation: undefined,
      model: 'model-a',
      since: '2026-10-01T00:00:00Z',
      until: '2026-10-08T00:00:00Z',
    });
  });
});

describe('错误分桶（动作码优先）', () => {
  function http(status: number, code: number, data: Record<string, unknown> = {}) {
    return { response: { status, data: { code, message: 'err', data } } };
  }

  it('409/14006 shared：不可重试', () => {
    const info = usageErrorInfo(http(409, 14006, { hintCode: 'shared_engine_binding' }));
    expect(info.kind).toBe('shared');
    expect(info.retryable).toBe(false);
    expect(usageErrorBlocksQueries(info.kind)).toBe(true);
  });

  it('502/14004 cursor_reset_required：可重试且是 cursorReset', () => {
    const info = usageErrorInfo(
      http(502, 14004, { hintCode: 'cursor_reset_required', engineCode: 'conflict' }),
    );
    expect(info.kind).toBe('cursorReset');
    expect(info.retryable).toBe(true);
    expect(info.engineCode).toBe('conflict');
  });

  it('503 reason 四桶：版本/数据/身份不可重试，unreachable 可重试', () => {
    expect(usageErrorInfo(http(503, 14000, { reason: 'engine_version_unsupported' })).kind).toBe(
      'version',
    );
    expect(usageErrorInfo(http(503, 14000, { reason: 'engine_data_incompatible' })).kind).toBe(
      'data',
    );
    const identity = usageErrorInfo(http(503, 14000, { reason: 'engine_identity_invalid' }));
    expect(identity.kind).toBe('identity');
    expect(identity.retryable).toBe(false);
    const unreachable = usageErrorInfo(http(503, 14000, { reason: 'engine_unreachable' }));
    expect(unreachable.kind).toBe('engineUnavailable');
    expect(unreachable.retryable).toBe(true);
  });

  it('429 携带 Retry-After；网络错误可重试；403/1009 权限不可重试', () => {
    const rate = usageErrorInfo(http(429, 429, { retryAfterSeconds: 7 }));
    expect(rate.kind).toBe('rateLimited');
    expect(rate.retryAfterSeconds).toBe(7);
    expect(usageErrorInfo({ message: 'Network Error' }).kind).toBe('network');
    const permission = usageErrorInfo(http(403, 1009));
    expect(permission.kind).toBe('permission');
    expect(permission.retryable).toBe(false);
    expect(usageErrorBlocksQueries('permission')).toBe(true);
  });

  it('429 回退读取响应头 retry-after / retry-after-actor；body 优先', () => {
    const headerOnly = usageErrorInfo({
      response: { status: 429, headers: { 'retry-after': '12' }, data: { code: 429, data: {} } },
    });
    expect(headerOnly.retryAfterSeconds).toBe(12);

    const actorHeader = usageErrorInfo({
      response: {
        status: 429,
        headers: { 'retry-after-actor': '7' },
        data: { code: 429, data: {} },
      },
    });
    expect(actorHeader.retryAfterSeconds).toBe(7);

    const bodyWins = usageErrorInfo({
      response: {
        status: 429,
        headers: { 'retry-after': '30' },
        data: { code: 429, data: { retryAfterSeconds: 5 } },
      },
    });
    expect(bodyWins.retryAfterSeconds).toBe(5);
  });

  it('requestId 从 engineDiagnostics 读出、不误读自由正文', () => {
    const info = usageErrorInfo(
      http(502, 14004, {
        hintCode: 'cursor_reset_required',
        engineDiagnostics: { requestId: 'req-1' },
        message: 'do not show me',
      }),
    );
    expect(info.requestId).toBe('req-1');
    expect(info.hintCode).toBe('cursor_reset_required');
  });
});
