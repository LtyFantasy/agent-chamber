'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { buildLoginRedirect } from '@/lib/login-redirect';
import { Loading } from '@/components/ui/loading';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, accessToken } = useAuthStore();
  const [isReady, setIsReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // 先恢复持久化数据，再判断登录状态
    const init = async () => {
      await useAuthStore.persist.rehydrate();
      setIsReady(true);
    };
    void init();
  }, []);

  useEffect(() => {
    if (isReady && !isAuthenticated && !accessToken) {
      // 带上当前地址（含 hash，与消费侧放行的 #anchor 对称）：深链如通知里的
      // /tasks/xxx#comment-2 登录后可回跳（与 api.ts 401 分支同款构造）
      const { pathname, search, hash } = window.location;
      router.push(buildLoginRedirect(pathname, search, hash));
    }
  }, [isReady, isAuthenticated, accessToken, router]);

  if (!isReady || (!isAuthenticated && !accessToken)) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  return <>{children}</>;
}
