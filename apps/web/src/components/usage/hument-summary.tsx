'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Hument Usage 首屏的**汇总卡 + Groups Top 10**（不是 29 个总量的平铺）
 *
 * [代码职责]
 *   - 4 张汇总卡：logical calls / total tokens / physical calls / cost（actual 与
 *     estimated **分列**，币种未声明）
 *   - 覆盖债提示：`excluded_untimed_rows` / 未知行数常驻可见
 *   - Groups 桌面表格 7 列、移动卡片；Top 10 默认，可展开全量；行内详情 button+aria-expanded
 *
 * [权威文档]
 *   - 后端 `memory-contract.ts` / `memory-engine.interface.ts` 的 `HumentUsage*`
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.3
 *
 * [关键不变量]
 *   - **null = 未知，不是 0**：一律走 `UsageValue`，禁止 `?? 0`。
 *   - **totals 覆盖完整匹配集**：不从 groups/rows 重算；Top 10 只是展示裁剪。
 *   - **币种未声明**：micros 原值 + "currency not declared"，不换算 USD、不推币种。
 *
 * [关联代码]
 *   - ../../lib/usage.ts — totals/三态/格式化
 *   - ./usage-primitives.tsx — UsageValue/UsageSection
 *   - ./hument-usage-tab.tsx — 唯一消费方
 *
 * [修改检查]
 *   □ 新增总量字段必须来自 engine.totals，禁止从 groups 求和
 *   □ 新增表格列必须保持 5–7 主列；其余进详情行
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-CODE-HOOK
 * =============================================================================
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  usageMicros,
  usageNumber,
  type HumentUsageGroup,
  type HumentUsageSummary,
  type HumentUsageTotals,
} from '@/lib/usage';
import { UsageSection, UsageValue } from './usage-primitives';

/**
 * model_basis 显示映射：requested / resolved / unknown 走本页 i18n；域外值原样显示。
 *
 * @param basis 引擎返回的开放字符串
 * @param t usage.hument.groups 的翻译函数
 */
function basisLabel(
  basis: string,
  t: (key: 'basisValue.requested' | 'basisValue.resolved' | 'basisValue.unknown') => string,
): string {
  if (basis === 'requested') return t('basisValue.requested');
  if (basis === 'resolved') return t('basisValue.resolved');
  if (basis === 'unknown') return t('basisValue.unknown');
  return basis;
}

/** 4 张汇总卡（actual/estimated 在成本卡内分列） */
export function HumentSummaryCards({ summary }: { summary: HumentUsageSummary }) {
  const t = useTranslations('usage.hument.cards');
  const { counts, tokens, cost, duration } = summary.totals;
  return (
    <div
      data-testid="hument-summary-cards"
      className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4"
    >
      <SummaryCard
        testId="hument-card-logical-calls"
        label={t('logicalCalls')}
        value={usageNumber(counts.logical_calls)}
        hint={t('evidenceRows', { count: counts.evidence_rows })}
      />
      <SummaryCard
        testId="hument-card-total-tokens"
        label={t('totalTokens')}
        value={usageNumber(tokens.total_tokens)}
        hint={
          tokens.total_tokens === null
            ? t('tokensUnknown', {
                known: tokens.known_total_tokens,
                unknown: tokens.unknown_total_rows,
              })
            : t('tokensKnown', { known: tokens.known_total_tokens })
        }
      />
      <SummaryCard
        testId="hument-card-physical-calls"
        label={t('physicalCalls')}
        value={usageNumber(counts.physical_calls)}
        hint={
          counts.physical_calls === null
            ? t('physicalUnknown', {
                known: counts.known_physical_calls,
                unknown: counts.unknown_physical_units,
              })
            : t('physicalKnown', { known: counts.known_physical_calls })
        }
      />
      <div
        data-testid="hument-card-cost"
        className="rounded-lg border border-border/60 bg-foreground/5 p-3"
      >
        <p className="text-[11px] text-muted-foreground">{t('cost')}</p>
        <dl className="mt-1 space-y-0.5 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">{t('actualCost')}</dt>
            <dd>
              <UsageValue value={usageMicros(cost.actual_micros)} testId="hument-actual-cost" />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] text-muted-foreground">{t('estimatedCost')}</dt>
            <dd>
              <UsageValue
                value={usageMicros(cost.estimated_micros)}
                testId="hument-estimated-cost"
              />
            </dd>
          </div>
        </dl>
        {cost.estimated_micros === null && (
          <p
            className="mt-1 text-[11px] text-muted-foreground"
            data-testid="hument-estimated-coverage"
          >
            {t('estimatedCoverage', {
              known: cost.known_estimated_micros,
              unknown: cost.unknown_estimated_rows,
            })}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid="hument-cost-nonaddable">
          {t('nonAddable')}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground" data-testid="hument-currency-note">
          {t('currencyNote')}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {t('duration', {
            known: duration.known_physical_ms,
            unknown: duration.unknown_physical_rows,
            physical: duration.physical_ms === null ? t('unknown') : duration.physical_ms,
          })}
        </p>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: ReturnType<typeof usageNumber>;
  hint: string;
  testId: string;
}) {
  return (
    <div data-testid={testId} className="rounded-lg border border-border/60 bg-foreground/5 p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">
        <UsageValue value={value} />
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Groups（Top 10 默认；全量可展开；移动卡片化） */
export function HumentGroups({ groups }: { groups: HumentUsageGroup[] }) {
  const t = useTranslations('usage.hument.groups');
  const [visibleCount, setVisibleCount] = useState(10);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 分档展开：每次多 20 行（不一次渲染无限 groups）
  const visible = groups.slice(0, visibleCount);
  const hasMore = groups.length > visibleCount;
  const groupKey = (group: HumentUsageGroup, index: number) =>
    `${index}:${group.operation}:${group.provider_operation}:${group.model ?? ''}:${group.model_basis}`;

  const toggle = (key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <UsageSection
      testId="hument-groups"
      title={t('title')}
      description={t('description', { shown: visible.length, total: groups.length })}
      action={
        groups.length > 10 ? (
          <div className="flex gap-2">
            {visibleCount > 10 && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="hument-groups-collapse"
                onClick={() => setVisibleCount(10)}
              >
                {t('collapse')}
              </Button>
            )}
            {hasMore && (
              <Button
                variant="outline"
                size="sm"
                data-testid="hument-groups-show-all"
                aria-expanded={hasMore}
                onClick={() => setVisibleCount((value) => Math.min(groups.length, value + 20))}
              >
                {t('showMore', { count: Math.min(20, groups.length - visibleCount) })}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {groups.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          {/* 桌面：7 列主表 */}
          <div
            role="region"
            aria-label={t('caption')}
            tabIndex={0}
            className="hidden overflow-x-auto rounded-lg border border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block"
          >
            <Table data-testid="hument-groups-table">
              <TableCaption>{t('caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('operation')}</TableHead>
                  <TableHead>{t('providerModel')}</TableHead>
                  <TableHead>{t('basis')}</TableHead>
                  <TableHead className="text-right">{t('logicalCalls')}</TableHead>
                  <TableHead className="text-right">{t('tokens')}</TableHead>
                  <TableHead className="text-right">{t('estimated')}</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">{t('details')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((group, index) => {
                  const key = groupKey(group, index);
                  const open = expanded.has(key);
                  const id = `hument-group-detail-${index}`;
                  return (
                    <GroupRows
                      key={key}
                      group={group}
                      open={open}
                      id={id}
                      onToggle={() => toggle(key)}
                      index={index}
                    />
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* 移动：卡片化（375px 可用） */}
          <div className="space-y-2 md:hidden" data-testid="hument-groups-mobile">
            {visible.map((group, index) => {
              const key = groupKey(group, index);
              const open = expanded.has(key);
              const id = `hument-group-mobile-detail-${index}`;
              return (
                <div
                  key={key}
                  data-testid={`hument-group-card-${index}`}
                  className="rounded-lg border border-border/60 p-2.5"
                >
                  <p className="font-mono text-xs">{group.operation}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {group.provider_operation} · {group.model ?? t('unknownModel')} ·{' '}
                    {basisLabel(group.model_basis, t)}
                  </p>
                  <dl className="mt-1 grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <dt className="text-muted-foreground">{t('logicalCalls')}</dt>
                      <dd>
                        <UsageValue value={usageNumber(group.totals.counts.logical_calls)} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('tokens')}</dt>
                      <dd>
                        <UsageValue value={usageNumber(group.totals.tokens.total_tokens)} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('estimated')}</dt>
                      <dd>
                        <UsageValue value={usageMicros(group.totals.cost.estimated_micros)} />
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    aria-label={t('expand', { operation: group.operation })}
                    onClick={() => toggle(key)}
                    className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-md border border-input px-2 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {open ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    {t('details')}
                  </button>
                  {open && (
                    <div id={id} className="mt-2">
                      <GroupTotals totals={group.totals} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </UsageSection>
  );
}

function GroupRows({
  group,
  open,
  id,
  onToggle,
  index,
}: {
  group: HumentUsageGroup;
  open: boolean;
  id: string;
  onToggle: () => void;
  index: number;
}) {
  const t = useTranslations('usage.hument.groups');
  return (
    <>
      <TableRow data-testid={`hument-group-row-${index}`}>
        <TableCell className="font-mono text-xs">{group.operation}</TableCell>
        <TableCell className="text-xs">
          <span className="font-mono">{group.provider_operation}</span>
          <span className="block text-muted-foreground">{group.model ?? t('unknownModel')}</span>
        </TableCell>
        <TableCell className="font-mono text-[11px] text-muted-foreground">
          {basisLabel(group.model_basis, t)}
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={usageNumber(group.totals.counts.logical_calls)} />
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={usageNumber(group.totals.tokens.total_tokens)} />
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={usageMicros(group.totals.cost.estimated_micros)} />
        </TableCell>
        <TableCell>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={t('expand', { operation: group.operation })}
            onClick={onToggle}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow id={id} data-testid={`hument-group-detail-row-${index}`}>
          <TableCell colSpan={7} className="bg-muted/30">
            <GroupTotals totals={group.totals} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** cost.status 是开放字符串：已知值走 i18n，域外值原样显示。 */
function costStatusLabel(
  status: string,
  t: (
    key: 'costStatusValue.known' | 'costStatusValue.partial' | 'costStatusValue.unknown',
  ) => string,
): string {
  if (status === 'known') return t('costStatusValue.known');
  if (status === 'partial') return t('costStatusValue.partial');
  if (status === 'unknown') return t('costStatusValue.unknown');
  return status;
}

/** 行内详情：计数/token/成本/时长（全部走三态展示） */
function GroupTotals({ totals }: { totals: HumentUsageTotals }) {
  const t = useTranslations('usage.hument.detail');
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] md:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">{t('evidenceRows')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.evidence_rows)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('generations')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.generations)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('batches')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.batches)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('physicalCalls')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.physical_calls)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('knownPhysical')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.known_physical_calls)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('unknownPhysical')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.unknown_physical_units)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('retries')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.retries)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('http429')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.http_429)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('cacheReuses')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.cache_reuses)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('replayCount')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.counts.replay_count)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('knownInputTokens')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.tokens.known_input_tokens)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('knownOutputTokens')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.tokens.known_output_tokens)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('knownTotalTokens')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.tokens.known_total_tokens)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('unknownInputRows')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.tokens.unknown_input_rows)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('unknownOutputRows')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.tokens.unknown_output_rows)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('unknownTotalRows')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.tokens.unknown_total_rows)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('actualCost')}</dt>
          <dd>
            <UsageValue value={usageMicros(totals.cost.actual_micros)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('estimatedCost')}</dt>
          <dd>
            <UsageValue value={usageMicros(totals.cost.estimated_micros)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('unknownEstimatedRows')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.cost.unknown_estimated_rows)} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('costStatus')}</dt>
          <dd className="font-mono">{costStatusLabel(totals.cost.status, t)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('duration')}</dt>
          <dd>
            <UsageValue value={usageNumber(totals.duration.physical_ms)} />
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">{t('nonAddable')}</p>
    </>
  );
}
