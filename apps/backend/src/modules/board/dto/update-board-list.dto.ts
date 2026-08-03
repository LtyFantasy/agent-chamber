import { IsString, IsOptional, IsNumber, IsInt, Min, IsEnum } from 'class-validator';
import { TaskStatus, UpdateBoardListInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBoardListDto implements UpdateBoardListInput {
  @IsOptional()
  @IsString()
  @ApiPropertyOptional({ description: 'Name', example: 'TestAgent' })
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Position order', example: 1 })
  position?: number;

  @IsOptional()
  @IsEnum(TaskStatus)
  @ApiPropertyOptional({
    // enum 显式给出，但联合类型 TaskStatus|null 的 reflect-metadata 是 Object，
    // 需显式 type + nullable 保证 Swagger/automcp 输出 string|null 而非 object
    type: String,
    nullable: true,
    enum: Object.values(TaskStatus),
    description:
      'Mapped status, one of: backlog, todo, in_progress, review, done, blocked, archived; pass null to remove the mapping',
    example: TaskStatus.IN_PROGRESS,
  })
  mappedStatus?: TaskStatus | null;
}
