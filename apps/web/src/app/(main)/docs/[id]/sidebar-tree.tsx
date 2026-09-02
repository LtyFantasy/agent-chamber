/**
 * 左栏目录树（docs 空间详情页「目录」视图模式）——懒加载版（v1.70.0-dev）。
 *
 * - 数据源：GET /doc-spaces/:id/docs/tree（按 prefix 返回当前层子目录 + 直挂文档）
 * - 每个 prefix 一条 useInfiniteQuery（queryKey ['docs','tree',spaceId,prefix]）：
 *   展开目录才挂载子层查询（懒加载触发）；文档/目录「加载更多」共用同一查询的
 *   fetchNextPage——pageParam = { foldersOffset, docsOffset } 双游标由 react-query
 *   管理（禁止手写 offset 累加数组），两侧都收齐才终止
 * - 目录默认全折叠 + localStorage 持久化展开态（key docs:expanded-folders，
 *   照 SIDEBAR_MODE_KEY 先例：SSR 无 localStorage，挂载后校正）
 * - 文件夹行显示 docCount（后端递归后代聚合，一眼看到体量）
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { FileText, FolderTree, Loader2, Workflow } from 'lucide-react';
import { Api } from '@/lib/api';
import { DOC_TYPE_DIAGRAM, type DocTreeDoc } from '@agent-chamber/shared';
import { docDisplayLabel } from '@/components/docs/doc-label';

/** 展开态 localStorage key（照 SIDEBAR_MODE_KEY 先例；SSR 无 localStorage，挂载后校正） */
const EXPANDED_FOLDERS_KEY = 'docs:expanded-folders';

/** 读取持久化展开集合（仅浏览器调用；无数据/解析失败 → 空集 = 默认全折叠） */
function loadExpandedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_FOLDERS_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 写回展开集合（JSON 数组；写失败静默——持久化是增强，不阻塞交互） */
function saveExpandedFolders(set: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // 隐私模式/配额满等场景静默降级为会话内记忆
  }
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
  return (
    <button
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
  onSelectDoc,
}: {
  spaceId: string;
  prefix: string;
  expanded: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  activeDocId: string | null;
  onSelectDoc: (docId: string) => void;
}) {
  const t = useTranslations('docs');
  const { data, isLoading, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
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
 * 展开态 localStorage 持久化（docs:expanded-folders），刷新后保持。
 */
export function SidebarTree({
  spaceId,
  activeDocId,
  onSelectDoc,
}: {
  spaceId: string;
  activeDocId: string | null;
  onSelectDoc: (docId: string) => void;
}) {
  /** 展开集合（key = 文件夹完整路径含尾 /，如 'memory/2026-08-29/'）；默认全折叠 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /** 挂载后按 localStorage 校正展开态（useState 默认空集保证首屏与 SSR 一致，避免 hydration 闪烁） */
  useEffect(() => {
    setExpanded(loadExpandedFolders());
  }, []);

  /** 折叠切换：Set 不可变更新 + 同步写回 localStorage（同 login 页 auth:last-email 先例） */
  const handleToggleFolder = (folderPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      saveExpandedFolders(next);
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
      onSelectDoc={onSelectDoc}
    />
  );
}
