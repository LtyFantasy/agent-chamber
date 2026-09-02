import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GET /agents/me/activities 查询参数（接口瘦身二期：裸数组 → 标准分页信封）。
 *
 * 词汇收敛到 page/pageSize（spec §7.4/§7.4a）；limit 是历史别名，仅在
 * pageSize 缺省时生效（pageSize 优先）。校验范式对齐 audit-log-query.dto.ts：
 * page Min(1) 无上限、pageSize/limit clamp [1,100]。
 */
export class MyActivitiesQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Page number', example: 1 })
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Items per page (max 100)', example: 20 })
  pageSize?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @ApiPropertyOptional({
    description: 'Legacy alias for pageSize; only used when pageSize is absent',
    example: 20,
  })
  limit?: number;
}
