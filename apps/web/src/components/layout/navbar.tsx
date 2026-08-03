'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth.store';
import { Avatar } from '@/components/ui/avatar';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { cn } from '@/lib/utils';
// 主题切换按钮已移除（dark-only 收敛，见 docs/ui-design-system.md），Sun/Moon 图标不再需要
import { LogOut, Settings, Menu } from 'lucide-react';
import Link from 'next/link';

interface NavbarProps {
  onMenuClick?: () => void;
}

export function Navbar({ onMenuClick }: NavbarProps) {
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const t = useTranslations('nav');

  return (
    // 顶栏玻璃化：半透底 + backdrop-blur（壳层元素允许 blur，滚动列表元素禁用）
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border/60 bg-background/70 px-4 backdrop-blur-xl md:px-6">
      <div className="flex items-center gap-2">
        <button
          onClick={onMenuClick}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:hidden"
          aria-label={t('openMenu')}
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>
      <div className="flex items-center gap-4">
        <div className="relative">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 rounded-full hover:bg-accent p-1 pr-3 transition-colors"
          >
            <Avatar src={user?.avatar} fallback={user?.name || 'U'} size="sm" seed={user?.id} />
            <span className="text-sm font-medium hidden sm:block">{user?.name}</span>
          </button>

          {open && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
              <div
                className={cn(
                  'absolute right-0 top-full z-50 mt-2 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
                  'animate-in fade-in-0 zoom-in-95',
                )}
              >
                <div className="px-2 py-1.5 text-sm font-semibold">{user?.name}</div>
                <div className="px-2 py-1.5 text-xs text-muted-foreground">{user?.email}</div>
                <div className="my-1 h-px bg-border" />
                {/* 语言快捷切换：与 settings 页「语言」分区共用 LocaleSwitcher */}
                <div className="px-2 py-1.5">
                  <div className="mb-1 text-xs text-muted-foreground">{t('language')}</div>
                  <LocaleSwitcher />
                </div>
                <div className="my-1 h-px bg-border" />
                <Link
                  href="/settings"
                  onClick={() => setOpen(false)}
                  className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  {t('settings')}
                </Link>
                <button
                  onClick={() => {
                    setOpen(false);
                    logout();
                  }}
                  className="relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  {t('logout')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
