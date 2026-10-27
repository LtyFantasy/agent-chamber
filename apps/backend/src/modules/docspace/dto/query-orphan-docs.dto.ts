/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - orphan 文档清单（诊断面）的 HTTP 查询形状（DocSpace 元数据治理 3 期，v1.92.0-dev）
 *
 * [代码职责]
 *   - 只做**格式正确性**（铁律 #21 层 1）：分页尺度、布尔严格解析、pathPrefix 长度；
 *     覆盖口径（primary ∪ secondary）与默认排除（settings.overviewFilter）归
 *     DocService.findOrphans。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（GET /doc-spaces/:id/docs/orphans 契约）
 *   - 补充: 线上 docs/spec.md（OrphanDocsQuery 语义形状）
 *
 * [关键不变量]
 *   - `includeExcluded` 用 @Transform **严格解析**（'true'/'false'，其余值 400）——
 *     对齐 doc-overview.dto.ts 的 applySpaceDefaults 惯例（评审 B2：宽松解析反直觉，
 *     铁律 #21 格式错误直接 400）；
 *   - pathPrefix 上限 512，对齐 QueryDocDto.pathPrefix 与 docs.path 列长。
 *
 * [关联代码]
 *   - apps/backend/src/modules/docspace/doc.service.ts — findOrphans 实现
 *   - apps/backend/src/modules/docspace/dto/query-doc.dto.ts — pathPrefix/pageSize 同款尺度
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * orphan 文档清单查询 DTO（GET /doc-spaces/:id/docs/orphans）
 *
 * 只读诊断面；默认应用空间 `settings.overviewFilter` 的 excludeTypes/excludeCategories
 * （与 overview 的「导航面」语义同源——日记/归档本就不该上 routes，默认不淹清单）。
 */
export class QueryOrphanDocsDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page (max 100)',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  // 分页硬上限 100，对齐全仓惯例（docs/spec.md 分页约定）；超限 → 400（铁律 #21）
  @Max(100)
  pageSize?: number = 20;

  /**
   * 是否关闭 overviewFilter 默认排除（query 参数均为字符串，故用 @Transform 严格解析，
   * 对齐 applySpaceDefaults 惯例）：'true' → true、'false' → false、缺省 → undefined；
   * 其余值保留原样由 @IsBoolean 拒绝 400。缺省 = 应用默认排除。
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
      'Set true to include orphans that the space overviewFilter excludes by default ' +
      '(excludeTypes / excludeCategories). Default false (navigation-surface semantics).',
    example: 'true',
  })
  includeExcluded?: boolean;

  @ApiPropertyOptional({
    description:
      'Path prefix filter (literal prefix semantics; LIKE wildcards escaped). Useful to slice ' +
      'a structural leaf cluster (e.g. "world/") out of a large orphan list.',
  })
  @IsOptional()
  @IsString()
  // 路径最长 512，对齐 QueryDocDto.pathPrefix 与 docs.path 列长
  @MaxLength(512)
  pathPrefix?: string;
}
