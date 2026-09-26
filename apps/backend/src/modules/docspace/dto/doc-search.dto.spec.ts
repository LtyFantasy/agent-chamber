import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DocSearchDto } from './doc-search.dto';

/**
 * DocSearchDto 校验测试（v1.85.0 批次 3：`q` 新增 `@MaxLength(200)`）。
 *
 * 设计意图：`q` 会作为**重排出境体的第一段**（q + state + questions ≤ 16KB）——无上限的长 q
 * 能单独把出境预算吃光（把候选全挤掉），故必须在 DTO 层（铁律 #21 层 1）用 400 拦住，
 * 禁止透传到 service/上游。⚠️ **只设上限、不设下限**：空 q 是既有合法形态（语义由 service
 * 的空查询短路承担），加 `@MinLength` 会静默改变既有契约。
 */
describe('DocSearchDto', () => {
  const validateQ = async (q: unknown) => {
    const dto = plainToInstance(DocSearchDto, { q });
    return validate(dto);
  };

  it('接受 q=200（上限边界，含 CJK 混排）', async () => {
    const q = `${'查'.repeat(99)}abc`; // 100 字符；再补到 200
    const errors = await validateQ(q + 'x'.repeat(200 - q.length));
    expect(errors).toHaveLength(0);
  });

  it('拒绝 q=201（超上限 ⇒ DTO 层 400）', async () => {
    const errors = await validateQ('x'.repeat(201));
    expect(errors.some((e) => e.property === 'q' && e.constraints?.maxLength)).toBe(true);
  });

  it('接受空串（**刻意不设 MinLength**：空 q 是既有合法形态）', async () => {
    const errors = await validateQ('');
    expect(errors).toHaveLength(0);
  });

  it('拒绝非字符串（既有 @IsString 保持有效）', async () => {
    const errors = await validateQ(123);
    expect(errors.some((e) => e.property === 'q' && e.constraints?.isString)).toBe(true);
  });

  it('q + limit/offset 组合照旧校验（limit 上限 20 / offset 上限 100000）', async () => {
    const dto = plainToInstance(DocSearchDto, { q: 'x', limit: 21, offset: 100001 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit' && e.constraints?.max)).toBe(true);
    expect(errors.some((e) => e.property === 'offset' && e.constraints?.max)).toBe(true);
  });
});
