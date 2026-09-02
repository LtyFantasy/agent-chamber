import { IsOptional, IsString, IsIn, IsInt, Min, Max, MaxLength, IsBoolean } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TopicStatus } from '@agent-chamber/shared';

/**
 * Topic 列表查询 DTO
 * 支持分页、状态过滤和关键词搜索
 */
export class QueryTopicDto {
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

  /**
   * 话题状态过滤：单个 TopicStatus 或特殊值 'all'（不过滤，返回全部状态）。
   * 注意 Service 层（topic.service.ts findAll）语义：缺省默认 'active'，'all' 不加状态条件；
   * DTO 校验必须与该语义对齐，不能用纯 @IsEnum 把 'all' 挡成 400（曾导致前端列表页回归）。
   */
  @IsOptional()
  @IsIn([...Object.values(TopicStatus), 'all'])
  @ApiPropertyOptional({
    enum: [...Object.values(TopicStatus), 'all'],
    description:
      'Filter by topic status, one of: open, active, paused, closed, archived, all (no filter). Defaults to active',
    example: TopicStatus.ACTIVE,
  })
  status?: TopicStatus | 'all';

  /** 搜索关键词，匹配话题标题和描述 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @ApiPropertyOptional({
    description: 'Search keyword; matches topic title and description',
    example: 'Search keyword',
  })
  q?: string;

  /**
   * 仅返回"我的"项（v1.70 插件绑定推断语义底座）：query 参数均为字符串，
   * 用 @Transform 严格解析（对齐 doc-overview/query-board-digest 布尔 query 惯例）：
   * 'true' → true、'false' → false、缺省 → undefined；其余值保留原样由 @IsBoolean 拒绝 400。
   * 语义：mine=true 时可见集收缩为 creator（含 owner-proxy 名下 agent 创建的）+
   * participant（status IN invited/active，对齐 unread SQL 口径），排除仅因 open 可见的项；
   * admin 求 mine 同样按 creator/participant 身份收缩。
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
      'Return only topics I created or participate in (invited/active), excluding open-visible-only ones. Default false.',
    example: 'true',
  })
  mine?: boolean;
}
