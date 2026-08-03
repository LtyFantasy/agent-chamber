import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveTaskUnusedHoursAndCoverImageUrl1783579798301 implements MigrationInterface {
  name = 'RemoveTaskUnusedHoursAndCoverImageUrl1783579798301';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "estimated_hours"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "actual_hours"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "cover_image_url"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tasks" ADD "cover_image_url" text`);
    await queryRunner.query(`ALTER TABLE "tasks" ADD "actual_hours" numeric(6,2)`);
    await queryRunner.query(`ALTER TABLE "tasks" ADD "estimated_hours" numeric(6,2)`);
  }
}
