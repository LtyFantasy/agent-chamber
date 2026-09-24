import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 接口/MCP 调用频率小时桶建表迁移（plan rocket-batwoman-booster-gold §2 D7，逐列钉死）
 *
 * 表 api_usage_stats_hourly：REST 请求 + MCP invocation 的**预聚合**计数
 * （用户拍板不做请求级明细表）。9 列维度构成唯一键，ON CONFLICT 累加
 * `call_count` / `latency_sum_ms` / `latency_max_ms` 三列。
 *
 * 三条教训（本迁移的存在理由，改动前必读）：
 * 1. **NULLS NOT DISTINCT 护栏**：唯一索引含可空列 `actor_id`，PG 默认语义下
 *    NULL 互不相等 → 匿名流量永远走 INSERT 分支、重复插行、零报错。
 *    索引必须显式 NULLS NOT DISTINCT（PG15+ 语法），且 entity 侧必须用
 *    **同名同列** `@Index` 声明：TypeORM 0.3.30 不识别该修饰符，按名匹配不到
 *    就会在 migration:generate 时静默 DROP 本索引（后果 = 同维度不再累加）。
 * 2. **actor_id 无 FK 裁定**：统计行须在 actor 硬删后存活（删号不该抹掉历史用量，
 *    audit_logs 无 FK 先例）。刻意不加 REFERENCES。
 * 3. **actor_type 列宽教训**：varchar(16) 而非 (8)——'anonymous' 9 字符，PG 对
 *    超长 varchar 报 22001 **不截断**，一行坏值会让整批 flush INSERT 全灭
 *    （T13/T14 实证：静默失败、表长期零行）。
 *
 * 二级索引**只留** idx_api_usage_stats_actor_bucket (actor_id, bucket_start)：
 * EXPLAIN 实测唯一有收益者；为 distinctActors 二次查询加 route 索引实测
 * 833MB / +24% 体积换 ~300ms，不划算。
 *
 * 表级 autovacuum 参数：月度清理（D11 保留 13 个月）单批 ~94 万死元组低于默认
 * scale_factor 0.2 的触发阈值 → 不设 0.02 则死元组长期堆积、表膨胀。
 *
 * SET LOCAL lock_timeout='5s'（1788439433261 先例：建表需 ACCESS EXCLUSIVE，
 * 长事务占锁时 5s 超时放弃而非无限排队；TypeORM 每 migration 事务内生效）。
 *
 * down() 整体 DROP TABLE（索引/存储参数随表消亡）。
 */
export class AddApiUsageStatsHourly1789484900000 implements MigrationInterface {
  name = 'AddApiUsageStatsHourly1789484900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表锁 5s 超时（长事务占表锁时放弃而非无限排队）
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // 2. 建表：仅 actor_id 可空；其余维度/累加列一律 NOT NULL（写入侧恒有值）
    await queryRunner.query(`
      CREATE TABLE api_usage_stats_hourly (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bucket_start TIMESTAMPTZ NOT NULL,
        channel VARCHAR(8) NOT NULL,
        mcp_surface VARCHAR(16) NOT NULL DEFAULT '',
        tool_name VARCHAR(128) NOT NULL DEFAULT '',
        method VARCHAR(8) NOT NULL,
        route VARCHAR(255) NOT NULL,
        actor_id UUID,
        actor_type VARCHAR(16) NOT NULL,
        status_class VARCHAR(3) NOT NULL,
        call_count INT NOT NULL,
        latency_sum_ms BIGINT NOT NULL,
        latency_max_ms INT NOT NULL
      )
    `);

    // 3. 唯一索引：9 维全列 + NULLS NOT DISTINCT（列顺序 = flush SQL 的 conflict_target 顺序
    //    与 ORDER BY 定序顺序，三处必须一致）
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_api_usage_stats_hourly
      ON api_usage_stats_hourly
        (bucket_start, channel, mcp_surface, tool_name, method, route,
         actor_id, actor_type, status_class)
      NULLS NOT DISTINCT
    `);

    // 4. 唯一二级索引：按 actor 查单 Agent 用量的唯一有收益者
    await queryRunner.query(`
      CREATE INDEX idx_api_usage_stats_actor_bucket
      ON api_usage_stats_hourly (actor_id, bucket_start)
    `);

    // 5. 表级 autovacuum 收紧（可在事务内执行；VACUUM 本身不可，见 D11 清理 cron）
    await queryRunner.query(`
      ALTER TABLE api_usage_stats_hourly
      SET (autovacuum_vacuum_scale_factor = 0.02)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 索引与存储参数随表消亡，无需单独 DROP
    await queryRunner.query(`DROP TABLE IF EXISTS api_usage_stats_hourly`);
  }
}
