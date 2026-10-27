import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DOC_SPACE_TAG_ALIASES_MAX, DOC_SPACE_TAG_MAX_LENGTH } from '@agent-chamber/shared';
import { RenameDocTagsDto } from './rename-doc-tags.dto';

/**
 * RenameDocTagsDto 校验测试（DocSpace 元数据治理 3 期）
 *
 * 钉住两条边界（评审 B1 + 铁律 #21 层 1）：
 * - `to` **trim 后非空**——`"   "` 也必须 400（@IsNotEmpty 单独用会放行空白串，而空白
 *   `to` 会让 array_replace 把旧 tag 写成空串 = 静默脏数据）；
 * - `from` 数组尺度与元素长度（≤20 项、每项 ≤50）——超限必须 DTO 层 400，禁止透传 PG。
 */
describe('RenameDocTagsDto', () => {
  const valid = { from: ['NPC'], to: 'npc' };

  it('合法输入通过（含首尾空白：`to` 被 trim 落库形态）', async () => {
    const dto = plainToInstance(RenameDocTagsDto, { from: [' NPC '], to: '  npc  ' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.to).toBe('npc');
  });

  it('rejects to="" （空串 → 400）', async () => {
    const dto = plainToInstance(RenameDocTagsDto, { ...valid, to: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'to' && e.constraints?.isNotEmpty)).toBe(true);
  });

  it('rejects to="   " （纯空白 → trim 后空 → 400，评审 B1 关键边界）', async () => {
    const dto = plainToInstance(RenameDocTagsDto, { ...valid, to: '   ' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'to')).toBe(true);
    expect(dto.to).toBe('');
  });

  it('rejects to 超长（> 50 字符 → 400）', async () => {
    const dto = plainToInstance(RenameDocTagsDto, {
      ...valid,
      to: 'x'.repeat(DOC_SPACE_TAG_MAX_LENGTH + 1),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'to' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects 缺失 to / 非字符串 to', async () => {
    expect(
      (await validate(plainToInstance(RenameDocTagsDto, { from: ['a'] }))).length,
    ).toBeGreaterThan(0);
    expect(
      (await validate(plainToInstance(RenameDocTagsDto, { from: ['a'], to: 1 }))).length,
    ).toBeGreaterThan(0);
  });

  it('rejects from 空数组 / 元素超长 / 超项数', async () => {
    expect(
      (await validate(plainToInstance(RenameDocTagsDto, { ...valid, from: [] }))).some(
        (e) => e.property === 'from' && e.constraints?.arrayNotEmpty,
      ),
    ).toBe(true);
    expect(
      (
        await validate(
          plainToInstance(RenameDocTagsDto, {
            ...valid,
            from: ['x'.repeat(DOC_SPACE_TAG_MAX_LENGTH + 1)],
          }),
        )
      ).some((e) => e.property === 'from'),
    ).toBe(true);
    expect(
      (
        await validate(
          plainToInstance(RenameDocTagsDto, {
            ...valid,
            from: Array.from({ length: DOC_SPACE_TAG_ALIASES_MAX + 1 }, (_, i) => `t${i}`),
          }),
        )
      ).some((e) => e.property === 'from' && e.constraints?.arrayMaxSize),
    ).toBe(true);
  });

  it('idempotencyKey / expectedBatchToken 长度边界', async () => {
    expect(
      (await validate(plainToInstance(RenameDocTagsDto, { ...valid, idempotencyKey: 'k' }))).length,
    ).toBe(0);
    expect(
      (
        await validate(
          plainToInstance(RenameDocTagsDto, { ...valid, idempotencyKey: 'k'.repeat(64) }),
        )
      ).length,
    ).toBe(0);
    expect(
      (
        await validate(
          plainToInstance(RenameDocTagsDto, { ...valid, idempotencyKey: 'k'.repeat(65) }),
        )
      ).some((e) => e.property === 'idempotencyKey'),
    ).toBe(true);
    expect(
      (
        await validate(
          plainToInstance(RenameDocTagsDto, { ...valid, expectedBatchToken: 'a'.repeat(64) }),
        )
      ).length,
    ).toBe(0);
    expect(
      (
        await validate(
          plainToInstance(RenameDocTagsDto, { ...valid, expectedBatchToken: 'a'.repeat(65) }),
        )
      ).some((e) => e.property === 'expectedBatchToken'),
    ).toBe(true);
  });
});
