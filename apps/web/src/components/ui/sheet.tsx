'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  side?: 'left' | 'right' | 'bottom';
  className?: string;
  /**
   * 面板可访问名（a11y，v1.90.0-dev 起可选）：传值时面板补 `role="dialog"` +
   * `aria-label`——无 role 的浮层对读屏软件只是一块普通 div，入口按钮的 aria-expanded
   * 语义接不上；不传值则 DOM 与历史完全一致（其余调用方的完整 pattern —— focus trap
   * + inert + aria-labelledby —— 另立 follow-up，本批只做 docs 右栏）。
   *
   * **刻意不加 `aria-modal`**：无 focus trap / inert 时就声明 aria-modal 是假声明
   * （键盘 Tab 仍会跑到浮层背后的内容上），比不加更糟。
   */
  ariaLabel?: string;
}

function Sheet({ open, onOpenChange, children, side = 'right', className, ariaLabel }: SheetProps) {
  const t = useTranslations('common');
  /** Escape 键关闭 */
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  if (!open) return null;

  const sideClass =
    side === 'right'
      ? 'inset-y-0 right-0 h-full w-full sm:max-w-sm border-l'
      : side === 'left' // eslint-disable-line rulesdir/no-magic-string-compare -- UI 几何方向（'left'|'right'|'bottom'），非 ParticipantStatus.LEFT
        ? 'inset-y-0 left-0 h-full w-full sm:max-w-sm border-r'
        : 'inset-x-0 bottom-0 h-auto max-h-[80vh] border-t rounded-t-xl';

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={() => onOpenChange(false)}
      />
      {/* Sheet 面板玻璃化（壳层元素允许 backdrop-blur）；glass 自带整圈边框，sideClass 的方向性 border 类被其取代。
          面板 a11y（仅传 ariaLabel 时生效）：role/aria-label 用展开属性下发，未传值的调用方 DOM 不变 */}
      <div
        className={cn(
          'glass fixed z-50 p-6 shadow-lg animate-in slide-in-from-right duration-300 flex flex-col',
          sideClass,
          className,
        )}
        {...(ariaLabel ? { role: 'dialog', 'aria-label': ariaLabel } : {})}
      >
        <button
          onClick={() => onOpenChange(false)}
          className="absolute right-3 top-3 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors z-10"
          aria-label={t('close')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5', className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  );
}

function SheetDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-4',
        className,
      )}
      {...props}
    />
  );
}

export { Sheet, SheetHeader, SheetTitle, SheetDescription, SheetFooter };
