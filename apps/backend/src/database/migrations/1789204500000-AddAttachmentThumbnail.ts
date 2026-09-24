import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 附件缩略图变体列迁移（P2 批 1 / plan §①.3）：attachments 表增 5 列 + partial unique 索引。
 *
 * - thumb_key varchar(512)：缩略图对象键 `<uuid>.thumb.webp`；NULL = 无缩略图
 *   （存量行不回溯生成 / 上传时 fail-open 生成失败）；
 * - thumb_width int / thumb_height int：缩略图输出尺寸（webp 最长边 ≤ 512，永不放大）；
 * - thumb_size_bytes bigint：缩略图字节数（bigint 读出为 string，DTO 出口显式 Number()）；
 * - thumb_sha256 char(64)：内容哈希，兼作 GET /attachments/:id/thumbnail 的 ETag。
 *
 * 五列全部 nullable、无默认值、无回填 → PG 15 元数据级 ALTER（catalog-only，无表重写），
 * 秒级、零数据重写，生产无损。应用层不变量：五列同生共死（全 NULL 或全非 NULL），
 * thumb_key IS NULL ⟺ thumb_sha256 IS NULL。
 *
 * uq_attachments_thumb_key partial unique（WHERE thumb_key IS NOT NULL）：只约束
 * 有缩略图的行，存量 NULL 行不参与；与 entity @Index 同名同列同 where（防 generate 噪声）。
 *
 * SET LOCAL lock_timeout='5s'（1788439433261 先例：加列需 ACCESS EXCLUSIVE 短锁，
 * 长事务占表锁时 5s 超时放弃而非无限排队；TypeORM 每 migration 事务内生效）。
 *
 * 裸 SQL + IF NOT EXISTS 风格照 1788932054730-AddAttachments.ts 与
 * 1788055753557-AddDocDiagramFields.ts 先例。
 */
export class AddAttachmentThumbnail1789204500000 implements MigrationInterface {
  name = 'AddAttachmentThumbnail1789204500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 加列锁 5s 超时（长事务占表锁时放弃而非无限排队）
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(
      `ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "thumb_key" varchar(512)`,
    );
    await queryRunner.query(`ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "thumb_width" int`);
    await queryRunner.query(
      `ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "thumb_height" int`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "thumb_size_bytes" bigint`,
    );
    await queryRunner.query(
      `ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "thumb_sha256" char(64)`,
    );

    // partial unique：有缩略图的行键唯一（uuid 键不重用，软删行不释放键）
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_attachments_thumb_key
      ON attachments (thumb_key)
      WHERE thumb_key IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_attachments_thumb_key`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP COLUMN IF EXISTS "thumb_sha256"`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP COLUMN IF EXISTS "thumb_size_bytes"`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP COLUMN IF EXISTS "thumb_height"`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP COLUMN IF EXISTS "thumb_width"`);
    await queryRunner.query(`ALTER TABLE "attachments" DROP COLUMN IF EXISTS "thumb_key"`);
  }
}
