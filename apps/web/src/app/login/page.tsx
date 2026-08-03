'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AmbientGlow } from '@/components/layout/ambient-glow';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Logo } from '@/components/ui/logo';
import { BookOpen } from 'lucide-react';

/** 最近一次成功登录账号的 localStorage key（体验改进：登录页默认回填） */
const LAST_EMAIL_KEY = 'auth:last-email';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const t = useTranslations('auth');

  // 挂载后回填最近登录账号（SSR 无 localStorage，须 useEffect 读取避免 hydration 不一致）
  useEffect(() => {
    const saved = localStorage.getItem(LAST_EMAIL_KEY);
    if (saved) setEmail(saved);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      localStorage.setItem(LAST_EMAIL_KEY, email);
      router.push('/');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('loginFailed');
      setError(message);
    }
  };

  return (
    // 登录页（展厅级绚丽）：页面级光斑 + 玻璃卡。不刷 bg-background，透出全局网格纹理
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <AmbientGlow />
      {/* 未登录态语言切换：开源访客首见英文，登录前即可切换 */}
      <div className="absolute right-4 top-4">
        <LocaleSwitcher />
      </div>
      <Card
        glass="vivid"
        tilt={{ max: 10, scale: 1.02 }}
        className="focus-glow relative w-full max-w-md"
      >
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            {/* 裸 Logo + 形状贴合发光（logo-glow）+ 呼吸脉动 */}
            <Logo className="animate-breathing logo-glow h-14 w-14" />
          </div>
          <CardTitle className="text-glow-cyan text-2xl font-bold">{t('loginTitle')}</CardTitle>
          <CardDescription>{t('loginDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="email">
                {t('email')}
              </label>
              <Input
                id="email"
                type="email"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
                {t('password')}
              </label>
              <Input
                id="password"
                type="password"
                placeholder={t('passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <Button type="submit" className="w-full" isLoading={isLoading}>
              {t('loginButton')}
            </Button>
          </form>

          {/* Skill 入口：未登录用户也可查看 Agent 接入指南 */}
          <div className="mt-4 border-t pt-4 text-center">
            <Link
              href="/skills/agent-chamber"
              className="inline-flex items-center justify-center gap-2 text-sm text-primary hover:underline"
            >
              <BookOpen className="h-4 w-4" />
              {t('viewAgentGuide')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
