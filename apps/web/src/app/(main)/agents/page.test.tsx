/**
 * agents/page.test.tsx — Agent 列表页删除确认弹窗影响面提示契约测试（统一批 B，A3-2 前端）。
 *
 * 覆盖四条产品细则：
 * ① seatCount > 0 → 追加「圆桌座位不会自动释放…」提示
 * ② openTaskCount > 0 → 追加「未完成任务不会自动改派」提示
 * ③ 四项全 0 → 简化文案（不展示"0 条"冗余列表）
 * ④ 接口失败 → 回退现文案，不阻塞删除（提示是增强不是门禁）
 *
 * 隔离策略：mock @/lib/api（listAll 渲染表格 + getDeletionImpact 弹窗计数）；
 * 文案用 en.json 快照（同 docs 页测试模式）。
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentsPage from './page';
import { Api } from '@/lib/api';
import { useNotificationStore } from '@/stores/notification.store';
import type { Agent, AgentDeletionImpact } from '@/types';

/** agents + common 命名空间 + 全键文案快照（同 en.json） */
const messages: Record<string, string> = {
  'agents.title': 'Agent Management',
  'agents.description': 'Manage your AI Agents',
  'agents.create': 'Create',
  'agents.empty': 'No agents',
  'agents.status.active': 'Active',
  'agents.table.name': 'Name',
  'agents.delete.title': 'Confirm deletion',
  'agents.delete.description':
    'This action is irreversible. Are you sure you want to delete this Agent?',
  'agents.delete.impactSeat':
    'Roundtable seats are not auto-released; this Agent cannot speak after deletion',
  'agents.delete.impactTasks': 'Open tasks are not auto-reassigned',
  'agents.delete.noImpact':
    'This Agent has no associated data. Its API Key will be revoked immediately. This action is irreversible.',
  'common.actions': 'Actions',
  'common.delete': 'Delete',
  // 重置 key 弹窗 + 新 key 展示（卡 72566c2e，m2）
  'agents.resetKey.title': 'Reset and View API Key',
  'agents.resetKey.confirm': 'Confirm Reset',
  'agents.resetKey.scopesHint': 'inherit strictest scopes',
  'agents.newKey.scopes': 'Permissions',
};

jest.mock('next-intl', () => ({
  // 组件新增 useLocale 依赖（formatRelativeTime/formatDate locale 下传），mock 固定 en
  useLocale: () => 'en',
  useTranslations: (ns?: string) => (key: string) => {
    const fullKey = ns ? `${ns}.${key}` : key;
    return messages[fullKey] ?? fullKey;
  },
}));

jest.mock('@/stores/auth.store', () => ({
  // admin 角色 → isAdmin 为 true（owner 列渲染；删除按钮不受角色影响）
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: 'admin' } }),
}));

jest.mock('@/lib/api', () => ({
  Api: {
    agents: {
      listAll: jest.fn(),
      getById: jest.fn(),
      getDeletionImpact: jest.fn(),
      delete: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      toggle: jest.fn(),
      resetKey: jest.fn(),
    },
  },
}));

const mockListAll = Api.agents.listAll as jest.Mock;
const mockGetDeletionImpact = Api.agents.getDeletionImpact as jest.Mock;
const mockDelete = Api.agents.delete as jest.Mock;

const AGENT: Agent = {
  id: 'a1',
  name: 'Agent One',
  status: 'active',
  apiKeyPrefix: 'ask_1234',
  topicCount: 2,
  messageCount: 5,
  lastActiveAt: '2026-08-01T00:00:00Z',
  createdAt: '2026-08-01T00:00:00Z',
};

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AgentsPage />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

/** 打开删除确认弹窗（表格渲染 → 点删除按钮 → getDeletionImpact 查询） */
async function openDeleteDialog(impact: AgentDeletionImpact | Error) {
  if (impact instanceof Error) mockGetDeletionImpact.mockRejectedValue(impact);
  else mockGetDeletionImpact.mockResolvedValue(impact);
  renderPage();
  await screen.findByText('Agent One');
  fireEvent.click(screen.getByTestId('delete-agent-a1'));
  // 弹窗打开（自研 Dialog 无 role="dialog"，按标题文本定位）
  await screen.findByText('Confirm deletion');
}

describe('AgentsPage 删除确认弹窗（统一批 B 影响面提示）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAll.mockResolvedValue([AGENT]);
    mockDelete.mockResolvedValue(undefined);
  });

  it('① seatCount > 0 → 原文案 + 追加「圆桌座位不会自动释放」提示', async () => {
    await openDeleteDialog({
      openTaskCount: 0,
      messageCount: 10,
      topicCount: 3,
      seatCount: 2,
    });

    // 追加座位提示（impact 查询异步 resolve 后渲染）
    expect(
      await screen.findByText(
        'Roundtable seats are not auto-released; this Agent cannot speak after deletion',
      ),
    ).toBeInTheDocument();
    // 非全 0 → 原文案保留
    expect(
      screen.getByText('This action is irreversible. Are you sure you want to delete this Agent?'),
    ).toBeInTheDocument();
    // 无任务提示（openTaskCount=0 不追加）
    expect(screen.queryByText('Open tasks are not auto-reassigned')).not.toBeInTheDocument();
  });

  it('② openTaskCount > 0 → 原文案 + 追加「未完成任务不会自动改派」提示', async () => {
    await openDeleteDialog({
      openTaskCount: 3,
      messageCount: 0,
      topicCount: 0,
      seatCount: 0,
    });

    expect(await screen.findByText('Open tasks are not auto-reassigned')).toBeInTheDocument();
    expect(
      screen.getByText('This action is irreversible. Are you sure you want to delete this Agent?'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Roundtable seats are not auto-released; this Agent cannot speak after deletion',
      ),
    ).not.toBeInTheDocument();
  });

  it('③ 四项全 0 → 简化文案（不展示"0 条"冗余列表，原文案被替换）', async () => {
    await openDeleteDialog({
      openTaskCount: 0,
      messageCount: 0,
      topicCount: 0,
      seatCount: 0,
    });

    expect(
      await screen.findByText(
        'This Agent has no associated data. Its API Key will be revoked immediately. This action is irreversible.',
      ),
    ).toBeInTheDocument();
    // 简化文案替代原文案（不展示"0 条"列表）
    expect(
      screen.queryByText(
        'This action is irreversible. Are you sure you want to delete this Agent?',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Roundtable seats are not auto-released; this Agent cannot speak after deletion',
      ),
    ).not.toBeInTheDocument();
  });

  it('④ 接口失败 → 回退现文案，不阻塞删除（确认按钮仍可执行删除）', async () => {
    await openDeleteDialog(new Error('network down'));

    // 回退原文案
    expect(
      screen.getByText('This action is irreversible. Are you sure you want to delete this Agent?'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'This Agent has no associated data. Its API Key will be revoked immediately. This action is irreversible.',
      ),
    ).not.toBeInTheDocument();

    // 不阻塞删除：确认后调用 DELETE
    fireEvent.click(
      within(
        screen.getByRole('heading', { name: 'Confirm deletion' }).parentElement!.parentElement!,
      ).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('a1'));
  });
});

describe('AgentsPage 详情页入口（遥测 follow-up F1）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAll.mockResolvedValue([AGENT]);
  });

  it('agent 名字渲染为链接，href 指向 /agents/<id> 遥测详情页', async () => {
    renderPage();

    // 名字即入口（暗页 → 可达）；next/link 在 jsdom 渲染为普通 <a>
    const link = await screen.findByRole('link', { name: 'Agent One' });
    expect(link).toHaveAttribute('href', '/agents/a1');
  });
});

/**
 * resetKey 新 key 权限展示（2026-10-16 卡 72566c2e，code-review m2）。
 *
 * 后端响应白名单带 `scopes`；本用例证明前端**真的消费**了它（渲染实际权限而非只有静态文案），
 * 否则该契约字段就是死的（类型声明无人读取）。重置弹窗里另有一行 scopes 继承语义提示。
 */
describe('AgentsPage 重置 key 弹窗（scopes 契约字段真被消费）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListAll.mockResolvedValue([AGENT]);
  });

  it('resetKey 响应带 scopes → 新 key 弹窗渲染实际权限', async () => {
    (Api.agents.resetKey as jest.Mock).mockResolvedValue({
      apiKey: 'ask_new_key_value',
      scopes: ['read'],
    });
    renderPage();
    await screen.findByText('Agent One');

    fireEvent.click(screen.getByTestId('reset-key-a1'));
    await screen.findByText('Reset and View API Key');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reset' }));

    await screen.findByText('ask_new_key_value');
    expect(screen.getByTestId('new-key-scopes')).toHaveTextContent('read');
  });

  it('响应缺 scopes（旧后端兼容）→ 不渲染该行，不崩', async () => {
    (Api.agents.resetKey as jest.Mock).mockResolvedValue({ apiKey: 'ask_legacy_key' });
    renderPage();
    await screen.findByText('Agent One');

    fireEvent.click(screen.getByTestId('reset-key-a1'));
    await screen.findByText('Reset and View API Key');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reset' }));

    await screen.findByText('ask_legacy_key');
    expect(screen.queryByTestId('new-key-scopes')).not.toBeInTheDocument();
  });
});

describe('operation failures retain their recovery controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useNotificationStore.setState({ toasts: [], alerts: [] });
    mockListAll.mockResolvedValue([AGENT]);
    mockGetDeletionImpact.mockResolvedValue({
      openTaskCount: 0,
      messageCount: 0,
      topicCount: 0,
      seatCount: 0,
    });
    (Api.agents.getById as jest.Mock).mockResolvedValue({
      ...AGENT,
      description: 'Old description',
    });
  });
  it('status failure keeps the row and can retry', async () => {
    (Api.agents.toggle as jest.Mock).mockRejectedValue(new Error('Network Error'));
    renderPage();
    const row = (await screen.findByText('Agent One')).closest('tr')!;
    const button = within(row).getByRole('button', {
      name: 'agents.table.status: agents.status.disabled',
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(useNotificationStore.getState().toasts[0]?.title).toBe('agents.toggleFailed'),
    );
    expect(within(row).getByText('Active')).toBeInTheDocument();
    (Api.agents.toggle as jest.Mock).mockResolvedValue({});
    fireEvent.click(button);
    await waitFor(() => expect(Api.agents.toggle).toHaveBeenCalledTimes(2));
    expect(useNotificationStore.getState().toasts).toHaveLength(1);
  });
  it('update failure keeps edited inputs and retries', async () => {
    (Api.agents.update as jest.Mock).mockRejectedValue(new Error('Network Error'));
    renderPage();
    const row = (await screen.findByText('Agent One')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'common.edit' }));
    fireEvent.change(await screen.findByDisplayValue('Old description'), {
      target: { value: 'Keep edited description' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(useNotificationStore.getState().toasts[0]?.title).toBe('agents.updateFailed'),
    );
    expect(screen.getByDisplayValue('Keep edited description')).toBeInTheDocument();
    (Api.agents.update as jest.Mock).mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('Keep edited description')).not.toBeInTheDocument(),
    );
    expect(Api.agents.update).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['delete', 'Delete', 'Confirm deletion', 'Delete', 'agents.deleteFailed'],
    [
      'resetKey',
      'Reset and View API Key',
      'Reset and View API Key',
      'Confirm Reset',
      'agents.resetKeyFailed',
    ],
  ])(
    '%s failure keeps confirmation and can retry',
    async (method, trigger, title, action, fallback) => {
      const request = Api.agents[method as 'delete' | 'resetKey'] as jest.Mock;
      request.mockRejectedValue({
        response: { status: 500, data: { code: 500, message: 'internal stack' } },
      });
      renderPage();
      const row = (await screen.findByText('Agent One')).closest('tr')!;
      fireEvent.click(within(row).getByRole('button', { name: trigger }));
      const dialog = within((await screen.findByText(title)).parentElement!.parentElement!);
      fireEvent.click(dialog.getByRole('button', { name: action }));
      await waitFor(() => expect(useNotificationStore.getState().toasts[0]?.title).toBe(fallback));
      expect(screen.getByText(title)).toBeInTheDocument();
      request.mockResolvedValue({ apiKey: 'test-new-key', scopes: ['read'] });
      fireEvent.click(dialog.getByRole('button', { name: action }));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText(title)).not.toBeInTheDocument());
    },
  );
});
