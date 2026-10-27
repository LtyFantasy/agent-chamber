'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Switch — 手写开关（**零 radix**，见 plan §D6 硬约束：前端不引 radix 依赖）。
 *
 * 为什么是 `<button role="switch">` 而不是 `<input type="checkbox">`：
 * - 原生 checkbox 要拿到同款视觉必须 `appearance-none` 并从零画轨道/滑块，等于放弃原生的全部好处；
 * - `button` 天然可聚焦、Enter/Space 触发、可 `disabled`，ARIA 语义用 `role="switch"` +
 *   `aria-checked` 精确表达（读屏播报「开/关」，checkbox 只播报「已选中/未选中」）。
 * - ⚠️ **受控组件**：`checked` 只是渲染输入，点击只发 `onCheckedChange`——
 *   是否变更、何时变更由调用方决定（偏好区的 optimistic + 失败回滚就靠这一点）。
 *
 * 动效（设计文档 §5 红线：只动 transform/opacity，200ms）：
 * - 滑块位移用 `translate-x`（transform）而非 `left`（触发布局）；
 * - 轨道颜色用 `transition-colors`（颜色过渡是允许的交互反馈）；
 * - `motion-reduce:transition-none` → `prefers-reduced-motion: reduce` 下两处过渡全部跳变，
 *   不播放动画（不是"缩短"——是完全不动）。
 *
 * [关联代码]
 * - components/settings/notification-*.tsx — 唯一消费方（渠道静音 / 类别偏好）
 * - docs/frontend/ui-design-system.md §4/§5 — 组件基线与动效规范
 */
export interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'role' | 'aria-checked' | 'children'
> {
  /** 受控状态（true = 开） */
  checked: boolean;
  /** 点击/键盘切换回调（仅发出意图，由调用方决定是否真的改状态） */
  onCheckedChange?: (checked: boolean) => void;
  /** 尺寸：default 用于渠道卡，sm 用于偏好列表行内 */
  size?: 'default' | 'sm';
  /** 无障碍名（**必填**：本组件不渲染 label，名字只能由调用方给） */
  'aria-label': string;
}

/** 轨道尺寸表（default / sm；sm 用于密集列表行，视觉上与行高对齐） */
const TRACK_SIZE_CLASSES = {
  default: 'h-6 w-11',
  sm: 'h-5 w-9',
} as const;

/** 滑块尺寸表（位移量与"轨道-滑块差值"恒等，避免"永远差 2px"的经典毛病） */
const KNOB_CLASSES = {
  default: 'h-5 w-5 translate-x-5',
  sm: 'h-4 w-4 translate-x-4',
} as const;

/** 滑块未选中态（同一尺寸、位移归零——两态只差 transform，过渡不会闪尺寸） */
const KNOB_OFF_CLASSES = {
  default: 'h-5 w-5 translate-x-0',
  sm: 'h-4 w-4 translate-x-0',
} as const;

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, onCheckedChange, disabled, size = 'default', ...props }, ref) => {
    return (
      <button
        {...props}
        ref={ref}
        type="button"
        role="switch"
        // aria-checked 是 role="switch" 的状态通道；aria-disabled 让读屏知道"看得见但改不了"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        data-state={checked ? 'checked' : 'unchecked'}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          'peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
          'transition-colors duration-200 motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'disabled:cursor-not-allowed disabled:opacity-50',
          // 选中 = 主光色青（工作区级：发光只用于选中/状态点缀）
          checked ? 'bg-primary' : 'bg-secondary',
          TRACK_SIZE_CLASSES[size],
          className,
        )}
      >
        {/* 滑块：位移只用 transform；颜色与轨道同相过渡 */}
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none block rounded-full bg-background shadow-sm',
            'transition-transform duration-200 motion-reduce:transition-none',
            checked ? KNOB_CLASSES[size] : KNOB_OFF_CLASSES[size],
          )}
        />
      </button>
    );
  },
);
Switch.displayName = 'Switch';

export { Switch };
