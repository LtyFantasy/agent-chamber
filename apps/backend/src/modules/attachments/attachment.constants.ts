/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 附件模块的**常量与判据单一事实源**：上限 / 限流 / TTL 档位 / 出口分叉 / 过期与就绪判据
 *
 * [代码职责]
 *   - 阈值常量：ATTACHMENT_MAX_BYTES(10MiB) / 配额 / 限流 / 签名 URL 变体与 TTL 边界
 *   - 判据纯函数（被 service / controller / GC / DocSpace 消费，禁止各处另写一份）：
 *     `isInlineImageMime` / `isAttachmentExpired` / `isAttachmentReadable` /
 *     `resolveAttachmentTtlMs` / `computeAttachmentExpiresAt`
 *   - 调度开关与批次：ATTACHMENT_EXPIRED_SWEEP_ENABLED / EXPIRED_SWEEP_BATCH_SIZE
 *   - 集中放置的原因：controller（multer limits / @Throttle）与 service（防御性复检 /
 *     配额事务）消费同一组阈值；env 覆盖仅影响新进程（模块加载期求值，
 *     对齐 auth.controller.ts THROTTLE 常量先例）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §16a「附件 TTL 与类型放开」— mime 不变量 / 410·12009 / TTL 词表
 *   - 补充: docs/architecture.md §3.2 — Attachments 模块（上传链与 GC 三轨）
 *
 * [铁律关联] #18(不变量检查) #21(双层校验) #17(测试契约) #11(注释)
 *
 * [关键不变量]
 *   - **INLINE_IMAGE_MIME_TYPES 是唯一 inline 判据，且必须精确相等成员判断**
 *     （`isInlineImageMime`）。禁前缀/正则：`image/svg+xml` 过闸 = 存储型 XSS；
 *     该值域与 image-sniffer 的返回类型逐字一致，新增图片格式两处同改。
 *   - **mime_type 列只承载字节证据**：4 种嗅探图片之一，或恒 `ATTACHMENT_FALLBACK_MIME`；
 *     非图片对象键后缀恒 `NON_IMAGE_OBJECT_EXT`('bin')——外部输入不进键空间/对象元数据。
 *   - **TTL fail-closed**：`resolveAttachmentTtlMs` 对缺省/未知/脏值一律回退
 *     `ATTACHMENT_TTL_DEFAULT`('7d')，**绝不回退 `never`**（回退 never = 把治理静默关掉）；
 *     档位键集受 shared `AttachmentTtl` 联合约束，漏搬档位即编译期报错。
 *   - **过期判据 = 严格 `expires_at < now()`**（`isAttachmentExpired`），与 GC 谓词、
 *     partial index `idx_attachments_expires_gc` 谓词逐字同义；null/非法日期串 → false
 *     （宁可可下载，也不因脏数据把资源置灰）。
 *   - 常量在**模块加载期**求值：env 变更需重启进程（`ATTACHMENT_EXPIRED_SWEEP_ENABLED`
 *     同规，测试环境恒 false）。
 *
 * [关联代码]
 *   - attachment.service.ts — 上传分类分支 / TTL 冻结 / 配额 SUM 谓词 / 字节面懒判与就绪谓词
 *   - attachment-gc.service.ts — 小时级过期回收（消费 EXPIRED_SWEEP_BATCH_SIZE 与开关）
 *   - attachment.controller.ts / attachment-public.controller.ts — 出口分叉与响应头单源
 *   - ../../../../packages/shared/src/constants/index.ts — ATTACHMENT_TTL_VALUES 值域单源
 *   - attachment.constants.spec.ts — 判据与档位的纯函数套件（改判据先看它）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增/修改判据必须被全模块单源复用（禁止在出口/GC/投影各写一份比较）
 *   □ 档位值域新增时同步 shared `ATTACHMENT_TTL_VALUES`（两处漂移 = 工具侧放行后端拒绝）
 * =============================================================================
 */
import type { AttachmentTtl } from '@agent-chamber/shared';

/** 测试环境判定（auth.controller.ts:53 先例：JEST_WORKER_ID 兼容 jest 单测与 e2e） */
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

/**
 * 单文件字节上限（默认 10MiB，业务口径记作 10MB）。
 * 与 nginx client_max_body_size 12m 的层级关系：nginx 先拦 >12m（413 无业务码），
 * multer limits.fileSize 拦 >10MiB（413 + ATTACHMENT_TOO_LARGE），service 防御性复检兜底。
 */
export const ATTACHMENT_MAX_BYTES = parseInt(
  process.env.ATTACHMENT_MAX_BYTES || String(10 * 1024 * 1024),
  10,
);

/**
 * 每上传者累计存储配额（默认 200MiB）。
 * 口径：SUM(size_bytes) WHERE uploader_id=? AND deleted_at IS NULL
 *       **AND (expires_at IS NULL OR expires_at > now())**（附件 TTL 批起：过期即不占配额，
 *       与小时级物理回收共同保证稳态物理占用 ≤ 2× 配额）；检查与插行同一事务 +
 *       pg_advisory_xact_lock（见 attachment.service.ts upload）。
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
 * 其他请求；2 与单实例 10MiB 上限的输入规模匹配（超出的请求排队等待）。
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

// ─── 类型放开与出口收紧（v1.90.0-dev 附件 TTL 批 §1.2）────────────────────────

/**
 * 可内联呈现的图片 mime **冻结常量**（单一事实源，对齐 ATTACHMENT_SIGNED_URL_VARIANTS 先例）。
 *
 * 三条字节出口（`GET /attachments/:id/content`、`/:id/thumbnail`、
 * `GET /public/attachments/:id/content`）**只做精确相等成员判断**
 * （见 {@link isInlineImageMime}）决定 inline/attachment 分叉：
 * - 命中 → `Content-Type = mime_type` + `Content-Disposition: inline`；
 * - 其余（含 `image/svg+xml` 等一切非枚举值）→ `application/octet-stream` + `attachment`。
 *
 * ⚠️ **禁止前缀/正则判断**（`startsWith('image/')` / `/^image\//`）：`image/svg+xml`
 * 是脚本执行面（SVG 内嵌 `<script>`），一旦过闸内联 = 直接存储型 XSS。
 * 值域必须与 `sniffImageMime` 的返回类型逐字一致——新增图片格式时两处同改。
 */
export const INLINE_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/** 可内联图片 mime 联合（单源派生自 INLINE_IMAGE_MIME_TYPES） */
export type InlineImageMimeType = (typeof INLINE_IMAGE_MIME_TYPES)[number];

/**
 * 非内联出口恒用的 Content-Type（**恒定值**，不取任何外部输入）。
 *
 * 语义：`mime_type` 只承载字节证据（4 种嗅探图片之一，或本常量）——客户端声明的
 * Content-Type 永不进该列（M1 不变量）。本常量同时是 `mime_type` 列对非图片行的
 * 唯一合法值、`storage.putObject` 对非图片对象的 Content-Type、以及非 inline
 * 出口的响应 Content-Type（三处同源）。
 */
export const ATTACHMENT_FALLBACK_MIME = 'application/octet-stream';

/**
 * 非图片附件的对象键后缀（**恒定**，M3 不变量）：`objectKey = ${uuid}.bin`。
 *
 * 为什么不从文件名/声明 mime 推导后缀：外部输入不得进入键空间（扩展名推导 =
 * 攻击者可控的键空间 + 与对象元数据的类型混淆面）。图片分支用嗅探 ext（闭合值域
 * png/jpg/gif/webp），非图片一律本值。bundle 导入侧另有自己的键规则（自产包恒图片）。
 */
export const NON_IMAGE_OBJECT_EXT = 'bin';

/**
 * 过期判据（**单一事实源**）：`expires_at` 非空且**严格早于** now。
 *
 * 与 GC 谓词 `expires_at < now() AND deleted_at IS NULL` / partial index 谓词
 * **逐字同义**——读取面（410）与回收面（物理删）必须对同一行在同一时刻给出同一
 * 判定，否则会出现"能读但已被回收"或"读不到却还没过期"的错位。
 *
 * 调用方按路径语义各自抛错（字节面 410·12009 / 引用与铸造面 400·12009），
 * 但判据只有这一个函数——禁止在各出口重写 `expiresAt < new Date()` 比较
 * （时钟基准与 null 语义一旦分叉，四表面口径即破）。
 *
 * 接受 Date 或 ISO 字符串（消息索引快照里是字符串，DB 行里是 Date）。
 * 非法日期字符串 → false（不判过期：宁可显示可下载，也不因脏数据把资源置灰）。
 *
 * @param expiresAt 过期时刻（null/undefined = 永久）
 * @param now 比较基准（显式注入便于测试）
 */
export function isAttachmentExpired(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  return ms < now.getTime();
}

/**
 * 字节读取路径的就绪谓词（m6）：非 'ready' 的行不得读字节。
 *
 * 背景：`status` 值域 {ready, pending}，全仓无 pending 写入方（潜伏态，presign 落地
 * 时统一收口）；读取字节面（content / thumbnail / resolvePublicContent）显式要求
 * 'ready'，未来 presign 引入半成品行时不会经既有出口泄漏半截字节。
 * **mint 侧刻意不加本谓词**（N5：pending 无写入方，铸造入口在 presign 落地时统一收口）。
 */
export function isAttachmentReadable(status: string): boolean {
  return status === 'ready';
}

/**
 * inline 判据：**精确相等**成员判断（唯一合法入口，禁止在出口处各写一份判断）。
 * @param mime 待判定的 mime（通常来自 attachment.mime_type）
 */
export function isInlineImageMime(mime: string): boolean {
  return (INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

// ─── 附件有效期（TTL）────────────────────────────────────────────────────────

/**
 * TTL 档位 → 毫秒映射（`never` → null = 永久）。
 * 键集受 `AttachmentTtl` 联合约束：shared 值域新增档位而此处漏搬 = 编译期报错。
 * 用 `Object.freeze` 冻结：这是"档位语义"的单源事实，运行期被改写等于契约漂移。
 */
export const ATTACHMENT_TTL_OPTIONS: Readonly<Record<AttachmentTtl, number | null>> = Object.freeze(
  {
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    never: null,
  },
);

/**
 * TTL 缺省档位（7d）。**fail-closed**：`settings.attachmentTtl` 缺省/脏值一律回退本档，
 * 绝不回退 `never`——回退 never 等于把治理目标静默关掉（对齐 maxRoundsWithoutHuman
 * 的"解析失败兜底缺省"先例，但兜底值的选择方向是安全侧）。
 */
export const ATTACHMENT_TTL_DEFAULT: AttachmentTtl = '7d';

/**
 * 解析 topic.settings.attachmentTtl → 毫秒（null = 永久）。
 *
 * 语义（§1.1）：**解析失败 ≠ never**。非字符串 / 未知档位 / 任意脏值 → 缺省 7d。
 * 白名单成员判断（hasOwnProperty）而非真值判断，防 `__proto__`/`constructor`
 * 之类的原型链键误命中。
 *
 * @param raw topic.settings.attachmentTtl 原值（jsonb，类型不可信）
 * @returns 毫秒数；null 表示永久（仅当显式 `'never'`）
 */
export function resolveAttachmentTtlMs(raw: unknown): number | null {
  if (
    typeof raw === 'string' &&
    Object.prototype.hasOwnProperty.call(ATTACHMENT_TTL_OPTIONS, raw)
  ) {
    return ATTACHMENT_TTL_OPTIONS[raw as AttachmentTtl];
  }
  return ATTACHMENT_TTL_OPTIONS[ATTACHMENT_TTL_DEFAULT];
}

/**
 * 计算附件过期时刻（上传时冻结，§1.1）。
 *
 * - topic 绑定：`now + ttl`；`never` → null；
 * - doc 绑定：**恒 null**（永久，豁免 TTL）——由调用方保证（传 rawTtl=null 且
 *   `permanent=true`，或直接不调用本函数）。
 *
 * @param rawTtl topic.settings.attachmentTtl 原值（doc 绑定传 null 且 permanent=true）
 * @param now 冻结时刻（显式注入便于测试；生产传 new Date()）
 * @param permanent true = 永久（doc 绑定/显式豁免）——短路返回 null，不做档位解析
 */
export function computeAttachmentExpiresAt(
  rawTtl: unknown,
  now: Date,
  permanent = false,
): Date | null {
  if (permanent) return null;
  const ttlMs = resolveAttachmentTtlMs(rawTtl);
  return ttlMs === null ? null : new Date(now.getTime() + ttlMs);
}

// ─── 小时级过期回收开关（§1.3 N3）─────────────────────────────────────────────

/**
 * 过期附件小时级物理回收（`sweepExpiredAttachments`）的调度开关。
 *
 * 为什么测试环境必须关（N3 硬约束）：小时级 cron 与"过期但行仍在"的 e2e 中间态
 * 天然冲突——测试跨过整点 :11 就会让 410 用例的 410 变 404（行被物理删）。
 * e2e 构造过期态一律走「关 sweep + 直改 DB expires_at」。
 *
 * 同款范式见 auth.controller.ts THROTTLE 常量（模块加载期求值，env 变更需重启）；
 * `ATTACHMENT_EXPIRED_SWEEP_ENABLED=false` 可显式关闭（运维手动降载通道）。
 */
export const ATTACHMENT_EXPIRED_SWEEP_ENABLED =
  !isTestEnv && process.env.ATTACHMENT_EXPIRED_SWEEP_ENABLED !== 'false';

/**
 * 过期回收单批处理条数（m2 评审）。
 *
 * 为什么必须分批：整批同时到期（例如某小时全量 TTL 到期）时，单轮把全部行读进内存
 * 并逐行删对象，会让本轮耗时超过 cron 周期（1h），与下一轮重叠——两轮并发删同一批行
 * 反而放大 MinIO 压力与行锁竞争。按 500 条一批循环，每批之间自然让出事件循环，
 * 且**下一轮 cron 只会看到尚未处理完的剩余行**（谓词按 expires_at ASC，先到期的先清）。
 *
 * 取值依据：500 条 × (1 次 SELECT + ≤1000 次 removeObject + 1 次 DELETE/行) 在
 * 正常 MinIO 时延下是秒级；批内内存峰值 = 500 行的实体（含 objectKey 等短列）。
 */
export const EXPIRED_SWEEP_BATCH_SIZE = 500;
