import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDocLinkHealth — 为 docs 表补 link_health jsonb NULL 列。
 *
 * 背景：错链巡检（Docs D1 Wave A）在文档写入时静态分析 markdown 内平台内引用，
 * 断链结果落库为 link_health jsonb。形状：
 *   { "total": number, "broken": string[], "checkedAt": "<ISO>" }
 *
 * - NULL 表示尚未检查（兼容旧数据）。
 * - jsonb 允许下游灵活查询 broken 数组内容。
 */
export class AddDocLinkHealth1785382244987 implements MigrationInterface {
  name = 'AddDocLinkHealth1785382244987';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE docs ADD COLUMN IF NOT EXISTS link_health jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE docs DROP COLUMN IF EXISTS link_health`);
  }
}
