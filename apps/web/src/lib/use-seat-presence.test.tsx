/**
 * use-seat-presence.test.tsx — useSeatPresence 轮询契约测试（jsdom）
 *
 * 覆盖（铁律 #17 测试契约，照 use-event-poll.test 真实计时器模式）：
 * ① enabled 时发首轮请求 + 按 intervalMs 轮询（复用页面同源 queryKey）
 * ② enabled=false 零请求（非圆桌 topic 不拉座位）
 * ③ 404 → 停止轮询 + 零重试（被踢出 topic 后不再狂刷）
 * ④ 非 404 错误 → 继续轮询（瞬时网络故障自愈）
 *
 * 实现说明：
 * - react-query 轮询由 refetchInterval 驱动，用真实计时器 + 极小 intervalMs +
 *   waitFor 等待轮询发生（fake timers 与 react-query 内部计时器组合脆弱，不用）；
 * - 轮询次数是瞬态条件，一律用单调/持久断言：mock 调用数 `>= N`。
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { useSeatPresence } from './use-seat-presence';
import { Api } from '@/lib/api';

jest.mock('@/lib/api', () => ({
  Api: {
    roundtable: {
      listSeats: jest.fn(),
    },
  },
}));

const mockedListSeats = Api.roundtable.listSeats as jest.MockedFunction<
  typeof Api.roundtable.listSeats
>;

/** 构造 AxiosError（组件按 instanceof + status 判定；config 占位照 seat-badges.test） */
function makeAxiosError(status: number): AxiosError {
  return new AxiosError('err', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: 'Error',
    headers: {},
    config: {} as never,
    data: {},
  });
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.clearAllMocks();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const TOPIC_ID = 't1';

describe('useSeatPresence', () => {
  it('enabled 时发首轮请求并按 intervalMs 轮询（同源 queryKey）', async () => {
    mockedListSeats.mockResolvedValue([]);

    renderHook(() => useSeatPresence(TOPIC_ID, { enabled: true, intervalMs: 20 }), { wrapper });

    await waitFor(() => expect(mockedListSeats).toHaveBeenCalledWith(TOPIC_ID));
    // 轮询发生：至少 3 次调用（单调条件，避免瞬态次数断言）
    await waitFor(() => expect(mockedListSeats.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('enabled=false → 零请求（非圆桌 topic 不拉座位）', async () => {
    renderHook(() => useSeatPresence(TOPIC_ID, { enabled: false, intervalMs: 20 }), { wrapper });

    // 给足轮询窗口（100ms）后仍无任何调用
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mockedListSeats).not.toHaveBeenCalled();
  });

  it('404 → 停止轮询 + 零重试（被踢出 topic 后不再狂刷）', async () => {
    // 404 零重试（hook retry 分支）：queryFn 抛 AxiosError 404 → 仅一次调用即止
    mockedListSeats.mockRejectedValue(makeAxiosError(404));

    renderHook(() => useSeatPresence(TOPIC_ID, { enabled: true, intervalMs: 20 }), { wrapper });

    await waitFor(() => expect(mockedListSeats).toHaveBeenCalledTimes(1));
    // 稳定期后仍不追加（轮询已停）
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mockedListSeats).toHaveBeenCalledTimes(1);
  });

  it('非 404 错误 → 继续轮询（瞬时网络故障自愈）', async () => {
    mockedListSeats.mockRejectedValue(new Error('network down'));

    renderHook(() => useSeatPresence(TOPIC_ID, { enabled: true, intervalMs: 20 }), { wrapper });

    // 网络错误不停止轮询：调用数持续增长（>=3 证明轮询未停）
    await waitFor(() => expect(mockedListSeats.mock.calls.length).toBeGreaterThanOrEqual(3));
  });
});
