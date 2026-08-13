'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
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

interface AgentDetail {
  id: string;
  name: string;
}

interface CreateKeyResponse {
  id: string;
  name: string;
  apiKey: string;
}

export default function AgentKeysPage() {
  const params = useParams();
  const id = params.id as string;
  const t = useTranslations('agents.keys');
  const tCommon = useTranslations('common');

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newKeyResult, setNewKeyResult] = useState<CreateKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  useEffect(() => {
    if (!id) return;

    setIsLoading(true);
    setError(null);

    Promise.all([Api.agents.getById(id).catch(() => null), Api.agents.findKeys(id).catch(() => [])])
      .then(([agentData, keysData]) => {
        setAgent(agentData);
        setKeys(keysData ?? []);
      })
      .catch((err) => {
        setError(err?.response?.data?.message || t('loadError'));
      })
      .finally(() => {
        setIsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
      setCreateError(
        (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data
          ?.message || t('createError'),
      );
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
      alert(
        (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data
          ?.message || t('revokeError'),
      );
    } finally {
      setRevokeLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col items-center justify-center">
        <h2 className="text-xl font-semibold">{t('loadError')}</h2>
        <p className="text-muted-foreground mt-2">{error}</p>
        <Link href="/agents" className="mt-4 text-primary hover:underline">
          {t('backToList')}
        </Link>
      </div>
    );
  }

  const activeKeys = keys.filter((k) => !k.revokedAt);
  const revokedKeys = keys.filter((k) => k.revokedAt);
  const displayKeys = [...activeKeys, ...revokedKeys];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
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
      {displayKeys.length === 0 ? (
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
                          {formatRelativeTime(key.createdAt)}
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
