'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/stores/auth.store';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loading } from '@/components/ui/loading';
import { AmbientGlow } from '@/components/layout/ambient-glow';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Logo } from '@/components/ui/logo';
import { CheckCircle } from 'lucide-react';

export default function RegisterPage() {
  const router = useRouter();
  const { user, isAuthenticated } = useAuthStore();
  const t = useTranslations('auth');
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');

  // 等待持久化状态恢复，避免未恢复前误判为未登录
  useEffect(() => {
    const init = async () => {
      await useAuthStore.persist.rehydrate();
      setIsReady(true);
    };
    void init();
  }, []);

  // 已登录但非 admin 的用户自动跳转到 dashboard
  useEffect(() => {
    if (isReady && isAuthenticated && user && user.role !== 'admin') {
      router.replace('/dashboard');
    }
  }, [isReady, isAuthenticated, user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (password !== confirmPassword) {
      setError(t('passwordMismatch'));
      return;
    }

    if (password.length < 6) {
      setError(t('passwordMinLength'));
      return;
    }

    setIsLoading(true);
    try {
      await Api.auth.register({ email, password, name });
      setSuccess(true);
      // 清空表单
      setName('');
      setEmail('');
      setPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('registerFailed');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  // 状态恢复前显示加载（不刷 bg-background，透出全局网格纹理）
  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Loading size="lg" />
      </div>
    );
  }

  // 未登录用户：显示仅限管理员提示
  if (!isAuthenticated || !user) {
    return (
      <div className="relative flex min-h-screen items-center justify-center px-4">
        <AmbientGlow />
        {/* 未登录态语言切换：与登录页一致 */}
        <div className="absolute right-4 top-4">
          <LocaleSwitcher />
        </div>
        <Card className="glass relative w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              {/* 裸 Logo + 形状贴合发光（logo-glow）+ 呼吸脉动 */}
              <Logo className="animate-breathing logo-glow h-14 w-14" />
            </div>
            <CardTitle className="text-glow-cyan text-2xl font-bold">
              {t('registerAccountTitle')}
            </CardTitle>
            <CardDescription>{t('registerAdminOnly')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">{t('registerHint')}</p>
            <Button className="w-full" onClick={() => router.push('/login')}>
              {t('goToLogin')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 已登录且是 admin：显示正常注册表单
  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <AmbientGlow />
      <Card className="glass focus-glow relative w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            {/* 裸 Logo + 形状贴合发光（logo-glow）+ 呼吸脉动 */}
            <Logo className="animate-breathing logo-glow h-14 w-14" />
          </div>
          <CardTitle className="text-glow-cyan text-2xl font-bold">{t('registerTitle')}</CardTitle>
          <CardDescription>{t('registerAdminDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {success ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-2 py-4">
                <CheckCircle className="h-12 w-12 text-green-500" />
                <p className="text-lg font-medium">{t('accountCreated')}</p>
                <p className="text-sm text-muted-foreground text-center">
                  {t('accountCreatedHint')}
                </p>
              </div>
              <Button className="w-full" onClick={() => router.push('/users')}>
                {t('viewUsers')}
              </Button>
              <Button variant="outline" className="w-full" onClick={() => setSuccess(false)}>
                {t('continueCreating')}
              </Button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="name">
                    {t('username')}
                  </label>
                  <Input
                    id="name"
                    type="text"
                    placeholder={t('usernamePlaceholder')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
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
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="confirmPassword">
                    {t('confirmPassword')}
                  </label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder={t('passwordPlaceholder')}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
                {error && (
                  <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}
                <Button type="submit" className="w-full" isLoading={isLoading}>
                  {t('registerButton')}
                </Button>
              </form>
              <div className="mt-4 text-center text-sm text-muted-foreground">
                {t('hasAccount')}{' '}
                <Link href="/login" className="text-primary hover:underline">
                  {t('loginNow')}
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
