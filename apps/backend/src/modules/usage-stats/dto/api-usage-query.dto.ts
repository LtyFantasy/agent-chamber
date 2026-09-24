/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：查询端点 `GET /system/api-usage` 的**参数契约**
 *
 * [代码职责]
 *   - 铁律 #21 双层校验的**第一层**：枚举值域 / UUID 形态 / 长度上限 / 数值边界
 *   - 长度上限一律对齐数据库列宽（route 255 / tool 128 / method 8）：
 *     超长值放过去会让 PG 报 22001，把 4xx 变成 500（铁律 #9 同理）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 端点参数表 + 统计口径专章
 *   - 补充: docs/database.md §api_usage_stats_hourly — 列宽与取值域
 *
 * [关键不变量]
 *   - **跨字段口径约束不在本层**：metric × groupBy、metric × route（仅工具口径内）、
 *     窗口跨度上限全部归 `ApiUsageQueryService` 统一裁决——"端点强制口径"只能有一处
 *     实现（§6 不变量：groupBy=tool 的默认口径不靠调用方自觉带参数）
 *   - `sortBy` 词表**刻意排除 `distinctActors`**（该字段来自 pass2 二次查询，
 *     pass1 排不了它）；枚举值一律引用 `usage-stats-query.constants.ts`，禁止就地重抄
 *
 * [关联代码]
 *   - api-usage-query.service.ts — 本 DTO 的消费方（业务口径解析）
 *   - api-usage.controller.ts — admin-only 入口
 *   - usage-stats-query.constants.ts — 词表/默认值/上限的单一定义点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（词表是否仍与常量同源）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  API_USAGE_ACTOR_TYPE_VALUES,
  API_USAGE_CHANNEL_VALUES,
  API_USAGE_DEFAULT_LIMIT,
  API_USAGE_DEFAULT_METRIC,
  API_USAGE_DEFAULT_ORDER,
  API_USAGE_DEFAULT_SORT_BY,
  API_USAGE_GROUP_BY_VALUES,
  API_USAGE_MAX_LIMIT,
  API_USAGE_MAX_SPAN_DAYS,
  API_USAGE_METRIC_VALUES,
  API_USAGE_MIN_LIMIT,
  API_USAGE_METHOD_MAX_LENGTH,
  API_USAGE_ORDER_VALUES,
  API_USAGE_ROUTE_MAX_LENGTH,
  API_USAGE_SORT_BY_VALUES,
  API_USAGE_SURFACE_VALUES,
  API_USAGE_TOOL_NAME_MAX_LENGTH,
  type ApiUsageGroupBy,
  type ApiUsageMetric,
  type ApiUsageOrder,
  type ApiUsageSortBy,
} from '../usage-stats-query.constants';

/**
 * `GET /system/api-usage` 查询 DTO（admin-only，D8 全参数）。
 *
 * 铁律 #21 双层校验的**第一层**：本层只管格式——枚举值域、UUID 形态、长度上限、
 * 数值边界。**跨字段口径约束不在这里**（metric 与 groupBy 的互斥、metric 与 route
 * 的互斥、窗口跨度 >90 天）——那些是业务口径，归 `ApiUsageQueryService` 统一裁决，
 * 保证"端点强制口径"（§6 不变量）只有一处实现。
 *
 * 长度上限一律对齐**数据库列宽**：route varchar(255) / tool_name varchar(128) /
 * method varchar(8)。超长值若放过去，PG 比较时会报 22001 把 4xx 变成 500
 * （铁律 #9 同理：参数错必须 400，不得 500）。
 */
export class ApiUsageQueryDto {
  /**
   * 聚合维度（必填）。三选一：
   * - `route` = REST 路由模板热度（默认排除 `mcp://%` 伪路由，见 service 口径隔离）；
   * - `tool` = MCP 工具口径（默认 invocation 计数）；
   * - `actor` = 单调用者用量（invocation 行与扇出 REST 行**求和**，单位混用见专章）。
   */
  @ApiProperty({
    description:
      'Aggregation dimension: route (REST route template) | tool (MCP tool) | actor (per caller; ' +
      'sums invocation rows and fan-out REST rows — mixed units, use for activity ranking only)',
    enum: API_USAGE_GROUP_BY_VALUES,
    example: 'tool',
  })
  @IsIn(API_USAGE_GROUP_BY_VALUES)
  groupBy: ApiUsageGroupBy;

  /**
   * 窗口起点（含）。缺省 = 最近 7 天。ISO 8601（带时区最稳），比较是**绝对时刻**比较
   * （bucket_start 是 timestamptz），无需调用方归一。
   */
  @ApiPropertyOptional({
    description:
      'Window start (inclusive), ISO 8601. Defaults to 7 days before `to`. Span is capped at ' +
      `${API_USAGE_MAX_SPAN_DAYS} days — split the query or use the SQL recipes for longer ranges.`,
    example: '2026-09-08T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  /**
   * 窗口终点（**开区间**：`bucket_start < to`）。
   * 为什么开区间：小时桶是"起点时刻"标识的整点窗口，含终点会带进当前未走完的
   * 半个桶（数字偏小且随调用时间抖动）。缺省 = 当前时刻。
   */
  @ApiPropertyOptional({
    description:
      'Window end (EXCLUSIVE: bucket_start < to), ISO 8601. Defaults to now. Half-open keeps the ' +
      'still-open current hour bucket out of the numbers.',
    example: '2026-09-15T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  /** 通道过滤：`rest`（拦截器采集）/ `mcp`（上报的 invocation 行） */
  @ApiPropertyOptional({
    description: 'Channel filter: rest (interceptor-collected) | mcp (reported invocation rows)',
    enum: API_USAGE_CHANNEL_VALUES,
  })
  @IsOptional()
  @IsIn(API_USAGE_CHANNEL_VALUES)
  channel?: string;

  /** 暴露面过滤（D4c 封闭词表；`''` = 非 MCP 流量，`unknown` = MCP 但暴露面不明） */
  @ApiPropertyOptional({
    description: "MCP surface filter (closed vocabulary; '' = non-MCP traffic)",
    enum: API_USAGE_SURFACE_VALUES,
  })
  @IsOptional()
  @IsIn(API_USAGE_SURFACE_VALUES)
  surface?: string;

  /**
   * 身份种类过滤。⚠️ `system` = MCP fallback-auth 归因标记（共享 --api-key），
   * 不是平台 system actor——用它可以把"身份不可信的调用"从 distinctActors 口径里摘掉。
   */
  @ApiPropertyOptional({
    description:
      "Actor type filter: agent | human | system | anonymous. 'system' marks MCP fallback-auth " +
      '(shared --api-key), NOT the platform system actor.',
    enum: API_USAGE_ACTOR_TYPE_VALUES,
  })
  @IsOptional()
  @IsIn(API_USAGE_ACTOR_TYPE_VALUES)
  actorType?: string;

  /** 单调用者过滤（UUID 形态；统计表无 FK，已删除的 actor 仍可查） */
  @ApiPropertyOptional({
    description: 'Single actor filter (UUID). The stats table has no FK — deleted actors stay queried.',
  })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  /**
   * 路由模板过滤（精确匹配）。显式传 route 会**覆盖** `groupBy=route` 默认的
   * `mcp://%` 排除（D8）；但在 **`groupBy=tool`** 下与缺省口径
   * `metric=invocations` 互斥（400，该口径本身已把 route 固定为
   * `mcp://tools/call`，再传 route 自相矛盾）——要看扇出 REST 行走 `metric=rest_calls`。
   */
  @ApiPropertyOptional({
    description:
      'Exact route template filter. Overrides the default mcp://% exclusion for groupBy=route; ' +
      'mutually exclusive with metric=invocations (400).',
    maxLength: API_USAGE_ROUTE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(API_USAGE_ROUTE_MAX_LENGTH)
  route?: string;

  /** MCP 工具名过滤（精确匹配；`''` 表示非 MCP 流量） */
  @ApiPropertyOptional({
    description: "Exact MCP tool name filter ('' = non-MCP traffic)",
    maxLength: API_USAGE_TOOL_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(API_USAGE_TOOL_NAME_MAX_LENGTH)
  tool?: string;

  /** HTTP method 过滤（大写，如 GET/POST/TOOL；`TOOL` = 上报行） */
  @ApiPropertyOptional({ description: 'HTTP method filter (uppercase; TOOL = reported rows)', maxLength: API_USAGE_METHOD_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(API_USAGE_METHOD_MAX_LENGTH)
  method?: string;

  /**
   * 工具口径（仅 `groupBy=tool` 可传，**与别的 groupBy 同传 = 400**——静默忽略会让
   * 调用方误读自己拿到的是哪个口径）：
   * - `invocations`（缺省）= 精确 invocation 计数（只取 `mcp://tools/call` 行）；
   * - `rest_calls` = 扇出 REST 行（`channel='rest'` 且 `tool_name<>''`）。
   */
  @ApiPropertyOptional({
    description:
      'Tool metric (groupBy=tool only; passing it with another groupBy is a 400): ' +
      `invocations (default) | rest_calls. Default: ${API_USAGE_DEFAULT_METRIC}.`,
    enum: API_USAGE_METRIC_VALUES,
  })
  @IsOptional()
  @IsIn(API_USAGE_METRIC_VALUES)
  metric?: ApiUsageMetric;

  /**
   * 排序键。**`distinctActors` 刻意不在词表里**：它来自 pass2 二次查询，
   * 不在 pass1 的聚合结果中，纳入排序会静默按错的键排。
   */
  @ApiPropertyOptional({
    description:
      'Sort key (distinctActors is deliberately NOT sortable — it comes from a second-pass query)',
    enum: API_USAGE_SORT_BY_VALUES,
    default: API_USAGE_DEFAULT_SORT_BY,
  })
  @IsOptional()
  @IsIn(API_USAGE_SORT_BY_VALUES)
  sortBy?: ApiUsageSortBy;

  /** 排序方向（缺省 desc） */
  @ApiPropertyOptional({
    description: 'Sort direction',
    enum: API_USAGE_ORDER_VALUES,
    default: API_USAGE_DEFAULT_ORDER,
  })
  @IsOptional()
  @IsIn(API_USAGE_ORDER_VALUES)
  order?: ApiUsageOrder;

  /** 返回的 top-N 键数（1–100，缺省 20） */
  @ApiPropertyOptional({
    description: 'Max returned keys (1–100)',
    minimum: API_USAGE_MIN_LIMIT,
    maximum: API_USAGE_MAX_LIMIT,
    default: API_USAGE_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(API_USAGE_MIN_LIMIT)
  @Max(API_USAGE_MAX_LIMIT)
  limit?: number;
}
