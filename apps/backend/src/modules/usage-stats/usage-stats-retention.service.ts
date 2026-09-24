/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：小时桶的**保留策略**（13 个月 + 月度清理）
 *
 * [代码职责]
 *   - 每月 1 日 04:30（**UTC**）删除超过 13 个月的桶，分批 catch-up 直到删尽
 *   - 删除后执行 `VACUUM (ANALYZE)` 回收死元组并刷新统计信息
 *
 * [权威文档]
 *   - 主文档: docs/database.md §api_usage_stats_hourly — 保留策略 + autovacuum 参数
 *   - 补充: docs/api-definition.md §Usage Stats — 端点窗口 ≤90 天、更长历史走 SQL
 *
 * [关键不变量]
 *   - **`timeZone: 'UTC'` 必传**：`@Cron` 默认按**进程本地时区**解释表达式，
 *     生产 host = Asia/Shanghai 时 "04:30" 会实际落在 UTC 20:30（错 8 小时），
 *     与表内 UTC 桶的语义脱节——排障时"说好的凌晨清"根本对不上
 *   - **`VACUUM` 不能进事务**：走独立 `dataSource.query()`（不带参数 → 简单查询协议），
 *     **禁止**与删除循环共用同一个 queryRunner 事务——PG 会报
 *     "VACUUM cannot run inside a transaction block"。ALTER TABLE 那类可进事务的语句
 *     才有资格写进 migration（D7 与 D11 的分界）
 *   - **删除必须分批 catch-up**：单条 DELETE 删数月数据会长时间持锁并撑爆 WAL；
 *     循环 `LIMIT` 批删（每批 ≤10 万行 + 批间小睡）让并发 flush 有机会插队
 *   - **cron 入口绝不抛出**：定时回调里的未捕获异常会打死进程（fail-open 原则），
 *     整段包 try/catch + logger
 *   - 删除阈值用 **DB 时钟**（`now() - interval '13 months'`）：多实例部署时应用侧
 *     时钟不一致会让清理窗口漂移
 *
 * [关联代码]
 *   - usage-stats-buffer.service.ts — 本表唯一写入方（删除与 flush 并发是常态）
 *   - database/migrations/1789484900000-AddApiUsageStatsHourly.ts — 表级 autovacuum
 *     参数（0.02）与本次 VACUUM 共同承担"月度删 ~94 万死元组"的回收责任
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（尤其：timeZone 与 VACUUM 事务边界）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * 保留期（月）。13 个月 = 覆盖"同比看一年 + 一个月缓冲"。
 * 体量参考：中位 ~31k 行/日 → 13 个月 ~12M 行 ~3.4GB（实测）。
 */
export const USAGE_STATS_RETENTION_MONTHS = 13;

/**
 * 单批删除行数上限（10 万）。
 * 为什么分批：一次性删数月数据会让 DELETE 长时间持锁 + 撑爆 WAL；
 * 10 万/批在实测中 ~1.2s 一批（走唯一索引前导 bucket_start），
 * 与并发 flush 的 ON CONFLICT 争用可控。
 */
export const USAGE_STATS_RETENTION_BATCH_SIZE = 100_000;

/** 批间小睡（ms）：给并发 flush 与 autovacuum 让出窗口，避免连打满 IO */
export const USAGE_STATS_RETENTION_BATCH_PAUSE_MS = 250;

/** 清理节奏：每月 1 日 04:30（UTC）。错峰于每日 03:17 附件软删清扫与 04:42 孤儿清扫 */
export const USAGE_STATS_RETENTION_CRON = '30 4 1 * *';

/** cron 时区（见 [关键不变量]：不传会用进程本地时区，与 UTC 桶语义脱节） */
export const USAGE_STATS_RETENTION_TIME_ZONE = 'UTC';

/**
 * 单批删除 SQL（`id IN (SELECT ... LIMIT n)`）。
 * 用 id 子查询而非 DELETE ... LIMIT（PG 不支持 DELETE LIMIT）；阈值走 DB 时钟。
 */
export const USAGE_STATS_RETENTION_DELETE_SQL = `
DELETE FROM api_usage_stats_hourly
WHERE id IN (
  SELECT id FROM api_usage_stats_hourly
  WHERE bucket_start < now() - interval '${USAGE_STATS_RETENTION_MONTHS} months'
  LIMIT ${USAGE_STATS_RETENTION_BATCH_SIZE}
)
`;

/**
 * 回收语句。**必须独立执行**（见 [关键不变量]）：不带参数 → node-postgres 走
 * 简单查询协议，不会被包进事务；`ANALYZE` 顺带刷新规划器统计（删除后行数骤降，
 * 旧统计会让后续查询选错计划）。
 */
export const USAGE_STATS_RETENTION_VACUUM_SQL = 'VACUUM (ANALYZE) api_usage_stats_hourly';

/** 一次清理的结果（logger 记录，调用方可观测） */
export interface UsageStatsRetentionResult {
  /** 本轮删除的总行数 */
  deletedRows: number;
  /** 实际执行的批数（catch-up 轮数） */
  batches: number;
}

/**
 * 小时桶保留策略服务（D11）。
 *
 * 与 flush 的关系：删除按 `bucket_start` 前进方向切尾，flush 只写"当前小时"附近的桶，
 * 两者在唯一索引上不冲突——但**并发是常态**（同一后端进程的 setInterval flush 与
 * cron 同域），所以删除刻意分批 + 批间小睡，而不是一条大事务。
 */
@Injectable()
export class UsageStatsRetentionService {
  private readonly logger = new Logger(UsageStatsRetentionService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * cron 入口（每月 1 日 04:30 UTC）。
   *
   * **绝不抛出**：定时回调里的异常没有上层接住，会直接打死进程——
   * 清理失败的正确后果是"下个月再试 + 日志可见"，而不是停机。
   */
  @Cron(USAGE_STATS_RETENTION_CRON, { timeZone: USAGE_STATS_RETENTION_TIME_ZONE })
  async sweepExpiredBuckets(): Promise<void> {
    try {
      const result = await this.purgeExpiredBuckets();
      this.logger.log(
        `retention sweep done: deletedRows=${result.deletedRows}, batches=${result.batches} ` +
          `(retentionMonths=${USAGE_STATS_RETENTION_MONTHS})`,
      );
    } catch (err) {
      this.logger.error(
        `retention sweep failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /**
   * 清理核心逻辑（独立方法便于直测，cron 只是它的定时包装）。
   *
   * 分批 catch-up：每批删 ≤10 万行，**不足一批即说明已删尽**（等价于"循环到
   * rowCount=0"，少一次必然为空的查询），批间小睡让并发 flush 插队。
   * 删除结束、queryRunner 释放后才执行 VACUUM（见 [关键不变量] 事务边界）。
   *
   * @returns 删除行数与批数（供 logger 与测试断言）
   */
  async purgeExpiredBuckets(): Promise<UsageStatsRetentionResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    let deletedRows = 0;
    let batches = 0;
    try {
      for (;;) {
        // useStructuredResult=true：只有结构化结果里才有 affected（行数）。
        // 非结构化返回对 DELETE 是 [rows, rowCount] 的裸元组——读它属于赌驱动实现。
        const result = await queryRunner.query(USAGE_STATS_RETENTION_DELETE_SQL, [], true);
        const rowCount = result.affected ?? 0;
        deletedRows += rowCount;
        batches += 1;
        if (rowCount < USAGE_STATS_RETENTION_BATCH_SIZE) break;
        await sleep(USAGE_STATS_RETENTION_BATCH_PAUSE_MS);
      }
    } finally {
      await queryRunner.release();
    }

    // 独立执行（不带参数 → 简单查询协议）：VACUUM 在事务块内会被 PG 拒绝
    await this.dataSource.query(USAGE_STATS_RETENTION_VACUUM_SQL);

    return { deletedRows, batches };
  }
}

/** 停顿指定毫秒（批间让行；用 unref 定时器避免测试进程被它拖住） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
