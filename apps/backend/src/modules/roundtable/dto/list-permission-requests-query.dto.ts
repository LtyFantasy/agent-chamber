/**
 * 审批请求列表查询 DTO（GET /roundtable/permission-requests?topicId=&status=）
 *
 * 双层校验（铁律 #21）：本 DTO 只做格式正确性（UUID/枚举/分页范围）；
 * topic 存在性 + read 权限（404）+ status 业务过滤在 Service 层。
 * status 取值冻结于实体（ROUNDTABLE_PERMISSION_REQUEST_STATUSES，M3 阶段 1）。
 */
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ROUNDTABLE_PERMISSION_REQUEST_STATUSES } from '../../../database/entities/roundtable-permission-request.entity';

export class ListPermissionRequestsQueryDto {
  @IsUUID()
  @ApiProperty({
    description: '圆桌 topic id（必填：审批请求按 topic 归属查询，参与者可见）',
    example: 'a0b17ace-6fde-4ee3-ba52-17c864f757ef',
  })
  topicId: string;

  @IsOptional()
  @IsIn([...ROUNDTABLE_PERMISSION_REQUEST_STATUSES])
  @ApiPropertyOptional({
    description: '按状态过滤（pending/approved/rejected/orphaned；缺省 = 全部）',
    enum: [...ROUNDTABLE_PERMISSION_REQUEST_STATUSES],
    example: 'pending',
  })
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: '页码（从 1 开始，默认 1）', example: 1 })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ description: '每页条数（1~100，默认 20）', example: 20 })
  pageSize?: number;
}
