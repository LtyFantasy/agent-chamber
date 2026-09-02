'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { formatRelativeTime } from '@/lib/utils';
import { AlertCircle, BookOpen, ChevronRight } from 'lucide-react';

/**
 * 公开 Skill 列表页。
 *
 * 路由：`/skills`
 * 特性：
 * - 无需登录即可访问
 * - 展示全部公开 Skill 的元数据（名称、版本、描述、更新时间）
 * - 点击进入 `/skills/:name` 详情页（含子 Skill 导航）
 */
export default function SkillListPage() {
  const t = useTranslations('skills');
  const locale = useLocale();

  const {
    data: skills,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => Api.skills.list(),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  // 请求失败或列表为空时展示空态提示
  if (error || !skills || skills.length === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <AlertCircle className="mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
      </div>
    );
  }

  return (
    // 不刷不透明 bg-background（ui-design-system §3：底色由 body 负责，避免盖住全局网格纹理）
    <main className="min-h-screen px-4 py-8 md:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-center gap-3">
          <BookOpen className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>

        {/* Skill 卡片列表 */}
        <div className="flex flex-col gap-4">
          {skills.map((skill) => (
            <Link key={skill.name} href={`/skills/${skill.name}`} className="group">
              <Card className="transition-colors group-hover:border-primary/50">
                <CardHeader>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-lg">{skill.name}</CardTitle>
                        {skill.version && <Badge variant="secondary">v{skill.version}</Badge>}
                      </div>
                      <CardDescription>{skill.description}</CardDescription>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>
                        {t('updated', { time: formatRelativeTime(skill.updatedAt, locale) })}
                      </span>
                      <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </div>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
