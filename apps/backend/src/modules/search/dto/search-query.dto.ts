import { IsString, IsOptional, IsIn, IsInt, Min, Max, MinLength, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SEARCH_TYPE_VALUES, type SearchType } from '@agent-chamber/shared';

/**
 * 全文搜索查询参数 DTO
 *
 * SearchType 单一事实来源 = @agent-chamber/shared（search-response.dto.ts 的
 * union type + SEARCH_TYPE_VALUES 常量，统一批 744aae46 收口本地 enum 双源）。
 */
export class SearchQueryDto {
  /** 搜索关键词 */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @ApiProperty({ description: 'Search keyword', example: 'Search keyword' })
  q: string;

  /** 搜索范围：all(全部) / messages(消息) / tasks(任务) / docs(文档) */
  @IsOptional()
  @IsIn([...SEARCH_TYPE_VALUES])
  @ApiPropertyOptional({
    enum: [...SEARCH_TYPE_VALUES],
    description: 'Search scope: all, messages, tasks, docs',
    example: 'all',
  })
  type?: SearchType = 'all';

  /** 页码，>= 1 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Page number', example: 1 })
  page?: number = 1;

  /** 每页条数，1-100 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Items per page', example: 1 })
  pageSize?: number = 20;
}
