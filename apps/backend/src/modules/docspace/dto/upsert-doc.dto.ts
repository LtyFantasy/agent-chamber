import { IsString, IsOptional, IsArray, MaxLength, ArrayMaxSize } from 'class-validator';
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
}
