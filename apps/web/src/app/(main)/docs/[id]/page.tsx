'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Visibility, extractLastHeadingSegment } from '@agent-chamber/shared';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  BookOpen,
  Check,
  CheckCircle,
  Copy,
  FilePlus,
  FileText,
  Link2,
  Pencil,
  Search,
  Lock,
  Globe,
  Settings,
  Users,
  Settings2,
  Plus,
  Trash2,
  Upload,
  X,
  FolderTree,
  ListTree,
} from 'lucide-react';
import { Api } from '@/lib/api';
import { dedupeOutlineSections } from '@/lib/outline-sections';
import { isCreatorOrOwner } from '@/lib/is-resource-owner';
import { formatDate } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loading } from '@/components/ui/loading';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Sheet, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import type { DocSummary, DocSearchHit } from '@/types';
import { MARKDOWN_CLASSES } from '@/lib/markdown-classes';
import { DocEditor } from '@/components/docs/doc-editor';
import { BatchUploadDialog } from '@/components/docs/batch-upload-dialog';
import { isExternalHref, resolveDocPath, PLATFORM_DOC_LINK_RE } from '@/components/docs/doc-link';
import { confirm, toast } from '@/lib/notify';

/**
 * mutation 错误统一提示（范式照抄 task-detail-panel.tsx addDependencyMutation）：
 * 优先透传服务端 error.response.data.message（4xx 业务原因），兜底 axios message / 领域文案。
 */
const alertMutationError = (fallback: string) => (err: unknown) => {
  const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
  alert(axiosErr?.response?.data?.message || axiosErr?.message || fallback);
};

/** 左栏文档项：title + type badge，选中态青光描边 */
function DocTreeItem({
  docItem,
  active,
  onSelect,
}: {
  docItem: DocSummary;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
      }`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
      <span className="flex-1 truncate text-xs">{docItem.title}</span>
      {docItem.docType && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {docItem.docType}
        </span>
      )}
    </button>
  );
}

/**
 * 去除标题中的行内代码记号，匹配 React Markdown 的 textContent。
 *
 * React Markdown 渲染后 textContent 不包含反引号，但 headingPath 保留原始 Markdown。
 */
function normalizeHeadingText(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1').trim();
}

/** 滚动到正文内指定标题（headingPath 末段由 shared helper 提取） */
function scrollToHeading(container: HTMLElement | null, headingPath: string | null | undefined) {
  if (!container || !headingPath) return;
  const lastSegment = extractLastHeadingSegment(headingPath);
  if (!lastSegment) return;
  const normalizedLastSegment = normalizeHeadingText(lastSegment);
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const el of Array.from(headings)) {
    if (normalizeHeadingText(el.textContent ?? '') === normalizedLastSegment) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
}

export default function DocSpaceDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const spaceId = params.id as string;
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('docs');
  const tGlobal = useTranslations();
  const user = useAuthStore((state) => state.user);

  // ── 本地状态 ────────────────────────────────────
  /** 选中文档由 ?doc= 驱动（刷新/分享链接可直达；切换经 selectDoc 同步 URL） */
  const selectedDocId = searchParams.get('doc');
  /** 左栏搜索词（非空时展示 search 命中列替代分类树） */
  const [searchQuery, setSearchQuery] = useState('');
  /** 防抖后的搜索词：输入停顿 300ms 才同步，避免每个字符都发一次 search 请求（B1） */
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  /** type / tag 过滤器（原生 select 先例） */
  const [typeFilter, setTypeFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  /** 折叠的分类 id 集合 */
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const [membersSheetOpen, setMembersSheetOpen] = useState(false);
  const [rightSheetOpen, setRightSheetOpen] = useState(false);
  /** 左栏折叠 Sheet（xl 以下，v1.47.0-dev 移动端优化）：搜索/过滤/分类树收进抽屉 */
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  /** 编辑态：null = 浏览模式，{ mode:'edit' } = 编辑已有文档，{ mode:'create' } = 新建文档 */
  const [editing, setEditing] = useState<{ mode: 'edit' | 'create' } | null>(null);
  const [spaceSettingsOpen, setSpaceSettingsOpen] = useState(false);
  const [batchUploadOpen, setBatchUploadOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  /** 断链条目复制反馈（1.5s 后复位） */
  const [copiedHref, setCopiedHref] = useState<string | null>(null);
  /** 空间设置表单（binding：'none' | 'topic:<id>' | 'board:<id>' 编码） */
  const [spaceForm, setSpaceForm] = useState({
    name: '',
    description: '',
    visibility: Visibility.OPEN,
    binding: 'none',
  });
  /** 待滚动定位的标题路径（搜索命中直达 section 用） */
  const pendingHeadingRef = useRef<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** 空间图例对话框开关（v1.43.1-dev）：图例改为头部按钮触发只读弹窗，不再内联占用首屏三栏区 */
  const [legendOpen, setLegendOpen] = useState(false);

  // ── 查询 ────────────────────────────────────────
  const { data: space, isLoading: spaceLoading } = useQuery({
    queryKey: ['docs', 'space', spaceId],
    queryFn: () => Api.docs.getSpace(spaceId),
    enabled: !!spaceId,
  });

  /** 空间设置的绑定选项（仅在对话框打开时拉取） */
  const { data: bindingBoards } = useQuery({
    queryKey: ['boards', 'binding-options'],
    queryFn: () => Api.boards.list({ pageSize: 100 }),
    enabled: spaceSettingsOpen,
  });
  const { data: bindingTopics } = useQuery({
    queryKey: ['topics', 'binding-options'],
    queryFn: () => Api.topics.list({ pageSize: 100 }),
    enabled: spaceSettingsOpen,
  });

  /** 文档列表（左栏分类树；搜索态不用它） */
  const { data: docsData } = useQuery({
    queryKey: ['docs', 'docs', spaceId, typeFilter, tagFilter],
    // listAllDocs 循环翻页拉全：单页 pageSize:100 在 >100 篇文档的空间静默丢尾部（对齐 agents.listAll 评审 M-e）
    queryFn: () =>
      Api.docs.listAllDocs(spaceId, {
        type: typeFilter || undefined,
        tag: tagFilter || undefined,
      }),
    enabled: !!spaceId,
  });

  /** 过滤候选专用全量列表（不带 type/tag——否则选中过滤后下拉只剩被筛文档的标签，反直觉） */
  const { data: facetDocsData } = useQuery({
    queryKey: ['docs', 'doc-facets', spaceId],
    queryFn: () => Api.docs.listAllDocs(spaceId),
    enabled: !!spaceId,
  });

  /** 搜索防抖 effect：300ms 停顿后同步 debounced 值；卸载时清理 timer，避免旧输入晚到 */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  /** 搜索命中（左栏搜索框，防抖后 q 非空才发） */
  const { data: searchHits } = useQuery({
    queryKey: ['docs', 'search', spaceId, debouncedSearchQuery],
    queryFn: () => Api.docs.search(spaceId, { q: debouncedSearchQuery, limit: 20 }),
    enabled: !!spaceId && debouncedSearchQuery.trim().length > 0,
  });

  /** 选中文档元数据 + 大纲 */
  const { data: doc, isError: docIsError } = useQuery({
    queryKey: ['docs', 'doc', selectedDocId],
    queryFn: () => Api.docs.getDoc(selectedDocId!),
    enabled: !!selectedDocId,
  });

  /** Web 全文通道（中栏渲染） */
  const {
    data: docContent,
    isLoading: contentLoading,
    isError: contentIsError,
    refetch: refetchContent,
  } = useQuery({
    queryKey: ['docs', 'doc-content', selectedDocId],
    queryFn: () => Api.docs.getDocContent(selectedDocId!),
    enabled: !!selectedDocId,
  });

  /** 编辑器专用完整原文（full=true 含首标题行，回写安全；仅进入编辑态才拉取） */
  const {
    data: docFullContent,
    isError: fullContentIsError,
    refetch: refetchFullContent,
  } = useQuery({
    queryKey: ['docs', 'doc-content-full', selectedDocId],
    queryFn: () => Api.docs.getDocContent(selectedDocId!, true),
    enabled: !!selectedDocId && editing?.mode === 'edit',
  });

  /**
   * Agent 列表（成员管理邀请用 + v1.37 owner 代理判定共用）：
   * 始终拉取（去掉 membersSheetOpen 懒加载限制）——queryKey 与 topics/boards 页共享缓存，
   * 非 admin 只返回自己拥有的 agents，即「我的 agent id 集合」
   */
  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    // listAll 循环翻页拉全：单页 pageSize:100 在 >100 个 agent 时静默丢数据（评审 M-e）
    queryFn: () => Api.agents.listAll(),
  });
  /** v1.37 owner 代理：我的 agent id 集合（creatorId ∈ 此集合 → 视同我创建） */
  const myAgentIds = useMemo(() => (agentsData ?? []).map((a) => a.id), [agentsData]);

  // ── 派生数据 ────────────────────────────────────
  /** useMemo 包裹避免 ?? [] 每次渲染产生新数组、污染下游 memo 依赖（listAllDocs 直接返回数组） */
  const docs = useMemo<DocSummary[]>(() => docsData ?? [], [docsData]);
  const categories = space?.categories ?? [];
  const members = space?.members ?? [];

  /** 管理权：admin | creator（含 owner 代理：creatorId ∈ 我的 agent id） | editor 成员（人类 actorId === user.id） */
  const canManage =
    !!user &&
    (user.role === 'admin' ||
      isCreatorOrOwner(space?.creatorId, user.id, myAgentIds) ||
      members.some((m) => m.actorId === user.id && m.role === 'editor'));

  /**
   * 所有权（v1.45 DOCSPACE-PERM 拆权）：admin | creator（含 owner 代理）。
   * 与 canManage 的区别：canManage 含 editor（内容策展），isOwnerLike 是
   * 后端 creator-only 操作（结构字段 visibility/绑定、邀请、creator 转让）的前端闸门——
   * editor 看到这些 UI 后端必 403（修 invite 403 mismatch）。
   */
  const isOwnerLike =
    !!user && (user.role === 'admin' || isCreatorOrOwner(space?.creatorId, user.id, myAgentIds));

  /** type / tag 候选（从「未过滤」全量列表聚合，开放字符串无硬编码枚举；listAllDocs 直接返回数组） */
  const facetDocs = useMemo<DocSummary[]>(() => facetDocsData ?? [], [facetDocsData]);
  const typeOptions = useMemo(
    () =>
      Array.from(new Set(facetDocs.map((d) => d.docType).filter((v): v is string => !!v))).sort(),
    [facetDocs],
  );
  const tagOptions = useMemo(
    () => Array.from(new Set(facetDocs.flatMap((d) => d.tags ?? []))).sort(),
    [facetDocs],
  );

  /**
   * 正文链接渲染器（path 写法 → docId 跳转的关键接线）：
   * - 外部 http/mailto → 新标签打开
   * - 平台规范链接 /docs/<spaceId>?doc=<docId> → SPA 导航（消掉整页刷新）
   * - 相对 .md path → resolveDocPath 命中后 SPA 跳 /docs/<spaceId>?doc=<id>；未命中按断链样式渲染（琥珀虚线，呼应右栏 linkHealth 警告）
   * - 纯 #锚点 / 非 .md 相对路径 → 默认渲染不干预
   * 解析映射用「未过滤」的 facetDocs，避免左栏 type/tag 过滤激活时误判断链。
   * facetDocs 经 listAllDocs 循环翻页拉全（对齐 agents.listAll 评审 M-e）：>100 篇的空间
   * 不再截断，断链判定与后端 linkHealth 全量集合对齐。
   * 跨文档 #锚点不做滚动定位：markdown 锚点 slug 与 headingPath 文本匹配规则不同构，落地不可靠。
   */
  const docPathToId = useMemo(() => new Map(facetDocs.map((d) => [d.path, d.id])), [facetDocs]);
  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        if (isExternalHref(href)) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        if (PLATFORM_DOC_LINK_RE.test(href)) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                router.push(href, { scroll: false });
              }}
            >
              {children}
            </a>
          );
        }
        const targetId = resolveDocPath(href, docPathToId);
        if (targetId) {
          const url = `/docs/${spaceId}?doc=${targetId}`;
          return (
            <a
              href={url}
              onClick={(e) => {
                e.preventDefault();
                router.push(url, { scroll: false });
              }}
            >
              {children}
            </a>
          );
        }
        if (targetId === null) {
          return (
            <span className="text-amber-500 underline decoration-dashed" title={href}>
              {children}
            </span>
          );
        }
        return <a href={href}>{children}</a>;
      },
    }),
    [docPathToId, router, spaceId],
  );

  /** 分类树：category → docs；未分类单列 */
  const docsByCategory = useMemo(() => {
    const map = new Map<string, DocSummary[]>();
    const uncategorized: DocSummary[] = [];
    for (const d of docs) {
      if (!d.categoryId) {
        uncategorized.push(d);
        continue;
      }
      const list = map.get(d.categoryId) ?? [];
      list.push(d);
      map.set(d.categoryId, list);
    }
    return { map, uncategorized };
  }, [docs]);

  /** 断链展示名：从正文 markdown 提取 href → 链接文本（空文本回退 href，仅首个出现生效） */
  const linkTextMap = useMemo(() => {
    const map = new Map<string, string>();
    const content = docContent?.content ?? '';
    const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const href = m[2].trim();
      if (!map.has(href)) map.set(href, m[1].trim());
    }
    return map;
  }, [docContent]);

  /** 全文加载完成后执行待定的标题滚动（搜索命中直达 section） */
  useEffect(() => {
    if (docContent && pendingHeadingRef.current) {
      scrollToHeading(contentRef.current, pendingHeadingRef.current);
      pendingHeadingRef.current = null;
    }
  }, [docContent]);

  /**
   * 切换选中文档并同步 ?doc= 到 URL（replace 不污染历史；刷新/分享可直达同一文档）。
   * docId 为 null 时清除参数（回到「请选择文档」态）。
   */
  const selectDoc = (docId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (docId) params.set('doc', docId);
    else params.delete('doc');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // ── Mutations ────────────────────────────────────
  const invalidateSpace = () => {
    void queryClient.invalidateQueries({ queryKey: ['docs', 'space', spaceId] });
    void queryClient.invalidateQueries({ queryKey: ['docs', 'docs', spaceId] });
    void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces'] });
  };

  const inviteMutation = useMutation({
    mutationFn: (agentId: string) => Api.docs.inviteAgent(spaceId, agentId),
    onSuccess: invalidateSpace,
    onError: alertMutationError(t('members.actionFailed')),
  });
  const uninviteMutation = useMutation({
    mutationFn: (actorId: string) => Api.docs.uninviteAgent(spaceId, actorId),
    onSuccess: invalidateSpace,
    onError: alertMutationError(t('members.actionFailed')),
  });
  const addEditorMutation = useMutation({
    mutationFn: (agentId: string) => Api.docs.addEditor(spaceId, agentId),
    onSuccess: invalidateSpace,
    onError: alertMutationError(t('members.actionFailed')),
  });
  const removeEditorMutation = useMutation({
    mutationFn: (actorId: string) => Api.docs.removeEditor(spaceId, actorId),
    onSuccess: invalidateSpace,
    onError: alertMutationError(t('members.actionFailed')),
  });
  // v1.45 DOCSPACE-PERM：creator 转让（creator-only，后端 409/404/403 语义由后端保证）
  const transferCreatorMutation = useMutation({
    mutationFn: (newCreatorId: string) => Api.docs.transferCreator(spaceId, newCreatorId),
    onSuccess: () => {
      invalidateSpace();
      toast.success({ title: t('members.transferSuccess') });
    },
    onError: alertMutationError(t('members.transferFailed')),
  });

  /**
   * 转让 creator 危险操作闸门（R5）：
   * confirm 文案明示「原创建者将失去全部权限（含 PRIVATE 空间读权限）」不可逆；
   * 确认后走 transferCreatorMutation（成功即 invalidateSpace 重拉成员/creator）。
   */
  const handleTransferCreator = async (actorId: string, actorName: string) => {
    const ok = await confirm({
      title: t('members.transferTitle'),
      description: t('members.transferConfirm', { name: actorName }),
      confirmText: t('members.transferConfirmButton'),
      cancelText: tGlobal('common.cancel'),
      confirmVariant: 'danger',
    });
    if (!ok) return;
    transferCreatorMutation.mutate(actorId);
  };
  const createCategoryMutation = useMutation({
    mutationFn: (name: string) => Api.docs.createCategory(spaceId, { name }),
    onSuccess: () => {
      invalidateSpace();
      setNewCategoryName('');
    },
    onError: alertMutationError(t('categories.actionFailed')),
  });
  const renameCategoryMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      Api.docs.updateCategory(id, { name }),
    onSuccess: invalidateSpace,
    onError: alertMutationError(t('categories.actionFailed')),
  });
  const deleteCategoryMutation = useMutation({
    mutationFn: (id: string) => Api.docs.deleteCategory(id),
    onSuccess: invalidateSpace,
    onError: alertMutationError(t('categories.actionFailed')),
  });
  const updateSpaceMutation = useMutation({
    mutationFn: (data: {
      name?: string;
      description?: string | null;
      visibility?: Visibility;
      topicId?: string | null;
      boardId?: string | null;
    }) => Api.docs.updateSpace(spaceId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'space', spaceId] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces'] });
      setSpaceSettingsOpen(false);
    },
    onError: alertMutationError(t('spaceSettings.saveError')),
  });

  /** 文档 upsert mutation：仅发 { path, content }，后端 upsert 未传字段全部 ?? existing 兜底 */
  const upsertMutation = useMutation({
    mutationFn: (input: { path: string; content: string }) => Api.docs.upsertDoc(spaceId, input),
    onSuccess: (result) => {
      if (result.unchanged === true) {
        alert(t('editor.unchanged'));
        return; // 内容无变化不退出编辑态
      }
      alert(t('editor.saveSuccess'));
      void queryClient.invalidateQueries({ queryKey: ['docs', 'doc', selectedDocId] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'doc-content', selectedDocId] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'doc-content-full', selectedDocId] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'docs', spaceId] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'doc-facets', spaceId] });
      if (editing?.mode === 'create') {
        selectDoc(result.id);
      }
      setEditing(null);
    },
    onError: (err: unknown) => {
      // 透传服务端 message（如 409 DOC_SOURCE_MISMATCH 原因），兜底通用文案
      const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
      alert(axiosErr?.response?.data?.message || axiosErr?.message || t('editor.saveError'));
    },
  });

  /**
   * R1 脏状态守卫：所有退出/切换编辑态的路径统一先过此函数。
   * 取消按钮（DocEditor 内）/ 左栏切文档 / 返回列表 / 搜索命中跳转 / 新建文档——
   * 脏状态时弹全局 confirm（danger 红钮），确认才允许继续（返回 true）。
   */
  const confirmDiscardEditing = async () =>
    !editing ||
    (await confirm({
      title: t('editor.discardTitle'),
      description: t('editor.discardConfirm'),
      confirmText: tGlobal('common.confirm'),
      cancelText: tGlobal('common.cancel'),
      confirmVariant: 'danger',
    }));

  /** 左栏选文档：编辑态时先确认脏状态（切文档前尝试退出编辑器） */
  const handleDocSelect = async (docId: string) => {
    if (!(await confirmDiscardEditing())) return;
    setEditing(null);
    selectDoc(docId);
  };

  /** 选中搜索命中：编辑态先确认，切文档并排队滚动 */
  const handleHitSelect = async (hit: DocSearchHit) => {
    if (!(await confirmDiscardEditing())) return;
    setEditing(null);
    pendingHeadingRef.current = hit.headingPath ?? null;
    selectDoc(hit.docId);
    setSearchQuery('');
  };

  /** 可邀请 Agent：active 且尚未是成员 */
  const memberActorIds = new Set(members.map((m) => m.actorId));
  const availableAgents = (agentsData ?? []).filter(
    (a) => a.status === 'active' && !memberActorIds.has(a.id),
  );

  if (spaceLoading) {
    return <Loading />;
  }

  if (!space) {
    return (
      <EmptyState
        title={tGlobal('common.noData')}
        action={
          <Link href="/docs">
            <Button variant="outline">{t('detail.backToList')}</Button>
          </Link>
        }
      />
    );
  }

  /** 左栏内容（搜索 + 类型/标签过滤 + 分类树；xl 常驻列与折叠 Sheet 共用，v1.47.0-dev 移动端折叠） */
  const sidebarContent = (
    <>
      <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('detail.searchPlaceholder')}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} title={t('detail.clearSearch')}>
            <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <select
          className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">{t('detail.allTypes')}</option>
          {typeOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
        >
          <option value="">{t('detail.allTags')}</option>
          {tagOptions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {searchQuery.trim() ? (
          /* 搜索命中列：点击直达文档 + section 滚动 */
          <div className="space-y-1">
            <p className="px-1 py-0.5 text-xs text-muted-foreground">{t('detail.searchHits')}</p>
            {(searchHits ?? []).length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                {t('detail.noSearchResults')}
              </p>
            ) : (
              (searchHits ?? []).map((hit, idx) => (
                <button
                  key={`${hit.docId}-${hit.position}-${idx}`}
                  onClick={() => handleHitSelect(hit)}
                  className="block w-full rounded-md border border-border/40 px-2 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <span className="block truncate text-xs font-medium">{hit.docTitle}</span>
                  {hit.headingPath && (
                    <span className="block truncate text-[11px] text-primary/80">
                      {hit.headingPath}
                    </span>
                  )}
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {hit.snippet}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : docs.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            {t('detail.noDocs')}
          </p>
        ) : (
          /* 分类树：可折叠分类 + 未分类区 */
          <div className="space-y-2">
            {categories.map((cat) => {
              const catDocs = docsByCategory.map.get(cat.id) ?? [];
              if (catDocs.length === 0) return null;
              const collapsed = collapsedCats.has(cat.id);
              return (
                <div key={cat.id}>
                  <button
                    onClick={() =>
                      setCollapsedCats((prev) => {
                        const next = new Set(prev);
                        if (next.has(cat.id)) next.delete(cat.id);
                        else next.add(cat.id);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <FolderTree className="h-3.5 w-3.5 text-primary/70" />
                    <span className="flex-1 truncate text-left">{cat.name}</span>
                    <span className="text-[10px]">{catDocs.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="ml-2 space-y-0.5 border-l border-border/40 pl-2">
                      {catDocs.map((d) => (
                        <DocTreeItem
                          key={d.id}
                          docItem={d}
                          active={d.id === selectedDocId}
                          onSelect={() => handleDocSelect(d.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {docsByCategory.uncategorized.length > 0 && (
              <div>
                <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                  {t('detail.uncategorized')}
                </p>
                <div className="space-y-0.5">
                  {docsByCategory.uncategorized.map((d) => (
                    <DocTreeItem
                      key={d.id}
                      docItem={d}
                      active={d.id === selectedDocId}
                      onSelect={() => handleDocSelect(d.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );

  /** 大纲/元数据右栏内容（xl 常驻列与折叠 Sheet 共用） */
  const rightPanel = (
    <>
      {/* Section 大纲导航 */}
      <div className="rounded-lg border border-border/50 p-3">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          <ListTree className="h-4 w-4 text-primary" />
          {t('doc.outline')}
        </h3>
        {!doc?.sections || doc.sections.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('doc.noOutline')}</p>
        ) : (
          <nav className="space-y-0.5">
            {/* 超长 section 的续 chunk 共用同一 headingPath/headingLevel，渲染前折叠
                （bug 1a6b57d0），否则同一标题在大纲重复 N 条 */}
            {dedupeOutlineSections(doc.sections).map((section) => (
              <button
                key={section.position}
                onClick={() => scrollToHeading(contentRef.current, section.headingPath)}
                className="block w-full truncate rounded px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                style={{ paddingLeft: `${6 + section.headingLevel * 10}px` }}
                title={section.headingPath ?? undefined}
              >
                {/* 目录只显示末段标题（面包屑全路径留在 tooltip），否则每项都被父级标题刷屏 */}
                {section.headingPath
                  ? extractLastHeadingSegment(section.headingPath) || t('doc.noOutline')
                  : t('doc.noOutline')}
              </button>
            ))}
          </nav>
        )}
      </div>

      {/* 链接健康卡 */}
      {doc && (
        <div className="rounded-lg border border-border/50 p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Link2 className="h-4 w-4 text-primary" />
            {t('linkHealth.title')}
          </h3>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            {doc.linkHealth ? (
              <>
                {doc.linkHealth.broken.length === 0 ? (
                  <div className="flex items-center gap-1.5 text-emerald-500">
                    <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      {doc.linkHealth.total === 0
                        ? t('linkHealth.noLinks')
                        : t('linkHealth.allReachable', { total: doc.linkHealth.total })}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 text-amber-500">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        {t('linkHealth.brokenLinks', {
                          count: doc.linkHealth.broken.length,
                        })}
                      </span>
                    </div>
                    <ul className="space-y-1">
                      {doc.linkHealth.broken.map((href, i) => {
                        const copied = copiedHref === href;
                        return (
                          <li key={i}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-1 truncate rounded bg-muted/40 px-1.5 py-0.5 text-[11px] transition-colors hover:bg-muted"
                              title={href}
                              onClick={() => {
                                void navigator.clipboard.writeText(href);
                                setCopiedHref(href);
                                setTimeout(
                                  () => setCopiedHref((cur) => (cur === href ? null : cur)),
                                  1500,
                                );
                              }}
                            >
                              {copied ? (
                                <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                              ) : (
                                <Copy className="h-3 w-3 shrink-0 opacity-60" />
                              )}
                              <span className="truncate">
                                {copied ? t('linkHealth.copied') : linkTextMap.get(href) || href}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                <p className="text-[11px] opacity-60">
                  {t('linkHealth.checkedAt', { time: formatDate(doc.linkHealth.checkedAt) })}
                </p>
              </>
            ) : (
              <p>{t('linkHealth.notChecked')}</p>
            )}
          </div>
        </div>
      )}

      {/* 元数据卡 */}
      {doc && (
        <div className="rounded-lg border border-border/50 p-3 text-xs">
          <h3 className="mb-2 text-sm font-medium">{t('doc.metadata')}</h3>
          <div className="space-y-1.5 text-muted-foreground">
            <div className="flex justify-between gap-2">
              <span>{t('doc.path')}</span>
              <span className="truncate font-mono text-foreground" title={doc.path}>
                {doc.path}
              </span>
            </div>
            {doc.docType && (
              <div className="flex justify-between gap-2">
                <span>{t('doc.type')}</span>
                <span className="text-foreground">{doc.docType}</span>
              </div>
            )}
            <div className="flex justify-between gap-2">
              <span>{t('doc.source')}</span>
              <span className="text-foreground">{doc.source ?? 'native'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('doc.sectionCount', { count: doc.sectionCount ?? 0 })}</span>
              <span>{t('doc.tokenEstimate', { count: doc.tokenEstimate ?? 0 })}</span>
            </div>
            {doc.updatedAt && (
              <div className="flex justify-between gap-2">
                <span>{t('doc.updatedAt')}</span>
                <span className="text-foreground">{formatDate(doc.updatedAt)}</span>
              </div>
            )}
            {doc.tags && doc.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {doc.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      {/* 头部：返回 + 空间名 + 可见性 + 设置入口 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          {/* 返回：onClick 直接挂 Button，避免 button 套 button 的 hydration 报错 */}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="shrink-0"
            onClick={async () => {
              if (!(await confirmDiscardEditing())) return;
              router.push('/docs');
            }}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="flex min-w-0 items-center truncate text-xl font-bold sm:text-2xl">
            <span className="truncate">{space.name}</span>
            {space.visibility === 'private' ? (
              <Lock className="ml-2 h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <Globe className="ml-2 h-4 w-4 shrink-0 text-emerald-500" />
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {/* 左栏折叠入口（v1.47.0-dev 移动端优化）：xl 以下左栏收进抽屉，正文不再被挤压 */}
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              className="xl:hidden"
              onClick={() => setSidebarSheetOpen(true)}
            >
              <FolderTree className="mr-1 h-4 w-4" />
              {t('detail.browse')}
            </Button>
          )}
          {/* xl 以下右栏折叠入口（编辑态禁用，R2） */}
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              className="xl:hidden"
              onClick={() => setRightSheetOpen(true)}
            >
              <ListTree className="mr-1 h-4 w-4" />
              {t('doc.outline')}
            </Button>
          )}
          {/* 空间图例入口（v1.43.1-dev）：仅在有图例内容时显示，点击打开只读弹窗 */}
          {space.description && (
            <Button variant="outline" size="sm" onClick={() => setLegendOpen(true)}>
              <BookOpen className="mr-1 h-4 w-4" />
              {t('detail.legend')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setMembersSheetOpen(true)}>
            <Users className="mr-1 h-4 w-4" />
            {t('members.title')}
          </Button>
          {canManage && (
            <Button variant="outline" size="sm" onClick={() => setCategoriesOpen(true)}>
              <Settings2 className="mr-1 h-4 w-4" />
              {t('categories.manage')}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSpaceForm({
                  name: space.name ?? '',
                  description: space.description ?? '',
                  visibility: space.visibility === 'private' ? Visibility.PRIVATE : Visibility.OPEN,
                  binding: space.boardId
                    ? `board:${space.boardId}`
                    : space.topicId
                      ? `topic:${space.topicId}`
                      : 'none',
                });
                setSpaceSettingsOpen(true);
              }}
            >
              <Settings className="mr-1 h-4 w-4" />
              {t('spaceSettings.title')}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!(await confirmDiscardEditing())) return;
                setEditing({ mode: 'create' });
              }}
            >
              <FilePlus className="mr-1 h-4 w-4" />
              {t('editor.newDoc')}
            </Button>
          )}
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={!!editing}
              title={editing ? t('upload.disabledEditing') : undefined}
              onClick={() => setBatchUploadOpen(true)}
            >
              <Upload className="mr-1 h-4 w-4" />
              {t('upload.button')}
            </Button>
          )}
        </div>
      </div>
      {/* 三栏主体 */}
      <div className="flex gap-4" style={{ height: 'calc(100vh - 9rem)' }}>
        {/* 左栏：搜索 + 过滤 + 分类树/搜索命中（xl 常驻；xl 以下收进折叠 Sheet，v1.47.0-dev 移动端优化） */}
        <aside className="hidden w-64 shrink-0 flex-col gap-2 overflow-hidden xl:flex">
          {sidebarContent}
        </aside>
        {/* 中栏：文档正文或编辑器 */}
        <main className="min-w-0 flex-1 overflow-y-auto rounded-lg border border-border/40 p-4">
          {editing ? (
            // 编辑模式必须等 full 原文就绪——去重版 docContent 回写会丢首标题行（P0 数据损坏）
            editing.mode === 'edit' && fullContentIsError ? (
              /* full 原文拉取失败：错误态 + 重试/退出编辑，不再永久 Loading 困住用户 */
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  title={t('editor.contentLoadError')}
                  description={t('editor.contentLoadErrorDesc')}
                  action={
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => void refetchFullContent()}>
                        {tGlobal('common.retry')}
                      </Button>
                      <Button variant="outline" onClick={() => setEditing(null)}>
                        {t('editor.exitEdit')}
                      </Button>
                    </div>
                  }
                />
              </div>
            ) : editing.mode === 'edit' && !docFullContent ? (
              <Loading />
            ) : (
              <DocEditor
                mode={editing.mode}
                spaceId={spaceId}
                initialContent={editing.mode === 'edit' ? (docFullContent?.content ?? '') : ''}
                initialPath={editing.mode === 'edit' ? (doc?.path ?? '') : undefined}
                existingPaths={facetDocs.map((d) => d.path)}
                boardId={space?.boardId ?? undefined}
                saving={upsertMutation.isPending}
                onSave={(input) => upsertMutation.mutate(input)}
                onCancel={() => setEditing(null)}
              />
            )
          ) : !selectedDocId ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('detail.selectDoc')}
            </div>
          ) : contentLoading ? (
            <Loading />
          ) : docIsError ? (
            /* 坏链直达 / 文档已删：友好空态 + 返回选择，不再裸 404 空白 */
            <div className="flex h-full items-center justify-center">
              <EmptyState
                title={t('detail.docNotFound')}
                action={
                  <Button variant="outline" onClick={() => selectDoc(null)}>
                    {t('detail.backToDocs')}
                  </Button>
                }
              />
            </div>
          ) : contentIsError ? (
            /* 正文查询失败：错误态 + 重试/返回，不再静默吞错渲染空正文 */
            <div className="flex h-full items-center justify-center">
              <EmptyState
                title={t('detail.contentLoadError')}
                description={t('detail.contentLoadErrorDesc')}
                action={
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => void refetchContent()}>
                      {tGlobal('common.retry')}
                    </Button>
                    <Button variant="outline" onClick={() => selectDoc(null)}>
                      {t('detail.backToDocs')}
                    </Button>
                  </div>
                }
              />
            </div>
          ) : (
            <div ref={contentRef}>
              {/* 标题区：title / summary / tags / 来源 badge + 编辑按钮 */}
              <header className="mb-4 border-b border-border/50 pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-2xl font-bold">{doc?.title ?? docContent?.title}</h2>
                    {doc?.summary && (
                      <p className="mt-1 text-sm text-muted-foreground">{doc.summary}</p>
                    )}
                  </div>
                  {canManage && doc?.source === 'native' && !contentLoading && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setEditing({ mode: 'edit' })}
                    >
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      {t('editor.edit')}
                    </Button>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {doc?.source && doc.source !== 'native' && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 bg-amber-500/10 text-amber-300"
                    >
                      <Lock className="mr-1 h-3 w-3" />
                      {t('doc.readOnlyMirror')}
                    </Badge>
                  )}
                  {doc?.docType && <Badge variant="secondary">{doc.docType}</Badge>}
                  {doc?.tags?.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => {
                        setTagFilter(tag);
                        setSearchQuery('');
                      }}
                      title={t('detail.filterByTag', { tag })}
                      className="transition-transform hover:scale-105"
                    >
                      <Badge
                        variant="outline"
                        className="cursor-pointer hover:border-primary/60 hover:text-primary"
                      >
                        {tag}
                      </Badge>
                    </button>
                  ))}
                </div>
              </header>
              <div className={`text-sm ${MARKDOWN_CLASSES}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {docContent?.content ?? ''}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </main>
        {/* 右栏：编辑态隐藏（R2）；xl 以下隐藏，折叠进 Sheet */}
        {!editing && (
          <aside className="hidden w-56 shrink-0 space-y-4 overflow-y-auto xl:block">
            {rightPanel}
          </aside>
        )}
      </div>

      {/* 左栏折叠 Sheet（xl 以下，v1.47.0-dev）：搜索/过滤/分类树收进抽屉，正文全宽 */}
      {!editing && (
        <Sheet open={sidebarSheetOpen} onOpenChange={setSidebarSheetOpen}>
          <SheetHeader>
            <SheetTitle>{t('detail.browse')}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 flex h-full min-h-0 flex-col gap-2 overflow-hidden">
            {sidebarContent}
          </div>
        </Sheet>
      )}

      {/* 右栏折叠 Sheet（xl 以下） */}
      {!editing && (
        <Sheet open={rightSheetOpen} onOpenChange={setRightSheetOpen}>
          <SheetHeader>
            <SheetTitle>{t('doc.outline')}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4">{rightPanel}</div>
        </Sheet>
      )}

      {/* 成员管理 Sheet（复用 board 成员管理模式：成员列表 + 邀请 Agent checkbox） */}
      <Sheet open={membersSheetOpen} onOpenChange={setMembersSheetOpen}>
        <SheetHeader>
          <SheetTitle>{t('members.title')}</SheetTitle>
          <SheetDescription>{t('members.description')}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="space-y-2">
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('members.noMembers')}</p>
            ) : (
              members.map((m) => (
                <div key={m.actorId} className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm">{m.actorName || m.actorId}</span>
                    <Badge variant={m.role === 'editor' ? 'default' : 'secondary'}>
                      {m.role === 'editor' ? t('members.editor') : t('members.member')}
                    </Badge>
                  </div>
                  {/* 行操作（转让/升降级/移除）全是 creator-only 端点，editor 看到必 403——gate 提升为 isOwnerLike（同邀请块收敛） */}
                  {isOwnerLike && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => handleTransferCreator(m.actorId, m.actorName || m.actorId)}
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        title={t('members.transferCreator')}
                      >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                      </button>
                      {m.role === 'editor' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => removeEditorMutation.mutate(m.actorId)}
                        >
                          {t('members.member')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => addEditorMutation.mutate(m.actorId)}
                        >
                          {t('members.setEditor')}
                        </Button>
                      )}
                      <button
                        onClick={() => uninviteMutation.mutate(m.actorId)}
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        title={t('members.remove')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* 邀请 Agent（checkbox 列表，isOwnerLike 可见——后端 invite 是 creator-only，editor 看到必 403） */}
          {isOwnerLike && (
            <div className="border-t border-border/50 pt-3">
              <p className="mb-2 text-sm font-medium">{t('members.addInvite')}</p>
              {availableAgents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('members.noAvailableAgents')}</p>
              ) : (
                <div className="space-y-1">
                  {availableAgents.map((agent) => (
                    <label
                      key={agent.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm transition-colors hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        onChange={(e) => {
                          if (e.target.checked) inviteMutation.mutate(agent.id);
                        }}
                      />
                      <span className="flex-1 truncate">{agent.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Sheet>

      {/* 分类管理 Dialog（canManage：增/改名/删） */}
      {/* 空间图例只读弹窗（v1.43.1-dev）：markdown 渲染查看；编辑入口在空间设置 */}
      <Dialog open={legendOpen} onOpenChange={setLegendOpen}>
        <DialogHeader>
          <DialogTitle>{t('detail.legend')}</DialogTitle>
          <DialogDescription>{space.name}</DialogDescription>
        </DialogHeader>
        <div className={`py-4 text-sm text-muted-foreground ${MARKDOWN_CLASSES}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {space.description ?? ''}
          </ReactMarkdown>
        </div>
      </Dialog>

      <Dialog open={categoriesOpen} onOpenChange={setCategoriesOpen}>
        <DialogHeader>
          <DialogTitle>{t('categories.title')}</DialogTitle>
          <DialogDescription>{t('categories.manage')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4">
          {categories.map((cat) => (
            <div key={cat.id} className="flex items-center gap-2">
              <Input
                defaultValue={cat.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== cat.name) {
                    renameCategoryMutation.mutate({ id: cat.id, name });
                  }
                }}
                className="h-9 flex-1"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={async () => {
                  // 分类删除确认（全局 confirm；与文件内其他确认框同批替换 window.confirm）
                  const ok = await confirm({
                    title: t('categories.deleteTitle'),
                    description: t('categories.deleteConfirm', { name: cat.name }),
                    confirmText: tGlobal('common.confirm'),
                    cancelText: tGlobal('common.cancel'),
                    confirmVariant: 'danger',
                  });
                  if (!ok) return;
                  deleteCategoryMutation.mutate(cat.id);
                }}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-2">
            <Input
              placeholder={t('categories.namePlaceholder')}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCategoryName.trim()) {
                  createCategoryMutation.mutate(newCategoryName.trim());
                }
              }}
              className="h-9 flex-1"
            />
            <Button
              size="sm"
              className="h-9"
              disabled={!newCategoryName.trim()}
              isLoading={createCategoryMutation.isPending}
              onClick={() => createCategoryMutation.mutate(newCategoryName.trim())}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCategoriesOpen(false)}>
            {tGlobal('common.close')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 空间设置 Dialog */}
      <Dialog open={spaceSettingsOpen} onOpenChange={setSpaceSettingsOpen}>
        <DialogHeader>
          <DialogTitle>{t('spaceSettings.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('spaceSettings.name')}</label>
            <Input
              value={spaceForm.name}
              onChange={(e) => setSpaceForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t('spaceSettings.namePlaceholder')}
              maxLength={100}
              className="h-9"
            />
          </div>
          {/* description */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('spaceSettings.description')}</label>
            <textarea
              value={spaceForm.description}
              onChange={(e) => setSpaceForm((prev) => ({ ...prev, description: e.target.value }))}
              placeholder={t('spaceSettings.descPlaceholder')}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          {/* editor 提示（v1.45 拆权）：结构字段（可见性/绑定）仅 creator 可改 */}
          {!isOwnerLike && (
            <p className="text-xs text-muted-foreground">{t('spaceSettings.editorHint')}</p>
          )}
          {/* visibility（结构字段，creator-only——editor 隐藏，payload 也不发） */}
          {isOwnerLike && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('spaceSettings.visibility')}</label>
              <div className="flex gap-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="visibility"
                    value="open"
                    checked={spaceForm.visibility === Visibility.OPEN}
                    onChange={() =>
                      setSpaceForm((prev) => ({ ...prev, visibility: Visibility.OPEN }))
                    }
                  />
                  {t('spaceSettings.visibilityPublic')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="visibility"
                    value="private"
                    checked={spaceForm.visibility === Visibility.PRIVATE}
                    onChange={() =>
                      setSpaceForm((prev) => ({ ...prev, visibility: Visibility.PRIVATE }))
                    }
                  />
                  {t('spaceSettings.visibilityPrivate')}
                </label>
              </div>
            </div>
          )}
          {/* 关联绑定（结构字段，creator-only——editor 隐藏；入口显示在所选看板/话题下；换绑/解绑不触碰任务↔文档链接（按 docId 关联）） */}
          {isOwnerLike && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('spaceSettings.binding')}</label>
              <select
                value={spaceForm.binding}
                onChange={(e) => setSpaceForm((prev) => ({ ...prev, binding: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <option value="none">{t('spaceSettings.bindingNone')}</option>
                {(bindingBoards?.items?.length ?? 0) > 0 && (
                  <optgroup label={t('spaceSettings.bindingBoards')}>
                    {bindingBoards!.items.map((b) => (
                      <option key={b.id} value={`board:${b.id}`}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {(bindingTopics?.items?.length ?? 0) > 0 && (
                  <optgroup label={t('spaceSettings.bindingTopics')}>
                    {bindingTopics!.items.map((tp) => (
                      <option key={tp.id} value={`topic:${tp.id}`}>
                        {tp.title}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <p className="text-xs text-muted-foreground">{t('spaceSettings.bindingHint')}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSpaceSettingsOpen(false)}>
            {tGlobal('common.close')}
          </Button>
          <Button
            disabled={!spaceForm.name.trim()}
            isLoading={updateSpaceMutation.isPending}
            onClick={async () => {
              // 绑定变更：编码值解包为后端 payload（'none' = 双侧显式 null 解绑），变更前先确认
              const currentBinding = space?.boardId
                ? `board:${space.boardId}`
                : space?.topicId
                  ? `topic:${space.topicId}`
                  : 'none';
              const bindingChanged = spaceForm.binding !== currentBinding;
              if (
                bindingChanged &&
                !(await confirm({
                  title: t('spaceSettings.bindingTitle'),
                  description: t('spaceSettings.bindingConfirm'),
                  confirmText: tGlobal('common.confirm'),
                  cancelText: tGlobal('common.cancel'),
                }))
              ) {
                return;
              }
              const payload: {
                name: string;
                description?: string | null;
                visibility?: Visibility;
                topicId?: string | null;
                boardId?: string | null;
              } = {
                name: spaceForm.name.trim(),
                // 空串/纯空白 → null 显式清空（后端已支持 description: null = 清空；传 '' 会被 DTO 400 拒绝）
                description: spaceForm.description.trim() || null,
              };
              // 拆权（v1.45 DOCSPACE-PERM）：editor 只发内容字段（name/description），
              // 结构字段（visibility/绑定）不发——后端结构字段 creator-only，editor 发了必 403
              if (isOwnerLike) {
                payload.visibility = spaceForm.visibility;
                if (bindingChanged) {
                  if (spaceForm.binding === 'none') {
                    payload.topicId = null;
                    payload.boardId = null;
                  } else if (spaceForm.binding.startsWith('topic:')) {
                    payload.topicId = spaceForm.binding.slice(6);
                  } else {
                    payload.boardId = spaceForm.binding.slice(6);
                  }
                }
              }
              updateSpaceMutation.mutate(payload);
            }}
          >
            {t('spaceSettings.save')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 批量上传 Dialog */}
      <BatchUploadDialog
        spaceId={spaceId}
        existingPaths={facetDocs.map((d) => d.path)}
        open={batchUploadOpen}
        onOpenChange={setBatchUploadOpen}
        onUploaded={() => {
          void queryClient.invalidateQueries({ queryKey: ['docs', 'docs', spaceId] });
          void queryClient.invalidateQueries({ queryKey: ['docs', 'doc-facets', spaceId] });
          void queryClient.invalidateQueries({ queryKey: ['docs', 'space', spaceId] });
        }}
      />
    </div>
  );
}
