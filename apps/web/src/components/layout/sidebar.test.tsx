/**
 * sidebar.test.tsx — 侧边栏全局圆桌审批角标测试（M3 阶段 2）+ 版本角标测试
 *
 * 覆盖：pending 计数 > 0 → 话题导航项上角标出现（数字正确）；= 0 → 不显示；
 * 超大计数 → 99+ 封顶；未登录（无 user）→ 不发 pending-count 请求；
 * 版本角标：/health 返回 version+commit → logo 下方显示；请求失败 → 静默不渲染。
 * 文案断言用 en.json 快照。
 */

import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './sidebar';
import { Api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

/** nav 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'nav.dashboard': 'Dashboard',
  'nav.agents': 'Agents',
  'nav.users': 'Users',
  'nav.topics': 'Topics',
  'nav.boards': 'Boards',
  'nav.docs': 'Docs',
  'nav.experiences': 'Experiences',
  'nav.search': 'Search',
  'nav.settings': 'Settings',
  'nav.monitoring': 'Monitoring',
  'nav.skill': 'Skill',
  'nav.closeMenu': 'Close menu',
  'nav.pendingApprovals': '{count} roundtable approvals pending',
  'nav.pendingExperienceReviews': '{count} experiences awaiting final review',
  'nav.language': 'Language',
  'nav.logout': 'Logout',
};

jest.mock('next-intl', () => ({
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

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('next/navigation', () => ({
  usePathname: () => '/topics',
}));

// ScrambleText 依赖 window.matchMedia（jsdom 未实现）；品牌动效与本测试无关，降级纯文本
jest.mock('@/components/ui/scramble-text', () => ({
  ScrambleText: ({ text }: { text: string }) => <span>{text}</span>,
}));

// LocaleSwitcher 依赖 useLocale/useRouter（与 mock 的 next-intl/next-navigation 不兼容），
// 语言切换逻辑与本测试无关，降级占位
jest.mock('@/components/locale-switcher', () => ({
  LocaleSwitcher: () => <div data-testid="locale-switcher" />,
}));

jest.mock('@/lib/api', () => ({
  // setAuthHooks：auth.store.ts 模块加载时调用（review-0831 任务 04e8d744 拆环注入），
  // mock 缺此导出会 TypeError: setAuthHooks is not a function
  setAuthHooks: jest.fn(),
  Api: {
    roundtable: {
      pendingPermissionRequestCount: jest.fn(),
    },
    monitoring: {
      getHealth: jest.fn(),
    },
    // 经验库待终审角标（admin 专属）：facets 聚合的 byQuality.unverified
    experiences: {
      facets: jest.fn(),
    },
  },
}));

const mockCount = Api.roundtable.pendingPermissionRequestCount as jest.Mock;
const mockHealth = Api.monitoring.getHealth as jest.Mock;
const mockFacets = Api.experiences.facets as jest.Mock;

/** /health 默认应答（无 version 字段 → 版本角标默认隐藏，不影响既有角标用例） */
const HEALTH_FALLBACK = { status: 'ok' as const, timestamp: '2026-08-15T00:00:00Z', uptime: 1 };

/**
 * 经验库 facets 默认应答：byIntent/byQuality **键全量**（后端契约，未命中 = 0），
 * 全零 → 待终审角标默认不显示，不影响既有用例。
 */
const FACETS_FALLBACK = {
  total: 0,
  byIntent: { pitfall: 0, repair: 0, howto: 0, optimize: 0, decision: 0 },
  byQuality: { unverified: 0, verified: 0, suspect: 0 },
  availableDomains: [],
  /** 第二期：角色级总览门（服务端判定；admin 天然 true）——缺省按"可终审"给，
   *  负例（非终审人）由用例显式覆盖为 false */
  viewerIsReviewer: true,
};

function renderSidebar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Sidebar />
    </QueryClientProvider>,
  );
}

describe('Sidebar 圆桌审批全局角标', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'U', role: 'admin' },
      isAuthenticated: true,
    });
    mockCount.mockResolvedValue({ count: 3 });
    mockHealth.mockResolvedValue(HEALTH_FALLBACK);
    mockFacets.mockResolvedValue(FACETS_FALLBACK);
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });
  });

  it('计数 > 0：话题导航项显示数字角标', async () => {
    renderSidebar();

    const badge = await screen.findByTestId('nav-pending-count');
    expect(badge).toHaveTextContent('3');
  });

  it('计数 = 0：不显示角标', async () => {
    mockCount.mockResolvedValue({ count: 0 });
    const { container } = renderSidebar();

    await screen.findByText('Topics');
    expect(container.querySelector('[data-testid="nav-pending-count"]')).toBeNull();
  });

  it('超大计数：99+ 封顶', async () => {
    mockCount.mockResolvedValue({ count: 150 });
    renderSidebar();

    expect(await screen.findByTestId('nav-pending-count')).toHaveTextContent('99+');
  });

  it('未登录（无 user）：不发 pending-count 请求', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    renderSidebar();

    await screen.findByText('Topics');
    expect(mockCount).not.toHaveBeenCalled();
    // 经验库待终审角标同理：未登录不发 facets 请求
    expect(mockFacets).not.toHaveBeenCalled();
  });
});

/**
 * 用户区（v1.49.0 布局两栏化）：原 navbar 用户菜单迁入 sidebar 底部。
 * 覆盖：用户按钮渲染 name/email；点击展开 dropup（语言切换/设置/登出）；
 * 登出点击调用 auth store logout 并收起菜单。
 */
describe('Sidebar 用户区（v1.49.0 布局两栏化）', () => {
  const logoutMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockCount.mockResolvedValue({ count: 0 });
    mockHealth.mockResolvedValue(HEALTH_FALLBACK);
    mockFacets.mockResolvedValue(FACETS_FALLBACK);
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'Test User', role: 'admin' },
      isAuthenticated: true,
      logout: logoutMock,
    });
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });
  });

  it('渲染用户按钮（name + email）', async () => {
    renderSidebar();
    const btn = await screen.findByTestId('sidebar-user-button');
    expect(btn).toHaveTextContent('Test User');
    expect(btn).toHaveTextContent('u@x.io');
  });

  it('点击展开 dropup：语言切换/设置/登出三入口', async () => {
    renderSidebar();
    fireEvent.click(await screen.findByTestId('sidebar-user-button'));
    // 菜单内查询（sidebar 导航本身有 Settings 项，需用菜单容器隔离）
    const menu = within(screen.getByTestId('sidebar-user-menu'));
    expect(menu.getByTestId('locale-switcher')).toBeInTheDocument();
    expect(menu.getByText('Settings')).toBeInTheDocument();
    expect(menu.getByText('Logout')).toBeInTheDocument();
  });

  it('登出：调用 logout 并收起菜单', async () => {
    renderSidebar();
    fireEvent.click(await screen.findByTestId('sidebar-user-button'));
    fireEvent.click(within(screen.getByTestId('sidebar-user-menu')).getByText('Logout'));
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('sidebar-user-menu')).not.toBeInTheDocument();
  });
});

/**
 * 版本角标（2026-08-15）：logo 下方显示后端 /health 的 version+commit，
 * 供用户一眼判定当前线上版本。覆盖：version+commit 全量显示；仅 version 省略 commit 段；
 * /health 失败 → 静默不渲染且导航不受影响（观测性增强不得破坏导航）。
 */
describe('Sidebar 版本角标', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCount.mockResolvedValue({ count: 0 });
    mockFacets.mockResolvedValue(FACETS_FALLBACK);
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'U', role: 'admin' },
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });
  });

  it('version+commit：显示完整角标', async () => {
    mockHealth.mockResolvedValue({ ...HEALTH_FALLBACK, version: '1.52.0-dev', commit: '0e80e65' });
    renderSidebar();

    const badge = await screen.findByTestId('sidebar-version');
    expect(badge).toHaveTextContent('v1.52.0-dev · 0e80e65');
  });

  it('仅 version（无 commit 字段）：省略 commit 段', async () => {
    mockHealth.mockResolvedValue({ ...HEALTH_FALLBACK, version: '1.52.0-dev' });
    renderSidebar();

    const badge = await screen.findByTestId('sidebar-version');
    expect(badge).toHaveTextContent('v1.52.0-dev');
    expect(badge).not.toHaveTextContent('·');
  });

  it('/health 请求失败：角标不渲染，导航仍可用', async () => {
    mockHealth.mockRejectedValue(new Error('network down'));
    const { container } = renderSidebar();

    await screen.findByText('Topics');
    expect(container.querySelector('[data-testid="sidebar-version"]')).toBeNull();
  });
});

/**
 * 经验库导航项与「待终审」角标（批 4）：导航项常量注册 + admin 专属角标。
 *
 * 角标语义 = facets 端点 `byQuality.unverified`（已录入未终审的积压量）：
 * - admin 且积压 > 0 → 挂在 /experiences 导航项上；
 * - 积压 = 0 → 不显示；
 * - 非 admin → **不发 facets 请求**（终审是 admin 面，普通用户看到积压量无从处置）。
 */
describe('Sidebar 经验库导航与待终审角标', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCount.mockResolvedValue({ count: 0 });
    mockHealth.mockResolvedValue(HEALTH_FALLBACK);
    mockFacets.mockResolvedValue(FACETS_FALLBACK);
  });

  afterEach(() => {
    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });
  });

  /** 设定登录用户（role 决定角标是否可见） */
  function signIn(role: 'admin' | 'editor') {
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: 'U', role },
      isAuthenticated: true,
    });
  }

  it('导航项存在且指向 /experiences', async () => {
    signIn('admin');
    renderSidebar();

    const link = (await screen.findByText('Experiences')).closest('a');
    expect(link).toHaveAttribute('href', '/experiences');
  });

  it('admin + 待终审 > 0：显示数字角标，且导航项直达待终审面（minor 7）', async () => {
    signIn('admin');
    mockFacets.mockResolvedValue({
      ...FACETS_FALLBACK,
      total: 7,
      byQuality: { unverified: 7, verified: 0, suspect: 0 },
      suspectCount: 2,
      viewerIsReviewer: true,
    });
    renderSidebar();

    const badge = await screen.findByTestId('nav-experiences-pending-count');
    expect(badge).toHaveTextContent('7');
    // 有积压 → href 带 quality=unverified（列表页支持该 searchParams 初始化过滤态）
    expect((await screen.findByText('Experiences')).closest('a')).toHaveAttribute(
      'href',
      '/experiences?quality=unverified',
    );
  });

  it('待终审 = 0：不显示角标，href 保持原值', async () => {
    signIn('admin');
    const { container } = renderSidebar();

    const link = (await screen.findByText('Experiences')).closest('a');
    expect(container.querySelector('[data-testid="nav-experiences-pending-count"]')).toBeNull();
    expect(link).toHaveAttribute('href', '/experiences');
  });

  it('非 admin 且服务端说不可审（viewerIsReviewer=false）→ 有积压也不显示角标', async () => {
    signIn('editor');
    // 第二期：facets 查询对**全体登录用户**发起（角色只有服务端知道，web 不再按 role 推门）
    mockFacets.mockResolvedValue({
      ...FACETS_FALLBACK,
      total: 7,
      byQuality: { unverified: 7, verified: 0, suspect: 0 },
      viewerIsReviewer: false,
    });
    const { container } = renderSidebar();

    await screen.findByText('Experiences');
    expect(mockFacets).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="nav-experiences-pending-count"]')).toBeNull();
  });

  it('非 admin 但服务端说可审（空间 owner/reviewer）→ 显示角标（admin 不再是唯一终审人）', async () => {
    signIn('editor');
    mockFacets.mockResolvedValue({
      ...FACETS_FALLBACK,
      total: 4,
      byQuality: { unverified: 4, verified: 0, suspect: 0 },
      viewerIsReviewer: true,
    });
    renderSidebar();

    const badge = await screen.findByTestId('nav-experiences-pending-count');
    expect(badge).toHaveTextContent('4');
  });

  it('viewerIsReviewer 缺失（旧后端/迁移窗口）→ **fail-closed**：不显示角标', async () => {
    signIn('admin');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 解构剔除只为构造"旧后端无该字段"的响应，值本身不用
    const { viewerIsReviewer: _omitted, ...withoutFlag } = FACETS_FALLBACK;
    mockFacets.mockResolvedValue({
      ...withoutFlag,
      total: 7,
      byQuality: { unverified: 7, verified: 0, suspect: 0 },
    });
    const { container } = renderSidebar();

    await screen.findByText('Experiences');
    expect(container.querySelector('[data-testid="nav-experiences-pending-count"]')).toBeNull();
  });
});
