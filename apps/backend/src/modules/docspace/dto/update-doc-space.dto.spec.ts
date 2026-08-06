import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateDocSpaceDto } from './update-doc-space.dto';

/**
 * UpdateDocSpaceDto 校验测试
 * - P2 批次 A3：name 补 @MinLength(1)（空串 → 400，对齐 CreateDocSpaceDto）
 * - P2 批次 A8：description 支持显式 null 清空（@IsOptional 放行 null），空串 '' → 400
 */
describe('UpdateDocSpaceDto', () => {
  describe('name (A3)', () => {
    it('accepts a valid name', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { name: 'Updated Docs' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects empty string name (→ 400)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { name: '' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'name' && e.constraints?.minLength)).toBe(true);
    });
  });

  describe('description (A8)', () => {
    it('accepts a valid description', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { description: 'Some description' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts explicit null (清空语义，@IsOptional 放行 null)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { description: null });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.description).toBeNull();
    });

    it('rejects empty string description (→ 400，@MinLength(1))', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { description: '' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'description' && e.constraints?.minLength)).toBe(
        true,
      );
    });

    it('omitted description passes (未提供 → service 保留旧值)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { name: 'X' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.description).toBeUndefined();
    });

    it('accepts boundary 20000 chars (图例化 cap，v1.41)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { description: 'a'.repeat(20000) });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects 20001 chars (→ 400，超出图例 cap)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { description: 'a'.repeat(20001) });
      const errors = await validate(dto);
      expect(
        errors.some((e) => e.property === 'description' && e.constraints?.maxLength),
      ).toBe(true);
    });
  });

  describe('overviewFilter (v1.38)', () => {
    it('accepts a valid overviewFilter with excludeTypes/excludeCategories', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeTypes: ['memory'], excludeCategories: ['archive'] },
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.overviewFilter?.excludeTypes).toEqual(['memory']);
    });

    it('accepts empty exclude lists (no-op filter)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeTypes: [], excludeCategories: [] },
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects non-array excludeTypes (→ 400)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeTypes: 'memory' },
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-string elements in excludeTypes (→ 400)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeTypes: [123] },
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    // ── 数组数量/长度上限（评审 B1，铁律 #21）──
    it('rejects excludeTypes over 20 items (→ 400)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeTypes: Array.from({ length: 21 }, (_, i) => `type-${i}`) },
      });
      const errors = await validate(dto);
      // @ValidateNested 嵌套错误挂在顶层错误的 children 上
      expect(
        errors.some(
          (e) =>
            e.property === 'overviewFilter' &&
            e.children?.some((c) => c.property === 'excludeTypes' && c.constraints?.arrayMaxSize),
        ),
      ).toBe(true);
    });

    it('rejects excludeTypes item over 64 chars (docType 单值上限)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeTypes: ['a'.repeat(65)] },
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects excludeCategories item over 128 chars (slug 单值上限)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: { excludeCategories: ['a'.repeat(129)] },
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('accepts boundary sizes (20 items, 64/128 char items)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, {
        overviewFilter: {
          excludeTypes: Array.from({ length: 20 }, () => 'a'.repeat(64)),
          excludeCategories: ['b'.repeat(128)],
        },
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts explicit null (清除语义，@ValidateIf 放行 null)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { overviewFilter: null });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.overviewFilter).toBeNull();
    });

    it('omitted overviewFilter passes (未提供 → service 保留旧值)', async () => {
      const dto = plainToInstance(UpdateDocSpaceDto, { name: 'X' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.overviewFilter).toBeUndefined();
    });
  });
});
