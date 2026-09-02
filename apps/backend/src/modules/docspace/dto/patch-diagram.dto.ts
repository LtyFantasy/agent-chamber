/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Diagram IR 图表能力 v1：patch_diagram 写入口 DTO（PATCH /docs/:id/diagram）——
 *     RFC 6901 pointer + RFC 6902 子集（replace/add/remove），原子应用，乐观锁必填
 *
 * [代码职责]
 *   - 格式正确性校验（铁律 #21 层 1）：op 枚举/patch path 形状/expectedContentHash 必填；
 *     指针存在性与类型语义由 diagram-patch.ts（service 层）负责
 *
 * [权威文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §0 D8（patch 语义拍板）§4.1
 *   - 补充: 线上 docs/api-definition.md diagram 小节（read_doc）
 *
 * [关键不变量]
 *   - expectedContentHash 必填——圆桌多 Agent 共改的裁判机制：409 → 重读 rebase 重试
 *   - 入口幂等指纹 = patch payload（patches+expectedContentHash），非派生全文
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
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DIAGRAM_PATCH_OPS, type DiagramPatchOpKind } from '@agent-chamber/shared';

/** 单条 JSON patch 操作（replace/add/remove；path 为 RFC 6901 指针） */
export class DiagramPatchItemDto {
  @ApiProperty({
    description: "Patch operation (RFC 6902 subset): 'replace' | 'add' | 'remove'",
    enum: DIAGRAM_PATCH_OPS,
  })
  @IsIn([...DIAGRAM_PATCH_OPS])
  op: DiagramPatchOpKind;

  @ApiProperty({
    description:
      'RFC 6901 JSON pointer (e.g. "/components/2/label"; ~0/~1 escapes; 0-based array ' +
      'index — index = position in the ir.components array returned by read_diagram). ' +
      'Root path ("" / "/") is rejected: replace the whole document via upsert_diagram.',
    maxLength: 2048,
  })
  @IsString()
  // 指针长度上限：IR 路径深度有限，无界串只会放大校验成本（铁律 21 格式层收口）
  @MaxLength(2048)
  path: string;

  @ApiPropertyOptional({
    description: 'Value for replace/add (required for those ops; ignored by remove)',
  })
  @IsOptional()
  value?: unknown;
}

/**
 * Patch diagram DTO（PATCH /docs/:id/diagram）
 *
 * 对当前 IR 深拷贝原子应用全部 op（一败全拒）→ 规范化 → 委托 upsertCore 走
 * diagram 分支（patch 后 IR 仍过完整校验渲染门，422 诊断指向 patch 后状态）。
 */
export class PatchDiagramDto {
  @ApiProperty({
    description: 'JSON patch list (applied atomically: all-or-nothing)',
    type: [DiagramPatchItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  // 单请求 patch 条数上限：100 远超真实编辑场景，防无界数组撑大校验/指纹计算
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DiagramPatchItemDto)
  patches: DiagramPatchItemDto[];

  @ApiProperty({
    description:
      'REQUIRED optimistic lock: contentHash from read_diagram/upsert response. ' +
      'Stale → 409 DOC_CONTENT_CONFLICT (re-read, rebase patches, retry).',
    maxLength: 64,
  })
  @IsString()
  // 必填（plan §0 D8 拍板）：缺省无前提的 patch 会把「以为在改旧版」变成盲写
  @Length(1, 64)
  expectedContentHash: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Fingerprint = patch payload ' +
      '(patches + expectedContentHash), NOT the derived full content — a retry after ' +
      'success replays the first response instead of false-conflicting on the moved base.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  clientRequestId?: string;
}
