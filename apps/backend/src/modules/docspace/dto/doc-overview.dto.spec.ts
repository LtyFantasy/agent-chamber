import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DocOverviewQueryDto } from './doc-overview.dto';

/**
 * DocOverviewQueryDto 校验测试（v1.38 overview 可配置过滤）
 *
 * 覆盖：全字段 optional、maxTokens 边界（500–50000，v1.41 放宽）、
 * applySpaceDefaults/includeDescription 字符串 transform、非法值拒绝。
 */
describe('DocOverviewQueryDto', () => {
  it('accepts an empty query (all fields optional)', async () => {
    const dto = plainToInstance(DocOverviewQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts all filter fields', async () => {
    const dto = plainToInstance(DocOverviewQueryDto, {
      type: 'guide,reference',
      excludeType: 'memory',
      category: 'architecture',
      excludeCategory: 'archive',
      tag: 'production',
      pathPrefix: 'docs/',
      maxTokens: '6000',
      applySpaceDefaults: 'false',
      includeDescription: 'false',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxTokens).toBe(6000);
    expect(dto.applySpaceDefaults).toBe(false);
    expect(dto.includeDescription).toBe(false);
  });

  describe('maxTokens 边界（500–50000，v1.41 放宽）', () => {
    it('accepts 500 (lower bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '500' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts 50000 (upper bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '50000' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects 499 (below lower bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '499' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'maxTokens' && e.constraints?.min)).toBe(true);
    });

    it('rejects 50001 (above upper bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '50001' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'maxTokens' && e.constraints?.max)).toBe(true);
    });

    it('rejects non-integer', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: 'abc' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'maxTokens')).toBe(true);
    });
  });

  describe('字符串字段长度上限（评审 B1，铁律 #21）', () => {
    it('rejects CSV 组合字段超 512（type）', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { type: `guide,${'a'.repeat(511)}` });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'type' && e.constraints?.maxLength)).toBe(true);
    });

    it('rejects CSV 组合字段超 512（excludeType）', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { excludeType: `memory,${'b'.repeat(511)}` });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'excludeType' && e.constraints?.maxLength)).toBe(
        true,
      );
    });

    it('rejects CSV 组合字段超 512（category）', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { category: `arch,${'c'.repeat(511)}` });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'category' && e.constraints?.maxLength)).toBe(true);
    });

    it('rejects CSV 组合字段超 512（excludeCategory）', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, {
        excludeCategory: `archive,${'d'.repeat(511)}`,
      });
      const errors = await validate(dto);
      expect(
        errors.some((e) => e.property === 'excludeCategory' && e.constraints?.maxLength),
      ).toBe(true);
    });

    it('rejects tag 超 64（单值上限）', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { tag: 'a'.repeat(65) });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'tag' && e.constraints?.maxLength)).toBe(true);
    });

    it('rejects pathPrefix 超 512', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { pathPrefix: 'a'.repeat(513) });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'pathPrefix' && e.constraints?.maxLength)).toBe(
        true,
      );
    });

    it('accepts 边界长度（type 恰 512、tag 恰 64、pathPrefix 恰 512）', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, {
        type: 'a'.repeat(512),
        tag: 'a'.repeat(64),
        pathPrefix: 'a'.repeat(512),
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('applySpaceDefaults transform（严格解析，评审 B2）', () => {
    it("parses 'false' as false (escape hatch)", async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { applySpaceDefaults: 'false' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.applySpaceDefaults).toBe(false);
    });

    it("parses 'true' as true", async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { applySpaceDefaults: 'true' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.applySpaceDefaults).toBe(true);
    });

    it('omitted → undefined (service 视为 true)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, {});
      expect(dto.applySpaceDefaults).toBeUndefined();
    });

    // 其余值不再静默解析为 false：格式错误直接 400（铁律 #21 不透传）
    it.each(['1', '0', 'yes', 'TRUE', 'False', '', 'on'])(
      "rejects '%s' (→ 400，不再静默当作 false)",
      async (value) => {
        const dto = plainToInstance(DocOverviewQueryDto, { applySpaceDefaults: value });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'applySpaceDefaults')).toBe(true);
      },
    );
  });

  describe('includeDescription transform（v1.41，对齐 applySpaceDefaults 惯例）', () => {
    it("parses 'false' as false (省略图例)", async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { includeDescription: 'false' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.includeDescription).toBe(false);
    });

    it("parses 'true' as true", async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { includeDescription: 'true' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.includeDescription).toBe(true);
    });

    it('omitted → undefined (service 视为 true 默认内嵌图例)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, {});
      expect(dto.includeDescription).toBeUndefined();
    });

    // 同 applySpaceDefaults：格式错误直接 400，不静默当作 false
    it.each(['1', '0', 'yes', 'TRUE', 'False', '', 'on'])(
      "rejects '%s' (→ 400，格式错误不透传)",
      async (value) => {
        const dto = plainToInstance(DocOverviewQueryDto, { includeDescription: value });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'includeDescription')).toBe(true);
      },
    );
  });

  describe('includeRoutes transform（v1.42 B5，对齐 includeDescription 惯例）', () => {
    it("parses 'false' as false (省略 routes)", async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { includeRoutes: 'false' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.includeRoutes).toBe(false);
    });

    it("parses 'true' as true", async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { includeRoutes: 'true' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.includeRoutes).toBe(true);
    });

    it('omitted → undefined (service 视为 true 默认内嵌 routes)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, {});
      expect(dto.includeRoutes).toBeUndefined();
    });

    // 同 includeDescription：格式错误直接 400，不静默当作 false
    it.each(['1', '0', 'yes', 'TRUE', 'False', '', 'on'])(
      "rejects '%s' (→ 400，格式错误不透传)",
      async (value) => {
        const dto = plainToInstance(DocOverviewQueryDto, { includeRoutes: value });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === 'includeRoutes')).toBe(true);
      },
    );
  });
});
