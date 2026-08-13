import { useNotificationStore } from '@/stores/notification.store';
import type { AlertOptions, ToastOptions } from '@/stores/notification.store';

/**
 * 命令式通知壳（全局 confirm / toast 的唯一入口）。
 *
 * - 调用点显式 `import { confirm } from '@/lib/notify'`，遮蔽浏览器全局
 *   window.confirm（命名即防护——内部实现用 requestConfirm 避免自引用 shadow）；
 * - 壳层不依赖 next-intl：confirmText/cancelText/title 等文案一律由调用方
 *   传入 i18n 结果，保持本文件纯函数可测；
 * - 类型定义（AlertOptions/ToastOptions）放在 stores/notification.store.ts——
 *   声明式组件（AlertDialog/Toaster）与命令式壳共享同一契约，store 是契约层。
 */

/** 弹确认框：确认 → true；取消 / 遮罩点击 / Esc → false（Promise 化，可 await） */
export function confirm(options: AlertOptions): Promise<boolean> {
  return useNotificationStore.getState().requestConfirm(options);
}

/** toast 函数对象（别名挂载在函数上：toast.success / toast.error / ...） */
interface ToastFn {
  (options: ToastOptions): void;
  success: (options: Omit<ToastOptions, 'variant'>) => void;
  error: (options: Omit<ToastOptions, 'variant'>) => void;
  info: (options: Omit<ToastOptions, 'variant'>) => void;
  warning: (options: Omit<ToastOptions, 'variant'>) => void;
}

const toast = ((options: ToastOptions) => {
  useNotificationStore.getState().pushToast(options);
}) as ToastFn;

/** 便捷别名：语义变体固定，调用方只传内容 */
toast.success = (options) => toast({ ...options, variant: 'success' });
toast.error = (options) => toast({ ...options, variant: 'error' });
toast.info = (options) => toast({ ...options, variant: 'info' });
toast.warning = (options) => toast({ ...options, variant: 'warning' });

export { toast };
