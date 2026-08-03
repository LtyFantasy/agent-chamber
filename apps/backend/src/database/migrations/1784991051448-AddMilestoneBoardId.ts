import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Batch 1: milestones.topic_id → board_id（NOT NULL）。
 *
 * 回填三步防御（D-B1-1）：
 *   Step A — 有已绑 task 的 milestone：按 tasks→board_lists→boards 的众数 board 回填
 *   Step B — 仍 NULL 的：取 topic 唯一 board（COUNT=1 时）
 *   Step C — 仍 NULL 的：RAISE EXCEPTION 中止 migration（需人工归置后重跑）
 *
 * D-B1-2：board_id 不加 DB 级 FK（对齐项目惯例）。
 */
export class AddMilestoneBoardId1784991051448 implements MigrationInterface {
  name = 'AddMilestoneBoardId1784991051448';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) 加 board_id 列
    await queryRunner.query(`ALTER TABLE "milestones" ADD COLUMN "board_id" uuid NULL`);

    // 2) Step A — 按已绑 task 的众数 board 回填
    await queryRunner.query(`
      UPDATE milestones m SET board_id = sub.board_id FROM (
        SELECT tk.milestone_id, bl.board_id, COUNT(*) AS cnt,
               ROW_NUMBER() OVER (PARTITION BY tk.milestone_id ORDER BY COUNT(*) DESC, bl.board_id) AS rn
        FROM tasks tk
        JOIN board_lists bl ON tk.list_id = bl.id
        WHERE tk.milestone_id IS NOT NULL
          AND tk.deleted_at IS NULL
          AND bl.deleted_at IS NULL
        GROUP BY tk.milestone_id, bl.board_id
      ) sub
      WHERE m.id = sub.milestone_id AND sub.rn = 1
    `);

    // 3) Step B — topic 唯一 board 兜底（topic 下有且仅有一个 board）
    await queryRunner.query(`
      UPDATE milestones m SET board_id = (
        SELECT b.id FROM boards b
        WHERE b.topic_id = m.topic_id AND b.deleted_at IS NULL
      )
      WHERE m.board_id IS NULL
        AND (SELECT COUNT(*) FROM boards b WHERE b.topic_id = m.topic_id AND b.deleted_at IS NULL) = 1
    `);

    // 4) Step C — 防御中止：仍 NULL 则报错
    await queryRunner.query(`
      DO $$ DECLARE n int; BEGIN
        SELECT COUNT(*) INTO n FROM milestones WHERE board_id IS NULL;
        IF n > 0 THEN
          RAISE EXCEPTION 'AddMilestoneBoardId: % milestone(s) cannot backfill board_id automatically', n;
        END IF;
      END $$
    `);

    // 5) NOT NULL
    await queryRunner.query(`ALTER TABLE "milestones" ALTER COLUMN "board_id" SET NOT NULL`);

    // 6) 下线 topic_id 列与索引，建 board_id 索引
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_218788423bd30c25f0eed48031"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN "topic_id"`);
    await queryRunner.query(`CREATE INDEX "idx_milestones_board_id" ON "milestones" ("board_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 逆序恢复：加回 topic_id → 由 boards.topic_id 回填 → NOT NULL → 删 board_id
    await queryRunner.query(`ALTER TABLE "milestones" ADD COLUMN "topic_id" uuid NULL`);

    // 从 boards.topic_id 反填
    await queryRunner.query(`
      UPDATE milestones m SET topic_id = (
        SELECT b.topic_id FROM boards b WHERE b.id = m.board_id AND b.deleted_at IS NULL
      )
    `);

    // 防御：仍 NULL 则报错
    await queryRunner.query(`
      DO $$ DECLARE n int; BEGIN
        SELECT COUNT(*) INTO n FROM milestones WHERE topic_id IS NULL;
        IF n > 0 THEN
          RAISE EXCEPTION 'AddMilestoneBoardId down: % milestone(s) cannot restore topic_id', n;
        END IF;
      END $$
    `);

    await queryRunner.query(`ALTER TABLE "milestones" ALTER COLUMN "topic_id" SET NOT NULL`);

    // 建回 topic_id 索引
    await queryRunner.query(
      `CREATE INDEX "IDX_218788423bd30c25f0eed48031" ON "milestones" ("topic_id")`,
    );

    // 删 board_id
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_milestones_board_id"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN "board_id"`);
  }
}
