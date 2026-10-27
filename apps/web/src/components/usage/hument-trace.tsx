'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Hument Usage **Trace 折叠区**的展示层（数据/分页状态由 `use-hument-trace` 提供）
 *
 * [代码职责]
 *   - 「已加载 X / 共 total_rows」、load-more 三态、第二页失败保留行重试、
 *     resetPending 不闪空、cursor 复位停止提示
 *   - 7 列主表 + 行内详情；滚动区可键盘聚焦（tabIndex=0 + role=region）
 *   - 首屏失败的可重试性由 `usageErrorInfo().retryable` 决定
 *
 * [权威文档]
 *   - 后端 `usage-trace.schema.json` / `memory-engine.interface.ts`
 *   - 计划 `constantine-pantha-lockjaw.md` §2.4 / §3.4.6
 *
 * [关键不变量]
 *   - **total_rows 是完整匹配集**（与页大小无关）；X 是当前已加载行数，不能把 X 当 total。
 *   - **null = 未知**；token/cost/elapsed 一律 `UsageValue`。
 *   - **复位期间保留旧行**：`refreshing` 只加状态行，不卸载表格。
 *   - **403/版本/身份不渲染重试按钮**（`UsageErrorPanel` 统一裁决）。
 *
 * [关联代码]
 *   - ./use-hument-trace.ts — 状态机（请求次数/复位上界）
 *   - ../../lib/usage.ts — 三态/错误分桶
 *   - ./usage-primitives.tsx — UsageValue/UsageErrorPanel/UsageStatus
 *
 * [修改检查]
 *   □ 表格主列保持 5–7；其余字段进详情行
 *   □ 新增交互必须键盘可达
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-CODE-HOOK
 * =============================================================================
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  usageFormatUtcMinute,
  usageMicros,
  usageNumber,
  type HumentUsageTraceRow,
} from '@/lib/usage';
import {
  UsageErrorPanel,
  UsageRetryButton,
  UsageSection,
  UsageStatus,
  UsageValue,
} from './usage-primitives';
import type { useHumentTrace } from './use-hument-trace';

type TraceController = ReturnType<typeof useHumentTrace>;

export function HumentTrace({
  trace,
  onRestart,
}: {
  trace: TraceController;
  /** 重置耗尽后的真实重启（增加 trace session → 新首页请求） */
  onRestart: () => void;
}) {
  const t = useTranslations('usage.hument.trace');
  const tState = useTranslations('usage.state');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <UsageSection
      testId="hument-trace"
      title={t('title')}
      description={t('description')}
      action={
        <UsageStatus testId="hument-trace-loaded">
          {t('loaded', { loaded: trace.rows.length, total: trace.totalRows })}
        </UsageStatus>
      }
    >
      {trace.refreshing && (
        <UsageStatus tone="warning" live testId="hument-trace-resetting">
          {t('resetting')}
        </UsageStatus>
      )}

      {trace.firstLoading ? (
        <div className="space-y-2" data-testid="hument-trace-loading">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : trace.firstError && trace.rows.length === 0 ? (
        <UsageErrorPanel
          error={trace.firstError}
          title={t('firstError')}
          retryLabel={tState('retry')}
          onRetry={trace.retryFirstPage}
          testId="hument-trace-first-error"
        />
      ) : trace.rows.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDesc')} />
      ) : (
        <>
          {trace.firstError && (
            <div className="flex flex-wrap items-center gap-2">
              <UsageStatus tone="warning" live testId="hument-trace-stale">
                {t('stale')}
              </UsageStatus>
              <UsageRetryButton
                error={trace.firstError}
                testId="hument-trace-stale-retry"
                onClick={trace.retryFirstPage}
              />
            </div>
          )}
          <TraceTable
            rows={trace.rows}
            expanded={expanded}
            onToggle={toggle}
            caption={t('caption')}
          />

          {trace.loadMoreError && (
            <div className="space-y-2" data-testid="hument-trace-load-more-error">
              <UsageErrorPanel
                error={trace.loadMoreError}
                title={trace.resetExhausted ? t('resetExhausted') : t('loadMoreError')}
                retryLabel={t('retryLoadMore')}
                onRetry={trace.resetExhausted ? undefined : () => void trace.loadMore()}
                testId="hument-trace-load-more-error-panel"
              />
              {trace.resetExhausted && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">{t('resetExhaustedHint')}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="hument-trace-restart"
                    onClick={onRestart}
                  >
                    {t('restartFirstPage')}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {trace.hasMore ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="hument-trace-load-more"
                isLoading={trace.loadingMore}
                disabled={trace.loadingMore || trace.refreshing}
                onClick={() => void trace.loadMore()}
              >
                {trace.loadingMore ? t('loadingMore') : t('loadMore')}
              </Button>
            ) : (
              <UsageStatus testId="hument-trace-end">{t('end')}</UsageStatus>
            )}
            {trace.loadingMore && (
              <UsageStatus live testId="hument-trace-loading-more">
                {t('loadingMore')}
              </UsageStatus>
            )}
          </div>
        </>
      )}
    </UsageSection>
  );
}

function TraceTable({
  rows,
  expanded,
  onToggle,
  caption,
}: {
  rows: HumentUsageTraceRow[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  caption: string;
}) {
  const t = useTranslations('usage.hument.trace');
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      data-testid="hument-trace-scroll"
      className="max-h-[30rem] overflow-auto rounded-lg border border-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table
        data-testid="hument-trace-table"
        className="w-full min-w-[48rem] caption-bottom text-sm"
      >
        <TableCaption>{caption}</TableCaption>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead>{t('columns.time')}</TableHead>
            <TableHead>{t('columns.operation')}</TableHead>
            <TableHead>{t('columns.provider')}</TableHead>
            <TableHead>{t('columns.model')}</TableHead>
            <TableHead className="text-right">{t('columns.tokens')}</TableHead>
            <TableHead className="text-right">{t('columns.elapsed')}</TableHead>
            <TableHead className="text-right">{t('columns.cost')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const open = expanded.has(row.id);
            const detailId = `hument-trace-detail-${index}`;
            return (
              <TraceRows
                key={row.id}
                row={row}
                open={open}
                detailId={detailId}
                onToggle={() => onToggle(row.id)}
                index={index}
              />
            );
          })}
        </TableBody>
      </table>
    </div>
  );
}

function TraceRows({
  row,
  open,
  detailId,
  onToggle,
  index,
}: {
  row: HumentUsageTraceRow;
  open: boolean;
  detailId: string;
  onToggle: () => void;
  index: number;
}) {
  const t = useTranslations('usage.hument.trace');
  const time = usageFormatUtcMinute(row.started_at ?? row.finished_at);
  return (
    <>
      <TableRow data-testid={`hument-trace-row-${index}`}>
        <TableCell className="whitespace-nowrap font-mono text-[11px]">{time}</TableCell>
        <TableCell className="font-mono text-[11px]">{row.operation}</TableCell>
        <TableCell className="font-mono text-[11px]">{row.provider_operation}</TableCell>
        <TableCell className="text-[11px]">
          {row.resolved_model ?? row.requested_model ?? row.model ?? '—'}
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={usageNumber(row.total_tokens)} />
        </TableCell>
        <TableCell className="text-right">
          <UsageValue value={usageNumber(row.elapsed_ms)} />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <UsageValue value={usageMicros(row.estimated_cost_micros)} />
            <button
              type="button"
              aria-expanded={open}
              aria-controls={detailId}
              aria-label={t('expand', { id: row.id })}
              onClick={onToggle}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow id={detailId} data-testid={`hument-trace-detail-${index}`}>
          <TableCell colSpan={7} className="bg-muted/30">
            <TraceDetail row={row} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function TraceDetail({ row }: { row: HumentUsageTraceRow }) {
  const t = useTranslations('usage.hument.trace.detail');
  type DetailKey =
    | 'id'
    | 'evidenceKind'
    | 'source'
    | 'usageSource'
    | 'tokenBasis'
    | 'modelBasis'
    | 'requestedModel'
    | 'resolvedModel'
    | 'inputTokens'
    | 'outputTokens'
    | 'actualCost'
    | 'costStatus'
    | 'physicalUnknown'
    | 'cacheReuses'
    | 'requestBytes'
    | 'responseBytes'
    | 'responseComplete'
    | 'httpStatus'
    | 'state'
    | 'invocationId'
    | 'logicalCallId'
    | 'generationId'
    | 'requestDigest'
    | 'startedAt'
    | 'finishedAt'
    | 'yes'
    | 'no';
  const fields: Array<[DetailKey, React.ReactNode]> = [
    [
      'id',
      <span key="id" className="font-mono break-all">
        {row.id}
      </span>,
    ],
    [
      'evidenceKind',
      <span key="ek" className="font-mono">
        {row.evidence_kind}
      </span>,
    ],
    [
      'source',
      <span key="src" className="font-mono">
        {row.source}
      </span>,
    ],
    [
      'usageSource',
      <span key="us" className="font-mono">
        {row.usage_source}
      </span>,
    ],
    [
      'tokenBasis',
      <span key="tb" className="font-mono">
        {row.token_basis}
      </span>,
    ],
    [
      'modelBasis',
      <span key="mb" className="font-mono">
        {row.model_basis}
      </span>,
    ],
    ['requestedModel', row.requested_model ?? '—'],
    ['resolvedModel', row.resolved_model ?? '—'],
    ['inputTokens', <UsageValue key="it" value={usageNumber(row.input_tokens)} />],
    ['outputTokens', <UsageValue key="ot" value={usageNumber(row.output_tokens)} />],
    ['actualCost', <UsageValue key="ac" value={usageMicros(row.actual_cost_micros)} />],
    [
      'costStatus',
      <span key="cs" className="font-mono">
        {row.cost_status}
      </span>,
    ],
    ['physicalUnknown', row.physical_calls_unknown ? t('yes') : t('no')],
    ['cacheReuses', <UsageValue key="cr" value={usageNumber(row.cache_reuses)} />],
    ['requestBytes', <UsageValue key="rb" value={usageNumber(row.request_bytes)} />],
    ['responseBytes', <UsageValue key="rsb" value={usageNumber(row.response_bytes)} />],
    ['responseComplete', row.response_complete ? t('yes') : t('no')],
    [
      'httpStatus',
      row.http_status === null || row.http_status === undefined ? (
        <UsageValue key="hs" value={{ text: '', unknown: true }} />
      ) : (
        String(row.http_status)
      ),
    ],
    ['startedAt', row.started_at ?? '—'],
    ['finishedAt', row.finished_at ?? '—'],
    ['state', row.state ?? '—'],
    ['invocationId', row.invocation_id ?? '—'],
    ['logicalCallId', row.logical_call_id ?? '—'],
    ['generationId', row.generation_id ?? '—'],
    ['requestDigest', row.request_digest ?? '—'],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2 lg:grid-cols-3">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{t(label)}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
