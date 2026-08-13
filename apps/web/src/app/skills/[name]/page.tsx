'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { formatRelativeTime } from '@/lib/utils';
import { Copy, Download, Terminal, AlertCircle, BookOpen } from 'lucide-react';

/**
 * 公开 Skill 详情页。
 *
 * 路由：`/skills/:name`
 * 特性：
 * - 无需登录即可访问
 * - 展示 Skill 元数据（名称、版本、更新时间）
 * - Markdown 预览
 * - 支持复制内容、下载 SKILL.md、复制一键安装命令
 */
export default function SkillDetailPage() {
  const params = useParams();
  const name = params.name as string;
  const t = useTranslations('skills');

  /** 复制按钮的临时状态：key -> 是否已复制 */
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({});

  const {
    data: skill,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['skills', 'detail', name],
    queryFn: () => Api.skills.get(name),
    enabled: !!name,
  });

  /** 子 Skill 列表（如 topics、taskboard、docs）；null = 尚未加载完成 */
  const { data: subs } = useQuery({
    queryKey: ['skills', 'subs', name],
    queryFn: () => Api.skills.getSubs(name),
    enabled: !!name,
  });

  /** 当前选中的子 Skill 路径；null = 展示主 Skill 内容 */
  const [selectedSub, setSelectedSub] = useState<string | null>(null);

  /** 选中子 Skill 的详情内容 */
  const { data: subDetail, isLoading: subLoading } = useQuery({
    queryKey: ['skills', 'sub', name, selectedSub],
    queryFn: () => Api.skills.getSub(name, selectedSub as string),
    enabled: !!name && !!selectedSub,
  });

  /** 一键安装命令，基于当前页面域名动态生成 */
  const installCommand = useMemo(() => {
    if (typeof window === 'undefined' || !name) return '';
    const origin = window.location.origin;
    return `curl -fsSL ${origin}/install-skill.sh | bash -s -- -d ~/.agents/skills/${name}`;
  }, [name]);

  /**
   * 复制文本到剪贴板，并在指定 key 上显示短暂的"已复制"状态。
   */
  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMap((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => {
        setCopiedMap((prev) => ({ ...prev, [key]: false }));
      }, 2000);
    } catch (err) {
      console.error('复制失败:', err);
    }
  };

  /** 下载 SKILL.md 文件 */
  const handleDownload = async () => {
    if (!skill) return;
    try {
      const rawContent = await Api.skills.get(name, 'raw');
      const blob = new Blob([rawContent], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'SKILL.md';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('下载失败:', err);
    }
  };

  /** 下载子 Skill 的 SKILL.md 文件（含 frontmatter，与仓库原文件一致） */
  const handleSubDownload = async (subpath: string) => {
    try {
      const rawContent = await Api.skills.getSub(name, subpath, 'raw');
      const blob = new Blob([rawContent], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'SKILL.md';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('下载失败:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  // 请求失败或 Skill 不存在时展示 404 提示
  if (error || !skill) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <AlertCircle className="mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{t('notFound')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t.rich('notFoundHint', {
            name: () => <code className="rounded bg-muted px-1 py-0.5">{name}</code>,
          })}
        </p>
        <Link href="/login" className="mt-6 text-sm text-primary hover:underline">
          {t('backToLogin')}
        </Link>
      </div>
    );
  }

  return (
    // 不刷不透明 bg-background（ui-design-system §3：底色由 body 负责，避免盖住全局网格纹理）
    <main className="min-h-screen px-4 py-8 md:px-8">
      <div className="mx-auto max-w-4xl">
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <BookOpen className="h-6 w-6 text-primary" />
                  <CardTitle className="text-2xl font-bold">{skill.name}</CardTitle>
                </div>
                <CardDescription>{skill.description}</CardDescription>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {skill.version && <Badge variant="secondary">v{skill.version}</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {t('updated', { time: formatRelativeTime(skill.updatedAt) })}
                  </span>
                </div>
              </div>

              {/* 操作按钮区 */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyToClipboard(skill.content, 'content')}
                >
                  <Copy className="mr-1.5 h-4 w-4" />
                  {copiedMap.content ? t('copied') : t('copyMarkdown')}
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="mr-1.5 h-4 w-4" />
                  {t('downloadSkillMd')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => copyToClipboard(installCommand, 'install')}
                  disabled={!installCommand}
                >
                  <Terminal className="mr-1.5 h-4 w-4" />
                  {copiedMap.install ? t('copied') : t('copyInstallCommand')}
                </Button>
              </div>
            </div>
          </CardHeader>

          {/* 子 Skill 导航条：主 Skill + 各子 Skill 标签，点击切换内容区 */}
          {subs && subs.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b px-6 pb-4">
              <span className="text-xs font-medium text-muted-foreground">{t('subSkills')}</span>
              <Button
                variant={selectedSub === null ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedSub(null)}
              >
                {skill.name}
              </Button>
              {subs.map((sub) => (
                <Button
                  key={sub.name}
                  variant={selectedSub === sub.name ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedSub(sub.name)}
                >
                  {sub.name}
                  {sub.version && <span className="ml-1.5 text-xs opacity-70">v{sub.version}</span>}
                </Button>
              ))}
            </div>
          )}

          <CardContent>
            {/* Markdown 预览：固定最大高度，支持滚动；选中子 Skill 时渲染子内容 */}
            <div className="max-h-[60vh] overflow-y-auto rounded-md border bg-card p-4 sm:p-6">
              {selectedSub ? (
                subLoading || !subDetail ? (
                  <div className="flex justify-center py-8">
                    <Loading size="sm" />
                  </div>
                ) : (
                  <>
                    <article className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{subDetail.content}</ReactMarkdown>
                    </article>
                    <div className="mt-4 flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSubDownload(selectedSub)}
                      >
                        <Download className="mr-1.5 h-4 w-4" />
                        {t('subDownload')}
                      </Button>
                    </div>
                  </>
                )
              ) : (
                <article className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.content}</ReactMarkdown>
                </article>
              )}
            </div>
          </CardContent>

          <CardFooter className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">{t('footerHint')}</p>
            <Link href="/login" className="text-sm text-primary hover:underline">
              {t('goToLogin')}
            </Link>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}
