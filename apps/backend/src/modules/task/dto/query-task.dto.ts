import {
  IsOptional,
  IsString,
  IsUUID,
  IsArray,
  IsInt,
  IsIn,
  Min,
  Max,
  ValidationOptions,
  ValidationArguments,
  registerDecorator,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { TaskStatus, QueryTaskInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 自定义校验：status 必须是合法 TaskStatus、TaskStatus 数组或特殊值 'all'
 */
function IsTaskStatusOrAll(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isTaskStatusOrAll',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === 'all') return true;
          const statuses = Array.isArray(value) ? value : [value];
          return statuses.every(
            (s) => typeof s === 'string' && Object.values(TaskStatus).includes(s as TaskStatus),
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid TaskStatus, an array of TaskStatus, or 'all'`;
        },
      },
    });
  };
}

/**
 * Task 列表查询 DTO
 * 支持多维度过滤、全文搜索、分页
 */
export class QueryTaskDto implements QueryTaskInput {
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Board ID', example: '550e8400-e29b-41d4-a716-446655440003' })
  boardId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'List ID', example: '550e8400-e29b-41d4-a716-446655440004' })
  listId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({ description: 'Topic ID', example: '550e8400-e29b-41d4-a716-446655440005' })
  topicId?: string;

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Milestone ID',
    example: '550e8400-e29b-41d4-a716-446655440006',
  })
  milestoneId?: string;

  @IsOptional()
  @IsTaskStatusOrAll()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    if (value === 'all') return 'all';
    const parts = value.split(',').filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  })
  @ApiPropertyOptional({
    enum: [...Object.values(TaskStatus), 'all'],
    description:
      'Filter by task status. Supports a single value, comma-separated values, or "all". Accepted values: backlog, todo, in_progress, review, done, blocked, archived, all. Omit to not filter (return all statuses). Note: differs from GET /boards/:id/lists/:listId/tasks which defaults to backlog+in_progress.',
    example: 'todo,in_progress',
  })
  status?: TaskStatus | TaskStatus[] | 'all';

  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Assignee ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  assigneeId?: string;

  // assignee_type 列即将删除，不再按负责人类型过滤

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') return value.split(',').filter(Boolean);
    return value;
  })
  @ApiPropertyOptional({ description: 'Label list', example: ['bug', 'urgent'] })
  labels?: string[];

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Search keyword', example: 'Search keyword' })
  q?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Page number', example: 1 })
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Items per page', example: 1 })
  pageSize?: number;

  /** 兼容参数：Agent 客户端常用 limit 而非 pageSize */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  @ApiPropertyOptional({ description: 'Items per page (compatibility alias)', example: 1 })
  limit?: number;

  @IsOptional()
  @Type(() => Boolean)
  @ApiPropertyOptional({ description: 'Show only unblocked tasks', example: true })
  unblocked?: boolean;

  /**
   * 排序方式（opt-in，默认 createdAt 不变）：
   * - createdAt：创建时间倒序（默认，web 看板分页依赖，前端不重排）
   * - statusPriority：状态优先级 in_progress > todo > blocked > backlog > 其余
   *   （review/done/archived 恒末位），次键 updatedAt DESC，第三键 id ASC 兜底稳定分页
   */
  @IsOptional()
  @IsIn(['createdAt', 'statusPriority'])
  @ApiPropertyOptional({
    enum: ['createdAt', 'statusPriority'],
    description:
      'Sort order. createdAt (default): newest first. statusPriority: in_progress > todo > blocked > backlog > others (review/done/archived always last), then updatedAt DESC, then id ASC for stable pagination.',
    example: 'statusPriority',
  })
  sort?: 'createdAt' | 'statusPriority';
}
