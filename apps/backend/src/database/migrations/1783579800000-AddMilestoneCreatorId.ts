import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 给 milestones 表增加 creator_id 列（创建者 Actor ID）与索引。
 * 向后兼容：列 nullable，历史数据保持 NULL，权限退化为「仅 topic 创建者/admin」。
 * 索引名 idx_milestones_creator_id 与 milestone.entity.ts 中 @Index 命名一致，
 * 避免未来 migration:generate 误出索引 diff。
 */
export class AddMilestoneCreatorId1783579800000 implements MigrationInterface {
  name = 'AddMilestoneCreatorId1783579800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "creator_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_milestones_creator_id" ON "milestones" ("creator_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_milestones_creator_id"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN IF EXISTS "creator_id"`);
  }
}
