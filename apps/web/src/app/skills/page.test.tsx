import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SkillListPage from './page';
import { Api } from '@/lib/api';

/** 本测试用到的文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'skills.title': 'Skill Library',
  'skills.subtitle': 'Agent onboarding guides and development conventions.',
  'skills.empty': 'No skills available',
  'skills.updated': 'Updated {time}',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return messages[fullKey] ?? fullKey;
  },
}));

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('@/lib/api', () => ({
  Api: {
    skills: {
      list: jest.fn(),
    },
  },
}));

const mockList = Api.skills.list as jest.Mock;

const skillFixture = {
  name: 'agent-chamber',
  description: 'Agent collaboration platform guide.',
  version: '1.17.0',
  updatedAt: '2026-08-09',
};

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillListPage />
    </QueryClientProvider>,
  );
}

describe('SkillListPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('渲染 Skill 卡片列表（名称/版本/描述/更新时间）', async () => {
    mockList.mockResolvedValue([skillFixture]);

    renderPage();

    expect(await screen.findByText('Skill Library')).toBeInTheDocument();
    expect(screen.getByText('agent-chamber')).toBeInTheDocument();
    expect(screen.getByText('v1.17.0')).toBeInTheDocument();
    expect(screen.getByText('Agent collaboration platform guide.')).toBeInTheDocument();
    // 卡片链接指向详情页
    expect(screen.getByRole('link', { name: /agent-chamber/ })).toHaveAttribute(
      'href',
      '/skills/agent-chamber',
    );
  });

  it('列表为空时渲染空态', async () => {
    mockList.mockResolvedValue([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No skills available')).toBeInTheDocument();
    });
    expect(screen.queryByText('agent-chamber')).not.toBeInTheDocument();
  });

  it('查询失败时渲染空态而非永久 Loading', async () => {
    mockList.mockRejectedValue(new Error('boom'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No skills available')).toBeInTheDocument();
    });
  });
});
