import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MergeDocCategoryDto } from './merge-doc-category.dto';

/**
 * MergeDocCategoryDto 校验测试（DocSpace 元数据治理 3 期）
 *
 * 格式层只做两件事（铁律 #21 层 1）：`targetId` 必须是 UUID、幂等键尺度 1~64。
 * 业务层（source/target 存在性、同空间、target 未软删、target ≠ source）归
 * DocRenameService —— 本 spec 只钉格式边界。
 */
describe('MergeDocCategoryDto', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('合法输入通过（UUID targetId）', async () => {
    const dto = plainToInstance(MergeDocCategoryDto, { targetId: uuid });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects 非 UUID targetId（空串 / 字面量 / 缺参）', async () => {
    for (const bad of ['', 'cat-1', undefined, 42]) {
      const errors = await validate(plainToInstance(MergeDocCategoryDto, { targetId: bad }));
      expect(errors.some((e) => e.property === 'targetId')).toBe(true);
    }
  });

  it('dryRun 必须是 boolean', async () => {
    expect(
      (await validate(plainToInstance(MergeDocCategoryDto, { targetId: uuid, dryRun: true }))).length,
    ).toBe(0);
    expect(
      (
        await validate(plainToInstance(MergeDocCategoryDto, { targetId: uuid, dryRun: 'yes' }))
      ).some((e) => e.property === 'dryRun'),
    ).toBe(true);
  });

  it('idempotencyKey 长度边界（1 / 64 通过，65 拒绝）', async () => {
    expect(
      (
        await validate(plainToInstance(MergeDocCategoryDto, { targetId: uuid, idempotencyKey: 'k' }))
      ).length,
    ).toBe(0);
    expect(
      (
        await validate(
          plainToInstance(MergeDocCategoryDto, { targetId: uuid, idempotencyKey: 'k'.repeat(64) }),
        )
      ).length,
    ).toBe(0);
    expect(
      (
        await validate(
          plainToInstance(MergeDocCategoryDto, { targetId: uuid, idempotencyKey: 'k'.repeat(65) }),
        )
      ).some((e) => e.property === 'idempotencyKey'),
    ).toBe(true);
  });
});
