import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsArray,
  MinLength,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Visibility, CreateDocSpaceInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDocSpaceDto implements CreateDocSpaceInput {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @ApiProperty({ description: 'Space name', example: 'Project Docs' })
  name: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @ApiPropertyOptional({
    description: 'URL-friendly slug. Auto-generated from name if omitted.',
    example: 'project-docs',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  @ApiPropertyOptional({
    description: 'Space description',
    example: 'Documentation for the project',
  })
  description?: string;

  /**
   * Binding: topicId and boardId are mutually exclusive.
   * Application layer validates (both provided → 400).
   */
  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => !o.boardId)
  @ApiPropertyOptional({
    description: 'Bind to a topic (mutually exclusive with boardId)',
    example: '550e8400-e29b-41d4-a716-446655440005',
  })
  topicId?: string;

  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => !o.topicId)
  @ApiPropertyOptional({
    description:
      'Bind to a board (mutually exclusive with topicId). Requires read access to the board.',
    example: '550e8400-e29b-41d4-a716-446655440006',
  })
  boardId?: string;

  @IsOptional()
  @IsEnum(Visibility)
  @ApiPropertyOptional({
    enum: Object.values(Visibility),
    description: 'Visibility: open (public) or private. Default open.',
    example: Visibility.OPEN,
  })
  visibility?: Visibility;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description: 'Initial agent member IDs to invite',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  invitedAgentIds?: string[];
}
