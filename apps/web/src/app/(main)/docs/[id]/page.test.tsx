import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createElement } from 'react';
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
  // 侧边栏视图模式 + 文档匹配文案
  'docs.detail.viewModeTree': 'Tree',
  'docs.detail.viewModeCategory': 'Category',
  'docs.detail.docMatches': 'Document matches',
  'docs.detail.searchHits': 'Search results',
  'docs.detail.noSearchResults': 'No matching sections',
  'docs.detail.uncategorized': 'Uncategorized',
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
      listAllDocs: jest.fn(),
      search: jest.fn(),
      getDoc: jest.fn(),
      getDocContent: jest.fn(),
    },
    // v1.37 owner 代理：页面新增我的 agent 列表查询（非 admin 只返回自己拥有的 agents）；
    // listAll 返回数组（循环翻页拉全），非分页响应
    agents: {
      listAll: jest.fn().mockResolvedValue([]),
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
  default: ({ children }: { children: React.ReactNode }) => (
    <div>
      {String(children)
        .split('\n')
        .map((line, index) => {
          const match = /^(#{1,6})\s+(.+)$/.exec(line);
          if (match) {
            return createElement(
              `h${match[1].length}`,
              { key: index },
              match[2].replace(/`([^`]*)`/g, '$1'),
            );
          }
          return <span key={index}>{line}</span>;
        })}
    </div>
  ),
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));

const mockApi = Api.docs as unknown as {
  getSpace: jest.Mock;
  listAllDocs: jest.Mock;
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

describe('DocSpaceDetailPage headingPath 导航', () => {
  it('scrolls to inline-code headings after normalizing markdown backticks', async () => {
    const specialHeading = '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）';
    mockApi.getSpace.mockResolvedValue(spaceFixture);
    mockApi.listAllDocs.mockResolvedValue([]);
    mockApi.search.mockResolvedValue([]);
    mockApi.getDoc.mockResolvedValue({
      ...docFixture,
      sections: [
        {
          position: 0,
          headingPath: specialHeading,
          heading: specialHeading,
          headingLevel: 3,
        },
      ],
    });
    mockApi.getDocContent.mockResolvedValue({
      content: `### ${specialHeading}\n\n正文。`,
      title: docFixture.title,
    });
    const scrollSpy = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollSpy,
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: specialHeading }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('目录与滚动改读 outline DTO heading（列直读：标题正文含 ` § ` 也不切错）', async () => {
    // 反解析 headingPath 末段会得到 "分隔"，列直读语义下按钮文案/滚动目标均为完整标题
    const fullTitle = '价格区间 § 含 § 分隔';
    mockApi.getSpace.mockResolvedValue(spaceFixture);
    mockApi.listAllDocs.mockResolvedValue([]);
    mockApi.search.mockResolvedValue([]);
    mockApi.getDoc.mockResolvedValue({
      ...docFixture,
      sections: [
        {
          position: 0,
          headingPath: `祖先A § 祖先B § ${fullTitle}`,
          heading: fullTitle,
          headingLevel: 3,
        },
      ],
    });
    mockApi.getDocContent.mockResolvedValue({
      content: `### ${fullTitle}\n\n正文。`,
      title: docFixture.title,
    });
    const scrollSpy = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollSpy,
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: fullTitle }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe('DocSpaceDetailPage 内容查询错误分支', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.getSpace.mockResolvedValue(spaceFixture);
    mockApi.listAllDocs.mockResolvedValue([]);
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
    mockApi.listAllDocs.mockResolvedValue([]);
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

describe('DocSpaceDetailPage 侧边栏视图模式 + 文档匹配', () => {
  /** 目录树/文档匹配用文档 fixture（多级 path、根级散文件、docType 覆盖过滤场景；
   *   listAllDocs 被调用两次：列表（带 type/tag 参数）与 facet 候选（不带参数） */
  const treeDocs = [
    { id: 'doc-1', title: 'Doc T', path: 'guides/t.md', docType: 'guide' },
    { id: 'doc-2', title: 'Readme', path: 'README.md' },
    { id: 'doc-3', title: 'Alpha', path: 'docs/a.md', docType: 'guide' },
    { id: 'doc-4', title: 'Beta', path: 'docs/sub/b.md' },
    { id: 'doc-5', title: 'Gamma', path: 'guides/nested/g.md' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockApi.getSpace.mockResolvedValue(spaceFixture);
    // 模拟服务端过滤语义：带 type/tag 参数的列表查询按 docType 过滤，facet 查询（不带参数）返回全量
    mockApi.listAllDocs.mockImplementation(
      (_spaceId?: string, opts?: { type?: string; tag?: string }) =>
        opts?.type
          ? Promise.resolve(treeDocs.filter((d) => d.docType === opts.type))
          : Promise.resolve(treeDocs),
    );
    mockApi.search.mockResolvedValue([]);
    mockApi.getDoc.mockResolvedValue(docFixture);
    mockApi.getDocContent.mockResolvedValue({ content: '# Doc T\nbody', title: 'Doc T' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('默认渲染目录树模式（review 修订③：tree 为默认）：目录行/子文件/根级散文件可见', async () => {
    renderPage();
    await screen.findByText('Test Space');
    // 目录树：folder 行 + 子文件（默认全展开）+ 根级散文件
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('guides')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Readme')).toBeInTheDocument();
    // 分类模式特征（未分类标签）不应出现
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument();
    // 目录按钮选中态
    expect(screen.getByTitle('Tree')).toHaveClass('bg-primary/10');
  });

  it('切到分类模式：原分类树渲染（未分类区 + 平铺文档），并写回 localStorage', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(screen.getByTitle('Category'));

    // 分类树回归：categories 为空 → 全部文档落未分类区
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.queryByText('docs')).not.toBeInTheDocument();
    expect(screen.getByText('Readme')).toBeInTheDocument();
    // 选中态迁移 + localStorage 持久化
    expect(screen.getByTitle('Category')).toHaveClass('bg-primary/10');
    expect(localStorage.getItem('docs:sidebar-mode')).toBe('category');
  });

  it('文件夹折叠隐藏子文件、展开恢复；根级散文件不受折叠影响', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(screen.getByText('docs'));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Readme')).toBeInTheDocument(); // 根级文件始终可见

    fireEvent.click(screen.getByText('docs'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('预置 docs:sidebar-mode=category 时挂载后按存储值渲染分类模式', async () => {
    localStorage.setItem('docs:sidebar-mode', 'category');
    renderPage();
    await screen.findByText('Test Space');

    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.queryByText('docs')).not.toBeInTheDocument();
  });

  it('搜索命中 path（大小写不敏感）时渲染「文档匹配」组；单组命中不显示 noSearchResults', async () => {
    jest.useFakeTimers();
    renderPage();
    await screen.findByText('Test Space');

    const input = screen.getByPlaceholderText('docs.detail.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'readme' } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    // 文档匹配组：title + 弱化 path 行
    await waitFor(() => {
      expect(screen.getByText('Document matches')).toBeInTheDocument();
    });
    expect(screen.getByText('Readme')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    // 内容命中为空但文档匹配有命中 → 不显示「无结果」
    expect(screen.queryByText('No matching sections')).not.toBeInTheDocument();
  });

  it('开着 type 过滤器时文档匹配仍命中（基于未过滤全量 facetDocs，评审修订②）', async () => {
    jest.useFakeTimers();
    renderPage();
    await screen.findByText('Test Space');

    // type=guide：列表查询只剩 guide 文档（Doc T / Alpha），Beta（无 docType）被过滤
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'guide' } });
    const input = screen.getByPlaceholderText('docs.detail.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'beta' } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    // Beta 按 title 命中（facetDocs 未过滤；若误用过滤后的 docs 将不命中）
    await waitFor(() => {
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });
    expect(screen.getByText('docs/sub/b.md')).toBeInTheDocument();
  });

  it('文档匹配与内容命中两组皆空时才显示 noSearchResults', async () => {
    jest.useFakeTimers();
    renderPage();
    await screen.findByText('Test Space');

    const input = screen.getByPlaceholderText('docs.detail.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'zzz-no-match' } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(screen.getByText('No matching sections')).toBeInTheDocument();
    });
    // 文档匹配 0 条 → 整组（含组标题）不渲染
    expect(screen.queryByText('Document matches')).not.toBeInTheDocument();
  });
});
