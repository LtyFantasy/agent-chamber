import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ExportBundleQueryDto } from './export-bundle-query.dto';

/**
 * ExportBundleQueryDto 校验测试（v1.89.0-dev 批次 A）
 *
 * 设计意图：pathPrefix 上限 512 必须与 UpsertDocDto.path / QueryDocDto.pathPrefix 同刻度，
 * 超限在格式层 400（禁透传 PG）；未知键的 400 由全局 ValidationPipe
 * `forbidNonWhitelisted` 承担（HTTP 层覆盖在 docspace.e2e-spec.ts）。
 */
describe('ExportBundleQueryDto', () => {
  it('缺省合法（无 query 参数 = 全量导出）', async () => {
    const dto = plainToInstance(ExportBundleQueryDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.pathPrefix).toBeUndefined();
  });

  it('接受合法前缀（含目录语义尾 / 与通配符字面量）', async () => {
    for (const value of ['memory/', 'docs/2026-09-30/', 'a%b_c\\d']) {
      const dto = plainToInstance(ExportBundleQueryDto, { pathPrefix: value });
      expect(await validate(dto)).toHaveLength(0);
      // 转义归 Service（本 DTO 不做改写：字面透传）
      expect(dto.pathPrefix).toBe(value);
    }
  });

  it('512 边界：恰好 512 通过，513 拒（@MaxLength）', async () => {
    const ok = plainToInstance(ExportBundleQueryDto, { pathPrefix: 'a'.repeat(512) });
    expect(await validate(ok)).toHaveLength(0);

    const tooLong = plainToInstance(ExportBundleQueryDto, { pathPrefix: 'a'.repeat(513) });
    const errors = await validate(tooLong);
    expect(errors.some((e) => e.property === 'pathPrefix' && e.constraints?.maxLength)).toBe(true);
  });

  it('非字符串拒绝（@IsString）', async () => {
    const dto = plainToInstance(ExportBundleQueryDto, { pathPrefix: 123 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'pathPrefix' && e.constraints?.isString)).toBe(true);
  });
});
