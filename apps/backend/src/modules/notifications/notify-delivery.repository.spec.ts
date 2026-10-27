/**
 * NotifyDeliveryRepository 单测（写侧永不抛 + S4 读侧的分页/过滤/全序契约）。
 *
 * 设计意图：admin 列表是投递审计的**唯一数据面**，它的三个错法都很安静：
 * ① 过滤没下推到 DB（拉全表再筛 ⇒ `total` 与过滤不一致 ⇒ 前端页码算错）；
 * ② `pageSize` 不夹逼（一条 query 就能拉全表）；
 * ③ 排序不是**全序**（同一毫秒落库的多行在翻页时因 tie-break 不确定而漏行/重复——
 *    experience judgments 的全序索引是同一个教训）。
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NotifyDeliveryRepository } from './notify-delivery.repository';
import {
  NOTIFY_DEFAULT_PAGE_SIZE,
  NOTIFY_MAX_PAGE_SIZE,
} from './notifications.constants';

describe('NotifyDeliveryRepository', () => {
  /** findAndCount 桩（记录入参；返回可控的 [items, total]） */
  function makeRepo(items: unknown[] = [], total = 0) {
    const deliveryRepo = {
      findAndCount: jest.fn().mockResolvedValue([items, total]),
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((entity: unknown) => entity),
    };
    return { deliveryRepo, repository: new NotifyDeliveryRepository(deliveryRepo as never) };
  }

  describe('findAll（admin 只读列表）', () => {
    it('缺省：第 1 页 / 每页 20 / **createdAt DESC, id DESC 全序** / 无过滤条件', async () => {
      const { deliveryRepo, repository } = makeRepo([{ id: 'a' }], 1);

      const page = await repository.findAll({});

      expect(deliveryRepo.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: NOTIFY_DEFAULT_PAGE_SIZE,
      });
      expect(page).toEqual({
        items: [{ id: 'a' }],
        total: 1,
        page: 1,
        pageSize: NOTIFY_DEFAULT_PAGE_SIZE,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('分页：page=3 / pageSize=5 ⇒ skip=10 / take=5（信封字段同步）', async () => {
      const { deliveryRepo, repository } = makeRepo([], 12);

      const page = await repository.findAll({ page: 3, pageSize: 5 });

      expect(deliveryRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 }),
      );
      expect(page).toMatchObject({ page: 3, pageSize: 5, total: 12, totalPages: 3, hasNext: false, hasPrev: true });
    });

    it('hasNext 边界：还有下一页时为 true（page=1 / total=21 / pageSize=20）', async () => {
      const { repository } = makeRepo([], 21);

      const page = await repository.findAll({ page: 1, pageSize: 20 });

      expect(page).toMatchObject({ totalPages: 2, hasNext: true, hasPrev: false });
    });

    it('空表：totalPages=0 且 hasNext/hasPrev 都是 false', async () => {
      const { repository } = makeRepo([], 0);

      const page = await repository.findAll({});

      expect(page).toMatchObject({ total: 0, totalPages: 0, hasNext: false, hasPrev: false });
    });

    it('**夹逼**：pageSize 超上限被夹到 100（服务层兜底，DTO 之外的调用方也安全）', async () => {
      const { deliveryRepo, repository } = makeRepo();

      const page = await repository.findAll({ pageSize: 10_000 });

      expect(deliveryRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: NOTIFY_MAX_PAGE_SIZE }),
      );
      expect(page.pageSize).toBe(NOTIFY_MAX_PAGE_SIZE);
    });

    it('畸形分页：page/pageSize 为 0 / 负数时回落缺省（不产生负 skip）', async () => {
      const { deliveryRepo, repository } = makeRepo();

      const page = await repository.findAll({ page: 0, pageSize: -3 });

      expect(deliveryRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: NOTIFY_DEFAULT_PAGE_SIZE }),
      );
      expect(page).toMatchObject({ page: 1, pageSize: NOTIFY_DEFAULT_PAGE_SIZE });
    });

    it('过滤下推到 DB：category 与 status 都进 where（`total` 才是过滤后的真值）', async () => {
      const { deliveryRepo, repository } = makeRepo();

      await repository.findAll({ category: 'direct', status: 'failed' });

      expect(deliveryRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { category: 'direct', status: 'failed' } }),
      );
    });

    it('过滤可以只给一个维度（另一维不加约束）', async () => {
      const { deliveryRepo, repository } = makeRepo();

      await repository.findAll({ category: 'digest' });

      expect(deliveryRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { category: 'digest' } }),
      );
    });

    it('过滤值不会被静默忽略（where 为空对象 = 无条件，与传 undefined 等价）', async () => {
      const { deliveryRepo, repository } = makeRepo();

      await repository.findAll({ category: undefined, status: undefined });

      const where = deliveryRepo.findAndCount.mock.calls[0][0].where;
      expect(where).toEqual({});
    });
  });

  describe('record（写侧：**永不抛**，S4 不得改坏）', () => {
    it('落库成功后返回（不抛）', async () => {
      const { deliveryRepo, repository } = makeRepo();

      await expect(
        repository.record({
          channel: 'feishu',
          recipient: 'ou_owner',
          category: 'direct',
          eventId: null,
          title: '[nightcrawler]',
          body: 'x',
          outcome: {
            status: 'success',
            attempts: 1,
            responseStatus: 200,
            lastError: null,
            deliveredAt: new Date(),
          },
        }),
      ).resolves.toBeUndefined();
      expect(deliveryRepo.save).toHaveBeenCalledTimes(1);
    });

    it('DB 抖动（save 抛错）只记 error，**绝不冒泡**（否则一次抖动升级成进程级故障）', async () => {
      const { deliveryRepo, repository } = makeRepo();
      deliveryRepo.save.mockRejectedValue(new Error('PG down'));
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(
        repository.record({
          channel: 'feishu',
          recipient: 'ou',
          category: 'direct',
          eventId: null,
          title: 't',
          body: 'b',
          outcome: { status: 'failed', attempts: 1, responseStatus: null, lastError: 'x', deliveredAt: null },
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});
