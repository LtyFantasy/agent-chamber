import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SidebarTree, ancestorPrefixes } from './sidebar-tree';
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

/** 层树元素（rerender 复用：同一 QueryClient 重渲染，模拟组件不卸载、仅 props 变化） */
const treeElement = (
  queryClient: QueryClient,
  props: Partial<ComponentProps<typeof SidebarTree>> = {},
) => (
  <QueryClientProvider client={queryClient}>
    <SidebarTree spaceId="space-1" activeDocId={null} onSelectDoc={jest.fn()} {...props} />
  </QueryClientProvider>
);

function renderTree(
  props: Partial<ComponentProps<typeof SidebarTree>> = {},
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(treeElement(queryClient, props));
}

/** 模拟后端 docsLimit=50 的分页文档批（id/path 同号，便于按页构造"目标落在第 N 页"） */
const docBatch = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `doc-${start + i}`,
    path: `d${start + i}.md`,
    title: `Doc ${start + i}`,
  }));

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
    // 展开态已写入 localStorage（按空间分片的 key，D3a）
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders:space-1') ?? '[]')).toEqual([
      'docs/',
    ]);

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

/**
 * 选中态随正文内链跳转同步（v1.7x 需求）：目标行"出现并可见" = 自动展开祖先链
 * + 层内有界自动翻页 + 高亮（现成）+ 滚动到可视区。
 * 用例编号与 plan（T1-T7/T2b）一一对应，T2b 是 D10 竞态专杀。
 */
describe('SidebarTree 选中态同步（内链跳转 / ?doc= 直达）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('T1 自动展开祖先链，且与已存展开态合并（不覆盖用户已展开的目录）', async () => {
    // ancestorPrefixes 纯函数边界：多级取全链、根级文档为空
    expect(ancestorPrefixes('a/b/c.md')).toEqual(['a/', 'a/b/']);
    expect(ancestorPrefixes('README.md')).toEqual([]);

    // 预置展开态（按空间分片的 key）：other/ 在用户上次会话中已展开
    localStorage.setItem('docs:expanded-folders:space-1', JSON.stringify(['other/']));
    mockGetTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) =>
      params?.prefix === 'docs/'
        ? Promise.resolve(
            treePage('docs/', [], [{ id: 'doc-3', path: 'docs/a.md', title: 'Alpha' }]),
          )
        : params?.prefix === 'other/'
          ? Promise.resolve(treePage('other/', [], []))
          : Promise.resolve(
              treePage(
                '',
                [
                  { path: 'other/', name: 'other', docCount: 1 },
                  { path: 'docs/', name: 'docs', docCount: 1 },
                ],
                [],
              ),
            ),
    );

    renderTree({ activeDocId: 'doc-3', activeDocPath: 'docs/a.md' });

    // 祖先链 docs/ 被自动展开（子层查询挂载并渲染出目标行）
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    // 持久化的 other/ 未被覆盖（合并不是替换）
    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ prefix: 'other/' }),
      );
    });
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders:space-1') ?? '[]')).toEqual([
      'other/',
      'docs/',
    ]);
  });

  it('T2 目标落在第 3 页：层内自动翻页直到目标行出现并高亮', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { docsOffset?: number }) => {
      const docsOffset = params?.docsOffset ?? 0;
      if (docsOffset === 100) {
        return Promise.resolve(
          treePage('', [], docBatch(101, 1), { docsTotal: 101, docsHasMore: false }),
        );
      }
      if (docsOffset === 50) {
        return Promise.resolve(
          treePage('', [], docBatch(51, 50), { docsTotal: 101, docsHasMore: true }),
        );
      }
      return Promise.resolve(
        treePage('', [], docBatch(1, 50), { docsTotal: 101, docsHasMore: true }),
      );
    });

    renderTree({ activeDocId: 'doc-101', activeDocPath: 'd101.md' });

    // 目标行（第 3 页）自动出现，无需用户点「加载更多」
    const targetRow = (await screen.findByText('d101')).closest('button');
    expect(targetRow).toHaveClass('bg-primary/10'); // 高亮现成
    // 恰好翻两次（50 → 100），第 3 页到手即收敛
    expect(mockGetTree).toHaveBeenCalledTimes(3);
    expect(mockGetTree).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ docsOffset: 100 }),
    );
  });

  it('T2b 竞态：activeDocPath 由 null（doc 未就绪）→ 值 时已挂载层仍自动翻到目标页（D10）', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { docsOffset?: number }) => {
      const docsOffset = params?.docsOffset ?? 0;
      if (docsOffset === 100) {
        return Promise.resolve(
          treePage('', [], docBatch(101, 1), { docsTotal: 101, docsHasMore: false }),
        );
      }
      if (docsOffset === 50) {
        return Promise.resolve(
          treePage('', [], docBatch(51, 50), { docsTotal: 101, docsHasMore: true }),
        );
      }
      return Promise.resolve(
        treePage('', [], docBatch(1, 50), { docsTotal: 101, docsHasMore: true }),
      );
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 首屏：doc 元数据尚未就绪（path 为 null）→ 不能翻页（无从判断目标在哪一层）
    const view = renderTree({ activeDocId: null, activeDocPath: null }, queryClient);
    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('d101')).not.toBeInTheDocument();

    // doc 就绪：同一层实例（复用重渲染，非重挂载）收到 path——effect deps 缺 path 标量时
    // 这里会静默永不翻页（本用例即该竞态专杀）
    view.rerender(treeElement(queryClient, { activeDocId: 'doc-101', activeDocPath: 'd101.md' }));

    expect(await screen.findByText('d101')).toBeInTheDocument();
    expect(mockGetTree).toHaveBeenCalledTimes(3);
  });

  it('T3 中间目录落在第 2 页：folders 侧自动翻页找到并展开该目录', async () => {
    // folders 排序（updated_at DESC，无 tie-break）变动时 offset 分页可能跳行，
    // "翻到找到" 对中间目录只是尽力而为（B4 已接受 + follow-up 补 tie-break）
    const page1Folders = Array.from({ length: 200 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}/`,
      name: `f${String(i).padStart(3, '0')}`,
      docCount: 1,
    }));
    mockGetTree.mockImplementation(
      (_spaceId: string, params?: { prefix?: string; foldersOffset?: number }) => {
        if (params?.prefix === 'f200/') {
          return Promise.resolve(
            treePage('f200/', [], [{ id: 'doc-9', path: 'f200/a.md', title: 'Alpha' }]),
          );
        }
        if ((params?.foldersOffset ?? 0) === 200) {
          return Promise.resolve(
            treePage('', [{ path: 'f200/', name: 'f200', docCount: 1 }], [], {
              foldersTotal: 201,
              foldersHasMore: false,
            }),
          );
        }
        return Promise.resolve(
          treePage('', page1Folders, [], { foldersTotal: 201, foldersHasMore: true }),
        );
      },
    );

    renderTree({ activeDocId: 'doc-9', activeDocPath: 'f200/a.md' });

    // 中间目录被自动翻出并展开 → 目标行出现
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(mockGetTree).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ foldersOffset: 200 }),
    );
  });

  it('T4 目标不在树中：翻到 hasMore 耗尽即停（请求次数有界、无高亮行）', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { docsOffset?: number }) => {
      const docsOffset = params?.docsOffset ?? 0;
      if (docsOffset === 50) {
        return Promise.resolve(
          treePage('', [], docBatch(51, 10), { docsTotal: 60, docsHasMore: false }),
        );
      }
      return Promise.resolve(
        treePage('', [], docBatch(1, 50), { docsTotal: 60, docsHasMore: true }),
      );
    });

    renderTree({ activeDocId: 'doc-missing', activeDocPath: 'missing.md' });

    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledTimes(2);
    });
    // 收敛后再等一轮：确认没有继续翻页（有界）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockGetTree).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('missing')).not.toBeInTheDocument();
    expect(document.querySelectorAll('button.bg-primary\\/10')).toHaveLength(0);
  });

  it('T4b 翻页请求持续失败：isFetchNextPageError 护栏让重试有界（D9）', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { docsOffset?: number }) =>
      (params?.docsOffset ?? 0) === 0
        ? Promise.resolve(treePage('', [], docBatch(1, 50), { docsTotal: 101, docsHasMore: true }))
        : Promise.reject(new Error('boom')),
    );

    renderTree({ activeDocId: 'doc-101', activeDocPath: 'd101.md' });

    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 失败态下不再发起翻页（无护栏时 hasMore 恒 true → 无界重试风暴）
    expect(mockGetTree).toHaveBeenCalledTimes(2);
  });

  it('T5 选中行滚动到可视区：仅 active 行触发 scrollIntoView({ block: "nearest" })', async () => {
    mockGetTree.mockResolvedValue(
      treePage(
        '',
        [],
        [
          { id: 'doc-1', path: 'a.md', title: 'Doc A' },
          { id: 'doc-2', path: 'b.md', title: 'Doc B' },
        ],
      ),
    );

    const spy = Element.prototype.scrollIntoView as unknown as jest.Mock;
    renderTree({ activeDocId: 'doc-2', activeDocPath: 'b.md' });

    const activeRow = (await screen.findByText('b')).closest('button');
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
    });
    expect(spy).toHaveBeenCalledTimes(1); // 非 active 行不滚动
    expect(spy.mock.instances).toContain(activeRow);
  });

  it('T6 只增不夺：手动折叠后不被反抢；再次导航到该子树内文档才重展开（D2）', async () => {
    mockGetTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) =>
      params?.prefix === 'docs/'
        ? Promise.resolve(
            treePage(
              'docs/',
              [],
              [
                { id: 'doc-3', path: 'docs/a.md', title: 'Alpha' },
                { id: 'doc-4', path: 'docs/b.md', title: 'Beta' },
              ],
            ),
          )
        : Promise.resolve(treePage('', [{ path: 'docs/', name: 'docs', docCount: 2 }], [])),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderTree({ activeDocId: 'doc-3', activeDocPath: 'docs/a.md' }, queryClient);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();

    // 用户手动折叠：子层隐藏 + 持久化同步移出（不反抢）
    fireEvent.click(screen.getByText('docs'));
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders:space-1') ?? '[]')).toEqual([]);

    // 无关重渲染（同 path，如父组件普通重渲染）：保持折叠、不写回
    view.rerender(treeElement(queryClient, { activeDocId: 'doc-3', activeDocPath: 'docs/a.md' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders:space-1') ?? '[]')).toEqual([]);

    // 再次导航到该子树内的另一篇文档（path 变化）→ 重新展开并高亮新目标
    view.rerender(treeElement(queryClient, { activeDocId: 'doc-4', activeDocPath: 'docs/b.md' }));
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders:space-1') ?? '[]')).toEqual([
      'docs/',
    ]);
  });

  it('T7 展开态按空间分片：写读均带 spaceId，旧全局 key 不读不删（D3a）', async () => {
    localStorage.setItem('docs:expanded-folders', JSON.stringify(['legacy/']));
    localStorage.setItem('docs:expanded-folders:space-1', JSON.stringify(['docs/']));
    mockGetTree.mockImplementation((_spaceId: string, params?: { prefix?: string }) =>
      params?.prefix === 'docs/'
        ? Promise.resolve(treePage('docs/', [], []))
        : Promise.resolve(
            treePage(
              '',
              [
                { path: 'docs/', name: 'docs', docCount: 0 },
                { path: 'legacy/', name: 'legacy', docCount: 0 },
              ],
              [],
            ),
          ),
    );

    renderTree();

    // 读：只认分片 key（docs/ 展开），旧全局 key 的 legacy/ 不被展开
    await waitFor(() => {
      expect(mockGetTree).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({ prefix: 'docs/' }),
      );
    });
    expect(mockGetTree).not.toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ prefix: 'legacy/' }),
    );

    // 写：折叠 docs/ 落分片 key；旧全局 key 原样保留（不读不删）
    fireEvent.click(screen.getByText('docs'));
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders:space-1') ?? 'null')).toEqual([]);
    expect(JSON.parse(localStorage.getItem('docs:expanded-folders') ?? 'null')).toEqual([
      'legacy/',
    ]);
  });
});
