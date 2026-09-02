/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Agent)
 *   - 补充: docs/api-definition.md §5. Agents
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（agent 写操作全量记，
 *     controller 层插桩决策 2，keyPrefix 缓解决策 9——create 的 status 是 actor 代理
 *     getter，TS spread 类实例不保留 getter 类型，须从 agent.actor.status 直取）
 *
 * [踩坑索引] D5(权限盲区) AGENT-VISIBILITY(Agent可见性) AGENT-FIELD-WHITELIST(白名单漏字段) A3-2(deletion-impact与DELETE同权)
 *
 * [铁律关联] #17(测试契约) #11(注释强制) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *   A3-2: GET /agents/:id/deletion-impact 的权限必须是 ensureCan 'delete'（与 DELETE 同权，
 *       调用者即删除者）——'read' 会向只读协作者泄露聚合计数（openTask/message/topic/seat）。
 *       见 plans/rictor-swamp-thing-hulkling.md R13
 *   AGENT-VISIBILITY: 非 admin 用户 ownerId 过滤导致 Board/Task 中看不到其他用户 Agent 名称（显示 ?）。
 *       修复：非 admin 不再强制 ownerId 过滤，改为返回全部 Agent 并在 controller 层 pick 公开字段，
 *             过滤 webhookUrl/webhookSecret/systemPrompt/modelConfig/rateLimit 等敏感配置。
 *       见 .kimi/plans/winter-soldier-damage-jericho.md §问题 2
 *   D5: AgentController 原无任何权限检查，任何 JWT 用户可操作任意 Agent。
 *       修复：GET /agents 拒绝 Agent(API Key) 访问，findAll 按 ownerId 过滤，
 *             findOne/update/remove/resetKey/toggle/stats/heartbeat/keys/createKey/revokeKey
 *             全部加 ensureCan(agent, actor, 'write') 检查。
 *       见 memory/2026-06-05.md、memory/2026-06-06.md
 *   AGENT-FIELD-WHITELIST: 新增/重命名响应字段只改 service + DTO，忘同步 pickPublicAgentFields 白名单——
 *       descriptionSnippet（2026-07-25, 339b64d）上线一个月实际不返回。
 *       白名单是响应字段的最后一道裁剪：字段变更必须三处同改（service 产出 + 共享 DTO +
 *       controller 白名单），并配 controller 层 spec 断言（service 层单测测不出白名单裁剪）。
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
  ParseUUIDPipe,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiResponse } from '@nestjs/swagger';
import { AgentService } from './agent.service';
import { PermissionService } from '../../common/services/permission.service';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { UnifiedActor } from '../../common/types/actor.types';
import {
  CreateAgentDto,
  UpdateAgentDto,
  AgentHeartbeatDto,
  CreateAgentKeyDto,
  QueryAgentDto,
  AgentDirectoryQueryDto,
  BriefingQueryDto,
  MyActivitiesQueryDto,
} from './dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { UserRole, ErrorCode, AgentStatus, AuditAction, ActorType } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';

@ApiTags('Agents')
@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly permService: PermissionService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List agents',
    description: 'List all agents with pagination and filters',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page (max 100)',
    type: Number,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status (active, disabled, pending, all)',
    enum: [...Object.values(AgentStatus), 'all'],
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search query for name or description',
    type: String,
  })
  @ApiQuery({ name: 'ownerId', required: false, description: 'Filter by owner ID', type: String })
  @ApiResponse({ status: 200, description: 'Agents list returned successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed (e.g. pageSize exceeds 100)' })
  async findAll(
    @Query()
    query: QueryAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // Agent（API Key）不能获取全部 Agent 列表：JwtAuthGuard 已对 X-API-Key 做真实认证
    // （成功挂 request.agent，B-59 起不再「放行不认证」），此处按身份类型拒绝而非读
    // 原始 header——语义等价且不依赖 guard 内部实现
    if (actor?.type === ActorType.AGENT) {
      throw new ForbiddenException({
        message: 'Permission denied: Agent cannot access agent list',
        code: ErrorCode.PERMISSION_DENIED,
      });
    }

    // 非 admin：只返回 ownerId = actor.id 的 Agent
    // 协作场景中的 Agent 名称由各自资源接口（Task/Board）聚合返回，
    // 不在 /agents 管理页泄露其他用户的 Agent 列表
    if (actor.role !== UserRole.ADMIN) {
      const result = await this.agentService.findAll({
        ...query,
        ownerId: actor.id,
      });
      return {
        ...result,
        items: result.items.map((item) =>
          this.agentService.pickPublicAgentFields(item as unknown as Record<string, unknown>),
        ),
      };
    }

    // admin：返回全部 Agent，但 apiKeyPrefix 仅对当前用户自己拥有的 Agent 暴露
    const result = await this.agentService.findAll(query);
    return {
      ...result,
      items: result.items.map((item) => {
        const publicAgent = this.agentService.pickPublicAgentFields(
          item as unknown as Record<string, unknown>,
        );
        if (item.ownerId === actor.id) {
          return publicAgent;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { apiKeyPrefix: _, ...withoutPrefix } = publicAgent;
        return withoutPrefix;
      }),
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create agent', description: 'Create a new agent' })
  @ApiResponse({ status: 201, description: 'Agent created successfully' })
  async create(@CurrentActor() actor: UnifiedActor, @Body() dto: CreateAgentDto) {
    const { apiKey, ...agent } = await this.agentService.create(actor.id, dto);
    // 审计（Phase 2）：CREATE + agent；newData 白名单 {agentId, name, status}（决策 6）
    // status 是 Agent 的 actor 代理 getter——TS spread 类实例不保留 getter 类型，
    // 从 actor 列直取（actor 在返回类型中恒存在，create 必建 actor 行）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.AGENT,
      entityId: agent.id,
      actorId: actor.id,
      newData: {
        agentId: agent.id,
        name: agent.name,
        status: agent.actor?.status ?? AgentStatus.ACTIVE,
      },
      source: 'api',
    });
    return {
      ...this.agentService.pickPublicAgentFields(agent as unknown as Record<string, unknown>),
      apiKey,
    };
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('me')
  @ApiOperation({
    summary: 'Get current agent',
    description: 'Get the current authenticated agent profile',
  })
  @ApiResponse({ status: 200, description: 'Current agent returned successfully' })
  async getMe(@CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(actor.id);
    return this.agentService.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch('me')
  @ApiOperation({
    summary: 'Update current agent',
    description: 'Update the current authenticated agent profile',
  })
  @ApiResponse({ status: 200, description: 'Current agent updated successfully' })
  async updateMe(@CurrentActor() actor: UnifiedActor, @Body() dto: UpdateAgentDto) {
    const agent = await this.agentService.updateMe(actor.id, dto);
    // 审计（Phase 2）：UPDATE + agent；actor=自己；newData 白名单子集（决策 6）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.AGENT,
      entityId: agent.id,
      actorId: actor.id,
      newData: {
        agentId: agent.id,
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      source: 'api',
    });
    return this.agentService.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('me/topics')
  @ApiOperation({
    summary: 'Get topics participated by current agent',
    description: 'Get topics the current agent participates in',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', type: Number })
  @ApiQuery({ name: 'pageSize', required: false, description: 'Items per page', type: Number })
  @ApiResponse({ status: 200, description: 'Topics returned successfully' })
  async getMyTopics(
    @CurrentActor() actor: UnifiedActor,
    @Query() query: { page?: number; pageSize?: number },
  ) {
    return this.agentService.findMyTopics(actor.id, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('me/activities')
  @ApiOperation({
    summary: 'Get recent activities of current agent',
    description:
      'Get recent activities (messages, tasks, comments) of the current agent. ' +
      'Returns a standard paginated envelope {items, total, page, pageSize, totalPages, hasNext, hasPrev}. ' +
      'pageSize takes priority; limit is a legacy alias used only when pageSize is absent.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Page number', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page (max 100, default 20)',
    type: Number,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Legacy alias for pageSize; only used when pageSize is absent',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Activities returned successfully' })
  async getMyActivities(@CurrentActor() actor: UnifiedActor, @Query() query: MyActivitiesQueryDto) {
    return this.agentService.findMyActivities(actor.id, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('me/unread')
  @ApiOperation({
    summary: 'Get unread message counts across my topics',
    description:
      'Unread message counts per topic for the current agent (cross-topic, plan forge-jubilee-robin.md WS-B). ' +
      'Semantics: only participation rows with status invited/active are counted (left rows excluded); ' +
      'messages sent by myself ARE counted (the read cursor advances only via get_topic_digest default markRead=true or explicit mark_topic_read); ' +
      'topics with unreadCount=0 are omitted; at most 50 topics, ordered by unreadCount DESC then topic updatedAt DESC; ' +
      'the result is a snapshot at call time — get_topic_digest(markRead=true) resets these counts.',
  })
  @ApiResponse({ status: 200, description: 'Unread counts returned successfully' })
  async getMyUnread(@CurrentActor() actor: UnifiedActor) {
    return this.agentService.findMyUnreadCounts(actor.id);
  }

  /**
   * =============================================================================
   * AGENT-CODE-HOOK | GET /agents/me/briefing
   * =============================================================================
   * [功能概念]
   *   - Agent 启动简报（会话初始化 / REST 冷启动）：一次调用建立工作上下文
   *
   * [代码职责]
   *   - 委托 AgentService.getMyBriefing（编排+降级语义在 service 层）；
   *     本层对 me 做最后一道白名单裁剪（AGENT-FIELD-WHITELIST 教训：白名单是
   *     响应字段的最后一道裁剪，controller 层 spec 断言裁剪行为）
   *
   * [权威文档]
   *   - 主文档: 线上 docs/api-definition.md §5 Agents（briefing 端点小节）
   *   - 补充: plan captain-atom-crimson-avenger-rocket-dc.md §2.2 — swagger 装饰器
   *     与引导语钉死项
   *
   * [关键不变量]
   *   - @ApiOperation description 必须含引导语「REST 后端实现；MCP 消费者请用
   *     语义工具 get_my_briefing」——/mcp-full 会同时出现原子与语义双入口，
   *     description 是 LLM 选工具的决策依据（DX S-4）
   *   - me 响应必须经 pickPublicAgentFields 白名单 + omit avatarUrl/apiKeyPrefix
   *     （12 字段全集，controller spec 断言）
   *   - 全套 swagger 装饰器（@ApiOperation/@ApiQuery/@ApiResponse）——automcp
   *     从 OpenAPI 生成 full 入口工具描述，缺装饰器 = 原子工具无描述
   *
   * [关联代码]
   *   - agent.service.ts getMyBriefing — 编排实现（me 同源 + 12 字段投影 + 降级）
   *   - dto/briefing-query.dto.ts — 参数校验（statuses 拒绝 'all'/空值 → 400）
   *
   * [修改检查]
   *   □ 已读 [权威文档]，确认修改符合设计意图
   *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
   *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
   *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
   * =============================================================================
   */
  @UseGuards(JwtOrApiKeyGuard)
  @Get('me/briefing')
  @ApiOperation({
    summary: 'Agent startup briefing',
    description:
      'REST 后端实现；MCP 消费者请用语义工具 get_my_briefing。' +
      'One-shot startup briefing: current agent profile (whitelisted public fields, avatarUrl/apiKeyPrefix omitted), ' +
      'my active tasks (slim 12-field projection with hasBlockers), unread message counts across my topics, ' +
      'and recent activities (content truncated to maxContentLength with contentTruncated flag). ' +
      'Degradation semantics: unreadCounts/hasBlockers keys are OMITTED on non-critical-path failure ' +
      '(≠ no unread / no blockers); [] means truly no unread. ' +
      'statuses rejects "all" and empty values (400).',
  })
  @ApiQuery({
    name: 'statuses',
    required: false,
    description:
      'Active task statuses to include (default: backlog/todo/in_progress/blocked). ' +
      'Comma-separated; replaces the default set (not appends). ' +
      '"all" and empty values are rejected with 400.',
    example: 'todo,in_progress',
  })
  @ApiQuery({
    name: 'taskLimit',
    required: false,
    description: 'Max active tasks to return (1~50, default 20)',
    type: Number,
  })
  @ApiQuery({
    name: 'activityLimit',
    required: false,
    description: 'Number of recent activities to return (1~50, default 10)',
    type: Number,
  })
  @ApiQuery({
    name: 'maxContentLength',
    required: false,
    description:
      'Max chars per recent activity content before truncation ' +
      '(default 300; 0 = no truncation, full text; max 50000). Only affects recentActivities.',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Briefing returned successfully' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (e.g. statuses= empty, contains "all", or limits out of range)',
  })
  async getMyBriefing(@CurrentActor() actor: UnifiedActor, @Query() query: BriefingQueryDto) {
    const briefing = await this.agentService.getMyBriefing(actor, query);
    // 最后一道白名单裁剪（AGENT-FIELD-WHITELIST 教训）：me 走 pickPublicAgentFields
    // + omit avatarUrl/apiKeyPrefix（12 字段全集；service 已裁剪，此处幂等双保险，
    // 保证 controller 层 spec 可断言裁剪行为）
    const me = this.agentService.pickPublicAgentFields(briefing.me as Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { avatarUrl: _avatarUrl, apiKeyPrefix: _apiKeyPrefix, ...meWithoutAuth } = me;
    return { ...briefing, me: meWithoutAuth };
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get('directory')
  @ApiOperation({
    summary: 'List agent directory',
    description:
      'Public agent directory — returns whitelisted public fields of all active agents on the platform. Accessible via both JWT and API Key.' +
      'Only exposes id, name, type, avatarUrl, capabilities, status; never exposes owner, webhook, systemPrompt, or other sensitive configuration.',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Fuzzy search by agent name', type: String })
  @ApiQuery({ name: 'page', required: false, description: 'Page number, default 1', type: Number })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Items per page, default 20, max 100',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Directory returned successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed (e.g. pageSize exceeds 100)' })
  async directory(@Query() query: AgentDirectoryQueryDto) {
    return this.agentService.findDirectory(query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get agent', description: 'Get agent details by ID' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Agent details returned successfully' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'read');
    return this.agentService.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Patch(':id')
  @ApiOperation({ summary: 'Update agent', description: 'Update agent by ID' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    const updated = await this.agentService.update(id, dto);
    // 审计（Phase 2）：UPDATE + agent；actor=操作者（决策 2：controller 层，无签名波及）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.AGENT,
      entityId: updated.id,
      actorId: actor.id,
      newData: {
        agentId: updated.id,
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
      source: 'api',
    });
    return this.agentService.pickPublicAgentFields(updated as unknown as Record<string, unknown>);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete agent', description: 'Delete agent by ID' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'delete');
    await this.agentService.remove(id);
    // 审计（Phase 2）：DELETE + agent；newData 白名单 {agentId, name}（决策 6）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.AGENT,
      entityId: id,
      actorId: actor.id,
      newData: { agentId: id, name: agent.name },
      source: 'api',
    });
    return true;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/reset-key')
  @ApiOperation({ summary: 'Reset API key', description: 'Reset the primary API key for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'API key reset successfully' })
  async resetKey(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    const result = await this.agentService.resetKey(id);
    // 审计（Phase 2）：RESET_API_KEY + agent；newData 带新 key 前缀（决策 9 缓解，
    // 前缀 = rawKey 前 8 字符，非明文；完整 apiKey 红线禁止入审计字段）
    await this.auditService.log({
      action: AuditAction.RESET_API_KEY,
      entityType: AUDIT_ENTITY_TYPE.AGENT,
      entityId: id,
      actorId: actor.id,
      newData: { agentId: id, keyPrefix: result.apiKey?.substring(0, 8) },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/toggle')
  @ApiOperation({
    summary: 'Toggle agent',
    description: 'Toggle agent status between active and disabled',
  })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Agent toggled successfully' })
  async toggle(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    const result = await this.agentService.toggle(id);
    // 审计（Phase 2）：TOGGLE_AGENT + agent；newData 带切换后 status
    await this.auditService.log({
      action: AuditAction.TOGGLE_AGENT,
      entityType: AUDIT_ENTITY_TYPE.AGENT,
      entityId: id,
      actorId: actor.id,
      newData: { agentId: id, status: result.status },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/deletion-impact')
  @ApiOperation({
    summary: 'Get agent deletion impact',
    description:
      'Get deletion impact counts (open tasks, messages, topics, roundtable seats) for the delete-confirmation dialog. ' +
      'Permission = same as DELETE (caller is the one who would delete): aggregate counts are not exposed to read-only collaborators.',
  })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Deletion impact returned successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found or deleted' })
  async getDeletionImpact(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const agent = await this.agentService.findOne(id);
    // 与 DELETE 同权（R13）：调用者即删除者；'read' 会向只读协作者泄露聚合计数
    await this.permService.ensureCan(agent, actor, 'delete');
    return this.agentService.getDeletionImpact(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/stats')
  @ApiOperation({ summary: 'Agent stats', description: 'Get usage statistics for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Agent stats returned successfully' })
  async stats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    return this.agentService.stats(id, query);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/heartbeat')
  @ApiOperation({
    summary: 'Agent heartbeat',
    description: 'Send a heartbeat to update agent last active time',
  })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'Heartbeat recorded successfully' })
  async heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentHeartbeatDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    return this.agentService.heartbeat(id, dto);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Get(':id/keys')
  @ApiOperation({ summary: 'List agent API keys', description: 'List all API keys for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'API keys returned successfully' })
  async findKeys(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    return this.agentService.findKeys(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/keys')
  @ApiOperation({
    summary: 'Create agent API key',
    description: 'Create a new API key for an agent',
  })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'API key created successfully' })
  async createKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAgentKeyDto,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    const result = await this.agentService.createKey(id, dto);
    // 审计（Phase 2）：CREATE + api_key；newData {keyId, keyPrefix, agentId}（决策 9，
    // keyPrefix 非明文；apiKey 明文不入）
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: AUDIT_ENTITY_TYPE.API_KEY,
      entityId: result.id,
      actorId: actor.id,
      newData: {
        keyId: result.id,
        keyPrefix: result.keyPrefix,
        agentId: result.agentId,
      },
      source: 'api',
    });
    return result;
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id/keys/:keyId')
  @ApiOperation({ summary: 'Revoke agent API key', description: 'Revoke an API key for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiParam({ name: 'keyId', description: 'API Key ID', type: String })
  @ApiResponse({ status: 200, description: 'API key revoked successfully' })
  async revokeKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @CurrentActor() actor: UnifiedActor,
  ) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    // 审计在 service 层（revokeKey 内部持有 key 实体 → keyId/keyPrefix/agentId 齐备；
    // actor 从 controller 传入，决策 8 同构）
    return this.agentService.revokeKey(keyId, actor.id);
  }
}
