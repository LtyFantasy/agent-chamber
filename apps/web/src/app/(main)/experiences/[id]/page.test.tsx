/**
 * experiences/[id]/page.test.tsx — 经验详情页契约测试
 *
 * 隔离策略同列表页：只 mock `axios` + 用真实 `@/lib/api`（请求形态与载荷可断言）。
 * 真实覆盖清单（修复轮校正：此前文件头声称覆盖"乐观锁 409 提示"但实际无对应用例）：
 * ① 正文 markdown / 元信息 / 质量与信任信号渲染；
 * ② **终审按钮组的权限分支**——admin 可见可提交、理由必填、非 admin 只见说明文案；
 * ③ 反馈按钮：提交 `{outcome, clientRequestId}`、用响应三计数更新 UI、成功后失效列表/分面；
 * ④ 过期 Badge + 反馈按钮禁用；
 * ⑤ suspect 条目**照常渲染且终审区可用**（双向门，UI 不得藏条目）；
 * ⑥ 编辑/删除可见性三分支（admin / owner 代理 / 非作者非 owner）；
 * ⑦ **编辑路径**：载荷带 `expectedUpdatedAt` = 详情 updatedAt、409 冲突文案 + 触发
 *    detail 重读、成功后失效 detail/list/facets 三处；
 * ⑧ 删除确认后 DELETE + 跳回列表；详情 404 空态。
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ExperienceDetailPage from './page';
import { axiosInstance } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { ActorType, type ExperienceDetail, type ExperienceJudgment } from '@/types';

const mockPush = jest.fn();
const mockConfirm = jest.fn();
const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();

/** experiences + common 文案快照（同 en.json；缺失 key 回落为 key 名） */
const messages: Record<string, string> = {
  'experiences.detail.back': 'Back to experiences',
  'experiences.detail.notFound': 'Experience not found',
  'experiences.detail.notFoundDesc': 'It may have been deleted.',
  'experiences.detail.notFoundBack': 'Back to the list',
  'experiences.detail.content': 'Content',
  'experiences.detail.signals': 'Signals',
  'experiences.detail.domains': 'Domains',
  'experiences.detail.env': 'Environment',
  'experiences.detail.sourceProject': 'Source project',
  'experiences.detail.createdBy': 'Recorded by',
  'experiences.detail.createdAt': 'Created',
  'experiences.detail.updatedAt': 'Updated',
  'experiences.detail.verifiedBy': 'Reviewed by',
  'experiences.detail.verifiedAt': 'Reviewed at',
  'experiences.detail.none': '—',
  'experiences.detail.edit': 'Edit',
  'experiences.detail.delete': 'Delete',
  'experiences.detail.deleteConfirmTitle': 'Delete this experience?',
  'experiences.detail.deleteConfirmDesc': 'It disappears from the list and from search.',
  'experiences.detail.deleted': 'Experience deleted',
  'experiences.expired': 'Expired',
  'experiences.neverExpires': 'Never expires',
  'experiences.form.expiresAt': 'Expires at',
  'experiences.intent.repair': 'Repair',
  'experiences.quality.unverified': 'Unverified',
  'experiences.quality.verified': 'Verified',
  'experiences.quality.suspect': 'Suspect',
  'experiences.feedback.title': 'Did it help?',
  'experiences.feedback.hint': 'Answer after you APPLY it.',
  'experiences.feedback.helped': 'Helped',
  'experiences.feedback.notHelpful': 'Did not help',
  'experiences.feedback.helpedCount': '{count} found this helpful',
  'experiences.feedback.distinctCount': '{count} distinct users confirmed it works',
  'experiences.feedback.expiredNotice': 'This entry has expired, so feedback is closed.',
  'experiences.feedback.failed': 'Failed to submit feedback',
  'experiences.review.title': 'Final review',
  'experiences.review.onlyAdmin':
    'Final review is limited to an admin or an experience space reviewer (owner / reviewer).',
  'experiences.review.current': 'Current quality: {quality}',
  'experiences.review.verify': 'Verify',
  'experiences.review.suspect': 'Mark suspect',
  'experiences.review.reasonPlaceholder': 'Why this verdict (required)',
  'experiences.review.reasonRequired': 'A reason is required',
  'experiences.review.verified': 'Entry verified',
  'experiences.review.suspected': 'Entry marked suspect',
  'experiences.review.failed': 'Review failed',
  'common.deleted': 'Deleted',
  // v1.81.0：归属人三态（卡片/详情共用文案）
  'experiences.creator.deletedHint':
    "This creator's account has been deleted — the name is kept from their profile.",
  'experiences.creator.orphanHint':
    "This creator's profile can no longer be resolved (maybe hard-deleted) — showing the first 8 characters of the ID.",
  'experiences.creator.type.human': 'Human',
  'experiences.creator.type.agent': 'Agent',
  'experiences.creator.type.system': 'System',
  'experiences.members.title': 'Experience space members',
  // 第二期：机器初评面板（档位/结论文案与 en.json 同源快照）
  'experiences.judgment.title': 'Machine pre-check (observation period) · reference only',
  'experiences.judgment.suppressed': 'Hidden: compare it after you finish the review',
  'experiences.judgment.resultHint': 'Recorded successfully.',
  'experiences.judgment.dimension.completeness': 'Completeness',
  'experiences.judgment.dimension.reusability': 'Reusability',
  'experiences.judgment.dimension.signalQuality': 'Signal quality',
  'experiences.judgment.dimension.duplicate': 'Duplicate',
  'experiences.judgment.dimension.intentSuggestion': 'Type suggestion',
  'experiences.judgment.dimension.domainSuggestion': 'Domain suggestion',
  'experiences.judgment.dimension.admissionSuggestion': 'Admission (cross-project)',
  // v1.82.0：准入建议三态 + rubric 代际小字（文案与 en.json 逐字对齐）
  'experiences.judgment.admission.admit': 'admit — transfers to other projects',
  'experiences.judgment.admission.needs_human': 'borderline — a reviewer should decide',
  'experiences.judgment.admission.reject': 'reject — low value for a cross-project base',
  'experiences.judgment.rubricVersion': 'rubric {version}',
  'experiences.judgment.level.missing': 'missing',
  'experiences.judgment.level.thin': 'thin',
  'experiences.judgment.level.partial': 'partial',
  'experiences.judgment.level.complete': 'complete',
  'experiences.judgment.level.one_off': 'one-off',
  'experiences.judgment.level.narrow': 'narrow',
  'experiences.judgment.level.broad': 'broad',
  'experiences.judgment.level.noise': 'noise',
  'experiences.judgment.level.weak': 'weak',
  'experiences.judgment.level.distinctive': 'distinctive',
  'experiences.judgment.verdict.distinct': 'distinct',
  'experiences.judgment.verdict.possible_duplicate': 'possible duplicate',
  'experiences.judgment.verdict.likely_duplicate': 'likely duplicate',
  'experiences.judgment.verdict.keep': 'current value is fine',
  'experiences.judgment.verdict.none_fits': 'no existing tag fits',
  'experiences.judgment.verdict.suggested': 'suggested: {value}',
  'experiences.form.submitEdit': 'Save',
  'experiences.form.conflict':
    'This entry changed while you were editing. The latest version has been reloaded — review your edit and submit again.',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.close': 'Close',
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
  useParams: () => ({ id: 'e1' }),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

jest.mock('@/lib/notify', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
    info: jest.fn(),
    warning: jest.fn(),
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

// react-markdown / remark-gfm 为纯 ESM（Jest 不转换 node_modules），stub 之：
// 本测试只断言"正文全文渲染出来了"，不需要 markdown 结构（docs 页测试有更细的 stub）
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{String(children)}</div>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

/** 后端统一响应信封 */
function envelope<T>(data: T) {
  return { data: { code: 0, message: 'ok', data, timestamp: '', requestId: 'r1' } };
}

/** 详情 fixture（ExperienceDetail 全字段） */
function detail(overrides: Partial<ExperienceDetail> = {}): ExperienceDetail {
  return {
    id: 'e1',
    title: 'Docker port forwarding fails on WSL2',
    summary: 'Published port unreachable from the Windows host.',
    intent: 'repair',
    quality: 'unverified',
    signals: ['port-unreachable'],
    domains: ['devops'],
    env: { os: 'wsl2', tool: 'docker' },
    helpedCount: 3,
    notHelpfulCount: 1,
    distinctHelpedCount: 3,
    lastHelpedAt: null,
    sourceProject: 'agent-chamber',
    expiresAt: null,
    expired: false,
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-21T00:00:00Z',
    content: '## Symptom\n\nPort unreachable\n\n## Fix\n\nRestart docker-desktop',
    createdByType: ActorType.AGENT,
    createdById: 'agent-1',
    // v1.81.0 归属三件套（活的缺省值；三态用例各自覆盖）
    createdByName: 'Agent One',
    createdByAvatarUrl: null,
    createdByDeletedAt: null,
    verifiedBy: null,
    verifiedByName: null,
    verifiedByDeletedAt: null,
    verifiedAt: null,
    ...overrides,
  };
}

/** 机器初评 fixture（七维齐全；用例按需把某些维置 null / 删掉 rubricVersion） */
function judgment(overrides: Partial<ExperienceJudgment> = {}): ExperienceJudgment {
  return {
    provider: 'jev',
    model: 'jev-latest',
    judgedAt: '2026-09-22T10:00:00Z',
    // rubric 代际（v1.82.0）：缺字段 = v1 旧快照（用例单独覆盖该形态）
    rubricVersion: 'v2',
    completeness: { level: 'partial', confidence: 0.7 },
    reusability: { level: 'broad', confidence: 0.64 },
    signalQuality: { level: 'weak', confidence: 0.32 },
    duplicate: { verdict: 'distinct', confidence: 0.92 },
    intentSuggestion: { verdict: 'suggested', value: 'pitfall', confidence: 0.51 },
    domainSuggestion: { verdict: 'none_fits', value: null, confidence: 0.97 },
    admissionSuggestion: { verdict: 'admit', confidence: 0.77 },
    ...overrides,
  };
}

/** 按 method+url 分派应答（未注册组合抛错，避免静默空响应掩盖接线错误） */
function route(handlers: {
  detail?: ExperienceDetail;
  detailError?: { status: number; message: string };
  agents?: { id: string }[];
  review?: unknown;
  reviewError?: { status: number; message: string };
  feedback?: unknown;
  update?: unknown;
  updateError?: { status: number; message: string };
}) {
  mockRequest.mockImplementation((config: { method?: string; url?: string }) => {
    const method = (config.method ?? 'GET').toUpperCase();
    const url = config.url ?? '';
    if (method === 'GET' && url === '/experiences/e1') {
      if (handlers.detailError) {
        return Promise.reject({
          response: {
            status: handlers.detailError.status,
            data: { message: handlers.detailError.message },
          },
        });
      }
      return Promise.resolve(envelope(handlers.detail ?? detail()));
    }
    if (method === 'GET' && url === '/agents') {
      return Promise.resolve(
        envelope({
          items: handlers.agents ?? [],
          total: (handlers.agents ?? []).length,
          page: 1,
          pageSize: 100,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        }),
      );
    }
    if (method === 'PATCH' && url === '/experiences/e1/quality') {
      if (handlers.reviewError) {
        return Promise.reject({
          response: {
            status: handlers.reviewError.status,
            data: { message: handlers.reviewError.message },
          },
        });
      }
      return Promise.resolve(
        envelope(
          handlers.review ?? {
            id: 'e1',
            quality: 'verified',
            verifiedBy: 'u1',
            verifiedAt: '2026-09-22T00:00:00Z',
          },
        ),
      );
    }
    if (method === 'PATCH' && url === '/experiences/e1') {
      // 编辑（乐观锁）：409 = expectedUpdatedAt 不匹配
      if (handlers.updateError) {
        return Promise.reject({
          response: {
            status: handlers.updateError.status,
            data: { message: handlers.updateError.message },
          },
        });
      }
      return Promise.resolve(envelope(handlers.update ?? handlers.detail ?? detail()));
    }
    if (method === 'POST' && url === '/experiences/e1/feedback') {
      return Promise.resolve(
        envelope(
          handlers.feedback ?? {
            experienceId: 'e1',
            outcome: 'helped',
            helpedCount: 4,
            notHelpfulCount: 1,
            distinctHelpedCount: 4,
          },
        ),
      );
    }
    if (method === 'DELETE' && url === '/experiences/e1') {
      return Promise.resolve(envelope({ deleted: true, id: 'e1' }));
    }
    return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
  });
}

/** 请求配置快照（按 method+url 过滤） */
function callsTo(method: string, url: string) {
  return mockRequest.mock.calls
    .map((c) => c[0] as { method?: string; url?: string; data?: Record<string, unknown> })
    .filter((c) => (c.method ?? 'GET').toUpperCase() === method && c.url === url);
}

/**
 * 共享 QueryClient（可断言失效语义）
 *
 * 详情页在保存/反馈后会失效 `['experiences','list']` 与 `['experiences','facets']`——
 * 这两个查询在本页没有 observer（不挂载），invalidate 只会把它们标记为 invalidated
 * 而不触发请求，故断言点只能是 QueryClient 缓存状态，不能是"又发了一次请求"。
 */
let queryClient: QueryClient;

function renderPage() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ExperienceDetailPage />
    </QueryClientProvider>,
  );
}

/** 预置 list/facets 缓存条目（invalidate 只能作用于"已存在的查询"） */
function seedListAndFacetsCache() {
  queryClient.setQueryData(['experiences', 'list', {}], {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  queryClient.setQueryData(['experiences', 'facets'], {
    total: 0,
    byIntent: { pitfall: 0, repair: 0, howto: 0, optimize: 0, decision: 0 },
    byQuality: { unverified: 0, verified: 0, suspect: 0 },
    availableDomains: [],
  });
}

/** 设定登录身份（role 决定终审区可见性） */
function signIn(role: 'admin' | 'editor', id = 'u1') {
  useAuthStore.setState({ user: { id, email: 'u@x.io', name: 'U', role }, isAuthenticated: true });
}

describe('ExperienceDetailPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    signIn('editor');
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('渲染正文（markdown）/ 元信息 / 质量与信任信号', async () => {
    route({ detail: detail() });
    renderPage();

    expect(await screen.findByText('Docker port forwarding fails on WSL2')).toBeInTheDocument();
    // content 全文（react-markdown 渲染出 markdown 标题文本）
    const content = screen.getByTestId('experience-detail-content');
    expect(content).toHaveTextContent('Port unreachable');
    expect(content).toHaveTextContent('Restart docker-desktop');
    expect(screen.getByTestId('experience-detail-quality')).toHaveTextContent('Unverified');
    expect(screen.getByTestId('experience-feedback-counts')).toHaveTextContent(
      '3 found this helpful',
    );
    // 元信息：env 固定键序渲染
    expect(screen.getByText('os:')).toBeInTheDocument();
    expect(screen.getByText('tool:')).toBeInTheDocument();
  });

  it('admin：viewerCanReview=true → 终审按钮组可见，提交带 quality+reason', async () => {
    signIn('admin');
    route({ detail: detail({ viewerCanReview: true }) });
    renderPage();

    const panel = await screen.findByTestId('experience-review-panel');
    expect(within(panel).getByTestId('experience-review-verify')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('experience-review-reason'), {
      target: { value: 'Reproduced on WSL2 + docker 24.0.7' },
    });
    fireEvent.click(screen.getByTestId('experience-review-verify'));

    await waitFor(() => expect(callsTo('PATCH', '/experiences/e1/quality')).toHaveLength(1));
    expect(callsTo('PATCH', '/experiences/e1/quality')[0].data).toEqual({
      quality: 'verified',
      reason: 'Reproduced on WSL2 + docker 24.0.7',
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it('admin：理由为空 → 就地报错且不发请求', async () => {
    signIn('admin');
    route({ detail: detail({ viewerCanReview: true }) });
    renderPage();

    await screen.findByTestId('experience-review-verify');
    fireEvent.click(screen.getByTestId('experience-review-verify'));

    expect(await screen.findByTestId('experience-review-error')).toHaveTextContent(
      'A reason is required',
    );
    expect(callsTo('PATCH', '/experiences/e1/quality')).toHaveLength(0);
  });

  it('非 admin 且无终审角色（viewerCanReview=false）→ 无按钮，仅"仅 admin 或终审人"文案', async () => {
    signIn('editor');
    route({ detail: detail({ viewerCanReview: false }) });
    renderPage();

    const panel = await screen.findByTestId('experience-review-panel');
    expect(within(panel).queryByTestId('experience-review-verify')).toBeNull();
    expect(within(panel).queryByTestId('experience-review-suspect')).toBeNull();
    expect(within(panel).getByTestId('experience-review-denied')).toHaveTextContent(
      'Final review is limited to an admin or an experience space reviewer (owner / reviewer).',
    );
  });

  it('非 admin 但服务端说可审（空间终审人）→ 按钮组可见（权限不再由 web 推 admin 身份）', async () => {
    signIn('editor');
    route({ detail: detail({ viewerCanReview: true }) });
    renderPage();

    const panel = await screen.findByTestId('experience-review-panel');
    expect(within(panel).getByTestId('experience-review-verify')).toBeInTheDocument();
    expect(within(panel).queryByTestId('experience-review-denied')).toBeNull();
  });

  it('viewerCanReview 缺失（旧响应/迁移窗口）→ **fail-closed**：不显示按钮组', async () => {
    signIn('admin');
    // 刻意不带 viewer 字段（undefined）——web 不猜权限，宁可少给入口
    route({ detail: detail() });
    renderPage();

    const panel = await screen.findByTestId('experience-review-panel');
    expect(within(panel).queryByTestId('experience-review-verify')).toBeNull();
    expect(within(panel).getByTestId('experience-review-denied')).toBeInTheDocument();
  });

  /**
   * 两态终审区（v1.81.0 禁自审四态退役）。
   *
   * 原先的第二态是"禁用 + 身份分叉文案"（self / owner_proxy 两个原因码）；四态退役后
   * `viewerReviewBlockReason` 停发，web 只剩「按钮组 / 缺角色说明」，且**没有**任何
   * "禁自审"分支——这两条用例钉住"已删干净"（旧分支的 testid 不复存在）。
   */
  it('viewerCanReview=false：只渲染缺角色说明（禁自审分支与其 testid 已彻底移除）', async () => {
    signIn('admin');
    route({ detail: detail({ viewerCanReview: false }) });
    renderPage();

    const panel = await screen.findByTestId('experience-review-panel');
    expect(within(panel).getByTestId('experience-review-denied')).toHaveTextContent(
      'Final review is limited to an admin or an experience space reviewer (owner / reviewer).',
    );
    // 旧「禁自审态」的两件套（禁用说明块 + 跳「成员」按钮）必须整体消失：
    // 缺角色时的正确动作是找 admin 授权，不是"去指派一位别人来审"
    expect(within(panel).queryByTestId('experience-review-blocked')).toBeNull();
    expect(within(panel).queryByTestId('experience-review-open-members')).toBeNull();
    expect(within(panel).queryByTestId('experience-review-verify')).toBeNull();
  });

  it('本人所录条目也可由自己终审（admin 自审）：按钮组照常可用', async () => {
    // 四态退役的核心行为变化：creator == 当前身份时不再出现禁用块
    signIn('admin');
    route({ detail: detail({ createdById: 'u1', viewerCanReview: true }) });
    renderPage();

    const panel = await screen.findByTestId('experience-review-panel');
    expect(within(panel).getByTestId('experience-review-verify')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('experience-review-reason'), {
      target: { value: 'self review is allowed now' },
    });
    fireEvent.click(screen.getByTestId('experience-review-verify'));
    await waitFor(() => expect(callsTo('PATCH', '/experiences/e1/quality')).toHaveLength(1));
  });

  it('suspect 条目：详情照常可见且终审区可用（双向门，UI 不藏条目）', async () => {
    signIn('admin');
    route({ detail: detail({ quality: 'suspect', viewerCanReview: true }) });
    renderPage();

    expect(await screen.findByTestId('experience-detail-quality')).toHaveTextContent('Suspect');
    // 终审区双向：suspect 也能改回 verified
    fireEvent.change(screen.getByTestId('experience-review-reason'), {
      target: { value: 'appeal accepted' },
    });
    fireEvent.click(screen.getByTestId('experience-review-verify'));
    await waitFor(() => expect(callsTo('PATCH', '/experiences/e1/quality')).toHaveLength(1));
  });

  it('机器初评面板：七维齐全 → 逐维渲染（建议项带值）+ rubric 代际小字，标注观察期', async () => {
    signIn('admin');
    route({ detail: detail({ judgment: judgment() }) });
    renderPage();

    const panel = await screen.findByTestId('experience-judgment-panel');
    // 观察期标注（人类终审为主、机器初评为辅）
    expect(
      within(panel).getByText('Machine pre-check (observation period) · reference only'),
    ).toBeInTheDocument();
    // rubric 代际小字（v1.82.0）：快照带 rubricVersion 才渲染
    expect(within(panel).getByTestId('experience-judgment-rubric-version')).toHaveTextContent(
      'rubric v2',
    );
    const body = within(panel).getByTestId('experience-judgment-body');
    expect(body).toHaveTextContent('Completeness');
    expect(body).toHaveTextContent('partial (0.70)');
    expect(body).toHaveTextContent('Reusability');
    expect(body).toHaveTextContent('broad (0.64)');
    expect(body).toHaveTextContent('Signal quality');
    expect(body).toHaveTextContent('weak (0.32)');
    expect(body).toHaveTextContent('Duplicate');
    expect(body).toHaveTextContent('distinct (0.92)');
    // 归类建议：suggested 带建议值（可行动）；none_fits 是"词表无合适项"（对维护者可行动）
    expect(body).toHaveTextContent('Type suggestion');
    expect(body).toHaveTextContent('suggested: pitfall');
    expect(body).toHaveTextContent('Domain suggestion');
    expect(body).toHaveTextContent('no existing tag fits');
    // 第 7 维准入建议（v1.82.0）：admit = 正向 emerald 着色 + 置信度
    expect(body).toHaveTextContent('Admission (cross-project)');
    expect(
      within(body).getByText('admit — transfers to other projects (0.77)').className,
    ).toContain('text-emerald-300');
  });

  it('机器初评面板：准入建议 needs_human → 警告着色（amber），文案提示交终审人', async () => {
    signIn('admin');
    route({
      detail: detail({
        judgment: judgment({ admissionSuggestion: { verdict: 'needs_human', confidence: 0.42 } }),
      }),
    });
    renderPage();

    const body = await screen.findByTestId('experience-judgment-body');
    const row = within(body).getByText('borderline — a reviewer should decide (0.42)');
    expect(row.className).toContain('text-amber-300');
  });

  it('机器初评面板：准入建议 reject → 负向着色（destructive），文案是作者自省提示', async () => {
    signIn('admin');
    route({
      detail: detail({
        judgment: judgment({ admissionSuggestion: { verdict: 'reject', confidence: 0.66 } }),
      }),
    });
    renderPage();

    const body = await screen.findByTestId('experience-judgment-body');
    const row = within(body).getByText('reject — low value for a cross-project base (0.66)');
    expect(row.className).toContain('text-destructive');
  });

  it('机器初评面板：rubricVersion 缺失（v1 旧快照）→ 不渲染代际小字，面板其余照常', async () => {
    signIn('admin');
    // v1 快照形状：无 rubricVersion 字段（服务端缺省语义 = 六维代际）
    route({ detail: detail({ judgment: judgment({ rubricVersion: undefined }) }) });
    renderPage();

    const panel = await screen.findByTestId('experience-judgment-panel');
    expect(within(panel).queryByTestId('experience-judgment-rubric-version')).toBeNull();
    expect(within(panel).getByTestId('experience-judgment-body')).toHaveTextContent('Completeness');
  });

  it('机器初评面板：**null 维度被容忍**——缺失维整行不渲染，其余照常（不崩）', async () => {
    signIn('admin');
    route({
      detail: detail({
        judgment: judgment({
          completeness: null,
          signalQuality: null,
          duplicate: null,
          intentSuggestion: null,
          admissionSuggestion: null,
          // 只留 reusability + domainSuggestion
        }),
      }),
    });
    renderPage();

    const body = await screen.findByTestId('experience-judgment-body');
    expect(body).toHaveTextContent('Reusability');
    expect(body).not.toHaveTextContent('Completeness');
    expect(body).not.toHaveTextContent('Signal quality');
    expect(body).not.toHaveTextContent('Duplicate');
    expect(body).not.toHaveTextContent('Type suggestion');
    // 第 7 维同样按"缺失维整行不渲染"处理（null 容忍覆盖新维）
    expect(body).not.toHaveTextContent('Admission (cross-project)');
    expect(body).toHaveTextContent('Domain suggestion');
  });

  it('机器初评面板：judgmentSuppressed=true → 只渲染「已隐藏：终审后可对照」（不渲染结论）', async () => {
    signIn('admin');
    route({
      detail: detail({
        quality: 'unverified',
        viewerCanReview: true,
        // 服务端已把 judgment 置 null（防锚定），web 只读标记
        judgment: null,
        judgmentSuppressed: true,
      }),
    });
    renderPage();

    expect(await screen.findByTestId('experience-judgment-suppressed')).toHaveTextContent(
      'Hidden: compare it after you finish the review',
    );
    expect(screen.queryByTestId('experience-judgment-body')).toBeNull();
  });

  it('反馈：提交 {outcome, clientRequestId} 并用响应三计数更新 UI', async () => {
    route({ detail: detail() });
    renderPage();

    await screen.findByTestId('experience-feedback-helped');
    seedListAndFacetsCache();
    expect(screen.getByTestId('experience-feedback-counts')).toHaveTextContent(
      '3 found this helpful',
    );

    fireEvent.click(screen.getByTestId('experience-feedback-helped'));

    await waitFor(() => expect(callsTo('POST', '/experiences/e1/feedback')).toHaveLength(1));
    const payload = callsTo('POST', '/experiences/e1/feedback')[0].data!;
    expect(payload.outcome).toBe('helped');
    expect(typeof payload.clientRequestId).toBe('string');
    expect(payload.clientRequestId).not.toBe('');
    // 响应计数直接回写缓存（无需二次查询）
    await waitFor(() =>
      expect(screen.getByTestId('experience-feedback-counts')).toHaveTextContent(
        '4 found this helpful',
      ),
    );
    // 列表卡片的信任信号 / most_used 口径保鲜：list + facets 一并失效（评审 minor 3）
    expect(queryClient.getQueryState(['experiences', 'list', {}])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['experiences', 'facets'])?.isInvalidated).toBe(true);
  });

  it('过期条目：显示过期 Badge，反馈按钮禁用', async () => {
    route({
      detail: detail({ expired: true, expiresAt: '2026-01-01T00:00:00Z' }),
    });
    renderPage();

    expect(await screen.findByTestId('experience-detail-expired')).toHaveTextContent('Expired');
    expect(screen.getByTestId('experience-feedback-helped')).toBeDisabled();
    expect(screen.getByTestId('experience-feedback-not-helpful')).toBeDisabled();
  });

  it('编辑/删除可见性：owner 代理（agent 归属当前人类）可见', async () => {
    signIn('editor', 'u1');
    route({ detail: detail({ createdById: 'agent-1' }), agents: [{ id: 'agent-1' }] });
    renderPage();

    expect(await screen.findByTestId('experience-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('experience-delete-button')).toBeInTheDocument();
  });

  it('编辑/删除可见性：非作者非 owner 的普通用户不可见', async () => {
    signIn('editor', 'u1');
    route({ detail: detail({ createdById: 'someone-else' }), agents: [{ id: 'agent-9' }] });
    renderPage();

    await screen.findByText('Docker port forwarding fails on WSL2');
    await waitFor(() => expect(callsTo('GET', '/agents')).toHaveLength(1));
    expect(screen.queryByTestId('experience-edit-button')).toBeNull();
    expect(screen.queryByTestId('experience-delete-button')).toBeNull();
  });

  it('删除：确认后 DELETE 并跳回列表', async () => {
    signIn('admin');
    mockConfirm.mockResolvedValue(true);
    route({ detail: detail() });
    renderPage();

    fireEvent.click(await screen.findByTestId('experience-delete-button'));

    await waitFor(() => expect(callsTo('DELETE', '/experiences/e1')).toHaveLength(1));
    expect(mockPush).toHaveBeenCalledWith('/experiences');
  });

  it('详情 404：渲染 notFound 空态（不重试同 id）', async () => {
    route({ detailError: { status: 404, message: 'Experience not found' } });
    renderPage();

    expect(await screen.findByText('Experience not found')).toBeInTheDocument();
    expect(screen.getByText('Back to the list')).toBeInTheDocument();
  });

  /**
   * 编辑路径（评审 M4）：此前文件头声称覆盖乐观锁但无对应用例。
   *
   * 三条分别钉住：载荷的乐观锁 token 取值、409 的恢复路径（重读）、成功后的失效范围。
   */
  describe('编辑路径（乐观锁 + 失效范围）', () => {
    /** 打开编辑 Dialog（admin 身份 → 编辑按钮可见） */
    async function openEditDialog() {
      fireEvent.click(await screen.findByTestId('experience-edit-button'));
      expect(await screen.findByTestId('experience-form-submit')).toBeInTheDocument();
    }

    it('提交载荷：带 expectedUpdatedAt = 详情 updatedAt，并预填现值', async () => {
      signIn('admin');
      route({ detail: detail({ updatedAt: '2026-09-21T00:00:00Z' }) });
      renderPage();
      await openEditDialog();

      // 预填：标题取自详情（表单体按 key 重挂载 + useState 初始化器）
      expect(screen.getByTestId('experience-form-title')).toHaveValue(
        'Docker port forwarding fails on WSL2',
      );

      fireEvent.click(screen.getByTestId('experience-form-submit'));

      await waitFor(() => expect(callsTo('PATCH', '/experiences/e1')).toHaveLength(1));
      const payload = callsTo('PATCH', '/experiences/e1')[0].data!;
      expect(payload.expectedUpdatedAt).toBe('2026-09-21T00:00:00Z');
      // 编辑通道不携带幂等键（乐观锁即冲突仲裁），quality 也不可改
      expect(payload.clientRequestId).toBeUndefined();
      expect(payload.quality).toBeUndefined();
    });

    it('编辑成功：失效 detail（重读）+ list + facets', async () => {
      signIn('admin');
      route({ detail: detail() });
      renderPage();
      await screen.findByTestId('experience-edit-button');
      seedListAndFacetsCache();
      await openEditDialog();

      fireEvent.click(screen.getByTestId('experience-form-submit'));

      await waitFor(() => expect(callsTo('PATCH', '/experiences/e1')).toHaveLength(1));
      // detail 有 observer → 失效即重读（GET 调用次数增加）
      await waitFor(() => expect(callsTo('GET', '/experiences/e1').length).toBeGreaterThan(1));
      expect(queryClient.getQueryState(['experiences', 'list', {}])?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(['experiences', 'facets'])?.isInvalidated).toBe(true);
    });

    it('409（乐观锁冲突）：提示已重载最新版本，并触发 detail 重读', async () => {
      signIn('admin');
      route({
        detail: detail(),
        updateError: { status: 409, message: 'expectedUpdatedAt mismatch' },
      });
      renderPage();
      await openEditDialog();
      const detailCallsBefore = callsTo('GET', '/experiences/e1').length;

      fireEvent.click(screen.getByTestId('experience-form-submit'));

      const error = await screen.findByTestId('experience-form-error');
      expect(error).toHaveTextContent('The latest version has been reloaded');
      // 恢复路径：invalidate detail → 父级 entry 更新（下次提交用新 token）
      await waitFor(() =>
        expect(callsTo('GET', '/experiences/e1').length).toBeGreaterThan(detailCallsBefore),
      );
      // 冲突不清空用户输入（表单内容保留，避免重打一遍）
      expect(screen.getByTestId('experience-form-title')).toHaveValue(
        'Docker port forwarding fails on WSL2',
      );
    });
  });
});

/**
 * 归属元信息（v1.81.0）：录入者三态行 + 录入时间 + 终审人行。
 *
 * 三态规则与列表卡片**同一实现**（`lib/experience` 的 `experienceActorLabel`），
 * 本组用例钉详情页的渲染结果与字段接线（createdByName / verifiedByName 来自
 * 服务端档案解析，web 不做任何名字推导）。
 */
describe('ExperienceDetailPage 归属元信息（v1.81.0）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    signIn('editor');
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
  });

  it('录入者行：sm 头像 + 名字 + 类型 + 完整 UUID（title 排查通道）', async () => {
    route({ detail: detail() });
    renderPage();

    const row = await screen.findByTestId('experience-detail-creator');
    const name = within(row).getByTestId('experience-detail-creator-name');
    expect(name.textContent).toBe('Agent One');
    expect(name).toHaveAttribute('title', 'agent-1');
    expect(within(row).getByText('Agent')).toBeInTheDocument();
    expect(within(row).queryByTestId('experience-detail-creator-deleted')).toBeNull();
  });

  it('录入者行软删态：真名保留 + 「已删除」标记（title 给出解释）', async () => {
    route({
      detail: detail({ createdByName: 'Bob', createdByDeletedAt: '2026-08-01T00:00:00Z' }),
    });
    renderPage();

    const row = await screen.findByTestId('experience-detail-creator');
    expect(within(row).getByTestId('experience-detail-creator-name').textContent).toBe('Bob');
    expect(within(row).getByTestId('experience-detail-creator-deleted')).toHaveAttribute(
      'title',
      messages['experiences.creator.deletedHint'],
    );
  });

  it('录入者孤儿态：显示 id 前 8 位（不加兜底词），title 保留完整 UUID', async () => {
    route({ detail: detail({ createdByName: null }) });
    renderPage();

    const row = await screen.findByTestId('experience-detail-creator');
    const name = within(row).getByTestId('experience-detail-creator-name');
    expect(name.textContent).toBe('agent-1');
    expect(name).toHaveAttribute('title', 'agent-1');
    expect(within(row).queryByTestId('experience-detail-creator-deleted')).toBeNull();
  });

  it('录入者 id 与 name 双缺失：整行（含「录入者」标签）不渲染', async () => {
    route({ detail: detail({ createdById: undefined, createdByName: undefined }) });
    renderPage();

    await screen.findByText('Docker port forwarding fails on WSL2');
    expect(screen.queryByTestId('experience-detail-creator')).toBeNull();
    expect(screen.queryByText('Recorded by')).toBeNull();
  });

  it('录入时间：渲染 createdAt（第二期起 i18n 键就在，一直未接线）', async () => {
    route({ detail: detail({ createdAt: '2026-09-20T00:00:00Z' }) });
    renderPage();

    const createdAt = await screen.findByTestId('experience-detail-created-at');
    expect(createdAt.textContent).toMatch(/2026/);
    // 创建时间排在更新时间之前（时间线阅读序）
    const updatedAt = screen.getByTestId('experience-detail-updated-at');
    expect(
      createdAt.compareDocumentPosition(updatedAt) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('终审人行：未终审显示占位符（不显示空行）', async () => {
    route({ detail: detail() });
    renderPage();

    expect((await screen.findByTestId('experience-detail-verified-by')).textContent).toBe('—');
  });

  it('终审人行：已终审显示名字，title 保留完整 UUID', async () => {
    route({
      detail: detail({
        verifiedBy: 'u1',
        verifiedByName: 'Ada',
        verifiedAt: '2026-09-22T00:00:00Z',
      }),
    });
    renderPage();

    const verified = await screen.findByTestId('experience-detail-verified-by');
    expect(verified.textContent).toBe('Ada');
    expect(within(verified).getByTitle('u1')).toBeInTheDocument();
  });

  it('终审人行软删态：真名保留 + 「已删除」标记（与录入者行同一条规则）', async () => {
    route({
      detail: detail({
        verifiedBy: 'u1',
        verifiedByName: 'Ada',
        verifiedByDeletedAt: '2026-09-23T00:00:00Z',
      }),
    });
    renderPage();

    const verified = await screen.findByTestId('experience-detail-verified-by');
    expect(verified.textContent).toContain('Ada');
    expect(within(verified).getByTestId('experience-detail-verified-deleted')).toHaveAttribute(
      'title',
      messages['experiences.creator.deletedHint'],
    );
  });
});
