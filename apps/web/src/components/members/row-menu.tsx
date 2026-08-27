'use client';

import { useEffect, useState } from 'react';
import { MoreVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 行级三点菜单（⋯）——项目无 dropdown-menu 基元（主脑裁决 A：不引依赖、不提炼
 * ui/ 通用基元），本组件即「自定义 dropdown」的收敛实现：参照 sidebar 用户菜单
 * （useState + fixed 遮罩 + 手写浮层）模式。
 *
 * 行为契约：
 * - 触发按钮（⋯，触控目标 40×40）→ 浮层 absolute 定位于行尾按钮下方（容器 relative）；
 * - 点击遮罩 / Esc / 点击菜单项 → 关闭（无键盘方向键导航，与项目自研基元水准一致）；
 * - 危险项（移除/转让创建者）红色文字；二次确认由调用方 AlertDialog 负责。
 */

/** 菜单项定义（调用方按 capabilities 装配） */
export interface RowMenuItem {
  /** 菜单项唯一键（React key + 测试定位） */
  key: string;
  label: string;
  /** 危险项（移除/转让创建者）：红色文字 */
  danger?: boolean;
  onSelect?: () => void;
}

interface RowMenuProps {
  items: RowMenuItem[];
  /** 触发按钮无障碍标签（行场景建议带成员名，如「Alice 的成员操作」） */
  ariaLabel: string;
  /** 触发按钮 data-testid（行内多实例时带 actorId 去重） */
  testId?: string;
}

export function RowMenu({ items, ariaLabel, testId }: RowMenuProps) {
  const [open, setOpen] = useState(false);

  /** Esc 关闭（open 期间挂载监听，关闭自动移除） */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  /** 菜单项点击：先关浮层再执行动作——动作可能弹 AlertDialog（与菜单关闭链路解耦） */
  const handleSelect = (item: RowMenuItem) => {
    setOpen(false);
    item.onSelect?.();
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <>
          {/* 遮罩：fixed 全屏点击关闭（层级低于菜单浮层、高于页面其余内容） */}
          <div
            className="fixed inset-0 z-40"
            data-testid="row-menu-overlay"
            onClick={() => setOpen(false)}
          />
          {/* 浮层：absolute 定位于行尾触发按钮下方；实色底（bg-popover）避免透出下层内容 */}
          <div
            role="menu"
            data-testid="row-menu"
            className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-popover p-1 shadow-lg"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={() => handleSelect(item)}
                className={cn(
                  // 菜单项全宽按钮；py-2.5 + text-sm ≈ 40px 触控目标
                  'flex w-full items-center rounded-md px-3 py-2.5 text-left text-sm transition-colors',
                  item.danger
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-foreground hover:bg-accent',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
