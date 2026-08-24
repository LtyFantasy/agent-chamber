/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, POST /docs/:id/append)
 *   - 补充: doc.service.ts appendDoc（追加写原语——服务端内部消化并发冲突，
 *     v1.65.0 消费者反馈批 7601e2f5）
 *
 * [踩坑索引]
 *   - 幂等键尺度照 create-task.dto 先例（1~64 字符，不强制 UUID）；超长在 DTO 层 400（铁律 21）
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import type { AppendDocInput } from '@agent-chamber/shared';

/**
 * POST /docs/:id/append 请求体（追加写原语，v1.65.0 消费者反馈批 7601e2f5）
 *
 * 格式校验（铁律 #21，Controller/DTO 层）：
 * - content 必须非空且含非空白字符（全空白追加无意义，且会污染文档排版——400 拦截）；
 * - position 白名单枚举 'end' | 'under-heading'（缺省 'end'，服务端兜底）；
 * - headingPath 仅在 position='under-heading' 时必填（@ValidateIf 条件校验）；
 *   携带但 position='end' 时被忽略（服务端不读该字段，无静默写风险）。
 *
 * 业务校验（Service 层）：headingPath 精确匹配 0 命中 → 404 DOC_NOT_FOUND（附可用
 * headingPath 列表）；多命中（同名 sibling，v1.57.3 后可能）→ 409 RESOURCE_CONFLICT
 * （附候选 position 列表，绝不静默挑选）。
 */
export class AppendDocDto implements AppendDocInput {
  @ApiProperty({
    description:
      'Markdown content to append (non-empty, must contain non-whitespace characters). ' +
      'May include its own heading lines — the chunker will create new sections from them. ' +
      'Leading/trailing whitespace is trimmed by the server.',
  })
  @IsString()
  @IsNotEmpty()
  // 全空白（如 '   '）在格式层 400 拦截：追加空白无业务意义且污染排版（铁律 #21）
  @Matches(/\S/, { message: 'content must contain non-whitespace characters' })
  content: string;

  @ApiPropertyOptional({
    description:
      "Append position: 'end' (document end, default) | 'under-heading' " +
      '(end of the target heading subtree). Defaults to end.',
    enum: ['end', 'under-heading'],
  })
  @IsOptional()
  @IsIn(['end', 'under-heading'])
  position?: 'end' | 'under-heading';

  @ApiPropertyOptional({
    description:
      "Required when position='under-heading': the target section's heading_path " +
      '(exact match, as shown in read_doc outline sections[].headingPath). ' +
      '0 matches → 404 DOC_NOT_FOUND (available headingPaths included); ' +
      'multiple matches → 409 RESOURCE_CONFLICT (candidate positions included). ' +
      'Ignored when position is end.',
  })
  // 条件必填：仅 position='under-heading' 时要求（@ValidateIf 缺省 = 跳过校验）
  @ValidateIf((o: AppendDocDto) => o.position === 'under-heading')
  @IsString()
  @IsNotEmpty()
  headingPath?: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Repeated submissions with the same ' +
      'clientRequestId by the same actor return the FIRST response snapshot with an ' +
      'idempotentReplay flag — no event, no doc_versions row, no side effects on replay. ' +
      'Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT. Safe for retries.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // 幂等键尺度照 create-task.dto 先例（1~64 字符，不强制 UUID）；超长在 DTO 层 400（铁律 21）
  @Length(1, 64)
  clientRequestId?: string;
}
