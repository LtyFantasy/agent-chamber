/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：admin 查询端点 `GET /system/api-usage`
 *
 * [代码职责]
 *   - admin-only 入口（权限在这里，聚合口径在 service）
 *   - 参数走 DTO 格式校验（枚举/范围/UUID/长度），响应直接透传 service 结果
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 端点契约 + 统计口径专章
 *     （本端点窗口 ≤90 天；更长历史走 SQL 配方；最小观察窗口 ≥4 周）
 *   - 补充: docs/architecture.md §UsageStats 模块 — 模块总览
 *
 * [关键不变量]
 *   - **admin-only 是类级三元组**：`@UseGuards(JwtAuthGuard, RolesGuard)` +
 *     `@Roles(UserRole.ADMIN)`——三者缺一即可被普通登录用户读到全平台调用画像
 *     （`/system/api-logs` 的 B-50 越权就是漏了角色过滤，见 monitoring.controller.ts）
 *   - 端点**不暴露任何写能力**：只读聚合，无副作用
 *   - 参数错误（互斥/跨度超限）必须是 400 且文案可操作——不得落到 500（铁律 #9）
 *
 * [关联代码]
 *   - api-usage-query.service.ts — 口径解析与聚合实现（本文件不做业务判断）
 *   - dto/api-usage-query.dto.ts — 格式层校验
 *   - modules/monitoring/monitoring.controller.ts — 同类 admin 端点先例（/system/api-logs）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（权限三元组是否仍完整）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@agent-chamber/shared';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ApiUsageQueryService, type ApiUsageResponse } from './api-usage-query.service';
import { ApiUsageQueryDto } from './dto/api-usage-query.dto';

/**
 * 调用频率查询端点（D8：admin-only，无 web UI——分析面 = 本端点 + 4 条 SQL 配方）。
 *
 * 为什么 admin-only 而不是"按 actor 收窄"：本端点的用途是**工具集优胜劣汰的全局
 * 决策数据**（平台级画像），按调用者收窄后失去意义；且它是只读聚合，不泄露正文。
 */
@ApiTags('Usage Stats')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('system')
export class ApiUsageController {
  constructor(private readonly apiUsageQueryService: ApiUsageQueryService) {}

  @Get('api-usage')
  @ApiOperation({
    summary: 'Aggregate API / MCP tool usage',
    description:
      'Admin-only aggregate of api_usage_stats_hourly over a UTC hour-bucket window (default: last 7 ' +
      'days, hard cap 90 days — split the range or use the SQL recipes for longer). Three dimensions: ' +
      'route (REST route template, mcp://% excluded unless route is passed explicitly) | tool (MCP ' +
      'tool, default metric=invocations → only mcp://tools/call rows; metric=rest_calls → fan-out ' +
      'channel=rest rows with a tool name) | actor (per caller; sums invocation and fan-out rows — ' +
      'mixed units, use for activity ranking only). distinctActors counts identified callers in the ' +
      'window (a second-pass query over the returned top-N keys; anonymous rows count 0).',
  })
  @ApiResponse({ status: 200, description: 'Aggregated items + window/coverage meta' })
  @ApiResponse({ status: 400, description: 'Mutually exclusive params or window span > 90 days' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions; admin role required' })
  async getApiUsage(@Query() query: ApiUsageQueryDto): Promise<ApiUsageResponse> {
    return this.apiUsageQueryService.query(query);
  }
}
