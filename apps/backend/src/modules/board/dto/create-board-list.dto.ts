import { IsString, IsOptional, IsNumber, IsInt, Min, IsEnum } from 'class-validator';
import { TaskStatus, CreateBoardListInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBoardListDto implements CreateBoardListInput {
  @IsString()
  @ApiProperty({ description: 'Name', example: 'TestAgent' })
  name: string;

  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(0)
  @ApiPropertyOptional({ description: 'Position order', example: 1 })
  position?: number;

  @IsOptional()
  @IsEnum(TaskStatus)
  @ApiPropertyOptional({
    enum: Object.values(TaskStatus),
    description:
      'Mapped status, one of: backlog, todo, in_progress, review, done, blocked, archived',
    example: TaskStatus.IN_PROGRESS,
  })
  mappedStatus?: TaskStatus;
}
