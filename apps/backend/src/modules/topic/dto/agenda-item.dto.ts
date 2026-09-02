import { IsString, IsOptional, IsIn, IsNumber } from 'class-validator';
import {
  AGENDA_ITEM_STATUS_VALUES,
  AgendaItemInput,
  AgendaItemStatus,
} from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgendaItemDto implements AgendaItemInput {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id?: string;

  @IsString()
  @ApiProperty({ description: 'Title', example: 'Example title' })
  title: string;

  @IsIn(AGENDA_ITEM_STATUS_VALUES)
  @ApiProperty({
    enum: AGENDA_ITEM_STATUS_VALUES,
    description: 'Status',
    example: 'pending',
  })
  status: AgendaItemStatus;

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
