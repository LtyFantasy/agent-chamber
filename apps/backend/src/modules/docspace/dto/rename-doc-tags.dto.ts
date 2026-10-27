/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 存量 tag rename/merge 的 HTTP 输入形状（DocSpace 元数据治理 3 期，v1.92.0-dev）
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：数组/元素类型、非空、长度上限、幂等键尺度；
 *     业务存在性（空间存在、from 与 to ci 全等、词表变换合法性）归 DocRenameService。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（POST /doc-spaces/:id/tags/rename 契约）
 *   - 补充: 线上 docs/spec.md（RenameDocTagsInput 语义形状）
 *
 * [关键不变量]
 *   - `from` 元素上限 = DOC_SPACE_TAG_ALIASES_MAX（20）——与词表 alias 上限同源，
 *     一次收拢的 distinct 旧值量级不会超过它；
 *   - tag 单值上限 = DOC_SPACE_TAG_MAX_LENGTH（50，对齐 docs.tags 元素既有约束）；
 *   - 长度超限必须在 DTO 层 400，禁止透传 PG（铁律 #21）。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc-rename.service.ts — 业务校验与执行
 *   - apps/backend/src/modules/docspace/doc-vocabulary.helper.ts — normalizeTagRenameValues
 *     （from 归一单源：trim / ci 去重 / 剔除字节全等 to 的自映射）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DOC_SPACE_TAG_ALIASES_MAX, DOC_SPACE_TAG_MAX_LENGTH } from '@agent-chamber/shared';

/**
 * 存量 tag rename/merge DTO（POST /doc-spaces/:id/tags/rename）
 *
 * rename = `from` 单元素；merge = `from` 多元素或 `to` 已是既有值——存储层语义同一
 * （把 `from` 里每个值替换为 `to`），不拆两个端点。
 */
export class RenameDocTagsDto {
  @ApiProperty({
    description:
      'Old tag values to replace (1–20 items, each ≤50 chars). Multiple values = merge ' +
      '(one pass collects e.g. ["NPC","npc "] into "npc"). Values are trimmed and ' +
      'byte-exactly deduped (case variants like "NPC"/"NpC" are DISTINCT stored values and ' +
      'are all kept); a value byte-identical to `to` is dropped as a no-op. ' +
      'Note: ≤20 items here means one call adds at most 20 aliases — a single rename cannot ' +
      'exceed the 20-alias vocabulary cap on its own; only accumulation across repeated ' +
      'renames can, and the response then reports `truncatedAliases`.',
    type: [String],
    maxItems: DOC_SPACE_TAG_ALIASES_MAX,
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(DOC_SPACE_TAG_ALIASES_MAX)
  @IsString({ each: true })
  // docs.tags 元素既有约束 = 50（DOC_SPACE_TAG_MAX_LENGTH 单源）；超长 DTO 层 400（铁律 21）
  @MaxLength(DOC_SPACE_TAG_MAX_LENGTH, { each: true })
  from: string[];

  @ApiProperty({
    description:
      'Target tag value (trimmed, non-empty, ≤50 chars). Becomes the canonical value in the ' +
      'space vocabulary (created if the space had none — alias declaration is unconditional). ' +
      'A blank value ("   ") is rejected with 400 — writing an empty tag would corrupt docs.tags.',
    maxLength: DOC_SPACE_TAG_MAX_LENGTH,
  })
  @IsString()
  // 先 trim 再判非空（评审 B1）：@IsNotEmpty 单独用会放行 "   "（非空字符串），
  // 而 trim 后为空的 `to` 会让 array_replace 把旧 tag 写成空串（静默脏数据）
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @MaxLength(DOC_SPACE_TAG_MAX_LENGTH)
  to: string;

  @ApiPropertyOptional({
    description:
      'true = preview only (affected docs + vocabulary plan + batchToken), zero side effects ' +
      '(no write, no audit, no idempotency record). Always run dryRun first, then execute with ' +
      'the returned expectedBatchToken.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description:
      'batchToken returned by dryRun — the optimistic precondition for execute. Mismatch ' +
      '(concurrent write changed tags/updatedAt since the dryRun) → 409 DOC_BATCH_CONFLICT with ' +
      'the current affected docIds, zero side effects (abort-all). Omit = blind execute (documented ' +
      'as unverified execution).',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // sha256 hex 定长 64；超长 = 格式错误，DTO 层 400（铁律 21）
  @MaxLength(64)
  expectedBatchToken?: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Retry with the SAME key after a transport error ' +
      'returns the FIRST response snapshot with idempotentReplay:true (no second write). Same key ' +
      'with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT.',
    example: 'rename-tags-20261005-001',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  idempotencyKey?: string;
}
