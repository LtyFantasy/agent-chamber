/**
 * topics/page.test.tsx — 话题列表页圆桌批次契约测试（v1.49.0）
 *
 * 覆盖：① 列表卡片圆桌 badge（kind='roundtable' 渲染、normal 不渲染）；
 * ② 创建 dialog 的 kind radio 分支（默认普通不展开圆桌配置；选圆桌后展开
 * wakePolicy/maxRounds + 不可变提示）；③ 创建提交 payload（圆桌携带
 * config {kind, wakePolicy, maxRoundsWithoutHuman?}，普通不携带 config）。
 * 文案断言用 en.json 快照；Api/auth store 全 mock（页面级测试不触网络）。
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TopicsPage from './page';
import { Api } from '@/lib/api';

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
  'common.cancel': 'Cancel',
  'common.save': 'Save',
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
  return render(
    <QueryClientProvider client={queryClient}>
      <TopicsPage />
    </QueryClientProvider>,
  );
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
    const buttons = screen.getAllByRole('button', { name: 'Create Topic' });
    fireEvent.click(buttons[buttons.length - 1]);

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
    const buttons = screen.getAllByRole('button', { name: 'Create Topic' });
    fireEvent.click(buttons[buttons.length - 1]);

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
    const buttons = screen.getAllByRole('button', { name: 'Create Topic' });
    fireEvent.click(buttons[buttons.length - 1]);

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
    const buttons = screen.getAllByRole('button', { name: 'Create Topic' });
    fireEvent.click(buttons[buttons.length - 1]);

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
    const allButtons = screen.getAllByRole('button');
    fireEvent.click(allButtons[1]);

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

    fireEvent.click(screen.getAllByRole('button')[1]);

    const select = (await screen.findByTestId('edit-attachment-ttl')) as HTMLSelectElement;
    await waitFor(() => expect(select).toHaveValue('7d'));
  });
});
