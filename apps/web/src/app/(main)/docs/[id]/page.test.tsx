import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { createElement } from 'react';
import { unzipSync } from 'fflate';
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
  // 复制 Markdown 按钮（docs.detail 命名空间）
  'docs.detail.copyMarkdown': 'Copy Markdown',
  'docs.detail.copied': 'Copied',
  'docs.detail.copyMarkdownError': 'Copy failed, please retry',
  // 空间级 bundle 导出/导入入口（导出 = 双格式菜单）
  'docs.bundle.export.title': 'Export the current space snapshot (JSON)',
  'docs.bundle.export.editingTitle': 'Exports the server-side version, excluding unsaved edits',
  'docs.bundle.export.zipFailed': 'Failed to build the human-readable export, please retry',
  'docs.bundle.export.menu.trigger': 'Export',
  'docs.bundle.export.menu.jsonLabel': 'Export bundle (JSON)',
  'docs.bundle.export.menu.jsonDesc':
    'Full snapshot: all documents + attachment bytes, restorable into the platform',
  'docs.bundle.export.menu.zipLabel': 'Export human-readable (ZIP)',
  'docs.bundle.export.menu.zipDesc':
    'docs directory tree + original attachment files, open directly',
  // ZIP 内 README 文案（真实链路走 lib 注入，这里给英文快照）
  'docs.bundle.export.readme.title': '{space} (human-readable export)',
  'docs.bundle.export.readme.exportedAt': 'Exported at: {time}',
  'docs.bundle.export.readme.docs': 'Documents: {count}',
  'docs.bundle.export.readme.attachments': 'Original attachment files: {count}',
  'docs.bundle.export.readme.unpacked': 'Attachments referenced but not packed: {count}',
  'docs.bundle.export.readme.linksRewritten': 'Attachment links were rewritten to relative paths',
  'docs.bundle.export.readme.invalidTitle': 'Documents with invalid paths',
  'docs.bundle.export.readme.invalidHint': 'These documents had illegal paths',
  'docs.bundle.export.readme.invalidItem': '`{from}` → `{to}`',
  'docs.bundle.export.readme.restoreHint':
    'This ZIP cannot be imported back; to restore, use "Export bundle (JSON)".',
  'docs.bundle.import.button': 'Import bundle',
  'docs.bundle.import.title': 'Restore documents from an export file',
  'docs.bundle.import.disabledEditing': 'Finish or cancel editing before import',
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

/** 当前会话用户角色（bundle 入口测试需要切换「全读者」与「admin」两态） */
let mockUserRole = 'admin';

jest.mock('@/stores/auth.store', () => ({
  // admin 角色 → canManage 为 true，编辑按钮可见
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: mockUserRole } }),
}));

const mockToastError = jest.fn();
const mockToastWarning = jest.fn();
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn().mockResolvedValue(true),
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
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
      exportSpaceBundle: jest.fn(),
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
// 导入对话框内部链路自带单测（import-bundle-dialog.test.tsx），本文件只验入口 + 刷新接线：
// mock 暴露 onImported / onOpenChange 触发点，并按 open 受控渲染（与真实组件同约定）
jest.mock('@/components/docs/import-bundle-dialog', () => ({
  ImportBundleDialog: ({
    open,
    onOpenChange,
    onImported,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onImported: () => void;
  }) =>
    open ? (
      <>
        <button onClick={onImported}>mock-bundle-imported</button>
        <button onClick={() => onOpenChange(false)}>mock-bundle-close</button>
      </>
    ) : null,
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
  exportSpaceBundle: jest.Mock;
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

/** 页面元素（rerender 复用：同一 QueryClient 重渲染，模拟 SPA 内换 ?doc= 而组件不卸载） */
const pageElement = (queryClient: QueryClient) => (
  <QueryClientProvider client={queryClient}>
    <DocSpaceDetailPage />
  </QueryClientProvider>
);

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(pageElement(queryClient));
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
    // 模拟服务端 tree 语义：根层返回目录 + 根级散文件；docs/ 子层返回 Alpha；
    // guides/ 子层返回独立叶子（当前 doc path = guides/t.md → 祖先链自动展开 guides/；
    // 若该层也回 treeRoot，其 folders 含 path='guides/' 且已展开 → 无界递归渲染/无界请求）
    mockApi.getTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) => {
      if (params?.prefix === 'docs/') {
        return Promise.resolve({
          prefix: 'docs/',
          folders: { items: [], total: 0, hasMore: false },
          docs: {
            items: [{ id: 'doc-3', path: 'docs/a.md', title: 'Alpha', docType: 'guide' }],
            total: 1,
            hasMore: false,
          },
        });
      }
      if (params?.prefix === 'guides/') {
        return Promise.resolve({
          prefix: 'guides/',
          folders: { items: [], total: 0, hasMore: false },
          docs: {
            items: [{ id: 'doc-1', path: 'guides/t.md', title: 'Doc T', docType: 'guide' }],
            total: 1,
            hasMore: false,
          },
        });
      }
      return Promise.resolve(treeRoot);
    });
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
    // 根层 + guides/ 子层（当前 doc path = guides/t.md → 祖先链自动展开，懒加载同步拉取）
    await waitFor(() => {
      expect(mockApi.getTree).toHaveBeenCalledTimes(2);
    });
    expect(mockApi.getTree).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ prefix: 'guides/' }),
    );
    // 不在祖先链上的目录（docs/）保持折叠，不拉子层
    expect(mockApi.getTree).not.toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ prefix: 'docs/' }),
    );
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

  it('diagram doc：复制 Markdown 按钮隐藏（IR JSON 非 markdown 原文，与 Edit 同规）', async () => {
    renderPage();
    await screen.findByTitle('Diagram preview');

    expect(screen.queryByRole('button', { name: 'Copy Markdown' })).not.toBeInTheDocument();
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

describe('DocSpaceDetailPage 复制 Markdown 原文按钮', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBase();
    // clipboard mock 先例照抄 seat-management.test.tsx:172
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
  });

  it('点击复制 → getDocContent(docId, true) 拉 full 原文 → writeText 写入 → 按钮变 Copied 态', async () => {
    mockApi.getDocContent.mockResolvedValue({ content: '# Doc T\nbody', title: 'Doc T' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Markdown' }));

    // full=true 契约：与编辑器回写同源（含首标题行）
    await waitFor(() => {
      expect(mockApi.getDocContent).toHaveBeenCalledWith('doc-1', true);
    });
    // 剪贴板写入完整原文
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Doc T\nbody');
    });
    // 反馈态：按钮文案切为 Copied
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });

  it('复制失败 → toast.error 路径；writeText 未被调用；按钮复位可重试', async () => {
    // 按 full 参数分流：渲染通道（无 full）必须成功才能渲染出 header 复制按钮；
    // 复制通道（full=true）reject 模拟复制请求失败
    mockApi.getDocContent.mockImplementation((docId: string, full?: boolean) =>
      full
        ? Promise.reject(new Error('network'))
        : Promise.resolve({ content: '# Doc T\nbody', title: 'Doc T' }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Markdown' }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith({ title: 'Copy failed, please retry' });
    });
    // 失败不写剪贴板
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    // 按钮复位（copying 已释放）：仍显示 Copy Markdown 且可再次点击重试
    const retryButton = screen.getByRole('button', { name: 'Copy Markdown' });
    expect(retryButton).not.toBeDisabled();
    fireEvent.click(retryButton);
    // 3 次 = 1 次渲染通道（无 full）+ 2 次复制请求（首次失败 + 重试）
    await waitFor(() => {
      expect(mockApi.getDocContent).toHaveBeenCalledTimes(3);
    });
  });
});

/**
 * 分类模式选中同步（D8）：activeCategorySlug gate（只有命中文档的分类才自动翻页）
 * + 命中文档所属分类折叠时自动重展开（含同分类内换文档）。
 */
describe('DocSpaceDetailPage 分类模式选中同步（activeCategorySlug gate / 折叠重展开）', () => {
  const treeDocs = [
    { id: 'doc-1', title: 'Doc T', path: 'guides/t.md', docType: 'guide' },
    { id: 'doc-2', title: 'Doc U', path: 'guides/u.md' },
    { id: 'doc-5', title: 'Gamma', path: 'guides/nested/g.md' },
    { id: 'doc-9', title: 'Misc Doc', path: 'misc/m.md' },
  ];

  /** 空间分类：cat-1（命中文档所在）+ cat-2（非命中） */
  const categorySpace = {
    ...spaceFixture,
    categories: [
      { id: 'cat-1', name: 'Guides', slug: 'guides' },
      { id: 'cat-2', name: 'Misc', slug: 'misc' },
    ],
  };

  /** 构造 listDocs 一页（hasNext/total 可控，用于多页自动翻页场景） */
  const pageOf = (items: unknown[], page: number, hasNext: boolean, total = items.length) => ({
    items,
    total,
    page,
    pageSize: 50,
    totalPages: hasNext ? page + 1 : page,
    hasNext,
    hasPrev: page > 1,
  });

  /** 指定分类收到的 listDocs 请求次数（有界断言用） */
  const callsFor = (slug: string) =>
    mockApi.listDocs.mock.calls.filter(
      ([, opts]: [string, { category?: string }?]) => opts?.category === slug,
    ).length;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockBase();
    // ?doc= 由 mockSearchParams 驱动（本 describe 内会改写，逐用例复位）
    mockSearchParams.set('doc', 'doc-1');
    mockApi.getSpace.mockResolvedValue(categorySpace);
    mockApi.getFacets.mockResolvedValue({
      types: [],
      tags: [],
      categories: [
        { slug: 'guides', name: 'Guides', count: 2 },
        { slug: 'misc', name: 'Misc', count: 1 },
      ],
    });
    // 当前文档属于 cat-1（slug=guides）
    mockApi.getDoc.mockResolvedValue({ ...docFixture, categoryId: 'cat-1' });
    mockApi.getTree.mockResolvedValue(emptyTree);
    localStorage.setItem('docs:sidebar-mode', 'category');
  });

  afterEach(() => {
    mockSearchParams.set('doc', 'doc-1');
  });

  it('gate：非命中分类恰好 1 次请求；命中分类自动翻到目标所在页后停止（有界）', async () => {
    mockApi.listDocs.mockImplementation(
      (_spaceId: string, opts?: { category?: string; page?: number }) => {
        if (opts?.category === 'guides') {
          // 目标 doc-1 在第 2 页（第 1 页只有别的文档）→ 自动翻一页命中
          return opts?.page === 2
            ? Promise.resolve(pageOf([treeDocs[0], treeDocs[1]], 2, false, 3))
            : Promise.resolve(pageOf([treeDocs[2]], 1, true, 3));
        }
        // 非命中分类：hasNext 恒 true——缺 gate 时会一路翻到页数上限（本断言即防此）
        return Promise.resolve(pageOf([treeDocs[3]], 1, true, 100));
      },
    );

    renderPage();
    await screen.findByText('Test Space');

    await waitFor(() => {
      expect(mockApi.listDocs).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ category: 'guides', page: 2 }),
      );
    });
    expect(callsFor('guides')).toBe(2); // 第 2 页命中即停（不再继续翻）
    expect(callsFor('misc')).toBe(1); // 非命中分类零翻页
  });

  it('命中文档所属分类折叠时自动重展开；同分类内换文档（categoryId 不变）也重展开', async () => {
    mockApi.listDocs.mockImplementation((_spaceId: string, opts?: { category?: string }) =>
      opts?.category === 'guides'
        ? Promise.resolve(paginated([treeDocs[0], treeDocs[1], treeDocs[2]]))
        : Promise.resolve(paginated([])),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(pageElement(queryClient));
    await screen.findByText('Test Space');
    // 分类区块展开态：Guides 下文档可见（Gamma 只出现在分类列表，避免多重匹配）
    expect(await screen.findByText('Gamma')).toBeInTheDocument();

    // 用户手动折叠 Guides
    fireEvent.click(screen.getByText('Guides'));
    expect(screen.queryByText('Gamma')).not.toBeInTheDocument();

    // 同分类内换文档：selectedDocId 变、categoryId 不变 → 分类重展开（D8 复核新-3）
    // 顺带断言重展开后的新 active 行滚动到可视区（DocTreeItem 的 D5 滚动，清记录后看新增调用）
    const scrollSpy = Element.prototype.scrollIntoView as unknown as jest.Mock;
    scrollSpy.mockClear();
    mockSearchParams.set('doc', 'doc-2');
    view.rerender(pageElement(queryClient));

    expect(await screen.findByText('Gamma')).toBeInTheDocument();
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1); // 仅新 active 行（doc-2）滚动
  });
});

/**
 * 空间级 bundle 导出/导入入口（页头按钮 + 导出下载链路）。
 * 对话框内部链路（五态机/预检/结果面板）见 import-bundle-dialog.test.tsx。
 */
describe('DocSpaceDetailPage 空间级 bundle 导出/导入入口', () => {
  /** 导出端点返回的 bundle（apiRequest 已解包 → 返回的就是 bundle 本体） */
  const bundleFixture = {
    formatVersion: 2,
    exportedAt: '2026-09-15T00:00:00Z',
    space: { name: 'Test Space', visibility: 'open' },
    docs: [{ path: 'a.md' }],
  };

  /** 用 FileReader 读 Blob 文本（jsdom 的 Blob 未实现 text()） */
  const readBlob = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });

  /** 用 FileReader 读 Blob 字节（ZIP 断言用；jsdom 的 Blob 未实现 arrayBuffer()） */
  const readBlobBytes = (blob: Blob) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });

  /** 最近一次锚点点击的 download 属性（click 被 stub，改在 stub 内记录） */
  let clickedDownload = '';
  const anchorDownloadName = () => clickedDownload;

  /** ZIP 根目录名（lib 用 now 生成，测试内按当天 UTC 复算，避免硬编码日期） */
  const zipRoot = `docspace-test-space-${new Date().toISOString().slice(0, 10)}`;

  let createObjectURL: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockBase();
    mockUserRole = 'admin';
    mockApi.exportSpaceBundle.mockResolvedValue(bundleFixture);
    createObjectURL = jest.fn(() => 'blob:test');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
    // 锚点点击在 jsdom 会触发未实现的导航，桩掉（顺带记录 download 名）
    clickedDownload = '';
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedDownload = this.download;
    });
  });

  afterEach(() => {
    mockUserRole = 'admin';
    jest.restoreAllMocks();
  });

  it('导出菜单对全读者可见；导入按钮仅 canManage 可见（非作者非编辑者无导入入口）', async () => {
    mockUserRole = 'user';
    mockApi.getSpace.mockResolvedValue({ ...spaceFixture, creatorId: 'other' });

    renderPage();
    await screen.findByText('Test Space');

    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import bundle' })).not.toBeInTheDocument();
  });

  it('canManage 时导入按钮可见且带 title', async () => {
    renderPage();
    await screen.findByText('Test Space');

    const importButton = await screen.findByRole('button', { name: 'Import bundle' });
    expect(importButton).toBeEnabled();
    expect(importButton).toHaveAttribute('title', 'Restore documents from an export file');
  });

  it('点触发钮 → 浮层两选项各带一行说明（认知差异写在选项旁）', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));

    const jsonItem = await screen.findByTestId('export-menu-json');
    const zipItem = screen.getByTestId('export-menu-zip');
    expect(within(jsonItem).getByText('Export bundle (JSON)')).toBeInTheDocument();
    expect(
      within(jsonItem).getByText(
        'Full snapshot: all documents + attachment bytes, restorable into the platform',
      ),
    ).toBeInTheDocument();
    expect(within(zipItem).getByText('Export human-readable (ZIP)')).toBeInTheDocument();
    expect(
      within(zipItem).getByText('docs directory tree + original attachment files, open directly'),
    ).toBeInTheDocument();
  });

  it('选 JSON 项 → 拉取 bundle 并下载 pretty JSON（Blob type + createObjectURL + 延时 revoke）', async () => {
    jest.useFakeTimers();
    const revokeSpy = URL.revokeObjectURL as jest.Mock;
    renderPage();
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByTestId('export-menu-json'));

    await waitFor(() => expect(mockApi.exportSpaceBundle).toHaveBeenCalledWith('space-1'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    const text = await readBlob(blob);
    expect(JSON.parse(text)).toEqual(bundleFixture);
    expect(text).toContain('\n  '); // pretty 打印（后端用途 = 落 git diff / 离线备份）
    // 导出后自检未超限 → 不弹警告
    expect(mockToastWarning).not.toHaveBeenCalled();
    // 选项点击后浮层关闭（动作与关闭链路解耦，但不留悬挂浮层）
    expect(screen.queryByTestId('export-menu-panel')).not.toBeInTheDocument();

    // revoke 延时 1s（数 MB 下载防中断）
    expect(revokeSpy).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(revokeSpy).toHaveBeenCalledWith('blob:test');
    jest.useRealTimers();
  });

  it('选 ZIP 项 → 同一 endpoint 拉 bundle，下载 application/zip（内容可解出 README + docs 条目）', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByTestId('export-menu-zip'));

    await waitFor(() => expect(mockApi.exportSpaceBundle).toHaveBeenCalledWith('space-1'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/zip');
    // ZIP 条目表由 lib 单测覆盖，这里只验页面接线产出的是**可解压的合法 zip** 且根目录就位
    const bytes = await readBlobBytes(blob);
    const unzipped = unzipSync(bytes);
    const entries = Object.keys(unzipped).sort();
    expect(entries).toContain(`${zipRoot}/README.md`);
    expect(entries).toContain(`${zipRoot}/a.md`);
    // jsdom 无 TextDecoder，解码走 Node Buffer（与 lib 手写 UTF-8 逐字节可比）
    expect(Buffer.from(unzipped[`${zipRoot}/README.md`]).toString('utf8')).toContain(
      'cannot be imported back',
    );
    // 下载名 = 根目录名 + .zip（由锚点 download 属性决定）
    expect(anchorDownloadName()).toBe(`${zipRoot}.zip`);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('ZIP 生成失败 → zip 专属失败 toast（与 JSON 失败文案区分）', async () => {
    mockApi.exportSpaceBundle.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByTestId('export-menu-zip'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith({ title: 'boom' }));
  });

  it('编辑中：导入按钮禁用并给出原因；导出触发钮不禁用，仅 title 提示不含未保存编辑（R4）', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const importButton = await screen.findByRole('button', { name: 'Import bundle' });
    expect(importButton).toBeDisabled();
    expect(importButton).toHaveAttribute('title', 'Finish or cancel editing before import');

    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(exportButton).toBeEnabled();
    expect(exportButton).toHaveAttribute(
      'title',
      'Exports the server-side version, excluding unsaved edits',
    );
  });

  it('页头按钮组 flex-wrap justify-end；三栏定高改 xl 限定（去掉行内 style）', async () => {
    renderPage();
    await screen.findByText('Test Space');

    const exportTrigger = await screen.findByRole('button', { name: 'Export' });
    // 菜单根容器（relative）在页头按钮组内 —— 触发钮多了一层菜单包裹，故取祖父节点
    expect(exportTrigger.closest('[data-testid="export-menu"]')?.parentElement).toHaveClass(
      'flex-wrap',
      'justify-end',
    );

    const firstAside = document.querySelector('aside') as HTMLElement;
    const columns = firstAside.parentElement as HTMLElement;
    expect(columns).toHaveClass('xl:h-[calc(100vh-9rem)]');
    // 行内定高已移除：<xl 时三栏自然流式滚动，按钮换行不再把底边顶出视口
    expect(columns).not.toHaveAttribute('style');
  });
});

/**
 * 回导成功后的刷新清单（D5）：空间/树/聚合四键 + 正文类查询**整类前缀失效**。
 *
 * 用 open/onOpenChange 受控的 mock 对话框触发 onImported（真实对话框内部链路见其自身单测）。
 */
describe('DocSpaceDetailPage 回导成功后查询失效清单（D5）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBase();
    mockUserRole = 'admin';
  });

  afterEach(() => {
    mockUserRole = 'admin';
    jest.restoreAllMocks();
  });

  it('onImported → 空间四键 + doc/doc-content/doc-content-full/filtered/search-docs/search 前缀全部失效', async () => {
    const invalidateSpy = jest.spyOn(QueryClient.prototype, 'invalidateQueries');

    renderPage();
    await screen.findByText('Test Space');

    // 对话框受控：未开始时 mock 不渲染任何内容
    expect(screen.queryByRole('button', { name: 'mock-bundle-imported' })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Import bundle' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-bundle-imported' }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });
    const invalidated = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey?: unknown[] } | undefined)?.queryKey,
    );
    expect(invalidated).toEqual(
      expect.arrayContaining([
        ['docs', 'space', 'space-1'],
        ['docs', 'tree'],
        ['docs', 'facets'],
        ['docs', 'spaces'],
        ['docs', 'doc'],
        ['docs', 'doc-content'],
        ['docs', 'doc-content-full'],
        ['docs', 'filtered'],
        ['docs', 'search-docs'],
        ['docs', 'search'],
      ]),
    );
  });

  it('关闭对话框走 onOpenChange（受控开关由页面持有）', async () => {
    renderPage();
    await screen.findByText('Test Space');

    fireEvent.click(await screen.findByRole('button', { name: 'Import bundle' }));
    expect(screen.getByRole('button', { name: 'mock-bundle-imported' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'mock-bundle-close' }));
    expect(screen.queryByRole('button', { name: 'mock-bundle-imported' })).not.toBeInTheDocument();
  });
});
