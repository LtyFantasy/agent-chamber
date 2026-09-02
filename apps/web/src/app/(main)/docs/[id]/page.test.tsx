import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
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
  'docs.detail.noDocs': 'No docs yet',
  'docs.detail.docLinkNotFound': 'Document not found or has been deleted',
  'docs.detail.loadMore': 'Load more',
  'docs.detail.loadMoreFolders': 'Load more folders',
  // 右栏 card 标题（diagram doc 隐藏断言需要真实文案）
  'docs.doc.outline': 'Outline',
  'docs.linkHealth.title': 'Link Health',
  // Diagram IR v1（图信息卡 + viewer iframe title）
  'docs.diagram.viewerTitle': 'Diagram preview',
  'docs.diagram.infoCard': 'Diagram Info',
  'docs.diagram.qualityProfile': 'Quality',
  'docs.diagram.renderedAt': 'Rendered',
  'docs.diagram.htmlBytes': 'Snapshot size',
  'docs.diagram.compositionErrors': 'Errors',
  'docs.diagram.compositionWarnings': 'Warnings',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return messages[fullKey] ?? fullKey;
  },
  // DIAGRAM-WEB-004：DiagramViewer 用 useLocale 进 queryKey/请求参数，mock 必须提供
  useLocale: () => 'en',
}));

const mockSearchParams = new URLSearchParams('doc=doc-1');
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'space-1' }),
  useSearchParams: () => mockSearchParams,
  useRouter: () => mockRouter,
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

const mockToastError = jest.fn();
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn().mockResolvedValue(true),
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
  },
}));

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      getSpace: jest.fn(),
      getTree: jest.fn(),
      getFacets: jest.fn(),
      listDocs: jest.fn(),
      search: jest.fn(),
      getDoc: jest.fn(),
      getDocContent: jest.fn(),
      getDocByPath: jest.fn(),
      getDiagramHtml: jest.fn(),
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
// （stub 额外渲染行内 markdown 链接，且走 components.a 渲染器——断链点击解析测试
//  需要真实 onClick 挂载，直接 <a> 会绕过页面 markdownComponents）
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({
    children,
    components,
  }: {
    children: React.ReactNode;
    components?: { a?: React.ComponentType<{ href?: string; children?: React.ReactNode }> };
  }) => {
    const A = components?.a;
    return (
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
            // 行内 markdown 链接渲染（[text](href) → components.a 或默认 <a>）
            const parts = line.split(/(\[[^\]]*\]\([^)\s]+\))/g);
            if (parts.length > 1) {
              return (
                <span key={index}>
                  {parts.map((part, i) => {
                    const lm = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part);
                    if (lm) {
                      if (A) return createElement(A, { key: i, href: lm[2] }, lm[1]);
                      return createElement('a', { key: i, href: lm[2] }, lm[1]);
                    }
                    return part;
                  })}
                </span>
              );
            }
            return <span key={index}>{line}</span>;
          })}
      </div>
    );
  },
}));
jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => undefined,
}));

const mockApi = Api.docs as unknown as {
  getSpace: jest.Mock;
  getTree: jest.Mock;
  getFacets: jest.Mock;
  listDocs: jest.Mock;
  search: jest.Mock;
  getDoc: jest.Mock;
  getDocContent: jest.Mock;
  getDocByPath: jest.Mock;
  getDiagramHtml: jest.Mock;
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

/** 空 tree 响应（根层无内容） */
const emptyTree = {
  prefix: '',
  folders: { items: [], total: 0, hasMore: false },
  docs: { items: [], total: 0, hasMore: false },
};

/** 空 facets 响应 */
const emptyFacets = { types: [], tags: [], categories: [] };

/** 构造 listDocs 分页响应 */
const paginated = (items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 20,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
});

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DocSpaceDetailPage />
    </QueryClientProvider>,
  );
}

/** 基础 mock 装配：空空间 + 空树 + 空 facets + 空列表（各 describe 按需覆盖） */
function mockBase() {
  mockApi.getSpace.mockResolvedValue(spaceFixture);
  mockApi.getTree.mockResolvedValue(emptyTree);
  mockApi.getFacets.mockResolvedValue(emptyFacets);
  mockApi.listDocs.mockResolvedValue(paginated([]));
  mockApi.search.mockResolvedValue([]);
  mockApi.getDoc.mockResolvedValue(docFixture);
  mockApi.getDocContent.mockResolvedValue({ content: '# Doc T\nbody', title: 'Doc T' });
  mockApi.getDocByPath.mockResolvedValue(null);
}

describe('DocSpaceDetailPage headingPath 导航', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBase();
  });

  it('scrolls to inline-code headings after normalizing markdown backticks', async () => {
    const specialHeading = '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）';
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
    mockBase();
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
    mockBase();
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

describe('DocSpaceDetailPage 侧边栏视图模式 + 文档匹配（懒加载）', () => {
  /** 目录树/文档匹配用文档 fixture（多级 path、根级散文件、docType 覆盖过滤场景） */
  const treeDocs = [
    { id: 'doc-1', title: 'Doc T', path: 'guides/t.md', docType: 'guide' },
    { id: 'doc-2', title: 'Readme', path: 'README.md' },
    { id: 'doc-3', title: 'Alpha', path: 'docs/a.md', docType: 'guide' },
    { id: 'doc-4', title: 'Beta', path: 'docs/sub/b.md' },
    { id: 'doc-5', title: 'Gamma', path: 'guides/nested/g.md' },
  ];

  /** 根层 tree：docs/ + guides/ 两个目录 + 根级散文件 Readme */
  const treeRoot = {
    prefix: '',
    folders: {
      items: [
        { path: 'docs/', name: 'docs', docCount: 2, latestDocAt: '2026-08-01T00:00:00Z' },
        { path: 'guides/', name: 'guides', docCount: 2, latestDocAt: '2026-08-01T00:00:00Z' },
      ],
      total: 2,
      hasMore: false,
    },
    docs: {
      items: [{ id: 'doc-2', path: 'README.md', title: 'Readme' }],
      total: 1,
      hasMore: false,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockBase();
    // type 过滤候选来自 facets 端点（「开着 type 过滤器」测试需要真实 option 才能设值）
    mockApi.getFacets.mockResolvedValue({
      types: [{ value: 'guide', count: 2 }],
      tags: [],
      categories: [],
    });
    // 模拟服务端 tree 语义：根层返回目录 + 根级散文件；docs/ 子层返回 Alpha
    mockApi.getTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) =>
      params?.prefix === 'docs/'
        ? Promise.resolve({
            prefix: 'docs/',
            folders: { items: [], total: 0, hasMore: false },
            docs: {
              items: [{ id: 'doc-3', path: 'docs/a.md', title: 'Alpha', docType: 'guide' }],
              total: 1,
              hasMore: false,
            },
          })
        : Promise.resolve(treeRoot),
    );
    // 模拟服务端过滤语义：q= 按 title/path 子串过滤；type= 按 docType 过滤
    mockApi.listDocs.mockImplementation(
      (_spaceId: string, opts?: { q?: string; type?: string }) => {
        if (opts?.q) {
          const q = opts.q.toLowerCase();
          return Promise.resolve(
            paginated(
              treeDocs.filter(
                (d) => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q),
              ),
            ),
          );
        }
        if (opts?.type) {
          return Promise.resolve(paginated(treeDocs.filter((d) => d.docType === opts.type)));
        }
        return Promise.resolve(paginated([]));
      },
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('默认渲染目录树模式（review 修订③：tree 为默认）：目录行/根级散文件可见', async () => {
    renderPage();
    await screen.findByText('Test Space');
    // 懒加载目录树：folder 行（含 docCount）+ 根级散文件
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('guides')).toBeInTheDocument();
    expect(screen.getByText('README')).toBeInTheDocument(); // 标题≈文件名去重 → 主标签为文件名（2026-09-02 拍板）
    // 未展开的目录不拉子层（只发过根层请求）
    expect(mockApi.getTree).toHaveBeenCalledTimes(1);
    // 分类模式特征（未分类标签）不应出现
    expect(screen.queryByText('Uncategorized')).not.toBeInTheDocument();
    // 目录按钮选中态
    expect(screen.getByTitle('Tree')).toHaveClass('bg-primary/10');
  });

  it('切到分类模式：分类 = getSpace categories ⋈ facets 计数，展开拉 ?category=slug 分页', async () => {
    mockApi.getSpace.mockResolvedValue({
      ...spaceFixture,
      categories: [{ id: 'cat-1', name: 'Guides', slug: 'guides' }],
    });
    mockApi.getFacets.mockResolvedValue({
      types: [],
      tags: [],
      categories: [{ slug: 'guides', name: 'Guides', count: 2 }],
    });
    mockApi.listDocs.mockImplementation((_spaceId: string, opts?: { category?: string }) =>
      opts?.category === 'guides'
        ? Promise.resolve(paginated([treeDocs[0], treeDocs[4]]))
        : Promise.resolve(paginated([])),
    );

    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(screen.getByTitle('Category'));

    // 分类行（facets 计数）；未折叠 → 挂载即拉取分类文档
    expect(screen.getByText('Guides')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    // Gamma 仅出现在分类列表（正文标题是 Doc T，避免多元素歧义用唯一文本断言）
    expect(await screen.findByText('Gamma')).toBeInTheDocument();
    expect(screen.getAllByText('Doc T').length).toBeGreaterThanOrEqual(2);
    // 折叠 → 分类文档隐藏
    fireEvent.click(screen.getByText('Guides'));
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
    // 选中态迁移 + localStorage 持久化
    expect(screen.getByTitle('Category')).toHaveClass('bg-primary/10');
    expect(localStorage.getItem('docs:sidebar-mode')).toBe('category');
  });

  it('分类视图 count=0 隐藏：facets 计数为 0 的分类不渲染（保持现行行为）', async () => {
    mockApi.getSpace.mockResolvedValue({
      ...spaceFixture,
      categories: [
        { id: 'cat-1', name: 'Guides', slug: 'guides' },
        { id: 'cat-2', name: 'Empty', slug: 'empty' },
      ],
    });
    mockApi.getFacets.mockResolvedValue({
      types: [],
      tags: [],
      categories: [
        { slug: 'guides', name: 'Guides', count: 2 },
        { slug: 'empty', name: 'Empty', count: 0 },
      ],
    });

    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(screen.getByTitle('Category'));

    // 有文档的分类渲染；count=0 的分类隐藏
    expect(screen.getByText('Guides')).toBeInTheDocument();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
  });

  it('目录懒加载：展开才拉子层，折叠隐藏子文件', async () => {
    renderPage();
    await screen.findByText('Test Space');

    // 展开 docs/ → 子层查询挂载，Alpha 出现
    fireEvent.click(screen.getByText('docs'));
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(mockApi.getTree).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ prefix: 'docs/' }),
    );
    // 根级散文件始终可见
    expect(screen.getByText('README')).toBeInTheDocument(); // 标题≈文件名去重 → 主标签为文件名（2026-09-02 拍板）

    // 折叠 → 子文件隐藏
    fireEvent.click(screen.getByText('docs'));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('预置 docs:sidebar-mode=category 时挂载后按存储值渲染分类模式', async () => {
    mockApi.getSpace.mockResolvedValue({
      ...spaceFixture,
      categories: [{ id: 'cat-1', name: 'Guides', slug: 'guides' }],
    });
    mockApi.getFacets.mockResolvedValue({
      types: [],
      tags: [],
      categories: [{ slug: 'guides', name: 'Guides', count: 2 }],
    });
    localStorage.setItem('docs:sidebar-mode', 'category');
    renderPage();
    await screen.findByText('Test Space');

    expect(screen.getByText('Guides')).toBeInTheDocument();
    expect(screen.queryByText('docs')).not.toBeInTheDocument();
  });

  it('搜索命中 path（大小写不敏感）时渲染「文档匹配」组（服务端 q= 分页）；单组命中不显示 noSearchResults', async () => {
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
    expect(screen.getByText('Readme')).toBeInTheDocument(); // 文档匹配组 = title 主行（两行行内已有 path 消歧，不采用树行文件名主标签）
    expect(screen.getByText('README.md')).toBeInTheDocument();
    // 服务端 q= 契约：请求带 q 参数
    expect(mockApi.listDocs).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ q: 'readme' }),
    );
    // 内容命中为空但文档匹配有命中 → 不显示「无结果」
    expect(screen.queryByText('No matching sections')).not.toBeInTheDocument();
  });

  it('开着 type 过滤器时文档匹配仍命中（服务端 q= 不受过滤影响，评审修订②）', async () => {
    jest.useFakeTimers();
    renderPage();
    await screen.findByText('Test Space');

    // type=guide：过滤态扁平列表查询（listDocs type=）与文档匹配查询（listDocs q=）并存
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'guide' } });
    const input = screen.getByPlaceholderText('docs.detail.searchPlaceholder');
    fireEvent.change(input, { target: { value: 'beta' } });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    // Beta 按 title 命中（q= 服务端过滤；若误用 type 过滤后的列表将不命中）
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

describe('DocSpaceDetailPage type/tag 过滤 → 扁平分页列表态（P3 行为变更）', () => {
  const treeDocs = [
    { id: 'doc-1', title: 'Doc T', path: 'guides/t.md', docType: 'guide' },
    { id: 'doc-2', title: 'Readme', path: 'README.md' },
    { id: 'doc-3', title: 'Alpha', path: 'docs/a.md', docType: 'guide' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockBase();
    // type/tag 过滤候选来自 facets 端点（select 需要真实 option 才能设值）
    mockApi.getFacets.mockResolvedValue({
      types: [{ value: 'guide', count: 2 }],
      tags: [{ value: 'no-such-tag', count: 1 }],
      categories: [],
    });
    mockApi.getTree.mockResolvedValue({
      prefix: '',
      folders: {
        items: [{ path: 'docs/', name: 'docs', docCount: 2, latestDocAt: '2026-08-01T00:00:00Z' }],
        total: 1,
        hasMore: false,
      },
      docs: { items: [], total: 0, hasMore: false },
    });
    mockApi.listDocs.mockImplementation(
      (_spaceId: string, opts?: { type?: string; tag?: string }) =>
        opts?.tag
          ? Promise.resolve(paginated([]))
          : opts?.type
            ? Promise.resolve(paginated(treeDocs.filter((d) => d.docType === opts.type)))
            : Promise.resolve(paginated([])),
    );
  });

  it('type 过滤激活 → 扁平分页列表态：目录树不再渲染，过滤结果平铺', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'guide' } });

    // 扁平列表：过滤后的文档平铺（Alpha 仅出现在扁平列表），目录行消失
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Doc T').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('docs')).not.toBeInTheDocument();
    // 过滤查询走 listDocs type= 契约
    expect(mockApi.listDocs).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ type: 'guide' }),
    );
  });

  it('过滤结果为空时显示「暂无文档」', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'guide' } });
    // 等第一段过滤查询落定（扁平列表出现）再叠加 tag 过滤
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'no-such-tag' } });

    await waitFor(() => {
      expect(screen.getByText('No docs yet')).toBeInTheDocument();
    });
  });
});

describe('DocSpaceDetailPage 正文相对链接断链点击解析（?path= 单一机制）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBase();
    // 当前文档 path 置根级：链接 docs/a.md 解析为 docs/a.md（源目录相对）
    mockApi.getDoc.mockResolvedValue({ ...docFixture, path: 'README.md' });
    mockApi.getDocContent.mockResolvedValue({
      content: '[Target](docs/a.md)',
      title: 'Doc T',
    });
  });

  it('命中 → SPA 跳转（?path= 异步解析 + 会话内缓存）', async () => {
    mockApi.getDocByPath.mockResolvedValue({ id: 'doc-3', path: 'docs/a.md', title: 'Alpha' });

    renderPage();
    fireEvent.click(await screen.findByText('Target'));

    await waitFor(() => {
      expect(mockApi.getDocByPath).toHaveBeenCalledWith('space-1', 'docs/a.md');
    });
    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith('/docs/space-1?doc=doc-3', { scroll: false });
    });
  });

  it('未命中 → toast「文档不存在或已删除」，不跳转', async () => {
    mockApi.getDocByPath.mockResolvedValue(null);

    renderPage();
    fireEvent.click(await screen.findByText('Target'));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith({
        title: 'Document not found or has been deleted',
      });
    });
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe('DocSpaceDetailPage diagram doc 中栏 iframe 预览（Diagram IR v1）', () => {
  /** diagram doc fixture：docType='diagram' + DocDetail.diagram 摘要（GET /docs/:id 契约） */
  const diagramDocFixture = {
    ...docFixture,
    docType: 'diagram',
    diagram: {
      diagramType: 'architecture',
      qualityProfile: 'standard',
      renderedAt: '2026-08-30T00:00:00Z',
      htmlBytes: 123456,
      composition: { errors: 0, warnings: 2 },
    },
  };
  const diagramHtml = '<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>';

  beforeEach(() => {
    jest.clearAllMocks();
    mockBase();
    mockApi.getDoc.mockResolvedValue(diagramDocFixture);
    mockApi.getDiagramHtml.mockResolvedValue(diagramHtml);
  });

  it('diagram doc：iframe[srcdoc][sandbox] 挂载；getDocContent 零调用；编辑按钮隐藏；右栏隐藏大纲/链接健康、显示图信息卡', async () => {
    renderPage();

    // iframe 挂载（srcdoc 内容 = api 返回的 HTML；sandbox 授 allow-scripts + allow-downloads）
    const iframe = await screen.findByTitle('Diagram preview');
    expect(iframe).toHaveAttribute('srcDoc', diagramHtml);
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-downloads');

    // 高度链（2026-09-02 用户反馈"窗口更高时图表应撑满"）：diagram 分支
    // contentRef 上 flex h-full flex-col，viewer wrapper flex-1 撑满中栏剩余高度
    const viewerWrapper = iframe.parentElement as HTMLElement;
    expect(viewerWrapper).toHaveClass('flex-1');
    expect(viewerWrapper.parentElement).toHaveClass('flex', 'h-full', 'flex-col');
    expect(mockApi.getDiagramHtml).toHaveBeenCalledWith('doc-1', 'en');

    // 正文全文通道对 diagram doc 零调用（enabled gate：docType==='diagram' 恒 disabled）
    expect(mockApi.getDocContent).not.toHaveBeenCalled();

    // v1 只读（Q5）：编辑按钮隐藏
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    // 右栏（第二个 aside）：大纲/链接健康卡隐藏，图信息卡显示渲染元数据
    // （头部折叠入口按钮固定渲染「Outline」文案，断言必须限定在右栏内）
    const rightAside = document.querySelectorAll('aside')[1] as HTMLElement;
    expect(within(rightAside).queryByText('Outline')).not.toBeInTheDocument();
    expect(within(rightAside).queryByText('Link Health')).not.toBeInTheDocument();
    expect(within(rightAside).getByText('Diagram Info')).toBeInTheDocument();
    expect(within(rightAside).getByText('architecture')).toBeInTheDocument();
    expect(within(rightAside).getByText('standard')).toBeInTheDocument();
    expect(within(rightAside).getByText('Rendered')).toBeInTheDocument();
    expect(within(rightAside).getByText('Snapshot size')).toBeInTheDocument();
    // composition 计数：0 errors（绿色）+ 2 warnings（琥珀）
    expect(within(rightAside).getByText('Errors')).toBeInTheDocument();
    expect(within(rightAside).getByText('Warnings')).toBeInTheDocument();
    expect(within(rightAside).getByText('0')).toBeInTheDocument();
    expect(within(rightAside).getByText('2')).toBeInTheDocument();
  });

  it('diagram doc 经左栏过滤扁平列表出现时用 Workflow 图标（非 diagram 仍是 FileText）', async () => {
    mockApi.getFacets.mockResolvedValue({
      types: [{ value: 'diagram', count: 1 }],
      tags: [],
      categories: [],
    });
    mockApi.listDocs.mockResolvedValue(paginated([diagramDocFixture]));

    renderPage();
    await screen.findByText('Test Space');

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'diagram' } });

    await waitFor(() => {
      expect(document.querySelector('svg.lucide-workflow')).toBeInTheDocument();
    });
    expect(document.querySelector('svg.lucide-file-text')).not.toBeInTheDocument();
  });

  it('非 diagram 回归：markdown doc 正文照常渲染、编辑按钮可见、无 iframe、getDocContent 正常调用', async () => {
    // 回归路径重置为 markdown fixture（describe 级 beforeEach 已覆盖为 diagramDocFixture）
    mockApi.getDoc.mockResolvedValue(docFixture);
    renderPage();

    // markdown 正文渲染（ReactMarkdown mock 输出行文本）
    expect(await screen.findByText('body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByTitle('Diagram preview')).not.toBeInTheDocument();
    expect(mockApi.getDocContent).toHaveBeenCalledWith('doc-1');
    expect(mockApi.getDiagramHtml).not.toHaveBeenCalled();
  });
});
