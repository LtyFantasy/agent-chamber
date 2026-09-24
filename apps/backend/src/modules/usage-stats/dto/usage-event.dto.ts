/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：MCP invocation 上报端点 `POST /system/usage-events`
 *     的**请求体契约**
 *
 * [代码职责]
 *   - 铁律 #21 双层校验的**第一层**：类型 / 封闭词表 / 长度 / 数值边界
 *   - 长度上限对齐列宽（tool_name varchar(128)）；超长值放过去会被 PG 报 22001
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 上报契约 + 口径专章
 *     （"invocation 计数为自报数据，不作审计/安全用途"）
 *   - 补充: docs/database.md §api_usage_stats_hourly — tool_name / mcp_surface 取值域
 *
 * [关键不变量]
 *   - **刻意不接收 `actorType`**：行的 `actor_type` 只由 `viaFallbackAuth` 推导
 *     （'system' 的唯一生产者 = 上报侧 fallback-auth 归因标记）。外部若能直接指定，
 *     该标记会退化成调用方可自填的字段，distinctActors 的"身份不可信"语义失效
 *   - surface 的词表与批 1 同名常量同源（`USAGE_SURFACE_VALUES`），禁止就地重抄
 *   - 业务语义收敛（surface 归一、tool 名截断、成败 → status_class）在 buffer 侧，
 *     不在本层重复实现
 *
 * [关联代码]
 *   - usage-events.controller.ts — 消费方（认证 + fail-open + 身份提取）
 *   - usage-stats-buffer.service.ts — 行形状与 actor_type 推导的唯一实现点
 *   - usage-stats.constants.ts — 词表与截断长度单一定义点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（actor_type 是否仍只有唯一生产者）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, Min, IsInt } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  USAGE_SURFACE_VALUES,
  USAGE_TOOL_NAME_MAX_LENGTH,
} from '../usage-stats.constants';

/**
 * `POST /system/usage-events` 请求体 DTO（D4b：MCP invocation 上报通道）。
 *
 * 上报方 = automcp（批 3），在 `handleToolsCall` 层四出口全覆盖后 fire-and-forget 调用。
 * **认证即可**（Agent API Key 或 human JWT），但本端点刻意**不接收 actorType**：
 * 行的 `actor_type` 由 `viaFallbackAuth` 唯一推导（见 `UsageStatsBufferService
 * .recordInvocation`），外部若能直接指定就会出现第二个 'system' 生产者，
 * "身份不可信"这一去重标记随即失效。
 *
 * 铁律 #21 双层校验的**第一层**：格式（类型/枚举/范围/长度）在此拦下，
 * 业务语义（surface 词表收敛、tool_name 截断、成败 → status_class）在 buffer 侧。
 */
export class UsageEventDto {
  /**
   * MCP 工具名（≤128，与列宽一致）。上报方的 `'__invalid__'` 哨兵（tools/call 的
   * params 缺失或 name 非法两个 pre-name 出口）原样保留——它表示"agent 想用但入口
   * 没有这个名字"，是晋升方向信号，与"非 MCP 流量"的空串哨兵语义不同。
   */
  @ApiProperty({
    description:
      "MCP tool name (≤128). The reporter uses '__invalid__' for tools/call exits where the tool " +
      'name was missing or invalid — that is a promotion signal, not an error.',
    maxLength: USAGE_TOOL_NAME_MAX_LENGTH,
    example: 'task',
  })
  @IsString()
  @MaxLength(USAGE_TOOL_NAME_MAX_LENGTH)
  toolName: string;

  /** 暴露面（D4c 封闭词表）：`''` = 非 MCP 流量，`unknown` = MCP 但暴露面不明 */
  @ApiProperty({
    description: "MCP surface (closed vocabulary: '' | mcp | mcp-full | unknown)",
    enum: USAGE_SURFACE_VALUES,
    example: 'mcp',
  })
  @IsIn(USAGE_SURFACE_VALUES)
  surface: string;

  /** 工具调用是否成功（true → 2xx，false → 5xx；上报只有成败两态，无 HTTP 状态可继承） */
  @ApiProperty({ description: 'Whether the tool call succeeded (true → 2xx, false → 5xx)' })
  @IsBoolean()
  ok: boolean;

  /** 工具调用耗时（ms，≥0；非整数由 buffer 侧四舍五入，列是 int） */
  @ApiProperty({ description: 'Tool call latency in milliseconds (≥0)', minimum: 0, example: 42 })
  @IsInt()
  @Min(0)
  latencyMs: number;

  /**
   * 是否走 fallbackAuth（共享 `--api-key`）→ 该行 `actor_type='system'`。
   * 语义 = "身份不可信"归因标记：distinctActors 在这种调用上会失真，用它可过滤。
   */
  @ApiPropertyOptional({
    description:
      "true when the call used the shared --api-key fallback → the row is stored with " +
      "actor_type='system' (identity not trustworthy; distinctActors would be skewed)",
  })
  @IsOptional()
  @IsBoolean()
  viaFallbackAuth?: boolean;
}
