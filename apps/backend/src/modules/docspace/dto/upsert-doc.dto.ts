import { IsString, IsOptional, IsArray, IsBoolean, MaxLength, ArrayMaxSize, Length } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Upsert 文档 DTO
 *
 * PUT /doc-spaces/:id/docs
 * 按 (spaceId, path) upsert：contentHash 相同时返回 unchanged。
 * category 按名解析，不存在则自动创建（slug 推导照 W2 分类逻辑）。
 */
export class UpsertDocDto {
  @ApiProperty({ description: 'Document path (space-unique identifier)', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  path: string;

  @ApiProperty({ description: 'Markdown content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({
    description: 'Document title (defaults to first heading or path basename)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    description: 'Summary (≤500 chars, defaults to first section first paragraph)',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @ApiPropertyOptional({ description: 'Document type (user-defined)', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  docType?: string;

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
      "Source identifier (default 'native'). Non-native docs reject writes from different sources.",
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @ApiPropertyOptional({
    description:
      'last-verified 源码提交 sha（ingest 适配器上报，如 git rev-parse HEAD 40 hex）。' +
      '语义 = "内容在此 sha 验证一致"；contentHash 相同但 sha 不同时仅刷新该列，' +
      '响应仍 unchanged。native 写入不需要此字段。',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // docs.source_sha 列为 varchar(64)，超长必须在 DTO 层 400，禁止透传 PG 22001 → 500（铁律 21）
  @MaxLength(64)
  sourceSha?: string;

  @ApiPropertyOptional({
    description:
      '可选乐观锁前提（fail-closed 改造）：调用方读取/上次写入时拿到的 contentHash ' +
      '（upsert 响应携 contentHash，链式写免重读）。文档不存在或当前 hash 不符 → ' +
      '409 DOC_CONTENT_CONFLICT（事务内 FOR UPDATE 复核）；hash 相符且内容未变 → ' +
      'unchanged 正常返回（不算冲突）。缺省 = 现状行为（无前提校验）。',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // sha256 hex 定长 64；超长 = 格式错误，DTO 层 400（铁律 21）
  @MaxLength(64)
  expectedContentHash?: string;

  @ApiPropertyOptional({
    description:
      '债 B：contentHash 相同也强制重建 sections（缺省 false）。用于修复 chunk 级元数据 ' +
      '损坏（heading_path/is_continuation 被直改出错）——重建后 headingText/headingPath/level ' +
      '全部按 chunker 重新计算。语义：走事务重建路径但**跳过** doc_versions 版本行插入+剪枝 ' +
      '（版本契约 = contentHash 变化才落版）；doc.updatedAt 会 bump（元数据确实重建了，预期语义）；' +
      '响应带 rechunked:true（unchanged 恒不出现）；DOC_UPDATED 事件携带 rechunked 上下文。' +
      '⚠️ batch 通道（PUT /docs/batch）显式剔除本参数，不生效。',
  })
  @IsOptional()
  @IsBoolean()
  forceRechunk?: boolean;

  @ApiPropertyOptional({
    description:
      'Idempotency key (optional, 1–64 chars). Repeated submissions with the same ' +
      'clientRequestId by the same actor return the FIRST response snapshot with an ' +
      'idempotentReplay flag — no event, no doc_versions row, no side effects on replay. ' +
      'Same key with a different payload → 409 IDEMPOTENCY_KEY_CONFLICT. Safe for retries.',
    example: 'upsert-docs-20260821-001',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  // 幂等键尺度照 create-task.dto 先例（1~64 字符，不强制 UUID）；超长在 DTO 层 400（铁律 21）
  @Length(1, 64)
  clientRequestId?: string;
}
