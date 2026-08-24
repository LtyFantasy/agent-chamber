/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §7. Tasks（POST /tasks/:id/report 端点契约）
 *   - 补充: docs/spec.md §3.2 TaskStatus
 *
 * [踩坑索引] -
 *
 * [铁律关联] #21(双层校验) #20(契约即设计)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { IsArray, IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { TaskStatus, ReportTaskResultInput } from '@agent-chamber/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * POST /tasks/:id/report 请求体。
 *
 * status 必填；comment/commitSha 任一非空即触发评论步骤（拼接规则与 MCP
 * report_task_result 一致）；docIds 逐条关联文档，单条失败内嵌 docLinks.failed。
 * clientRequestId 为幂等键（1~64 字符），同 actor 同 key 重试返回首次快照。
 */
export class ReportTaskResultDto implements ReportTaskResultInput {
  @IsEnum(TaskStatus)
  @ApiProperty({
    enum: Object.values(TaskStatus),
    description: 'Target status (required)',
    example: TaskStatus.DONE,
  })
  status: TaskStatus;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description:
      'Report content (optional). At least one of comment or commitSha must be provided for a comment to be posted.',
    example: '任务完成，附测试证据',
  })
  comment?: string;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional({
    description: 'Associated commit SHA, appended to the comment text (optional)',
    example: '7e1a2fe',
  })
  commitSha?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  @ApiPropertyOptional({
    description:
      'Optional: array of document IDs (UUIDs) to link to this task. ' +
      'Each doc is linked individually; single failures are embedded in docLinks.failed — ' +
      'the main report is not affected.',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  docIds?: string[];

  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Same actor + same key retry returns the first response snapshot with idempotentReplay; same key with a different payload is rejected with 409.',
    example: 'pm-agent-20260823-001',
  })
  clientRequestId?: string;
}
