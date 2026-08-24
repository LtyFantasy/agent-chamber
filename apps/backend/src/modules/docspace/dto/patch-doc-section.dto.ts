/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, PATCH /docs/:id/sections/:position)
 *   - 补充: doc.service.ts patchSection（section 级写 = 整节替换 + 复用 upsert 重建管线）
 *
 * [踩坑索引]
 *   - Hument 事故（topic msg 6dbc4da3）：stale position fail-open → fail-closed
 *     （2026-08-16）：新增 expectedSectionHash 可选前提校验字段，不符 → 409
 *     DOC_CONTENT_CONFLICT（缺省 = 旧行为，工具描述劝退缺省用法）
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
import { IsOptional, IsString, Length } from 'class-validator';

/**
 * PATCH /docs/:id/sections/:position 请求体（v1.55 section 级写）
 *
 * 格式校验（铁律 #21，Controller/DTO 层）：content 必须是字符串；
 * 业务校验（Service 层）：position 是否落在该文档实际 section 数范围内
 * （越界 → 404 DOC_NOT_FOUND，与 getSection 锚点缺失语义一致）。
 *
 * content 语义 = 替换后的**整节渲染片段**（含标题行，与 read_doc section 模式 /
 * web full=true 通道的表示同形）；替换后服务端重跑 chunk/重建管线。
 * 传空串 = 删除该节。position 定位在 URL 路径（ParseIntPipe 管整数格式），
 * 不放 body，保持与读侧 GET /docs/:id/sections/:position 对称。
 */
export class PatchDocSectionDto {
  @ApiProperty({
    description:
      'New section content — the full rendered section fragment INCLUDING its heading line ' +
      '(same shape read_doc section mode / GET /docs/:id/content?full=true produce). ' +
      'The whole section (heading line included) is replaced, then the document is re-chunked. ' +
      'Empty string deletes the section.',
  })
  @IsString()
  content: string;

  @ApiPropertyOptional({
    description:
      'Optional write precondition (fail-closed): the sectionHash captured when the section ' +
      'was read (GET /docs/:id/sections responses carry sectionHash). Mismatch with the ' +
      "section's current hash → 409 DOC_CONTENT_CONFLICT (data.sectionCount included) — " +
      'protects against stale positions writing the wrong block after re-chunk drift. ' +
      'Omit to keep legacy fail-open behavior (not recommended).',
  })
  @IsOptional()
  @IsString()
  expectedSectionHash?: string;

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
