'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { Api } from '@/lib/api';
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
  History,
  X,
  BookOpen,
  ExternalLink,
  Lightbulb,
  LogOut,
  ChevronUp,
} from 'lucide-react';
import { Logo } from '@/components/ui/logo';
import { ScrambleText } from '@/components/ui/scramble-text';
import { Avatar } from '@/components/ui/avatar';
import { LocaleSwitcher } from '@/components/locale-switcher';

/** 导航项的 i18n key（nav.* 命名空间），文案在组件内经 useTranslations 解析 */
const allNavItems = [
  { href: '/', labelKey: 'dashboard', icon: LayoutDashboard },
  { href: '/agents', labelKey: 'agents', icon: Bot },
  { href: '/users', labelKey: 'users', icon: Users, adminOnly: true },
  { href: '/topics', labelKey: 'topics', icon: MessageSquare },
  { href: '/boards', labelKey: 'boards', icon: KanbanSquare },
  { href: '/docs', labelKey: 'docs', icon: FileText },
  // 经验库：平台第四资源（Topic 管人 / Board 管事 / DocSpace 管知识 / Experience 管实战笔记），
  // 插在 docs 之后 search 之前——知识 → 经验 → 检索的动线顺序
  { href: '/experiences', labelKey: 'experiences', icon: Lightbulb },
  { href: '/search', labelKey: 'search', icon: Search },
  { href: '/settings', labelKey: 'settings', icon: Settings },
  { href: '/monitoring', labelKey: 'monitoring', icon: Activity },
  // 活动日志：不加 adminOnly——human 非 admin 可见可查自己+名下 agent（plan 决策）
  { href: '/logs', labelKey: 'logs', icon: History },
  { href: '/skills', labelKey: 'skill', icon: BookOpen, external: true },
] as const;

interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps = {}) {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const isAdmin = user?.role === UserRole.ADMIN;
  const t = useTranslations('nav');
  /** 用户区 dropup 开关（v1.49.0：原 navbar 用户菜单迁入 sidebar 底部） */
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  /**
   * 圆桌审批全局待办角标（M3 阶段 2）：当前用户可见 pending 审批总数。
   * web 无 WebSocket → react-query 30s 轮询（与 topic 内审批卡片同节奏）；
   * verdict 成功/409 后由卡片 invalidate ['roundtable','permission-count'] 联动。
   * 角标纯提示 + 挂话题导航项：点击 = 进话题列表（无「pending topics」聚合端点，
   * 不做 N+1 探测深跳，见 frontend-architecture §3.2.3 设计说明）
   */
  const { data: pendingCountData } = useQuery({
    queryKey: ['roundtable', 'permission-count'],
    queryFn: () => Api.roundtable.pendingPermissionRequestCount(),
    enabled: !!user,
    refetchInterval: 30_000,
  });
  const pendingCount = pendingCountData?.count ?? 0;

  /**
   * 经验库「待终审」角标（第二期：**全体登录用户都拉，按角色决定渲染**）。
   *
   * 数据源 = facets 端点的 `byQuality.unverified`（**全局**未终审积压量）+ 角色级总览门
   * `viewerIsReviewer`（服务端判定：人类 admin 或空间 owner/reviewer 任一）。
   *
   * 两处取舍写在明处：
   * - **query 对全体登录用户发起**（原为 `!!user && isAdmin`）：第二期起"能不能终审"不再
   *   等于 admin（空间成员也能），web 无法从 user.role 推出角色——角色只有服务端知道，
   *   故由服务端透出的 `viewerIsReviewer` 当渲染门；代价是给非终审人多发一次低成本的
   *   facets 查询（与圆桌角标同节奏 30s 轮询）。
   * - **角标语义 = 全局积压**（含"我不可审"的那些条目）：web 无 per-item 判定投影，
   *   逐条算成本不值（plan §13 已登记"列表页不提示哪条我能审"）；文案措辞与 4 周度量
   *   口径一致（见 docs/experience-base.md 的积压量口径）。
   */
  const { data: experienceFacets } = useQuery({
    queryKey: ['experiences', 'facets'],
    queryFn: () => Api.experiences.facets(),
    enabled: !!user,
    refetchInterval: 30_000,
  });
  const pendingReviewCount = experienceFacets?.byQuality?.unverified ?? 0;
  /**
   * 渲染门：服务端角色级门（admin 也置 true）+ 有积压才显示。
   * 缺省 false 是**有意 fail-closed**：字段缺失（旧后端/迁移窗口）不渲染角标。
   */
  const canReviewExperiences = experienceFacets?.viewerIsReviewer === true;

  /**
   * 平台版本角标（logo 正下方）：后端 /health 实时读取
   * （version = monorepo 根 package.json，commit = git short SHA）。
   * 公共端点无需登录；失败静默不渲染——观测性增强不得影响导航可用性。
   */
  const { data: health } = useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => Api.monitoring.getHealth(),
    staleTime: 60_000,
    refetchInterval: 300_000,
    retry: false,
  });

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
          {/* 版本角标：logo 正下方等宽小字（v1.52.0-dev · 0e80e65），
              数据源 = 后端 /health，部署后自动跟随，无硬编码 */}
          {health?.version && (
            <div className="px-6 pt-1.5" data-testid="sidebar-version">
              <span
                className="font-mono text-[10px] tracking-wide text-muted-foreground/60 select-none"
                title={
                  health.commit ? `v${health.version} · ${health.commit}` : `v${health.version}`
                }
              >
                v{health.version}
                {health.commit ? ` · ${health.commit}` : ''}
              </span>
            </div>
          )}
          <nav className="flex-1 space-y-1 p-4">
            {navItems.map((item) => {
              const isExternal = 'external' in item && item.external;
              const isActive =
                !isExternal && (pathname === item.href || pathname?.startsWith(`${item.href}/`));

              /** 公共样式类（relative：圆桌审批角标锚点，仅 topics 项启用） */
              const linkClasses = cn(
                'relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'nav-item-active text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              );

              /** 圆桌审批全局待办角标：数字 > 0 才显示（克制小圆点，挂在话题导航项上） */
              const approvalBadge =
                item.href === '/topics' && pendingCount > 0 ? (
                  <span
                    data-testid="nav-pending-count"
                    title={t('pendingApprovals', { count: pendingCount })}
                    aria-label={t('pendingApprovals', { count: pendingCount })}
                    className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
                  >
                    {pendingCount > 99 ? '99+' : pendingCount}
                  </span>
                ) : null;

              /**
               * 经验库「待终审」角标：unverified 计数 > 0 才显示（仅 admin 有数据）。
               * 有积压时把导航项 href 直达 `?quality=unverified`（列表页支持该 searchParams
               * 初始化过滤态，评审 minor 7）——点角标即落到待终审面，而不是先看全量再手选。
               * 注意：`isActive` 判定仍用 `item.href`（原值 /experiences），不受此影响。
               */
              const hasPendingReview =
                item.href === '/experiences' && canReviewExperiences && pendingReviewCount > 0;
              const experienceReviewBadge = hasPendingReview ? (
                <span
                  data-testid="nav-experiences-pending-count"
                  title={t('pendingExperienceReviews', { count: pendingReviewCount })}
                  aria-label={t('pendingExperienceReviews', { count: pendingReviewCount })}
                  className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
                >
                  {pendingReviewCount > 99 ? '99+' : pendingReviewCount}
                </span>
              ) : null;
              /** 导航项实际 href（仅经验库在有待终审时带过滤参数） */
              const linkHref = hasPendingReview ? '/experiences?quality=unverified' : item.href;

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
                  href={linkHref}
                  onClick={onMobileClose}
                  className={linkClasses}
                >
                  <item.icon className="h-5 w-5" />
                  {t(item.labelKey)}
                  {approvalBadge}
                  {experienceReviewBadge}
                </Link>
              );
            })}
          </nav>
          {/* 用户区（v1.49.0 布局两栏化）：原 navbar 用户菜单迁入 sidebar 底部——
              avatar + name/email 按钮 → dropup 向上弹出（语言切换/设置/登出）；
              桌面端唯一用户入口，移动端抽屉内同位 */}
          <div className="relative border-t border-border/60 p-3">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              data-testid="sidebar-user-button"
              className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
            >
              <Avatar src={user?.avatar} fallback={user?.name || 'U'} size="sm" seed={user?.id} />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-medium">{user?.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{user?.email}</span>
              </span>
              <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            {userMenuOpen && (
              <>
                {/* 外点关闭遮罩（dropup z-50，与全局秩序 dialog z-50 同级不冲突——
                    sidebar 内 stacking context 独立） */}
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div
                  data-testid="sidebar-user-menu"
                  className="absolute bottom-full left-3 right-3 z-50 mb-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95"
                >
                  {/* 语言快捷切换：与 settings 页「语言」分区共用 LocaleSwitcher */}
                  <div className="px-2 py-1.5">
                    <div className="mb-1 text-xs text-muted-foreground">{t('language')}</div>
                    <LocaleSwitcher />
                  </div>
                  <div className="my-1 h-px bg-border" />
                  <Link
                    href="/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Settings className="mr-2 h-4 w-4" />
                    {t('settings')}
                  </Link>
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
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
      </aside>
    </>
  );
}
