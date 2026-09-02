import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  ValidateNested,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Visibility, TopicStatus, UpdateTopicInput } from '@agent-chamber/shared';
import { AgendaItemDto } from './agenda-item.dto';
import { TopicConfigDto } from './topic-config.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTopicDto implements UpdateTopicInput {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @ApiPropertyOptional({ description: 'Title', example: 'Example title' })
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @ApiPropertyOptional({ description: 'Description', example: 'A description' })
  description?: string;

  @IsOptional()
  @IsEnum(TopicStatus)
  @ApiPropertyOptional({
    enum: Object.values(TopicStatus),
    description: 'Topic status, one of: open, active, paused, closed, archived',
    example: TopicStatus.ACTIVE,
  })
  status?: TopicStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgendaItemDto)
  @ApiPropertyOptional({ description: 'Agenda items', example: ['Agenda Item 1', 'Agenda Item 2'] })
  agenda?: AgendaItemDto[];

  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility, one of: open (public), private',
    example: Visibility.OPEN,
  })
  visibility?: Visibility;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description: 'Invited agent IDs',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  invitedAgentIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => TopicConfigDto)
  @ApiPropertyOptional({ description: 'Configuration', example: { visibility: 'open' } })
  config?: TopicConfigDto;
}
