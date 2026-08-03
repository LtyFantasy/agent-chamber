import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBoardListMappedStatusUnique1780385300000 implements MigrationInterface {
  name = 'AddBoardListMappedStatusUnique1780385300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 部分唯一索引：同一 board 下 mapped_status 非空时唯一
    // null 值不参与唯一性检查（大多数列不绑定状态）
    // 软删除列不参与唯一性检查
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_board_list_mapped_status_unique
      ON board_lists (board_id, mapped_status)
      WHERE mapped_status IS NOT NULL AND deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_board_list_mapped_status_unique
    `);
  }
}
