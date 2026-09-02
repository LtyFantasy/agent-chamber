import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the chunker-produced local heading text as an independent column.
 *
 * The generated migration was reduced to the requested doc_sections column to avoid
 * unrelated schema drift. Existing rows are backfilled by taking the last segment
 * of the heading_path (split on the ` § ` separator), which is best-effort: new
 * writes through the chunker are the authoritative source. The backfill produces
 * the correct result for legacy rows because the production audit (Phase 0) found
 * no stored heading with an embedded ` § ` sequence; the reverse+split_part trick
 * is required because PG split_part() does not support negative indexes.
 *
 * Contract shift (debt A): heading_path degrades to a pure addressing locator;
 * title display must read heading_text (local heading) instead of re-parsing the
 * path string — see markdown-chunker.ts / doc.service.ts renderSectionPart.
 */
export class AddDocSectionHeadingText1787028746871 implements MigrationInterface {
  name = 'AddDocSectionHeadingText1787028746871';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "doc_sections" ADD COLUMN IF NOT EXISTS "heading_text" varchar(512)`,
    );

    // Backfill: last heading_path segment = local heading text. reverse() + split_part()
    // takes the LAST segment without negative-index support; trim removes the whitespace
    // around the separator. Best-effort by design — the chunker-written column is the
    // authoritative source going forward.
    await queryRunner.query(
      `UPDATE "doc_sections"
       SET "heading_text" = trim(reverse(split_part(reverse("heading_path"), ' § ', 1)))
       WHERE "heading_path" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "doc_sections" DROP COLUMN IF EXISTS "heading_text"`);
  }
}
