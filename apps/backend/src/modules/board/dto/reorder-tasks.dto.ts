import { IsArray, ValidateNested, IsUUID, IsNumber, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TaskOrderItemInput, ReorderTasksInput } from '@agent-chamber/shared';
import { ApiProperty } from '@nestjs/swagger';

class TaskOrderItem implements TaskOrderItemInput {
  @IsUUID()
  @ApiProperty({ description: 'ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @IsNumber()
  @IsInt()
  @Min(0)
  @ApiProperty({ description: 'Position order', example: 1 })
  position: number;
}

export class ReorderTasksDto implements ReorderTasksInput {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskOrderItem)
  @ApiProperty({
    description: 'Task list',
    example: [{ id: '550e8400-e29b-41d4-a716-446655440000', position: 0 }],
  })
  tasks: TaskOrderItem[];
}
