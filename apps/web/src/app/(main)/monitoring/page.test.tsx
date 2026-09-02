/**
 * monitoring/page.test.tsx — 系统监控页渲染测试
 *
 * 覆盖：关注带（全零 → All systems normal；有异常 → 计数项出现）、圆桌健康
 * （runner 在线比 / 座位 backlogEstimate，null → Unknown 不显示 0）、webhook
 * 空态（无投递 → No deliveries yet 而非 0%）、事件总线区块渲染。
 * 文案断言用 en.json 快照。
 */

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MonitoringPage from './page';
import { Api } from '@/lib/api';
import type { SystemOverview } from '@/types';

/** monitoring 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'monitoring.title': 'System Monitoring',
  'monitoring.description': 'View platform API audit logs and system status',
  'monitoring.exportLogs': 'Export Logs',
  'monitoring.todayCount': "Today's Operations",
  'monitoring.totalCount': 'Total Records',
  'monitoring.uniqueActors': 'Unique Actors',
  'monitoring.apiLogs': 'API Logs',
  'monitoring.noLogs': 'No logs',
  'monitoring.noLogsDesc': 'API call logs will appear here',
  'monitoring.attention.allClear': 'All systems normal',
  'monitoring.attention.needsAttention': 'Needs attention',
  'monitoring.attention.runnersOffline': '{count} runner(s) offline',
  'monitoring.attention.seatsBacklog': '{count} seat(s) with unconsumed messages',
  'monitoring.attention.webhookIssues': '{count} deliveries failed/retrying',
  'monitoring.system.title': 'System Info',
  'monitoring.system.version': 'Version',
  'monitoring.system.commit': 'Commit',
  'monitoring.system.uptime': 'Uptime',
  'monitoring.system.generatedAt': 'Data as of',
  'monitoring.roundtable.runners': 'Runners',
  'monitoring.roundtable.seats': 'Seats',
  'monitoring.roundtable.online': 'online',
  'monitoring.roundtable.noRunners': 'No runners registered',
  'monitoring.roundtable.noSeats': 'No seats',
  'monitoring.roundtable.seatCount': '{count} seat(s)',
  'monitoring.roundtable.neverSeen': 'never seen',
  'monitoring.roundtable.unbound': '{count} unbound',
  'monitoring.roundtable.unboundBadge': 'unbound',
  'monitoring.roundtable.backlog': '{count} unconsumed',
  'monitoring.roundtable.backlogUnknown': 'Unknown',
  'monitoring.roundtable.injection': 'Injection Pipeline',
  'monitoring.roundtable.latencyAvg': 'Avg injection latency',
  'monitoring.roundtable.latencyMax': 'Max injection latency',
  'monitoring.roundtable.latencySamples': '{count} sample(s)',
  'monitoring.roundtable.noSamples': 'Samples collected since this version',
  'monitoring.roundtable.retryCount': 'Send retries (total)',
  'monitoring.roundtable.failCount': 'Injection failures (total)',
  'monitoring.pipeline.events': 'Event Bus',
  'monitoring.pipeline.webhooks': 'Webhook Deliveries',
  'monitoring.pipeline.last24h': 'Events in last 24h',
  'monitoring.pipeline.total': 'Total events',
  'monitoring.pipeline.latestEvent': 'Latest event',
  'monitoring.pipeline.noEvents': 'No events',
  'monitoring.pipeline.successRate': 'Delivery success rate',
  'monitoring.pipeline.avgLatency': 'Avg latency',
  'monitoring.pipeline.failed': 'Failed',
  'monitoring.pipeline.retrying': 'Retrying',
  'monitoring.pipeline.noDeliveries': 'No deliveries yet',
  'monitoring.pipeline.sse': 'SSE Push',
  'monitoring.pipeline.activeConnections': 'Active connections',
  'monitoring.pipeline.sseDesc': 'In-process gauge of /events/stream',
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

jest.mock('@/lib/api', () => ({
  Api: {
    monitoring: {
      getOverview: jest.fn(),
      getHealth: jest.fn(),
      getApiLogs: jest.fn(),
      exportApiLogs: jest.fn(),
    },
  },
  // 值域常量（与 api.ts 单源一致；runner 状态 badge 消费）
  RUNNER_STATUS: { ONLINE: 'online', OFFLINE: 'offline' },
}));

const mockApi = Api.monitoring as jest.Mocked<typeof Api.monitoring>;

function makeOverview(overrides: Partial<SystemOverview> = {}): SystemOverview {
  return {
    generatedAt: '2026-08-15T09:00:00.000Z',
    runners: {
      total: 1,
      online: 1,
      offline: 0,
      items: [
        {
          id: 'r1',
          name: 'prod-kimi',
          status: 'online',
          version: '0.4.0',
          lastSeenAt: '2026-08-15T08:59:00.000Z',
          seatCount: 2,
        },
      ],
    },
    seats: {
      total: 2,
      unbound: 0,
      byStatus: { active: 2 },
      items: [
        {
          id: 's1',
          label: 'kimi-1',
          vendor: 'kimi',
          status: 'active',
          topicId: 't1',
          runnerId: 'r1',
          backlogEstimate: 0,
        },
        {
          id: 's2',
          label: 'codex-1',
          vendor: 'codex',
          status: 'active',
          topicId: 't1',
          runnerId: 'r1',
          backlogEstimate: null,
        },
      ],
    },
    events: {
      total: 100,
      last24h: 12,
      latestEventAt: '2026-08-15T08:59:30.000Z',
      byTypeLast24h: [{ eventType: 'message.created', count: 10 }],
    },
    webhooks: {
      total: 0,
      pending: 0,
      success: 0,
      failed: 0,
      retrying: 0,
      successRate: null,
      avgResponseTimeMs: null,
    },
    // 1.54.0 埋点批：默认空态（samples=0）+ sse gauge 0；用例按需 override
    injection: {
      latencySamples: 0,
      latencyAvgMs: null,
      latencyMaxMs: null,
      retryCount: 0,
      failCount: 0,
    },
    sse: { activeConnections: 0 },
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MonitoringPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.getHealth.mockResolvedValue({
    status: 'ok',
    timestamp: '2026-08-15T09:00:00.000Z',
    uptime: 90061,
    version: '1.52.0-dev',
    commit: '44fa9e3',
  });
  mockApi.getApiLogs.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
    hasNext: false,
    hasPrev: false,
    // 后端全量聚合值（ce579dda）：取与页面其他数字不撞车的值以便断言
    todayCount: 42,
    uniqueActors: 17,
  });
});

describe('MonitoringPage', () => {
  it('shows all-clear strip and roundtable/pipeline sections when healthy', async () => {
    mockApi.getOverview.mockResolvedValue(makeOverview());

    renderPage();

    await waitFor(() => expect(screen.getByText('All systems normal')).toBeInTheDocument());
    expect(screen.getByText('Runners')).toBeInTheDocument();
    expect(screen.getByText('Seats')).toBeInTheDocument();
    expect(screen.getByText('Event Bus')).toBeInTheDocument();
    expect(screen.getByText('Webhook Deliveries')).toBeInTheDocument();
    // runner 在线比与座位行
    expect(screen.getByText('prod-kimi')).toBeInTheDocument();
    expect(screen.getByText('kimi-1')).toBeInTheDocument();
    // backlogEstimate null → Unknown（不得显示为 0 unconsumed）：
    // 「0 unconsumed」全页只出现一次（s1 的真实 0 估计），s2 显示 Unknown
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getAllByText('0 unconsumed')).toHaveLength(1);
    // 无 webhook 投递 → 空态文案而非 0%
    expect(screen.getByText('No deliveries yet')).toBeInTheDocument();
    // 系统信息（version/commit 来自 /health）
    await waitFor(() => expect(screen.getByText('1.52.0-dev')).toBeInTheDocument());
    expect(screen.getByText('44fa9e3')).toBeInTheDocument();
  });

  it('renders stat cards from backend aggregates (not client-side page filtering)', async () => {
    mockApi.getOverview.mockResolvedValue(makeOverview());

    renderPage();

    // todayCount=42 / uniqueActors=17 来自后端聚合 mock（items 为空，
    // 若按旧客户端过滤逻辑算会显示 0，据此可区分新旧实现）
    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument());
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText("Today's Operations")).toBeInTheDocument();
    expect(screen.getByText('Unique Actors')).toBeInTheDocument();
  });

  it('shows attention items when runners offline, seats backlogged, webhooks failing', async () => {
    const overview = makeOverview({
      runners: {
        total: 2,
        online: 1,
        offline: 1,
        items: [
          {
            id: 'r1',
            name: 'prod-kimi',
            status: 'online',
            version: null,
            lastSeenAt: null,
            seatCount: 1,
          },
          {
            id: 'r2',
            name: 'dead-runner',
            status: 'offline',
            version: null,
            lastSeenAt: null,
            seatCount: 0,
          },
        ],
      },
      seats: {
        total: 1,
        unbound: 0,
        byStatus: { active: 1 },
        items: [
          {
            id: 's1',
            label: 'kimi-1',
            vendor: 'kimi',
            status: 'active',
            topicId: 't1',
            runnerId: 'r1',
            backlogEstimate: 3,
          },
        ],
      },
      webhooks: {
        total: 10,
        pending: 2,
        success: 7,
        failed: 1,
        retrying: 1,
        successRate: 0.875,
        avgResponseTimeMs: 123,
      },
    });
    mockApi.getOverview.mockResolvedValue(overview);

    renderPage();

    await waitFor(() => expect(screen.getByText('Needs attention')).toBeInTheDocument());
    expect(screen.getByText('1 runner(s) offline')).toBeInTheDocument();
    expect(screen.getByText('1 seat(s) with unconsumed messages')).toBeInTheDocument();
    // failed 1 + retrying 1 = 2
    expect(screen.getByText('2 deliveries failed/retrying')).toBeInTheDocument();
    // 座位积压中性呈现
    expect(screen.getByText('3 unconsumed')).toBeInTheDocument();
    // webhook 成功率与耗时
    expect(screen.getByText('87.5%')).toBeInTheDocument();
    expect(screen.getByText('123ms')).toBeInTheDocument();
  });

  it('renders without overview (request pending/failed) and keeps api-logs section', async () => {
    mockApi.getOverview.mockRejectedValue(new Error('network'));

    renderPage();

    // 原有 api-logs 区块不受影响
    await waitFor(() => expect(screen.getByText('API Logs')).toBeInTheDocument());
    expect(screen.getByText('No logs')).toBeInTheDocument();
    expect(screen.queryByText('All systems normal')).not.toBeInTheDocument();
  });

  it('renders injection pipeline empty state and SSE connection count (1.54.0)', async () => {
    // 默认 makeOverview：samples=0（空态）+ sse.activeConnections=0
    mockApi.getOverview.mockResolvedValue(makeOverview());

    renderPage();

    // 注入管线卡片：samples=0 → 空态文案（不得显示 0ms）
    await waitFor(() =>
      expect(screen.getByText('Samples collected since this version')).toBeInTheDocument(),
    );
    expect(screen.getByText('Injection Pipeline')).toBeInTheDocument();
    expect(screen.getByText('Send retries (total)')).toBeInTheDocument();
    expect(screen.getByText('Injection failures (total)')).toBeInTheDocument();
    // SSE 推送卡片：连接数渲染（组合文案 = 标签 + 进程内 gauge 说明；
    // 裸数字 0 与 statCards 的 0 撞车，故用组合文本断言）
    expect(screen.getByText('SSE Push')).toBeInTheDocument();
    expect(
      screen.getByText('Active connections · In-process gauge of /events/stream'),
    ).toBeInTheDocument();
  });

  it('renders injection latency avg/max/samples and retry/fail counts when samples > 0', async () => {
    mockApi.getOverview.mockResolvedValue(
      makeOverview({
        injection: {
          latencySamples: 3,
          latencyAvgMs: 1234,
          latencyMaxMs: 1500,
          // 取值避开页面其他裸数字（statCards 42/0/17、events 12/100 等）以免 getByText 歧义
          retryCount: 7,
          failCount: 3,
        },
        sse: { activeConnections: 5 },
      }),
    );

    renderPage();

    // samples>0 → 均值大字 + avg/max/samples 明细行（samples=0 的空态不得同时出现）
    await waitFor(() => expect(screen.getByText('1234ms')).toBeInTheDocument());
    expect(screen.getByText('Avg injection latency')).toBeInTheDocument();
    expect(screen.getByText('Max injection latency')).toBeInTheDocument();
    expect(screen.getByText('1500ms')).toBeInTheDocument();
    expect(screen.getByText('3 sample(s)')).toBeInTheDocument();
    expect(screen.queryByText('Samples collected since this version')).not.toBeInTheDocument();
    // 计数渲染（含非零告警色 class 语义：retry amber / fail destructive）
    expect(screen.getByText('Send retries (total)')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Injection failures (total)')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // SSE 连接数渲染
    expect(screen.getByText('5')).toBeInTheDocument();
  });
});
