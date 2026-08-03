'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { useTilt, type TiltOptions } from '@/lib/use-tilt';

/**
 * Card 特效 props（可选配容器 API，设计文档 plans/magik-pantha-static.md §D0）：
 * - `glass`：高斯模糊玻璃壳（等价 .glass class）。红线：仅壳层/展示位元素，
 *   滚动列表重复元素禁用；规范：Card 场景一律用 prop，.glass class 只服务
 *   非 Card 壳层（sidebar/navbar/dialog），禁止 prop 与 class 混用；
 * - `hoverGlow`：hover 边框特效（等价 transition-shadow + hover:border-primary/40
 *   + hover:shadow-glow-sm），列表卡通用；与 focus-glow（focus 态）是两回事；
 * - `tilt`：3D 悬停倾斜（use-tilt）。只动 transform；不扩散到滚动长列表。
 * 三者可自由组合，默认全关、向后兼容。
 */
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 高斯模糊玻璃壳：true=常规玻璃（壳层通用）；'vivid'=展示位加强玻璃（更透，仅登录卡等单卡展示位）。滚动列表重复元素禁用 */
  glass?: boolean | 'vivid';
  /** hover 青光描边 + 微光投影 */
  hoverGlow?: boolean;
  /** 3D 悬停倾斜：true 用默认参数（max 6° / scale 1.01），或传 TiltOptions 自定义 */
  tilt?: boolean | TiltOptions;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, glass, hoverGlow, tilt, ...props }, ref) => {
    const tiltOptions = typeof tilt === 'object' ? tilt : undefined;
    const tiltRef = useTilt<HTMLDivElement>(tiltOptions, !tilt);

    // forwardRef 与内部 tilt ref 合并：useCallback 化，防每次渲染重挂 listener
    const mergedRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        (tiltRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref, tiltRef],
    );

    return (
      <div
        ref={mergedRef}
        // 深空玻璃卡：半透底（无 blur，卡片可能出现在滚动区）+ 细腻弱边框 + 大圆角
        className={cn(
          'rounded-xl border border-border/60 bg-card/60 text-card-foreground shadow-sm',
          glass === 'vivid' ? 'glass-vivid' : glass && 'glass',
          hoverGlow && 'transition-shadow hover:border-primary/40 hover:shadow-glow-sm',
          // transition 由 useTilt 分相控制（move 关/enter-leave 开），className 不挂 transition-transform
          tilt && '[transform-style:preserve-3d] will-change-transform',
          className,
        )}
        {...props}
      />
    );
  },
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('text-2xl font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
export type { CardProps };
