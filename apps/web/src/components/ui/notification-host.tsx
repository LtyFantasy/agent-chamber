'use client';

import { AlertDialog } from './alert-dialog';
import { Toaster } from './toast';
import { useNotificationStore } from '@/stores/notification.store';

/**
 * NotificationHost — 全局通知宿主（挂 app/providers.tsx，全站唯一挂载点）。
 *
 * 订阅 store：
 * - 取 alerts 队列首个渲染 AlertDialog（同时只弹一个，resolve 后队列推进）；
 * - 渲染 Toaster 消费 toasts 堆叠列表。
 * 命令式壳（lib/notify.ts）不直接渲染任何 UI——一切经 store 回流到这里。
 */
export function NotificationHost() {
  const alerts = useNotificationStore((s) => s.alerts);
  const resolveAlert = useNotificationStore((s) => s.resolveAlert);
  const current = alerts[0] ?? null;

  return (
    <>
      <AlertDialog
        open={current !== null}
        title={current?.title ?? ''}
        description={current?.description}
        confirmText={current?.confirmText ?? ''}
        cancelText={current?.cancelText ?? ''}
        confirmVariant={current?.confirmVariant}
        // 确认/取消：回执当前 Promise 并出队（store 内先出队再 resolve）
        onConfirm={() => resolveAlert(true)}
        onCancel={() => resolveAlert(false)}
        // 遮罩点击已走 onCancel 路径（AlertDialog dismissable 语义），
        // 关闭完全由 open prop（alerts[0]）驱动——此处 no-op 避免双重出队
        onOpenChange={() => {}}
      />
      <Toaster />
    </>
  );
}
