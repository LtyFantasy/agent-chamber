import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ApiUsageQueryDto } from './api-usage-query.dto';
import {
  API_USAGE_GROUP_BY_VALUES,
  API_USAGE_MAX_LIMIT,
  API_USAGE_SORT_BY_VALUES,
  API_USAGE_SURFACE_VALUES,
} from '../usage-stats-query.constants';

/**
 * `GET /system/api-usage` 查询 DTO 格式校验单测（铁律 #21 双层校验第一层）。
 *
 * 跨字段口径约束（metric × groupBy / metric × route / 跨度上限）**不在这里**——
 * 它们归 ApiUsageQueryService 统一裁决（见该文件 spec）。
 */
describe('ApiUsageQueryDto', () => {
  it('groupBy 三取值全部通过', async () => {
    for (const groupBy of API_USAGE_GROUP_BY_VALUES) {
      const dto = plainToInstance(ApiUsageQueryDto, { groupBy });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('groupBy 缺省 → 拒绝（必填，无默认维度）', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, {});
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'groupBy')).toBe(true);
  });

  it('groupBy 词表外取值 → 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'status' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'groupBy' && e.constraints?.isIn)).toBe(true);
  });

  it('sortBy 词表刻意排除 distinctActors（pass1 排不了二次查询的字段）', async () => {
    expect(API_USAGE_SORT_BY_VALUES).not.toContain('distinctActors');
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', sortBy: 'distinctActors' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'sortBy' && e.constraints?.isIn)).toBe(true);
  });

  it('sortBy 词表三取值全部通过', async () => {
    for (const sortBy of API_USAGE_SORT_BY_VALUES) {
      const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', sortBy });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('limit 边界：1 与 100 通过，0 与 101 拒绝', async () => {
    for (const limit of [1, API_USAGE_MAX_LIMIT]) {
      const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', limit: String(limit) });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.limit).toBe(limit);
    }
    for (const limit of ['0', String(API_USAGE_MAX_LIMIT + 1)]) {
      const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', limit });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    }
  });

  it('limit 非数字 → 拒绝（不落到 SQL）', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', limit: 'abc' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('from/to 非 ISO 8601 → 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', from: 'yesterday' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'from' && e.constraints?.isDateString)).toBe(true);
  });

  it('actorId 非 UUID → 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'actor', actorId: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'actorId' && e.constraints?.isUuid)).toBe(true);
  });

  it('route 长度上限 255：恰好 255 通过，256 拒绝（列宽对齐）', async () => {
    const ok = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', route: 'r'.repeat(255) });
    expect(await validate(ok)).toHaveLength(0);
    const tooLong = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', route: 'r'.repeat(256) });
    const errors = await validate(tooLong);
    expect(errors.some((e) => e.property === 'route' && e.constraints?.maxLength)).toBe(true);
  });

  it('tool 长度上限 128：129 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', tool: 't'.repeat(129) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tool' && e.constraints?.maxLength)).toBe(true);
  });

  it('method 长度上限 8：9 拒绝（列宽 varchar(8)）', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', method: 'M'.repeat(9) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'method' && e.constraints?.maxLength)).toBe(true);
  });

  it('channel 词表外取值 → 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'route', channel: 'grpc' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'channel')).toBe(true);
  });

  it('actorType 词表外取值 → 拒绝（含大小写敏感）', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'actor', actorType: 'Agent' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'actorType')).toBe(true);
  });

  it('surface 使用 D4c 封闭词表（含 \'\'）', async () => {
    for (const surface of API_USAGE_SURFACE_VALUES) {
      const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', surface });
      expect(await validate(dto)).toHaveLength(0);
    }
    const bad = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', surface: 'worker' });
    expect((await validate(bad)).some((e) => e.property === 'surface')).toBe(true);
  });

  it('metric 词表外取值 → 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', metric: 'all' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'metric')).toBe(true);
  });

  it('order 词表外取值 → 拒绝', async () => {
    const dto = plainToInstance(ApiUsageQueryDto, { groupBy: 'tool', order: 'descending' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'order')).toBe(true);
  });
});
