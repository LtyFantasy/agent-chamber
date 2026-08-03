import { IsOptional, IsBoolean, IsNumber, IsEnum, IsArray, IsUUID } from 'class-validator';
import { Visibility, TopicConfigInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TopicConfigDto implements TopicConfigInput {
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Auto-archive', example: true })
  autoArchive?: boolean;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Archive after days', example: 1 })
  archiveAfterDays?: number;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Allow agents to join', example: true })
  allowAgentJoin?: boolean;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Enable moderation', example: true })
  moderationEnabled?: boolean;

  /** 话题可见性：open（公开，自由加入）/ private（私密，仅受邀可加入） */
  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility, one of: open (public), private',
    example: Visibility.OPEN,
  })
  visibility?: Visibility;

  /** 私密话题的白名单（visibility=private 时生效） */
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description: 'Invited agent IDs',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  invitedAgentIds?: string[];
}
