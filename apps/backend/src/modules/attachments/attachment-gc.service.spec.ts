/**
 * AttachmentGcService 单测（plan §3.7 软删清扫 + P2 批 4 孤儿清扫）
 *
 * 覆盖（每日软删轨）：软删超窗行查询形态（withDeleted + addSelect('a.deletedAt') +
 * 窗口参数）、删对象 → 硬删行职责链（**原图 + 缩略图双键**）、删对象失败记日志继续
 * （行照删、后续行不受影响、objectFailures 计数）、空批零动作、启动补扫
 * fire-and-forget 不 reject、GC 不写 audit（本服务无 audit 依赖——结构性保证）。
 *
 * 覆盖（每周孤儿轨）：保护集查询形态（withDeleted 全表只取 objectKey/thumbKey 两列）、
 * 孤儿删除、合法对象与缩略图对象双列保留、**软删行 objectKey+thumbKey 保留**、
 * grace 内新对象保留、缺时间戳保守跳过、删除失败计数继续、计数日志抽样上限、
 * cron 入口委托 1h grace 常量 + @Cron 元数据表达式 '42 4 * * 0'。
 */
import {
  AttachmentGcService,
  ATTACHMENT_GC_RETENTION_DAYS,
  ATTACHMENT_ORPHAN_GRACE_MS,
  ORPHAN_SWEEP_SAMPLE_LIMIT,
} from './attachment-gc.service';
import type { StoredObjectInfo } from './storage.service';
import { Attachment } from '../../database/entities/attachment.entity';

describe('AttachmentGcService', () => {
  let service: AttachmentGcService;
  let attachmentRepo: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let storage: { removeObject: jest.Mock; listObjects: jest.Mock; getBucket: jest.Mock };
  let qb: {
    withDeleted: jest.Mock;
    addSelect: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  };

  /** 超窗软删行工厂 */
  function makeRow(id: string, key: string): Attachment {
    return { id, objectKey: key, deletedAt: new Date('2026-08-01T00:00:00Z') } as Attachment;
  }

  /** 把对象数组包成异步生成器（listObjects 的返回形状） */
  function objectsFrom(items: StoredObjectInfo[]): AsyncGenerator<StoredObjectInfo> {
    return (async function* () {
      for (const item of items) yield item;
    })();
  }

  beforeEach(() => {
    qb = {
      withDeleted: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    attachmentRepo = {
      createQueryBuilder: jest.fn(() => qb),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    storage = {
      removeObject: jest.fn(async () => undefined),
      listObjects: jest.fn(() => objectsFrom([])),
      getBucket: jest.fn(() => 'test-bucket'),
    };
    service = new AttachmentGcService(attachmentRepo as never, storage as never);
  });

  it('查询形态：withDeleted 解除过滤 + addSelect 显式取 deleted_at + 窗口 cutoff', async () => {
    const before = Date.now();
    await service.sweepSoftDeletedOlderThan(30);
    const after = Date.now();

    expect(qb.withDeleted).toHaveBeenCalled();
    expect(qb.addSelect).toHaveBeenCalledWith('a.deletedAt');
    expect(qb.where).toHaveBeenCalledWith('a.deleted_at IS NOT NULL');
    const [clause, params] = qb.andWhere.mock.calls[0];
    expect(clause).toBe('a.deleted_at < :cutoff');
    // cutoff ≈ now - 30d（毫秒级容差）
    const cutoffMs = (params.cutoff as Date).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 30 * 24 * 3600 * 1000 - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - 30 * 24 * 3600 * 1000 + 1000);
  });

  it('空批：零对象操作零硬删', async () => {
    const res = await service.sweepSoftDeletedOlderThan(30);
    expect(res).toEqual({ scanned: 0, hardDeleted: 0, objectFailures: 0 });
    expect(storage.removeObject).not.toHaveBeenCalled();
    expect(attachmentRepo.delete).not.toHaveBeenCalled();
  });

  it('职责链：逐行 删对象（按 objectKey）→ 硬删行', async () => {
    qb.getMany.mockResolvedValue([makeRow('a1', 'k1.png'), makeRow('a2', 'k2.png')]);
    const res = await service.sweepSoftDeletedOlderThan(30);

    expect(storage.removeObject).toHaveBeenCalledWith('k1.png');
    expect(storage.removeObject).toHaveBeenCalledWith('k2.png');
    expect(attachmentRepo.delete).toHaveBeenCalledWith({ id: 'a1' });
    expect(attachmentRepo.delete).toHaveBeenCalledWith({ id: 'a2' });
    // 顺序：每行先删对象后硬删行（对象删除失败才允许继续，见下个用例）
    expect(storage.removeObject.mock.invocationCallOrder[0]).toBeLessThan(
      attachmentRepo.delete.mock.invocationCallOrder[0],
    );
    expect(res).toEqual({ scanned: 2, hardDeleted: 2, objectFailures: 0 });
  });

  it('有缩略图的行：原图 + 缩略图双删（P2 批 1——软删清扫不留 thumb 孤儿）', async () => {
    qb.getMany.mockResolvedValue([
      {
        id: 'a1',
        objectKey: 'k1.png',
        thumbKey: 'k1.thumb.webp',
        deletedAt: new Date('2026-08-01T00:00:00Z'),
      } as Attachment,
      makeRow('a2', 'k2.png'), // 无缩略图：只删原图
    ]);

    const res = await service.sweepSoftDeletedOlderThan(30);

    expect(storage.removeObject).toHaveBeenNthCalledWith(1, 'k1.png');
    expect(storage.removeObject).toHaveBeenNthCalledWith(2, 'k1.thumb.webp');
    expect(storage.removeObject).toHaveBeenNthCalledWith(3, 'k2.png');
    expect(res).toEqual({ scanned: 2, hardDeleted: 2, objectFailures: 0 });
  });

  it('缩略图删失败不牵连原图：objectFailures 只记失败键，行照硬删', async () => {
    qb.getMany.mockResolvedValue([
      {
        id: 'a1',
        objectKey: 'k1.png',
        thumbKey: 'k1.thumb.webp',
        deletedAt: new Date('2026-08-01T00:00:00Z'),
      } as Attachment,
    ]);
    storage.removeObject.mockImplementation(async (key: string) => {
      if (key === 'k1.thumb.webp') throw new Error('minio timeout');
    });

    const res = await service.sweepSoftDeletedOlderThan(30);

    expect(storage.removeObject).toHaveBeenCalledTimes(2); // 原图删照常执行
    expect(res).toEqual({ scanned: 1, hardDeleted: 1, objectFailures: 1 });
  });

  it('删对象失败：记日志继续——行照硬删、后续行不受影响、objectFailures 计数', async () => {
    qb.getMany.mockResolvedValue([
      makeRow('a1', 'bad.png'),
      makeRow('a2', 'good.png'),
      makeRow('a3', 'good2.png'),
    ]);
    storage.removeObject.mockImplementation(async (key: string) => {
      if (key === 'bad.png') throw new Error('minio timeout');
    });

    const res = await service.sweepSoftDeletedOlderThan(30);

    expect(res).toEqual({ scanned: 3, hardDeleted: 3, objectFailures: 1 });
    expect(attachmentRepo.delete).toHaveBeenCalledTimes(3);
    expect(storage.removeObject).toHaveBeenCalledTimes(3);
  });

  it('sweepExpired（cron 入口）委托固定保留期常量', async () => {
    const spy = jest
      .spyOn(service, 'sweepSoftDeletedOlderThan')
      .mockResolvedValue({ scanned: 0, hardDeleted: 0, objectFailures: 0 });
    await service.sweepExpired();
    expect(spy).toHaveBeenCalledWith(ATTACHMENT_GC_RETENTION_DAYS);
    expect(ATTACHMENT_GC_RETENTION_DAYS).toBe(30); // plan §3.7 钉死
  });

  it('onApplicationBootstrap：fire-and-forget 触发补扫，sweep 异常自吞不 reject', async () => {
    const spy = jest
      .spyOn(service, 'sweepSoftDeletedOlderThan')
      .mockRejectedValue(new Error('db down'));
    expect(() => service.onApplicationBootstrap()).not.toThrow();
    // 微任务排空后断言 sweep 已被触发且异常未传播
    await new Promise((resolve) => setImmediate(resolve));
    expect(spy).toHaveBeenCalled();
  });

  // ─── 孤儿对象清扫（P2 批 4）─────────────────────────────────────

  describe('sweepOrphanObjects（孤儿对象清扫）', () => {
    /** 桶内对象条目工厂（默认年龄 24h——超出 1h grace） */
    function obj(key: string, ageMs = 24 * 3600 * 1000): StoredObjectInfo {
      return { key, size: 128, lastModified: new Date(Date.now() - ageMs) };
    }

    /** 设定本轮桶内对象 */
    function setObjects(items: StoredObjectInfo[]): void {
      storage.listObjects.mockImplementation(() => objectsFrom(items));
    }

    /** 保护集行工厂（只关心 objectKey/thumbKey 两列；deletedAt 仅作语义标记） */
    function protectRow(objectKey: string, thumbKey: string | null = null): Attachment {
      return { objectKey, thumbKey } as Attachment;
    }

    it('保护集查询形态：withDeleted 全表 + 只取 objectKey/thumbKey 两列', async () => {
      await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(qb.withDeleted).toHaveBeenCalled();
      expect(qb.select).toHaveBeenCalledWith(['a.objectKey', 'a.thumbKey']);
      expect(qb.addSelect).not.toHaveBeenCalled(); // 孤儿轨不需要 deleted_at 值
    });

    it('孤儿对象（无行、超 grace）→ 删除 + 计数', async () => {
      qb.getMany.mockResolvedValue([]);
      setObjects([obj('orphan-1.png'), obj('orphan-2.png')]);

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(storage.removeObject).toHaveBeenCalledWith('orphan-1.png');
      expect(storage.removeObject).toHaveBeenCalledWith('orphan-2.png');
      expect(res).toEqual({
        scanned: 2,
        deleted: 2,
        skippedFresh: 0,
        skippedUnknownAge: 0,
        failures: 0,
      });
    });

    it('合法对象：objectKey 命中保护集 → 保留', async () => {
      qb.getMany.mockResolvedValue([protectRow('live.png')]);
      setObjects([obj('live.png'), obj('orphan.png')]);

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(storage.removeObject).toHaveBeenCalledTimes(1);
      expect(storage.removeObject).toHaveBeenCalledWith('orphan.png');
      expect(res.deleted).toBe(1);
    });

    it('缩略图对象：thumbKey 命中保护集 → 保留（双列保护核心）', async () => {
      qb.getMany.mockResolvedValue([protectRow('live.png', 'live.thumb.webp')]);
      setObjects([obj('live.png'), obj('live.thumb.webp')]);

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(storage.removeObject).not.toHaveBeenCalled();
      expect(res).toEqual({
        scanned: 2,
        deleted: 0,
        skippedFresh: 0,
        skippedUnknownAge: 0,
        failures: 0,
      });
    });

    it('软删行的 objectKey 与 thumbKey 仍在保护集（withDeleted）→ 原图与 thumb 双保留', async () => {
      // 软删行在 30 天保留期内：其对象与缩略图都还合法（未硬删 = 还能恢复）
      qb.getMany.mockResolvedValue([
        { ...protectRow('soft.png', 'soft.thumb.webp'), deletedAt: new Date() } as Attachment,
      ]);
      setObjects([obj('soft.png'), obj('soft.thumb.webp'), obj('orphan.png')]);

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(storage.removeObject).toHaveBeenCalledTimes(1);
      expect(storage.removeObject).toHaveBeenCalledWith('orphan.png');
      expect(res.deleted).toBe(1);
    });

    it('grace 窗口内的新对象（含在途上传）→ 不删，skippedFresh 计数', async () => {
      qb.getMany.mockResolvedValue([]);
      setObjects([obj('in-flight.png', 5 * 60 * 1000)]); // 5 分钟前

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(storage.removeObject).not.toHaveBeenCalled();
      expect(res.skippedFresh).toBe(1);
      expect(res.deleted).toBe(0);
    });

    it('缺时间戳对象 → 年龄不可证，保守跳过（skippedUnknownAge）', async () => {
      qb.getMany.mockResolvedValue([]);
      setObjects([{ key: 'no-timestamp.png', size: 0, lastModified: null }, obj('old-orphan.png')]);

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(storage.removeObject).toHaveBeenCalledTimes(1);
      expect(storage.removeObject).toHaveBeenCalledWith('old-orphan.png');
      expect(res.skippedUnknownAge).toBe(1);
    });

    it('删除失败：记 error 继续本轮，failures 计数、后续对象照删', async () => {
      qb.getMany.mockResolvedValue([]);
      setObjects([obj('bad.png'), obj('good.png')]);
      storage.removeObject.mockImplementation(async (key: string) => {
        if (key === 'bad.png') throw new Error('minio timeout');
      });
      const errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

      const res = await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      expect(res).toEqual({
        scanned: 2,
        deleted: 1,
        skippedFresh: 0,
        skippedUnknownAge: 0,
        failures: 1,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('key=bad.png'));
    });

    it('计数日志（PM M8）：scanned/deleted + 抽样 key 前 10', async () => {
      qb.getMany.mockResolvedValue([]);
      const items = Array.from({ length: 12 }, (_, i) => obj(`orphan-${i}.png`));
      setObjects(items);
      const logSpy = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

      await service.sweepOrphanObjectsOlderThan(ATTACHMENT_ORPHAN_GRACE_MS);

      const msg = logSpy.mock.calls[0][0] as string;
      expect(msg).toContain('scanned=12');
      expect(msg).toContain('deleted=12');
      expect(msg).toContain(`graceMs=${ATTACHMENT_ORPHAN_GRACE_MS}`);
      const sample = /sampleKeys=\[([^\]]*)\]/.exec(msg)?.[1] ?? '';
      expect(sample.split(', ')).toHaveLength(ORPHAN_SWEEP_SAMPLE_LIMIT);
      expect(ORPHAN_SWEEP_SAMPLE_LIMIT).toBe(10);
    });

    it('cron 入口 sweepOrphanObjects 委托 1h grace 常量（无启动补扫）', async () => {
      const spy = jest.spyOn(service, 'sweepOrphanObjectsOlderThan').mockResolvedValue({
        scanned: 0,
        deleted: 0,
        skippedFresh: 0,
        skippedUnknownAge: 0,
        failures: 0,
      });

      await service.sweepOrphanObjects();

      expect(spy).toHaveBeenCalledWith(ATTACHMENT_ORPHAN_GRACE_MS);
      expect(ATTACHMENT_ORPHAN_GRACE_MS).toBe(60 * 60 * 1000); // plan §④ 钉死 1h
    });

    it('@Cron 元数据：42 4 * * 0（周频，与每日 17 3 * * * 软删清扫分轨）', () => {
      // @nestjs/schedule 把表达式存进 'SCHEDULE_CRON_OPTIONS' 元数据（该常量名
      // 未从包根导出，故此处用字面量——见 @nestjs/schedule/dist/schedule.constants.js）
      const cron = Reflect.getMetadata(
        'SCHEDULE_CRON_OPTIONS',
        AttachmentGcService.prototype.sweepOrphanObjects,
      ) as { cronTime?: string } | undefined;
      expect(cron?.cronTime).toBe('42 4 * * 0');
    });
  });
});
