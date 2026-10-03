'use client';

/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 非图片附件的消息内卡片（v1.90.0-dev 通用附件 + TTL 批，plan §2 B1）
 *     — 图标 + 文件名 + 格式化大小 + 过期倒计时 + 下载按钮 + 可执行警告
 *
 * [代码职责]
 *   - 图标分类：按 `originalName` 扩展名优先、`clientMimeType` 兜底，收敛 6 类
 *     （文档/压缩/代码/数据/音视频/通用）
 *   - 下载：axiosInstance（拦截器自动带 token）拉 blob → objectURL → 临时
 *     `<a download>` → 延后 revoke；**绝不裸导航**（/content 需凭证，裸链接 401）
 *   - 过期态：置灰 + 下载禁用 + 「已过期」；可执行扩展名下载前弹确认
 *   - 导出纯函数分类器与 `isInlineImageAttachment` 供消息气泡过滤复用（单测直测）
 *
 * [权威文档]
 *   - 主文档: docs/frontend-architecture.md §3.2.3（消息渲染）— 附件卡片
 *   - 补充: docs/api-definition.md §16a（附件 TTL / 410·12009 / 四表面口径）
 *
 * [关键不变量]
 *   - **图标分类禁止用 `mimeType`**（M1 delta 注记）：非图片的 `mimeType` 恒为
 *     `application/octet-stream`（字节证据口径），对呈现形态零信息量——只用
 *     `clientMimeType`（纯展示信息）与文件名扩展名
 *   - 图片条目（`isInlineImageAttachment`）= 4 种嗅探 mime 之一，**恒不渲染卡片**：
 *     图片由 content 内 `![]()` 渲染，卡片再渲染 = 双重呈现
 *   - 过期判据 = 服务端 `expired`（权威）∨ 本地纯函数 `expiryStateOf` 判死（同定义）；
 *     **翻转时机 = 跨过 TTL 后首次 re-render 或首次下载（410 兜底提示），不引定时器**
 *     （不假装秒级准时）。文案与禁用态由同一 `isExpired` 派生，二者不得自相矛盾；
 *     GC 物理回收后字节面 404，故下载失败文案不区分 404/410（都走「下载失败」），
 *     过期态由投影驱动而非错误驱动
 *   - mime 白名单/图片判定的**单源 = src/lib/attachment-mime.ts**（纯模块；放组件里
 *     会让 composer/doc-editor 拖入整张客户端组件图），本模块仅 re-export 兼容旧引用
 *   - 下载请求路径必须剥离 API_PREFIX（axiosInstance.baseURL 已含前缀，双拼 404
 *     ——attachment-image 同源教训），复用其 resolveAttachmentRequestPath 单源
 *   - axios 响应拦截器对 410 **不弹全局 toast**（只 console.error，R8 已核实），
 *     卡片不额外做静默化——失败提示由本组件本地文案承担
 *
 * [关联代码]
 *   - src/components/topics/message-bubble.tsx — 消费面（过滤图片条目后渲染列表）
 *   - src/lib/attachment-mime.ts — INLINE_IMAGE_MIME_TYPES / isInlineImageAttachment 单源
 *   - src/components/attachments/attachment-image.tsx — resolveAttachmentRequestPath 单源
 *   - src/lib/api.ts — axiosInstance / ATTACHMENT_MAX_BYTES
 *   - packages/shared/src/dto/topic-response.dto.ts — MessageAttachment 契约
 *
 * [持久踩坑]
 *   - 下载重入闸用**同步 ref**（downloadPendingRef）而非 state：`downloading` 是渲染
 *     快照，确认弹窗打开期间恒 false → 双击排队两个确认框 = 两次下载请求
 *     （同 topic-composer 的 confirmPendingRef 先例）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Database,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileText,
  FileVideo,
  Loader2,
} from 'lucide-react';
import type { MessageAttachment } from '@agent-chamber/shared';
import { axiosInstance } from '@/lib/api';
import { confirm, toast } from '@/lib/notify';
import { resolveAttachmentRequestPath } from '@/components/attachments/attachment-image';

/**
 * 图片判定与 mime 白名单的**单源在 `@/lib/attachment-mime`**（纯模块，见该文件
 * [踩坑索引]：放在组件模块会让 composer/doc-editor 拖入整个客户端组件图）。
 * 此处 re-export 仅为兼容既有引用（message-bubble 与测试从本模块取），
 * 新代码请直接从 `@/lib/attachment-mime` 导入。
 */
export { INLINE_IMAGE_MIME_TYPES, isInlineImageAttachment } from '@/lib/attachment-mime';

/** 图标分类（6 类；plan §2 B1 钉死的粒度——再细分只会让视觉噪音变大） */
export type AttachmentIconKind = 'document' | 'archive' | 'code' | 'data' | 'media' | 'generic';

/** 扩展名 → 分类词典（值域闭死；未命中回退 clientMimeType 前缀，再回退 generic） */
const EXTENSION_KIND: Record<string, AttachmentIconKind> = {
  // 文档：排版/文字/演示（表格归「数据」——见 data 组）
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  txt: 'document',
  text: 'document',
  log: 'document',
  md: 'document',
  markdown: 'document',
  rst: 'document',
  ppt: 'document',
  pptx: 'document',
  odp: 'document',
  key: 'document',
  // 压缩/归档
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  jar: 'archive',
  war: 'archive',
  iso: 'archive',
  dmg: 'archive',
  // 代码/脚本/配置
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  ps1: 'code',
  bat: 'code',
  cmd: 'code',
  html: 'code',
  htm: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  vue: 'code',
  svelte: 'code',
  toml: 'code',
  ini: 'code',
  conf: 'code',
  env: 'code',
  // 数据（含表格/schema）
  csv: 'data',
  tsv: 'data',
  xls: 'data',
  xlsx: 'data',
  ods: 'data',
  json: 'data',
  jsonl: 'data',
  ndjson: 'data',
  xml: 'data',
  yaml: 'data',
  yml: 'data',
  sql: 'data',
  parquet: 'data',
  avro: 'data',
  sqlite: 'data',
  db: 'data',
  // 音视频
  mp3: 'media',
  wav: 'media',
  flac: 'media',
  aac: 'media',
  ogg: 'media',
  oga: 'media',
  m4a: 'media',
  opus: 'media',
  wma: 'media',
  mp4: 'media',
  m4v: 'media',
  mov: 'media',
  avi: 'media',
  mkv: 'media',
  webm: 'media',
  wmv: 'media',
  mpg: 'media',
  mpeg: 'media',
  flv: 'media',
};

/** 视频扩展名子集（media 类内再分图标：🎬 vs 🎵——分类粒度不变，只是图标更贴切） */
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mov',
  'avi',
  'mkv',
  'webm',
  'wmv',
  'mpg',
  'mpeg',
  'flv',
]);

/** 压缩包 mime（扩展名未命中时的兜底分类） */
const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/x-xz',
]);

/**
 * 可执行/脚本扩展名（plan §1 m7 accepted risk 的 Web 侧缓解）：下载前必须弹确认。
 * 与后端无耦合——后端不做扫描（accepted risk），前端只是把「你可能在下载可执行
 * 文件」这件事显式化，不是安全边界。
 */
export const EXECUTABLE_EXTENSIONS: readonly string[] = [
  '.exe',
  '.scr',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.lnk',
  '.ps1',
  '.sh',
  '.jar',
];

/**
 * 取小写扩展名（含点）；无扩展名/隐藏文件（`.bashrc`）→ ''。
 *
 * **归一化（n2 修订）**：先 `trim()` 去尾空白、再剥尾部连续点，然后才取最后一个
 * `.` 之后的部分——`'payload.exe '` / `'payload.exe...'` / `'payload.exe. '`
 * 这类尾空格、尾点伪装必须与 `'payload.exe'` 判等，否则可执行警告会被绕开。
 */
export function extensionOf(name: string): string {
  const normalized = name.trim().replace(/\.+$/, '');
  const i = normalized.lastIndexOf('.');
  if (i <= 0 || i === normalized.length - 1) return '';
  return normalized.slice(i).toLowerCase();
}

/** 可执行扩展名判定（大小写不敏感） */
export function isExecutableAttachment(
  attachment: Pick<MessageAttachment, 'originalName'>,
): boolean {
  return EXECUTABLE_EXTENSIONS.includes(extensionOf(attachment.originalName));
}

/**
 * 附件图标分类（**禁止读 `mimeType`**，见 [关键不变量]）：
 * ① 扩展名命中词典 → 该分类；② 未命中 → `clientMimeType` 前缀兜底；
 * ③ 仍未知 → generic。clientMimeType 是客户端声明值（sanitize 后），仅展示用途。
 */
export function classifyAttachment(
  attachment: Pick<MessageAttachment, 'originalName' | 'clientMimeType' | 'mimeType'>,
): AttachmentIconKind {
  const ext = extensionOf(attachment.originalName).replace(/^\./, '');
  const byExt = EXTENSION_KIND[ext];
  if (byExt) return byExt;

  const declared = attachment.clientMimeType ?? '';
  if (declared.startsWith('audio/') || declared.startsWith('video/')) return 'media';
  if (ARCHIVE_MIME_TYPES.has(declared)) return 'archive';
  if (
    declared === 'application/json' ||
    declared === 'application/xml' ||
    declared === 'text/csv'
  ) {
    return 'data';
  }
  if (declared.startsWith('text/') || declared === 'application/pdf') return 'document';
  return 'generic';
}

/** 分类 → 图标（media 类内按视频子集再分；纯展示决策） */
function iconOf(kind: AttachmentIconKind, originalName: string) {
  switch (kind) {
    case 'document':
      return FileText;
    case 'archive':
      return FileArchive;
    case 'code':
      return FileCode;
    case 'data':
      return Database;
    case 'media':
      return VIDEO_EXTENSIONS.has(extensionOf(originalName).replace(/^\./, ''))
        ? FileVideo
        : FileAudio;
    default:
      return File;
  }
}

/** 人类可读字节数（B / KB / MB；业务口径 10MB 上限内不会出现 GB） */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** 过期态（纯函数；`now` 可注入，单测免冻结时钟） */
export type AttachmentExpiryState =
  | { kind: 'never' }
  | { kind: 'expired' }
  | { kind: 'soon'; hours: number }
  | { kind: 'days'; days: number };

/**
 * 过期态推导（与服务端 `expired` 同定义 `expiresAt < now()`；无 expiresAt / 非法
 * 时间串 → never，与投影「索引缺键 = null = 永久」语义对齐）。
 * < 24h 归「钟点」档（临期，琥珀提亮），≥ 24h 归「天数」档。
 */
export function expiryStateOf(
  expiresAt: string | null,
  now: number = Date.now(),
): AttachmentExpiryState {
  if (!expiresAt) return { kind: 'never' };
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return { kind: 'never' };
  const diff = at - now;
  if (diff <= 0) return { kind: 'expired' };
  const hours = Math.ceil(diff / 3_600_000);
  if (hours < 24) return { kind: 'soon', hours };
  return { kind: 'days', days: Math.ceil(diff / 86_400_000) };
}

/**
 * blob 落盘（axios blob → objectURL → 临时 `<a download>` → 延后 revoke）。
 *
 * revoke 为何延后一个宏任务：`a.click()` 只是把下载排入浏览器队列，部分引擎
 * （Safari/旧 Chromium）在同步返回后才真正读取 blob URL——立即 revoke 会得到
 * 空文件。0ms 延时已足够。
 *
 * try/finally（n1 修订）：`click()` 抛错（引擎策略/权限）也必须摘掉临时节点并
 * revoke——objectURL 是进程级持有，泄漏一个就永久占住整个 blob 的内存。
 * 创建后**必然**走到 revoke（无早返回路径）。
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export interface AttachmentFileCardProps {
  /** 消息附件投影条目（`Message.attachments` 元素） */
  attachment: MessageAttachment;
  /** 附加类名（布局交由调用方，如气泡内上间距） */
  className?: string;
}

/**
 * 非图片附件卡片（plan §2 B1）：图标 + 文件名 + 大小 + 过期倒计时 + 下载按钮。
 *
 * - 过期态（服务端 `expired` 或本地纯函数判死）：整卡置灰、下载禁用、文案「已过期」
 * - 可执行扩展名：下载前走全局 confirm（危险色）；卡片同时常驻琥珀警示 badge
 *   （a11y：不能只把风险藏在弹窗里）
 * - 图片条目不应传入（调用方 `isInlineImageAttachment` 过滤）；本组件不做二次
 *   过滤——把「渲染什么」的决策留在消费面，避免两处口径漂移
 * - 下载失败一律本地文案（410/404 均不区分：GC 物理回收后过期附件行已硬删）
 */
export function AttachmentFileCard({ attachment, className }: AttachmentFileCardProps) {
  const t = useTranslations('attachments');
  const tGlobal = useTranslations();
  const [downloading, setDownloading] = useState(false);
  /** 下载重入闸（m3）：覆盖 confirm 等待 + 请求在途全程，见 handleDownload 注释 */
  const downloadPendingRef = useRef(false);

  const expiry = expiryStateOf(attachment.expiresAt);
  /**
   * 过期判据 = 服务端 `expired`（权威）∨ 本地纯函数判死（与服务端同定义）。
   * 叠加本地推导的理由：页面长开时会跨过 TTL 时刻，服务端字段是响应快照。
   *
   * **翻转时机（m4 如实化）**：跨过 TTL 后**首次 re-render 或首次下载**（下载走
   * 410 兜底提示）才翻转——本组件**不引定时器**（不假装秒级准时，避免每张卡片
   * 一个 tick 的常驻开销）。文案与禁用态由同一 `isExpired` 派生，二者不会自相矛盾。
   */
  const isExpired = attachment.expired || expiry.kind === 'expired';
  const executable = isExecutableAttachment(attachment);
  const kind = classifyAttachment(attachment);
  const Icon = iconOf(kind, attachment.originalName);

  const expiryText = (() => {
    // M2 修订：先用并集判据（服务端 expired=true 而本地 expiresAt 尚在未来时，
    // 禁用态已生效，文案必须同为「已过期」，否则出现「可下载」文案配禁用按钮的矛盾）
    if (isExpired) return t('card.expired');
    if (expiry.kind === 'soon') return t('card.expiresInHours', { hours: expiry.hours });
    if (expiry.kind === 'days') return t('card.expiresInDays', { days: expiry.days });
    return null; // 永久（null / 存量缺键 / doc 绑定）
  })();

  const handleDownload = useCallback(async () => {
    // 重入闸（m3）：`downloading` 是渲染快照，在「确认弹窗打开期间」恒为 false——
    // 双击会排队两个确认框、确认两次 = 两次下载请求。故照 topic-composer 的
    // confirmPendingRef 先例加同步 ref：覆盖 confirm 等待 + 请求在途全程，finally 复位。
    if (isExpired || downloadPendingRef.current) return;
    downloadPendingRef.current = true;
    try {
      // 可执行扩展名：下载前确认（plan §1 m7；取消不发请求）
      if (executable) {
        const ok = await confirm({
          title: t('card.executableTitle'),
          description: t('card.executableConfirm', { name: attachment.originalName }),
          confirmText: tGlobal('common.confirm'),
          cancelText: tGlobal('common.cancel'),
          confirmVariant: 'danger',
        });
        if (!ok) return;
      }
      const requestPath = resolveAttachmentRequestPath(attachment.contentUrl);
      if (!requestPath) {
        toast.error({ title: t('card.downloadFailed') });
        return;
      }
      setDownloading(true);
      try {
        const res = await axiosInstance.get(requestPath, { responseType: 'blob' });
        triggerDownload(res.data as Blob, attachment.originalName);
      } catch {
        // 410·12009（会话期间过期）/ 404（GC 已硬删）/ 网络：统一本地文案。
        // 拦截器对 410 不弹全局 toast（R8 已核实），故这里不会出现双重提示。
        toast.error({ title: t('card.downloadFailed') });
      } finally {
        setDownloading(false);
      }
    } finally {
      downloadPendingRef.current = false;
    }
  }, [attachment.contentUrl, attachment.originalName, executable, isExpired, t, tGlobal]);

  return (
    <li
      data-testid="attachment-file-card"
      className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
        isExpired ? 'border-border/40 bg-muted/20 opacity-60' : 'border-border/60 bg-background/40'
      } ${className ?? ''}`}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-xs font-medium text-foreground/90"
          title={attachment.originalName}
        >
          {attachment.originalName}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
          {expiryText && (
            <span
              data-testid="attachment-expiry"
              className={
                isExpired
                  ? 'text-muted-foreground'
                  : expiry.kind === 'soon'
                    ? 'font-medium text-amber-400'
                    : ''
              }
            >
              {expiryText}
            </span>
          )}
          {/* 可执行扩展名常驻警示（不能只藏在下载确认弹窗里——键盘/读屏用户也要能感知） */}
          {executable && (
            <span
              data-testid="attachment-executable-badge"
              className="inline-flex items-center gap-0.5 font-medium text-amber-400"
              title={t('card.executableConfirm', { name: attachment.originalName })}
            >
              <AlertTriangle className="h-3 w-3" aria-hidden />
              {t('card.executableBadge')}
            </span>
          )}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={isExpired || downloading}
        aria-label={isExpired ? t('card.expired') : t('card.download')}
        title={isExpired ? t('card.expired') : t('card.download')}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {downloading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Download className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
    </li>
  );
}
