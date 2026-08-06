import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * docs.source_sha 迁移（v1.42 批次 B6：sourceSha 新鲜度）
 *
 * 设计要点：
 * - 全加法：新列可空，存量数据零风险，符合迁移兼容铁律
 * - source_sha varchar(64) = sha1（git rev-parse HEAD 40 hex）/sha256（64 hex）均可容纳
 * - 语义 = last-verified sha（内容在此 sha 验证一致），由 sync 适配器上报；
 *   新鲜度判断留给消费端（doc.sourceSha vs 空间 maxSha 比较）
 * - 普通 btree 索引：空间内新鲜度比较（按 source_sha 扫同一空间文档）
 * - 幂等 IF NOT EXISTS；down 逆序 DROP 列（索引随列自动删除）
 */
export class AddDocSourceSha1785953032576 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE docs
        ADD COLUMN IF NOT EXISTS source_sha VARCHAR(64)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_docs_source_sha ON docs (source_sha)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_docs_source_sha`);
    await queryRunner.query(`ALTER TABLE docs DROP COLUMN IF EXISTS source_sha`);
  }
}
