/**
 * seat-management.test.tsx — 圆桌座位管理分区契约测试（v1.49.0，C2；v1.51.0 适配；
 * 2026-08-12 改版：向导入口 = 头部轻量提示 → 模态框）
 *
 * 覆盖：① runner chips 渲染（name / vendors / 状态点，离线 runner 沉底不隐藏）；
 * ② 未认领座位（runnerId == null）→ 轻量提示「N 个座位待连接」（含计数），点击
 * 打开向导模态框（定位第一个未认领座位；向导经 getRunnerPlatformUrl 推导平台
 * URL）；③ 座位全认领 → 无提示无向导；④ onExitGuide 透传（全绿后「去 @ 它试试」
 * 触发外层动作 + 关闭模态框）；⑤ canManage 门控「添加座位」按钮显隐。文案断言用
 * en.json 快照；Api 全 mock（seats 经 listSeats mock 提供——SeatManagement 的
 * useSeatPresence 与页面同 key 共享）。
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeatManagement } from './seat-management';
import { Api } from '@/lib/api';

const messages: Record<string, string> = {
  'topics.seatMgmt.title': 'Roundtable seats',
  'topics.seatMgmt.addSeat': 'Add seat',
  // 简化非 ICU 形态（mock 不做 plural 解析；断言用词避开单复数差异）
  'topics.seatMgmt.pendingCount': '{count} seats awaiting connection →',
  'topics.seatGuide.connectTitle': 'Connect seat "{label}"',
  'topics.seatGuide.connectDesc':
    'This seat has no runner yet — connect one via the paths below; the result is verified automatically.',
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
  useLocale: () => 'en',
}));

jest.mock('@/lib/api', () => ({
  Api: {
    roundtable: {
      listRunners: jest.fn(),
      listSeats: jest.fn(),
      createSeat: jest.fn(),
    },
    agents: {
      listAll: jest.fn(),
    },
  },
}));

const mockListRunners = Api.roundtable.listRunners as jest.Mock;
const mockListSeats = Api.roundtable.listSeats as jest.Mock;

const ONLINE_RUNNER = {
  id: 'r1',
  name: 'local-dev',
  status: 'online',
  version: '0.3.1',
  vendors: ['kimi', 'codex'],
  lastSeenAt: new Date().toISOString(),
};
const OFFLINE_RUNNER = {
  id: 'r2',
  name: 'old-runner',
  status: 'offline',
  version: null,
  vendors: ['kimi'],
  lastSeenAt: null,
};

/** 未认领座位（runnerId == null）——向导默认展开的触发条件 */
const UNCLAIMED_SEAT = {
  id: 'seat-1',
  label: 'kimi-1',
  status: 'active',
  vendor: 'kimi',
  runnerId: null,
};
/** 已认领座位（runnerId != null）——连接闭环，不再渲染向导 */
const CLAIMED_SEAT = { ...UNCLAIMED_SEAT, runnerId: 'r1' };

function renderPanel(canManage = false, onExitGuide?: () => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SeatManagement topicId="t1" canManage={canManage} onExitGuide={onExitGuide} />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

beforeEach(() => {
  jest.clearAllMocks();
  (Api.agents.listAll as jest.Mock).mockResolvedValue([]);
  mockListSeats.mockResolvedValue([]);
});

describe('runner 状态行', () => {
  it('渲染 runner chips（name + vendors），离线 runner 也展示（沉底不隐藏）', async () => {
    mockListRunners.mockResolvedValue([ONLINE_RUNNER, OFFLINE_RUNNER]);
    renderPanel();
    expect(await screen.findByText('local-dev')).toBeInTheDocument();
    expect(screen.getByText('kimi, codex')).toBeInTheDocument();
    expect(screen.getByText('old-runner')).toBeInTheDocument();
  });

  it('座位全认领 → 不渲染连接向导（连接已闭环，不打扰），也无轻量提示', async () => {
    mockListRunners.mockResolvedValue([ONLINE_RUNNER]);
    mockListSeats.mockResolvedValue([CLAIMED_SEAT]);
    renderPanel();
    await screen.findByText('local-dev');
    await waitFor(() => expect(mockListSeats).toHaveBeenCalled());
    expect(screen.queryByTestId('seat-mgmt-pending-hint')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument();
  });
});

describe('连接向导入口（2026-08-12 改版：头部轻量提示 → 模态框）', () => {
  it('有未认领座位 → 轻量提示（含计数）而非常驻向导；点击 → 模态框打开向导', async () => {
    mockListRunners.mockResolvedValue([]);
    mockListSeats.mockResolvedValue([UNCLAIMED_SEAT]);
    renderPanel();
    const hint = await screen.findByTestId('seat-mgmt-pending-hint');
    // count=1（mock 简化文案，正则避开单复数形态）
    expect(hint).toHaveTextContent(/1.*awaiting connection/);
    // 未点击前不渲染向导（信息密度减重的核心）
    expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument();
    fireEvent.click(hint);
    const guide = await screen.findByTestId('runner-connect-guide');
    // 向导含平台 URL（经 getRunnerPlatformUrl 推导，测试环境 = jsdom origin）
    expect(guide).toHaveTextContent(window.location.origin);
    // 模态框标题 = 第一个未认领座位
    expect(screen.getByText('Connect seat "kimi-1"')).toBeInTheDocument();
  });

  it('多未认领座位 → 计数正确，点击定位第一个未认领座位', async () => {
    mockListRunners.mockResolvedValue([]);
    mockListSeats.mockResolvedValue([
      { ...UNCLAIMED_SEAT, id: 'seat-1', label: 'kimi-1' },
      { ...UNCLAIMED_SEAT, id: 'seat-2', label: 'kimi-2' },
    ]);
    renderPanel();
    const hint = await screen.findByTestId('seat-mgmt-pending-hint');
    expect(hint).toHaveTextContent('2 seats awaiting connection →');
    fireEvent.click(hint);
    await screen.findByTestId('runner-connect-guide');
    expect(screen.getByText('Connect seat "kimi-1"')).toBeInTheDocument();
  });

  it('onExitGuide 透传：向导全绿时点击「去 @ 它试试」→ 触发外层动作并关闭模态框', async () => {
    mockListRunners.mockResolvedValue([ONLINE_RUNNER]);
    // 首轮：未认领座位 → 轻量提示；点击 → 向导模态框
    mockListSeats.mockResolvedValue([UNCLAIMED_SEAT]);
    const onExitGuide = jest.fn();
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
    const { queryClient } = renderPanel(false, onExitGuide);
    fireEvent.click(await screen.findByTestId('seat-mgmt-pending-hint'));
    await screen.findByTestId('runner-connect-guide');

    // 座位被认领（listSeats 换值 + invalidate 重取）：liveSeat.runnerId 有值 →
    // 验收环全绿 → R10 按钮出现
    mockListSeats.mockResolvedValue([
      {
        ...UNCLAIMED_SEAT,
        runnerId: 'r1',
        presence: { phase: 'idle', at: new Date().toISOString() },
      },
    ]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['roundtable', 'seats', 't1'] });
    });
    const button = await screen.findByTestId('seat-guide-go-mention');
    fireEvent.click(button);
    await waitFor(() => expect(onExitGuide).toHaveBeenCalledTimes(1));
    // 模态框随退出动作关闭（向导卸载，轮询停止）
    await waitFor(() =>
      expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument(),
    );
  });
});

describe('canManage 门控', () => {
  it('无权限不显示「添加座位」按钮；有权限显示', async () => {
    mockListRunners.mockResolvedValue([ONLINE_RUNNER]);
    const { unmount } = renderPanel(false);
    await screen.findByText('local-dev');
    expect(screen.queryByTestId('seat-management-add')).not.toBeInTheDocument();
    unmount();
    renderPanel(true);
    expect(await screen.findByTestId('seat-management-add')).toBeInTheDocument();
  });
});
