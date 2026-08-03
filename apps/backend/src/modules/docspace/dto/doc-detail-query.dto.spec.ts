import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DocDetailQueryDto } from './doc-detail-query.dto';

/**
 * DocDetailQueryDto 校验测试（read_doc 小文档内联全文批次）
 *
 * maxFullTokens 双层校验第二层（第一层为 controller ParseIntPipe）：
 * 0 ≤ maxFullTokens ≤ 100000。无上限会让任意大文档全文内联 = 响应放大攻击面，
 * 故越界必须 DTO 层拒绝（全局 ValidationPipe 转 400），禁止透传到 service。
 */
describe('DocDetailQueryDto', () => {
  it('accepts maxFullTokens=0 (下限边界，强制 outline)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '0' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxFullTokens).toBe(0);
  });

  it('accepts maxFullTokens=100000 (上限边界)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '100000' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxFullTokens).toBe(100000);
  });

  it('accepts maxFullTokens=2000 (缺省阈值等值)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '2000' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxFullTokens).toBe(2000);
  });

  it('omitting maxFullTokens is valid (缺省用模块常量)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.maxFullTokens).toBeUndefined();
  });

  it('rejects maxFullTokens=-1 (低于下限 → 400)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '-1' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxFullTokens' && e.constraints?.min)).toBe(true);
  });

  it('rejects maxFullTokens=100001 (超上限 → 400)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '100001' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxFullTokens' && e.constraints?.max)).toBe(true);
  });

  it('rejects maxFullTokens=1e30 (超大值 → 400 而非 500)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '1e30' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxFullTokens')).toBe(true);
  });

  it('rejects maxFullTokens=abc (非数字 → 400)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: 'abc' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxFullTokens' && e.constraints?.isInt)).toBe(true);
  });

  it('rejects maxFullTokens=1.5 (非整数 → 400)', async () => {
    const dto = plainToInstance(DocDetailQueryDto, { maxFullTokens: '1.5' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxFullTokens' && e.constraints?.isInt)).toBe(true);
  });
});
