/**
 * 左栏目录树（docs 空间详情页「目录」视图模式）——懒加载版（v1.70.0-dev）。
 *
 * - 数据源：GET /doc-spaces/:id/docs/tree（按 prefix 返回当前层子目录 + 直挂文档）
 * - 每个 prefix 一条 useInfiniteQuery（queryKey ['docs','tree',spaceId,prefix]）：
 *   展开目录才挂载子层查询（懒加载触发）；文档/目录「加载更多」共用同一查询的
 *   fetchNextPage——pageParam = { foldersOffset, docsOffset } 双游标由 react-query
 *   管理（禁止手写 offset 累加数组），两侧都收齐才终止
 * - 目录默认全折叠 + localStorage 持久化展开态（key docs:expanded-folders:<spaceId>，
 *   照 SIDEBAR_MODE_KEY 先例：SSR 无 localStorage，挂载后校正；按空间分片——SPA 内
 *   跨空间软导航不重挂载组件，全局单 key 会让 A 空间的展开态泄漏到 B 空间）
 * - 选中同步（2026-09-14）：?doc= 切换文档（正文内链跳转/冷启动直达）时，按
 *   activeDocPath 自动展开祖先链 + 层内有界自动翻页直到目标行出现——高亮本就
 *   由 activeDocId 驱动，滚动到可视区由行内 effect 补足；只增不夺（用户手动折叠的
 *   目录，仅当再次导航到该子树内文档时才重新展开）
 * - 文件夹行显示 docCount（后端递归后代聚合，一眼看到体量）
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { FileText, FolderTree, Loader2, Workflow } from 'lucide-react';
import { Api } from '@/lib/api';
import { DOC_TYPE_DIAGRAM, type DocTreeDoc } from '@agent-chamber/shared';
import { docDisplayLabel } from '@/components/docs/doc-label';

/**
 * 展开态 localStorage key 前缀（照 SIDEBAR_MODE_KEY 先例；SSR 无 localStorage，挂载后校正）。
 * 按 spaceId 分片：本组件在 SPA 跨空间软导航时不重挂载，全局单 key 会把 A 空间的
 * 展开态泄漏进 B 空间（同名目录路径极常见）。旧全局 key `docs:expanded-folders`
 * **不读不迁移**（一次性偏好丢失可接受，惰性失效无害）。
 */
const EXPANDED_FOLDERS_KEY_PREFIX = 'docs:expanded-folders:';

/** 单层自动翻页页数上限（D4）：docs 默认 50/页 → 500 条、folders 200/页 → 2000 条封顶。
 *  超限即停（祖先已展开、仅目标行缺席），防止长尾层把 refetch 成本拖成无界 */
const TREE_AUTO_PAGE_LIMIT = 10;

/** 展开态 localStorage key（按空间分片） */
function expandedFoldersKey(spaceId: string): string {
  return `${EXPANDED_FOLDERS_KEY_PREFIX}${spaceId}`;
}

/** 读取持久化展开集合（仅浏览器调用；无数据/解析失败 → 空集 = 默认全折叠） */
function loadExpandedFolders(spaceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(expandedFoldersKey(spaceId));
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 写回展开集合（JSON 数组；写失败静默——持久化是增强，不阻塞交互） */
function saveExpandedFolders(spaceId: string, set: Set<string>): void {
  try {
    localStorage.setItem(expandedFoldersKey(spaceId), JSON.stringify(Array.from(set)));
  } catch {
    // 隐私模式/配额满等场景静默降级为会话内记忆
  }
}

/**
 * 从文档 path 推导祖先目录前缀链（每段含尾部 /）：`a/b/c.md` → `['a/', 'a/b/']`。
 * 根级文档（path 无 /）→ 空数组（根层无需展开任何目录）。
 * 纯函数（无副作用），导出供单测直测边界（T1）。
 */
export function ancestorPrefixes(path: string): string[] {
  const segments = path.split('/');
  const prefixes: string[] = [];
  // 末段是文件名本身，不构成目录前缀；逐段累积成 prefix
  for (let i = 1; i < segments.length; i += 1) {
    prefixes.push(`${segments.slice(0, i).join('/')}/`);
  }
  return prefixes;
}

/** 目录树文件行：样式与分类树 DocTreeItem（components/docs/doc-tree）对齐。
 *  标签（2026-09-02 用户拍板）：文件名为主（定位键，目录树里同名标题可能来自
 *  不同目录），标题为辅（与文件名实质相同时去重，见 doc-label）；tooltip 给
 *  全路径 + 全标题。hideBadge：同层 docType 全同时整层降噪（TreeLevel 注入）。 */
function FileRow({
  doc,
  active,
  hideBadge = false,
  onSelect,
}: {
  doc: DocTreeDoc;
  active: boolean;
  /** 徽标降噪：同层文档 docType 全同时置 true（如 memory/ 下 77 个 memory 徽标纯噪声） */
  hideBadge?: boolean;
  onSelect: () => void;
}) {
  const label = docDisplayLabel(doc);
  /** 行 DOM 引用：选中态落到本行时把它滚进可视区（见下方 effect） */
  const rowRef = useRef<HTMLButtonElement>(null);

  /**
   * 选中行滚动到可视区：高亮由 active 类名现成完成，但内链跳转后目标行可能
   * 落在滚动容器可视区之外（左栏 overflow-y-auto），用户看不到"选中了"。
   * 为什么带可选链：jsdom 无 scrollIntoView（全局 stub 见 jest.setup.js），
   * 老浏览器同样可能缺实现——容错而非崩溃。
   */
  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={rowRef}
      onClick={onSelect}
      title={doc.title ? `${doc.path} — ${doc.title}` : doc.path}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
      }`}
    >
      {/* diagram doc 用 Workflow 图标区分（与 page.tsx DocTreeItem 同规；其余维持 FileText） */}
      {doc.docType === DOC_TYPE_DIAGRAM ? (
        <Workflow className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
      )}
      <span className={`min-w-0 truncate text-xs ${label.secondary ? 'shrink' : 'flex-1'}`}>
        {label.primary}
      </span>
      {label.secondary && (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {label.secondary}
        </span>
      )}
      {doc.docType && !hideBadge && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {doc.docType}
        </span>
      )}
    </button>
  );
}

/**
 * 单层目录渲染：folders + docs + 各自的「加载更多」；展开的 folder 递归渲染子层。
 * 折叠状态由父组件注入（expanded Set，key = 文件夹完整路径含尾 /），自身不持有状态。
 */
function TreeLevel({
  spaceId,
  prefix,
  expanded,
  onToggleFolder,
  activeDocId,
  activeDocPath,
  onSelectDoc,
}: {
  spaceId: string;
  prefix: string;
  expanded: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  activeDocId: string | null;
  /** 当前文档 path（null = 未就绪）：用于判断本层是否在目标祖先链上并补齐分页 */
  activeDocPath: string | null;
  onSelectDoc: (docId: string) => void;
}) {
  const t = useTranslations('docs');
  const { data, isLoading, fetchNextPage, isFetchingNextPage, isFetchNextPageError } =
    useInfiniteQuery({
      queryKey: ['docs', 'tree', spaceId, prefix],
      queryFn: ({ pageParam }) => Api.docs.getTree(spaceId, { prefix, ...pageParam }),
      initialPageParam: { foldersOffset: 0, docsOffset: 0 },
      getNextPageParam: (lastPage, _allPages, lastPageParam) => {
        // 双游标同步推进：folders/docs 各自按已收条数累加 offset（游标由 react-query
        // 管理，禁止手写数组累加）；两侧都收齐才终止（hasMore 由后端按 total 判定）
        const foldersOffset = lastPageParam.foldersOffset + lastPage.folders.items.length;
        const docsOffset = lastPageParam.docsOffset + lastPage.docs.items.length;
        if (foldersOffset >= lastPage.folders.total && docsOffset >= lastPage.docs.total) {
          return undefined;
        }
        return { foldersOffset, docsOffset };
      },
    });

  const folders = useMemo(() => data?.pages.flatMap((p) => p.folders.items) ?? [], [data]);
  const docs = useMemo(() => data?.pages.flatMap((p) => p.docs.items) ?? [], [data]);
  // 徽标降噪（2026-09-02 用户拍板）：同层已加载文档 docType 全同时隐藏整层徽标
  // （纯噪声）；混合型保留（消歧价值所在）。规则对已加载集合确定——翻页加载出
  // 异型文档后整层徽标恢复。
  const hideBadges = docs.length > 0 && new Set(docs.map((d) => d.docType ?? null)).size === 1;
  const lastPage = data?.pages[data.pages.length - 1];
  const foldersHasMore = lastPage?.folders.hasMore ?? false;
  const docsHasMore = lastPage?.docs.hasMore ?? false;
  /** 已收页数（D4 上限的计数源；也是自动翻页 effect 的必要 dep——页数变了才重判） */
  const pagesFetched = data?.pages.length ?? 0;

  // ── 自动翻页判定（全标量，deps 直用）─────────────────────────────
  /** 本层是否在目标文档的祖先链上（根层 prefix '' 恒真；startsWith 含前缀目录语义） */
  const onPath = !!activeDocPath && (prefix === '' || activeDocPath.startsWith(prefix));
  /** 目标路径去掉本层 prefix 后的剩余段（如 prefix='a/'、path='a/b.md' → 'b.md'） */
  const rest = onPath ? (activeDocPath as string).slice(prefix.length) : '';
  /** rest 不含 '/' → 目标就是本层直挂文档；否则目标在中间目录 `${prefix}${首段}/` 之下 */
  const expectDoc = onPath && !rest.includes('/');
  const expectedFolder = onPath && !expectDoc ? `${prefix}${rest.split('/')[0]}/` : null;
  /** 目标行是否已在已加载页中（高亮键 = 文档 id，与 FileRow 的 active 判定同源） */
  const docFound = docs.some((d) => d.id === activeDocId);
  /** 期望的中间目录是否已在已加载页中 */
  const folderFound = expectedFolder !== null && folders.some((f) => f.path === expectedFolder);
  /** B1 诊断去重：同一层同一目标只 warn 一次，避免每次重渲染刷屏 */
  const warnedTargetRef = useRef<string | null>(null);

  /**
   * 层内有界自动翻页：仅当本层在目标祖先链上、目标（本层直挂文档 / 期望中间目录）
   * 尚未出现在已加载页中、且该侧仍有下一页时，按需 fetchNextPage。
   *
   * 为什么放 effect 而非渲染期：fetchNextPage 是副作用，渲染期调用会触发
   * setState-during-render；effect 天然带"请求落定重渲染后重判"的收敛性。
   * 为什么 deps 必须含 activeDocPath（D10）：层是**复用重渲染**（非重挂载），
   * activeDocPath 由 null（doc 未就绪）→ 值 时若 deps 缺 path 标量，已挂载层
   * 的 effect 不会重跑，目标在第 ≥2 页时静默永不翻页（T2b 专杀该竞态）。
   * 失败护栏：isFetchNextPageError 时立即停（请求恒失败时 hasMore 恒 true，
   * 不停会变成无界重试风暴，D9）+ TREE_AUTO_PAGE_LIMIT 页数上限双保险。
   */
  useEffect(() => {
    if (!onPath) {
      warnedTargetRef.current = null;
      return;
    }
    if (isFetchingNextPage || isFetchNextPageError) return;
    const found = expectDoc ? docFound : folderFound;
    if (found) return;
    // 超限/目标不在树中 = 静默降级（祖先已展开、目标行缺席）：console.warn 打出精确诊断
    // （total 来自首页响应的全量计数，比"再翻一页试试"更有信息量；no-console 只放行 warn/error）
    const total = expectDoc ? lastPage?.docs.total : lastPage?.folders.total;
    const hasMore = expectDoc ? docsHasMore : foldersHasMore;
    const targetLabel = expectDoc ? activeDocPath : expectedFolder;
    const warn = (reason: string) => {
      if (warnedTargetRef.current === targetLabel) return;
      warnedTargetRef.current = targetLabel;
      console.warn(
        `[sidebar-tree] 目录树同步未定位到目标 ${reason}：prefix='${prefix}' target='${targetLabel}' total=${total ?? 0} 已收页数=${pagesFetched}`,
      );
    };
    if (pagesFetched >= TREE_AUTO_PAGE_LIMIT) {
      warn(`（已翻满 ${TREE_AUTO_PAGE_LIMIT} 页上限）`);
      return;
    }
    if (!hasMore) {
      // data 未就绪（首屏加载中）不算"未找到"，只有确实收齐了才判缺席
      if (data) warn('（已收齐本层，目标不在树中，可能已删除）');
      return;
    }
    void fetchNextPage();
  }, [
    activeDocPath,
    onPath,
    expectDoc,
    expectedFolder,
    docFound,
    folderFound,
    docsHasMore,
    foldersHasMore,
    isFetchingNextPage,
    isFetchNextPageError,
    pagesFetched,
    data,
    lastPage,
    prefix,
    fetchNextPage,
  ]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1 px-1 py-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {folders.map((folder) => (
        <div key={folder.path}>
          <button
            onClick={() => onToggleFolder(folder.path)}
            className="flex w-full items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <FolderTree className="h-3.5 w-3.5 text-primary/70" />
            <span className="flex-1 truncate text-left">{folder.name}</span>
            <span className="text-[10px]">{folder.docCount}</span>
          </button>
          {expanded.has(folder.path) && (
            /* 缩进线照抄分类树：子层左缩进 + 竖线分隔；展开才挂载子层查询（懒加载） */
            <div className="ml-2 space-y-0.5 border-l border-border/40 pl-2">
              <TreeLevel
                spaceId={spaceId}
                prefix={folder.path}
                expanded={expanded}
                onToggleFolder={onToggleFolder}
                activeDocId={activeDocId}
                activeDocPath={activeDocPath}
                onSelectDoc={onSelectDoc}
              />
            </div>
          )}
        </div>
      ))}
      {foldersHasMore && (
        <button
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t('detail.loadMoreFolders')}
        </button>
      )}
      {docs.map((doc) => (
        <FileRow
          key={doc.id}
          doc={doc}
          active={doc.id === activeDocId}
          hideBadge={hideBadges}
          onSelect={() => onSelectDoc(doc.id)}
        />
      ))}
      {docsHasMore && (
        <button
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t('detail.loadMore')}
        </button>
      )}
      {prefix === '' && folders.length === 0 && docs.length === 0 && (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">{t('detail.noDocs')}</p>
      )}
    </div>
  );
}

/**
 * 懒加载目录树（根层 = prefix ''，挂载即拉取；子层展开才拉取）。
 * 展开态 localStorage 持久化（docs:expanded-folders:<spaceId>），刷新后保持。
 * 调用方应传 `key={spaceId}`：换空间重挂载，内存中的展开态随空间重置（D3a）。
 */
export function SidebarTree({
  spaceId,
  activeDocId,
  activeDocPath = null,
  onSelectDoc,
}: {
  spaceId: string;
  activeDocId: string | null;
  /** 当前文档 path（null = doc 元数据未就绪）：祖先链自动展开的推导依据（D6） */
  activeDocPath?: string | null;
  onSelectDoc: (docId: string) => void;
}) {
  /** 展开集合（key = 文件夹完整路径含尾 /，如 'memory/2026-08-29/'）；默认全折叠 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /** 挂载后按 localStorage 校正展开态（useState 默认空集保证首屏与 SSR 一致，避免 hydration 闪烁） */
  useEffect(() => {
    setExpanded(loadExpandedFolders(spaceId));
  }, [spaceId]);

  /**
   * 祖先链自动展开（选中同步的核心）：目标文档的每个祖先目录加入展开集。
   *
   * 声明次序是硬约束——必须排在上面的 mount 校正 effect 之后：mount 校正是**直值 set**
   * （用存储值整体覆盖），React 同一 commit 内按 effect 声明序入队 state 更新，若本 effect
   * 排在前面，其函数式合并结果会被随后的直值 set 覆盖，祖先链展开丢失。
   *
   * deps 严格取 activeDocPath（+ spaceId，落盘 key 需要）：只在"导航到另一篇文档"时触发，
   * 因此用户手动折叠的目录不会被无关重渲染反抢（D2 只增不夺）；同目录 a.md→b.md 导航会
   * 重新展开刚折叠的目录——预期行为（T6 钉死）。
   * 函数式合并 + 同引用早退：无新增时零写入零重渲染，StrictMode 双调用幂等无害。
   */
  useEffect(() => {
    if (!activeDocPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestorPrefixes(activeDocPath)) next.add(p);
      if (next.size === prev.size) return prev; // 无新增 → 同引用早退，零写入零重渲染
      // updater 内落盘对齐 handleToggleFolder 先例：展开态语义 = 用户意图 ∪ 访问过的祖先链（D3）
      saveExpandedFolders(spaceId, next);
      return next;
    });
  }, [activeDocPath, spaceId]);

  /** 折叠切换：Set 不可变更新 + 同步写回 localStorage（同 login 页 auth:last-email 先例） */
  const handleToggleFolder = (folderPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      saveExpandedFolders(spaceId, next);
      return next;
    });
  };

  return (
    <TreeLevel
      spaceId={spaceId}
      prefix=""
      expanded={expanded}
      onToggleFolder={handleToggleFolder}
      activeDocId={activeDocId}
      activeDocPath={activeDocPath}
      onSelectDoc={onSelectDoc}
    />
  );
}
