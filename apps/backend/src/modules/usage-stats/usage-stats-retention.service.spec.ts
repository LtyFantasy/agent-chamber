import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  USAGE_STATS_RETENTION_BATCH_SIZE,
  USAGE_STATS_RETENTION_CRON,
  USAGE_STATS_RETENTION_DELETE_SQL,
  USAGE_STATS_RETENTION_TIME_ZONE,
  USAGE_STATS_RETENTION_VACUUM_SQL,
  UsageStatsRetentionService,
} from './usage-stats-retention.service';

/**
 * 保留策略单测：cron 元数据（UTC！）+ 分批 catch-up + VACUUM 的事务边界。
 *
 * 为什么单独钉 VACUUM：`VACUUM` 不能在事务块内执行，一旦与删除循环共用同一个
 * queryRunner/事务，PG 直接报错、月度清理整体失败——而失败只在一年后的生产
 * 第一次删除时才暴露（月频 cron 的典型坑）。
 */
describe('UsageStatsRetentionService', () => {
  let events: string[];
  let queryRunner: { query: jest.Mock; release: jest.Mock };
  let dataSource: { createQueryRunner: jest.Mock; query: jest.Mock };
  let service: UsageStatsRetentionService;

  beforeEach(() => {
    events = [];
    queryRunner = {
      query: jest.fn(async () => {
        events.push('delete');
        return { affected: 0 };
      }),
      release: jest.fn(async () => {
        events.push('release');
      }),
    };
    dataSource = {
      createQueryRunner: jest.fn(() => queryRunner),
      query: jest.fn(async () => {
        events.push('vacuum');
        return [[], 0];
      }),
    };
    service = new UsageStatsRetentionService(dataSource as unknown as DataSource);
  });

  afterEach(() => jest.clearAllMocks());

  it('@Cron 元数据：表达式 30 4 1 * *（每月 1 日 04:30）', () => {
    // @nestjs/schedule 把选项存进 'SCHEDULE_CRON_OPTIONS' 元数据（该常量名在
    // 包内未从 index 导出，故按字面量读取，attachment-gc.service.spec.ts 同先例）
    const cron = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      UsageStatsRetentionService.prototype.sweepExpiredBuckets,
    ) as { cronTime?: string; timeZone?: string } | undefined;
    expect(cron?.cronTime).toBe(USAGE_STATS_RETENTION_CRON);
    expect(cron?.cronTime).toBe('30 4 1 * *');
  });

  it('@Cron 元数据：timeZone 必须是 UTC（缺省会用进程本地时区，host=Asia/Shanghai 差 8 小时）', () => {
    const cron = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      UsageStatsRetentionService.prototype.sweepExpiredBuckets,
    ) as { timeZone?: string } | undefined;
    expect(cron?.timeZone).toBe(USAGE_STATS_RETENTION_TIME_ZONE);
    expect(cron?.timeZone).toBe('UTC');
  });

  it('删除 SQL 带 13 个月阈值与 LIMIT 分批', () => {
    expect(USAGE_STATS_RETENTION_DELETE_SQL).toContain("interval '13 months'");
    expect(USAGE_STATS_RETENTION_DELETE_SQL).toContain(`LIMIT ${USAGE_STATS_RETENTION_BATCH_SIZE}`);
    expect(USAGE_STATS_RETENTION_DELETE_SQL).toContain('id IN (');
  });

  it('单批删尽（不足一批）→ 一轮结束', async () => {
    queryRunner.query.mockResolvedValue({ affected: 3 });

    const result = await service.purgeExpiredBuckets();

    expect(result).toEqual({ deletedRows: 3, batches: 1 });
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
  });

  it('满批 → 继续下一轮 catch-up，直到不足一批', async () => {
    queryRunner.query
      .mockResolvedValueOnce({ affected: USAGE_STATS_RETENTION_BATCH_SIZE })
      .mockResolvedValueOnce({ affected: USAGE_STATS_RETENTION_BATCH_SIZE })
      .mockResolvedValueOnce({ affected: 17 });

    const result = await service.purgeExpiredBuckets();

    expect(result).toEqual({ deletedRows: 2 * USAGE_STATS_RETENTION_BATCH_SIZE + 17, batches: 3 });
    expect(queryRunner.query).toHaveBeenCalledTimes(3);
    // 每批都是同一条参数化删除语句（无内插用户输入）
    expect(queryRunner.query.mock.calls[0][0]).toBe(USAGE_STATS_RETENTION_DELETE_SQL);
  });

  it('恰好整批后已删尽（下一轮 0 行）→ 以 rowCount=0 收口', async () => {
    queryRunner.query
      .mockResolvedValueOnce({ affected: USAGE_STATS_RETENTION_BATCH_SIZE })
      .mockResolvedValueOnce({ affected: 0 });

    const result = await service.purgeExpiredBuckets();

    expect(result.batches).toBe(2);
    expect(result.deletedRows).toBe(USAGE_STATS_RETENTION_BATCH_SIZE);
  });

  it('affected 缺失（驱动返回形态变化）按 0 处理，不死循环', async () => {
    queryRunner.query.mockResolvedValue({});

    const result = await service.purgeExpiredBuckets();

    expect(result).toEqual({ deletedRows: 0, batches: 1 });
  });

  it('VACUUM 在 queryRunner 释放之后、经 dataSource 独立执行（不在同一事务里）', async () => {
    // 用 mockImplementation（而非 mockResolvedValue）保留事件记录
    queryRunner.query.mockImplementation(async () => {
      events.push('delete');
      return { affected: 5 };
    });

    await service.purgeExpiredBuckets();

    expect(events).toEqual(['delete', 'release', 'vacuum']);
    expect(dataSource.query).toHaveBeenCalledWith(USAGE_STATS_RETENTION_VACUUM_SQL);
    // 不带参数 → node-postgres 走简单查询协议（参数化会被包进隐式事务/扩展协议）
    expect(dataSource.query.mock.calls[0]).toHaveLength(1);
    expect(queryRunner.query.mock.calls.every(([sql]) => sql !== USAGE_STATS_RETENTION_VACUUM_SQL)).toBe(
      true,
    );
  });

  it('queryRunner 始终释放（异常路径不泄漏连接）', async () => {
    queryRunner.query.mockRejectedValue(new Error('deadlock detected'));

    await expect(service.purgeExpiredBuckets()).rejects.toThrow('deadlock');
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('cron 入口永不抛出：删除失败只记 error 日志，且不执行 VACUUM', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    queryRunner.query.mockRejectedValue(new Error('connection terminated'));

    await expect(service.sweepExpiredBuckets()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('retention sweep failed'),
      expect.anything(),
    );
    expect(dataSource.query).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('cron 入口成功路径记录总量日志', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    queryRunner.query.mockResolvedValue({ affected: 9 });

    await service.sweepExpiredBuckets();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('deletedRows=9'));
    log.mockRestore();
  });

  it('cron 入口永不抛出：VACUUM 失败同样只记日志', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    queryRunner.query.mockResolvedValue({ affected: 1 });
    dataSource.query.mockRejectedValue(new Error('cannot vacuum in transaction'));

    await expect(service.sweepExpiredBuckets()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();

    error.mockRestore();
  });
});
