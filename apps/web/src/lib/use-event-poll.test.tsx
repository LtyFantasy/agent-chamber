/**
 * use-event-poll.test.ts — useEventPoll 轮询契约测试（jsdom）
 *
 * 覆盖（铁律 #17 测试契约）：
 * ① 首轮用 cursor='now' 锚定：不回调历史事件，记录 nextCursor 供后续轮询
 * ② 后续轮询推进 cursor：新事件逐条回调，游标随 nextCursor 前进
 * ③ 空结果不回调
 *
 * 实现说明：
 * - react-query 轮询由 refetchInterval 驱动，用真实计时器 + 极小 intervalMs +
 *   waitFor 等待轮询发生（fake timers 与 react-query 内部计时器组合脆弱，不用）；
 * - 轮询次数是瞬态条件（waitFor 首查时可能已远超目标值），一律用单调/持久断言：
 *   mock 调用数 `>= N`、`toHaveBeenCalledWith(游标)`、`mock.calls[0/1]` 固定位。
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEventPoll } from './use-event-poll';
import { Api } from '@/lib/api';
import type { EventItem } from '@/lib/api';

jest.mock('@/lib/api', () => ({
  Api: {
    events: {
      poll: jest.fn(),
    },
  },
}));

const mockedPoll = Api.events.poll as jest.MockedFunction<typeof Api.events.poll>;

/** 构造最小 EventItem fixture（字段对齐 backend Event entity） */
function makeEvent(partial: Partial<EventItem>): EventItem {
  return {
    id: 'evt-1',
    eventType: 'new_message',
    resourceType: 'topic',
    resourceId: 'topic-1',
    actorId: 'agent-1',
    topicId: 'topic-1',
    boardId: null,
    payload: {},
    cursor: '1000',
    delivered: false,
    deliveredAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.clearAllMocks();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useEventPoll', () => {
  it('首轮用 cursor=now 锚定：跳过历史不回调，记录游标供后续轮询', async () => {
    mockedPoll.mockResolvedValueOnce({ events: [], nextCursor: '2000' });
    const onEvent = jest.fn();

    renderHook(() => useEventPoll({ intervalMs: 10_000, onEvent }), { wrapper });

    // 首轮请求用 'now'（默认 limit=100 是 api.ts 侧参数，mock 收到的只有 cursor 一参）
    await waitFor(() => expect(mockedPoll).toHaveBeenCalledWith('now'));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('后续轮询推进 cursor 并逐条回调新事件', async () => {
    // 首轮 'now' 锚定（空结果）→ 之后每轮返回两条新事件 + 新游标 4000
    mockedPoll.mockResolvedValueOnce({ events: [], nextCursor: '2000' }).mockResolvedValue({
      events: [makeEvent({ id: 'e1', cursor: '3000' }), makeEvent({ id: 'e2', cursor: '4000' })],
      nextCursor: '4000',
    });
    const onEvent = jest.fn();

    renderHook(() => useEventPoll({ intervalMs: 20, onEvent }), { wrapper });

    // 第二轮起用首轮返回的游标 '2000'（持久条件：一旦发生恒为真）
    await waitFor(() => expect(mockedPoll).toHaveBeenCalledWith('2000'));
    // 新事件按顺序逐条回调（mock.calls[0]/[1] 固定为前两次回调，不受后续轮询影响）
    expect(onEvent.mock.calls[0][0].id).toBe('e1');
    expect(onEvent.mock.calls[1][0].id).toBe('e2');

    // 游标随 nextCursor 前进：第三轮起用 '4000'
    await waitFor(() => expect(mockedPoll).toHaveBeenCalledWith('4000'));
  });

  it('空结果不回调', async () => {
    // 恒空结果：游标始终停在 '2000'，不产生任何事件回调
    mockedPoll.mockResolvedValue({ events: [], nextCursor: '2000' });
    const onEvent = jest.fn();

    renderHook(() => useEventPoll({ intervalMs: 20, onEvent }), { wrapper });

    // 至少完成两轮轮询（单调条件，避免瞬态次数断言）
    await waitFor(() => expect(mockedPoll.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
