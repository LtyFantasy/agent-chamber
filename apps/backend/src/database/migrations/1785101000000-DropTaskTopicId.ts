import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Batch 3: task.topic_id 下线（v1.24.0-dev）。
 *
 * up():
 *   1. NOTICE 统计 tasks 表中非空 topic_id 的行数（仅日志，不阻断）
 *   2. DROP COLUMN topic_id（PG 自动连带删除同名索引 IDX_8cdb0faa4204a82b0cd8445d91）
 *
 * down():
 *   1. 重建 topic_id uuid NULL 列
 *   2. 从 board_lists JOIN boards 回填 topic_id（生产审计确认零信息丢失）
 *   3. 重建索引 IDX_8cdb0faa4204a82b0cd8445d91
 *
 * 生产审计结论（2026-07-26）：
 *   - tasks.topic_id vs list→board→topic 推断 mismatch = 0 → DROP 零信息丢失
 *   - topic_id 索引名 IDX_8cdb0faa4204a82b0cd8445d91（PG 自动生成）
 *   - 回填公式：UPDATE tasks t SET topic_id = b.topic_id
 *     FROM board_lists l JOIN boards b ON b.id = l.board_id WHERE t.list_id = l.id
 */
export class DropTaskTopicId1785101000000 implements MigrationInterface {
  name = 'DropTaskTopicId1785101000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 1. NOTICE 统计非空 topic_id 行数（仅日志，不阻断——审计已确认零信息丢失）
    // =========================================================================
    await queryRunner.query(`
      DO $$ DECLARE
        non_null_count int;
      BEGIN
        SELECT COUNT(*) INTO non_null_count FROM "tasks" WHERE "topic_id" IS NOT NULL;
        RAISE NOTICE 'DropTaskTopicId: dropping topic_id column. Non-null rows before drop: %. Audit confirmed zero information loss.', non_null_count;
      END $$
    `);

    // =========================================================================
    // 2. DROP COLUMN topic_id（同名索引 IDX_8cdb0faa4204a82b0cd8445d91 自动连带删除）
    // =========================================================================
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "topic_id"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 1. 重建 topic_id uuid NULL 列
    // =========================================================================
    await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN "topic_id" uuid NULL`);

    // =========================================================================
    // 2. 从 board_lists JOIN boards 回填 topic_id
    // =========================================================================
    await queryRunner.query(`
      UPDATE "tasks" t
      SET "topic_id" = b."topic_id"
      FROM "board_lists" l
      JOIN "boards" b ON b."id" = l."board_id"
      WHERE t."list_id" = l."id"
    `);

    // =========================================================================
    // 3. 重建索引（与迁移前同名，PG 自动生成名）
    // =========================================================================
    await queryRunner.query(
      `CREATE INDEX "IDX_8cdb0faa4204a82b0cd8445d91" ON "tasks" ("topic_id")`,
    );
  }
}
