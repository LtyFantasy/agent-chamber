import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeMilestoneTopicIdNotNull1783305284755 implements MigrationInterface {
  name = 'MakeMilestoneTopicIdNotNull1783305284755';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 安全前置检查：若仍有孤立里程碑，先阻止 migration 而非静默破坏数据
    const result = await queryRunner.query(
      `SELECT COUNT(*) AS count FROM milestones WHERE topic_id IS NULL`,
    );
    const orphanedCount = parseInt(result[0]?.count ?? '0', 10);
    if (orphanedCount > 0) {
      throw new Error(
        `Found ${orphanedCount} milestone(s) with NULL topic_id. Please clean up orphaned milestones before applying this migration.`,
      );
    }

    await queryRunner.query(`ALTER TABLE milestones ALTER COLUMN topic_id SET NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE milestones ALTER COLUMN topic_id DROP NOT NULL`);
  }
}
