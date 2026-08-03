'use client';

import { useAuthStore } from '@/stores/auth.store';
import { UserRole } from '@/types';
import { useTranslations } from 'next-intl';
import { Loading } from '@/components/ui/loading';
import { AdminDashboard } from './dashboard/admin-dashboard';
import { EditorDashboard } from './dashboard/editor-dashboard';

export default function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const isLoading = useAuthStore((state) => state.isLoading);
  const t = useTranslations('dashboard');

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loading />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-[50vh] items-center justify-center text-muted-foreground">
        {t('loginRequired')}
      </div>
    );
  }

  if (user.role === UserRole.ADMIN) {
    return <AdminDashboard />;
  }

  return <EditorDashboard />;
}
