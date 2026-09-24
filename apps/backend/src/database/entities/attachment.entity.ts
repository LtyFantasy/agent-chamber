/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (Attachments 模块 / MinIO 媒体附件)
 *   - 补充: docs/database.md (attachments 表), docs/api-definition.md §Attachments
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
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
   * MIME 类型——魔数嗅探值（不信任客户端声明的 Content-Type），
   * 同时是 GET /content 响应 Content-Type 的单一来源。
   */
  @Column({ type: 'varchar', length: 100, nullable: false, name: 'mime_type' })
  mimeType: string;

  /**
   * 字节数（PG bigint）。TypeORM int8 读出为 string——DTO 出口必须显式 Number()
   * （8MiB 单文件 / 200MiB 配额规模远低于 2^53，安全；刻意偏离平台 string 先例，
   * 转换点钉死在 attachment.service.ts toDto）。
   */
  @Column({ type: 'bigint', nullable: false, name: 'size_bytes' })
  sizeBytes: string;

  /** 内容 SHA-256（hex 64 字符），兼作 GET /content 的 ETag */
  @Column({ type: 'char', length: 64, nullable: false })
  sha256: string;

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
