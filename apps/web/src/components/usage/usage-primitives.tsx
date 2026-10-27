'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `/usage` 两 Tab 共用的**展示原语**：可空数值、状态/错误面板、coverage chip、
 *     未知机器码调试区
 *
 * [代码职责]
 *   - 把 `lib/usage.ts` 的三态/错误分桶翻译成可访问的 JSX（role=status/alert、
 *     aria-expanded、可聚焦滚动区）
 *   - 不持有任何请求/路由状态（纯展示，页面与 Tab 组件负责数据）
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3
 *   - 线上 `docs/frontend/ui-design-system.md`（暗色 Mission Control 主题）
 *   - 线上 `docs/frontend/i18n.md`（`usage.*` 命名空间；en / zh-CN key 全等）
 *
 * [关键不变量]
 *   - **unknown ≠ 0**：`usageNumber` 判 `unknown` 时只渲染 `—` 与 aria-label，绝不写 0。
 *   - **错误动作码优先**：重试按钮是否出现只看 `usageErrorInfo().retryable`。
 *   - **调试信息默认折叠**：未知 code / requestId 只放 `<details>`，不占主视线。
 *   - **coverage 的 excluded_untimed_rows 不得被读成 0**：>0 时常驻提示"被排除"。
 *
 * [关联代码]
 *   - ../../lib/usage.ts — 三态/错误分桶的唯一实现
 *   - ./platform-usage-tab.tsx / ./hument-usage-tab.tsx — 消费方
 *
 * [修改检查]
 *   □ 新增文案必须同步 en.json / zh-CN.json（key 全等）
 *   □ 新增交互必须键盘可达（button 而非 div+onClick）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-CODE-HOOK
 * =============================================================================
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  usageErrorInfo,
  type HumentUsageCoverage,
  type UsageErrorInfo,
  type UsageNumberView,
} from '@/lib/usage';

/** Retry-After 倒计时（0 = 可重试；倒计时期间按钮必须禁用） */
function useRetryCountdown(error: unknown, seconds: number | null): number {
  const [remaining, setRemaining] = useState(seconds ?? 0);
  useEffect(() => {
    setRemaining(seconds ?? 0);
    if (!seconds || seconds <= 0) return;
    const timer = setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
    // 依赖 error 对象：新错误即使 Retry-After 秒数相同，也必须重新起算（避免同值卡 0）
  }, [error, seconds]);
  return remaining;
}

/** 可空数值的展示：未知时 `—` + 明确 aria 文案；已知时原值。 */
export function UsageValue({
  value,
  testId,
  className,
}: {
  value: UsageNumberView;
  testId?: string;
  className?: string;
}) {
  const t = useTranslations('usage.state');
  if (value.unknown) {
    return (
      <span
        data-testid={testId}
        data-unknown="true"
        aria-label={t('unknownHint')}
        title={t('unknownHint')}
        className={cn('text-muted-foreground', className)}
      >
        —
      </span>
    );
  }
  return (
    <span data-testid={testId} className={cn('tabular-nums', className)}>
      {value.text}
    </span>
  );
}

/** 状态行（加载/刷新/提示；`role=status` 让读屏在异步变化时播报）。 */
export function UsageStatus({
  children,
  tone = 'muted',
  testId,
  live = false,
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'warning';
  testId?: string;
  /** true = live region（只给 stale/loading/error 用；静态说明不要开） */
  live?: boolean;
}) {
  return (
    <p
      role={live ? 'status' : undefined}
      data-testid={testId}
      className={cn('text-xs', tone === 'warning' ? 'text-amber-300' : 'text-muted-foreground')}
    >
      {children}
    </p>
  );
}

/** 分节标题 + 内容（统一卡片外壳，避免每块自造玻璃样式）。 */
export function UsageSection({
  title,
  description,
  action,
  children,
  testId,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="glass-flat space-y-3 rounded-lg border border-border/60 p-3 md:p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 调试区：未知机器码/请求 id 默认折叠。 */
export function UsageDebug({
  info,
  testId = 'usage-debug',
}: {
  info: UsageErrorInfo;
  testId?: string;
}) {
  const t = useTranslations('usage.state');
  const rows: Array<[string, string | null]> = [
    [t('debugStatus'), info.status === null ? null : String(info.status)],
    [t('debugCode'), info.code === null ? null : String(info.code)],
    [t('debugReason'), info.reason],
    [t('debugEngineCode'), info.engineCode],
    [t('debugHintCode'), info.hintCode],
    [t('debugRequestId'), info.requestId],
  ];
  const visible = rows.filter(([, value]) => value !== null);
  if (visible.length === 0) return null;
  return (
    <details data-testid={testId} className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{t('debug')}</summary>
      <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 font-mono">
        {visible.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground/70">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * 带 Retry-After 倒计时的重试按钮（stale 横幅等自定义位置复用）。
 *
 * 与 `UsageErrorPanel` 同源：倒计时期间 disabled；依赖 error 对象避免同秒数卡 0。
 */
export function UsageRetryButton({
  error,
  onClick,
  label,
  testId,
}: {
  error: unknown;
  onClick: () => void;
  label?: string;
  testId?: string;
}) {
  const t = useTranslations('usage.state');
  const info = usageErrorInfo(error);
  const wait = useRetryCountdown(error, info.retryAfterSeconds);
  return (
    <Button variant="outline" size="sm" data-testid={testId} disabled={wait > 0} onClick={onClick}>
      {wait > 0 ? t('retryWait', { seconds: wait }) : (label ?? t('retry'))}
    </Button>
  );
}

/**
 * 错误面板（唯一入口）。
 *
 * `retryable` 为 false 时**不渲染重试按钮**（权限/版本/身份/共享的下一步不是重试）。
 */
export function UsageErrorPanel({
  error,
  title,
  description,
  onRetry,
  retryLabel,
  testId,
}: {
  error: unknown;
  title: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  testId?: string;
}) {
  const t = useTranslations('usage.state');
  const info = usageErrorInfo(error);
  const retryWait = useRetryCountdown(error, info.retryAfterSeconds);
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-destructive">{title}</p>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
          {info.retryAfterSeconds !== null && (
            <p className="text-xs text-muted-foreground">
              {t('retryAfter', { seconds: info.retryAfterSeconds })}
            </p>
          )}
        </div>
      </div>
      {info.retryable && onRetry && (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="usage-error-retry"
            disabled={retryWait > 0}
            onClick={onRetry}
          >
            {retryWait > 0 ? t('retryWait', { seconds: retryWait }) : (retryLabel ?? t('retry'))}
          </Button>
        </div>
      )}
      <UsageDebug info={info} testId={`${testId ?? 'usage-error'}-debug`} />
    </div>
  );
}

/** 简单信息横幅（引擎不可用/共享/权限等"不是重试能解决"的状态）。 */
export function UsageNotice({
  tone = 'info',
  title,
  description,
  children,
  testId,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title: string;
  description?: string;
  children?: React.ReactNode;
  testId?: string;
}) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div
      role={tone === 'danger' ? 'alert' : tone === 'warning' ? 'status' : undefined}
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-xs',
        tone === 'danger'
          ? 'border-destructive/40 bg-destructive/10'
          : tone === 'warning'
            ? 'border-amber-500/40 bg-amber-500/10'
            : 'border-border/60 bg-foreground/5',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          tone === 'danger'
            ? 'text-destructive'
            : tone === 'warning'
              ? 'text-amber-300'
              : 'text-muted-foreground',
        )}
      />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-muted-foreground">{description}</p>}
        {children}
      </div>
    </div>
  );
}

const COVERAGE_STATUS_LABEL = {
  complete: 'coverage.statusValue.complete',
  partial: 'coverage.statusValue.partial',
  unknown: 'coverage.statusValue.unknown',
} as const;

const COVERAGE_SCOPE_LABEL = {
  actor_private: 'coverage.scopeValue.actor_private',
} as const;

/** coverage chip：状态 + sources/reasons 折叠（excluded_untimed_rows 常驻）。 */
export function UsageCoverageChip({ coverage }: { coverage: HumentUsageCoverage }) {
  const t = useTranslations('usage.hument');
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="hument-coverage" className="rounded-lg border border-border/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t('coverage.label')}</span>
        <span
          data-testid="hument-coverage-status"
          className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {t('coverage.status', {
            status:
              COVERAGE_STATUS_LABEL[coverage.status as keyof typeof COVERAGE_STATUS_LABEL] !==
              undefined
                ? t(COVERAGE_STATUS_LABEL[coverage.status as keyof typeof COVERAGE_STATUS_LABEL])
                : coverage.status,
          })}
        </span>
        <span
          data-testid="hument-coverage-scope"
          className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {t('coverage.scope', {
            scope:
              COVERAGE_SCOPE_LABEL[coverage.scope as keyof typeof COVERAGE_SCOPE_LABEL] !==
              undefined
                ? t(COVERAGE_SCOPE_LABEL[coverage.scope as keyof typeof COVERAGE_SCOPE_LABEL])
                : coverage.scope,
          })}
        </span>
        {coverage.excluded_untimed_rows > 0 && (
          <span
            data-testid="hument-coverage-excluded"
            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300"
            title={t('coverage.excludedHint')}
          >
            {t('coverage.excluded', { count: coverage.excluded_untimed_rows })}
          </span>
        )}
        <button
          type="button"
          data-testid="hument-coverage-toggle"
          aria-expanded={open}
          aria-controls="hument-coverage-sources"
          onClick={() => setOpen((value) => !value)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {t('coverage.sources')}
        </button>
      </div>
      {open && (
        <div
          id="hument-coverage-sources"
          data-testid="hument-coverage-sources"
          className="mt-2 space-y-1"
        >
          {coverage.sources.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t('coverage.noSources')}</p>
          ) : (
            coverage.sources.map((source) => (
              <div
                key={`${source.source}:${source.status}`}
                className="flex flex-wrap items-baseline gap-2 text-[11px]"
              >
                <span className="font-mono text-foreground/90">{source.source}</span>
                <span className="text-muted-foreground">{source.status}</span>
                {source.reasons.length > 0 && (
                  <span className="text-amber-300/90">{source.reasons.join(' · ')}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
