import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 给 events 表增加 board_id 字段
 * 用于按看板聚合过滤事件流，与 topic_id / actor_id 共同构成事件可见性过滤条件
 */
export class AddBoardIdToEvents1781260000000 implements MigrationInterface {
  name = 'AddBoardIdToEvents1781260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "board_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_events_board_id" ON "events"("board_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_events_board_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "board_id"`);
  }
}
