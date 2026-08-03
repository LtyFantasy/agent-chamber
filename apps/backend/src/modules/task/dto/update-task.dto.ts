import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsISO8601,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { TaskStatus, Priority, UpdateTaskInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CustomFields = Record<string, any>;

export class UpdateTaskDto implements UpdateTaskInput {
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
  @IsEnum(Priority)
  @ApiPropertyOptional({
    enum: Object.values(Priority),
    description: 'Priority, one of: p0 (critical), p1, p2, p3',
    example: Priority.P1,
  })
  priority?: Priority;

  @IsOptional()
  @IsEnum(TaskStatus)
  @ApiPropertyOptional({
    enum: Object.values(TaskStatus),
    description: 'Task status, one of: backlog, todo, in_progress, review, done, blocked, archived',
    example: TaskStatus.IN_PROGRESS,
  })
  status?: TaskStatus;

  @IsOptional()
  @IsUUID()
  @Transform(({ value }) => (value === '' ? null : value))
  @ApiPropertyOptional({
    // 联合类型 string|null 会让 reflect-metadata 推导为 Object，导致 Swagger/automcp
    // 把本字段输出成 type:object（外部 Agent 无法正确传参），必须显式声明 type + nullable
    type: String,
    nullable: true,
    description: 'Assignee actor ID (UUID). Pass null or empty string to unassign.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  assigneeId?: string | null;

  // assignee_type 列即将删除，不再传入负责人类型

  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({ description: 'Due date (ISO 8601)', example: '2024-06-30T00:00:00Z' })
  dueDate?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ApiPropertyOptional({ description: 'Label list', example: ['bug', 'urgent'] })
  labels?: string[];

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'List ID', example: '550e8400-e29b-41d4-a716-446655440004' })
  listId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Milestone ID',
    example: '550e8400-e29b-41d4-a716-446655440006',
  })
  milestoneId?: string;

  @IsOptional()
  @ApiPropertyOptional({ description: 'Custom fields', example: { points: 3, sprint: 'S1' } })
  customFields?: CustomFields;
}
