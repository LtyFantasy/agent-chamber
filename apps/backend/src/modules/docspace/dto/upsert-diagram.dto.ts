/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：upsert_diagram 写入口 DTO（PUT /doc-spaces/:id/diagrams）
 *
 * [代码职责]
 *   - 格式正确性校验（铁律 #21 层 1）：path/ir/title/summary/category/tags/hash/幂等键的
 *     形状与长度；IR 内容合法性（schema/几何/组合质量）由 service 渲染门负责（层 2）
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §4.1（REST 端点表）
 *   - 补充: 线上 docs/api-definition.md diagram 小节（read_doc）
 *
 * [关键不变量]
 *   - ir 必须是 JSON object（@IsObject）；内容校验不在本层
 *   - 幂等指纹 = 规范化 IR 内容（service 层 stringify(ir, null, 2) 后入 upsert 管线）
 *
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
  IsObject,
  MaxLength,
  ArrayMaxSize,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DOC_TITLE_MAX_LENGTH, DOC_SUMMARY_MAX_LENGTH } from '@agent-chamber/shared';

/**
 * Upsert diagram DTO（PUT /doc-spaces/:id/diagrams）
 *
 * 按 (spaceId, path) upsert 图文档：ir 规范化（JSON.stringify 2 空格）后委托
 * docService.upsert 走 diagram 分支（校验渲染门 fail-closed，不过不入库）。
 */
export class UpsertDiagramDto {
  @ApiProperty({ description: 'Document path (space-unique identifier)', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  path: string;

  @ApiProperty({
    description:
      'Diagram IR object (schema_version/diagram_type/meta/...). Server canonicalizes it ' +
      '(JSON.stringify with 2-space indent) before hashing/storage. Render gate is fail-closed: ' +
      'schema/geometry/composition errors always reject (422 DIAGRAM_VALIDATION_FAILED with ' +
      'diagnostics); warnings reject only under quality_profile=showcase. ' +
      'Repository evidence (meta.repository / components[].sources) is rejected upfront — ' +
      'the platform renderer never reads repository files.',
  })
  @IsObject()
  ir: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Document title (defaults to ir.meta.title, then path)',
    maxLength: DOC_TITLE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  // docs.title 列长单源 = shared DOC_TITLE_MAX_LENGTH（review-0831 任务 e013af33 收敛）
  @MaxLength(DOC_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({
    description: 'Summary (≤500 chars, defaults to "<diagramType> 图：<ir.meta.title>")',
    maxLength: DOC_SUMMARY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  // docs.summary 列长单源 = shared DOC_SUMMARY_MAX_LENGTH（review-0831 任务 e013af33 收敛）
  @MaxLength(DOC_SUMMARY_MAX_LENGTH)
  summary?: string;

  @ApiPropertyOptional({
    description: 'Category name (created if not found in space)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  // doc_category.name 列为 varchar(100)，超长必须在 DTO 层 400，禁止透传 PG 22001 → 500（铁律 21）
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'Tags list (max 20 items, each ≤50 chars)' })
  @IsOptional()
  @IsArray()
  // 标签数量/长度上限：防止无界数组撑大 docs.tags jsonb 与 GIN 索引
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description:
      'Optional optimistic lock: contentHash from a previous read/write response. ' +
      'Missing doc or hash mismatch → 409 DOC_CONTENT_CONFLICT (rechecked in-transaction).',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // sha256 hex 定长 64；超长 = 格式错误，DTO 层 400（铁律 21）
  @MaxLength(64)
  expectedContentHash?: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Repeated submissions with the same key by the ' +
      'same actor return the FIRST response snapshot with idempotentReplay:true — no side effects ' +
      'on replay. Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
    example: 'upsert-diagram-20260830-001',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // 幂等键尺度照 create-task.dto 先例（1~64 字符，不强制 UUID）；超长在 DTO 层 400（铁律 21）
  @Length(1, 64)
  clientRequestId?: string;
}
