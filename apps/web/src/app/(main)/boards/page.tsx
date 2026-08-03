'use client';

import { useState } from 'react';
import { Visibility } from '@agent-chamber/shared';
import type { Board } from '@agent-chamber/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Plus,
  KanbanSquare,
  CheckSquare,
  ArrowRight,
  Pencil,
  Trash2,
  Lock,
  Globe,
  Users,
} from 'lucide-react';

export default function BoardsPage() {
  const queryClient = useQueryClient();
  const t = useTranslations('boards');
  const tGlobal = useTranslations();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newVisibility, setNewVisibility] = useState<Visibility>(Visibility.OPEN);

  const [editBoard, setEditBoard] = useState<{
    id: string;
    name: string;
    description?: string;
    visibility?: Visibility;
  } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['boards', 'list'],
    queryFn: () => Api.boards.list({ pageSize: 100 }),
  });

  const createMutation = useMutation({
    mutationFn: Api.boards.create,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
      setCreateOpen(false);
      setNewName('');
      setNewDesc('');
      setNewVisibility(Visibility.PRIVATE);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { name: string; description?: string; visibility?: Visibility };
    }) => Api.boards.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
      setEditBoard(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => Api.boards.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['boards'] });
      setDeleteId(null);
    },
  });

  const boards = data?.items ?? [];

  const handleCreate = () => {
    if (!newName.trim()) return;
    createMutation.mutate({ name: newName, description: newDesc, visibility: newVisibility });
  };

  const handleUpdate = () => {
    if (!editBoard || !editBoard.name.trim()) return;
    updateMutation.mutate({
      id: editBoard.id,
      data: {
        name: editBoard.name,
        description: editBoard.description,
        visibility: editBoard.visibility,
      },
    });
  };

  const openEdit = async (board: Board) => {
    // 列表项只有 descriptionSnippet（截断值），编辑表单需完整描述，
    // 通过详情接口拉取避免数据截断风险（spec.md §7.4a）
    const detail = await Api.boards.getById(board.id);
    setEditBoard({
      id: board.id,
      name: board.name,
      description: detail.description ?? undefined,
      visibility: board.visibility,
    });
  };

  return (
    <div className="space-y-6">
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

      {isLoading ? (
        <Loading />
      ) : boards.length === 0 ? (
        <EmptyState
          title={t('noBoards')}
          description={t('noBoardsDesc')}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t('create')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {boards.map((board) => (
            <Link key={board.id} href={`/boards/${board.id}`}>
              {/* 工作区克制：hoverGlow 青光描边微光（同 Batch 4 任务卡手法）+ tilt 3D 悬停倾斜（默认 max 6°） */}
              <Card hoverGlow tilt className="h-full cursor-pointer">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-lg flex items-center">
                      {board.name}
                      {board.visibility === 'private' && (
                        <Lock className="ml-2 h-4 w-4 text-amber-500" />
                      )}
                      {board.visibility === 'open' && (
                        <Globe className="ml-2 h-4 w-4 text-emerald-500" />
                      )}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void openEdit(board);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeleteId(board.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                        <KanbanSquare className="h-4 w-4 text-primary" />
                      </div>
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {board.descriptionSnippet || t('noDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <CheckSquare className="h-4 w-4" />
                      {t('taskProgress', {
                        completed: board.completedTaskCount ?? 0,
                        total: board.taskCount ?? 0,
                      })}
                    </span>
                    {board.memberCount != null && (
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {board.memberCount}
                      </span>
                    )}
                  </div>
                  <div className="mt-4 flex items-center text-sm text-primary">
                    {t('viewBoard')} <ArrowRight className="ml-1 h-4 w-4" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogHeader>
          <DialogTitle>{t('form.createTitle')}</DialogTitle>
          <DialogDescription>{t('form.createDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.name')}</label>
            <Input
              placeholder={t('form.namePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.description')}</label>
            <Input
              placeholder={t('form.descPlaceholder')}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.visibility')}</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="board-visibility"
                  value="open"
                  checked={newVisibility === Visibility.OPEN}
                  onChange={() => setNewVisibility(Visibility.OPEN)}
                />
                <Globe className="h-4 w-4 text-emerald-500" />
                <span className="text-sm">{t('visibility.publicDesc')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="board-visibility"
                  value="private"
                  checked={newVisibility === Visibility.PRIVATE}
                  onChange={() => setNewVisibility(Visibility.PRIVATE)}
                />
                <Lock className="h-4 w-4 text-amber-500" />
                <span className="text-sm">{t('visibility.privateDesc')}</span>
              </label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleCreate} isLoading={createMutation.isPending}>
            {tGlobal('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editBoard} onOpenChange={() => setEditBoard(null)}>
        <DialogHeader>
          <DialogTitle>{t('form.editTitle')}</DialogTitle>
          <DialogDescription>{t('form.editDesc')}</DialogDescription>
        </DialogHeader>
        {editBoard && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.name')}</label>
              <Input
                placeholder={t('form.namePlaceholder')}
                value={editBoard.name}
                onChange={(e) => setEditBoard({ ...editBoard, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.description')}</label>
              <Input
                placeholder={t('form.descPlaceholder')}
                value={editBoard.description || ''}
                onChange={(e) => setEditBoard({ ...editBoard, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('form.visibility')}</label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="edit-board-visibility"
                    value="open"
                    checked={editBoard.visibility === Visibility.OPEN}
                    onChange={() => setEditBoard({ ...editBoard, visibility: Visibility.OPEN })}
                  />
                  <Globe className="h-4 w-4 text-emerald-500" />
                  <span className="text-sm">{t('visibility.public')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="edit-board-visibility"
                    value="private"
                    checked={editBoard.visibility === Visibility.PRIVATE}
                    onChange={() => setEditBoard({ ...editBoard, visibility: Visibility.PRIVATE })}
                  />
                  <Lock className="h-4 w-4 text-amber-500" />
                  <span className="text-sm">{t('visibility.private')}</span>
                </label>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditBoard(null)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleUpdate} isLoading={updateMutation.isPending}>
            {tGlobal('common.save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>{t('delete.confirmTitle')}</DialogTitle>
          <DialogDescription>{t('delete.confirmDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteId(null)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            isLoading={deleteMutation.isPending}
          >
            {tGlobal('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
