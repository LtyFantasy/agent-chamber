'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `/usage`：两个**一级 Tab** —— 平台 API/MCP 调用统计（admin） / Hument 模型调用用量
 *
 * [代码职责]
 *   - Tab 级授权：平台 Tab 非 admin 渲染权限面板且**不发请求**；Hument Tab 按项目
 *     `canReadUsage` + 引擎状态分权
 *   - 默认 Tab 按角色/URL：URL `tab` 合法则用它；否则 admin → platform、非 admin → hument
 *   - Tab 切换走 `router.push`（位置语义，后退有意义）；过滤在各自 Tab 内 `replace`
 *   - 两个 Tab 的 URL 参数命名空间隔离：平台 `p_*`、Hument `project` + `h_*`
 *
 * [权威文档]
 *   - 发行裁剪: 线上 docs/integrations/oss-dual-repo.md §11（关闭时仅保留平台统计）
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3
 *   - 线上 `docs/frontend/frontend-architecture.md` §2.3（权限守卫）/ §4.1（URL 状态分层）
 *   - 线上 `docs/frontend/i18n.md`（`usage.*`，en / zh-CN key 全等）
 *
 * [关键不变量]
 *   - **非 admin 看不到平台 Tab 的数据**：`PlatformUsageTab` 的 query `enabled: isAdmin`，
 *     页面层也不为平台 Tab 预取任何数据。
 *   - **默认 Tab 不是"记住上一次"**：只由 URL 与角色决定（可分享/可刷新）。
 *   - **切 Tab 不丢另一个 Tab 的参数**：push 时复制现有 searchParams。
 *
 * [关联代码]
 *   - ../../components/usage/platform-usage-tab.tsx
 *   - ../../components/usage/hument-usage-tab.tsx
 *   - ../../lib/usage.ts
 *
 * [修改检查]
 *   □ 新增 Tab 必须同步 `USAGE_TABS` + i18n 两侧文案 + URL 默认规则
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-CODE-HOOK
 * =============================================================================
 */
import { useEffect, useState } from 'react';
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth.store';
import { UserRole } from '@/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { parseEnumParam } from '@/lib/utils';
import { USAGE_TABS, type UsageTab } from '@/lib/usage';
import { PlatformUsageTab } from '@/components/usage/platform-usage-tab';
import { HumentUsageTab } from '@/components/usage/hument-usage-tab';

export default function UsagePage() {
  const t = useTranslations('usage');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const isAdmin = user?.role === UserRole.ADMIN;

  // 公开发行只有平台统计；旧分享链接 tab=hument 也不能挂载引擎用量组件。
  const parsedTab = parseEnumParam(searchParams.get('tab'), USAGE_TABS);
  const urlTab = !MEMORY_FEATURE_ENABLED && parsedTab === 'hument' ? 'platform' : parsedTab;
  const defaultTab: UsageTab = MEMORY_FEATURE_ENABLED && !isAdmin ? 'hument' : 'platform';
  const [tab, setTab] = useState<UsageTab>(urlTab ?? defaultTab);

  // URL → state 单向同步（后退/前进/外链）
  useEffect(() => {
    // URL 无 tab（如后退到裸 `/usage`）时回到角色默认——否则后退无法离开 Hument
    const next = urlTab ?? defaultTab;
    if (next !== tab) setTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 URL 侧变化时投影
  }, [urlTab, defaultTab]);

  const selectTab = (next: UsageTab) => {
    if (next === tab) return;
    setTab(next);
    // Tab = 位置语义 ⇒ push；复制现有参数以保留另一个 Tab 的命名空间
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set('tab', next);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-xs text-muted-foreground">
          {t(MEMORY_FEATURE_ENABLED ? 'description' : 'platformDescription')}
        </p>
      </header>

      {MEMORY_FEATURE_ENABLED ? (
        <Tabs value={tab} onValueChange={(value) => selectTab(value as UsageTab)}>
          <TabsList
            data-testid="usage-tabs"
            aria-label={t('tabs.aria')}
            className="grid w-full grid-cols-2 xl:inline-flex xl:w-auto"
          >
            <TabsTrigger value="platform" data-testid="usage-tab-platform" className="flex-1">
              {t('tabs.platform')}
            </TabsTrigger>
            <TabsTrigger value="hument" data-testid="usage-tab-hument" className="flex-1">
              {t('tabs.hument')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="platform" className="mt-3">
            <PlatformUsageTab isAdmin={isAdmin} />
          </TabsContent>
          <TabsContent value="hument" className="mt-3">
            <HumentUsageTab />
          </TabsContent>
        </Tabs>
      ) : (
        <PlatformUsageTab isAdmin={isAdmin} />
      )}
    </div>
  );
}
