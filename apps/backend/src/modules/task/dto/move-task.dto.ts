import { IsUUID, IsOptional, IsNumber } from 'class-validator';
import { MoveTaskInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MoveTaskDto implements MoveTaskInput {
  @IsUUID()
  @ApiProperty({ description: 'List ID', example: '550e8400-e29b-41d4-a716-446655440004' })
  listId: string;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Sort position', example: 1 })
  order?: number;

  @IsOptional()
  @IsNumber()
  @ApiPropertyOptional({ description: 'Position order', example: 1 })
  position?: number;
}
