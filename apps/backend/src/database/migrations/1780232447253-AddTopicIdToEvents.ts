import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 给 events 表增加 topic_id 字段
 * 用于按话题聚合过滤事件流
 */
export class AddTopicIdToEvents1780232447253 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "topic_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_events_topic_id" ON "events"("topic_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_events_topic_id"`);
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN IF EXISTS "topic_id"`);
  }
}
