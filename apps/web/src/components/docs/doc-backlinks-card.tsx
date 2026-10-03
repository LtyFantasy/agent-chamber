'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react';
import { extractLastHeadingSegment } from '@agent-chamber/shared';
import { Api } from '@/lib/api';
import type { DocBacklinksSource } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fileBaseName } from './doc-label';

/** 首屏渲染的来源分组数（超出部分收进「还有 N 篇」toggle，docCount ≤ 5 不渲染 toggle） */
const BACKLINKS_INITIAL_GROUPS = 5;

/**
 * 反向引用卡片 props。
 *
 * 数据来自 `GET /docs/:id/backlinks`（DocBacklinks，服务端已按来源文档分组、
 * 已剔除自引用）。卡片只负责展示与「点了去哪」的回调，导航/滚动由页面统一持有。
 */
interface DocBacklinksCardProps {
  /** 当前文档 ID；null（未选文档）不渲染——本卡的主语是「谁引用了它」 */
  docId: string | null;
  /**
   * 点击来源：组行 → 该来源文档**首处命中 section**；逐处行 → **该处 section**。
   *
   * headingPath 传 DTO 原始**全路径**（null = 无 heading 定位的文首段）：末段提取
   * 留给调用方——`scrollToHeading` 按渲染标题文本匹配，而渲染标题 = 末段
   * （page.tsx 搜索命中同款 `extractLastHeadingSegment`），在卡片内先截断会让
   * 「完整路径逐处进 aria-label」与「喂给滚动的是末段」两个契约混在一起。
   */
  onSelectDoc: (docId: string, headingPath?: string | null) => void;
}

/**
 * 分组级形态徽标口径：组内形态**一致**才显示徽标（全相对路径 → 相对路径；
 * 全平台链接 → 平台链接），**混合组不显示**——混合是真实存在的形态
 * （同一篇文档既有相对 .md 链接又有 /docs/...?doc= 平台链接），
 * 二选一的徽标会撒谎。形态逐处信息在 aria-label 里完整给出。
 *
 * 中性色（subtle/outline）是刻意的：琥珀在本页语义已被「断链」占用
 * （linkHealth 卡），形态是中性事实不是告警。
 */
function groupFormLabel(source: DocBacklinksSource): 'pathBased' | 'platform' | null {
  const allPathBased = source.links.every((link) => link.isPathBased);
  if (allPathBased) return 'pathBased';
  if (source.links.every((link) => !link.isPathBased)) return 'platform';
  return null;
}

/**
 * 文档详情页右栏「被引用」卡片（v1.90.0-dev）。
 *
 * 回答「这篇文档被谁引用了、在哪些 section 引用」：
 * - 组 = 来源文档（首屏 5 组，超出收进「还有 N 篇」toggle，可收起）；
 * - 组行可展开为逐处行（组内 > 1 处才给展开入口——单处时 section 已在组行上，
 *   href/形态/「移动后需改写」进组行 aria-label，无信息缺口）；
 * - 组行点击 → 来源文档首处命中 section；逐处行点击 → 该处 section。
 *
 * 语义结构：`ul > li > div[button, button]`——**不嵌套可点元素**（本页血泪先例：
 * button 套 button 触发 hydration 报错，见 page.tsx 返回按钮注释）。
 */
export function DocBacklinksCard({ docId, onSelectDoc }: DocBacklinksCardProps) {
  const t = useTranslations('docs.backlinks');
  const tGlobal = useTranslations();
  /** 「还有 N 篇」展开态（true = 全量组；false = 首屏 5 组） */
  const [showAllSources, setShowAllSources] = useState(false);
  /** 已展开逐处行的来源文档 id 集合 */
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  /**
   * 切文档复位两个展开态：来源集合整体换人，沿用旧 docId 的展开集合会 bleed 到
   * 新文档（copied 态复位同型先例，page.tsx 的 markdownCopied effect）。
   */
  useEffect(() => {
    setShowAllSources(false);
    setExpandedSources(new Set());
  }, [docId]);

  /**
   * 反向引用查询（queryKey 前缀 `['docs','backlinks']` 与页面三处失效接线对齐）。
   *
   * - **显式偏离全局默认**（providers.tsx `refetchOnWindowFocus: true`）：本查询是
   *   服务端**全空间反扫**（逐篇重建正文做链接匹配），代价远高于普通列表查询，
   *   窗口焦点抖动不该触发重扫；新鲜度改由显式失效接线保证——左栏/正文编辑
   *   （upsertMutation）与空间级回导（invalidateSpace / invalidateSpaceContent）
   *   都会失效 `['docs','backlinks']` 前缀。staleTime 5min 与全局默认同值。
   * - 加载判定用 `isLoading` 而非 `isPending`：v5 里 disabled 查询的 `isPending`
   *   恒为 true（`isLoading = isPending && isFetching`，docId 为空时不该显示骨架）。
   */
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['docs', 'backlinks', docId],
    queryFn: () => Api.docs.getBacklinks(docId as string),
    enabled: !!docId,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  /** 未选文档：本卡无主语，整卡不渲染（hook 之后早退，不违反 hooks 规则） */
  if (!docId) return null;

  const sources = data?.sources ?? [];
  const visibleSources = showAllSources ? sources : sources.slice(0, BACKLINKS_INITIAL_GROUPS);
  const hiddenCount = sources.length - visibleSources.length;

  /** section 显示名：命中处 headingPath 末段；无 heading 定位 → 「文首」 */
  const sectionLabel = (headingPath: string | null | undefined) =>
    headingPath ? extractLastHeadingSegment(headingPath) || t('noHeading') : t('noHeading');

  /** 形态徽标文案（pathBased / platform 两个受控值 → 中性 Badge）；混合组调用方不渲染 */
  const formLabel = (form: 'pathBased' | 'platform') =>
    form === 'pathBased' ? t('pathBasedBadge') : t('platformBadge');

  /**
   * 单处引用的 aria 描述片段：section 末段 · href · 形态（· 移动后需改写）。
   * 「移动后需改写」只进 aria-label——相对 .md 链接在来源文档被 move 后会断，
   * 是行动信息；上屏会与断链琥珀色抢视觉层级。
   */
  const linkTarget = (link: DocBacklinksSource['links'][number]) =>
    [
      sectionLabel(link.headingPath),
      link.href,
      formLabel(link.isPathBased ? 'pathBased' : 'platform'),
      ...(link.isPathBased ? [t('pathBasedHint')] : []),
    ].join(' · ');

  /**
   * 行 aria-label（单条参数化模板，组行与逐处行共用）：
   * 完整 path / 逐处 headingPath / href / 形态一次给全，屏幕阅读器不丢契约字段。
   */
  const rowAria = (source: DocBacklinksSource, links: DocBacklinksSource['links']) =>
    t('rowAria', {
      title: source.sourceTitle,
      path: source.sourcePath,
      count: links.length,
      targets: links.map(linkTarget).join('; '),
    });

  /** 展开/收起某一来源的逐处行 */
  const toggleSource = (sourceDocId: string) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(sourceDocId)) next.delete(sourceDocId);
      else next.add(sourceDocId);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-border/50 p-3">
      {/* 标题：数据态带双计数（篇 = 来源文档数 / 处 = 入链条目数），
          加载与错误态没有可信数字 → 用无计数标题（不拿 0 冒充已知） */}
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <CornerDownRight className="h-4 w-4 text-primary" />
        {isLoading || isError || !data
          ? t('titlePlain')
          : t('title', { docCount: data.docCount, linkCount: data.linkCount })}
      </h3>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {isLoading ? (
          /* 固定高三行骨架（3 × h-4）：三态切换不改变卡片高度，右栏不跳 */
          <div className="space-y-1.5" data-testid="backlinks-skeleton">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : isError ? (
          /* 紧凑错误行：复用 common.retry（不新增 retry 键）；请求中禁用防连点 */
          <div className="flex items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">{t('error')}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {tGlobal('common.retry')}
            </Button>
          </div>
        ) : sources.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {visibleSources.map((source) => {
                const expanded = expandedSources.has(source.sourceDocId);
                const firstHeadingPath = source.links[0]?.headingPath ?? null;
                const form = groupFormLabel(source);
                return (
                  <li key={source.sourceDocId}>
                    <div className="flex items-start gap-1 rounded">
                      {/* 组行：整行可点 → 来源文档首处命中 section */}
                      <button
                        type="button"
                        className="min-w-0 flex-1 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-accent"
                        title={source.sourceTitle}
                        aria-label={rowAria(source, source.links)}
                        onClick={() => onSelectDoc(source.sourceDocId, firstHeadingPath)}
                      >
                        <span className="block truncate text-xs text-foreground">
                          {fileBaseName(source.sourcePath)}
                        </span>
                        <span className="block truncate text-[11px]">
                          {sectionLabel(firstHeadingPath)}
                          {/* 「N 处」单条参数化消息并入同一文本节点：拆 span 会让裸数字
                              成为独立元素（页面测试的裸数字断言会 multiple elements） */}
                          {source.links.length > 1
                            ? ` · ${t('hits', { count: source.links.length })}`
                            : ''}
                        </span>
                      </button>
                      {/* 组级形态徽标（混合组不渲染；外层，避免 button 内嵌 div） */}
                      {form && (
                        <Badge variant="subtle" className="mt-0.5 shrink-0 text-[10px]">
                          {formLabel(form)}
                        </Badge>
                      )}
                      {/* 逐处展开开关（组内仅 1 处不给入口——section 已在组行上） */}
                      {source.links.length > 1 && (
                        <button
                          type="button"
                          className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          aria-expanded={expanded}
                          /* 可访问名 = 「来源标题 · N 处」：只用「N 处」会让同页多个
                             两处组重名（读屏用户分不清展开的是哪一篇） */
                          aria-label={`${source.sourceTitle} · ${t('hits', {
                            count: source.links.length,
                          })}`}
                          onClick={() => toggleSource(source.sourceDocId)}
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                    {/* 逐处行：点此处 → 该处 section */}
                    {expanded && (
                      <ul className="ml-2 mt-0.5 space-y-0.5 border-l border-border/40 pl-2">
                        {source.links.map((link, index) => (
                          <li key={`${link.href}-${index}`} className="flex items-start gap-1">
                            <button
                              type="button"
                              className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] transition-colors hover:bg-accent hover:text-foreground"
                              title={link.headingPath ?? undefined}
                              aria-label={rowAria(source, [link])}
                              onClick={() =>
                                onSelectDoc(source.sourceDocId, link.headingPath ?? null)
                              }
                            >
                              {sectionLabel(link.headingPath)}
                            </button>
                            <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
                              {formLabel(link.isPathBased ? 'pathBased' : 'platform')}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* 首屏 5 组之外的余量开关（docCount ≤ 5 不渲染；可收起） */}
            {sources.length > BACKLINKS_INITIAL_GROUPS && (
              <button
                type="button"
                className="w-full rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => setShowAllSources((prev) => !prev)}
              >
                {showAllSources ? t('collapse') : t('expandMore', { count: hiddenCount })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
