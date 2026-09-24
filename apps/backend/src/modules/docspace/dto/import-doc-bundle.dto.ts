/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: docs/api-definition.md §16 (DocSpace 模块, doc_routes 段) —— 任务 T6（空间级全量导出/回导）
 *   - 补充: docs/api-definition.md §16 (bundle formatVersion 2, P2 批 5) —— media/mediaOmitted 段
 *
 * [踩坑索引]
 *   - BUNDLE-MEDIA-UNION: media[] 是**联合形状**（完整媒体项 | skipped 标记），
 *     而 class-validator 的装饰器只能表达"字段可选"——union 的必填性由 Service 层
 *     按 `skipped` 是否存在分支校验，非法项落 per-item failed（手改包不该整包 400）。
 *     改本文件时必须保持"DTO 只管格式、union 语义归 Service"的分工（铁律 #21）。
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ contentBase64 @MaxLength / media @ArrayMaxSize / mimeType @IsIn 三处上限
 *     必须取自 doc-bundle.constants.ts（与导出预算、导入复检同源）
 *   □ 新增导出字段必须在此显式声明（forbidNonWhitelisted：未声明字段会让 roundtrip 400）
 * =============================================================================
 */
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
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
  DOC_TITLE_MAX_LENGTH,
  DOC_SUMMARY_MAX_LENGTH,
} from '@agent-chamber/shared';
import {
  DOC_BUNDLE_MEDIA_BASE64_MAX_LENGTH,
  DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES,
  DOC_BUNDLE_MEDIA_MAX_ITEMS,
  DOC_BUNDLE_MEDIA_MIME_TYPES,
  DOC_BUNDLE_MEDIA_SKIP_REASONS,
} from '../doc-bundle.constants';

/**
 * 空间导出 bundle 顶层格式版本（任务 T6；P2 批 5 升 2）。
 *
 * formatVersion 是 bundle 形状的稳定契约：导出端点**恒写 2**，回导端点接受
 * `DOC_BUNDLE_ACCEPTED_FORMAT_VERSIONS`（{1,2}）。不匹配 → 400 VALIDATION_ERROR
 * （Service 层业务校验，DTO 层只保证它是整数——铁律 #21 双层校验的分工）。
 */
export const DOC_BUNDLE_FORMAT_VERSION = 2;

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
   * **纯 informational，import 时忽略不参与写**——新增了该字段后的 bundle 回导
   * 旧/新服务端皆不报错（formatVersion 1/2 都声明该字段；roundtrip 兼容）。
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

  @ApiPropertyOptional({ description: 'Document title', maxLength: DOC_TITLE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  // docs.title 列长单源 = shared DOC_TITLE_MAX_LENGTH（review-0831 任务 e013af33 收敛）
  @MaxLength(DOC_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({
    description: 'Curated summary (≤500 chars)',
    maxLength: DOC_SUMMARY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  // docs.summary 列长单源 = shared DOC_SUMMARY_MAX_LENGTH（review-0831 任务 e013af33 收敛）
  @MaxLength(DOC_SUMMARY_MAX_LENGTH)
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
 * bundle.media[] 的 thumbnail 载荷（formatVersion 2，plan §⑤.2）。
 *
 * 只有附件行有缩略图（thumb_key 非空）时才出现；导入侧按**字节证据**校验：
 * 解码字节必须嗅探为 webp，且与声明的 sizeBytes/sha256 自洽——任一不符该项
 * per-item failed（不落行）。
 */
export class BundleMediaThumbnailDto {
  @ApiProperty({ description: 'Thumbnail width in px', minimum: 1, maximum: 16384 })
  @IsInt()
  @Min(1)
  @Max(16384)
  width: number;

  @ApiProperty({ description: 'Thumbnail height in px', minimum: 1, maximum: 16384 })
  @IsInt()
  @Min(1)
  @Max(16384)
  height: number;

  @ApiProperty({ description: 'Decoded thumbnail byte length', minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES)
  sizeBytes: number;

  @ApiProperty({ description: 'SHA-256 of the decoded thumbnail bytes (lowercase hex)' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sha256: string;

  @ApiProperty({ description: 'Thumbnail bytes, standard padded base64' })
  @IsString()
  @IsBase64()
  @MaxLength(DOC_BUNDLE_MEDIA_BASE64_MAX_LENGTH)
  contentBase64: string;
}

/**
 * bundle.media[] 条目（formatVersion 2，plan §⑤.2）——**联合形状**：
 *
 * - 完整媒体项：sourceAttachmentId + docPath + originalName/mimeType/sizeBytes/sha256/
 *   contentBase64（+ 可选 thumbnail）；
 * - 导出侧因超出单项上限或联合预算未打包时落 `{ skipped, ...meta }` 标记，
 *   导入侧计入 skipped（不落行、不报错）。
 *
 * 必填性为什么不在 DTO 表达：union 语义 class-validator 表达不了；DTO 只做格式校验
 * （mimeType 值域 / sha256 形状 / base64 / 长度上限），"该有的字段没给"由 Service 层
 * 落 per-item failed（手改包不该让整包 400）。
 *
 * sourceAttachmentId 是**URL 重写配对键**：导出侧恒等于正文 URL 里的旧附件 id；
 * 自建 bundle 时也必须保持一致，否则正文里的旧 URL 找不到映射（无映射不重写）。
 */
export class BundleMediaItemDto {
  @ApiPropertyOptional({
    description:
      'Source attachment id (URL-rewrite pairing key; must match the id in the body URL)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceAttachmentId?: string;

  @ApiProperty({ description: 'Doc path this media item belongs to', maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  docPath: string;

  @ApiPropertyOptional({ description: 'Original file name (sanitized on import)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalName?: string;

  @ApiPropertyOptional({
    description: 'MIME type (must match the byte evidence of contentBase64)',
    enum: [...DOC_BUNDLE_MEDIA_MIME_TYPES],
  })
  @IsOptional()
  @IsIn([...DOC_BUNDLE_MEDIA_MIME_TYPES])
  mimeType?: string;

  @ApiPropertyOptional({ description: 'Decoded byte length', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES)
  sizeBytes?: number;

  @ApiPropertyOptional({ description: 'SHA-256 of the decoded bytes (lowercase hex)' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;

  @ApiPropertyOptional({ description: 'Original image bytes, standard padded base64' })
  @IsOptional()
  @IsString()
  @IsBase64()
  @MaxLength(DOC_BUNDLE_MEDIA_BASE64_MAX_LENGTH)
  contentBase64?: string;

  @ApiPropertyOptional({ description: 'Thumbnail payload (only when the row has one)' })
  @IsOptional()
  @ValidateNested()
  @Type(() => BundleMediaThumbnailDto)
  thumbnail?: BundleMediaThumbnailDto;

  @ApiPropertyOptional({
    description: 'Exporter-side skip marker (no payload); skipped items are not imported',
    enum: [...DOC_BUNDLE_MEDIA_SKIP_REASONS],
  })
  @IsOptional()
  @IsIn([...DOC_BUNDLE_MEDIA_SKIP_REASONS])
  skipped?: string;
}

/**
 * bundle.mediaOmitted[] 条目（formatVersion 2，plan §⑤.1 / PM Q4/m4）——
 * **informational 清单**：正文引用了该附件，但它绑定的是 topic（跨环境主题 id 不通用，
 * 且 topic 绑定附件不在空间读权限面内）→ 刻意不打包，让"回导后这段断链"可被发现。
 */
export class BundleMediaOmittedItemDto {
  @ApiProperty({ description: 'Doc path whose body references the attachment', maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  docPath: string;

  @ApiProperty({ description: 'Referenced attachment id' })
  @IsString()
  @MaxLength(64)
  attachmentId: string;

  @ApiProperty({ description: 'Why it was not packed', enum: ['topic_bound'] })
  @IsIn(['topic_bound'])
  reason: string;
}

/**
 * POST /doc-spaces/:id/import-bundle 请求体 = 导出端点的完整输出（formatVersion 1 或 2）。
 *
 * 顶层即 bundle 本身（不套 envelope），导出文件可直接作为请求体回灌。
 * categories/routes/docs/media/mediaOmitted 可选（空数组合法）；space 必填。
 * formatVersion=1 时 media 段整体跳过（结果信封 media 段为全零值形状）。
 */
export class ImportDocBundleDto {
  @ApiProperty({ description: 'Bundle format version (1 = no media, 2 = with media)', example: 2 })
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

  @ApiPropertyOptional({
    description:
      'Media payloads (formatVersion 2): attachment bytes referenced by doc content, ' +
      'packed under a joint request-body budget; skipped markers carry no payload',
    type: [BundleMediaItemDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DOC_BUNDLE_MEDIA_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BundleMediaItemDto)
  media?: BundleMediaItemDto[];

  @ApiPropertyOptional({
    description:
      'Informational list of body-referenced attachments that were deliberately not packed ' +
      '(reason: topic_bound) — the corresponding links stay broken after import',
    type: [BundleMediaOmittedItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BundleMediaOmittedItemDto)
  mediaOmitted?: BundleMediaOmittedItemDto[];
}
