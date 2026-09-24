/**
 * DocSpace bundle formatVersion 2（媒体打包）预算与载荷上限（P2 批 5 / plan §⑤.1-⑤.3 钉死）。
 *
 * 为什么单独成文件：这组常量被三处消费——DTO（contentBase64 的 @MaxLength / media 的
 * @ArrayMaxSize / mimeType @IsIn）、导出侧联合预算计算、导入侧对称防御复检。三处必须是
 * 同一个数字，散落即漂移。
 *
 * 联合预算口径（plan §0 dx M4 / arch M2 / PM B2 行，architect 复核 B-1 修正）：
 * 单请求体上限是**双 10mb**（express `json({limit:'10mb'})` + nginx `client_max_body_size 10m`），
 * 因此媒体额度不能是固定值，必须是"总量减去其它段"的余量：
 *   `媒体额度 = DOC_BUNDLE_MAX_BYTES − docs 段实际 JSON 字节 − DOC_BUNDLE_ENVELOPE_MARGIN_BYTES`
 * 64KiB 余量覆盖：媒体段自身的 JSON 键开销（sourceAttachmentId/docPath/originalName/sha256
 * 等每项数百字节）、categories/routes/space 段、以及 JSON 转义的少量膨胀。
 */

/**
 * 单请求体硬上限（10MiB）——与 main.ts body-parser limit 及生产 nginx
 * client_max_body_size 同值（双端任一更小都会先 413，故取同值时本层预判才有效）。
 */
export const DOC_BUNDLE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 信封余量（64KiB）：留给媒体段 JSON 键开销 + 其余段（categories/routes/space）+
 * 转义膨胀的安全垫。刻意不用"精确计算每项开销"的路线——精确路线要预演整包序列化，
 * 复杂度换不到实际收益（该垫子占额度 0.6%）。
 */
export const DOC_BUNDLE_ENVELOPE_MARGIN_BYTES = 64 * 1024;

/**
 * 单项媒体载荷上限（默认 6MiB，指**原图原始字节数**）。
 * 依据：附件上传单文件上限 8MiB，base64 后 10.67MB 已超双 10mb 请求体上限——
 * 即"能上传的图"有一部分天生进不了 bundle，必须在导出侧显式落 `skipped:'too_large'`
 * 而不是让整包被 413 打回（可发现优于静默截断）。
 */
export const DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES = 6 * 1024 * 1024;

/**
 * 原图 base64 编码长度（标准 padded 字母表）：`4·⌈n/3⌉`。
 * 导出侧**读对象前**用 DB 列（size_bytes / thumb_size_bytes）按下式预判编码体积，
 * 避免"读了 6MiB 才发现预算不够"的内存浪费（plan §⑤.3 导出内存策略）。
 */
export function base64EncodedLength(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}

/** contentBase64 的 DTO 长度上限（与单项原始字节上限对齐：超出即格式错误 400） */
export const DOC_BUNDLE_MEDIA_BASE64_MAX_LENGTH = base64EncodedLength(
  DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES,
);

/**
 * 单包媒体条目数上限（DTO `@ArrayMaxSize` + 导出侧条目数闸门共用）。
 * 取值依据：每条媒体项的 JSON 键开销最坏约 1KB（docPath ≤512 字符 + originalName ≤255 +
 * 两个 64 位 hex + 数字），32 条 ≈ 32KB < 64KiB 信封余量；放开到 100 条则键开销本身
 * 就能吃掉余量。额度耗尽的剩余项落 `skipped:'budget_exceeded'`（理由与字节预算同族）。
 */
export const DOC_BUNDLE_MEDIA_MAX_ITEMS = 32;

/**
 * 媒体 MIME 白名单（DTO `@IsIn`）。
 * **单一事实源是 image-sniffer.sniffImageMime 的返回类型**（上传与 bundle 导入共用同一嗅探），
 * 这里只是把同一值域显式声明给 DTO 层做格式校验；改嗅探值域必须同步本数组。
 */
export const DOC_BUNDLE_MEDIA_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** 导出侧因预算/单项上限未能打包的媒体项 reason 值域（skipped 双形态，plan §⑤.2） */
export const DOC_BUNDLE_MEDIA_SKIP_REASONS = ['too_large', 'budget_exceeded'] as const;

export type DocBundleMediaSkipReason = (typeof DOC_BUNDLE_MEDIA_SKIP_REASONS)[number];

/**
 * 导入端点接受的 formatVersion 集合（plan §⑤.1：1 → 跳 media，结果信封 media 段全零值形状）。
 * 1 是存量快照格式（v1.55 起落 git 的 bundle 全是 1），必须保持可回导。
 */
export const DOC_BUNDLE_ACCEPTED_FORMAT_VERSIONS = [1, 2] as const;
