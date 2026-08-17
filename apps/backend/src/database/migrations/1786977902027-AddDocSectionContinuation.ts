import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the chunker fact used by renderer run-dedup.
 *
 * The generated migration was reduced to the requested doc_sections column because
 * local roundtable indexes have unrelated schema drift. Existing adjacent rows with
 * the same heading path and level are backfilled as continuation chunks to preserve
 * the renderer behavior for documents written before this flag existed.
 */
export class AddDocSectionContinuation1786977902027 implements MigrationInterface {
  name = 'AddDocSectionContinuation1786977902027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "doc_sections" ADD COLUMN IF NOT EXISTS "is_continuation" boolean NOT NULL DEFAULT false`,
    );

    // Freeze the pre-v1.57.3 heuristic for stored rows: only a section immediately
    // following an equal-path/equal-level sibling is a continuation chunk.
    await queryRunner.query(
      `UPDATE "doc_sections" AS current_section
       SET "is_continuation" = TRUE
       FROM "doc_sections" AS previous_section
       WHERE current_section."doc_id" = previous_section."doc_id"
         AND current_section."position" = previous_section."position" + 1
         AND current_section."heading_path" IS NOT DISTINCT FROM previous_section."heading_path"
         AND current_section."heading_level" = previous_section."heading_level"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "doc_sections" DROP COLUMN IF EXISTS "is_continuation"`);
  }
}
