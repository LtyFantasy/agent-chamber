import { IsUUID, IsOptional, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { AssignTaskInput } from '@agent-chamber/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AssignTaskDto implements AssignTaskInput {
  @IsOptional()
  @IsUUID()
  @Transform(({ value }) => (value === '' ? null : value))
  @ApiPropertyOptional({
    // 联合类型 string|null 会让 reflect-metadata 推导为 Object，导致 Swagger/automcp
    // 把本字段输出成 type:object（外部 Agent 无法正确传参），必须显式声明 type + nullable
    type: String,
    nullable: true,
    description: 'Assignee ID; pass empty string / null / undefined to unassign',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  assigneeId?: string | null;

  // assignee_type 列即将删除，不再传入负责人类型；Service 会根据 Actor 表推导

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'Append mode', example: true })
  append?: boolean;
}
