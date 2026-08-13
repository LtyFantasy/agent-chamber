/**
 * toast.test.tsx — Toast 基础项 + Toaster 容器契约测试（jsdom）。
 *
 * 覆盖：渲染（title/description/色条）、手动关闭回调、自动消失（fake timers）、
 * duration<=0 不自动消失、variant 色条类名、Toaster 集成
 * （pushToast 渲染 / dismiss 移除 / aria-live）。
 * 队列上限（5 丢最旧）与 confirm 队列语义见 stores/notification.store.test.ts。
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { ToastItem, Toaster } from './toast';
import { useNotificationStore, type ToastItem as ToastItemType } from '@/stores/notification.store';

function makeItem(overrides: Partial<ToastItemType> = {}): ToastItemType {
  return {
    id: 'toast-1',
    title: 'Message sent',
    description: 'Your @all message reached 2 seats',
    variant: 'success',
    duration: 4000,
    ...overrides,
  };
}

describe('ToastItem', () => {
  it('渲染 title / description / 关闭按钮', () => {
    render(<ToastItem item={makeItem()} onDismiss={jest.fn()} />);
    expect(screen.getByText('Message sent')).toBeInTheDocument();
    expect(screen.getByText('Your @all message reached 2 seats')).toBeInTheDocument();
    expect(screen.getByTestId('toast-dismiss')).toBeInTheDocument();
  });

  it('点击关闭按钮 → onDismiss(id)', () => {
    const onDismiss = jest.fn();
    render(<ToastItem item={makeItem()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('toast-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('toast-1');
  });

  it('duration 到期自动消失（fake timers）', () => {
    jest.useFakeTimers();
    try {
      const onDismiss = jest.fn();
      render(<ToastItem item={makeItem({ duration: 1000 })} onDismiss={onDismiss} />);
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(999);
      });
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(onDismiss).toHaveBeenCalledWith('toast-1');
    } finally {
      jest.useRealTimers();
    }
  });

  it('duration<=0 不自动消失（常驻，需手动关闭）', () => {
    jest.useFakeTimers();
    try {
      const onDismiss = jest.fn();
      render(<ToastItem item={makeItem({ duration: 0 })} onDismiss={onDismiss} />);
      act(() => {
        jest.advanceTimersByTime(10000);
      });
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('variant 色条类名（success 绿 / error destructive / info 主色 / warning 琥珀）', () => {
    const cases: Array<[NonNullable<ToastItemType['variant']>, string]> = [
      ['success', 'bg-emerald-500/70'],
      ['error', 'bg-destructive/80'],
      ['info', 'bg-primary/80'],
      ['warning', 'bg-amber-500/70'],
    ];
    for (const [variant, expected] of cases) {
      const { unmount } = render(<ToastItem item={makeItem({ variant })} onDismiss={jest.fn()} />);
      expect(screen.getByTestId('toast-item').querySelector('span')).toHaveClass(expected);
      unmount();
    }
  });

  it('variant 缺省 → info 主色条', () => {
    const item = makeItem({ variant: undefined });
    render(<ToastItem item={item} onDismiss={jest.fn()} />);
    expect(screen.getByTestId('toast-item').querySelector('span')).toHaveClass('bg-primary/80');
  });
});

describe('Toaster（store 驱动）', () => {
  beforeEach(() => {
    // 重置 store（zustand 无内置 reset，直接 setState 清空）
    useNotificationStore.setState({ alerts: [], toasts: [] });
  });

  it('订阅 store.toasts：pushToast 后渲染，dismiss 后移除', () => {
    render(<Toaster />);

    act(() => {
      useNotificationStore.getState().pushToast({ title: 'Saved', variant: 'success' });
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();

    const id = useNotificationStore.getState().toasts[0].id;
    act(() => {
      useNotificationStore.getState().dismissToast(id);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('容器带 aria-live="polite"（读屏可感知不打断）', () => {
    render(<Toaster />);
    expect(screen.getByTestId('toaster')).toHaveAttribute('aria-live', 'polite');
  });
});
