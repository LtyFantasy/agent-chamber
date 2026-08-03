import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixTopicVisibilityDefaults1780385200000 implements MigrationInterface {
  name = 'FixTopicVisibilityDefaults1780385200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fix topics where settings->visibility is null or missing
    await queryRunner.query(`
      UPDATE topics
      SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{visibility}',
        '"open"'::jsonb,
        true
      )
      WHERE settings->>'visibility' IS NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Cannot revert data fix
  }
}
