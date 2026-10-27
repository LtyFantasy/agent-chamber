/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocCategory merge 的 HTTP 输入形状（DocSpace 元数据治理 3 期，v1.92.0-dev）
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：targetId 是 UUID、幂等键尺度；
 *     业务存在性（source/target 存在、同空间、target 未软删、target ≠ source）归
 *     DocRenameService（404 / 422）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（POST /doc-categories/:id/merge 契约）
 *   - 补充: 线上 docs/spec.md（MergeDocCategoryInput 语义形状）
 *
 * [关键不变量]
 *   - merge **不接 expectedBatchToken**（plan D2/§3 定形）：dryRun 仍返回 batchToken 供
 *     人工核对，但 execute 以 target 的锁行重读为并发仲裁（category merge 是「重指向 +
 *     软删」的幂等形态，无 tag 侧的批量快照语义）。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc-rename.service.ts — mergeCategory 实现
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { IsBoolean, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DocCategory merge DTO（POST /doc-categories/:id/merge）
 *
 * 把 source（路径参数 `:id`）下的文档重指向 target，改写软引用（doc_routes.category /
 * overviewFilter.excludeCategories），并软删 source。⚠️ category 无 alias 机制——
 * merge 后旧 slug 查询即空（tags 有 alias 兼容 / category 没有的不对称性）。
 */
export class MergeDocCategoryDto {
  @ApiProperty({
    description:
      'Target category ID (UUID, same space, not soft-deleted). Must differ from the source ' +
      'category in the path. Docs under the source are repointed to it.',
  })
  @IsUUID()
  targetId: string;

  @ApiPropertyOptional({
    description:
      'true = preview only (affected docs + soft-reference impact + batchToken), zero side ' +
      'effects (no write, no audit, no idempotency record).',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Retry with the SAME key after a transport error ' +
      'returns the FIRST response snapshot with idempotentReplay:true (no second write).',
    example: 'merge-category-20261005-001',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  idempotencyKey?: string;
}
