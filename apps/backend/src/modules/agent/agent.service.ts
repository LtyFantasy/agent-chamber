/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *   - 补充: docs/api-definition.md §5. Agents
 *
 * [踩坑索引] B-46(PATCH清空字段) B-47(topics返回null) D-3(controller预存失败)
 *
 * [铁律关联] #11(代理层透传) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   B-46: PATCH /agents/me 只传 description 时 name 被清空为 null。
 *         根因：Object.assign(agent, dto) 将 undefined 属性覆盖为 null。
 *         修复：显式字段判断 + 修复字段映射(config→modelConfig, avatar→avatarUrl)。
 *         见 memory/2026-06-05.md
 *   B-47: GET /agents/me/topics 返回 null。SQL 查询了 topics.type 列但该列不存在。
 *         修复：移除 SQL 中不存在的列。见 memory/2026-06-05.md
 *   D-3: agent.controller.spec.ts 12 个预存失败（JwtService 依赖缺失）。
 *         状态：待修，不影响实际功能。见 PROJECT.md §5.5 D3
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { AgentStatus, ErrorCode, ActorType } from '@agent-chamber/shared';
import type { PaginatedResponse, Agent as AgentDto } from '@agent-chamber/shared';
import { CreateAgentDto, UpdateAgentDto, AgentHeartbeatDto, CreateAgentKeyDto } from './dto';

@Injectable()
export class AgentService {
  constructor(
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(ApiKey)
    private apiKeyRepo: Repository<ApiKey>,
  ) {}

  async findAll(query: {
    page?: number;
    pageSize?: number;
    status?: string;
    q?: string;
    ownerId?: string;
  }): Promise<PaginatedResponse<AgentDto>> {
    const { page = 1, pageSize = 20, status, q, ownerId } = query;
    const qb = this.agentRepo
      .createQueryBuilder('agent')
      .innerJoinAndSelect('agent.actor', 'actor')
      .where('actor.deleted_at IS NULL');

    if (ownerId) {
      qb.andWhere('agent.owner_id = :ownerId', { ownerId });
    }
    if (status && status !== 'all') {
      qb.andWhere('actor.status = :status', { status });
    }
    if (q) {
      qb.andWhere('(agent.name ILIKE :q OR agent.description ILIKE :q)', { q: `%${q}%` });
    }

    // 关联所有者用户及其 actor，仅选择必要字段用于聚合 ownerName
    qb.leftJoinAndSelect('agent.owner', 'owner').leftJoinAndSelect('owner.actor', 'ownerActor');

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .orderBy('actor.createdAt', 'DESC')
      .getManyAndCount();

    // 批量查询每个 Agent 的话题数、消息数以及当前生效 API Key 前缀（避免 N+1）
    const agentIds = items.map((a) => a.id);
    let topicCountMap = new Map<string, number>();
    let messageCountMap = new Map<string, number>();
    let keyPrefixMap = new Map<string, string>();

    if (agentIds.length > 0) {
      // topic_participants.is_active 已删除（ConsolidateMembership），改用 status 列：
      // 旧 is_active=true 等价于 status IN ('invited','active')
      const topicCounts = (await this.agentRepo.manager.query(
        `SELECT tp.participant_id as "agentId", COUNT(tp.topic_id) as count
         FROM topic_participants tp
         INNER JOIN topics t ON t.id = tp.topic_id
         WHERE tp.participant_id = ANY($1) AND tp.status IN ('invited', 'active') AND t.deleted_at IS NULL
         GROUP BY tp.participant_id`,
        [agentIds],
      )) as Array<{ agentId: string; count: string }>;

      const messageCounts = (await this.agentRepo.manager.query(
        `SELECT sender_id as "agentId", COUNT(id) as count
         FROM messages
         WHERE sender_id = ANY($1) AND deleted_at IS NULL
         GROUP BY sender_id`,
        [agentIds],
      )) as Array<{ agentId: string; count: string }>;

      const activeKeyPrefixes = (await this.apiKeyRepo.manager.query(
        `SELECT DISTINCT ON (agent_id) agent_id as "agentId", key_prefix as "keyPrefix"
         FROM api_keys
         WHERE agent_id = ANY($1) AND revoked_at IS NULL
         ORDER BY agent_id, created_at DESC`,
        [agentIds],
      )) as Array<{ agentId: string; keyPrefix: string }>;

      topicCountMap = new Map(topicCounts.map((r) => [r.agentId, parseInt(r.count, 10)]));
      messageCountMap = new Map(messageCounts.map((r) => [r.agentId, parseInt(r.count, 10)]));
      keyPrefixMap = new Map(activeKeyPrefixes.map((r) => [r.agentId, r.keyPrefix]));
    }

    const itemsWithStats = items.map((agent) => {
      // 不返回完整 owner / actor 嵌套对象，仅保留聚合后的 ownerName；
      // 同时剔除大文本 description，列表仅返回摘要片段（spec.md §7.4a）
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { owner, actor: _actor, description, ...agentWithoutOwner } = agent;
      void description;
      return {
        ...agentWithoutOwner,
        status: agent.status,
        ownerName: owner?.displayName ?? owner?.username ?? '-',
        topicCount: topicCountMap.get(agent.id) || 0,
        messageCount: messageCountMap.get(agent.id) || 0,
        apiKeyPrefix: keyPrefixMap.get(agent.id),
        descriptionSnippet: description?.slice(0, 200) ?? null,
        // createdAt/updatedAt/avatarUrl 是 Agent 实体上的 getter，依赖 actor 对象；
        // 解构后 actor 被剥离（spread 不拷贝原型 getter），必须显式赋值才能在
        // JSON 响应中保留——漏掉 avatarUrl 会导致列表页头像退化为文字 fallback。
        avatarUrl: agent.avatarUrl,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        lastActiveAt: agent.lastActiveAt,
      };
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: itemsWithStats,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  /**
   * 公开目录查询——仅返回白名单字段，任何 API Key 持有者均可访问。
   *
   * 白名单：id、name、type: 'agent'、avatarUrl、capabilities、status
   * 绝不暴露：ownerId、webhookUrl、webhookSecret、systemPrompt、modelConfig、
   *          rateLimit、lastActiveAt、统计数据
   * 排除软删 agent（actor.deletedAt IS NOT NULL）
   */
  async findDirectory(query: {
    q?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResponse<unknown>> {
    const { q, page = 1, pageSize = 20 } = query;
    const qb = this.agentRepo
      .createQueryBuilder('agent')
      .innerJoin('agent.actor', 'actor')
      .where('actor.deleted_at IS NULL');

    if (q) {
      qb.andWhere('agent.name ILIKE :q', { q: `%${q}%` });
    }

    // 显式 select 白名单字段，避免敏感字段泄露。
    // 注意：select 字符串引用的必须是真实列映射——status/avatarUrl 在 agent 表不存在，
    // 是 entity getter 代理到 actor 的兼容属性（见 agent.entity.ts 头部），QB 里必须写 'actor.xxx'；
    // 写 'agent.status' 会被原样拼进 SQL 导致 column does not exist（生产事故教训）。
    qb.select(['agent.id', 'agent.name', 'agent.capabilities', 'actor.status', 'actor.avatarUrl']);

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .orderBy('agent.name', 'ASC')
      .getManyAndCount();

    const directoryItems = items.map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: 'agent' as const,
      avatarUrl: agent.actor?.avatarUrl ?? null,
      capabilities: agent.capabilities,
      status: agent.status,
    }));

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: directoryItems,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  async findOne(id: string) {
    const agent = await this.agentRepo.findOne({
      where: { id },
      relations: { actor: true },
    });
    if (!agent || !agent.actor || agent.actor.deletedAt)
      throw new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND });
    return agent;
  }

  async updateMe(id: string, dto: UpdateAgentDto) {
    return this.update(id, dto);
  }

  async findMyTopics(agentId: string, query: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = query;
    const pageNum = Math.max(+page, 1);
    const pageSizeNum = Math.min(Math.max(+pageSize, 1), 100);
    const offset = (pageNum - 1) * pageSizeNum;

    // Count total
    // 注意：topic_participants.is_active 已在 ConsolidateMembership 迁移中删除，
    // 参与者状态单一事实源为 status 列（invited|active|left），旧 is_active=true 等价于 invited|active
    const countResult = await this.agentRepo.manager.query(
      `SELECT COUNT(*) as total FROM topics t
       INNER JOIN topic_participants tp ON tp.topic_id = t.id
       WHERE tp.participant_id = $1 AND tp.status IN ('invited', 'active') AND t.deleted_at IS NULL`,
      [agentId],
    );
    const total = parseInt(countResult[0].total, 10);

    // Get topics — 注意 topics 表没有 type/creator_type 列（B-47 修复）
    const items = await this.agentRepo.manager.query(
      `SELECT t.id, t.title, t.status, t.creator_id as "creatorId", t.created_at as "createdAt", t.updated_at as "updatedAt"
       FROM topics t
       INNER JOIN topic_participants tp ON tp.topic_id = t.id
       WHERE tp.participant_id = $1 AND tp.status IN ('invited', 'active') AND t.deleted_at IS NULL
       ORDER BY t.updated_at DESC
       LIMIT $2 OFFSET $3`,
      [agentId, pageSizeNum, offset],
    );

    const totalPages = Math.ceil(total / pageSizeNum);
    return {
      items,
      total,
      page: pageNum,
      pageSize: pageSizeNum,
      totalPages,
      hasNext: pageNum < totalPages,
      hasPrev: pageNum > 1,
    };
  }

  async findMyActivities(agentId: string, query: { limit?: string | number }) {
    const { limit = 20 } = query;
    const take = Math.min(Math.max(+limit, 1), 100);

    // Recent messages sent by this agent
    const messages = await this.agentRepo.manager.query(
      `SELECT 'message' as type, id, topic_id as "topicId", content, created_at as "createdAt"
       FROM messages
       WHERE sender_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, take],
    );

    // Recent tasks assigned to this agent (Task entity has no creator_id)
    const tasks = await this.agentRepo.manager.query(
      `SELECT 'task' as type, id, title, status, created_at as "createdAt", updated_at as "updatedAt"
       FROM tasks
       WHERE assignee_id = $1 AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT $2`,
      [agentId, take],
    );

    // Recent comments by this agent
    const comments = await this.agentRepo.manager.query(
      `SELECT 'comment' as type, id, task_id as "taskId", content, created_at as "createdAt"
       FROM task_comments
       WHERE author_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [agentId, take],
    );

    // Merge and sort by createdAt DESC
    const all = [...messages, ...tasks, ...comments];
    all.sort(
      (a: { createdAt: string | Date }, b: { createdAt: string | Date }) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return all.slice(0, take);
  }

  async create(ownerId: string, dto: CreateAgentDto) {
    const actor = new Actor();
    actor.type = ActorType.AGENT;
    actor.displayName = dto.name;
    actor.status = AgentStatus.ACTIVE;
    await this.agentRepo.manager.save(actor);

    const agent = this.agentRepo.create({
      ...dto,
      id: actor.id,
      actor,
      ownerId,
    });
    const savedAgent = (await this.agentRepo.save(agent)) as unknown as Agent;

    // Generate API key
    const rawKey = `ask_${crypto.randomBytes(24).toString('base64url')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 8);

    const apiKey = this.apiKeyRepo.create({
      agentId: savedAgent.id,
      keyHash,
      keyPrefix,
      name: 'Default Key',
      permissions: { scopes: ['read', 'write'] },
      createdBy: ownerId,
    });
    await this.apiKeyRepo.save(apiKey);

    return { ...savedAgent, apiKey: rawKey };
  }

  async update(id: string, dto: UpdateAgentDto) {
    const agent = await this.findOne(id);

    // 部分更新：只更新传入的字段，避免 undefined 覆盖已有值（B-46）
    if (dto.name !== undefined) agent.name = dto.name;
    if (dto.description !== undefined) agent.description = dto.description;
    if (dto.systemPrompt !== undefined) agent.systemPrompt = dto.systemPrompt;
    if (dto.capabilities !== undefined) agent.capabilities = dto.capabilities;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (dto.config !== undefined) agent.modelConfig = dto.config as any;
    if (dto.avatar !== undefined) {
      agent.avatarUrl = dto.avatar;
      // 联动清理：avatar 被清空或改为非本站 SVG 短链（外部 URL）时，
      // actors.avatar_svg 已成无引用的孤儿数据，一并清除，回落确定性生成头像
      if (agent.actor && dto.avatar !== `/api/v1/avatars/${agent.actor.id}.svg`) {
        agent.actor.avatarSvg = null;
      }
    }
    if (dto.status !== undefined) agent.status = dto.status;

    const saved = await this.agentRepo.save(agent);
    return { ...saved };
  }

  async remove(id: string) {
    const agent = await this.findOne(id);
    // 软删除标记在 actor 表上（agents 已不再持有 deleted_at）
    agent.deletedAt = new Date();
    await this.agentRepo.save(agent);
    return true;
  }

  async resetKey(id: string) {
    const agent = await this.findOne(id);
    // Revoke old keys
    await this.apiKeyRepo
      .createQueryBuilder()
      .update()
      .set({ revokedAt: new Date() })
      .where('agent_id = :id AND revoked_at IS NULL', { id })
      .execute();

    const rawKey = `ask_${crypto.randomBytes(24).toString('base64url')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 8);

    const apiKey = this.apiKeyRepo.create({
      agentId: agent.id,
      keyHash,
      keyPrefix,
      name: 'Reset Key',
      permissions: { scopes: ['read', 'write'] },
    });
    await this.apiKeyRepo.save(apiKey);

    return { apiKey: rawKey };
  }

  async toggle(id: string) {
    const agent = await this.findOne(id);
    agent.status = agent.status === AgentStatus.ACTIVE ? AgentStatus.DISABLED : AgentStatus.ACTIVE;
    await this.agentRepo.save(agent);
    return { id: agent.id, status: agent.status };
  }

  async stats(id: string, query: Record<string, unknown>) {
    const agent = await this.findOne(id);
    return {
      agentId: agent.id,
      period: query,
      messageCount: 0,
      topicCount: 0,
      taskCount: 0,
      avgResponseTime: 0,
      tokenUsage: 0,
      dailyActivity: [],
    };
  }

  async heartbeat(id: string, _dto: AgentHeartbeatDto) {
    const agent = await this.findOne(id);
    agent.lastActiveAt = new Date();
    await this.agentRepo.save(agent);
    return agent;
  }

  async findKeys(agentId: string) {
    return this.apiKeyRepo.find({
      where: { agentId },
      order: { createdAt: 'DESC' },
    });
  }

  async createKey(agentId: string, dto: CreateAgentKeyDto) {
    const agent = await this.findOne(agentId);
    const rawKey = `ask_${crypto.randomBytes(24).toString('base64url')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 8);

    const apiKey = this.apiKeyRepo.create({
      agentId: agent.id,
      keyHash,
      keyPrefix,
      name: dto.name,
      permissions: { scopes: ['read', 'write'] },
    });
    await this.apiKeyRepo.save(apiKey);
    return { ...apiKey, apiKey: rawKey };
  }

  async revokeKey(keyId: string) {
    const key = await this.apiKeyRepo.findOne({ where: { id: keyId } });
    if (!key)
      throw new NotFoundException({ message: 'API Key not found', code: ErrorCode.NOT_FOUND });
    key.revokedAt = new Date();
    await this.apiKeyRepo.save(key);
    return true;
  }
}
