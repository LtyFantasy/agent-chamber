import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 提升 Agent 为 Topic editor（v1.46 TOPIC-PERM）
 * 镜像 Board add-editor 端点 DTO：仅 agentId（editor 只授 agent，人类成员不走此端点）
 */
export class AddTopicEditorDto {
  @IsUUID()
  @ApiProperty({ description: 'Agent ID', example: '550e8400-e29b-41d4-a716-446655440001' })
  agentId: string;
}
