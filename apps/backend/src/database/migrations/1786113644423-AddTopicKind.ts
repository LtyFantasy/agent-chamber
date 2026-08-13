import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * topics 表增列 kind（圆桌 M2 阶段 1，见 docs/roundtable-design.md §5）
 *
 * 设计要点：
 * - 单列表加列：`kind varchar NOT NULL DEFAULT 'normal'`，存量行零感知（迁移兼容铁律：
 *   增列设默认值，不改写存量数据），回滚 = 直接减列
 * - 圆桌取值 'roundtable'（设计文档 §5 冻结，铁律 #20 契约即设计：枚举值是设计数据）
 * - kind 创建后不可变（M2 阶段 1 决策：update 忽略 kind，normal↔roundtable 互转在
 *   推迟清单），因此本迁移不需要 CHECK 约束——语义约束在应用层
 *
 * ⚠️ 本文件为人工手写，禁止用 typeorm migration:generate 生成——存量表有元数据漂移
 * 噪音债（M1 migration 同源问题，见 AddRoundtableRunnerAndSeat 头部注释），
 * 单列增列不值得冒漂移噪音风险。
 */
export class AddTopicKind1786113644423 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topics" ADD "kind" character varying(20) NOT NULL DEFAULT 'normal'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "topics" DROP COLUMN "kind"`);
  }
}
