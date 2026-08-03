import { IsOptional, IsString, IsUUID, IsInt, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AgentStatus } from '@agent-chamber/shared';

/**
 * Agent 列表查询 DTO
 * 支持分页、状态过滤、关键词搜索和按所有者过滤
 */
export class QueryAgentDto {
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

  /** Agent 状态过滤，可选值：active, disabled, pending, all */
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    enum: [...Object.values(AgentStatus), 'all'],
    description: 'Filter by agent status, one of: active, disabled, pending, all',
    example: AgentStatus.ACTIVE,
  })
  status?: string;

  /** 搜索关键词，匹配 Agent 名称或描述 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({
    description: 'Search keyword; matches agent name or description',
    example: 'Search keyword',
  })
  q?: string;

  /** Filter by owner ID */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Filter by owner ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  ownerId?: string;
}
