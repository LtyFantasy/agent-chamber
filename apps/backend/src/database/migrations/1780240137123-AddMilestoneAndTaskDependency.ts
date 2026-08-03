import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新增里程碑(Milestone)和任务依赖(TaskDependency)支持
 * - milestones 表：版本/Sprint 管理
 * - task_dependencies 表：任务间依赖关系
 * - tasks 表新增 milestone_id 字段
 */
export class AddMilestoneAndTaskDependency1780240137123 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 创建 milestones 表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "milestones" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(200) NOT NULL,
        "description" text,
        "topic_id" uuid,
        "status" varchar(20) NOT NULL DEFAULT 'planned',
        "start_date" timestamptz,
        "target_date" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_milestones_topic_id" ON "milestones"("topic_id")`,
    );

    // 创建 task_dependencies 表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "task_dependencies" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "task_id" uuid NOT NULL,
        "depends_on_task_id" uuid NOT NULL,
        "dependency_type" varchar(20) NOT NULL DEFAULT 'blocks',
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_dependencies_unique" ON "task_dependencies"("task_id", "depends_on_task_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_task_dependencies_depends_on" ON "task_dependencies"("depends_on_task_id")`,
    );

    // tasks 表新增 milestone_id 字段
    await queryRunner.query(`ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "milestone_id" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tasks_milestone_id" ON "tasks"("milestone_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tasks_milestone_id"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN IF EXISTS "milestone_id"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_task_dependencies_depends_on"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_task_dependencies_unique"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "task_dependencies"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_milestones_topic_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "milestones"`);
  }
}
