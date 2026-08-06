import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * milestone Release 化（v1.42.0-dev 批次 B1）——全部加法，存量数据零风险：
 * 1. MilestoneStatus 枚举扩展 dev/ready/deployed/verified（PG15 事务内可 ADD VALUE）；
 * 2. milestones 表新增 5 列（全可空）：version/body/deploy_meta/deployed_at/verified_at；
 * 3. 部分唯一索引 uq_milestones_board_version (board_id, version) WHERE version IS NOT NULL
 *    ——同 board 内 version 唯一，冲突 23505 → 409 MILESTONE_VERSION_CONFLICT（Service 翻译）。
 *
 * 幂等风格对齐 AddMilestoneCreatorId1783579800000：IF NOT EXISTS 全量防护，重复执行零副作用。
 * 注意：migration:generate 原始输出混入本地库 schema drift 噪音（FK/索引/NOT NULL 差异），
 * 已人工剔除，只保留本任务变更（项目教训，见 memory/2026-08-04.md）。
 */
export class AddMilestoneReleaseFields1785949186866 implements MigrationInterface {
  name = 'AddMilestoneReleaseFields1785949186866';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 枚举扩展：普通四态 + Release 四态共存（设计决策 §5-1：单 status 列，Service 流转矩阵隔离）
    await queryRunner.query(
      `ALTER TYPE "public"."milestones_status_enum" ADD VALUE IF NOT EXISTS 'dev'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."milestones_status_enum" ADD VALUE IF NOT EXISTS 'ready'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."milestones_status_enum" ADD VALUE IF NOT EXISTS 'deployed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."milestones_status_enum" ADD VALUE IF NOT EXISTS 'verified'`,
    );

    // 新增列（全可空，存量 milestone 保持普通态语义）
    await queryRunner.query(
      `ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "version" character varying(50)`,
    );
    await queryRunner.query(`ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "body" text`);
    await queryRunner.query(
      `ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "deploy_meta" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "deployed_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "milestones" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP WITH TIME ZONE`,
    );

    // 部分唯一索引：version 为 NULL 的普通里程碑不参与唯一性（同 board 多个普通里程碑不受影响）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_milestones_board_version" ON "milestones" ("board_id", "version") WHERE "version" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_milestones_board_version"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN IF EXISTS "verified_at"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN IF EXISTS "deployed_at"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN IF EXISTS "deploy_meta"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN IF EXISTS "body"`);
    await queryRunner.query(`ALTER TABLE "milestones" DROP COLUMN IF EXISTS "version"`);
    // 枚举值 dev/ready/deployed/verified 不可删除（PG 不支持 ALTER TYPE ... DROP VALUE，
    // 且历史数据可能已引用）；回滚仅恢复列与索引，枚举多出的值无害（普通态不触达）。
  }
}
