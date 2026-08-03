import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * 文档详情查询 DTO
 *
 * GET /docs/:id?maxFullTokens=
 *
 * maxFullTokens 覆盖「小文档全文内联」的 token 阈值（缺省 2000，见 DocService
 * FULL_CONTENT_TOKEN_THRESHOLD）。双层校验第二层（第一层为 controller 的
 * ParseIntPipe）：0 ≤ maxFullTokens ≤ 100000——无上限会让任意大文档全文内联，
 * 构成响应放大攻击面，故必须硬上限。
 */
export class DocDetailQueryDto {
  @ApiPropertyOptional({
    description:
      '小文档全文内联的 token 阈值覆盖（0 = 强制 outline；缺省 2000；上限 100000 防响应放大）',
    minimum: 0,
    maximum: 100000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  maxFullTokens?: number;
}
