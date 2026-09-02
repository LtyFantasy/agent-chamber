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

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AgentsPage from './page';
import { Api } from '@/lib/api';
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('a1'));
  });
});
