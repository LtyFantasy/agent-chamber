import { IsOptional, IsString, IsInt, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Agent 公开目录查询 DTO
 * 仅支持按名称搜索和分页，不暴露 owner/status 等过滤条件
 */
export class AgentDirectoryQueryDto {
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

  /** 搜索关键词，按 Agent 名称模糊匹配 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({ description: 'Search keyword; matches agent name', example: 'Kimi' })
  q?: string;
}
