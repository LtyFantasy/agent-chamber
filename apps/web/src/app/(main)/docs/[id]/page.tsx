'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { Visibility, DOC_TYPE_DIAGRAM, extractLastHeadingSegment } from '@agent-chamber/shared';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle,
  Copy,
  FilePlus,
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
  Workflow,
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
import { Sheet, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { DocSearchHit } from '@/types';
import { UserRole, DocSpaceMemberRole, AgentStatus, ActorType, DOC_SOURCE_NATIVE } from '@/types';
import { MARKDOWN_CLASSES } from '@/lib/markdown-classes';
import { DocEditor } from '@/components/docs/doc-editor';
import { DiagramViewer } from '@/components/docs/diagram-viewer';
import { BatchUploadDialog } from '@/components/docs/batch-upload-dialog';
import { isExternalHref, resolveDocHref, PLATFORM_DOC_LINK_RE } from '@/components/docs/doc-link';
import { confirm, toast } from '@/lib/notify';
import { MembersSheet } from '@/components/members/members-sheet';
import type { MemberItem, MembersSheetLabels } from '@/components/members/types';
import { SidebarTree } from './sidebar-tree';
// 左栏文档树组件（前端债包批次 4 子项 2 commit 6 抽取自本页：DocTreeItem + CategorySection）
import { DocTreeItem, CategorySection } from '@/components/docs/doc-tree';

/** 左栏视图模式 localStorage key（同 login 页 auth:last-email 先例；SSR 无 localStorage，挂载后校正） */
const SIDEBAR_MODE_KEY = 'docs:sidebar-mode';

/** 左栏视图模式：tree = 按 path 前缀的目录树（默认），category = Agent 策展分类（历史行为） */
type SidebarViewMode = 'tree' | 'category';

/**
 * mutation 错误统一提示（范式照抄 task-detail-panel.tsx addDependencyMutation）：
 * 优先透传服务端 error.response.data.message（4xx 业务原因），兜底 axios message / 领域文案。
 */
const alertMutationError = (fallback: string) => (err: unknown) => {
  const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
  alert(axiosErr?.response?.data?.message || axiosErr?.message || fallback);
};

/**
 * 去除标题中的行内代码记号，匹配 React Markdown 的 textContent。
 *
 * React Markdown 渲染后 textContent 不包含反引号，但 headingPath 保留原始 Markdown。
 */
function normalizeHeadingText(text: string): string {
  return text.replace(/`([^`]*)`/g, '$1').trim();
}

/** 字节数人性化显示（图信息卡快照体积；B/KB/MB 为通用单位，不随 locale 翻译） */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 滚动到正文内指定标题（目录传 outline DTO heading——后端 heading_text 列直读，
 * 标题正文含 ` § ` 也完整保留；反解析取标题已废弃，见 shared extractLastHeadingSegment 注释） */
function scrollToHeading(container: HTMLElement | null, heading: string | null | undefined) {
  if (!container || !heading) return;
  const normalizedHeading = normalizeHeadingText(heading);
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const el of Array.from(headings)) {
    if (normalizeHeadingText(el.textContent ?? '') === normalizedHeading) {
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
  const locale = useLocale();
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
  /** 左栏视图模式（目录/分类双模式）：默认 tree（用户拍板——目录是人脑心智模型），localStorage 持久化记住 */
  const [viewMode, setViewMode] = useState<SidebarViewMode>('tree');
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
  /** 断链点击解析的会话内缓存（path → docId | null；null = 已确认不存在，避免重复请求） */
  const pathCacheRef = useRef<Map<string, string | null>>(new Map());
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

  /** 全空间聚合计数（type/tag/category 候选；替代前端全量列表聚合，v1.70.0-dev） */
  const { data: facetsData } = useQuery({
    queryKey: ['docs', 'facets', spaceId],
    queryFn: () => Api.docs.getFacets(spaceId),
    enabled: !!spaceId,
  });

  /** type/tag 过滤激活 → 扁平分页列表态（P3 行为变更：过滤后不再保持树形） */
  const filterActive = typeFilter !== '' || tagFilter !== '';
  const {
    data: filteredData,
    fetchNextPage: fetchNextFiltered,
    hasNextPage: filteredHasNext,
    isFetchingNextPage: filteredFetching,
    isPending: filteredPending,
  } = useInfiniteQuery({
    queryKey: ['docs', 'filtered', spaceId, typeFilter, tagFilter],
    queryFn: ({ pageParam }) =>
      Api.docs.listDocs(spaceId, {
        type: typeFilter || undefined,
        tag: tagFilter || undefined,
        page: pageParam,
        pageSize: 50,
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => (lastPage.hasNext ? lastPage.page + 1 : undefined),
    enabled: !!spaceId && filterActive,
  });

  /** 搜索防抖 effect：300ms 停顿后同步 debounced 值；卸载时清理 timer，避免旧输入晚到 */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  /** 挂载后按 localStorage 校正视图模式（useState 默认值保证首屏与 SSR 一致，避免 hydration 闪烁；
   *  与 login 页 auth:last-email 回填同款写法） */
  useEffect(() => {
    const saved = localStorage.getItem(SIDEBAR_MODE_KEY);
    if (saved === 'tree' || saved === 'category') setViewMode(saved);
  }, []);

  /** 搜索命中（左栏搜索框，防抖后 q 非空才发） */
  const { data: searchHits } = useQuery({
    queryKey: ['docs', 'search', spaceId, debouncedSearchQuery],
    queryFn: () => Api.docs.search(spaceId, { q: debouncedSearchQuery, limit: 20 }),
    enabled: !!spaceId && debouncedSearchQuery.trim().length > 0,
  });

  /**
   * 搜索 B 组「文档匹配」：服务端 GET docs?q=（title+path ILIKE 既有契约）分页 + 加载更多。
   * 为什么服务端化：旧实现对全量 facetDocs 前端子串过滤，全量拉取已删除（懒加载改造）；
   * 后端 q= 对 title/path 做 ILIKE，语义等价且天然分页。
   */
  const {
    data: docMatchesData,
    fetchNextPage: fetchNextDocMatches,
    hasNextPage: docMatchesHasNext,
    isFetchingNextPage: docMatchesFetching,
    isPending: docMatchesPending,
  } = useInfiniteQuery({
    queryKey: ['docs', 'search-docs', spaceId, debouncedSearchQuery],
    queryFn: ({ pageParam }) =>
      Api.docs.listDocs(spaceId, { q: debouncedSearchQuery, page: pageParam, pageSize: 20 }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => (lastPage.hasNext ? lastPage.page + 1 : undefined),
    enabled: !!spaceId && debouncedSearchQuery.trim().length > 0,
  });

  /** 选中文档元数据 + 大纲 */
  const { data: doc, isError: docIsError } = useQuery({
    queryKey: ['docs', 'doc', selectedDocId],
    queryFn: () => Api.docs.getDoc(selectedDocId!),
    enabled: !!selectedDocId,
  });

  /**
   * Web 全文通道（中栏渲染）。enabled 追加 doc 就绪 + 非 diagram 双条件：
   * ① doc 就绪才能知道 docType——diagram doc 的正文是 IR JSON，中栏走
   *   DiagramViewer（iframe 快照），绝不能发 /content 拉 IR 文本（acceptance:
   *   diagram doc 下 getDocContent 零调用）；② 若只在 docType 上做 gate，
   *   首渲染时 doc 未加载（undefined !== 'diagram'）仍会发起一次无谓请求。
   */
  const {
    data: docContent,
    isLoading: contentLoading,
    isError: contentIsError,
    refetch: refetchContent,
  } = useQuery({
    queryKey: ['docs', 'doc-content', selectedDocId],
    queryFn: () => Api.docs.getDocContent(selectedDocId!),
    enabled: !!selectedDocId && !!doc && doc.docType !== DOC_TYPE_DIAGRAM,
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
  /** useMemo 包裹：space 未加载时 ?? [] 每次渲染产生新数组，污染下游 memo 依赖（exhaustive-deps） */
  const categories = useMemo(() => space?.categories ?? [], [space]);
  const members = useMemo(() => space?.members ?? [], [space]);

  /** 管理权：admin | creator（含 owner 代理：creatorId ∈ 我的 agent id） | editor 成员（人类 actorId === user.id） */
  const canManage =
    !!user &&
    (user.role === UserRole.ADMIN ||
      isCreatorOrOwner(space?.creatorId, user.id, myAgentIds) ||
      members.some((m) => m.actorId === user.id && m.role === DocSpaceMemberRole.EDITOR));

  /**
   * 所有权（v1.45 DOCSPACE-PERM 拆权）：admin | creator（含 owner 代理）。
   * 与 canManage 的区别：canManage 含 editor（内容策展），isOwnerLike 是
   * 后端 creator-only 操作（结构字段 visibility/绑定、邀请、creator 转让）的前端闸门——
   * editor 看到这些 UI 后端必 403（修 invite 403 mismatch）。
   */
  const isOwnerLike =
    !!user &&
    (user.role === UserRole.ADMIN || isCreatorOrOwner(space?.creatorId, user.id, myAgentIds));

  /** type / tag 候选（facets 端点聚合，开放字符串无硬编码枚举；未过滤——选中过滤后
   *  下拉仍保留全部候选，反直觉问题与旧 facetDocs 行为一致） */
  const typeOptions = useMemo(
    () => (facetsData?.types ?? []).map((f) => f.value).sort(),
    [facetsData],
  );
  const tagOptions = useMemo(
    () => (facetsData?.tags ?? []).map((f) => f.value).sort(),
    [facetsData],
  );

  /** 分类计数（facets 聚合；count=0 的分类在分类视图隐藏，保持现行行为） */
  const categoryCounts = useMemo(
    () => new Map((facetsData?.categories ?? []).map((c) => [c.slug, c.count])),
    [facetsData],
  );
  const visibleCategories = useMemo(
    () => categories.filter((cat) => (categoryCounts.get(cat.slug) ?? 0) > 0),
    [categories, categoryCounts],
  );

  /** 过滤态扁平列表（P3：type/tag 过滤激活 → 扁平分页列表态） */
  const filteredDocs = useMemo(
    () => filteredData?.pages.flatMap((p) => p.items) ?? [],
    [filteredData],
  );

  /** 搜索 B 组「文档匹配」（服务端 q= 分页结果） */
  const docMatches = useMemo(
    () => docMatchesData?.pages.flatMap((p) => p.items) ?? [],
    [docMatchesData],
  );

  /**
   * 正文链接渲染器（path 写法 → docId 跳转的关键接线）：
   * - 外部 http/mailto → 新标签打开
   * - 平台规范链接 /docs/<spaceId>?doc=<docId> → SPA 导航（消掉整页刷新）
   * - 相对 .md path → 渲染为普通链接，点击时 ?path= 异步解析（单一机制 + 会话内缓存）：
   *   命中 → SPA 跳 /docs/<spaceId>?doc=<id>；未命中 → toast「文档不存在或已删除」
   * - 纯 #锚点 / 非 .md 相对路径 → 默认渲染不干预
   * 琥珀断链样式只保留在右栏 linkHealth 区（未加载的链接不再预判断链——点击才知死活）。
   * 跨文档 #锚点不做滚动定位：markdown 锚点 slug 与 headingPath 文本匹配规则不同构，落地不可靠。
   */
  /** 当前文档 path 标量：markdownComponents 闭包只用到 doc 的 truthiness + path，
   *  提取标量进 deps 替代 doc 对象本体（消解 exhaustive-deps warning，语义等价） */
  const currentDocPath = doc?.path;

  /** 相对 .md 链接点击解析：会话内缓存（path → docId | null）优先，未命中走 ?path= 异步解析 */
  const handleRelativeDocLink = useCallback(
    async (resolvedPath: string) => {
      const cached = pathCacheRef.current.get(resolvedPath);
      if (cached !== undefined) {
        if (cached) router.push(`/docs/${spaceId}?doc=${cached}`, { scroll: false });
        else toast.error({ title: t('detail.docLinkNotFound') });
        return;
      }
      try {
        const doc = await Api.docs.getDocByPath(spaceId, resolvedPath);
        if (doc) {
          pathCacheRef.current.set(resolvedPath, doc.id);
          router.push(`/docs/${spaceId}?doc=${doc.id}`, { scroll: false });
        } else {
          pathCacheRef.current.set(resolvedPath, null);
          toast.error({ title: t('detail.docLinkNotFound') });
        }
      } catch {
        // 解析请求失败：不缓存（下次点击可重试），toast 提示
        toast.error({ title: t('detail.docLinkNotFound') });
      }
    },
    [router, spaceId, t],
  );

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
        // 相对 .md 链接：普通链接渲染，点击时异步解析（未加载不预判断链）
        if (currentDocPath) {
          const resolved = resolveDocHref(href, currentDocPath);
          if (resolved !== undefined) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (resolved === null) {
                    // 越出空间根的不可达解析：直接判断链
                    toast.error({ title: t('detail.docLinkNotFound') });
                  } else {
                    void handleRelativeDocLink(resolved);
                  }
                }}
              >
                {children}
              </a>
            );
          }
        }
        return <a href={href}>{children}</a>;
      },
    }),
    [router, currentDocPath, handleRelativeDocLink, t],
  );

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
    // 懒加载目录树/聚合计数（A4 防脏目录计数）：前缀通配失效覆盖全部 prefix 层
    void queryClient.invalidateQueries({ queryKey: ['docs', 'tree'] });
    void queryClient.invalidateQueries({ queryKey: ['docs', 'facets'] });
    void queryClient.invalidateQueries({ queryKey: ['docs', 'spaces'] });
  };

  /** 邀请 Agent 加入空间（R2 Promise 契约：页面层 allSettled 循环调用；
      选择集已移交 MembersSheet 内部管理，onSuccess 只负责刷新详情） */
  const inviteMutation = useMutation({
    mutationFn: (agentId: string) => Api.docs.inviteAgent(spaceId, agentId),
    onSuccess: invalidateSpace,
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

  // ── MembersSheet 数据装配（批次 C3：内联成员 Sheet → 共享组件；页面层负责
  //    DTO → MemberItem 映射与权限 gate，组件纯受控不感知业务）──

  /** 活跃成员 → MemberItem（DocSpaceMemberDto：actorId/actorName/actorType/role；
   *  DTO 无 avatarUrl 字段 → 不传，Avatar 按 actorId 确定性底色兜底；行级排除
   *  照抄旧 UI——所有行（含自己/创建者行）都显示操作入口，不设 canRemove
   *  （缺省跟随 capabilities.remove），转让给自己/创建者行移除等后端注定拒绝
   *  的操作由后端 409/403 守卫兜底（既存行为，重构不改行为）） */
  const memberItems = useMemo((): MemberItem[] => {
    if (!space) return [];
    return (space.members ?? []).map((m) => ({
      actorId: m.actorId,
      name: m.actorName || m.actorId,
      actorType: m.actorType ?? 'agent',
      role: m.role,
      // 已删除信号透传（统一批 B）：软删 actor 带 deletedAt → member-row 灰化+badge
      deletedAt: m.deletedAt ?? null,
      status: 'active',
    }));
  }, [space]);

  /** 可邀请 agent 候选（照抄旧「添加邀请」checkbox 列表：全量 active agent 排除
   *  现有成员；docs 无 invited 概念，无需兜底集合） */
  const candidateItems = useMemo((): MemberItem[] => {
    if (!space) return [];
    const memberIds = new Set((space.members ?? []).map((m) => m.actorId));
    return (agentsData ?? [])
      .filter((a) => a.status === AgentStatus.ACTIVE && !memberIds.has(a.id))
      .map((a) => ({
        actorId: a.id,
        name: a.name,
        actorType: 'agent',
        role: 'member',
        avatarUrl: a.avatarUrl ?? undefined,
        status: 'active',
      }));
  }, [space, agentsData]);

  /** 差异化文案：复用页面现有 docs.members.* key（title/角色/类别） */
  const memberLabels: MembersSheetLabels = {
    title: t('members.title'),
    roleLabels: {
      editor: t('members.editor'),
      member: t('members.member'),
    },
    typeLabels: {
      human: t('members.human'),
      agent: t('members.agent'),
    },
  };

  /** R2 邀请提交（Promise 契约）：mutateAsync 循环 + allSettled——全成功 resolve
   *  （组件切回主视图并清空选择）；任一失败 reject（组件留在邀请视图保留选择）+
   *  失败汇总 toast（成功 N / 失败 M）。docs 无人类候选，kind 恒为 'agent'，
   *  非 agent 防御性短路 */
  const handleInvite = async (actorIds: string[], kind: 'agent' | 'human') => {
    if (kind !== ActorType.AGENT) return;
    const results = await Promise.allSettled(
      actorIds.map((actorId) => inviteMutation.mutateAsync(actorId)),
    );
    // eslint-disable-next-line rulesdir/no-magic-string-compare -- PromiseSettledResult 内置状态（'fulfilled'|'rejected'），非圆桌权限请求状态
    const failed = results.filter((r) => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    if (failed > 0) {
      toast.error({
        title: t('members.inviteFailed', { succeeded, failed }),
      });
      throw new Error(`invite agent partial failure: ${failed}/${results.length}`);
    }
  };

  /** 移除活跃成员（组件 AlertDialog 确认后回调）：docs 的 removeEditor 是降级
   *  （editor → member 保行）非移除，移除唯一出口是 uninviteAgent——照抄旧 UI
   *  X 按钮对所有行（含 editor 行）一律 uninviteMutation，与角色无关 */
  const handleRemoveMember = (actorId: string) => {
    uninviteMutation.mutate(actorId);
  };

  /** 升降级（docs 双向）：toRole==='editor' → addEditor（升级 member → editor）；
   *  toRole==='member' → removeEditor（后端语义 = 降级 editor → member，保行不删，
   *  与 board 的完全移除相反——docspace.service.ts removeEditor 注释明示
   *  "Demote: editor → member (never delete the row)"） */
  const handleChangeRole = (actorId: string, newRole: string) => {
    if (newRole === DocSpaceMemberRole.EDITOR) {
      addEditorMutation.mutate(actorId);
    } else {
      removeEditorMutation.mutate(actorId);
    }
  };

  /** 转让创建者（组件 AlertDialog 二次确认后回调；成功 toast 与重拉详情都在
   *  transferCreatorMutation 内——v1.45 DOCSPACE-PERM creator-only，后端
   *  409/404/403 语义由后端保证；旧页面层 confirm 确认流废弃，统一组件确认流） */
  const handleTransferCreator = (actorId: string) => {
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
      void queryClient.invalidateQueries({ queryKey: ['docs', 'tree'] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'facets'] });
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
      // 懒加载目录树/聚合计数（A4 防脏目录计数）：前缀通配失效覆盖全部 prefix 层
      void queryClient.invalidateQueries({ queryKey: ['docs', 'tree'] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'facets'] });
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

  /** 视图模式切换：同步写回 localStorage（同 login 页 auth:last-email 先例，刷新后记住选择） */
  const handleViewModeChange = (mode: SidebarViewMode) => {
    setViewMode(mode);
    localStorage.setItem(SIDEBAR_MODE_KEY, mode);
  };

  /** 选中搜索命中：编辑态先确认，切文档并排队滚动 */
  const handleHitSelect = async (hit: DocSearchHit) => {
    if (!(await confirmDiscardEditing())) return;
    setEditing(null);
    // DocSearchHit 只携带 headingPath（搜索索引投影无 heading 字段，见 shared
    // DocSearchHit），此处反解析末段仅作兼容兜底——outline 消费点已改直读 heading
    pendingHeadingRef.current = hit.headingPath ? extractLastHeadingSegment(hit.headingPath) : null;
    selectDoc(hit.docId);
    setSearchQuery('');
  };

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

  /** 左栏内容（搜索 + 类型/标签过滤 + 视图模式切换 + 目录树/分类树/搜索命中；xl 常驻列与折叠 Sheet 共用，v1.47.0-dev 移动端折叠） */
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

      {/* 视图模式切换（目录/分类双模式）：目录=FolderTree / 分类=ListTree，选中态高亮；
          title 提示走 i18n；搜索态下切换对渲染无影响但按钮保持常驻，布局不跳格 */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => handleViewModeChange('tree')}
          title={t('detail.viewModeTree')}
          className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors ${
            viewMode === 'tree'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          <FolderTree className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => handleViewModeChange('category')}
          title={t('detail.viewModeCategory')}
          className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors ${
            viewMode === 'category'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          <ListTree className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {searchQuery.trim() ? (
          /* 搜索命中列：文档匹配（服务端 q= 分页，B 组）在上，内容命中（section 正文，现状）在下 */
          <div className="space-y-3">
            {docMatches.length > 0 && (
              <div className="space-y-1">
                <p className="px-1 py-0.5 text-xs text-muted-foreground">
                  {t('detail.docMatches')}
                </p>
                {docMatches.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => handleDocSelect(d.id)}
                    className="block w-full rounded-md border border-border/40 px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <span className="block truncate text-xs font-medium">{d.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {d.path}
                    </span>
                  </button>
                ))}
                {docMatchesHasNext && (
                  <button
                    onClick={() => void fetchNextDocMatches()}
                    disabled={docMatchesFetching}
                    className="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                  >
                    {t('detail.loadMore')}
                  </button>
                )}
              </div>
            )}
            <div className="space-y-1">
              <p className="px-1 py-0.5 text-xs text-muted-foreground">{t('detail.searchHits')}</p>
              {(searchHits ?? []).length === 0 && docMatches.length === 0 && !docMatchesPending ? (
                /* noSearchResults 两组皆空（且文档匹配已加载完）才显示：文档匹配命中但内容无命中时不该误导「无结果」 */
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
          </div>
        ) : filterActive ? (
          /* P3 行为变更：type/tag 过滤激活 → 扁平分页列表态（不再保持树形） */
          filteredPending ? null : filteredDocs.length === 0 ? (
            <p className="px-1 py-4 text-center text-xs text-muted-foreground">
              {t('detail.noDocs')}
            </p>
          ) : (
            <div className="space-y-0.5">
              {filteredDocs.map((d) => (
                <DocTreeItem
                  key={d.id}
                  docItem={d}
                  active={d.id === selectedDocId}
                  onSelect={() => handleDocSelect(d.id)}
                />
              ))}
              {filteredHasNext && (
                <button
                  onClick={() => void fetchNextFiltered()}
                  disabled={filteredFetching}
                  className="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                >
                  {t('detail.loadMore')}
                </button>
              )}
            </div>
          )
        ) : viewMode === 'tree' ? (
          /* 目录模式（默认）：懒加载目录树（展开态 localStorage 持久化在 SidebarTree 内部管理） */
          <SidebarTree
            spaceId={spaceId}
            activeDocId={selectedDocId}
            onSelectDoc={(docId) => handleDocSelect(docId)}
          />
        ) : /* 分类模式：分类 = getSpace categories ⋈ facets 计数（count=0 隐藏），展开拉 ?category=slug 分页 */
        visibleCategories.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-muted-foreground">
            {t('detail.noDocs')}
          </p>
        ) : (
          <div className="space-y-2">
            {visibleCategories.map((cat) => (
              <CategorySection
                key={cat.id}
                spaceId={spaceId}
                slug={cat.slug}
                name={cat.name}
                count={categoryCounts.get(cat.slug) ?? 0}
                collapsed={collapsedCats.has(cat.id)}
                onToggle={() =>
                  setCollapsedCats((prev) => {
                    const next = new Set(prev);
                    if (next.has(cat.id)) next.delete(cat.id);
                    else next.add(cat.id);
                    return next;
                  })
                }
                activeDocId={selectedDocId}
                onSelectDoc={(docId) => handleDocSelect(docId)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );

  /** 大纲/元数据右栏内容（xl 常驻列与折叠 Sheet 共用） */
  const rightPanel = (
    <>
      {/* Section 大纲导航：diagram doc 隐藏（合成节无标题大纲，只显示「无大纲」噪音）；
          正文未就绪时也隐藏——大纲按钮点击依赖 contentRef（正文容器），
          正文晚于 doc 元数据加载（diagram 分支的 enabled gate），过早渲染会点到空容器 */}
      {doc?.docType !== DOC_TYPE_DIAGRAM && !contentLoading && (
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
                  onClick={() => scrollToHeading(contentRef.current, section.heading)}
                  className="block w-full truncate rounded px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  style={{ paddingLeft: `${6 + section.headingLevel * 10}px` }}
                  title={section.headingPath ?? undefined}
                >
                  {/* 目录只显示本地标题（outline DTO heading 列直读——标题正文含 ` § `
                      也完整保留；面包屑全路径留在 tooltip），否则每项都被父级标题刷屏 */}
                  {section.heading || t('doc.noOutline')}
                </button>
              ))}
            </nav>
          )}
        </div>
      )}

      {/* 链接健康卡（diagram doc 隐藏：IR JSON 无 markdown 链接，linkHealth 恒 0 噪音） */}
      {doc && doc.docType !== DOC_TYPE_DIAGRAM && (
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
                  {t('linkHealth.checkedAt', {
                    time: formatDate(doc.linkHealth.checkedAt, locale),
                  })}
                </p>
              </>
            ) : (
              <p>{t('linkHealth.notChecked')}</p>
            )}
          </div>
        </div>
      )}

      {/* 图信息卡（Diagram IR v1）：diagram doc 专用，数据源 = DocDetail.diagram
          （GET /docs/:id 摘要携带 render_meta，免二次请求；html 大字段另走 diagram.html） */}
      {doc?.docType === DOC_TYPE_DIAGRAM && doc.diagram && (
        <div className="rounded-lg border border-border/50 p-3 text-xs">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Workflow className="h-4 w-4 text-primary" />
            {t('diagram.infoCard')}
          </h3>
          <div className="space-y-1.5 text-muted-foreground">
            <div className="flex justify-between gap-2">
              <span>{t('doc.type')}</span>
              <span className="truncate text-foreground">{doc.diagram.diagramType ?? '-'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('diagram.qualityProfile')}</span>
              <span className="text-foreground">{doc.diagram.qualityProfile ?? '-'}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('diagram.renderedAt')}</span>
              <span className="text-foreground">
                {doc.diagram.renderedAt ? formatDate(doc.diagram.renderedAt, locale) : '-'}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('diagram.htmlBytes')}</span>
              <span className="text-foreground">
                {doc.diagram.htmlBytes != null ? formatBytes(doc.diagram.htmlBytes) : '-'}
              </span>
            </div>
            {/* composition 计数：errors > 0 标红、warnings > 0 标琥珀（对齐后端门槛语义） */}
            <div className="flex justify-between gap-2">
              <span>{t('diagram.compositionErrors')}</span>
              <span
                className={
                  (doc.diagram.composition?.errors ?? 0) > 0
                    ? 'text-destructive'
                    : 'text-emerald-500'
                }
              >
                {doc.diagram.composition?.errors ?? 0}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('diagram.compositionWarnings')}</span>
              <span
                className={
                  (doc.diagram.composition?.warnings ?? 0) > 0
                    ? 'text-amber-500'
                    : 'text-muted-foreground'
                }
              >
                {doc.diagram.composition?.warnings ?? 0}
              </span>
            </div>
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
              <span className="text-foreground">{doc.source ?? DOC_SOURCE_NATIVE}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>{t('doc.sectionCount', { count: doc.sectionCount ?? 0 })}</span>
              <span>{t('doc.tokenEstimate', { count: doc.tokenEstimate ?? 0 })}</span>
            </div>
            {doc.updatedAt && (
              <div className="flex justify-between gap-2">
                <span>{t('doc.updatedAt')}</span>
                <span className="text-foreground">{formatDate(doc.updatedAt, locale)}</span>
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
            {space.visibility === Visibility.PRIVATE ? (
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
            {/* 入口计数（批次 C3）：成员数 > 0 时补 (N)，与 board 入口按钮同规 */}
            {members.length > 0 ? ` (${members.length})` : ''}
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
                  visibility:
                    space.visibility === Visibility.PRIVATE ? Visibility.PRIVATE : Visibility.OPEN,
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
          ) : docIsError ? (
            /* 坏链直达 / 文档已删：友好空态 + 返回选择，不再裸 404 空白。
               必须排在 Loading 前：doc 查询失败时 doc 恒 undefined，
               （diagram 分支引入的）!doc Loading 条件会把它误判成永久加载 */
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
          ) : !doc || contentLoading ? (
            /* 等待 doc 元数据（diagram 判定依据）或正文；diagram doc 的正文查询
               恒 disabled（contentLoading=false），走完此条件即落入 DiagramViewer */
            <Loading />
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
            // diagram 分支补 h-full 链（2026-09-02 用户反馈）：main 定高但本 div
            // 原为自然流，viewer h-full 对 auto 高度父级退化为 min-h 560px，窗口
            // 更高时中栏下方留白；flex h-full flex-col + viewer flex-1 让图撑满
            // 中栏剩余高度。文本文档保持自然流（长文滚动语义不变）
            <div
              ref={contentRef}
              className={doc?.docType === DOC_TYPE_DIAGRAM ? 'flex h-full flex-col' : undefined}
            >
              {/* 标题区：title / summary / tags / 来源 badge + 编辑按钮 */}
              <header className="mb-4 border-b border-border/50 pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-2xl font-bold">{doc?.title ?? docContent?.title}</h2>
                    {doc?.summary && (
                      <p className="mt-1 text-sm text-muted-foreground">{doc.summary}</p>
                    )}
                  </div>
                  {canManage &&
                    doc?.source === DOC_SOURCE_NATIVE &&
                    !contentLoading &&
                    /* v1 只读拍板（Q5）：diagram doc 隐藏编辑按钮——IR 走 MCP/Agent 写入 */
                    doc?.docType !== DOC_TYPE_DIAGRAM && (
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
                  {doc?.source && doc.source !== DOC_SOURCE_NATIVE && (
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
              {/* 中栏正文：diagram doc → iframe 预览（DiagramViewer）；其余走 ReactMarkdown */}
              {doc?.docType === DOC_TYPE_DIAGRAM ? (
                <DiagramViewer docId={selectedDocId} />
              ) : (
                <div className={`text-sm ${MARKDOWN_CLASSES}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {docContent?.content ?? ''}
                  </ReactMarkdown>
                </div>
              )}
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

      {/* 成员管理（批次 C3：内联成员 Sheet → 共享 MembersSheet——信息架构主视图 +
          邀请二级视图；权限 gate 照抄旧各 section（isOwnerLike：平台 admin ｜ 空间
          创建者/owner 代理——invite/移除/升降级/转让全是 creator-only 端点，
          editor 看到必 403）；docs 无 invited 区、无人类候选，不传 invited/
          humanCandidates；升降级双向（docs removeEditor = 降级保行，与 board 的
          完全移除相反）；行级 gate 照抄旧 UI——所有行显示操作（canRemove 不设），
          创建者行/转让给自己由后端 409 守卫兜底 */}
      <MembersSheet
        open={membersSheetOpen}
        onOpenChange={setMembersSheetOpen}
        labels={memberLabels}
        members={memberItems}
        candidates={candidateItems}
        capabilities={{
          invite: isOwnerLike,
          remove: isOwnerLike,
          changeRole: isOwnerLike
            ? [
                { fromRole: 'member', toRole: 'editor', label: t('members.setEditor') },
                { fromRole: 'editor', toRole: 'member', label: t('members.member') },
              ]
            : [],
          transferCreator: isOwnerLike,
        }}
        onInvite={handleInvite}
        onRemove={handleRemoveMember}
        onChangeRole={handleChangeRole}
        onTransferCreator={handleTransferCreator}
        inviting={inviteMutation.isPending}
      />

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
        open={batchUploadOpen}
        onOpenChange={setBatchUploadOpen}
        onUploaded={() => {
          // 懒加载目录树/聚合计数（A4 防脏目录计数）：前缀通配失效覆盖全部 prefix 层
          void queryClient.invalidateQueries({ queryKey: ['docs', 'tree'] });
          void queryClient.invalidateQueries({ queryKey: ['docs', 'facets'] });
          void queryClient.invalidateQueries({ queryKey: ['docs', 'space', spaceId] });
        }}
      />
    </div>
  );
}
