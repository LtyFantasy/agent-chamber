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

/**
 * 缩略图最长边（默认 512px，env ATTACHMENT_THUMB_MAX_EDGE 覆盖）。
 * 语义：webp 变体按 inside 缩放至最长边 ≤ 该值，**永不放大**（原图小于阈值时
 * 输出保持原尺寸）。仅影响新上传——存量附件不回溯生成（见 service upload）。
 */
export const ATTACHMENT_THUMB_MAX_EDGE = parseInt(
  process.env.ATTACHMENT_THUMB_MAX_EDGE || '512',
  10,
);

/** 缩略图 webp 编码质量（0-100；80 = 体积/观感平衡档位，非安全参数） */
export const ATTACHMENT_THUMB_QUALITY = 80;

/**
 * 缩略图解码并发信号量（同时最多 2 个 sharp 解码在途）。
 * 为什么必须有界：解码是 CPU 密集操作，上传限流是 30/min/IP（按 IP 计数，
 * 多上传者并发时并不互相削峰），无界解码会打满 libvips 线程池、拖慢同进程
 * 其他请求；2 与单实例 8MiB 上限的输入规模匹配（超出的请求排队等待）。
 */
export const ATTACHMENT_THUMB_DECODE_CONCURRENCY = 2;

// ─── 短时签名 URL（P2 批 2）────────────────────────────────────────────────

/**
 * 铸造端点限流：30 次/分钟/IP（`POST /attachments/:id/signed-url`）。
 * 语义：铸造是廉价但可被滥用的写审计操作（每次落一行 audit + 签一个 token），
 * 沿用上传端点同档位；测试环境放宽防 e2e 误伤（isTestEnv 同款范式）。
 */
export const ATTACHMENT_MINT_URL_THROTTLE_LIMIT = isTestEnv
  ? 100_000
  : parseInt(process.env.THROTTLE_ATTACHMENT_MINT_URL_LIMIT || '30', 10);
export const ATTACHMENT_MINT_URL_THROTTLE_TTL_MS = 60_000;

/**
 * 公开内容端点限流：60 次/分钟/IP（`GET /public/attachments/:id/content`）。
 * 为什么**比铸造宽松一倍**：该端点是页面/Agent 的正常读图路径（一张消息页可能
 * 同时拉多张原图 + 缩略图），过紧会误伤正常浏览；它不写库、不签凭证，
 * 滥用代价仅为带宽（对象存储侧另有成本），60/min 是"够用且能挡脚本循环"的档位。
 * 注：此前 IP 恒为 127.0.0.1（无 trust proxy）导致合桶，main.ts 已修（set('trust proxy', 1)）。
 */
export const ATTACHMENT_PUBLIC_CONTENT_THROTTLE_LIMIT = isTestEnv
  ? 100_000
  : parseInt(process.env.THROTTLE_ATTACHMENT_PUBLIC_CONTENT_LIMIT || '60', 10);
export const ATTACHMENT_PUBLIC_CONTENT_THROTTLE_TTL_MS = 60_000;

/**
 * 签名 URL 有效期边界（秒）：DTO `ttlSeconds` 声明区间 = [60, 3600]。
 * 下界 60：再短会让"铸造→转发→抓取"的正常链路在慢网络下自伤；
 * 上界 3600：能力 URL 无法撤销（软删附件是唯一失效手段），一小时是
 * "够用但泄露窗口可控"的折中；未显式传值时用 config
 * `attachmentUrl.ttlDefaultSeconds`（默认 300）。
 */
export const ATTACHMENT_SIGNED_URL_TTL_MIN_SECONDS = 60;
export const ATTACHMENT_SIGNED_URL_TTL_MAX_SECONDS = 3600;

/**
 * 签名 URL 变体值域（**单一事实源**：mint 请求 DTO 校验 / token 载荷 `var` 值 /
 * 公开端点分支 / audit newData.variant 共用）。
 * - original：原图对象（objectKey），Content-Type 取 DB mime_type；
 * - thumbnail：缩略图对象（thumbKey，恒 webp）；无缩略图的附件铸造该变体 → 404·12008。
 */
export const ATTACHMENT_SIGNED_URL_VARIANTS = ['original', 'thumbnail'] as const;

/** 签名 URL 变体类型（单源派生自 ATTACHMENT_SIGNED_URL_VARIANTS） */
export type AttachmentSignedUrlVariant = (typeof ATTACHMENT_SIGNED_URL_VARIANTS)[number];

/** 默认变体（DTO variant 缺省 = original；不签缩略图是因为存量附件多无 thumb） */
export const ATTACHMENT_SIGNED_URL_DEFAULT_VARIANT: AttachmentSignedUrlVariant = 'original';

/**
 * 签名 token 的 issuer（签发与校验必须同值，单一事实源）。
 * 为什么钉死 issuer：同一密钥下可能存在多族 token（会话/刷新），issuer 让
 * "这枚 token 是给谁用的"成为**被验签覆盖的声明**（jsonwebtoken 把 issuer 写进
 * 签名载荷并在 verify 时校验），跨族混用（拿刷新 token 打公开端点）当场失败。
 */
export const ATTACHMENT_SIGNED_URL_ISSUER = 'attachment-url';

/**
 * 签名 token 的 scope 值（签发与校验同源）。
 * 三断言之一（scope 不匹配 → 401·12006）：把"凭证用途"写进被签名的载荷，
 * 未来新增其它附件能力（如直传 URL）时不同 scope 天然不可互换。
 */
export const ATTACHMENT_SIGNED_URL_SCOPE = 'attachment:content';

/**
 * sharp 解码选项（安全评审 security M1 钉死，逐项 rationale）：
 * - limitInputPixels：复用上传侧 40MP 上限常量——头部尺寸校验之外，解码器
 *   自身再设像素天花板（双保险：头部解析与真实解码路径不一致时仍有兜底）；
 * - animated:false + pages:1：GIF/animated WebP 只解首帧（缩略图是静态封面，
 *   动画缩略图无产品价值且成倍放大解码面）；
 * - sequentialRead:true：单次顺序读（缩略图只解码一遍，不留随机访问面）；
 * - failOn 保持 sharp 默认 'warning'（**刻意不设 'error'**：untrusted input
 *   场景官方推荐 warning，'error' 的容错面反而更弱——评审复核实证）。
 */
export const ATTACHMENT_THUMB_DECODE_OPTIONS = {
  limitInputPixels: ATTACHMENT_MAX_TOTAL_PIXELS,
  animated: false,
  pages: 1,
  sequentialRead: true,
} as const;
