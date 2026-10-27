/**
 * memory/graph/page.test.tsx — 关系图页契约测试
 *
 * 隔离策略与 memory/page.test.tsx 一致：**只 mock axios，不 mock `@/lib/api`**——
 * 请求形态（method/url/params/cursor）本身是契约，mock 掉 Api 层会把被测物一起 mock 掉。
 *
 * 覆盖清单（plan §4.3 点名项）：
 * ① **Tab 序 = 布局输出序**（DOM 顺序即布局纯函数的输出序，画布不得再排序）
 * ② **Enter 开抽屉**、Esc 关抽屉（键盘底线，U2/N1）
 * ③ **skip link 指向图之后的落点**（N7：筛选器在画布上方，跳筛选器对跳过 200 个
 *    tab stop 的人没用）
 * ④ **点节点零 axios 请求**（N6：抽屉内容全部本地派生）
 * ⑤ **`ledgerMapping` 跨页合并**（N3：翻页后早期页的节点也要能钻取）
 * ⑥ **有记忆无边 → 画布照画孤立网格 + 说明条，不是 EmptyState**（F1/M3：dev 种子
 *    7 记忆 0 边正是此态，是走查首屏）
 * ⑦ 缺 `?project=` 时取列表首项并**回写 URL**（B1）
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MemoryGraphPage from './page';
import { axiosInstance } from '@/lib/api';
import enMessages from '@/i18n/messages/en.json';
import type {
  MemoryGraphViewResponse,
  MemoryProjectDto,
  MemoryViewEdge,
  MemoryViewGraphNode,
} from '@/lib/memory';

/**
 * 当前地址栏。
 *
 * push/replace 只改这个串并记录调用，**不自己触发重渲染**：本页的"缺省 project 回写 URL"
 * 发生在 effect 里，若路由器在 effect 中同步 rerender，会在同一个 `act()` 冲刷里再入 React
 * （实测报 "Should not already be working"）。需要"地址栏变了"的用例由测试显式调
 * `rerenderPage()`（那是事件处理器之后的一次普通重渲，安全）。
 */
let mockSearchParamsString = '';
let rerenderPage: (() => void) | null = null;

function applyHref(href: string) {
  const queryIndex = href.indexOf('?');
  mockSearchParamsString = queryIndex >= 0 ? href.slice(queryIndex + 1) : '';
}

const mockPush = jest.fn((href: string) => applyHref(href));
const mockReplace = jest.fn((href: string) => applyHref(href));

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  usePathname: () => '/memory/graph',
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

/** 真实语言包摊平（验收项大量是"文案内容"，手抄快照证不了上线产物说了什么） */
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

/**
 * 极简 ICU 格式化（只实现本项目用到的两个形态）。
 *
 * 为什么必须实现 plural：图页/阶梯的计数文案在 en 侧是 ICU plural
 * （`{count, plural, one {# node} other {# nodes}}`，与 `memory.card.sourceCount` 同款）。
 * 桩里不实现的话，断言读到的是原始 ICU 串——测的就不是"用户看到的文案"了。
 */
function formatMessage(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  let out = text.replace(
    /\{(\w+),\s*plural,\s*one \{([^{}]*)\} other \{([^{}]*)\}\}/g,
    (_match, key: string, one: string, other: string) => {
      const value = Number(params[key]);
      return (value === 1 ? one : other).replace(/#/g, String(value));
    },
  );
  for (const [key, value] of Object.entries(params))
    out = out.split(`{${key}}`).join(String(value));
  return out;
}

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return formatMessage(messages[fullKey] ?? fullKey, params);
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

/*
  jsdom 的 `getBoundingClientRect()` 恒返回全 0（同 jest.setup.js 里 scrollIntoView 的处理）：
  画布在"容器尺寸还没量出来"时会**正确地**不挂 SVG（那一帧的 viewBox 只能是 0×0，
  兜底一个小尺寸会把内容放大近千倍），于是节点一个都渲染不出来——14 个用例集体假红。
  这里给元素一个确定尺寸，补上 jsdom 缺的那一环；`ResizeObserver` 在 jsdom 里也不存在，
  hook 会退回 window resize + 挂载时测一次，所以这个桩能被量到。
*/
beforeAll(() => {
  Element.prototype.getBoundingClientRect = jest.fn(() => ({
    width: 1200,
    height: 560,
    top: 0,
    left: 0,
    right: 1200,
    bottom: 560,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

/*
  jsdom **没有 PointerEvent**（实测 `typeof window.PointerEvent === 'undefined'`）：
  `fireEvent.pointerDown(el, { pointerId, clientX })` 会退化成不带这些字段的普通 Event，
  于是视口 hook 读到 `pointerId === undefined`、点击判定读到 `clientX === undefined`
  ⇒ 拖拽手势在测试里根本构造不出来（B5 的两个用例会是假绿/假红）。
  这里做一个**最小**补丁：只补齐 hook 真正读的字段（pointerId / clientX / clientY / button）。
*/
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

function envelope<T>(data: T) {
  return { data: { code: 0, message: 'ok', data, timestamp: '', requestId: 'r1' } };
}

/** HTTP 错误（拦截器形态：response.data.code 是业务码，data.data 是附加槽） */
function httpError(status: number, code: number, data?: Record<string, unknown>) {
  return { response: { status, data: { code, message: `err ${code}`, data: data ?? {} } } };
}

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

function project(overrides: Partial<MemoryProjectDto> = {}): MemoryProjectDto {
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

/** 节点夹具 */
function node(id: string, overrides: Partial<MemoryViewGraphNode> = {}): MemoryViewGraphNode {
  return {
    memory_id: id,
    kind: 'observation',
    scope: 'actor_private',
    status: 'active',
    active_resolution: 'R0',
    available_resolution: 'R0',
    label: `Label ${id}`,
    preview: `preview ${id}`,
    label_resolution: 'R0',
    confidence_present: false,
    contradiction_count: 0,
    supersession_count: 0,
    anchor_state: 'fresh',
    boundary: false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function pageBlock(total: number, loaded: number, nextCursor = '') {
  return {
    total,
    total_kind: 'exact' as const,
    loaded,
    next_cursor: nextCursor,
    partial: false,
    truncated: false,
    truncation_reason: '',
  };
}

/** graph 响应夹具（默认：N 个孤立节点、0 条边 —— 正是 dev 种子的形态） */
function graphResponse(options: {
  nodes: MemoryViewGraphNode[];
  edges?: MemoryGraphViewResponse['engine']['edges'];
  nextCursor?: string;
  ledgerMapping?: Record<string, string>;
  omittedEdgeCount?: number;
}): MemoryGraphViewResponse {
  const { nodes, edges = [], nextCursor = '', ledgerMapping, omittedEdgeCount = 0 } = options;
  return {
    engine: {
      schema_version: 'v1',
      request_id: 'r1',
      auth_kind: 'binding_credential_ref',
      authority: 'inspect_read',
      target: {
        target_id: 't',
        workspace_id: 'w',
        actor_id: 'a',
        binding_id: 'b',
        scope: 'actor_private',
      },
      snapshot_digest: 'digest-1',
      mode: 'browse',
      center_memory_id: '',
      filters: {
        kind: 'any',
        status: 'any',
        active_resolution: 'any',
        available_resolution: 'any',
        anchor_state: 'any',
        created_from: null,
        created_to: null,
        relation_type: 'any',
      },
      budget: {
        node_limit: 200,
        edge_limit: 600,
        neighborhood_limit: 100,
        preview_scalars: 160,
        depth: 1,
      },
      node_page: pageBlock(nodes.length, nodes.length, nextCursor),
      edge_page: pageBlock(edges.length, edges.length),
      omitted_edge_count: omittedEdgeCount,
      nodes,
      edges,
      redaction: 'memory-projection-safe-v1',
    },
    filteredByPermission: false,
    filteredNodeCount: 0,
    filteredEdgeCount: 0,
    unmappedCount: 0,
    engineDataSuspect: false,
    ledgerMapping:
      ledgerMapping ??
      Object.fromEntries(nodes.map((item) => [item.memory_id, `n-${item.memory_id}`])),
    trustLevel: 'untrusted_advisory',
    decisionAuthority: 'none',
    usageNote: 'raw usage note',
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const makeUi = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryGraphPage />
    </QueryClientProvider>
  );
  const utils = render(makeUi());
  rerenderPage = () => utils.rerender(makeUi());
  return utils;
}

/**
 * 挂载服务端 mock：项目列表 + graph 分页。
 *
 * `pages` 按 cursor 出页（`''` = 首页）；`cursorError` 让**带 cursor** 的请求失败
 * （B3 重置用例）。`nodesByProject` 让不同项目返回不同节点（B2 切项目用例）。
 */
function mockServer(options: {
  nodesFirst: MemoryViewGraphNode[];
  nodesSecond?: MemoryViewGraphNode[];
  /** 首页的边（缺省 = 0 边——dev 种子形态） */
  edgesFirst?: MemoryViewEdge[];
  nextCursorFirst?: string;
  /** 项目列表（缺省 = 单项目；B2 需要两项） */
  projects?: MemoryProjectDto[];
  /** 指定项目的首页节点（B2） */
  nodesByProject?: Record<string, MemoryViewGraphNode[]>;
  /** 按 cursor 精确出页（覆盖 nodesFirst/nodesSecond 的简化路径） */
  pages?: Record<string, MemoryGraphViewResponse>;
  /** 带 cursor 的分页请求失败（B3） */
  cursorError?: { status: number; code: number; data?: Record<string, unknown> };
}) {
  const second = options.nodesSecond
    ? graphResponse({
        nodes: options.nodesSecond,
        // 第二页的 ledgerMapping 只含第二页节点；合并后早期页节点仍要可钻取
        ledgerMapping: Object.fromEntries(
          options.nodesSecond.map((item) => [item.memory_id, `n-${item.memory_id}`]),
        ),
      })
    : null;
  mockRequest.mockImplementation(
    (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
      const method = (config.method ?? 'GET').toUpperCase();
      const url = config.url ?? '';
      if (method === 'GET' && url === '/memory/projects') {
        const items = options.projects ?? [project()];
        return Promise.resolve(
          envelope({
            items,
            total: items.length,
            page: 1,
            pageSize: 100,
            provisioningAvailable: true,
          }),
        );
      }
      if (method === 'GET' && /\/views\/graph$/.test(url)) {
        const cursor = (config.params?.cursor as string | undefined) ?? '';
        // 先查 pages：这样"第二页成功、第三页失败"才构造得出来（cursorError 是兜底）
        if (options.pages && options.pages[cursor]) {
          return Promise.resolve(envelope(options.pages[cursor]));
        }
        if (cursor && options.cursorError) {
          const { status, code, data } = options.cursorError;
          return Promise.reject(httpError(status, code, data));
        }
        if (cursor && second) return Promise.resolve(envelope(second));
        if (cursor) {
          return Promise.resolve(envelope(graphResponse({ nodes: [], ledgerMapping: {} })));
        }
        // `/memory/projects/<id>/views/graph` → 第 4 段是 projectId
        const projectId = url.split('/')[3];
        const nodes = options.nodesByProject?.[projectId] ?? options.nodesFirst;
        return Promise.resolve(
          envelope(
            graphResponse({
              nodes,
              edges: options.edgesFirst ?? [],
              nextCursor: options.nextCursorFirst ?? '',
            }),
          ),
        );
      }
      return Promise.resolve(envelope({}));
    },
  );
}

/** graph 请求（B1 断言参数名、B3 断言重拉首页） */
function graphCalls() {
  return mockRequest.mock.calls
    .map(
      (call) =>
        call[0] as {
          method?: string;
          url?: string;
          params?: Record<string, unknown>;
        },
    )
    .filter((config) => /\/views\/graph$/.test(config.url ?? ''));
}

/** 带 cursor 的 graph 请求（B3：重置后应当只剩不带 cursor 的首页请求） */
function cursorGraphCalls() {
  return graphCalls().filter((config) => !!config.params?.cursor);
}

/** DOM 顺序读节点 id（= Tab 序） */
function domNodeIds(): string[] {
  return screen
    .getAllByTestId('memory-graph-node')
    .map((element) => element.getAttribute('data-memory-id') ?? '');
}

beforeEach(() => {
  mockRequest.mockReset();
  mockPush.mockClear();
  mockReplace.mockClear();
  mockSearchParamsString = `project=${PROJECT_A}`;
  rerenderPage = null;
});

describe('MemoryGraphPage', () => {
  it('有记忆无边：画布照画孤立节点 + 说明条（**不是** EmptyState）', async () => {
    mockServer({ nodesFirst: [node('m1'), node('m2'), node('m3')] });
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(3));
    // 关键断言：这是走查首屏的形态——7 记忆 0 边必须画出来，不能被空态吃掉
    expect(screen.queryByTestId('memory-graph-empty')).toBeNull();
    expect(screen.getByTestId('memory-graph-no-edges-note')).toBeTruthy();
    // 孤立节点进孤立区（有包围盒）
    expect(screen.getByTestId('memory-graph-legend')).toBeTruthy();
  });

  it('Tab 序 = 布局输出序（DOM 顺序即纯函数输出序，画布不二次排序）', async () => {
    // 三个孤立节点，created_at 乱序给出：布局按 createdAt 升序排，DOM 必须照那个序
    mockServer({
      nodesFirst: [
        node('m-c', { created_at: '2026-10-03T00:00:00.000Z' }),
        node('m-a', { created_at: '2026-10-01T00:00:00.000Z' }),
        node('m-b', { created_at: '2026-10-02T00:00:00.000Z' }),
      ],
    });
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(3));
    expect(domNodeIds()).toEqual(['m-a', 'm-b', 'm-c']);
  });

  it('Enter 开抽屉、Esc 关抽屉（键盘底线）', async () => {
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();

    const first = (await screen.findAllByTestId('memory-graph-node'))[0];
    expect(screen.queryByTestId('memory-graph-drawer')).toBeNull();
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('memory-graph-drawer')).toBeTruthy());
    expect(screen.getByTestId('memory-graph-drawer-label').textContent).toBe('Label m1');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('memory-graph-drawer')).toBeNull());
  });

  it('点节点零 axios 请求（抽屉内容全部本地派生）', async () => {
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();

    const first = (await screen.findAllByTestId('memory-graph-node'))[0];
    const before = mockRequest.mock.calls.length;
    fireEvent.click(first);
    await waitFor(() => expect(screen.getByTestId('memory-graph-drawer')).toBeTruthy());
    // 开抽屉期间一次请求都不许发（relations / meta 全来自已加载的 graph 响应）
    expect(mockRequest.mock.calls.length).toBe(before);
  });

  it('`ledgerMapping` 跨页合并：翻页后早期页的节点仍能钻到详情', async () => {
    mockServer({
      nodesFirst: [node('m1')],
      nextCursorFirst: 'cursor-1',
      nodesSecond: [node('m2')],
    });
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));
    // 翻页：第二页只带 m2 的 ledgerMapping
    fireEvent.click(screen.getByTestId('memory-graph-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(2));

    // 点**第一页**的节点：映射必须还在（少了同步累积，这里会渲染成"无法打开详情"）
    fireEvent.click(screen.getAllByTestId('memory-graph-node')[0]);
    await waitFor(() => expect(screen.getByTestId('memory-graph-drawer')).toBeTruthy());
    const link = screen.getByTestId('memory-graph-drawer-open-detail');
    expect(link.getAttribute('href')).toBe(`/memory/n-m1?project=${PROJECT_A}`);
  });

  it('skip link 指向图之后的落点，且该落点真实存在', async () => {
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();

    const skip = await screen.findByTestId('memory-graph-skip');
    expect(skip.getAttribute('href')).toBe('#memory-graph-after');
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));
    expect(document.getElementById('memory-graph-after')).not.toBeNull();
  });

  it('缺 ?project= 时取列表首项并回写 URL', async () => {
    mockSearchParamsString = '';
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();

    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(String(mockReplace.mock.calls[0][0])).toBe(`/memory/graph?project=${PROJECT_A}`);
  });

  it('治理条单条合并：摘要 + 说明位 + 信任框尾部都在同一条里', async () => {
    mockServer({ nodesFirst: [node('m1'), node('m2')] });
    renderPage();

    const bar = await screen.findByTestId('memory-graph-governance');
    expect(within(bar).getByTestId('memory-graph-governance-summary').textContent).toContain(
      'Showing 2 nodes',
    );
    expect(within(bar).getByTestId('memory-graph-trust-note')).toBeTruthy();
    // 明细默认收起
    expect(within(bar).queryByTestId('memory-graph-governance-details')).toBeNull();
    fireEvent.click(within(bar).getByTestId('memory-graph-governance-toggle'));
    expect(within(bar).getByTestId('memory-graph-governance-details')).toBeTruthy();
  });

  it('空项目（0 节点）→ EmptyState + 回账本出口', async () => {
    mockServer({ nodesFirst: [] });
    renderPage();

    const empty = await screen.findByTestId('memory-graph-empty');
    expect(empty).toBeTruthy();
    expect(screen.queryByTestId('memory-graph-canvas')).toBeNull();
  });
});
// ══════════════════════════════════════════════════════════════════════════
// 终审回归（agent-39）：B1 参数名 / B2 切项目 / B3 重置 / B5 拖拽 / m2 累积口径
// ══════════════════════════════════════════════════════════════════════════

describe('MemoryGraphPage 终审回归', () => {
  it('B1 选关系过滤器：请求参数名是 camelCase `relationType`（不是引擎的 `relation_type`）', async () => {
    /*
      这条断言的价值在于"mock 只看 URL"是盲的：参数名错配时页面照常渲染，
      只有真机才 400。故这里必须把 `params` 也钉住。
    */
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));

    const before = graphCalls().length;
    fireEvent.change(screen.getByTestId('memory-graph-filter-relation'), {
      target: { value: 'supersedes' },
    });
    rerenderPage?.();
    await waitFor(() => expect(graphCalls().length).toBeGreaterThan(before));

    const last = graphCalls()[graphCalls().length - 1];
    expect(last.params).toMatchObject({ relationType: 'supersedes' });
    expect(Object.keys(last.params ?? {})).not.toContain('relation_type');
  });

  it('B2 切项目：旧项目节点消失、抽屉一并关闭（key=projectId 整体重挂）', async () => {
    mockServer({
      projects: [
        project({ id: PROJECT_A, slug: 'a', name: 'Project A' }),
        project({ id: PROJECT_B, slug: 'b', name: 'Project B' }),
      ],
      nodesFirst: [node('m-a')],
      nodesByProject: { [PROJECT_B]: [node('m-b')] },
    });
    renderPage();
    await waitFor(() => expect(domNodeIds()).toEqual(['m-a']));

    // 抽屉开着切项目：这是 B2 里最危险的一路——残留的 ledgerMapping 会拼出跨项目链接
    fireEvent.click(screen.getAllByTestId('memory-graph-node')[0]);
    await waitFor(() => expect(screen.getByTestId('memory-graph-drawer')).toBeTruthy());

    fireEvent.change(screen.getByTestId('memory-graph-project-select'), {
      target: { value: PROJECT_B },
    });
    rerenderPage?.();

    await waitFor(() => expect(domNodeIds()).toEqual(['m-b']));
    expect(screen.queryByTestId('memory-graph-drawer')).toBeNull();
  });

  it('B3 cursor 分页收 502/14004(snapshot_stale)：窗口期内**不早退**，重拉落地后才收敛', async () => {
    /*
      这条用例的关键在**窗口期**：重置在途时 react-query 仍保留 `status='error'`
      （失败的 cursor 请求留下的），若错误分支没有 `!resetPending`，整页会被换成错误卡片
      ——状态条渲染不出、画布卸载、transform 与 fitRef 一并销毁。
      故恢复页用**手动 resolve 的 deferred**，在 resolve 之前就把窗口期钉住。
    */
    const pageM1 = graphResponse({ nodes: [node('m1')], nextCursor: 'cursor-1' });
    const pageM2 = graphResponse({ nodes: [node('m2')], nextCursor: 'cursor-2' });
    let releaseRecovery: () => void = () => {};
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let firstPageCalls = 0;
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        const url = config.url ?? '';
        if (method === 'GET' && url === '/memory/projects') {
          return Promise.resolve(
            envelope({
              items: [project()],
              total: 1,
              page: 1,
              pageSize: 100,
              provisioningAvailable: true,
            }),
          );
        }
        if (/\/views\/graph$/.test(url)) {
          const cursor = (config.params?.cursor as string | undefined) ?? '';
          if (cursor === 'cursor-1') return Promise.resolve(envelope(pageM2));
          if (cursor === 'cursor-2') {
            return Promise.reject(httpError(502, 14004, { engineCode: 'snapshot_stale' }));
          }
          firstPageCalls += 1;
          // 首次首页即时返回；**恢复页挂起**（窗口期由此可测）
          if (firstPageCalls === 1) return Promise.resolve(envelope(pageM1));
          return recoveryGate.then(() => envelope(pageM1));
        }
        return Promise.resolve(envelope({}));
      },
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('memory-graph-load-more'));
    await waitFor(() => expect(domNodeIds()).toEqual(['m1', 'm2']));

    // 第三次翻页失败 → 进入重置
    fireEvent.click(screen.getByTestId('memory-graph-load-more'));
    const notice = await screen.findByTestId('memory-graph-reset-notice');
    expect(notice.getAttribute('data-kind')).toBe('stale');
    expect(notice).toHaveTextContent(messages['memory.graph.status.resetStale']);

    // ── 窗口期（恢复页尚未返回）──────────────────────────────────────────────
    expect(screen.getByTestId('memory-graph-reset-notice')).toBeTruthy();
    expect(screen.queryByTestId('memory-graph-error')).toBeNull();
    expect(screen.queryByTestId('memory-graph-loading')).toBeNull();
    // 画布子树**未卸载** ⇒ transform / fitRef 保住（plan「保留画布 transform」）
    expect(screen.getByTestId('memory-graph-canvas')).toBeTruthy();
    expect(screen.getByTestId('memory-graph-viewport')).toBeTruthy();
    expect(screen.queryByTestId('memory-graph-empty')).toBeNull();

    // ── 收敛：恢复页落地 ─────────────────────────────────────────────────────
    releaseRecovery();
    await waitFor(() => expect(domNodeIds()).toEqual(['m1']));
    expect(cursorGraphCalls().length).toBeGreaterThanOrEqual(2);
    expect(graphCalls()[graphCalls().length - 1].params?.cursor).toBeUndefined();
    // 状态条常驻到下一次成功请求（恢复页本身不算"下一次"）
    expect(screen.getByTestId('memory-graph-reset-notice')).toBeTruthy();
    expect(screen.getByTestId('memory-graph-canvas')).toBeTruthy();
  });

  it('B3 非 stale 的 502：文案分叉到「引擎返回错误（code）」而不是说「数据已变化」', async () => {
    mockServer({
      nodesFirst: [node('m1')],
      pages: { '': graphResponse({ nodes: [node('m1')], nextCursor: 'cursor-1' }) },
      cursorError: { status: 502, code: 14004, data: { engineCode: 'engine_error' } },
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('memory-graph-load-more'));
    const notice = await screen.findByTestId('memory-graph-reset-notice');
    expect(notice.getAttribute('data-kind')).toBe('other');
    expect(notice).toHaveTextContent('engine_error');
  });

  it('B3 首屏就失败时不触发重置（否则失败与重置互相触发成死循环）', async () => {
    mockServer({
      nodesFirst: [],
      cursorError: { status: 502, code: 14004, data: { engineCode: 'snapshot_stale' } },
    });
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        const url = config.url ?? '';
        if (method === 'GET' && url === '/memory/projects') {
          return Promise.resolve(
            envelope({
              items: [project()],
              total: 1,
              page: 1,
              pageSize: 100,
              provisioningAvailable: true,
            }),
          );
        }
        if (/\/views\/graph$/.test(url)) {
          return Promise.reject(httpError(502, 14004, { engineCode: 'snapshot_stale' }));
        }
        return Promise.resolve(envelope({}));
      },
    );
    renderPage();

    await screen.findByTestId('memory-graph-error');
    // 首屏失败 ⇒ 走错误态，**不是**重置状态条
    expect(screen.queryByTestId('memory-graph-reset-notice')).toBeNull();
    // 且不会自激：请求数停在"首屏 + 它自己的那次 retry"上，等一会儿也不涨
    await waitFor(() => expect(graphCalls().length).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(graphCalls()).toHaveLength(2);
  });

  it('B5 在节点上按下并拖拽后松手：**不开抽屉**（4px 判定落在节点自身）', async () => {
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();
    const target = (await screen.findAllByTestId('memory-graph-node'))[0];

    fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 160, clientY: 100 });
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 160, clientY: 100 });
    fireEvent.click(target);
    expect(screen.queryByTestId('memory-graph-drawer')).toBeNull();

    // 对照组：原地按下即松手（位移 0）→ 必须能开抽屉（守卫别把正常点击也拦掉）
    fireEvent.pointerDown(target, { pointerId: 2, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.click(target);
    await waitFor(() => expect(screen.getByTestId('memory-graph-drawer')).toBeTruthy());
  });

  it('B5 拖出画布再松手：panning 归零（下次按下不当成第二指）', async () => {
    mockServer({ nodesFirst: [node('m1')] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));

    const viewport = screen.getByTestId('memory-graph-viewport');
    fireEvent.pointerDown(viewport, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    expect(viewport.className).toContain('cursor-grabbing');
    // 指针移到画布外（jsdom 里"外"体现为事件只到 window）
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 900 });
    await waitFor(() => expect(viewport.className).toContain('cursor-grab'));
  });

  it('m2 治理条的省略边数走累积态：翻页后不回落（不读"最后一页"）', async () => {
    mockServer({
      nodesFirst: [node('m1')],
      pages: {
        '': graphResponse({ nodes: [node('m1')], nextCursor: 'cursor-1', omittedEdgeCount: 9 }),
        'cursor-1': graphResponse({ nodes: [node('m2')], omittedEdgeCount: 2 }),
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));
    expect(screen.getByTestId('memory-graph-governance-summary').textContent).toContain('9');

    fireEvent.click(screen.getByTestId('memory-graph-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(2));
    // 若读"最后一页"这里会变成 2
    expect(screen.getByTestId('memory-graph-governance-summary').textContent).toContain('9');
  });
  it('m3 翻页成功后「加载更多」不被卡在 Loading（在途光标标记必须在成功响应后复位）', async () => {
    mockServer({
      nodesFirst: [node('m1')],
      pages: {
        '': graphResponse({ nodes: [node('m1')], nextCursor: 'cursor-1' }),
        // 第二页**仍带** next_cursor：按钮留在页面上，才谈得上"它有没有被卡住"
        'cursor-1': graphResponse({ nodes: [node('m2')], nextCursor: 'cursor-2' }),
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('memory-graph-load-more'));
    await waitFor(() => expect(domNodeIds()).toEqual(['m1', 'm2']));

    const button = screen.getByTestId('memory-graph-load-more');
    // 不复位的话这里会一直是「Loading…」且 disabled（此后任何 refetch 都卡住）
    expect(button).toHaveTextContent(messages['memory.graph.canvas.loadMore']);
    expect(button).not.toBeDisabled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 走查修复批回归（2026-10-11）：clip 红线 / supersedes 箭头 / dim 通道
// ══════════════════════════════════════════════════════════════════════════

/** 边夹具（audit_locator 是契约必填，给稳定占位值） */
function edgeFixture(from: string, to: string, type: string): MemoryViewEdge {
  return {
    relation_id: `${from}->${to}:${type}`,
    from_id: from,
    to_id: to,
    type,
    created_at: '2026-10-01T00:00:00.000Z',
    audit_locator: { status: 'ok', journal_event_id: 'j', revision_id: 'r', mutation_id: 'm' },
  };
}

describe('MemoryGraphPage 走查修复批回归', () => {
  it('label 文字挂共享 clipPath 且 id 可解析；节点 <g> 与焦点环 rect 不挂（红线）', async () => {
    mockServer({ nodesFirst: [node('m1'), node('m2')] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(2));

    for (const g of screen.getAllByTestId('memory-graph-node')) {
      const clipped = g.querySelectorAll('text[clip-path]');
      expect(clipped.length).toBeGreaterThan(0);
      // clipId 已洗冒号（useId `:r0:` → `r0`）；clip-path 引用解析走 getElementById 最稳
      const ref = clipped[0].getAttribute('clip-path') ?? '';
      const id = /^url\(#(.+)\)$/.exec(ref)?.[1] ?? '';
      expect(id).not.toBe('');
      expect(document.getElementById(id)).not.toBeNull();
      // 红线：clip 绝不挂节点 <g>（焦点环 rect 画在盒外 x=-4，挂 g 会把它整条裁掉）
      expect(g.getAttribute('clip-path')).toBeNull();
      expect(g.querySelector('rect[x="-4"]')?.getAttribute('clip-path') ?? null).toBeNull();
    }
  });

  it('supersedes 边出箭头 polygon 且尖端落在 to 端盒边界；其他类型不出箭头', async () => {
    // 方向语义：from=新版（取代者）→ to=旧版（被取代者）；布局把 to 推右列
    mockServer({
      nodesFirst: [
        node('new', { created_at: '2026-10-02T00:00:00.000Z' }),
        node('old', { created_at: '2026-10-01T00:00:00.000Z' }),
      ],
      edgesFirst: [edgeFixture('new', 'old', 'supersedes')],
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(2));

    const edge = screen.getByTestId('memory-graph-edge');
    expect(edge.getAttribute('data-relation-type')).toBe('supersedes');
    const arrow = edge.querySelector('polygon');
    expect(arrow).not.toBeNull();
    // 尖端（points 第一个坐标）落在 to 端（'old'，右列）盒子的左边界上：
    // old 盒 x = 24 + (140+32) = 196，y 中线 = 24+28 = 52（布局纯函数口径）
    const [tipX, tipY] = (arrow!.getAttribute('points') ?? '').trim().split(/\s+/).map(Number);
    expect(tipX).toBeCloseTo(196, 6);
    expect(tipY).toBeCloseTo(52, 6);
  });

  it('非 supersedes 边不出箭头；选中别的节点时线与箭头同暗（opacity 在包裹 <g> 上）', async () => {
    mockServer({
      nodesFirst: [
        node('new', { created_at: '2026-10-02T00:00:00.000Z' }),
        node('old', { created_at: '2026-10-01T00:00:00.000Z' }),
        node('lone', { created_at: '2026-10-03T00:00:00.000Z' }),
      ],
      edgesFirst: [edgeFixture('new', 'old', 'supersedes'), edgeFixture('new', 'old', 'supports')],
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(3));

    const edges = screen.getAllByTestId('memory-graph-edge');
    const supports = edges.find((el) => el.getAttribute('data-relation-type') === 'supports');
    expect(supports?.querySelector('polygon') ?? null).toBeNull();

    // 选中孤立节点 ⇒ 两条边都非邻接 ⇒ 包裹 <g> 降到 0.15（线与箭头同暗，通道不分叉）
    const lone = screen
      .getAllByTestId('memory-graph-node')
      .find((el) => el.getAttribute('data-memory-id') === 'lone');
    fireEvent.click(lone!);
    for (const el of screen.getAllByTestId('memory-graph-edge')) {
      expect(el.getAttribute('opacity')).toBe('0.15');
    }
  });

  it('LOD label 档（0.5 ≤ scale < 1）：节点只画单行且截断显式补 …（终审 P1-2 覆盖缺口）', async () => {
    // DOM 测试恒 scale=1（auto-fit 不放大）⇒ 旧缺口：单行档在任何测试里不可达。
    // 点一次缩小：1 × 0.8 = 0.8 ∈ [0.5, 1) ⇒ label 档
    mockServer({ nodesFirst: [node('m1', { label: 'a'.repeat(40) })] });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('memory-graph-node')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('memory-graph-zoom-out'));

    const g = screen.getByTestId('memory-graph-node');
    await waitFor(() => {
      const tspans = g.querySelectorAll('tspan');
      expect(tspans).toHaveLength(1);
      expect(tspans[0].textContent ?? '').toMatch(/…$/);
    });
  });

  it('LOD shape 档（scale < 0.5）：supersedes 边不画箭头、节点不画文字（终审 P1-2）', async () => {
    // 连点四次缩小：0.8⁴ ≈ 0.41 < 0.5 ⇒ shape 档（钳制下界 0.2，不会误穿）
    mockServer({
      nodesFirst: [
        node('new', { created_at: '2026-10-02T00:00:00.000Z' }),
        node('old', { created_at: '2026-10-01T00:00:00.000Z' }),
      ],
      edgesFirst: [edgeFixture('new', 'old', 'supersedes')],
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('memory-graph-edge')).not.toBeNull());
    // full 档基线：箭头在
    expect(screen.getByTestId('memory-graph-edge').querySelector('polygon')).not.toBeNull();

    const zoomOut = screen.getByTestId('memory-graph-zoom-out');
    for (let i = 0; i < 4; i++) fireEvent.click(zoomOut);

    await waitFor(() => {
      expect(screen.getByTestId('memory-graph-edge').querySelector('polygon')).toBeNull();
    });
    for (const g of screen.getAllByTestId('memory-graph-node')) {
      expect(g.querySelectorAll('text')).toHaveLength(0);
    }
  });
});
