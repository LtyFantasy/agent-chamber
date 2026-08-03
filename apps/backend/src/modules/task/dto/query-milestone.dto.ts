import { IsOptional, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { QueryMilestoneInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Milestone 列表查询 DTO
 * 支持按话题过滤与分页
 */
export class QueryMilestoneDto implements QueryMilestoneInput {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Board ID', example: '550e8400-e29b-41d4-a716-446655440005' })
  boardId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Page number', example: 1 })
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Items per page', example: 20 })
  pageSize?: number;
}
