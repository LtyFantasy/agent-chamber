import 'reflect-metadata';
import { validate } from 'class-validator';
import { PatchDocMetadataDto } from './patch-doc-metadata.dto';

/**
 * PatchDocMetadataDto 校验测试（v1.61.0 批次 2，Board 任务 201ae04f）
 *
 * 设计意图 = Partial 三态语义无歧义（游戏方契约第 1 条）：
 * - 字段缺席（undefined）= 不动 → 校验跳过；
 * - 字段 null = 400 拒绝 → @ValidateIf 让 null 进入校验被类型装饰器拦下
 *   （@IsOptional 会把 null 当缺席跳过——三态契约禁止，见 DTO AGENT-HOOK）；
 * - 字段显式给值 = 更新 → 按类型/长度规则校验（tags: [] = 清空，合法显式值）。
 */
describe('PatchDocMetadataDto', () => {
  /** 构造带必填 expectedContentHash 的最小合法 DTO */
  function makeDto(overrides: Record<string, unknown> = {}): PatchDocMetadataDto {
    const dto = new PatchDocMetadataDto();
    dto.expectedContentHash = 'a'.repeat(64);
    return Object.assign(dto, overrides) as PatchDocMetadataDto;
  }

  // ─── 三态矩阵：缺席 / 显式 / null ─────────────────────────────

  it('accepts minimal body (only required expectedContentHash — all metadata fields absent)', async () => {
    const errors = await validate(makeDto());
    expect(errors).toHaveLength(0);
  });

  it('accepts every metadata field explicitly set', async () => {
    const dto = makeDto({
      title: '新标题',
      summary: '新摘要',
      docType: 'guide',
      tags: ['a', 'b'],
      category: 'architecture',
      allowCreateCategory: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects null title (three-state: null = 400, not "absent")', async () => {
    const errors = await validate(makeDto({ title: null }));
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });

  it('rejects null summary', async () => {
    const errors = await validate(makeDto({ summary: null }));
    expect(errors.some((e) => e.property === 'summary')).toBe(true);
  });

  it('rejects null docType', async () => {
    const errors = await validate(makeDto({ docType: null }));
    expect(errors.some((e) => e.property === 'docType')).toBe(true);
  });

  it('rejects null tags (empty array is the clear-tags signal, null is invalid)', async () => {
    const errors = await validate(makeDto({ tags: null }));
    expect(errors.some((e) => e.property === 'tags')).toBe(true);
  });

  it('rejects null category', async () => {
    const errors = await validate(makeDto({ category: null }));
    expect(errors.some((e) => e.property === 'category')).toBe(true);
  });

  it('rejects null allowCreateCategory', async () => {
    const errors = await validate(makeDto({ allowCreateCategory: null }));
    expect(errors.some((e) => e.property === 'allowCreateCategory')).toBe(true);
  });

  it('rejects null expectedContentHash (required precondition)', async () => {
    const dto = new PatchDocMetadataDto();
    (dto as { expectedContentHash: unknown }).expectedContentHash = null;
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedContentHash')).toBe(true);
  });

  it('rejects missing expectedContentHash (required field)', async () => {
    const dto = new PatchDocMetadataDto();
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedContentHash')).toBe(true);
  });

  // ─── tags 三态关键区分：[] = 清空（合法）vs 缺席 = 不动 ──────────

  it('accepts tags: [] (clear-tags semantics — empty array is a valid explicit value)', async () => {
    const errors = await validate(makeDto({ tags: [] }));
    expect(errors).toHaveLength(0);
  });

  it('rejects tags with non-string items', async () => {
    const errors = await validate(makeDto({ tags: ['ok', 42] }));
    expect(errors.some((e) => e.property === 'tags')).toBe(true);
  });

  it('rejects tags over 20 items (ArrayMaxSize, aligned with upsert)', async () => {
    const errors = await validate(makeDto({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }));
    expect(errors.some((e) => e.property === 'tags' && e.constraints?.arrayMaxSize)).toBe(true);
  });

  it('rejects tags item over 50 chars (aligned with upsert)', async () => {
    const errors = await validate(makeDto({ tags: ['x'.repeat(51)] }));
    expect(errors.some((e) => e.property === 'tags')).toBe(true);
  });

  // ─── 列宽边界（铁律 #21：DTO 层 400，禁止透传 PG 22001 → 500）────

  it('rejects title over 200 chars', async () => {
    const errors = await validate(makeDto({ title: 'x'.repeat(201) }));
    expect(errors.some((e) => e.property === 'title' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects summary over 500 chars', async () => {
    const errors = await validate(makeDto({ summary: 'x'.repeat(501) }));
    expect(errors.some((e) => e.property === 'summary' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects docType over 64 chars', async () => {
    const errors = await validate(makeDto({ docType: 'x'.repeat(65) }));
    expect(errors.some((e) => e.property === 'docType' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects category over 100 chars', async () => {
    const errors = await validate(makeDto({ category: 'x'.repeat(101) }));
    expect(errors.some((e) => e.property === 'category' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects expectedContentHash over 64 chars (sha256 hex fixed width)', async () => {
    const errors = await validate(makeDto({ expectedContentHash: 'a'.repeat(65) }));
    expect(
      errors.some((e) => e.property === 'expectedContentHash' && e.constraints?.maxLength),
    ).toBe(true);
  });

  it('rejects non-string title / non-boolean allowCreateCategory (type guards)', async () => {
    const errors = await validate(makeDto({ title: 123, allowCreateCategory: 'yes' }));
    expect(errors.some((e) => e.property === 'title' && e.constraints?.isString)).toBe(true);
    expect(errors.some((e) => e.property === 'allowCreateCategory' && e.constraints?.isBoolean)).toBe(true);
  });
});
