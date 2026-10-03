import { IsOptional, IsString, IsInt, IsISO8601, IsIn, Min, Max, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { DOC_LIST_SORT_VALUES, DocListSort } from '@agent-chamber/shared';

/**
 * 查询文档列表 DTO
 *
 * GET /doc-spaces/:id/docs?category=&tag=&type=&q=&path=&pathPrefix=&page=&pageSize
 *   &updatedAfter=&sort=
 *
 * path= 精确匹配，与模糊 q= 互斥，同传 → 400。
 * pathPrefix= 前缀匹配（v1.55），与 path= 互斥（同打 path 列，语义包含），同传 → 400；
 * 可与 q= 组合（前缀限定范围 + 关键词过滤）。
 *
 * updatedAfter= / sort=（v1.89.0-dev 批次 A）：供"最近变更镜像"类消费。
 * ⚠️ 能力边界三盲区（写进契约，消费方别误用）：
 * ① **只筛元数据**（`docs.updated_at`）——内容级增量不存在，全文仍需 read_doc 逐篇或
 *    整子树 export；
 * ② **删除不可见**——findAll 硬过滤 `deleted_at IS NULL`，软删不 bump updated_at，
 *    镜像维护须周期全量对账或消费 `doc_deleted` 事件；
 * ③ **两个时钟源写同一列**——save() 路径的 `@UpdateDateColumn` 是 JS 侧 `new Date()`
 *    （应用时钟），元数据 patch / move 走 QueryBuilder 显式 `NOW()`（DB 时钟=事务开始）；
 *    重叠窗口按秒级起步、**默认 ≥5 分钟或按最长写事务时长取值**，水位 =
 *    `max(updatedAt) − 重叠窗口` 回看 + contentHash 去重。另注：元数据 patch/move 也会
 *    bump（噪音已知）；`docs.updated_at` 无索引（当前量级可接受）。
 */
export class QueryDocDto {
  @ApiPropertyOptional({ description: 'Filter by category slug' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by tag' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ description: 'Filter by document type' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({
    description: 'Full-text search keyword (title + path ILIKE). Mutually exclusive with path=.',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Exact path match. Mutually exclusive with q=.',
  })
  @IsOptional()
  @IsString()
  path?: string;

  @ApiPropertyOptional({
    description:
      'Path prefix match (e.g. "memory/"). Mutually exclusive with path=; combinable with q=. ' +
      'LIKE wildcards in the input are escaped (literal prefix semantics).',
  })
  @IsOptional()
  @IsString()
  // 路径最长 512，对齐 UpsertDocDto.path @MaxLength(512)
  @MaxLength(512)
  pathPrefix?: string;

  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
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
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // 分页硬上限 100，对齐全仓惯例（docs/spec.md 分页约定）；超限 → 400 而非透传 DB 触发 500
  @Max(100)
  pageSize?: number = 20;

  @ApiPropertyOptional({
    description:
      'Only docs whose updatedAt is at/after this ISO 8601 time (inclusive). Metadata-level ' +
      'only — there is no content-level increment, and deletions are invisible (soft delete ' +
      'does not bump updatedAt).',
    example: '2026-09-30T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  updatedAfter?: string;

  @ApiPropertyOptional({
    description:
      'Sort mode for the list. Omit for the default path ASC. updatedAt_desc/updatedAt_asc sort ' +
      'by docs.updated_at with path ASC as the tie-breaker (stable pagination).',
    enum: [...DOC_LIST_SORT_VALUES],
  })
  @IsOptional()
  @IsIn([...DOC_LIST_SORT_VALUES])
  sort?: DocListSort;
}
