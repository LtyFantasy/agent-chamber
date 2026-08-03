'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MotionConfig, motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth.store';
import { Api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar } from '@/components/ui/avatar';
import { AmbientGlow } from '@/components/layout/ambient-glow';
import { formatRelativeTime, cn } from '@/lib/utils';
import { fadeSlideUp, staggerContainer, useCountUp } from '@/lib/animations';
import {
  Bot,
  MessageSquare,
  CheckSquare,
  KanbanSquare,
  FileText,
  Activity,
  Trophy,
  Flame,
} from 'lucide-react';

const statusMap: Record<
  string,
  {
    labelKey: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
  }
> = {
  draft: { labelKey: 'topics.status.draft', variant: 'secondary' },
  open: { labelKey: 'topics.status.open', variant: 'default' },
  active: { labelKey: 'topics.status.active', variant: 'success' },
  voting: { labelKey: 'topics.status.voting', variant: 'warning' },
  paused: { labelKey: 'topics.status.paused', variant: 'warning' },
  closed: { labelKey: 'topics.status.closed', variant: 'destructive' },
  archived: { labelKey: 'topics.status.archived', variant: 'outline' },
};

/**
 * StatNumber — 统计卡大数字，挂载时从 0 滚动到目标值。
 * 独立组件是为了在 map 渲染中合法调用 useCountUp hook。
 */
function StatNumber({ value }: { value: number }) {
  const display = useCountUp(value);
  return <>{display}</>;
}

/** 最近活跃判定窗口：15 分钟内有消息/任务动作的 Agent 视为「在线呼吸」状态 */
const RECENT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

export function AdminDashboard() {
  const { user } = useAuthStore();
  const t = useTranslations('dashboard');
  const tGlobal = useTranslations();

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: () => Api.dashboard.getStats(),
  });

  const { data: activities, isLoading: activityLoading } = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: () => Api.dashboard.getAgentActivity(),
  });

  const { data: leaderboard } = useQuery({
    queryKey: ['dashboard', 'leaderboard'],
    queryFn: () => Api.dashboard.getLeaderboard(),
  });

  const { data: recentTopics } = useQuery({
    queryKey: ['dashboard', 'recent-topics'],
    queryFn: () => Api.dashboard.getRecentTopics(),
  });

  const statCards = [
    {
      title: t('agents'),
      value: stats?.totalAgents ?? 0,
      active: stats?.activeAgents ?? 0,
      icon: Bot,
    },
    {
      title: t('topics'),
      value: stats?.totalTopics ?? 0,
      active: stats?.activeTopics ?? 0,
      icon: MessageSquare,
    },
    {
      title: t('tasks'),
      value: stats?.totalTasks ?? 0,
      active: stats?.completedTasks ?? 0,
      icon: CheckSquare,
    },
    { title: t('boards'), value: stats?.totalBoards ?? 0, icon: KanbanSquare },
    // Docs 卡：值为文档总数，副标题为空间计数；
    // ?? 0 容错旧后端响应缺字段（v1.35 前后端混部窗口）
    {
      title: t('docs'),
      value: stats?.docCount ?? 0,
      subtitle: t('docsSpaces', { count: stats?.docSpaceCount ?? 0 }),
      icon: FileText,
    },
  ];

  // 排行榜进度条归一化基准：取榜单最大 messageCount，保底 1 防除零
  const maxMessageCount = Math.max(1, ...(leaderboard ?? []).map((a) => a.messageCount ?? 0));

  return (
    // reducedMotion="user"：全页 framer-motion 动画尊重 prefers-reduced-motion（设计文档 §5）
    <MotionConfig reducedMotion="user">
      {/* 展厅级门面：页面级光斑（仅 dashboard/login 级页面允许）；relative 让内容压在光斑之上 */}
      <div className="relative space-y-6">
        <AmbientGlow />

        <motion.div variants={fadeSlideUp} initial="hidden" animate="show" className="relative">
          {/* 标题点缀青光：仅标题允许 text-glow，正文禁用 */}
          <h1 className="text-glow-cyan text-3xl font-bold tracking-tight">
            {t('welcomeBack', { name: user?.name || t('adminFallback') })}
          </h1>
          <p className="text-muted-foreground mt-1">{t('adminDescription')}</p>
        </motion.div>

        {statsLoading ? (
          <Loading />
        ) : (
          <motion.div
            variants={staggerContainer}
            initial="hidden"
            animate="show"
            className="relative grid gap-4 md:grid-cols-2 lg:grid-cols-5"
          >
            {statCards.map((card) => (
              <motion.div key={card.title} variants={fadeSlideUp}>
                {/* 统计卡 = 展厅级焦点：玻璃 blur + 青紫渐变描边（glow-border 会接管背景，勿再叠 bg-*）；h-full 保证无副标题的卡与其余卡等高 */}
                <Card className="glass glow-border h-full">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
                    {/* 图标青光点缀：微光晕，呼应主光色 */}
                    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 shadow-glow-sm">
                      <card.icon className="h-4 w-4 text-primary" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      <StatNumber value={card.value} />
                    </div>
                    {card.active !== undefined && (
                      <p className="text-xs text-muted-foreground">
                        {t('activeOfTotal', { active: card.active, total: card.value })}
                      </p>
                    )}
                    {'subtitle' in card && card.subtitle && (
                      <p className="text-xs text-muted-foreground">{card.subtitle}</p>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        )}

        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="relative grid gap-4 lg:grid-cols-2"
        >
          <motion.div variants={fadeSlideUp}>
            {/* 区块卡级容器允许 .glass（backdrop-blur）；其内部列表行禁用 blur */}
            <Card className="glass h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-primary" />
                  {t('agentActivity')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {activityLoading ? (
                  <Loading />
                ) : !activities || activities.length === 0 ? (
                  <EmptyState title={t('noActivity')} description={t('noActivityDesc')} />
                ) : (
                  <div className="space-y-4">
                    {activities.map((activity, index) => {
                      // 状态呼吸光点：15 分钟内活跃 → 青色呼吸 + 微光；否则静态灰点
                      const isRecentlyActive =
                        !!activity.lastActiveAt &&
                        Date.now() - new Date(activity.lastActiveAt).getTime() <
                          RECENT_ACTIVE_WINDOW_MS;
                      return (
                        <div
                          key={activity?.agentId || `activity-${index}`}
                          className="glass-flat flex items-center justify-between rounded-lg p-3"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                              <Bot className="h-4 w-4 text-primary" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium">{activity.agentName}</p>
                                <span
                                  aria-label={
                                    isRecentlyActive ? t('recentlyActive') : t('inactive')
                                  }
                                  className={cn(
                                    'h-1.5 w-1.5 rounded-full',
                                    isRecentlyActive
                                      ? 'animate-breathing bg-primary shadow-glow-sm'
                                      : 'bg-muted-foreground/40',
                                  )}
                                />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {t('messageTaskCount', {
                                  messages: activity.messageCount,
                                  tasks: activity.taskCount,
                                })}
                              </p>
                            </div>
                          </div>
                          <Badge variant="outline">
                            {activity.lastActiveAt
                              ? formatRelativeTime(activity.lastActiveAt)
                              : t('neverActive')}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={fadeSlideUp} className="space-y-4">
            <Card className="glass">
              <CardHeader>
                <CardTitle>{t('platformOverview')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('totalMessages')}</span>
                  <span className="font-medium">{stats?.totalMessages ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('completedTasks')}</span>
                  <span className="font-medium">
                    {stats?.completedTasks ?? 0} / {stats?.totalTasks ?? 0}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('activeTopics')}</span>
                  <span className="font-medium">
                    {stats?.activeTopics ?? 0} / {stats?.totalTopics ?? 0}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{t('onlineAgents')}</span>
                  <span className="font-medium">
                    {stats?.activeAgents ?? 0} / {stats?.totalAgents ?? 0}
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Trophy className="h-5 w-5 text-yellow-500" />
                  {t('agentLeaderboard')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!leaderboard || leaderboard.length === 0 ? (
                  <EmptyState title={t('noData')} />
                ) : (
                  <div className="space-y-3">
                    {leaderboard.slice(0, 5).map((agent, index) => (
                      <div key={agent.id} className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-medium">
                              {index + 1}
                            </span>
                            {/* 排行榜补头像：actorType="agent" 带 Bot 角标，无头像时回落 seed 确定性底色 */}
                            <Avatar
                              src={agent.avatarUrl}
                              fallback={agent.name}
                              seed={agent.id}
                              actorType="agent"
                              size="sm"
                            />
                            <span className="text-sm font-medium">{agent.name}</span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{t('xMessages', { count: agent.messageCount })}</span>
                            <span>·</span>
                            <span>{t('xCompletedTasks', { count: agent.completedTaskCount })}</span>
                          </div>
                        </div>
                        {/* 发光进度条：按 messageCount 归一化，纯 CSS 宽度（不动画 width，符合动效红线） */}
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-primary to-violet-glow shadow-glow-sm"
                            style={{
                              width: `${Math.round(((agent.messageCount ?? 0) / maxMessageCount) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Flame className="h-5 w-5 text-orange-500" />
                  {t('recentTopics')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!recentTopics || recentTopics.length === 0 ? (
                  <EmptyState title={t('noTopics')} />
                ) : (
                  <div className="space-y-3">
                    {recentTopics.slice(0, 5).map((topic) => {
                      const status = statusMap[topic.status] || {
                        labelKey: topic.status,
                        variant: 'default' as const,
                      };
                      return (
                        <div key={topic.id} className="flex items-center justify-between gap-2">
                          <Link
                            href={`/topics/${topic.id}`}
                            className="truncate text-sm font-medium transition-colors hover:text-primary"
                          >
                            {topic.title}
                          </Link>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={status.variant}>
                              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                              {tGlobal(status.labelKey as any)}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {topic.lastMessageAt
                                ? formatRelativeTime(topic.lastMessageAt)
                                : topic.updatedAt
                                  ? formatRelativeTime(topic.updatedAt)
                                  : ''}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </motion.div>
      </div>
    </MotionConfig>
  );
}
