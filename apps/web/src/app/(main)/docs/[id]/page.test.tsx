import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DocSpaceDetailPage from './page';
import { Api } from '@/lib/api';

/** 本测试用到的文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'common.retry': 'Retry',
  'docs.editor.edit': 'Edit',
  'docs.editor.contentLoadError': 'Failed to load the original document',
  'docs.editor.contentLoadErrorDesc': 'Check your connection and retry, or exit editing',
  'docs.editor.exitEdit': 'Exit editing',
  'docs.detail.contentLoadError': 'Failed to load document content',
  'docs.detail.contentLoadErrorDesc': 'Check your connection and try again',
  'docs.detail.backToDocs': 'Back to doc list',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return messages[fullKey] ?? fullKey;
  },
}));

const mockSearchParams = new URLSearchParams('doc=doc-1');

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'space-1' }),
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: jest.fn() }),
  usePathname: () => '/docs/space-1',
}));

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('@/stores/auth.store', () => ({
  // admin 角色 → canManage 为 true，编辑按钮可见
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: 'admin' } }),
}));

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      getSpace: jest.fn(),
      listDocs: jest.fn(),
      search: jest.fn(),
      getDoc: jest.fn(),
      getDocContent: jest.fn(),
    },
    // v1.37 owner 代理：页面新增我的 agent 列表查询（非 admin 只返回自己拥有的 agents）
    agents: {
      list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    },
  },
}));

// 编辑器/批量上传内部链路与本测试无关，stub 掉保持测试轻量
jest.mock('@/components/docs/doc-editor', () => ({
  DocEditor: () => <div>DocEditor</div>,
}));
jest.mock('@/components/docs/batch-upload-dialog', () => ({
  BatchUploadDialog: () => null,
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

const mockApi = Api.docs as unknown as {
  getSpace: jest.Mock;
  listDocs: jest.Mock;
  search: jest.Mock;
  getDoc: jest.Mock;
  getDocContent: jest.Mock;
};

/** 最小可用空间对象（admin → creatorId 无需匹配） */
const spaceFixture = {
  id: 'space-1',
  name: 'Test Space',
  visibility: 'open',
  creatorId: 'u1',
  members: [],
  categories: [],
};

/** 最小可用文档元数据对象（native 来源 → 编辑按钮可见） */
const docFixture = {
  id: 'doc-1',
  title: 'Doc T',
  path: 'guides/t.md',
  source: 'native',
  sections: [],
};

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocSpaceDetailPage />
    </QueryClientProvider>,
  );
}

describe('DocSpaceDetailPage 内容查询错误分支', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getSpace.mockResolvedValue(spaceFixture);
    mockApi.listDocs.mockResolvedValue({ items: [], total: 0 });
    mockApi.search.mockResolvedValue([]);
    mockApi.getDoc.mockResolvedValue(docFixture);
  });

  it('浏览态正文查询失败时渲染错误态（重试/返回），而非永久 Loading 或空正文', async () => {
    mockApi.getDocContent.mockRejectedValue(new Error('boom'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Failed to load document content')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to doc list' })).toBeInTheDocument();
  });

  it('编辑态 full 原文查询失败时渲染错误态（重试/退出编辑），而非永久 Loading', async () => {
    // full=true（编辑器原文）失败；普通正文（浏览态）正常，保证能进入编辑态
    mockApi.getDocContent.mockImplementation((_id: string, full?: boolean) =>
      full
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ content: '# Doc T\nbody', title: 'Doc T' }),
    );

    renderPage();

    // 进入编辑态
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load the original document')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    // 退出编辑 → 回到浏览态，错误态消失、正文恢复
    fireEvent.click(screen.getByRole('button', { name: 'Exit editing' }));
    await waitFor(() => {
      expect(screen.queryByText('Failed to load the original document')).not.toBeInTheDocument();
    });
  });
});

describe('DocSpaceDetailPage 搜索防抖（B1）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getSpace.mockResolvedValue(spaceFixture);
    mockApi.listDocs.mockResolvedValue({ items: [], total: 0 });
    mockApi.search.mockResolvedValue([]);
    mockApi.getDoc.mockResolvedValue(docFixture);
    mockApi.getDocContent.mockResolvedValue({ content: '# Doc T\nbody', title: 'Doc T' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('快速连续输入只发一次 search 请求（300ms 停顿后取最终值）', async () => {
    jest.useFakeTimers();
    renderPage();

    // 等初始数据渲染完成（fake timers 下 waitFor/findBy 自动推进定时器）
    await screen.findByText('Test Space');

    const input = screen.getByPlaceholderText('docs.detail.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.change(input, { target: { value: 'abc' } });

    // 距最后一次输入仅 200ms：防抖未到期，不发任何请求
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(mockApi.search).not.toHaveBeenCalled();

    // 停顿满 300ms：只发一次，且请求参数为最终输入值
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => {
      expect(mockApi.search).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.search).toHaveBeenCalledWith('space-1', { q: 'abc', limit: 20 });
  });

  it('清空搜索词后防抖同步关闭查询（enabled 失效，不再发请求）', async () => {
    jest.useFakeTimers();
    renderPage();
    await screen.findByText('Test Space');

    const input = screen.getByPlaceholderText('docs.detail.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'abc' } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    await waitFor(() => {
      expect(mockApi.search).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    // 清空后 enabled 随防抖值关闭：请求数不再增长
    expect(mockApi.search).toHaveBeenCalledTimes(1);
  });
});
