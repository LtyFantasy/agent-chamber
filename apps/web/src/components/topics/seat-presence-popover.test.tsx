/**
 * seat-presence-popover.test.tsx — 座位实时态详情浮层渲染契约测试（M4b-1）
 *
 * 覆盖：open=false 零渲染；近况时间线渲染（summary/result 原文透传 + kind 图标
 * 宽松映射）；空近况显示空态词条；沉默计数（>0 才渲染）；用量（used/size 齐全才渲染）；
 * Esc / 点击外部关闭（照 search-select-popover 手写模式）。文案断言用 en.json 快照。
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { SeatPresencePopover } from './seat-presence-popover';
import type { RoundtableSeatItem } from '@/lib/api';

/** topics.seatPresence 命名空间的英语文案快照（同 en.json） */
const messages: Record<string, string> = {
  'topics.seatPresence.recentActivity': 'Recent activity',
  'topics.seatPresence.noActivity': 'No recent activity',
  'topics.seatPresence.silentCount': 'Silent rounds: {count}',
  'topics.seatPresence.usage': 'Usage {used}/{size} tokens',
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

const onClose = jest.fn();

beforeEach(() => {
  onClose.mockReset();
});

/** 带近况/沉默计数/用量的完整座位 fixture */
const SEAT_FULL: RoundtableSeatItem = {
  id: 'seat-1',
  label: 'Seat Alpha',
  status: 'active',
  vendor: 'kimi',
  runnerId: null,
  state: {
    recentActivity: [
      {
        at: '2026-08-10T08:00:00.000Z',
        kind: 'tool_call',
        summary: 'read_file',
        result: 'completed',
      },
      { at: '2026-08-10T08:01:00.000Z', kind: 'turn', summary: '回复 120 字', result: 'end_turn' },
    ],
    silentCount: 2,
    lastUsage: { used: 1200, size: 8000, at: '2026-08-10T08:01:00.000Z' },
  },
};

function renderPopover(seat: RoundtableSeatItem, open: boolean) {
  return render(<SeatPresencePopover seat={seat} open={open} onClose={onClose} />);
}

describe('SeatPresencePopover 座位实时态浮层', () => {
  it('open=false → 零渲染', () => {
    const { container } = renderPopover(SEAT_FULL, false);
    expect(container.querySelector('[data-testid="seat-presence-popover"]')).toBeNull();
  });

  it('近况时间线渲染：summary 原文透传 + result 次行', () => {
    renderPopover(SEAT_FULL, true);

    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    // 两条活动条目：summary 是服务端摘要文本（原文透传不翻译）
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('回复 120 字')).toBeInTheDocument();
    expect(screen.getByText('end_turn')).toBeInTheDocument();
    expect(screen.getAllByTestId('seat-presence-activity-item')).toHaveLength(2);
  });

  it('无近况 → 显示空态词条', () => {
    renderPopover({ ...SEAT_FULL, state: {} }, true);
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('沉默计数 >0 渲染；lastUsage 齐全渲染用量', () => {
    renderPopover(SEAT_FULL, true);
    expect(screen.getByTestId('seat-presence-silent-count')).toHaveTextContent('Silent rounds: 2');
    expect(screen.getByTestId('seat-presence-usage')).toHaveTextContent('Usage 1200/8000 tokens');
  });

  it('silentCount=0 / lastUsage 缺字段 → 对应块不渲染（零噪音）', () => {
    renderPopover(
      {
        ...SEAT_FULL,
        state: { recentActivity: [], silentCount: 0, lastUsage: { used: 1 } as never },
      },
      true,
    );
    expect(screen.queryByTestId('seat-presence-silent-count')).toBeNull();
    expect(screen.queryByTestId('seat-presence-usage')).toBeNull();
  });

  it('Esc → 关闭回调（keydown 派发在浮层元素自身——事件只向上冒泡）', () => {
    renderPopover(SEAT_FULL, true);
    fireEvent.keyDown(screen.getByTestId('seat-presence-popover'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击外部 → 关闭回调（浮层外 mousedown）', () => {
    renderPopover(SEAT_FULL, true);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
