/**
 * AttachmentGcService 单测（plan §3.7）
 *
 * 覆盖：软删超窗行查询形态（withDeleted + addSelect('a.deletedAt') + 窗口参数）、
 * 删对象 → 硬删行职责链、删对象失败记日志继续（行照删、后续行不受影响、
 * objectFailures 计数）、空批零动作、启动补扫 fire-and-forget 不 reject、
 * GC 不写 audit（本服务无 audit 依赖——结构性保证）。
 */
import { AttachmentGcService, ATTACHMENT_GC_RETENTION_DAYS } from './attachment-gc.service';
import { Attachment } from '../../database/entities/attachment.entity';

describe('AttachmentGcService', () => {
  let service: AttachmentGcService;
  let attachmentRepo: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let storage: { removeObject: jest.Mock };
  let qb: {
    withDeleted: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getMany: jest.Mock;
  };

  /** 超窗软删行工厂 */
  function makeRow(id: string, key: string): Attachment {
    return { id, objectKey: key, deletedAt: new Date('2026-08-01T00:00:00Z') } as Attachment;
  }

  beforeEach(() => {
    qb = {
      withDeleted: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    attachmentRepo = {
      createQueryBuilder: jest.fn(() => qb),
      delete: jest.fn(async () => ({ affected: 1 })),
    };
    storage = { removeObject: jest.fn(async () => undefined) };
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
});
