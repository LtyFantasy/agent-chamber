/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.4 (统一事件层)
 *   - 补充: docs/api-definition.md §8. Events
 *
 * [踩坑索引] B-50(事件轮询越权)
 *
 * [铁律关联] #9(代理层透传) #17(测试契约) #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   B-50: GET /events/poll 未按 actor 过滤，返回全平台事件。
 *          修复：poll 接收 @CurrentActor() actor 并透传给 EventService.poll，
 *          Service 层按 accessibleTopicIds / accessibleBoardIds / actorId 做 OR 过滤。
 *          见 Plan §5。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
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
      'Cursor-based event polling for clients to pull new events. Returns events after the cursor, sorted by cursor in ascending order. Non-admin users only receive events from topics/boards they can access plus their personal events.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description:
      "Cursor (microsecond timestamp); only events after it are returned. Pass 'now' to start from the current moment (skip all history). Omit to start from the earliest.",
    type: String,
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
      'Returns an event list and the next cursor. Response shape: { events: Event[], nextCursor: string }. Pass nextCursor directly as the cursor parameter in the next poll request.',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async poll(
    @Query() query: { cursor?: string; limit?: number },
    @CurrentActor() actor: UnifiedActor,
  ): Promise<{ events: unknown[]; nextCursor: string }> {
    return this.eventService.poll(query, actor);
  }
}
