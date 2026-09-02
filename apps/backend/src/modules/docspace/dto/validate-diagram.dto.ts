/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：validate_diagram dry-run 入口 DTO
 *     （POST /doc-spaces/:id/diagrams/validate）——零写入零事件的修复凭据通道
 *
 * [代码职责]
 *   - 格式正确性校验（铁律 #21 层 1）；两模式互斥（ir vs path/docId）由 service
 *     层判 400（语义互斥不是字段格式错误，照 patch-doc.ts 工具侧快速失败范式）
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §4.1（validate 端点 + M-e docId 通道）
 *
 * [关键不变量]
 *   - 零副作用：本 DTO 到达的 service 方法禁止任何写操作（doc 行/版本/事件/幂等）
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
  IsIn,
  IsObject,
  IsUUID,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DIAGRAM_PATCH_OPS, type DiagramPatchOpKind } from '@agent-chamber/shared';

/** validate 预演用单条 patch（与 PatchDiagramDto 的 item 同构，独立声明避免 DTO 互引） */
export class ValidateDiagramPatchItemDto {
  @ApiPropertyOptional({
    description: "Patch operation: 'replace' | 'add' | 'remove'",
    enum: DIAGRAM_PATCH_OPS,
  })
  @IsIn([...DIAGRAM_PATCH_OPS])
  op: DiagramPatchOpKind;

  @ApiPropertyOptional({ description: 'RFC 6901 JSON pointer', maxLength: 2048 })
  @IsString()
  @MaxLength(2048)
  path: string;

  @ApiPropertyOptional({ description: 'Value for replace/add' })
  @IsOptional()
  value?: unknown;
}

/**
 * Validate diagram DTO（dry-run，两模式互斥）：
 * - (a) `{ir}`：裸 IR 校验；
 * - (b) `{path | docId, patches?}`：对存量 diagram doc 模拟 patch 后校验
 *   （docId 通道与 read/patch 对齐，plan §4.1 M-e）。
 */
export class ValidateDiagramDto {
  @ApiPropertyOptional({
    description: 'Mode (a): bare IR object to validate (mutually exclusive with path/docId)',
  })
  @IsOptional()
  @IsObject()
  ir?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Mode (b): doc path within the space (mutually exclusive with ir/docId)',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;

  @ApiPropertyOptional({
    description: 'Mode (b): document ID (mutually exclusive with ir/path)',
  })
  @IsOptional()
  @IsUUID()
  docId?: string;

  @ApiPropertyOptional({
    description:
      'Mode (b) only: simulate these JSON patches on the current IR before validating ' +
      '(omit to validate the stored IR as-is)',
    type: [ValidateDiagramPatchItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ValidateDiagramPatchItemDto)
  patches?: ValidateDiagramPatchItemDto[];
}
