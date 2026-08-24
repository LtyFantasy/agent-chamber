/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/api-definition.md §16 (DocSpace 模块, doc_routes 段) —— 任务 T6（空间级全量导出/回导）
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DOC_ROUTE_CODE_ENTRY_TYPES,
  DocRouteCodeEntryType,
  Visibility,
} from '@agent-chamber/shared';

/**
 * 空间导出 bundle 顶层格式版本（任务 T6）。
 *
 * formatVersion 是 bundle 形状的稳定契约：导出端点写入、回导端点校验。
 * 只支持当前版本（=1）；不匹配 → 400 VALIDATION_ERROR（Service 层业务校验，
 * DTO 层只保证它是整数——铁律 #21 双层校验的分工）。
 */
export const DOC_BUNDLE_FORMAT_VERSION = 1;

/** 回导 bundle 的排序权重上限（对齐 CreateDocRouteDto/CreateDocCategoryDto 惯例） */
const BUNDLE_SORT_ORDER_MAX = 10000;

/**
 * bundle.space（空间元数据段）
 *
 * 注意：回导时默认**不回写**目标空间（防覆盖目标空间策展），仅
 * `?overwriteSpaceMeta=true` 显式开启——该语义由 DocBundleService 落地，
 * DTO 只做格式校验。
 */
export class BundleSpaceMetaDto {
  @ApiProperty({ description: 'Space name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: 'Space legend (markdown description)' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Space visibility',
    enum: [Visibility.OPEN, Visibility.PRIVATE],
  })
  @IsOptional()
  @IsIn([Visibility.OPEN, Visibility.PRIVATE])
  visibility?: Visibility;

  @ApiPropertyOptional({ description: 'Raw space settings jsonb (visibility/overviewFilter/...)' })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

/**
 * bundle.categories 条目（任务 T6）
 *
 * 业务键 = name（空间内精确匹配，非软删；重复 name → 该条 per-item failed，
 * 见 DocBundleService）。slug/description/sortOrder 为策展字段。
 */
export class BundleCategoryItemDto {
  @ApiProperty({
    description: 'Category name (business key for idempotent re-import)',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: 'URL-friendly slug (auto-derived from name if omitted)',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  slug?: string;

  @ApiPropertyOptional({ description: 'Category description' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Sort order (lower = first)',
    minimum: 0,
    maximum: BUNDLE_SORT_ORDER_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(BUNDLE_SORT_ORDER_MAX)
  sortOrder?: number;
}

/**
 * bundle.routes 条目（任务 T6）
 *
 * 路由在 bundle 中用 **primaryDocPath / secondaryDocPath** 引用文档（而非 UUID）——
 * UUID 是库内身份不跨空间可移植；path 是业务键，回导时解析回目标空间的 docId。
 * 业务键 = (intent, primaryDocPath 解析出的 primaryDocId)：已存在 → 更新，不存在 → 创建。
 *
 * primaryDocPath 为 null 表示导出时该路由指向的文档已不存在（软删）——回导时
 * 该条无法解析 → per-item failed（不中止批次）。
 */
export class BundleRouteItemDto {
  @ApiProperty({ description: 'User intent ("我要…")', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  intent: string;

  @ApiPropertyOptional({ description: 'Route group (nullable)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string | null;

  @ApiPropertyOptional({
    description: 'Primary doc path (resolved to docId on import)',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  primaryDocPath?: string | null;

  @ApiPropertyOptional({
    description: 'Primary doc heading anchor (exact heading_path)',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  primaryHeadingPath?: string | null;

  @ApiPropertyOptional({ description: 'Secondary doc path (nullable)', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  secondaryDocPath?: string | null;

  @ApiPropertyOptional({ description: 'Secondary doc heading anchor (nullable)', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  secondaryHeadingPath?: string | null;

  @ApiPropertyOptional({
    description: 'Code entry (repo-relative path or glob pattern)',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  codeEntry?: string | null;

  @ApiPropertyOptional({
    description: 'codeEntry type: exact (default) | pattern (glob, recheck-exempt)',
    enum: [...DOC_ROUTE_CODE_ENTRY_TYPES],
    default: 'exact',
  })
  @IsOptional()
  @IsIn([...DOC_ROUTE_CODE_ENTRY_TYPES])
  codeEntryType?: DocRouteCodeEntryType;

  @ApiPropertyOptional({
    description: 'Sort order (ASC)',
    minimum: 0,
    maximum: BUNDLE_SORT_ORDER_MAX,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(BUNDLE_SORT_ORDER_MAX)
  sortOrder?: number;
}

/**
 * bundle.docs 条目（任务 T6）
 *
 * 字段与 UpsertDocDto 对齐（path/content/title/summary/docType/category/tags），
 * 回导时逐条复用 DocService.batchUpsert（per-doc 独立事务，单篇失败不中止批次）。
 * content 为完整可回导原文（reconstructContent full=true 语义，含首标题行）。
 */
export class BundleDocItemDto {
  @ApiProperty({ description: 'Document path (space-unique identifier)', maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  path: string;

  /**
   * 文档 ID（export 侧附加，v1.62.0）。**纯 informational，import 时忽略不参与写**——
   * 显式声明为 optional 是为让新版 bundle（带 docId/contentHash）可安全回导
   * （forbidNonWhitelisted 下未声明字段会被 400 拒），跨版本 roundtrip 兼容。
   */
  @ApiPropertyOptional({ description: 'Exported doc id (informational, ignored on import)' })
  @IsOptional()
  @IsString()
  docId?: string;

  /**
   * 原始写入 payload 的 SHA-256（export 侧附加，v1.62.0；nullable 列可达 null）。
   * **纯 informational，import 时忽略不参与写**——新增了该字段的新版 bundle 回导
   * 旧/新服务端皆不报错（formatVersion 保持 1；roundtrip 兼容）。
   */
  @ApiPropertyOptional({
    description: 'Original payload SHA-256 (informational, ignored on import; nullable)',
  })
  @IsOptional()
  @IsString()
  contentHash?: string | null;

  @ApiProperty({ description: 'Full markdown content (exported full, re-importable)' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Document title', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'Curated summary (≤500 chars)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;

  @ApiPropertyOptional({
    description: 'Document type (controlled vocabulary, see import_docs)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  docType?: string;

  @ApiPropertyOptional({ description: 'Category name (matched by name on import)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ description: 'Tags list (max 20 items, each ≤50 chars)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];
}

/**
 * POST /doc-spaces/:id/import-bundle 请求体 = 导出端点的完整输出（formatVersion 1）。
 *
 * 顶层即 bundle 本身（不套 envelope），导出文件可直接作为请求体回灌。
 * categories/routes/docs 可选（空数组合法）；space 必填。
 */
export class ImportDocBundleDto {
  @ApiProperty({ description: 'Bundle format version (must equal 1)', example: 1 })
  @IsInt()
  formatVersion: number;

  @ApiPropertyOptional({ description: 'Export timestamp (ISO 8601, informational)' })
  @IsOptional()
  @IsString()
  exportedAt?: string;

  @ApiProperty({ description: 'Space metadata (name/description/visibility/settings)' })
  @ValidateNested()
  @Type(() => BundleSpaceMetaDto)
  space: BundleSpaceMetaDto;

  @ApiPropertyOptional({
    description: 'Categories (business key: name)',
    type: [BundleCategoryItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BundleCategoryItemDto)
  categories?: BundleCategoryItemDto[];

  @ApiPropertyOptional({
    description: 'Intent routes (business key: intent + primaryDocPath)',
    type: [BundleRouteItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BundleRouteItemDto)
  routes?: BundleRouteItemDto[];

  @ApiPropertyOptional({
    description: 'Documents (upsert by path, per-doc independent transaction)',
    type: [BundleDocItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BundleDocItemDto)
  docs?: BundleDocItemDto[];
}
