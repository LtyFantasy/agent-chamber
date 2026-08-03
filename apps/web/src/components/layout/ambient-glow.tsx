import { cn } from '@/lib/utils';

/**
 * AmbientGlow — 页面级深空氛围光斑（纯视觉，无逻辑）。
 *
 * 用途：登录/注册/dashboard 等「展厅级」页面的背景径向渐变光斑。
 * 【红线】仅页面级使用，禁止挂到全局 body 或工作区滚动容器（见 docs/ui-design-system.md）；
 * 动画只用 transform（tailwind animate-drift / animate-drift-slow），不触发 layout。
 *
 * 渲染 3 个光斑：青（左上）、紫（右下）、青（底部居中偏暗），
 * absolute 定位 + pointer-events-none，不影响交互。
 */
export function AmbientGlow({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
    >
      {/* 主光斑：青，左上 */}
      <div
        className="animate-drift absolute -left-32 -top-32 h-[480px] w-[480px] rounded-full"
        style={{
          background: 'radial-gradient(circle, hsl(var(--primary) / 0.16) 0%, transparent 65%)',
        }}
      />
      {/* 辅助光斑：紫，右下，反向慢速漂移制造错层感 */}
      <div
        className="animate-drift-slow absolute -bottom-40 -right-32 h-[560px] w-[560px] rounded-full"
        style={{
          background: 'radial-gradient(circle, hsl(var(--violet) / 0.14) 0%, transparent 65%)',
        }}
      />
      {/* 第三光斑：青，底部居中，更暗，补纵深 */}
      <div
        className="animate-drift absolute -bottom-24 left-1/3 h-[400px] w-[400px] rounded-full"
        style={{
          background: 'radial-gradient(circle, hsl(var(--primary) / 0.08) 0%, transparent 65%)',
        }}
      />
    </div>
  );
}
