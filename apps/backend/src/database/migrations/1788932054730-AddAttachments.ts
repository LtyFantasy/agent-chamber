import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Attachments 模块建表迁移（MinIO 媒体附件 P0，plan wiccan-carnage-rocket §2）
 *
 * 表 attachments：MinIO 对象存储的元数据行（图片 only P0）。
 * - uploader_id FK→actors.id ON DELETE CASCADE（actors 超表覆盖人类+Agent）
 * - topic_id / doc_id FK 均 ON DELETE SET NULL（DB 评审修正：CASCADE 与
 *   "资源删除不级联媒体"语义矛盾；当前 topic/doc 均软删，硬删为潜伏路径兜底）
 * - chk_attachments_binding CHECK (topic_id IS NULL OR doc_id IS NULL)：
 *   OR 形给 FK SET NULL 留路（照 chk_doc_spaces_binding 先例），
 *   "恰好一值"由应用层强制（上传校验链第一道，12005）
 * - object_key 全表唯一（非 partial：uuid 键不重用，软删行不释放键）
 * - size_bytes BIGINT：DTO 出口显式 Number()（转换点钉死在 service toDto）
 * - status 无 DB CHECK：对齐"语义约束在应用层"惯例（1786113644423），
 *   P0 仅写 'ready'，'pending' 为 P2 presign 预留
 *
 * 索引全部 partial（平台惯例），与 entity @Index 同名同列同 where：
 * - idx_attachments_uploader_created (uploader_id, created_at DESC)：mine 分页 + 配额 SUM
 * - idx_attachments_topic / idx_attachments_doc：按绑定资源反查
 * - idx_attachments_sha256：内容寻址/比对
 * - idx_attachments_deleted_gc (deleted_at) WHERE deleted_at IS NOT NULL：GC 扫描
 *
 * SET LOCAL lock_timeout='5s'（1788439433261 先例：建表需 ACCESS EXCLUSIVE，
 * 长事务占锁时 5s 超时放弃而非无限排队；TypeORM 每 migration 事务内生效）。
 *
 * down() 整体 DROP TABLE（约束/索引随表消亡）。
 */
export class AddAttachments1788932054730 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表锁 5s 超时（长事务占表锁时放弃而非无限排队）
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // 2. attachments 表
    await queryRunner.query(`
      CREATE TABLE attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        uploader_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
        bucket VARCHAR(63) NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        size_bytes BIGINT NOT NULL,
        sha256 CHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ready',
        topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
        doc_id UUID REFERENCES docs(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT chk_attachments_binding CHECK (topic_id IS NULL OR doc_id IS NULL),
        CONSTRAINT uq_attachments_object_key UNIQUE (object_key)
      )
    `);

    // 3. Partial 索引（全量 5 枚，与 entity @Index 一致）
    // mine 分页（uploader + created_at DESC）+ 配额 SUM(size_bytes) 共用
    await queryRunner.query(`
      CREATE INDEX idx_attachments_uploader_created
      ON attachments (uploader_id, created_at DESC)
      WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_attachments_topic
      ON attachments (topic_id)
      WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_attachments_doc
      ON attachments (doc_id)
      WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX idx_attachments_sha256
      ON attachments (sha256)
      WHERE deleted_at IS NULL
    `);
    // GC 扫描：软删超 30 天行 → 删对象 → 硬删行
    await queryRunner.query(`
      CREATE INDEX idx_attachments_deleted_gc
      ON attachments (deleted_at)
      WHERE deleted_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 索引/约束随表消亡，无需单独 DROP
    await queryRunner.query(`DROP TABLE IF EXISTS attachments`);
  }
}
