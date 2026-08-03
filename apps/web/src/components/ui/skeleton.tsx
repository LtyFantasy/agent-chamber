import { cn } from '@/lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

function Skeleton({ className, ...props }: SkeletonProps) {
  // 暗色适配：bg-muted 走令牌已自动适配深空底；/70 透明度让骨架在深底上更柔和
  return <div className={cn('animate-pulse rounded-md bg-muted/70', className)} {...props} />;
}

export { Skeleton };
