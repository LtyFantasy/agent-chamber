import { IsUUID, IsOptional, IsEnum } from 'class-validator';
import { TaskDependencyType, AddTaskDependencyInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddTaskDependencyDto implements AddTaskDependencyInput {
  @IsUUID()
  @ApiProperty({
    description: 'Dependent task ID',
    example: '550e8400-e29b-41d4-a716-446655440009',
  })
  dependsOnTaskId: string;

  @IsOptional()
  @IsEnum(TaskDependencyType)
  @ApiPropertyOptional({
    enum: Object.values(TaskDependencyType),
    description: 'Dependency type, one of: blocks, relates_to, duplicates',
    example: TaskDependencyType.BLOCKS,
  })
  type?: TaskDependencyType;
}
