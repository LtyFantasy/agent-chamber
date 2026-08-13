import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 撤销 Agent 的 Topic editor 角色（v1.46 TOPIC-PERM）
 * 镜像 Board remove-editor 端点 DTO：仅 agentId
 */
export class RemoveTopicEditorDto {
  @IsUUID()
  @ApiProperty({ description: 'Agent ID', example: '550e8400-e29b-41d4-a716-446655440001' })
  agentId: string;
}
