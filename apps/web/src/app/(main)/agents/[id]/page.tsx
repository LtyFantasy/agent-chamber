'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { formatDate } from '@/lib/utils';
import {
  ArrowLeft,
  Bot,
  MessageSquare,
  FolderKanban,
  Clock,
  Zap,
  CalendarDays,
} from 'lucide-react';

const AGENT_DETAIL_STATUS_LABEL_KEY = {
  active: 'agents.detail.status.active',
  disabled: 'agents.detail.status.disabled',
  pending: 'agents.detail.status.pending',
} as const;

const AGENT_DETAIL_STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  active: 'success',
  disabled: 'secondary',
  pending: 'warning',
};

export default function AgentDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const t = useTranslations('agents.detail');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tGlobal = useTranslations() as any;

  const { data: agent, isLoading: agentLoading } = useQuery({
    queryKey: ['agents', 'detail', id],
    queryFn: () => Api.agents.getById(id),
    enabled: !!id,
  });

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['agents', 'stats', id],
    queryFn: () => Api.agents.getStats(id),
    enabled: !!id,
  });

  const isLoading = agentLoading || statsLoading;

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">{t('notFound')}</h2>
        <Link href="/agents" className="mt-4 text-primary hover:underline">
          {t('backToList')}
        </Link>
      </div>
    );
  }

  const statusLabel =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tGlobal(
      AGENT_DETAIL_STATUS_LABEL_KEY[
        agent.status as keyof typeof AGENT_DETAIL_STATUS_LABEL_KEY
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    ) || agent.status;
  const statusVariant = AGENT_DETAIL_STATUS_VARIANT[agent.status] || 'default';

  const statCards = [
    {
      title: t('stats.topics'),
      value: stats?.topicCount ?? agent.topicCount ?? 0,
      icon: FolderKanban,
    },
    {
      title: t('stats.messages'),
      value: stats?.messageCount ?? agent.messageCount ?? 0,
      icon: MessageSquare,
    },
    {
      title: t('stats.tasks'),
      value: stats?.taskCount ?? 0,
      icon: Zap,
    },
    {
      title: t('stats.avgResponse'),
      value: stats?.avgResponseTime ? `${stats.avgResponseTime}ms` : '-',
      icon: Clock,
    },
  ];

  const dailyActivity = stats?.dailyActivity ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/agents">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
          </div>
          {agent.lastActiveAt && (
            <p className="text-sm text-muted-foreground mt-1">
              {t('lastActive', { time: formatDate(agent.lastActiveAt) })}
            </p>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((card) => (
          <Card key={card.title}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{card.title}</p>
                  <p className="text-2xl font-bold mt-1">{card.value}</p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <card.icon className="h-5 w-5 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Description */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('description')}</CardTitle>
            </CardHeader>
            <CardContent>
              {agent.description ? (
                <p className="text-sm whitespace-pre-wrap">{agent.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noDescription')}</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Daily Activity */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                {t('activityTimeline')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dailyActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noActivity')}</p>
              ) : (
                <div className="space-y-3">
                  {dailyActivity.map((day) => (
                    <div key={day.date} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                        <span className="text-sm">{day.date}</span>
                      </div>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <span>{t('dailyMessages', { count: day.messageCount })}</span>
                        <span>{t('dailyTokens', { count: day.tokenUsage })}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
