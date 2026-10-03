/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - attachments 表：MinIO 对象存储的元数据行（媒体附件 + TTL 过期治理）
 *
 * [代码职责]
 *   - 列定义与列级语义（绑定模型 / 键 / mime 双列 / 过期时刻 / 缩略图五列 / 软删）
 *   - 索引声明：与 migrations 手写索引**同名同列同 where**（防 generate 噪声）
 *
 * [权威文档]
 *   - 主文档: docs/database.md — attachments 表结构与三轨 GC
 *   - 补充: docs/api-definition.md §16a「附件 TTL 与类型放开」— mime 不变量 / expiresAt 语义
 *   - 补充: docs/architecture.md §3.2 — Attachments 模块
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释)
 *
 * [关键不变量]
 *   - `mime_type` **只承载字节证据**：4 种嗅探图片 mime 之一，或非图片恒
 *     `application/octet-stream`。客户端声明值**永不进本列**（进 `client_mime_type`，
 *     纯展示）；任何以对象元数据直出的新通道（如未来 presign）不得复用本列当"可信类型"。
 *   - `client_mime_type` 是展示信息，非法/缺失 → NULL（sanitize 见 client-mime.ts）；
 *     任何服务决策**不得**读它。
 *   - `expires_at` 上传时**冻结**（topic TTL / doc 绑定恒 NULL / 存量迁移 NULL = 永久）；
 *     判据 = 非空且 < now()，小时级 GC 按
 *     `expires_at < now() AND deleted_at IS NULL` 物理回收——与
 *     `idx_attachments_expires_gc` 的 partial 谓词精确匹配（多/少一个条件即全表扫）。
 *   - 索引全部 partial 且与 migration 同名同 where；缩略图五列**同生共死**
 *     （全 NULL 或全非 NULL），`thumb_key` 是"有无缩略图"的唯一判据。
 *   - `deleted_at` 是 DeleteDateColumn({select:false})：GC/批量写需显式 addSelect 或
 *     显式 set（批量 update 不会自动维护软删列）。
 *
 * [关联代码]
 *   - migrations/1788932054730-AddAttachments.ts / 1789204500000-AddAttachmentThumbnail.ts /
 *     1791500000000-AddAttachmentTtlAndClientMime.ts — 建表/缩略图/TTL 双列 + GC partial index
 *   - attachment.constants.ts — INLINE_IMAGE_MIME_TYPES / isAttachmentExpired 判据单源
 *   - attachment.service.ts — 列的写入点（分类分支 / TTL 冻结 / 配额 SUM 谓词）
 *   - attachment-gc.service.ts — 按 expires_at / deleted_at 三轨回收
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增/改名列必须同时手写 migration（禁 generate）并跑 migration-drift 门禁
 *   □ 新增索引必须与 GC/查询谓词逐字对齐，否则退化为全表扫
 * =============================================================================
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * 媒体附件（MinIO 对象存储的元数据行）。
 *
 * 绑定模型：上传即绑定、单绑定——topicId/docId 应用层强制恰好一值
 * （DB CHECK 仅 OR 形，给 FK ON DELETE SET NULL 留路；双 NULL = 无绑定态，
 * 仅上传者/admin 可读，见 attachment-access.service.ts）。
 *
 * FK 由 migration 建立（uploader→actors CASCADE，topic/doc→SET NULL），
 * 实体侧保持裸 uuid 列不建关系对象（doc-space.entity 先例，避免 entities 层新环）。
 *
 * 索引全部 partial（平台惯例），与 migration 同名同列同 where，防 generate 噪声；
 * idx_attachments_uploader_created 的 created_at DESC 方向仅 migration 可表达
 * （TypeORM @Index 无 order 选项），generate 噪声可接受——平台手写 migration 不 generate。
 * uq_attachments_thumb_key 是 partial **unique**（P2 批 1）：只约束有缩略图的行。
 */
@Entity('attachments')
@Index('idx_attachments_uploader_created', ['uploaderId', 'createdAt'], {
  where: 'deleted_at IS NULL',
})
@Index('idx_attachments_topic', ['topicId'], { where: 'deleted_at IS NULL' })
@Index('idx_attachments_doc', ['docId'], { where: 'deleted_at IS NULL' })
@Index('idx_attachments_sha256', ['sha256'], { where: 'deleted_at IS NULL' })
@Index('idx_attachments_deleted_gc', ['deletedAt'], { where: 'deleted_at IS NOT NULL' })
@Index('idx_attachments_expires_gc', ['expiresAt'], {
  where: 'deleted_at IS NULL AND expires_at IS NOT NULL',
})
@Unique('uq_attachments_object_key', ['objectKey'])
@Index('uq_attachments_thumb_key', ['thumbKey'], { unique: true, where: 'thumb_key IS NOT NULL' })
export class Attachment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 上传者 actor ID（FK→actors.id ON DELETE CASCADE；actors 超表覆盖人类+Agent） */
  @Column({ type: 'uuid', nullable: false, name: 'uploader_id' })
  uploaderId: string;

  /**
   * MinIO bucket（入库冗余列：支持未来多 bucket 分流，P0–P2 恒为配置 bucket）。
   *
   * ⚠️ 多 bucket 提醒（PM M8）：孤儿对象清扫（attachment-gc.service.ts
   * `sweepOrphanObjectsOlderThan`）只扫**配置 bucket**（storage.getBucket()）——
   * 若未来真做分流写入，其它 bucket 的对象不会被误删（保护集是全表的，键仍在
   * Set 内），但也**不会被清扫**；届时清扫需改为遍历 `SELECT DISTINCT bucket`。
   */
  @Column({ type: 'varchar', length: 63, nullable: false })
  bucket: string;

  /**
   * MinIO 对象键 `{uuid}.{safeExt}`，全表唯一（非 partial：uuid 不重用，
   * 软删行不释放键，天然无冲突）。
   */
  @Column({ type: 'varchar', length: 512, nullable: false, name: 'object_key' })
  objectKey: string;

  /** 原始文件名（上传时经 sanitize：剥控制字符/路径分隔符，UTF-8 字节截断 ≤255） */
  @Column({ type: 'varchar', length: 255, nullable: false, name: 'original_name' })
  originalName: string;

  /**
   * MIME 类型——**只承载字节证据**，是 GET /content 响应 Content-Type 的单一来源。
   *
   * v1.90.0-dev 不变量（M1）：本列只有两种可能——
   * ① 4 种嗅探图片 mime 之一（png/jpeg/gif/webp，来自 `sniffImageMime` 的字节证据）；
   * ② 非图片行恒 `application/octet-stream`（`ATTACHMENT_FALLBACK_MIME`）。
   * **客户端声明的 Content-Type 永不进本列**（进 {@link clientMimeType}，纯展示）。
   * 任何以对象元数据直出的新通道（如未来 presign）不得复用本列作为"可信类型"依据；
   * 出口呈现形态由 `INLINE_IMAGE_MIME_TYPES` 精确成员判断决定（见 attachment.constants.ts）。
   */
  @Column({ type: 'varchar', length: 100, nullable: false, name: 'mime_type' })
  mimeType: string;

  /**
   * 客户端声明的 mime（sanitize 后；非法/缺失 → NULL）——**纯展示信息**
   * （附件卡片图标参考），不参与任何服务决策、不进响应 Content-Type。
   *
   * sanitize 规则见 client-mime.ts：剥控制字符 / 取分号前的 media type / 形状校验
   * （`type/subtype`）/ 截断 ≤100 字符。存量行 NULL。
   */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'client_mime_type' })
  clientMimeType: string | null;

  /**
   * 字节数（PG bigint）。TypeORM int8 读出为 string——DTO 出口必须显式 Number()
   * （10MiB 单文件 / 200MiB 配额规模远低于 2^53，安全；刻意偏离平台 string 先例，
   * 转换点钉死在 attachment.service.ts toDto）。
   */
  @Column({ type: 'bigint', nullable: false, name: 'size_bytes' })
  sizeBytes: string;

  /** 内容 SHA-256（hex 64 字符），兼作 GET /content 的 ETag */
  @Column({ type: 'char', length: 64, nullable: false })
  sha256: string;

  /**
   * 过期时刻（v1.90.0-dev 附件 TTL 批）。**上传时冻结**：`now() + topic.settings.attachmentTtl`。
   *
   * - NULL = 永久，三种来源：doc 绑定附件（豁免 TTL）/ topic 设置 `never` /
   *   存量行迁移后（迁移补列 NULL，存量一律永久，不追溯）；
   * - `never` 与"解析失败"**不同义**：settings 脏值走 fail-closed 回退 7d
   *   （见 attachment.constants.resolveAttachmentTtlMs），绝不回退 NULL；
   * - 事后修改 topic TTL **只影响新上传**，本列不追溯（契约简单可预测）；
   * - 过期判据 = 本列非 NULL 且 < now()：字节面 410·12009，元数据面照常 200 带本值；
   * - 小时级 GC（`sweepExpiredAttachments`）按本列物理回收行与对象，
   *   谓词 `expires_at < now() AND deleted_at IS NULL`——与
   *   `idx_attachments_expires_gc` 的 partial 谓词精确匹配（否则退化为全表扫）。
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expiresAt: Date | null;

  /**
   * 状态值域：'ready'（P0 唯一写入值，上传完成即可读）/ 'pending'（P2 presign 预留）。
   * 应用层校验不建 DB CHECK（对齐"语义约束在应用层"惯例，migration 1786113644423）。
   */
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'ready' })
  status: string;

  /** 绑定话题（FK→topics.id ON DELETE SET NULL；与 docId 恰好一值由应用层强制） */
  @Column({ type: 'uuid', nullable: true, name: 'topic_id' })
  topicId: string | null;

  /** 绑定文档（FK→docs.id ON DELETE SET NULL；硬删才触发，当前 docs 均软删为潜伏路径） */
  @Column({ type: 'uuid', nullable: true, name: 'doc_id' })
  docId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /** 软删标准写法（select:false——GC 查询需显式 addSelect，见 attachment-gc.service） */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  /**
   * 缩略图对象键 `<uuid>.thumb.webp`（P2 批 1）。
   *
   * NULL = 该附件没有缩略图（存量行不回溯生成 / fail-open 生成失败）——
   * "有无缩略图" 的唯一判定来源，禁止用其他 thumb_* 列的组合反推。
   * partial unique 索引 WHERE thumb_key IS NOT NULL（与 migration 同名同 where）：
   * 软删行不释放键（uuid 不重用），与 object_key 的全表唯一同规。
   */
  @Column({ type: 'varchar', length: 512, nullable: true, name: 'thumb_key' })
  thumbKey: string | null;

  /** 缩略图宽（px）；与 thumbHeight/thumbSizeBytes/thumbSha256 **同生共死**（应用层维护：全 NULL 或全非 NULL） */
  @Column({ type: 'int', nullable: true, name: 'thumb_width' })
  thumbWidth: number | null;

  /** 缩略图高（px）；语义同 thumbWidth（首帧尺寸，≤ ATTACHMENT_THUMB_MAX_EDGE） */
  @Column({ type: 'int', nullable: true, name: 'thumb_height' })
  thumbHeight: number | null;

  /**
   * 缩略图字节数（PG bigint，读出为 string——DTO 出口显式 Number()，
   * 与 sizeBytes 同规、同转换点纪律）；不计入上传配额（配额只计原图）。
   */
  @Column({ type: 'bigint', nullable: true, name: 'thumb_size_bytes' })
  thumbSizeBytes: string | null;

  /** 缩略图内容 SHA-256（hex 64，null 当且仅当 thumbKey 为 null），兼作 GET /:id/thumbnail 的 ETag */
  @Column({ type: 'char', length: 64, nullable: true, name: 'thumb_sha256' })
  thumbSha256: string | null;
}
