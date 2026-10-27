/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 按 actor 授权的统一事件轮询入口
 *
 * [代码职责]
 *   - 认证后透传当前 actor 与游标参数；维护 REST/OpenAPI 轮询消费说明
 *
 * [权威文档]
 *   - 主文档: DocSpace Agent Chamber docs/api-definition.md §8.1 — 轮询消费合同
 *   - 补充: DocSpace Agent Chamber docs/architecture.md §3.2.4 — 统一事件层
 *
 * [关键不变量]
 *   - CurrentActor 必须传给 Service；admin 之外仅返回可读 Topic/Board/DocSpace 或本人事件
 *   - nextCursor 是不透明 DB 位点，消费者原样回传，不可按时间解析或制造
 *
 * [关联代码]
 *   - apps/backend/src/modules/event/event.service.ts — SQL 授权、分页和游标校验
 *
 * [持久踩坑]
 *   - B-50(越权): 漏传 actor 会破坏授权。详情: docs/api-definition.md §8.1
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Controller, Get, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { EventService } from './event.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';

@ApiTags('Events')
@Controller('events')
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @UseGuards(JwtOrApiKeyGuard)
  @Get('poll')
  @ApiOperation({
    summary: 'Poll events',
    description:
      'Cursor-based event polling for clients to pull new events. Returns events after the cursor, sorted by cursor in ascending order. Non-admin actors only receive events from accessible topics/boards/DocSpaces (DocSpace events match payload.spaceId), plus their personal events.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      'Opaque monotonic sequence number issued by the database (a bigint decimal string, at most 19 digits) — pass the nextCursor value returned by the previous poll. ' +
      "'now' starts from the current global high-water mark (the latest cursor in the whole deployment; NOT narrowed by your permissions — you may still be unable to see some of the events that follow it). " +
      'An empty string is treated as omitted. Any other value (non-numeric, longer than 19 digits, repeated parameter) is rejected with 400 VALIDATION_ERROR.',
    type: String,
    example: '1792000000123456',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description:
      'Max events returned by polling, default 100. Values exceeding 100 are automatically clamped to 100 (to avoid breaking the polling loop).',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns an event list and the next cursor. Response shape: { events: Event[], nextCursor: string }. nextCursor is ALWAYS a string (never null) — pass it directly as the cursor parameter in the next poll request.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid cursor: not a numeric string of at most 19 digits, and not the literal "now" (code VALIDATION_ERROR).',
  })
  async poll(
    @Query() query: { cursor?: string; limit?: number },
    @CurrentActor() actor: UnifiedActor,
  ): Promise<{ events: unknown[]; nextCursor: string }> {
    return this.eventService.poll(query, actor);
  }
}
