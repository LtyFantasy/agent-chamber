import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  ValidateNested,
  IsNotEmpty,
  MinLength,
  MaxLength,
  IsUUID,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Visibility, CreateTopicInput } from '@agent-chamber/shared';
import { AgendaItemDto } from './agenda-item.dto';
import { TopicConfigDto } from './topic-config.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTopicDto implements CreateTopicInput {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  @ApiProperty({ description: 'Title', example: 'Example title' })
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @ApiPropertyOptional({ description: 'Description', example: 'A description' })
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgendaItemDto)
  @ApiPropertyOptional({
    description: 'Agenda items',
    example: [{ title: 'Agenda Item 1', order: 1 }],
  })
  agenda?: AgendaItemDto[];

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description: 'Invited agent IDs',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  invitedAgentIds?: string[];

  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility, one of: open (public), private',
    example: Visibility.OPEN,
  })
  visibility?: Visibility;

  @IsOptional()
  @ValidateNested()
  @Type(() => TopicConfigDto)
  @ApiPropertyOptional({ description: 'Configuration', example: { visibility: 'open' } })
  config?: TopicConfigDto;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Repeated submissions with the same clientRequestId by the same actor return the first created entity with an idempotentReplay flag. Safe for retries.',
    example: 'pm-agent-20260726-001',
  })
  clientRequestId?: string;
}
