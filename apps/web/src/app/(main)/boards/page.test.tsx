/**
 * boards/page.test.tsx — 看板列表页**失败可见性**契约（卡 240c74d6）。
 *
 * 本批要根治的是「静默失败」：查询失败被渲染成空态（用户读成"没有数据"）、mutation 失败
 * 毫无反馈。故本 spec 的四个用例分别钉住：
 * ① 首载失败 → 可见错误态 + 重试按钮（验收锚点：断网/500 注入下有可见错误态）；
 * ② 服务端 4xx 业务原因 → 透传 message（用户要知道"为什么失败"）；
 * ③ 有缓存的刷新失败 → **保留旧列表、不切错误态**（memory 页 R-2 判据，防错误分支
 *    把零看板用户的空态入口整棵卸载）；
 * ④ mutation 失败 → toast 进通知 store，且断网时不出现 axios 英文原文。
 *
 * Api/auth store 全 mock（页面级测试不触网络），QueryClient 用 `retry:false` 替身
 * （否则真实重试 2 次 + 退避会把断言拖到超时）。
 */

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BoardsPage from './page';
import { Api } from '@/lib/api';
import { useNotificationStore } from '@/stores/notification.store';

/** boards/common 命名空间英语文案快照（同 en.json；未收录键回落为完整 key 路径） */
const messages: Record<string, string> = {
  'boards.title': 'Boards',
  'boards.description': 'Manage task boards',
  'boards.create': 'Create Board',
  'boards.noBoards': 'No boards',
  'boards.noBoardsDesc': 'Create your first board',
  'boards.noDescription': 'No description',
  'boards.viewBoard': 'View board',
  'boards.taskProgress': '{completed} / {total} tasks',
  'boards.loadErrorTitle': 'Failed to load boards',
  'boards.loadErrorDesc': 'Check your connection and try again.',
  'boards.createError': 'Failed to create the board. Please try again.',
  'boards.updateError': 'Failed to update the board. Please try again.',
  'boards.deleteError': 'Failed to delete the board. Please try again.',
  'boards.form.createTitle': 'Create Board',
  'boards.form.createDesc': 'Enter board information',
  'boards.form.name': 'Name',
  'boards.form.namePlaceholder': 'Board name',
  'boards.form.description': 'Description',
  'boards.form.descPlaceholder': 'Board description (optional)',
  'boards.form.visibility': 'Visibility',
  'boards.visibility.publicDesc': 'Public (anyone can view)',
  'boards.visibility.privateDesc': 'Private (invite only)',
  'common.create': 'Create',
  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.noData': 'No data',
  'common.emptyList': 'List is empty',
};

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
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

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/api', () => ({
  Api: {
    boards: {
      list: jest.fn(),
      getById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    agents: { listAll: jest.fn() },
  },
}));

// auth store：页面消费 user（canManageBoard 门控 admin）——给 admin 让编辑/删除按钮渲染
jest.mock('@/stores/auth.store', () => ({
  useAuthStore: () => ({ user: { id: 'u-1', role: 'admin' } }),
}));

const mockList = Api.boards.list as jest.Mock;
const mockCreate = Api.boards.create as jest.Mock;
const mockUpdate = Api.boards.update as jest.Mock;
const mockDelete = Api.boards.delete as jest.Mock;
const mockAgents = Api.agents.listAll as jest.Mock;

/** 渲染并返回 QueryClient（供"刷新失败保留旧数据"用例直驱 refetch） */
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BoardsPage />
    </QueryClientProvider>,
  );
  return queryClient;
}

const BOARD = {
  id: 'b-1',
  name: '看板一',
  visibility: 'open',
  taskCount: 3,
  completedTaskCount: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  useNotificationStore.setState({ toasts: [], alerts: [] });
  mockAgents.mockResolvedValue([]);
  mockList.mockResolvedValue({ items: [BOARD], total: 1 });
});

describe('BoardsPage 错误态（卡 240c74d6）', () => {
  it('首载失败（500）→ 可见错误态 + 重试按钮；文案走本地兜底（不显示 5xx 服务端措辞）', async () => {
    mockList.mockRejectedValue({
      response: { status: 500, data: { code: 500, message: 'QueryFailedError: boom' } },
    });
    renderPage();

    expect(await screen.findByTestId('boards-list-error')).toBeInTheDocument();
    expect(screen.getByText('Failed to load boards')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('QueryFailedError: boom')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // 错误态不该同时渲染空态（否则"失败"与"没有数据"又混成一个样子）
    expect(screen.queryByText('No boards')).not.toBeInTheDocument();
  });

  it('断网（无 response）→ 错误态 + 兜底文案（不是 axios 的 Network Error）', async () => {
    mockList.mockRejectedValue(new Error('Network Error'));
    renderPage();

    expect(await screen.findByTestId('boards-list-error')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('Network Error')).not.toBeInTheDocument();
  });

  it('4xx + 业务码 → 透传服务端 message（用户要看到"为什么失败"）', async () => {
    mockList.mockRejectedValue({
      response: {
        status: 403,
        data: { code: 1009, message: 'you are not a member of this board' },
      },
    });
    renderPage();

    expect(await screen.findByTestId('boards-list-error')).toBeInTheDocument();
    expect(screen.getByText('you are not a member of this board')).toBeInTheDocument();
  });

  it('重试按钮可用：refetch 成功后回到列表', async () => {
    mockList.mockRejectedValueOnce(new Error('Network Error'));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('看板一')).toBeInTheDocument();
    expect(screen.queryByTestId('boards-list-error')).not.toBeInTheDocument();
  });

  it('已有缓存的刷新失败 → 保留旧列表、不进错误态（R-2 判据）', async () => {
    const queryClient = renderPage();
    await screen.findByText('看板一');

    mockList.mockRejectedValue(new Error('Network Error'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['boards', 'list'] });
    });

    // 旧数据仍在（TanStack v5 刷新失败保留 data），错误分支不得接管
    expect(screen.getByText('看板一')).toBeInTheDocument();
    expect(screen.queryByTestId('boards-list-error')).not.toBeInTheDocument();
  });
});

describe('BoardsPage mutation 失败提示（卡 240c74d6 六枚之一）', () => {
  it('创建失败（断网）→ toast 兜底文案，不出现 axios 英文原文', async () => {
    mockCreate.mockRejectedValue(new Error('Network Error'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Board' }));

    fireEvent.change(screen.getByPlaceholderText('Board name'), { target: { value: '新看板' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const toasts = useNotificationStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Failed to create the board. Please try again.');
      expect(toasts[0].variant).toBe('error');
    });
  });

  it('创建失败（4xx 业务原因）→ toast 透传服务端 message', async () => {
    mockCreate.mockRejectedValue({
      response: { status: 409, data: { code: 3002, message: 'board name already taken' } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Board' }));

    fireEvent.change(screen.getByPlaceholderText('Board name'), { target: { value: '重名看板' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(useNotificationStore.getState().toasts[0]?.title).toBe('board name already taken');
    });
  });
});

/** 详情接口 mock（列表页 openEdit 用例用；既有的 mock 常量块不含 boards.getById） */
const mockGetById = Api.boards.getById as jest.Mock;

// ── R-2 鉴别性用例（reviewer M1）───────────────────────────────────────────────
// 上面 5 条错误态用例都只在「刷新失败**且从未成功过**」下验证，把判据从
// `isError && data === undefined` 改成 `boards.length === 0` 后照样全绿——即无人能拦住这个
// 回归。本条走 memory 页 R-2 的形态：**首载成功但列表为空 → refetch 失败**，断言空态
// （含创建 CTA）不被错误态接管（零看板用户正是空态入口的主目标）。
describe('BoardsPage R-2 判据鉴别性（卡 240c74d6）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useNotificationStore.setState({ toasts: [], alerts: [] });
    mockAgents.mockResolvedValue([]);
  });

  it('零看板用户：首载成功但列表为空 → refetch 失败 ⇒ 空态不被错误态接管', async () => {
    // 本用例自建 client + 自行 rerender（`renderPage` 只返回 client，不返回 RTL 视图对象）
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    /** 重渲染用工厂：每次返回**新元素对象**——复用同一个 element 对象会被 React 直接
        bailout 跳过重渲染，那等于没重渲染（实测过的坑，见下方注释） */
    const renderTree = () => (
      <QueryClientProvider client={queryClient}>
        <BoardsPage />
      </QueryClientProvider>
    );
    mockAgents.mockResolvedValue([]);
    mockList.mockResolvedValueOnce({ items: [], total: 0 });
    const { rerender } = render(renderTree());
    expect(await screen.findByText('No boards')).toBeInTheDocument();

    mockList.mockRejectedValue(new Error('Network Error'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['boards', 'list'] });
    });
    // ⚠️ **显式重渲染（且必须是新元素对象）**：RQ 把失败通知投递给 observer 是**异步调度**的
    // （实测通知落不落地取决于并发时序，单跑/合跑结果都不同），直接读 DOM 会读到上一帧——
    // 那样把判据改回 `boards.length === 0` 也照样"通过"。而 `rerender(同一个 element 对象)`
    // 会被 React bailout 跳过 ⇒ 同样读不到新判据。二者叠加就是本用例鉴别力的全部来源。
    rerender(renderTree());

    // 先证明"刷新真的失败了且旧 data 仍在"——否则本用例可能只是没跑到那条分支
    const state = queryClient.getQueryState(['boards', 'list']);
    // QueryState 上没有 isError（那是 observer 结果上的派生布尔），状态机字段是 status
    expect(state?.status).toBe('error');
    expect(state?.data).toEqual({ items: [], total: 0 });

    // R-2：`isError && data={items:[]}` 不得触发错误态，否则空态 CTA 整棵被卸载
    expect(screen.queryByTestId('boards-list-error')).toBeNull();
    expect(screen.getByText('No boards')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create Board' }).length).toBeGreaterThan(0);
  });

  // reviewer M2：boards openEdit 的 try/catch（同 plan 顺手修）此前零覆盖
  it('编辑入口的详情拉取失败 → toast（不再是被吞掉的未处理 Promise 拒绝）', async () => {
    mockGetById.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await screen.findByText('看板一');

    // 卡片操作区第一个按钮 = 铅笔（canManageBoard 为真才渲染：auth store mock 给 admin）
    fireEvent.click(
      within(screen.getByRole('link', { name: /看板一/ })).getByRole('button', {
        name: 'common.edit',
      }),
    );

    await waitFor(() => {
      const toasts = useNotificationStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Check your connection and try again.');
    });
    // 编辑 dialog 不该被打开（没有详情可编辑）
    expect(screen.queryByPlaceholderText('Board name')).not.toBeInTheDocument();
  });
});

it('board update failure retains its form and retries', async () => {
  mockGetById.mockResolvedValue({ ...BOARD, description: 'Original' });
  mockUpdate.mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('看板一');
  fireEvent.click(
    within(screen.getByRole('link', { name: /看板一/ })).getByRole('button', {
      name: 'common.edit',
    }),
  );
  fireEvent.change(await screen.findByDisplayValue('看板一'), {
    target: { value: 'Keep board name' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(useNotificationStore.getState().toasts[0]?.title).toBe(messages['boards.updateError']),
  );
  expect(screen.getByDisplayValue('Keep board name')).toBeInTheDocument();
  mockUpdate.mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
  await waitFor(() =>
    expect(screen.queryByDisplayValue('Keep board name')).not.toBeInTheDocument(),
  );
  expect(mockUpdate).toHaveBeenCalledTimes(2);
});
it('board delete failure keeps confirmation and retries', async () => {
  mockDelete.mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('看板一');
  fireEvent.click(
    within(screen.getByRole('link', { name: /看板一/ })).getByRole('button', {
      name: 'common.delete',
    }),
  );
  const dialog = within(
    screen.getByRole('heading', { name: 'boards.delete.confirmTitle' }).parentElement!
      .parentElement!,
  );
  fireEvent.click(dialog.getByRole('button', { name: 'common.delete' }));
  await waitFor(() =>
    expect(useNotificationStore.getState().toasts[0]?.title).toBe(messages['boards.deleteError']),
  );
  expect(screen.getByRole('heading', { name: 'boards.delete.confirmTitle' })).toBeInTheDocument();
  mockDelete.mockResolvedValue({});
  fireEvent.click(dialog.getByRole('button', { name: 'common.delete' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: 'boards.delete.confirmTitle' }),
    ).not.toBeInTheDocument(),
  );
  expect(mockDelete).toHaveBeenCalledTimes(2);
});
