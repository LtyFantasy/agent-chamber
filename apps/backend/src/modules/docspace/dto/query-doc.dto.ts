import { IsOptional, IsString, IsInt, Min, Max, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * 查询文档列表 DTO
 *
 * GET /doc-spaces/:id/docs?category=&tag=&type=&q=&path=&pathPrefix=&page=&pageSize=
 *
 * path= 精确匹配，与模糊 q= 互斥，同传 → 400。
 * pathPrefix= 前缀匹配（v1.55），与 path= 互斥（同打 path 列，语义包含），同传 → 400；
 * 可与 q= 组合（前缀限定范围 + 关键词过滤）。
 */
export class QueryDocDto {
  @ApiPropertyOptional({ description: 'Filter by category slug' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by tag' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ description: 'Filter by document type' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Full-text search keyword (title + path ILIKE). Mutually exclusive with path=.',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Exact path match. Mutually exclusive with q=.',
  })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({
    description:
      'Path prefix match (e.g. "memory/"). Mutually exclusive with path=; combinable with q=. ' +
      'LIKE wildcards in the input are escaped (literal prefix semantics).',
  })
  @IsOptional()
  @IsString()
  // 路径最长 512，对齐 UpsertDocDto.path @MaxLength(512)
  @MaxLength(512)
  pathPrefix?: string;

  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page (max 100)',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // 分页硬上限 100，对齐全仓惯例（docs/spec.md 分页约定）；超限 → 400 而非透传 DB 触发 500
  @Max(100)
  pageSize?: number = 20;
}
