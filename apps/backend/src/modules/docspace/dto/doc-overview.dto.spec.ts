import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DocOverviewQueryDto } from './doc-overview.dto';

/**
 * DocOverviewQueryDto 校验测试（v1.38 overview 可配置过滤）
 *
 * 覆盖：全字段 optional、maxTokens 边界（500–16000）、
 * applySpaceDefaults 字符串 'false'→false transform、非法值拒绝。
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
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxTokens).toBe(6000);
    expect(dto.applySpaceDefaults).toBe(false);
  });

  describe('maxTokens 边界（500–16000）', () => {
    it('accepts 500 (lower bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '500' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts 16000 (upper bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '16000' });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects 499 (below lower bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '499' });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'maxTokens' && e.constraints?.min)).toBe(true);
    });

    it('rejects 16001 (above upper bound)', async () => {
      const dto = plainToInstance(DocOverviewQueryDto, { maxTokens: '16001' });
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
});
