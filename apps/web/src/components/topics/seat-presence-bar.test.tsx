/**
 * seat-presence-bar.test.tsx — 圆桌座位实时态顶部常驻条渲染/交互契约测试（M4b-1）
 *
 * 覆盖：空态零渲染（enabled=false / 无座位）；chip 渲染（label + 主脑 Crown +
 * presence badge 五相位矩阵 + 头像 bindActorId→参与者映射）；取消按钮门控
 * （busy 相位 + canManage 才显示）；cancel 交互（confirm 取消不调 API / 确认调
 * cancelSeat + 成功 toast）；409 → 失效重取 + 内联瞬态提示；403 → 内联区分提示；
 * 其他错误 → 全局 error toast；chip 点击展开 Popover。
 *
 * 隔离策略：mock use-seat-presence 返回固定数据（组件渲染/交互不依赖轮询）；
 * useSeatPresence 自身的轮询契约在 lib/use-seat-presence.test.tsx 单独覆盖。
 * 文案断言用 en.json 快照；全局 confirm/toast（lib/notify）直接 mock。
 */

import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { SeatPresenceBar } from './seat-presence-bar';
import { useSeatPresence } from '@/lib/use-seat-presence';
import { Api } from '@/lib/api';
import { confirm, toast } from '@/lib/notify';
import type { RoundtableSeatItem } from '@/lib/api';
import type { TopicParticipant } from '@/types';
import { ParticipantStatus } from '@/types';

/** topics.seatPresence 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'topics.seatPresence.thinking': 'Thinking',
  'topics.seatPresence.replying': 'Replying',
  'topics.seatPresence.silent': 'Silent',
  'topics.seatPresence.offline': 'Offline',
  'topics.seatPresence.cancel': 'Cancel',
  'topics.seatPresence.cancelTitle': 'Cancel reply',
  'topics.seatPresence.cancelConfirm':
    'Cancel seat {label}? Its current reply will be interrupted.',
  'topics.seatPresence.cancelSent': 'Cancel command sent',
  'topics.seatPresence.cancelConflict': 'This seat has already finished its reply. List refreshed.',
  'topics.seatPresence.cancelForbidden': 'No permission to cancel this seat',
  'topics.seatPresence.cancelFailed': 'Failed to cancel, please retry',
  'topics.seatPresence.recentActivity': 'Recent activity',
  'topics.seatPresence.noActivity': 'No recent activity',
  'topics.seatPresence.silentCount': 'Silent rounds: {count}',
  'topics.seatPresence.usage': 'Usage {used}/{size} tokens',
  'topics.seatManager.coordinator': 'Coordinator',
  'topics.seatManager.coordinatorTitle': 'Coordinator seat',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
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

// 传输抽象接缝隔离：组件渲染/交互不依赖真实轮询（轮询契约在 hook 测试单独覆盖）
jest.mock('@/lib/use-seat-presence', () => ({
  useSeatPresence: jest.fn(),
}));
const mockUseSeatPresence = useSeatPresence as jest.Mock;

jest.mock('@/lib/api', () => ({
  Api: {
    roundtable: {
      cancelSeat: jest.fn(),
    },
  },
}));

// 全局 confirm/toast mock（jsdom 未实现异步 Promise 弹窗）
jest.mock('@/lib/notify', () => ({
  confirm: jest.fn(),
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));
const mockConfirm = confirm as jest.Mock;
const mockToastSuccess = toast.success as jest.Mock;
const mockToastError = toast.error as jest.Mock;

const mockCancel = Api.roundtable.cancelSeat as jest.Mock;

const TOPIC_ID = 't1';

/** 座位 fixture：seat-1 思考中（busy）、seat-2 工具中（busy + coordinator + silent 近况） */
const SEATS: RoundtableSeatItem[] = [
  {
    id: 'seat-1',
    label: 'Seat Alpha',
    status: 'active',
    vendor: 'kimi',
    runnerId: null,
    presence: { phase: 'thinking', at: '2026-08-10T08:00:00.000Z' },
  },
  {
    id: 'seat-2',
    label: 'Seat Beta',
    status: 'active',
    vendor: 'kimi',
    runnerId: null,
    coordinator: true,
    config: { bindActorId: 'actor-1' },
    presence: { phase: 'tool', at: '2026-08-10T08:01:00.000Z', toolTitle: 'read_file' },
    state: {
      recentActivity: [
        { at: '2026-08-10T08:01:00.000Z', kind: 'turn', summary: '沉默', result: 'end_turn' },
      ],
      silentCount: 1,
    },
  },
];

const PARTICIPANTS: TopicParticipant[] = [
  {
    participantId: 'actor-1',
    participantType: 'agent',
    name: 'Kimi Runner',
    avatarUrl: null,
    description: null,
    role: 'member',
    status: ParticipantStatus.ACTIVE,
  },
];

function renderBar(props: { enabled?: boolean; canManage?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SeatPresenceBar
        topicId={TOPIC_ID}
        enabled={props.enabled ?? true}
        participants={PARTICIPANTS}
        canManage={props.canManage ?? true}
      />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

/** 构造 AxiosError（组件按 instanceof + status 判定） */
function makeAxiosError(status: number): AxiosError {
  return new AxiosError('err', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: 'Error',
    headers: {},
    config: {} as never,
    data: { message: 'err' },
  });
}

describe('SeatPresenceBar 顶部座位条', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirm.mockReset();
    mockUseSeatPresence.mockReturnValue({ data: SEATS });
  });

  it('无座位 → 零渲染；enabled=false → 零渲染（空态不打扰）', () => {
    mockUseSeatPresence.mockReturnValue({ data: [] });
    const { container } = renderBar();
    expect(container.querySelector('[data-testid="seat-presence-bar"]')).toBeNull();

    mockUseSeatPresence.mockReturnValue({ data: SEATS });
    const { container: container2 } = renderBar({ enabled: false });
    expect(container2.querySelector('[data-testid="seat-presence-bar"]')).toBeNull();
  });

  it('chip 渲染：label + 主脑 Crown + 头像（bindActorId→参与者 fallback）', () => {
    const { container } = renderBar();

    expect(screen.getByText('Seat Alpha')).toBeInTheDocument();
    expect(screen.getByText('Seat Beta')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid^="seat-presence-chip-"]')).toHaveLength(2);
    // 仅 coordinator 座位渲染主脑徽章（沿用 seat-badges 做法）
    expect(screen.getAllByText('Coordinator')).toHaveLength(1);
    // 头像：bindActorId=actor-1 命中参与者行 → Avatar fallback 显示参与者名首字母
    expect(screen.getByText('KR')).toBeInTheDocument();
  });

  it('presence badge 矩阵：thinking/tool/replying/offline 各相位渲染', () => {
    // tool 相位（seat-2 已带 toolTitle）
    renderBar();
    expect(screen.getByTestId('presence-thinking-seat-1')).toHaveTextContent('◉ Thinking');
    expect(screen.getByTestId('presence-tool-seat-2')).toHaveTextContent('🔧 read_file');

    // replying / offline
    mockUseSeatPresence.mockReturnValue({
      data: [
        {
          id: 'seat-3',
          label: 'Seat Gamma',
          status: 'active',
          vendor: 'kimi',
          presence: { phase: 'replying', at: '2026-08-10T08:00:00.000Z' },
        },
        {
          id: 'seat-4',
          label: 'Seat Delta',
          status: 'active',
          vendor: 'kimi',
          presence: { phase: 'offline', at: '2026-08-10T08:00:00.000Z' },
        },
      ],
    });
    const { container } = renderBar();
    expect(screen.getByTestId('presence-replying-seat-3')).toHaveTextContent('▌ Replying');
    expect(screen.getByTestId('presence-offline-seat-4')).toHaveTextContent('Offline');
    // 本棵树（树 B）2 座位各 1 枚 badge
    expect(container.querySelectorAll('[data-testid^="presence-"]')).toHaveLength(2);
  });

  it('idle 相位：最近一轮 silent → 💤；非 silent → 无 presence badge', () => {
    mockUseSeatPresence.mockReturnValue({
      data: [
        // 最近 turn 摘要='沉默'（服务端摘要语义耦合）→ 💤
        {
          id: 'seat-5',
          label: 'Seat Echo',
          status: 'active',
          vendor: 'kimi',
          presence: { phase: 'idle', at: '2026-08-10T08:00:00.000Z' },
          state: {
            recentActivity: [
              { at: '2026-08-10T08:00:00.000Z', kind: 'turn', summary: '沉默', result: 'end_turn' },
            ],
          },
        },
        // 最近 turn 是回复 → 无 badge
        {
          id: 'seat-6',
          label: 'Seat Foxtrot',
          status: 'active',
          vendor: 'kimi',
          presence: { phase: 'idle', at: '2026-08-10T08:00:00.000Z' },
          state: {
            recentActivity: [
              {
                at: '2026-08-10T08:00:00.000Z',
                kind: 'turn',
                summary: '回复 10 字',
                result: 'end_turn',
              },
            ],
          },
        },
      ],
    });
    const { container } = renderBar();
    expect(screen.getByTestId('presence-silent-seat-5')).toHaveTextContent('💤 Silent');
    expect(container.querySelector('[data-testid="presence-silent-seat-6"]')).toBeNull();
  });

  it('取消按钮门控：busy 相位 + canManage 才显示', () => {
    // canManage=false → 无取消按钮（权限闸）
    const { container: c1 } = renderBar({ canManage: false });
    expect(c1.querySelector('[data-testid^="cancel-seat-"]')).toBeNull();

    // canManage=true + 非 busy 座位 → 无取消按钮
    mockUseSeatPresence.mockReturnValue({
      data: [
        {
          id: 'seat-7',
          label: 'Seat Idle',
          status: 'active',
          vendor: 'kimi',
          presence: { phase: 'idle', at: '2026-08-10T08:00:00.000Z' },
        },
      ],
    });
    const { container: c2 } = renderBar();
    expect(c2.querySelector('[data-testid^="cancel-seat-"]')).toBeNull();

    // busy 座位 × 2（seat-1/seat-2）→ 各一枚取消按钮
    mockUseSeatPresence.mockReturnValue({ data: SEATS });
    const { container: c3 } = renderBar();
    expect(c3.querySelectorAll('[data-testid^="cancel-seat-"]')).toHaveLength(2);
  });

  it('cancel 交互：confirm 取消 → 不调 cancelSeat', async () => {
    mockConfirm.mockResolvedValue(false);
    const { container } = renderBar();

    fireEvent.click(container.querySelector('[data-testid="cancel-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Cancel seat Seat Alpha'),
      }),
    );
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('cancel 交互：confirm 确认 → 调 cancelSeat + 成功 toast', async () => {
    mockConfirm.mockResolvedValue(true);
    mockCancel.mockResolvedValue({ accepted: true, seatId: 'seat-1' });
    const { container } = renderBar();

    fireEvent.click(container.querySelector('[data-testid="cancel-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('seat-1'));
    expect(mockToastSuccess).toHaveBeenCalledWith({ title: 'Cancel command sent' });
  });

  it('cancel 409（座位已完成发言竞态）→ 失效重取 + 内联瞬态提示', async () => {
    mockConfirm.mockResolvedValue(true);
    mockCancel.mockRejectedValue(makeAxiosError(409));
    const { queryClient, container } = renderBar();
    // 预置联动目标缓存：invalidate 后 isInvalidated 置 true（观测 invalidate 发生）
    queryClient.setQueryData(['roundtable', 'seats', TOPIC_ID], SEATS);

    fireEvent.click(container.querySelector('[data-testid="cancel-seat-seat-1"]') as Element);
    await act(async () => {}); // 结算 confirm Promise

    expect(await screen.findByTestId('seat-presence-notice')).toHaveTextContent(
      'This seat has already finished its reply. List refreshed.',
    );
    await waitFor(() => {
      expect(queryClient.getQueryState(['roundtable', 'seats', TOPIC_ID])?.isInvalidated).toBe(
        true,
      );
    });
  });

  it('cancel 403（治理身份被降级）→ 内联区分提示；其他错误 → 全局 error toast', async () => {
    mockConfirm.mockResolvedValue(true);
    const { container } = renderBar();

    // 403：内联区分提示（无 toast）
    mockCancel.mockRejectedValue(makeAxiosError(403));
    fireEvent.click(container.querySelector('[data-testid="cancel-seat-seat-1"]') as Element);
    await act(async () => {});
    expect(await screen.findByText('No permission to cancel this seat')).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();

    // 其他错误（网络等）：全局 error toast
    mockCancel.mockRejectedValue(new Error('network down'));
    fireEvent.click(container.querySelector('[data-testid="cancel-seat-seat-2"]') as Element);
    await act(async () => {});
    expect(mockToastError).toHaveBeenCalledWith({ title: 'Failed to cancel, please retry' });
    await act(async () => {}); // 提示计时器收尾（不泄漏未处理定时器）
  });

  it('chip 点击展开 Popover（再次点击收起）', async () => {
    const { container } = renderBar();

    fireEvent.click(
      container.querySelector('[data-testid="seat-presence-chip-seat-1"]') as Element,
    );
    expect(screen.getByTestId('seat-presence-popover')).toBeInTheDocument();

    // 再次点击同一 chip → 收起
    fireEvent.click(
      container.querySelector('[data-testid="seat-presence-chip-seat-1"]') as Element,
    );
    expect(container.querySelector('[data-testid="seat-presence-popover"]')).toBeNull();
  });
});
