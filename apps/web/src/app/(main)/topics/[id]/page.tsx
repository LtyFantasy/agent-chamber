'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { Message, TopicParticipant, Board } from '@/types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { isCreatorOrOwner } from '@/lib/is-resource-owner';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { Avatar } from '@/components/ui/avatar';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { formatRelativeTime } from '@/lib/utils';
// framer-motion：新消息进入动画（仅 opacity+transform，见 docs/ui-design-system.md §5）
import { motion, useReducedMotion } from 'framer-motion';
import { fadeSlideUp } from '@/lib/animations';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MARKDOWN_CHAT_CLASSES } from '@/lib/markdown-classes';
import { CollapsibleMarkdown } from '@/components/topics/collapsible-markdown';
import {
  ArrowLeft,
  Send,
  AlertCircle,
  Pencil,
  Lightbulb,
  Vote,
  CheckSquare,
  FileText,
  Brain,
  Activity,
  Trash2,
  Lock,
  Globe,
  Copy,
  SlidersHorizontal,
  Users,
  Layout,
  FolderKanban,
  Plus,
  X,
  UserPlus,
} from 'lucide-react';

export default function TopicDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const queryClient = useQueryClient();
  const t = useTranslations('topics');
  const tGlobal = useTranslations();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollHeightBeforeRef = useRef<number>(0);
  const prevFetchingNextRef = useRef(false);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const currentUser = useAuthStore((state) => state.user);
  const [messageContent, setMessageContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ type: 'close' | 'archive'; open: boolean }>({
    type: 'close',
    open: false,
  });
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [filterSender, setFilterSender] = useState<{
    senderId: string;
    senderName: string;
    senderAvatar?: string;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedContentId, setCopiedContentId] = useState<string | null>(null);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedTab, setRelatedTab] = useState<'boards' | 'tasks' | 'docs'>('tasks');
  const [linkBoardOpen, setLinkBoardOpen] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  /** 当前选中的待邀请用户 ID */
  const [selectedUserId, setSelectedUserId] = useState('');

  const { data: topic, isLoading: topicLoading } = useQuery({
    queryKey: ['topics', 'detail', id],
    queryFn: () => Api.topics.getById(id),
    enabled: !!id,
  });

  /** 查询所有 Agent 列表，用于邀请选择器 */
  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    // listAll 循环翻页拉全：单页 pageSize:100 在 >100 个 agent 时静默丢数据（评审 M-e）
    queryFn: () => Api.agents.listAll(),
  });

  /** v1.37 owner 代理：我的 agent id 集合（GET /agents 对非 admin 只返回自己拥有的 agents） */
  const myAgentIds = useMemo(() => (agentsData ?? []).map((a) => a.id), [agentsData]);

  /** 查询用户列表，用于邀请人类用户选择器 */
  const { data: usersData } = useQuery({
    queryKey: ['users', 'list'],
    queryFn: () => Api.users.listUsers({ pageSize: 100 }),
  });

  const {
    data: messagesData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: messagesLoading,
  } = useInfiniteQuery({
    queryKey: ['topics', 'messages', id, filterSender?.senderId],
    queryFn: ({ pageParam }) =>
      Api.topics.getMessages(id, {
        limit: 20,
        before: pageParam,
        senderId: filterSender?.senderId,
      }),
    getNextPageParam: (lastPage) => {
      return lastPage.hasMore ? lastPage.nextCursor : undefined;
    },
    initialPageParam: undefined as string | undefined,
    enabled: !!id,
  });

  const { data: unreadData } = useQuery({
    queryKey: ['topics', 'unread', id],
    queryFn: () => Api.topics.getUnread(id),
    enabled: !!id && isAuthenticated,
  });

  const markAsReadMutation = useMutation({
    mutationFn: () => Api.topics.markAsRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'unread', id] });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: (content: string) => Api.topics.sendMessage(id, { content }),
    onSuccess: (rawMessage: Message) => {
      // 乐观更新：将新消息添加到第一页（最新消息页），避免丢失已加载的历史分页
      const optimisticMessage: import('@/types').Message = {
        id: rawMessage.id,
        topicId: rawMessage.topicId,
        senderId: rawMessage.senderId,
        senderType: 'human',
        senderName: currentUser?.name || t('message.senderSelf'),
        senderAvatar: currentUser?.avatar ?? undefined,
        content: rawMessage.content,
        replyTo: (rawMessage as unknown as { replyToId?: string }).replyToId || undefined,
        createdAt: rawMessage.createdAt,
      };

      // 乐观更新：使用与实际 useInfiniteQuery 完全匹配的 queryKey（含 filterSender 参数）
      const messagesQueryKey = ['topics', 'messages', id, filterSender?.senderId];
      queryClient.setQueryData(
        messagesQueryKey,
        (
          old:
            | InfiniteData<{ messages: Message[]; nextCursor: string | null; hasMore: boolean }>
            | undefined,
        ) => {
          if (!old || !old.pages || old.pages.length === 0) return old;
          const newPages = [...old.pages];
          newPages[0] = {
            ...newPages[0],
            messages: [...newPages[0].messages, optimisticMessage],
          };
          return { ...old, pages: newPages };
        },
      );

      void queryClient.invalidateQueries({ queryKey: ['topics', 'messages', id] });
      void queryClient.invalidateQueries({ queryKey: ['topics', 'unread', id] });
      setMessageContent('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      // 新消息发送后滚动到底部
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    },
  });

  const removeMessageMutation = useMutation({
    mutationFn: ({ messageId }: { messageId: string }) => Api.topics.removeMessage(id, messageId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'messages', id] });
    },
  });

  const removeParticipantMutation = useMutation({
    mutationFn: ({ participantId }: { participantId: string }) =>
      Api.topics.removeParticipant(id, participantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  /** 邀请 Agent 加入话题 */
  const inviteAgentMutation = useMutation({
    mutationFn: (agentId: string) => Api.topics.inviteAgent(id, { agentId }),
    onSuccess: (_, agentId) => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      setSelectedAgentIds((prev) => prev.filter((sid) => sid !== agentId));
    },
  });

  /** 取消邀请 Agent */
  const uninviteAgentMutation = useMutation({
    mutationFn: (agentId: string) => Api.topics.uninviteAgent(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  /** 邀请人类用户加入话题 */
  const inviteUserMutation = useMutation({
    mutationFn: (userId: string) => Api.topics.inviteUser(id, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      setSelectedUserId('');
    },
  });

  /** 取消邀请人类用户（从参与者中移除） */
  const uninviteUserMutation = useMutation({
    mutationFn: (userId: string) => Api.topics.uninviteUser(id, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  const openMutation = useMutation({
    mutationFn: () => Api.topics.open(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => Api.topics.pause(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => Api.topics.resume(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  const closeMutation = useMutation({
    mutationFn: () => Api.topics.close(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      setConfirmDialog({ type: 'close', open: false });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => Api.topics.archive(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      setConfirmDialog({ type: 'archive', open: false });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { title: string; description?: string }) => Api.topics.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      void queryClient.invalidateQueries({ queryKey: ['topics', 'list'] });
      setEditOpen(false);
    },
  });

  const { data: allBoardsData } = useQuery({
    queryKey: ['boards', 'list'],
    queryFn: () => Api.boards.list({ pageSize: 100 }),
    enabled: linkBoardOpen,
  });

  /** 绑定本话题的文档空间（关联区 Docs tab 薄入口） */
  const { data: topicSpacesData } = useQuery({
    queryKey: ['docs', 'spaces', 'topic', id],
    queryFn: () => Api.docs.listSpaces({ topicId: id, pageSize: 20 }),
    enabled: !!id && relatedOpen,
  });

  const linkBoardMutation = useMutation({
    mutationFn: (boardId: string) => Api.boards.update(boardId, { topicId: id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      void queryClient.invalidateQueries({ queryKey: ['boards', 'list'] });
      setLinkBoardOpen(false);
      setSelectedBoardId('');
    },
  });

  const unlinkBoardMutation = useMutation({
    mutationFn: (boardId: string) =>
      Api.boards.update(boardId, { topicId: null as unknown as string }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
      void queryClient.invalidateQueries({ queryKey: ['boards', 'list'] });
    },
  });

  // 合并所有分页消息：pages 顺序是 [最新, 更早, 更更早]，reverse 后按时间正序排列
  // 注意：(messagesData?.pages ?? []) 避免 messagesData 为 undefined 时 slice() 报错
  const allMessages = (messagesData?.pages ?? [])
    .slice()
    .reverse()
    .flatMap((p) => p.messages);

  // 从已加载消息中提取唯一发送者列表（用于过滤选择器）
  const senderList = useMemo(() => {
    const map = new Map<
      string,
      { senderId: string; senderName: string; senderAvatar?: string; senderType?: string }
    >();
    allMessages.forEach((msg) => {
      if (!map.has(msg.senderId)) {
        map.set(msg.senderId, {
          senderId: msg.senderId,
          senderName: msg.senderName,
          senderAvatar: msg.senderAvatar,
          senderType: msg.senderType,
        });
      }
    });
    return Array.from(map.values());
  }, [allMessages]);

  // 首次加载完成后滚动到底部（最新消息）
  const isFirstLoadRef = useRef(true);
  useEffect(() => {
    if (isFirstLoadRef.current && !messagesLoading && allMessages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      isFirstLoadRef.current = false;
    }
  }, [messagesLoading, allMessages.length]);

  // 进入动画闸门：首次历史消息渲染完成后才置 true——历史列表不播入场动画，
  // 仅之后新追加（SSE / 发送）挂载的消息播放 fadeSlideUp
  const entryAnimReadyRef = useRef(false);
  useEffect(() => {
    if (!messagesLoading && allMessages.length > 0) {
      entryAnimReadyRef.current = true;
    }
  }, [messagesLoading, allMessages.length]);

  // 尊重 prefers-reduced-motion（动效规范 §5）：减少动效时入场动画直接落终态
  const shouldReduceMotion = useReducedMotion();

  // 加载更多历史消息后，保持滚动位置不变
  useEffect(() => {
    const wasFetching = prevFetchingNextRef.current;
    prevFetchingNextRef.current = isFetchingNextPage;

    if (wasFetching && !isFetchingNextPage && scrollHeightBeforeRef.current > 0) {
      const el = scrollContainerRef.current;
      if (el) {
        const heightDiff = el.scrollHeight - scrollHeightBeforeRef.current;
        if (heightDiff > 0) {
          el.scrollTop = heightDiff;
        }
        scrollHeightBeforeRef.current = 0;
      }
    }
  }, [isFetchingNextPage]);

  // 滚动到顶部时自动加载更多历史消息
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop < 80 && hasNextPage && !isFetchingNextPage) {
        scrollHeightBeforeRef.current = el.scrollHeight;
        void fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  // 消息加载完成后自动标记为已读
  useEffect(() => {
    if (
      !messagesLoading &&
      allMessages.length > 0 &&
      isAuthenticated &&
      !markAsReadMutation.isPending
    ) {
      markAsReadMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesLoading, allMessages.length, isAuthenticated, id]);

  const adjustTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  };

  const handleSend = () => {
    if (!messageContent.trim()) return;
    sendMessageMutation.mutate(messageContent);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const openConfirm = (type: 'close' | 'archive') => {
    setConfirmDialog({ type, open: true });
  };

  const handleConfirm = () => {
    if (confirmDialog.type === 'close') {
      closeMutation.mutate();
    } else {
      archiveMutation.mutate();
    }
  };

  const isConfirmPending =
    confirmDialog.type === 'close' ? closeMutation.isPending : archiveMutation.isPending;

  const openEdit = () => {
    if (topic) {
      setEditTitle(topic.title);
      setEditDesc(topic.description || '');
      setEditOpen(true);
    }
  };

  const handleUpdate = () => {
    if (!editTitle.trim()) return;
    updateMutation.mutate({ title: editTitle, description: editDesc });
  };

  if (topicLoading) {
    return (
      <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  if (!topic) {
    return (
      <div className="flex h-[calc(100vh-8rem)] flex-col items-center justify-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold">{t('notFound')}</h2>
        <Link href="/topics" className="mt-4 text-primary hover:underline">
          {t('backToList')}
        </Link>
      </div>
    );
  }

  const renderStatusActions = () => {
    const status = topic.status;

    if (status === 'archived') {
      return null;
    }

    const buttons: React.ReactNode[] = [];

    if (status === 'draft') {
      buttons.push(
        <Button
          key="open"
          size="sm"
          variant="default"
          onClick={() => openMutation.mutate()}
          isLoading={openMutation.isPending}
        >
          {t('publish')}
        </Button>,
      );
    }

    if (status === 'active') {
      buttons.push(
        <Button
          key="pause"
          size="sm"
          variant="outline"
          onClick={() => pauseMutation.mutate()}
          isLoading={pauseMutation.isPending}
          className="w-full justify-start"
        >
          {t('pause')}
        </Button>,
      );
    }

    if (status === 'paused') {
      buttons.push(
        <Button
          key="resume"
          size="sm"
          variant="outline"
          onClick={() => resumeMutation.mutate()}
          isLoading={resumeMutation.isPending}
          className="w-full justify-start"
        >
          {t('resume')}
        </Button>,
      );
    }

    if (status !== 'closed') {
      buttons.push(
        <Button
          key="close"
          size="sm"
          variant="secondary"
          onClick={() => openConfirm('close')}
          className="w-full justify-start"
        >
          {t('closeTopic')}
        </Button>,
      );
    }

    buttons.push(
      <Button
        key="archive"
        size="sm"
        variant="outline"
        onClick={() => openConfirm('archive')}
        className="w-full justify-start"
      >
        {t('archive')}
      </Button>,
    );

    return <div className="flex flex-col gap-1">{buttons}</div>;
  };

  return (
    <div className="flex h-[calc(100vh-6rem)] md:h-[calc(100vh-8rem)] flex-col">
      {/* Header：玻璃化壳层（允许 backdrop-blur），半透明底让网格纹透出 */}
      <div className="glass mb-3 flex items-center gap-2 md:mb-4 min-w-0 rounded-xl px-3 py-2">
        <Link href="/topics" className="shrink-0">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg md:text-2xl font-bold truncate">{topic.title}</h1>
            {topic.visibility === 'private' && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 text-amber-300 border-amber-500/40 bg-amber-500/10"
              >
                <Lock className="h-3 w-3" /> {t('visibility.private')}
              </Badge>
            )}
            {topic.visibility === 'open' && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
              >
                <Globe className="h-3 w-3" /> {t('visibility.public')}
              </Badge>
            )}
          </div>
          {topic.description && (
            <p className="text-xs md:text-sm text-muted-foreground truncate">{topic.description}</p>
          )}
        </div>
        {/* Participants & Invite button */}
        <button
          onClick={() => setParticipantsOpen(true)}
          className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Users className="h-3.5 w-3.5" />
          {(() => {
            const participants = topic.participants || [];
            const activeCount = participants.filter((p) => p.status === 'active').length;
            const invitedCount =
              participants.filter((p) => p.status === 'invited').length ||
              (topic.invitedAgentIds || []).length;
            const total = activeCount + invitedCount;
            return total > 0 ? t('people', { count: total }) : t('participants');
          })()}
        </button>
        {/* Related boards/tasks button */}
        <button
          onClick={() => setRelatedOpen(true)}
          className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <FolderKanban className="h-3.5 w-3.5" />
          {topic.boardCount !== undefined && topic.taskCount !== undefined
            ? t('boardsAndTasks', { boards: topic.boardCount, tasks: topic.taskCount })
            : t('relatedLabel')}
        </button>
        {/* Filter button */}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setFilterOpen(true)}
          className="shrink-0 relative"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {filterSender && (
            <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-primary" />
          )}
        </Button>
        {/* More actions */}
        <div className="shrink-0 relative group">
          <Button size="sm" variant="ghost">
            <span className="text-lg leading-none">⋮</span>
          </Button>
          {/* 浮层属壳层元素：glass 玻璃化（允许 blur），替代不透明 bg-background */}
          <div className="absolute right-0 top-full mt-1 w-40 rounded-md glass shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
            <div className="p-1">
              {renderStatusActions()}
              <Button size="sm" variant="ghost" onClick={openEdit} className="w-full justify-start">
                <Pencil className="h-4 w-4 mr-2" /> {tGlobal('common.edit')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Participants & Invite Sheet */}
      <Sheet open={participantsOpen} onOpenChange={setParticipantsOpen}>
        <SheetHeader>
          <SheetTitle>{t('participant.title')}</SheetTitle>
          <SheetDescription>
            {(() => {
              const participants = topic.participants || [];
              const activeCount = participants.filter((p) => p.status === 'active').length;
              const invitedCount =
                participants.filter((p) => p.status === 'invited').length ||
                (topic.invitedAgentIds || []).length;
              return t('participant.summary', { count: activeCount, invited: invitedCount });
            })()}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* 活跃参与者 */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium">
              {t('participant.activeList')}
              {(() => {
                const activeParticipants = (topic.participants || []).filter(
                  (p) => p.status === 'active',
                );
                return activeParticipants.length ? ` (${activeParticipants.length})` : '';
              })()}
            </h3>
            {(() => {
              const activeParticipants = (topic.participants || []).filter(
                (p) => p.status === 'active',
              );
              if (activeParticipants.length === 0) {
                return (
                  <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                    {t('participant.noActive')}
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  {activeParticipants.map((p: TopicParticipant) => (
                    <div
                      key={p.participantId}
                      className="flex items-center gap-3 rounded-lg border p-2.5"
                    >
                      <Avatar
                        src={p.avatarUrl ?? undefined}
                        fallback={p.name}
                        size="sm"
                        actorType={p.participantType}
                        seed={p.participantId}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.participantType === 'human'
                            ? t('participant.human')
                            : t('participant.agent')}{' '}
                          · {p.role || t('participant.member')}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {p.role === 'moderator'
                          ? t('participant.moderator')
                          : t('participant.member')}
                      </Badge>
                      {(currentUser?.role === 'admin' ||
                        isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds)) &&
                        p.participantId !== currentUser?.id &&
                        p.participantId !== topic.creatorId && (
                          <button
                            onClick={() =>
                              p.participantType === 'human'
                                ? uninviteUserMutation.mutate(p.participantId)
                                : removeParticipantMutation.mutate({
                                    participantId: p.participantId,
                                  })
                            }
                            disabled={
                              p.participantType === 'human'
                                ? uninviteUserMutation.isPending
                                : removeParticipantMutation.isPending
                            }
                            className="text-xs text-destructive hover:text-destructive/80 disabled:opacity-50"
                          >
                            {t('participant.remove')}
                          </button>
                        )}
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* 已邀请 Agent */}
          {(currentUser?.role === 'admin' ||
            isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds)) && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">
                {t('participant.invitedList')}
                {(() => {
                  const invitedParticipants = (topic.participants || []).filter(
                    (p) => p.status === 'invited',
                  );
                  const count = invitedParticipants.length || (topic.invitedAgentIds || []).length;
                  return count ? ` (${count})` : '';
                })()}
              </h3>
              {(() => {
                // 优先展示 participants 中 status='invited' 的成员
                const invitedParticipants = (topic.participants || []).filter(
                  (p) => p.status === 'invited',
                );
                if (invitedParticipants.length > 0) {
                  return (
                    <div className="space-y-2">
                      {invitedParticipants.map((p: TopicParticipant) => (
                        <div
                          key={p.participantId}
                          className="flex items-center gap-3 rounded-lg border p-2.5"
                        >
                          <Avatar
                            src={p.avatarUrl ?? undefined}
                            fallback={p.name}
                            size="sm"
                            actorType={p.participantType}
                            seed={p.participantId}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{p.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {p.participantType === 'human'
                                ? t('participant.human')
                                : t('participant.agent')}{' '}
                              · {t('participant.invited')}
                            </p>
                          </div>
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            {t('participant.invited')}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            isLoading={
                              uninviteAgentMutation.isPending &&
                              uninviteAgentMutation.variables === p.participantId
                            }
                            onClick={() => uninviteAgentMutation.mutate(p.participantId)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  );
                }

                // 兜底：invitedAgentIds 中尚未出现在 participants 的
                const invitedAgentIds = topic.invitedAgentIds || [];
                const participantIds = new Set(
                  (topic.participants || []).map((p) => p.participantId),
                );
                const missingIds = invitedAgentIds.filter((id) => !participantIds.has(id));
                const invitedAgents = (agentsData ?? []).filter((a) => missingIds.includes(a.id));
                if (invitedAgents.length === 0) {
                  return (
                    <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                      {t('participant.noInvited')}
                    </div>
                  );
                }
                return (
                  <div className="space-y-2">
                    {invitedAgents.map((agent) => (
                      <div
                        key={agent.id}
                        className="flex items-center gap-3 rounded-lg border p-2.5"
                      >
                        <Avatar fallback={agent.name} size="sm" actorType="agent" seed={agent.id} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{agent.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {agent.status === 'active'
                              ? t('participant.agentStatus.active')
                              : agent.status === 'disabled'
                                ? t('participant.agentStatus.disabled')
                                : t('participant.agentStatus.pending')}
                          </p>
                        </div>
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {t('participant.invited')}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          isLoading={
                            uninviteAgentMutation.isPending &&
                            uninviteAgentMutation.variables === agent.id
                          }
                          onClick={() => uninviteAgentMutation.mutate(agent.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* 添加邀请 */}
          {(currentUser?.role === 'admin' ||
            isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds)) && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">{t('participant.addInvite')}</h3>
              {(() => {
                // 排除所有非 left 的参与者（active + invited）
                const involvedAgentIds = new Set(
                  (topic.participants || [])
                    .filter(
                      (p: TopicParticipant) => p.participantType === 'agent' && p.status !== 'left',
                    )
                    .map((p: TopicParticipant) => p.participantId),
                );
                // invitedAgentIds 兜底 —— 排除已在 participants 中的
                (topic.invitedAgentIds || []).forEach((id) => {
                  if (!(topic.participants || []).some((p) => p.participantId === id)) {
                    involvedAgentIds.add(id);
                  }
                });
                const availableAgents = (agentsData ?? []).filter(
                  (a) => a.status === 'active' && !involvedAgentIds.has(a.id),
                );
                if (availableAgents.length === 0) {
                  return (
                    <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                      {t('participant.noAvailableAgents')}
                    </div>
                  );
                }
                return (
                  <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                    {availableAgents.map((agent) => {
                      const checked = selectedAgentIds.includes(agent.id);
                      return (
                        <label
                          key={agent.id}
                          className="flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 hover:bg-muted/50 transition-colors"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0"
                            checked={checked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedAgentIds((prev) => [...prev, agent.id]);
                              } else {
                                setSelectedAgentIds((prev) => prev.filter((id) => id !== agent.id));
                              }
                            }}
                          />
                          <Avatar
                            fallback={agent.name}
                            size="sm"
                            actorType="agent"
                            seed={agent.id}
                          />
                          <span className="flex-1 text-sm truncate">{agent.name}</span>
                        </label>
                      );
                    })}
                  </div>
                );
              })()}

              {selectedAgentIds.length > 0 && (
                <SheetFooter>
                  <Button variant="outline" onClick={() => setSelectedAgentIds([])}>
                    {tGlobal('common.cancel')}
                  </Button>
                  <Button
                    isLoading={inviteAgentMutation.isPending}
                    onClick={() => {
                      selectedAgentIds.forEach((agentId) => {
                        inviteAgentMutation.mutate(agentId);
                      });
                    }}
                  >
                    <UserPlus className="mr-1 h-4 w-4" />
                    {t('participant.inviteAgents', { count: selectedAgentIds.length })}
                  </Button>
                </SheetFooter>
              )}
            </div>
          )}

          {/* 邀请用户（仅 Private Topic） */}
          {topic.visibility === 'private' &&
            (currentUser?.role === 'admin' ||
              isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds)) && (
              <div className="space-y-3">
                <h3 className="text-sm font-medium">{t('participant.inviteUser')}</h3>
                {(() => {
                  const participantUserIds = new Set(
                    (topic.participants || [])
                      .filter((p: TopicParticipant) => p.participantType === 'human')
                      .map((p: TopicParticipant) => p.participantId),
                  );
                  const availableUsers = (usersData?.items ?? []).filter(
                    (u) => !participantUserIds.has(u.id) && u.id !== currentUser?.id,
                  );
                  if (availableUsers.length === 0) {
                    return (
                      <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                        {t('participant.noUsers')}
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-2">
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={selectedUserId}
                        onChange={(e) => setSelectedUserId(e.target.value)}
                      >
                        <option value="">{t('participant.selectUser')}</option>
                        {availableUsers.map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                      </select>
                      {selectedUserId && (
                        <Button
                          isLoading={inviteUserMutation.isPending}
                          onClick={() => inviteUserMutation.mutate(selectedUserId)}
                          className="w-full"
                        >
                          <UserPlus className="mr-1 h-4 w-4" />
                          {t('participant.invite')}
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
        </div>
      </Sheet>

      {/* Filter Sheet */}
      <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
        <SheetHeader>
          <SheetTitle>{t('filter.title')}</SheetTitle>
          <SheetDescription>{t('filter.description')}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          <button
            onClick={() => {
              setFilterSender(null);
              setFilterOpen(false);
            }}
            className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
              !filterSender ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
          >
            <span className="text-sm">{t('filter.all')}</span>
          </button>
          {senderList.map((sender) => (
            <button
              key={sender.senderId}
              onClick={() => {
                setFilterSender(sender);
                setFilterOpen(false);
              }}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                filterSender?.senderId === sender.senderId
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              <Avatar
                src={sender.senderAvatar}
                fallback={sender.senderName}
                size="sm"
                actorType={sender.senderType === 'agent' ? 'agent' : 'human'}
                seed={sender.senderId}
              />
              <span className="text-sm">{sender.senderName}</span>
            </button>
          ))}
        </div>
      </Sheet>

      {/* Related Sheet */}
      <Sheet open={relatedOpen} onOpenChange={setRelatedOpen}>
        <SheetHeader>
          <SheetTitle>{t('related.title')}</SheetTitle>
          <SheetDescription>
            {topic.boardCount !== undefined && topic.taskCount !== undefined
              ? t('related.summary', {
                  boards: topic.boardCount,
                  tasks: topic.taskCount,
                  done: topic.doneTaskCount || 0,
                })
              : t('related.fallback')}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          {/* Tab switcher */}
          <div className="flex gap-1 rounded-lg bg-muted p-1 mb-4">
            <button
              onClick={() => setRelatedTab('tasks')}
              className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${
                relatedTab === 'tasks'
                  ? 'bg-accent shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('related.tasks')}
            </button>
            <button
              onClick={() => setRelatedTab('boards')}
              className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${
                relatedTab === 'boards'
                  ? 'bg-accent shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('related.boards')}
            </button>
            <button
              onClick={() => setRelatedTab('docs')}
              className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${
                relatedTab === 'docs'
                  ? 'bg-accent shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('related.docs')}
            </button>
          </div>

          {relatedTab === 'tasks' ? (
            <div className="space-y-2">
              {topic.tasks && topic.tasks.length > 0 ? (
                topic.tasks.map(
                  (t: { id: string; title: string; status: string; priority: string }) => (
                    <Link
                      key={t.id}
                      href={`/tasks/${t.id}`}
                      className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted transition-colors"
                      onClick={() => setRelatedOpen(false)}
                    >
                      <span
                        className={`h-2 w-2 rounded-full shrink-0 ${
                          t.status === 'done'
                            ? 'bg-green-500'
                            : t.status === 'in_progress'
                              ? 'bg-amber-500'
                              : t.status === 'blocked'
                                ? 'bg-red-500'
                                : 'bg-blue-500'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{t.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {t.status} · {t.priority}
                        </p>
                      </div>
                      <CheckSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                    </Link>
                  ),
                )
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t('related.noTasks')}</p>
                </div>
              )}
            </div>
          ) : relatedTab === 'boards' ? (
            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  setSelectedBoardId('');
                  setLinkBoardOpen(true);
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('related.linkBoard')}
              </Button>
              {topic.boards && topic.boards.length > 0 ? (
                topic.boards.map((b: { id: string; name: string; taskCount?: number }) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted transition-colors group"
                  >
                    <Link
                      href={`/boards/${b.id}`}
                      className="flex items-center gap-3 flex-1 min-w-0"
                      onClick={() => setRelatedOpen(false)}
                    >
                      <Layout className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{b.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('related.xTasks', { count: b.taskCount || 0 })}
                        </p>
                      </div>
                    </Link>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (confirm(t('related.unlinkConfirm', { name: b.name }))) {
                          unlinkBoardMutation.mutate(b.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0 p-1"
                      title={t('related.unlink')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Layout className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t('related.noBoards')}</p>
                </div>
              )}
            </div>
          ) : (
            /* Docs tab：绑定本话题的文档空间薄入口（名称 + docCount + 链接） */
            <div className="space-y-2">
              {(topicSpacesData?.items ?? []).length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t('related.noDocs')}</p>
                </div>
              ) : (
                (topicSpacesData?.items ?? []).map((s) => (
                  <Link
                    key={s.id}
                    href={`/docs/${s.id}`}
                    className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted transition-colors"
                    onClick={() => setRelatedOpen(false)}
                  >
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('related.xDocs', { count: s.docCount ?? 0 })}
                      </p>
                    </div>
                  </Link>
                ))
              )}
            </div>
          )}
        </div>
      </Sheet>

      {/* Link Board Dialog */}
      <Dialog open={linkBoardOpen} onOpenChange={setLinkBoardOpen}>
        <DialogHeader>
          <DialogTitle>{t('linkBoard.title')}</DialogTitle>
          <DialogDescription>{t('linkBoard.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4 max-h-[300px] overflow-y-auto">
          {(() => {
            const linkedIds = new Set(
              (topic.boards || []).map(
                (b: { id: string; name: string; taskCount?: number }) => b.id,
              ),
            );
            const available = (allBoardsData?.items || []).filter(
              (b: Board) => !linkedIds.has(b.id),
            );
            if (available.length === 0) {
              return (
                <div className="text-center py-6 text-muted-foreground">
                  <p className="text-sm">{t('linkBoard.noAvailable')}</p>
                </div>
              );
            }
            return available.map((b: Board) => (
              <label
                key={b.id}
                className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  selectedBoardId === b.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <input
                  type="radio"
                  name="linkBoard"
                  value={b.id}
                  checked={selectedBoardId === b.id}
                  onChange={() => setSelectedBoardId(b.id)}
                  className="h-4 w-4 text-primary"
                />
                <span className="text-sm font-medium">{b.name}</span>
              </label>
            ));
          })()}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setLinkBoardOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button
            onClick={() => {
              if (selectedBoardId) linkBoardMutation.mutate(selectedBoardId);
            }}
            isLoading={linkBoardMutation.isPending}
            disabled={!selectedBoardId}
          >
            {t('linkBoard.confirm')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Messages */}
      <Card className="flex-1 overflow-hidden">
        <CardContent className="flex h-full flex-col p-2 md:p-4">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto space-y-3 md:space-y-4 pr-1 md:pr-2"
          >
            {/* 加载更多历史消息提示 */}
            {isFetchingNextPage && (
              <div className="py-2 text-center text-xs text-muted-foreground">
                {t('message.loadingHistory')}
              </div>
            )}
            {!hasNextPage && allMessages.length > 0 && (
              <div className="py-2 text-center text-xs text-muted-foreground">
                {t('message.noMoreHistory')}
              </div>
            )}

            {messagesLoading ? (
              <Loading />
            ) : allMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                <MessageSquareIcon className="h-12 w-12 mb-2" />
                <p>{t('message.empty')}</p>
              </div>
            ) : (
              allMessages.map((msg) => (
                // 新消息进入动画：初次渲染的历史消息 initial={false} 不播；
                // entryAnimReadyRef 置位后新挂载的消息播 fadeSlideUp（仅 opacity+transform），
                // prefers-reduced-motion 时同样落终态不播
                <motion.div
                  key={msg.id}
                  variants={fadeSlideUp}
                  initial={entryAnimReadyRef.current && !shouldReduceMotion ? 'hidden' : false}
                  animate="show"
                  className={`group flex gap-2 md:gap-3 ${msg.senderType === 'human' ? 'flex-row-reverse' : ''}`}
                >
                  <div className="shrink-0">
                    <Avatar
                      src={msg.senderAvatar}
                      fallback={msg.senderName}
                      size="sm"
                      actorType={msg.senderType === 'agent' ? 'agent' : 'human'}
                      seed={msg.senderId}
                    />
                  </div>
                  <MessageBubble
                    msg={msg}
                    currentUserId={currentUser?.id}
                    onDelete={(messageId) => removeMessageMutation.mutate({ messageId })}
                    isDeleting={removeMessageMutation.isPending}
                    copiedId={copiedId}
                    onCopy={(messageId) => {
                      void navigator.clipboard.writeText(messageId);
                      setCopiedId(messageId);
                      setTimeout(
                        () => setCopiedId((prev) => (prev === messageId ? null : prev)),
                        1500,
                      );
                    }}
                    copiedContentId={copiedContentId}
                    onCopyContent={(messageId, content) => {
                      void navigator.clipboard.writeText(content);
                      setCopiedContentId(messageId);
                      setTimeout(
                        () => setCopiedContentId((prev) => (prev === messageId ? null : prev)),
                        1500,
                      );
                    }}
                  />
                </motion.div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Unread hint */}
          {unreadData && unreadData.unreadCount > 0 && (
            <div className="mt-2 text-xs md:text-sm text-destructive font-medium">
              {t('message.unreadCount', { count: unreadData.unreadCount })}
            </div>
          )}

          {/* Input：玻璃输入框（壳层元素允许 blur）+ focus 青光环；发送按钮走 default 渐变变体 */}
          <div className="mt-2 md:mt-4 flex items-center gap-2 border-t border-border/60 pt-2 md:pt-4">
            <textarea
              ref={textareaRef}
              placeholder={t('message.inputPlaceholder')}
              value={messageContent}
              onChange={(e) => {
                setMessageContent(e.target.value);
                requestAnimationFrame(adjustTextareaHeight);
              }}
              onKeyDown={handleKeyDown}
              disabled={sendMessageMutation.isPending}
              rows={1}
              className="glass flex-1 min-h-[36px] max-h-32 overflow-y-auto resize-none rounded-md px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button
              onClick={handleSend}
              isLoading={sendMessageMutation.isPending}
              disabled={!messageContent.trim()}
              className="shrink-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogHeader>
          <DialogTitle>{t('form.editTitle')}</DialogTitle>
          <DialogDescription>{t('form.editDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.title')}</label>
            <Input
              placeholder={t('form.titlePlaceholder')}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('form.description')}</label>
            <Input
              placeholder={t('form.descPlaceholder')}
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditOpen(false)}>
            {tGlobal('common.cancel')}
          </Button>
          <Button onClick={handleUpdate} isLoading={updateMutation.isPending}>
            {tGlobal('common.save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Confirm Dialog */}
      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
      >
        <DialogHeader>
          <DialogTitle>
            {confirmDialog.type === 'close' ? t('confirmClose') : t('confirmArchive')}
          </DialogTitle>
          <DialogDescription>
            {confirmDialog.type === 'close' ? t('closeWarning') : t('archiveWarning')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setConfirmDialog({ type: 'close', open: false })}
          >
            {tGlobal('common.cancel')}
          </Button>
          <Button
            variant={confirmDialog.type === 'close' ? 'destructive' : 'default'}
            onClick={handleConfirm}
            isLoading={isConfirmPending}
          >
            {tGlobal('common.confirm')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function MessageBubble({
  msg,
  currentUserId,
  onDelete,
  isDeleting,
  copiedId,
  onCopy,
  copiedContentId,
  onCopyContent,
}: {
  msg: import('@/types').Message;
  currentUserId?: string;
  onDelete?: (messageId: string) => void;
  isDeleting?: boolean;
  copiedId?: string | null;
  onCopy?: (messageId: string) => void;
  copiedContentId?: string | null;
  onCopyContent?: (messageId: string, content: string) => void;
}) {
  const t = useTranslations('topics');
  // 8 种消息类型配色体系（docs/ui-design-system.md §6）：
  // status_update 青 / system 红 / artifact 紫 / thinking 灰+呼吸微光 /
  // proposal 绿 / vote 琥珀 / task 靛——全部暗色适配（半透明底 + 亮阶文字）。
  // strong 字段 = markdown 强调同族提亮（2026-08-02 用户拍板）：彩色气泡内
  // **强调** 取同一色相的 100 亮阶（emerald-100 等），不借中性白——纯白不属
  // 任何色相家族，叠加彩色正文会触发同时对比残影（红旁白泛青绿等）；
  // thinking 灰泡是无彩色，不设 strong，沿用默认档近白（黑白同族提亮）。
  const typeConfig: Record<
    string,
    {
      icon: React.ReactNode;
      labelKey: string;
      bg: string;
      text: string;
      border: string;
      /** markdown strong 同族提亮覆盖（&& 提权）；缺省 = 共享默认档近白 */
      strong?: string;
    }
  > = {
    status_update: {
      icon: <Activity className="h-3 w-3" />,
      labelKey: 'topics.messageType.status_update',
      bg: 'bg-primary/10',
      text: 'text-primary',
      border: 'border-primary/25',
      strong: '[&&_strong]:text-cyan-100',
    },
    system: {
      icon: <AlertCircle className="h-3 w-3" />,
      labelKey: 'topics.messageType.system',
      bg: 'bg-destructive/15',
      text: 'text-red-300',
      border: 'border-destructive/25',
      strong: '[&&_strong]:text-red-100',
    },
    artifact: {
      icon: <FileText className="h-3 w-3" />,
      labelKey: 'topics.messageType.artifact',
      bg: 'bg-violet-glow/15',
      text: 'text-violet-300',
      border: 'border-violet-glow/25',
      strong: '[&&_strong]:text-violet-100',
    },
    thinking: {
      icon: <Brain className="h-3 w-3" />,
      labelKey: 'topics.messageType.thinking',
      bg: 'bg-muted/50',
      text: 'text-muted-foreground',
      border: 'border-border/60',
    },
    proposal: {
      icon: <Lightbulb className="h-3 w-3" />,
      labelKey: 'topics.messageType.proposal',
      bg: 'bg-emerald-500/15',
      text: 'text-emerald-300',
      border: 'border-emerald-500/25',
      strong: '[&&_strong]:text-emerald-100',
    },
    vote: {
      icon: <Vote className="h-3 w-3" />,
      labelKey: 'topics.messageType.vote',
      bg: 'bg-amber-500/15',
      text: 'text-amber-300',
      border: 'border-amber-500/25',
      strong: '[&&_strong]:text-amber-100',
    },
    task: {
      icon: <CheckSquare className="h-3 w-3" />,
      labelKey: 'topics.messageType.task',
      bg: 'bg-indigo-500/15',
      text: 'text-indigo-300',
      border: 'border-indigo-500/25',
      strong: '[&&_strong]:text-indigo-100',
    },
  };

  const tGlobal = useTranslations();

  const cfg = msg.type ? typeConfig[msg.type] : null;
  const isUser = msg.senderType === 'human';

  // 气泡底（滚动区重复元素，红线：禁 backdrop-blur，一律半透实色底/工具类）
  let bubbleClass: string;
  if (cfg) {
    bubbleClass = `${cfg.bg} ${cfg.text} border ${cfg.border}`;
  } else if (isUser) {
    // 人类消息靠右：主光色青→紫渐变底 + 微光（克制的点缀发光）
    bubbleClass =
      'bg-gradient-to-br from-primary/25 via-primary/15 to-violet-glow/15 text-foreground border border-primary/30 shadow-glow-sm';
  } else if (msg.senderType === 'system') {
    // 系统消息：警示红但克制（与 system 类型同色系）
    bubbleClass = 'bg-destructive/15 text-red-300 border border-destructive/25';
  } else {
    // Agent chat：半透实色玻璃平替（无 blur）
    bubbleClass = 'glass-flat';
  }

  return (
    <div className={`max-w-[82%] md:max-w-[70%] rounded-lg px-3 py-2 md:px-4 ${bubbleClass}`}>
      <div className="flex items-center gap-1.5 md:gap-2 mb-1 flex-wrap">
        {cfg && (
          // thinking 类型附呼吸微光（animate-breathing 仅 opacity+transform，符合动效红线）
          <span
            className={`inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-background/60 ${msg.type === 'thinking' ? 'animate-breathing' : ''}`}
          >
            {cfg.icon}
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {tGlobal(cfg.labelKey as any)}
          </span>
        )}
        <span className="text-xs font-medium opacity-80 truncate max-w-[120px] md:max-w-none">
          {msg.senderName}
        </span>
        <span className="text-xs opacity-60">{formatRelativeTime(msg.createdAt)}</span>
        <code
          className="text-[10px] opacity-40 font-mono cursor-pointer hover:opacity-70 transition-opacity relative"
          title={t('message.copyId')}
          onClick={(e) => {
            e.stopPropagation();
            onCopy?.(msg.id);
          }}
        >
          {msg.id}
          {copiedId === msg.id && (
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-popover text-popover-foreground border border-border/60 px-1.5 py-0.5 rounded whitespace-nowrap">
              {t('message.copied')}
            </span>
          )}
        </code>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onCopyContent?.(msg.id, msg.content);
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground relative"
          title={t('message.copyContent')}
        >
          <Copy className="h-3 w-3" />
          {copiedContentId === msg.id && (
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-popover text-popover-foreground border border-border/60 px-1.5 py-0.5 rounded whitespace-nowrap">
              {t('message.copied')}
            </span>
          )}
        </button>
        {currentUserId &&
          msg.senderId === currentUserId &&
          msg.senderType === 'human' &&
          onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(t('message.deleteConfirm'))) {
                  onDelete(msg.id);
                }
              }}
              disabled={isDeleting}
              className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive/80 disabled:opacity-30"
              title={t('message.deleteTitle')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
      </div>
      {/* Markdown 暗色适配（共享紧凑版，单一事实源 lib/markdown-classes.ts，
          设计约定见 docs/ui-design-system.md §6.1）：
          - whitespace-pre-wrap 有意保留：聊天换行语义（Enter 发送 / Shift+Enter 换行），
            段落间距由 pre-wrap 保留的换行提供，故聊天版不含 [&_p] margin（叠加会双倍空行）
          - 条件覆盖用 `&&` 双写父选择器提权——与共享类同属性冲突时，胜负由生成
            样式表规则顺序决定（与 className 书写顺序无关），&& 使特异性 2>1 确定性胜出：
            · 彩色类型气泡：strong 同族提亮（cfg.strong，emerald-100/red-100 等，
              见 typeConfig 头注释；thinking 灰泡不设，沿用默认档近白）
            · 无类型 chat（人类/Agent 普通消息）：strong 改青色——中性气泡正文已是
              foreground，共享默认档（白）无区分
            · 无类型 system 发送者：红泡同上同族提亮（red-100）
            · thinking：斜体容器内 strong/em 回归正体（italic 内强调 = roman 排版约定）
            · status_update：整泡 text-primary，链接改近白 + 青下划线方可辨识
          - 外层由 CollapsibleMarkdown 包装（components/topics/collapsible-markdown.tsx）：
            Agent 长消息默认折叠（实测高度阈值，8 种消息类型统一），详见 ui-design-system §6.1 */}
      <CollapsibleMarkdown
        className={`text-sm whitespace-pre-wrap break-words ${MARKDOWN_CHAT_CLASSES}${
          cfg?.strong ? ` ${cfg.strong}` : ''
        }${!cfg && msg.senderType !== 'system' ? ' [&&_strong]:text-primary' : ''}${
          !cfg && msg.senderType === 'system' ? ' [&&_strong]:text-red-100' : ''
        }${msg.type === 'thinking' ? ' italic opacity-80 [&&_strong]:not-italic [&&_em]:not-italic' : ''}${
          msg.type === 'status_update'
            ? ' [&&_a]:text-foreground [&&_a]:decoration-primary [&&_a]:decoration-2'
            : ''
        }`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
      </CollapsibleMarkdown>
    </div>
  );
}

function MessageSquareIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
      />
    </svg>
  );
}
