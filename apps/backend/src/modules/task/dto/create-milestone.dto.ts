import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsISO8601,
  MinLength,
  MaxLength,
} from 'class-validator';
import { MilestoneStatus, CreateMilestoneInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMilestoneDto implements CreateMilestoneInput {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Description', example: 'A description' })
  description?: string;

  @IsUUID()
  @ApiProperty({
    description: 'Associated board ID (required)',
    example: '550e8400-e29b-41d4-a716-446655440005',
  })
  boardId: string;

  @IsOptional()
  @IsEnum(MilestoneStatus)
  @ApiPropertyOptional({
    enum: Object.values(MilestoneStatus),
    description: 'Milestone status, one of: planned, active, completed, cancelled',
    example: MilestoneStatus.ACTIVE,
  })
  status?: MilestoneStatus;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'Start date (ISO 8601)', example: '2024-01-01T00:00:00Z' })
  startDate?: string;

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'targetDate', example: '2024-12-31T00:00:00Z' })
  targetDate?: string;
}
