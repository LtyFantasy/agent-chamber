import { IsOptional, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Board 列表查询 DTO
 * 支持分页和按话题 ID 过滤
 */
export class QueryBoardDto {
  /** 页码，>= 1，默认 1 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Page number, starting from 1', example: 1 })
  page?: number = 1;

  /** 每页条数，1~100，默认 20 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ description: 'Items per page, max 100', example: 20 })
  pageSize?: number = 20;

  /** 按话题 ID 过滤 */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Filter by topic ID',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  topicId?: string;
}
