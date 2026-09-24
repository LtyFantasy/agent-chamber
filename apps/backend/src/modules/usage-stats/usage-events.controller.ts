/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计：MCP invocation 上报端点 `POST /system/usage-events`
 *
 * [代码职责]
 *   - 接收 automcp 的 fire-and-forget 上报，转成 buffer 的一次计数（D4b）
 *   - **fail-open**：聚合失败也只 warn，绝不把上报方打成 5xx
 *   - `@SkipUsageStats()` 自统计排除（否则每次 MCP 调用会额外产生一行 REST 记录）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 上报契约 + 口径专章
 *     （"invocation 计数为自报数据，不作审计/安全用途"、actor_type='system' 语义）
 *   - 补充: docs/architecture.md §UsageStats 模块
 *
 * [关键不变量]
 *   - **`actor_type` 不接受外部输入**：只由 `viaFallbackAuth` 推导
 *     （'system' 的唯一生产者 = 上报侧 fallback-auth 归因标记）——若外部能直接指定，
 *     "身份不可信"标记会退化成可由调用方自行填写的字段
 *   - **`@SkipUsageStats()` 不可摘除**：本端点是上报入口，被自己统计会让
 *     `channel=rest` 口径混入统计管线自身的流量（D4b）
 *   - **认证即可，不设角色门槛**：调用方是 Agent（X-API-Key）也可能是 human JWT
 *   - 响应恒为 202：上报方是 fire-and-forget 语义，返回 4xx/5xx 只会让 automcp
 *     把一次成功的工具调用当成失败
 *   - 上报失败只 `logger.warn`（automcp 侧另有 console.warn——两侧都要可见，
 *     否则 backend 不可达时形成通道双盲）
 *
 * [关联代码]
 *   - usage-stats-buffer.service.ts — 计数落点（`recordInvocation`，行形状钉死在此）
 *   - dto/usage-event.dto.ts — 请求体契约（格式层校验）
 *   - usage-stats.interceptor.ts — `@SkipUsageStats` 的消费方（Reflector 读取）
 *   - skip-usage-stats.decorator.ts — 装饰器本体
 *
 * [持久踩坑]
 *   USAGE-STATS-SELFCOUNT(自统计): 上报端点若被全局拦截器统计，MCP 每次工具调用会
 *     多出一行 `channel=rest` 的记录（工具调用数被重复计入 REST 口径）。安全方向:
 *     方法级 @SkipUsageStats() + 端到端断言"上报两次只落 1 行 invocation 行"。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（自统计排除与 fail-open 是否仍在）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { SkipUsageStats } from './skip-usage-stats.decorator';
import { UsageStatsBufferService } from './usage-stats-buffer.service';
import { UsageEventDto } from './dto/usage-event.dto';

/** 上报受理结果（固定形状；`accepted` 恒为 true——受理 ≠ 已落库，落库由 flush 决定） */
export interface UsageEventAccepted {
  accepted: boolean;
}

/**
 * MCP invocation 上报端点（D4b）。
 *
 * 认证：`JwtOrApiKeyGuard`（Bearer 或 X-API-Key 双通道）——与 sse / audit / task 等
 * 既有"双认证"端点同一组合。Agent 走 API Key、人类排障走 JWT，两者都能上报。
 *
 * 行形状由 `UsageStatsBufferService.recordInvocation` 钉死
 * （`channel='mcp', method='TOOL', route='mcp://tools/call'`），本端点只负责
 * 身份提取与 fail-open 包装。
 */
@ApiTags('Usage Stats')
@UseGuards(JwtOrApiKeyGuard)
@Controller('system')
export class UsageEventsController {
  private readonly logger = new Logger(UsageEventsController.name);

  constructor(private readonly usageStatsBuffer: UsageStatsBufferService) {}

  @Post('usage-events')
  @SkipUsageStats()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Report one MCP tool invocation (fire-and-forget)',
    description:
      'Accepts a self-reported MCP tools/call outcome and folds it into the hourly aggregation ' +
      "(channel='mcp', method='TOOL', route='mcp://tools/call'). Reporting is best-effort: aggregation " +
      'failures are logged and never surface as 4xx/5xx, so the caller can fire-and-forget. ' +
      "viaFallbackAuth=true stores the row with actor_type='system' (identity not trustworthy). " +
      'Self-reported data — not for audit or security purposes.',
  })
  @ApiResponse({ status: 202, description: 'Accepted for aggregation' })
  @ApiResponse({ status: 400, description: 'Malformed payload (tool name too long, unknown surface, negative latency)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async reportUsageEvent(
    @Req() request: Request,
    @Body() dto: UsageEventDto,
  ): Promise<UsageEventAccepted> {
    try {
      this.usageStatsBuffer.recordInvocation({
        toolName: dto.toolName,
        surface: dto.surface,
        ok: dto.ok,
        latencyMs: dto.latencyMs,
        viaFallbackAuth: dto.viaFallbackAuth,
        actorId: readAgentId(request),
      });
    } catch (err) {
      // fail-open：统计是旁路。上报方已经完成了一次工具调用，此处抛错只会让它
      // 把成功的调用当失败处理——通道宁丢一次计数，不污染业务语义。
      this.logger.warn(`usage event dropped: ${(err as Error).message}`);
    }
    return { accepted: true };
  }
}

/**
 * 从认证上下文取上报方身份：**只认 agent**（`request.agent?.id`）。
 *
 * 人类 JWT 调用本端点时 `actorId` 留 null（上报通道的语义是"MCP 调用者"，
 * 人类排障流量不该混进 Agent 用量画像）。统计行刻意无 FK，故这里不校验存在性。
 *
 * ⚠️ 用 `unknown` 中转而不是直接读 typed `Request`：`Express.Request` 上
 * `user` 存在两处同名声明冲突（`src/types/express.d.ts` vs `@types/passport` 的空
 * `Express.User`），本文件读 `agent` 虽不直接撞坑，但沿用批 1 拦截器的**最小形状**
 * 读法（usage-stats.interceptor.ts 的 `readActorContext`）以免未来改动被同一坑绊住。
 */
function readAgentId(request: Request): string | null {
  const agent = (request as unknown as { agent?: { id?: string } | null }).agent;
  return typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : null;
}
