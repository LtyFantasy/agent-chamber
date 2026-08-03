import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDocSpaceSlugUniqueIndex — 为 doc_spaces.slug 补 partial unique index。
 *
 * 背景：实体注释声明 slug「软删外全表唯一，partial unique index 在 migration 中定义」，
 * 但 AddDocSpaceModule migration 只建了 categories/docs 两处 partial unique，
 * doc_spaces.slug 遗漏——唯一性此前仅靠应用层 generateUniqueSlug 循环，
 * 并发创建可产生重复 slug，MCP 按名/slug 解析空间会歧义（review M1）。
 *
 * - partial（WHERE deleted_at IS NULL）：与 categories/docs 两处先例一致，
 *   软删空间的 slug 可被新空间复用。
 * - IF NOT EXISTS 幂等（与 deploy.sh 防呆比对兼容）。
 */
export class AddDocSpaceSlugUniqueIndex1785340200000 implements MigrationInterface {
  name = 'AddDocSpaceSlugUniqueIndex1785340200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_spaces_slug ON doc_spaces (slug) WHERE deleted_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_doc_spaces_slug`);
  }
}
