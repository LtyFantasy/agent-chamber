'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { NotificationHost } from '@/components/ui/notification-host';

/**
 * 全局 Providers。
 * 主题已收敛为 dark-only（layout.tsx 服务端硬编码 <html class="dark">），
 * 原 ThemeProvider（mode 判断 + mounted hack）已随 theme.store.ts 一并移除，
 * 此处只保留 React Query + 全局通知宿主（NotificationHost：AlertDialog/Toaster
 * 的唯一挂载点，命令式 confirm/toast 经 store 回流到这里渲染）。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: 2,
            retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
          },
          mutations: {
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <NotificationHost />
      {children}
    </QueryClientProvider>
  );
}
