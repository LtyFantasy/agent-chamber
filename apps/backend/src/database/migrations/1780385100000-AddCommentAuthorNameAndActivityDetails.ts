import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCommentAuthorNameAndActivityDetails1780385100000 implements MigrationInterface {
  name = 'AddCommentAuthorNameAndActivityDetails1780385100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add author_name to task_comments
    await queryRunner.query(`
      ALTER TABLE task_comments
      ADD COLUMN IF NOT EXISTS author_name varchar(255)
    `);

    // Backfill authorName for existing comments from agents
    await queryRunner.query(`
      UPDATE task_comments tc
      SET author_name = a.name
      FROM agents a
      WHERE tc.author_id = a.id
        AND tc.author_type = 'agent'
        AND tc.author_name IS NULL
    `);

    // Backfill authorName for existing comments from users
    await queryRunner.query(`
      UPDATE task_comments tc
      SET author_name = COALESCE(u.display_name, u.username)
      FROM users u
      WHERE tc.author_id = u.id
        AND tc.author_type = 'human'
        AND tc.author_name IS NULL
    `);

    // Add details to task_activities
    await queryRunner.query(`
      ALTER TABLE task_activities
      ADD COLUMN IF NOT EXISTS details text
    `);

    // Backfill details for existing activities
    await queryRunner.query(`
      UPDATE task_activities
      SET details = CASE
        WHEN action = 'created' THEN '创建了任务'
        WHEN action = 'moved' THEN '移动了任务'
        WHEN action = 'assigned' AND old_value IS NULL THEN '分配了任务'
        WHEN action = 'assigned' AND old_value IS NOT NULL THEN '重新分配了任务'
        WHEN action = 'commented' THEN '添加了评论'
        WHEN action = 'updated' AND field_name IS NOT NULL THEN '更新了: ' || field_name
        ELSE action
      END
      WHERE details IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE task_comments DROP COLUMN IF EXISTS author_name`);
    await queryRunner.query(`ALTER TABLE task_activities DROP COLUMN IF EXISTS details`);
  }
}
