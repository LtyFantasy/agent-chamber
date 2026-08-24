/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.5 (SSE Module — 实时推送模块)
 *   - 补充: docs/api-definition.md §8.2 (GET /events/stream)
 *
 * [踩坑索引] B-51(SSE 推送越权)
 *
 * [铁律关联] #17(测试契约) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *   B-51: stream() 不取 actor/Query，全量广播无过滤，私密资源事件泄露。
 *          修复：@CurrentActor + types/topics 偏好过滤传入 SseService 按连接过滤。
 *          见 memory/2026-08-18.md
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Controller, Query, Sse, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Observable, interval, map, merge } from 'rxjs';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { SseService, SseFilters } from './sse.service';

/** 解析逗号分隔查询参数为字符串数组；空段剔除，非法值整体忽略（长连接端点对垃圾参数宽容，不 400） */
function parseCsvParam(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

@ApiTags('SSE')
@Controller('events')
export class SseController {
  constructor(private readonly sseService: SseService) {}

  @UseGuards(JwtOrApiKeyGuard)
  @Sse('stream')
  @ApiOperation({ summary: 'SSE stream（按连接 actor 授权过滤；types/topics 为偏好过滤，与可见性取交集）' })
  @ApiQuery({ name: 'types', required: false, description: '订阅事件类型，逗号分隔（偏好过滤）' })
  @ApiQuery({ name: 'topics', required: false, description: '订阅话题 ID，逗号分隔（偏好过滤）' })
  stream(
    @CurrentActor() actor: UnifiedActor,
    @Query('types') types?: string,
    @Query('topics') topics?: string,
  ): Observable<MessageEvent> {
    const filters: SseFilters = {
      types: parseCsvParam(types),
      topics: parseCsvParam(topics),
    };
    const heartbeat$ = interval(30000).pipe(
      map(
        () =>
          ({
            data: JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() }),
          }) as MessageEvent,
      ),
    );
    return merge(this.sseService.subscribe(actor, filters), heartbeat$);
  }
}
