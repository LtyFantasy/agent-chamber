import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { QueryBoardDto } from './query-board.dto';

/**
 * 分页硬上限回归：pageSize 超过 100 必须被 DTO 校验拒绝（400），
 * 防止调用方（尤其是 Agent）一次性全量拉取撑爆上下文。
 */
describe('QueryBoardDto', () => {
  it('should reject pageSize exceeding 100', async () => {
    const dto = plainToInstance(QueryBoardDto, { pageSize: 999999 });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pageSize' && e.constraints?.max)).toBe(true);
  });

  it('should accept pageSize of exactly 100', async () => {
    const dto = plainToInstance(QueryBoardDto, { pageSize: 100 });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject non-UUID topicId', async () => {
    const dto = plainToInstance(QueryBoardDto, { topicId: 'not-a-uuid' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'topicId' && e.constraints?.isUuid)).toBe(true);
  });

  // v1.70 mine 布尔 query：'true'/'false' 严格解析，其余值 400（对齐项目布尔 query 惯例）
  it("should parse mine='true' to boolean true", async () => {
    const dto = plainToInstance(QueryBoardDto, { mine: 'true' });
    expect(dto.mine).toBe(true);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should parse mine='false' to boolean false", async () => {
    const dto = plainToInstance(QueryBoardDto, { mine: 'false' });
    expect(dto.mine).toBe(false);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("should reject non-boolean mine value (e.g. '1') — 不静默当 false", async () => {
    const dto = plainToInstance(QueryBoardDto, { mine: '1' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'mine' && e.constraints?.isBoolean)).toBe(true);
  });

  it('should default mine to undefined when absent', async () => {
    const dto = plainToInstance(QueryBoardDto, {});
    expect(dto.mine).toBeUndefined();
  });
});
