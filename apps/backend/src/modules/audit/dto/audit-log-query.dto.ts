import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsString,
  IsUUID,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@agent-chamber/shared';

/**
 * GET /audit 与 GET /activity-logs 共用查询 DTO（活动日志系统 Phase 1）。
 *
 * 铁律 #21 双层校验：本层只做格式正确性（UUID/枚举/时间串/数字边界），
 * 业务存在性与越权收窄在 AuditService.findScoped（决策 4：收窄不 403）。
 * from/to 为 ISO 8601 字符串（含时区），闭区间语义 createdAt >= from 且 <= to。
 */
export class AuditLogQueryDto {
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
  @ApiPropertyOptional({ description: 'Items per page', example: 1 })
  pageSize?: number;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description:
      'Filter by actor ID; out-of-scope values are narrowed to the caller scope (not 403)',
    example: '00000000-0000-4000-8000-000000000005',
  })
  actorId?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Entity type (task/topic/message/doc/…, free varchar)',
    example: 'message',
  })
  entityType?: string;

  @IsOptional()
  @IsEnum(AuditAction)
  @ApiPropertyOptional({
    description: 'Action (AuditAction enum)',
    enum: AuditAction,
    example: AuditAction.CREATE,
  })
  action?: AuditAction;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({
    description: 'Start time (ISO 8601 with timezone, inclusive)',
    example: '2026-08-27T08:36:00+08:00',
  })
  from?: string;

  @IsOptional()
  @IsDateString()
  @ApiPropertyOptional({
    description: 'End time (ISO 8601 with timezone, inclusive)',
    example: '2026-08-27T23:59:59+08:00',
  })
  to?: string;
}
