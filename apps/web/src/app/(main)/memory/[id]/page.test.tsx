/**
 * memory/[id]/page.test.tsx — 记忆详情页契约测试（含更正链时间线）
 *
 * 隔离策略同列表页：**只 mock axios**（`@/lib/api` 走真实实现），断言"发出去的是什么请求"
 * 与"渲染出来的是什么"。
 *
 * 覆盖清单（plan v2.1 §2 步骤 12 详情页必含项）：
 * ① 串链：链序 + 现行版本标记 + 点击节点写 `?v=`（push）；
 * ② 分叉：`withdrawn` 更正行单列「未达成尝试」，不进主链；
 * ③ 断链标记：cap 触顶 ⇒「链可能不完整」；
 * ④ 单版本记忆**不渲染**时间线；
 * ⑤ 降级态：metadata 投影 = 独立「仅元数据可见」态（不是通用错误/重试）；
 * ⑥ `?v=` 指向链外节点 → 正文照常 + 时间线注明；
 * ⑦ **正文/header 不 gate 于链**：链查询失败，正文毫发无损；
 * ⑧ 403/404 独立态（不给重试死胡同）；
 * ⑨ 来源回查入口与"已变化"提示。
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MemoryDetailPage from './page';
import { axiosInstance } from '@/lib/api';
import enMessages from '@/i18n/messages/en.json';
import type {
  MemoryNominationDto,
  MemoryNominationListResponse,
  MemoryViewHistoryItem,
  MemoryViewLadderSlot,
} from '@/lib/memory';

let mockRowId = 'n1';
let mockSearchParamsString = '';
const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: mockRowId }),
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  usePathname: () => `/memory/${mockRowId}`,
  useRouter: () => ({ push: mockPush }),
}));

/** 摊平真实语言包（文案本身就是验收项，手抄快照没有证明力） */
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
  memory: enMessages.memory,
  common: enMessages.common,
});

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (params) {
      for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
    }
    return text;
  },
}));

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

const PROJECT = '11111111-1111-4111-8111-111111111111';

const BASE_FIELDS = {
  category: 'ruling',
  nominatorId: 'a1b2c3d4-0000-4000-8000-000000000001',
  nominatorType: 'agent',
  nominatorName: 'Agent One',
  nominatorDeletedAt: null,
  projectId: PROJECT,
  reviewAt: null,
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** 链上一行（full 档） */
function row(overrides: Partial<MemoryNominationDto> = {}): MemoryNominationDto {
  return {
    projection: 'full',
    formationState: 'committed',
    status: 'active',
    correctionOf: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    subject: 'Claim',
    scope: 'Scope',
    effectiveNote: null,
    content: 'assembled content',
    contentExcerpt: 'excerpt',
    sources: [],
    recoveryPath: null,
    deferred: false,
    ...BASE_FIELDS,
    ...overrides,
  } as MemoryNominationDto;
}

/** 详情 + 链 两路 mock（链按 page/pageSize 切片，total 可控 ⇒ 覆盖 cap 触顶） */
function makeRouter(options: {
  details?: Record<string, MemoryNominationDto>;
  detailError?: { status: number; code: number };
  chainRows?: MemoryNominationDto[];
  /** 链的 total（默认 = chainRows.length；给大值即可模拟"页数不够"） */
  chainTotal?: number;
  chainError?: { status: number; code: number };
  /** views detail 的五槽（缺省 = 全 R0 恒等常量，正是 dev 的真形态） */
  viewLadder?: MemoryViewLadderSlot[];
  /** views detail 失败（如 404/14003 = 映射缺失 / 来源不可见） */
  viewError?: { status: number; code: number; data?: Record<string, unknown> };
  /** views history 的条目 */
  historyItems?: MemoryViewHistoryItem[];
  /** views representation 的正文（按 representation_id 取） */
  representationBodies?: Record<string, string>;
  /** views representation 失败（M4：404/14003 = 引擎投影不可读） */
  representationError?: { status: number; code: number };
  /** views representation 的正文被引擎截断（body_truncated 必须显式标注） */
  representationTruncated?: boolean;
}) {
  return (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ?? '';
    if (method === 'GET' && /^\/memory\/nominations\/[^/]+$/.test(url)) {
      if (options.detailError)
        return Promise.reject(httpError(options.detailError.status, options.detailError.code));
      const id = url.split('/').pop() as string;
      const detail = options.details?.[id];
      if (!detail) return Promise.reject(httpError(404, 14003));
      return Promise.resolve(envelope(detail));
    }
    if (method === 'GET' && /^\/memory\/projects\/[^/]+\/nominations$/.test(url)) {
      if (options.chainError)
        return Promise.reject(httpError(options.chainError.status, options.chainError.code));
      const rows = options.chainRows ?? [];
      const total = options.chainTotal ?? rows.length;
      const page = Number(config.params?.page ?? 1);
      const pageSize = Number(config.params?.pageSize ?? 100);
      const start = (page - 1) * pageSize;
      const response: MemoryNominationListResponse = {
        items: rows.slice(start, start + pageSize),
        total,
        page,
        pageSize,
        engineAvailability: { engine: 'hument', available: true, reason: null },
      };
      return Promise.resolve(envelope(response));
    }
    // ── views 族（引擎投影）────────────────────────────────────────────────
    if (method === 'GET' && /\/views\/memories\/[^/]+$/.test(url)) {
      if (options.viewError)
        return Promise.reject(
          httpError(options.viewError.status, options.viewError.code, options.viewError.data),
        );
      return Promise.resolve(
        envelope({
          engine: {
            memory: { memory_id: 'm1', active_resolution: 'R0', available_resolution: 'R0' },
            sections: {
              representations: { page: projectionPage(), ladder: options.viewLadder ?? [] },
              anchors: { page: projectionPage(), items: [] },
              relations: { page: projectionPage(), items: [] },
            },
          },
          trustLevel: 'untrusted_advisory',
          decisionAuthority: 'none',
          usageNote: 'note',
        }),
      );
    }
    if (method === 'GET' && /\/views\/memories\/[^/]+\/history\/[^/]+$/.test(url)) {
      return Promise.resolve(
        envelope({
          engine: {
            memory_id: 'm1',
            resolution: url.split('/').pop() as string,
            page: projectionPage(),
            items: options.historyItems ?? [],
          },
          trustLevel: 'untrusted_advisory',
          decisionAuthority: 'none',
          usageNote: 'note',
        }),
      );
    }
    if (method === 'GET' && /\/views\/memories\/[^/]+\/representations\/[^/]+$/.test(url)) {
      if (options.representationError) {
        return Promise.reject(
          httpError(options.representationError.status, options.representationError.code),
        );
      }
      const representationId = url.split('/').pop() as string;
      return Promise.resolve(
        envelope({
          engine: {
            memory_id: 'm1',
            representation: {
              representation_id: representationId,
              body: options.representationBodies?.[representationId] ?? 'historical body',
              body_truncated: options.representationTruncated ?? false,
              original_bytes: 16,
            },
          },
          trustLevel: 'untrusted_advisory',
          decisionAuthority: 'none',
          usageNote: 'note',
        }),
      );
    }
    return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
  };
}

/** 投影分页块（views 族响应的最小可用形状） */
function projectionPage() {
  return {
    total: 0,
    total_kind: 'exact' as const,
    loaded: 0,
    next_cursor: '',
    partial: false,
    truncated: false,
    truncation_reason: '',
  };
}

/** 造一个阶梯槽 */
function ladderSlot(
  resolution: string,
  overrides: Partial<MemoryViewLadderSlot> = {},
): MemoryViewLadderSlot {
  return {
    resolution,
    state: 'current_materialized',
    active: resolution === 'R0',
    current: null,
    historical_count: 0,
    ...overrides,
  };
}

/** 五槽：全 R0（dev 种子的真形态） */
function defaultLadder(): MemoryViewLadderSlot[] {
  return ['R0', 'R1', 'R2', 'R3', 'R4'].map((resolution) =>
    ladderSlot(resolution, {
      state: resolution === 'R0' ? 'current_materialized' : 'beyond_available',
      current:
        resolution === 'R0'
          ? {
              representation_id: 'rep-r0',
              resolution: 'R0',
              revision_id: 'rev-1',
              mutation_id: 'mut-1',
              source_ref: 'chamber://doc/d1',
              current: true,
              body: 'current R0 body',
              digest: 'dg',
              original_bytes: 16,
              body_truncated: false,
              created_at: '2026-10-01T00:00:00.000Z',
            }
          : null,
    }),
  );
}

function renderPage() {
  // retryDelay: 0 —— 页面调用点显式 `retry: 1`（不吃全局默认），测试端把退避压掉
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryDetailPage />
    </QueryClientProvider>,
  );
}

/** 链请求（详情页唯一会翻页的请求） */
function chainCalls() {
  return mockRequest.mock.calls
    .map((call) => call[0] as { method?: string; url?: string; params?: Record<string, unknown> })
    .filter(
      (config) =>
        (config.method ?? 'GET').toUpperCase() === 'GET' &&
        !!config.url?.includes('/projects/') &&
        config.url.includes('/nominations'),
    );
}

describe('MemoryDetailPage 正文与元信息', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('渲染正文（保行结构）/ 主张 / 元信息 / 提名者 / 账本 id', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', subject: 'Claim one', content: 'line1\nline2' }) },
        chainRows: [row({ id: 'n1' })],
      }),
    );
    renderPage();

    const content = await screen.findByTestId('memory-detail-content');
    // 装配正文是模板文本，行结构本身是信息 ⇒ pre-wrap（markdown 会把单换行折叠掉）
    expect(content.className).toContain('whitespace-pre-wrap');
    expect(content).toHaveTextContent('line1 line2');
    expect(screen.getByTestId('memory-detail-subject')).toHaveTextContent('Claim one');
    expect(screen.getByTestId('memory-detail-ledger-id')).toHaveTextContent('n1');
    expect(screen.getByTestId('memory-detail-nominator')).toHaveTextContent('Agent One');
    expect(screen.queryByTestId('memory-degraded-banner')).toBeNull();
  });

  it('⑨ 来源：locator + 标题路径 + 「已变化」提示 + 回查工具入口（信任框信封的一部分）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: {
          n1: row({
            id: 'n1',
            sources: [
              {
                type: 'doc',
                id: 'd1',
                parent: null,
                versionHash: 'h1',
                headingPath: 'Docs § 1.2',
                locator: 'chamber://doc/d1#h1',
                moved: true,
                readWith: { tool: 'read_doc', params: { id: 'd1' } },
              },
            ],
          }),
        },
        chainRows: [row({ id: 'n1' })],
      }),
    );
    renderPage();

    const source = await screen.findByTestId('memory-detail-source');
    expect(source).toHaveTextContent('chamber://doc/d1#h1');
    expect(source).toHaveTextContent('Docs § 1.2');
    expect(within(source).getByTestId('memory-detail-source-moved')).toBeInTheDocument();
    expect(source).toHaveTextContent('Re-read with read_doc');
  });

  it('纯著述（sources 为空数组）→ 明说"没有来源"，不摆空列表', async () => {
    mockRequest.mockImplementation(
      makeRouter({ details: { n1: row({ id: 'n1' }) }, chainRows: [row({ id: 'n1' })] }),
    );
    renderPage();

    expect(await screen.findByTestId('memory-detail-sources')).toHaveTextContent(
      messages['memory.detail.sourcesEmpty'],
    );
  });
});

describe('MemoryDetailPage 更正链时间线（D2 / 第 27-33 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('① 串链：n1 → n2 → n3，现行版本是最新节点，Tab 序 = 链序', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: {
          n1: row({
            id: 'n1',
            subject: 'First',
            status: 'superseded',
            createdAt: '2026-10-01T00:00:00.000Z',
          }),
        },
        chainRows: [
          row({
            id: 'n1',
            subject: 'First',
            status: 'superseded',
            createdAt: '2026-10-01T00:00:00.000Z',
          }),
          row({
            id: 'n2',
            subject: 'Second',
            status: 'superseded',
            correctionOf: 'n1',
            createdAt: '2026-10-02T00:00:00.000Z',
          }),
          row({
            id: 'n3',
            subject: 'Third',
            status: 'active',
            correctionOf: 'n2',
            createdAt: '2026-10-03T00:00:00.000Z',
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-detail-content');

    const nodes = await screen.findAllByTestId('memory-timeline-node');
    expect(nodes.map((node) => node.textContent)).toEqual([
      expect.stringContaining('First'),
      expect.stringContaining('Second'),
      expect.stringContaining('Third'),
    ]);
    // 现行版本 = 主链末端（没有任何主链节点取代它）
    const current = screen.getByTestId('memory-timeline-current');
    expect(current.closest('[data-testid="memory-timeline-node"]')).toBe(nodes[2]);
    // `aria-current` 是颜色之外的第二个通道
    expect(nodes[2]).toHaveAttribute('aria-current', 'true');
    expect(nodes[0]).not.toHaveAttribute('aria-current');

    // 点击节点 → `?v=<ledgerId>` 进 URL，且走 **push**（位置语义，后退能回上一版）
    fireEvent.click(nodes[2]);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(String(mockPush.mock.calls[0][0])).toContain('v=n3');
  });

  it('② 分叉：withdrawn 更正行**不进主链**，单列「未达成尝试」', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', subject: 'First' }) },
        chainRows: [
          row({
            id: 'n1',
            subject: 'First',
            status: 'superseded',
            createdAt: '2026-10-01T00:00:00.000Z',
          }),
          row({
            id: 'n2',
            subject: 'Second',
            status: 'active',
            correctionOf: 'n1',
            createdAt: '2026-10-02T00:00:00.000Z',
          }),
          // 同一条 n1 的第二支更正，但未达成（withdrawn 释放了唯一位）
          row({
            id: 'n2b',
            subject: 'Attempt that failed',
            status: 'withdrawn',
            formationState: 'failed',
            correctionOf: 'n1',
            createdAt: '2026-10-02T12:00:00.000Z',
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-detail-content');

    const nodes = await screen.findAllByTestId('memory-timeline-node');
    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.textContent).join(' ')).not.toContain('Attempt that failed');

    const withdrawn = screen.getByTestId('memory-timeline-withdrawn');
    expect(withdrawn).toHaveTextContent(messages['memory.timeline.withdrawnTitle']);
    expect(withdrawn).toHaveTextContent('Attempt that failed');
  });

  it('③ 断链标记：链查询 cap 触顶 ⇒ 显式「链可能不完整」（不许静默少画）', async () => {
    // total=600 ⇒ 5 页 * 100 仍取不全 ⇒ truncated
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1' }) },
        chainRows: [
          row({ id: 'n1', subject: 'First' }),
          row({ id: 'n2', subject: 'Second', correctionOf: 'n1' }),
        ],
        chainTotal: 600,
      }),
    );
    renderPage();
    await screen.findByTestId('memory-detail-content');

    expect(await screen.findByTestId('memory-timeline-truncated')).toHaveTextContent(
      messages['memory.timeline.chainIncomplete'],
    );
    // cap 5 页：请求页数不超过 5（避免把"拉全项目账本"变成无界操作）
    expect(chainCalls().length).toBeLessThanOrEqual(5);
  });

  it('④ 单版本记忆不渲染时间线（一条线的"版本树"是噪音）', async () => {
    mockRequest.mockImplementation(
      makeRouter({ details: { n1: row({ id: 'n1' }) }, chainRows: [row({ id: 'n1' })] }),
    );
    renderPage();
    await screen.findByTestId('memory-detail-content');

    await waitFor(() => expect(chainCalls().length).toBeGreaterThan(0));
    expect(screen.queryByTestId('memory-timeline')).toBeNull();
  });

  it('⑦ 正文不 gate 于链：链查询失败 → 时间线自报错 + 手动刷新，正文毫发无损', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', content: 'body survives' }) },
        chainError: { status: 500, code: 9999 },
      }),
    );
    renderPage();

    // 正文先到、照常渲染
    expect(await screen.findByTestId('memory-detail-content')).toHaveTextContent('body survives');
    const timelineError = await screen.findByTestId('memory-timeline-error');
    expect(timelineError).toHaveTextContent(messages['memory.timeline.unavailable']);
    expect(within(timelineError).getByText(messages['memory.timeline.retry'])).toBeInTheDocument();
    // 正文没有被"链挂了"连坐
    expect(screen.getByTestId('memory-detail-content')).toBeInTheDocument();
  });

  it('⑥ `?v=` 链外节点：正文照常（按该版本取详情）+ 时间线注明「不在当前链视图内」', async () => {
    mockRowId = 'n1';
    mockSearchParamsString = 'v=33333333-3333-4333-8333-333333333333';
    mockRequest.mockImplementation(
      makeRouter({
        details: {
          n1: row({ id: 'n1' }),
          '33333333-3333-4333-8333-333333333333': row({
            id: '33333333-3333-4333-8333-333333333333',
            subject: 'A version outside the loaded window',
            content: 'outside body',
          }),
        },
        // 真链（n1 ← n2）——单节点链会让时间线整体不渲染，那时"链视图"本身不存在
        chainRows: [row({ id: 'n1' }), row({ id: 'n2', correctionOf: 'n1' })],
      }),
    );
    renderPage();

    // 正文来自 `?v=` 指向的那一行（不是路由里的 n1）
    expect(await screen.findByTestId('memory-detail-content')).toHaveTextContent('outside body');
    expect(screen.getByTestId('memory-detail-subject')).toHaveTextContent(
      'A version outside the loaded window',
    );
    expect(await screen.findByTestId('memory-timeline-outside-chain')).toHaveTextContent(
      messages['memory.timeline.outsideChain'],
    );
  });

  it('回到现行版本：选中不在末端时给出口，点了写 `?v=`', async () => {
    mockRowId = 'n1';
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', subject: 'First' }) },
        chainRows: [
          row({
            id: 'n1',
            subject: 'First',
            status: 'superseded',
            createdAt: '2026-10-01T00:00:00.000Z',
          }),
          row({
            id: 'n2',
            subject: 'Second',
            correctionOf: 'n1',
            createdAt: '2026-10-02T00:00:00.000Z',
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-detail-content');

    const back = await screen.findByTestId('memory-timeline-back-to-current');
    fireEvent.click(back);
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(String(mockPush.mock.calls[0][0])).toContain('v=n2');
  });

  it('项目参数与响应不一致时**以响应为准**（URL 只是加载前占位）', async () => {
    mockSearchParamsString = 'project=99999999-9999-4999-8999-999999999999';
    mockRequest.mockImplementation(
      makeRouter({ details: { n1: row({ id: 'n1' }) }, chainRows: [row({ id: 'n1' })] }),
    );
    renderPage();
    await screen.findByTestId('memory-detail-content');

    // 链请求必须打到**响应里的** projectId（参数错项目 ⇒ 链恒空 ⇒ 有链记忆会被伪装成单版本）
    await waitFor(() => expect(chainCalls().length).toBeGreaterThan(0));
    expect(chainCalls()[0].url).toBe(`/memory/projects/${PROJECT}/nominations`);
  });
});

describe('MemoryDetailPage 降级与不可见态（第 20 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('⑤ metadata 投影 → 独立「仅元数据可见」态（权限说明 + 返回账本），不是通用重试', async () => {
    const meta = row({ id: 'n1' });
    delete meta.subject;
    delete meta.scope;
    delete meta.effectiveNote;
    delete meta.content;
    delete meta.contentExcerpt;
    delete meta.sources;
    mockRequest.mockImplementation(
      makeRouter({ details: { n1: { ...meta, projection: 'metadata' } }, chainRows: [] }),
    );
    renderPage();

    const state = await screen.findByTestId('memory-detail-metadata-only');
    expect(state).toHaveTextContent(messages['memory.detail.metadataOnlyTitle']);
    expect(state).toHaveTextContent(messages['memory.detail.metadataOnlyDesc']);
    expect(within(state).getByText(messages['memory.detail.metadataOnlyBack'])).toBeInTheDocument();
    // 正文区不渲染（也没有"重试"这种死胡同按钮）
    expect(screen.queryByTestId('memory-detail-content')).toBeNull();
    expect(screen.getByTestId('memory-metadata-badge')).toBeInTheDocument();
  });

  it('⑧ 404/14003 → 独立不可见态 + 返回账本（不给重试）', async () => {
    mockRequest.mockImplementation(makeRouter({ detailError: { status: 404, code: 14003 } }));
    renderPage();

    const unavailable = await screen.findByTestId('memory-detail-unavailable');
    expect(unavailable).toHaveTextContent(messages['memory.detail.notFound']);
    expect(
      within(unavailable).getByText(messages['memory.detail.notFoundBack']),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('memory-detail-error')).toBeNull();
  });

  it('403/1009（内容读权限不足）同样走独立不可见态', async () => {
    mockRequest.mockImplementation(makeRouter({ detailError: { status: 403, code: 1009 } }));
    renderPage();

    expect(await screen.findByTestId('memory-detail-unavailable')).toBeInTheDocument();
  });

  it('通用错误（500）→ 通用错误态 + 重试（与上面两种独立态分叉）', async () => {
    mockRequest.mockImplementation(makeRouter({ detailError: { status: 500, code: 9999 } }));
    renderPage();

    const error = await screen.findByTestId('memory-detail-error');
    expect(error).toHaveTextContent(messages['memory.detail.errorTitle']);
    expect(screen.queryByTestId('memory-detail-unavailable')).toBeNull();
  });

  it('复核时间已过 → 显示到期标记（本地时间戳比较，与后端 reviewBefore 同口径）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', reviewAt: '2020-01-01T00:00:00.000Z' }) },
        chainRows: [row({ id: 'n1' })],
      }),
    );
    renderPage();

    const header = await screen.findByTestId('memory-detail-header');
    expect(header).toHaveTextContent(messages['memory.nomination.reviewDue']);
  });

  it('recoveryPath 白名单映射：不裸渲染机器码（未映射值走通用文案）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', recoveryPath: 'hub_manual_required' }) },
        chainRows: [row({ id: 'n1' })],
      }),
    );
    renderPage();

    const recovery = await screen.findByTestId('memory-detail-recovery');
    expect(recovery).toHaveTextContent(messages['memory.recovery.hubManualRequired']);
    expect(recovery).not.toHaveTextContent('hub_manual_required');
    // 详情页给**复制**出口（卡片里不行——整卡是链接，第 26 与 48 条的交汇点）
    expect(within(recovery).getByTestId('memory-recovery-copy')).toHaveTextContent(
      messages['memory.recovery.copyLedgerId'],
    );
  });
});

/** views 族请求（详情页右栏新块；用于断言"折叠/无引擎记忆时零请求"） */
function viewsCalls() {
  return mockRequest.mock.calls
    .map((call) => call[0] as { method?: string; url?: string })
    .filter((config) => !!config.url?.includes('/views/'));
}

/**
 * 右栏新增两块（分辨率阶梯 + 版本历史）的契约。
 *
 * 这三条是 plan 的**产品裁决落点**（F2/N1/N12）：本行没有引擎记忆时"零请求 + 说明"、
 * 折叠态不发请求（钻取层级）、阶梯四态不合并 + 常驻 legend。
 */
describe('MemoryDetailPage 引擎投影（右栏新增两段）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('本行没有引擎记忆（engineMemoryIds 为空）→ 两块显示说明且**零 views 请求**', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: [] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: [] })],
      }),
    );
    renderPage();

    await screen.findByTestId('memory-detail-content');
    // 两块都出现，且说的是同一句"这条还没有引擎记忆"（不是报错、不给重试）
    expect(await screen.findByTestId('memory-resolution-no-engine')).toHaveTextContent(
      messages['memory.detail.noEngineMemory'],
    );
    expect(screen.getByTestId('memory-representation-no-engine')).toHaveTextContent(
      messages['memory.detail.noEngineMemory'],
    );
    await waitFor(() => expect(viewsCalls()).toHaveLength(0));
  });

  it('views 404（映射缺失 / 来源不可见）→ 块内说明，**不给通用重试**', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewError: { status: 404, code: 14003 },
      }),
    );
    renderPage();

    const ladderError = await screen.findByTestId('memory-resolution-error');
    expect(ladderError).toHaveTextContent(messages['memory.detail.engineViewUnavailable']);
    // 404 是常态路径：重试按钮是死胡同，故这里**不该**有它
    expect(within(ladderError).queryByRole('button')).toBeNull();
  });

  it('五槽全 R0（dev 形态）：恒带 R 标签 + 常驻 legend + active 标记', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
      }),
    );
    renderPage();

    await screen.findByTestId('memory-resolution-legend');
    for (const resolution of ['R0', 'R1', 'R2', 'R3', 'R4']) {
      expect(screen.getByTestId(`memory-resolution-slot-${resolution}`)).toBeTruthy();
    }
    // 全 R0 必须被 legend 解释成正常态（否则走查第一眼会读成功能坏了）
    expect(screen.getByTestId('memory-resolution-legend')).toHaveTextContent(
      messages['memory.resolution.legend'],
    );
    expect(screen.getByTestId('memory-resolution-active')).toHaveTextContent(
      messages['memory.resolution.active'],
    );
    // beyond（尚未晋升）不可点：渲染成 span 而不是 button
    expect(screen.getByTestId('memory-resolution-slot-R4').tagName).toBe('SPAN');
    // current（有正文）可点
    expect(screen.getByTestId('memory-resolution-slot-R0').tagName).toBe('BUTTON');
  });

  it('点当前槽开正文 Dialog 且**零新增请求**（正文已在 detail 响应里）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
      }),
    );
    renderPage();

    await screen.findByTestId('memory-resolution-slot-R0');
    const before = mockRequest.mock.calls.length;
    fireEvent.click(screen.getByTestId('memory-resolution-slot-R0'));
    expect(await screen.findByTestId('memory-representation-body')).toHaveTextContent(
      'current R0 body',
    );
    expect(mockRequest.mock.calls.length).toBe(before);
  });

  it('版本历史默认折叠 ⇒ 零请求；展开后才打一次 history', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
        historyItems: [],
      }),
    );
    renderPage();

    await screen.findByTestId('memory-representation-history');
    // 折叠态：只有标题行 + 展开按钮，零 history 请求
    expect(viewsCalls().filter((item) => item.url?.includes('/history/'))).toHaveLength(0);

    fireEvent.click(screen.getByTestId('memory-representation-history-toggle'));
    await waitFor(() =>
      expect(viewsCalls().filter((item) => item.url?.includes('/history/'))).toHaveLength(1),
    );
    // 默认 resolution = ladder 的 active 槽（R0），不是硬编码
    expect(viewsCalls().find((item) => item.url?.includes('/history/'))?.url).toContain(
      '/history/R0',
    );
  });

  it('history 空态文案把"没有旧版本"与"更正链"划清界限（P2：空是合法常态）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
        historyItems: [],
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByTestId('memory-representation-history-toggle'));
    const empty = await screen.findByTestId('memory-representation-history-empty');
    expect(empty).toHaveTextContent(messages['memory.representations.emptyTitle']);
    expect(empty).toHaveTextContent(messages['memory.representations.emptyDesc']);
  });
});
/**
 * M4：历史条目的正文二态（按 `representation_id` 取）——与"当前槽直给"那条路径不同，
 * 它会真的打一次 representation 端点，且自带 404 与截断两条降级。
 */
describe('MemoryDetailPage 历史条目正文（M4）', () => {
  const historyItem = (id: string): MemoryViewHistoryItem => ({
    representation_id: id,
    resolution: 'R0',
    revision_id: 'rev-old',
    mutation_id: 'mut-old',
    current: false,
    preview: 'old preview text',
    digest: 'dg',
    original_bytes: 16,
    preview_truncated: false,
    created_at: '2026-10-01T00:00:00.000Z',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('展开 → 点条目：命中 `/representations/<rid>` 且渲染正文（不渲染恒假的 current 标记）', async () => {
    const rid = 'rep-old-1';
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
        historyItems: [historyItem(rid)],
        representationBodies: { [rid]: 'the historical body text' },
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByTestId('memory-representation-history-toggle'));
    const entry = await screen.findByTestId('memory-representation-history-item');
    // 引擎只查 is_current=0 ⇒ items[].current 恒 false，UI 不渲染这个标记
    expect(entry.textContent).not.toContain('current');

    fireEvent.click(entry);
    expect(await screen.findByTestId('memory-representation-body')).toHaveTextContent(
      'the historical body text',
    );
    expect(viewsCalls().some((item) => item.url?.includes(`/representations/${rid}`))).toBe(true);
  });

  it('正文 404/14003：块内说「引擎投影当前不可读」，**不给重试按钮**', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
        historyItems: [historyItem('rep-old-2')],
        representationError: { status: 404, code: 14003 },
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByTestId('memory-representation-history-toggle'));
    fireEvent.click(await screen.findByTestId('memory-representation-history-item'));

    const unavailable = await screen.findByTestId('memory-representation-404');
    expect(unavailable).toHaveTextContent(messages['memory.representations.dialog.unavailable']);
    // 404 是常态路径：重试是死胡同
    expect(within(unavailable).queryByRole('button')).toBeNull();
  });

  it('body_truncated：正文照常渲染 + 显式标注截断（不吞）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: { n1: row({ id: 'n1', engineMemoryIds: ['m1'] }) },
        chainRows: [row({ id: 'n1', engineMemoryIds: ['m1'] })],
        viewLadder: defaultLadder(),
        historyItems: [historyItem('rep-old-3')],
        representationBodies: { 'rep-old-3': 'truncated body' },
        representationTruncated: true,
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByTestId('memory-representation-history-toggle'));
    fireEvent.click(await screen.findByTestId('memory-representation-history-item'));

    expect(await screen.findByTestId('memory-representation-body')).toHaveTextContent(
      'truncated body',
    );
    expect(screen.getByTestId('memory-representation-truncated')).toBeTruthy();
  });
});
/**
 * m6：两块「没有引擎投影」的说明必须分**成因**——"还没形成"要去等，"仅元数据可见"要去申请权限，
 * 共用一句话会把后者误导成前者。
 */
describe('MemoryDetailPage 无引擎记忆的成因分叉（m6）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('仅元数据可见的行：两块说的是「投影被隐去」，不是「还没形成」', async () => {
    const metadataRow = row({ id: 'n1', projection: 'metadata' });
    mockRequest.mockImplementation(
      makeRouter({ details: { n1: metadataRow }, chainRows: [metadataRow] }),
    );
    renderPage();

    await screen.findByTestId('memory-detail-metadata-only');
    expect(await screen.findByTestId('memory-resolution-no-engine')).toHaveTextContent(
      messages['memory.detail.noEngineMemoryMetadata'],
    );
    expect(screen.getByTestId('memory-representation-no-engine')).toHaveTextContent(
      messages['memory.detail.noEngineMemoryMetadata'],
    );
    // 反向钉子：不能落到"还没形成"那句上
    expect(screen.getByTestId('memory-resolution-no-engine')).not.toHaveTextContent(
      messages['memory.detail.noEngineMemory'],
    );
  });
});
/**
 * 终审 nit：右栏下钻态（阶梯 resolution / 历史展开 / 正文 Dialog）描述的是"**这一行**的下钻位置"，
 * 沿更正链 A → B 跳转时必须归零——路由不变、组件不重挂，否则 B 会带着 A 的展开态。
 */
describe('MemoryDetailPage 右栏下钻态随行切换归零（终审 nit）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRowId = 'n1';
    mockSearchParamsString = '';
  });

  it('切到链上另一版：历史块回到折叠态（不带着上一行选过的 resolution）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        details: {
          n1: row({ id: 'n1', engineMemoryIds: ['m1'] }),
          n2: row({ id: 'n2', correctionOf: 'n1', engineMemoryIds: ['m2'] }),
        },
        chainRows: [
          row({ id: 'n1', engineMemoryIds: ['m1'] }),
          row({ id: 'n2', correctionOf: 'n1', engineMemoryIds: ['m2'] }),
        ],
        viewLadder: defaultLadder(),
        historyItems: [],
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    const makeUi = () => (
      <QueryClientProvider client={queryClient}>
        <MemoryDetailPage />
      </QueryClientProvider>
    );
    const utils = render(makeUi());

    // 在 n1 上展开历史块（下钻态被置为"展开"）
    fireEvent.click(await screen.findByTestId('memory-representation-history-toggle'));
    expect(await screen.findByTestId('memory-representation-resolution')).toBeTruthy();

    // 切到链上第二版：走路由参数（`?v=` 的值必须是 UUID 形态，本文件的夹具 id 不是）
    mockRowId = 'n2';
    utils.rerender(makeUi());

    // n2 的阶梯先加载出来（证明不是"还在 loading 骨架"造成的假阴性）
    await screen.findByTestId('memory-resolution-legend');
    expect(screen.queryByTestId('memory-representation-resolution')).toBeNull();
  });
});
