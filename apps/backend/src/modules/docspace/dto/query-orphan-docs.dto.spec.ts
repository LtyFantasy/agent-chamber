import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { QueryOrphanDocsDto } from './query-orphan-docs.dto';

/**
 * QueryOrphanDocsDto 校验测试（DocSpace 元数据治理 3 期）
 *
 * 三条边界（铁律 #21 层 1）：
 * - 分页尺度（pageSize ≤100 硬上限，超限 400 而非透传 DB）；
 * - `includeExcluded` **严格解析**（'true'/'false' 才接受，'1'/'yes' 一律 400——
 *   对齐 doc-overview.dto.ts 的 applySpaceDefaults 惯例，宽松解析反直觉）；
 * - `pathPrefix` ≤512（对齐 docs.path 列长）。
 */
describe('QueryOrphanDocsDto', () => {
  it('缺省：page=1 / pageSize=20（DTO 默认值，不依赖 service 兜底）', async () => {
    const dto = plainToInstance(QueryOrphanDocsDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });

  it('query 字符串数字被转换并校验（"50" → 50）', async () => {
    const dto = plainToInstance(QueryOrphanDocsDto, { page: '2', pageSize: '50' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.pageSize).toBe(50);
  });

  it('rejects pageSize=101 / page=0（分页越界 → 400）', async () => {
    expect(
      (
        await validate(plainToInstance(QueryOrphanDocsDto, { pageSize: '101' }))
      ).some((e) => e.property === 'pageSize' && e.constraints?.max),
    ).toBe(true);
    expect(
      (await validate(plainToInstance(QueryOrphanDocsDto, { page: '0' }))).some(
        (e) => e.property === 'page' && e.constraints?.min,
      ),
    ).toBe(true);
  });

  it('includeExcluded 严格解析：true/false 通过，其余值 400（不静默当真/假）', async () => {
    const on = plainToInstance(QueryOrphanDocsDto, { includeExcluded: 'true' });
    expect(await validate(on)).toHaveLength(0);
    expect(on.includeExcluded).toBe(true);

    const off = plainToInstance(QueryOrphanDocsDto, { includeExcluded: 'false' });
    expect(await validate(off)).toHaveLength(0);
    expect(off.includeExcluded).toBe(false);

    for (const bad of ['1', 'yes', 'TRUE', '']) {
      const errors = await validate(plainToInstance(QueryOrphanDocsDto, { includeExcluded: bad }));
      expect(errors.some((e) => e.property === 'includeExcluded')).toBe(true);
    }
  });

  it('pathPrefix 长度上限 512（513 → 400）', async () => {
    expect(
      (await validate(plainToInstance(QueryOrphanDocsDto, { pathPrefix: 'a'.repeat(512) }))).length,
    ).toBe(0);
    expect(
      (
        await validate(plainToInstance(QueryOrphanDocsDto, { pathPrefix: 'a'.repeat(513) }))
      ).some((e) => e.property === 'pathPrefix'),
    ).toBe(true);
  });
});
