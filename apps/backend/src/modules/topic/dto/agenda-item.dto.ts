import { IsString, IsOptional, IsEnum, IsNumber } from 'class-validator';
import { AgendaItemInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgendaItemDto implements AgendaItemInput {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id?: string;

  @IsString()
  @ApiProperty({ description: 'Title', example: 'Example title' })
  title: string;

  @IsEnum(['pending', 'in_progress', 'completed'] as const)
  @ApiProperty({
    enum: ['pending', 'in_progress', 'completed'],
    description: 'Status',
    example: 'pending',
  })
  status: 'pending' | 'in_progress' | 'completed';

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Assigned to',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  assignedTo?: string;

  @IsNumber()
  @ApiProperty({ description: 'Sort position', example: 1 })
  order: number;
}
