/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念] 任务 PATCH 的清空三态、版本前提与外部输入 schema。
 * [代码职责] 验证请求格式并显式发布可空 UUID；业务权限和锁仍由 service 负责。
 * [权威文档] DocSpace Agent Chamber: docs/api-definition.md §7.13；
 *   docs/spec.md — UpdateTaskInput 与任务 DTO。
 * [关键不变量] 省略保持，milestone null 解绑，空串仍非法；nullable union 必须声明 scalar type。
 * [关联代码] packages/shared/src/dto/task.dto.ts；update-task.dto.spec.ts；swagger-schema.spec.ts。
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
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
  /**
   * 乐观锁前提（可选）：任务详情响应里的 `updatedAt` 原样回传。
   *
   * ⚠️ 必须带 `@IsOptional() @IsISO8601()` 装饰器：全局 ValidationPipe 开了
   * `whitelist + forbidNonWhitelisted`（main.ts），无装饰器的字段会被判为未声明属性
   * 直接 400。`@IsISO8601()` 同时挡掉"随手塞个非时间字符串"的调用方（否则 service
   * 侧 `new Date(x).getTime()` 得 NaN，只能靠等值比对侥幸拦住，错误码也说不清原因）。
   */
  @IsOptional()
  @IsISO8601()
  @ApiPropertyOptional({
    // 与 dueDate 同为 string：ISO 8601 字符串，回传详情响应的 updatedAt 原样值即可
    description:
      'Optional optimistic-lock precondition: the `updatedAt` from GET /tasks/:id, ' +
      'passed back verbatim. Mismatch → 409 RESOURCE_CONFLICT with data.currentUpdatedAt ' +
      '(re-read the task and retry with the fresh value; retrying with the same token keeps failing). ' +
      'OMITTING THIS FIELD MEANS NO LOCK AT ALL — new code should always send it.',
    example: '2026-10-16T08:00:00.000Z',
  })
  expectedUpdatedAt?: string;

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
    // Explicit scalar metadata prevents string|null from being reflected as an object.
    type: String,
    nullable: true,
    description: 'Milestone UUID. Omit to keep it; pass null to unbind. Empty string is invalid.',
    example: '550e8400-e29b-41d4-a716-446655440006',
  })
  /** Nullable declaration documents the existing @IsOptional null behavior; validation is unchanged. */
  milestoneId?: string | null;

  @IsOptional()
  @ApiPropertyOptional({ description: 'Custom fields', example: { points: 3, sprint: 'S1' } })
  customFields?: CustomFields;
}
