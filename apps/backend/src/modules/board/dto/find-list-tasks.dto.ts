import {
  IsOptional,
  IsInt,
  Min,
  Max,
  ValidationOptions,
  ValidationArguments,
  registerDecorator,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus } from '@agent-chamber/shared';

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
 * 看板列任务列表查询 DTO
 * 用于 GET /boards/:id/lists/:listId/tasks
 */
export class FindListTasksQueryDto {
  @IsOptional()
  @IsTaskStatusOrAll()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    if (value === 'all') return 'all';
    return value.split(',').filter(Boolean);
  })
  @ApiPropertyOptional({
    enum: [...Object.values(TaskStatus), 'all'],
    description:
      "Filter by task status. Supports single value, comma-separated values, or 'all'. Defaults to backlog,in_progress",
    example: 'backlog,in_progress',
  })
  status?: string | string[] | 'all';

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
  @ApiPropertyOptional({ description: 'Items per page', example: 20 })
  pageSize?: number = 20;
}
