'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNotificationStore, type ToastItem } from '@/stores/notification.store';

/** 自动消失默认时长（ms） */
const TOAST_DEFAULT_DURATION = 4000;

/**
 * variant → 左侧色条样式（半透明语义色，badge 先例派生；error 用 --destructive 令牌）。
 * 色条是 toast 语义的主视觉锚点，容器玻璃壳保持中性（.glass-flat 无 blur，克制）。
 */
const VARIANT_BAR: Record<NonNullable<ToastItem['variant']>, string> = {
  success: 'bg-emerald-500/70',
  error: 'bg-destructive/80',
  info: 'bg-primary/80',
  warning: 'bg-amber-500/70',
};

/** 关闭按钮图标色（跟随色条语义，弱化处理不抢正文） */
const VARIANT_ICON: Record<NonNullable<ToastItem['variant']>, string> = {
  success: 'text-emerald-400',
  error: 'text-destructive',
  info: 'text-primary',
  warning: 'text-amber-400',
};

/**
 * ToastItem — 单条 toast 展示项（纯 props 驱动，可独立测试）。
 * - 玻璃壳 .glass-flat（无 blur，克制）+ 顶部滑入动效（tailwindcss-animate）；
 * - duration 到期自动消失（计时器卸载清理）；手动关闭按钮；
 * - aria-live 由 Toaster 容器统一提供（polite 不打断读屏）。
 */
function ToastItem({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const variant = item.variant ?? 'info';
  const duration = item.duration ?? TOAST_DEFAULT_DURATION;

  // 自动消失：duration 到期调用 onDismiss；卸载时清理计时器（防泄漏）
  useEffect(() => {
    if (duration <= 0) return;
    const timer = setTimeout(() => onDismiss(item.id), duration);
    return () => clearTimeout(timer);
  }, [item.id, duration, onDismiss]);

  return (
    <div
      data-testid="toast-item"
      className={cn(
        'glass-flat relative flex w-80 items-start gap-2.5 overflow-hidden rounded-lg p-3 pr-8 shadow-lg',
        'animate-in slide-in-from-top-2 fade-in duration-200',
      )}
    >
      {/* 左侧语义色条（绝对定位贴左边） */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', VARIANT_BAR[variant])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        {item.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
        )}
      </div>
      <button
        type="button"
        data-testid="toast-dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
        className={cn(
          'absolute right-2 top-2 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100',
          VARIANT_ICON[variant],
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Toaster — 全局 toast 容器（订阅 store.toasts，右上角堆叠）。
 * - fixed top-16 right-4（header 之下不遮导航）；z-[60] 盖全部弹层
 *   （弹窗操作常伴随 toast，见 plan §3.5 层级约定）；
 * - aria-live="polite"：读屏用户可感知新通知但不打断当前朗读。
 */
export function Toaster() {
  const toasts = useNotificationStore((s) => s.toasts);
  const dismissToast = useNotificationStore((s) => s.dismissToast);

  return (
    <div
      aria-live="polite"
      className="fixed right-4 top-16 z-[60] flex flex-col items-end gap-2"
      data-testid="toaster"
    >
      {toasts.map((item) => (
        <ToastItem key={item.id} item={item} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

export { ToastItem };
