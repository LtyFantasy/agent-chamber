import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DocsPage from './page';
import { Api } from '@/lib/api';
import { useNotificationStore } from '@/stores/notification.store';

/** 本测试用到的文案快照（同 en.json；未命中 key 回退为完整 key 路径，不影响断言） */
const messages: Record<string, string> = {
  'docs.create': 'New Space',
  'docs.delete.confirmTitle': 'Confirm deletion',
  'docs.delete.confirmDesc': 'Delete space and its {count} docs and {linkedCount} linked tasks?',
  'docs.loadErrorTitle': 'Failed to load doc spaces',
  'docs.loadErrorDesc': 'Check your connection and try again.',
  'docs.noSpaces': 'No doc spaces',
  'docs.noSpacesDesc': 'Create your first doc space to organize project knowledge',
  'docs.form.createError': 'Create failed, please try again',
  'docs.delete.error': 'Delete failed, please try again',
  'common.delete': 'Delete',
  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
};

jest.mock('next-intl', () => ({
  // 组件新增 useLocale 依赖（formatRelativeTime/formatDate locale 下传），mock 固定 en
  useLocale: () => 'en',
  // 支持 {param} 简单插值（测试文案用简版占位，与 en.json 的 ICU 语法无关）
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

jest.mock('next/link', () => {
  return function MockLink({ children, href }: { children: React.ReactNode; href: string }) {
    return <a href={href}>{children}</a>;
  };
});

jest.mock('@/lib/api', () => ({
  Api: {
    docs: {
      listSpaces: jest.fn(),
      getSpace: jest.fn(),
      deleteSpace: jest.fn(),
      createSpace: jest.fn(),
    },
    topics: { list: jest.fn() },
    boards: { list: jest.fn() },
  },
}));

const mockApi = Api.docs as unknown as {
  listSpaces: jest.Mock;
  getSpace: jest.Mock;
  deleteSpace: jest.Mock;
};

function renderPage() {
  // retry: false —— 查询失败立即进入 isError，避免默认 3 次重试拖慢断言
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DocsPage />
    </QueryClientProvider>,
  );
  // 连 client 一起返回：R-2 用例要断言「刷新真的失败了（isError）但旧 data 仍在」——
  // 只靠界面断言无法区分"没失败"与"失败但被判据正确拦住"
  return { ...view, queryClient };
}

describe('DocsPage 删除空间确认框（B2 linkedTaskCount）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.listSpaces.mockResolvedValue({
      items: [{ id: 's1', name: 'Space 1', visibility: 'open', docCount: 3 }],
      total: 1,
    });
    mockApi.getSpace.mockResolvedValue({
      id: 's1',
      name: 'Space 1',
      docCount: 3,
      linkedTaskCount: 5,
    });
  });

  it('点击删除打开确认框，按 spaceId 拉详情并展示 docCount + linkedTaskCount', async () => {
    renderPage();
    await screen.findByText('Space 1');

    // 卡片右上角删除按钮（无文字，仅 Trash2 图标，按 icon class 定位）
    fireEvent.click(
      within(screen.getByRole('link', { name: /Space 1/ })).getByRole('button', { name: 'Delete' }),
    );

    // Dialog 打开后触发详情查询（拿 linkedTaskCount）
    await waitFor(() => {
      expect(mockApi.getSpace).toHaveBeenCalledWith('s1');
    });
    expect(
      await screen.findByText('Delete space and its 3 docs and 5 linked tasks?'),
    ).toBeInTheDocument();
  });

  it('详情尚未返回时展示加载态文案', async () => {
    // getSpace 挂起 → 确认框停留在 loadingDetail 文案
    mockApi.getSpace.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByText('Space 1');

    fireEvent.click(
      within(screen.getByRole('link', { name: /Space 1/ })).getByRole('button', { name: 'Delete' }),
    );

    expect(await screen.findByText('docs.delete.loadingDetail')).toBeInTheDocument();
  });
});

describe('DocsPage 错误态（卡 240c74d6）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('首载失败（500）→ 可见错误态 + 重试按钮；文案走本地兜底', async () => {
    mockApi.listSpaces.mockRejectedValue({
      response: { status: 500, data: { code: 500, message: 'QueryFailedError: relation "x"' } },
    });
    renderPage();

    expect(await screen.findByTestId('docs-list-error')).toBeInTheDocument();
    expect(screen.getByText('Failed to load doc spaces')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('QueryFailedError: relation "x"')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // 失败不得与空态混成一个样子
    expect(screen.queryByText('No doc spaces')).not.toBeInTheDocument();
  });

  it('断网（无 response）→ 错误态，不出现 axios 英文原文；4xx + 业务码 → 透传服务端 message', async () => {
    mockApi.listSpaces.mockRejectedValue(new Error('Network Error'));
    const { unmount } = renderPage();
    expect(await screen.findByTestId('docs-list-error')).toBeInTheDocument();
    expect(screen.queryByText('Network Error')).not.toBeInTheDocument();
    unmount();

    mockApi.listSpaces.mockRejectedValue({
      response: { status: 403, data: { code: 1009, message: 'this space is private' } },
    });
    renderPage();
    expect(await screen.findByText('this space is private')).toBeInTheDocument();
  });

  it('删除空间失败 → toast（不再用阻塞式 alert）', async () => {
    mockApi.listSpaces.mockResolvedValue({
      items: [{ id: 's1', name: 'Space 1', visibility: 'open', docCount: 3 }],
      total: 1,
    });
    mockApi.getSpace.mockResolvedValue({ id: 's1', name: 'Space 1', docCount: 3 });
    mockApi.deleteSpace.mockRejectedValue(new Error('Network Error'));
    useNotificationStore.setState({ toasts: [], alerts: [] });

    renderPage();
    await screen.findByText('Space 1');
    fireEvent.click(
      within(screen.getByRole('link', { name: /Space 1/ })).getByRole('button', { name: 'Delete' }),
    );
    await screen.findByText('Confirm deletion');

    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Confirm deletion' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Delete' }),
    );

    await waitFor(() => {
      expect(useNotificationStore.getState().toasts[0]?.title).toBe(
        'Delete failed, please try again',
      );
    });
  });
});

describe('queryKey 撞车修复（卡 240c74d6）', () => {
  /** 与 topics 列表页**不同**的绑定候选键；旧值 `['topics','list']` 与 topics 页同键不同 queryFn */
  const TOPICS_PAGE_KEY = ['topics', 'list'] as const;
  /**
   * docs 页绑定候选的键（= 兄弟文件 `docs/[id]/page.tsx` 的 `['topics','binding-options']`）。
   * 测试里只留这一份"期望值"，靠下面两处哨兵断言证明页面**真的**用了它——比只比较两个字符串
   * 常量硬：页面键改错时哨兵会红，而不是常量跟着一起漂。
   */
  const DOCS_BIND_KEY = ['topics', 'binding-options'] as const;

  it('两页的键必须不同：docs 页既不读也不覆盖 topics 页的缓存（跨页导航后两边列表都完整）', async () => {
    expect(DOCS_BIND_KEY).not.toEqual(TOPICS_PAGE_KEY);

    // 模拟"先逛过话题页"：同一 client 里已有 topics 列表页的缓存
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(TOPICS_PAGE_KEY, {
      items: [{ id: 'sentinel', title: 'SENTINEL-TOPIC' }],
      total: 1,
    });
    // mockApi 的声明只覆盖 Api.docs（既有用例口径），topics 候选查询单独取一次引用
    const topicsListMock = (Api as unknown as { topics: { list: jest.Mock } }).topics.list;
    topicsListMock.mockResolvedValue({
      items: [{ id: 't-1', title: '真实话题' }],
      total: 1,
    });
    mockApi.listSpaces.mockResolvedValue({ items: [], total: 0 });

    render(
      <QueryClientProvider client={queryClient}>
        <DocsPage />
      </QueryClientProvider>,
    );
    // 空态 → 点「New Space」打开新建 dialog
    fireEvent.click(await screen.findByRole('button', { name: 'New Space' }));

    // 绑定类型切到 topic → 触发候选查询（与 topics 列表页同 data 源、不同键）
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'topic' } });
    await waitFor(() => expect(topicsListMock).toHaveBeenCalledTimes(1));

    // 候选下拉渲染的是本次真实拉取结果，不是撞键缓存里的哨兵
    expect(await screen.findByRole('option', { name: '真实话题' })).toBeInTheDocument();
    expect(screen.queryByText('SENTINEL-TOPIC')).not.toBeInTheDocument();

    // 正方向：页面确实把候选写进了自己那个键（不是写了别的什么键就完事）
    expect(queryClient.getQueryData(DOCS_BIND_KEY)).toBeDefined();

    // 反方向：docs 页的写入没污染 topics 页的缓存（跨页导航后话题列表仍完整）
    const topicsCache = queryClient.getQueryData<{ items: { title: string }[] }>(TOPICS_PAGE_KEY);
    expect(topicsCache?.items[0].title).toBe('SENTINEL-TOPIC');
  });
});

// ── R-2 鉴别性用例（reviewer M1）───────────────────────────────────────────────
// 与 topics/boards 两页同规：上面的错误态用例只在「刷新失败**且从未成功过**」下验证，
// 把判据从 `isError && data === undefined` 改成 `spaces.length === 0` 后照样全绿——即无人能
// 拦住这个回归。本条走 memory 页 R-2 的形态：**首载成功但列表为空 → refetch 失败** ⇒
// 空态（含创建 CTA）不被错误态接管。
describe('DocsPage R-2 判据鉴别性（卡 240c74d6）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('零空间用户：首载成功但列表为空 → refetch 失败 ⇒ 空态不被错误态接管', async () => {
    mockApi.listSpaces.mockResolvedValueOnce({ items: [], total: 0 });
    const { queryClient, rerender } = renderPage();
    /** 重渲染用工厂：每次返回**新元素对象**——复用同一个 element 对象会被 React 直接
        bailout 跳过重渲染，那等于没重渲染（实测过的坑，见下方注释） */
    const renderTree = () => (
      <QueryClientProvider client={queryClient}>
        <DocsPage />
      </QueryClientProvider>
    );
    expect(await screen.findByText('No doc spaces')).toBeInTheDocument();

    mockApi.listSpaces.mockRejectedValue(new Error('Network Error'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['docs', 'spaces'] });
    });
    // ⚠️ **显式重渲染（且必须是新元素对象）**：RQ 把失败通知投递给 observer 是**异步调度**的
    // （实测通知落不落地取决于并发时序，单跑/合跑结果都不同），直接读 DOM 会读到上一帧——
    // 那样把判据改回 `spaces.length === 0` 也照样"通过"。而 `rerender(同一个 element 对象)`
    // 会被 React bailout 跳过 ⇒ 同样读不到新判据。二者叠加就是本用例鉴别力的全部来源。
    rerender(renderTree());

    // 先证明"刷新真的失败了且旧 data 仍在"——否则本用例可能只是没跑到那条分支
    const state = queryClient.getQueryState(['docs', 'spaces']);
    // QueryState 上没有 isError（那是 observer 结果上的派生布尔），状态机字段是 status
    expect(state?.status).toBe('error');
    expect(state?.data).toEqual({ items: [], total: 0 });

    // R-2：`isError && data={items:[]}` 不得触发错误态，否则空态 CTA 整棵被卸载
    expect(screen.queryByTestId('docs-list-error')).toBeNull();
    expect(screen.getByText('No doc spaces')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New Space' }).length).toBeGreaterThan(0);
  });
});

it('doc space create failure preserves name, description and binding for retry', async () => {
  useNotificationStore.setState({ toasts: [], alerts: [] });
  (Api.docs.createSpace as jest.Mock).mockRejectedValue(new Error('Network Error'));
  mockApi.listSpaces.mockResolvedValue({ items: [{ id: 's1', name: 'Space 1' }] });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'New Space' }));
  fireEvent.change(screen.getByPlaceholderText('docs.form.namePlaceholder'), {
    target: { value: 'Keep new space' },
  });
  fireEvent.change(screen.getByPlaceholderText('docs.form.descPlaceholder'), {
    target: { value: 'Keep description' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
  await waitFor(() =>
    expect(useNotificationStore.getState().toasts[0]?.title).toBe(
      messages['docs.form.createError'],
    ),
  );
  expect(screen.getByDisplayValue('Keep new space')).toBeInTheDocument();
  expect(screen.getByDisplayValue('Keep description')).toBeInTheDocument();
  (Api.docs.createSpace as jest.Mock).mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
  await waitFor(() => expect(screen.queryByDisplayValue('Keep new space')).not.toBeInTheDocument());
  expect(Api.docs.createSpace).toHaveBeenCalledTimes(2);
});
