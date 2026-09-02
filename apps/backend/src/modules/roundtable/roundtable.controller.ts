/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/roundtable-design.md §6 (座位管理) / §7 (seatLabel 与权限边界)
 *   - 补充: docs/roundtable-design.md §5 (roundtable_seats 表)
 *
 * [踩坑索引]
 *
 * [铁律关联] #9(代理层透传) #11(注释) #21(双层校验)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */
import { Controller, Post, Get, Delete, Body, Query, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { RoundtableService } from './roundtable.service';
import {
  CreateSeatDto,
  ListSeatsQueryDto,
  VerdictPermissionRequestDto,
  ListPermissionRequestsQueryDto,
} from './dto';

/**
 * 圆桌座位管理 REST（M1 最小面：dogfood 建座位/查座位用；web 管理 UI 在 M3）
 *
 * 权限模型（§7）：座位本身的读写按 topic 参与者权限（ensureCan）判定——seatLabel 是
 * 展示/路由语义，不是权限边界；本控制器只做 DTO 格式校验，存在性/权限在 Service 层
 * （铁律 #21 双层校验）。
 *
 * M3 阶段 1 追加审批 REST：POST /roundtable/permission-requests/:id/verdict（人类裁决，
 * agent key 403）、GET /roundtable/permission-requests（列表，topic 参与者可见）、
 * GET /roundtable/permission-requests/pending-count（当前用户可见 pending 总数，全局
 * 角标数据源）——格式校验在 DTO，状态机/权限/存在性在 Service（铁律 #21/#22）。
 * M3 阶段 3 追加座位移除 REST：DELETE /roundtable/seats/:id（仅人类 topic 管理员/
 * 平台管理员；软删 + seat.revoke 下行 + topic 公告，全部在 Service 层）。
 * M4b-1 追加取消 REST：POST /roundtable/seats/:id/cancel（治理身份 admin|creator|
 * ownerProxy；busy 门控——presence 非 busy 409；seat.cancel 下行 fire-and-forget，
 * 立即返回 accepted，优雅结果异步经轮询观察）。
 * v1.49.0 追加 runner 列表 REST：GET /roundtable/runners（任意认证 actor 可读，
 * 字段投影不透 actorId；web 座位管理 runner 状态块数据源）。
 */
@ApiTags('Roundtable')
@Controller('roundtable')
@UseGuards(JwtOrApiKeyGuard)
export class RoundtableController {
  constructor(private readonly roundtableService: RoundtableService) {}

  @Post('seats')
  @ApiOperation({
    summary: 'Create roundtable seat',
    description:
      'Create a seat in a roundtable topic. Requires write permission on the topic. ' +
      'bindActorId defaults to the current agent actor id when the creator is an agent.',
  })
  @ApiResponse({ status: 201, description: 'Seat created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden (not a topic participant)' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async createSeat(@CurrentActor() actor: UnifiedActor, @Body() dto: CreateSeatDto) {
    return this.roundtableService.createSeat(dto, actor);
  }

  @Get('seats')
  @ApiOperation({
    summary: 'List roundtable seats',
    description:
      'List seats of a roundtable topic. Requires read permission on the topic. ' +
      'seat.state is a whitelist projection: modelInfo/recentActivity/silentCount/lastUsage are kept; ' +
      'internal fields (recentInjects/failedEventSeqs/roundsWithoutHuman/valveTripCount) are not exposed.',
  })
  @ApiResponse({ status: 200, description: 'Seat list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 404, description: 'Topic not found (or no read access)' })
  async listSeats(@Query() query: ListSeatsQueryDto, @CurrentActor() actor: UnifiedActor) {
    return this.roundtableService.listSeats(query.topicId, actor);
  }

  @Delete('seats/:id')
  @ApiOperation({
    summary: 'Remove roundtable seat (human topic/platform admin only)',
    description:
      'Soft-remove a seat: status=removed + unbind runner, deliver seat.revoke to the ' +
      'bound runner and announce in the topic. Humans (JWT) who are the topic creator, ' +
      'its owner proxy, or a platform admin only; agent API keys are rejected with 403.',
  })
  @ApiParam({ name: 'id', description: 'Seat id (UUID)' })
  @ApiResponse({ status: 200, description: 'Removed seat row (status=removed)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden (agent key or not a topic/platform admin)' })
  @ApiResponse({ status: 404, description: 'Seat not found' })
  async removeSeat(@Param('id') id: string, @CurrentActor() actor: UnifiedActor) {
    return this.roundtableService.removeSeat(id, actor);
  }

  @Post('seats/:id/cancel')
  @ApiOperation({
    summary: 'Cancel a running seat turn (topic creator/admin/owner proxy only)',
    description:
      'Request graceful cancellation of a busy seat (presence thinking/tool/replying): ' +
      'deliver seat.cancel to the bound runner and return accepted immediately; the graceful ' +
      'result is async and observable via seat presence polling. Idle/offline seats return ' +
      '409 (busy gate). Topic creator, its owner proxy or a platform admin only; others 403.',
  })
  @ApiParam({ name: 'id', description: 'Seat id (UUID)' })
  @ApiResponse({ status: 200, description: 'Cancel accepted (graceful result async)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden (not creator/admin/owner proxy)' })
  @ApiResponse({ status: 404, description: 'Seat not found' })
  @ApiResponse({ status: 409, description: 'Seat is not busy (idle/offline), cannot cancel' })
  async cancelSeat(@Param('id') id: string, @CurrentActor() actor: UnifiedActor) {
    return this.roundtableService.cancelSeat(id, actor);
  }

  @Get('runners')
  @ApiOperation({
    summary: 'List roundtable runners',
    description:
      'List registered runners as a minimal projection (id/name/status/version/vendors/' +
      'lastSeenAt — actorId is not exposed). Readable by any authenticated actor. ' +
      'Sorted online-first, then lastSeenAt desc. Powers the web seat-management runner status block.',
  })
  @ApiResponse({ status: 200, description: 'Runner list (online first)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  async listRunners() {
    return this.roundtableService.listRunners();
  }

  @Get('permission-requests/pending-count')
  @ApiOperation({
    summary: 'Count pending permission requests visible to the current actor',
    description:
      'Count of pending permission requests across all topics where the current actor ' +
      'is an active participant. Global badge data source for the roundtable approval UI.',
  })
  @ApiResponse({ status: 200, description: 'Pending count' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  async pendingCount(@CurrentActor() actor: UnifiedActor) {
    return { count: await this.roundtableService.pendingPermissionRequestCount(actor) };
  }

  @Get('permission-requests')
  @ApiOperation({
    summary: 'List permission requests of a topic',
    description:
      'List permission requests of a roundtable topic with optional status filter and ' +
      'pagination. Requires read permission on the topic (404 otherwise).',
  })
  @ApiResponse({ status: 200, description: 'Paginated permission request list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 404, description: 'Topic not found (or no read access)' })
  async listPermissionRequests(
    @Query() query: ListPermissionRequestsQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    return this.roundtableService.listPermissionRequests(query, actor);
  }

  @Post('permission-requests/:id/verdict')
  @ApiOperation({
    summary: 'Resolve a permission request (human only)',
    description:
      'Resolve a pending permission request: persist the verdict, deliver seat.permission_verdict ' +
      'down to the runner and announce in the topic. Humans (JWT) who are topic participants only; ' +
      'agent API keys are rejected with 403. Non-pending requests return 409; optionId not in the ' +
      'request options returns 422.',
  })
  @ApiParam({ name: 'id', description: 'Permission request id (UUID)' })
  @ApiResponse({ status: 200, description: 'Resolved permission request' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden (agent key or not a topic participant)' })
  @ApiResponse({ status: 404, description: 'Permission request not found' })
  @ApiResponse({ status: 409, description: 'Already resolved (not pending)' })
  @ApiResponse({ status: 422, description: 'optionId not in request options' })
  async verdictPermissionRequest(
    @Param('id') id: string,
    @Body() dto: VerdictPermissionRequestDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    return this.roundtableService.verdictPermissionRequest(id, dto, actor);
  }
}
