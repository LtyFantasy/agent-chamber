/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plans/big-barda-big-barda-pantha.md §2 D8（web 批量上传）
 *   - 补充: plans/big-barda-big-barda-pantha.md §7 A3（lint 范围外还原禁令）
 *
 * [踩坑索引] （暂无）
 *
 * [铁律关联] #1（每次 session 必读 AGENTS.md/INDEX.md） #12（写/改文件分批、匹配现有风格）
 *
 * [详细踩坑]（暂无）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Upload, X, AlertTriangle, CheckCircle, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Api } from '@/lib/api';
import { FILE_MAX_BYTES, isOverFileLimit } from '@/lib/docs-upload-limit';

// ── 内联类型（跟随 api.ts 写法，不从 shared 引新 DTO） ──

/** 批量上传单项输入 */
interface BatchDocItem {
  path: string;
  content: string;
  title?: string;
  summary?: string;
  docType?: string;
  category?: string;
  tags?: string[];
}

/** 批量上传单项结果 */
interface BatchDocResult {
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  id?: string;
  error?: { message: string; code?: number };
}

/** 批量上传响应 */
interface BatchUpsertResponse {
  results: BatchDocResult[];
  summary: {
    total: number;
    created: number;
    updated: number;
    unchanged: number;
    failed: number;
  };
}

/** 待上传文件条目（客户端状态） */
interface PendingFile {
  /** 文件名 = 上传 path（v1 不支持目录结构） */
  name: string;
  content: string;
  /** content 字节数（new Blob([content]).size） */
  byteSize: number;
  /** 是否与空间内已有文档路径冲突（覆盖标记 amber） */
  conflict: boolean;
}

/** 组件状态机 */
type UploadPhase = 'selecting' | 'uploading' | 'done';

// ── 分片工具（纯函数，不依赖组件状态） ──

const CHUNK_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const CHUNK_MAX_DOCS = 50;

function sliceFiles(files: PendingFile[]): PendingFile[][] {
  const chunks: PendingFile[][] = [];
  let current: PendingFile[] = [];
  let currentBytes = 0;

  for (const f of files) {
    if (
      (currentBytes + f.byteSize > CHUNK_MAX_BYTES && current.length > 0) ||
      current.length >= CHUNK_MAX_DOCS
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(f);
    currentBytes += f.byteSize;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

export interface BatchUploadDialogProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

/**
 * BatchUploadDialog — 批量上传本地 md 文档组件。
 *
 * 流程：
 * 1. 点击「选择文件」→ `<input type="file" multiple accept=".md,.markdown,.txt">`
 * 2. `file.text()` 读取内容 → 待传列表（文件名=path、大小、覆盖标记）
 * 3. 支持逐项移除
 * 4. 「开始上传」→ 按 content 累加 ≤3MB 且 ≤50 篇切片
 * 5. 逐片顺序 `await` POST batch 端点，显示进度
 * 6. 结束汇总：created/updated/unchanged/failed 计数 + failed 列表
 *
 * 覆盖标记（v1.70.0-dev 懒加载改造）：on-open 按 pathPrefix 分页拉取已存在路径
 * （有界——最多 5 页 500 条；超出边界的冲突标记可能漏标，属已知权衡）。
 */
export function BatchUploadDialog({
  spaceId,
  open,
  onOpenChange,
  onUploaded,
}: BatchUploadDialogProps) {
  const t = useTranslations('docs.upload');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<UploadPhase>('selecting');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<BatchUpsertResponse['summary'] | null>(null);
  const [failedItems, setFailedItems] = useState<BatchDocResult[]>([]);
  /** 已存在路径（on-open 有界拉取；空 = 未拉取/拉取失败，冲突标记降级为空） */
  const [existingPaths, setExistingPaths] = useState<string[]>([]);

  /** on-open 拉取已存在路径（pathPrefix='' 根目录 = 全空间；分页有界，防全量拉取） */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const paths: string[] = [];
      try {
        for (let page = 1; page <= 5; page++) {
          const res = await Api.docs.listDocs(spaceId, { pathPrefix: '', page, pageSize: 100 });
          paths.push(...res.items.map((d) => d.path));
          if (!res.hasNext || paths.length >= res.total) break;
        }
      } catch {
        // 拉取失败：冲突标记降级为空（不阻塞上传流程）
      }
      if (!cancelled) setExistingPaths(paths);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, spaceId]);

  /** 重置所有状态 */
  const reset = useCallback(() => {
    setPhase('selecting');
    setPendingFiles([]);
    setProgress({ done: 0, total: 0 });
    setSummary(null);
    setFailedItems([]);
  }, []);

  /** 关闭 Dialog 重置状态；uploading 阶段禁止关闭（遮罩点击是唯一关闭路径，防止进度语境丢失） */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && phase === 'uploading') return;
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset, phase],
  );

  // ── 文件选择 ──────────────────────────────────

  const existingPathSet = useMemo(() => new Set(existingPaths), [existingPaths]);

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      e.target.value = ''; // 重置 input，允许重复选同一文件
      if (!files || files.length === 0) return;

      const pending: PendingFile[] = [];
      const rejected: { name: string; size: number }[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // B4：超限文件提前拒绝入列（用 file.size 原始字节数，避免大文件先读进内存再判超）
        if (isOverFileLimit(file.size)) {
          rejected.push({ name: file.name, size: file.size });
          continue;
        }
        try {
          const content = await file.text();
          pending.push({
            name: file.name,
            content,
            byteSize: new Blob([content]).size,
            conflict: existingPathSet.has(file.name),
          });
        } catch {
          // 读取失败静默跳过
        }
      }

      // B4：超限提示——一次 alert 汇总所有被拒文件（文件名 + 大小），避免逐个弹窗
      if (rejected.length > 0) {
        const lines = rejected.map((f) => `${f.name} (${formatSize(f.size)})`).join('\n');
        alert(`${t('fileTooLarge', { max: formatSize(FILE_MAX_BYTES) })}\n${lines}`);
      }

      // 去重：同名已在待传列表或本次选择内重复则跳过——防 React key 重复与批内互撞
      setPendingFiles((prev) => {
        const seen = new Set(prev.map((f) => f.name));
        const fresh = pending.filter((f) => {
          if (seen.has(f.name)) return false;
          seen.add(f.name);
          return true;
        });
        return [...prev, ...fresh];
      });
      setSummary(null);
      setFailedItems([]);
    },
    [existingPathSet, t],
  );

  /** 移除单个待传文件 */
  const removeFile = useCallback((name: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  // ── 分片上传 ──────────────────────────────────

  const handleStartUpload = useCallback(async () => {
    if (pendingFiles.length === 0) return;

    const chunks = sliceFiles(pendingFiles);
    setPhase('uploading');
    setProgress({ done: 0, total: pendingFiles.length });

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    const allFailed: BatchDocResult[] = [];

    let processed = 0;
    for (const chunk of chunks) {
      const docs: BatchDocItem[] = chunk.map((f) => ({
        path: f.name,
        content: f.content,
      }));

      try {
        const res: BatchUpsertResponse = await Api.docs.batchUpsertDocs(spaceId, docs);
        created += res.summary.created;
        updated += res.summary.updated;
        unchanged += res.summary.unchanged;
        failed += res.summary.failed;

        for (const item of res.results) {
          // eslint-disable-next-line rulesdir/no-magic-string-compare -- batch 单项结果状态（'created'|'updated'|'unchanged'|'failed'，本地 BatchDocResult 类型），非 WebhookStatus
          if (item.status === 'failed') {
            allFailed.push(item);
          }
        }
      } catch {
        // 整片网络错误：标记片中所有文件为失败
        for (const doc of chunk) {
          allFailed.push({
            path: doc.name,
            status: 'failed',
            error: { message: t('networkError') },
          });
        }
        failed += chunk.length;
      }

      processed += chunk.length;
      setProgress({ done: processed, total: pendingFiles.length });
    }

    setSummary({ total: pendingFiles.length, created, updated, unchanged, failed });
    setFailedItems(allFailed);
    setPhase('done');
    onUploaded();
  }, [pendingFiles, spaceId, onUploaded, t]);

  // ── 格式化文件大小 ────────────────────────────

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ── 渲染 ──────────────────────────────────────

  const uploading = phase === 'uploading';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {/* ── 文件选择按钮（选择中可见） ── */}
        {phase === 'selecting' && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".md,.markdown,.txt"
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
              {t('selectFiles')}
            </Button>
          </>
        )}

        {/* ── 待传列表 ── */}
        {pendingFiles.length > 0 && (
          <div className="rounded-md border border-border/50">
            {/* 表头 */}
            <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2 text-xs font-medium text-muted-foreground">
              <span className="flex-1">{t('colPath')}</span>
              <span className="w-20 text-right">{t('colSize')}</span>
              <span className="w-12 text-center">{t('colAction')}</span>
            </div>
            {/* 文件行 */}
            <div className="max-h-64 overflow-y-auto">
              {pendingFiles.map((f) => (
                <div
                  key={f.name}
                  className={`flex items-center gap-2 border-b border-border/20 px-3 py-1.5 last:border-b-0 ${
                    f.conflict ? 'bg-amber-500/5' : ''
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs">{f.name}</span>
                  <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                    {formatSize(f.byteSize)}
                  </span>
                  <span className="flex w-12 shrink-0 items-center justify-center gap-1">
                    {f.conflict && (
                      <span className="text-[10px] text-amber-500" title={t('willOverwrite')}>
                        <AlertTriangle className="h-3 w-3" />
                      </span>
                    )}
                    {!uploading && (
                      <button
                        onClick={() => removeFile(f.name)}
                        className="text-muted-foreground transition-colors hover:text-destructive"
                        title={t('remove')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 上传中进度 ── */}
        {uploading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{
                  width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <span className="shrink-0 text-xs">
              {t('uploading', { done: progress.done, total: progress.total })}
            </span>
          </div>
        )}

        {/* ── 完成汇总 ── */}
        {/* eslint-disable-next-line rulesdir/no-magic-string-compare -- 对话框本地状态机阶段（UploadPhase），非 TaskStatus */}
        {phase === 'done' && summary && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-emerald-500/10 px-3 py-2">
                <span className="text-emerald-400">{t('created')}</span>
                <span className="ml-2 font-semibold text-emerald-300">{summary.created}</span>
              </div>
              <div className="rounded-md bg-blue-500/10 px-3 py-2">
                <span className="text-blue-400">{t('updated')}</span>
                <span className="ml-2 font-semibold text-blue-300">{summary.updated}</span>
              </div>
              <div className="rounded-md bg-muted/30 px-3 py-2">
                <span className="text-muted-foreground">{t('unchanged')}</span>
                <span className="ml-2 font-semibold">{summary.unchanged}</span>
              </div>
              <div
                className={`rounded-md px-3 py-2 ${
                  summary.failed > 0 ? 'bg-red-500/10' : 'bg-muted/30'
                }`}
              >
                <span className={summary.failed > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                  {t('failed')}
                </span>
                <span className={`ml-2 font-semibold ${summary.failed > 0 ? 'text-red-300' : ''}`}>
                  {summary.failed}
                </span>
              </div>
            </div>

            {/* 失败列表 */}
            {failedItems.length > 0 && (
              <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3">
                <p className="mb-2 text-xs font-medium text-red-400">{t('failedTitle')}</p>
                <ul className="space-y-1">
                  {failedItems.map((item, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      <span className="font-mono text-red-300">{item.path}</span>
                      {item.error && <span className="ml-2">— {item.error.message}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* 无文件提示 */}
        {pendingFiles.length === 0 && phase === 'selecting' && (
          <p className="text-center text-xs text-muted-foreground">{t('noFilesHint')}</p>
        )}
      </div>

      <DialogFooter>
        {phase === 'selecting' && pendingFiles.length > 0 && (
          <Button onClick={handleStartUpload}>
            <CheckCircle className="mr-2 h-4 w-4" />
            {t('start')}
          </Button>
        )}
        {/* eslint-disable-next-line rulesdir/no-magic-string-compare -- 对话框本地状态机阶段（UploadPhase），非 TaskStatus */}
        {phase === 'done' && (
          <>
            <Button variant="outline" onClick={reset}>
              {t('reselect')}
            </Button>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('done')}
            </Button>
          </>
        )}
        {phase === 'uploading' && (
          <Button variant="outline" disabled>
            {t('uploadingProgress')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
