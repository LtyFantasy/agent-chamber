'use client';

import { useTranslations } from 'next-intl';
import { Button } from './button';
import { EmptyState } from './empty-state';

/** Presentation only: the caller owns query state, cache availability and retry scope. */
export function QueryFeedback({
  message,
  onRetry,
  busy = false,
  compact = false,
}: {
  /** Already localized, channel-safe explanation from the calling region. */
  message: string;
  /** Retry only the failed query or column owned by the caller. */
  onRetry: () => void;
  /** Disable repeat requests and expose their progress to assistive technology. */
  busy?: boolean;
  /** Keep successful content mounted alongside a non-blocking refresh notice. */
  compact?: boolean;
}) {
  const t = useTranslations('common');
  const retry = (
    <Button variant="outline" size="sm" onClick={onRetry} isLoading={busy} aria-busy={busy}>
      {t('retry')}
    </Button>
  );
  return compact ? (
    <div
      role="status"
      aria-live="polite"
      aria-busy={busy}
      className="my-2 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <p className="min-w-0 flex-1">{message}</p>
      {retry}
    </div>
  ) : (
    <div role="status" aria-live="polite" aria-busy={busy}>
      <EmptyState title={message} description="" action={retry} />
    </div>
  );
}
