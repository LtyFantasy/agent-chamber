'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { MotionConfig, motion } from 'framer-motion';
import { useLocale, useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth.store';
import { Api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { AmbientGlow } from '@/components/layout/ambient-glow';
import { formatRelativeTime, cn } from '@/lib/utils';
import { fadeSlideUp, staggerContainer } from '@/lib/animations';
import { Bot, MessageSquare, KanbanSquare, ArrowRight, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentStatus } from '@/types';

export function EditorDashboard() {
  const { user } = useAuthStore();
  const t = useTranslations('dashboard');
  const locale = useLocale();

  const { data: agents, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => Api.agents.list(),
  });

  const { data: topics, isLoading: topicsLoading } = useQuery({
    queryKey: ['topics'],
    queryFn: () => Api.topics.list(),
  });

  const { data: boards, isLoading: boardsLoading } = useQuery({
    queryKey: ['boards'],
    queryFn: () => Api.boards.list(),
  });

  // 快捷入口配色：全部走令牌/暗色半透明写法（设计文档 §2.2），
  // 禁止 bg-*-50 / text-*-600 这类亮主题硬编码（暗底上是"补丁脸"）
  const quickLinks = [
    {
      href: '/topics',
      title: t('quickLink.topicsTitle'),
      description: t('quickLink.topicsDesc'),
      icon: MessageSquare,
      count: topics?.items?.length ?? 0,
      countLabel: t('quickLink.topicsCount', { count: topics?.items?.length ?? 0 }),
      // 主光色青：令牌驱动
      color: 'bg-primary/15 text-primary',
    },
    {
      href: '/boards',
      title: t('quickLink.boardsTitle'),
      description: t('quickLink.boardsDesc'),
      icon: KanbanSquare,
      count: boards?.items?.length ?? 0,
      countLabel: t('quickLink.boardsCount', { count: boards?.items?.length ?? 0 }),
      // 语义绿：暗底适配的半透明写法
      color: 'bg-emerald-500/15 text-emerald-300',
    },
    {
      href: '/agents',
      title: t('quickLink.agentsTitle'),
      description: t('quickLink.agentsDesc'),
      icon: Bot,
      count: agents?.items?.length ?? 0,
      countLabel: t('quickLink.agentsCount', { count: agents?.items?.length ?? 0 }),
      // 辅助光色紫：violet-glow 令牌 + violet-300 文字
      color: 'bg-violet-glow/15 text-violet-300',
    },
  ];

  const isLoading = agentsLoading || topicsLoading || boardsLoading;

  return (
    // reducedMotion="user"：全页 framer-motion 动画尊重 prefers-reduced-motion（设计文档 §5）
    <MotionConfig reducedMotion="user">
      {/* 展厅级门面：页面级光斑（仅 dashboard/login 级页面允许）；relative 让内容压在光斑之上 */}
      <div className="relative space-y-6">
        <AmbientGlow />

        {/* 欢迎区：深空玻璃横幅 + 左上径向微光 + 呼吸光晕图标 */}
        <motion.div
          variants={fadeSlideUp}
          initial="hidden"
          animate="show"
          className="glass relative overflow-hidden rounded-xl p-6"
        >
          {/* 微光：横幅内嵌的径向青光斑（纯视觉，pointer-events-none） */}
          <div
            aria-hidden
            className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full"
            style={{
              background: 'radial-gradient(circle, hsl(var(--primary) / 0.18) 0%, transparent 70%)',
            }}
          />
          <div className="relative flex items-center gap-3">
            <div className="animate-breathing flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 shadow-glow-sm">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                {t('welcomeBack', { name: user?.name || t('editorFallback') })}
              </h1>
              <p className="text-muted-foreground mt-1">{t('editorDescription')}</p>
            </div>
          </div>
        </motion.div>

        {/* 快捷入口 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="relative grid gap-4 md:grid-cols-3"
        >
          {quickLinks.map((link) => (
            <motion.div key={link.href} variants={fadeSlideUp}>
              <Link href={link.href} className="group block h-full">
                {/* 快捷入口 = CTA 性质卡片：玻璃化 + hover 青色描边/图标微光 */}
                <Card className="glass h-full transition-colors hover:border-primary/50">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div
                        className={cn(
                          'flex h-10 w-10 items-center justify-center rounded-lg transition-shadow group-hover:shadow-glow-sm',
                          link.color,
                        )}
                      >
                        <link.icon className="h-5 w-5" />
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
                    </div>
                    <CardTitle className="text-base mt-3">{link.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{link.description}</p>
                    {isLoading ? (
                      <div className="mt-3 h-4 w-12 animate-pulse rounded bg-muted" />
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">{link.countLabel}</p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
        </motion.div>

        {/* 最近内容 */}
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="relative grid gap-4 lg:grid-cols-2"
        >
          {/* 最近话题 */}
          <motion.div variants={fadeSlideUp}>
            {/* 区块卡级容器允许 .glass（backdrop-blur）；其内部列表行用 .glass-flat 禁 blur */}
            <Card className="glass h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-primary" />
                  {t('recentTopics')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {topicsLoading ? (
                  <Loading />
                ) : !topics?.items || topics.items.length === 0 ? (
                  <EmptyState
                    title={t('noTopics')}
                    description={t('noTopicsDesc')}
                    action={
                      <Link href="/topics">
                        <Button variant="outline" size="sm">
                          {t('goToTopics')}
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    {topics.items.slice(0, 5).map((topic) => (
                      <Link
                        key={topic.id}
                        href={`/topics/${topic.id}`}
                        className="glass-flat flex items-center justify-between gap-2 rounded-lg p-3 transition-colors hover:bg-accent"
                      >
                        <span className="truncate text-sm font-medium">{topic.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {topic.lastMessageAt
                            ? formatRelativeTime(topic.lastMessageAt, locale)
                            : topic.updatedAt
                              ? formatRelativeTime(topic.updatedAt, locale)
                              : ''}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* 我的 Agents */}
          <motion.div variants={fadeSlideUp}>
            <Card className="glass h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-violet-300" />
                  {t('myAgents')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {agentsLoading ? (
                  <Loading />
                ) : !agents?.items || agents.items.length === 0 ? (
                  <EmptyState
                    title={t('noAgent')}
                    description={t('noAgentDesc')}
                    action={
                      <Link href="/agents">
                        <Button variant="outline" size="sm">
                          {t('createAgent')}
                        </Button>
                      </Link>
                    }
                  />
                ) : (
                  <div className="space-y-3">
                    {agents.items.slice(0, 5).map((agent) => (
                      <Link
                        key={agent.id}
                        href={`/agents/${agent.id}`}
                        className="glass-flat flex items-center justify-between gap-2 rounded-lg p-3 transition-colors hover:bg-accent"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                            <Bot className="h-4 w-4 text-primary" />
                          </div>
                          <span className="text-sm font-medium">{agent.name}</span>
                        </div>
                        {/* 在线状态：呼吸光点 + 暗底适配的 emerald-300（替换亮主题 text-green-600） */}
                        <span
                          className={cn(
                            'flex shrink-0 items-center gap-1.5 text-xs',
                            agent.status === AgentStatus.ACTIVE
                              ? 'text-emerald-300'
                              : 'text-muted-foreground',
                          )}
                        >
                          {agent.status === AgentStatus.ACTIVE && (
                            <span className="animate-breathing h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          )}
                          {agent.status === AgentStatus.ACTIVE ? t('online') : agent.status}
                        </span>
                      </Link>
                    ))}
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
