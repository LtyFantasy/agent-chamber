import * as React from 'react';
import { cn } from '@/lib/utils';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'subtle';
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
    secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
    destructive:
      'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
    outline: 'text-foreground',
    // 暗色适配：半透明语义色底 + 亮色文字（修复原亮主题 emerald/amber-100/800 硬编码，
    // dark-only 后不再保留 dark: 前缀双份写法）
    success: 'border-transparent bg-emerald-500/15 text-emerald-300',
    warning: 'border-transparent bg-amber-500/15 text-amber-300',
    // subtle：中性低调标签（圆桌座位 badge 等展示性标签）——半透明中性底 + 前景色，
    // 不抢正文视觉（Mission Control 暗色主题协调，同 success/warning 的半透明派生法）
    subtle: 'border-transparent bg-foreground/10 text-foreground/80',
  };

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
