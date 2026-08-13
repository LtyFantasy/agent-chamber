/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §6.11
 *   - 补充: docs/architecture.md §3.2.2 (Topic / Message)
 *   D5: TopicController 权限检查从 Service 迁移到 Controller。
 *         findOne → findById() + ensureCan() + enrich()。见 memory/2026-06-05.md
 *
 * [踩坑索引] D5(权限迁移) B-50(列表权限过滤) B-55(QueryBuilder orderBy select 风险) OWNER-PROXY(sendMessage透传role) TOPIC-PERM(write放宽后结构端点收口)
 *
 * [铁律关联] #11(代理层透传) #21(双层校验) #22(findOne 判空) #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条）
 *   TOPIC-PERM: v1.46 TopicPolicy.write 放宽给 editor 参与方后，12 个共用 ensureCan(write)
 *       的端点必须逐个收口——内容字段（title/description）走 policy write，结构端点
 *       （状态流转/agenda/成员管理）与 PATCH 结构字段（status/agenda/visibility/
 *       invitedAgentIds/config）改走 ensureCreatorOrAdmin（admin|creator|ownerProxy）。
 *       漏收口 = editor 可 close/archive/invite（与目标语义表相悖）。
 *   B-55: TypeORM 0.3.30 在 skip/take + join + orderBy(关联字段) + select() 未包含该字段时，
 *         生成 count 子查询报 distinctAlias.xxx does not exist。修复：显式 select orderBy 依赖字段
 *         或改用 leftJoinAndSelect。见 memory/2026-07-02.md §B-55。
 *   B-50: Topic/Board 列表接口在 Controller 层过滤，导致分页 total 与 items 不一致。
 *         修复：Controller.findAll 透传 actor 给 Service，由 Service 层 QueryBuilder 做
 *         IN 过滤，删除 PermissionService.filterTopics。见 Plan §2.1 / §2.2。
 *
 *   OWNER-PROXY: v1.37 sendMessage 透传 actor.role（admin 对 private 话题发言放行）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { TopicService } from './topic.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Topic } from '../../database/entities/topic.entity';
import { TopicStatus, ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';
import {
  CreateTopicDto,
  UpdateTopicDto,
  SendMessageDto,
  UpdateAgendaDto,
  MarkAsReadDto,
  InviteTopicAgentDto,
  UninviteTopicAgentDto,
  InviteTopicUserDto,
  UninviteTopicUserDto,
  RemoveTopicParticipantDto,
  AddTopicEditorDto,
  RemoveTopicEditorDto,
  GetMessagesQueryDto,
  UnreadQueryDto,
  QueryTopicDto,
} from './dto';

@ApiTags('Topics')
@Controller('topics')
export class TopicController {
  constructor(
    private readonly topicService: TopicService,
    private readonly permService: PermissionService,
    private readonly ownerProxy: OwnerProxyService,
  ) {}

  /**
   * 判定 actor 是否为话题创建者级（D2，v1.46 TOPIC-PERM 结构端点收口）：
   * 直接 creator ｜ 人类 owner 代理（v1.37：owner 对其 agent 创建的 topic 视同 creator）。
   * admin 不在此列（admin 由调用方按需 bypass——docspace isCreatorOf 同构）。
   */
  private async isCreatorOf(topic: Topic, actor: UnifiedActor | null): Promise<boolean> {
    if (!actor) return false;
    if (topic.creatorId === actor.id) return true;
    return this.ownerProxy.isOwnerProxy(topic.creatorId, actor);
  }

  /**
   * 判定 actor 是否为话题创建者级并强制放行，否则 403（D2，v1.46 TOPIC-PERM 结构端点收口）：
   * admin bypass ｜ 直接 creator ｜ 人类 owner 代理。非创建者级 → 403（PERMISSION_DENIED）。
   * 与 TopicPolicy.write 的关系：policy 放宽给 editor 参与方后，结构操作（状态流转/
   * agenda/成员管理/结构字段）必须由本 helper 收口为 creator-only（镜像 DocSpace
   * isCreatorOf 模式）。
   */
  private async ensureCreatorOrAdmin(topic: Topic, actor: UnifiedActor): Promise<void> {
    if (actor?.role === UserRole.ADMIN) return;
    if (await this.isCreatorOf(topic, actor)) return;
    throw new ForbiddenException({
      message: 'Only the topic creator can perform this action',
      code: ErrorCode.PERMISSION_DENIED,
    });
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get()
  @ApiOperation({
    summary: 'List topics',
    description:
      "List topics with pagination, status filter, and keyword search. Results are filtered by the current actor's permissions.",
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number, starting from 1, default 1',
    type: Number,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, max 100, default 20',
    type: Number,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description:
      'Filter by topic status, one of: draft, open, active, voting, paused, closed, archived, all (no filter). Defaults to active',
    enum: [...Object.values(TopicStatus), 'all'],
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search keyword; matches topic title and description',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Paginated list of topics' })
  @ApiResponse({ status: 400, description: 'Validation failed (e.g. pageSize exceeds 100)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findAll(@Query() query: QueryTopicDto, @CurrentActor() actor: UnifiedActor) {
    return this.topicService.findAll(query, actor);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post()
  @ApiOperation({
    summary: 'Create topic',
    description:
      'Create a new topic. The creator automatically becomes a topic participant and owner.',
  })
  @ApiResponse({ status: 201, description: 'Topic created' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async create(@CurrentActor() actor: UnifiedActor, @Body() dto: CreateTopicDto) {
    return this.topicService.create(actor.id, actor.type, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id')
  @ApiOperation({
    summary: 'Get topic',
    description: "Get a single topic's details, including the participant list.",
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic details' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    // TopicPolicy 的 read 判定依赖调用方注入 hasAccess（invited/active 参与者）——
    // 与 getMessages/sendMessage 保持一致，否则 PRIVATE 话题的非创建者参与者会被误判 404
    const hasAccess = await this.topicService.hasTopicAccess(id, actor.id);
    await this.permService.ensureCan(topic, actor, 'read', { hasAccess });
    return this.topicService.findOneWithParticipants(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id')
  @ApiOperation({
    summary: 'Update topic',
    description:
      'Update topic by ID. Field-level permission split (v1.46 TOPIC-PERM): ' +
      'content fields (title/description) require write access (creator, editor participant, ' +
      'owner-proxy, or admin); structural fields (status/agenda/visibility/invitedAgentIds/config) ' +
      'require creator (or admin). An editor request containing any structural field is rejected ' +
      'as a whole (403) — no partial application.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic updated' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTopicDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    // 字段级分权（D3）：内容字段（title/description）走 policy write——permService.ensureCan
    // 全覆盖 creator/editor 参与方/owner-proxy/admin（实现收敛，不自造 isCreatorOrEditor）；
    // 结构字段（status/agenda/visibility/invitedAgentIds/config）creator-only（D2 helper）。
    // ⚠️ 结构字段存在性必须 `!== undefined`（显式 null 也算「出现」）——truthy 判断会漏掉
    // { visibility: null } 类请求，让 editor 绕过结构字段检查。agenda 归结构（驱动圆桌讨论流）。
    const structuralFields = [
      'status',
      'agenda',
      'visibility',
      'invitedAgentIds',
      'config',
    ] as const;
    const presentStructural = structuralFields.filter((f) => dto[f] !== undefined);
    if (presentStructural.length > 0) {
      // 整体 403 + 列出实际出现的结构字段名（R1：agent 消费者可据消息自修正），不做部分应用。
      // ⚠️ admin bypass 别漏（与 DocSpace v1.45 模板同构）
      const isAdmin = actor?.role === UserRole.ADMIN;
      const isCreator = await this.isCreatorOf(topic, actor);
      if (!isCreator && !isAdmin) {
        throw new ForbiddenException({
          message: `Structural fields require creator permission: ${presentStructural.join(', ')}`,
          code: ErrorCode.PERMISSION_DENIED,
        });
      }
    } else {
      // 内容字段（title/description）：creator/editor 参与方/owner-proxy/admin 可改 → policy write
      await this.permService.ensureCan(topic, actor, 'write');
    }
    return this.topicService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete topic',
    description:
      'Delete a topic (soft delete). Only the topic creator or an admin can perform this action.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic deleted' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    await this.permService.ensureCan(topic, actor, 'delete');
    return this.topicService.remove(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/close')
  @ApiOperation({
    summary: 'Close topic',
    description: 'Close a topic. No new messages can be sent after closing.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic closed' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async close(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.changeStatus(id, TopicStatus.CLOSED);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/pause')
  @ApiOperation({
    summary: 'Pause topic',
    description: 'Pause a topic. The topic becomes read-only after pausing.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic paused' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async pause(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.changeStatus(id, TopicStatus.PAUSED);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/open')
  @ApiOperation({
    summary: 'Open topic (draft → active)',
    description: 'Activate a draft topic to active status, allowing discussions to begin.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic activated' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async open(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.changeStatus(id, TopicStatus.ACTIVE);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/resume')
  @ApiOperation({
    summary: 'Resume topic',
    description: 'Resume a paused topic to active status.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic resumed' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async resume(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.changeStatus(id, TopicStatus.ACTIVE);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/archive')
  @ApiOperation({
    summary: 'Archive topic',
    description: 'Archive a topic. Archived topics no longer appear in default lists.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Topic archived' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async archive(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.changeStatus(id, TopicStatus.ARCHIVED);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/join')
  @ApiOperation({
    summary: 'Join topic',
    description:
      'The current actor joins the topic as a participant. Returns success immediately if already a participant.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Joined topic' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async join(@Param('id', ParseUUIDPipe) topicId: string, @CurrentActor() actor: UnifiedActor) {
    const topic = await this.topicService.findById(topicId);
    // 如果已是活跃参与者，跳过 join（兼容 OPEN→PRIVATE 话题迁移）
    const isAlreadyActive = await this.topicService.isActiveParticipant(topicId, actor.id);
    if (isAlreadyActive) {
      return { success: true, message: 'Already a participant' };
    }
    // PRIVATE 话题 join 需注入 hasAccess（invited/active 参与者），
    // 否则被邀请但尚未 join 的参与者会被误判无权限（404）
    const hasAccess = await this.topicService.hasTopicAccess(topicId, actor.id);
    await this.permService.ensureCan(topic, actor, 'join', { hasAccess });
    return this.topicService.join(topicId, actor.id, actor.type);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/leave')
  @ApiOperation({
    summary: 'Leave topic',
    description: 'The current actor leaves the topic, removing their participant status.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Left topic' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async leave(@Param('id', ParseUUIDPipe) topicId: string, @CurrentActor() actor: UnifiedActor) {
    return this.topicService.leave(topicId, actor.id, actor.type);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/remove-participant')
  @ApiOperation({
    summary: 'Remove participant from topic (creator/admin only)',
    description:
      'Remove a specified participant from the topic. Only the topic creator or an admin can perform this action.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Participant removed' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or participant not found' })
  async removeParticipant(
    @Param('id', ParseUUIDPipe) topicId: string,
    @CurrentActor() actor: UnifiedActor,
    @Body() dto: RemoveTopicParticipantDto,
  ) {
    const topic = await this.topicService.findById(topicId);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.removeParticipant(topicId, actor.id, dto.participantId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/messages')
  @ApiOperation({
    summary: 'Get messages',
    description:
      'List topic messages with pagination, time-range filter, and sender filter.' +
      'Agents reading for the first time should use limit=1~5, then fetch more via before/after cursors as needed;' +
      'this avoids wasting tokens by pulling large volumes of historical messages at once.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiQuery({
    name: 'after',
    required: false,
    description:
      'Return messages after this message ID (cursor pagination, excluding the anchor itself)',
    type: String,
  })
  @ApiQuery({
    name: 'before',
    required: false,
    description:
      'Return messages before this message ID (cursor pagination, excluding the anchor itself)',
    type: String,
  })
  @ApiQuery({
    name: 'since',
    required: false,
    description: 'Return messages after this timestamp (ISO 8601 format)',
    type: String,
  })
  @ApiQuery({
    name: 'start',
    required: false,
    description:
      "Message ID; return this message and those after it (mutually exclusive with 'after')",
    type: String,
  })
  @ApiQuery({
    name: 'end',
    required: false,
    description:
      "Message ID; return this message and those before it (mutually exclusive with 'before')",
    type: String,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description:
      'Items per page, 1–100, default 50.' +
      'Agents reading for the first time should explicitly pass limit=1~5, then load more via before/after as needed.',
    type: Number,
  })
  @ApiQuery({
    name: 'senderId',
    required: false,
    description: 'Filter by sender actor ID',
    type: String,
  })
  @ApiResponse({ status: 200, description: 'Message list' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({
    status: 404,
    description: 'Topic not found, or cursor message not found / not belonging to this topic',
  })
  async getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GetMessagesQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    const hasAccess = await this.topicService.hasTopicAccess(id, actor.id);
    await this.permService.ensureCan(topic, actor, 'read', { hasAccess });
    return this.topicService.getMessages(id, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/messages')
  @ApiOperation({
    summary: 'Send message',
    description:
      'Send a message in the topic. The sender must be a topic participant, or the topic must be publicly visible.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 201, description: 'Message sent' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async sendMessage(
    @Param('id', ParseUUIDPipe) topicId: string,
    @CurrentActor() actor: UnifiedActor,
    @Body() dto: SendMessageDto,
  ) {
    const topic = await this.topicService.findById(topicId);
    const hasAccess = await this.topicService.hasTopicAccess(topicId, actor.id);
    await this.permService.ensureCan(topic, actor, 'read', { hasAccess });
    // 透传 senderRole（human admin 对 private 话题发消息放行，见 topic.service sendMessage）
    return this.topicService.sendMessage(topicId, actor.id, actor.type, dto, actor.role);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/messages/unread')
  @ApiOperation({
    summary: 'Get unread messages',
    description:
      "Get the current actor's unread message count and incremental message list in the topic." +
      "Use the 'limit' parameter to control the number of returned messages (1–50, default 20).",
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    description:
      'Number of unread messages to return, 1–50, default 20. Does not affect unreadCount (total unread count).',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Unread summary and incremental messages' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async getUnread(
    @Param('id', ParseUUIDPipe) topicId: string,
    @Query() query: UnreadQueryDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(topicId);
    // read 判定需注入 hasAccess（invited/active 参与者），与 getMessages 保持一致
    const hasAccess = await this.topicService.hasTopicAccess(topicId, actor.id);
    await this.permService.ensureCan(topic, actor, 'read', { hasAccess });
    return this.topicService.getUnread(topicId, query, actor.id, actor.type);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/read')
  @ApiOperation({
    summary: 'Mark messages as read up to a specific message',
    description:
      'Mark topic messages as read. Optionally specify a message ID; otherwise marks up to the latest message.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Marked as read' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async markAsRead(
    @Param('id', ParseUUIDPipe) topicId: string,
    @CurrentActor() actor: UnifiedActor,
    @Body() dto: MarkAsReadDto,
  ) {
    if (!actor) {
      throw new BadRequestException({
        message: 'User or Agent ID is required',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const topic = await this.topicService.findById(topicId);
    // read 判定需注入 hasAccess（invited/active 参与者），与 getMessages 保持一致
    const hasAccess = await this.topicService.hasTopicAccess(topicId, actor.id);
    await this.permService.ensureCan(topic, actor, 'read', { hasAccess });
    return this.topicService.markAsRead(topicId, actor.id, actor.type, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':topicId/messages/:messageId')
  @ApiOperation({
    summary: 'Delete message (soft delete)',
    description:
      'Soft-delete a specified message. Normally only the message sender or a topic admin can perform this action.',
  })
  @ApiParam({ name: 'topicId', description: 'Topic UUID', type: String })
  @ApiParam({ name: 'messageId', description: 'Message UUID', type: String })
  @ApiResponse({ status: 200, description: 'Message deleted' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or message not found' })
  async removeMessage(
    @Param('topicId', ParseUUIDPipe) topicId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    return this.topicService.removeMessage(topicId, messageId, actor.id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/agenda')
  @ApiOperation({
    summary: 'Update topic agenda',
    description: 'Update the topic agenda. This overwrites the existing agenda content.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Agenda updated' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic not found' })
  async updateAgenda(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgendaDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.updateAgenda(id, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/invite-agent')
  @ApiOperation({
    summary: 'Invite an agent to a private topic',
    description:
      'Invite an agent to a private topic. The invited agent will be granted participant status.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Invited successfully' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or agent not found' })
  async inviteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteTopicAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.inviteAgent(id, dto.agentId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/uninvite-agent')
  @ApiOperation({
    summary: 'Uninvite an agent from a private topic',
    description: "Revoke an agent's participant status in the topic.",
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Uninvited successfully' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or agent not found' })
  async uninviteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UninviteTopicAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.uninviteAgent(id, dto.agentId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/add-editor')
  @ApiOperation({
    summary: 'Add editor to topic (creator/admin only)',
    description:
      'Promote an agent to topic editor (v1.46 TOPIC-PERM). Editors can modify content fields ' +
      '(title/description) without joining first — an invited editor can edit immediately. ' +
      'Structural operations (status transitions, agenda, visibility, member management) ' +
      'remain creator-only. Only the topic creator or an admin can perform this action.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 201, description: 'Editor added successfully' })
  @ApiResponse({ status: 400, description: 'Target is the topic creator (cannot be promoted)' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or agent not found' })
  @ApiResponse({ status: 409, description: 'Agent has left the topic (re-invite first)' })
  async addEditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTopicEditorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    // 成员管理属结构操作（D2）：creator/admin-only（owner 代理含内）
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.addEditor(id, dto.agentId);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/remove-editor')
  @ApiOperation({
    summary: 'Remove editor from topic (creator/admin only)',
    description:
      'Revoke an agent\u2019s topic editor role (v1.46 TOPIC-PERM). The agent is demoted to ' +
      'member (status preserved — not removed from the topic). Only the topic creator or an ' +
      'admin can perform this action.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 201, description: 'Editor removed successfully' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic, agent, or editor row not found' })
  async removeEditor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveTopicEditorDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    // 成员管理属结构操作（D2）：creator/admin-only（owner 代理含内）
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.removeEditor(id, dto.agentId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/invite-user')
  @ApiOperation({
    summary: 'Invite a human user to a topic (directly joins as participant)',
    description:
      'Invite a human user to the topic; the user directly becomes a participant. JWT authentication only.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Invited successfully' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or user not found' })
  async inviteUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteTopicUserDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.join(id, dto.userId, ActorType.HUMAN);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/uninvite-user')
  @ApiOperation({
    summary: 'Uninvite a human user from a topic (removes from participants)',
    description: 'Remove a human user from the topic participants. JWT authentication only.',
  })
  @ApiParam({ name: 'id', description: 'Topic UUID', type: String })
  @ApiResponse({ status: 200, description: 'Uninvited successfully' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Topic or user not found' })
  async uninviteUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UninviteTopicUserDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const topic = await this.topicService.findById(id);
    await this.ensureCreatorOrAdmin(topic, actor);
    return this.topicService.uninviteUser(id, dto.userId);
  }
}
