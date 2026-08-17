import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * doc_routes 新增 code_entry_type 列（T5：codeEntryType exact/pattern 分支）
 *
 * 设计要点：
 * - 全加法：新列带 DEFAULT 'exact'，存量行迁移后自动回填 'exact'，行为零漂移（迁移兼容铁律）
 * - 'exact'（缺省）= codeEntry 精确路径，recheck 沿用既有存在性校验；
 *   'pattern' = glob 泛化写法，recheck 豁免精确校验（health 标记 codeEntryStatus:'exempt'）
 * - 生成器曾夹带本地库漂移的 roundtable 索引 DROP/CREATE 杂音（本地库迁移历史不全所致，
 *   与本次变更无关），已人工精修剔除——迁移只含本意变更
 * - down() 直接 DROP COLUMN（新列无存量数据依赖，可安全逆序）
 */
export class AddDocRouteCodeEntryType1786836802462 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "doc_routes" ADD "code_entry_type" character varying(16) NOT NULL DEFAULT 'exact'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "doc_routes" DROP COLUMN "code_entry_type"`);
  }
}
