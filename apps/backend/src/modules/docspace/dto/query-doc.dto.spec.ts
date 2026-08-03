import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { QueryDocDto } from './query-doc.dto';

/**
 * QueryDocDto 校验测试（P2 批次 A2：pageSize 分页硬上限 @Max(100)）
 *
 * 设计意图：对齐全仓分页硬上限惯例（docs/spec.md 分页约定）。
 * 超限必须 DTO 层 400，禁止透传 DB（超大 limit 可能拖垮查询）。
 */
describe('QueryDocDto', () => {
  it('accepts pageSize=100 (上限边界)', async () => {
    const dto = plainToInstance(QueryDocDto, { pageSize: '100' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.pageSize).toBe(100);
  });

  it('rejects pageSize=101 (超上限 → 400)', async () => {
    const dto = plainToInstance(QueryDocDto, { pageSize: '101' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pageSize' && e.constraints?.max)).toBe(true);
  });

  it('rejects pageSize=1e30 (超大值 → 400 而非 500)', async () => {
    const dto = plainToInstance(QueryDocDto, { pageSize: '1e30' });
    const errors = await validate(dto);
    // 1e30 经 @Type(() => Number) 转为 1e+30，@IsInt 或 @Max 之一拒绝
    expect(errors.some((e) => e.property === 'pageSize')).toBe(true);
  });

  it('rejects pageSize=0 (低于下限)', async () => {
    const dto = plainToInstance(QueryDocDto, { pageSize: '0' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pageSize' && e.constraints?.min)).toBe(true);
  });

  it('defaults pageSize to 20 when omitted', async () => {
    const dto = plainToInstance(QueryDocDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.pageSize).toBe(20);
  });
});
