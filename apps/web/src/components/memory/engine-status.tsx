'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆引擎的**可用性呈现**：Hub 状态灯（导航级信号）+ 搜索区横幅（解释 + 禁用依据）
 *
 * [代码职责]
 *   - 把 `engineAvailability`（项目/列表响应内嵌，**免额外请求**）与 runtime 503 的
 *     reason 翻译成同一套人类文案与同一个视觉态（plan §1 D9：仅搜索区降级，
 *     卡片墙/详情照常可用）
 *
 * [权威文档]
 *   - 主文档: 线上 docs/frontend/ui-design-system.md §2.2（语义色用半透明写法）/§3（禁不透明 bg）
 *   - 实现蓝本: Memory web 二期 plan v2.1 §1 D9 + §5 第 18/22/25/36 条
 *
 * [关键不变量]
 *   - **文案只有一个分叉源**（`memoryUnavailableReasonKind`）：`engineAvailability.reason`
 *     与 runtime 503 `data.reason` 共用；两处各写一份 = 迟早一处漏改，同一个故障两套说法
 *   - **状态灯的文字恒在**（WCAG 1.4.1）：颜色只是加强，不许出现"纯色点独载语义"
 *   - **常态不发光不呼吸**（plan §5 第 36 条）：引擎正常时是一枚中性点，不是装饰灯；
 *     异常才 amber + 文案（记忆是可选增强，用 destructive 会过度告警）
 *   - 横幅**禁刷不透明 `bg-background`**（会盖住 body 的全局网格纹）——沿用仓内告警条
 *     先例 `border-amber-500/40 bg-amber-500/10 text-amber-300`
 *
 * [关联代码]
 *   - ../../lib/memory.ts — `memoryUnavailableReasonKind` / `memoryEngineAvailable` 的唯一实现
 *   - ../../app/(main)/memory/page.tsx — 横幅与状态灯的挂载点（列表页搜索区）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认新增状态仍走"文字 + 颜色"双通道
 *   □ 新增 reason 分支必须同时改 lib/memory 的分叉函数与 i18n 两侧语言包
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MemoryEngineAvailability, MemoryUnavailableKind } from '@/lib/memory';

/**
 * Hub 状态灯（引擎可用性）。
 *
 * 位置与语义：窄屏与项目切换器合并成一行次级信息（plan §5 第 1 条），桌面端同处一行。
 * 两种态：
 * - 可用 → 中性点（`bg-muted-foreground/50`，**不加 shadow/animate**）+ `hub.ok`；
 * - 不可用 → amber 点 + `hub.degraded`（具体成因与下一步在 `MemoryEngineBanner`）。
 *
 * `availability` 缺失（旧响应 / 项目未加载）按"可用"渲染：**不谎报故障**——
 * 一个凭空的告警比没有告警更伤信任。
 */
function MemoryEngineLight({
  availability,
  className,
}: {
  availability?: MemoryEngineAvailability;
  className?: string;
}) {
  const t = useTranslations('memory');
  const available = !availability || availability.available;
  const label = available ? t('hub.ok') : t('hub.degraded');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] text-muted-foreground',
        className,
      )}
      data-testid="memory-engine-light"
    >
      {/* 装饰性色点：语义由右侧文字承载（颜色只是加强），故点本身 aria-hidden */}
      <span
        aria-hidden="true"
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          available ? 'bg-muted-foreground/50' : 'bg-amber-400',
        )}
      />
      <span data-testid="memory-engine-light-label">{label}</span>
    </span>
  );
}

/**
 * 搜索区引擎横幅（**唯一的降级视觉态**，list/详情不因它降级）。
 *
 * 文案按成因三分叉（plan §5 第 18/25 条）：
 * - `notConfigured`（部署无引擎）→ 说明"记忆是可选增强，账本照常"；
 * - `projectUnbound`（本项目未绑定）→ 指向管理员绑引擎（配置面，不是运维面）；
 * - `engineUnavailable`（unreachable/timeout/error）→ 稍后重试。
 *
 * `runtime` = true 表示本次是**运行期** 503（上一次搜索打到引擎时它挂了）——
 * 同一套原因文案 + 一句"搜索保持禁用直到它恢复"。
 *
 * @param kind - 文案分叉键（由 reason 派生，调用方不要再自己分叉）
 * @param runtime - 是否来自运行期 503（而非项目投影的 engineAvailability）
 */
function MemoryEngineBanner({
  kind,
  runtime = false,
  className,
}: {
  kind: MemoryUnavailableKind;
  runtime?: boolean;
  className?: string;
}) {
  const t = useTranslations('memory');
  /** 显式字面量映射（next-intl key 有编译期校验，禁动态拼） */
  const REASON_TEXT: Record<MemoryUnavailableKind, string> = {
    notConfigured: t('engine.reason.notConfigured'),
    projectUnbound: t('engine.reason.projectUnbound'),
    engineUnavailable: t('engine.reason.engineUnavailable'),
  };
  return (
    <div
      role="status"
      data-testid="memory-engine-banner"
      data-kind={kind}
      className={cn(
        'flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-300',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">
        <p>{REASON_TEXT[kind]}</p>
        {runtime && <p data-testid="memory-engine-banner-runtime">{t('engine.runtimeNote')}</p>}
      </div>
    </div>
  );
}

export { MemoryEngineLight, MemoryEngineBanner };
