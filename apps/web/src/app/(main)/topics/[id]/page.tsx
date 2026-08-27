'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { Message, Board } from '@/types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Api } from '@/lib/api';
import { isCreatorOrOwner } from '@/lib/is-resource-owner';
import { confirm, toast } from '@/lib/notify';
import { useEventPoll } from '@/lib/use-event-poll';
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
import { Sheet, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
// framer-motion：新消息进入动画（仅 opacity+transform，见 docs/ui-design-system.md §5）
import { motion, useReducedMotion } from 'framer-motion';
import { fadeSlideUp } from '@/lib/animations';
import { MembersSheet } from '@/components/members/members-sheet';
import type { MemberItem, MembersSheetLabels } from '@/components/members/types';
import { MessageBubble } from '@/components/topics/message-bubble';
import { RoundtableMentionHint } from '@/components/topics/roundtable-mention-hint';
import { PermissionRequestCard } from '@/components/topics/permission-request-card';
import { SeatBadges } from '@/components/topics/seat-badges';
import { SeatManagement } from '@/components/topics/seat-management';
import { SeatPresenceBar } from '@/components/topics/seat-presence-bar';
import { TopicComposer } from '@/components/topics/topic-composer';
import {
  ArrowLeft,
  AlertCircle,
  Pencil,
  CheckSquare,
  FileText,
  Lock,
  Globe,
  SlidersHorizontal,
  Users,
  UsersRound,
  Layout,
  FolderKanban,
  Plus,
  X,
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
    senderDeletedAt?: string | null;
  } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedContentId, setCopiedContentId] = useState<string | null>(null);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedTab, setRelatedTab] = useState<'boards' | 'tasks' | 'docs'>('tasks');
  const [linkBoardOpen, setLinkBoardOpen] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');

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

  // 实时刷新兜底：agent 座位等「他人消息」落库后前端无本地触发源（发送/删除/裁决
  // 的 invalidate 只覆盖用户自身操作），只能靠事件轮询感知。仅本 topic 的
  // new_message 事件才失效消息查询——前缀失效（['topics','messages',id]）连带
  // filterSender 变体一起刷新；轮询生命周期由 useEventPoll 内部管理，页面不关心。
  useEventPoll({
    onEvent: (event) => {
      if (event.eventType === 'new_message' && event.topicId === id) {
        void queryClient.invalidateQueries({ queryKey: ['topics', 'messages', id] });
      }
    },
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
      // 输入框高度重置由 TopicComposer 内部监听 value 清空完成（textareaRef 已随组件下沉）

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

  /** 邀请 Agent 加入话题（R2 Promise 契约：页面层 allSettled 循环调用；
      选择集已移交 MembersSheet 内部管理，onSuccess 只负责刷新详情） */
  const inviteAgentMutation = useMutation({
    mutationFn: (agentId: string) => Api.topics.inviteAgent(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  /** 取消邀请 Agent */
  const uninviteAgentMutation = useMutation({
    mutationFn: (agentId: string) => Api.topics.uninviteAgent(id, { agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
    },
  });

  /** 邀请人类用户加入话题（R2 同 inviteAgentMutation：allSettled 循环，无选择集副作用） */
  const inviteUserMutation = useMutation({
    mutationFn: (userId: string) => Api.topics.inviteUser(id, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['topics', 'detail', id] });
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
      {
        senderId: string;
        senderName: string;
        senderAvatar?: string;
        senderType?: string;
        /** 发送者已删除信号（统一批 B）：非空 → 过滤 Sheet 灰化 + title 提示 */
        senderDeletedAt?: string | null;
      }
    >();
    allMessages.forEach((msg) => {
      if (!map.has(msg.senderId)) {
        map.set(msg.senderId, {
          senderId: msg.senderId,
          senderName: msg.senderName,
          senderAvatar: msg.senderAvatar,
          senderType: msg.senderType,
          senderDeletedAt: msg.deletedAt,
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

  /** 圆桌 @ 补全候选源（M2 web 批次）：仅 kind='roundtable' 拉座位，active 座位 label 作为 mentionTargets */
  const isRoundtable = topic?.kind === 'roundtable';
  const { data: seatsData } = useQuery({
    queryKey: ['roundtable', 'seats', id],
    queryFn: () => Api.roundtable.listSeats(id),
    enabled: isRoundtable,
    staleTime: 30_000,
  });
  const mentionTargets = useMemo(() => {
    if (!isRoundtable) return null;
    return (seatsData ?? []).filter((s) => s.status === 'active').map((s) => s.label);
  }, [isRoundtable, seatsData]);

  // ── MembersSheet 数据装配（批次 C1：内联成员 Sheet → 共享组件；页面层负责
  //    DTO → MemberItem 映射与权限 gate，组件纯受控不感知业务）──

  /** 参与者管理权限闸（照抄原内联 Sheet 各 section 的 gate：平台 admin ｜ topic
   *  创建者/owner 代理——体验层闸，后端同样 403） */
  const canManage =
    currentUser?.role === 'admin' ||
    isCreatorOrOwner(topic?.creatorId, currentUser?.id, myAgentIds);

  /** 活跃参与者 → MemberItem（role 归一：非 moderator 一律 member，与旧 Badge 取反一致） */
  const memberItems = useMemo((): MemberItem[] => {
    if (!topic) return [];
    return (topic.participants ?? [])
      .filter((p) => p.status === 'active')
      .map((p) => ({
        actorId: p.participantId,
        name: p.name,
        actorType: p.participantType,
        role: p.role === 'moderator' ? 'moderator' : 'member',
        avatarUrl: p.avatarUrl ?? undefined,
        // 已删除信号透传（统一批 B）：软删 actor 带 deletedAt → member-row 灰化+badge
        deletedAt: p.deletedAt ?? null,
        status: 'active',
        // 自己（移除自己=leave 有专门入口，误点报 400）与 topic 创建者（非 admin 移除
        // 报 403）不渲染移除入口——照抄旧内联 UI 的行级排除（对所有 viewer 含 admin 生效）
        canRemove: p.participantId !== currentUser?.id && p.participantId !== topic.creatorId,
      }));
  }, [topic, currentUser?.id]);

  /** 已邀请 → MemberItem（status=invited，agent 与人类都含；invitedAgentIds 是
   *  同一集合的派生字段（后端 dto 注释明示），旧 invitedAgentIds 兜底分支为死代码，
   *  不重复展开；role='invited' 让副行显示「type · 已邀请」同旧 UI） */
  const invitedItems = useMemo((): MemberItem[] => {
    if (!topic) return [];
    return (topic.participants ?? [])
      .filter((p) => p.status === 'invited')
      .map((p) => ({
        actorId: p.participantId,
        name: p.name,
        actorType: p.participantType,
        role: 'invited',
        avatarUrl: p.avatarUrl ?? undefined,
        // 已删除信号透传（统一批 B）：已邀请区同样降级渲染
        deletedAt: p.deletedAt ?? null,
        status: 'invited',
      }));
  }, [topic]);

  /** 可邀请 agent 候选（照抄旧「添加邀请」checkbox 列表：全量 active agent 排除
   *  已参与者（非 left）+ invitedAgentIds 兜底） */
  const candidateItems = useMemo((): MemberItem[] => {
    if (!topic) return [];
    const involvedAgentIds = new Set(
      (topic.participants ?? [])
        .filter((p) => p.participantType === 'agent' && p.status !== 'left')
        .map((p) => p.participantId),
    );
    (topic.invitedAgentIds ?? []).forEach((id) => {
      if (!(topic.participants ?? []).some((p) => p.participantId === id)) {
        involvedAgentIds.add(id);
      }
    });
    return (agentsData ?? [])
      .filter((a) => a.status === 'active' && !involvedAgentIds.has(a.id))
      .map((a) => ({
        actorId: a.id,
        name: a.name,
        actorType: 'agent',
        role: 'member',
        avatarUrl: a.avatarUrl ?? undefined,
        status: 'active',
      }));
  }, [topic, agentsData]);

  /** 可邀请人类（仅 private topic 传：排除已在 participants 的任何状态人类 +
   *  当前用户；non-private 返回 undefined → 组件不渲染人类区） */
  const humanCandidates = useMemo((): MemberItem[] | undefined => {
    if (!topic || topic.visibility !== 'private') return undefined;
    const participantUserIds = new Set(
      (topic.participants ?? [])
        .filter((p) => p.participantType === 'human')
        .map((p) => p.participantId),
    );
    return (usersData?.items ?? [])
      .filter((u) => !participantUserIds.has(u.id) && u.id !== currentUser?.id)
      .map((u) => ({
        actorId: u.id,
        name: u.name,
        actorType: 'human',
        role: 'member',
        avatarUrl: u.avatar ?? undefined,
        status: 'active',
      }));
  }, [topic, usersData, currentUser]);

  /** participantId → participantType 索引（移除/取消邀请按类型分发端点：agent →
   *  remove-participant / uninvite-agent，human → uninvite-user——uninvite-agent
   *  对非 agent id 会 404（后端校验 agent 存在性），必须按类型路由） */
  const participantTypeById = useMemo(() => {
    const map = new Map<string, 'human' | 'agent'>();
    (topic?.participants ?? []).forEach((p) => map.set(p.participantId, p.participantType));
    return map;
  }, [topic]);

  /** 圆桌兜底座位（bindActorId 不匹配任何活跃参与者——invited agent 预建座 / actor
   *  离桌残留；M3 阶段 3 独立小组展示，管理员仍可移除清理；无此类座位零渲染） */
  const leftSeats = useMemo(() => {
    if (!isRoundtable || !topic) return [];
    const activeParticipantIds = new Set(
      (topic.participants ?? []).filter((p) => p.status === 'active').map((p) => p.participantId),
    );
    return (seatsData ?? []).filter(
      (s) => s.config?.bindActorId && !activeParticipantIds.has(s.config.bindActorId),
    );
  }, [isRoundtable, topic, seatsData]);

  const handleSend = () => {
    if (!messageContent.trim()) return;
    sendMessageMutation.mutate(messageContent);
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
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] items-center justify-center">
        <Loading size="lg" />
      </div>
    );
  }

  if (!topic) {
    return (
      <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col items-center justify-center">
        <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold">{t('notFound')}</h2>
        <Link href="/topics" className="mt-4 text-primary hover:underline">
          {t('backToList')}
        </Link>
      </div>
    );
  }

  // ── MembersSheet 差异化文案与回调（R2 邀请 Promise 契约 + 按类型分发）──

  /** 差异化文案：复用页面现有 topics.participant.* key（invited 角色映射保持
   *  旧已邀请区「type · 已邀请」副行文案） */
  const memberLabels: MembersSheetLabels = {
    title: t('participant.title'),
    roleLabels: {
      moderator: t('participant.moderator'),
      member: t('participant.member'),
      invited: t('participant.invited'),
    },
    typeLabels: {
      human: t('participant.human'),
      agent: t('participant.agent'),
    },
  };

  /** R2 邀请提交（Promise 契约）：mutateAsync 循环 + allSettled——全成功 resolve
   *  （组件切回主视图并清空选择）；任一失败 reject（组件留在邀请视图保留选择）+
   *  失败汇总 toast（成功 N / 失败 M） */
  const handleInvite = async (actorIds: string[], kind: 'agent' | 'human') => {
    const mutation = kind === 'agent' ? inviteAgentMutation : inviteUserMutation;
    const results = await Promise.allSettled(
      actorIds.map((actorId) => mutation.mutateAsync(actorId)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed > 0) {
      toast.error({
        title: t('participant.inviteFailed', { succeeded, failed }),
      });
      throw new Error(`invite ${kind} partial failure: ${failed}/${results.length}`);
    }
  };

  /** 移除活跃成员（组件 AlertDialog 确认后回调）：按类型分发端点与旧 UI 一致——
   *  agent → removeParticipant；human → uninviteUser */
  const handleRemoveMember = (actorId: string) => {
    if (participantTypeById.get(actorId) === 'human') {
      uninviteUserMutation.mutate(actorId);
    } else {
      removeParticipantMutation.mutate({ participantId: actorId });
    }
  };

  /** 取消邀请（X）：agent → uninviteAgent；human → uninviteUser（防御性分发——
   *  当前后端 invite-user 直落 active，invited 区理论只含 agent；按类型路由避免
   *  误用 uninvite-agent 对用户 id 触发 AGENT_NOT_FOUND 404） */
  const handleCancelInvite = (actorId: string) => {
    if (participantTypeById.get(actorId) === 'human') {
      uninviteUserMutation.mutate(actorId);
    } else {
      uninviteAgentMutation.mutate(actorId);
    }
  };

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
    <div className="flex h-[calc(100vh-5rem)] md:h-[calc(100vh-3rem)] flex-col">
      {/* Header：玻璃化壳层（允许 backdrop-blur），半透明底让网格纹透出。
          relative z-20：.glass 的 backdrop-filter 会创建 stacking context，header 内
          ⋮ 下拉（z-50 被困其中）需整层抬到 SeatPresenceBar（z-10）之上才不遮盖；
          仍低于 navbar z-30 / 移动侧栏遮罩 z-40 / dialog z-50，全局层级秩序不破 */}
      <div className="glass relative z-20 mb-3 flex items-center gap-2 md:mb-4 min-w-0 rounded-xl px-3 py-2">
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
            {/* 圆桌标识 badge（v1.49.0，与列表页卡片同款紫色系） */}
            {topic.kind === 'roundtable' && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 text-violet-300 border-violet-500/40 bg-violet-500/10"
              >
                <UsersRound className="h-3 w-3" /> {t('kind.roundtable')}
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

      {/* 圆桌座位实时态顶部常驻条（M4b-1）：glass header 下方，仅 kind='roundtable'
          渲染——chip 实时相位（presence 5s 轮询经 useSeatPresence hook）+ 近况浮层 +
          取消发言按钮（busy + 治理权限）；空态零渲染；canManage 与参与者管理同规：
          平台 admin ｜ topic 创建者/owner 代理（后端同样 403，前端是体验层闸） */}
      <SeatPresenceBar
        topicId={id}
        enabled={isRoundtable}
        participants={topic.participants}
        canManage={
          currentUser?.role === 'admin' ||
          isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds)
        }
      />

      {/* 参与者与邀请（批次 C1：内联成员 Sheet → 共享 MembersSheet——信息架构
          主视图 + 邀请二级视图；圆桌扩展经 topSlot（SeatManagement + 圆桌兜底座位组）
          / renderRowExtra（agent 行 SeatBadges）保留；权限 gate 照抄旧各 section；
          已邀请区仅管理视角可见——canManage 为假时不传 invited prop，组件即不渲染整区） */}
      <MembersSheet
        open={participantsOpen}
        onOpenChange={setParticipantsOpen}
        labels={memberLabels}
        members={memberItems}
        invited={canManage ? invitedItems : undefined}
        candidates={candidateItems}
        humanCandidates={humanCandidates}
        capabilities={{ invite: canManage, remove: canManage, cancelInvite: canManage }}
        onInvite={handleInvite}
        onRemove={handleRemoveMember}
        onCancelInvite={handleCancelInvite}
        inviting={inviteAgentMutation.isPending || inviteUserMutation.isPending}
        topSlot={
          isRoundtable && (
            <div className="space-y-3">
              {/* 圆桌座位管理分区（v1.49.0，C2）：runner 在线状态 + 建座入口；
                  canManage 与参与者管理同规（平台 admin ｜ topic 创建者/owner 代理） */}
              <SeatManagement
                topicId={id}
                canManage={canManage}
                onExitGuide={() => setParticipantsOpen(false)}
              />
              {/* 圆桌座位兜底组（M3 阶段 3 改版）：bindActorId 不匹配任何活跃
                  参与者的座位（罕见：actor 已离桌/被移除，座位残留；invited agent
                  预建座也在内）——独立小组展示，管理员仍可移除清理；无此类座位
                  零渲染。随 C1 接入迁入 topSlot（组件无列表区底部槽位），位置由
                  原成员列表底部改为 Sheet 顶部 */}
              {leftSeats.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    {t('seatManager.leftGroup')}
                  </h4>
                  <SeatBadges
                    topicId={id}
                    seats={leftSeats}
                    canManage={canManage}
                    onExitGuide={() => setParticipantsOpen(false)}
                  />
                </div>
              )}
            </div>
          )
        }
        renderRowExtra={(seat) =>
          isRoundtable && seat.actorType === 'agent' ? (
            <SeatBadges
              topicId={id}
              seats={(seatsData ?? []).filter((s) => s.config?.bindActorId === seat.actorId)}
              canManage={canManage}
              onExitGuide={() => setParticipantsOpen(false)}
            />
          ) : null
        }
      />

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
          {senderList.map((sender) => {
            // 已删除降级（统一批 B）：灰化 + title 提示，不加常驻 badge（高密度列表防噪音）
            const senderDeleted = !!sender.senderDeletedAt;
            return (
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
                <span
                  className={senderDeleted ? 'text-sm opacity-60' : 'text-sm'}
                  title={senderDeleted ? t('message.deletedSenderTitle') : undefined}
                >
                  {sender.senderName}
                </span>
              </button>
            );
          })}
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
              {/*
                关联/解绑看板提交结构字段 topicId（PATCH /boards）——v1.46 D6 起非 creator
                （含 owner 代理）提交整体 403，故入口只对 topic 创建者级显示（与后端收口一致）
              */}
              {isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds) && (
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
              )}
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
                    {isCreatorOrOwner(topic.creatorId, currentUser?.id, myAgentIds) && (
                      <button
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // 解除看板关联（v1.48.1 收尾：全局确认弹框替代 window.confirm）
                          if (
                            await confirm({
                              title: t('related.unlinkConfirm', { name: b.name }),
                              confirmText: tGlobal('common.confirm'),
                              cancelText: tGlobal('common.cancel'),
                              confirmVariant: 'danger',
                            })
                          ) {
                            unlinkBoardMutation.mutate(b.id);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0 p-1"
                        title={t('related.unlink')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
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

      {/* 圆桌审批裁决卡片（M3 阶段 2）：仅 kind='roundtable' 启用——pending 列表 +
          裁决按钮组，30s 轮询与全局角标同节奏；空态零渲染；enabled 短路保证
          普通 topic 不请求审批 API、不渲染卡片；participants 供行内头像查找
          （seatId → bindActorId，照 SeatPresenceBar 同源数据） */}
      <PermissionRequestCard
        topicId={id}
        seats={seatsData}
        enabled={isRoundtable}
        participants={topic.participants}
      />

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
                  className={`group flex gap-2 md:gap-3 ${msg.senderType === 'human' ? 'flex-row-reverse' : ''} ${
                    msg.senderType === 'system' ? 'w-full justify-center' : ''
                  }`}
                >
                  {msg.senderType !== 'system' && (
                    // 已删除降级（统一批 B）：头像 hover 提示（senderName 灰化在气泡内）
                    <div className="shrink-0">
                      <Avatar
                        src={msg.senderAvatar}
                        fallback={msg.senderName}
                        size="sm"
                        actorType={msg.senderType === 'agent' ? 'agent' : 'human'}
                        seed={msg.senderId}
                        title={msg.deletedAt ? t('message.deletedSenderTitle') : undefined}
                      />
                    </div>
                  )}
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

          {/* 输入区：TopicComposer（含 @ 补全 + backdrop 高亮，仅圆桌 mentionTargets 启用；
              普通 topic 退化 = 原 textarea 行为）。发送按钮并入组件，玻璃输入框样式不变 */}
          <TopicComposer
            value={messageContent}
            onChange={setMessageContent}
            onSend={handleSend}
            disabled={sendMessageMutation.isPending}
            isSending={sendMessageMutation.isPending}
            placeholder={t('message.inputPlaceholder')}
            mentionTargets={mentionTargets}
          />
          {/* 圆桌 mention 模式提示（M2 阶段 6）：仅 kind=roundtable && wakePolicy=mention
              时渲染——提醒「未 @ 不唤醒」（roundtable-design §6），文案走 i18n */}
          <RoundtableMentionHint kind={topic?.kind} wakePolicy={topic?.wakePolicy} />
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
