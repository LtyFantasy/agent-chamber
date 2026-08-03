'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
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
      router.push('/login');
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
