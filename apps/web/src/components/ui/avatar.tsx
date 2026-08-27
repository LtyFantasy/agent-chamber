import * as React from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * =============================================================================
 * 确定性生成头像调色板（8 色，深空色系）
 * =============================================================================
 * 无 src 时 fallback 底色不再统一灰，而是按 seed（通常为 actor id）hash 到本调色板，
 * 保证同一 Actor 全站任何位置渲染出相同底色（确定性），相邻 Actor 有区分度。
 *
 * 选色依据（与 docs/ui-design-system.md §2 色板协调）：
 * - 色相覆盖主光色青（187）与辅助光色紫（258）及其邻近方位（蓝/靛/青绿/粉/琥珀/天蓝），
 *   全色环 8 等分附近的深空变体，彼此可区分；
 * - 亮度压到 30-38%、饱和度 45-65%：在 --background(222 47% 5%) 深空底色上
 *   有存在感但不刺眼，符合「工作区级克制」的分级发光原则；
 * - fallback 首字母恒用 --foreground 同色（210 40% 96%），8 色底上均保 WCAG 可读性。
 */
const AVATAR_PALETTE = [
  'hsl(187 60% 32%)', // 青（主光色相深版）
  'hsl(258 55% 45%)', // 紫（辅助光色相深版）
  'hsl(222 60% 40%)', // 深空蓝
  'hsl(282 45% 42%)', // 品紫
  'hsl(160 50% 30%)', // 青绿
  'hsl(330 45% 42%)', // 粉
  'hsl(25 60% 38%)', // 琥珀
  'hsl(200 65% 35%)', // 天蓝
] as const;

/**
 * djb2 字符串 hash。
 *
 * 选用理由：对短字符串（UUID / 名字）分布均匀、实现无副作用且跨端确定
 * （纯算术，不依赖运行环境），正是「同一 seed 恒定同色」所需的全部性质；
 * 不需要加密强度，故不引第三方库。
 */
function hashSeed(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }
  return Math.abs(hash);
}

/**
 * 解析头像 URL。
 *
 * 后端 avatarUrl 可能是站内相对短链（如 /api/v1/avatars/:actorId.svg）。
 * 本地开发前端（8742）与 API（8743）跨端口，<img> 请求不走 axios baseURL，
 * 必须由 NEXT_PUBLIC_API_URL 推导源站前缀，否则 8742 上 404；
 * 生产前后端同源（nginx 反代）时 NEXT_PUBLIC_API_URL 缺省或为相对路径，原样返回即可。
 */
function resolveAvatarUrl(src: string): string {
  if (!src.startsWith('/api/')) return src;
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base || !/^https?:\/\//.test(base)) return src;
  return new URL(base).origin + src;
}

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string | null;
  alt?: string;
  fallback?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /**
   * Actor 类型。'agent' 时右下角叠 Bot 身份徽章（王者荣耀头像框式角标）；
   * 'human' / 未传不显示——人类是默认态，不增加视觉噪音。
   * 位置固定右下（身份装饰国际惯例位），左上/右上预留给未来在线状态点。
   */
  actorType?: 'human' | 'agent';
  /**
   * 已删除降级标记（统一批 B）：true 时整头像灰化（grayscale + 半透明）并隐藏
   * Bot 身份角标——"身份已失效"的视觉语义，与名字灰化/badge 配套使用。
   * 消费方依据投影 DTO 的 deletedAt 非空传 true。
   */
  deleted?: boolean;
  /**
   * 确定性底色种子（调用方传 actor id）。无 src 时按 `seed ?? fallback`
   * hash 到 AVATAR_PALETTE；不传则退化到按 fallback 文本 hash，仍保证确定性。
   */
  seed?: string;
}

function Avatar({
  className,
  src,
  alt,
  fallback,
  size = 'md',
  actorType,
  deleted = false,
  seed,
  ...props
}: AvatarProps) {
  const sizes = {
    xs: 'h-5 w-5 text-[10px]',
    sm: 'h-8 w-8 text-xs',
    md: 'h-10 w-10 text-sm',
    lg: 'h-12 w-12 text-base',
    xl: 'h-16 w-16 text-lg',
  };

  /**
   * Bot 角标规格（设计决策，与 docs/ui-design-system.md 同步）：
   * - xs（20px 头像）不显示徽章——会糊成一团；
   * - sm/md 徽章 12px（图标 8px），lg/xl 14px（图标 9px）；
   * - violet 底（辅助光色，标识 Agent 身份）+ 页面底色细描边圈（ring-background），
   *   保证叠在任何头像（含彩色生成底/照片/SVG）上边缘都清晰。
   */
  const badgeSizes: Partial<Record<NonNullable<AvatarProps['size']>, string>> = {
    sm: 'h-3 w-3',
    md: 'h-3 w-3',
    lg: 'h-3.5 w-3.5',
    xl: 'h-3.5 w-3.5',
  };
  const badgeIconSizes: Partial<Record<NonNullable<AvatarProps['size']>, string>> = {
    sm: 'h-2 w-2',
    md: 'h-2 w-2',
    lg: 'h-2.5 w-2.5',
    xl: 'h-2.5 w-2.5',
  };
  const showBadge = actorType === 'agent' && size !== 'xs' && !deleted;

  const fallbackText = fallback
    ? fallback
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?';

  // 确定性底色：seed（actor id）优先，fallback 文本兜底
  const paletteColor = AVATAR_PALETTE[hashSeed(seed ?? fallback ?? '?') % AVATAR_PALETTE.length];
  const resolvedSrc = src ? resolveAvatarUrl(src) : null;

  return (
    <div className={cn('relative shrink-0', sizes[size], className)} {...props}>
      <div
        // 已删除灰化（统一批 B）：grayscale + opacity-50——身份失效的低饱和视觉；
        // deleted 同时隐藏 Bot 角标；无 src 时用确定性调色板底色 + 近白首字母，
        // 有 src 时保持 muted 底作图片加载垫层
        className={cn(
          'flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground',
          deleted && 'opacity-50 grayscale',
        )}
        style={
          resolvedSrc ? undefined : { backgroundColor: paletteColor, color: 'hsl(210 40% 96%)' }
        }
      >
        {resolvedSrc ? (
          <img
            src={resolvedSrc}
            alt={alt || fallback}
            className="aspect-square h-full w-full object-cover"
          />
        ) : (
          <span>{fallbackText}</span>
        )}
      </div>
      {showBadge && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-violet-glow text-primary-foreground ring-2 ring-background',
            badgeSizes[size],
          )}
        >
          <Bot className={badgeIconSizes[size]} strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}

export { Avatar };
