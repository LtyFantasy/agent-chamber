'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Menu } from 'lucide-react';
import { Sidebar } from './sidebar';
import { Logo } from '@/components/ui/logo';

/**
 * 全局壳层（v1.49.0 布局两栏化）：桌面端 = 左 sidebar + 右内容区，无全局顶栏
 * （原 navbar 的用户菜单/语言切换已迁入 sidebar 底部用户区）；移动端保留 slim
 * 顶栏（h-12，仅菜单键 + logo）——菜单键是移动端打开抽屉的唯一入口，移动端
 * 本就不存在「两栏」，保留细栏维持导航可预期性。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const t = useTranslations('nav');

  return (
    // 注意：此处不得刷不透明 bg-background——body::before 的全局网格纹理在 z-index:-1，
    // 不透明底色会把它整个盖住；底色由 body 负责（globals.css 有说明）
    <div className="min-h-screen">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="ml-0 md:ml-64 min-h-screen">
        {/* 移动端 slim 顶栏：半透底 + backdrop-blur（壳层元素允许 blur），md 以上零渲染 */}
        <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border/60 bg-background/70 px-3 backdrop-blur-xl md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={t('openMenu')}
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/" className="flex items-center gap-2" aria-label="Chamber">
            <Logo className="logo-glow h-5 w-5" />
          </Link>
        </div>
        <main className="p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
