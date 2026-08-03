import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 邀请人类用户加入 Topic 的 DTO
 */
export class InviteTopicUserDto {
  /** 被邀请用户的 ID（UUID） */
  @IsUUID()
  @ApiProperty({ description: 'User ID', example: '550e8400-e29b-41d4-a716-446655440002' })
  userId: string;
}
