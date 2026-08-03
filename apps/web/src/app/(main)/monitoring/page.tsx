'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { Activity, Database, Users, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import type { AuditLog, PaginatedResponse } from '@/types';

function formatDate(dateStr: string) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('zh-CN');
}

function getTodayStart() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

export default function MonitoringPage() {
  const t = useTranslations('monitoring');
  const [logs, setLogs] = useState<PaginatedResponse<AuditLog> | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 20;

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

  const todayStart = getTodayStart();
  const todayCount =
    logs?.items.filter((log) => log.createdAt && log.createdAt >= todayStart).length ?? 0;
  const totalCount = logs?.total ?? 0;
  const uniqueActors = logs?.items
    ? new Set(logs.items.map((log) => log.actorId).filter(Boolean)).size
    : 0;

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
