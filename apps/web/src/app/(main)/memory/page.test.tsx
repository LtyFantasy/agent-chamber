/**
 * memory/page.test.tsx — 记忆列表页契约测试（plan §2 步骤 12 必含断言全覆盖）
 *
 * 隔离策略同 experiences/page.test.tsx：**只 mock axios，不 mock `@/lib/api`**——
 * 请求形态（method/url/params/body）本身就是契约（tab 过滤参数、recall 的副作用载荷），
 * mock 掉 Api 层会把被测物一起 mock 掉。
 *
 * 覆盖清单（对应 plan v2.1 §2 步骤 12）：
 * ① 降级**两成因**分叉文案（全 metadata = 无项目内容权限 / 混合 = 来源不可见）；
 * ② 项目列表空态（≠"项目无记忆"）；
 * ③ **Tab 归属互斥**：withdrawn + formationState=failed 只进「已失效」；
 * ④ Tab **部分失败**只在该 Tab 内报错（不吞、不污染其它 Tab）；
 * ⑤ 引擎不可用**分层**：项目级（engineAvailability）与 runtime 503 各自出横幅 + 禁用搜索，
 *    而卡片墙照常可用；
 * ⑥ `no_memory` / `rejected` 行在「提名记录」可见；
 * ⑦ 双模式搜索：字面 = 零请求就地过滤；语义 = 打一次引擎（身份/世代/预算三项载荷）；
 * ⑧ 字面过滤边界文案（"这一页没匹配" ≠ "没有记忆"）；
 * ⑨ **切项目丢弃在途召回响应**（竞态断言）；
 * ⑩ URL 分层：project/tab 走 push、q/mode/page 走 replace；
 * ⑪ URL 恢复的 `q` **只回填、不自动执行**（分享链接不烧配额）。
 */

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MemoryPage from './page';
import { axiosInstance } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import enMessages from '@/i18n/messages/en.json';
import type {
  MemoryEngineAvailability,
  MemoryNominationDto,
  MemoryNominationListResponse,
  MemoryProjectDto,
  MemoryRecallItem,
  MemoryRecallResponse,
} from '@/lib/memory';
import { useNotificationStore } from '@/stores/notification.store';

/**
 * 当前测试的 searchParams（jest.mock 工厂只允许引用 mock* 前缀的外部变量）。
 *
 * ⚠️ 本批（评审 M4/M5）起它是**可变**的：push/replace 会像真浏览器那样把 href 落到它上面
 * 并触发重渲染。理由——"URL 是状态的一部分"这件事只有在 URL 真会变时才算被测到：
 * 静态串会让"后退同步"（M5）与"防抖写入覆盖导航"（M4）两个用例根本无从证伪。
 */
let mockSearchParamsString = '';
/** 由 renderPage 注入：让"路由变化"能驱动一次重渲染（模拟地址栏变化/后退） */
let rerenderPage: (() => void) | null = null;

/**
 * 把 router.push/replace 拿到的 href 落到地址栏并重渲染。
 *
 * 只取 `?` 之后的部分（真 app 里 `/memory?x=y` 与 `?x=y` 对 `useSearchParams()` 等价）。
 */
function applyHref(href: string) {
  const queryIndex = href.indexOf('?');
  mockSearchParamsString = queryIndex >= 0 ? href.slice(queryIndex + 1) : '';
  rerenderPage?.();
}

const mockPush = jest.fn((href: string) => applyHref(href));
const mockReplace = jest.fn((href: string) => applyHref(href));

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  usePathname: () => '/memory',
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

/**
 * 把真实语言包摊平成 `namespace.key` 表。
 *
 * 为什么读**真实** en.json 而不是手抄快照：本批的验收项大量是"文案内容"（两成因降级文案、
 * 三态引擎横幅、all_filtered 与 no_matches 的区分），手抄一份只能证明接线对，
 * 证不了上线产物里说的是什么。
 */
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
 * 为什么必须实现 plural：`memory.card.sourceCount` 在 en 侧是 ICU plural
 * （`{count, plural, one {# source} other {# sources}}`，评审 m12），桩里不实现的话
 * 断言读到的是原始 ICU 串 —— 测的就不是"用户看到的文案"了。
 *
 * @param text - 语言包原文
 * @param params - 插值参数
 * @returns 渲染后的文案
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

/**
 * axios 层 mock：`api.ts` 在模块加载期调用 `axios.create(...)`，故工厂必须返回带
 * `interceptors.{request,response}.use` 与 `request` 的实例；`request` 是捕获点。
 */
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

/** 后端统一响应信封（apiRequest 剥 data 层） */
function envelope<T>(data: T) {
  return { data: { code: 0, message: 'ok', data, timestamp: '', requestId: 'r1' } };
}

/** HTTP 错误（拦截器形态：response.data.code 是业务码，data.data 是附加槽） */
function httpError(status: number, code: number, data?: Record<string, unknown>) {
  return { response: { status, data: { code, message: `err ${code}`, data: data ?? {} } } };
}

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_C = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const TOPIC_TARGET = '44444444-4444-4444-8444-444444444444';
const BOARD_TARGET = '55555555-5555-4555-8555-555555555555';

/** 引擎可用性块（缺省 = 可用） */
function availability(overrides: Partial<MemoryEngineAvailability> = {}): MemoryEngineAvailability {
  return { engine: 'hument', available: true, reason: null, ...overrides };
}

/** 项目投影 */
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
    engineAvailability: availability(),
    // W-4：类型必填（数据驱动 A3 的来源）——不加这一行编译期必红
    canReadContent: true,
    // Usage 读面是独立判据（全部绑定可读）；缺省夹具按可读
    canReadUsage: true,
    ...overrides,
  };
}

/** 召回项（缺省 = 有出处 + 一条来源；score 必填，A1 展示依赖它） */
function recallItem(overrides: Partial<MemoryRecallItem> = {}): MemoryRecallItem {
  return {
    memoryId: 'm1',
    ledgerId: 'n1',
    category: 'ruling',
    subject: 'Semantic hit',
    scope: 'scope',
    body: 'body text',
    kind: 'ruling',
    resolution: 'canonical',
    status: 'active',
    derivation: 'sourced',
    contentTruncated: false,
    reviewDue: false,
    score: 7,
    sources: [],
    ...overrides,
  };
}

/** 账本行投影（缺省 = full 档「生效中 + 已形成」） */
function nomination(overrides: Partial<MemoryNominationDto> = {}): MemoryNominationDto {
  return {
    projection: 'full',
    id: 'n1',
    category: 'ruling',
    formationState: 'committed',
    status: 'active',
    nominatorId: AGENT_ID,
    nominatorType: 'agent',
    nominatorName: 'Agent One',
    nominatorDeletedAt: null,
    projectId: PROJECT_A,
    correctionOf: null,
    reviewAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    subject: 'Docker port forwarding fails on WSL2',
    scope: 'WSL2 hosts',
    effectiveNote: null,
    contentExcerpt: 'Published port unreachable from the Windows host.',
    sources: [],
    recoveryPath: null,
    deferred: false,
    ...overrides,
  };
}

/** 治理白名单降级投影：**full 档字段整键缺席** */
function metadataNomination(overrides: Partial<MemoryNominationDto> = {}): MemoryNominationDto {
  const row = nomination(overrides);
  delete row.subject;
  delete row.scope;
  delete row.effectiveNote;
  delete row.contentExcerpt;
  delete row.sources;
  delete row.recoveryPath;
  delete row.deferred;
  return { ...row, projection: 'metadata' };
}

/** 列表信封 */
function listResponse(
  items: MemoryNominationDto[],
  total: number,
  availabilityBlock = availability(),
): MemoryNominationListResponse {
  return { items, total, page: 1, pageSize: 100, engineAvailability: availabilityBlock };
}

/** 通用分页信封（绑定候选三源用；Api 侧按 PaginatedResponse<T> 消费） */
function pagedResponse<T>(items: T[]) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 100,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  };
}

/** 召回响应 */
function recallResponse(overrides: Partial<MemoryRecallResponse> = {}): MemoryRecallResponse {
  return {
    items: [],
    emptyReason: 'none',
    filteredByPermission: false,
    engineDataSuspect: false,
    recallId: 'recall-1',
    presentationEventId: null,
    trustLevel: 'untrusted_advisory',
    decisionAuthority: 'none',
    usageNote: 'raw usage note',
    ...overrides,
  };
}

/**
 * 服务端语义 mock：按 query 参数对 fixture 过滤。
 *
 * 刻意**照着后端的过滤语义**实现（status/formationState 单值精确匹配 + 内存分页），
 * 这样"tab 归属互斥"这类断言才测的是真的请求参数，而不是我们自己造的假数据。
 */
function makeRouter(options: {
  projects?: MemoryProjectDto[];
  projectsError?: { status: number; code: number };
  /** 部署级自助开通开关（列表信封；缺省 = true，供创建表单的 hument/自动注册动线） */
  provisioningAvailable?: boolean;
  rows?: MemoryNominationDto[];
  /** 某一路强制失败（键 = formationState 或 status），模拟部分失败 */
  failState?: string;
  /** 列表整体失败（runtime 503） */
  listError?: { status: number; code: number; data?: Record<string, unknown> };
  recall?: MemoryRecallResponse | { deferred: true };
  /** 绑定候选（topic/board/docSpace 三种来源；缺省 = 空 ⇒ 目标下拉空态） */
  bindingTargets?: {
    topic?: { id: string; title: string }[];
    board?: { id: string; name: string }[];
    docSpace?: { id: string; name: string }[];
  };
  /** 候选列表加载失败（三态里的失败态） */
  bindingTargetsError?: { status: number; code: number };
  /** 候选列表挂起（三态里的加载中态） */
  bindingTargetsDeferred?: boolean;
  /** 创建成功返回的项目（缺省 = 新建 PROJECT_C） */
  createProject?: MemoryProjectDto;
  /** 创建失败（错误透传分叉用） */
  createError?: {
    status: number;
    code: number;
    data?: Record<string, unknown>;
    /** 覆盖服务端 message（验证"含 GET 路径的文案不得透传"） */
    message?: string;
  };
  /** 创建挂起（isPending 期间键盘契约用） */
  createDeferred?: boolean;
}) {
  const rows = options.rows ?? [];
  return (config: {
    method?: string;
    url?: string;
    params?: Record<string, unknown>;
    data?: unknown;
  }) => {
    const method = (config.method ?? 'GET').toUpperCase();
    if (method === 'GET' && config.url === '/memory/projects') {
      if (options.projectsError) {
        return Promise.reject(httpError(options.projectsError.status, options.projectsError.code));
      }
      return Promise.resolve(
        envelope({
          items: options.projects ?? [project()],
          total: (options.projects ?? [project()]).length,
          page: 1,
          pageSize: 100,
          provisioningAvailable: options.provisioningAvailable ?? true,
        }),
      );
    }
    // ── 创建项目（POST /memory/projects）────────────────────────────────────
    if (method === 'POST' && config.url === '/memory/projects') {
      if (options.createDeferred) return new Promise(() => {});
      if (options.createError) {
        const { status, code, data, message } = options.createError;
        return Promise.reject({
          response: { status, data: { code, message: message ?? `err ${code}`, data: data ?? {} } },
        });
      }
      return Promise.resolve(
        envelope(
          options.createProject ?? project({ id: PROJECT_C, slug: 'fresh-project', name: 'Fresh' }),
        ),
      );
    }
    // ── 绑定候选三源（创建表单的目标下拉）───────────────────────────────────
    if (method === 'GET' && config.url === '/topics') {
      if (options.bindingTargetsDeferred) return new Promise(() => {});
      if (options.bindingTargetsError) {
        return Promise.reject(
          httpError(options.bindingTargetsError.status, options.bindingTargetsError.code),
        );
      }
      return Promise.resolve(envelope(pagedResponse(options.bindingTargets?.topic ?? [])));
    }
    if (method === 'GET' && config.url === '/boards') {
      return Promise.resolve(envelope(pagedResponse(options.bindingTargets?.board ?? [])));
    }
    if (method === 'GET' && config.url === '/doc-spaces') {
      return Promise.resolve(envelope(pagedResponse(options.bindingTargets?.docSpace ?? [])));
    }
    if (method === 'GET' && /^\/memory\/projects\/[^/]+\/nominations$/.test(config.url ?? '')) {
      const params = config.params ?? {};
      if (options.listError) {
        return Promise.reject(
          httpError(options.listError.status, options.listError.code, options.listError.data),
        );
      }
      if (
        options.failState &&
        (params.formationState === options.failState || params.status === options.failState)
      ) {
        return Promise.reject(httpError(500, 9999));
      }
      const matched = rows.filter(
        (row) =>
          (!params.status || row.status === params.status) &&
          (!params.formationState || row.formationState === params.formationState),
      );
      // 服务端语义：total = 裁剪前全量行数，items = 内存 slice（分页器用例依赖这一点）
      const page = Number(params.page ?? 1);
      const pageSize = Number(params.pageSize ?? 100);
      const start = (page - 1) * pageSize;
      return Promise.resolve(
        envelope({
          ...listResponse(matched.slice(start, start + pageSize), matched.length),
          page,
          pageSize,
        }),
      );
    }
    if (method === 'POST' && /^\/memory\/projects\/[^/]+\/recalls$/.test(config.url ?? '')) {
      if (options.recall && 'deferred' in options.recall) return new Promise(() => {});
      return Promise.resolve(envelope(options.recall ?? recallResponse()));
    }
    return Promise.reject(new Error(`unexpected request: ${method} ${config.url}`));
  };
}

/** 取某 method+url 形态的全部请求 */
function callsTo(predicate: (config: { method?: string; url?: string }) => boolean) {
  return mockRequest.mock.calls
    .map(
      (call) =>
        call[0] as {
          method?: string;
          url?: string;
          params?: Record<string, unknown>;
          data?: Record<string, unknown>;
        },
    )
    .filter((config) => predicate({ method: config.method, url: config.url }));
}

/** 账本列表请求 */
function listCalls() {
  return callsTo(
    (c) => (c.method ?? 'GET').toUpperCase() === 'GET' && !!c.url?.includes('/nominations'),
  );
}

/** 召回请求 */
function recallCalls() {
  return callsTo(
    (c) => (c.method ?? 'GET').toUpperCase() === 'POST' && !!c.url?.includes('/recalls'),
  );
}

/** 创建项目请求（POST /memory/projects） */
function createCalls() {
  return callsTo(
    (c) => (c.method ?? 'GET').toUpperCase() === 'POST' && c.url === '/memory/projects',
  );
}

/** 项目名单请求（GET /memory/projects） */
function projectsCalls() {
  return callsTo(
    (c) => (c.method ?? 'GET').toUpperCase() === 'GET' && c.url === '/memory/projects',
  );
}

/** 绑定候选请求（GET /topics） */
function topicCalls() {
  return callsTo((c) => (c.method ?? 'GET').toUpperCase() === 'GET' && c.url === '/topics');
}

function renderPage() {
  // retryDelay: 0 —— 页面在调用点显式写了 `retry: 1`（plan §5 第 41 条硬要求，不吃全局默认），
  // 故失败路径的默认 1s 指数退避只能在测试端压掉：否则每个"错误态"用例都要等 1s 才稳定。
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  /**
   * ⚠️ 每次重渲染都要**新建**元素树（`makeUi()` 每次调用返回新对象）。
   * 复用同一个 element 对象会让 React 命中 `oldProps === newProps` 的 bailout：
   * 整个子树不重渲 ⇒ `useSearchParams()` 不会被重新求值 ⇒ 模拟的"地址栏变化"根本没传进组件
   * （M5 用例会假绿/假红）。这是 RTL 里模拟 URL 变化最容易踩的坑。
   */
  const makeUi = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryPage />
    </QueryClientProvider>
  );
  const utils = render(makeUi());
  // 同一 provider/client 重渲染 = 「地址栏变了但应用没主动动过」的那次渲染（后退/前进/外链）
  rerenderPage = () => utils.rerender(makeUi());
  return utils;
}

/**
 * 模拟浏览器**后退/前进**：改地址栏 + 重渲染（应用侧零动作，只能靠 URL→state 同步接住）。
 *
 * @param search - 目标 query 串（不含 `?`）
 */
function navigateTo(search: string) {
  mockSearchParamsString = search;
  // 包 act：地址栏变化 + 重渲染属于"外部事件"，不包的话同步触发的 state 更新不会刷进 DOM
  act(() => {
    rerenderPage?.();
  });
}

describe('MemoryPage 卡片墙与三 Tab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('用量深链恒带当前 project（/usage?tab=hument&project=<uuid>）', async () => {
    mockRequest.mockImplementation(makeRouter({ projects: [project()] }));
    renderPage();
    const link = await screen.findByTestId('memory-usage-entry');
    expect(link).toHaveAttribute('href', `/usage?tab=hument&project=${PROJECT_A}`);
  });

  it('渲染卡片：category chip / 状态 / 主张 / 摘要 / 归属 / 来源计数钻取提示', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({
            sources: [
              {
                type: 'doc',
                id: 'd1',
                parent: null,
                versionHash: 'h1',
                headingPath: 'Docs § 1',
                locator: 'chamber://doc/d1',
                moved: false,
                readWith: { tool: 'read_doc', params: {} },
              },
            ],
          }),
        ],
      }),
    );
    renderPage();

    const card = await screen.findByTestId('memory-card');
    expect(within(card).getByTestId('memory-category-chip')).toHaveTextContent('ruling');
    expect(within(card).getByTestId('memory-status-badge')).toHaveTextContent('In effect');
    expect(within(card).getByTestId('memory-card-subject')).toHaveTextContent(
      'Docker port forwarding fails on WSL2',
    );
    expect(within(card).getByTestId('memory-card-excerpt')).toHaveTextContent(
      'Published port unreachable from the Windows host.',
    );
    expect(within(card).getByTestId('memory-card-nominator-name')).toHaveTextContent('Agent One');
    // 来源计数是 text-[11px] 的钻取提示（**不是徽章**）
    // ICU plural（m12）：1 条走单数分支
    expect(within(card).getByTestId('memory-card-source-count')).toHaveTextContent('1 source');
  });

  it('三 Tab 带计数（committed 取自身 total；另两 Tab 取各路 total 之和）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'c1' }),
          nomination({ id: 'f1', formationState: 'failed' }),
          nomination({ id: 'r1', formationState: 'rejected' }),
          nomination({ id: 'nm1', formationState: 'no_memory' }),
          nomination({ id: 'w1', status: 'withdrawn', formationState: 'failed' }),
          nomination({ id: 's1', status: 'superseded' }),
        ],
      }),
    );
    renderPage();

    expect(await screen.findByTestId('memory-tab-committed')).toHaveTextContent('Remembered (1)');
    // 提名记录 = failed + rejected + no_memory 三路各自 total 之和（committed 不进）
    expect(screen.getByTestId('memory-tab-nominations')).toHaveTextContent('Nominations (3)');
    // 已失效 = superseded + withdrawn
    expect(screen.getByTestId('memory-tab-inactive')).toHaveTextContent('Retired (2)');
  });

  /**
   * ③ **Tab 归属互斥**：`withdrawn` 行的 formationState 可以是 failed，但它属于无效主张
   * （DB 不变量 withdrawn ⇒ engineMemoryIds 为空），只能出现在「已失效」。
   *
   * 断言分两层：请求参数层（提名记录六路全带 `status=active`）+ 渲染层（切到已失效才看得到它）。
   */
  it('Tab 归属互斥：withdrawn + failed 只进「已失效」，不出现在「提名记录」', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'f1', formationState: 'failed', subject: 'Failed claim' }),
          nomination({
            id: 'w1',
            status: 'withdrawn',
            formationState: 'failed',
            subject: 'A withdrawn correction',
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-tabs');

    // 六路请求全部带 status=active（没有任何一路去找 withdrawn）
    const formationCalls = listCalls().filter((c) => c.params?.formationState);
    expect(formationCalls.length).toBeGreaterThanOrEqual(6);
    expect(formationCalls.every((c) => c.params?.status === 'active')).toBe(true);

    fireEvent.click(screen.getByTestId('memory-tab-nominations'));
    expect(await screen.findByText('Failed claim')).toBeInTheDocument();
    expect(screen.queryByText('A withdrawn correction')).toBeNull();

    fireEvent.click(screen.getByTestId('memory-tab-inactive'));
    expect(await screen.findByText('A withdrawn correction')).toBeInTheDocument();
  });

  it('⑥ 未终态行在「提名记录」可见：rejected / no_memory 各自渲染，并带形成态徽章', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'r1', formationState: 'rejected', subject: 'Rejected claim' }),
          nomination({ id: 'nm1', formationState: 'no_memory', subject: 'Engine saw nothing new' }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-tabs');

    fireEvent.click(screen.getByTestId('memory-tab-nominations'));
    expect(await screen.findByText('Rejected claim')).toBeInTheDocument();
    expect(screen.getByText('Nothing to remember')).toBeInTheDocument();
    const badges = screen
      .getAllByTestId('memory-formation-badge')
      .map((badge) => badge.textContent);
    expect(badges).toContain('Rejected');
    expect(badges).toContain('Nothing to remember');
  });

  it('子标签 chip 是真筛选器：带各自 total，点了就过滤合并集', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'f1', formationState: 'failed', subject: 'Failed claim' }),
          nomination({ id: 'r1', formationState: 'rejected', subject: 'Rejected claim' }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-tabs');
    fireEvent.click(screen.getByTestId('memory-tab-nominations'));

    const chip = await screen.findByTestId('memory-formation-chip-failed');
    expect(chip).toHaveTextContent('Failed (1)');
    expect(screen.getByTestId('memory-formation-chip-rejected')).toHaveTextContent('Rejected (1)');

    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByText('Rejected claim')).toBeNull());
    expect(screen.getByText('Failed claim')).toBeInTheDocument();
  });

  it('⑯ 提名记录行的下一步出口：人类文案 + 账本 id 文本（**不裸渲染机器码**）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({
            id: 'r1',
            formationState: 'rejected',
            subject: 'Rejected claim',
            recoveryPath: 'hub_manual_required',
          }),
          nomination({
            id: 'ok1',
            formationState: 'failed',
            subject: 'Retryable claim',
            recoveryPath: null,
          }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-tabs');
    fireEvent.click(screen.getByTestId('memory-tab-nominations'));

    const note = await screen.findByTestId('memory-card-recovery');
    expect(note).toHaveTextContent(messages['memory.recovery.hubManualRequired']);
    // 机器码不许出现在界面上（未映射值另有通用文案兜底）
    expect(note).not.toHaveTextContent('hub_manual_required');
    // 账本 id 以**可选中文本**给出（卡内不放复制按钮：整卡是链接，见第 26/48 条）
    expect(within(note).getByTestId('memory-recovery-ledger-id')).toHaveTextContent('r1');
    expect(within(note).queryByTestId('memory-recovery-copy')).toBeNull();
    // recoveryPath 为 null 的行不渲染这句（"无下一步"渲染成一行字只会让人怀疑数据丢了）
    expect(screen.getAllByTestId('memory-card-recovery')).toHaveLength(1);
  });

  it('截断说明：某一路 total > 100 时写「已显示最近 100 条 · 共 N 条」', async () => {
    // failed 路 total=250（只回 100 条），另一路正常 ⇒ 逐路说明截断
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          return Promise.resolve(
            envelope({ items: [project()], total: 1, page: 1, pageSize: 100 }),
          );
        }
        const params = config.params ?? {};
        if (params.formationState === 'failed') {
          return Promise.resolve(
            envelope(listResponse([nomination({ id: 'f1', formationState: 'failed' })], 250)),
          );
        }
        return Promise.resolve(envelope(listResponse([], 0)));
      },
    );
    renderPage();
    await screen.findByTestId('memory-tabs');
    fireEvent.click(screen.getByTestId('memory-tab-nominations'));

    expect(await screen.findByTestId('memory-truncated-failed')).toHaveTextContent(
      'Showing the newest 100 · 250 in total',
    );
  });
});

describe('MemoryPage 降级两成因分叉（第 19/25 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('成因①「无项目内容读权限」（整片 metadata）→ 页面级横幅 + 紧凑三列表，不渲染 N 张锁态卡', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: [metadataNomination({ id: 'm1' }), metadataNomination({ id: 'm2' })] }),
    );
    renderPage();

    expect(await screen.findByTestId('memory-degraded-banner')).toHaveTextContent(
      messages['memory.degraded.pageBanner'],
    );
    expect(screen.getByTestId('memory-metadata-list')).toBeInTheDocument();
    expect(screen.getAllByTestId('memory-metadata-row')).toHaveLength(2);
    // 整片降级不摆 N 个锁态卡（那是 N 次说同一句话）
    expect(screen.queryAllByTestId('memory-locked-row')).toHaveLength(0);
  });

  it('成因②「该条目来源已不可见」（混合降级）→ 仅那些行渲染同高锁态行，且无页面级横幅', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'full-1', subject: 'Visible claim' }),
          metadataNomination({ id: 'meta-1' }),
        ],
      }),
    );
    renderPage();

    expect(await screen.findByTestId('memory-locked-row')).toHaveTextContent(
      messages['memory.degraded.rowLocked'],
    );
    // 两种成因文案**不同**（这是本组用例的核心）
    expect(messages['memory.degraded.rowLockedHint']).not.toBe(
      messages['memory.degraded.pageBanner'],
    );
    expect(screen.queryByTestId('memory-degraded-banner')).toBeNull();
    expect(screen.getByText('Visible claim')).toBeInTheDocument();
  });

  it('项目下拉的「无内容读权限」标注**数据驱动**（canReadContent=false 才标，与是否访问过无关）', async () => {
    const badge = messages['memory.project.metadataOnlyBadge'];
    mockRequest.mockImplementation(
      makeRouter({
        projects: [
          project({ canReadContent: false }),
          project({ id: PROJECT_B, slug: 'other', name: 'Other' }),
        ],
        rows: [nomination()],
      }),
    );
    renderPage();

    await screen.findByTestId('memory-card');
    const select = screen.getByTestId('memory-project-select');
    // 负向单侧：只有 false 的项目被标出（true 的项目不标，形态仍是纯文本无着色）
    expect(within(select).getByText(`Chamber Main (chamber-main) · ${badge}`)).toBeInTheDocument();
    expect(within(select).getByText('Other (other)')).toBeInTheDocument();
    // 与项目级可读性无关的行级文案**不受影响**（拆词：项目级 ≠ 行级来源可见性）
    expect(messages['memory.degraded.rowLocked']).not.toBe(badge);
    expect(messages['memory.card.metadataOnly']).not.toBe(badge);
  });
});

describe('MemoryPage 项目列表三态', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('② 项目列表为空 → 专用空态 + **创建入口**（零项目用户的最大断点，PM Q1-a）', async () => {
    mockRequest.mockImplementation(makeRouter({ projects: [], rows: [] }));
    renderPage();

    const empty = await screen.findByTestId('memory-projects-empty');
    expect(within(empty).getByText(messages['memory.project.emptyTitle'])).toBeInTheDocument();
    expect(within(empty).getByText(messages['memory.project.emptyDesc'])).toBeInTheDocument();
    // W-3 口径：不说"请联系他们创建"，改说"绑定一个你能读的…即可创建"
    expect(messages['memory.project.emptyDesc']).not.toContain('Ask them');
    // 不渲染卡片墙/Tab（没有项目就没有账本可看）
    expect(screen.queryByTestId('memory-tabs')).toBeNull();

    // 空态 CTA：点了能开创建 Dialog（否则"空态有入口"只是摆设）
    fireEvent.click(screen.getByTestId('memory-project-create-empty'));
    expect(await screen.findByTestId('memory-create-submit')).toBeInTheDocument();
    expect(screen.getByTestId('memory-create-name')).toHaveFocus();
  });

  it('项目列表失败 → 错误态 + 重试', async () => {
    mockRequest.mockImplementation(makeRouter({ projectsError: { status: 500, code: 9999 } }));
    renderPage();

    expect(await screen.findByTestId('memory-projects-error')).toBeInTheDocument();
    expect(screen.getByText(messages['memory.project.retry'])).toBeInTheDocument();
  });
});

describe('MemoryPage 引擎不可用分层（D9 / 第 18 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  /**
   * ⑤ **分层**：引擎不可用只降级搜索区，**卡片墙照常可用**——
   * 本地数据端点（projects/ledger/detail）根本不依赖引擎。
   */
  it('项目级 engineAvailability: project_engine_unbound → 横幅 + 禁用搜索 + 卡片墙照常', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        projects: [
          project({
            engineAvailability: availability({
              engine: 'none',
              available: false,
              reason: 'project_engine_unbound',
            }),
          }),
        ],
        rows: [nomination({ id: 'c1' })],
      }),
    );
    renderPage();

    const banner = await screen.findByTestId('memory-engine-banner');
    expect(banner).toHaveAttribute('data-kind', 'projectUnbound');
    expect(banner).toHaveTextContent(messages['memory.engine.reason.projectUnbound']);
    expect(screen.getByTestId('memory-search-input')).toBeDisabled();
    expect(screen.getByTestId('memory-search-submit')).toBeDisabled();
    // 卡片墙不受影响
    expect(await screen.findByTestId('memory-card')).toBeInTheDocument();
    expect(screen.getByTestId('memory-engine-light-label')).toHaveTextContent('Engine unavailable');
  });

  it('部署未配引擎（not_configured）→ 同一横幅的**另一套**文案', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        projects: [
          project({
            engine: 'none',
            engineWorkspaceId: null,
            engineActorId: null,
            engineCredentialRef: null,
            engineAvailability: availability({
              engine: 'none',
              available: false,
              reason: 'not_configured',
            }),
          }),
        ],
        rows: [nomination({ id: 'c1' })],
      }),
    );
    renderPage();

    const banner = await screen.findByTestId('memory-engine-banner');
    expect(banner).toHaveAttribute('data-kind', 'notConfigured');
    expect(banner).toHaveTextContent(messages['memory.engine.reason.notConfigured']);
    // 三套文案互不相同（按成因分叉的全部意义）
    expect(messages['memory.engine.reason.notConfigured']).not.toBe(
      messages['memory.engine.reason.projectUnbound'],
    );
  });

  it('runtime 503 → 复用同一横幅态 + 禁用搜索（并附 runtime 说明行）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [],
        listError: { status: 503, code: 14000, data: { reason: 'engine_unreachable' } },
      }),
    );
    renderPage();

    const banner = await screen.findByTestId('memory-engine-banner');
    expect(banner).toHaveAttribute('data-kind', 'engineUnavailable');
    expect(screen.getByTestId('memory-engine-banner-runtime')).toHaveTextContent(
      messages['memory.engine.runtimeNote'],
    );
    expect(screen.getByTestId('memory-search-input')).toBeDisabled();
  });

  it('引擎正常时状态灯中性且可搜索（常态不发光不告警）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination({ id: 'c1' })] }));
    renderPage();

    await screen.findByTestId('memory-card');
    expect(screen.queryByTestId('memory-engine-banner')).toBeNull();
    expect(screen.getByTestId('memory-engine-light-label')).toHaveTextContent('Engine connected');
    expect(screen.getByTestId('memory-search-input')).not.toBeDisabled();
  });
});

describe('MemoryPage 双模式搜索（D7 / 第 10/11/13/14/17 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({
      user: { id: 'u-1', email: 'u@x.io', name: 'U', role: 'editor' },
      isAuthenticated: true,
    });
  });

  it('模式切换器是 radiogroup（非 Tabs），切换**不重置查询词**', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await screen.findByTestId('memory-card');

    expect(screen.getByTestId('memory-search-mode')).toHaveAttribute('role', 'radiogroup');
    expect(screen.getByTestId('memory-search-mode-semantic')).toHaveAttribute('role', 'radio');
    expect(screen.getByTestId('memory-search-mode-semantic')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'docker' } });
    fireEvent.click(screen.getByTestId('memory-search-mode-literal'));

    expect(screen.getByTestId('memory-search-input')).toHaveValue('docker');
    expect(screen.getByTestId('memory-search-mode-literal')).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('模式说明常驻且随模式变化（语义 = 配额代价；字面 = 候选规模 + 零配额）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await screen.findByTestId('memory-card');

    expect(screen.getByTestId('memory-search-mode-note')).toHaveTextContent(
      messages['memory.search.semanticNote'].replace('{max}', '20'),
    );
    fireEvent.click(screen.getByTestId('memory-search-mode-literal'));
    expect(screen.getByTestId('memory-search-mode-note')).toHaveTextContent(
      messages['memory.search.literalNote'].replace('{count}', '1'),
    );
  });

  it('字面模式：输入即过滤、**零请求**（不再打引擎）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ subject: 'Docker issue' }),
          nomination({ id: 'n2', subject: 'Kanban issue' }),
        ],
      }),
    );
    renderPage();
    expect(await screen.findAllByTestId('memory-card')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('memory-search-mode-literal'));
    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'kanban' } });

    await waitFor(() => expect(screen.queryByText('Docker issue')).toBeNull());
    expect(screen.getByText('Kanban issue')).toBeInTheDocument();
    expect(recallCalls()).toHaveLength(0);
  });

  it('⑧ 字面过滤边界：无匹配时给"这一页没匹配"的专写文案（≠"没有记忆"），且仍零请求', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination({ subject: 'Docker issue' })] }));
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.click(screen.getByTestId('memory-search-mode-literal'));
    fireEvent.change(screen.getByTestId('memory-search-input'), {
      target: { value: 'kubernetes' },
    });

    expect(await screen.findByTestId('memory-literal-empty')).toHaveTextContent(
      messages['memory.search.literalEmpty'].replace('{query}', 'kubernetes'),
    );
    // 与"没有记忆"的空态文案不同（两件事）
    expect(messages['memory.search.literalEmpty']).not.toBe(
      messages['memory.empty.committedTitle'],
    );
    expect(recallCalls()).toHaveLength(0);
  });

  it('⑦ 语义模式：提交打一次引擎，载荷含身份/世代(≥0)/预算，结果顶栏展示信任框与 recallId', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        recall: recallResponse({
          items: [
            // W-2②：**两条差异分数**（7 vs 3）——单条或全同值会被 `memoryRecallScoresInformative`
            // 抑制，"渲染相关度 N"的用例就会恒败。这条 fixture 是该断言的依据。
            recallItem({
              memoryId: 'm1',
              ledgerId: 'n1',
              subject: 'Semantic hit',
              body: 'body text',
              score: 7,
              sources: [
                {
                  type: 'doc',
                  id: 'd1',
                  parent: null,
                  versionHash: null,
                  headingPath: null,
                  locator: 'chamber://doc/d1',
                  moved: true,
                  readWith: { tool: 'read_doc', params: {} },
                },
              ],
            }),
            recallItem({
              memoryId: 'm2',
              ledgerId: 'n2',
              subject: 'Second hit',
              body: 'another body',
              score: 3,
              derivation: 'authorship',
              sources: [],
            }),
          ],
          recallId: 'recall-42',
          filteredByPermission: true,
          engineDataSuspect: true,
        }),
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.change(screen.getByTestId('memory-search-input'), {
      target: { value: 'what do we know' },
    });
    fireEvent.click(screen.getByTestId('memory-search-submit'));

    await waitFor(() => expect(recallCalls()).toHaveLength(1));
    const call = recallCalls()[0];
    expect(call.url).toBe(`/memory/projects/${PROJECT_A}/recalls`);
    expect(call.data?.query).toBe('what do we know');
    expect(call.data?.contextIdentity).toBe(`web:user:u-1:project:${PROJECT_A}`);
    expect(typeof call.data?.contextEpoch).toBe('number');
    expect(call.data?.contextEpoch as number).toBeGreaterThan(0);
    // ⚠️ 上限断言是**防回归哨兵**：引擎硬上限 1e9，`Date.now()` 毫秒（1.76e12）与
    // Unix 秒（1.76e9）都会被后端 DTO @Max 当场 400（backend `c5758ece`）。
    // 没有这一条时，"typeof number && > 0" 恰好放过毫秒值——回归只能靠打真引擎才发现。
    expect(call.data?.contextEpoch as number).toBeLessThanOrEqual(1_000_000_000);
    expect(call.data?.maxItems).toBe(20);

    // 结果顶栏：人类化信任框 + 上限 + 顺序说明 + recallId + 权限过滤 + 引擎数据可疑
    expect(await screen.findByTestId('memory-recall-trust-note')).toHaveTextContent(
      messages['memory.search.trustNote'],
    );
    expect(screen.getByTestId('memory-recall-max-items')).toHaveTextContent('At most 20 results');
    expect(screen.getByTestId('memory-recall-order-note')).toHaveTextContent(
      messages['memory.search.orderNote'],
    );
    expect(screen.getByTestId('memory-recall-id')).toHaveTextContent('recall-42');
    expect(screen.getByTestId('memory-recall-filtered')).toBeInTheDocument();
    expect(screen.getByTestId('memory-recall-suspect')).toBeInTheDocument();
    // 原始信任框三件套进折叠调试区（不丢）
    expect(
      within(screen.getByTestId('memory-recall-debug')).getByText('raw usage note'),
    ).toBeInTheDocument();
    // 条目级只留差异化出处徽章（两条：有出处 1 条 / 无出处（自述））
    const badges = screen.getAllByTestId('memory-derivation-badge');
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent('1 source');
    // A1 行尾弱文本：差异分数各按原值渲染（7 / 3），且不是 Badge（只是 span 文本）
    const scoreNotes = screen.getAllByTestId('memory-recall-score');
    expect(scoreNotes).toHaveLength(2);
    expect(scoreNotes[0]).toHaveTextContent('Relevance 7');
    expect(scoreNotes[1]).toHaveTextContent('Relevance 3');
    // 与 scope 行同档（样式在承载 scope+score 的同一行 <p> 上）
    expect(scoreNotes[0].parentElement?.className).toContain('text-[11px]');
    expect(scoreNotes[0].parentElement?.className).toContain('text-muted-foreground/80');
    expect(scoreNotes[0].tagName).toBe('SPAN');
    // 第 12 条：语义结果展示时 Tab 栏让位（只作用于账本）
    expect(screen.queryByTestId('memory-tabs')).toBeNull();
  });

  it('再提交**同一个词**仍然强制打引擎（缓存不吞第二次提交：epoch 入 payload 不入 key）', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: [nomination()], recall: recallResponse({ recallId: 'r-1' }) }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'same word' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));
    await waitFor(() => expect(recallCalls()).toHaveLength(1));

    fireEvent.click(screen.getByTestId('memory-search-submit'));
    await waitFor(() => expect(recallCalls()).toHaveLength(2));
    // 两次的 epoch 都是新取的（同词重搜可复现，但不复用旧结果）
    expect(typeof recallCalls()[1].data?.contextEpoch).toBe('number');
    expect(recallCalls()[1].data?.contextEpoch as number).toBeLessThanOrEqual(1_000_000_000);
  });

  it('⑰ all_filtered 与 no_matches 文案互不相同（下一步动作不同）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        recall: recallResponse({ emptyReason: 'all_filtered', filteredByPermission: true }),
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));

    expect(await screen.findByTestId('memory-recall-empty')).toHaveTextContent(
      messages['memory.search.empty.allFiltered'],
    );
    expect(messages['memory.search.empty.allFiltered']).not.toBe(
      messages['memory.search.empty.noMatches'],
    );
  });

  it('召回 403（无内容读权限）→ 搜索框禁用 + **常驻可见**说明行（不是 title 悬浮）', async () => {
    let first = true;
    mockRequest.mockImplementation((config: { method?: string; url?: string }) => {
      const method = (config.method ?? 'GET').toUpperCase();
      if (method === 'GET' && config.url === '/memory/projects') {
        return Promise.resolve(envelope({ items: [project()], total: 1, page: 1, pageSize: 100 }));
      }
      if (method === 'GET' && config.url?.includes('/nominations')) {
        return Promise.resolve(envelope(listResponse([nomination()], 1)));
      }
      if (method === 'POST' && config.url?.includes('/recalls')) {
        if (first) {
          first = false;
          return Promise.reject(httpError(403, 1009));
        }
        return Promise.resolve(envelope(recallResponse()));
      }
      return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
    });
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));

    const note = await screen.findByTestId('memory-search-disabled-note');
    expect(note).toHaveTextContent(messages['memory.search.forbidden']);
    expect(screen.getByTestId('memory-search-input')).toBeDisabled();
  });
});

describe('MemoryPage 切项目竞态与 URL 分层（第 37/40 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({
      user: { id: 'u-1', email: 'u@x.io', name: 'U', role: 'editor' },
      isAuthenticated: true,
    });
  });

  /** 造一个"永远不 resolve"的召回请求 + 一次手动 resolve 的开关 */
  function deferredRecall() {
    let release: (() => void) | null = null;
    const pending = new Promise<unknown>((resolve) => {
      release = () => resolve(envelope(recallResponse({ recallId: 'stale-recall' })));
    });
    return { pending, release: () => release?.() };
  }

  it('⑨ 切项目丢弃在途召回响应：旧项目的结果 resolve 后**永不**渲染到新项目视图', async () => {
    const { pending, release } = deferredRecall();
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          return Promise.resolve(
            envelope({
              items: [project(), project({ id: PROJECT_B, slug: 'other', name: 'Other' })],
              total: 2,
              page: 1,
              pageSize: 100,
            }),
          );
        }
        if (method === 'GET' && config.url?.includes('/nominations')) {
          return Promise.resolve(envelope(listResponse([nomination()], 1)));
        }
        if (method === 'POST' && config.url?.includes('/recalls')) return pending;
        return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
      },
    );
    renderPage();
    await screen.findByTestId('memory-card');

    // 项目 A 上发起语义搜索（在途）
    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'in flight' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));
    await waitFor(() => expect(recallCalls()).toHaveLength(1));
    expect(await screen.findByTestId('memory-recall-loading')).toBeInTheDocument();

    // 切项目 B：召回结果态立刻清空（含丢弃在途响应），回默认 tab 与第 1 页
    fireEvent.change(screen.getByTestId('memory-project-select'), { target: { value: PROJECT_B } });
    expect(await screen.findByTestId('memory-tabs')).toBeInTheDocument();
    expect(screen.queryByTestId('memory-recall-results')).toBeNull();

    // 旧项目的响应姗姗来迟：仍然不许渲染到 B 的视图里
    release();
    await waitFor(() => expect(screen.getByTestId('memory-card')).toBeInTheDocument());
    expect(screen.queryByTestId('memory-recall-results')).toBeNull();
    expect(screen.queryByTestId('memory-recall-id')).toBeNull();
    // 切项目后所有账本请求都指向 B（结果态按 projectId 键控）
    await waitFor(() =>
      expect(listCalls().some((c) => c.url === `/memory/projects/${PROJECT_B}/nominations`)).toBe(
        true,
      ),
    );
  });

  it('⑩ URL 分层：切项目/切 Tab 走 push（位置语义）；切模式/翻页/查询词走 replace', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        projects: [project(), project({ id: PROJECT_B, slug: 'other', name: 'Other' })],
        rows: [nomination()],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.click(screen.getByTestId('memory-tab-nominations'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    // 非「已记住」Tab：从 URL 移除 page
    expect(String(mockPush.mock.calls[0][0])).toContain('tab=nominations');
    expect(String(mockPush.mock.calls[0][0])).not.toContain('page=');

    fireEvent.change(screen.getByTestId('memory-project-select'), { target: { value: PROJECT_B } });
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));
    expect(String(mockPush.mock.calls[1][0])).toContain(`project=${PROJECT_B}`);
    // 切项目回默认 tab 且 page 从 URL 移除
    expect(String(mockPush.mock.calls[1][0])).toContain('tab=committed');
    expect(String(mockPush.mock.calls[1][0])).not.toContain('page=');

    fireEvent.click(screen.getByTestId('memory-search-mode-literal'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(String(mockReplace.mock.calls.at(-1)?.[0])).toContain('mode=literal');
    // 位置语义与瞬时浏览态互不串台
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('翻页走 replace 且请求带 page（仅「已记住」有分页器）', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: Array.from({ length: 25 }, (_, i) => nomination({ id: `n${i}` })) }),
    );
    renderPage();
    expect(await screen.findAllByTestId('memory-card')).toHaveLength(20);

    fireEvent.click(screen.getByTestId('memory-next-page'));
    await waitFor(() => expect(listCalls().some((c) => c.params?.page === 2)).toBe(true));
    expect(String(mockReplace.mock.calls.at(-1)?.[0])).toContain('page=2');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('⑪ URL 恢复的 q 只回填输入框 + 给"不会自动执行"说明，**永不**自动烧配额', async () => {
    mockSearchParamsString = 'q=docker&project=' + PROJECT_A;
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();

    expect(await screen.findByTestId('memory-search-input')).toHaveValue('docker');
    expect(await screen.findByTestId('memory-recall-restored')).toHaveTextContent(
      messages['memory.search.restoredHint'],
    );
    // 关键：挂载期一次召回请求都不发
    expect(recallCalls()).toHaveLength(0);
  });

  it('清空语义结果：回到账本并清掉 URL 里的 q', async () => {
    mockSearchParamsString = 'q=docker';
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()], recall: recallResponse() }));
    renderPage();
    await screen.findByTestId('memory-recall-restored');

    fireEvent.click(screen.getByTestId('memory-recall-back'));
    expect(await screen.findByTestId('memory-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('memory-search-input')).toHaveValue('');
  });
});

describe('MemoryPage Tab 部分失败（第 21 条）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('④ 六路里挂一路：报错只出现在「提名记录」内，不污染「已记住」', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'c1' }),
          nomination({ id: 'f1', formationState: 'failed' }),
          nomination({ id: 'r1', formationState: 'rejected', subject: 'Still reachable' }),
        ],
        failState: 'failed',
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    // 已记住 Tab 干净：没有任何错误文案
    expect(screen.queryByTestId('memory-tab-partial-error')).toBeNull();
    expect(screen.queryByTestId('memory-tab-error')).toBeNull();

    fireEvent.click(screen.getByTestId('memory-tab-nominations'));
    // 该路挂了 ⇒ 在这一格内显式报错（静默失败会被读成"这条路没有数据"）。
    // 文案：注入的是 **500 + code 9999**，按通道分级（卡 240c74d6）**5xx 不透传服务端
    // message**，一律回落本地兜底文案（`MEMORY_ERROR_FALLBACK` = 'request failed'）——
    // 这条断言同时把"5xx 不泄露服务端措辞"钉在 memory 页上。
    expect(await screen.findByTestId('memory-tab-partial-error')).toHaveTextContent(
      'request failed',
    );
    // 其它路的数据照常渲染（部分失败 ≠ 整页失败）
    expect(await screen.findByText('Still reachable')).toBeInTheDocument();
  });
});

/**
 * 评审修订轮（fix commit）新增覆盖。
 *
 * 每条都对应一处 reviewer 取证的真实缺陷，故断言刻意打在"缺陷的可观测后果"上：
 * M1 点重试**真的发请求**、M2 旧结果**被标记为旧**且能重生、M4 最终 href **同时含新 tab 与 q**、
 * M5 后退**界面跟着地址栏走**且恢复的 q 仍不自动烧配额。
 */
describe('MemoryPage 评审修订（M1/M2/M4/M5）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ mode: undefined, user: null, isAuthenticated: false } as never);
  });

  it('M1 阻塞错误态的重试真的发请求（提名记录 Tab：六路全失败时逐路重打）', async () => {
    // 该 fixture 下唯一有数据的路就是失败的那路 ⇒ visibleRows 为空 ⇒ 走阻塞错误态
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination({ id: 'f1', formationState: 'failed', subject: 'Failed claim' })],
        failState: 'failed',
      }),
    );
    renderPage();
    await screen.findByTestId('memory-tabs');
    fireEvent.click(screen.getByTestId('memory-tab-nominations'));

    await screen.findByTestId('memory-tab-error');
    const before = listCalls().filter((c) => c.params?.formationState === 'failed').length;
    expect(before).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('memory-tab-error-retry'));

    // 关键断言：按钮不是空操作 —— 失败路被真的重打了一遍
    await waitFor(() =>
      expect(
        listCalls().filter((c) => c.params?.formationState === 'failed').length,
      ).toBeGreaterThan(before),
    );
  });

  it('M1 已记住 Tab 的重试打在 committed 路（分派不串台）', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: [], listError: { status: 500, code: 9999 } }),
    );
    renderPage();

    await screen.findByTestId('memory-tab-error');
    const before = listCalls().filter((c) => c.params?.formationState === 'committed').length;
    fireEvent.click(screen.getByTestId('memory-tab-error-retry'));
    await waitFor(() =>
      expect(
        listCalls().filter((c) => c.params?.formationState === 'committed').length,
      ).toBeGreaterThan(before),
    );
  });

  it('M2 第二次提交失败：旧结果仍在但**被标记为旧** + 重试再发一次', async () => {
    let recallCount = 0;
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          return Promise.resolve(
            envelope({ items: [project()], total: 1, page: 1, pageSize: 100 }),
          );
        }
        if (method === 'GET' && config.url?.includes('/nominations')) {
          return Promise.resolve(envelope(listResponse([nomination()], 1)));
        }
        if (method === 'POST' && config.url?.includes('/recalls')) {
          recallCount += 1;
          // 第 1 次成功、第 2 次失败（refetch 失败会保留旧 data，status=error）
          if (recallCount === 2) return Promise.reject(httpError(500, 9999));
          return Promise.resolve(
            envelope(
              recallResponse({
                recallId: `recall-${recallCount}`,
                items: [recallItem({ subject: 'First hit', body: 'body', score: 7 })],
              }),
            ),
          );
        }
        return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
      },
    );
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'q1' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));
    expect(await screen.findByTestId('memory-recall-item')).toHaveTextContent('First hit');

    // 第二次提交（重搜同一词）：这次失败
    fireEvent.click(screen.getByTestId('memory-search-submit'));
    await waitFor(() => expect(recallCalls()).toHaveLength(2));

    // 旧结果**不白丢**（还在），但必须明说"这次刷新没成功"
    expect(await screen.findByTestId('memory-recall-stale-warning')).toBeInTheDocument();
    expect(screen.getByTestId('memory-recall-item')).toHaveTextContent('First hit');
    // 且不是"通用错误态"（那是无数据时的分支）
    expect(screen.queryByTestId('memory-recall-error')).toBeNull();

    // 重试出口真能重生
    fireEvent.click(screen.getByTestId('memory-recall-stale-retry'));
    await waitFor(() => expect(recallCalls()).toHaveLength(3));
  });

  it('M4 防抖写入用**写入时刻**的 URL 当基底：打字后立刻切 Tab ⇒ href 含新 tab 且保留 q', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await screen.findByTestId('memory-card');

    // 打字（防抖 300ms 未到）→ 立刻切 Tab（push 改地址栏）
    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'doc' } });
    fireEvent.click(screen.getByTestId('memory-tab-nominations'));

    // 防抖落地时若拿旧基底当基底，这次写入会把 tab=nominations 冲掉（只剩 q=doc）
    await waitFor(
      () =>
        expect(
          mockReplace.mock.calls.some(
            (call) =>
              String(call[0]).includes('tab=nominations') && String(call[0]).includes('q=doc'),
          ),
        ).toBe(true),
      { timeout: 2000 },
    );
    // 且没有一次写入把 tab 打回 committed
    expect(mockReplace.mock.calls.some((call) => String(call[0]).includes('tab=committed'))).toBe(
      false,
    );
  });

  it('M5 后退恢复 tab：界面 Tab 跟着地址栏走（push 语义兑现）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [
          nomination({ id: 'c1' }),
          nomination({ id: 'w1', status: 'withdrawn', subject: 'Withdrawn one' }),
        ],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    // 前进到「已失效」
    fireEvent.click(screen.getByTestId('memory-tab-inactive'));
    expect(await screen.findByText('Withdrawn one')).toBeInTheDocument();
    expect(mockSearchParamsString).toContain('tab=inactive');

    // 浏览器后退：地址栏回到默认 tab，应用侧零动作 ⇒ 只能靠 URL→state 同步接住
    navigateTo('');
    expect(await screen.findByText('Docker port forwarding fails on WSL2')).toBeInTheDocument();
    expect(screen.queryByText('Withdrawn one')).toBeNull();
  });

  it('M5 后退恢复 q：回填输入框与展示态，但**召回请求数仍为 0**（不自动烧配额）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()], recall: recallResponse() }));
    renderPage();
    await screen.findByTestId('memory-card');
    expect(recallCalls()).toHaveLength(0);

    // 外链/后退带来的带 q 地址
    navigateTo('q=docker');

    expect(await screen.findByTestId('memory-search-input')).toHaveValue('docker');
    expect(await screen.findByTestId('memory-recall-restored')).toHaveTextContent(
      messages['memory.search.restoredHint'],
    );
    // 安全底线：恢复 ≠ 执行
    expect(recallCalls()).toHaveLength(0);
  });

  it('M5 后退到**无 q** 的地址：输入框跟着清空（不能留着上一次的词）', async () => {
    mockSearchParamsString = 'q=docker';
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()], recall: recallResponse() }));
    renderPage();
    await screen.findByTestId('memory-recall-restored');

    navigateTo('');
    await waitFor(() => expect(screen.getByTestId('memory-search-input')).toHaveValue(''));
    expect(recallCalls()).toHaveLength(0);
  });

  it('m1 切项目一并清掉 URL 的 q（不让上一个项目的查询词在刷新后复活）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        projects: [project(), project({ id: PROJECT_B, slug: 'other', name: 'Other' })],
        rows: [nomination()],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    fireEvent.change(screen.getByTestId('memory-search-input'), {
      target: { value: 'stale query' },
    });
    // URLSearchParams 把空格编码成 `+`
    await waitFor(() => expect(mockSearchParamsString).toContain('q=stale+query'));

    fireEvent.change(screen.getByTestId('memory-project-select'), { target: { value: PROJECT_B } });
    await waitFor(() => expect(mockSearchParamsString).toContain(`project=${PROJECT_B}`));
    expect(mockSearchParamsString).not.toContain('q=');
  });

  it('m2 已失效 Tab 先撞上 runtime 503 也出引擎横幅（不再被读成"本地请求失败"）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [],
        failState: 'withdrawn',
        listError: undefined,
      }),
    );
    // withdrawn 路单独 503（另两路正常）——用自定义实现精确控制
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          return Promise.resolve(
            envelope({ items: [project()], total: 1, page: 1, pageSize: 100 }),
          );
        }
        if (method === 'GET' && config.url?.includes('/nominations')) {
          if (config.params?.status === 'withdrawn') {
            return Promise.reject(httpError(503, 14000, { reason: 'engine_unreachable' }));
          }
          return Promise.resolve(envelope(listResponse([], 0)));
        }
        return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
      },
    );
    renderPage();

    const banner = await screen.findByTestId('memory-engine-banner');
    expect(banner).toHaveAttribute('data-kind', 'engineUnavailable');
    expect(screen.getByTestId('memory-search-input')).toBeDisabled();
  });

  it('m4 字面模式不渲染提交按钮（输入即过滤，空操作按钮比没有更糟）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await screen.findByTestId('memory-card');

    expect(screen.getByTestId('memory-search-submit')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('memory-search-mode-literal'));
    await waitFor(() => expect(screen.queryByTestId('memory-search-submit')).toBeNull());
  });

  it('m5 模式切换器与子标签 chip 的选中态都有 Check 图标（双通道，不靠颜色独载）', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: [nomination({ id: 'f1', formationState: 'failed' })] }),
    );
    renderPage();
    await screen.findByTestId('memory-tabs');

    // 语义模式默认选中 ⇒ 有 Check；字面未选中 ⇒ 没有
    expect(screen.getByTestId('memory-search-mode-semantic').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('memory-search-mode-literal').querySelector('svg')).toBeNull();

    fireEvent.click(screen.getByTestId('memory-tab-nominations'));
    await screen.findByTestId('memory-formation-chips');
    // 「全部」默认选中 ⇒ 有 Check
    expect(screen.getByTestId('memory-formation-chip-all').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('memory-formation-chip-failed').querySelector('svg')).toBeNull();
    fireEvent.click(screen.getByTestId('memory-formation-chip-failed'));
    await waitFor(() =>
      expect(
        screen.getByTestId('memory-formation-chip-failed').querySelector('svg'),
      ).not.toBeNull(),
    );
  });

  it('A3 预置禁用：canReadContent=false 的项目 → 搜索框直接禁用 + 常驻说明（无需先打一次 403）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        // 账本行是 full 投影（不是"全 metadata"）⇒ 禁用只能来自项目级 canReadContent
        projects: [project({ canReadContent: false })],
        rows: [nomination()],
      }),
    );
    renderPage();
    await screen.findByTestId('memory-card');

    // 预置禁用：一次召回都还没发
    expect(recallCalls()).toHaveLength(0);
    expect(screen.getByTestId('memory-search-input')).toBeDisabled();
    expect(screen.getByTestId('memory-search-disabled-note')).toHaveTextContent(
      messages['memory.search.forbidden'],
    );
    // 下拉同时标出（数据驱动，且此刻**没有**任何 403 观测）
    expect(
      within(screen.getByTestId('memory-project-select')).getByText(
        `Chamber Main (chamber-main) · ${messages['memory.project.metadataOnlyBadge']}`,
      ),
    ).toBeInTheDocument();
  });

  it('A3 403 兜底仍生效：投影说可读（canReadContent=true），但召回 403 → 搜索禁用', async () => {
    mockRequest.mockImplementation((config: { method?: string; url?: string }) => {
      const method = (config.method ?? 'GET').toUpperCase();
      if (method === 'GET' && config.url === '/memory/projects') {
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
      if (method === 'GET' && config.url?.includes('/nominations')) {
        return Promise.resolve(envelope(listResponse([nomination()], 1)));
      }
      if (method === 'POST' && config.url?.includes('/recalls')) {
        return Promise.reject(httpError(403, 1009));
      }
      return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
    });
    renderPage();
    await screen.findByTestId('memory-card');

    // 预置态可搜索（投影 canReadContent=true）
    expect(screen.getByTestId('memory-search-input')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));

    // 403 通道把它关掉（兜底不可删）
    expect(await screen.findByTestId('memory-search-disabled-note')).toHaveTextContent(
      messages['memory.search.forbidden'],
    );
    expect(screen.getByTestId('memory-search-input')).toBeDisabled();
  });
});

/**
 * A1 召回评分展示（§1.6/§1.8 + C-3）。
 *
 * 三条守卫各有用例：**全同值**（零信息 → 主列表抑制）、**缺值**（旧后端 → 只抑制行尾，
 * 不隐藏整条召回结果，W-5）、**单调性**（分数按引擎给的顺序渲染）。调试区恒显原值（C-3）。
 */
describe('MemoryPage A1 召回评分展示', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({
      user: { id: 'u-1', email: 'u@x.io', name: 'U', role: 'editor' },
      isAuthenticated: true,
    });
  });

  /** 模拟"缺 score"的旧后端行（类型上 score 必填，故构造后删键） */
  function withoutScore(item: MemoryRecallItem): MemoryRecallItem {
    const copy: Partial<MemoryRecallItem> = { ...item };
    delete copy.score;
    return copy as MemoryRecallItem;
  }

  /** 提交一次语义搜索并等结果区出现 */
  async function runSemantic(recall: MemoryRecallResponse) {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()], recall }));
    renderPage();
    await screen.findByTestId('memory-card');
    fireEvent.change(screen.getByTestId('memory-search-input'), { target: { value: 'q' } });
    fireEvent.click(screen.getByTestId('memory-search-submit'));
    await screen.findByTestId('memory-recall-list');
  }

  it('C-3 全同值：主列表不渲染分数（零信息），但**钻取区恒显原值**', async () => {
    await runSemantic(
      recallResponse({
        recallId: 'r-uniform',
        items: [
          recallItem({ memoryId: 'm1', ledgerId: 'n1', subject: 'A', score: 5 }),
          recallItem({
            memoryId: 'm2',
            ledgerId: 'n2',
            subject: 'B',
            score: 5,
            resolution: 'chosen',
            kind: 'note',
          }),
        ],
      }),
    );

    // 主列表：全同值 ⇒ 一个行尾分数都不画（两条召回结果本身照常渲染）
    expect(screen.queryAllByTestId('memory-recall-score')).toHaveLength(0);
    expect(screen.getAllByTestId('memory-recall-item')).toHaveLength(2);

    // 钻取区：恒显原值（含全同值分布），且逐项行带 items[i]. 归属
    const debug = screen.getByTestId('memory-recall-debug');
    const debugRows = within(debug)
      .getAllByRole('listitem')
      .map((row) => row.textContent ?? '');
    expect(debugRows).toContain('items[0].score: 5');
    expect(debugRows).toContain('items[1].score: 5');
    // N3：域外值（canonical / chosen）**原样**显示，不做映射
    expect(debugRows).toContain('items[0].resolution: canonical');
    expect(debugRows).toContain('items[1].resolution: chosen');
    // 信封三件套仍在
    expect(debugRows).toContain('trustLevel: untrusted_advisory');
  });

  it('W-5 缺值：只不渲染行尾元素，**不隐藏整条召回结果**；调试区原值透传（undefined）', async () => {
    await runSemantic(
      recallResponse({
        recallId: 'r-missing',
        items: [
          recallItem({ memoryId: 'm1', ledgerId: 'n1', subject: 'Has score', score: 9 }),
          withoutScore(recallItem({ memoryId: 'm2', ledgerId: 'n2', subject: 'No score field' })),
        ],
      }),
    );

    // 任一条缺值 ⇒ 本次召回的分数不展示
    expect(screen.queryAllByTestId('memory-recall-score')).toHaveLength(0);
    // 但召回结果本身必须照常渲染（缺守卫只砍行尾，不砍条目）
    const items = screen.getAllByTestId('memory-recall-item');
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent('No score field');
    // 调试区如实显示缺失（排障要看到"真的没有这个字段"）
    const debugRows = within(screen.getByTestId('memory-recall-debug'))
      .getAllByRole('listitem')
      .map((row) => row.textContent ?? '');
    expect(debugRows).toContain('items[1].score: undefined');
    expect(debugRows).toContain('items[0].score: 9');
  });

  it('单调性：分数与条目顺序同源（**不按分数重排**，按引擎给的输入顺序渲染）', async () => {
    // m-2：fixture 刻意**乱序**（4 在前、9 在后）——若实现"按分数排序"，降序 fixture 会恒过
    // 而对"保序"与"重排"无法区分；乱序后"渲染顺序 == 输入顺序"才真正可证伪。
    await runSemantic(
      recallResponse({
        recallId: 'r-order',
        items: [
          recallItem({ memoryId: 'm1', ledgerId: 'n1', subject: 'First in input', score: 4 }),
          recallItem({ memoryId: 'm2', ledgerId: 'n2', subject: 'Second in input', score: 9 }),
        ],
      }),
    );

    const scoreNotes = screen.getAllByTestId('memory-recall-score');
    expect(scoreNotes[0]).toHaveTextContent('Relevance 4');
    expect(scoreNotes[1]).toHaveTextContent('Relevance 9');
    // 渲染顺序 == 输入顺序（前端不重排；顺序与分数都由引擎给出）
    const items = screen.getAllByTestId('memory-recall-item');
    expect(items[0]).toHaveTextContent('First in input');
    expect(items[1]).toHaveTextContent('Second in input');
    // orderNote 三件套（词面权重 / 仅同次可比 / 非置信度）
    expect(screen.getByTestId('memory-recall-order-note')).toHaveTextContent(
      messages['memory.search.orderNote'],
    );
  });
});

/**
 * A2 项目创建 Dialog（plan §2 全套契约 + N6 键盘动线）。
 *
 * 每个用例都自证"请求形态/错误分叉/时序"是契约（不是造出来的假数据）：
 * `POST /memory/projects` 的 body 形状、四种错误透传分叉、成功后的刷新+选中顺序。
 */
describe('MemoryPage A2 项目创建 Dialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
    rerenderPage = null;
    useAuthStore.setState({ user: null, isAuthenticated: false });
    useNotificationStore.setState({ toasts: [], alerts: [] });
  });

  /** 打开创建 Dialog（工具栏入口） */
  async function openDialog() {
    fireEvent.click(await screen.findByTestId('memory-project-create'));
    return screen.findByTestId('memory-create-submit');
  }

  /**
   * 填一份**可提交**的表单：name + slug + 选一条绑定并**点进列表**。
   *
   * 「选中目标」≠「已绑定」——多绑列表编辑器里必须显式"添加"才进 `bindings` 数组。
   */
  async function fillValidForm() {
    fireEvent.change(screen.getByTestId('memory-create-name'), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByTestId('memory-create-slug'), {
      target: { value: 'fresh-project' },
    });
    await addBinding(TOPIC_TARGET);
  }

  /**
   * 选定一个目标并点"添加"进列表（多绑编辑器的基本动作）。
   *
   * ⚠️ 必须**等目标下拉就绪**再改动：候选在加载/失败/空时该下拉是 `disabled`，
   * 而 jsdom 对 disabled 表单元素的 change 不触发 React onChange —— 不等就会静默丢改动
   * （实测：连续添加时后一次添加凭空消失，列表少一条）。
   */
  async function addBinding(targetId: string) {
    const select = screen.getByTestId('memory-create-target');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: targetId } });
    const add = screen.getByTestId('memory-create-binding-add');
    await waitFor(() => expect(add).not.toBeDisabled());
    fireEvent.click(add);
  }

  it('入口 + a11y：role=dialog / aria-labelledby / 打开聚焦首字段 / aria-haspopup（N6）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    const entry = await screen.findByTestId('memory-project-create');
    // 入口按钮：size=sm 对齐工具行 + 声明会开对话框
    expect(entry).toHaveAttribute('aria-haspopup', 'dialog');
    expect(entry.className).toContain('h-8');

    await openDialog();
    const panel = screen.getByRole('dialog');
    expect(panel).toHaveAttribute('aria-labelledby', 'memory-project-create-title');
    // 无 focus trap ⇒ **刻意不声明** aria-modal（假声明比不声明更糟）
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(screen.getByTestId('memory-create-name')).toHaveFocus();
  });

  it('字段顺序 name→slug→engine→bindings；slug **禁止静默自动填充**（不可撤销动作）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await openDialog();

    const order = [
      'memory-create-name',
      'memory-create-slug',
      'memory-create-engine',
      'memory-create-binding-type',
    ].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING = 后一个元素在前一个之后
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    // 打字只填名称：slug 不许被系统"猜"出来
    fireEvent.change(screen.getByTestId('memory-create-name'), { target: { value: 'My Project' } });
    expect(screen.getByTestId('memory-create-slug')).toHaveValue('');
  });

  it('slug 前端预校验：输入即行内红字 + aria-describedby；提交时聚焦第一个错误字段', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();

    // 输入即报错（不必等提交，也不被"绑定列表为空 ⇒ 提交禁用"挡住）
    fireEvent.change(screen.getByTestId('memory-create-slug'), { target: { value: 'Bad Slug!' } });
    const err = await screen.findByTestId('memory-create-slug-error');
    expect(err).toHaveTextContent(messages['memory.project.form.slugInvalid']);
    expect(screen.getByTestId('memory-create-slug')).toHaveAttribute(
      'aria-describedby',
      'memory-create-slug-hint memory-create-slug-error',
    );

    // 补齐其余字段（**绑定要真的进列表**，否则提交是禁用的）后提交
    // → 焦点落到第一个错误字段（slug），且不发请求
    fireEvent.change(screen.getByTestId('memory-create-name'), { target: { value: 'X' } });
    await addBinding(TOPIC_TARGET);
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    expect(screen.getByTestId('memory-create-slug')).toHaveFocus();
    expect(createCalls()).toHaveLength(0);
  });

  it('请求体形状：name/slug/bindings/engine（hument + 三键全缺 = 自助开通 ⇒ 不发送三键）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0].url).toBe('/memory/projects');
    expect(createCalls()[0].data).toEqual({
      name: 'Fresh',
      slug: 'fresh-project',
      bindings: [{ type: 'topic', id: TOPIC_TARGET }],
      engine: 'hument',
    });
  });

  it('多绑：绑定列表为空 ⇒ 提交禁用 + disabledNote；「选中目标」≠「已绑定」，必须点"添加"', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();

    fireEvent.change(screen.getByTestId('memory-create-name'), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByTestId('memory-create-slug'), {
      target: { value: 'fresh-project' },
    });
    // 空列表：不渲染列表区
    expect(screen.queryByTestId('memory-create-binding-list')).toBeNull();
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();
    expect(screen.getByTestId('memory-create-disabled-note')).toHaveTextContent(
      messages['memory.project.form.bindingEmpty'],
    );

    // 只在"待选"里选了一个目标 —— 还没进列表 ⇒ 依然不可提交（这是本用例的核心）
    fireEvent.change(screen.getByTestId('memory-create-target'), {
      target: { value: TOPIC_TARGET },
    });
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();

    // 点"添加" ⇒ 进列表 ⇒ 可提交
    fireEvent.click(screen.getByTestId('memory-create-binding-add'));
    expect(screen.getByTestId('memory-create-binding-list')).toBeInTheDocument();
    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(1);
    expect(screen.getByTestId('memory-create-submit')).not.toBeDisabled();
    // 添加后目标下拉清空回占位（便于连续添加同类型多个）+ 焦点留在目标下拉
    expect(screen.getByTestId('memory-create-target')).toHaveValue('');
    expect(screen.getByTestId('memory-create-target')).toHaveFocus();
  });

  it('多绑 payload：topic + board 两条 ⇒ bindings 两条且**保持添加顺序**', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: {
          topic: [{ id: TOPIC_TARGET, title: 'Topic One' }],
          board: [{ id: BOARD_TARGET, name: 'Board One' }],
        },
        createProject: project({ id: PROJECT_C, slug: 'fresh-project', name: 'Fresh' }),
      }),
    );
    renderPage();
    await openDialog();

    fireEvent.change(screen.getByTestId('memory-create-name'), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByTestId('memory-create-slug'), {
      target: { value: 'fresh-project' },
    });
    await addBinding(TOPIC_TARGET);
    // 切类型 → 待选目标清空（已选列表不受影响），再绑一个看板
    fireEvent.change(screen.getByTestId('memory-create-binding-type'), {
      target: { value: 'board' },
    });
    await addBinding(BOARD_TARGET);

    const rows = screen.getAllByTestId('memory-create-binding-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Topic One');
    expect(rows[1]).toHaveTextContent('Board One');
    expect(screen.getByTestId('memory-create-binding-count')).toHaveTextContent('2/20');

    fireEvent.click(screen.getByTestId('memory-create-submit'));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0].data).toEqual({
      name: 'Fresh',
      slug: 'fresh-project',
      // 顺序 = 添加顺序；只带 type+id（label 是界面用的，不许进 payload）
      bindings: [
        { type: 'topic', id: TOPIC_TARGET },
        { type: 'board', id: BOARD_TARGET },
      ],
      engine: 'hument',
    });
  });

  it('多绑 重复防护：同 type+id 再选一次 ⇒ 添加禁用 + 可见提示；列表仍 1 条（不做"添加后去重"）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();
    await addBinding(TOPIC_TARGET);
    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(1);

    // 再选同一个目标 ⇒ 重复
    fireEvent.change(screen.getByTestId('memory-create-target'), {
      target: { value: TOPIC_TARGET },
    });
    const add = screen.getByTestId('memory-create-binding-add');
    expect(add).toBeDisabled();
    expect(screen.getByTestId('memory-create-binding-duplicate')).toHaveTextContent(
      messages['memory.project.form.bindingDuplicate'],
    );
    // 硬点也不进（守卫在 handler 里，不只靠 disabled）
    fireEvent.click(add);
    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(1);
  });

  it('多绑 移除：删一条列表减一；删空 ⇒ 提交重新禁用 + 焦点回落到类型下拉', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: {
          topic: [
            { id: TOPIC_TARGET, title: 'Topic One' },
            { id: 'topic-2', title: 'Topic Two' },
          ],
        },
      }),
    );
    renderPage();
    await openDialog();
    fireEvent.change(screen.getByTestId('memory-create-name'), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByTestId('memory-create-slug'), {
      target: { value: 'fresh-project' },
    });
    await addBinding(TOPIC_TARGET);
    await addBinding('topic-2');
    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(2);

    // 删除按钮：type=button + 人话 aria-label（读屏能辨"删哪条"）
    const removeButtons = screen.getAllByTestId('memory-create-binding-remove');
    expect(removeButtons[0]).toHaveAttribute('type', 'button');
    expect(removeButtons[0]).toHaveAttribute(
      'aria-label',
      messages['memory.project.form.bindingRemove']
        .replace('{type}', messages['memory.project.form.bindingTypeTopic'])
        .replace('{name}', 'Topic One'),
    );

    // 删第一条 ⇒ 剩一条，焦点交给相邻行的移除按钮（焦点不丢）
    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(1);
    expect(screen.getByTestId('memory-create-binding-remove')).toHaveFocus();

    // 删空 ⇒ 提交重新禁用，焦点回落到类型下拉
    fireEvent.click(screen.getByTestId('memory-create-binding-remove'));
    expect(screen.queryByTestId('memory-create-binding-list')).toBeNull();
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();
    expect(screen.getByTestId('memory-create-binding-type')).toHaveFocus();
  });

  it('多绑 上限：到 20 条即禁用"添加" + 行内提示（后端 @ArrayMaxSize(20)）', async () => {
    const manyTopics = Array.from({ length: 21 }, (_, i) => ({
      id: `topic-${i}`,
      title: `Topic ${i}`,
    }));
    mockRequest.mockImplementation(
      makeRouter({ rows: [nomination()], bindingTargets: { topic: manyTopics } }),
    );
    renderPage();
    await openDialog();
    for (let i = 0; i < 20; i++) await addBinding(`topic-${i}`);

    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(20);
    expect(screen.getByTestId('memory-create-binding-max')).toHaveTextContent(
      messages['memory.project.form.bindingMaxReached'].replace('{max}', '20'),
    );
    // 到顶即禁添加：第 21 条选好了也加不进去
    fireEvent.change(screen.getByTestId('memory-create-target'), {
      target: { value: 'topic-20' },
    });
    expect(screen.getByTestId('memory-create-binding-add')).toBeDisabled();
    fireEvent.click(screen.getByTestId('memory-create-binding-add'));
    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(20);
  });

  // nit3 回归保护：重复防护判据是 type+id 联合——同 id 不同 type 必须允许
  it('多绑 边界：同 id 不同 type 允许添加（平台三件套同名的真实场景）', async () => {
    const SHARED = '55555555-5555-4555-8555-555555555555';
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: {
          topic: [{ id: SHARED, title: 'Agent Chamber' }],
          board: [{ id: SHARED, name: 'Agent Chamber' }],
        },
      }),
    );
    renderPage();
    await openDialog();

    await addBinding(SHARED); // topic
    fireEvent.change(screen.getByTestId('memory-create-binding-type'), {
      target: { value: 'board' },
    });
    await addBinding(SHARED); // board 同 id——不得被重复防护误杀

    expect(screen.getAllByTestId('memory-create-binding-row')).toHaveLength(2);
    // 两条移除按钮的 aria-label 靠类型区分（nit2：同名资源读屏可辨）
    const removes = screen.getAllByTestId('memory-create-binding-remove');
    expect(removes[0].getAttribute('aria-label')).not.toBe(removes[1].getAttribute('aria-label'));
  });

  it('N2 engine 默认条件化：provisioningAvailable=false ⇒ 默认 none；切 hument ⇒ 全空禁用（C-6）；补齐三键 ⇒ 可提交', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        provisioningAvailable: false,
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();

    expect(screen.getByTestId('memory-create-engine')).toHaveValue('none');

    fireEvent.change(screen.getByTestId('memory-create-engine'), { target: { value: 'hument' } });
    // 不可用态文案 + 高级区三键必填（缺一即提交禁用 + 可见原因）
    expect(screen.getByTestId('memory-create-provisioning-unavailable')).toHaveTextContent(
      messages['memory.project.form.provisioningUnavailable'],
    );
    await fillValidForm();
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();
    expect(screen.getByTestId('memory-create-disabled-note')).toHaveTextContent(
      messages['memory.project.form.engineTripleRequired'],
    );

    // 补全三键 ⇒ 可提交，且请求体带三键
    fireEvent.change(screen.getByTestId('memory-create-workspace'), { target: { value: 'ws-1' } });
    fireEvent.change(screen.getByTestId('memory-create-actor'), { target: { value: 'actor-1' } });
    fireEvent.change(screen.getByTestId('memory-create-credential'), {
      target: { value: 'ref-1' },
    });
    expect(screen.getByTestId('memory-create-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0].data).toEqual({
      name: 'Fresh',
      slug: 'fresh-project',
      bindings: [{ type: 'topic', id: TOPIC_TARGET }],
      engine: 'hument',
      engineWorkspaceId: 'ws-1',
      engineActorId: 'actor-1',
      engineCredentialRef: 'ref-1',
    });
  });

  it('M-1 部分填（自助开通**可用**）：只填 2 键 ⇒ 提交禁用（成因=部分填）；全空仍合法（主路径不受影响）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        provisioningAvailable: true,
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();

    // 全空 = 自助开通（合法主路径）：不被部分填的新守卫误伤
    expect(screen.getByTestId('memory-create-engine')).toHaveValue('hument');
    expect(screen.getByTestId('memory-create-submit')).not.toBeDisabled();

    // 只填 2 个键 ⇒ 部分填 ⇒ 后端必 400（normalizeEngineBinding 缺一即错）⇒ 前端必须禁用
    fireEvent.change(screen.getByTestId('memory-create-workspace'), { target: { value: 'ws-1' } });
    fireEvent.change(screen.getByTestId('memory-create-actor'), { target: { value: 'actor-1' } });
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();
    const note = screen.getByTestId('memory-create-disabled-note');
    expect(note).toHaveTextContent(messages['memory.project.form.engineTriplePartial']);
    // 成因文案不能是"自助开通不可用"（那是错误归因：本模式可用）
    expect(note).not.toHaveTextContent(messages['memory.project.form.engineTripleRequired']);

    // 禁用之外的入口（Enter）同样被校验挡住：一个请求都不发
    fireEvent.keyDown(screen.getByTestId('memory-create-name'), { key: 'Enter' });
    expect(createCalls()).toHaveLength(0);

    // 补齐第三个键 ⇒ 恢复可提交（且 payload 带三键）
    fireEvent.change(screen.getByTestId('memory-create-credential'), {
      target: { value: 'ref-1' },
    });
    expect(screen.getByTestId('memory-create-submit')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('memory-create-submit'));
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0].data).toEqual({
      name: 'Fresh',
      slug: 'fresh-project',
      bindings: [{ type: 'topic', id: TOPIC_TARGET }],
      engine: 'hument',
      engineWorkspaceId: 'ws-1',
      engineActorId: 'actor-1',
      engineCredentialRef: 'ref-1',
    });
  });

  it('M-1 部分填（自助开通**不可用**）：同样禁用，成因文案是"部分填"而非"缺一"', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        provisioningAvailable: false,
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();
    fireEvent.change(screen.getByTestId('memory-create-engine'), { target: { value: 'hument' } });
    await fillValidForm();

    // 只填 1 个键
    fireEvent.change(screen.getByTestId('memory-create-workspace'), { target: { value: 'ws-1' } });
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();
    expect(screen.getByTestId('memory-create-disabled-note')).toHaveTextContent(
      messages['memory.project.form.engineTriplePartial'],
    );
    fireEvent.keyDown(screen.getByTestId('memory-create-name'), { key: 'Enter' });
    expect(createCalls()).toHaveLength(0);
  });

  it('provisioning 可用 + hument ⇒ 自动注册文案 + slug 不可撤销常驻警示（非 title）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await openDialog();

    expect(screen.getByTestId('memory-create-engine')).toHaveValue('hument');
    expect(screen.getByTestId('memory-create-provisioning-auto')).toHaveTextContent(
      messages['memory.project.form.provisioningAuto'],
    );
    const warn = screen.getByTestId('memory-create-slug-irreversible');
    expect(warn).toHaveTextContent(messages['memory.project.form.slugIrreversible']);
    // 常驻警示是**可见文本**，不是 title 属性
    expect(warn).not.toHaveAttribute('title');
  });

  it('M-2 凭据引用行内预警与后端形态**逐字对齐**：sk_ / sk- / 大写 APIKEY 都当场提示（不等 400）', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await openDialog();

    const field = screen.getByTestId('memory-create-credential');
    expect(screen.queryByTestId('memory-create-credential-warning')).toBeNull();

    // 与后端 `/^(apikey|sk)[_-]/i` 同形态：下划线、连字符、大小写都要覆盖
    for (const value of ['sk_live_abc', 'sk-live-abc', 'APIKEY-xyz', 'apikey_xyz']) {
      fireEvent.change(field, { target: { value } });
      expect(screen.getByTestId('memory-create-credential-warning')).toHaveTextContent(
        messages['memory.project.form.credentialLooksReal'],
      );
    }
    // 正常引用名不预警（避免噪音）
    fireEvent.change(field, { target: { value: 'ref-fresh-project' } });
    expect(screen.queryByTestId('memory-create-credential-warning')).toBeNull();
  });

  it('目标下拉三态 · 空：说明"绑定同时是权限来源"', async () => {
    mockRequest.mockImplementation(makeRouter({ rows: [nomination()] }));
    renderPage();
    await openDialog();

    const empty = await screen.findByTestId('memory-create-target-empty');
    expect(empty).toHaveTextContent(messages['memory.project.form.targetEmpty']);
    expect(empty).toHaveTextContent(messages['memory.project.form.targetEmptyHint']);
    expect(screen.getByTestId('memory-create-target')).toBeDisabled();
    expect(screen.getByTestId('memory-create-target-cap-note')).toBeInTheDocument();
  });

  it('目标下拉三态 · 加载中：禁用 + 文案', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: [nomination()], bindingTargetsDeferred: true }),
    );
    renderPage();
    await openDialog();

    expect(screen.getByTestId('memory-create-target-loading')).toHaveTextContent(
      messages['memory.project.form.targetLoading'],
    );
    expect(screen.getByTestId('memory-create-target')).toBeDisabled();
  });

  it('目标下拉三态 · 失败：行内错误 + 重试真的重发', async () => {
    mockRequest.mockImplementation(
      makeRouter({ rows: [nomination()], bindingTargetsError: { status: 500, code: 9999 } }),
    );
    renderPage();
    await openDialog();

    await screen.findByTestId('memory-create-target-error');
    const before = topicCalls().length;
    fireEvent.click(screen.getByTestId('memory-create-target-retry'));
    await waitFor(() => expect(topicCalls().length).toBeGreaterThan(before));
  });

  it('m-3 切绑定类型：候选就绪后焦点落在目标下拉（disabled 期间 focus 是 no-op，须等候选）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: {
          topic: [{ id: TOPIC_TARGET, title: 'Topic One' }],
          board: [{ id: 'b1', name: 'Board One' }],
        },
      }),
    );
    renderPage();
    await openDialog();
    // 打开时焦点在首字段（不是目标下拉）
    expect(screen.getByTestId('memory-create-name')).toHaveFocus();

    fireEvent.change(screen.getByTestId('memory-create-binding-type'), {
      target: { value: 'board' },
    });
    // 切类型清空旧目标
    expect(screen.getByTestId('memory-create-target')).toHaveValue('');
    // 候选就绪后焦点落到目标下拉（旧实现直接 focus 在 loading 窗口静默失效）
    await waitFor(() => expect(screen.getByTestId('memory-create-target')).toHaveFocus());
  });

  it('键盘动线：Esc 关闭 / Enter 提交（N6）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
      }),
    );
    renderPage();
    await openDialog();

    // Esc 关闭（window 级监听）
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('memory-create-name')).toBeNull());

    // 重新打开 → Enter（表单 onSubmit 路径）真的提交
    await openDialog();
    await fillValidForm();
    fireEvent.keyDown(screen.getByTestId('memory-create-name'), { key: 'Enter' });
    await waitFor(() => expect(createCalls()).toHaveLength(1));
  });

  it('isPending 期间 Esc 不关（挂起创建 → 窗必须留着，错误态才有"保留已填值"可言）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createDeferred: true,
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(screen.getByTestId('memory-create-submit')).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    // 窗仍在
    expect(screen.getByTestId('memory-create-name')).toBeInTheDocument();
  });

  it('m-1 错误态禁止被动关窗（Esc/遮罩都不关，值不丢）；取消按钮仍可用（明确放弃）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createError: { status: 503, code: 14000, data: { reason: 'provisioning_timeout' } },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));
    await screen.findByTestId('memory-create-submit-error');

    // 错误态：Esc 不关（关窗=卸载=清空已填值，与 timeout 重试纪律矛盾）
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('memory-create-name')).toHaveValue('Fresh');
    expect(screen.getByTestId('memory-create-slug')).toHaveValue('fresh-project');

    // 遮罩点击同样不关（纯装饰层，aria-hidden，不在 Tab 序列）
    const backdrop = document.querySelector('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(screen.getByTestId('memory-create-name')).toBeInTheDocument();

    // 取消按钮是**明确意图**，保留可用
    expect(screen.getByTestId('memory-create-cancel')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('memory-create-cancel'));
    await waitFor(() => expect(screen.queryByTestId('memory-create-name')).toBeNull());
  });

  it('错误分叉 409/14002 → slug 红字（服务端 message 里的 GET 路径**不得透传**）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createError: {
          status: 409,
          code: 14002,
          message: "slug 'fresh-project' is already taken. GET /memory/projects?slug=... 已被占用",
        },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    const err = await screen.findByTestId('memory-create-slug-error');
    expect(err).toHaveTextContent(messages['memory.project.createError.slugTaken']);
    expect(err.textContent).not.toContain('GET');
  });

  it('错误分叉 400 有 data.errors → 表单形状错：绑定区红字 + 聚焦绑定区', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createError: {
          status: 400,
          code: 9000,
          data: { errors: ['bindings should not be empty'] },
        },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    const err = await screen.findByTestId('memory-create-target-field-error');
    expect(err).toHaveTextContent(messages['memory.project.form.bindingEmpty']);
    expect(screen.getByTestId('memory-create-target')).toHaveFocus();
  });

  it('错误分叉 400 指名字段 engineWorkspaceId → 人话 + 自动展开高级区（**字段名不上屏**）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createError: { status: 400, code: 9000, data: { field: 'engineWorkspaceId' } },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    const err = await screen.findByTestId('memory-create-engine-error');
    expect(err).toHaveTextContent(messages['memory.project.createError.engineField']);
    expect(err.textContent).not.toContain('engineWorkspaceId');
    expect(screen.getByTestId('memory-create-advanced')).toHaveAttribute('open');
  });

  it('错误分叉 400 无 errors 无 field → 语义错：目标下拉权限红字', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createError: { status: 400, code: 9000 },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    expect(await screen.findByTestId('memory-create-target-field-error')).toHaveTextContent(
      messages['memory.project.createError.targetForbidden'],
    );
  });

  it('M-2 KEY_SHAPED 形态 400（无 data.errors / 无 data.field）→ 权限红字之外**同时**展示服务端 message（真因不吞）', async () => {
    mockRequest.mockImplementation(
      makeRouter({
        rows: [nomination()],
        bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
        createError: {
          status: 400,
          code: 9000,
          message:
            'engineCredentialRef looks like a REAL credential (apikey_/sk_ prefix). It must be a ' +
            'non-secret reference NAME resolved by the engine side. 凭据引用不是机密',
        },
      }),
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    // 主文案仍是权限说明（C-2 的语义错分支）
    expect(await screen.findByTestId('memory-create-target-field-error')).toHaveTextContent(
      messages['memory.project.createError.targetForbidden'],
    );
    // 但真因（服务端 message，本形态下唯一线索）必须可见 —— 次级兜底
    const detail = screen.getByTestId('memory-create-submit-error-detail');
    expect(detail).toHaveTextContent('REAL credential');
  });

  // 503 四 reason 分叉（逐个独立用例，避免同测多渲染互相污染）
  const provisioningCases = [
    ['provisioning_unavailable', 'memory.project.createError.provisionUnavailable'],
    ['provisioning_timeout', 'memory.project.createError.provisionTimeout'],
    ['provisioning_conflict', 'memory.project.createError.provisionConflict'],
    ['provisioning_failed', 'memory.project.createError.provisionFailed'],
  ] as const;
  for (const [reason, key] of provisioningCases) {
    it(`错误分叉 503 · ${reason} → 针对性人话 + 保留已填值（timeout 不建议换 slug）`, async () => {
      mockRequest.mockImplementation(
        makeRouter({
          rows: [nomination()],
          bindingTargets: { topic: [{ id: TOPIC_TARGET, title: 'Topic One' }] },
          createError: { status: 503, code: 14000, data: { reason } },
        }),
      );
      renderPage();
      await openDialog();
      await fillValidForm();
      fireEvent.click(screen.getByTestId('memory-create-submit'));

      const box = await screen.findByTestId('memory-create-submit-error');
      expect(box).toHaveTextContent(messages[key]);
      // timeout 的重试纪律：保持 slug 与项目名不变 —— 绝不建议换 slug/换名
      if (reason === 'provisioning_timeout') {
        expect(messages[key]).not.toMatch(/another|Pick another|换一个/);
      }
      // 保留已填值（重试要沿用同一 slug/name）
      expect(screen.getByTestId('memory-create-name')).toHaveValue('Fresh');
      expect(screen.getByTestId('memory-create-slug')).toHaveValue('fresh-project');
      // 无幂等键 ⇒ mutation 不自动重发（只发了一次）
      expect(createCalls()).toHaveLength(1);
      // 服务端 message 作为次级兜底展示
      expect(screen.getByTestId('memory-create-submit-error-detail')).toBeInTheDocument();
    });
  }

  it('成功：toast.success + **先 await refetch 再选中**（新项目在选项里时才算选中）', async () => {
    let created = false;
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          const items = created
            ? [project(), project({ id: PROJECT_C, slug: 'fresh-project', name: 'Fresh' })]
            : [project()];
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
        if (method === 'POST' && config.url === '/memory/projects') {
          created = true;
          return Promise.resolve(
            envelope(project({ id: PROJECT_C, slug: 'fresh-project', name: 'Fresh' })),
          );
        }
        if (method === 'GET' && config.url === '/topics') {
          return Promise.resolve(
            envelope(pagedResponse([{ id: TOPIC_TARGET, title: 'Topic One' }])),
          );
        }
        if (method === 'GET' && config.url?.includes('/nominations')) {
          return Promise.resolve(envelope(listResponse([nomination()], 1)));
        }
        return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
      },
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    // 选中必须落在**新项目**上（先 refetch 才有这个 option —— 时序铁律）
    await waitFor(() => expect(screen.getByTestId('memory-project-select')).toHaveValue(PROJECT_C));
    expect(
      within(screen.getByTestId('memory-project-select')).getByText('Fresh (fresh-project)'),
    ).toBeInTheDocument();
    // Dialog 已关；名单被重新拉过
    expect(screen.queryByTestId('memory-create-name')).toBeNull();
    expect(projectsCalls().length).toBeGreaterThan(1);
    // toast.success 经 store 出（Toaster 未挂载，直接查 store）
    const toasts = useNotificationStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('success');
  });

  it('R-1/m-4 创建成功但名单刷新失败：toast 报错 + **直接关窗**（不留重复提交口）+ 不选中不存在的项目', async () => {
    let projectListCalls = 0;
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          projectListCalls += 1;
          // 首次成功渲染页面；创建后的那次 refetch 失败（m-4 的触发路径）
          if (projectListCalls > 1) return Promise.reject(httpError(500, 9999));
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
        if (method === 'POST' && config.url === '/memory/projects') {
          return Promise.resolve(
            envelope(project({ id: PROJECT_C, slug: 'fresh-project', name: 'Fresh' })),
          );
        }
        if (method === 'GET' && config.url === '/topics') {
          return Promise.resolve(
            envelope(pagedResponse([{ id: TOPIC_TARGET, title: 'Topic One' }])),
          );
        }
        if (method === 'GET' && config.url?.includes('/nominations')) {
          return Promise.resolve(envelope(listResponse([nomination()], 1)));
        }
        return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
      },
    );
    renderPage();
    await openDialog();
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    // 必须显式判 refetch 结果：v5 的 refetch 失败是 resolve，await 会照常往下走
    // （先出「已创建」成功 toast，再追加一条「刷新失败」错误 toast）
    await waitFor(() => {
      const toasts = useNotificationStore.getState().toasts;
      expect(
        toasts.some(
          (toast) =>
            toast.variant === 'error' &&
            toast.title === messages['memory.project.refreshFailedAfterCreate'],
        ),
      ).toBe(true);
    });
    // R-1：**直接关窗**——留窗只会把"重复创建（必 409 → 诱导换 slug）"变成唯一动作
    await waitFor(() => expect(screen.queryByTestId('memory-create-name')).toBeNull());
    // 没被选中成"列表里不存在的 id"（仍是原有的 PROJECT_A）
    expect(screen.getByTestId('memory-project-select')).toHaveValue(PROJECT_A);
    // 刷新失败但有旧数据：不把整页打成错误态（列表还在）
    expect(screen.queryByTestId('memory-projects-error')).toBeNull();
    expect(screen.getByTestId('memory-project-select')).toBeInTheDocument();
  });

  it('R-2 零项目用户：空态 CTA 建项目 → 201 但名单 refetch 失败 ⇒ 空态**不被整页错误态接管**', async () => {
    let projectListCalls = 0;
    mockRequest.mockImplementation(
      (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
        const method = (config.method ?? 'GET').toUpperCase();
        if (method === 'GET' && config.url === '/memory/projects') {
          projectListCalls += 1;
          // 首次成功但**零项目**（零项目用户的典型态）；创建后的 refetch 失败
          if (projectListCalls > 1) return Promise.reject(httpError(500, 9999));
          return Promise.resolve(
            envelope({
              items: [],
              total: 0,
              page: 1,
              pageSize: 100,
              provisioningAvailable: true,
            }),
          );
        }
        if (method === 'POST' && config.url === '/memory/projects') {
          return Promise.resolve(
            envelope(project({ id: PROJECT_C, slug: 'fresh-project', name: 'Fresh' })),
          );
        }
        if (method === 'GET' && config.url === '/topics') {
          return Promise.resolve(
            envelope(pagedResponse([{ id: TOPIC_TARGET, title: 'Topic One' }])),
          );
        }
        if (method === 'GET' && config.url?.includes('/nominations')) {
          return Promise.resolve(envelope(listResponse([], 0)));
        }
        return Promise.reject(new Error(`unexpected ${method} ${config.url}`));
      },
    );
    renderPage();

    // 空态入口（零项目用户的主路径）
    const empty = await screen.findByTestId('memory-projects-empty');
    fireEvent.click(within(empty).getByTestId('memory-project-create-empty'));
    await screen.findByTestId('memory-create-submit');
    await fillValidForm();
    fireEvent.click(screen.getByTestId('memory-create-submit'));

    await waitFor(() =>
      expect(
        useNotificationStore
          .getState()
          .toasts.some(
            (toast) =>
              toast.variant === 'error' &&
              toast.title === messages['memory.project.refreshFailedAfterCreate'],
          ),
      ).toBe(true),
    );
    // R-2：`isError && data={items:[]}` **不得**触发整页错误态（否则空态 CTA 整棵被卸载）
    expect(screen.queryByTestId('memory-projects-error')).toBeNull();
    expect(screen.getByTestId('memory-projects-empty')).toBeInTheDocument();
    expect(screen.getByTestId('memory-project-create-empty')).toBeInTheDocument();
  });
});
