/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §7. Tasks（PATCH /tasks/:id/description 端点契约）
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
import { IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PatchTaskDescriptionInput } from '@agent-chamber/shared';

/**
 * PATCH /tasks/:id/description 请求体。
 *
 * match 模式精确串替换（契约对齐 DocSpace patchByMatch）：
 * - oldString 必填非空；0 命中 → 404、>1 命中 → 409 + data.matchCount；
 * - newString 可为空串 = 删除该片段（$ 模式按字面量处理，服务端函数式 replacer）；
 * - expectedDescriptionHash 可选乐观锁前提（sha256(description ?? '')，从
 *   GET /tasks/:id 响应的 descriptionHash 捕获）；不符 → 409 + currentDescriptionHash；
 * - clientRequestId 幂等键（1~64 字符），同 actor 同 key 重试返回首次快照。
 */
export class PatchTaskDescriptionDto implements PatchTaskDescriptionInput {
  @IsString()
  @MinLength(1)
  @ApiProperty({
    description:
      'Exact substring to replace in the task description (required, non-empty). ' +
      '0 matches → 404; >1 matches → 409 with matchCount — never silently picks one.',
    example: '旧段落',
  })
  oldString: string;

  @IsString()
  @ApiProperty({
    description:
      'Replacement text (required; empty string deletes the matched fragment). ' +
      '$ patterns ($&, $1, ...) are treated literally, not interpreted.',
    example: '新段落',
  })
  newString: string;

  @IsOptional()
  @IsString()
  // sha256 hex 定长 64；超长 = 格式错误，DTO 层 400（铁律 21，照 upsert-doc 先例）
  @MaxLength(64)
  @ApiPropertyOptional({
    description:
      'Optional optimistic-lock precondition: the descriptionHash captured from ' +
      'GET /tasks/:id (sha256 of the description). Mismatch → 409 with currentDescriptionHash.',
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  })
  expectedDescriptionHash?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Same actor + same key retry returns the ' +
      'first response snapshot with idempotentReplay; same key with a different payload ' +
      'is rejected with 409.',
    example: 'pm-agent-20260823-001',
  })
  clientRequestId?: string;
}
