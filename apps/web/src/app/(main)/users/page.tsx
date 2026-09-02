'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
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
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { UserRole, type AdminUser, type CreateUserRequest, type UpdateUserRequest } from '@/types';

const ROLE_BADGE_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  admin: 'default',
  editor: 'secondary',
};

const ROLE_LABEL_KEY: Record<string, string> = {
  admin: 'users.role.admin',
  editor: 'users.role.editor',
};

const STATUS_BADGE_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
> = {
  active: 'success',
  disabled: 'secondary',
};

const STATUS_LABEL_KEY: Record<string, string> = {
  active: 'users.status.active',
  disabled: 'users.status.disabled',
};

/** 用户头像/占位 */
function UserAvatar({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
      <span className="text-sm font-medium text-primary">{initial}</span>
    </div>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const t = useTranslations('users');
  const locale = useLocale();
  const tCommon = useTranslations('common');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tGlobal = useTranslations() as any;

  // ── Search & Filter ──
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Dialogs ──
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);

  // ── Create Form ──
  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<UserRole>(UserRole.EDITOR);

  // ── Edit Form ──
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>(UserRole.EDITOR);
  const [editStatus, setEditStatus] = useState('active');

  // ── Errors ──
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  // ── Data ──
  const { data, isLoading } = useQuery({
    queryKey: ['users', 'list', { q: searchQuery }],
    queryFn: () =>
      Api.users.list({
        q: searchQuery || undefined,
        pageSize: 100,
      }),
  });

  // Debounce search input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchQuery(searchInput);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchInput]);

  const users = data?.items ?? [];

  // ── Mutations ──
  const createMutation = useMutation({
    mutationFn: (data: CreateUserRequest) => Api.users.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      handleCloseCreate();
    },
    onError: (err: unknown) => {
      setCreateError(
        (err as { response?: { data?: { message?: string } }; message?: string }).response?.data
          ?.message || t('createFailed'),
      );
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUserRequest }) =>
      Api.users.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      handleCloseEdit();
    },
    onError: (err: unknown) => {
      setEditError(
        (err as { response?: { data?: { message?: string } }; message?: string }).response?.data
          ?.message || t('updateFailed'),
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => Api.users.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setDeleteUser(null);
    },
  });

  // ── Handlers ──
  const handleCreate = () => {
    if (!createEmail.trim() || !createName.trim() || !createPassword.trim()) return;
    setCreateError(null);
    createMutation.mutate({
      email: createEmail.trim(),
      name: createName.trim(),
      password: createPassword,
      role: createRole,
    });
  };

  const handleUpdate = () => {
    if (!editUser || !editName.trim()) return;
    setEditError(null);
    updateMutation.mutate({
      id: editUser.id,
      data: { name: editName.trim(), role: editRole, status: editStatus },
    });
  };

  const openEdit = useCallback((user: AdminUser) => {
    setEditUser(user);
    setEditName(user.name);
    setEditRole(user.role as UserRole);
    setEditStatus(user.status);
    setEditError(null);
  }, []);

  const openDelete = useCallback((user: AdminUser) => {
    setDeleteUser(user);
  }, []);

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setCreateEmail('');
    setCreateName('');
    setCreatePassword('');
    setCreateRole(UserRole.EDITOR);
    setCreateError(null);
  };

  const handleCloseEdit = () => {
    setEditUser(null);
    setEditName('');
    setEditRole(UserRole.EDITOR);
    setEditStatus('active');
    setEditError(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t('create')}
        </Button>
      </div>

      {/* Search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t('searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <Loading />
      ) : users.length === 0 ? (
        <EmptyState
          title={t('empty')}
          description={t('emptyDesc')}
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
                      {t('table.user')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.role')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.status')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.lastLogin')}
                    </th>
                    <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">
                      {t('table.createdAt')}
                    </th>
                    <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">
                      {tCommon('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child]:border-0">
                  {users.map((user) => (
                    <tr key={user.id} className="border-b transition-colors hover:bg-muted/50">
                      <td className="p-4 align-middle">
                        <div className="flex items-center gap-3">
                          <UserAvatar name={user.name} />
                          <div>
                            <div className="font-medium">{user.name}</div>
                            <div className="text-xs text-muted-foreground">{user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 align-middle">
                        <Badge variant={ROLE_BADGE_VARIANT[user.role] || 'default'}>
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {tGlobal(ROLE_LABEL_KEY[user.role] as any) || user.role}
                        </Badge>
                      </td>
                      <td className="p-4 align-middle">
                        <Badge variant={STATUS_BADGE_VARIANT[user.status] || 'default'}>
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {tGlobal(STATUS_LABEL_KEY[user.status] as any) || user.status}
                        </Badge>
                      </td>
                      <td className="p-4 align-middle text-muted-foreground">
                        {formatRelativeTime(user.lastLoginAt, locale)}
                      </td>
                      <td className="p-4 align-middle text-muted-foreground">
                        {formatDate(user.createdAt, locale)}
                      </td>
                      <td className="p-4 align-middle">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(user)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => openDelete(user)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) handleCloseCreate();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('form.createTitle')}</DialogTitle>
          <DialogDescription>{t('form.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.email')}</label>
            <Input
              type="email"
              placeholder={t('form.emailPlaceholder')}
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.name')}</label>
            <Input
              placeholder={t('form.namePlaceholder')}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.initialPassword')}</label>
            <Input
              type="password"
              placeholder={t('form.passwordPlaceholder')}
              value={createPassword}
              onChange={(e) => setCreatePassword(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.role')}</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={createRole}
              onChange={(e) => setCreateRole(e.target.value as UserRole)}
            >
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <option value="editor">{tGlobal(ROLE_LABEL_KEY.editor as any)}</option>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <option value="admin">{tGlobal(ROLE_LABEL_KEY.admin as any)}</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          {createError && <p className="text-sm text-destructive mr-auto">{createError}</p>}
          <Button variant="outline" onClick={handleCloseCreate}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleCreate} isLoading={createMutation.isPending}>
            {tCommon('create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editUser} onOpenChange={() => handleCloseEdit()}>
        <DialogHeader>
          <DialogTitle>{t('form.editTitle')}</DialogTitle>
          <DialogDescription>{t('form.editDesc')}</DialogDescription>
        </DialogHeader>
        {editUser && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.name')}</label>
              <Input
                placeholder={t('form.namePlaceholder')}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.role')}</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as UserRole)}
              >
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <option value="editor">{tGlobal(ROLE_LABEL_KEY.editor as any)}</option>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <option value="admin">{tGlobal(ROLE_LABEL_KEY.admin as any)}</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.status')}</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
              >
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <option value="active">{tGlobal(STATUS_LABEL_KEY.active as any)}</option>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <option value="disabled">{tGlobal(STATUS_LABEL_KEY.disabled as any)}</option>
              </select>
            </div>
          </div>
        )}
        <DialogFooter>
          {editError && <p className="text-sm text-destructive mr-auto">{editError}</p>}
          <Button variant="outline" onClick={handleCloseEdit}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleUpdate} isLoading={updateMutation.isPending}>
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteUser} onOpenChange={() => setDeleteUser(null)}>
        <DialogHeader>
          <DialogTitle>{t('delete.title')}</DialogTitle>
          <DialogDescription>
            {t('delete.description', { name: deleteUser?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteUser(null)}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteUser && deleteMutation.mutate(deleteUser.id)}
            isLoading={deleteMutation.isPending}
          >
            {tCommon('delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
