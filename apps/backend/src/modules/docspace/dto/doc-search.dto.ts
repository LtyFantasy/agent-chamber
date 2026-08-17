import { IsOptional, IsString, Min, Max, IsInt, IsIn, IsISO8601 } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { DOC_SEARCH_SORT_VALUES, type DocSearchSort } from '@agent-chamber/shared';

/**
 * 文档搜索查询 DTO
 *
 * GET /doc-spaces/:id/search
 *
 * 双层校验（铁律 #21）层 1 格式正确性：本 DTO 全部 class-validator 约束；
 * 层 2 业务存在性（空间存在 + 读权限）在 controller（findById + ensureCan）。
 *
 * v1.55 新增 offset/sort/createdAfter/createdBefore（穷尽式调研翻页 +
 * 「读最近 N 天日记」时间序场景）；排序语义见 DocSearchService.search 注释。
 */
export class DocSearchDto {
  @IsString()
  @ApiProperty({
    description: 'Search query string',
    example: 'architecture design',
  })
  q: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Filter by document type',
    example: 'architecture',
  })
  type?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Filter by tag',
    example: 'overview',
  })
  tag?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Filter by category slug',
    example: 'architecture',
  })
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  @ApiPropertyOptional({
    description: 'Max number of hits to return (1-20, default 5)',
    default: 5,
    minimum: 1,
    maximum: 20,
  })
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  @ApiPropertyOptional({
    description:
      'Pagination offset — number of hits to skip (paired with limit for exhaustive pagination, default 0). ' +
      'Upper bound 100000 guards against unbounded OFFSET scan cost.',
    default: 0,
    minimum: 0,
    maximum: 100000,
  })
  offset?: number;

  @IsOptional()
  @IsIn([...DOC_SEARCH_SORT_VALUES])
  @ApiPropertyOptional({
    description:
      'Sort mode. "relevance" (default): dual-scoring + intent fusion boost ranking. ' +
      '"createdAt_desc"/"createdAt_asc": ORDER BY docs.created_at takes over — boost fusion ' +
      'is skipped entirely (score stays the raw composite, no boosts key). ' +
      'Use with createdAfter/createdBefore for time-window queries (e.g. recent diaries).',
    enum: DOC_SEARCH_SORT_VALUES,
    default: 'relevance',
  })
  sort?: DocSearchSort;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({
    description: 'Only include docs created at or after this ISO 8601 time (inclusive boundary)',
    example: '2026-08-01T00:00:00.000Z',
  })
  createdAfter?: string;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({
    description: 'Only include docs created at or before this ISO 8601 time (inclusive boundary)',
    example: '2026-08-15T23:59:59.999Z',
  })
  createdBefore?: string;
}
