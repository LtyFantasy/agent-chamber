/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 记忆表示正文 Dialog：单份表示（当前层级 / 历史版本）的**纯文本**阅读面
 *
 * [代码职责]
 *   - 两种数据来源共用一份实现（plan §4.2 N11）：
 *     ① `body` 直给 —— 阶梯 `current` 槽的正文（**数据已在手，零请求**）；
 *     ② `fetchTarget` —— 历史条目的正文（按 `representationId` 打一次 representation 端点）
 *   - 三态自带：loading / 404「引擎投影当前不可读」/ 其它错误 + 重试
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §19.21（representation 契约）+ docs/frontend/ui-design-system.md §3
 *   - 实现蓝本: plan §4.2「representation-body-dialog.tsx」段 + N11
 *
 * [关键不变量]
 *   - **正文是纯文本快照，走 `whitespace-pre-wrap`**：不走 markdown、不注入 HTML
 *     （≤64KiB 的引擎正文，markdown 渲染等于给一份不可信文本开一条渲染面）
 *   - **404 与其它错误分开**（plan §4.2 M10）：404 = 该记忆的引擎投影当前不可读（映射缺失 /
 *     来源不可见，是**常态路径**），给它一个"重试"按钮是死胡同；其它错误才给重试
 *   - **当前槽的正文不发请求**（M5）：detail 响应的 `ladder[].current` 就是完整正文，
 *     再打一次 representation 端点是拿延迟换一份已经到手的数据
 *   - `body_truncated` 必须显式标注（不吞）：读者要知道手上的正文不是全文
 *   - Esc / 焦点还原走共享的 `useDismissableLayer`（第三处复制起就抽，见 plan §4.1）
 *
 * [关联代码]
 *   - ./resolution-ladder.tsx — ① 的调用方（当前槽）
 *   - ./representation-history.tsx — ② 的调用方（历史条目）
 *   - ../ui/dialog.tsx — 壳（遮罩 + 玻璃卡）
 *   - ../../lib/use-dismissable-layer.ts — Esc + 焦点还原
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认正文渲染仍是纯文本 pre-wrap（禁 markdown / dangerouslySetInnerHTML）
 *   □ 新增错误分支必须能落到"下一步动作"（重试 / 回账本），不做无出口的报错
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
'use client';

import { useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Api } from '@/lib/api';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/ui/loading';
import { useDismissableLayer } from '@/lib/use-dismissable-layer';
import { memoryViewErrorKind } from '@/lib/memory';

/** 直接给的正文（当前槽：数据已在 detail 响应里，零请求） */
export interface DirectRepresentationBody {
  text: string;
  truncated: boolean;
  bytes: number;
}

/** 按 id 取正文（历史条目：发一次 representation 请求） */
export interface FetchedRepresentationTarget {
  projectId: string;
  engineMemoryId: string;
  representationId: string;
}

interface RepresentationBodyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题（调用方按 i18n 拼好：「当前正文（R0）」/「历史版本 · 时间」） */
  title: string;
  /** ① 直接给正文；与 `fetchTarget` 二选一 */
  body?: DirectRepresentationBody;
  /** ② 按 id 取正文；与 `body` 二选一 */
  fetchTarget?: FetchedRepresentationTarget;
}

/**
 * 表示正文 Dialog。
 *
 * @param props - 见 `RepresentationBodyDialogProps`（`body` 与 `fetchTarget` 二态）
 */
export function RepresentationBodyDialog({
  open,
  onOpenChange,
  title,
  body,
  fetchTarget,
}: RepresentationBodyDialogProps) {
  const t = useTranslations('memory');
  const closeRef = useRef<HTMLButtonElement>(null);

  /** 只有"按 id 取"这一态才发请求；`body` 直给时 `enabled:false` ⇒ 零请求 */
  const query = useQuery({
    queryKey: [
      'memory',
      'view-representation',
      fetchTarget?.projectId,
      fetchTarget?.engineMemoryId,
      fetchTarget?.representationId,
    ],
    queryFn: () =>
      Api.memory.memoryViewRepresentation(
        (fetchTarget as FetchedRepresentationTarget).projectId,
        (fetchTarget as FetchedRepresentationTarget).engineMemoryId,
        (fetchTarget as FetchedRepresentationTarget).representationId,
      ),
    enabled: open && !!fetchTarget,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useDismissableLayer({
    open,
    onDismiss: () => onOpenChange(false),
    initialFocus: closeRef,
  });

  if (!open) return null;

  const fetched = query.data?.engine.representation;
  const text = body?.text ?? fetched?.body ?? '';
  const truncated = body?.truncated ?? fetched?.body_truncated ?? false;
  const bytes = body?.bytes ?? fetched?.original_bytes ?? 0;
  const errorKind = memoryViewErrorKind(query.error);
  /** 只有"按 id 取"这一态才可能处于 loading / error */
  const pending = !!fetchTarget && (query.isLoading || query.isFetching) && !fetched;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle data-testid="memory-representation-dialog-title">{title}</DialogTitle>
      </DialogHeader>
      <div className="mt-3 max-h-[60vh] overflow-y-auto">
        {pending ? (
          <Loading className="py-8" />
        ) : query.isError ? (
          errorKind.notFound ? (
            // 常态路径（映射缺失 / 来源不可见）：给重试是死胡同，只说明
            <p className="text-sm text-muted-foreground" data-testid="memory-representation-404">
              {t('representations.dialog.unavailable')}
            </p>
          ) : (
            <div className="space-y-2" data-testid="memory-representation-error">
              <p className="text-sm text-destructive">{t('representations.dialog.errorOther')}</p>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t('representations.dialog.retry')}
              </Button>
            </div>
          )
        ) : (
          <>
            {truncated && (
              <p
                className="mb-2 inline-flex items-center gap-1.5 text-xs text-amber-300"
                data-testid="memory-representation-truncated"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('representations.dialog.bodyTruncated', { bytes })}
              </p>
            )}
            {/* 纯文本 pre-wrap：引擎正文是快照，保行结构本身就是信息（禁 markdown） */}
            <div
              className="whitespace-pre-wrap break-words text-sm leading-relaxed"
              data-testid="memory-representation-body"
            >
              {text}
            </div>
          </>
        )}
      </div>
      <DialogFooter>
        <Button ref={closeRef} variant="outline" type="button" onClick={() => onOpenChange(false)}>
          {t('representations.dialog.close')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
