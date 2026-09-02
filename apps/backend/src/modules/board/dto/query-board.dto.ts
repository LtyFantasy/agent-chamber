import { IsOptional, IsUUID, IsInt, Min, Max, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Board 列表查询 DTO
 * 支持分页和按话题 ID 过滤
 */
export class QueryBoardDto {
  /** 页码，>= 1，默认 1 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @ApiPropertyOptional({ description: 'Page number, starting from 1', example: 1 })
  page?: number = 1;

  /** 每页条数，1~100，默认 20 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @ApiPropertyOptional({ description: 'Items per page, max 100', example: 20 })
  pageSize?: number = 20;

  /** 按话题 ID 过滤 */
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional({
    description: 'Filter by topic ID',
    example: '550e8400-e29b-41d4-a716-446655440003',
  })
  topicId?: string;

  /**
   * 仅返回"我的"项（v1.70 插件绑定推断语义底座）：query 参数均为字符串，
   * 用 @Transform 严格解析（对齐 doc-overview/query-board-digest 布尔 query 惯例）：
   * 'true' → true、'false' → false、缺省 → undefined；其余值保留原样由 @IsBoolean 拒绝 400。
   * 语义：mine=true 时可见集收缩为 creator（含 owner-proxy 名下 agent 创建的）+ member，
   * 排除仅因 open 可见的项；admin 求 mine 同样按 creator/member 身份收缩。
   * 缺省 false = 现有可见性口径不变（现有消费方零影响）。
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
      'Return only boards I created or am a member of, excluding open-visible-only ones. Default false.',
    example: 'true',
  })
  mine?: boolean;
}
