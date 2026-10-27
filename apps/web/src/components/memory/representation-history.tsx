/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **版本历史块**：同一条引擎记忆在**同一分辨率**下的旧表示（revision）列表
 *
 * [代码职责]
 *   - 手动展开后才发请求（钻取层级：不展开零成本）；块标题显示当前 resolution 并允许切 R0–R4
 *   - 条目 = 单行摘要（`line-clamp-2` preview + created_at），点条目交给外层开正文 Dialog
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §19.20（history 契约）+ docs/spec.md Memory 节
 *   - 实现蓝本: plan §4.2「representation-history.tsx」段 + F9/N12/N20
 *
 * [关键不变量]
 *   - **history ≠ 更正链**（官方回信）：本块是"同记忆同分辨率的旧版本"，取代关系是
 *     "跨记忆的 supersedes 链"（另一块）。空态文案必须把这条讲清楚——两者混着理解会让
 *     读者以为"没有旧版本 = 没有历史"
 *   - **`items[].current` 恒 `false`，UI 不渲染该标记**（F9）：引擎只查 `is_current = 0`，
 *     渲染一个恒假的分支等于给读者一个永远不变的假信息
 *   - **空是合法常态**（P2）：只有"同一记忆在同一分辨率下被重新形成"才会产生旧版本，
 *     空态要说明而不是报错
 *   - **默认折叠**：它是下钻面，常驻展开会在右栏堆出一长条与主线无关的记录
 *   - 未展开 / 无引擎记忆时**零请求**：`enabled` 同时看展开态与 `engineMemoryId`
 *
 * [关联代码]
 *   - ./resolution-ladder.tsx — 历史出口的触发方（点槽 → 展开本块并切 resolution）
 *   - ./representation-body-dialog.tsx — 条目正文的落点（② 按 id 取态）
 *   - ../../lib/api.ts — `memoryViewHistory`
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认没有把更正链的语义混进本块
 *   □ 新增字段展示前核对契约（本块字段全部来自 history 响应）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from 'next-intl';
import {
  MEMORY_GRAPH_RESOLUTIONS,
  memoryUnavailableReasonKind,
  memoryUnavailableReasonOf,
  memoryViewErrorKind,
  type MemoryViewHistoryItem,
} from '@/lib/memory';
import { MemoryEngineBanner } from '@/components/memory/engine-status';
import { cn, formatDate } from '@/lib/utils';

interface RepresentationHistoryProps {
  projectId: string;
  /** 引擎记忆 id（null = 本行还没有引擎记忆 ⇒ 只显示说明，**不发请求**） */
  engineMemoryId: string | null;
  /**
   * 没有引擎记忆的**成因**（m6）：`notFormed` = 还没形成；`metadataOnly` = 仅元数据可见
   * （引擎投影同样要内容读权限）。两种成因的下一步动作不同，共用一句文案会误导。
   */
  noEngineCause?: 'notFormed' | 'metadataOnly';
  /** 当前查看的 resolution */
  resolution: string;
  onResolutionChange: (resolution: string) => void;
  /** 展开态（受控：点阶梯的历史出口要能把它展开并滚到目标分辨率） */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** 点条目 → 外层开正文 Dialog（按 representation_id 取正文） */
  onOpenBody: (item: MemoryViewHistoryItem) => void;
  className?: string;
}

/**
 * 版本历史块（详情页右栏第三段）。
 *
 * 折叠态只渲染标题行 + 展开按钮；展开后才打 history 端点。`resolution` 由外层持有，
 * 这样"点阶梯的某个槽"能直接切到那一层（N12）。
 */
export function RepresentationHistory({
  projectId,
  engineMemoryId,
  noEngineCause = 'notFormed',
  resolution,
  onResolutionChange,
  expanded,
  onExpandedChange,
  onOpenBody,
  className,
}: RepresentationHistoryProps) {
  const t = useTranslations('memory');
  const locale = useLocale();

  const query = useQuery({
    queryKey: ['memory', 'view-history', projectId, engineMemoryId, resolution],
    queryFn: () => Api.memory.memoryViewHistory(projectId, engineMemoryId as string, resolution),
    // 折叠 / 无引擎记忆时零请求（钻取层级）
    enabled: expanded && !!engineMemoryId,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const errorKind = memoryViewErrorKind(query.error);
  const items = query.data?.engine.items ?? [];

  return (
    <section
      className={cn('glass-flat space-y-3 rounded-lg border border-border/60 p-4', className)}
      data-testid="memory-representation-history"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t('representations.title')}
          </h2>
          {/* 常驻副标题（F8）：与"更正链"分属两条动线 */}
          <p className="text-[11px] text-muted-foreground/80">{t('representations.subtitle')}</p>
        </div>
        {engineMemoryId && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="memory-representation-history-toggle"
            aria-expanded={expanded}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? (
              <ChevronDown className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {expanded ? t('representations.collapse') : t('representations.expand')}
          </Button>
        )}
      </div>

      {/* 本行还没有引擎记忆（withdrawn / no_memory / 未形成）：零请求，只说清楚 */}
      {!engineMemoryId && (
        <p className="text-xs text-muted-foreground" data-testid="memory-representation-no-engine">
          {noEngineCause === 'metadataOnly'
            ? t('detail.noEngineMemoryMetadata')
            : t('detail.noEngineMemory')}
        </p>
      )}

      {engineMemoryId && expanded && (
        <>
          {/* resolution 切换（默认由外层给成 ladder 的 active 槽，N12） */}
          <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t('representations.resolutionLabel')}</span>
            <select
              data-testid="memory-representation-resolution"
              value={resolution}
              onChange={(event) => onResolutionChange(event.target.value)}
              className="h-7 rounded-md border border-input bg-background/60 px-2 text-[11px]"
            >
              {MEMORY_GRAPH_RESOLUTIONS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          {query.isLoading && (
            <div className="space-y-2" data-testid="memory-representation-history-loading">
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          )}

          {!query.isLoading && query.isError && (
            <>
              {errorKind.engineUnavailable ? (
                <MemoryEngineBanner
                  kind={memoryUnavailableReasonKind(memoryUnavailableReasonOf(query.error))}
                  runtime
                />
              ) : (
                <div className="space-y-2" data-testid="memory-representation-history-error">
                  <p className="text-xs text-muted-foreground">
                    {errorKind.notFound
                      ? t('detail.engineViewUnavailable')
                      : t('representations.dialog.errorOther')}
                  </p>
                  {!errorKind.notFound && (
                    <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t('representations.retry')}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}

          {!query.isLoading && !query.isError && items.length === 0 && (
            // 空是合法常态（P2）：文案必须说明成因，并与"更正链"划清界限
            <div className="space-y-1" data-testid="memory-representation-history-empty">
              <p className="text-xs text-muted-foreground">{t('representations.emptyTitle')}</p>
              <p className="text-[11px] text-muted-foreground/80">
                {t('representations.emptyDesc')}
              </p>
            </div>
          )}

          {items.length > 0 && (
            <ul className="space-y-1" data-testid="memory-representation-history-list">
              {items.map((item, index) => (
                <li key={item.representation_id}>
                  <button
                    type="button"
                    data-testid="memory-representation-history-item"
                    aria-label={t('representations.entryAria', {
                      index: index + 1,
                      total: items.length,
                      createdAt: formatDate(item.created_at, locale),
                    })}
                    onClick={() => onOpenBody(item)}
                    className="w-full space-y-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {/* 单行摘要（N20）：完整预览进 Dialog，列表里 line-clamp-2 就够 */}
                    <span className="line-clamp-2 block text-xs">{item.preview}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/80">
                      <span>{formatDate(item.created_at, locale)}</span>
                      <span>· {item.resolution}</span>
                      <span>· {t('representations.bytes', { bytes: item.original_bytes })}</span>
                      {item.preview_truncated && (
                        <span className="text-amber-300">
                          {t('representations.previewTruncated')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
