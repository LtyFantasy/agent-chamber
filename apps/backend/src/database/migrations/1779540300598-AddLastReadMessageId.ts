import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 给 topic_participants 表增加 last_read_message_id 字段
 * 用于实现话题级别的已读追踪
 */
export class AddLastReadMessageId1779540300598 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD COLUMN IF NOT EXISTS "last_read_message_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_participants" DROP COLUMN IF EXISTS "last_read_message_id"`,
    );
  }
}
