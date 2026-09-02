import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add doc_versions table (doc history MVP).
 *
 * The generated migration was reduced to the requested doc_versions table because
 * the local dev database has unrelated schema drift (roundtable index shapes,
 * tracked as debt 94502fef). Pure additive table — no existing-data migration.
 *
 * Design contract (see doc-version.entity.ts):
 * - version 单调递增（历史最大+1），删旧不归零；保留策略在应用层事务内剪枝
 * - FK→docs ON DELETE CASCADE（物理删文档清版本；软删不清——历史可考古）
 */
export class AddDocVersions1787020795334 implements MigrationInterface {
  name = 'AddDocVersions1787020795334';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "doc_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "doc_id" uuid NOT NULL, "version" integer NOT NULL, "content_hash" character varying(64) NOT NULL, "content" text NOT NULL, "author_actor_id" uuid NOT NULL, "source" character varying(16) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2aa4b84f5b83db90335406af094" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7a67262ab74c2d0095c9cd7a5e" ON "doc_versions" ("doc_id", "version") `,
    );
    await queryRunner.query(
      `ALTER TABLE "doc_versions" ADD CONSTRAINT "FK_3c6f4489356a11e2a006e8cb468" FOREIGN KEY ("doc_id") REFERENCES "docs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "doc_versions" DROP CONSTRAINT "FK_3c6f4489356a11e2a006e8cb468"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_7a67262ab74c2d0095c9cd7a5e"`);
    await queryRunner.query(`DROP TABLE "doc_versions"`);
  }
}
