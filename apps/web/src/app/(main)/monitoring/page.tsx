'use client';

import { useEffect, useState, useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Api, RUNNER_STATUS } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Activity,
  Database,
  Users,
  Download,
  ChevronLeft,
  ChevronRight,
  Server,
  Radio,
  Armchair,
  Zap,
  Webhook,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import type { ApiLogListResponse, SystemOverview } from '@/types';
import { formatRelativeTime } from '@/lib/utils';

function formatDate(dateStr: string) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN');
}

/** uptime 秒数 → 紧凑可读（如 3d 4h / 45m / 30s） */
function formatUptime(seconds: number) {
  if (seconds >= 86400)
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * 「需要关注」汇总带：离线 runner / 有积压座位 / webhook 失败+重试中。
 * 全零时显示「一切正常」中性绿色态；有异常时红色计数。3 秒可读优先。
 */
function AttentionStrip({ overview }: { overview: SystemOverview }) {
  const t = useTranslations('monitoring.attention');
  const offlineRunners = overview.runners.offline;
  const backlogSeats = overview.seats.items.filter((s) => (s.backlogEstimate ?? 0) > 0).length;
  const webhookIssues = overview.webhooks.failed + overview.webhooks.retrying;
  const allClear = offlineRunners === 0 && backlogSeats === 0 && webhookIssues === 0;

  if (allClear) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="h-4 w-4" />
        {t('allClear')}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" />
        {t('needsAttention')}
      </div>
      {offlineRunners > 0 && <span>{t('runnersOffline', { count: offlineRunners })}</span>}
      {backlogSeats > 0 && <span>{t('seatsBacklog', { count: backlogSeats })}</span>}
      {webhookIssues > 0 && <span>{t('webhookIssues', { count: webhookIssues })}</span>}
    </div>
  );
}

/** 系统信息行：version · commit · uptime（来自 /health 裸响应）+ 数据生成时间 */
function SystemInfoRow({ generatedAt }: { generatedAt?: string }) {
  const t = useTranslations('monitoring.system');
  const locale = useLocale();
  const { data: health } = useQuery({
    queryKey: ['monitoring', 'health'],
    queryFn: () => Api.monitoring.getHealth(),
    refetchInterval: 60_000,
  });
  const items = [
    { label: t('version'), value: health?.version ?? '-' },
    { label: t('commit'), value: health?.commit ?? '-' },
    { label: t('uptime'), value: health ? formatUptime(health.uptime) : '-' },
    { label: t('generatedAt'), value: generatedAt ? formatRelativeTime(generatedAt, locale) : '-' },
  ];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{t('title')}</CardTitle>
        <Server className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          {items.map((item) => (
            <div key={item.label}>
              <div className="text-xs text-muted-foreground">{item.label}</div>
              <div className="font-mono text-sm font-medium">{item.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** 圆桌健康：runner 在线状态 + 座位占用/未消费水位 + 注入管线埋点 */
function RoundtableSection({ overview }: { overview: SystemOverview }) {
  const t = useTranslations('monitoring.roundtable');
  const locale = useLocale();
  const { runners, seats, injection } = overview;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{t('runners')}</CardTitle>
          <Radio className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {runners.online}
            <span className="text-base font-normal text-muted-foreground">
              {' '}
              / {runners.total} {t('online')}
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {runners.items.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('noRunners')}</p>
            )}
            {runners.items.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant={r.status === RUNNER_STATUS.ONLINE ? 'success' : 'destructive'}>
                    {r.status}
                  </Badge>
                  <span className="font-medium">{r.name}</span>
                  {r.version && (
                    <span className="font-mono text-xs text-muted-foreground">v{r.version}</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {t('seatCount', { count: r.seatCount })}
                  {' · '}
                  {r.lastSeenAt ? formatRelativeTime(r.lastSeenAt, locale) : t('neverSeen')}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{t('seats')}</CardTitle>
          <Armchair className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {seats.total}
            {seats.unbound > 0 && (
              <span className="text-base font-normal text-muted-foreground">
                {' '}
                / {t('unbound', { count: seats.unbound })}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(seats.byStatus).map(([status, count]) => (
              <Badge key={status} variant="secondary">
                {status} {count}
              </Badge>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {seats.items.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('noSeats')}</p>
            )}
            {seats.items.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.label}</span>
                  <span className="text-xs text-muted-foreground">{s.vendor}</span>
                  {!s.runnerId && <Badge variant="outline">{t('unboundBadge')}</Badge>}
                </div>
                {/* backlogEstimate = 未消费水位（中性色，随攒批窗口抖动属正常）；
                    null = 从未派发，无法估计，不得显示为 0 */}
                <span className="text-xs text-muted-foreground">
                  {s.backlogEstimate === null
                    ? t('backlogUnknown')
                    : t('backlog', { count: s.backlogEstimate })}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 注入管线（1.54.0 埋点批）：延迟样本为滑动窗口（ring ≤100/座位），
          非全量统计；samples=0 显示空态，避免 0ms 误读 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{t('injection')}</CardTitle>
          <Zap className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {injection.latencySamples === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noSamples')}</p>
          ) : (
            <>
              <div className="text-2xl font-bold">{injection.latencyAvgMs}ms</div>
              <p className="text-xs text-muted-foreground">{t('latencyAvg')}</p>
            </>
          )}
          <div className="mt-3 space-y-1.5 text-sm">
            {injection.latencySamples > 0 && (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('latencyMax')}</span>
                  <span>{injection.latencyMaxMs}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t('latencySamples', { count: injection.latencySamples })}
                  </span>
                </div>
              </>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('retryCount')}</span>
              <span
                className={injection.retryCount > 0 ? 'text-amber-600 dark:text-amber-400' : ''}
              >
                {injection.retryCount}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('failCount')}</span>
              <span className={injection.failCount > 0 ? 'text-destructive' : ''}>
                {injection.failCount}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
/** 事件总线活跃度 + Webhook 投递健康 + SSE 推送连接 */
function PipelineSection({ overview }: { overview: SystemOverview }) {
  const t = useTranslations('monitoring.pipeline');
  const locale = useLocale();
  const { events, webhooks, sse } = overview;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{t('events')}</CardTitle>
          <Zap className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{events.last24h}</div>
          <p className="text-xs text-muted-foreground">{t('last24h')}</p>
          <div className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('total')}</span>
              <span>{events.total}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('latestEvent')}</span>
              <span>
                {events.latestEventAt
                  ? formatRelativeTime(events.latestEventAt, locale)
                  : t('noEvents')}
              </span>
            </div>
          </div>
          {events.byTypeLast24h.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {events.byTypeLast24h.slice(0, 5).map((row) => (
                <Badge key={row.eventType} variant="secondary">
                  {row.eventType} {row.count}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{t('webhooks')}</CardTitle>
          <Webhook className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {webhooks.total === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noDeliveries')}</p>
          ) : (
            <>
              <div className="text-2xl font-bold">
                {/* successRate 为 null（无完结投递）时显示 -，避免 0% 误读为全部失败 */}
                {webhooks.successRate === null
                  ? '-'
                  : `${(webhooks.successRate * 100).toFixed(1)}%`}
              </div>
              <p className="text-xs text-muted-foreground">{t('successRate')}</p>
              <div className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('avgLatency')}</span>
                  <span>
                    {webhooks.avgResponseTimeMs === null ? '-' : `${webhooks.avgResponseTimeMs}ms`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('failed')}</span>
                  <span className={webhooks.failed > 0 ? 'text-destructive' : ''}>
                    {webhooks.failed}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('retrying')}</span>
                  <span className={webhooks.retrying > 0 ? 'text-destructive' : ''}>
                    {webhooks.retrying}
                  </span>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* SSE 推送连接数（SseService 进程内 gauge 瞬时值） */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{t('sse')}</CardTitle>
          <Radio className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{sse.activeConnections}</div>
          <p className="text-xs text-muted-foreground">
            {t('activeConnections')} · {t('sseDesc')}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function MonitoringPage() {
  const t = useTranslations('monitoring');
  const [logs, setLogs] = useState<ApiLogListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data: overview } = useQuery({
    queryKey: ['monitoring', 'overview'],
    queryFn: () => Api.monitoring.getOverview(),
    refetchInterval: 30_000,
  });

  const fetchLogs = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await Api.monitoring.getApiLogs({ page: p, pageSize });
      setLogs(data);
    } catch (err) {
      console.error('获取 API 日志失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLogs(page);
  }, [page, fetchLogs]);

  const handleExport = async () => {
    try {
      const result = await Api.monitoring.exportApiLogs();
      const blob = new Blob([JSON.stringify(result.data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `api-logs-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('导出 API 日志失败:', err);
    }
  };

  // todayCount / uniqueActors 为后端全量聚合值（ce579dda 修复：不再对当前页
  // 客户端过滤，翻页不漂移）；totalCount 受时间过滤参数影响（当前未启用过滤 UI）
  const todayCount = logs?.todayCount ?? 0;
  const totalCount = logs?.total ?? 0;
  const uniqueActors = logs?.uniqueActors ?? 0;

  const statCards = [
    {
      title: t('todayCount'),
      value: todayCount,
      icon: Activity,
    },
    {
      title: t('totalCount'),
      value: totalCount,
      icon: Database,
    },
    {
      title: t('uniqueActors'),
      value: uniqueActors,
      icon: Users,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        <Button variant="outline" onClick={handleExport}>
          <Download className="mr-2 h-4 w-4" />
          {t('exportLogs')}
        </Button>
      </div>

      {overview && <AttentionStrip overview={overview} />}

      <SystemInfoRow generatedAt={overview?.generatedAt} />

      {overview && (
        <>
          <RoundtableSection overview={overview} />
          <PipelineSection overview={overview} />
        </>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {statCards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('apiLogs')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loading />
          ) : !logs || logs.items.length === 0 ? (
            <EmptyState title={t('noLogs')} description={t('noLogsDesc')} />
          ) : (
            <div className="space-y-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('table.time')}</TableHead>
                    <TableHead>{t('table.action')}</TableHead>
                    <TableHead>{t('table.entityType')}</TableHead>
                    <TableHead>{t('table.entityId')}</TableHead>
                    <TableHead>{t('table.actor')}</TableHead>
                    <TableHead>{t('table.ipAddress')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.items.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(String(log.createdAt))}
                      </TableCell>
                      <TableCell>{log.action}</TableCell>
                      <TableCell>{log.entityType}</TableCell>
                      <TableCell className="font-mono text-xs max-w-[120px] truncate">
                        {log.entityId}
                      </TableCell>
                      <TableCell>{log.actorId ?? '-'}</TableCell>
                      <TableCell>{log.ipAddress ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {t('pagination', {
                    page: logs.page,
                    totalPages: logs.totalPages,
                    pageSize: logs.pageSize,
                    total: logs.total,
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p - 1)}
                    disabled={!logs.hasPrev}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!logs.hasNext}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
