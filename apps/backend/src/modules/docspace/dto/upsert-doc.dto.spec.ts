import 'reflect-metadata';
import { validate } from 'class-validator';
import { UpsertDocDto } from './upsert-doc.dto';

/**
 * UpsertDocDto 校验测试（A2：category/tags 长度校验）
 *
 * 设计意图：category 对应 doc_category.name varchar(100)，tags 为无界 jsonb 数组。
 * 超长输入必须在 DTO 层返回 400（铁律 21 双层校验），禁止透传到 PostgreSQL 触发 22001 → 500。
 */
describe('UpsertDocDto', () => {
  /** 构造最小合法 DTO，单项测试只改一个字段 */
  const makeValidDto = (): UpsertDocDto => {
    const dto = new UpsertDocDto();
    dto.path = 'docs/test.md';
    dto.content = '# Hello';
    return dto;
  };

  it('accepts a valid category and tags', async () => {
    const dto = makeValidDto();
    dto.category = 'guides';
    dto.tags = ['a', 'b'];

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects category exceeding 100 chars (must be 400, not PG 22001 → 500)', async () => {
    const dto = makeValidDto();
    dto.category = 'a'.repeat(101);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'category' && e.constraints?.maxLength)).toBe(true);
  });

  it('rejects more than 20 tags', async () => {
    const dto = makeValidDto();
    dto.tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tags' && e.constraints?.arrayMaxSize)).toBe(true);
  });

  it('rejects a single tag exceeding 50 chars', async () => {
    const dto = makeValidDto();
    dto.tags = ['ok', 'x'.repeat(51)];

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tags' && e.constraints?.maxLength)).toBe(true);
  });

  it('accepts a valid sourceSha (last-verified git sha)', async () => {
    const dto = makeValidDto();
    dto.sourceSha = 'a'.repeat(40); // git rev-parse HEAD 40 hex

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects sourceSha exceeding 64 chars (must be 400, not PG 22001 → 500)', async () => {
    const dto = makeValidDto();
    dto.sourceSha = 'a'.repeat(65);

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'sourceSha' && e.constraints?.maxLength)).toBe(true);
  });

  it('accepts forceRechunk as a boolean (债 B 元数据修复参数)', async () => {
    const dto = makeValidDto();
    dto.forceRechunk = true;

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects non-boolean forceRechunk (格式层 400，不透传 service)', async () => {
    const dto = makeValidDto();
    (dto as unknown as { forceRechunk: unknown }).forceRechunk = 'yes';

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'forceRechunk' && e.constraints?.isBoolean)).toBe(true);
  });
});
