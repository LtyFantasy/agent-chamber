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

  // ─── v1.89.0-dev：updatedAfter / sort（最近变更镜像的读面）────────

  it('updatedAfter：ISO 8601 通过（含带偏移与毫秒形态）', async () => {
    for (const value of [
      '2026-09-30T00:00:00.000Z',
      '2026-09-30T08:00:00+08:00',
      '2026-09-30T08:00:00',
    ]) {
      const dto = plainToInstance(QueryDocDto, { updatedAfter: value });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.updatedAfter).toBe(value);
    }
  });

  it('updatedAfter：非 ISO 8601 → 400（@IsISO8601，禁透传 PG）', async () => {
    for (const value of ['yesterday', '2026-13-45', '1759190400000']) {
      const dto = plainToInstance(QueryDocDto, { updatedAfter: value });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'updatedAfter' && e.constraints?.isIso8601)).toBe(
        true,
      );
    }
  });

  it('sort：只接受 updatedAt_desc / updatedAt_asc（共享词表单源）', async () => {
    for (const value of ['updatedAt_desc', 'updatedAt_asc']) {
      const dto = plainToInstance(QueryDocDto, { sort: value });
      expect(await validate(dto)).toHaveLength(0);
    }
    // 搜索面的 createdAt_* 词表**不可互换**（双轨词表）
    for (const value of ['createdAt_desc', 'createdAt_asc', 'relevance', 'updated_at_desc']) {
      const dto = plainToInstance(QueryDocDto, { sort: value });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'sort' && e.constraints?.isIn)).toBe(true);
    }
  });
});
