/**
 * usage/page.test.tsx — `/usage` 双 Tab 的判别性契约测试（计划 §3.4.6）。
 *
 * 隔离策略：**只 mock axios，不 mock `@/lib/api`**——请求形态（URL/params/次数）本身
 * 就是契约（平台 Tab 非 admin 零请求、trace 首页恰好 1 次、cursor 复位上界）。
 *
 * 覆盖：
 * ① 默认 Tab 按角色 / URL；Tab 切换 push；参数命名空间隔离（p_* vs h_*）；
 * ② Hument `canReadUsage=false` → 权限面板且零 summary 请求；
 * ③ 切项目不裸显旧数字；
 * ④ 刷新失败保留旧数据 + stale + 旧 as_of；
 * ⑤ summary 与 trace 独立失败；
 * ⑥ `null ≠ 0` + 成本币种未声明；
 * ⑦ coverage sources/reasons 折叠；
 * ⑧ 平台 Top-N 不求和 + actor 混合单位 + 三种空态；
 * ⑨ 90 天时间窗上限；
 * ⑩ trace 首屏恰好 1 次 / load-more 三态 / 在途旧 filter 丢弃 / cursor 复位上界；
 * ⑪ 表格 caption、aria-expanded、trace 滚动区键盘聚焦、移动卡片容器。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UsagePage from './page';
import { axiosInstance } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { UserRole } from '@/types';
import enMessages from '@/i18n/messages/en.json';
import type { HumentUsageSummary, HumentUsageTrace, HumentUsageTraceRow } from '@/lib/usage';

// 此 suite 验证完整内测能力；OSS 关闭行为由 memory-distribution.test.tsx 独立覆盖。
jest.mock('@agent-chamber/shared', () => ({
  ...jest.requireActual('@agent-chamber/shared'),
  MEMORY_FEATURE_ENABLED: true,
}));

// ── next/navigation：可变 searchParams + push/replace 落到地址栏并重渲染 ──────────
let mockSearchParamsString = '';
let rerenderPage: (() => void) | null = null;

function applyHref(href: string) {
  const queryIndex = href.indexOf('?');
  mockSearchParamsString = queryIndex >= 0 ? href.slice(queryIndex + 1) : '';
  // 模拟浏览器路由的**异步**重渲染：effect 内的 replace 不应在 React 正在提交时
  // 同步 rerender（真实 Next router 也不会），否则测试会触发 "Should not already be working"。
  setTimeout(() => rerenderPage?.(), 0);
}

const mockPush = jest.fn((href: string) => applyHref(href));
const mockReplace = jest.fn((href: string) => applyHref(href));

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  usePathname: () => '/usage',
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

// ── next-intl：读真实 en.json（文案即验收对象）──────────────────────────────────
function flatten(source: Record<string, unknown>, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object')
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    else out[path] = String(value);
  }
  return out;
}

const messages: Record<string, string> = flatten({
  usage: enMessages.usage,
  common: enMessages.common,
  nav: enMessages.nav,
  memory: enMessages.memory,
});

function formatMessage(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let out = text.replace(
    /\{(\w+),\s*plural,\s*one \{([^{}]*)\} other \{([^{}]*)\}\}/g,
    (_match, key: string, one: string, other: string) => {
      const value = Number(params[key]);
      return (value === 1 ? one : other).replace(/#/g, String(value));
    },
  );
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return formatMessage(messages[fullKey] ?? fullKey, params);
  },
}));

// ── axios：api.ts 在模块加载期调用 create；request 是唯一捕获点 ─────────────────
jest.mock('axios', () => {
  const instance = {
    request: jest.fn(),
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  const create = jest.fn(() => instance);
  return {
    __esModule: true,
    default: { create, getUri: jest.fn() },
    create,
    AxiosError: class AxiosError extends Error {},
  };
});

const mockRequest = axiosInstance.request as unknown as jest.Mock;

function envelope<T>(data: T) {
  return { data: { code: 0, message: 'ok', data, timestamp: '', requestId: 'r1' } };
}

function httpError(status: number, code: number, data?: Record<string, unknown>) {
  return { response: { status, data: { code, message: `err ${code}`, data: data ?? {} } } };
}

/** 可手动结算的 promise（在途请求/竞态断言） */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────
const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_A,
    slug: 'chamber-main',
    name: 'Chamber Main',
    bindings: [{ type: 'docSpace', id: 'd1' }],
    engine: 'hument',
    engineWorkspaceId: 'ws',
    engineActorId: 'actor',
    engineCredentialRef: 'ref',
    status: 'active',
    retainQueryText: true,
    createdBy: 'u1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    engineAvailability: { engine: 'hument', available: true, reason: null },
    canReadContent: true,
    canReadUsage: true,
    ...overrides,
  };
}

function projectsResponse(items = [project()]) {
  return { items, total: items.length, page: 1, pageSize: 100, provisioningAvailable: true };
}

function emptyTotals() {
  return {
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
}

function summaryEngine(overrides: Partial<HumentUsageSummary> = {}): HumentUsageSummary {
  return {
    schema_version: 'usage-summary-v1',
    filter: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z' },
    time_basis: 'physical_request_start',
    snapshot: 'snap-1',
    as_of: '2026-10-08T00:00:01.000Z',
    totals: emptyTotals(),
    groups: [],
    coverage: { status: 'complete', scope: 'actor_private', sources: [], excluded_untimed_rows: 0 },
    ...overrides,
  };
}

function summaryResponse(engine: HumentUsageSummary) {
  return {
    engine,
    target: { workspaceId: 'ws', actorId: 'actor', scope: 'actor_private' },
    usageCaveat: 'caveat',
  };
}

function traceRow(overrides: Partial<HumentUsageTraceRow> = {}): HumentUsageTraceRow {
  return {
    id: `row-${Math.random()}`,
    evidence_kind: 'provider_call',
    source: 'hument',
    operation: 'formation',
    provider_operation: 'generation',
    entity_id: 'e1',
    model_basis: 'requested',
    elapsed_ms: 12,
    time_source: 'physical_request_start',
    request_bytes: 10,
    response_bytes: 20,
    response_complete: true,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    usage_source: 'provider',
    token_basis: 'reported',
    actual_cost_micros: null,
    estimated_cost_micros: 0,
    cost_status: 'unknown',
    physical_calls_unknown: false,
    cache_reuses: null,
    adapter_elapsed_ms: 12,
    ...overrides,
  };
}

function traceEngine(overrides: Partial<HumentUsageTrace> = {}): HumentUsageTrace {
  return {
    schema_version: 'usage-trace-v1',
    filter: { since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z' },
    time_basis: 'physical_request_start',
    snapshot: 'snap-1',
    as_of: '2026-10-08T00:00:01.000Z',
    rows: [traceRow({ id: 'r1', operation: 'formation' })],
    total_rows: 1,
    limit: 100,
    has_more: false,
    totals: emptyTotals(),
    coverage: { status: 'complete', scope: 'actor_private', sources: [], excluded_untimed_rows: 0 },
    ...overrides,
  };
}

function nonEmptySummaryResponse() {
  return summaryResponse(
    summaryEngine({
      totals: {
        ...emptyTotals(),
        counts: { ...emptyTotals().counts, logical_calls: 1, evidence_rows: 1 },
      },
    }),
  );
}

function traceResponse(engine: HumentUsageTrace) {
  return {
    engine,
    target: { workspaceId: 'ws', actorId: 'actor', scope: 'actor_private' },
    usageCaveat: 'caveat',
  };
}

interface Handlers {
  projects?: (params: Record<string, unknown>) => unknown | Promise<unknown>;
  projectDetail?: (id: string) => unknown | Promise<unknown>;
  summary?: (id: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  trace?: (id: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  platform?: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

function installHandlers(handlers: Handlers = {}) {
  mockRequest.mockImplementation((config: { url: string; params?: Record<string, unknown> }) => {
    const url = config.url;
    const params = config.params ?? {};
    const respond = (value: unknown) =>
      value instanceof Error || (value as { response?: unknown })?.response
        ? Promise.reject(value)
        : Promise.resolve(envelope(value));

    if (url === '/memory/projects') {
      return respond(handlers.projects ? handlers.projects(params) : projectsResponse());
    }
    if (/^\/memory\/projects\/[^/]+$/.test(url)) {
      const id = url.split('/')[3];
      return respond(handlers.projectDetail ? handlers.projectDetail(id) : project({ id }));
    }
    if (url.endsWith('/usage/summary')) {
      const id = url.split('/')[3];
      return respond(
        handlers.summary ? handlers.summary(id, params) : summaryResponse(summaryEngine()),
      );
    }
    if (url.endsWith('/usage/trace')) {
      const id = url.split('/')[3];
      return respond(handlers.trace ? handlers.trace(id, params) : traceResponse(traceEngine()));
    }
    if (url === '/system/api-usage') {
      return respond(
        handlers.platform
          ? handlers.platform(params)
          : {
              items: [],
              meta: {
                windowFrom: '2026-10-01T00:00:00.000Z',
                windowTo: '2026-10-08T00:00:00.000Z',
                earliestBucketStart: null,
                dataCoverageDays: null,
                groupBy: 'tool',
                metric: 'invocations',
              },
            },
      );
    }
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
}

function callsTo(suffix: string) {
  return mockRequest.mock.calls.filter(([config]) =>
    (config as { url: string }).url.endsWith(suffix),
  );
}

function setUser(role: UserRole) {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'u1@example.com',
      name: 'User One',
      role,
    } as never,
    accessToken: 'token',
    refreshToken: 'refresh',
    isAuthenticated: true,
    isLoading: false,
  });
}

function renderPageWithClient(queryClient: QueryClient) {
  const view = () => (
    <QueryClientProvider client={queryClient}>
      <UsagePage />
    </QueryClientProvider>
  );
  const rendered = render(view());
  rerenderPage = () => rendered.rerender(view());
  return { queryClient, unmount: rendered.unmount };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return renderPageWithClient(queryClient);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParamsString = '';
  rerenderPage = null;
  setUser(UserRole.ADMIN);
  installHandlers();
});

afterEach(() => {
  rerenderPage = null;
});

// ══════════════════════════════════════════════════════════════════════════
// ① Tab / URL / 角色
// ══════════════════════════════════════════════════════════════════════════
describe('Tab / URL / 角色', () => {
  it('admin 无 URL tab → 默认平台 Tab 并发请求；切到 Hument 用 push', async () => {
    installHandlers({
      platform: () => ({
        items: [],
        meta: {
          windowFrom: '2026-10-01T00:00:00.000Z',
          windowTo: '2026-10-08T00:00:00.000Z',
          earliestBucketStart: null,
          dataCoverageDays: null,
          groupBy: 'tool',
          metric: 'invocations',
        },
      }),
    });
    renderPage();

    expect(screen.getByTestId('usage-tab-platform')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('usage-tab-platform')).toHaveAttribute('role', 'tab');
    expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('role', 'tab');
    await waitFor(() => expect(callsTo('/system/api-usage')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('usage-tab-hument'));
    expect(mockPush).toHaveBeenCalled();
    expect(mockSearchParamsString).toContain('tab=hument');
    await waitFor(() =>
      expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('非 admin 无 URL tab → 默认 Hument Tab，且零平台请求', async () => {
    setUser(UserRole.EDITOR);
    renderPage();
    expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(callsTo('/usage/summary')).toHaveLength(1));
    expect(callsTo('/system/api-usage')).toHaveLength(0);
    expect(screen.queryByTestId('platform-usage-table')).not.toBeInTheDocument();
  });

  it('非 admin 显式 tab=platform → 权限面板 + 零平台请求', async () => {
    setUser(UserRole.EDITOR);
    mockSearchParamsString = 'tab=platform';
    renderPage();
    expect(screen.getByTestId('platform-permission')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo('/system/api-usage')).toHaveLength(0);
  });

  it('切 Tab 保留 Hument 的 h_* 命名空间', async () => {
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-10-08T00:00:00.000Z';
    mockSearchParamsString = `tab=hument&h_from=${from}&h_to=${to}`;
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('usage-tab-platform'));
    await waitFor(() =>
      expect(screen.getByTestId('usage-tab-platform')).toHaveAttribute('aria-selected', 'true'),
    );
    expect(new URLSearchParams(mockSearchParamsString).get('h_from')).toBe(from);
    expect(new URLSearchParams(mockSearchParamsString).get('h_to')).toBe(to);
  });

  it('URL tab=hument 优先于角色默认', () => {
    mockSearchParamsString = 'tab=hument';
    renderPage();
    expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('aria-selected', 'true');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② canReadUsage / 权限
// ══════════════════════════════════════════════════════════════════════════
describe('Hument 权限门', () => {
  it('canReadUsage=false → 权限面板，且不发 summary/trace', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({ projects: () => projectsResponse([project({ canReadUsage: false })]) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-permission')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /usage disabled/ })).toBeDisabled();
    expect(callsTo('/usage/summary')).toHaveLength(0);
    expect(callsTo('/usage/trace')).toHaveLength(0);
  });

  it('409/14006 共享身份 → 专用面板（不显示 0，不自动重试）', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => httpError(409, 14006, { hintCode: 'shared_engine_binding' }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-shared')).toBeInTheDocument());
    expect(screen.queryByTestId('hument-summary-cards')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Retry$/ })).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 切项目不裸显旧数字 / ④ stale / ⑤ 独立失败
// ══════════════════════════════════════════════════════════════════════════
describe('数据隔离与刷新语义', () => {
  it('切项目期间不显示上一个项目的数字', async () => {
    mockSearchParamsString = 'tab=hument';
    const projectB = deferred<unknown>();
    installHandlers({
      projects: () =>
        projectsResponse([project(), project({ id: PROJECT_B, name: 'B', slug: 'b' })]),
      summary: (id) =>
        id === PROJECT_A
          ? summaryResponse(
              summaryEngine({
                totals: {
                  ...emptyTotals(),
                  counts: { ...emptyTotals().counts, logical_calls: 111 },
                },
              }),
            )
          : projectB.promise,
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('111'),
    );
    fireEvent.change(screen.getByTestId('hument-project-select'), {
      target: { value: PROJECT_B },
    });

    await waitFor(() => expect(screen.getByTestId('hument-summary-loading')).toBeInTheDocument());
    expect(screen.queryByText('111')).not.toBeInTheDocument();

    await act(async () => {
      projectB.resolve(
        summaryResponse(
          summaryEngine({
            totals: {
              ...emptyTotals(),
              counts: { ...emptyTotals().counts, logical_calls: 222 },
            },
          }),
        ),
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('222'),
    );
  });

  it('刷新失败保留旧数据 + stale + 旧 as_of', async () => {
    mockSearchParamsString = 'tab=hument';
    let calls = 0;
    installHandlers({
      summary: () => {
        calls += 1;
        return calls === 1
          ? summaryResponse(summaryEngine({ as_of: '2026-10-08T00:00:01.000Z' }))
          : httpError(503, 14000, { reason: 'engine_unreachable' });
      },
    });
    const { queryClient } = renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('hument-as-of')).toHaveTextContent('2026-10-08 00:00 UTC'),
    );

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['usage', 'memory', 'summary'] });
    });

    await waitFor(() => expect(screen.getByTestId('hument-summary-stale')).toBeInTheDocument());
    expect(screen.getByTestId('hument-summary-stale')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('hument-summary-stale')).toHaveTextContent('2026-10-08 00:00 UTC');
    expect(screen.getByTestId('hument-summary-retry')).toBeInTheDocument();
    // 旧数据仍在
    expect(screen.getByTestId('hument-summary-cards')).toBeInTheDocument();
  });

  it('stale 横幅 429 也按 Retry-After 倒计时禁用重试', async () => {
    mockSearchParamsString = 'tab=hument';
    let calls = 0;
    installHandlers({
      summary: () => {
        calls += 1;
        if (calls === 1) return nonEmptySummaryResponse();
        return {
          response: {
            status: 429,
            headers: { 'retry-after': '5' },
            data: { code: 429, message: 'limited', data: {} },
          },
        };
      },
    });
    const { queryClient } = renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-summary-cards')).toBeInTheDocument());
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['usage', 'memory', 'summary'] });
    });
    await waitFor(() => expect(screen.getByTestId('hument-summary-stale')).toBeInTheDocument());
    const retry = screen.getByTestId('hument-summary-retry');
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent(/Retry in [45]s/);
    expect(screen.getByTestId('hument-summary-cards')).toBeInTheDocument();
  });

  it('summary 失败与 trace 成功互不拖累', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => httpError(503, 14000, { reason: 'engine_unreachable' }),
      trace: () =>
        traceResponse(traceEngine({ rows: [traceRow({ id: 'r1', operation: 'formation' })] })),
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('hument-error-engineUnavailable')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('formation'),
    );
    expect(screen.queryByTestId('hument-trace-first-error')).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑥ null ≠ 0 / 币种；⑦ coverage
// ══════════════════════════════════════════════════════════════════════════
describe('三态与 coverage', () => {
  it('actual cost null 显示未知；estimated 0 显示 0µ；币种未声明', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () =>
        summaryResponse(
          summaryEngine({
            totals: {
              ...emptyTotals(),
              cost: {
                status: 'partial',
                actual_micros: null,
                known_estimated_micros: 0,
                estimated_micros: 0,
                unknown_estimated_rows: 0,
              },
              tokens: { ...emptyTotals().tokens, total_tokens: 0, known_total_tokens: 0 },
            },
          }),
        ),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('hument-card-cost')).toBeInTheDocument());
    const actual = screen.getByTestId('hument-actual-cost');
    expect(actual).toHaveAttribute('data-unknown', 'true');
    expect(actual).toHaveTextContent('—');
    expect(actual).toHaveClass('text-muted-foreground');
    expect(actual).not.toHaveClass('text-muted-foreground/70');
    expect(screen.getByTestId('hument-estimated-cost')).toHaveTextContent('0 µ');
    expect(screen.getByTestId('hument-currency-note')).toHaveTextContent(
      'Currency is not declared',
    );
    expect(screen.getByTestId('hument-currency-note')).not.toHaveTextContent('$');
    // 口径警示与身份回声必须上屏（不是"项目总消耗/完整账单"）
    expect(screen.getByTestId('hument-caveat')).toHaveTextContent(
      'not the project total or a complete bill',
    );
    expect(screen.getByTestId('hument-target')).toHaveTextContent('workspace ws');
  });

  it('coverage sources/reasons 可展开，excluded 行常驻提示', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () =>
        summaryResponse(
          summaryEngine({
            coverage: {
              status: 'partial',
              scope: 'actor_private',
              excluded_untimed_rows: 4,
              sources: [
                { source: 'provider_receipts', status: 'partial', reasons: ['missing_started_at'] },
              ],
            },
          }),
        ),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('hument-coverage')).toBeInTheDocument());
    expect(screen.getByTestId('hument-coverage-status')).toHaveTextContent('partial');
    expect(screen.getByTestId('hument-coverage-scope')).toHaveTextContent('current identity only');
    expect(screen.getByTestId('hument-coverage-excluded')).toHaveTextContent('4');
    const toggle = screen.getByTestId('hument-coverage-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('hument-coverage-sources')).toHaveTextContent('provider_receipts');
    expect(screen.getByTestId('hument-coverage-sources')).toHaveTextContent('missing_started_at');
  });
});

it('estimated unknown 显示 known/unknown 覆盖，且与 actual 不相加', async () => {
  mockSearchParamsString = 'tab=hument';
  installHandlers({
    summary: () =>
      summaryResponse(
        summaryEngine({
          totals: {
            ...emptyTotals(),
            cost: {
              status: 'partial',
              actual_micros: 10,
              known_estimated_micros: 5,
              estimated_micros: null,
              unknown_estimated_rows: 2,
            },
          },
        }),
      ),
  });
  renderPage();
  await waitFor(() => expect(screen.getByTestId('hument-card-cost')).toBeInTheDocument());
  expect(screen.getByTestId('hument-estimated-coverage')).toHaveTextContent(
    '2 row(s) unknown · 5 known micros',
  );
  expect(screen.getByTestId('hument-cost-nonaddable')).toHaveTextContent('do not add');
});

it('advanced filters 显示启用数量；trace limit 在 trace 区', async () => {
  mockSearchParamsString = 'tab=hument';
  installHandlers({ summary: () => nonEmptySummaryResponse() });
  renderPage();
  await waitFor(() => expect(screen.getByTestId('hument-advanced-toggle')).toBeInTheDocument());
  expect(screen.getByTestId('hument-trace-limit')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('hument-advanced-toggle'));
  fireEvent.change(screen.getByPlaceholderText('formation'), { target: { value: 'formation' } });
  fireEvent.click(screen.getByTestId('hument-filter-apply'));
  await waitFor(() =>
    expect(screen.getByTestId('hument-advanced-toggle')).toHaveTextContent('Advanced filters (1)'),
  );
});

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 平台：Top-N / 混合单位 / 三种空态 / 90 天
// ══════════════════════════════════════════════════════════════════════════
describe('平台 Tab', () => {
  it('Top-N 不求和 + earliest/覆盖警示 + caption', async () => {
    installHandlers({
      platform: () => ({
        // Top-N 警示只在 items.length >= limit 时出现：这里用 20 行触发
        items: Array.from({ length: 20 }, (_, index) => ({
          key: `tool_${index}`,
          callCount: 10 + index,
          distinctActors: 1,
          avgLatencyMs: 5,
          maxLatencyMs: 9,
          errorRate: 0.1,
        })),
        meta: {
          windowFrom: '2026-10-01T00:00:00.000Z',
          windowTo: '2026-10-08T00:00:00.000Z',
          earliestBucketStart: '2026-09-20T00:00:00.000Z',
          dataCoverageDays: 18,
          groupBy: 'tool',
          metric: 'invocations',
        },
      }),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('platform-usage-table')).toBeInTheDocument());
    expect(screen.getByTestId('platform-topn-note')).toHaveTextContent('not a full total');
    expect(screen.getByTestId('platform-coverage-warning')).toHaveTextContent('Less than 28 days');
    expect(screen.getByTestId('platform-window')).toHaveTextContent('2026-10-01 00:00 UTC');
    expect(screen.getByTestId('platform-earliest')).toHaveTextContent('2026-09-20 00:00 UTC');
    expect(
      within(screen.getByTestId('platform-usage-table')).getByText(/Top-N/),
    ).toBeInTheDocument();
    // 展开行 aria-expanded
    const expand = screen.getAllByRole('button', { name: /Expand/ })[0];
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Max ms')).toBeInTheDocument();
  });

  it('groupBy=actor 显示混合单位警示；metric 只对 tool 出现', async () => {
    mockSearchParamsString = 'tab=platform&p_group=actor';
    renderPage();
    expect(screen.queryByTestId('platform-metric')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('platform-mixed-units')).toBeInTheDocument());
  });

  function platformEmptyMeta(earliestBucketStart: string | null) {
    return {
      items: [],
      meta: {
        windowFrom: '2026-10-01T00:00:00.000Z',
        windowTo: '2026-10-08T00:00:00.000Z',
        earliestBucketStart,
        dataCoverageDays: earliestBucketStart ? 30 : null,
        groupBy: 'tool',
        metric: 'invocations',
      },
    };
  }

  it('全表无数据：earliestBucketStart=null', async () => {
    installHandlers({ platform: () => platformEmptyMeta(null) });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('platform-empty-noTableData')).toBeInTheDocument(),
    );
  });

  it('窗口零：表里有数据但本窗口为空', async () => {
    installHandlers({ platform: () => platformEmptyMeta('2026-09-01T00:00:00.000Z') });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-empty-window')).toBeInTheDocument());
  });

  it('过滤零：窗口有数据但 actorType 过滤排除全部', async () => {
    installHandlers({ platform: () => platformEmptyMeta('2026-09-01T00:00:00.000Z') });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-empty-window')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('platform-actor-type'), { target: { value: 'agent' } });
    await waitFor(() => expect(screen.getByTestId('platform-empty-filtered')).toBeInTheDocument());
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑨ Hument 90 天硬上限
// ══════════════════════════════════════════════════════════════════════════
describe('时间窗上限', () => {
  it('自定义 >90 天 → 前端拒绝且不发新 summary 请求', async () => {
    mockSearchParamsString = 'tab=hument';
    renderPage();
    await waitFor(() => expect(callsTo('/usage/summary')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('hument-advanced-toggle'));
    fireEvent.change(screen.getByTestId('hument-window-from'), {
      target: { value: '2026-01-01T00:00' },
    });
    fireEvent.change(screen.getByTestId('hument-window-to'), {
      target: { value: '2026-06-01T00:00' },
    });
    fireEvent.click(screen.getByTestId('hument-filter-apply'));

    expect(screen.getByTestId('hument-filter-error')).toHaveTextContent('must not exceed 90 days');
    expect(callsTo('/usage/summary')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑩ Trace：次数 / 在途丢弃 / 复位上界
// ══════════════════════════════════════════════════════════════════════════
describe('Trace 分页状态机', () => {
  it('首屏失败恰好 1 次（不自动重试）', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: () => httpError(503, 14000, { reason: 'engine_unreachable' }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));

    await waitFor(() => expect(screen.getByTestId('hument-trace-first-error')).toBeInTheDocument());
    expect(callsTo('/usage/trace')).toHaveLength(1);
  });

  it('load-more 成功：已加载 X / 共 total_rows', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: (_id, params) =>
        traceResponse(
          params.cursor
            ? traceEngine({
                rows: [traceRow({ id: 'r2', operation: 'recall' })],
                total_rows: 3,
                has_more: false,
                next_cursor: undefined,
              })
            : traceEngine({
                rows: [traceRow({ id: 'r1', operation: 'formation' })],
                total_rows: 3,
                has_more: true,
                next_cursor: 'c1',
              }),
        ),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));

    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-loaded')).toHaveTextContent('Loaded 1 of 3'),
    );
    fireEvent.click(screen.getByTestId('hument-trace-load-more'));
    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-loaded')).toHaveTextContent('Loaded 2 of 3'),
    );
    const traceCalls = callsTo('/usage/trace');
    expect(traceCalls).toHaveLength(2);
    const summaryCall = callsTo('/usage/summary')[0][0] as { params: Record<string, unknown> };
    const firstTrace = traceCalls[0][0] as { params: Record<string, unknown> };
    const secondTrace = traceCalls[1][0] as { params: Record<string, unknown> };
    // summary 与 trace 首页逐字同窗；第二页回送首页原精度/过滤/limit + cursor
    expect(firstTrace.params.since).toBe(summaryCall.params.since);
    expect(firstTrace.params.until).toBe(summaryCall.params.until);
    expect(String(firstTrace.params.since)).toMatch(/\.\d{3}Z$/);
    expect(secondTrace.params.since).toBe(firstTrace.params.since);
    expect(secondTrace.params.until).toBe(firstTrace.params.until);
    expect(secondTrace.params.limit).toBe(firstTrace.params.limit);
    expect(secondTrace.params.operation).toBe(firstTrace.params.operation);
    expect(secondTrace.params.providerOperation).toBe(firstTrace.params.providerOperation);
    expect(secondTrace.params.model).toBe(firstTrace.params.model);
    expect(secondTrace.params.cursor).toBe('c1');
    expect(screen.getByTestId('hument-trace-end')).toBeInTheDocument();
  });

  it('在途旧 filter 响应被丢弃（新 filter 结果不被旧响应污染）', async () => {
    mockSearchParamsString = 'tab=hument';
    const oldPage = deferred<unknown>();
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: (_id, params) => {
        if (params.operation === 'other') {
          return traceResponse(
            traceEngine({
              rows: [traceRow({ id: 'new-row', operation: 'other' })],
              total_rows: 1,
              has_more: false,
            }),
          );
        }
        if (params.cursor) return oldPage.promise;
        return traceResponse(
          traceEngine({
            rows: [traceRow({ id: 'r1', operation: 'formation' })],
            total_rows: 2,
            has_more: true,
            next_cursor: 'c1',
          }),
        );
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('formation'),
    );

    // 第二页在途
    fireEvent.click(screen.getByTestId('hument-trace-load-more'));
    // 改过滤并应用（新 key；trace 仍展开 → 自动拉新首页）
    fireEvent.click(screen.getByTestId('hument-advanced-toggle'));
    fireEvent.change(screen.getByPlaceholderText('formation'), { target: { value: 'other' } });
    fireEvent.click(screen.getByTestId('hument-filter-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('other'),
    );

    // 旧响应此刻才回来 → 必须被丢弃
    await act(async () => {
      oldPage.resolve(
        traceResponse(
          traceEngine({
            rows: [traceRow({ id: 'old-row', operation: 'old-op' })],
            total_rows: 2,
            has_more: false,
          }),
        ),
      );
    });
    expect(screen.queryByText('old-op')).not.toBeInTheDocument();
    expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('other');
  });

  it('cursor 复位：首次自动重拉首页，第二次停止（有界）', async () => {
    mockSearchParamsString = 'tab=hument';
    let traceCalls = 0;
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: (_id, params) => {
        traceCalls += 1;
        if (params.cursor) {
          return httpError(502, 14004, {
            hintCode: 'cursor_reset_required',
            engineCode: 'conflict',
          });
        }
        return traceResponse(
          traceEngine({
            rows: [traceRow({ id: 'r1', operation: 'formation' })],
            total_rows: 2,
            has_more: true,
            next_cursor: 'c1',
          }),
        );
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() => expect(screen.getByTestId('hument-trace-row-0')).toBeInTheDocument());

    // 第一次 load-more → 502 → 自动重拉首页（保留行）
    fireEvent.click(screen.getByTestId('hument-trace-load-more'));
    await waitFor(() => expect(traceCalls).toBe(3));
    expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('formation');

    // 第二次 load-more → 再次 502 → 停止
    fireEvent.click(screen.getByTestId('hument-trace-load-more'));
    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-load-more-error')).toHaveTextContent(
        'invalidated again after a reset',
      ),
    );
    expect(traceCalls).toBe(4);
    expect(screen.queryByText('Retry this page')).not.toBeInTheDocument();

    // 承诺的出口必须真实有效：点击后增加 session 并实际发首页
    fireEvent.click(screen.getByTestId('hument-trace-restart'));
    await waitFor(() => expect(traceCalls).toBe(5));
    await waitFor(() => expect(screen.getByTestId('hument-trace-load-more')).toBeInTheDocument());
    expect(screen.queryByTestId('hument-trace-load-more-error')).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑩b 其余状态面：无项目 / 列表失败 / 无引擎 / 版本 / 身份 / Hument 空态
// ══════════════════════════════════════════════════════════════════════════
describe('状态面', () => {
  it('无项目 → 空态（不是"用量为零"）', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({ projects: () => projectsResponse([]) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-projects-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('hument-project-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hument-project-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hument-project-page')).not.toBeInTheDocument();
    expect(screen.queryByText('Pick a project above')).not.toBeInTheDocument();
    expect(screen.getByTestId('hument-empty-memory-link')).toHaveAttribute('href', '/memory');
    expect(callsTo('/usage/summary')).toHaveLength(0);
  });

  it('项目列表失败 → 错误面板 + 重试，不发 summary', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({ projects: () => httpError(500, 0) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-projects-error')).toBeInTheDocument());
    expect(callsTo('/usage/summary')).toHaveLength(0);
  });

  it('engine=none → 未绑定说明，不发 summary', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({ projects: () => projectsResponse([project({ engine: 'none' })]) });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('hument-engine-projectUnbound')).toBeInTheDocument(),
    );
    expect(callsTo('/usage/summary')).toHaveLength(0);
  });

  it('版本不足 / 身份未授权 → 专用错误，不出现重试按钮', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => httpError(503, 14000, { reason: 'engine_version_unsupported' }),
    });
    const first = renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-error-version')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Retry$/ })).not.toBeInTheDocument();
    first.unmount();
    rerenderPage = null;

    installHandlers({
      summary: () => httpError(503, 14000, { reason: 'engine_identity_invalid' }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-error-identity')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Retry$/ })).not.toBeInTheDocument();
  });

  it('过滤零 / 无时刻全排除 两种 Hument 空态', async () => {
    mockSearchParamsString = 'tab=hument&h_op=formation';
    installHandlers({ summary: () => summaryResponse(summaryEngine()) });
    const first = renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-empty-filter')).toBeInTheDocument());
    first.unmount();
    rerenderPage = null;

    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () =>
        summaryResponse(
          summaryEngine({
            coverage: {
              status: 'partial',
              scope: 'actor_private',
              sources: [],
              excluded_untimed_rows: 5,
            },
          }),
        ),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-empty-allExcluded')).toBeInTheDocument());
    expect(screen.getByTestId('hument-coverage-excluded')).toHaveTextContent('5');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑫ P0/P1 回归：项目钉住、picker 局部化、深链出口、429、trace 会话/参数
// ══════════════════════════════════════════════════════════════════════════
describe('项目选择与主体隔离', () => {
  const PROJECT_C = '33333333-3333-4333-8333-333333333333';

  function pagedProjects(items: ReturnType<typeof project>[], page: number, total: number) {
    return { items, total, page, pageSize: 100, provisioningAvailable: true };
  }

  it('默认项目钉住并写 URL；翻页不换 activeProject、不卸载 summary', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      projects: (params) =>
        params.page === 2
          ? pagedProjects([project({ id: PROJECT_C, name: 'C', slug: 'c' })], 2, 101)
          : pagedProjects([project(), project({ id: PROJECT_B, name: 'B', slug: 'b' })], 1, 101),
      projectDetail: (id) => project({ id, name: 'A', slug: 'a' }),
      summary: () =>
        summaryResponse(
          summaryEngine({
            totals: {
              ...emptyTotals(),
              counts: { ...emptyTotals().counts, logical_calls: 111, evidence_rows: 1 },
            },
          }),
        ),
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('111'),
    );
    await waitFor(() =>
      expect(new URLSearchParams(mockSearchParamsString).get('project')).toBe(PROJECT_A),
    );

    fireEvent.click(screen.getByTestId('hument-project-next'));
    // picker 进入 loading，但主体仍在（不卸载 summary）
    await waitFor(() => expect(screen.getByTestId('hument-projects-loading')).toBeInTheDocument());
    expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('111');
    expect(screen.getByTestId('hument-project-select')).toHaveValue(PROJECT_A);

    await waitFor(() =>
      expect(screen.queryByTestId('hument-projects-loading')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('111');
    // 只发过首页那一次 summary（列表翻页/深链详情都不改 summary key）
    expect(callsTo('/usage/summary')).toHaveLength(1);
    // A 不在第 2 页 → 按 id 读详情
    expect(
      mockRequest.mock.calls.some(
        ([config]) => (config as { url: string }).url === `/memory/projects/${PROJECT_A}`,
      ),
    ).toBe(true);
  });

  it('同一 QueryClient 热缓存 + 裸 hument URL：project/h_from/h_to 同帧写入，Tab 往返窗口不变', async () => {
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-10-08T00:00:00.000Z';
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryDelay: 0, refetchOnWindowFocus: false },
        mutations: { retry: false },
      },
    });
    installHandlers({ summary: () => nonEmptySummaryResponse() });

    mockSearchParamsString = `tab=hument&project=${PROJECT_A}&h_from=${from}&h_to=${to}`;
    const first = renderPageWithClient(queryClient);
    await waitFor(() => expect(callsTo('/usage/summary')).toHaveLength(1));
    first.unmount();
    rerenderPage = null;

    // 裸 URL：projects 已在同一 QueryClient 热缓存里；归一化必须一次写全三个键
    mockSearchParamsString = 'tab=hument';
    renderPageWithClient(queryClient);
    await waitFor(() => {
      const url = new URLSearchParams(mockSearchParamsString);
      expect(url.get('project')).toBe(PROJECT_A);
      expect(url.get('h_from')).toBeTruthy();
      expect(url.get('h_to')).toBeTruthy();
    });
    const normalized = new URLSearchParams(mockSearchParamsString);
    const firstFrom = normalized.get('h_from');
    const firstTo = normalized.get('h_to');

    fireEvent.click(screen.getByTestId('usage-tab-platform'));
    await waitFor(() =>
      expect(screen.getByTestId('usage-tab-platform')).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.click(screen.getByTestId('usage-tab-hument'));
    await waitFor(() =>
      expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('aria-selected', 'true'),
    );
    const after = new URLSearchParams(mockSearchParamsString);
    expect(after.get('project')).toBe(PROJECT_A);
    expect(after.get('h_from')).toBe(firstFrom);
    expect(after.get('h_to')).toBe(firstTo);
  });

  it('搜索过滤掉选中项目时显示 filtered out，不复用 outsidePage 文案', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      projects: () =>
        projectsResponse([project(), project({ id: PROJECT_B, name: 'B', slug: 'b' })]),
      summary: () => nonEmptySummaryResponse(),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-project-select')).toHaveValue(PROJECT_A));
    fireEvent.change(screen.getByTestId('hument-project-search'), { target: { value: 'nope' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /filtered out by search/ })).toBeInTheDocument(),
    );
  });

  it('项目列表失败只局部报错，已选项目主体保留', async () => {
    mockSearchParamsString = 'tab=hument';
    let calls = 0;
    installHandlers({
      projects: () => {
        calls += 1;
        return calls === 1 ? projectsResponse([project()]) : httpError(500, 0);
      },
      summary: () =>
        summaryResponse(
          summaryEngine({
            totals: {
              ...emptyTotals(),
              counts: { ...emptyTotals().counts, logical_calls: 7, evidence_rows: 1 },
            },
          }),
        ),
    });
    const { queryClient } = renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('7'),
    );

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['usage', 'projects', 1] });
    });
    await waitFor(() => expect(screen.getByTestId('hument-projects-error')).toBeInTheDocument());
    expect(screen.getByTestId('hument-card-logical-calls')).toHaveTextContent('7');
    expect(callsTo('/usage/summary')).toHaveLength(1);
  });

  it('深链项目 404 → picker + 清除 project 有效出口', async () => {
    mockSearchParamsString = `tab=hument&project=${PROJECT_B}`;
    installHandlers({
      projects: () => projectsResponse([project()]),
      projectDetail: (id) =>
        id === PROJECT_B ? httpError(404, 14001) : project({ id, name: 'A', slug: 'a' }),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('hument-project-not-found')).toBeInTheDocument());
    expect(screen.getByTestId('hument-project-select')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('hument-clear-project'));

    await waitFor(() => expect(callsTo('/usage/summary')).toHaveLength(1));
    await waitFor(() =>
      expect(new URLSearchParams(mockSearchParamsString).get('project')).toBe(PROJECT_A),
    );
  });
});

describe('429 / blocked / empty trace', () => {
  it('429 从响应头回退读 Retry-After，倒计时期间禁用重试', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => ({
        response: {
          status: 429,
          headers: { 'retry-after': '5' },
          data: { code: 429, message: 'limited', data: {} },
        },
      }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-error-rateLimited')).toBeInTheDocument());
    const retry = screen.getByTestId('usage-error-retry');
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent(/Retry in [45]s/);
    fireEvent.click(retry);
    expect(callsTo('/usage/summary')).toHaveLength(1);
  });

  it('summaryBlocked（共享）→ trace 禁用且零 trace 请求', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => httpError(409, 14006, { hintCode: 'shared_engine_binding' }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-shared')).toBeInTheDocument());
    const toggle = screen.getByTestId('hument-trace-toggle');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Load trace');
    expect(screen.getByTestId('hument-trace-disabled')).toHaveTextContent('Trace is closed');
    fireEvent.click(toggle);
    expect(callsTo('/usage/trace')).toHaveLength(0);
  });

  it('summary 明确空窗 → trace 禁用并说明', async () => {
    mockSearchParamsString = 'tab=hument';
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-empty-window')).toBeInTheDocument());
    expect(screen.getByTestId('hument-trace-toggle')).toBeDisabled();
    expect(screen.getByTestId('hument-trace-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('hument-trace-disabled')).toHaveTextContent('already shows');
    expect(callsTo('/usage/trace')).toHaveLength(0);
  });
});

describe('Trace 会话与失败恢复', () => {
  it('展开首帧显示 loading，不闪“无 trace 行”', async () => {
    mockSearchParamsString = 'tab=hument';
    const pending = deferred<unknown>();
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: () => pending.promise,
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    expect(screen.getByTestId('hument-trace-loading')).toBeInTheDocument();
    expect(screen.queryByText('No trace rows')).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(traceResponse(traceEngine({ has_more: false })));
    });
    await waitFor(() => expect(screen.getByTestId('hument-trace-row-0')).toBeInTheDocument());
  });

  it('Apply 同 filter 也开启新 trace session，实际重发首页', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: () => traceResponse(traceEngine({ has_more: false })),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() => expect(callsTo('/usage/trace')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('hument-advanced-toggle'));
    fireEvent.click(screen.getByTestId('hument-filter-apply'));
    await waitFor(() => expect(callsTo('/usage/trace')).toHaveLength(2));
    // 同 filter Apply 也刷新 summary（as_of 前进），不是只重启 trace
    await waitFor(() => expect(callsTo('/usage/summary')).toHaveLength(2));
  });

  it('第二页普通失败保留行并可重试', async () => {
    mockSearchParamsString = 'tab=hument';
    let cursorAttempts = 0;
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: (_id, params) => {
        if (!params.cursor) {
          return traceResponse(
            traceEngine({
              rows: [traceRow({ id: 'r1', operation: 'formation' })],
              total_rows: 2,
              has_more: true,
              next_cursor: 'c1',
            }),
          );
        }
        cursorAttempts += 1;
        if (cursorAttempts === 1) return httpError(500, 14000, {});
        return traceResponse(
          traceEngine({
            rows: [traceRow({ id: 'r2', operation: 'recall' })],
            total_rows: 2,
            has_more: false,
          }),
        );
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() => expect(screen.getByTestId('hument-trace-row-0')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('hument-trace-load-more'));
    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-load-more-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('formation');

    fireEvent.click(
      within(screen.getByTestId('hument-trace-load-more-error-panel')).getByTestId(
        'usage-error-retry',
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('hument-trace-loaded')).toHaveTextContent('Loaded 2 of 2'),
    );
  });

  it('游标复位后的首页刷新失败 → stale 分支真实可见', async () => {
    mockSearchParamsString = 'tab=hument';
    let firstPageCalls = 0;
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: (_id, params) => {
        if (params.cursor) {
          return httpError(502, 14004, { hintCode: 'cursor_reset_required' });
        }
        firstPageCalls += 1;
        if (firstPageCalls === 1) {
          return traceResponse(
            traceEngine({
              rows: [traceRow({ id: 'r1', operation: 'formation' })],
              total_rows: 2,
              has_more: true,
              next_cursor: 'c1',
            }),
          );
        }
        return httpError(503, 14000, { reason: 'engine_unreachable' });
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() => expect(screen.getByTestId('hument-trace-row-0')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('hument-trace-load-more'));
    await waitFor(() => expect(screen.getByTestId('hument-trace-stale')).toBeInTheDocument());
    expect(screen.getByTestId('hument-trace-row-0')).toHaveTextContent('formation');
  });
});

describe('窗口与原始参数', () => {
  it('脏 Hument URL 窗口回填合法值；summary/trace 共用同一原精度窗口', async () => {
    mockSearchParamsString = 'tab=hument&h_from=bad&h_to=bad';
    installHandlers({
      summary: () => nonEmptySummaryResponse(),
      trace: () => traceResponse(traceEngine({ has_more: false })),
    });
    renderPage();
    await waitFor(() => expect(callsTo('/usage/summary')).toHaveLength(1));
    const summaryParams = (callsTo('/usage/summary')[0][0] as { params: Record<string, unknown> })
      .params;
    await waitFor(() => {
      const params = new URLSearchParams(mockSearchParamsString);
      expect(params.get('h_from')).toBe(summaryParams.since);
      expect(params.get('h_to')).toBe(summaryParams.until);
    });

    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() => expect(callsTo('/usage/trace')).toHaveLength(1));
    const traceParams = (callsTo('/usage/trace')[0][0] as { params: Record<string, unknown> })
      .params;
    expect(traceParams.since).toBe(summaryParams.since);
    expect(traceParams.until).toBe(summaryParams.until);
  });
});

describe('异步 replace 与显式过滤写入', () => {
  it('router.replace 延迟一拍时：Reset 不复活旧 h_op；改窗+过滤 Apply 保留新 h_op', async () => {
    const oldFrom = '2026-10-01T00:00:00.000Z';
    const oldTo = '2026-10-08T00:00:00.000Z';
    mockSearchParamsString = `tab=hument&h_op=old&h_from=${oldFrom}&h_to=${oldTo}`;
    installHandlers({ summary: () => nonEmptySummaryResponse() });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-advanced-toggle')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('hument-advanced-toggle'));
    fireEvent.click(screen.getByTestId('hument-filter-reset'));
    // 归一化 effect 只能补缺失/非法窗口；不得用旧 searchParams 把 h_op=old 写回来
    await waitFor(() => {
      const url = new URLSearchParams(mockSearchParamsString);
      expect(url.get('h_op')).toBeNull();
      expect(url.get('h_from')).not.toBe(oldFrom);
    });

    fireEvent.change(screen.getByTestId('hument-window-from'), {
      target: { value: '2026-09-01T00:00' },
    });
    fireEvent.change(screen.getByTestId('hument-window-to'), {
      target: { value: '2026-09-10T00:00' },
    });
    fireEvent.change(screen.getByPlaceholderText('formation'), { target: { value: 'new-op' } });
    fireEvent.click(screen.getByTestId('hument-filter-apply'));

    await waitFor(() => {
      const url = new URLSearchParams(mockSearchParamsString);
      expect(url.get('h_op')).toBe('new-op');
      expect(url.get('h_from')).toBe('2026-09-01T00:00:00.000Z');
      expect(url.get('h_to')).toBe('2026-09-10T00:00:00.000Z');
    });
  });
});

describe('平台窗口 / groupBy / coverage unknown', () => {
  function platformResponse(
    metaOverrides: Record<string, unknown> = {},
    items: Array<Record<string, unknown>> = [],
  ) {
    return {
      items,
      meta: {
        windowFrom: '2026-01-01T00:00:00.000Z',
        windowTo: '2026-01-08T00:00:00.000Z',
        earliestBucketStart: '2025-12-01T00:00:00.000Z',
        dataCoverageDays: 30,
        groupBy: 'tool',
        metric: 'invocations',
        ...metaOverrides,
      },
    };
  }

  it('p_from/p_to 合法则逐字复用；切 Tab 往返 + Refresh 不漂窗', async () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-02T00:00:00.000Z';
    mockSearchParamsString = `tab=platform&p_from=${from}&p_to=${to}`;
    installHandlers({ platform: () => platformResponse({ windowFrom: from, windowTo: to }) });
    renderPage();
    await waitFor(() => expect(callsTo('/system/api-usage')).toHaveLength(1));
    let params = (callsTo('/system/api-usage')[0][0] as { params: Record<string, unknown> }).params;
    expect(params.from).toBe(from);
    expect(params.to).toBe(to);

    fireEvent.click(screen.getByTestId('usage-tab-hument'));
    await waitFor(() =>
      expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.click(screen.getByTestId('usage-tab-platform'));
    await waitFor(() => expect(screen.getByTestId('platform-refresh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('platform-refresh'));
    await waitFor(() => expect(callsTo('/system/api-usage').length).toBeGreaterThan(1));
    params = (callsTo('/system/api-usage').at(-1)![0] as { params: Record<string, unknown> })
      .params;
    expect(params.from).toBe(from);
    expect(params.to).toBe(to);
  });

  it('脏平台窗口回填合法 p_from/p_to', async () => {
    mockSearchParamsString = 'tab=platform&p_from=bad&p_to=bad';
    renderPage();
    await waitFor(() => expect(callsTo('/system/api-usage')).toHaveLength(1));
    const params = (callsTo('/system/api-usage')[0][0] as { params: Record<string, unknown> })
      .params;
    await waitFor(() => {
      const url = new URLSearchParams(mockSearchParamsString);
      expect(url.get('p_from')).toBe(params.from);
      expect(url.get('p_to')).toBe(params.to);
    });
  });

  it('Refresh 同窗口重取，isFetching 时 disabled + aria-busy', async () => {
    let calls = 0;
    const pending = deferred<unknown>();
    installHandlers({
      platform: () => {
        calls += 1;
        return calls === 1 ? platformResponse() : pending.promise;
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-empty-window')).toBeInTheDocument());
    const before = (callsTo('/system/api-usage')[0][0] as { params: Record<string, unknown> })
      .params;
    fireEvent.click(screen.getByTestId('platform-refresh'));
    const refresh = screen.getByTestId('platform-refresh');
    await waitFor(() => expect(refresh).toBeDisabled());
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pending.resolve(platformResponse());
    });
    await waitFor(() => expect(refresh).not.toBeDisabled());
    const after = (callsTo('/system/api-usage').at(-1)![0] as { params: Record<string, unknown> })
      .params;
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to);
  });

  it('Jump to now 按当前实际跨度重新物化窗口（custom 保留跨度）', async () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-04T00:00:00.000Z';
    mockSearchParamsString = `tab=platform&p_range=7&p_from=${from}&p_to=${to}`;
    installHandlers({ platform: () => platformResponse({ windowFrom: from, windowTo: to }) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-range')).toHaveValue('custom'));
    fireEvent.click(screen.getByTestId('platform-jump-now'));
    await waitFor(() => {
      const url = new URLSearchParams(mockSearchParamsString);
      expect(url.get('p_from')).not.toBe(from);
      expect(url.get('p_to')).not.toBe(to);
      const span = Date.parse(url.get('p_to')!) - Date.parse(url.get('p_from')!);
      expect(span).toBe(3 * 24 * 60 * 60 * 1000);
    });
    expect(screen.getByTestId('platform-range')).toHaveValue('custom');
  });

  it('p_from/p_to 与 p_range 不一致时按实际窗口推导（28 天 / custom）', async () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to28 = '2026-01-29T00:00:00.000Z';
    mockSearchParamsString = `tab=platform&p_range=7&p_from=${from}&p_to=${to28}`;
    installHandlers({ platform: () => platformResponse({ windowFrom: from, windowTo: to28 }) });
    const first = renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-range')).toHaveValue('28'));
    first.unmount();
    rerenderPage = null;

    const customTo = '2026-01-04T00:00:00.000Z';
    mockSearchParamsString = `tab=platform&p_range=7&p_from=${from}&p_to=${customTo}`;
    installHandlers({ platform: () => platformResponse({ windowFrom: from, windowTo: customTo }) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-range')).toHaveValue('custom'));
    expect(screen.getByRole('option', { name: 'Custom window' })).toBeInTheDocument();
  });

  it('dataCoverageDays=null 显示 unknown 警示，不显示 0 天', async () => {
    installHandlers({
      platform: () => platformResponse({ dataCoverageDays: null }),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-earliest')).toBeInTheDocument());
    expect(screen.getByTestId('platform-earliest')).toHaveTextContent('coverage is unknown');
    expect(screen.getByTestId('platform-earliest')).not.toHaveTextContent('0 day');
    expect(screen.getByTestId('platform-coverage-warning')).toHaveTextContent(
      'cannot be ruled out',
    );
  });

  it('非 actor groupBy 不渲染 Type 列/假 actor 详情；actor 用 i18n', async () => {
    mockSearchParamsString = 'tab=platform&p_group=tool';
    installHandlers({
      platform: () =>
        platformResponse({ groupBy: 'tool' }, [
          {
            key: 'tool_a',
            callCount: 1,
            distinctActors: 1,
            avgLatencyMs: 1,
            maxLatencyMs: 2,
            errorRate: 0,
          },
        ]),
    });
    const first = renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-usage-table')).toBeInTheDocument());
    expect(
      within(screen.getByTestId('platform-usage-table')).queryByRole('columnheader', {
        name: 'Actor type',
      }),
    ).not.toBeInTheDocument();
    const expand = screen.getAllByRole('button', { name: /Expand/ })[0];
    fireEvent.click(expand);
    expect(screen.queryByText('Actor name')).not.toBeInTheDocument();
    first.unmount();
    rerenderPage = null;

    mockSearchParamsString = 'tab=platform&p_group=actor';
    installHandlers({
      platform: () =>
        platformResponse({ groupBy: 'actor' }, [
          {
            key: null,
            callCount: 1,
            distinctActors: 0,
            avgLatencyMs: 1,
            maxLatencyMs: 2,
            errorRate: 0,
            actorType: 'anonymous',
          },
          {
            key: 'u1',
            actorName: 'deleted actor',
            actorType: 'human',
            callCount: 2,
            distinctActors: 1,
            avgLatencyMs: 1,
            maxLatencyMs: 2,
            errorRate: 0,
          },
        ]),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-usage-table')).toBeInTheDocument());
    expect(
      within(screen.getByTestId('platform-usage-table')).getByRole('columnheader', {
        name: 'Actor type',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('platform-row-anonymous')).getAllByText('Anonymous').length,
    ).toBeGreaterThan(0);
    const deletedRow = screen.getByTestId('platform-row-u1');
    expect(within(deletedRow).getByText('Deleted actor')).toBeInTheDocument();
    fireEvent.click(within(deletedRow).getByRole('button', { name: /Expand/ }));
    expect(
      within(screen.getByTestId('platform-row-detail-u1')).getByText('Deleted actor'),
    ).toBeInTheDocument();
  });

  it('平台刷新失败 → stale + 重试恢复且不换窗口', async () => {
    installHandlers({
      platform: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          if (calls === 2) return httpError(503, 14000, { reason: 'engine_unreachable' });
          return platformResponse({}, [
            {
              key: 'tool_a',
              callCount: 1,
              distinctActors: 1,
              avgLatencyMs: 1,
              maxLatencyMs: 2,
              errorRate: 0,
            },
          ]);
        };
      })(),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-usage-table')).toBeInTheDocument());
    const before = (callsTo('/system/api-usage')[0][0] as { params: Record<string, unknown> })
      .params;
    fireEvent.click(screen.getByTestId('platform-refresh'));
    await waitFor(() => expect(screen.getByTestId('platform-stale')).toBeInTheDocument());
    expect(screen.getByTestId('platform-stale')).toHaveAttribute('role', 'status');
    fireEvent.click(screen.getByTestId('platform-stale-retry'));
    await waitFor(() => expect(screen.getByTestId('platform-usage-table')).toBeInTheDocument());
    const after = (callsTo('/system/api-usage').at(-1)![0] as { params: Record<string, unknown> })
      .params;
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to);
  });

  it('Top-N 警示只在 items>=limit 时出现；账本归属声明常驻', async () => {
    installHandlers({ platform: () => platformResponse() });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('platform-empty-window')).toBeInTheDocument());
    expect(screen.queryByTestId('platform-topn-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('platform-ledger-scope')).toHaveTextContent('separate ledger');
  });
});

describe('未知值的分行/分列与 trace 原值', () => {
  it('三个 unknown token 维度不相加；http_status 缺失显示未知', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () =>
        summaryResponse(
          summaryEngine({
            groups: [
              {
                operation: 'formation',
                provider_operation: 'generation',
                model: 'm',
                model_basis: 'requested',
                totals: {
                  ...emptyTotals(),
                  tokens: {
                    ...emptyTotals().tokens,
                    unknown_input_rows: 1,
                    unknown_output_rows: 2,
                    unknown_total_rows: 3,
                  },
                },
              },
            ],
          }),
        ),
      trace: () =>
        traceResponse(
          traceEngine({
            rows: [traceRow({ id: 'r1', http_status: undefined })],
            has_more: false,
          }),
        ),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-groups-table')).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByTestId('hument-groups-table')).getByRole('button', {
        name: /Expand group formation/,
      }),
    );
    const detail = screen.getByTestId('hument-group-detail-row-0');
    for (const [label, value] of [
      ['Unknown input-token rows', '1'],
      ['Unknown output-token rows', '2'],
      ['Unknown total-token rows', '3'],
    ] as const) {
      expect(within(detail).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(detail).not.toHaveTextContent('6');

    fireEvent.click(screen.getByTestId('hument-trace-toggle'));
    await waitFor(() => expect(screen.getByTestId('hument-trace-row-0')).toBeInTheDocument());
    const expand = screen.getByRole('button', { name: /Expand trace row/ });
    fireEvent.click(expand);
    const traceDetail = screen.getByTestId('hument-trace-detail-0');
    const httpCell = within(traceDetail).getByText('HTTP status').nextElementSibling;
    expect(httpCell?.querySelector('[data-unknown="true"]')).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑪ 可访问性 / 移动关键语义
// ══════════════════════════════════════════════════════════════════════════
describe('可访问性与移动语义', () => {
  it('项目选择器窄屏收缩 class 契约（jsdom 不证明 375 布局）', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({ summary: () => nonEmptySummaryResponse() });
    renderPage();
    const select = await screen.findByTestId('hument-project-select');
    // 移动端：w-full + min-w-0 允许 flex item 收缩；桌面：auto + 22rem 上限不回归
    expect(select).toHaveClass('w-full', 'min-w-0', 'sm:w-auto', 'sm:max-w-[22rem]');
    const label = select.closest('label');
    expect(label).toHaveClass('w-full', 'min-w-0', 'sm:w-auto');
    // 搜索框 192px、分页按钮均为小固定宽，未触发真实溢出，本批不改
    expect(screen.getByTestId('hument-project-search')).toHaveClass('w-48');
  });

  it('Groups caption / 行展开 aria-expanded / 移动卡片容器', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () =>
        summaryResponse(
          summaryEngine({
            groups: [
              {
                operation: 'formation',
                provider_operation: 'generation',
                model: 'm',
                model_basis: 'requested',
                totals: emptyTotals(),
              },
            ],
          }),
        ),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId('hument-groups-table')).toBeInTheDocument());
    expect(
      within(screen.getByTestId('hument-groups-table')).getByText(
        'Usage by operation, provider operation and model',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('hument-groups-mobile')).toBeInTheDocument();
    const expand = within(screen.getByTestId('hument-groups-table')).getByRole('button', {
      name: /Expand group formation/,
    });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('hument-group-detail-row-0')).toBeInTheDocument();

    // 静态说明不是 live region；预设 aria-pressed 真实
    expect(screen.getByTestId('hument-caveat')).not.toHaveAttribute('role');
    fireEvent.click(screen.getByTestId('hument-preset-28'));
    expect(screen.getByTestId('hument-preset-28')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('hument-preset-7')).toHaveAttribute('aria-pressed', 'false');
  });

  it('Groups 分档展开：默认 10 组，点击再多 20 组', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({
      summary: () =>
        summaryResponse(
          summaryEngine({
            groups: Array.from({ length: 30 }, (_, index) => ({
              operation: `op_${index}`,
              provider_operation: 'generation',
              model: 'm',
              model_basis: 'requested',
              totals: emptyTotals(),
            })),
          }),
        ),
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-groups-table')).toBeInTheDocument());
    expect(screen.getAllByTestId(/hument-group-row-/)).toHaveLength(10);
    fireEvent.click(screen.getByTestId('hument-groups-show-all'));
    await waitFor(() => expect(screen.getAllByTestId(/hument-group-row-/)).toHaveLength(30));
  });

  it('Trace 滚动区可键盘聚焦且带 region/caption', async () => {
    mockSearchParamsString = 'tab=hument';
    installHandlers({ summary: () => nonEmptySummaryResponse() });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('hument-trace-toggle')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('hument-trace-toggle'));

    await waitFor(() => expect(screen.getByTestId('hument-trace-scroll')).toBeInTheDocument());
    const scroll = screen.getByTestId('hument-trace-scroll');
    expect(scroll).toHaveAttribute('tabindex', '0');
    expect(scroll).toHaveAttribute('role', 'region');
    expect(scroll).toHaveAttribute('aria-label', 'Recorded usage rows for the current window');
    expect(screen.getByTestId('hument-trace-table')).toHaveClass('min-w-[48rem]');
    expect(
      within(screen.getByTestId('hument-trace-table')).getByText(
        'Recorded usage rows for the current window',
      ),
    ).toBeInTheDocument();
  });
});
