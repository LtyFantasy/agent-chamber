/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.1 (Account / Auth / Agent)
 *   - 补充: docs/api-definition.md §5. Agents
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（revokeKey service 层
 *     插桩 + 可选 operatorActorId，决策 8 同构——key 实体字段 controller 不可得）
 *
 * [踩坑索引] B-46(PATCH清空字段) B-47(topics返回null) D-3(controller预存失败) A3-1(remove事务吊销Key) A3-2(seatCount须jsonb路径)
 *
 * [铁律关联] #11(代理层透传) #12(文档联动) #23(jsonb查询集成覆盖)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   A3-1: remove() 若先软删后吊销 Key，revoke 失败会留下"agent 已删但 Key 仍活跃"的
 *         半完成态。修复：事务包裹（先批量 revoke 后软删），revoke 失败整体回滚，
 *         agent 未删可恢复。revokedReason='agent deleted' 为本次新增（resetKey 先例未设）。
 *         见 plans/rictor-swamp-thing-hulkling.md R15
 *   A3-2: deletion-impact 的 seatCount 必须 queryBuilder `config->>'bindActorId' = :id`
 *         写法——findOne/find 嵌套 jsonb 对象条件生成整列等值（永不命中，RT-SEAT-1 同类），
 *         mock 单测测不出 SQL 生成，需配打真实 PG 的 e2e。见 plans/rictor-swamp-thing-hulkling.md R13
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
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import {
  AgentStatus,
  ErrorCode,
  ActorType,
  AuditAction,
  TaskStatus,
  ParticipantStatus,
  SEAT_LIFECYCLE_STATUS,
} from '@agent-chamber/shared';
import type {
  PaginatedResponse,
  Agent as AgentDto,
  AgentDeletionImpact,
  TopicUnreadCount,
} from '@agent-chamber/shared';
import {
  CreateAgentDto,
  UpdateAgentDto,
  AgentHeartbeatDto,
  CreateAgentKeyDto,
  BriefingQueryDto,
  MyActivitiesQueryDto,
} from './dto';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { buildAvatarUrl } from '../avatars/avatar.constants';
import { TaskService } from '../task/task.service';
import { TaskDependencyService } from '../task/task-dependency.service';
import { UnifiedActor } from '../../common/types/actor.types';

/**
 * 活跃任务缺省状态集（getMyBriefing 的 active tasks 口径，与 MCP get_my_briefing
 * 缺省一致）。backlog 是平台的默认待办状态（看板默认列），必须纳入活跃任务，
 * 否则 Agent 会漏掉尚未开工的已分配任务。调用方可传 statuses 覆盖（替换而非追加）。
 */
const DEFAULT_ACTIVE_STATUSES: TaskStatus[] = [
  TaskStatus.BACKLOG,
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.BLOCKED,
];

/**
 * activeTasks 12 字段白名单（plan captain-atom-crimson-avenger-rocket-dc §2.3，
 * 与 MCP get-my-briefing.ts ACTIVE_TASK_KEPT_FIELDS 逐字段一致）。
 *
 * 只透传 Agent 消费模型需要的字段；description/list/board/customFields/position
 * 等多余键一律剔除。hasBlockers 为阶段 2 补查合并，不在本常量内。
 */
const ACTIVE_TASK_KEPT_FIELDS = [
  'id',
  'title',
  'status',
  'priority',
  'labels',
  'boardId',
  'boardName',
  'listId',
  'listName',
  'dueDate',
  'updatedAt',
] as const;

/**
 * 通用字段截断（truncateField 后端等价物，语义照 platform-mcp project.ts:49-62）。
 *
 * 语义：
 * - slice 裸截断，无省略号
 * - maxChars=0 是「不截断」哨兵，跳过
 * - 仅 typeof string 的字段参与——无 content 的 task 型 activity 天然豁免
 * - 标记命名统一 = `{field}Truncated`（content → contentTruncated），挂条目级
 *
 * @param obj      - 目标对象（原地修改）
 * @param field    - 要截断的字段名
 * @param maxChars - 截断上限（字符）；0 = 不截断返全文
 */
function truncateField(obj: Record<string, unknown>, field: string, maxChars: number): void {
  if (
    maxChars !== 0 &&
    typeof obj[field] === 'string' &&
    (obj[field] as string).length > maxChars
  ) {
    obj[field] = (obj[field] as string).slice(0, maxChars);
    obj[`${field}Truncated`] = true;
  }
}

@Injectable()
export class AgentService {
  constructor(
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(ApiKey)
    private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(RoundtableSeat)
    private seatRepo: Repository<RoundtableSeat>,
    private readonly auditService: AuditService,
    private readonly taskService: TaskService,
    private readonly taskDependencyService: TaskDependencyService,
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
      // 旧 is_active=true 等价于 status IN ('invited','active')（枚举插值，review-0831 任务 e013af33）
      const topicCounts = (await this.agentRepo.manager.query(
        `SELECT tp.participant_id as "agentId", COUNT(tp.topic_id) as count
         FROM topic_participants tp
         INNER JOIN topics t ON t.id = tp.topic_id
         WHERE tp.participant_id = ANY($1) AND tp.status IN ('${ParticipantStatus.INVITED}', '${ParticipantStatus.ACTIVE}') AND t.deleted_at IS NULL
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
       WHERE tp.participant_id = $1 AND tp.status IN ('${ParticipantStatus.INVITED}', '${ParticipantStatus.ACTIVE}') AND t.deleted_at IS NULL`,
      [agentId],
    );
    const total = parseInt(countResult[0].total, 10);

    // Get topics — 注意 topics 表没有 type/creator_type 列（B-47 修复）
    const items = await this.agentRepo.manager.query(
      `SELECT t.id, t.title, t.status, t.creator_id as "creatorId", t.created_at as "createdAt", t.updated_at as "updatedAt"
       FROM topics t
       INNER JOIN topic_participants tp ON tp.topic_id = t.id
       WHERE tp.participant_id = $1 AND tp.status IN ('${ParticipantStatus.INVITED}', '${ParticipantStatus.ACTIVE}') AND t.deleted_at IS NULL
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

  /**
   * 我的活动流（GET /agents/me/activities，接口瘦身二期：裸数组 → 标准分页信封）。
   *
   * 真分页实现：三表各取 page*pageSize 条（offset 0）→ 内存合并排序 → 按页切片；
   * total = 三表 count 之和（3 条 count 查询）。
   * 取舍注记：查询量随页号线性增长（无跨表游标分页），体量小可接受。
   * 合并排序必须带全序 tie-break (createdAt, type, id)——同 createdAt 跨表记录
   * 在页边界排序不稳定会重复/漏条（三表 SQL 已 select id）。
   * 顺带收益：旧 limit='abc' → NaN → SQL 500，DTO 校验后变 400（改进非回归）。
   *
   * @param agentId 当前 agent id
   * @param query page/pageSize（pageSize 优先；limit 仅在 pageSize 缺省时生效，别名映射）
   */
  async findMyActivities(agentId: string, query: MyActivitiesQueryDto) {
    const pageNum = Math.max(1, Math.floor(query.page ?? 1));
    const pageSizeNum = Math.min(Math.max(Math.floor(query.pageSize ?? query.limit ?? 20), 1), 100);
    const fetchLimit = pageNum * pageSizeNum;

    // 三表各取 page*pageSize 条（offset 0，与旧 limit 语义兼容：page=1 时等价）
    const [messages, tasks, comments, messageCount, taskCount, commentCount] = await Promise.all([
      this.agentRepo.manager.query(
        `SELECT 'message' as type, id, topic_id as "topicId", content, created_at as "createdAt"
         FROM messages
         WHERE sender_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT $2`,
        [agentId, fetchLimit],
      ),
      // Task entity has no creator_id
      this.agentRepo.manager.query(
        `SELECT 'task' as type, id, title, status, created_at as "createdAt", updated_at as "updatedAt"
         FROM tasks
         WHERE assignee_id = $1 AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT $2`,
        [agentId, fetchLimit],
      ),
      this.agentRepo.manager.query(
        `SELECT 'comment' as type, id, task_id as "taskId", content, created_at as "createdAt"
         FROM task_comments
         WHERE author_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT $2`,
        [agentId, fetchLimit],
      ),
      this.agentRepo.manager.query(
        `SELECT COUNT(*)::int AS total FROM messages WHERE sender_id = $1 AND deleted_at IS NULL`,
        [agentId],
      ),
      this.agentRepo.manager.query(
        `SELECT COUNT(*)::int AS total FROM tasks WHERE assignee_id = $1 AND deleted_at IS NULL`,
        [agentId],
      ),
      this.agentRepo.manager.query(
        `SELECT COUNT(*)::int AS total FROM task_comments WHERE author_id = $1 AND deleted_at IS NULL`,
        [agentId],
      ),
    ]);

    // 合并排序：createdAt DESC + 全序 tie-break (type, id)
    const all = [...messages, ...tasks, ...comments];
    all.sort(
      (
        a: { createdAt: string | Date; type: string; id: string },
        b: { createdAt: string | Date; type: string; id: string },
      ) => {
        const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        if (a.type !== b.type) return a.type < b.type ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      },
    );

    const total =
      parseInt(messageCount[0]?.total ?? '0', 10) +
      parseInt(taskCount[0]?.total ?? '0', 10) +
      parseInt(commentCount[0]?.total ?? '0', 10);
    const start = (pageNum - 1) * pageSizeNum;
    const items = all.slice(start, start + pageSizeNum);
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

  /**
   * 跨 topic 未读消息计数（GET /agents/me/unread，plan forge-jubilee-robin.md WS-B）。
   *
   * 语义与 TopicService.getUnread（topic.service.ts:1241-1309）逐条对齐：
   * - 无游标（last_read_message_id IS NULL）→ 该 topic 全量未删消息计数；
   * - 游标消息已软删 → 锚点 join 落空（a.deleted_at IS NULL）→ 降级全量；
   * - 自己发的消息计入（无 sender 过滤，与 getUnread 同语义）；
   * - 仅统计 status IN ('invited','active') 的参与行（left 排除，me/topics 同口径）；
   * - 已软删 topic 排除；只返回 unreadCount > 0 的 topic，最多 50 条
   *   （按未读数 DESC、updated_at DESC 排序，截断安全）。
   *
   * 为什么裸 SQL：跨 topic 聚合 + 行值比较 (created_at, id) 一条 SQL 精确复刻
   * getUnread 语义，避免 N+1 逐 topic 查询；行值比较在 DB 内做（微秒精度，
   * 避免 JS Date 毫秒截断误算锚点自身，同 getUnread :1287 注释）。
   *
   * @param actorId 当前 actor id
   * @returns TopicUnreadCount[]（无参与/全已读 → 空数组）
   */
  async findMyUnreadCounts(actorId: string): Promise<TopicUnreadCount[]> {
    return this.agentRepo.manager.query(
      `SELECT t.id AS "topicId", t.title AS "topicName", COUNT(m.id)::int AS "unreadCount"
       FROM topic_participants tp
       JOIN topics t ON t.id = tp.topic_id AND t.deleted_at IS NULL
       LEFT JOIN messages a ON a.id = tp.last_read_message_id AND a.deleted_at IS NULL
       LEFT JOIN messages m ON m.topic_id = tp.topic_id AND m.deleted_at IS NULL
         AND (a.id IS NULL OR (m.created_at, m.id) > (a.created_at, a.id))
       WHERE tp.participant_id = $1 AND tp.status IN ('${ParticipantStatus.INVITED}','${ParticipantStatus.ACTIVE}')
       GROUP BY t.id, t.title
       HAVING COUNT(m.id) > 0
       ORDER BY "unreadCount" DESC, t.updated_at DESC
       LIMIT 50`,
      [actorId],
    ) as Promise<TopicUnreadCount[]>;
  }

  /**
   * 从 Agent 对象中提取公开字段，过滤敏感配置信息（AGENT-FIELD-WHITELIST 白名单）。
   *
   * 公开字段：id, name, avatarUrl, status, ownerId, ownerName, description, descriptionSnippet,
   *          capabilities, createdAt, lastActiveAt, topicCount, messageCount, apiKeyPrefix
   * 过滤字段：webhookUrl, webhookSecret, systemPrompt, modelConfig, rateLimit,
   *          webhookEvents, webhookTimeoutMs, webhookRetryMax
   *
   * topicCount / messageCount 为 service 层附加的统计字段，一并保留。
   * apiKeyPrefix 用于列表页展示，仅在当前用户为所有者时暴露。
   * descriptionSnippet 为 service 层 findAll 剥离完整 description 后的摘要片段（列表场景）；
   * create/findOne 等单条路径无该字段（值为 undefined，JSON 序列化时被丢弃，无副作用）。
   *
   * 2026-08-29 从 controller 私有方法提升为 service 公开方法（plan
   * captain-atom-crimson-avenger-rocket-dc §2.3）：controller 与 getMyBriefing 共用，
   * 白名单是响应字段的最后一道裁剪——字段变更必须三处同改（service 产出 + 共享 DTO +
   * 白名单），并配 controller 层 spec 断言（service 层单测测不出白名单裁剪）。
   *
   * @param agent 原始 Agent 对象（实体或 service 产出对象）
   * @returns 仅含白名单字段的 plain object
   */
  pickPublicAgentFields(agent: Record<string, unknown>) {
    return {
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      status: agent.status,
      ownerId: agent.ownerId,
      ownerName: agent.ownerName,
      description: agent.description,
      descriptionSnippet: agent.descriptionSnippet,
      capabilities: agent.capabilities,
      createdAt: agent.createdAt,
      lastActiveAt: agent.lastActiveAt,
      topicCount: agent.topicCount,
      messageCount: agent.messageCount,
      apiKeyPrefix: agent.apiKeyPrefix,
    };
  }

  /**
   * =============================================================================
   * AGENT-CODE-HOOK | getMyBriefing（GET /agents/me/briefing）
   * =============================================================================
   * [功能概念]
   *   - Agent 启动简报：一次调用建立工作上下文（me + activeTasks + unreadCounts
   *     + recentActivities），REST 冷启动路径的核心端点
   *
   * [代码职责]
   *   - 编排下沉（v1.65 report_task_result 先例）：me 先行 → tasks/activities/unread
   *     三路并行 → blockers 补查；降级语义（键省略）在此实现
   *
   * [权威文档]
   *   - 主文档: 线上 docs/api-definition.md §5 Agents（briefing 端点小节）
   *   - 补充: plan captain-atom-crimson-avenger-rocket-dc.md §2.3 — 编排结构钉死项
   *
   * [关键不变量]
   *   - me 必须走 pickPublicAgentFields 白名单 + omit avatarUrl/apiKeyPrefix，
   *     禁止塞 findOne 整实体（webhookSecret/systemPrompt/modelConfig/rateLimit 会出网）
   *   - 12 字段投影 null 保留语义（!== undefined 判断，null 字段保留）
   *   - 降级 = 键省略：unread 失败 → unreadCounts 键省略；blockers 失败 →
   *     hasBlockers 键省略（不补 false——未知 ≠ 无 blocker）；不挂整体
   *   - 读操作不落审计行（与 digest/overview 一致）
   *
   * [关联代码]
   *   - task.service.ts findAll — tasks 数据源（statusPriority 排序 + board 可见性过滤）
   *   - task-dependency.service.ts hasBlockers — blockers 批量补查
   *   - packages/platform-mcp get-my-briefing.ts — MCP 侧编排（本方法后端化后
   *     退化为薄透传，成功路径输出契约逐字段不变）
   *
   * [修改检查]
   *   □ 已读 [权威文档]，确认修改符合设计意图
   *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
   *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
   *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
   * =============================================================================
   */
  async getMyBriefing(
    actor: UnifiedActor,
    query: BriefingQueryDto,
  ): Promise<{
    me: Record<string, unknown>;
    activeTasks: { items: Record<string, unknown>[]; total: number };
    unreadCounts?: TopicUnreadCount[];
    recentActivities: unknown[];
  }> {
    // 阶段 1：me 先行（tasks 的 assigneeId 依赖 me.id）。
    // me 数据源与 GET /agents/me 同源（findOne + pickPublicAgentFields 白名单，
    // PM R-6：统计字段 topicCount/messageCount 在场），再 omit avatarUrl/apiKeyPrefix
    // （人类 UI / 认证元数据，对 Agent 消费无价值，与 MCP Batch F 一致）。
    const agent = await this.findOne(actor.id);
    const me = this.pickPublicAgentFields(agent as unknown as Record<string, unknown>);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { avatarUrl: _avatarUrl, apiKeyPrefix: _apiKeyPrefix, ...meBriefing } = me;

    // 阶段 2：tasks / activities / unread 三路并行。
    // unread 是非关键路径：.catch 降级为 undefined（省略 unreadCounts 字段，防部署
    // 时序 404 拖垮整个 briefing，对齐 MCP 现状 get-my-briefing.ts:216-219）。
    // Promise.resolve 包裹：保证非 promise 返回值（如测试 mock）也不会同步抛 TypeError。
    const [tasksResult, recentActivities, unread] = await Promise.all([
      this.taskService.findAll(
        {
          assigneeId: actor.id,
          status: query.statuses ?? DEFAULT_ACTIVE_STATUSES,
          pageSize: query.taskLimit ?? 20,
          // WS-A 新增 opt-in 排序：in_progress > todo > blocked > backlog > 其余
          sort: 'statusPriority',
        },
        actor,
      ),
      this.findMyActivities(actor.id, { pageSize: query.activityLimit ?? 10 }),
      Promise.resolve(this.findMyUnreadCounts(actor.id)).catch(() => undefined),
    ]);

    // 阶段 3：blockers 补查（TaskDependencyService.hasBlockers，返回 Record<taskId, boolean>）。
    // 非关键路径：失败降级为 undefined（hasBlockers 省略，不挂主流程）；空 items 跳过。
    const taskItems = Array.isArray(tasksResult.items) ? tasksResult.items : [];
    let blockersMap: Record<string, boolean> | undefined;
    if (taskItems.length > 0) {
      blockersMap = await Promise.resolve(
        this.taskDependencyService.hasBlockers(
          taskItems
            .map((t) => (t as unknown as Record<string, unknown>).id as string)
            .filter(Boolean),
        ),
      ).catch(() => undefined);
    }

    // activeTasks：12 字段白名单投影 + hasBlockers 合并（map 缺失/降级时省略该键，
    // 不补 false——未知 ≠ 无 blocker）。null 保留语义：!== undefined 判断，null 字段保留。
    const items = taskItems.map((t) => {
      const task =
        t !== null && typeof t === 'object' ? (t as unknown as Record<string, unknown>) : {};
      const projected: Record<string, unknown> = {};
      for (const field of ACTIVE_TASK_KEPT_FIELDS) {
        if (task[field] !== undefined) {
          projected[field] = task[field];
        }
      }
      if (blockersMap !== undefined) {
        const hasBlockers = blockersMap[task.id as string];
        if (hasBlockers !== undefined) {
          projected.hasBlockers = hasBlockers;
        }
      }
      return projected;
    });

    // recentActivities：信封化后取 .items 数组，原形状透传（briefing 字段形状不变，
    // 仅数据源从裸数组变为信封），逐项截断 content（无 content 的 task 型条目
    // 经 truncateField 的 typeof string 检查天然豁免，不打 contentTruncated）。
    // maxContentLength 防御性钳制（DTO 已 400 拦截越界，此处兜底直接调 service 的场景）：
    // 负数 → 0（不截断），>50000 → 50000（防止放量返回超长字符串）。
    const maxContentLength = Math.max(0, Math.min(query.maxContentLength ?? 300, 50000));
    const activityItems = (
      recentActivities && Array.isArray((recentActivities as { items?: unknown[] }).items)
        ? (recentActivities as { items: Record<string, unknown>[] }).items.map((a) => {
            const item =
              a !== null && typeof a === 'object' ? { ...(a as Record<string, unknown>) } : {};
            truncateField(item, 'content', maxContentLength);
            return item;
          })
        : recentActivities
    ) as unknown[];

    return {
      me: meBriefing,
      // 只透传 {items, total}，砍分页信封其余键（page/pageSize/totalPages/hasNext/hasPrev）
      activeTasks: { items, total: tasksResult.total },
      ...(unread !== undefined ? { unreadCounts: unread } : {}),
      recentActivities: activityItems,
    };
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
      if (agent.actor && dto.avatar !== buildAvatarUrl(agent.actor.id)) {
        agent.actor.avatarSvg = null;
      }
    }
    if (dto.status !== undefined) agent.status = dto.status;

    const saved = await this.agentRepo.save(agent);
    return { ...saved };
  }

  /**
   * 删除 Agent（软删 + 事务化吊销 API Key，统一批 A3-1，R15）
   *
   * 事务包裹两步，顺序**先 revoke 后软删**（revoke 失败时 agent 未删可恢复；
   * 反序会留下"agent 已删但 Key 仍活跃"的半完成态）：
   *   1. 批量吊销全部未吊销 Key（set revokedAt + revokedReason，对齐 resetKey 写法，
   *      revokedReason 为本次新增——api_keys.revoked_reason 列早存在，resetKey 先例未设）；
   *   2. 软删：agent.deletedAt setter 转发 actor，save 级联写 actors 表。
   * revoke 失败 → 事务回滚，软删不发生。
   *
   * @param id agent id
   * @returns true
   * @throws NotFoundException agent 不存在或已软删（findOne 前置判空，事务外）
   */
  async remove(id: string) {
    const agent = await this.findOne(id);
    await this.agentRepo.manager.transaction(async (manager) => {
      // 1. 批量吊销：先 revoke 后软删（R15），revokedReason 便于审计回溯删除动作
      const now = new Date();
      await manager
        .createQueryBuilder()
        .update(ApiKey)
        .set({ revokedAt: now, revokedReason: 'agent deleted' })
        .where('agent_id = :id AND revoked_at IS NULL', { id })
        .execute();
      // 2. 软删标记在 actor 表上（agents 已不再持有 deleted_at），save 级联写 actors
      agent.deletedAt = now;
      await manager.save(agent);
    });
    return true;
  }

  /**
   * 删除影响面查询（统一批 A3-2，R13：权限 = 与 DELETE 同权，调用者即删除者）
   *
   * 删除确认弹窗展示用，返回四项聚合计数：
   * - openTaskCount：assignee = 该 agent 且 status 非 done/archived 的 tasks（未软删）
   * - messageCount：该 agent 发送的消息数（未软删）
   * - topicCount：participant status IN ('invited','active') 的话题数
   * - seatCount：⚠️ 铁律 #23——roundtable_seats 的 bindActorId 在 jsonb config 内，
   *   findOne/find 嵌套 jsonb 对象条件生成整列等值（永不命中），必须 queryBuilder
   *   `config->>'bindActorId' = :id` 路径写法；status != 'removed' 对齐座位唯一约束
   *   uq_roundtable_seats_topic_bind_actor（removed 软删豁免，移除后可重建）。
   *
   * @param id agent id（已软删/不存在 → findOne 抛 404，天然符合"已删 agent 无影响面可查"）
   * @returns AgentDeletionImpact 四项计数
   */
  async getDeletionImpact(id: string): Promise<AgentDeletionImpact> {
    // findOne 对软删 agent 抛 404（前置判空，铁律 #22）
    await this.findOne(id);

    // 前三个 count 走 raw SQL（参照 findAll :90-105 批量范式；单 agent 场景直接 COUNT）。
    // 状态字面量经 shared 枚举模板插值（受信代码无注入面；review-0831 任务 e013af33 收敛）
    const [openTaskCount, messageCount, topicCount] = await Promise.all([
      this.agentRepo.manager.query<Array<{ count: string }>>(
        `SELECT COUNT(id) as count FROM tasks
         WHERE assignee_id = $1 AND status NOT IN ('${TaskStatus.DONE}', '${TaskStatus.ARCHIVED}') AND deleted_at IS NULL`,
        [id],
      ),
      this.agentRepo.manager.query<Array<{ count: string }>>(
        `SELECT COUNT(id) as count FROM messages
         WHERE sender_id = $1 AND deleted_at IS NULL`,
        [id],
      ),
      this.agentRepo.manager.query<Array<{ count: string }>>(
        `SELECT COUNT(topic_id) as count FROM topic_participants
         WHERE participant_id = $1 AND status IN ('${ParticipantStatus.INVITED}', '${ParticipantStatus.ACTIVE}')`,
        [id],
      ),
    ]);

    // seatCount：jsonb 路径必须 queryBuilder（铁律 #23，见方法头注释）
    const seatCount = await this.seatRepo
      .createQueryBuilder('seat')
      .where("seat.config->>'bindActorId' = :id", { id })
      .andWhere(`seat.status != '${SEAT_LIFECYCLE_STATUS.REMOVED}'`)
      .getCount();

    return {
      openTaskCount: parseInt(openTaskCount[0]?.count ?? '0', 10),
      messageCount: parseInt(messageCount[0]?.count ?? '0', 10),
      topicCount: parseInt(topicCount[0]?.count ?? '0', 10),
      seatCount,
    };
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

  /**
   * 吊销指定 API Key（软吊销：revokedAt 置位）
   *
   * @param keyId 要吊销的 key id
   * @param operatorActorId 操作者 actor id（审计用；controller 传入，决策 8 同构）
   * @returns true
   * @throws NotFoundException key 不存在
   */
  async revokeKey(keyId: string, operatorActorId?: string) {
    const key = await this.apiKeyRepo.findOne({ where: { id: keyId } });
    if (!key)
      throw new NotFoundException({ message: 'API Key not found', code: ErrorCode.NOT_FOUND });
    key.revokedAt = new Date();
    await this.apiKeyRepo.save(key);
    // 审计（Phase 2）：DELETE + api_key；service 层（key 实体含 agentId/keyPrefix，
    // controller 不可得）；newData 白名单 {keyId, keyPrefix, agentId}（决策 9，非明文）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.API_KEY,
      entityId: keyId,
      actorId: operatorActorId ?? key.agentId,
      newData: { keyId: key.id, keyPrefix: key.keyPrefix, agentId: key.agentId },
      source: 'api',
    });
    return true;
  }
}
