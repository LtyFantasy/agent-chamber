import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BoardDigestQueryDto } from './query-board-digest.dto';

/**
 * v1.42 BoardDigestQueryDto.versionLimit 边界（对齐 openLimit 等既有 limit 惯例）：
 * 0–50 合法（0 = versions.history 空数组），越界/非整数拒绝 400。
 * 缺省值（versionLimit 缺省 5）在 service 层应用，DTO 只做格式校验（铁律 #21）。
 */
describe('BoardDigestQueryDto versionLimit', () => {
  it('should accept versionLimit=0 (empty history)', async () => {
    const dto = plainToInstance(BoardDigestQueryDto, { versionLimit: 0 });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should accept versionLimit=50 (upper bound)', async () => {
    const dto = plainToInstance(BoardDigestQueryDto, { versionLimit: 50 });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject versionLimit=-1 (below min)', async () => {
    const dto = plainToInstance(BoardDigestQueryDto, { versionLimit: -1 });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'versionLimit' && e.constraints?.min)).toBe(true);
  });

  it('should reject versionLimit=51 (above max)', async () => {
    const dto = plainToInstance(BoardDigestQueryDto, { versionLimit: 51 });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'versionLimit' && e.constraints?.max)).toBe(true);
  });

  it('should reject non-integer versionLimit (string "abc")', async () => {
    const dto = plainToInstance(BoardDigestQueryDto, { versionLimit: 'abc' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'versionLimit' && e.constraints?.isInt)).toBe(true);
  });

  it('should accept numeric string versionLimit "3" via @Type transform', async () => {
    const dto = plainToInstance(BoardDigestQueryDto, { versionLimit: '3' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
