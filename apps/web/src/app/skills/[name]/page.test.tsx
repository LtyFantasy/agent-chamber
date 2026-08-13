import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SkillDetailPage from './page';
import { Api } from '@/lib/api';

/** 本测试用到的文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'skills.updated': 'Updated {time}',
  'skills.copyMarkdown': 'Copy Markdown',
  'skills.copyInstallCommand': 'Copy install command',
  'skills.downloadSkillMd': 'Download SKILL.md',
  'skills.subSkills': 'Sub Skills',
  'skills.subDownload': 'Download SKILL.md',
  'skills.notFound': 'Skill not found',
  'skills.footerHint': 'This Skill is used to guide Agents to integrate with this platform.',
  'skills.goToLogin': 'Go to Login →',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => {
    const t = (key: string) => {
      const fullKey = ns ? `${ns}.${key}` : key;
      return messages[fullKey] ?? fullKey;
    };
    // 404 分支使用 t.rich（含 <code> 插值），简化实现：与 t 同构返回文案
    t.rich = (key: string) => {
      const fullKey = ns ? `${ns}.${key}` : key;
      return messages[fullKey] ?? fullKey;
    };
    return t;
  },
}));

jest.mock('next/navigation', () => ({
  useParams: () => ({ name: 'agent-chamber' }),
}));

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('@/lib/api', () => ({
  Api: {
    skills: {
      get: jest.fn(),
      getSubs: jest.fn(),
      getSub: jest.fn(),
    },
  },
}));

// react-markdown / remark-gfm 为纯 ESM，Jest 不转换 node_modules，stub 之
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));

const mockApi = Api.skills as unknown as {
  get: jest.Mock;
  getSubs: jest.Mock;
  getSub: jest.Mock;
};

const skillFixture = {
  name: 'agent-chamber',
  description: 'Agent collaboration platform guide.',
  version: '1.17.0',
  updatedAt: '2026-08-09',
  content: '# Main Skill Content\n',
};

const subsFixture = [
  { name: 'topics', description: 'Topics skill.', version: '1.5.1', updatedAt: '2026-08-01' },
  {
    name: 'taskboard',
    description: 'Task board skill.',
    version: '1.4.1',
    updatedAt: '2026-08-01',
  },
];

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillDetailPage />
    </QueryClientProvider>,
  );
}

describe('SkillDetailPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.get.mockResolvedValue(skillFixture);
    mockApi.getSubs.mockResolvedValue(subsFixture);
    mockApi.getSub.mockResolvedValue({
      name: 'topics',
      description: 'Topics skill.',
      version: '1.5.1',
      updatedAt: '2026-08-01',
      content: '# Topics Sub Content\n',
    });
  });

  it('渲染主 Skill 内容与操作按钮', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'agent-chamber' })).toBeInTheDocument();
    expect(screen.getByText(/# Main Skill Content/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeInTheDocument();
    // 下载按钮同时用于主文件与子文件（同文案）
    expect(screen.getAllByRole('button', { name: 'Download SKILL.md' }).length).toBeGreaterThan(0);
  });

  it('渲染子 Skill 导航标签并切换到子内容', async () => {
    renderPage();

    await screen.findByRole('heading', { name: 'agent-chamber' });

    // 子标签渲染：主 Skill 标签 + topics/taskboard
    expect(screen.getByRole('button', { name: /agent-chamber/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /topics/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /taskboard/ })).toBeInTheDocument();

    // 点击 topics → 请求子详情并渲染子内容
    fireEvent.click(screen.getByRole('button', { name: /topics/ }));

    await waitFor(() => {
      expect(mockApi.getSub).toHaveBeenCalledWith('agent-chamber', 'topics');
    });
    expect(await screen.findByText(/# Topics Sub Content/)).toBeInTheDocument();
    // 子内容区带下载按钮
    expect(screen.getAllByRole('button', { name: 'Download SKILL.md' }).length).toBeGreaterThan(0);
  });

  it('无子 Skill 时不渲染导航条', async () => {
    mockApi.getSubs.mockResolvedValue([]);

    renderPage();

    await screen.findByRole('heading', { name: 'agent-chamber' });

    await waitFor(() => {
      expect(mockApi.getSubs).toHaveBeenCalledWith('agent-chamber');
    });
    // 导航条标题不出现，且只有主内容无切换按钮
    expect(screen.queryByText('Sub Skills')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /topics/ })).not.toBeInTheDocument();
  });

  it('Skill 不存在时渲染 404 提示', async () => {
    mockApi.get.mockRejectedValue(new Error('not found'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Skill not found')).toBeInTheDocument();
    });
  });
});
