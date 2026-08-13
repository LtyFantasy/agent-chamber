/**
 * sidebar.test.tsx — 侧边栏全局圆桌审批角标测试（M3 阶段 2）
 *
 * 覆盖：pending 计数 > 0 → 话题导航项上角标出现（数字正确）；= 0 → 不显示；
 * 超大计数 → 99+ 封顶；未登录（无 user）→ 不发 pending-count 请求。
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
  'nav.search': 'Search',
  'nav.settings': 'Settings',
  'nav.monitoring': 'Monitoring',
  'nav.skill': 'Skill',
  'nav.closeMenu': 'Close menu',
  'nav.pendingApprovals': '{count} roundtable approvals pending',
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
  Api: {
    roundtable: {
      pendingPermissionRequestCount: jest.fn(),
    },
  },
}));

const mockCount = Api.roundtable.pendingPermissionRequestCount as jest.Mock;

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
    useAuthStore.setState({
      user: { id: 'u1', email: 'u@x.io', name: '天羽', role: 'admin' },
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
    expect(btn).toHaveTextContent('天羽');
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
