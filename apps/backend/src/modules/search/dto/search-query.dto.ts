import {
  IsString,
  IsOptional,
  IsEnum,
  IsInt,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SearchType {
  ALL = 'all',
  MESSAGES = 'messages',
  TASKS = 'tasks',
}

/**
 * 全文搜索查询参数 DTO
 */
export class SearchQueryDto {
  /** 搜索关键词 */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @ApiProperty({ description: 'Search keyword', example: 'Search keyword' })
  q: string;

  /** 搜索范围：all(全部) / messages(消息) / tasks(任务) */
  @IsOptional()
  @IsEnum(SearchType)
  @ApiPropertyOptional({
    enum: Object.values(SearchType),
    description: 'Search scope: all, messages, tasks',
    example: SearchType.ALL,
  })
  type?: SearchType = SearchType.ALL;

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
