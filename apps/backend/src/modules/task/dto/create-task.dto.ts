import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsISO8601,
  IsUUID,
  MinLength,
  MaxLength,
  Length,
} from 'class-validator';
import { Priority, TaskStatus, CreateTaskInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskDto implements CreateTaskInput {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Board ID', example: '550e8400-e29b-41d4-a716-446655440003' })
  boardId?: string;

  @IsUUID()
  @ApiProperty({ description: 'List ID', example: '550e8400-e29b-41d4-a716-446655440004' })
  listId: string;

  @IsString()
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
    example: TaskStatus.TODO,
  })
  status?: TaskStatus;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description:
      'Assignee actor ID (UUID). Defaults to the current actor when omitted during creation.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  assigneeId?: string;

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
  @ApiPropertyOptional({
    description: 'Milestone ID',
    example: '550e8400-e29b-41d4-a716-446655440006',
  })
  milestoneId?: string;

  @IsOptional()
  @ApiPropertyOptional({ description: 'Custom fields', example: { points: 3, sprint: 'S1' } })
  customFields?: Record<string, unknown>;

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
