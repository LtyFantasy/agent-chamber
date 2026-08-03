/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16.8 (GET /doc-spaces/:id/overview)
 *   - 补充: plan bobbi-morse-x-23-cyclone.md WS2 (overview 可配置过滤)
 *
 * [踩坑索引] B2(applySpaceDefaults严格解析)
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   B2: applySpaceDefaults 曾用 `value === 'true'` 宽松解析，'1'/'yes'/'0' 静默当 false，
 *      反直觉且格式错误不透传精神不符。修复：@Transform 严格解析 'true'/'false'（大小写敏感，
 *      对齐 doc.controller.ts `full === 'true'` 先例），其余值保留原样由 @IsBoolean 拒绝 400。
 *      见 memory/2026-08-03.md §B2
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #6）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** CSV 组合过滤字段（type/excludeType/category/excludeCategory）整体长度上限。
 * docType 单值上限 64、slug 单值上限 128（对齐 upsert-doc.dto.ts / slugify slice(0,128)），
 * CSV 整体 512 ≈ 8 个 docType 或 4 个 slug；防无界 query 字符串（铁律 #21 格式校验不透传）。 */
const CSV_FILTER_MAX_LENGTH = 512;

/**
 * GET /doc-spaces/:id/overview 查询参数 DTO（v1.38 可配置过滤）
 *
 * 语义约定（与 docs/api-definition.md §16.8 同步）：
 * - 全部 optional；query 参数均为字符串，逗号分隔列表由 service 拆分解析
 * - include（type/category）与 exclude（excludeType/excludeCategory）同现 = 先 include 后 exclude（交集）
 * - 传 category 白名单时 uncategorized 段省略；excludeCategory 时保留
 * - per-call 显式传参逐字段覆盖空间级默认过滤（settings.overviewFilter）
 * - applySpaceDefaults=false 为逃生门：完全忽略空间级默认过滤（本次要全量）
 */
export class DocOverviewQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(CSV_FILTER_MAX_LENGTH)
  @ApiPropertyOptional({
    description:
      'Comma-separated docType whitelist (include). Combined with excludeType = include-then-exclude (intersection). ' +
      'e.g. type=guide,reference to see only curated docs.',
    example: 'guide,reference',
  })
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CSV_FILTER_MAX_LENGTH)
  @ApiPropertyOptional({
    description:
      'Comma-separated docType blacklist (exclude). e.g. excludeType=memory to filter out diary noise.',
    example: 'memory',
  })
  excludeType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CSV_FILTER_MAX_LENGTH)
  @ApiPropertyOptional({
    description:
      'Comma-separated category slug whitelist (include). When set, the uncategorized section is omitted.',
    example: 'architecture,reference',
  })
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CSV_FILTER_MAX_LENGTH)
  @ApiPropertyOptional({
    description: 'Comma-separated category slug blacklist (exclude).',
    example: 'archive',
  })
  excludeCategory?: string;

  @IsOptional()
  @IsString()
  // tag 为单值，上限 64 对齐 docType 单值上限（upsert-doc.dto.ts @MaxLength(64)）
  @MaxLength(64)
  @ApiPropertyOptional({
    description: 'Filter docs whose tags array contains this tag.',
    example: 'production',
  })
  tag?: string;

  @IsOptional()
  @IsString()
  // 路径最长 512，对齐 UpsertDocDto.path @MaxLength(512)
  @MaxLength(512)
  @ApiPropertyOptional({
    description: 'Filter docs by path prefix (e.g. "memory/" excludes everything outside).',
    example: 'docs/',
  })
  pathPrefix?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(16000)
  @ApiPropertyOptional({
    description: 'Override the ~4000 default token cap (range 500–16000).',
    minimum: 500,
    maximum: 16000,
    example: 6000,
  })
  maxTokens?: number;

  /**
   * 逃生门：query 参数均为字符串，class-validator 的 @IsBoolean 无法直接校验字符串，
   * 故用 @Transform 严格解析：'true' → true、'false' → false，缺省 → undefined。
   * 大小写敏感（对齐既有布尔 query 先例 doc.controller.ts `full === 'true'`）；
   * 其余值（'1'/'yes'/'0'/空串等）保留原样 → @IsBoolean 拒绝 400，
   * 不静默当作 false（评审 B2：反直觉解析透传 DB 无意义，铁律 #21 格式错误直接 400）。
   * 显式 false → service 完全忽略空间级 overviewFilter（本次要全量）。
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  @ApiPropertyOptional({
    description:
      'Apply space-level default filters (settings.overviewFilter). Default true; ' +
      "pass 'false' as escape hatch to ignore space defaults entirely.",
    example: 'true',
  })
  applySpaceDefaults?: boolean;
}
