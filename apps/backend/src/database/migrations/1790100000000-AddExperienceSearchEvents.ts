import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 经验库检索观测轻表迁移 —— `experience_search_events`（plan v1.3 §8 PM R2）
 *
 * 手写裸 SQL（**禁止裸 `migration:generate` 提交**，同上一个经验库迁移的纪律）。
 *
 * 为什么是独立迁移而不是并进 `AddExperienceEntries`：该迁移已在本仓验证链与漂移基线上
 * 跑过（时间戳 1790000000000 已入账），追加 DDL 会让"迁移链产物"与既有基线快照脱节，
 * 且违反 additive-only 的向前兼容习惯——新表单独一条，回滚面最小。
 *
 * 本表**刻意不建索引**（唯一读形态是 4 周复查的聚合扫描；写路径是每次检索一行，
 * 加索引只增写放大）。列宽 `query_hash varchar(64)` 与 sha256 hex 精确同宽
 * （见实体的 rationale：指纹而非原文，避免观测表成为第二个内容泄漏面）。
 *
 * down()：**仅本仓 migration 往返验证链使用**；**生产回滚走 DEPLOY.md 的 additive-only
 * 口径**（本表无存量读写方，出问题只需停止埋点代码，不回滚 DDL）。
 *
 * 漂移门禁：本表由 TypeORM 元数据**完全表达**（PK + 3 个标量列，无裸 SQL 特有产物），
 * 故预期**不新增基线条目**——若门禁报出本表相关新增项，说明实体与迁移链不一致，
 * 应先对齐二者而不是改基线（test/migration-drift.e2e-spec.ts 的三情形处置）。
 */
export class AddExperienceSearchEvents1790100000000 implements MigrationInterface {
  name = 'AddExperienceSearchEvents1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 建表锁 5s 超时（长事务占 ACCESS EXCLUSIVE 锁时放弃而非无限排队）。
    //    ⚠️ 事务范围（2026-09-22 批 1 审查纠偏）：`migrationsTransactionMode` 未设 ⇒
    //    TypeORM 0.3.30 缺省 'all'，**本批 pending 迁移共用同一事务**，故本条 SET LOCAL
    //    会**一直生效到链尾**（后续更大时间戳的 migration 继承 5s lock_timeout，拿不到锁
    //    即 abort 不留长锁队列——有意保护）。需要别的超时须在本条内显式重设。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    await queryRunner.query(`
      CREATE TABLE experience_search_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        query_hash VARCHAR(64) NOT NULL,
        had_results BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS experience_search_events`);
  }
}
