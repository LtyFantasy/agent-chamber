import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

interface EmptyStateProps {
  title?: string;
  description?: string;
  className?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

function EmptyState({ title, description, className, icon, action }: EmptyStateProps) {
  const t = useTranslations('common');
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      {icon || (
        <svg
          className="h-12 w-12 text-muted-foreground/50 mb-4"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
          />
        </svg>
      )}
      <h3 className="text-lg font-medium text-foreground">{title ?? t('noData')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{description ?? t('emptyList')}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export { EmptyState };
