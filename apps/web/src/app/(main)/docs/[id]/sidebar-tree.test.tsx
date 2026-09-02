import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarTree } from './sidebar-tree';
import { Api } from '@/lib/api';

/** 文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'docs.detail.loadMore': 'Load more',
  'docs.detail.loadMoreFolders': 'Load more folders',
  'docs.detail.noDocs': 'No docs yet',
};

jest.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return messages[fullKey] ?? fullKey;
  },
}));

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      getTree: jest.fn(),
    },
  },
}));

const mockGetTree = Api.docs.getTree as jest.Mock;

/** 构造 tree 端点页响应（folders/docs 各自分页信封） */
const treePage = (
  prefix: string,
  folders: { path: string; name: string; docCount: number }[],
  docs: { id: string; path: string; title: string; docType?: string | null }[],
  opts: {
    foldersTotal?: number;
    foldersHasMore?: boolean;
    docsTotal?: number;
    docsHasMore?: boolean;
  } = {},
) => ({
  prefix,
  folders: {
    items: folders,
    total: opts.foldersTotal ?? folders.length,
    hasMore: opts.foldersHasMore ?? false,
  },
  docs: {
    items: docs,
    total: opts.docsTotal ?? docs.length,
    hasMore: opts.docsHasMore ?? false,
  },
});

function renderTree() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SidebarTree spaceId="space-1" activeDocId={null} onSelectDoc={jest.fn()} />
    </QueryClientProvider>,
  );
}

describe('SidebarTree 懒加载目录树', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('根层渲染 folders + docs；文件夹行显示 docCount', async () => {
    mockGetTree.mockResolvedValue(
      treePage(
        '',
        [{ path: 'docs/', name: 'docs', docCount: 3 }],
        [{ id: 'doc-2', path: 'README.md', title: 'Readme' }],
      ),
    );

    renderTree();

    expect(await screen.findByText('docs')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // docCount
    // 行标签（2026-09-02 拍板）：文件名为主（去 .md）；标题≈文件名时去重不显示
    expect(screen.getByText('README')).toBeInTheDocument();
    expect(screen.queryByText('Readme')).not.toBeInTheDocument();
    // 根层只发一次请求（prefix=''）
    expect(mockGetTree).toHaveBeenCalledTimes(1);
    expect(mockGetTree).toHaveBeenCalledWith('space-1', expect.objectContaining({ prefix: '' }));
  });

  it('目录默认全折叠：展开前不请求子层，点击展开才拉取下一层', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) =>
      params?.prefix === 'docs/'
        ? Promise.resolve(
            treePage('docs/', [], [{ id: 'doc-3', path: 'docs/a.md', title: 'Alpha' }]),
          )
        : Promise.resolve(treePage('', [{ path: 'docs/', name: 'docs', docCount: 1 }], [])),
    );

    renderTree();
    await screen.findByText('docs');

    // 未展开：子层查询未挂载（只发过根层请求）
    expect(mockGetTree).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('docs'));

    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ prefix: 'docs/' }),
      );
    });
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('展开态 localStorage 持久化：刷新后保持展开并自动拉取子层（P1）', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) =>
      params?.prefix === 'docs/'
        ? Promise.resolve(
            treePage('docs/', [], [{ id: 'doc-3', path: 'docs/a.md', title: 'Alpha' }]),
          )
        : Promise.resolve(treePage('', [{ path: 'docs/', name: 'docs', docCount: 1 }], [])),
    );

    const first = renderTree();
    fireEvent.click(await screen.findByText('docs'));
    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ prefix: 'docs/' }),
      );
    });
    // 展开态已写入 localStorage
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders') ?? '[]')).toEqual(['docs/']);

    // 卸载后重新挂载（新 QueryClient 模拟刷新）：挂载即按存储值展开并拉取子层
    first.unmount();
    mockGetTree.mockClear();
    renderTree();

    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ prefix: 'docs/' }),
      );
    });
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('文档「加载更多」：docs.hasMore 时显示按钮，点击以 docsOffset 翻页（useInfiniteQuery 游标）', async () => {
    // 首页满额 50 条 → 游标推进到 docsOffset=50；第二页返回剩余 10 条
    const page1Docs = Array.from({ length: 50 }, (_, i) => ({
      id: `doc-${i + 1}`,
      path: `d${i + 1}.md`,
      title: `D${i + 1}`,
    }));
    mockGetTree.mockImplementation((_spaceId: string, params?: { docsOffset?: number }) =>
      params?.docsOffset === 50
        ? Promise.resolve(
            treePage(
              '',
              [],
              Array.from({ length: 10 }, (_, i) => ({
                id: `doc-${i + 51}`,
                path: `d${i + 51}.md`,
                title: `D${i + 51}`,
              })),
              { docsTotal: 60, docsHasMore: false },
            ),
          )
        : Promise.resolve(treePage('', [], page1Docs, { docsTotal: 60, docsHasMore: true })),
    );

    renderTree();
    fireEvent.click(await screen.findByText('Load more'));

    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ docsOffset: 50 }),
      );
    });
    expect(await screen.findByText('d51')).toBeInTheDocument(); // 标题≈文件名去重 → 主标签为文件名（去 .md）
  });

  it('目录「加载更多」：folders.hasMore 时显示按钮，点击以 foldersOffset 翻页', async () => {
    // 首页满额 200 个目录 → 游标推进到 foldersOffset=200；第二页返回剩余 1 个
    const page1Folders = Array.from({ length: 200 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}/`,
      name: `f${String(i).padStart(3, '0')}`,
      docCount: 1,
    }));
    mockGetTree.mockImplementation((_spaceId: string, params?: { foldersOffset?: number }) =>
      params?.foldersOffset === 200
        ? Promise.resolve(
            treePage('', [{ path: 'zzz/', name: 'zzz', docCount: 1 }], [], {
              foldersTotal: 201,
            }),
          )
        : Promise.resolve(
            treePage('', page1Folders, [], { foldersTotal: 201, foldersHasMore: true }),
          ),
    );

    renderTree();
    fireEvent.click(await screen.findByText('Load more folders'));

    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ foldersOffset: 200 }),
      );
    });
    expect(await screen.findByText('zzz')).toBeInTheDocument();
  });

  it('行标签：文件名主 + 标题辅双标签；同层 docType 全同时徽标整层降噪', async () => {
    mockGetTree.mockResolvedValue(
      treePage(
        '',
        [],
        [
          { id: 'doc-1', path: 'memory/2026-09-01.md', title: '今日任务', docType: 'memory' },
          { id: 'doc-2', path: 'memory/2026-09-02.md', title: '三修实录', docType: 'memory' },
        ],
      ),
    );

    renderTree();

    // 文件名主标签（去 .md）+ 标题辅标签同时在场
    expect(await screen.findByText('2026-09-01')).toBeInTheDocument();
    expect(screen.getByText('今日任务')).toBeInTheDocument();
    expect(screen.getByText('2026-09-02')).toBeInTheDocument();
    expect(screen.getByText('三修实录')).toBeInTheDocument();
    // 同层全 memory → 徽标整层隐藏（77 个 memory 徽标纯噪声场景）
    expect(screen.queryByText('memory')).not.toBeInTheDocument();
  });

  it('徽标：同层 docType 混合时保留（消歧价值所在）', async () => {
    mockGetTree.mockResolvedValue(
      treePage(
        '',
        [],
        [
          { id: 'doc-1', path: 'a.md', title: 'A 文档', docType: 'guide' },
          { id: 'doc-2', path: 'b.md', title: 'B 文档', docType: 'memory' },
        ],
      ),
    );

    renderTree();

    expect(await screen.findByText('guide')).toBeInTheDocument();
    expect(screen.getByText('memory')).toBeInTheDocument();
  });

  it('空空间：根层无 folders/docs 时显示「暂无文档」', async () => {
    mockGetTree.mockResolvedValue(treePage('', [], []));

    renderTree();

    expect(await screen.findByText('No docs yet')).toBeInTheDocument();
  });
});
