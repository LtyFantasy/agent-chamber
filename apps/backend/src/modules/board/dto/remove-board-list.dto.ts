import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 删除看板列 DTO
 * 可选指定将列中任务迁移到的目标列 ID
 */
export class RemoveBoardListDto {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'ID of the target list to migrate tasks to',
    example: '550e8400-e29b-41d4-a716-446655440004',
  })
  moveTasksTo?: string;
}
