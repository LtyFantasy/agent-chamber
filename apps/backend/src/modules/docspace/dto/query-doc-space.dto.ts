import { IsOptional, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DocSpace list query DTO
 * Supports pagination and optional boardId/topicId filtering (badge usage).
 */
export class QueryDocSpaceDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Page number, starting from 1', example: 1 })
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ description: 'Items per page, max 100', example: 20 })
  pageSize?: number = 20;

  /** Filter by bound board ID (badge usage) */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Filter by bound board ID',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  boardId?: string;

  /** Filter by bound topic ID (badge usage) */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Filter by bound topic ID',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  topicId?: string;
}
