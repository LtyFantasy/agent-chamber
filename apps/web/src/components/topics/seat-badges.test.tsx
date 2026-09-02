/**
 * seat-badges.test.tsx — 圆桌座位 chip 组渲染契约测试（M3 阶段 3 r13 + 阶段 5 配置观测，
 * 2026-08-08 改版：由 seat-manager.test.tsx 移植——座位块移入参与者面板后无容器/无标题；
 * 2026-08-12：未认领 chip 可点击打开连接向导模态框）
 *
 * 覆盖：座位 chip 渲染（label / status 徽章 / 主脑标记 / 实际运行配置三件套
 * model-thinking-mode，缺省字段不渲染对应项）；空座位零渲染（enabled 职责已上移到
 * 页面调用方短路，组件不再持有）；canManage 权限闸（无权限不显示移除按钮）；移除
 * 交互（confirm 取消不调 API / 确认后调 deleteSeat 并 invalidate seats + 消息列表）；
 * 移除失败内联提示；连接向导模态框（未认领 chip 显示「待连接」+ 点击打开 Dialog 内含
 * RunnerConnectGuide / 键盘 Enter 同效 / 已认领 chip 不可点击 / 移除按钮点击不连带
 * 打开向导 / onExitGuide 透传）。文案断言用 en.json 快照；全局 confirm（lib/notify）
 * 直接 mock（jsdom 未实现异步 Promise 弹窗，mock 返回值控制结果）。
 */

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { SeatBadges } from './seat-badges';
import { Api, type RoundtableSeatItem } from '@/lib/api';
import { confirm } from '@/lib/notify';

/** topics.seatManager/seatGuide 命名空间的英语文案快照（同 en.json；title 已随旧容器移除） */
const messages: Record<string, string> = {
  'topics.seatManager.coordinator': 'Coordinator',
  'topics.seatManager.coordinatorTitle': 'Coordinator seat',
  'topics.seatManager.thinking': 'Thinking',
  'topics.seatManager.pendingConnect': 'Not connected',
  'topics.seatManager.remove': 'Remove',
  'topics.seatManager.removeTitle': 'Remove seat',
  'topics.seatManager.removeConfirm': 'Remove seat {label}? Its session will be stopped.',
  'topics.seatManager.removeFailed': 'Failed to remove seat, please retry',
  'topics.seatManager.removedForbidden': 'No permission to remove this seat',
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
      deleteSeat: jest.fn(),
      // 向导（弹窗内）的轮询数据源：默认空列表，用例按需 mock
      listRunners: jest.fn(),
      listSeats: jest.fn(),
    },
  },
  // 值域常量（与 api.ts 单源一致；组件 statusBadgeClass 消费）
  SEAT_LIFECYCLE_STATUSES: ['active', 'paused', 'parked', 'offline', 'removed'],
  SEAT_LIFECYCLE_STATUS: {
    ACTIVE: 'active',
    PAUSED: 'paused',
    PARKED: 'parked',
    OFFLINE: 'offline',
    REMOVED: 'removed',
  },
  // 值域常量（与 api.ts 单源一致；内嵌 RunnerConnectGuide 的 runner 在线判定消费）
  RUNNER_STATUS: { ONLINE: 'online', OFFLINE: 'offline' },
  // 值域常量（与 api.ts 单源一致；内嵌 RunnerConnectGuide 的 presence 存活判定消费）
  PRESENCE_PHASE: {
    THINKING: 'thinking',
    TOOL: 'tool',
    REPLYING: 'replying',
    IDLE: 'idle',
    OFFLINE: 'offline',
  },
}));

// 全局 confirm mock：resolve 值控制「确认/取消」分支（异步确认需 await act 结算）
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
}));
const mockConfirm = confirm as jest.Mock;

const mockDelete = Api.roundtable.deleteSeat as jest.Mock;
const mockListRunners = Api.roundtable.listRunners as jest.Mock;
const mockListSeats = Api.roundtable.listSeats as jest.Mock;

const TOPIC_ID = 't1';

const SEATS: RoundtableSeatItem[] = [
  { id: 'seat-1', label: 'Seat Alpha', status: 'active', vendor: 'kimi', runnerId: null },
  {
    id: 'seat-2',
    label: 'Seat Beta',
    status: 'offline',
    vendor: 'kimi',
    runnerId: null,
    coordinator: true,
    state: { modelInfo: { model: 'kimi-k2', thinking: 'high', mode: 'auto' } },
  },
];
/** 已认领座位（runnerId != null）——chip 无待连接提示、不可点击 */
const CLAIMED_SEAT: RoundtableSeatItem = {
  id: 'seat-claimed',
  label: 'Seat Claimed',
  status: 'active',
  vendor: 'kimi',
  runnerId: 'r1',
};

function renderBadges(
  props: {
    topicId?: string;
    seats?: RoundtableSeatItem[];
    canManage?: boolean;
    onExitGuide?: () => void;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SeatBadges
        topicId={props.topicId ?? TOPIC_ID}
        seats={props.seats}
        canManage={props.canManage}
        onExitGuide={props.onExitGuide}
      />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

describe('SeatBadges 座位 chip 组', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    jest.clearAllMocks();
    // 向导轮询数据源缺省：无 runner、无座位（弹窗内向导静默待机）
    mockListRunners.mockResolvedValue([]);
    mockListSeats.mockResolvedValue([]);
  });

  it('渲染座位 chip：label + status 徽章；主脑座位带 Coordinator 徽章', async () => {
    const { container } = renderBadges({ seats: SEATS });

    expect(screen.getByText('Seat Alpha')).toBeInTheDocument();
    expect(screen.getByText('Seat Beta')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="seat-chip"]')).toHaveLength(2);
    // status 是协议值不翻译，原样展示（active/offline）
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
    // 仅 coordinator 座位渲染主脑徽章
    expect(screen.getAllByText('Coordinator')).toHaveLength(1);
  });

  it('M3 阶段 5：实际运行配置三件套渲染（model/thinking/mode，值原文透传）', async () => {
    const { container } = renderBadges({ seats: SEATS });

    // 有 modelInfo 的座位：三件套齐全（model 值原文、Thinking 译 label + 等级、mode 值原文）
    expect(screen.getByText('kimi-k2')).toBeInTheDocument();
    expect(screen.getByText('Thinking high')).toBeInTheDocument();
    expect(screen.getByText('auto')).toBeInTheDocument();
    // 无 modelInfo 的座位：不渲染配置组
    expect(container.querySelector('[data-testid="seat-model-info-seat-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="seat-model-info-seat-2"]')).not.toBeNull();
  });

  it('M3 阶段 5：modelInfo 缺省字段不渲染对应项（部分字段只显示提供的）', () => {
    const { container } = renderBadges({
      seats: [
        {
          id: 'seat-3',
          label: 'Seat Gamma',
          status: 'active',
          vendor: 'kimi',
          runnerId: null,
          state: { modelInfo: { mode: 'yolo' } },
        },
      ],
    });

    // 只提供 mode：仅 mode 渲染，model/thinking 对应项不出现
    expect(container.querySelector('[data-testid="seat-mode-seat-3"]')).toHaveTextContent('yolo');
    expect(container.querySelector('[data-testid="seat-model-seat-3"]')).toBeNull();
    expect(container.querySelector('[data-testid="seat-thinking-seat-3"]')).toBeNull();
  });

  it('空座位 → 零渲染（空态不打扰；enabled 短路职责已上移页面调用方）', () => {
    const { container } = renderBadges({ seats: [] });
    expect(container.querySelector('[data-testid="seat-badges"]')).toBeNull();
  });

  it('无管理权限（canManage=false）→ 不渲染移除按钮', () => {
    const { container } = renderBadges({ seats: SEATS, canManage: false });
    expect(container.querySelector('[data-testid^="remove-seat-"]')).toBeNull();
  });

  it('有管理权限：confirm 取消 → 不调 deleteSeat', async () => {
    mockConfirm.mockResolvedValue(false);
    const { container } = renderBadges({ seats: SEATS, canManage: true });

    fireEvent.click(container.querySelector('[data-testid="remove-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise（异步确认无同步阻塞）

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Remove seat Seat Alpha'),
      }),
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('有管理权限：confirm 确认 → 调 deleteSeat + invalidate seats 与消息列表', async () => {
    mockConfirm.mockResolvedValue(true);
    mockDelete.mockResolvedValue({ ...SEATS[0], status: 'removed' });
    const { queryClient, container } = renderBadges({ seats: SEATS, canManage: true });
    // 预置联动目标缓存：invalidate 后 isInvalidated 置 true（观测 invalidate 发生）
    queryClient.setQueryData(['roundtable', 'seats', TOPIC_ID], SEATS);
    queryClient.setQueryData(['topics', 'messages', TOPIC_ID], { messages: [] });

    fireEvent.click(container.querySelector('[data-testid="remove-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('seat-1');
    });
    await waitFor(() => {
      expect(queryClient.getQueryState(['roundtable', 'seats', TOPIC_ID])?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(['topics', 'messages', TOPIC_ID])?.isInvalidated).toBe(true);
    });
  });

  it('移除失败（403）→ 内联权限提示；非 403 → 通用失败提示', async () => {
    mockConfirm.mockResolvedValue(true);
    const { container } = renderBadges({ seats: SEATS, canManage: true });

    // 403：权限过期/被降级（真 AxiosError，组件按 instanceof + status 判定）
    mockDelete.mockRejectedValue(
      new AxiosError('Forbidden', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: {} as never,
        data: { message: 'Access denied' },
      }),
    );
    fireEvent.click(container.querySelector('[data-testid="remove-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise
    expect(await screen.findByTestId('seat-badges-notice')).toHaveTextContent(
      'No permission to remove this seat',
    );

    // 通用失败（等待文案出现——findByText 等 state 更新，避免读到上一条提示的竞态）
    mockDelete.mockRejectedValue(new Error('network down'));
    fireEvent.click(container.querySelector('[data-testid="remove-seat-seat-2"]') as Element);
    await act(async () => {}); // 结算 confirm Promise
    expect(await screen.findByText('Failed to remove seat, please retry')).toBeInTheDocument();
    await act(async () => {}); // 提示计时器收尾（不泄漏未处理定时器）
  });
});

describe('连接向导模态框（2026-08-12 改版：chip 点击打开）', () => {
  it('未认领 chip 显示「待连接」提示；已认领 chip 不显示', () => {
    renderBadges({ seats: [SEATS[0], CLAIMED_SEAT] });
    expect(screen.getByTestId('seat-pending-seat-1')).toHaveTextContent('Not connected');
    expect(screen.queryByTestId(`seat-pending-${CLAIMED_SEAT.id}`)).not.toBeInTheDocument();
  });

  it('未认领 chip 可点击 → Dialog 打开且内含向导；遮罩点击关闭', async () => {
    const { container } = renderBadges({ seats: SEATS });
    // 未点击前不渲染向导（信息密度减重的核心）
    expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument();
    fireEvent.click(container.querySelectorAll('[data-testid="seat-chip"]')[0] as Element);
    // 弹窗内含向导 + 标题 = 被点击座位
    expect(await screen.findByTestId('runner-connect-guide')).toBeInTheDocument();
    expect(screen.getByText('Connect seat "Seat Alpha"')).toBeInTheDocument();
    // 遮罩关闭（Dialog 遮罩 = className 含 bg-black/60 的 fixed 层）
    fireEvent.click(container.querySelector('[class*="bg-black"]') as Element);
    await waitFor(() =>
      expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument(),
    );
  });

  it('已认领 chip 无点击语义（无 role=button，点击不打开向导）', () => {
    const { container } = renderBadges({ seats: [SEATS[0], CLAIMED_SEAT] });
    const claimedChip = container.querySelectorAll('[data-testid="seat-chip"]')[1] as Element;
    expect(claimedChip).not.toHaveAttribute('role', 'button');
    fireEvent.click(claimedChip);
    expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument();
  });

  it('未认领 chip 键盘 Enter 打开向导（role=button 键盘语义）', () => {
    const { container } = renderBadges({ seats: SEATS });
    fireEvent.keyDown(container.querySelectorAll('[data-testid="seat-chip"]')[0] as Element, {
      key: 'Enter',
    });
    expect(screen.getByTestId('runner-connect-guide')).toBeInTheDocument();
  });

  it('移除按钮点击不触发向导打开（stopPropagation 隔离，不连带弹窗）', async () => {
    mockConfirm.mockResolvedValue(false);
    const { container } = renderBadges({ seats: SEATS, canManage: true });
    fireEvent.click(container.querySelector('[data-testid="remove-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise
    expect(mockConfirm).toHaveBeenCalled();
    expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument();
  });

  it('onExitGuide 透传：全绿时点击「去 @ 它试试」→ 触发外层动作并关闭弹窗', async () => {
    mockListRunners.mockResolvedValue([
      {
        id: 'r1',
        name: 'local-dev',
        status: 'online',
        version: '0.3.1',
        vendors: ['kimi'],
        lastSeenAt: new Date().toISOString(),
      },
    ]);
    const onExitGuide = jest.fn();
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
    const { queryClient, container } = renderBadges({ seats: [SEATS[0]], onExitGuide });
    fireEvent.click(container.querySelector('[data-testid="seat-chip"]') as Element);
    await screen.findByTestId('runner-connect-guide');

    // 座位被认领（listSeats 换值 + invalidate 重取）→ 验收环全绿 → R10 按钮
    mockListSeats.mockResolvedValue([
      {
        ...SEATS[0],
        runnerId: 'r1',
        presence: { phase: 'idle', at: new Date().toISOString() },
      },
    ]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['roundtable', 'seats', TOPIC_ID] });
    });
    const button = await screen.findByTestId('seat-guide-go-mention');
    fireEvent.click(button);
    await waitFor(() => expect(onExitGuide).toHaveBeenCalledTimes(1));
    // 弹窗随退出动作关闭（向导卸载，轮询停止）
    await waitFor(() =>
      expect(screen.queryByTestId('runner-connect-guide')).not.toBeInTheDocument(),
    );
  });
});
