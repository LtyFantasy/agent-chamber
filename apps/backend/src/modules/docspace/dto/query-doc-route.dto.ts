/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, doc_routes 段)
 *   - 补充: plan §4-B5 (意图路由结构化)
 *
 * [踩坑索引] (无历史踩坑，新建文件)
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #6）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** q 长度上限：对齐 intent 字段上限（doc_routes.intent varchar(200)） */
const ROUTE_Q_MAX_LENGTH = 200;

/** category 长度上限：对齐 doc_routes.category varchar(100) */
const ROUTE_CATEGORY_MAX_LENGTH = 100;

/** 分页 pageSize 硬上限，对齐全仓惯例（docs/spec.md 分页约定）；超限 → 400 而非透传 DB */
const ROUTE_PAGE_SIZE_MAX = 100;

/**
 * GET /doc-spaces/:id/routes 查询参数 DTO（v1.55 列表增强）
 *
 * 格式校验（铁律 #21，Controller/DTO 层）：长度/整数边界；
 * 语义约定（与 docs/api-definition.md §16 同步）：
 * - 不传 page/pageSize → 传统全量模式：返回 DocRoute[] 数组（向后兼容），
 *   q/category 过滤仍然生效（仅收窄数组内容，不改响应形状）
 * - 传 page 或 pageSize 任一项 → 分页模式：返回标准 PaginatedResponse 信封
 *   （items/total/page/pageSize/totalPages/hasNext/hasPrev，与 docs 列表同款）
 * - q = intent 模糊匹配（ILIKE，大小写不敏感）
 * - category = 精确匹配（路由分组是策展枚举值，不做模糊）
 */
export class QueryDocRouteDto {
  @ApiPropertyOptional({
    description: 'Fuzzy match on intent (ILIKE, case-insensitive).',
    example: '架构',
    maxLength: ROUTE_Q_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ROUTE_Q_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by route category (exact match).',
    example: 'architecture',
    maxLength: ROUTE_CATEGORY_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ROUTE_CATEGORY_MAX_LENGTH)
  category?: string;

  @ApiPropertyOptional({
    description:
      'Page number (min 1). Passing page or pageSize switches the response to the ' +
      'standard paginated envelope; omitting both keeps the legacy full-array shape.',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page (max 100). Only effective in paginated mode.',
    minimum: 1,
    maximum: ROUTE_PAGE_SIZE_MAX,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ROUTE_PAGE_SIZE_MAX)
  pageSize?: number;
}
