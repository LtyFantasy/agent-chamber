'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './dialog';
import { Button } from './button';
import { useDismissableLayer } from '@/lib/use-dismissable-layer';

/**
 * AlertDialog — 声明式确认框（组合复用 Dialog，不复制遮罩/玻璃代码）。
 *
 * 与命令式壳 confirm() 的关系：本组件是纯展示层，不感知 store；
 * NotificationHost 订阅 store.alerts 取队列首个驱动本组件的 open。
 * 也可独立组合进任意页面（自带 Esc/焦点还原/scroll lock/无障碍）。
 *
 * 关闭语义：
 * - 取消按钮 / Esc → onCancel()（取消路径单路，宿主在 onCancel 中关闭）；
 * - 遮罩点击 → dismissable 时 onCancel() + onOpenChange(false)，否则忽略；
 * - 确认按钮 → onConfirm()。
 */
interface AlertDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmText: string;
  cancelText: string;
  /** 确认钮变体：danger → destructive 红钮（删除/破坏性操作）；缺省 default 渐变主钮 */
  confirmVariant?: 'default' | 'danger';
  /** 是否允许点遮罩取消（默认 true；false 时遮罩点击忽略，用户必须显式选择） */
  dismissable?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 遮罩点击的受控同步（宿主场景可传 no-op——关闭由 onCancel 驱动 open prop） */
  onOpenChange: (open: boolean) => void;
}

export function AlertDialog({
  open,
  title,
  description,
  confirmText,
  cancelText,
  confirmVariant = 'default',
  dismissable = true,
  onConfirm,
  onCancel,
  onOpenChange,
}: AlertDialogProps) {
  const titleId = useId();
  const descId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  /** 最新 onCancel 引用（Esc keydown 监听在 open 期间挂载，用 ref 免重挂） */
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  /** portal 挂载守卫：SSR/hydration 阶段不渲染（document 不可用/与服务端树不一致） */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /*
    Esc 关闭 + 焦点还原（打开时记录触发元素、autoFocus 确认钮；关闭/卸载时幂等还原）。
    迁到 `useDismissableLayer`：本组件原是这份语义的参考实现，记忆正文 Dialog 与关系图
    节点抽屉都要同一套，三处各写一份必然漂移（plan §4.1 的抽取要求）。
    `ready: mounted` 替代原来的 `[open, mounted]` deps——首帧 portal 未挂时 confirmRef
    还是 null，不等它翻转 autoFocus 会永远落空。
  */
  useDismissableLayer({
    open,
    onDismiss: () => onCancelRef.current(),
    initialFocus: confirmRef,
    ready: mounted,
  });

  // scroll lock：弹窗打开时锁页面滚动，关闭还原（对齐原生 confirm 的阻塞语义）
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  /** 遮罩点击（Dialog 内部 onOpenChange(false)）：dismissable 时视为取消 */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(next);
        return;
      }
      if (!dismissable) return;
      onCancel();
      onOpenChange(false);
    },
    [dismissable, onCancel, onOpenChange],
  );

  if (!mounted) return null;
  if (!open) return null;

  return createPortal(
    // role=alertdialog 挂在包裹 Dialog 的容器上：整块（遮罩+卡片）都是对话框语义
    <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogHeader>
          <DialogTitle id={titleId}>{title}</DialogTitle>
          {description && <DialogDescription id={descId}>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onCancel}>
            {cancelText}
          </Button>
          <Button
            ref={confirmRef}
            type="button"
            // 红线：渐变+光晕仅 default 变体；danger → destructive 红钮保持克制
            variant={confirmVariant === 'danger' ? 'destructive' : 'default'}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>,
    document.body,
  );
}
