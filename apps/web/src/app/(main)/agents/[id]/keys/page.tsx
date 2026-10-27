'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { toast } from '@/lib/notify';
import { QueryFeedback } from '@/components/ui/query-feedback';
import { errorMessageOf } from '@/lib/error-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import { formatRelativeTime } from '@/lib/utils';
import { ArrowLeft, Plus, KeyRound, Copy, Check, AlertTriangle } from 'lucide-react';

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}

interface CreateKeyResponse {
  id: string;
  name: string;
  apiKey: string;
  /** 新 key 的实际 scopes（后端白名单字段，2026-10-16 卡 72566c2e）；旧后端无此字段时为 undefined */
  scopes?: string[];
}

export default function AgentKeysPage() {
  const params = useParams();
  const id = params.id as string;
  const t = useTranslations('agents.keys');
  const tRead = useTranslations('common');
  const queryClient = useQueryClient();
  const locale = useLocale();
  const tCommon = useTranslations('common');

  const agentQuery = useQuery({
    queryKey: ['agents', 'detail', id],
    queryFn: () => Api.agents.getById(id),
    enabled: !!id,
  });
  const keysQuery = useQuery({
    queryKey: ['agents', 'keys', id],
    queryFn: () => Api.agents.findKeys(id),
    enabled: !!id,
  });
  const agent = agentQuery.data;
  const keys = keysQuery.data ?? [];
  /** Preserve the existing create/revoke cache updates without coupling the two reads. */
  const setKeys = (update: (previous: ApiKey[]) => ApiKey[]) =>
    queryClient.setQueryData(['agents', 'keys', id], (previous: ApiKey[] | undefined) =>
      update(previous ?? []),
    );

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKeyResult, setNewKeyResult] = useState<CreateKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreateLoading(true);
    setCreateError(null);

    try {
      const result = await Api.agents.createKey(id, { name: newKeyName.trim() });
      setNewKeyResult(result);
      setKeys((prev) => [
        {
          id: result.id,
          name: result.name,
          keyPrefix: result.apiKey.slice(0, 12) + '...',
          createdAt: new Date().toISOString(),
          revokedAt: null,
        },
        ...prev,
      ]);
    } catch (err: unknown) {
      setCreateError(errorMessageOf(err, t('createError')));
    } finally {
      setCreateLoading(false);
    }
  };

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setNewKeyName('');
    setCreateError(null);
    setNewKeyResult(null);
    setCopied(false);
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const handleRevoke = async () => {
    if (!revokeKey) return;
    setRevokeLoading(true);

    try {
      await Api.agents.revokeKey(id, revokeKey.id);
      setKeys((prev) =>
        prev.map((k) =>
          k.id === revokeKey.id ? { ...k, revokedAt: new Date().toISOString() } : k,
        ),
      );
      setRevokeKey(null);
    } catch (err: unknown) {
      toast.error({ title: errorMessageOf(err, t('revokeError')) });
    } finally {
      setRevokeLoading(false);
    }
  };

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);
  const displayKeys = [...activeKeys, ...revokedKeys];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {agentQuery.isError && (
        <QueryFeedback
          compact={agentQuery.data !== undefined}
          message={errorMessageOf(
            agentQuery.error,
            tRead(agentQuery.data !== undefined ? 'refreshFailed' : 'loadFailed'),
          )}
          onRetry={() => void agentQuery.refetch()}
          busy={agentQuery.isFetching}
        />
      )}
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href={`/agents/${id}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t('title', { name: agent?.name || 'Agent' })}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('create')}
        </Button>
      </div>

      {/* Keys List */}
      {keysQuery.isError && keysQuery.data !== undefined && (
        <QueryFeedback
          compact={keysQuery.data !== undefined}
          message={errorMessageOf(
            keysQuery.error,
            tRead(keysQuery.data !== undefined ? 'refreshFailed' : 'loadFailed'),
          )}
          onRetry={() => void keysQuery.refetch()}
          busy={keysQuery.isFetching}
        />
      )}
      {keysQuery.isError && keysQuery.data === undefined ? (
        <QueryFeedback
          compact={keysQuery.data !== undefined}
          message={errorMessageOf(
            keysQuery.error,
            tRead(keysQuery.data !== undefined ? 'refreshFailed' : 'loadFailed'),
          )}
          onRetry={() => void keysQuery.refetch()}
          busy={keysQuery.isFetching}
        />
      ) : keysQuery.isLoading ? (
        <Loading />
      ) : displayKeys.length === 0 ? (
        <EmptyState
          title={t('empty')}
          description={t('emptyDesc')}
          icon={<KeyRound className="h-12 w-12 text-muted-foreground/50" />}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('create')}
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="relative w-full overflow-auto">
              <table className="w-full caption-bottom text-sm">
                <thead className="[&_tr]:border-b">
                  <tr className="border-b transition-colors hover:bg-muted/50">
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.name')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.prefix')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.createdAt')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.status')}
                    </th>
                    <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">
                      {tCommon('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {displayKeys.map((key) => {
                    const isActive = !key.revokedAt;
                    return (
                      <tr key={key.id} className="border-b transition-colors hover:bg-muted/50">
                        <td className="p-4 align-middle">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                              <KeyRound className="h-4 w-4 text-primary" />
                            </div>
                            <div className="font-medium">{key.name}</div>
                          </div>
                        </td>
                        <td className="p-4 align-middle">
                          <code className="rounded bg-muted px-2 py-1 text-xs">
                            {key.keyPrefix}
                          </code>
                        </td>
                        <td className="p-4 align-middle text-muted-foreground">
                          {formatRelativeTime(key.createdAt, locale)}
                        </td>
                        <td className="p-4 align-middle">
                          <Badge variant={isActive ? 'success' : 'secondary'}>
                            {isActive ? t('status.active') : t('status.revoked')}
                          </Badge>
                        </td>
                        <td className="p-4 align-middle">
                          <div className="flex items-center justify-end gap-2">
                            {isActive && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setRevokeKey(key)}
                              >
                                {t('revoke')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create Key Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) handleCloseCreate();
        }}
      >
        {newKeyResult ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('createSuccess')}</DialogTitle>
              <DialogDescription>{t('createSuccessHint')}</DialogDescription>
            </DialogHeader>
            <div className="py-4 space-y-4">
              {/* 警示框：半透明语义色（ui-design-system §2.2），dark-only 后不再写 dark: 变体 */}
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-amber-200">{t('oneTimeWarning')}</p>
                    <p className="text-xs text-amber-300 mt-1">{t('oneTimeWarningDesc')}</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 block rounded bg-muted p-3 text-sm break-all">
                  {newKeyResult.apiKey}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => handleCopy(newKeyResult.apiKey)}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              {/* 实际 scopes（后端白名单字段直读；旧后端无该字段则不渲染） */}
              {newKeyResult.scopes && (
                <p className="text-muted-foreground text-sm" data-testid="new-key-scopes">
                  {t('scopes')}: {newKeyResult.scopes.join(', ') || '—'}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button onClick={handleCloseCreate}>{t('saved')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('createDialogTitle')}</DialogTitle>
              <DialogDescription>{t('createDialogDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('nameLabel')}</label>
                <Input
                  placeholder={t('namePlaceholder')}
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate();
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              {createError && <p className="text-sm text-destructive mr-auto">{createError}</p>}
              <Button variant="outline" onClick={handleCloseCreate}>
                {tCommon('cancel')}
              </Button>
              <Button onClick={handleCreate} isLoading={createLoading}>
                {tCommon('create')}
              </Button>
            </DialogFooter>
          </>
        )}
      </Dialog>

      {/* Revoke Confirm Dialog */}
      <Dialog open={!!revokeKey} onOpenChange={() => setRevokeKey(null)}>
        <DialogHeader>
          <DialogTitle>{t('revokeTitle')}</DialogTitle>
          <DialogDescription>{t('revokeWarning')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRevokeKey(null)}>
            {tCommon('cancel')}
          </Button>
          <Button variant="destructive" onClick={handleRevoke} isLoading={revokeLoading}>
            {t('revoke')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
