/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 空间级导出 / 回导 bundle 的客户端预检、体积口径与下载命名（纯函数，无 React 依赖）
 *
 * [代码职责]
 *   - 定义 bundle 请求体体积口径常量与文件读取守卫、解析预检（errorKey 权威表）、
 *     下载文件名生成、覆盖篇数核对
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/product-overview.md` — DocSpace 空间导入/导出一节
 *   - 补充: 线上 `docs/api-definition.md` — GET /doc-spaces/:id/export 与 POST /doc-spaces/:id/import-bundle
 *
 * [关键不变量]
 *   - 判超口径 = **紧凑 JSON 的 UTF-8 字节数**（= axios 实际发出的请求体字节）；
 *     服务端 DOC_BUNDLE_ENVELOPE_MARGIN_BYTES(64KiB) 是其内部记账余量，客户端**不得二次扣减**
 *   - 超限 bundle 在任何 HTTP/MCP 通道都导不回（body-parser 与 nginx 同为 10m），文案不得指向回导端点
 *   - `docs` 缺席 = 合法的 0 篇包（服务端 DTO 可选）；只有「存在但非数组」才判非法
 *   - 读取守卫必须在 `file.text()` **之前**判（先读进内存再判等于没判）
 *
 * [关联代码]
 *   - `apps/web/src/components/docs/import-bundle-dialog.tsx` — 唯一消费者（预检 + 文案表）
 *   - `apps/backend/src/modules/docspace/doc-bundle.constants.ts:20,27` — 服务端侧同口径常量
 *   - `apps/backend/src/modules/docspace/doc-bundle.service.ts:152-177` — bundle 形状权威
 *
 * [持久踩坑]
 *   - BUNDLE-UI-1(体积口径): 用 `text.length` 或 pretty JSON 判超会误判（axios 发的是紧凑 JSON）。
 *     安全方向：判超一律走 serializedBodySize()
 *   - BUNDLE-UI-2(docs 缺席): 把「docs 缺席」当非法包会让合法的空包无法回导。安全方向：缺席 = 0 篇
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { DocSpaceBundleDocItem, DocSpaceExportBundle } from '@/types';

/**
 * bundle 请求体体积上限（10MiB）——与后端 `DOC_BUNDLE_MAX_BYTES` 同值。
 *
 * 判据口径：**紧凑 JSON 的 UTF-8 字节数**（`JSON.stringify` 无缩进 = axios 实际发出的
 * 请求体字节）。服务端 64KiB 信封余量是内部记账（媒体额度 = MAX − docs − MARGIN），
 * 客户端不得二次扣减；超过本值 = 任何 HTTP/MCP 通道都导不回。
 */
export const BUNDLE_BODY_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 文件读取守卫（32MB）：超过则不进入 `file.text()`。
 *
 * 取值理由：合法 bundle 上限 10MiB，32MB 留足 pretty 缩进 / BOM 等膨胀余量，
 * 同时挡住误选的大文件（先读进内存再判超等于没判）。
 */
export const FILE_READ_GUARD_BYTES = 32 * 1024 * 1024;

/** bundle 预检错误码 */
export type BundleErrorKey =
  | 'fileTooLargeToRead'
  | 'tooLarge'
  | 'invalidJson'
  | 'missingSpace'
  | 'unsupportedVersion'
  | 'docsNotArray';

/**
 * errorKey → i18n key（相对 `docs.bundle` 命名空间）——**文案唯一权威表**。
 *
 * 值类型为模板字面量联合（非 string）：next-intl 的 `t()` 只接受字面量键，
 * 宽化的 string 会被类型检查拒绝（组件以此表反查文案，禁止另写 errorKey → 文案映射）。
 */
export type BundleErrorMessageKey = `errors.${BundleErrorKey}`;

export const BUNDLE_ERROR_MESSAGE_KEYS: Record<BundleErrorKey, BundleErrorMessageKey> = {
  fileTooLargeToRead: 'errors.fileTooLargeToRead',
  tooLarge: 'errors.tooLarge',
  invalidJson: 'errors.invalidJson',
  missingSpace: 'errors.missingSpace',
  unsupportedVersion: 'errors.unsupportedVersion',
  docsNotArray: 'errors.docsNotArray',
};

/** bundle 五段计数（media 段拆「完整项 / skipped 标记」；docs 缺席 = 0） */
export interface BundleCounts {
  categories: number;
  routes: number;
  docs: number;
  /** media 段完整项（携带字节） */
  media: number;
  /** media 段 `{skipped}` 标记项（导出侧因单项上限/预算未打包） */
  mediaSkipped: number;
  /** mediaOmitted（正文引用但刻意未打包 → 回导后断链） */
  mediaOmitted: number;
}

/** 预检结果（判别联合：ok=true 才携带可回导的 bundle 与计数） */
export type BundlePreviewResult =
  | { ok: true; bundle: DocSpaceExportBundle; counts: BundleCounts }
  | { ok: false; errorKey: BundleErrorKey };

/** 读取守卫：size 超过 FILE_READ_GUARD_BYTES 时禁止读取（内存保护） */
export function isOverReadGuard(sizeBytes: number): boolean {
  return sizeBytes > FILE_READ_GUARD_BYTES;
}

/** 请求体体积口径：紧凑 JSON 的 UTF-8 字节数（= axios POST 实际发出的 body 字节） */
export function serializedBodySize(parsed: unknown): number {
  return new Blob([JSON.stringify(parsed)]).size;
}

/** 数组段长度（字段可缺席 / 形状可疑时不炸，按 0 计） */
function sectionLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * media 段条目是否为导出侧 `{skipped}` 标记（无字节，仅有元数据）。
 *
 * **对任意输入安全**：bundle 文本来自用户文件，条目可能是 null / 字符串 / 数字，
 * 裸 `'skipped' in entry` 会抛 TypeError（`in` 右操作数必须为对象）——预检必须全函数。
 *
 * @param entry bundle.media[] 的元素（unknown：不信任入参形状）
 * @returns 该条目是否为 `{skipped: ...}` 标记
 */
export function isSkippedMediaEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && 'skipped' in entry;
}

/**
 * media 段计数：`items` = 有字节的对象条目，`skipped` = `{skipped}` 标记。
 *
 * 其余形状（null / 标量 / 数组）一律**不计入任一桶**（不是"完整项"，也不是"跳过项"）。
 * 收口在此：组件侧复用本函数计数，不得另写 `'skipped' in entry`（重复实现 = 重复的崩溃面）。
 */
export function countMediaEntries(media: unknown): { items: number; skipped: number } {
  if (!Array.isArray(media)) return { items: 0, skipped: 0 };
  let items = 0;
  let skipped = 0;
  for (const entry of media) {
    if (isSkippedMediaEntry(entry)) skipped += 1;
    else if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) items += 1;
  }
  return { items, skipped };
}

/**
 * 条项是否为可回导的 doc 条目（对象 + 非空 string path）。
 * 类型谓词：预检阶段用它把 unknown 收窄为 DocSpaceBundleDocItem（同服务端 DTO 必填口径）。
 */
function isDocItem(value: unknown): value is DocSpaceBundleDocItem {
  if (typeof value !== 'object' || value === null) return false;
  const path = (value as { path?: unknown }).path;
  return typeof path === 'string' && path !== '';
}

/**
 * 解析并预检 bundle 文本（选择文件 → parse → 结构 / 版本 / 体积三段校验）。
 *
 * 顺序：JSON 解析 → 顶层对象 → formatVersion ∈ {1,2} → space.name 非空字符串 →
 * docs 条项形状（每条须为含非空 string path 的对象）→ 体积。
 * **docs 缺席按 0 篇放行**（合法的空包）。
 *
 * 全函数契约：任意文本输入都返回判别联合，**不抛异常**（bundle 文本来自用户文件）。
 */
export function parseBundlePreview(text: string): BundlePreviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errorKey: 'invalidJson' };
  }
  // 顶层非对象（含 null / 数组 / 标量）：既非 bundle 也谈不上缺字段，统一按「缺空间信息」处理
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errorKey: 'missingSpace' };
  }

  const candidate = parsed as Partial<DocSpaceExportBundle>;
  // 版本：缺席等同于不在值域（后端 DTO 亦要求 formatVersion 必填）
  if (candidate.formatVersion !== 1 && candidate.formatVersion !== 2) {
    return { ok: false, errorKey: 'unsupportedVersion' };
  }

  const space = candidate.space;
  if (!space || typeof space.name !== 'string' || space.name.trim() === '') {
    return { ok: false, errorKey: 'missingSpace' };
  }

  // docs：缺席 = 合法的 0 篇包；存在但非数组 / 含非对象条项 / 条项缺 path
  // → 不是平台导出的 bundle（服务端 BundleDocItemDto.path 为 @IsString+@IsNotEmpty 必填，同口径）
  const rawDocs = (candidate as { docs?: unknown }).docs;
  if (rawDocs !== undefined && (!Array.isArray(rawDocs) || !rawDocs.every(isDocItem))) {
    return { ok: false, errorKey: 'docsNotArray' };
  }

  const bundle = candidate as DocSpaceExportBundle;
  if (serializedBodySize(bundle) > BUNDLE_BODY_MAX_BYTES) {
    return { ok: false, errorKey: 'tooLarge' };
  }

  const mediaEntries = Array.isArray(bundle.media) ? bundle.media : [];
  const media = countMediaEntries(mediaEntries);
  return {
    ok: true,
    bundle,
    counts: {
      categories: sectionLength(bundle.categories),
      routes: sectionLength(bundle.routes),
      docs: sectionLength(bundle.docs),
      media: media.items,
      mediaSkipped: media.skipped,
      mediaOmitted: sectionLength(bundle.mediaOmitted),
    },
  };
}

/**
 * 导出名 slug（JSON 与人类可读 ZIP 共用的唯一规则，防两条命名规则漂移）。
 *
 * slug = 空间名转小写后非字母数字折叠为 `-` 并去首尾；纯中文名折叠为空 → 回退 spaceId 前 8 位。
 */
export function bundleSlug(spaceName: string, spaceId: string): string {
  const slug = spaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || spaceId.slice(0, 8);
}

/**
 * 导出文件名：`docspace-{slug}-{YYYY-MM-DD}.json`（日期取 UTC，同监控页导出先例）。
 *
 * slug 规则见 `bundleSlug`（与人类可读 ZIP 侧同法）。
 */
export function bundleDownloadName(
  spaceName: string,
  spaceId: string,
  date: Date = new Date(),
): string {
  return `docspace-${bundleSlug(spaceName, spaceId)}-${date.toISOString().slice(0, 10)}.json`;
}

/**
 * 覆盖篇数核对：bundle.docs 中 path 已存在于目标空间的条数（交集计数）。
 *
 * 仅用于「已完整取到目标空间 path 列表」的场景——列表被截断时该值只是下界，
 * 截断判定由调用方用 `space.docCount` 交叉校验。
 *
 * 对任意条项安全（`doc?.path`）：预检已拒非法条项，但本函数在渲染期被调用，
 * 不信任入参形状可避免"预检漏网即整页崩溃"。
 */
export function countOverwrite(
  bundleDocs: DocSpaceBundleDocItem[] | undefined,
  existingPaths: string[],
): number {
  if (!bundleDocs || bundleDocs.length === 0) return 0;
  const existing = new Set(existingPaths);
  return bundleDocs.filter((doc) => typeof doc?.path === 'string' && existing.has(doc.path)).length;
}
