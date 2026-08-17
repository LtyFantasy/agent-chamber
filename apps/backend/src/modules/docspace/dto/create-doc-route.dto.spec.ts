import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateDocRouteDto } from './create-doc-route.dto';
import { UpdateDocRouteDto } from './update-doc-route.dto';

/**
 * CreateDocRouteDto / UpdateDocRouteDto 校验测试（v1.42 批次 B5）
 *
 * 覆盖：必填字段、长度边界（intent 200 / category 100 / headingPath 512 / codeEntry 512）、
 * UUID 校验、sortOrder 边界（0–10000）、Partial 继承。
 */
describe('CreateDocRouteDto', () => {
  it('accepts a minimal valid payload', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: '我要了解系统架构',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a full payload with all optional fields', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: '我要了解系统架构',
      category: 'architecture',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      primaryHeadingPath: '## 3. 架构总览',
      secondaryDocId: '5f3d1b2a-0000-4000-8000-000000000002',
      secondaryHeadingPath: '## 5. 关键设计决策',
      codeEntry: 'apps/backend/src/app.module.ts',
      sortOrder: 3,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing intent', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'intent')).toBe(true);
  });

  it('rejects empty intent', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: '',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'intent' && e.constraints?.isNotEmpty)).toBe(true);
  });

  it('rejects intent over 200 chars', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i'.repeat(201),
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'intent' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects category over 100 chars', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      category: 'c'.repeat(101),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'category' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects non-UUID primaryDocId', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: 'not-a-uuid',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'primaryDocId' && e.constraints?.isUuid)).toBe(true);
  });

  it('rejects non-UUID secondaryDocId', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      secondaryDocId: 'not-a-uuid',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'secondaryDocId' && e.constraints?.isUuid)).toBe(
      true,
    );
  });

  it('rejects headingPath over 512 chars', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      primaryHeadingPath: '#'.repeat(513),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'primaryHeadingPath' && e.constraints?.maxLength)).toBe(
      true,
    );
  });

  it('rejects codeEntry over 512 chars', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      codeEntry: 'a'.repeat(513),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'codeEntry' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects sortOrder below 0', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      sortOrder: -1,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'sortOrder' && e.constraints?.min)).toBe(true);
  });

  it('rejects sortOrder above 10000', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      sortOrder: 10001,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'sortOrder' && e.constraints?.max)).toBe(true);
  });

  it('rejects non-integer sortOrder', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      sortOrder: 'abc',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'sortOrder')).toBe(true);
  });

  // ─── T5 codeEntryType 枚举校验（缺省 exact，IsIn 白名单） ────

  it('accepts codeEntryType "pattern"（glob 泛化写法，与 codeEntry 配套）', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      codeEntry: 'apps/web/app/**' + '/page.tsx',
      codeEntryType: 'pattern',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts explicit codeEntryType "exact"', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      codeEntryType: 'exact',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects codeEntryType not in exact|pattern（如 "glob"）', async () => {
    const dto = plainToInstance(CreateDocRouteDto, {
      intent: 'i',
      primaryDocId: '5f3d1b2a-0000-4000-8000-000000000001',
      codeEntryType: 'glob',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'codeEntryType' && e.constraints?.isIn)).toBe(true);
  });

  describe('UpdateDocRouteDto (PartialType)', () => {
    it('accepts an empty patch (all fields optional)', async () => {
      const dto = plainToInstance(UpdateDocRouteDto, {});
      expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts a single-field patch (sortOrder only)', async () => {
      const dto = plainToInstance(UpdateDocRouteDto, { sortOrder: 9 });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.sortOrder).toBe(9);
    });

    it('accepts a codeEntryType-only patch (Partial 继承枚举校验)', async () => {
      const dto = plainToInstance(UpdateDocRouteDto, { codeEntryType: 'pattern' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('still enforces field constraints on provided fields', async () => {
      const dto = plainToInstance(UpdateDocRouteDto, { intent: 'i'.repeat(201) });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'intent' && e.constraints?.maxLength)).toBe(true);
    });
  });
});
