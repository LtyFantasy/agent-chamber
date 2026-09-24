'use client';

/**
 * 左栏文档树组件（DocTreeItem + CategorySection）。
 *
 * 自 docs/[id]/page.tsx 抽取（前端债包批次 4 子项 2 commit 6）——纯展示 + 懒加载列表，
 * 无页面级闭包依赖：DocTreeItem 三 props（docItem/active/onSelect），CategorySection
 * 九 props（spaceId/slug/name/count/collapsed/onToggle/activeDocId/activeCategorySlug/onSelectDoc）。
 * 纯函数（normalizeHeadingText/scrollToHeading/formatBytes）按 plan 钉死留在页面，
 * 本文件不搬——normalizeHeadingText 唯一消费方是页面级 scrollToHeading。
 */

import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { FolderTree, Workflow, FileText } from 'lucide-react';
import { DOC_TYPE_DIAGRAM } from '@agent-chamber/shared';
import { Api } from '@/lib/api';
import type { DocSummary } from '@/types';
import { docDisplayLabel } from '@/components/docs/doc-label';

/** 单分类自动翻页页数上限（同 sidebar-tree 的 TREE_AUTO_PAGE_LIMIT 口径）：
 *  分类默认 50/页 → 500 条封顶，超限即停（D4 有界原则） */
const CATEGORY_AUTO_PAGE_LIMIT = 10;

interface DocTreeItemProps {
  /** 文档摘要（path/title 行标签 + docType 徽章数据源） */
  docItem: DocSummary;
  /** 选中态（青光描边） */
  active: boolean;
  /** 徽标降噪：同组文档 docType 全同时置 true（如 memory/ 下整组 memory 徽标纯噪声） */
  hideBadge?: boolean;
  /** 点击选中回调 */
  onSelect: () => void;
}

/** 左栏文档项：文件名主标签 + 标题辅标签（去重见 doc-label）+ type badge，选中态青光描边 */
function DocTreeItem({ docItem, active, hideBadge = false, onSelect }: DocTreeItemProps) {
  const label = docDisplayLabel(docItem);
  /** 行 DOM 引用：选中态落到本行时把它滚进可视区（见下方 effect） */
  const rowRef = useRef<HTMLButtonElement>(null);

  /**
   * 选中行滚动到可视区（与目录树 FileRow 同规）：高亮由 active 类名现成完成，
   * 但内链跳转/切换文档后目标行可能落在滚动容器可视区外，需显式滚近。
   * 可选链容错：jsdom 无 scrollIntoView（全局 stub 见 jest.setup.js），老浏览器同样可能缺实现。
   */
  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={rowRef}
      onClick={onSelect}
      title={docItem.title ? `${docItem.path} — ${docItem.title}` : docItem.path}
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
      }`}
    >
      {/* diagram doc 用 Workflow 图标区分（Diagram IR v1）；其余维持 FileText */}
      {docItem.docType === DOC_TYPE_DIAGRAM ? (
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
      {docItem.docType && !hideBadge && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {docItem.docType}
        </span>
      )}
    </button>
  );
}

interface CategorySectionProps {
  /** DocSpace UUID（分类文档查询 + queryKey 键） */
  spaceId: string;
  /** 分类 slug（?category= 查询参数） */
  slug: string;
  /** 分类显示名 */
  name: string;
  /** facets 计数（行尾展示） */
  count: number;
  /** 折叠态（父组件注入，会话内记忆） */
  collapsed: boolean;
  /** 折叠切换回调 */
  onToggle: () => void;
  /** 当前选中文档 id（高亮） */
  activeDocId: string | null;
  /**
   * 当前文档所属分类 slug（page.tsx 由 doc.categoryId ⋈ categories 现算；null = 未就绪/未分类）。
   * 自动翻页的**首条 gate**：只有命中分类才有必要翻页——缺它会把所有分类都翻到底（D8）。
   */
  activeCategorySlug?: string | null;
  /** 文档选中回调 */
  onSelectDoc: (docId: string) => void;
}

/**
 * 分类模式单分类区块（懒加载，v1.70.0-dev）：行 = 分类名 + facets 计数；
 * 展开才挂载 ?category=slug 分页查询（useInfiniteQuery 游标翻页 + 加载更多）。
 * 折叠状态由父组件注入（collapsedCats，会话内记忆，与旧分类树行为一致）。
 */
function CategorySection({
  spaceId,
  slug,
  name,
  count,
  collapsed,
  onToggle,
  activeDocId,
  activeCategorySlug = null,
  onSelectDoc,
}: CategorySectionProps) {
  const t = useTranslations('docs');
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } =
    useInfiniteQuery({
      queryKey: ['docs', 'category-docs', spaceId, slug],
      queryFn: ({ pageParam }) =>
        Api.docs.listDocs(spaceId, { category: slug, page: pageParam, pageSize: 50 }),
      initialPageParam: 1,
      getNextPageParam: (lastPage) => (lastPage.hasNext ? lastPage.page + 1 : undefined),
      enabled: !collapsed,
    });
  const catDocs = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  // 徽标降噪（与目录树同规）：同组已加载文档 docType 全同时隐藏整组徽标；混合保留
  const hideBadges =
    catDocs.length > 0 && new Set(catDocs.map((d) => d.docType ?? null)).size === 1;

  /** 本分类是否命中当前文档（D8 gate 首条） */
  const isActiveCategory = activeCategorySlug !== null && slug === activeCategorySlug;
  /** 目标行是否已在已加载页中（高亮键 = 文档 id，与 DocTreeItem 的 active 判定同源） */
  const found = catDocs.some((d) => d.id === activeDocId);
  /** 已收页数（上限计数源 + effect 必要的重判触发） */
  const pagesFetched = data?.pages.length ?? 0;

  /**
   * 分类内有界自动翻页：选中文档在命中分类中但尚未出现在已加载页时逐页补齐，
   * 直到出现/耗尽/错误/超限。deps 必须含 activeDocId（D10 同款竞态：分类区块是
   * 复用重渲染，目标 doc 未就绪 → 就绪时不重跑会静默永不翻页）与 pagesFetched。
   * 折叠态（查询 disabled）时 data 为空、hasNextPage 为 undefined，天然不翻页。
   */
  useEffect(() => {
    if (!isActiveCategory || !activeDocId) return;
    if (found || isFetchingNextPage || isFetchNextPageError) return;
    if (pagesFetched >= CATEGORY_AUTO_PAGE_LIMIT) {
      console.warn(
        `[doc-tree] 分类同步未定位到目标（已翻满 ${CATEGORY_AUTO_PAGE_LIMIT} 页上限）：slug='${slug}' total=${data?.pages[0]?.total ?? 0}`,
      );
      return;
    }
    if (!hasNextPage) {
      // data 未就绪（折叠 / 首屏加载中）不算"未找到"，只有确实收齐了才判缺席
      if (data) {
        console.warn(
          `[doc-tree] 分类同步未定位到目标（已收齐该分类，文档可能不在本分类或已删除）：slug='${slug}' total=${data.pages[0]?.total ?? 0}`,
        );
      }
      return;
    }
    void fetchNextPage();
  }, [
    isActiveCategory,
    activeDocId,
    found,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    pagesFetched,
    data,
    slug,
    fetchNextPage,
  ]);

  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <FolderTree className="h-3.5 w-3.5 text-primary/70" />
        <span className="flex-1 truncate text-left">{name}</span>
        <span className="text-[10px]">{count}</span>
      </button>
      {!collapsed && (
        <div className="ml-2 space-y-0.5 border-l border-border/40 pl-2">
          {catDocs.map((d) => (
            <DocTreeItem
              key={d.id}
              docItem={d}
              active={d.id === activeDocId}
              hideBadge={hideBadges}
              onSelect={() => onSelectDoc(d.id)}
            />
          ))}
          {hasNextPage && (
            <button
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent"
            >
              {t('detail.loadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export { DocTreeItem, CategorySection };
