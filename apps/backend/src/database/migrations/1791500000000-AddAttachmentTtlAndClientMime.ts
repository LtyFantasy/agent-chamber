import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddAttachmentTtlAndClientMime1791500000000 — 附件 TTL 批（v1.90.0-dev）双列 + GC partial index。
 *
 * 三件事（plan §A1 钉死）：
 * 1. `expires_at TIMESTAMPTZ NULL`——上传时按 topic.settings.attachmentTtl 冻结；
 *    存量行 **NULL = 永久**（迁移不追溯；用户拍板设计点 3）；
 * 2. `client_mime_type VARCHAR(100) NULL`——sanitize 后的客户端声明 mime，**纯展示**，
 *    不参与任何服务决策（M1 不变量：mime_type 列只承载字节证据）；
 * 3. `idx_attachments_expires_gc (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL`
 *    ——小时级 `sweepExpiredAttachments`（`@Cron('11 * * * *')`）的谓词
 *    `expires_at < now() AND deleted_at IS NULL` 与**本 partial 谓词精确匹配**，
 *    否则 PG 无法用索引、退化为全表扫（security 已核对该 partial 形态正确）。
 *    名字与 entity `@Index('idx_attachments_expires_gc', ...)` 同名同 where
 *    （平台手写 migration 惯例：防 generate 噪声）。
 *
 * `ADD COLUMN` 对存量行是 NULL（PG 11+ 元数据级变更，不重写表；两列均无 NOT NULL，
 * 无需 DEFAULT 回填）；`IF NOT EXISTS` 保证幂等（deploy.sh 防呆比对兼容）。
 * `SET LOCAL lock_timeout='5s'`（1788439433261 先例：长事务占表锁时放弃而非无限排队）。
 *
 * down()：DROP INDEX + DROP COLUMN（可回滚；两列无 DB 约束依赖）。
 */
export class AddAttachmentTtlAndClientMime1791500000000 implements MigrationInterface {
  name = 'AddAttachmentTtlAndClientMime1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(
      `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
    );
    await queryRunner.query(
      `ALTER TABLE attachments ADD COLUMN IF NOT EXISTS client_mime_type VARCHAR(100)`,
    );

    // 与 sweepExpiredAttachments 谓词精确匹配的 partial index（见类注释第 3 点）
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_attachments_expires_gc
      ON attachments (expires_at)
      WHERE deleted_at IS NULL AND expires_at IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_attachments_expires_gc`);
    await queryRunner.query(`ALTER TABLE attachments DROP COLUMN IF EXISTS client_mime_type`);
    await queryRunner.query(`ALTER TABLE attachments DROP COLUMN IF EXISTS expires_at`);
  }
}
