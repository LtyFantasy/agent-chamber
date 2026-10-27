/** Memory 发行边界的 React 行为；完整 Hument 交互在既有 usage/page suite 保留。 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './sidebar';
import UsagePage from '@/app/(main)/usage/page';
import MemoryLayout from '@/app/(main)/memory/layout';
import { useAuthStore } from '@/stores/auth.store';
import { Api } from '@/lib/api';
import enMessages from '@/i18n/messages/en.json';

let mockMemoryEnabled = true;
let mockSearch = '';
const mockHumentMount = jest.fn();

jest.mock('@agent-chamber/shared', () => ({
  ...jest.requireActual('@agent-chamber/shared'),
  get MEMORY_FEATURE_ENABLED() {
    return mockMemoryEnabled;
  },
}));
jest.mock('next/navigation', () => ({
  usePathname: () => '/usage',
  useSearchParams: () => new URLSearchParams(mockSearch),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});
jest.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => (key: string) => {
    const path = [namespace, key].filter(Boolean).join('.').split('.');
    return path.reduce<unknown>(
      (value, segment) => (value as Record<string, unknown>)?.[segment],
      enMessages,
    ) as string;
  },
}));
jest.mock('@/components/ui/scramble-text', () => ({
  ScrambleText: ({ text }: { text: string }) => <span>{text}</span>,
}));
jest.mock('@/components/locale-switcher', () => ({ LocaleSwitcher: () => null }));
jest.mock('@/components/usage/hument-usage-tab', () => ({
  HumentUsageTab: () => {
    mockHumentMount();
    return <div data-testid="hument-mounted" />;
  },
}));
jest.mock('@/lib/api', () => ({
  setAuthHooks: jest.fn(),
  Api: {
    roundtable: { pendingPermissionRequestCount: jest.fn() },
    monitoring: { getHealth: jest.fn() },
    experiences: { facets: jest.fn() },
    usage: { apiUsage: jest.fn() },
  },
}));

let client: QueryClient;

/** Render the actual shell or page with a fresh query cache, leaving platform authorization intact. */
function show(node: React.ReactNode, role: 'admin' | 'editor') {
  useAuthStore.setState({
    user: { id: 'u1', email: 'u@example.com', name: 'User', role },
    isAuthenticated: true,
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMemoryEnabled = false;
  mockSearch = '';
  (Api.roundtable.pendingPermissionRequestCount as jest.Mock).mockResolvedValue({ count: 0 });
  (Api.monitoring.getHealth as jest.Mock).mockResolvedValue({ status: 'ok' });
  (Api.experiences.facets as jest.Mock).mockResolvedValue({ byQuality: { unverified: 0 } });
  // A pending platform response is enough to test request authorization; no network is contacted.
  (Api.usage.apiUsage as jest.Mock).mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  client?.clear();
  act(() => useAuthStore.setState({ user: null, isAuthenticated: false }));
});

describe('Memory 发行菜单', () => {
  it.each(['admin', 'editor'] as const)(
    '关闭时 %s 无记忆入口，保留知识与经验入口',
    async (role) => {
      show(<Sidebar />, role);
      expect(await screen.findByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
      expect(screen.getByRole('link', { name: 'Experiences' })).toHaveAttribute(
        'href',
        '/experiences',
      );
      expect(screen.queryByRole('link', { name: 'Memory' })).not.toBeInTheDocument();
      if (role === 'admin')
        expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/usage');
      else expect(screen.queryByRole('link', { name: 'Usage' })).not.toBeInTheDocument();
    },
  );

  it('内部开启时 editor 同时可见记忆与用量入口', async () => {
    mockMemoryEnabled = true;
    show(<Sidebar />, 'editor');
    expect(await screen.findByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/memory');
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/usage');
  });
});

describe('Memory 发行用量页', () => {
  it.each(['', 'tab=hument'])('关闭时 editor 直链 %s 显示原权限面板且零数据请求', async (query) => {
    mockSearch = query;
    show(<UsagePage />, 'editor');
    expect(await screen.findByTestId('platform-permission')).toBeInTheDocument();
    expect(screen.queryByTestId('usage-tab-hument')).not.toBeInTheDocument();
    expect(screen.queryByText(/Hument/)).not.toBeInTheDocument();
    expect(mockHumentMount).not.toHaveBeenCalled();
    expect(Api.usage.apiUsage).not.toHaveBeenCalled();
  });

  it('关闭时 admin 的旧 Hument 链接仍只请求平台统计', async () => {
    mockSearch = 'tab=hument';
    show(<UsagePage />, 'admin');
    await waitFor(() => expect(Api.usage.apiUsage).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('platform-group-by')).toBeInTheDocument();
    expect(screen.queryByText(/Hument/)).not.toBeInTheDocument();
    expect(mockHumentMount).not.toHaveBeenCalled();
  });

  it('内部开启时 editor 仍默认挂载 Hument Tab', async () => {
    mockMemoryEnabled = true;
    show(<UsagePage />, 'editor');
    expect(await screen.findByTestId('hument-mounted')).toBeInTheDocument();
    expect(screen.getByTestId('usage-tab-hument')).toHaveAttribute('aria-selected', 'true');
    expect(Api.usage.apiUsage).not.toHaveBeenCalled();
  });
});

describe('Memory 整个路由子树的服务端发行门', () => {
  it('关闭时在渲染子页面前返回标准 notFound', () => {
    const Child = jest.fn(() => <div>memory content</div>);
    expect(() => MemoryLayout({ children: <Child /> })).toThrow('NEXT_NOT_FOUND');
    expect(Child).not.toHaveBeenCalled();
  });

  it('开启时保留原 children，不引入额外权限或请求', () => {
    mockMemoryEnabled = true;
    const children = <div>memory content</div>;
    expect(MemoryLayout({ children })).toBe(children);
  });
});
