import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { QueryTopicDto } from './query-topic.dto';

/**
 * 分页硬上限回归：pageSize 超过 100 必须被 DTO 校验拒绝（400），
 * 防止调用方（尤其是 Agent）一次性全量拉取撑爆上下文。
 */
describe('QueryTopicDto', () => {
  it('should reject pageSize exceeding 100', async () => {
    const dto = plainToInstance(QueryTopicDto, { pageSize: 999999 });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pageSize' && e.constraints?.max)).toBe(true);
  });

  it('should accept pageSize of exactly 100', async () => {
    const dto = plainToInstance(QueryTopicDto, { pageSize: 100 });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject pageSize below 1', async () => {
    const dto = plainToInstance(QueryTopicDto, { pageSize: 0 });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pageSize' && e.constraints?.min)).toBe(true);
  });

  it('should reject invalid status enum', async () => {
    const dto = plainToInstance(QueryTopicDto, { status: 'not-a-status' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'status' && e.constraints?.isIn)).toBe(true);
  });

  // 回归：前端话题列表页固定传 status=all 拉取全部状态（Service 缺省只返回 active），
  // DTO 校验不得把 'all' 挡成 400（B-56 生产回归）
  it("should accept status 'all'", async () => {
    const dto = plainToInstance(QueryTopicDto, { status: 'all' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should accept a valid TopicStatus', async () => {
    const dto = plainToInstance(QueryTopicDto, { status: 'active' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // v1.70 mine 布尔 query：'true'/'false' 严格解析，其余值 400（对齐项目布尔 query 惯例）
  it("should parse mine='true' to boolean true", async () => {
    const dto = plainToInstance(QueryTopicDto, { mine: 'true' });
    expect(dto.mine).toBe(true);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should parse mine='false' to boolean false", async () => {
    const dto = plainToInstance(QueryTopicDto, { mine: 'false' });
    expect(dto.mine).toBe(false);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should reject non-boolean mine value (e.g. '1') — 不静默当 false", async () => {
    const dto = plainToInstance(QueryTopicDto, { mine: '1' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'mine' && e.constraints?.isBoolean)).toBe(true);
  });

  it('should default mine to undefined when absent', async () => {
    const dto = plainToInstance(QueryTopicDto, {});
    expect(dto.mine).toBeUndefined();
  });
});
