/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, PATCH /docs/:id/metadata)
 *   - 补充: plan patriot-cyclone-deadman.md §2.1（v1.61.0 批次 2：metadata-only patch，
 *     游戏方 proposal 6 条契约——Partial 三态语义/hash 必填/不重切/native-only）
 *
 * [踩坑索引]
 *   - @IsOptional 三态陷阱（本 DTO 立）：class-validator 的 @IsOptional 对 undefined
 *     与 null **同样跳过校验**——metadata patch 的 Partial 契约要求三态无歧义
 *     （缺席=不动 / null=400 / 值=更新），必须用 @ValidateIf((_o, v) => v !== undefined)
 *     替代 @IsOptional：undefined 跳过、null 进入校验被 @IsString/@IsArray 拒绝 400。
 *     改本 DTO 字段时禁止换回 @IsOptional（会把 null 静默当缺席，破坏契约）
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
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
import {
  IsString,
  IsArray,
  IsBoolean,
  ArrayMaxSize,
  MaxLength,
  ValidateIf,
  IsOptional,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DOC_TITLE_MAX_LENGTH, DOC_SUMMARY_MAX_LENGTH } from '@agent-chamber/shared';

/**
 * PATCH /docs/:id/metadata 请求体（v1.61.0 批次 2，metadata-only 写通道）
 *
 * **Partial 三态语义（契约核心，铁律 #21 格式层）**：
 * - 字段**缺席**（undefined）= 不动该字段；
 * - 字段为 **null** = 400 校验拒绝（@ValidateIf 让 null 进入校验被类型装饰器拦下——
 *   @IsOptional 会把 null 当缺席跳过，禁止换用）；
 * - 字段**显式给值** = 更新。`tags: []` = 清空标签（空数组是合法显式值）。
 *
 * 业务存在性（Service 层）：expectedContentHash 与 contentHash 比对（stale → 409）、
 * category 解析开关（只解析既有 / allowCreateCategory 自动创建）、native-only 隔离。
 */
export class PatchDocMetadataDto {
  @ApiProperty({
    description:
      'REQUIRED optimistic-lock precondition: the contentHash captured at read time ' +
      '(upsert/read responses carry contentHash). Mismatch → 409 DOC_CONTENT_CONFLICT ' +
      '(checked fast outside the transaction + rechecked under FOR UPDATE inside — ' +
      'TOCTOU-guarded). metadata-only patch never changes contentHash, so a matching ' +
      'hash stays valid across chained metadata writes; only a concurrent CONTENT edit ' +
      'invalidates it.',
    maxLength: 64,
  })
  @IsString()
  // sha256 hex 定长 64；超长 = 格式错误，DTO 层 400（铁律 21，与 upsert/move 同款）
  @MaxLength(64)
  expectedContentHash: string;

  @ApiPropertyOptional({
    description:
      'New title (≤200 chars). Absent = keep current; null = 400 (three-state partial semantics).',
    maxLength: DOC_TITLE_MAX_LENGTH,
  })
  // 三态区分：undefined 跳过校验（缺席=不动）；null 进入校验被 @IsString 拒绝 400。
  // ⚠️ 禁止换回 @IsOptional（null 会被当缺席静默跳过，破坏三态契约——见 AGENT-HOOK）
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  // docs.title 列为 varchar(200)，超长必须在 DTO 层 400，禁止透传 PG 22001 → 500（铁律 21）；
  // 列长单源 = shared DOC_TITLE_MAX_LENGTH（review-0831 任务 e013af33 收敛）
  @MaxLength(DOC_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({
    description:
      'New summary (≤500 chars). Absent = keep current; empty string = store empty; ' +
      'null = 400 (three-state partial semantics).',
    maxLength: DOC_SUMMARY_MAX_LENGTH,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  // docs.summary 列为 varchar(500)，同 upsert 契约；列长单源 = shared DOC_SUMMARY_MAX_LENGTH
  @MaxLength(DOC_SUMMARY_MAX_LENGTH)
  summary?: string;

  @ApiPropertyOptional({
    description:
      'New docType (≤64 chars, user-defined). Absent = keep current; null = 400 ' +
      '(three-state partial semantics).',
    maxLength: 64,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  // docs.doc_type 列为 varchar(64)，同 upsert 契约
  @MaxLength(64)
  docType?: string;

  @ApiPropertyOptional({
    description:
      'New tags list (max 20 items, each ≤50 chars). Absent = keep current; [] = CLEAR ' +
      'all tags; null = 400 (three-state partial semantics).',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  // 标签数量/长度上限：与 upsert 同款（防无界数组撑大 docs.tags 与 GIN 索引）
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description:
      'Category name (≤100 chars). Absent = keep current; null = 400. ' +
      'DEFAULT resolve-only: an unknown name → 404 DOC_CATEGORY_NOT_FOUND (prevents ' +
      'typo-born near-duplicate categories); pass allowCreateCategory=true to auto-create ' +
      'via the existing upsert resolution path.',
    maxLength: 100,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  // doc_category.name 列为 varchar(100)，超长必须在 DTO 层 400（铁律 21，同 upsert）
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({
    description:
      'true = category resolution may auto-create the category when the name is unknown ' +
      '(existing upsert resolveCategory behavior). Default false = resolve-only against ' +
      'existing space categories (unknown name → 404 DOC_CATEGORY_NOT_FOUND).',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  allowCreateCategory?: boolean;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Repeated submissions with the same ' +
      'clientRequestId by the same actor return the FIRST response snapshot with an ' +
      'idempotentReplay flag — no audit, no event, no side effects on replay. ' +
      'Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT. Safe for retries.',
    example: 'patch-meta-20260821-001',
    maxLength: 64,
  })
  // 幂等键不是元数据字段，不参与三态契约：@IsOptional 对 null 跳过校验 → null 视为
  // 缺席（无键旁路），与 create-task.dto 先例一致；超长在 DTO 层 400（铁律 21）
  @IsOptional()
  @IsString()
  @Length(1, 64)
  clientRequestId?: string;
}
