import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixTaskBoardId1780385000000 implements MigrationInterface {
  name = 'FixTaskBoardId1780385000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 安全执行：先检查 tasks.board_id 列是否存在（某些部署环境可能没有该列）
    const columnExists = await queryRunner.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tasks' AND column_name = 'board_id'
    `);

    if (columnExists.length > 0) {
      // Fix tasks with null boardId but valid listId
      await queryRunner.query(`
        UPDATE tasks t
        SET board_id = bl.board_id,
            topic_id = COALESCE(t.topic_id, b.topic_id)
        FROM board_lists bl
        LEFT JOIN boards b ON b.id = bl.board_id
        WHERE t.list_id = bl.id
          AND t.board_id IS NULL
          AND t.list_id IS NOT NULL
      `);
    }

    // Fix board_list position defaults where null
    await queryRunner.query(`
      UPDATE board_lists
      SET position = 0
      WHERE position IS NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Cannot revert data fix
  }
}
