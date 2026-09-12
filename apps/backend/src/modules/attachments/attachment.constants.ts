/**
 * Attachments 模块业务常量（plan wiccan-carnage-rocket §3.1/§3.4 钉死值）
 *
 * 集中放置的原因：controller（multer limits / @Throttle）与 service（防御性复检 /
 * 配额事务）消费同一组阈值，必须单一事实源；env 覆盖仅影响新进程（模块加载期求值，
 * 对齐 auth.controller.ts THROTTLE 常量先例）。
 */

/** 测试环境判定（auth.controller.ts:53 先例：JEST_WORKER_ID 兼容 jest 单测与 e2e） */
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

/**
 * 单文件字节上限（默认 8MiB）。
 * 与 nginx client_max_body_size 10m 的层级关系：nginx 先拦 >10m（413 无业务码），
 * multer limits.fileSize 拦 >8MiB（413 + ATTACHMENT_TOO_LARGE），service 防御性复检兜底。
 */
export const ATTACHMENT_MAX_BYTES = parseInt(
  process.env.ATTACHMENT_MAX_BYTES || String(8 * 1024 * 1024),
  10,
);

/**
 * 每上传者累计存储配额（默认 200MiB）。
 * 口径：SUM(size_bytes) WHERE uploader_id=? AND deleted_at IS NULL（软删即释放）；
 * 检查与插行同一事务 + pg_advisory_xact_lock（见 attachment.service.ts upload）。
 */
export const ATTACHMENT_QUOTA_BYTES = parseInt(
  process.env.ATTACHMENT_QUOTA_BYTES || String(200 * 1024 * 1024),
  10,
);

/**
 * 上传限流：30 次/分钟/IP（内存存储，按 IP——nginx 反代共享 IP 前提与 auth 先例一致）。
 * 测试环境放宽（防 e2e 并发套件误伤，auth.controller 先例）。
 */
export const ATTACHMENT_UPLOAD_THROTTLE_LIMIT = isTestEnv
  ? 100_000
  : parseInt(process.env.THROTTLE_ATTACHMENT_LIMIT || '30', 10);
export const ATTACHMENT_UPLOAD_THROTTLE_TTL_MS = 60_000;

/**
 * 防解码炸弹尺寸上限（只解析图片头部，不完整解码）：
 * 单边 ≤ 16384px 且总像素 ≤ 40MP。超限/头部无法解析一律 400。
 */
export const ATTACHMENT_MAX_DIMENSION_PX = 16_384;
export const ATTACHMENT_MAX_TOTAL_PIXELS = 40_000_000;
