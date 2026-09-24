/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 空间导出 bundle → 「人类可读 ZIP」的纯函数转换（docs 目录树 / 附件原文件 /
 *     正文附件 URL 相对化 / README 说明）
 *
 * [代码职责]
 *   - 把 `GET /doc-spaces/:id/export` 返回的 bundle（JSON）装配成 ZIP 条目表：
 *     path 消毒与去重、base64 → 字节、附件配对表、逐 doc 相对路径重写、README 文本生成、
 *     根目录 / 下载命名。无 React / next-intl 依赖（文案由调用方注入）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/product-overview.md` — DocSpace 空间导出 / 导入一节
 *   - 补充: 线上 `docs/api-definition.md` — GET /doc-spaces/:id/export（bundle 形状与 media 段）
 *
 * [关键不变量]
 *   - **只读派生**：本 lib 不改 bundle 格式、不回写任何字段；ZIP 是单向产物，**不可回导**
 *     （回导唯一入口 = JSON bundle）
 *   - URL 重写**仅限配对表内 id**（= 确实写进 `attachments/` 的媒体项）；skipped / mediaOmitted
 *     项、`/public/attachments/...` 签名 URL、`/thumbnail` 引用一律保留原样
 *   - 重写目标必须是**相对路径**（逐 doc 按 dirname 计算），否则本地 Markdown 预览断图
 *   - ZIP 内所有键都落在同一根目录前缀下（防解压散落到用户当前目录）
 *   - `README.md` 名字先占位：文档 path 恰为 `README.md` 时会被去重改名，不得覆盖导出说明
 *
 * [关联代码]
 *   - `apps/web/src/lib/doc-bundle.ts` — `bundleSlug`（JSON / ZIP 共用命名规则）、JSON 导出链
 *   - `apps/web/src/components/docs/export-menu.tsx` — 双格式导出入口菜单
 *   - `apps/web/src/app/(main)/docs/[id]/page.tsx` — 唯一装配调用方（fetch → build → fflate zip）
 *   - `apps/backend/src/modules/docspace/doc-bundle.service.ts:188-223` — media / mediaOmitted 形状权威
 *
 * [持久踩坑]
 *   - HUMAN-ZIP-1(签名 URL): `/public/attachments/<id>/content?token=...` 是 topic 绑定附件的签名
 *     URL，字节不在 bundle 内 → 重写必成死链。安全方向：正则前置字符守卫（`/public/` 天然不匹配）
 *     + 只重写配对表内 id
 *   - HUMAN-ZIP-2(URL 形态): 正文里的附件 URL 有三种形态（带 API 前缀的相对 / 裸 `/attachments/` /
 *     绝对 URL），只认一种会漏改写。安全方向：三形态同一条正则，改动前先看单测矩阵
 *   - HUMAN-ZIP-3(编码): jsdom 测试环境无 `TextEncoder` 全局 → 本文件手写 UTF-8 编码，
 *     不要图省事换回全局（lib 需在 SSR / 浏览器 / jsdom 三处同构运行）
 *   - HUMAN-ZIP-4(ICU 碰撞): README 文案先经 next-intl（ICU MessageFormat）渲染，`{key}`
 *     占位符会被 ICU 当参数——t() 不传 values 时返回**原始键名**（2026-09-15 Playwright
 *     实证：README 出现 `# docs.bundle.export.readme.title` 字面量）。安全方向：占位符
 *     一律 `%key%`；守门 = 单测静态守卫（readme 文案禁 `\{\w+\}`）+ Playwright 真实链路
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { DocSpaceExportBundle } from '@/types';
import { bundleSlug } from '@/lib/doc-bundle';

/** ZIP 条目表：key = ZIP 内完整相对路径（已含根目录前缀），value = 文件字节 */
export type HumanExportFiles = Record<string, Uint8Array>;

/**
 * 装配统计（README 计数 + 单测断言面）。
 *
 * `skipped` / `omitted` / `invalidMedia` 三者都是「未打包」但成因不同，分开计数以便排错；
 * README 面向读者只给一个合计（见 `buildReadme`）。
 */
export interface HumanExportStats {
  /** 写入 ZIP 的文档篇数 */
  docs: number;
  /** 解出原文件的附件数（不含 skipped / mediaOmitted） */
  attachments: number;
  /** bundle.media 中的 `{skipped}` 标记数（导出侧因上限未打包） */
  skipped: number;
  /** bundle.mediaOmitted 条数（topic 绑定附件，字节不在 bundle 内） */
  omitted: number;
  /** 形状可疑 / base64 非法的媒体条项数（跳过，不写入） */
  invalidMedia: number;
  /** 原 path 非法、被改名放入 `__invalid-path__/` 的文档数 */
  invalidPaths: number;
  /** 消毒后重名（文档 / 附件）被追加短 id 去重的次数 */
  deduped: number;
  /** 正文中被改写成相对路径的附件 URL 出现次数 */
  rewrittenUrls: number;
}

/** 装配结果 */
export interface HumanExportResult {
  files: HumanExportFiles;
  stats: HumanExportStats;
  /** 根目录名（`docspace-<slug>-<YYYY-MM-DD>`），调用方拼下载名用 */
  rootName: string;
}

/**
 * README 文案（**由调用方按 UI locale 注入**——本 lib 不依赖 next-intl）。
 *
 * 每条都是「纯文本行」，markdown 结构（标题层级 / 列表符号 / 分隔线）由 lib 自己产出：
 * 换 locale 时只换文字，不换排版。
 */
export interface HumanExportReadmeTexts {
  /** 文档标题行，`%space%` = 空间名 */
  title: string;
  /** 导出时间行，`%time%` = ISO 8601 */
  exportedAt: string;
  /** 文档计数行，`%count%` = 篇数（0 也出行） */
  docs: string;
  /** 附件计数行，`%count%` = 附件数（0 也出行，R5 零值形态） */
  attachments: string;
  /** 未打包附件提示行，`%count%` = skipped + omitted + invalidMedia（仅 >0 出行） */
  unpacked: string;
  /** 正文链接已相对化说明（仅 attachments > 0 出行） */
  linksRewritten: string;
  /** 路径异常小节标题（仅 invalidPaths > 0 出行） */
  invalidTitle: string;
  /** 路径异常小节导语 */
  invalidHint: string;
  /** 单条改名记录，`%from%` = 原 path，`%to%` = ZIP 内路径 */
  invalidItem: string;
  /** 回导指引（**必须明示本 ZIP 不可回导**，指向 JSON bundle 导出） */
  restoreHint: string;
}

/** 装配入参 */
export interface HumanExportOptions {
  /** README 文案（locale 注入） */
  texts: HumanExportReadmeTexts;
  /** 当前空间 id（空间名折叠为空时的 slug 回退，与 JSON 侧同法） */
  spaceId: string;
  /** 导出时间（根目录日期 + README 时间戳），默认 now */
  date?: Date;
}

/** path 消毒结果 */
export interface SanitizedDocPath {
  /** 消毒后的 ZIP 内相对路径（不含根目录前缀） */
  path: string;
  /** true = 原 path 非法（`..` / 空段 / 反斜杠），已归入 `__invalid-path__/` */
  invalid: boolean;
}

/** ZIP 内非法 path 的收容目录（D3） */
export const INVALID_PATH_DIR = '__invalid-path__';

/**
 * 附件正文 URL 三形态正则（R1）：带 API 前缀的相对 / 裸 `/attachments/` / 绝对 URL。
 *
 * 结构 = 前置字符守卫 + 三形态交替 + id 捕获组；`m` 标志未开（不跨行匹配 URL）。
 * 守卫 `[^A-Za-z0-9_/.-]` 的作用：把 `/public/attachments/...`（前一字符是 `c`）、
 * 绝对 URL 里 host 后的 `/api/v1/...`（前一字符是 host 末字符）这两类**子串误匹配**挡掉，
 * 比 lookbehind 稳（旧 Safari 不支持 lookbehind，会直接编译报错）。
 */
const ATTACHMENT_CONTENT_URL_RE =
  /(^|[^A-Za-z0-9_/.-])((?:https?:\/\/[^\s/"'()<>]+\/api\/v1\/attachments\/|\/api\/v1\/attachments\/|\/attachments\/)([A-Za-z0-9_-]{1,64})\/content(?:\?[^\s"'()<>]*)?)/g;

/**
 * `%key%` 占位符替换（文案模板用；缺失键保留原样，便于暴露漏配文案）。
 *
 * 占位符刻意用 `%key%` 而非 `{key}`：README 文案先经 next-intl（ICU MessageFormat）
 * 渲染，`{arg}` 会被 ICU 当参数——t() 不传 values 时 next-intl 直接返回**原始键名**
 * （HUMAN-ZIP-4，Playwright 实证抓出：`# docs.bundle.export.readme.title` 进 ZIP）。
 */
function format(template: string, vars: Record<string, string | number>): string {
  return template.replace(/%(\w+)%/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/**
 * UTF-8 编码（**手写**：jsdom 测试环境无 `TextEncoder` 全局；见 [持久踩坑] HUMAN-ZIP-3）。
 *
 * 逐码点迭代（`for...of` 合并代理对），按 UTF-8 规则产出 1-4 字节。
 */
function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/**
 * 标准 padded base64 → 字节。非法输入由 `atob` 抛错，调用方按「跳过该条项」处理。
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 文件名消毒（D3）：去路径分隔符（防解压时建目录 / 目录穿越）与控制字符；空结果回退占位名。
 */
export function sanitizeFileName(name: string): string {
  const cleaned = (typeof name === 'string' ? name : '')
    .replace(/[\\/]+/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return cleaned || 'attachment';
}

/**
 * doc path → ZIP 内相对路径（D3）。
 *
 * 合法：去开头 `/` 后按段使用（保留 `docs/x.md` 目录树形态）。
 * 非法（归入 `__invalid-path__/<docId前8>-<basename>`）：空路径、含反斜杠、存在空段（含首尾
 * 多余斜杠与 `//`）或 `..` / `.` 段。`.` 一并判非法：单段 `.` 会变成 ZIP 里的目录条目，
 * 不是文件——比放行更危险的静默形态。
 */
export function sanitizeDocPath(path: string, docId?: string): SanitizedDocPath {
  const raw = typeof path === 'string' ? path : '';
  const shortId = (docId ?? '').slice(0, 8);
  const candidate = raw.replace(/^\/+/, '');
  const segments = candidate.split('/');
  const illegal =
    candidate === '' ||
    raw.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (!illegal) return { path: candidate, invalid: false };

  const basename = sanitizeFileName(
    segments.filter((segment) => segment !== '' && segment !== '.' && segment !== '..').pop() ?? '',
  );
  return {
    path: `${INVALID_PATH_DIR}/${shortId ? `${shortId}-` : ''}${basename}`,
    invalid: true,
  };
}

/**
 * 根目录名 = `docspace-<slug>-<YYYY-MM-DD>`（日期取 UTC，与 JSON 导出同日）。
 *
 * 下载名（`.zip`）与 ZIP 内根目录同名，解压后目录名即文件名，便于多空间区分。
 */
export function zipRootName(spaceName: string, spaceId: string, date: Date = new Date()): string {
  return `docspace-${bundleSlug(spaceName, spaceId)}-${date.toISOString().slice(0, 10)}`;
}

/** 人类可读 ZIP 下载名：根目录名 + `.zip`（D8） */
export function humanExportDownloadName(
  spaceName: string,
  spaceId: string,
  date: Date = new Date(),
): string {
  return `${zipRootName(spaceName, spaceId, date)}.zip`;
}

/** 在扩展名前插入后缀（`a/b.md` + `abc12345` → `a/b-abc12345.md`；无扩展名则直接追加） */
function insertBeforeExtension(relPath: string, suffix: string): string {
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  if (dot > slash + 1) return `${relPath.slice(0, dot)}-${suffix}${relPath.slice(dot)}`;
  return `${relPath}-${suffix}`;
}

/**
 * 消毒后重名去重（D3）：优先追加 `-<短 id>`，仍冲突则继续追加序号（全函数，绝不返回重复键）。
 *
 * @param relPath 已消毒的相对路径
 * @param used 已占用路径集合（调用方维护，本函数负责登记新值）
 * @param suffixSource 短 id 来源（docId / 附件 id）
 * @param onDedupe 去重发生时的回调（统计用）
 */
function dedupePath(
  relPath: string,
  used: Set<string>,
  suffixSource: string,
  onDedupe: () => void,
): string {
  if (!used.has(relPath)) {
    used.add(relPath);
    return relPath;
  }
  onDedupe();
  const suffix = (suffixSource || '').slice(0, 8);
  let candidate = insertBeforeExtension(relPath, suffix || 'dup');
  let counter = 2;
  while (used.has(candidate)) {
    candidate = insertBeforeExtension(relPath, `${suffix || 'dup'}-${counter}`);
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** 目录部分（POSIX 语义；根目录文档返回空串） */
function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

/**
 * 从文档目录到 ZIP 内目标文件的相对路径（POSIX；本地 Markdown 预览靠它找图）。
 *
 * 例：`docs/a.md` → `../attachments/x`；根目录文档 → `attachments/x`；`docs/sub/a.md` → `../../attachments/x`。
 */
function relativeFrom(docDir: string, target: string): string {
  if (docDir === '') return target;
  const from = docDir.split('/');
  const to = target.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }
  return [...new Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

/**
 * Markdown 链接里的最少转义：空格与圆括号会截断 `![alt](url)` 语法。
 *
 * 非 ASCII（中文附件名）**不编码**——主流渲染器直接可用，`encodeURIComponent` 只会让链接难读。
 */
function encodeMarkdownPath(relPath: string): string {
  return relPath.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** 媒体完整项窄化结果（不信任 bundle.media 的入参形状） */
interface HumanExportMediaItem {
  sourceAttachmentId: string;
  originalName: string;
  contentBase64: string;
}

/** bundle.media[] 条项是否为 `{skipped}` 标记（对象 + 有 skipped 键） */
function isSkippedMediaEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && 'skipped' in entry;
}

/**
 * 媒体完整项窄化：三项关键字段齐备才算可用（缺任一 → 该条项跳过并计入 invalidMedia）。
 * `originalName` 缺席不判非法（消毒阶段会回退占位名）。
 */
function asMediaItem(entry: unknown): HumanExportMediaItem | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const id = item.sourceAttachmentId;
  const base64 = item.contentBase64;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof base64 !== 'string' || base64 === '') return null;
  return {
    sourceAttachmentId: id,
    originalName: typeof item.originalName === 'string' ? item.originalName : '',
    contentBase64: base64,
  };
}

/** 文档条项窄化结果 */
interface HumanExportDocItem {
  path: string;
  docId: string;
  content: string;
}

/** 文档条项窄化：`path` 必须为非空 string 才可用（同 `doc-bundle.isDocItem` 口径） */
function asDocItem(entry: unknown): HumanExportDocItem | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  if (typeof item.path !== 'string' || item.path === '') return null;
  return {
    path: item.path,
    docId: typeof item.docId === 'string' ? item.docId : '',
    content: typeof item.content === 'string' ? item.content : '',
  };
}

/** 数组段长度（字段缺席 / 形状可疑时按 0 计，不炸） */
function sectionLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** 生成 README 全文（结构由 lib 拥有，文案由调用方注入） */
function buildReadme(
  spaceName: string,
  exportedAt: string,
  stats: HumanExportStats,
  invalidPaths: { from: string; to: string }[],
  texts: HumanExportReadmeTexts,
): string {
  const lines: string[] = [];
  lines.push(`# ${format(texts.title, { space: spaceName })}`);
  lines.push('');
  lines.push(`- ${format(texts.exportedAt, { time: exportedAt })}`);
  lines.push(`- ${format(texts.docs, { count: stats.docs })}`);
  lines.push(`- ${format(texts.attachments, { count: stats.attachments })}`);

  const unpacked = stats.skipped + stats.omitted + stats.invalidMedia;
  if (unpacked > 0) lines.push(`- ${format(texts.unpacked, { count: unpacked })}`);
  if (stats.attachments > 0) lines.push(`- ${texts.linksRewritten}`);

  if (invalidPaths.length > 0) {
    lines.push('');
    lines.push(`## ${texts.invalidTitle}`);
    lines.push('');
    lines.push(texts.invalidHint);
    lines.push('');
    for (const item of invalidPaths) {
      lines.push(`- ${format(texts.invalidItem, { from: item.from, to: item.to })}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(texts.restoreHint);
  lines.push('');
  return lines.join('\n');
}

/**
 * bundle → ZIP 条目表（纯函数，不抛异常）。
 *
 * 处理顺序（**顺序即语义**）：
 * ① 媒体先行——解 base64 并建「原附件 id → ZIP 内附件路径」配对表，同时让 `attachments/`
 *    下的文件名先占位（文档 path 撞名时由文档侧去重改名）；
 * ② 文档——path 消毒 / 去重 → 逐篇按 dirname 计算相对路径并重写正文 URL；
 * ③ README——最后写，`README.md` 名字在 ② 之前已登记占位。
 */
export function buildHumanExportEntries(
  bundle: DocSpaceExportBundle,
  options: HumanExportOptions,
): HumanExportResult {
  const date = options.date ?? new Date();
  const spaceName = typeof bundle?.space?.name === 'string' ? bundle.space.name : '';
  const rootName = zipRootName(spaceName, options.spaceId, date);
  const prefix = `${rootName}/`;

  const files: HumanExportFiles = {};
  const used = new Set<string>(['README.md']); // 导出说明先占位，防被同名文档覆盖
  const invalidPaths: { from: string; to: string }[] = [];
  const stats: HumanExportStats = {
    docs: 0,
    attachments: 0,
    skipped: 0,
    omitted: sectionLength(bundle?.mediaOmitted),
    invalidMedia: 0,
    invalidPaths: 0,
    deduped: 0,
    rewrittenUrls: 0,
  };
  const bumpDedupe = () => {
    stats.deduped += 1;
  };

  // ① 附件：解字节 + 建配对表
  const media = Array.isArray(bundle?.media) ? bundle.media : [];
  const pairing = new Map<string, string>();
  for (const entry of media) {
    if (isSkippedMediaEntry(entry)) {
      stats.skipped += 1;
      continue;
    }
    const item = asMediaItem(entry);
    if (!item) {
      stats.invalidMedia += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(item.contentBase64);
    } catch {
      stats.invalidMedia += 1;
      continue;
    }
    const fileName = `${item.sourceAttachmentId.slice(0, 8)}-${sanitizeFileName(item.originalName)}`;
    const relPath = dedupePath(
      `attachments/${fileName}`,
      used,
      item.sourceAttachmentId,
      bumpDedupe,
    );
    files[prefix + relPath] = bytes;
    // 同一 id 多次出现（理论不可达）时以首个为准：正文重写只需一个确定目标
    if (!pairing.has(item.sourceAttachmentId)) pairing.set(item.sourceAttachmentId, relPath);
    stats.attachments += 1;
  }

  // ② 文档：消毒 → 去重 → 正文 URL 相对化
  const docs = Array.isArray(bundle?.docs) ? bundle.docs : [];
  for (const entry of docs) {
    const doc = asDocItem(entry);
    if (!doc) continue;
    const sanitized = sanitizeDocPath(doc.path, doc.docId);
    if (sanitized.invalid) {
      stats.invalidPaths += 1;
      invalidPaths.push({ from: doc.path, to: sanitized.path });
    }
    const relPath = dedupePath(sanitized.path, used, doc.docId, bumpDedupe);
    const docDir = dirOf(relPath);
    const content = doc.content.replace(
      ATTACHMENT_CONTENT_URL_RE,
      (match: string, guard: string, _url: string, id: string) => {
        const target = pairing.get(id);
        // 未打包（skipped / omitted / 形状可疑）→ 保留原 URL：联网仍可访问，且不制造死链
        if (!target) return match;
        stats.rewrittenUrls += 1;
        return `${guard}${encodeMarkdownPath(relativeFrom(docDir, target))}`;
      },
    );
    files[prefix + relPath] = utf8Bytes(content);
    stats.docs += 1;
  }

  // ③ README：计数 + 路径异常记录 + 回导指引（不可回导 + 指向 JSON 导出）
  const exportedAt = date.toISOString();
  files[`${prefix}README.md`] = utf8Bytes(
    buildReadme(spaceName, exportedAt, stats, invalidPaths, options.texts),
  );

  return { files, stats, rootName };
}
