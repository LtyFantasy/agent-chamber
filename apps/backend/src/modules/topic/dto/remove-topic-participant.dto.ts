import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 移除话题参与者的 DTO
 * Actor ID 全局唯一，无需指定 participantType。
 */
export class RemoveTopicParticipantDto {
  @IsUUID()
  @ApiProperty({
    description: 'Participant actor ID',
    example: '550e8400-e29b-41d4-a716-446655440002',
  })
  participantId: string;
}
