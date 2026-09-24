/**
 * experiences/page.test.tsx — 经验库列表页契约测试
 *
 * 隔离策略（刻意与仓内其它页面测试不同，理由如下）：
 * 本文件**只 mock `axios`，不 mock `@/lib/api`**——列表页的数组参数序列化是后端契约的
 * 高危点（axios 默认方括号形态会被后端 400），mock 掉 Api 层就把"真实请求 URL 形态"
 * 一起 mock 掉了，测不到。故：mock axios 捕获请求配置 + 用真实 Api 命名空间，
 * 既能断言 UI 行为，又能断言 `signals=a&signals=b` 的实际形态。
 *
 * 覆盖：卡片流渲染（含信任信号）、搜索 300ms 防抖、intent/quality 过滤、空态（零命中
 * 是成功态）、`?quality=unverified` 直达、most_used 自报数据警示、录入 Dialog 提交
 * 载荷（signals 数组 + clientRequestId）、数组参数 URL 形态。
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExperiencesPage from './page';
import { axiosInstance, Api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import {
  ActorType,
  type ExperienceListResponse,
  type ExperienceFacetsResponse,
  type ExperienceSummary,
} from '@/types';
// v1.81.0：质量徽章释义的断言直接读**真实**语言包（手抄快照只能证明"接线对"，
// 证不了"上线产物里没有 admin 字样"——本批的核心文案约束恰恰是后者）
import enMessages from '@/i18n/messages/en.json';
import zhMessages from '@/i18n/messages/zh-CN.json';

/** 当前测试的 searchParams 初值（jest.mock 工厂只允许引用 mock* 前缀的外部变量） */
let mockSearchParamsString = '';

/** experiences + 组件用到的 common 文案快照（同 en.json；缺失的 key 回落为 key 名） */
const messages: Record<string, string> = {
  'experiences.title': 'Experience Base',
  'experiences.description': 'Battle-scarred notes shared across projects.',
  'experiences.record': 'Record experience',
  'experiences.searchPlaceholder': 'Search experiences...',
  'experiences.trustSignal': '{count} users found this helpful',
  'experiences.empty': 'No experiences found',
  'experiences.emptyDesc': 'Nothing matches the current filters.',
  'experiences.emptyHint': 'Zero hits is normal at this stage.',
  'experiences.listError': 'Failed to load experiences',
  'experiences.retry': 'Retry',
  'experiences.pagination': 'Page {page} / {totalPages} · {pageSize} per page · {total} total',
  'experiences.expired': 'Expired',
  'experiences.filter.all': 'All',
  'experiences.filter.countUnknown': '—',
  // v1.81.0：录入者筛选（标签 / 未就绪 / 截断提示）
  'experiences.filter.creator': 'Recorded by',
  'experiences.filter.creatorUnavailable':
    'Creator list is still loading (or failed to load) — filtering by creator is unavailable right now.',
  'experiences.filter.creatorTruncated':
    'Showing the top {count} creators by entry count — search for the rest, or open an entry to see who recorded it.',
  'experiences.card.createdAt': 'Recorded {time}',
  'experiences.creator.deletedHint':
    "This creator's account has been deleted — the name is kept from their profile.",
  'experiences.creator.orphanHint':
    "This creator's profile can no longer be resolved (maybe hard-deleted) — showing the first 8 characters of the ID.",
  'experiences.creator.type.human': 'Human',
  'experiences.creator.type.agent': 'Agent',
  'experiences.creator.type.system': 'System',
  'experiences.clearFilters': 'Clear all filters',
  'common.deleted': 'Deleted',
  'experiences.backToFirstPage': 'Back to page 1',
  'experiences.sort.recent': 'Recently updated',
  'experiences.sort.most_used': 'Most used',
  'experiences.sort.mostUsedNotice': 'Usage counts are self-reported and can be manipulated.',
  'experiences.intent.repair': 'Repair',
  'experiences.intent.pitfall': 'Pitfall',
  'experiences.intent.howto': 'How-to',
  'experiences.intent.optimize': 'Optimize',
  'experiences.intent.decision': 'Decision',
  'experiences.quality.unverified': 'Unverified',
  'experiences.quality.verified': 'Verified',
  'experiences.quality.suspect': 'Suspect',
  // 质量徽章释义：**直接取真实语言包**（不手抄）——本批的核心文案约束是"不再出现 admin"，
  // 手抄一份会让"渲染的是真实文案"与"文案本身合规"两件事都失去证明力
  'experiences.qualityHint.unverified': enMessages.experiences.qualityHint.unverified,
  'experiences.qualityHint.verified': enMessages.experiences.qualityHint.verified,
  'experiences.qualityHint.suspect': enMessages.experiences.qualityHint.suspect,
  'experiences.form.createTitle': 'Record an experience',
  'experiences.form.title': 'Title',
  'experiences.form.summary': 'Summary',
  'experiences.form.signals': 'Signals',
  'experiences.form.submitCreate': 'Record',
  'experiences.form.submitting': 'Saving...',
  'experiences.form.sectionSymptom': 'Symptom',
  'experiences.form.sectionRootCause': 'Root cause',
  'experiences.form.sectionFix': 'Fix',
  'experiences.form.sectionHowVerified': 'How verified',
  'experiences.form.chipEmpty': 'Type a keyword first',
  'experiences.form.chipComma': 'One keyword per chip — commas are not allowed',
  'experiences.form.chipTooLong': 'Each keyword can be at most 50 characters',
  'experiences.form.chipTooMany': 'At most {max} entries',
  'experiences.form.removeChip': 'Remove',
  // 第二期：机器初评（结果面板摘要块）
  'experiences.judgment.title': 'Machine pre-check (observation period) · reference only',
  'experiences.judgment.resultHint': 'Recorded successfully.',
  'experiences.judgment.dimension.completeness': 'Completeness',
  'experiences.judgment.dimension.signalQuality': 'Signal quality',
  'experiences.judgment.dimension.duplicate': 'Duplicate',
  'experiences.judgment.dimension.intentSuggestion': 'Type suggestion',
  'experiences.judgment.dimension.domainSuggestion': 'Domain suggestion',
  'experiences.judgment.level.missing': 'missing',
  'experiences.judgment.level.thin': 'thin',
  'experiences.judgment.level.noise': 'noise',
  'experiences.judgment.level.weak': 'weak',
  'experiences.judgment.verdict.possible_duplicate': 'possible duplicate',
  'experiences.judgment.verdict.likely_duplicate': 'likely duplicate',
  'experiences.judgment.verdict.suggested': 'suggested: {value}',
  // 第二期：成员入口与 Sheet（角色标签按 plan 钉死）
  'experiences.members.title': 'Experience space members',
  'experiences.members.owner': 'Space admin',
  'experiences.members.reviewer': 'Reviewer',
  'experiences.members.human': 'Human',
  'experiences.members.agent': 'Agent',
  'experiences.members.setOwner': 'Make space admin',
  'experiences.members.setReviewer': 'Make reviewer',
  'experiences.members.inviteFailed': '{succeeded} invited, {failed} failed',
  // MembersSheet 内部（members 命名空间；与 en.json 同源快照，仅用例用到的最小集）
  'members.invite': 'Invite',
  'members.back': 'Back',
  'members.searchMembers': 'Search members',
  'members.searchCandidates': 'Search agents',
  'members.emptyTitle': 'No members yet',
  'members.emptyDesc': 'Invite an agent to review entries.',
  'members.candidatesEmpty': 'No candidates',
  'members.selectedCount': '{count} selected',
  'members.agentSection': 'Agents',
  'members.menuAria': 'Member actions',
  'members.remove': 'Remove',
  'members.removeConfirmTitle': 'Remove member?',
  'members.removeConfirmDesc': 'They lose review rights immediately.',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
};

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string, params?: Record<string, string | number>) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    let text = messages[fullKey] ?? fullKey;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{${k}}`).join(String(v));
      }
    }
    return text;
  },
}));

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

/**
 * axios 层 mock：`api.ts` 在模块加载时调用 `axios.create(...)`，故工厂必须返回一个
 * 带 `interceptors.{request,response}.use` 与 `request` 的实例；`request` 是捕获点。
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

/** 录入者 fixture 用 UUID（`?createdById=` 直达要求 UUID 形态——脏值会被前端拦下） */
const CREATOR_A = 'a1b2c3d4-0000-4000-8000-000000000001';
const CREATOR_B = 'a1b2c3d4-0000-4000-8000-000000000002';

/** 列表条目 fixture（ExperienceSummary 全字段） */
function entry(overrides: Partial<ExperienceSummary> = {}): ExperienceSummary {
  return {
    id: 'e1',
    title: 'Docker port forwarding fails on WSL2',
    summary: 'Published port unreachable from the Windows host.',
    intent: 'repair',
    quality: 'unverified',
    signals: ['port-unreachable'],
    domains: ['devops'],
    env: { os: 'wsl2' },
    helpedCount: 0,
    notHelpfulCount: 0,
    distinctHelpedCount: 3,
    lastHelpedAt: null,
    sourceProject: 'agent-chamber',
    expiresAt: null,
    expired: false,
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-21T00:00:00Z',
    // v1.81.0 归属三件套：缺省给"活态"，三态用例各自覆盖所需字段
    createdById: CREATOR_A,
    createdByType: ActorType.AGENT,
    createdByName: 'Agent One',
    ...overrides,
  };
}

const FACETS: ExperienceFacetsResponse = {
  total: 2,
  byIntent: { pitfall: 0, repair: 2, howto: 0, optimize: 0, decision: 0 },
  byQuality: { unverified: 1, verified: 1, suspect: 0 },
  availableDomains: ['devops', 'testing'],
  // v1.81.0：录入者候选（含一条软删，覆盖下拉的删除标记分支）
  byCreator: [
    {
      createdById: CREATOR_A,
      createdByType: ActorType.AGENT,
      createdByName: 'Agent One',
      createdByDeletedAt: null,
      count: 2,
    },
    {
      createdById: CREATOR_B,
      createdByType: ActorType.HUMAN,
      createdByName: 'Bob',
      createdByDeletedAt: '2026-08-01T00:00:00Z',
      count: 1,
    },
  ],
};

/** 按 method+url 分派应答（未注册的组合直接抛错——避免"静默空响应"掩盖接线错误） */
function route(handlers: {
  list?: ExperienceListResponse;
  /** 按请求参数动态出列表响应（分页相关用例） */
  listFor?: (params: Record<string, unknown>) => ExperienceListResponse;
  facets?: ExperienceFacetsResponse;
  /** facets 失败（v1.81.0：录入者候选不可信 → 下拉禁用） */
  facetsError?: { status: number; message: string };
  create?: unknown;
  members?: { items: unknown[] };
  membersError?: { status: number; message: string };
  addMember?: unknown;
  agents?: { id: string; name: string; status?: string; avatarUrl?: string | null }[];
}) {
  mockRequest.mockImplementation(
    (config: { method?: string; url?: string; params?: Record<string, unknown> }) => {
      const method = (config.method ?? 'GET').toUpperCase();
      if (method === 'GET' && config.url === '/experiences') {
        // listFor：按请求参数动态出响应（分页/参数相关用例用）
        if (handlers.listFor)
          return Promise.resolve(envelope(handlers.listFor(config.params ?? {})));
        return Promise.resolve(
          envelope(handlers.list ?? { items: [], total: 0, page: 1, pageSize: 20 }),
        );
      }
      if (method === 'GET' && config.url === '/experiences/facets') {
        if (handlers.facetsError) {
          return Promise.reject({
            response: {
              status: handlers.facetsError.status,
              data: { message: handlers.facetsError.message },
            },
          });
        }
        return Promise.resolve(envelope(handlers.facets ?? FACETS));
      }
      if (method === 'POST' && config.url === '/experiences') {
        return Promise.resolve(envelope(handlers.create ?? { id: 'new1', quality: 'unverified' }));
      }
      // 第二期：空间成员四端点（入口仅 admin，用例覆盖权限门与默认角色）
      if (method === 'GET' && config.url === '/experiences/members') {
        if (handlers.membersError) {
          return Promise.reject({
            response: {
              status: handlers.membersError.status,
              data: { message: handlers.membersError.message },
            },
          });
        }
        return Promise.resolve(envelope(handlers.members ?? { items: [] }));
      }
      if (method === 'GET' && config.url === '/agents') {
        return Promise.resolve(
          envelope({ items: handlers.agents ?? [], total: 0, page: 1, pageSize: 100 }),
        );
      }
      if (method === 'POST' && config.url === '/experiences/members') {
        return Promise.resolve(
          envelope(handlers.addMember ?? { actorId: 'a1', role: 'reviewer', invitedBy: 'u1' }),
        );
      }
      if (method === 'PATCH' && String(config.url).startsWith('/experiences/members/')) {
        return Promise.resolve(envelope({ actorId: 'a1', role: 'owner', invitedBy: 'u1' }));
      }
      if (method === 'DELETE' && String(config.url).startsWith('/experiences/members/')) {
        return Promise.resolve(envelope({ deleted: true, actorId: 'a1' }));
      }
      return Promise.reject(new Error(`unexpected request: ${method} ${config.url}`));
    },
  );
}

/** 取最后一次 / 全部 list 请求的 config */
function listCalls() {
  return mockRequest.mock.calls
    .map((c) => c[0] as { method?: string; url?: string; params?: Record<string, unknown> })
    .filter((c) => (c.method ?? 'GET').toUpperCase() === 'GET' && c.url === '/experiences');
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ExperiencesPage />
    </QueryClientProvider>,
  );
}

describe('ExperiencesPage 列表', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  it('渲染卡片流：标题 / 摘要 / 类型 / 质量 / 领域 / 信任信号', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const card = await screen.findByTestId('experience-card');
    expect(within(card).getByText('Docker port forwarding fails on WSL2')).toBeInTheDocument();
    expect(
      within(card).getByText('Published port unreachable from the Windows host.'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Repair')).toBeInTheDocument();
    expect(within(card).getByText('Unverified')).toBeInTheDocument();
    expect(within(card).getByText('devops')).toBeInTheDocument();
    // 信任信号 = distinctHelpedCount（去重有效命中数）
    expect(within(card).getByTestId('experience-card-trust')).toHaveTextContent(
      '3 users found this helpful',
    );
  });

  it('搜索防抖：输入后 300ms 才发起带 q 的请求', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();
    await screen.findByTestId('experience-card');

    fireEvent.change(screen.getByTestId('experience-search-input'), {
      target: { value: 'port' },
    });

    // 防抖窗口内不应有带 q 的请求（初次挂载的 q='' 请求不算）
    expect(listCalls().some((c) => c.params?.q === 'port')).toBe(false);
    await waitFor(() => expect(listCalls().some((c) => c.params?.q === 'port')).toBe(true));
  });

  it('intent / quality 过滤：选择后请求携带对应参数并回到第 1 页', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();
    await screen.findByTestId('experience-card');

    fireEvent.change(screen.getByTestId('experience-intent-filter'), {
      target: { value: 'pitfall' },
    });
    await waitFor(() => expect(listCalls().some((c) => c.params?.intent === 'pitfall')).toBe(true));

    fireEvent.change(screen.getByTestId('experience-quality-filter'), {
      target: { value: 'verified' },
    });
    await waitFor(() =>
      expect(
        listCalls().some((c) => c.params?.quality === 'verified' && c.params?.page === 1),
      ).toBe(true),
    );
  });

  it('零命中：空态 + 后端 hint 引导，不渲染错误态', async () => {
    route({
      list: { items: [], total: 0, page: 1, pageSize: 20, hint: 'No prior experience matched.' },
    });
    renderPage();

    expect(await screen.findByText('No experiences found')).toBeInTheDocument();
    expect(screen.getByTestId('experience-empty-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('experience-error')).toBeNull();
  });

  it('?quality=unverified 直达：初始化过滤态并随首次请求发出', async () => {
    mockSearchParamsString = 'quality=unverified';
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    await screen.findByTestId('experience-card');
    expect(listCalls().some((c) => c.params?.quality === 'unverified')).toBe(true);
    expect(screen.getByTestId('experience-quality-filter')).toHaveValue('unverified');
  });

  it('most_used 排序：展示「自报数据可操纵」警示', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();
    await screen.findByTestId('experience-card');

    expect(screen.queryByTestId('experience-most-used-notice')).toBeNull();
    fireEvent.change(screen.getByTestId('experience-sort-filter'), {
      target: { value: 'most_used' },
    });

    expect(await screen.findByTestId('experience-most-used-notice')).toBeInTheDocument();
    await waitFor(() => expect(listCalls().some((c) => c.params?.sort === 'most_used')).toBe(true));
  });

  it('录入 Dialog：提交载荷含 signals 数组与幂等键，成功后回到列表', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      create: { id: 'new1', quality: 'unverified' },
    });
    renderPage();
    await screen.findByTestId('experience-card');

    fireEvent.click(screen.getByTestId('experience-record-button'));
    expect(await screen.findByText('Record an experience')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('experience-form-title'), {
      target: { value: 'Port mapping lost' },
    });
    fireEvent.change(screen.getByTestId('experience-form-summary'), {
      target: { value: 'Port unreachable after reboot.' },
    });
    // signals 是必填：回车成 chip（逗号形态被就地拦下，见 lib/experience 单测）
    fireEvent.change(screen.getByTestId('experience-form-signals'), {
      target: { value: 'ECONNREFUSED' },
    });
    fireEvent.keyDown(screen.getByTestId('experience-form-signals'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('experience-form-submit'));

    await waitFor(() => {
      const post = mockRequest.mock.calls.find(
        (c) => (c[0] as { method?: string }).method === 'POST',
      );
      expect(post).toBeTruthy();
      const payload = (post![0] as { data: Record<string, unknown> }).data;
      // 数组保持数组（不逗号拼接）；chip 已归一化为小写
      expect(payload.signals).toEqual(['econnrefused']);
      expect(typeof payload.clientRequestId).toBe('string');
      expect(payload.clientRequestId).not.toBe('');
      // 四节模板预填：content 非空且含验证方式节（后端软告警不会误触发）
      expect(String(payload.content)).toContain('## How verified');
    });
  });
});

describe('ExperiencesPage 数组参数 URL 形态（后端契约红线）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  it('signals/domains 经 Api 层序列化为重复键（signals=a&signals=b）', async () => {
    route({ list: { items: [], total: 0, page: 1, pageSize: 20 } });

    await Api.experiences.list({ signals: ['a', 'b'], domains: ['devops'] });

    const config = listCalls().at(-1) as unknown as {
      params: Record<string, unknown>;
      paramsSerializer: (p: Record<string, unknown>) => string;
    };
    // params 里是数组（不是逗号串），序列化器产出重复键形态
    expect(config.params.signals).toEqual(['a', 'b']);
    expect(config.paramsSerializer(config.params)).toBe('signals=a&signals=b&domains=devops');
  });
});

/**
 * 录入收口与失效范围（评审 B2 / M1）。
 *
 * B2：落库成功即收口（刷新 + toast），**不依赖结果面板被关闭**——用户经遮罩关窗也
 * 必须已完成刷新（此前 onSaved 只在面板关闭按钮里调，遮罩关闭即丢失）。
 * M1：onSaved 失效 `['experiences']` 前缀 → 挂载中的 list 立即重新请求（只 refetch
 * 列表不够：分面计数与 sidebar 待终审角标会陈旧到 staleTime 过期为止）。
 */
describe('ExperiencesPage 录入收口与失效范围（B2 / M1）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  /** 填写最小可提交表单（signals 必填） */
  function fillMinimalForm() {
    fireEvent.change(screen.getByTestId('experience-form-title'), {
      target: { value: 'Port mapping lost' },
    });
    fireEvent.change(screen.getByTestId('experience-form-summary'), {
      target: { value: 'Port unreachable after reboot.' },
    });
    fireEvent.change(screen.getByTestId('experience-form-signals'), {
      target: { value: 'econnrefused' },
    });
    fireEvent.keyDown(screen.getByTestId('experience-form-signals'), { key: 'Enter' });
  }

  it('有软提示：结果面板显示 warnings/possibleDuplicates，且此时 list 已重新请求（B2）', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      create: {
        id: 'new1',
        quality: 'unverified',
        warnings: ['content does not appear to contain a "How verified" section'],
        possibleDuplicates: [{ id: 'e9', title: 'Similar entry', quality: 'verified' }],
      },
    });
    renderPage();
    await screen.findByTestId('experience-card');
    const listCallsBefore = listCalls().length;

    fireEvent.click(screen.getByTestId('experience-record-button'));
    await screen.findByTestId('experience-form-title');
    fillMinimalForm();
    fireEvent.click(screen.getByTestId('experience-form-submit'));

    // 软提示可见（不阻断；条已落库）
    const panel = await screen.findByTestId('experience-form-result');
    expect(within(panel).getByText('Similar entry')).toBeInTheDocument();
    // 收口已完成：list 被失效并重新请求（面板还开着，刷新也已发生）
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listCallsBefore));
  });

  it('仅有机器初评（无 warnings/duplicates）：也切结果面板并展示软提示摘要（第二期扩展）', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      create: {
        id: 'new1',
        quality: 'unverified',
        judgment: {
          provider: 'jev',
          model: 'jev-latest',
          judgedAt: '2026-09-22T10:00:00Z',
          completeness: { level: 'thin', confidence: 0.85 },
          reusability: null,
          signalQuality: { level: 'noise', confidence: 0.66 },
          duplicate: { verdict: 'possible_duplicate', confidence: 0.4 },
          intentSuggestion: { verdict: 'suggested', value: 'pitfall', confidence: 0.6 },
          domainSuggestion: { verdict: 'none_fits', value: null, confidence: 0.5 },
        },
      },
    });
    renderPage();
    await screen.findByTestId('experience-card');

    fireEvent.click(screen.getByTestId('experience-record-button'));
    await screen.findByTestId('experience-form-title');
    fillMinimalForm();
    fireEvent.click(screen.getByTestId('experience-form-submit'));

    const panel = await screen.findByTestId('experience-form-result');
    // 只列"可行动"的软提示：低分维度 + 归类建议（完整/良好的维度不占版面）
    expect(within(panel).getByTestId('experience-result-judgment-completeness')).toHaveTextContent(
      'thin',
    );
    expect(within(panel).getByTestId('experience-result-judgment-signal')).toHaveTextContent(
      'noise',
    );
    expect(within(panel).getByTestId('experience-result-judgment-duplicate')).toHaveTextContent(
      'possible duplicate',
    );
    expect(within(panel).getByTestId('experience-result-judgment-intent')).toHaveTextContent(
      'suggested: pitfall',
    );
    // 仅供参考的纪律文案必须在（软提示不阻断录入）
    expect(panel).toHaveTextContent('Recorded successfully.');
  });

  it('机器初评全为 null 维度：结果面板照常切换但不崩（无摘要行）', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      create: {
        id: 'new1',
        quality: 'unverified',
        judgment: {
          provider: 'jev',
          model: 'jev-latest',
          judgedAt: '2026-09-22T10:00:00Z',
          completeness: null,
          reusability: null,
          signalQuality: null,
          duplicate: null,
          intentSuggestion: null,
          domainSuggestion: null,
        },
      },
    });
    renderPage();
    await screen.findByTestId('experience-card');

    fireEvent.click(screen.getByTestId('experience-record-button'));
    await screen.findByTestId('experience-form-title');
    fillMinimalForm();
    fireEvent.click(screen.getByTestId('experience-form-submit'));

    const panel = await screen.findByTestId('experience-form-result');
    expect(within(panel).queryByTestId('experience-result-judgment-completeness')).toBeNull();
    expect(within(panel).queryByTestId('experience-result-judgment-signal')).toBeNull();
    expect(panel).toHaveTextContent('Machine pre-check');
  });

  it('无软提示：直接收口并刷新列表（M1 前缀失效）', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      create: { id: 'new1', quality: 'unverified' },
    });
    renderPage();
    await screen.findByTestId('experience-card');
    const listCallsBefore = listCalls().length;

    fireEvent.click(screen.getByTestId('experience-record-button'));
    await screen.findByTestId('experience-form-title');
    fillMinimalForm();
    fireEvent.click(screen.getByTestId('experience-form-submit'));

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listCallsBefore));
    // 无软提示 → 不进入结果面板
    expect(screen.queryByTestId('experience-form-result')).toBeNull();
  });
});

/**
 * 分面计数口径（评审 M2）。
 *
 * facets 与列表同一 baseQuery（默认排除 suspect）⇒ `byQuality.suspect` 结构性恒 0；
 * 真实可疑数是 admin 专属 `suspectCount`。非 admin 无该键 → 显示占位符（不能用假 0，
 * 0 会被读成"没有可疑条目"）。
 */
describe('ExperiencesPage quality 分面计数（M2）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('admin：suspect 取 suspectCount，其余取 byQuality', async () => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'U', role: 'admin' },
      isAuthenticated: true,
    });
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      facets: { ...FACETS, suspectCount: 4 },
    });
    renderPage();

    const select = await screen.findByTestId('experience-quality-filter');
    // facets 是异步的：等计数到位再断言（否则读到的是加载中的 0）
    await waitFor(() => expect(within(select).getByText('Suspect (4)')).toBeInTheDocument());
    expect(within(select).getByText('Verified (1)')).toBeInTheDocument();
    expect(within(select).getByText('Unverified (1)')).toBeInTheDocument();
  });

  it('非 admin：无 suspectCount → 占位符而非假 0', async () => {
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'U', role: 'editor' },
      isAuthenticated: true,
    });
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const select = await screen.findByTestId('experience-quality-filter');
    await waitFor(() => expect(within(select).getByText('Verified (1)')).toBeInTheDocument());
    expect(within(select).getByText('Suspect (—)')).toBeInTheDocument();
  });
});

/** searchParams 白名单（评审 minor 6）与空页退路（评审 minor 11） */
describe('ExperiencesPage searchParams 校验与空页退路（minor 6 / 11）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  it('非法过滤参数回落缺省：不发该参数，下拉停在「全部」', async () => {
    mockSearchParamsString = 'quality=bogus&intent=nope&sort=weird';
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    await screen.findByTestId('experience-card');
    const params = listCalls().at(-1)!.params!;
    expect(params.quality).toBeUndefined();
    expect(params.intent).toBeUndefined();
    // sort 回落缺省 recent（后端 @IsIn 白名单，脏值会 400）
    expect(params.sort).toBe('recent');
    expect(screen.getByTestId('experience-quality-filter')).toHaveValue('');
    expect(screen.getByTestId('experience-sort-filter')).toHaveValue('recent');
  });

  it('第 N 页空掉时提供「回到第 1 页」出口', async () => {
    route({
      listFor: (params) =>
        params.page === 2
          ? { items: [], total: 25, page: 2, pageSize: 20 }
          : { items: [entry()], total: 25, page: 1, pageSize: 20 },
    });
    renderPage();
    await screen.findByTestId('experience-card');

    fireEvent.click(screen.getByTestId('experience-next-page'));
    const back = await screen.findByTestId('experience-back-to-first-page');

    fireEvent.click(back);
    await waitFor(() => expect(listCalls().at(-1)!.params!.page).toBe(1));
  });

  /**
   * 空间成员入口与接线（第二期 plan §6）。
   *
   * 覆盖：入口 admin 权限门（非 admin 不渲染且**不发**成员请求）；邀请默认 role=reviewer；
   * 行内改角色 → PATCH。成员组件自身的行为（搜索/选择/capabilities 显隐）已在
   * components/members/members-sheet.spec.tsx 覆盖，本处只测**经验库调用方的接线**。
   */
  describe('ExperiencesPage 成员入口（第二期）', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockSearchParamsString = '';
    });

    afterEach(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });

    function signIn(role: 'admin' | 'editor') {
      useAuthStore.setState({
        user: { id: 'u1', email: 'u@x.io', name: 'U', role },
        isAuthenticated: true,
      });
    }

    /** 取某 method+url 的全部请求 */
    function callsTo(method: string, url: string) {
      return mockRequest.mock.calls
        .map((c) => c[0] as { method?: string; url?: string; data?: Record<string, unknown> })
        .filter((c) => (c.method ?? 'GET').toUpperCase() === method && c.url === url);
    }

    it('入口仅 admin 可见；非 admin 不渲染按钮且**不发**成员请求', async () => {
      signIn('editor');
      route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
      renderPage();

      await screen.findByTestId('experience-card');
      expect(screen.queryByTestId('experience-members-button')).toBeNull();
      // 非 admin 连成员清单都不拉（enabled 门；服务端另有闸门，web 只决定给不给入口）
      expect(callsTo('GET', '/experiences/members')).toHaveLength(0);
    });

    it('admin：打开成员 Sheet → 邀请默认 role=reviewer；行内改角色 → PATCH 新角色', async () => {
      signIn('admin');
      route({
        list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
        members: {
          items: [
            {
              actorId: 'a1',
              actorType: 'agent',
              actorName: 'Agent One',
              avatarUrl: null,
              deletedAt: null,
              role: 'reviewer',
              invitedBy: 'u1',
              createdAt: '2026-09-22T00:00:00Z',
            },
          ],
        },
        agents: [{ id: 'a2', name: 'Agent Two', status: 'active' }],
      });
      renderPage();

      fireEvent.click(await screen.findByTestId('experience-members-button'));
      // 成员行来自 GET /experiences/members（actorName 由服务端档案解析填充）
      expect(await screen.findByTestId('member-row-a1')).toBeInTheDocument();

      // 邀请：进入二级视图 → 选候选 → 提交（默认 reviewer）
      fireEvent.click(screen.getByTestId('open-invite'));
      fireEvent.click(await screen.findByTestId('invite-candidate-a2'));
      fireEvent.click(screen.getByTestId('invite-submit'));
      await waitFor(() => expect(callsTo('POST', '/experiences/members')).toHaveLength(1));
      expect(callsTo('POST', '/experiences/members')[0].data).toEqual({
        actorId: 'a2',
        role: 'reviewer',
      });

      // 行内改角色：reviewer 行 → 菜单「Make space admin」→ PATCH
      fireEvent.click(screen.getByTestId('member-menu-a1'));
      fireEvent.click(within(screen.getByTestId('row-menu')).getByText('Make space admin'));
      await waitFor(() => expect(callsTo('PATCH', '/experiences/members/a1')).toHaveLength(1));
      expect(callsTo('PATCH', '/experiences/members/a1')[0].data).toEqual({ role: 'owner' });
    });
  });
});

/**
 * 卡片归属元信息行（v1.81.0）：录入者三态 + 带标签相对时间。
 *
 * 三态规则唯一实现在 `lib/experience` 的 `experienceActorLabel`，卡片/详情/下拉共用；
 * 本组用例钉的是**渲染结果**（谁能看到什么、title 里有没有可排查的完整 UUID），
 * 而不是函数返回值——规则对不对要在消费面看。
 */
describe('ExperiencesPage 卡片归属元信息行（v1.81.0）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  it('活态：名字 + 类型小字 + 带标签时间（datetime / aria-label 双通道）', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const row = await screen.findByTestId('experience-card-creator');
    expect(within(row).getByTestId('experience-card-creator-name')).toHaveTextContent('Agent One');
    // 类型用文字表达（xs 头像不显示 Bot 角标，避免与角标重复）
    expect(within(row).getByText('Agent')).toBeInTheDocument();
    expect(within(row).queryByTestId('experience-card-creator-deleted')).toBeNull();

    const time = within(row).getByTestId('experience-card-created-at');
    expect(time).toHaveTextContent('Recorded');
    // 机器可读通道：datetime = 原始时间戳；aria-label = 绝对时间（相对时间对读屏是噪音）
    expect(time).toHaveAttribute('datetime', '2026-09-20T00:00:00Z');
    expect(time.getAttribute('aria-label')).toMatch(/2026/);
  });

  it('元信息行排在信任行**之前**（归属是可信度的上游判据）', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const card = await screen.findByTestId('experience-card');
    const creator = within(card).getByTestId('experience-card-creator');
    const trust = within(card).getByTestId('experience-card-trust');
    expect(creator.compareDocumentPosition(trust) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('软删态：真名保留（不换兜底词）+ 「已删除」标记 + 头像灰化', async () => {
    route({
      list: {
        items: [entry({ createdByName: 'Bob', createdByDeletedAt: '2026-08-01T00:00:00Z' })],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    renderPage();

    const row = await screen.findByTestId('experience-card-creator');
    const name = within(row).getByTestId('experience-card-creator-name');
    expect(name.textContent).toBe('Bob');
    expect(name).toHaveAttribute('title', CREATOR_A);
    expect(within(row).getByTestId('experience-card-creator-deleted')).toHaveAttribute(
      'title',
      messages['experiences.creator.deletedHint'],
    );
    expect(
      within(row).getByTestId('experience-card-creator-avatar').querySelector('.grayscale'),
    ).not.toBeNull();
  });

  it('孤儿态（name null）：显示 id 前 8 位、不加兜底词，title 保留完整 UUID', async () => {
    route({
      list: { items: [entry({ createdByName: null })], total: 1, page: 1, pageSize: 20 },
    });
    renderPage();

    const row = await screen.findByTestId('experience-card-creator');
    const name = within(row).getByTestId('experience-card-creator-name');
    expect(name.textContent).toBe(CREATOR_A.slice(0, 8));
    expect(name).toHaveAttribute('title', CREATOR_A);
    // 孤儿 ≠ 软删：不显示删除标记（它是"档案解析不到"，不是"人没了"）
    expect(within(row).queryByTestId('experience-card-creator-deleted')).toBeNull();
    // 解释挂头像：名字元素的 title 恒留给完整 UUID（唯一排查通道，任何态都不让位）
    expect(within(row).getByTestId('experience-card-creator-avatar')).toHaveAttribute(
      'title',
      messages['experiences.creator.orphanHint'],
    );
  });

  it('id 与 name 双缺失：整行不渲染（不摆空行）', async () => {
    route({
      list: {
        items: [
          entry({ createdById: undefined, createdByName: undefined, createdByType: undefined }),
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    renderPage();

    await screen.findByTestId('experience-card');
    expect(screen.queryByTestId('experience-card-creator')).toBeNull();
  });
});

/**
 * 录入者筛选（v1.81.0 第 6 控件）。
 *
 * 覆盖三条产品要求：选项源 = facets.byCreator（含软删标记）、已选值**强制并入选项**
 * （受控 select 空值防线）、facets 不可用时禁用 + 提示。
 */
describe('ExperiencesPage 录入者筛选（v1.81.0）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  it('下拉选项来自 facets.byCreator：名字 + 计数 + 软删标记，且 testid/aria-label 成对', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const select = await screen.findByTestId('experience-creator-filter');
    expect(select).toHaveAttribute('aria-label', 'Recorded by');
    await waitFor(() => expect(within(select).getByText('Agent One (2)')).toBeInTheDocument());
    // option 里没有 title，删除标记只能是文本（卡片是灰化+title，下拉必须显式写出来）
    expect(within(select).getByText('Bob · Deleted (1)')).toBeInTheDocument();
  });

  it('选中后请求带 createdById 并回到第 1 页', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const select = await screen.findByTestId('experience-creator-filter');
    await waitFor(() => expect(within(select).getByText('Agent One (2)')).toBeInTheDocument());

    fireEvent.change(select, { target: { value: CREATOR_B } });
    await waitFor(() =>
      expect(
        listCalls().some((c) => c.params?.createdById === CREATOR_B && c.params?.page === 1),
      ).toBe(true),
    );
  });

  it('已选值强制并入选项：?createdById= 不在 top-20 时也不渲染空选中', async () => {
    const unseen = 'ffffffff-0000-4000-8000-000000000009';
    mockSearchParamsString = `createdById=${unseen}`;
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const select = await screen.findByTestId('experience-creator-filter');
    // 受控 select 的 value 必须能在选项里找到，否则渲染空选中（用户以为在筛，其实过滤已丢）
    expect(select).toHaveValue(unseen);
    await waitFor(() =>
      expect(within(select).getByText(`${unseen.slice(0, 8)} (—)`)).toBeInTheDocument(),
    );
    // 无权威计数时用占位符（不写假 0——与 quality 的 suspect 计数同一纪律）
    expect(listCalls().some((c) => c.params?.createdById === unseen)).toBe(true);
  });

  it('非 UUID 的脏 createdById 被白名单拦下：不发参数、下拉停「全部」', async () => {
    mockSearchParamsString = 'createdById=not-a-uuid';
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    await screen.findByTestId('experience-card');
    expect(screen.getByTestId('experience-creator-filter')).toHaveValue('');
    expect(listCalls().at(-1)!.params!.createdById).toBeUndefined();
  });

  it('形状像 UUID 但版本/variant 位不合规（后端 @IsUUID 会 400）同样被拦下', async () => {
    mockSearchParamsString = 'createdById=11111111-1111-1111-1111-111111111111';
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    await screen.findByTestId('experience-card');
    expect(screen.getByTestId('experience-creator-filter')).toHaveValue('');
    expect(listCalls().at(-1)!.params!.createdById).toBeUndefined();
  });

  it('facets 失败：下拉禁用 + title 提示（候选集不可信时不放行）', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      facetsError: { status: 500, message: 'facets down' },
    });
    renderPage();

    const select = await screen.findByTestId('experience-creator-filter');
    await waitFor(() => expect(select).toBeDisabled());
    expect(select).toHaveAttribute('title', messages['experiences.filter.creatorUnavailable']);
  });

  it('byCreatorTruncated：展示截断提示（下拉不是全部录入者）', async () => {
    route({
      list: { items: [entry()], total: 1, page: 1, pageSize: 20 },
      facets: { ...FACETS, byCreatorTruncated: true },
    });
    renderPage();

    expect(await screen.findByTestId('experience-creator-truncated')).toHaveTextContent(
      'Showing the top 20 creators by entry count',
    );
  });

  it('过滤条为 6 列网格，新控件 sm 占满末行 2 格 / xl 与其它控件等宽', async () => {
    route({ list: { items: [entry()], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    await screen.findByTestId('experience-card');
    const bar = screen.getByTestId('experience-filters');
    expect(bar.className).toContain('xl:grid-cols-6');
    expect(bar.className).not.toContain('xl:grid-cols-5');
    const select = screen.getByTestId('experience-creator-filter');
    expect(select.className).toContain('sm:col-span-2');
    expect(select.className).toContain('xl:col-span-1');
  });

  it('空态「清除全部筛选」：清空过滤并回第 1 页（sort 不动）', async () => {
    mockSearchParamsString = 'quality=unverified&sort=most_used';
    route({ list: { items: [], total: 0, page: 1, pageSize: 20 } });
    renderPage();

    fireEvent.click(await screen.findByTestId('experience-clear-filters'));
    await waitFor(() => expect(listCalls().at(-1)!.params!.quality).toBeUndefined());
    // 排序不属于"过滤"，清过滤不该顺手把用户选的排序也重置
    expect(listCalls().at(-1)!.params!.sort).toBe('most_used');
    expect(listCalls().at(-1)!.params!.page).toBe(1);
  });

  it('无过滤时不渲染「清除全部筛选」（点了没反应的按钮是噪音）', async () => {
    route({ list: { items: [], total: 0, page: 1, pageSize: 20 } });
    renderPage();

    await screen.findByText('No experiences found');
    expect(screen.queryByTestId('experience-clear-filters')).toBeNull();
  });
});

/**
 * 质量徽章释义文案（v1.81.0 治理变更的**用户可见后果**）。
 *
 * 禁自审四态退役后 verified 的语义降级为"至少一位终审人确认过"（当前库里 creator 与
 * 终审人基本同一人），徽章释义若还写"admin 复核通过"就是向用户撒谎。断言直接读真实
 * 语言包：手抄快照只能证明接线对，证不了上线产物里没有 admin 字样。
 */
describe('ExperiencesPage 质量徽章释义（v1.81.0 去 admin 化）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchParamsString = '';
  });

  it('卡片徽章 title = 真实语言包的 qualityHint（渲染路径接对了）', async () => {
    route({ list: { items: [entry({ quality: 'verified' })], total: 1, page: 1, pageSize: 20 } });
    renderPage();

    const card = await screen.findByTestId('experience-card');
    expect(
      within(card).getByTitle(enMessages.experiences.qualityHint.verified),
    ).toBeInTheDocument();
  });

  it('三个 qualityHint 文案均不含 "admin"（en 与 zh-CN，大小写不敏感）', () => {
    for (const hint of Object.values(enMessages.experiences.qualityHint)) {
      expect(hint.toLowerCase()).not.toContain('admin');
    }
    for (const hint of Object.values(zhMessages.experiences.qualityHint)) {
      expect(hint.toLowerCase()).not.toContain('admin');
    }
  });

  it('verified 释义对用户点明「可能是录入者本人」（自证语义必须可见）', () => {
    expect(zhMessages.experiences.qualityHint.verified).toContain('录入者本人');
    expect(enMessages.experiences.qualityHint.verified).toContain('possibly the author');
  });
});
