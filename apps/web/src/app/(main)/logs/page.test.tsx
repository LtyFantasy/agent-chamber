/**
 * logs/page.test.tsx — 活动日志查询页测试（活动日志系统 Phase 4）
 *
 * 覆盖：buildLogsQuery 纯函数组装、过滤器状态 → 查询参数（mock 调用实参）、
 * 角色数据源边界（非 admin 不调 /admin/users、admin 调 /admin/users + /agents）、
 * actorId=null → System / actorName=null → Unknown / 软删角标、scope 回声展示
 * （null=全量 / 数组=受限）、IP 列字段存在性（非 admin 无列）、行展开 JSON pretty。
 * 文案断言用 en.json 快照（monitoring/page.test.tsx 同构）。
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LogsPage from './page';
import { buildLogsQuery } from '@/lib/logs-query';
import { Api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import type { ActivityLogItem, ActivityLogListResponse } from '@/types';

/** logs 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'logs.title': 'Activity Logs',
  'logs.description': 'Query platform write operations by actor, entity, action and time range',
  'logs.scope.admin': 'Admin view: all actors',
  'logs.scope.restricted': 'Restricted: {count} actor(s) visible',
  'logs.scope.scopeHint': 'Self + owned agents (incl. deleted) for non-admin users',
  'logs.filter.actor': 'Actor',
  'logs.filter.actorPlaceholder': 'All actors',
  'logs.filter.actorSearchPlaceholder': 'Search user or agent…',
  'logs.filter.actorEmpty': 'No matching actors',
  'logs.filter.actorClear': 'Clear actor filter',
  'logs.filter.actorAgentHint': 'agent',
  'logs.filter.entityType': 'Entity type',
  'logs.filter.entityTypeAll': 'All types',
  'logs.filter.action': 'Action',
  'logs.filter.actionAll': 'All actions',
  'logs.filter.timeRange': 'Time range',
  'logs.filter.timePresets.1h': 'Last 1 hour',
  'logs.filter.timePresets.24h': 'Last 24 hours',
  'logs.filter.timePresets.7d': 'Last 7 days',
  'logs.filter.timePresets.custom': 'Custom',
  'logs.filter.from': 'From',
  'logs.filter.to': 'To',
  'logs.filter.reset': 'Reset',
  'logs.table.title': 'Logs',
  'logs.table.time': 'Time',
  'logs.table.actor': 'Actor',
  'logs.table.action': 'Action',
  'logs.table.entity': 'Entity',
  'logs.table.ip': 'IP address',
  'logs.table.expand': 'View details',
  'logs.systemActor': 'System',
  'logs.deletedActor': 'deleted',
  'logs.unknownActor': 'Unknown',
  'logs.noLogs': 'No logs',
  'logs.noLogsDesc':
    'No activity logs match the current filters. Note: logging is best-effort — an empty result does not mean nothing happened.',
  'logs.pagination': 'Page {page} / {totalPages}, {pageSize} per page, {total} total',
  'logs.detail.diff': 'Diff',
  'logs.detail.newData': 'New data',
  'logs.detail.oldData': 'Old data',
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
  Api: {
    users: { list: jest.fn() },
    agents: { list: jest.fn() },
    logs: { list: jest.fn() },
  },
}));

const mockUsersList = Api.users.list as jest.Mock;
const mockAgentsList = Api.agents.list as jest.Mock;
const mockLogsList = Api.logs.list as jest.Mock;

const ADMIN_USER = {
  id: 'user-admin-1',
  email: 'admin@dev.local',
  name: 'Admin',
  role: 'admin' as const,
};
const HUMAN_USER = {
  id: 'user-human-1',
  email: 'human@dev.local',
  name: 'Human',
  role: 'editor' as const,
};

/** 构造 ActivityLogItem（缺省字段自动补全；ipAddress 按入参决定是否携带） */
function makeLog(overrides: Partial<ActivityLogItem> & { withIp?: boolean } = {}): ActivityLogItem {
  const { withIp = true, ...rest } = overrides;
  const base: ActivityLogItem = {
    id: 'log-1',
    action: 'create',
    entityType: 'task',
    entityId: 'task-1',
    actorId: 'user-1',
    actorType: 'user',
    actorName: 'Alice',
    actorDeletedAt: null,
    ipAddress: '127.0.0.1',
    userAgent: 'test-agent',
    createdAt: '2026-08-28T08:00:00.000Z',
    oldData: null,
    newData: null,
    diff: null,
    source: 'api',
  };
  if (!withIp) {
    delete base.ipAddress;
    delete base.userAgent;
  }
  return { ...base, ...rest };
}

function makeResponse(
  items: ActivityLogItem[],
  scope: string[] | null,
  overrides: Partial<ActivityLogListResponse> = {},
): ActivityLogListResponse {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: Math.max(1, Math.ceil(items.length / 20)),
    hasNext: false,
    hasPrev: false,
    scope,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LogsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // 默认：admin 登录 + 空日志列表（各用例按需 setState / mock 返回值）
  useAuthStore.setState({ user: ADMIN_USER, isAuthenticated: true });
  mockLogsList.mockResolvedValue(makeResponse([], null));
});

describe('buildLogsQuery（过滤器状态 → 查询参数组装，纯函数）', () => {
  it('全字段透传 + pageSize 固定 20', () => {
    expect(
      buildLogsQuery({
        actorId: 'a1',
        entityType: 'task',
        action: 'create',
        from: '2026-08-27T00:00:00.000Z',
        to: '2026-08-28T00:00:00.000Z',
        page: 2,
      }),
    ).toEqual({
      actorId: 'a1',
      entityType: 'task',
      action: 'create',
      from: '2026-08-27T00:00:00.000Z',
      to: '2026-08-28T00:00:00.000Z',
      page: 2,
      pageSize: 20,
    });
  });

  it('空筛选（空串/null/undefined）→ 键省略，不传空串给后端', () => {
    expect(buildLogsQuery({ actorId: null, entityType: '', action: '', page: 1 })).toEqual({
      page: 1,
      pageSize: 20,
    });
    expect(buildLogsQuery({ actorId: undefined, entityType: '', action: '', page: 1 })).toEqual({
      page: 1,
      pageSize: 20,
    });
  });
});

describe('LogsPage — 过滤器 → 查询参数', () => {
  it('默认加载：24h 预设 → from=ISO 字符串，page/pageSize 齐备', async () => {
    // 页面在渲染时取 now-24h；断言用渲染前快照 + 容差，避免毫秒级时序误报
    const before = Date.now();
    renderPage();
    await waitFor(() => expect(mockLogsList).toHaveBeenCalled());
    expect(mockLogsList).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 20,
      from: expect.any(String),
    });
    const fromMs = new Date(mockLogsList.mock.calls[0][0].from).getTime();
    expect(fromMs).toBeGreaterThan(before - 24 * 3_600_000 - 1000);
    expect(fromMs).toBeLessThanOrEqual(before);
  });

  it('选择 entityType/action 后查询参数带上对应值，且回到第 1 页', async () => {
    mockLogsList.mockResolvedValue(makeResponse([], null));
    renderPage();
    await waitFor(() => expect(mockLogsList).toHaveBeenCalledTimes(1));

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'task' } });
    fireEvent.change(selects[1], { target: { value: 'create' } });

    await waitFor(() => expect(mockLogsList).toHaveBeenCalledTimes(3));
    expect(mockLogsList).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 20,
      from: expect.any(String),
      entityType: 'task',
      action: 'create',
    });
  });

  it('自定义时间档：datetime-local 起止 → ISO 8601（UTC）', async () => {
    mockLogsList.mockResolvedValue(makeResponse([], null));
    renderPage();
    await waitFor(() => expect(mockLogsList).toHaveBeenCalledTimes(1));

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[2], { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2026-08-27T00:00' },
    });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-28T00:00' } });

    await waitFor(() => expect(mockLogsList).toHaveBeenCalledTimes(4));
    const last = mockLogsList.mock.calls[3][0];
    // datetime-local 为本地时区（本机 Asia/Shanghai）→ toISOString 转 UTC；
    // 期望值用同一 Date 构造派生，避免硬编码时区偏移
    expect(last.from).toBe(new Date('2026-08-27T00:00').toISOString());
    expect(last.to).toBe(new Date('2026-08-28T00:00').toISOString());
  });
});

describe('LogsPage — actor 选择器数据源（角色边界）', () => {
  it('admin：打开选择器 → /admin/users + /agents 并行调用（无 ownerId）', async () => {
    mockUsersList.mockResolvedValue({ items: [ADMIN_USER], total: 1 });
    mockAgentsList.mockResolvedValue({ items: [], total: 0 });
    renderPage();
    await waitFor(() => expect(mockLogsList).toHaveBeenCalled());

    // 触发按钮 = 含「All actors」占位文案的按钮
    fireEvent.click(screen.getByText('All actors'));

    await waitFor(() => expect(mockUsersList).toHaveBeenCalled());
    expect(mockAgentsList).toHaveBeenCalled();
    expect(mockAgentsList).toHaveBeenLastCalledWith(expect.objectContaining({ pageSize: 20 }));
    expect(mockAgentsList.mock.calls[0][0].ownerId).toBeUndefined();
  });

  it('非 admin：打开选择器 → 只调 /agents?ownerId=<me>，绝不调 /admin/users', async () => {
    useAuthStore.setState({ user: HUMAN_USER, isAuthenticated: true });
    mockAgentsList.mockResolvedValue({
      items: [{ id: 'agent-1', name: 'AgentOne', status: 'active', ownerId: HUMAN_USER.id }],
      total: 1,
    });
    renderPage();
    await waitFor(() => expect(mockLogsList).toHaveBeenCalled());

    fireEvent.click(screen.getByText('All actors'));

    // 空串搜索也会触发（popover 打开即搜）→ agents.list 带 ownerId=自己
    await waitFor(() => expect(mockAgentsList).toHaveBeenCalled());
    expect(mockAgentsList).toHaveBeenCalledWith({
      q: undefined,
      ownerId: HUMAN_USER.id,
      pageSize: 20,
    });
    // 非 admin 禁止触碰 /admin/users
    expect(mockUsersList).not.toHaveBeenCalled();
  });
});

describe('LogsPage — 表格渲染', () => {
  it('actorId=null → System；actorName=null（真孤儿）→ Unknown；软删 → deleted 角标', async () => {
    mockLogsList.mockResolvedValue(
      makeResponse(
        [
          makeLog({
            id: 'l1',
            actorId: null,
            actorName: null,
            actorDeletedAt: null,
            withIp: false,
          }),
          makeLog({
            id: 'l2',
            actorId: 'orphan-1',
            actorName: null,
            actorDeletedAt: null,
            withIp: false,
          }),
          makeLog({
            id: 'l3',
            actorId: 'gone-1',
            actorName: 'Gone',
            actorDeletedAt: '2026-08-01T00:00:00.000Z',
            withIp: false,
          }),
        ],
        ['user-human-1'],
      ),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('System')).toBeInTheDocument());
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Gone')).toBeInTheDocument();
    expect(screen.getByText('deleted')).toBeInTheDocument();
  });

  it('scope=null（admin）→ 「Admin view: all actors」', async () => {
    mockLogsList.mockResolvedValue(makeResponse([makeLog()], null));
    renderPage();
    await waitFor(() => expect(screen.getByText('Admin view: all actors')).toBeInTheDocument());
  });

  it('scope=数组（非 admin）→ 受限提示 + 计数', async () => {
    useAuthStore.setState({ user: HUMAN_USER, isAuthenticated: true });
    mockLogsList.mockResolvedValue(
      makeResponse([makeLog({ withIp: false })], [HUMAN_USER.id, 'agent-1']),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('Restricted: 2 actor(s) visible')).toBeInTheDocument(),
    );
  });

  it('非 admin 响应无 ipAddress 字段 → IP 列不渲染（SCOP 兜底）', async () => {
    useAuthStore.setState({ user: HUMAN_USER, isAuthenticated: true });
    mockLogsList.mockResolvedValue(makeResponse([makeLog({ withIp: false })], [HUMAN_USER.id]));
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByText('IP address')).not.toBeInTheDocument();
  });

  it('admin 响应含 ipAddress → IP 列渲染', async () => {
    mockLogsList.mockResolvedValue(makeResponse([makeLog()], null));
    renderPage();
    await waitFor(() => expect(screen.getByText('IP address')).toBeInTheDocument());
    expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
  });

  it('行展开：点击 chevron → newData/diff JSON pretty 渲染；再点收起', async () => {
    mockLogsList.mockResolvedValue(
      makeResponse(
        [
          makeLog({
            id: 'l1',
            newData: { taskId: 'task-1', title: 'T' },
            diff: { status: { from: 'todo', to: 'in_progress' } },
          }),
        ],
        null,
      ),
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByLabelText('View details')).toHaveLength(1));

    fireEvent.click(screen.getAllByLabelText('View details')[0]);

    await waitFor(() => expect(screen.getByText('New data')).toBeInTheDocument());
    expect(screen.getByText('Diff')).toBeInTheDocument();
    expect(screen.getByText(/"taskId": "task-1"/)).toBeInTheDocument();
    expect(screen.getByText(/"from": "todo"/)).toBeInTheDocument();
    // 无 oldData → 不渲染「Old data」段
    expect(screen.queryByText('Old data')).not.toBeInTheDocument();

    // 再点收起
    fireEvent.click(screen.getAllByLabelText('View details')[0]);
    await waitFor(() => expect(screen.queryByText('New data')).not.toBeInTheDocument());
  });

  it('空列表 → 空态文案（含「空结果不代表未发生」提示）', async () => {
    mockLogsList.mockResolvedValue(makeResponse([], null));
    renderPage();
    await waitFor(() => expect(screen.getByText('No logs')).toBeInTheDocument());
    expect(
      screen.getByText(
        'No activity logs match the current filters. Note: logging is best-effort — an empty result does not mean nothing happened.',
      ),
    ).toBeInTheDocument();
  });
});
