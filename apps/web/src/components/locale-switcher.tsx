/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/frontend-architecture.md §i18n
 *   - 补充: docs/ui-design-system.md（玻璃/按钮视觉规范）
 *
 * [踩坑索引] 无
 *
 * [铁律关联] #11(注释强制) #7(编译优先)
 *
 * [详细踩坑]
 *   无
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
'use client';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SUPPORTED_LOCALES, setLocaleCookie, type Locale } from '@/i18n';

/**
 * 各语言的自描述名称（语言名不翻译，始终以自身语言呈现，符合业界惯例）。
 * 新增语言时在此补一行。
 */
const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

/**
 * 语言切换器：写 NEXT_LOCALE cookie + router.refresh() 让服务端按新语言重渲。
 * 用于 settings 页「语言」分区与 navbar 用户下拉。
 * 副作用：写 cookie、触发路由刷新。
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();

  const switchTo = (next: Locale) => {
    if (next === locale) return;
    setLocaleCookie(next);
    router.refresh();
  };

  return (
    <div
      className={cn('flex items-center gap-2', className)}
      role="radiogroup"
      aria-label="Language"
    >
      {SUPPORTED_LOCALES.map((l) => (
        <button
          key={l}
          role="radio"
          aria-checked={locale === l}
          onClick={() => switchTo(l)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors',
            locale === l
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {locale === l && <Check className="h-3.5 w-3.5" />}
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
