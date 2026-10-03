import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DocBacklinksCard } from './doc-backlinks-card';
import { Api } from '@/lib/api';
import type { DocBacklinks, DocBacklinksSource } from '@/types';

/**
 * 反向引用卡片契约测试（v1.90.0-dev）。
 *
 * 覆盖：门控（!docId 零渲染）/ 三态（骨架 / 错误 + 重试 / 空）/ 标题双计数口径 /
 * 组行信息层级（文件名 + 首处 section 末段 + N 处）/ 组级形态徽标（含混合组不显示）/
 * 两级展开（首屏 5 组 + 「还有 N 篇」可收起、组行展开为逐处行）/ aria-label 契约 /
 * 点击回调的 section 直达参数 / 切文档展开态复位。
 *
 * 文案断言走测试侧 en 快照（本仓惯例，见 seat-presence-popover.test.tsx）：en.json 里
 * title / hits / expandMore / rowAria 是 ICU plural，简化 mock 只做 `{param}` 替换，
 * 故此处快照写成占位形态——断言的是「参数化后的可见文案」，ICU 渲染本身归 next-intl。
 */
const messages: Record<string, string> = {
  'docs.backlinks.title': 'Referenced by {docCount} docs · {linkCount} links',
  'docs.backlinks.titlePlain': 'Backlinks',
  'docs.backlinks.empty': 'No documents link here yet',
  'docs.backlinks.error': 'Failed to load backlinks',
  'docs.backlinks.noHeading': 'Top of doc',
  'docs.backlinks.expandMore': '{count} more',
  'docs.backlinks.collapse': 'Show less',
  'docs.backlinks.hits': '{count} links',
  'docs.backlinks.rowAria': 'Source {title} ({path}) — {count} links: {targets}',
  'docs.backlinks.pathBasedBadge': 'Relative path',
  'docs.backlinks.platformBadge': 'Platform link',
  'docs.backlinks.pathBasedHint': 'Needs rewriting after a move',
  'common.retry': 'Retry',
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

jest.mock('@/lib/api', () => ({
  Api: { docs: { getBacklinks: jest.fn() } },
}));

const mockGetBacklinks = (Api.docs as unknown as { getBacklinks: jest.Mock }).getBacklinks;

/** 入链条目 fixture（默认 = 相对 .md 路径命中 "Top § Intro"） */
const link = (over: Partial<DocBacklinksSource['links'][number]> = {}) => ({
  href: '../beta.md',
  isPathBased: true,
  sectionPosition: 0,
  headingPath: 'Top § Intro',
  ...over,
});

/** 来源分组 fixture */
const source = (over: Partial<DocBacklinksSource> = {}): DocBacklinksSource => ({
  sourceDocId: 'src-1',
  sourcePath: 'guides/alpha.md',
  sourceTitle: 'Alpha Guide',
  links: [link()],
  ...over,
});

/** 响应 fixture：docCount/linkCount 由 sources 推导（与后端组装口径一致） */
const backlinks = (sources: DocBacklinksSource[]): DocBacklinks => ({
  docId: 'doc-1',
  path: 'guides/target.md',
  docCount: sources.length,
  linkCount: sources.reduce((n, s) => n + s.links.length, 0),
  sources,
});

/** 三组 fixture：单处相对路径 / 两处平台链接（含一无 heading 命中）/ 混合形态 */
const THREE_SOURCES: DocBacklinksSource[] = [
  source(),
  source({
    sourceDocId: 'src-2',
    sourcePath: 'beta.md',
    sourceTitle: 'Beta',
    links: [
      link({ href: '/docs/sp?doc=doc-1', isPathBased: false, headingPath: 'Beta § Usage' }),
      link({ href: '/docs/sp?doc=doc-1#anchor', isPathBased: false, headingPath: null }),
    ],
  }),
  source({
    sourceDocId: 'src-3',
    sourcePath: 'mixed.md',
    sourceTitle: 'Mixed',
    links: [
      link({ href: '../target.md', isPathBased: true, headingPath: 'M § One' }),
      link({ href: '/docs/sp?doc=doc-1', isPathBased: false, headingPath: 'M § Two' }),
    ],
  }),
];

/** 生成 N 个单处来源（「还有 N 篇」/ 复位用例需要 > 5 组）；第 1 组给两处便于测组内展开 */
const manySources = (count: number): DocBacklinksSource[] =>
  Array.from({ length: count }, (_, i) =>
    source({
      sourceDocId: `src-${i + 1}`,
      sourcePath: `d/doc-${i + 1}.md`,
      sourceTitle: `Doc ${i + 1}`,
      links:
        i === 0
          ? [link(), link({ href: '../second.md', headingPath: 'A § Second' })]
          : [link({ headingPath: `D § S${i + 1}` })],
    }),
  );

function renderCard(initial: Partial<ComponentProps<typeof DocBacklinksCard>> = {}) {
  const onSelectDoc = jest.fn();
  // retry: false —— 查询失败立即进入 isError，避免默认重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (props: Partial<ComponentProps<typeof DocBacklinksCard>>) => (
    <QueryClientProvider client={queryClient}>
      <DocBacklinksCard docId="doc-1" onSelectDoc={onSelectDoc} {...props} />
    </QueryClientProvider>
  );
  const view = render(element(initial));
  return {
    onSelectDoc,
    unmount: view.unmount,
    rerenderCard: (props: Partial<ComponentProps<typeof DocBacklinksCard>>) =>
      view.rerender(element(props)),
  };
}

/** 组行按钮（accessible name = rowAria 模板，含来源 title） */
const groupRow = (title: string) =>
  screen.getByRole('button', { name: new RegExp(`Source ${title}`) });

beforeEach(() => {
  mockGetBacklinks.mockReset();
});

describe('DocBacklinksCard 门控与三态', () => {
  it('docId 为 null → 零渲染且不发请求（未选文档时本卡无主语）', () => {
    const { rerenderCard } = renderCard({ docId: null });

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(mockGetBacklinks).not.toHaveBeenCalled();
    rerenderCard({ docId: null });
    expect(mockGetBacklinks).not.toHaveBeenCalled();
  });

  it('加载中 → 固定高骨架 + 无计数标题（不拿 0 冒充已知）', async () => {
    mockGetBacklinks.mockReturnValue(new Promise(() => {}));
    renderCard();

    expect(await screen.findByTestId('backlinks-skeleton')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backlinks' })).toBeInTheDocument();
    expect(screen.queryByText(/Referenced by/)).not.toBeInTheDocument();
    expect(mockGetBacklinks).toHaveBeenCalledWith('doc-1');
  });

  it('错误 → 紧凑错误行 + common.retry 可重试（不新增 retry 键）', async () => {
    mockGetBacklinks.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(backlinks([]));
    renderCard();

    expect(await screen.findByText('Failed to load backlinks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockGetBacklinks).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No documents link here yet')).toBeInTheDocument();
  });

  it('空 → 空态文案 + 标题仍给双计数 0（口径一致，不撒谎）', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks([]));
    renderCard();

    expect(await screen.findByText('No documents link here yet')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Referenced by 0 docs · 0 links' }),
    ).toBeInTheDocument();
  });
});

describe('DocBacklinksCard 分组口径与行信息层级', () => {
  it('标题给双计数（篇 = 组数 / 处 = 入链总数），组行 = 文件名 + 首处 section 末段', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(THREE_SOURCES));
    renderCard();

    // 3 篇 / 5 处（1 + 2 + 2）
    expect(
      await screen.findByRole('heading', { name: 'Referenced by 3 docs · 5 links' }),
    ).toBeInTheDocument();

    // 第 1 行 = fileBaseName（去目录去 .md），全路径只进 aria
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('guides/alpha.md')).not.toBeInTheDocument();

    // 第 2 行 = 首处命中 section 的**末段**
    expect(within(groupRow('Alpha Guide')).getByText('Intro')).toBeInTheDocument();
  });

  it('组内仅 1 处不显示「N 处」也无展开入口；> 1 处追加单条参数化消息', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(THREE_SOURCES));
    renderCard();

    await screen.findByText('alpha');
    expect(within(groupRow('Alpha Guide')).queryByText(/links/)).not.toBeInTheDocument();
    // 单处组连展开入口都不渲染（section 已在组行上，展开无新信息）
    expect(screen.queryByRole('button', { name: 'Alpha Guide · 1 links' })).not.toBeInTheDocument();

    // 两处组：section 末段与计数在同一文本节点（拆 span 会让裸数字变成独立元素）
    expect(within(groupRow('Beta')).getByText('Usage · 2 links')).toBeInTheDocument();
    // 展开入口的可访问名含来源标题：同页多个两处组不得重名
    expect(screen.getByRole('button', { name: 'Beta · 2 links' })).toBeInTheDocument();
  });

  it('组级形态徽标：全相对 → 相对路径、全平台 → 平台链接（中性 Badge，且不嵌在按钮内）', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(THREE_SOURCES));
    renderCard();

    await screen.findByText('alpha');
    const alphaLi = groupRow('Alpha Guide').closest('li') as HTMLElement;
    const betaLi = groupRow('Beta').closest('li') as HTMLElement;
    expect(within(alphaLi).getByText('Relative path')).toBeInTheDocument();
    expect(within(betaLi).getByText('Platform link')).toBeInTheDocument();
    // 徽标是组行按钮的兄弟而非子节点（button 内不嵌 div——hydration 血泪先例）
    expect(within(groupRow('Alpha Guide')).queryByText('Relative path')).not.toBeInTheDocument();
  });

  it('无 headingPath 的首处命中显示「文首」（无 section 定位的兜底词）', async () => {
    mockGetBacklinks.mockResolvedValue(
      backlinks([source({ links: [link({ headingPath: null })] })]),
    );
    renderCard();

    expect(
      await screen.findByRole('heading', { name: 'Referenced by 1 docs · 1 links' }),
    ).toBeInTheDocument();
    expect(within(groupRow('Alpha Guide')).getByText('Top of doc')).toBeInTheDocument();
  });

  it('混合形态组不显示组级徽标（二选一会撒谎）；逐处形态逐条给出', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks([THREE_SOURCES[2]]));
    renderCard();

    const row = await screen.findByRole('button', { name: /Source Mixed/ });
    const li = row.closest('li') as HTMLElement;
    expect(within(li).queryByText('Relative path')).not.toBeInTheDocument();
    expect(within(li).queryByText('Platform link')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mixed · 2 links' }));
    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
    expect(within(li).getByText('Relative path')).toBeInTheDocument();
    expect(within(li).getByText('Platform link')).toBeInTheDocument();
  });

  it('aria-label 一次给全完整 path / 逐处 headingPath / href / 形态 / 移动后需改写', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(THREE_SOURCES));
    renderCard();

    const row = await screen.findByRole('button', { name: /Source Alpha Guide/ });
    const aria = row.getAttribute('aria-label') as string;
    expect(aria).toContain('Alpha Guide');
    expect(aria).toContain('guides/alpha.md');
    expect(aria).toContain('Intro');
    expect(aria).toContain('../beta.md');
    expect(aria).toContain('Relative path');
    expect(aria).toContain('Needs rewriting after a move');
    expect(row).toHaveAttribute('title', 'Alpha Guide');
  });
});

describe('DocBacklinksCard 两级展开与点击回调', () => {
  it('组行点击 → 该来源首处命中 section（全路径原样回传，末段提取归调用方）', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(THREE_SOURCES));
    const { onSelectDoc } = renderCard();

    fireEvent.click(await screen.findByRole('button', { name: /Source Beta/ }));
    expect(onSelectDoc).toHaveBeenCalledWith('src-2', 'Beta § Usage');
  });

  it('逐处行点击 → 该处 section；文首命中回传 null（调用方落顶部）', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(THREE_SOURCES));
    const { onSelectDoc } = renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Beta · 2 links' }));
    // 第二处（headingPath = null）的逐处行
    fireEvent.click(screen.getByRole('button', { name: /1 links: Top of doc/ }));
    expect(onSelectDoc).toHaveBeenCalledWith('src-2', null);
    // 第一处 → **该处** headingPath（不是组行的首处兜底）
    fireEvent.click(screen.getByRole('button', { name: /1 links: Usage/ }));
    expect(onSelectDoc).toHaveBeenCalledWith('src-2', 'Beta § Usage');
  });

  it('首屏仅 5 组：「还有 N 篇」可展开可收起', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(manySources(7)));
    renderCard();

    expect(await screen.findByText('doc-1')).toBeInTheDocument();
    expect(screen.queryByText('doc-6')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2 more' }));
    expect(screen.getByText('doc-6')).toBeInTheDocument();
    expect(screen.getByText('doc-7')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('doc-6')).not.toBeInTheDocument();
  });

  it('docCount ≤ 5 不渲染「还有 N 篇」开关', async () => {
    mockGetBacklinks.mockResolvedValue(backlinks(manySources(5)));
    renderCard();

    expect(await screen.findByText('doc-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument();
  });
});

describe('DocBacklinksCard 切文档复位', () => {
  it('展开态（列表展开 + 组内逐处展开）随 docId 切换复位，不 bleed 到新文档', async () => {
    // 新文档 = 单组单处且命中「文首」：若旧展开态 bleed 过来会残留 'Intro'/'Second'
    const docTwo = backlinks([
      source({
        sourceDocId: 'other',
        sourcePath: 'o.md',
        sourceTitle: 'Other',
        links: [link({ headingPath: null })],
      }),
    ]);
    mockGetBacklinks.mockImplementation((docId: string) =>
      Promise.resolve(docId === 'doc-1' ? backlinks(manySources(7)) : docTwo),
    );
    const { rerenderCard } = renderCard();

    fireEvent.click(await screen.findByRole('button', { name: '2 more' }));
    fireEvent.click(screen.getByRole('button', { name: 'Doc 1 · 2 links' }));
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();

    rerenderCard({ docId: 'doc-2' });

    expect(
      await screen.findByRole('heading', { name: 'Referenced by 1 docs · 1 links' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument();
    expect(screen.queryByText('Intro')).not.toBeInTheDocument();
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    expect(mockGetBacklinks).toHaveBeenCalledWith('doc-2');
  });
});
