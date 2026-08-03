import { IsArray, ValidateNested, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { BatchCreateTasksInput } from '@agent-chamber/shared';
import { CreateTaskDto } from './create-task.dto';
import { ApiProperty } from '@nestjs/swagger';

/**
 * 批量创建任务 DTO
 * 一次最多创建 50 个任务（防止滥用）
 */
export class BatchCreateTasksDto implements BatchCreateTasksInput {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTaskDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ApiProperty({
    description: 'Task list, 1–50 CreateTaskDto objects',
    type: () => [CreateTaskDto],
  })
  tasks: CreateTaskDto[];
}
