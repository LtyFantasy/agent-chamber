'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆搜索条：**语义/字面双模式**输入区（模式切换 + 查询框 + 提交 + 常驻模式说明）
 *
 * [代码职责]
 *   - 承载"两种搜索是两种不同的东西"这一唯一的产品事实：语义模式问引擎（消耗配额、
 *     有副作用），字面模式只在已加载的条目里做文本匹配（即时、零配额）
 *   - 提交动作**只回调**，不自己发请求——召回是 `enabled:false` 的 query + 手动 refetch
 *     （D7），触发时机与缓存语义由页面持有
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §3（禁常驻 `.glow-border`：它接管 background
 *     且与 Input 自带 focus 环打架）/§4（input focus 青光基线）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §5 第 1/10/11/12/13/18/39 条
 *
 * [关键不变量]
 *   - **模式切换器是 radiogroup，不是 Tabs**（第 10 条）：它选的是"怎么解释这次查询"
 *     （一个互斥的模态选择），不是"看哪一页内容"。且**切换不重置查询词**——用户改了模式
 *     却发现输入框被清空，是纯粹的惩罚
 *   - **模式说明常驻可见且随模式变化**（第 11 条）：两种模式的代价差一个数量级
 *     （引擎配额 vs 本地字符串匹配），把代价写在一行里是产品诚实性要求
 *   - **禁用态必须有常驻可见的说明行**（第 39 条）：仓内没有 Tooltip 原语，原生 `title`
 *     在触屏/键盘/读屏下都不成立——禁用而没有解释 = 死胡同
 *   - **禁常驻 `.glow-border`**（第 1 条）：它接管 `background`，与 Input 自带 focus 环冲突
 *
 * [关联代码]
 *   - ../../app/(main)/memory/page.tsx — 唯一的挂载点（持有 mode/value/submitted 状态）
 *   - ../../lib/memory.ts — 查询长度上限 / 召回条数预算常量
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认动效与 focus 样式仍走 Input 自带基线（不自绘发光）
 *   □ 新增模式必须同时给出"模式说明文案"（两侧语言包）与结果区语义
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useTranslations } from 'next-intl';
import { Check, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  MEMORY_RECALL_QUERY_MAX_LENGTH,
  MEMORY_SEARCH_MODE,
  type MemorySearchMode,
} from '@/lib/memory';

interface MemorySearchBarProps {
  /** 当前模式（受控：由页面持有，因为语义结果展示要据此隐藏 Tab 栏） */
  mode: MemorySearchMode;
  /** 模式切换（**不得**顺带重置查询词，见文件头不变量） */
  onModeChange: (mode: MemorySearchMode) => void;
  /** 输入框内容（受控；URL 恢复的 q 只回填到这里，永不自动执行） */
  value: string;
  onValueChange: (value: string) => void;
  /** 提交（语义 = 触发一次真实召回；字面 = 就地过滤） */
  onSubmit: () => void;
  /** 召回在途：按钮 loading + 禁用（第 13 条） */
  searching: boolean;
  /** 引擎不可用 / 无内容读权限 → 整个搜索区禁用 */
  disabled: boolean;
  /** 禁用原因（**常驻可见**，第 39 条；禁用而无解释是死胡同） */
  disabledNote?: string;
  /** 字面模式的候选规模（"已加载的 N 条"里的 N） */
  literalCount: number;
  /** 语义模式的条数预算（界面承诺与请求参数同源） */
  maxItems: number;
}

/**
 * 记忆搜索条（双模式）。
 *
 * 布局与先例一致：`h-12 pl-10 text-base` 的输入框照抄 `app/(main)/search/page.tsx`
 * （全站最高的输入框档，首屏主交互位），图标绝对定位在左侧。
 */
function MemorySearchBar({
  mode,
  onModeChange,
  value,
  onValueChange,
  onSubmit,
  searching,
  disabled,
  disabledNote,
  literalCount,
  maxItems,
}: MemorySearchBarProps) {
  const t = useTranslations('memory');
  const semantic = mode === MEMORY_SEARCH_MODE.SEMANTIC;

  /** 提交：空查询不发请求（空查询打引擎 = 白烧一次配额） */
  const submit = () => {
    if (disabled || searching || value.trim().length === 0) return;
    onSubmit();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="memory-search-input"
            aria-label={t('search.placeholder')}
            value={value}
            maxLength={MEMORY_RECALL_QUERY_MAX_LENGTH}
            placeholder={t('search.placeholder')}
            disabled={disabled}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className="h-12 pl-10 text-base"
          />
        </div>

        {/*
          模式切换（radiogroup，非 Tabs）：`aria-checked` 给读屏，"当前模式"由 Check 图标
          + 主光色描边双通道表达（不靠颜色独载语义）。
        */}
        <div
          role="radiogroup"
          aria-label={t('search.modeAria')}
          data-testid="memory-search-mode"
          className="flex items-center gap-1.5"
        >
          {[MEMORY_SEARCH_MODE.SEMANTIC, MEMORY_SEARCH_MODE.LITERAL].map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`memory-search-mode-${m}`}
                disabled={disabled}
                onClick={() => onModeChange(m)}
                className={cn(
                  'inline-flex h-12 items-center rounded-md border px-3 text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {/* 选中态 = Check 图标 + 主光色描边双通道（同 locale-switcher 先例） */}
                {active && <Check className="mr-1.5 h-3.5 w-3.5 shrink-0" />}
                {m === MEMORY_SEARCH_MODE.SEMANTIC
                  ? t('search.mode.semantic')
                  : t('search.mode.literal')}
              </button>
            );
          })}
        </div>

        {/*
          提交按钮**只在语义模式渲染**（m4）：字面模式是"输入即过滤"，这个按钮在那里
          是个点了没反应的空操作（空操作按钮比没有按钮更糟——用户会以为过滤失效了）。
          模式说明行（"即时、不消耗配额"）已经交代了字面模式怎么用。
        */}
        {semantic && (
          <Button
            data-testid="memory-search-submit"
            className="h-12 shrink-0"
            disabled={disabled || searching || value.trim().length === 0}
            onClick={submit}
          >
            {searching && (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {searching ? t('search.searching') : t('search.submit')}
          </Button>
        )}
      </div>

      {/*
        模式说明（常驻）：语义 → 条数预算 + 配额代价；字面 → 候选规模 + 零配额。
        两句都写死在语言包里、随 mode 显式取（禁动态拼 key）。
      */}
      <p className="text-xs text-muted-foreground" data-testid="memory-search-mode-note">
        {semantic
          ? t('search.semanticNote', { max: maxItems })
          : t('search.literalNote', { count: literalCount })}
      </p>

      {/* 禁用说明：常驻可见（不是 title/悬浮层），键盘与读屏都能读到 */}
      {disabled && disabledNote && (
        <p className="text-xs text-amber-300" data-testid="memory-search-disabled-note">
          {disabledNote}
        </p>
      )}
    </div>
  );
}

export { MemorySearchBar };
