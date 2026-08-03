/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Agent)
 *   - 补充: docs/api-definition.md §5. Agents
 *
 * [踩坑索引] D5(权限盲区) AGENT-VISIBILITY(Agent可见性)
 *
 * [铁律关联] #17(测试契约) #11(注释强制) #18(不变量检查)
 *
 * [详细踩坑]（最多 5 条）
 *   AGENT-VISIBILITY: 非 admin 用户 ownerId 过滤导致 Board/Task 中看不到其他用户 Agent 名称（显示 ?）。
 *       修复：非 admin 不再强制 ownerId 过滤，改为返回全部 Agent 并在 controller 层 pick 公开字段，
 *             过滤 webhookUrl/webhookSecret/systemPrompt/modelConfig/rateLimit 等敏感配置。
 *       见 .kimi/plans/winter-soldier-damage-jericho.md §问题 2
 *   D5: AgentController 原无任何权限检查，任何 JWT 用户可操作任意 Agent。
 *       修复：GET /agents 拒绝 Agent(API Key) 访问，findAll 按 ownerId 过滤，
 *             findOne/update/remove/resetKey/toggle/stats/heartbeat/keys/createKey/revokeKey
 *             全部加 ensureCan(agent, actor, 'write') 检查。
 *       见 memory/2026-06-05.md、memory/2026-06-06.md
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
  Req,
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
} from './dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { UserRole, ErrorCode, AgentStatus } from '@agent-chamber/shared';

@ApiTags('Agents')
@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly permService: PermissionService,
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
    @Req() req: unknown,
    @CurrentActor() actor: UnifiedActor,
  ) {
    // Agent（API Key）不能获取全部 Agent 列表
    const headers = (req as { headers: Record<string, string | undefined> }).headers;
    if (headers['x-api-key']) {
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
          this.pickPublicAgentFields(item as unknown as Record<string, unknown>),
        ),
      };
    }

    // admin：返回全部 Agent，但 apiKeyPrefix 仅对当前用户自己拥有的 Agent 暴露
    const result = await this.agentService.findAll(query);
    return {
      ...result,
      items: result.items.map((item) => {
        const publicAgent = this.pickPublicAgentFields(item as unknown as Record<string, unknown>);
        if (item.ownerId === actor.id) {
          return publicAgent;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { apiKeyPrefix: _, ...withoutPrefix } = publicAgent;
        return withoutPrefix;
      }),
    };
  }

  /**
   * 从 Agent 对象中提取公开字段，过滤敏感配置信息。
   *
   * 公开字段：id, name, avatarUrl, status, ownerId, ownerName, description, capabilities,
   *          createdAt, topicCount, messageCount, apiKeyPrefix
   * 过滤字段：webhookUrl, webhookSecret, systemPrompt, modelConfig, rateLimit,
   *          webhookEvents, webhookTimeoutMs, webhookRetryMax
   *
   * topicCount / messageCount 为 service 层附加的统计字段，一并保留。
   * apiKeyPrefix 用于列表页展示，仅在当前用户为所有者时暴露。
   */
  private pickPublicAgentFields(agent: Record<string, unknown>) {
    return {
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      status: agent.status,
      ownerId: agent.ownerId,
      ownerName: agent.ownerName,
      description: agent.description,
      capabilities: agent.capabilities,
      createdAt: agent.createdAt,
      topicCount: agent.topicCount,
      messageCount: agent.messageCount,
      apiKeyPrefix: agent.apiKeyPrefix,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create agent', description: 'Create a new agent' })
  @ApiResponse({ status: 201, description: 'Agent created successfully' })
  async create(@CurrentActor() actor: UnifiedActor, @Body() dto: CreateAgentDto) {
    const { apiKey, ...agent } = await this.agentService.create(actor.id, dto);
    return {
      ...this.pickPublicAgentFields(agent as unknown as Record<string, unknown>),
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
    return this.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
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
    return this.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
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
    description: 'Get recent activities (messages, tasks, comments) of the current agent',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Limit number of activities',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'Activities returned successfully' })
  async getMyActivities(
    @CurrentActor() actor: UnifiedActor,
    @Query() query: { limit?: string | number },
  ) {
    return this.agentService.findMyActivities(actor.id, query);
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
    return this.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
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
    return this.pickPublicAgentFields(updated as unknown as Record<string, unknown>);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete agent', description: 'Delete agent by ID' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'delete');
    return this.agentService.remove(id);
  }

  @UseGuards(JwtOrApiKeyGuard)
  @Post(':id/reset-key')
  @ApiOperation({ summary: 'Reset API key', description: 'Reset the primary API key for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID (UUID)', type: String })
  @ApiResponse({ status: 201, description: 'API key reset successfully' })
  async resetKey(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() actor: UnifiedActor) {
    const agent = await this.agentService.findOne(id);
    await this.permService.ensureCan(agent, actor, 'write');
    return this.agentService.resetKey(id);
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
    return this.agentService.toggle(id);
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
    return this.agentService.createKey(id, dto);
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
    return this.agentService.revokeKey(keyId);
  }
}
