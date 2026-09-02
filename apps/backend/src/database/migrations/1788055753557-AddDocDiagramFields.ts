import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Diagram IR v1（plan diagram-ir-v1-plan.md §1.1）：docs 表增三个图能力列。
 *
 * - diagram_type varchar(16)：从 IR diagram_type 反正范化（最长类型名 'architecture' 12 字符），
 *   免解析 IR 即可列表/过滤；
 * - rendered_html text：自包含 HTML 快照（内联 SVG+CSS+JS，PG TOAST 自动压缩）——IR 的
 *   确定性编译产物，不进 doc_versions；
 * - render_meta jsonb：{engine, rendererVersion, qualityProfile, checks, composition, renderedAt,
 *   htmlBytes, htmlSha256}（紧凑 ~1KB）。
 *
 * 三列全部 nullable、无默认值、无回填 → PG 15 元数据级 ALTER（catalog-only，无表重写），
 * 秒级、零数据重写，生产无损。不变量：docType='diagram' ⟺ diagram_type/rendered_html 非空
 * （由 upsertCore diagram 分支同事务维护；docType 迁出时三列同置 null）。
 *
 * 裸 SQL + IF NOT EXISTS 风格照 1787028746871-AddDocSectionHeadingText.ts 先例。
 */
export class AddDocDiagramFields1788055753557 implements MigrationInterface {
  name = 'AddDocDiagramFields1788055753557';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS "diagram_type" varchar(16)`,
    );
    await queryRunner.query(`ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS "rendered_html" text`);
    await queryRunner.query(`ALTER TABLE "docs" ADD COLUMN IF NOT EXISTS "render_meta" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "docs" DROP COLUMN IF EXISTS "render_meta"`);
    await queryRunner.query(`ALTER TABLE "docs" DROP COLUMN IF EXISTS "rendered_html"`);
    await queryRunner.query(`ALTER TABLE "docs" DROP COLUMN IF EXISTS "diagram_type"`);
  }
}
