/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §7（GET /boards/:id/digest 端点契约）
 *   - 补充: .kimi/plan-info-online-batch-a.md §4 A2（digest 装配硬语义）
 *
 * [踩坑索引] -
 *
 * [铁律关联] #21(双层校验) #11(注释强制) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #6）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GET /boards/:id/digest 查询参数 DTO（v1.41 Board Digest）
 *
 * 语义约定（与 docs/api-definition.md §7 digest 端点契约同步）：
 * - 全部 optional；limit 类参数缺省值在 service 侧应用（DTO 只做格式校验，铁律 #21）
 * - limit 上限 50：防单次调用放大返回体积；0 为合法值 = 该段返回空数组（不查询）
 * - includeDescription 严格 transform 惯例（对齐 doc-overview.dto.ts B2 教训）：
 *   'true' → true、'false' → false、缺省 → undefined（service 视为 true）；
 *   其余值保留原样由 @IsBoolean 拒绝 400，不静默当 false
 */
export class BoardDigestQueryDto {
  /** nextUp 段条数上限（缺省 10；0 = 空数组） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  @ApiPropertyOptional({ description: 'Max nextUp items (default 10; 0 = empty)', minimum: 0, maximum: 50, example: 10 })
  openLimit?: number;

  /** recentDone 段条数上限（缺省 5；0 = 空数组） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  @ApiPropertyOptional({ description: 'Max recentDone items (default 5; 0 = empty)', minimum: 0, maximum: 50, example: 5 })
  doneLimit?: number;

  /** risks 段条数上限（缺省 10；0 = 空数组） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  @ApiPropertyOptional({ description: 'Max risks items (default 10; 0 = empty)', minimum: 0, maximum: 50, example: 10 })
  riskLimit?: number;

  /** docs.recentlyUpdated 条数上限（缺省 5；0 = 空数组，docs 段仍返回空间元数据） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  @ApiPropertyOptional({ description: 'Max docs.recentlyUpdated items (default 5; 0 = empty)', minimum: 0, maximum: 50, example: 5 })
  docsLimit?: number;

  /** versions.history 条数上限（v1.42；缺省 5；0 = 空数组；production/development/total 不受影响） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  @ApiPropertyOptional({ description: 'Max versions.history items (default 5; 0 = empty)', minimum: 0, maximum: 50, example: 5 })
  versionLimit?: number;

  /**
   * 是否内嵌项目图例（board.description 全文，v1.41）：query 参数均为字符串，
   * 故用 @Transform 严格解析（对齐 doc-overview.dto.ts includeDescription 惯例）：
   * 'true' → true、'false' → false、缺省 → undefined；其余值保留原样由 @IsBoolean 拒绝 400。
   * 语义：缺省视为 true（默认内嵌图例全文，始终全量不截断）；显式 false 时 description 为 null。
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
      'Include the board description (legend) in the response. Default true; ' +
      "pass 'false' to set description to null.",
    example: 'true',
  })
  includeDescription?: boolean;
}
