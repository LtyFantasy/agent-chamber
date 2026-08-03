'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { UserRole } from '@/types';
import {
  LayoutDashboard,
  Bot,
  Users,
  MessageSquare,
  KanbanSquare,
  FileText,
  Search,
  Settings,
  Activity,
  X,
  BookOpen,
  ExternalLink,
} from 'lucide-react';
import { Logo } from '@/components/ui/logo';
import { ScrambleText } from '@/components/ui/scramble-text';

/** 导航项的 i18n key（nav.* 命名空间），文案在组件内经 useTranslations 解析 */
const allNavItems = [
  { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/agents', labelKey: 'agents', icon: Bot },
  { href: '/users', labelKey: 'users', icon: Users, adminOnly: true },
  { href: '/topics', labelKey: 'topics', icon: MessageSquare },
  { href: '/boards', labelKey: 'boards', icon: KanbanSquare },
  { href: '/docs', labelKey: 'docs', icon: FileText },
  { href: '/search', labelKey: 'search', icon: Search },
  { href: '/settings', labelKey: 'settings', icon: Settings },
  { href: '/monitoring', labelKey: 'monitoring', icon: Activity },
  { href: '/skills/agent-chamber', labelKey: 'skill', icon: BookOpen, external: true },
] as const;

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps = {}) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === UserRole.ADMIN;
  const t = useTranslations('nav');

  const navItems = allNavItems.filter((item) => {
    if ('adminOnly' in item && item.adminOnly && !isAdmin) return false;
    return true;
  });

  return (
    <>
      {/* 移动端遮罩层 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onMobileClose} />
      )}
      <aside
        className={cn(
          // 侧边栏玻璃化（壳层元素允许 backdrop-blur）；border-border/60 弱化右分隔断线
          'glass fixed left-0 top-0 z-50 h-screen w-64 transition-transform duration-300 ease-in-out',
          'md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 items-center justify-between border-b border-border/60 px-6">
            <Link href="/" className="flex items-center gap-2 font-bold text-xl">
              {/* 裸 Logo + 形状贴合发光（logo-glow），呼应 Mission Control 主题 */}
              <Logo className="logo-glow h-7 w-7" />
              {/* 品牌文字：青光 + 周期乱码解码突发 + 轻微故障色差 */}
              <ScrambleText text="Chamber" className="text-glow-cyan glitch-soft" />
            </Link>
            {/* 移动端关闭按钮 */}
            <button
              onClick={onMobileClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md md:hidden"
              aria-label={t('closeMenu')}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav className="flex-1 space-y-1 p-4">
            {navItems.map((item) => {
              const isExternal = 'external' in item && item.external;
              const isActive =
                !isExternal && (pathname === item.href || pathname?.startsWith(`${item.href}/`));

              /** 公共样式类 */
              const linkClasses = cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'nav-item-active text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              );

              /** 外部链接渲染为 <a target="_blank">，新标签打开 */
              if (isExternal) {
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={onMobileClose}
                    className={linkClasses}
                  >
                    <item.icon className="h-5 w-5" />
                    {t(item.labelKey)}
                    <ExternalLink className="h-3 w-3 ml-auto text-muted-foreground" />
                  </a>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onMobileClose}
                  className={linkClasses}
                >
                  <item.icon className="h-5 w-5" />
                  {t(item.labelKey)}
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>
    </>
  );
}
