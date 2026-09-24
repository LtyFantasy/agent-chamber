/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 空间级 bundle 回导 UI（选择文件 → 预检预览 → 回导 → 结果五态机）
 *
 * [代码职责]
 *   - 承载「导入 bundle」的全流程：本地预检（零网络请求即拦截非法/超限文件）、
 *     影响面预览（覆盖篇数三态 + 危险区）、回导请求、按真实 API 字段渲染结果与失败并集
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/product-overview.md` — DocSpace 空间导入/导出一节
 *   - 补充: 线上 `docs/api-definition.md` — POST /doc-spaces/:id/import-bundle（六阶段 + 幂等契约）
 *
 * [关键不变量]
 *   - 请求体体积判据与 errorKey→文案表一律取自 `lib/doc-bundle.ts`（唯一权威），本文件不另立
 *   - **同 bundle 重导幂等**（服务端契约）：故 error/done 态的「重试」直接重发同一 bundle，不重读文件
 *   - 六阶段非整体事务 → 失败/中断都可能已部分落库，文案必须如实告知「可能已部分写入」（正面利用幂等）
 *   - importing 阶段禁止关闭（Esc 与遮罩点击同走 handleOpenChange 守卫）
 *   - 覆盖篇数 CTA 永不携带未核实的数字：path 拉取失败 = 无数字 + 确认按钮禁用
 *   - 结果面板字段名严格对照 `doc-bundle.service.ts:226-283`：categories/routes 只有三态（无 unchanged）
 *
 * [关联代码]
 *   - `apps/web/src/lib/doc-bundle.ts` — 预检 / 体积口径 / errorKey 文案表（纯函数）
 *   - `apps/web/src/app/(main)/docs/[id]/page.tsx` — 宿主（onImported → 空间+正文类查询整类失效）
 *   - `apps/backend/src/modules/docspace/doc-bundle.service.ts:226-283` — 回导结果形状权威
 *
 * [持久踩坑]
 *   - BUNDLE-DLG-1(覆盖篇数): path 列表按 5 页 × 100 有界拉取，超过即为下界。
 *     安全方向：用 `space.docCount` 交叉校验，截断时文案降级为「至少覆盖 N 篇」，不得报精确数；
 *     核对中/核对失败时 CTA 一律回退**无数字**文案（不得把未知渲染成 0）
 *   - BUNDLE-DLG-2(类型层级): axios 经 apiRequest 解包后返回的就是 bundle 本体，
 *     照抄监控页写 `bundle.data` 会拿到 undefined（监控页的 `result.data` 是响应体自带字段）
 *   - BUNDLE-DLG-3(文件即不可信输入): bundle 文本来自用户文件，任何条目都可能是 null/标量。
 *     安全方向：形状判定一律走 `lib/doc-bundle.ts`（预检 + 计数函数已全函数化），
 *     调用侧再包 try/catch 双保险——预检漏网不得表现为「点了没反应」
 *   - BUNDLE-DLG-4(live FileList): 浏览器 `input.files` 是 live 引用——先 `value=''` 重置
 *     会把已捕获的 FileList 一起清空（选择静默无响应，2026-09-15 Playwright 实证）。
 *     安全方向：**先取 file/快照再重置**；jsdom FileList 非 live，单测测不出此顺序依赖
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, FileJson, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Api } from '@/lib/api';
import { confirm } from '@/lib/notify';
import { useNotificationStore } from '@/stores/notification.store';
import { Visibility } from '@/types';
import type { DocSpaceExportBundle, DocSpaceImportBundleResult } from '@/types';
import {
  BUNDLE_ERROR_MESSAGE_KEYS,
  countMediaEntries,
  countOverwrite,
  isOverReadGuard,
  parseBundlePreview,
} from '@/lib/doc-bundle';
import type { BundleErrorKey } from '@/lib/doc-bundle';

/** 组件状态机（五态：error 态保留已解析 bundle 与勾选状态，供同包重试） */
type ImportPhase = 'selecting' | 'preview' | 'importing' | 'done' | 'error';

/** 现有 path 拉取分页上限（照 batch-upload-dialog 有界先例：5 页 × 100 = 500 条） */
const EXISTING_PATHS_MAX_PAGES = 5;
const EXISTING_PATHS_PAGE_SIZE = 100;

/** 语义色（项目事实标准）：created=emerald / updated·reused=blue / neutral（unchanged·skipped）=muted / failed=red */
type StatTone = 'created' | 'updated' | 'neutral' | 'failed';

const STAT_TONE_CLASS: Record<StatTone, { box: string; label: string; value: string }> = {
  created: { box: 'bg-emerald-500/10', label: 'text-emerald-400', value: 'text-emerald-300' },
  updated: { box: 'bg-blue-500/10', label: 'text-blue-400', value: 'text-blue-300' },
  neutral: { box: 'bg-muted/30', label: 'text-muted-foreground', value: '' },
  failed: { box: 'bg-red-500/10', label: 'text-red-400', value: 'text-red-300' },
};

/**
 * spaceMeta 状态 → 文案 key + 语义色。
 * 查表而非字符串比较：'updated' 在 no-magic-string-compare 黑名单中（ActivityAction 同值）。
 * `error` 分支当前实现无产出路径（服务端 phase ⑥ 无 try/catch，抛错即请求级 500），仅做防御性渲染。
 */
const SPACE_META_PRESENTATION: Record<
  DocSpaceImportBundleResult['spaceMeta']['status'],
  { labelKey: 'result.spaceMetaUpdated' | 'result.spaceMetaSkipped'; tone: string }
> = {
  updated: { labelKey: 'result.spaceMetaUpdated', tone: 'text-blue-300' },
  skipped: { labelKey: 'result.spaceMetaSkipped', tone: 'text-muted-foreground' },
};

/**
 * per-item 结果是否为失败。
 *
 * 收口在一处：docs 四态与 categories/routes 三态共用 'failed' 字面量，
 * 散落在渲染分支里逐个 eslint-disable 会淹没问题（'failed' 属 WebhookStatus 黑名单）。
 */
function isFailedStatus(status: string): boolean {
  // eslint-disable-next-line rulesdir/no-magic-string-compare -- per-item 回导结果状态（docs 四态 / categories·routes 三态共用），非 WebhookStatus
  return status === 'failed';
}

/** 计数小卡片（语义色映射；failed 为 0 时降级为中性色，照 batch-upload 汇总卡片） */
function StatChip({ tone, label, value }: { tone: StatTone; label: string; value: number }) {
  const cls = STAT_TONE_CLASS[tone];
  return (
    <div className={`rounded-md px-3 py-2 ${cls.box}`}>
      <span className={cls.label}>{label}</span>
      <span className={`ml-2 font-semibold ${cls.value}`}>{value}</span>
    </div>
  );
}

/** 失败并集列表条目（标识字段按段各自取值，见 buildFailures） */
interface FailureEntry {
  key: string;
  label: string;
  detail: string;
}

/**
 * 失败项并集（docs=path / categories=name / routes=intent+primaryDocPath /
 * media=originalName ?? docPath / spaceMeta=区段名+error.message）。
 *
 * @param spaceMetaLabel spaceMeta 段的本地化标识（该段无 per-item 业务键，用区段名代替）
 */
function buildFailures(result: DocSpaceImportBundleResult, spaceMetaLabel: string): FailureEntry[] {
  const entries: FailureEntry[] = [];
  for (const item of result.docs.results) {
    if (isFailedStatus(item.status)) {
      entries.push({
        key: `doc:${item.path}`,
        label: item.path,
        detail: item.error?.message ?? '',
      });
    }
  }
  for (const item of result.categories.results) {
    if (isFailedStatus(item.status)) {
      entries.push({
        key: `category:${item.name}`,
        label: item.name,
        detail: item.error?.message ?? '',
      });
    }
  }
  for (const item of result.routes.results) {
    if (isFailedStatus(item.status)) {
      entries.push({
        key: `route:${item.intent}:${item.primaryDocPath ?? ''}`,
        label: item.primaryDocPath ? `${item.intent} → ${item.primaryDocPath}` : item.intent,
        detail: item.error?.message ?? '',
      });
    }
  }
  // 下标参与 key：同一文档的同一附件名可以有两条失败项（重名附件），仅用字段拼接会撞 key
  for (const [index, item] of result.media.failed.entries()) {
    entries.push({
      key: `media:${index}:${item.docPath}:${item.originalName ?? ''}`,
      label: item.originalName ?? item.docPath,
      detail: item.reason,
    });
  }
  if (result.spaceMeta.error) {
    entries.push({
      key: 'spaceMeta',
      label: spaceMetaLabel,
      detail: result.spaceMeta.error.message,
    });
  }
  return entries;
}

export interface ImportBundleDialogProps {
  spaceId: string;
  /** 目标空间名（来源空间异名警示用） */
  spaceName: string;
  /** 目标空间可见性（overwriteSpaceMeta 可能覆盖它） */
  spaceVisibility: Visibility;
  /** 目标空间文档总数（覆盖篇数三态化的交叉校验基准；递归后代未删文档数） */
  spaceDocCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 回导成功回调（宿主据此失效空间 + 正文类查询） */
  onImported: () => void;
}

/**
 * ImportBundleDialog — 空间级 bundle 回导对话框。
 *
 * 五态机：
 * - `selecting` 选择 .json 文件（accept + 读取守卫 + 结构/版本/体积预检，失败零网络请求）；
 * - `preview`   影响面预览（来源空间异名警示、覆盖篇数三态、危险区、并发知情文案）；
 * - `importing` 单请求回导（120s 超时；禁止关闭）；
 * - `done`      按真实 API 字段渲染五段结果 + 失败并集；
 * - `error`     请求级失败（保留 bundle 与勾选状态，「重试」重发同一 bundle——幂等安全）。
 */
export function ImportBundleDialog({
  spaceId,
  spaceName,
  spaceVisibility,
  spaceDocCount,
  open,
  onOpenChange,
  onImported,
}: ImportBundleDialogProps) {
  const t = useTranslations('docs.bundle');

  const titleId = useId();
  const descId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<ImportPhase>('selecting');
  /** 本地预检错误（errorKey；文案经 BUNDLE_ERROR_MESSAGE_KEYS 反查） */
  const [fileError, setFileError] = useState<BundleErrorKey | null>(null);
  const [bundle, setBundle] = useState<DocSpaceExportBundle | null>(null);
  const [overwriteSpaceMeta, setOverwriteSpaceMeta] = useState(false);
  /** 已存在 path（预览态有界拉取；空数组 = 未取/取失败，与 failed 标记配合判定） */
  const [existingPaths, setExistingPaths] = useState<string[]>([]);
  const [existingLoading, setExistingLoading] = useState(false);
  const [existingFailed, setExistingFailed] = useState(false);
  const [result, setResult] = useState<DocSpaceImportBundleResult | null>(null);
  const [importErrorMessage, setImportErrorMessage] = useState('');

  const docCount = bundle?.docs?.length ?? 0;
  // skipped 计数复用 lib 权威实现（不得在组件内另写 'skipped' in entry：重复实现 = 重复崩溃面）
  const { items: mediaItemCount, skipped: skippedMediaCount } = countMediaEntries(bundle?.media);
  const omittedMediaCount = bundle?.mediaOmitted?.length ?? 0;

  /** 重置全部状态（关闭对话框时调用） */
  const reset = useCallback(() => {
    setPhase('selecting');
    setFileError(null);
    setBundle(null);
    setOverwriteSpaceMeta(false);
    setExistingPaths([]);
    setExistingLoading(false);
    setExistingFailed(false);
    setResult(null);
    setImportErrorMessage('');
  }, []);

  /**
   * 关闭守卫：importing 阶段禁止关闭（Esc / 遮罩点击 / 按钮同走本函数，
   * 中断不会回滚已落库部分，进度语境不能丢）。非关闭方向直接透传。
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && phase === 'importing') return;
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset, phase],
  );

  /**
   * Esc 关闭（ui/dialog 基元不含 Esc 处理，此处补；与遮罩点击共用同一守卫）。
   *
   * 级联守卫（两道）：
   * 1. `defaultPrevented`：任何更早执行的监听已消费本次 Esc → 不重复处理；
   * 2. 全局确认框队列非空 → 二次确认框（ui/alert-dialog）正开着，本次 Esc 归它。
   *    第 2 道是真正生效的那道：alert-dialog 的 Esc 监听在其打开时才注册，**晚于本监听**
   *    （同 target 同阶段按注册序执行），故本监听执行时 defaultPrevented 恒为 false——
   *    只判它会让一次 Esc 既取消确认又关掉父对话框（丢 bundle 与勾选状态）。
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      if (useNotificationStore.getState().alerts.length > 0) return;
      e.preventDefault();
      handleOpenChange(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, handleOpenChange]);

  /** 进入预览态时拉取目标空间已有 path（有界：5 页 × 100）——覆盖篇数核对的输入 */
  useEffect(() => {
    if (!open || phase !== 'preview') return;
    let cancelled = false;
    setExistingLoading(true);
    setExistingFailed(false);
    void (async () => {
      const paths: string[] = [];
      try {
        for (let page = 1; page <= EXISTING_PATHS_MAX_PAGES; page++) {
          const res = await Api.docs.listDocs(spaceId, {
            pathPrefix: '',
            page,
            pageSize: EXISTING_PATHS_PAGE_SIZE,
          });
          paths.push(...res.items.map((d) => d.path));
          if (!res.hasNext || paths.length >= res.total) break;
        }
        if (cancelled) return;
        setExistingPaths(paths);
      } catch {
        // 拉取失败：CTA 永不携带未核实的数字 → 预览显示定性文案且确认按钮禁用
        if (!cancelled) setExistingFailed(true);
      } finally {
        if (!cancelled) setExistingLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, phase, spaceId]);

  // ── 文件选择与预检 ──────────────────────────────

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    // 先取 file 再重置：浏览器 input.files 是 **live FileList**——先 `value=''` 会把
    // 已捕获的 FileList 一起清空（倒读 [0]=undefined），选择静默无响应（Playwright 实证）；
    // jsdom 的 FileList 非 live，单测测不出此顺序依赖。
    const file = e.target.files?.[0];
    e.target.value = ''; // 重置 input，允许重新选同一文件
    if (!file) return;

    setFileError(null);
    // 读取守卫：先判 file.size 再 file.text()（内存保护；超限不读文件、不发任何请求）
    if (isOverReadGuard(file.size)) {
      setFileError('fileTooLargeToRead');
      return;
    }

    let text: string;
    try {
      text = await file.text();
    } catch {
      // 读取失败与「无法解析」对用户是同一后果：换文件重试（errorKey 表无独立读取失败项）
      setFileError('invalidJson');
      return;
    }

    // 预检已按全函数契约实现（任意输入返回判别联合）；此处 try/catch 是第二道保险——
    // 预检若漏网抛错，必须落回可见错误态，绝不能表现为「选了文件没反应」
    let preview: ReturnType<typeof parseBundlePreview>;
    try {
      preview = parseBundlePreview(text);
    } catch {
      setFileError('invalidJson');
      return;
    }
    if (!preview.ok) {
      setFileError(preview.errorKey);
      return;
    }

    setBundle(preview.bundle);
    setOverwriteSpaceMeta(false);
    setExistingPaths([]);
    setResult(null);
    setImportErrorMessage('');
    setPhase('preview');
  }, []);

  /** 返回重选：保留选择态之外的一切清空（bundle/勾选/结果） */
  const backToSelecting = useCallback(() => {
    setPhase('selecting');
    setFileError(null);
    setBundle(null);
    setOverwriteSpaceMeta(false);
    setExistingPaths([]);
    setExistingLoading(false);
    setExistingFailed(false);
    setResult(null);
    setImportErrorMessage('');
  }, []);

  // ── 覆盖篇数三态（精确 / 下界 / 不可核实）────────

  const coverage = useMemo(() => {
    if (!bundle) return null;
    if (docCount === 0) return { kind: 'empty' as const, overwrite: 0 };
    if (existingLoading) return { kind: 'loading' as const };
    if (existingFailed) return { kind: 'unknown' as const };
    const overwrite = countOverwrite(bundle.docs, existingPaths);
    // space.docCount 是递归后代未删文档总数；已取数不足即意味着列表被截断 → 该值只是下界
    const truncated = spaceDocCount > existingPaths.length;
    return truncated
      ? { kind: 'atLeast' as const, overwrite, checked: existingPaths.length }
      : { kind: 'precise' as const, overwrite };
  }, [bundle, docCount, existingFailed, existingLoading, existingPaths, spaceDocCount]);

  // 空包（0 篇）无需核对篇数、也无未核实数字 → 可确认；仅「核对中 / 核对失败」禁用
  const canConfirm =
    coverage !== null && coverage.kind !== 'loading' && coverage.kind !== 'unknown';
  /**
   * 危险区按钮计数：**仅在核对出数字时**取值（null = 无数字可用）。
   * 核对中/失败时按钮虽禁用，仍要渲染无数字文案——把未知渲染成「覆盖 0 篇」= 编造数字。
   */
  const overwriteCount =
    coverage !== null && coverage.kind !== 'loading' && coverage.kind !== 'unknown'
      ? coverage.overwrite
      : null;

  /** 危险区确认按钮文案矩阵：无数字（未勾选 / 未核实）→ 无计数文案 */
  const confirmLabel = useMemo(() => {
    if (!overwriteSpaceMeta) return t('overwrite.confirm');
    if (overwriteCount === null) return t('overwrite.confirm');
    return coverage?.kind === 'atLeast'
      ? t('overwrite.confirmDangerAtLeast', { overwrite: overwriteCount })
      : t('overwrite.confirmDanger', { overwrite: overwriteCount });
  }, [coverage, overwriteCount, overwriteSpaceMeta, t]);

  const coverageText = useMemo(() => {
    if (!coverage) return '';
    switch (coverage.kind) {
      case 'empty':
        return t('preview.emptyBundle');
      case 'loading':
        return t('preview.coverageLoading');
      case 'unknown':
        return t('preview.coverageUnknown');
      case 'precise':
        return t('preview.coverageExact', { total: docCount, overwrite: coverage.overwrite });
      case 'atLeast':
        return t('preview.coverageAtLeast', {
          total: docCount,
          overwrite: coverage.overwrite,
          spaceTotal: spaceDocCount,
          checked: coverage.checked,
        });
    }
  }, [coverage, docCount, spaceDocCount, t]);

  const bundleVisibility = bundle?.space.visibility;
  /** 危险区二次确认只在可见性真会变化时叠加（防确认疲劳） */
  const visibilityWillChange =
    overwriteSpaceMeta && !!bundleVisibility && bundleVisibility !== spaceVisibility;

  const visibilityLabel = useCallback(
    (value: Visibility) =>
      value === Visibility.PRIVATE ? t('visibility.private') : t('visibility.open'),
    [t],
  );

  // ── 回导请求 ────────────────────────────────────

  /** 发起回导（done 前的二次确认不在本函数内——error/done 态的重试必须零打扰） */
  const runImport = useCallback(async () => {
    if (!bundle) return;
    setPhase('importing');
    try {
      const res = await Api.docs.importSpaceBundle(spaceId, bundle, overwriteSpaceMeta);
      setResult(res);
      setPhase('done');
      onImported();
    } catch (err) {
      const axiosErr = err as { response?: { data?: { message?: string } }; message?: string };
      setImportErrorMessage(
        axiosErr?.response?.data?.message || axiosErr?.message || t('error.fallback'),
      );
      setPhase('error');
    }
  }, [bundle, onImported, overwriteSpaceMeta, spaceId, t]);

  const handleConfirmImport = useCallback(async () => {
    if (visibilityWillChange && bundleVisibility) {
      const ok = await confirm({
        title: t('overwrite.visibilityConfirmTitle'),
        description: t('overwrite.visibilityConfirmDesc', {
          from: visibilityLabel(spaceVisibility),
          to: visibilityLabel(bundleVisibility),
        }),
        confirmText: t('overwrite.confirm'),
        cancelText: t('cancel'),
        confirmVariant: 'danger',
      });
      if (!ok) return;
    }
    await runImport();
  }, [bundleVisibility, runImport, spaceVisibility, t, visibilityLabel, visibilityWillChange]);

  // ── 结果派生 ────────────────────────────────────

  const failures = useMemo(
    () => (result ? buildFailures(result, t('result.spaceMetaSection')) : []),
    [result, t],
  );

  // phase === 'done'：'done' 属 no-magic-string-compare 黑名单（TaskStatus 同值），收口为一次比较
  // eslint-disable-next-line rulesdir/no-magic-string-compare -- 对话框本地状态机阶段（ImportPhase），非 TaskStatus
  const isDonePhase = phase === 'done';

  if (!open) return null;

  return (
    // role/aria 挂在包裹 Dialog 的容器上：整块（遮罩 + 卡片）都是对话框语义（照 ui/alert-dialog.tsx）
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogHeader>
          <DialogTitle id={titleId}>{t('dialog.title')}</DialogTitle>
          <DialogDescription id={descId}>{t('dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* ── 选择文件 ── */}
          {phase === 'selecting' && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  void handleFileSelect(e);
                }}
              />
              <Button
                variant="outline"
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" />
                {t('dialog.selectFile')}
              </Button>
              {fileError ? (
                <div className="flex gap-2 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t(BUNDLE_ERROR_MESSAGE_KEYS[fileError])}</span>
                </div>
              ) : (
                <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
                  <FileJson className="h-3.5 w-3.5" />
                  {t('dialog.noFileHint')}
                </p>
              )}
            </>
          )}

          {/* ── 预览 ── */}
          {phase === 'preview' && bundle && (
            <div className="space-y-3">
              {/* 来源空间异名 = 最高危场景（可能导错包） */}
              {bundle.space.name !== spaceName && (
                <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t('preview.sourceMismatch', { source: bundle.space.name, target: spaceName })}
                  </span>
                </div>
              )}

              {/* 影响面 headline */}
              <div className="space-y-1">
                <p className={`text-sm ${coverage?.kind === 'unknown' ? 'text-amber-300' : ''}`}>
                  {coverageText}
                </p>
                <p className="text-xs text-muted-foreground">{t('preview.notDeleting')}</p>
                {skippedMediaCount + omittedMediaCount > 0 && (
                  <p className="text-xs text-amber-300">
                    {t('preview.mediaBroken', { count: skippedMediaCount + omittedMediaCount })}
                  </p>
                )}
              </div>

              {/* 次级：五段计数 + 来源信息（muted 小字） */}
              <div className="space-y-0.5 text-[11px] text-muted-foreground">
                <p>
                  {t('preview.counts', {
                    categories: bundle.categories?.length ?? 0,
                    routes: bundle.routes?.length ?? 0,
                    docs: docCount,
                    media: mediaItemCount,
                    mediaSkipped: skippedMediaCount,
                    mediaOmitted: omittedMediaCount,
                  })}
                </p>
                <p>{t('preview.source', { name: bundle.space.name })}</p>
                {bundle.exportedAt && <p>{t('preview.exportedAt', { time: bundle.exportedAt })}</p>}
                <p>{t('preview.formatVersion', { version: bundle.formatVersion })}</p>
              </div>

              {/* 危险区：overwriteSpaceMeta 真实写范围 */}
              <div className="space-y-2 rounded-md border border-border/50 p-3">
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  {/* checkbox 沿用项目惯例：原生 input（ui 无 checkbox 基元） */}
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={overwriteSpaceMeta}
                    onChange={(e) => setOverwriteSpaceMeta(e.target.checked)}
                  />
                  <span>{t('overwrite.label')}</span>
                </label>
                {overwriteSpaceMeta && (
                  <div className="space-y-1 border-t border-border/30 pt-2 text-[11px]">
                    <p className="text-amber-300">{t('overwrite.scopeTitle')}</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                      <li>{t('overwrite.scopeName')}</li>
                      <li>{t('overwrite.scopeSettings')}</li>
                      <li>{t('overwrite.scopeVisibility')}</li>
                    </ul>
                    {visibilityWillChange && bundleVisibility && (
                      <p className="text-amber-300">
                        {t('overwrite.visibilityChange', {
                          from: visibilityLabel(spaceVisibility),
                          to: visibilityLabel(bundleVisibility),
                        })}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 并发知情 */}
              <p className="text-[11px] text-muted-foreground">{t('preview.concurrency')}</p>
            </div>
          )}

          {/* ── 导入中 ── */}
          {phase === 'importing' && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">{t('dialog.importing')}</p>
              <p className="text-xs text-muted-foreground">{t('dialog.importingHint')}</p>
            </div>
          )}

          {/* ── 结果（字段名严格对照 doc-bundle.service.ts:226-283） ── */}
          {isDonePhase && result && (
            <div className="space-y-3">
              <p className="text-sm font-medium">{t('result.title')}</p>

              {/* docs 段（四态，独占一行）；0 篇时不渲染全 0 面板 */}
              {result.docs.summary.total === 0 ? (
                <p className="text-xs text-muted-foreground">{t('result.emptyDocs')}</p>
              ) : (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">{t('result.docsSection')}</p>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <StatChip
                      tone="created"
                      label={t('result.created')}
                      value={result.docs.summary.created}
                    />
                    <StatChip
                      tone="updated"
                      label={t('result.updated')}
                      value={result.docs.summary.updated}
                    />
                    <StatChip
                      tone="neutral"
                      label={t('result.unchanged')}
                      value={result.docs.summary.unchanged}
                    />
                    <StatChip
                      tone={result.docs.summary.failed > 0 ? 'failed' : 'neutral'}
                      label={t('result.failed')}
                      value={result.docs.summary.failed}
                    />
                  </div>
                </div>
              )}

              {/* categories / routes 段：三态（**无 unchanged**，服务端不返回该桶） */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t('result.categoriesSection')}</p>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <StatChip
                    tone="created"
                    label={t('result.created')}
                    value={result.categories.summary.created}
                  />
                  <StatChip
                    tone="updated"
                    label={t('result.updated')}
                    value={result.categories.summary.updated}
                  />
                  <StatChip
                    tone={result.categories.summary.failed > 0 ? 'failed' : 'neutral'}
                    label={t('result.failed')}
                    value={result.categories.summary.failed}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t('result.routesSection')}</p>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <StatChip
                    tone="created"
                    label={t('result.created')}
                    value={result.routes.summary.created}
                  />
                  <StatChip
                    tone="updated"
                    label={t('result.updated')}
                    value={result.routes.summary.updated}
                  />
                  <StatChip
                    tone={result.routes.summary.failed > 0 ? 'failed' : 'neutral'}
                    label={t('result.failed')}
                    value={result.routes.summary.failed}
                  />
                </div>
              </div>

              {/* media 段：created / reused / skipped（failed 明细进失败并集） */}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t('result.mediaSection')}</p>
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <StatChip
                    tone="created"
                    label={t('result.created')}
                    value={result.media.created}
                  />
                  <StatChip tone="updated" label={t('result.reused')} value={result.media.reused} />
                  <StatChip
                    tone="neutral"
                    label={t('result.skipped')}
                    value={result.media.skipped}
                  />
                </div>
              </div>

              {/* spaceMeta 段：默认 skipped（overwriteSpaceMeta=true 才写） */}
              <div className="text-xs">
                <span className="text-muted-foreground">{t('result.spaceMetaSection')}</span>
                <span className={`ml-2 ${SPACE_META_PRESENTATION[result.spaceMeta.status].tone}`}>
                  {t(SPACE_META_PRESENTATION[result.spaceMeta.status].labelKey)}
                </span>
                {/* 防御性渲染：error 字段声明存在，但服务端当前实现无产出路径 */}
                {result.spaceMeta.error && (
                  <p className="mt-1 text-red-400">{result.spaceMeta.error.message}</p>
                )}
              </div>

              {failures.length > 0 && (
                <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3">
                  <p className="mb-1 text-xs font-medium text-red-400">
                    {t('result.failuresTitle', { count: failures.length })}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">{t('result.failuresHint')}</p>
                  <ul className="space-y-1">
                    {failures.map((item) => (
                      <li key={item.key} className="text-xs text-muted-foreground">
                        <span className="font-mono text-red-300">{item.label}</span>
                        {item.detail && <span className="ml-2">— {item.detail}</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void runImport();
                      }}
                    >
                      {t('retry')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── 请求级失败（bundle 与勾选状态保留，重试零打扰） ── */}
          {phase === 'error' && (
            <div className="space-y-2">
              <div className="flex gap-2 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{importErrorMessage}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('error.partialWarning')}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === 'selecting' && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('cancel')}
            </Button>
          )}
          {phase === 'preview' && (
            <>
              <Button variant="outline" onClick={backToSelecting}>
                {t('backToSelect')}
              </Button>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant={overwriteSpaceMeta ? 'destructive' : 'default'}
                disabled={!canConfirm}
                onClick={() => {
                  void handleConfirmImport();
                }}
              >
                {confirmLabel}
              </Button>
            </>
          )}
          {phase === 'importing' && (
            <Button variant="outline" disabled>
              {t('dialog.importingProgress')}
            </Button>
          )}
          {isDonePhase && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('done')}
            </Button>
          )}
          {phase === 'error' && (
            <>
              <Button variant="outline" onClick={backToSelecting}>
                {t('backToSelect')}
              </Button>
              <Button
                onClick={() => {
                  void runImport();
                }}
              >
                {t('retry')}
              </Button>
            </>
          )}
        </DialogFooter>
      </Dialog>
    </div>
  );
}
