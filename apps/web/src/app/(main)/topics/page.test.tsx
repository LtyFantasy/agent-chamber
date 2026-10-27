/**
 * topics/page.test.tsx — 话题列表页圆桌批次契约测试（v1.49.0）
 *
 * 覆盖：① 列表卡片圆桌 badge（kind='roundtable' 渲染、normal 不渲染）；
 * ② 创建 dialog 的 kind radio 分支（默认普通不展开圆桌配置；选圆桌后展开
 * wakePolicy/maxRounds + 不可变提示）；③ 创建提交 payload（圆桌携带
 * config {kind, wakePolicy, maxRoundsWithoutHuman?}，普通不携带 config）。
 * 文案断言用 en.json 快照；Api/auth store 全 mock（页面级测试不触网络）。
 */

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TopicsPage from './page';
import { Api } from '@/lib/api';
import { useNotificationStore } from '@/stores/notification.store';

/** topics/common 命名空间英语文案快照（同 en.json；未收录键回落为 key 本身） */
const messages: Record<string, string> = {
  'topics.title': 'Topics',
  'topics.description': 'Join discussions or create new topics',
  'topics.create': 'Create Topic',
  'topics.noDescription': 'No description',
  'topics.viewDetail': 'View detail',
  'topics.kind.roundtable': 'Roundtable',
  'topics.kind.normal': 'Normal',
  'topics.visibility.publicAria': 'Public topic',
  'topics.visibility.privateAria': 'Private topic',
  'topics.visibility.publicDesc': 'Open (anyone can join)',
  'topics.visibility.privateDesc': 'Private (invite only)',
  'topics.status.active': 'Active',
  'topics.status.open': 'Open',
  'topics.form.createTitle': 'Create Topic',
  'topics.form.createDesc': 'Enter topic information',
  'topics.form.title': 'Title',
  'topics.form.titlePlaceholder': 'Topic title',
  'topics.form.description': 'Description',
  'topics.form.descPlaceholder': 'Topic description (optional)',
  'topics.form.visibility': 'Visibility',
  'topics.form.kind': 'Type',
  'topics.form.kindNormalDesc': 'Normal (standard discussion topic)',
  'topics.form.kindRoundtableDesc': 'Roundtable (multi-agent seat meeting)',
  'topics.form.kindImmutableHint':
    'Type cannot be changed after creation; add seats from the topic detail page',
  'topics.form.wakePolicy': 'Wake policy',
  'topics.form.wakeMention': 'Mention to wake (default; seats only receive @seat or @all)',
  'topics.form.wakeBroadcast': 'Broadcast (every new message goes to all seats)',
  'topics.form.maxRounds': 'Safety-valve round limit (optional)',
  'topics.form.maxRoundsPlaceholder': 'Default 8; 0 = disabled',
  'topics.form.attachmentTtl': 'Attachment retention',
  'topics.form.attachmentTtlHint':
    'Applies to newly uploaded attachments only; existing attachments keep their original expiry.',
  'topics.form.attachmentTtl1d': '1 day',
  'topics.form.attachmentTtl7d': '7 days (default)',
  'topics.form.attachmentTtl30d': '30 days',
  'topics.form.attachmentTtlNever': 'Never expire',
  'topics.loadErrorTitle': 'Failed to load topics',
  'topics.loadErrorDesc': 'Check your connection and try again.',
  'topics.noTopics': 'No topics',
  'topics.noTopicsDesc': 'Create your first topic',
  'topics.createError': 'Failed to create the topic. Please try again.',
  'topics.updateError': 'Failed to update the topic. Please try again.',
  'topics.deleteError': 'Failed to delete the topic. Please try again.',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.retry': 'Retry',
};

jest.mock('next-intl', () => ({
  // 组件新增 useLocale 依赖（formatRelativeTime/formatDate locale 下传），mock 固定 en
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

// next/link 在 jsdom 直接渲染为 <a>（页面卡片整卡跳转，无需真实路由）
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/api', () => ({
  Api: {
    topics: {
      list: jest.fn(),
      getUnread: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      getById: jest.fn(),
    },
  },
}));

// auth store：页面只消费 isAuthenticated（未读数查询开关）
jest.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: (s: { isAuthenticated: boolean }) => unknown) =>
    selector({ isAuthenticated: true }),
}));

const mockList = Api.topics.list as jest.Mock;
const mockGetUnread = Api.topics.getUnread as jest.Mock;
const mockCreate = Api.topics.create as jest.Mock;
const mockDelete = Api.topics.delete as jest.Mock;
const mockUpdate = Api.topics.update as jest.Mock;
const mockGetById = Api.topics.getById as jest.Mock;

const NORMAL_TOPIC = {
  id: 't-normal',
  title: '普通话题',
  status: 'active',
  visibility: 'open',
  kind: 'normal',
  participantCount: 2,
  messageCount: 10,
  lastMessageAt: new Date().toISOString(),
};

const ROUNDTABLE_TOPIC = {
  id: 't-round',
  title: '圆桌会议',
  status: 'active',
  visibility: 'private',
  kind: 'roundtable',
  participantCount: 3,
  messageCount: 42,
  lastMessageAt: new Date().toISOString(),
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TopicsPage />
    </QueryClientProvider>,
  );
  // 连 client 一起返回：R-2 用例要断言「刷新真的失败了（isError）但旧 data 仍在」——
  // 只靠界面断言无法区分"没失败"与"失败但被判据正确拦住"（鉴别力靠 isError 这一句）
  return { ...view, queryClient };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ items: [NORMAL_TOPIC, ROUNDTABLE_TOPIC], total: 2 });
  mockGetUnread.mockResolvedValue({ unreadCount: 0 });
});

describe('列表卡片圆桌 badge（v1.49.0）', () => {
  it('kind=roundtable 渲染圆桌 badge；normal 不渲染', async () => {
    renderPage();
    // 等待列表加载（卡片标题出现）
    await screen.findByText('圆桌会议');
    expect(screen.getByText('Roundtable')).toBeInTheDocument();
    // normal 卡片不出 badge（全页仅一枚 Roundtable badge）
    expect(screen.getAllByText('Roundtable')).toHaveLength(1);
  });
});

describe('创建 dialog kind 分支（v1.49.0）', () => {
  it('默认普通：不展开圆桌配置；提交 config 只带附件有效期（缺省 7d）', async () => {
    mockCreate.mockResolvedValue({ id: 't-new' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Topic' }));

    // 圆桌配置区默认不渲染
    expect(screen.queryByText('Wake policy')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Topic title'), {
      target: { value: '新话题' },
    });
    // footer 提交钮（dialog 内第二个 Create Topic 按钮）
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Create Topic' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Create Topic' }),
    );

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    // mutationFn 第一参数是表单 payload（第二参数是 react-query 内部选项，不断言）
    expect(mockCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ title: '新话题', config: { attachmentTtl: '7d' } }),
    );
  });

  it('选圆桌：展开 wakePolicy/maxRounds + 不可变提示；提交携带 config（留空不落 maxRounds）', async () => {
    mockCreate.mockResolvedValue({ id: 't-new' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Topic' }));

    fireEvent.click(screen.getByRole('radio', { name: /Roundtable \(multi-agent/ }));

    // 圆桌配置区展开
    expect(screen.getByText('Wake policy')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Type cannot be changed after creation; add seats from the topic detail page',
      ),
    ).toBeInTheDocument();

    // 切到广播唤醒
    fireEvent.click(
      screen.getByRole('radio', { name: 'Broadcast (every new message goes to all seats)' }),
    );
    fireEvent.change(screen.getByPlaceholderText('Topic title'), {
      target: { value: '圆桌测试' },
    });
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Create Topic' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Create Topic' }),
    );

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        title: '圆桌测试',
        config: { kind: 'roundtable', wakePolicy: 'broadcast', attachmentTtl: '7d' },
      }),
    );
  });

  it('选圆桌 + 填轮数上限：config 携带 maxRoundsWithoutHuman 数值', async () => {
    mockCreate.mockResolvedValue({ id: 't-new' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Topic' }));
    fireEvent.click(screen.getByRole('radio', { name: /Roundtable \(multi-agent/ }));

    fireEvent.change(screen.getByPlaceholderText('Default 8; 0 = disabled'), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByPlaceholderText('Topic title'), {
      target: { value: '圆桌测试' },
    });
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Create Topic' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Create Topic' }),
    );

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        config: {
          kind: 'roundtable',
          wakePolicy: 'mention',
          maxRoundsWithoutHuman: 20,
          attachmentTtl: '7d',
        },
      }),
    );
  });
});

describe('附件有效期下拉（v1.90.0-dev 附件 TTL 批 §2 B3.5）', () => {
  it('创建 dialog：4 档选项 + 默认 7 天 + hint 文案；改档后随 config 提交', async () => {
    mockCreate.mockResolvedValue({ id: 't-new' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Topic' }));

    const select = screen.getByTestId('create-attachment-ttl') as HTMLSelectElement;
    expect(select).toHaveValue('7d');
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ['1d', '1 day'],
      ['7d', '7 days (default)'],
      ['30d', '30 days'],
      ['never', 'Never expire'],
    ]);
    // hint 明确「仅影响新上传」
    expect(
      screen.getByText(
        'Applies to newly uploaded attachments only; existing attachments keep their original expiry.',
      ),
    ).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'never' } });
    fireEvent.change(screen.getByPlaceholderText('Topic title'), {
      target: { value: '永久附件桌' },
    });
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Create Topic' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Create Topic' }),
    );

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ config: { attachmentTtl: 'never' } }),
    );
  });

  it('编辑 dialog：初值取 detail.settings.attachmentTtl（缺省回退 7d）；保存回写 config', async () => {
    mockGetById.mockResolvedValue({
      id: 't-normal',
      title: '普通话题',
      description: 'desc',
      settings: { attachmentTtl: '30d' },
    });
    mockUpdate.mockResolvedValue({ id: 't-normal' });
    renderPage();
    await screen.findByText('圆桌会议');

    // 第一张卡片的铅笔（卡片操作区第一个按钮）
    fireEvent.click(
      within(screen.getByRole('link', { name: /普通话题/ })).getByRole('button', {
        name: 'common.edit',
      }),
    );

    const select = (await screen.findByTestId('edit-attachment-ttl')) as HTMLSelectElement;
    await waitFor(() => expect(select).toHaveValue('30d'));

    fireEvent.change(select, { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0][0]).toBe('t-normal');
    expect(mockUpdate.mock.calls[0][1]).toEqual(
      expect.objectContaining({ title: '普通话题', config: { attachmentTtl: 'never' } }),
    );
  });

  it('编辑 dialog：detail.settings 缺 attachmentTtl → 回退 7d（与后端 fail-closed 缺省一致）', async () => {
    mockGetById.mockResolvedValue({ id: 't-normal', title: '普通话题', description: 'desc' });
    renderPage();
    await screen.findByText('圆桌会议');

    fireEvent.click(
      within(screen.getByRole('link', { name: /普通话题/ })).getByRole('button', {
        name: 'common.edit',
      }),
    );

    const select = (await screen.findByTestId('edit-attachment-ttl')) as HTMLSelectElement;
    await waitFor(() => expect(select).toHaveValue('7d'));
  });
});

describe('TopicsPage 错误态与 mutation 失败提示（卡 240c74d6）', () => {
  beforeEach(() => {
    // toast 断言直读通知 store；清空避免用例间串味
    useNotificationStore.setState({ toasts: [], alerts: [] });
  });

  it('首载失败（500）→ 可见错误态 + 重试按钮；文案走本地兜底（不显示 5xx 服务端措辞）', async () => {
    mockList.mockRejectedValue({
      response: { status: 500, data: { code: 500, message: 'QueryFailedError: relation "x"' } },
    });
    renderPage();

    expect(await screen.findByTestId('topics-list-error')).toBeInTheDocument();
    expect(screen.getByText('Failed to load topics')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('QueryFailedError: relation "x"')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // 失败不得与空态混成一个样子（否则用户读到的是"没有话题"）
    expect(screen.queryByText('No topics')).not.toBeInTheDocument();
  });

  it('断网（无 response）→ 错误态；4xx + 业务码 → 透传服务端 message', async () => {
    mockList.mockRejectedValue(new Error('Network Error'));
    const { unmount } = renderPage();
    expect(await screen.findByTestId('topics-list-error')).toBeInTheDocument();
    expect(screen.queryByText('Network Error')).not.toBeInTheDocument();
    unmount();

    mockList.mockRejectedValue({
      response: { status: 403, data: { code: 1009, message: 'you are not in this topic' } },
    });
    renderPage();
    expect(await screen.findByText('you are not in this topic')).toBeInTheDocument();
  });

  it('创建失败（断网）→ toast 兜底文案，不出现 axios 英文原文', async () => {
    mockCreate.mockRejectedValue(new Error('Network Error'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Topic' }));

    fireEvent.change(screen.getByPlaceholderText('Topic title'), { target: { value: '新话题' } });
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Create Topic' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Create Topic' }),
    );

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const toasts = useNotificationStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Failed to create the topic. Please try again.');
      expect(toasts[0].title).not.toContain('Network Error');
      expect(toasts[0].variant).toBe('error');
    });
  });

  it('创建失败（4xx 业务原因）→ toast 透传服务端 message', async () => {
    mockCreate.mockRejectedValue({
      response: { status: 400, data: { code: 9000, message: 'title should not be empty' } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create Topic' }));

    fireEvent.change(screen.getByPlaceholderText('Topic title'), { target: { value: '空标题' } });
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Create Topic' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Create Topic' }),
    );

    await waitFor(() => {
      expect(useNotificationStore.getState().toasts[0]?.title).toBe('title should not be empty');
    });
  });

  it('编辑入口的详情拉取失败 → toast（不再是被吞掉的未处理 Promise 拒绝）', async () => {
    mockGetById.mockRejectedValue(new Error('Network Error'));
    renderPage();
    await screen.findByText('圆桌会议');

    // 第一张卡片的铅笔
    fireEvent.click(
      within(screen.getByRole('link', { name: /普通话题/ })).getByRole('button', {
        name: 'common.edit',
      }),
    );

    await waitFor(() => {
      const toasts = useNotificationStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toBe('Check your connection and try again.');
    });
    // 编辑 dialog 不该被打开（没有详情可编辑）
    expect(screen.queryByTestId('edit-attachment-ttl')).not.toBeInTheDocument();
  });

  // ── R-2 鉴别性用例（reviewer M1）─────────────────────────────────────────────
  // 上面各条都只在「刷新失败**且从未成功过**」下验证错误态：把判据从
  // `isError && data === undefined` 改成 `topics.length === 0` 后照样全绿——即无人能拦住
  // 这个回归。本条走 memory 页 R-2 的形态：**首载成功但列表为空 → refetch 失败**，断言空态
  // （含创建 CTA）不被错误态接管（零话题用户正是空态入口的主目标）。
  it('R-2 零话题用户：首载成功但列表为空 → refetch 失败 ⇒ 空态不被错误态接管', async () => {
    mockList.mockResolvedValueOnce({ items: [], total: 0 });
    const { queryClient, rerender } = renderPage();
    /** 重渲染用工厂：每次返回**新元素对象**——复用同一个 element 对象会被 React 直接
        bailout 跳过重渲染，那等于没重渲染（实测过的坑，见下方注释） */
    const renderTree = () => (
      <QueryClientProvider client={queryClient}>
        <TopicsPage />
      </QueryClientProvider>
    );
    expect(await screen.findByText('No topics')).toBeInTheDocument();

    mockList.mockRejectedValue(new Error('Network Error'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['topics', 'list'] });
    });
    // ⚠️ **显式重渲染（且必须是新元素对象）**：RQ 把失败通知投递给 observer 是**异步调度**的
    // （实测通知落不落地取决于并发时序，单跑/合跑结果都不同），直接读 DOM 会读到上一帧——
    // 那样把判据改回 `topics.length === 0` 也照样"通过"。而 `rerender(同一个 element 对象)`
    // 会被 React bailout 跳过 ⇒ 同样读不到新判据。二者叠加就是本用例鉴别力的全部来源。
    rerender(renderTree());

    // 先证明"刷新真的失败了且旧 data 仍在"——否则本用例可能只是没跑到那条分支
    const state = queryClient.getQueryState(['topics', 'list']);
    // QueryState 上没有 isError（那是 observer 结果上的派生布尔），状态机字段是 status
    expect(state?.status).toBe('error');
    expect(state?.data).toEqual({ items: [], total: 0 });

    // R-2：`isError && data={items:[]}` 不得触发错误态，否则空态 CTA 整棵被卸载
    expect(screen.queryByTestId('topics-list-error')).toBeNull();
    expect(screen.getByText('No topics')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create Topic' }).length).toBeGreaterThan(0);
  });
});

it('topic update failure retains the edited fields and retries', async () => {
  useNotificationStore.setState({ toasts: [], alerts: [] });
  mockGetById.mockResolvedValue({ ...NORMAL_TOPIC, description: 'Original description' });
  mockUpdate.mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('普通话题');
  fireEvent.click(
    within(screen.getByRole('link', { name: /普通话题/ })).getByRole('button', {
      name: 'common.edit',
    }),
  );
  fireEvent.change(await screen.findByDisplayValue('普通话题'), {
    target: { value: 'Keep topic title' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(useNotificationStore.getState().toasts[0]?.title).toBe(messages['topics.updateError']),
  );
  expect(screen.getByDisplayValue('Keep topic title')).toBeInTheDocument();
  mockUpdate.mockResolvedValue({});
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.queryByDisplayValue('Keep topic title')).not.toBeInTheDocument(),
  );
  expect(mockUpdate).toHaveBeenCalledTimes(2);
});
it('topic delete failure keeps the confirmation target and retries', async () => {
  useNotificationStore.setState({ toasts: [], alerts: [] });
  mockDelete.mockRejectedValue(new Error('Network Error'));
  renderPage();
  await screen.findByText('普通话题');
  fireEvent.click(
    within(screen.getByRole('link', { name: /普通话题/ })).getByRole('button', {
      name: 'common.delete',
    }),
  );
  const dialog = within(
    screen.getByRole('heading', { name: 'topics.delete.confirmTitle' }).parentElement!
      .parentElement!,
  );
  fireEvent.click(dialog.getByRole('button', { name: 'common.delete' }));
  await waitFor(() =>
    expect(useNotificationStore.getState().toasts[0]?.title).toBe(messages['topics.deleteError']),
  );
  expect(screen.getByRole('heading', { name: 'topics.delete.confirmTitle' })).toBeInTheDocument();
  mockDelete.mockResolvedValue({});
  fireEvent.click(dialog.getByRole('button', { name: 'common.delete' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: 'topics.delete.confirmTitle' }),
    ).not.toBeInTheDocument(),
  );
  expect(mockDelete).toHaveBeenCalledTimes(2);
});
