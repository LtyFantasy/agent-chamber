/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §6.11
 *   - 补充: docs/architecture.md §3.2.2 (Topic / Message), docs/spec.md §3.2 MessageType
 *   - 圆桌: docs/roundtable-design.md §6/§7（seatLabel 单键透传 / wakePolicy effective 派生）
 *   - 活动日志插桩: plan shadowcat-sunspot-catwoman.md Phase 2（sendMessageInternal 是
 *     全仓唯一 messageRepo.create 点，roundtable 经它写系统消息 → service 层插桩决策 2；
 *     幂等 replay 不重复记；newData 白名单 {messageId, topicId, topicTitle}，content 黑名单）
 *   D5: canAccess() 已从 Service 删除，权限检查迁移到 Controller + TopicPolicy。
 *         Service 只做业务逻辑。见 memory/2026-06-05.md
 *
 * [踩坑索引] D-6(排序方向) B-1(type序列化) B-5(可见性控制) senderType映射 D5(权限迁移) B-50(列表权限过滤) B-55(QueryBuilder orderBy select 风险) E3(tie-break全序+markAsRead防回退+upsert修复) E3-fix(游标DB内行值比较+统计trigger单一事实源) OWNER-PROXY(sendMessage放行) JOINED-AT(joinedAt语义+upsert覆盖role) SYS-PARTICIPANT(参与者列表过滤system哨兵) R1(公共解析收口) A2.5(写入口assertActorUsable) R11(update只拦新增id) UNREAD-CURSOR(发送即已读+join/邀请游标初始化)
 *
 * [铁律关联] #21(双层校验) #22(findOne 判空) #11(注释) #17(测试契约) #18(不变量检查) #4(文档优先) #12(文档联动)
 *
 * [详细踩坑]（最多 5 条，按严重/最近排序）
 *   UNREAD-CURSOR: 游标只在 markAsRead/digest 推进——自己发的消息计入自己未读、
 *       join/邀请后全历史未读（2026-08-28 Kimi-Kairos 反馈采纳）。修复（v1.69）：
 *       发送即已读（AUTO_JOIN_SQL $3 单调推进，含旧锚点软删 NOT EXISTS 逃生口，
 *       与 markAsRead 防回退语义对齐）+ join/邀请建行游标初始化（re-join 保留原
 *       游标=离开期间未读）；行值比较全部 DB 内完成（E3-fix 精度教训）。
 *       见 .kimi/plans/unread-cursor-semantics.md。
 *   A2.5: 写入口（inviteAgent/addEditor/create/update 的 invitedAgentIds）统一走
 *       ActorProfileService.assertActorUsable（存在+未软删两态，404 AGENT_NOT_FOUND）。
 *       ⚠️ R11: update 的 invitedAgentIds 是完整替换语义，一刀切校验会让「存量含已删
 *       agent 的话题」永远无法保存——只拦不在 participants 表的新增 id（含 left 状态
 *       跳过）；uninvite 后 re-invite 已删 agent 漏检为声明边界。2026-08-26 统一批 A2.5。
 *   R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——withDeleted 只解除过滤不选
 *       列。本文件所有 actor 投影（消息 sender/参与者）一律经 ActorProfileService.resolveProfiles
 *       取 deletedAt/type/name，禁止散落 queryBuilder 或自建 actors 查询（收口见
 *       common/services/actor-profile.service.ts，契约 docs/spec.md §1）。2026-08-26 统一批 A2。
 *   SYS-PARTICIPANT: findOneWithParticipants 把 system 哨兵（公告通道 sendSystemMessage 为
 *         私密桌 join 的 actor）当成员返回——参与者面板出现 "Agent · member" 且计数虚高。
 *         修复：resolveActorProfiles 后按 profile.type===SYSTEM 过滤，只动返回数组不动 DB 行
 *         （哨兵 join 是公告通道需要）与 invitedAgentIds 派生。见 memory/2026-08-08.md。
 *   JOINED-AT: joined_at 用 @CreateDateColumn（NOT NULL + DB DEFAULT NOW()），invited 行插入即写邀请时间；
 *          sendMessage 的 TypeORM upsert DO UPDATE 每条消息把 joined_at 刷成消息时间且把 moderator 降级为 member。
 *          修复：joined_at 改可空 + 语义=最近一次激活时间（invited NULL/激活写入/re-join 刷新），DB 加
 *          CHECK (status != 'active' OR joined_at IS NOT NULL)；sendMessage 自动 join 改原生 SQL 原子条件
 *          upsert（role 不进 SET 子句，仅 invited/left 行激活刷新 joinedAt）。
 *   E3-fix: JS Date 只有毫秒精度，PG timestamptz 是微秒——读回 JS 再绑回 SQL 比较会
 *         把锚点消息自身误算进增量；message_count 应用层 +1 与 trigger
 *         trg_topics_message_stats 双写导致计数翻倍。
 *         修复：游标/防回退全部改 DB 内行值子查询比较；统计只由 trigger 维护。
 *         见 memory/2026-07-26.md §E3。
 *   B-55: TypeORM 0.3.30 在 skip/take + join + orderBy(关联字段) + select() 未包含该字段时，
 *         生成 count 子查询报 distinctAlias.xxx does not exist。修复：显式 select orderBy 依赖字段
 *         或改用 leftJoinAndSelect。见 memory/2026-07-02.md §B-55。
 *   D-6: getMessages 默认 ASC 返回最早消息，导致最新消息不可见。
 *         修复：根据参数区分 DESC/ASC + reverse。见 memory/2026-05-24.md
 *   B-50: Topic/Board 列表接口在 Controller 层过滤，导致分页 total 与 items 不一致。
 *         修复：findAll 接收 actor，在 Service 层 QueryBuilder 加 IN 过滤，空白名单直接
 *         返回空分页，保持 total 与 items 同源。见 Plan §2.1 / §2.2。
 *
 *   OWNER-PROXY: v1.37 sendMessage private 硬校验放行条件扩展为
 *       senderRole===ADMIN || owner 代理 || ACTIVE participant（行为变更，见 docs/architecture.md §7.2）；
 *       admin / agent 短路不触发 owner 代理查询。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Message } from '../../database/entities/message.entity';
import { User } from '../../database/entities/user.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Board } from '../../database/entities/board.entity';
import { Task } from '../../database/entities/task.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import {
  TopicStatus,
  ActorType,
  MessageType,
  Visibility,
  TaskStatus,
  ErrorCode,
  EventType,
  ParticipantStatus,
  TopicParticipantRole,
  UserRole,
} from '@agent-chamber/shared';
import type { TopicDetail } from '@agent-chamber/shared';
import {
  CreateTopicDto,
  UpdateTopicDto,
  SendMessageDto,
  UpdateAgendaDto,
  MarkAsReadDto,
  GetMessagesQueryDto,
  UnreadQueryDto,
} from './dto';
import { EventService } from '../event/event.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { ResourceValidator } from '../../common/resource-validator';
import { UnifiedActor } from '../../common/types/actor.types';
import { ActorProfileService, ActorProfile } from '../../common/services/actor-profile.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@agent-chamber/shared';

/**
 * sendMessage 自动 join 的原子条件 upsert（v1.40 joinedAt 语义修复）。
 *
 * 为什么用原生 SQL 而非 TypeORM upsert：TypeORM 的 DO UPDATE 会覆盖
 * role/status/joined_at 全部列——每条消息都会把 joinedAt 刷成消息时间，
 * 且把 moderator 降级为 member。原生 SQL 的 ON CONFLICT DO UPDATE 只
 * 条件更新 status/joined_at，role 不出现在 SET 子句（moderator 不被降级，
 * active 行 joinedAt 不被刷新）。
 *
 * 状态机语义（与 join() re-join 一致）：
 * - 新行（INSERT 分支）：role='member', status='active', joined_at=now()
 * - invited 行发消息 → 隐式激活（status→active, joined_at→now()）
 * - left 行发消息 → 视同重新加入（status→active, joined_at→now()）
 * - active 行 → 两列均保持原值（不刷新 joinedAt）
 *
 * 原子性：单条 INSERT ... ON CONFLICT 语句，并发首消息/并发幂等重试
 * 不会触发 PK (topic_id, participant_id) 冲突 23505（禁止 find/save
 * 的读-改-写竞态）。事件一致性：本路径只发 NEW_MESSAGE，不新增
 * AGENT_JOINED 事件（隐式激活不广播加入事件，与历史行为一致）。
 *
 * 发送即已读（v1.69 未读游标语义修正，Kimi-Kairos 反馈采纳）：$3 = 本次
 * 新消息 id，发送者自己的 last_read_message_id 随发送单调推进——
 * 自己发的消息不再计入自己未读（IM 通用语义）。INSERT 分支（首发消息的
 * 新参与者）游标直接落 $3，无历史洪水。ON CONFLICT 四分支 CASE：
 * ① 游标 NULL → 推进；② 旧锚点消息已软删（NOT EXISTS 逃生口，与
 * markAsRead「rows 为空 → 允许推进」语义对齐，否则行值比较得 NULL 落入
 * ELSE，悬空游标永不自愈 = 永久全量未读）→ 推进；③ DB 内行值比较
 * (created_at, id) 严格更新 → 推进（沿用 markAsRead 精度教训：禁止
 * JS Date 比较，微秒精度只在 DB 内可靠）；④ ELSE 保留旧值（防同一
 * 发送者并发两条消息时游标回退）。仅推进发送者本人行，不影响其他参与者。
 */
const AUTO_JOIN_PARTICIPANT_SQL = `
  INSERT INTO topic_participants (topic_id, participant_id, role, status, joined_at, last_read_message_id)
  VALUES ($1, $2, 'member', 'active', now(), $3)
  ON CONFLICT (topic_id, participant_id) DO UPDATE SET
    status = CASE WHEN topic_participants.status IN ('invited', 'left')
                  THEN 'active' ELSE topic_participants.status END,
    joined_at = CASE WHEN topic_participants.status IN ('invited', 'left')
                     THEN now() ELSE topic_participants.joined_at END,
    last_read_message_id = CASE
      WHEN topic_participants.last_read_message_id IS NULL THEN $3
      WHEN NOT EXISTS (SELECT 1 FROM messages o
                       WHERE o.id = topic_participants.last_read_message_id
                         AND o.deleted_at IS NULL) THEN $3
      WHEN (SELECT (n.created_at, n.id) FROM messages n WHERE n.id = $3)
         > (SELECT (o.created_at, o.id) FROM messages o
            WHERE o.id = topic_participants.last_read_message_id) THEN $3
      ELSE topic_participants.last_read_message_id
    END
`;

@Injectable()
export class TopicService {
  constructor(
    @InjectRepository(Topic)
    private topicRepo: Repository<Topic>,
    @InjectRepository(TopicParticipant)
    private participantRepo: Repository<TopicParticipant>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Agent)
    private agentRepo: Repository<Agent>,
    @InjectRepository(Actor)
    private actorRepo: Repository<Actor>,
    private readonly eventService: EventService,
    @InjectRepository(Board)
    private boardRepo: Repository<Board>,
    @InjectRepository(Task)
    private taskRepo: Repository<Task>,
    private readonly accessQuery: AccessQueryService,
    private readonly resourceValidator: ResourceValidator,
    private readonly dataSource: DataSource,
    private readonly ownerProxy: OwnerProxyService,
    private readonly actorProfileService: ActorProfileService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * 批量解析 Actor 类型
   * 业务表中的 *_type 列即将删除，加载实体时该字段为 undefined，
   * 需要通过 actors 表重新推导类型。
   * 统一批 A1 收敛：委托 ActorProfileService.resolveProfiles 取 type（withDeleted 查询，
   * 覆盖软删 actor——原 actorRepo.find 默认过滤软删，软删 actor 会漏判 fallback 到 HUMAN）。
   */
  private async resolveActorTypes(actorIds: string[]): Promise<Map<string, ActorType>> {
    const profiles = await this.actorProfileService.resolveProfiles(actorIds);
    return new Map([...profiles].map(([id, p]) => [id, p.type]));
  }

  /**
   * 批量聚合 Actor 公开信息（类型、显示名、头像、描述）
   * 用于参与者列表、消息发送者等场景的响应组装。
   * 统一批 A1 收敛：委托 ActorProfileService（返回元素新增 deletedAt 信号；
   * 软删 actor 解析出真名 + 真实 type，不再是 'System'/被过滤——契约变更见
   * docs/spec.md §1；真孤儿不进 map，由调用方兜底）。
   */
  private async resolveActorProfiles(actorIds: string[]): Promise<Map<string, ActorProfile>> {
    return this.actorProfileService.resolveProfiles(actorIds);
  }

  /** 原始查询：按 ID 查找 Topic，不做权限检查 */
  async findById(id: string): Promise<Topic> {
    const topic = await this.topicRepo.findOne({ where: { id } });
    if (!topic) {
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });
    }
    return topic;
  }

  /**
   * 列表查询：在 Service 层按 Actor 权限做 IN 过滤，保证分页 total 与 items 同源。
   * @param query - 分页/状态/搜索条件
   * @param actor - 当前统一身份；Admin 不过滤，非 Admin 用白名单 IN 过滤
   */
  async findAll(
    query: { page?: number; pageSize?: number; status?: string; q?: string },
    actor?: UnifiedActor,
  ) {
    const { page = 1, pageSize = 20, status = 'active', q } = query;

    const accessibleTopicIds = await this.accessQuery.getAccessibleTopicIds(actor);
    // 非 Admin 且白名单为空时直接返回空分页，避免生成空 IN () 导致 SQL 错误
    if (accessibleTopicIds && accessibleTopicIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: +page,
        pageSize: +pageSize,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
    }

    const qb = this.topicRepo.createQueryBuilder('topic').where('topic.deleted_at IS NULL');

    if (accessibleTopicIds) {
      qb.andWhere('topic.id IN (:...accessibleTopicIds)', { accessibleTopicIds });
    }
    if (status && status !== 'all') {
      qb.andWhere('topic.status = :status', { status });
    }
    if (q) {
      qb.andWhere('(topic.title ILIKE :q OR topic.description ILIKE :q)', { q: `%${q}%` });
    }

    const [items, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .orderBy('topic.updatedAt', 'DESC')
      .getManyAndCount();

    // 从 settings JSONB 提取 visibility 到顶层字段，剔除大文本 description（spec.md §7.4a）
    const itemsWithVisibility = items.map((item) => {
      const { description, ...rest } = item;
      void description;
      return {
        ...rest,
        visibility: item.settings?.visibility,
        descriptionSnippet: description?.slice(0, 200) ?? null,
      };
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      items: itemsWithVisibility,
      total,
      page: +page,
      pageSize: +pageSize,
      totalPages,
      hasNext: +page < totalPages,
      hasPrev: +page > 1,
    };
  }

  /** 查询 Topic 及其参与者（不做权限检查，由 Controller 层负责） */
  async findOneWithParticipants(id: string): Promise<TopicDetail> {
    const topic = await this.topicRepo.findOne({
      where: { id },
      relations: ['participants'],
    });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });

    // 批量查询参与者对应的 Actor 公开信息（participantType 已从 DB 列转为内存字段）
    const activeParticipants = (topic.participants || []).filter(
      (p) => p.status !== ParticipantStatus.LEFT,
    );
    const participantIds = activeParticipants.map((p) => p.participantId);
    const profileMap = await this.resolveActorProfiles(participantIds);

    // 过滤 system 哨兵参与者（公告通道实现细节，不是成员）：sendSystemMessage 为私密桌
    // 自动 join 的 system 哨兵（SYSTEM_ACTOR_ID，roundtable.service 播种）不应出现在参与者
    // 面板/计数里——RT-ROUTE 系列（失败回执/安全阀/审批公告）全部复用该通道，同源设计。
    // 同时过滤真孤儿（R12：公共服务对 actors 表无行的 id 不进 map）——两种非成员
    // （哨兵/孤儿）统一 `!profile || profile.type === SYSTEM` 挡在返回数组外。
    // 只过滤返回的 participants 数组：不动 DB 行（哨兵 join 是公告通道需要，保留）、
    // 不动 invitedAgentIds 派生（其按 topic.participants 原样派生，与 participants 无关）。
    const participants = activeParticipants
      .filter((p) => {
        const profile = profileMap.get(p.participantId);
        return profile !== undefined && profile.type !== ActorType.SYSTEM;
      })
      .map((p) => {
        const profile = profileMap.get(p.participantId) as ActorProfile;
        return {
          participantId: p.participantId,
          // 非 HUMAN 即 'agent'：SYSTEM 与真孤儿已在上方过滤，此分支不会有漏网
          participantType:
            profile.type === ActorType.HUMAN ? ('human' as const) : ('agent' as const),
          name: profile.name,
          avatarUrl: profile.avatarUrl ?? null,
          description: profile.description ?? null,
          role: p.role,
          status: p.status as ParticipantStatus,
          joinedAt: p.joinedAt,
          // 软删信号透传：非空 = 该参与者已删除，name 仍可显示（契约 docs/spec.md §1）
          deletedAt: profile.deletedAt ? profile.deletedAt.toISOString() : null,
        };
      });

    // 从 participants 派生 invitedAgentIds（status='invited' 且类型为 agent 的行）
    const invitedAgentIds = (topic.participants || [])
      .filter((p) => p.status === ParticipantStatus.INVITED)
      .map((p) => p.participantId);

    // 查询关联 Board/Task 计数与最近 5 项（防膨胀）
    // Task 不再存储 topic_id，改为三表 join（task→list→board）派生
    const taskQb = () =>
      this.taskRepo
        .createQueryBuilder('task')
        .innerJoin('task.list', 'list')
        .innerJoin(Board, 'board', 'board.id = list.board_id')
        .where('board.topic_id = :id', { id })
        .andWhere('task.deleted_at IS NULL');
    const [boards, tasks, boardCount, taskCount, openTaskCount, doneTaskCount] = await Promise.all([
      this.boardRepo.find({ where: { topicId: id }, order: { createdAt: 'DESC' }, take: 5 }),
      // orderBy 必须用实体属性名 createdAt（B-51/B-55：take+join+orderBy 列名触发
      // TypeORM 0.3.x createOrderByCombinedWithSelectExpression bug，生产 500 教训）
      taskQb().orderBy('task.createdAt', 'DESC').take(5).getMany(),
      this.boardRepo.count({ where: { topicId: id } }),
      taskQb().getCount(),
      taskQb()
        .andWhere('task.status IN (:...st)', {
          st: [
            TaskStatus.BACKLOG,
            TaskStatus.TODO,
            TaskStatus.IN_PROGRESS,
            TaskStatus.REVIEW,
            TaskStatus.BLOCKED,
          ],
        })
        .getCount(),
      taskQb().andWhere('task.status = :done', { done: TaskStatus.DONE }).getCount(),
    ]);

    // 圆桌唤醒策略 effective 值（仅 kind='roundtable' 时输出，normal topic 缺省）：
    // settings.wakePolicy 显式值优先，缺省 → 'mention'。与 roundtable.service
    // resolveWakePolicy 同规（真相源，其还处理 normal→broadcast 兜底，本字段只服务
    // web 圆桌 UI 提示，故 normal 不输出）——设计 docs/roundtable-design.md §6。
    const settings = topic.settings as Record<string, unknown> | null | undefined;
    const wakePolicy = topic.kind === 'roundtable' ? settings?.wakePolicy : undefined;
    const effectiveWakePolicy =
      wakePolicy === 'mention' || wakePolicy === 'broadcast' ? wakePolicy : 'mention';

    return {
      ...topic,
      invitedAgentIds,
      ...(topic.kind === 'roundtable' ? { wakePolicy: effectiveWakePolicy } : {}),
      participants,
      boardCount,
      taskCount,
      openTaskCount,
      doneTaskCount,
      boards: (boards ?? []).map((b) => ({ id: b.id, name: b.name, taskCount: b.taskCount })),
      tasks: (tasks ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
      })),
    };
  }

  async create(creatorId: string, creatorType: ActorType, dto: CreateTopicDto) {
    const visibility = dto.visibility ?? dto.config?.visibility ?? Visibility.OPEN;
    const invitedAgentIds = dto.invitedAgentIds || dto.config?.invitedAgentIds || [];

    // 批量校验 invitedAgentIds 中所有 Agent 存在且未软删（Phase 2 + 统一批 A2.5：
    // create 一刀切校验全部 id——契约 docs/spec.md §1 规则 6：存量历史保留，新增引用禁止）
    if (invitedAgentIds.length > 0) {
      await Promise.all(
        [...new Set(invitedAgentIds)].map((id) => this.actorProfileService.assertActorUsable(id)),
      );
    }

    const { clientRequestId, ...createDto } = dto;

    // kind 是实体列（不是 settings 键）：从 config 解构出来单独落列；
    // 其余配置（含 wakePolicy）原样铺进 settings jsonb
    const { kind: kindInput, ...restConfig } = createDto.config ?? {};
    const kind = kindInput ?? 'normal';

    const settings: Record<string, unknown> = {
      allow_agent_proposal: true,
      vote_threshold: 3,
      visibility,
      ...restConfig,
    };
    // 圆桌唤醒策略缺省 'mention'（设计 docs/roundtable-design.md §6 默认：仅 @唤醒，
    // 新桌默认省钱安全）；普通桌 wakePolicy 原样透传（零感知，无路由逻辑消费该值）
    if (kind === 'roundtable' && settings.wakePolicy === undefined) {
      settings.wakePolicy = 'mention';
    }

    // ── 无幂等键：走原路径（零开销） ──
    if (!clientRequestId) {
      const topic = this.topicRepo.create({
        title: createDto.title,
        description: createDto.description,
        agenda: createDto.agenda,
        creatorId,
        creatorType,
        status: TopicStatus.ACTIVE,
        kind,
        settings,
      });
      const savedTopic = (await this.topicRepo.save(topic)) as unknown as Topic;

      // 审计（Phase 2）：CREATE + topic；actor=creator；newData 白名单
      // {topicId, title, visibility?}（决策 6；description/agenda/settings 不入）
      await this.auditService.log({
        action: AuditAction.CREATE,
        entityType: 'topic',
        entityId: savedTopic.id,
        actorId: creatorId,
        newData: {
          topicId: savedTopic.id,
          title: savedTopic.title,
          ...(savedTopic.settings?.visibility !== undefined && {
            visibility: savedTopic.settings.visibility,
          }),
        },
        source: 'api',
      });

      // Add creator as participant（creator 即 active，显式写 joinedAt；
      // DB DEFAULT NOW() 已移除，active 行必须由应用写入 joinedAt）
      const participant = this.participantRepo.create({
        topicId: savedTopic.id,
        participantId: creatorId,
        participantType: creatorType,
        role: TopicParticipantRole.MODERATOR,
        status: ParticipantStatus.ACTIVE,
        joinedAt: new Date(),
      });
      await this.participantRepo.save(participant);

      // Insert invited agent rows with status='invited', role='member'
      // invited 行有意不写 joinedAt（语义：受邀时 NULL，激活时才写入）
      if (invitedAgentIds.length > 0) {
        const rows = [...new Set(invitedAgentIds)]
          .filter((agentId) => agentId !== creatorId)
          .map((agentId) =>
            this.participantRepo.create({
              topicId: savedTopic.id,
              participantId: agentId,
              role: TopicParticipantRole.MEMBER,
              status: ParticipantStatus.INVITED,
            }),
          );
        if (rows.length > 0) {
          await this.participantRepo.save(rows);
        }
      }

      return savedTopic;
    }

    // ── 有幂等键：事务保护（创建话题 + 写幂等记录） ──
    try {
      const { savedTopic } = await this.dataSource.transaction(async (manager) => {
        const topicRepo = manager.getRepository(Topic);
        const topic = topicRepo.create({
          title: createDto.title,
          description: createDto.description,
          agenda: createDto.agenda,
          creatorId,
          creatorType,
          status: TopicStatus.ACTIVE,
          kind,
          settings,
        });
        const saved: Topic = (await topicRepo.save(topic)) as unknown as Topic;

        // 写入幂等记录
        await manager.getRepository(IdempotencyRecord).save({
          actorId: creatorId,
          clientRequestId,
          entityType: 'topic',
          entityId: saved.id,
        });

        // 创建者自动成为参与者（在事务内）；creator 即 active，显式写 joinedAt
        const participantRepo = manager.getRepository(TopicParticipant);
        const participant = participantRepo.create({
          topicId: saved.id,
          participantId: creatorId,
          participantType: creatorType,
          role: TopicParticipantRole.MODERATOR,
          status: ParticipantStatus.ACTIVE,
          joinedAt: new Date(),
        });
        await participantRepo.save(participant);

        // 受邀 Agent 行（invited 行有意不写 joinedAt，激活时才写入）
        if (invitedAgentIds.length > 0) {
          const rows = [...new Set(invitedAgentIds)]
            .filter((agentId) => agentId !== creatorId)
            .map((agentId) =>
              participantRepo.create({
                topicId: saved.id,
                participantId: agentId,
                role: TopicParticipantRole.MEMBER,
                status: ParticipantStatus.INVITED,
              }),
            );
          if (rows.length > 0) {
            await participantRepo.save(rows);
          }
        }

        return { savedTopic: saved };
      });

      // 审计（Phase 2）：幂等键路径的真实写成功后记（replay 分支不记——决策 2
      // 「幂等 replay 不重复记」）；载荷与无幂等键路径一致
      await this.auditService.log({
        action: AuditAction.CREATE,
        entityType: 'topic',
        entityId: savedTopic.id,
        actorId: creatorId,
        newData: {
          topicId: savedTopic.id,
          title: savedTopic.title,
          ...(savedTopic.settings?.visibility !== undefined && {
            visibility: savedTopic.settings.visibility,
          }),
        },
        source: 'api',
      });

      return savedTopic;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key') {
        // 幂等重放
        const idempotencyRepo = this.dataSource.getRepository(IdempotencyRecord);
        const record = await idempotencyRepo.findOne({
          where: { actorId: creatorId, clientRequestId },
        });
        if (!record) {
          throw err;
        }
        const existing = await this.topicRepo.findOne({ where: { id: record.entityId } });
        if (!existing) {
          throw new NotFoundException({
            message: 'Topic not found for idempotent replay',
            code: ErrorCode.TOPIC_NOT_FOUND,
          });
        }
        return { ...existing, idempotentReplay: true };
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateTopicDto) {
    const topic = await this.topicRepo.findOne({ where: { id } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });
    if (topic.status === TopicStatus.CLOSED) {
      throw new BadRequestException({ message: 'Topic is closed', code: ErrorCode.TOPIC_CLOSED });
    }

    // 处理 invitedAgentIds 更新：set invited set via participant table
    if (dto.invitedAgentIds !== undefined) {
      const newSet = new Set(dto.invitedAgentIds);

      // Get current invited participant IDs (status='invited')
      const currentInvited = await this.participantRepo.find({
        where: { topicId: id, status: ParticipantStatus.INVITED },
      });
      const currentSet = new Set(currentInvited.map((p) => p.participantId));

      // 已有任意状态参与者行的 actor 不得插入 invited 行：
      // save 按 PK upsert，若不排除会把 active/left 行覆盖降级为 invited（review 发现的回归）
      const existingRows = await this.participantRepo.find({
        where: { topicId: id },
        select: ['participantId'],
      });
      const existingIds = new Set(existingRows.map((p) => p.participantId));

      // 统一批 A2.5（R11）：update 是完整替换语义，只拦"新增" id——已在该 topic
      // participants 表任何状态（含 left）的 id 跳过软删校验，否则存量含已删 agent
      // 的话题永远无法保存（存量成员关系保留，契约 docs/spec.md §1 规则 5/6）。
      // 边界声明：uninvite 后 re-invite 已删 agent 会漏过，可接受（plan R11）。
      const newIds = [...newSet].filter((aid) => !existingIds.has(aid));
      if (newIds.length > 0) {
        await Promise.all(newIds.map((aid) => this.actorProfileService.assertActorUsable(aid)));
      }

      // New IDs not in current: insert invited rows（有意不写 joinedAt，激活时才写入）
      const toAdd = [...newSet].filter((aid) => !currentSet.has(aid) && !existingIds.has(aid));
      if (toAdd.length > 0) {
        // 未读游标初始化（v1.69 D3）：受邀时刻起算未读，邀请前历史不计
        const inviteAnchor = await this.findLatestMessageId(id);
        const rows = toAdd.map((agentId) =>
          this.participantRepo.create({
            topicId: id,
            participantId: agentId,
            role: TopicParticipantRole.MEMBER,
            status: ParticipantStatus.INVITED,
            lastReadMessageId: inviteAnchor,
          }),
        );
        await this.participantRepo.save(rows);
      }

      // Current IDs not in new: DELETE invited-only rows (don't touch active/left rows)
      const toRemove = currentInvited.filter((p) => !newSet.has(p.participantId));
      if (toRemove.length > 0) {
        await this.participantRepo.remove(toRemove);
      }
    }

    // 处理 visibility / config 更新（合并到 settings，不再包含 invitedAgentIds）
    if (dto.visibility !== undefined || dto.config !== undefined) {
      // kind 创建后不可变：update 收到的 kind 一律忽略（normal↔roundtable 互转在
      // M2 推迟清单）——存量 seat 归属与会话层规则开关都依赖创建时的 kind，
      // 中途突变会让 topic 生命周期语义漂移。wakePolicy 是运行时可调策略，原样合并。
      const { kind: _ignoredKind, ...configRest } = dto.config ?? {};
      void _ignoredKind;
      topic.settings = {
        ...topic.settings,
        ...(dto.visibility !== undefined && { visibility: dto.visibility }),
        ...configRest,
      };
    }

    if (dto.title !== undefined) topic.title = dto.title;
    if (dto.description !== undefined) topic.description = dto.description;
    if (dto.status !== undefined) topic.status = dto.status;
    if (dto.agenda !== undefined) topic.agenda = dto.agenda;

    return this.topicRepo.save(topic);
  }

  async remove(id: string) {
    const topic = await this.findById(id);
    await this.topicRepo.softRemove(topic);
    return true;
  }

  async changeStatus(id: string, status: TopicStatus) {
    const topic = await this.findById(id);
    topic.status = status;
    return this.topicRepo.save(topic);
  }

  /**
   * 加入话题（参与者激活：invited→active / left→re-join / 新行创建）
   *
   * 审计分层（plan shadowcat-sunspot-catwoman 决策 2）：join 有内部调用方
   * （roundtable 的 ensureSeatActorJoined / sendSystemMessage 复用本通道，均带
   * isActiveParticipant 幂等前置——仅在真实加入时触发）→ service 层插桩，
   * controller 层会漏掉圆桌全部自动加入。
   *
   * @param topicId 话题 ID
   * @param participantId 加入者 actor ID
   * @param participantType 加入者类型（human/agent/system）
   * @param operatorActorId 操作者 actor ID（审计用；invite-user 场景=操作 admin/creator，
   *                        缺省 = participantId——自己加入/圆桌自动加入语义正确）
   */
  async join(
    topicId: string,
    participantId: string,
    participantType: ActorType,
    operatorActorId?: string,
  ) {
    const topic = await this.topicRepo.findOne({ where: { id: topicId } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });
    if (topic.status === TopicStatus.CLOSED) {
      throw new BadRequestException({ message: 'Topic is closed', code: ErrorCode.TOPIC_CLOSED });
    }

    let tp = await this.participantRepo.findOne({
      where: { topicId, participantId },
    });

    if (tp) {
      // 激活已存在行（invited→active / left→re-join）：刷新 joinedAt 为本次激活时间。
      // joinedAt 语义 = 最近一次实际激活时间（v1.40），left 行历史 joinedAt 不保留。
      tp.status = ParticipantStatus.ACTIVE;
      tp.leftAt = null;
      tp.joinedAt = new Date();
    } else {
      // 新行：显式写 joinedAt（NOT NULL + DB DEFAULT NOW() 已移除，必须由应用写入）
      tp = this.participantRepo.create({
        topicId,
        participantId,
        participantType,
        role: TopicParticipantRole.MEMBER,
        status: ParticipantStatus.ACTIVE,
        joinedAt: new Date(),
      });
    }

    // 未读游标初始化（v1.69 未读游标语义修正 D2）：激活时游标为 null
    // （全新行 / legacy invited·left 行）→ 初始化为当前最新消息，未读只反映
    // "加入之后"的增量，历史考古走消息分页/搜索；游标非 null（re-join 或
    // invite 时已初始化）→ 保留——离开/受邀期间的消息仍是未读，信号语义正确。
    if (tp.lastReadMessageId == null) {
      tp.lastReadMessageId = await this.findLatestMessageId(topicId);
    }
    await this.participantRepo.save(tp);

    await this.eventService.create({
      eventType: EventType.AGENT_JOINED,
      resourceType: 'topic',
      resourceId: topicId,
      topicId: topicId ?? undefined,
      actorId: participantId,
      actorType: participantType,
      payload: { participantId, joinedAt: tp.joinedAt },
    });

    // 审计（Phase 2）：CREATE + topic_participant；actor=操作者（invite-user 由
    // controller 传操作 admin/creator，缺省=participantId）；newData {topicId, participantId}
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: 'topic_participant',
      entityId: participantId,
      actorId: operatorActorId ?? participantId,
      newData: { topicId, participantId },
      source: 'api',
    });

    return { topicId, participantId, joinedAt: tp.joinedAt };
  }

  /**
   * 查话题当前最新消息 id（全序 created_at DESC, id DESC LIMIT 1），无消息返回 null。
   *
   * 用途（v1.69 未读游标语义修正）：参与者行创建/激活时的游标初始化——
   * join / inviteAgent / addEditor / update invitedAgentIds 四处复用，
   * 语义统一为「未读 = 进入房间之后的增量」。
   */
  private async findLatestMessageId(topicId: string): Promise<string | null> {
    const latest = await this.messageRepo.findOne({
      where: { topicId },
      order: { createdAt: 'DESC', id: 'DESC' },
      select: ['id'],
    });
    return latest?.id ?? null;
  }

  /**
   * 获取原始成员身份状态（返回 status 字段值或 null）
   */
  async getMembershipStatus(topicId: string, participantId: string): Promise<string | null> {
    const tp = await this.participantRepo.findOne({
      where: { topicId, participantId },
    });
    return tp?.status ?? null;
  }

  /**
   * 检查 actor 是否拥有话题访问权限（invited 或 active — 用于 read/join 上下文）
   */
  async hasTopicAccess(topicId: string, participantId: string): Promise<boolean> {
    const tp = await this.participantRepo.findOne({
      where: { topicId, participantId },
    });
    return (
      tp != null &&
      (tp.status === ParticipantStatus.INVITED || tp.status === ParticipantStatus.ACTIVE)
    );
  }

  /**
   * 检查 actor 是否为活跃参与者（用于 write/sendMessage 上下文）
   */
  async isActiveParticipant(topicId: string, participantId: string): Promise<boolean> {
    const tp = await this.participantRepo.findOne({
      where: { topicId, participantId },
    });
    return tp != null && tp.status === ParticipantStatus.ACTIVE;
  }

  /**
   * 🔄 [DEPRECATED] 检查指定 actor 是否已是话题的活跃参与者
   * 请使用 hasTopicAccess() 或 isActiveParticipant() 替代。
   * 保留此方法保持向后兼容，待 Controller 迁移后移除。
   */
  async isParticipant(topicId: string, participantId: string): Promise<boolean> {
    return this.hasTopicAccess(topicId, participantId);
  }

  async leave(topicId: string, participantId: string, participantType: ActorType) {
    // 校验话题存在性
    await this.findById(topicId);
    const tp = await this.participantRepo.findOne({
      where: { topicId, participantId },
    });
    if (!tp)
      throw new ForbiddenException({ message: 'Not in topic', code: ErrorCode.AGENT_NOT_IN_TOPIC });

    tp.status = ParticipantStatus.LEFT;
    tp.leftAt = new Date();
    await this.participantRepo.save(tp);

    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: 'topic',
      resourceId: topicId,
      topicId: topicId ?? undefined,
      actorId: participantId,
      actorType: participantType,
      payload: { participantId, leftAt: tp.leftAt },
    });

    return { topicId, participantId, leftAt: tp.leftAt };
  }

  async removeParticipant(topicId: string, actorId: string, participantId: string) {
    // 校验话题存在性
    await this.findById(topicId);

    // 不能移除自己（应使用 leave）；actor ID 全局唯一，无需比较 type
    if (actorId === participantId) {
      throw new BadRequestException({
        message: 'Use leave endpoint to remove yourself',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const tp = await this.participantRepo.findOne({
      where: { topicId, participantId },
    });
    if (!tp)
      throw new NotFoundException({
        message: 'Participant not found',
        code: ErrorCode.AGENT_NOT_IN_TOPIC,
      });

    tp.status = ParticipantStatus.LEFT;
    tp.leftAt = new Date();
    await this.participantRepo.save(tp);

    const participantType = await this.resolveActorTypes([participantId]).then(
      (map) => map.get(participantId) ?? ActorType.HUMAN,
    );

    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: 'topic',
      resourceId: topicId,
      topicId: topicId ?? undefined,
      actorId: participantId,
      actorType: participantType,
      payload: { participantId, removedBy: actorId, leftAt: tp.leftAt },
    });

    // 审计（Phase 2）：DELETE + topic_participant（kick）；actor=操作者（actorId 参数，
    // service 层插桩）；newData {topicId, participantId}
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'topic_participant',
      entityId: participantId,
      actorId,
      newData: { topicId, participantId },
      source: 'api',
    });

    return { topicId, participantId, leftAt: tp.leftAt };
  }

  async getMessages(topicId: string, query: GetMessagesQueryDto) {
    const { after, before, since, start, end, senderId } = query;
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);

    /**
     * 游标互斥矩阵：语义冲突的组合直接拒绝，避免边界行为不可预期。
     * - after / start：语义重复但包含策略不同
     * - before / end：语义重复但包含策略不同
     * - start / before、end / after：半开区间组合，暂不支持
     */
    if (after !== undefined && start !== undefined) {
      throw new BadRequestException({
        message: 'Cannot use after and start together',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (before !== undefined && end !== undefined) {
      throw new BadRequestException({
        message: 'Cannot use before and end together',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (start !== undefined && before !== undefined) {
      throw new BadRequestException({
        message: 'Cannot use start and before together',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    if (end !== undefined && after !== undefined) {
      throw new BadRequestException({
        message: 'Cannot use end and after together',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const qb = this.messageRepo
      .createQueryBuilder('message')
      .where('message.topic_id = :topicId', { topicId })
      .andWhere('message.deleted_at IS NULL');

    if (senderId) {
      qb.andWhere('message.sender_id = :senderId', { senderId });
    }

    /**
     * 模式判断：
     * - forward 模式 (after/since/start/start+end)：增量/定位拉取消息，ASC 排序
     * - reverse 模式 (before/end/无参数)：加载历史消息，DESC 排序后 reverse 为正序
     */
    const isForwardMode = !!(after || since || start);

    /**
     * 加载游标锚点消息并校验 topic 归属，返回 (createdAt, id) 用于全序谓词。
     */
    const fetchAnchor = async (cursorId: string) => {
      const message = await this.messageRepo.findOne({
        where: { id: cursorId, topicId },
        select: ['createdAt', 'id'],
      });
      if (!message) {
        throw new NotFoundException({
          message: 'Message not found in this topic',
          code: ErrorCode.TOPIC_MESSAGE_NOT_FOUND,
        });
      }
      return message;
    };

    // Apply after cursor: tie-break 严格大于——子查询行比较，避免 JS Date 毫秒截断
    // （PG timestamptz 为微秒精度，JS Date 仅毫秒，绑定 Date 会让锚点自身满足 created_at > :d）
    if (after) {
      await fetchAnchor(after);
      qb.andWhere(
        '(message.created_at, message.id) > (SELECT am.created_at, am.id FROM messages am WHERE am.id = :afterId)',
        { afterId: after },
      );
    }

    // Apply before cursor: tie-break 严格小于（子查询行比较）
    if (before) {
      await fetchAnchor(before);
      qb.andWhere(
        '(message.created_at, message.id) < (SELECT am.created_at, am.id FROM messages am WHERE am.id = :beforeId)',
        { beforeId: before },
      );
    }

    /**
     * Apply start cursor: tie-break 含锚点 >= （子查询行比较）
     * 与 after 的区别：start 包含锚点消息本身，适合"从某条消息开始看"的场景。
     */
    let startMessage: { createdAt: Date; id: string } | undefined;
    if (start) {
      startMessage = await fetchAnchor(start);
      qb.andWhere(
        '(message.created_at, message.id) >= (SELECT am.created_at, am.id FROM messages am WHERE am.id = :startId)',
        { startId: start },
      );
    }

    /**
     * Apply end cursor: tie-break 含锚点 <= （子查询行比较）
     * 与 before 的区别：end 包含锚点消息本身，适合"向上定位阅读"的场景。
     */
    let endMessage: { createdAt: Date; id: string } | undefined;
    if (end) {
      endMessage = await fetchAnchor(end);
      qb.andWhere(
        '(message.created_at, message.id) <= (SELECT am.created_at, am.id FROM messages am WHERE am.id = :endId)',
        { endId: end },
      );
    }

    // 闭区间 [start, end] 校验：全序比较 start > end 才报错
    if (startMessage && endMessage) {
      const startTime = startMessage.createdAt.getTime();
      const endTime = endMessage.createdAt.getTime();
      if (startTime > endTime || (startTime === endTime && startMessage.id > endMessage.id)) {
        throw new BadRequestException({
          message: 'Start message is after end message',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
    }

    // Apply since timestamp: fetch messages created strictly after the given ISO timestamp
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        qb.andWhere('message.created_at > :sinceDate', { sinceDate });
      }
    }

    if (isForwardMode) {
      qb.orderBy('message.createdAt', 'ASC').addOrderBy('message.id', 'ASC');
    } else {
      qb.orderBy('message.createdAt', 'DESC').addOrderBy('message.id', 'DESC');
    }
    qb.take(limit);

    const [items, total] = await qb.getManyAndCount();

    // 反向模式：DESC 取最新/更早的 N 条，需要 reverse 为正序（从旧到新）以便前端渲染
    const orderedItems = isForwardMode ? items : [...items].reverse();

    // 映射为 API 形状（发送者 profile 注入，与 fetchUnreadMessages 共用同一映射）
    const messages = await this.mapToMessageDtos(orderedItems);

    /**
     * Cursor 语义：
     * - forward 模式 (after/since/start/start+end)：nextCursor 是当前批次最新的消息 id
     * - reverse 模式 (before/end/无参数)：nextCursor 是当前批次最旧的消息 id
     */
    const nextCursor =
      messages.length > 0
        ? isForwardMode
          ? messages[messages.length - 1].id
          : messages[0].id
        : null;

    return {
      messages,
      nextCursor,
      hasMore: messages.length === limit && total > limit,
    };
  }

  /**
   * 发送消息
   *
   * @param topicId 话题 ID
   * @param senderId 发送者 actor ID
   * @param senderType 发送者类型（human / agent / system）
   * @param dto 消息 DTO
   * @param senderRole 人类发送者角色（仅 human 有效，用于 private 话题 admin 放行）
   */
  async sendMessage(
    topicId: string,
    senderId: string,
    senderType: ActorType,
    dto: SendMessageDto,
    senderRole?: UserRole,
  ) {
    const topic = await this.topicRepo.findOne({ where: { id: topicId } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });
    if (topic.status === TopicStatus.CLOSED) {
      throw new BadRequestException({ message: 'Topic is closed', code: ErrorCode.TOPIC_CLOSED });
    }
    if (topic.status === TopicStatus.PAUSED) {
      throw new BadRequestException({ message: 'Topic is paused', code: ErrorCode.TOPIC_PAUSED });
    }
    if (topic.status === TopicStatus.ARCHIVED) {
      throw new BadRequestException({
        message: 'Topic is archived',
        code: ErrorCode.TOPIC_ALREADY_ARCHIVED,
      });
    }

    const actorType = senderType === ActorType.HUMAN ? ActorType.HUMAN : ActorType.AGENT;

    // 私密话题中，未加入的成员不能通过发消息自动 join。
    // v1.37 放行扩展（行为变更，见 docs/architecture.md §7.2）：
    //   - ADMIN：安全姿态放宽——admin 对 private 话题发言不再 403（此前连 admin 都卡死）
    //   - owner 代理：发送者是 creator（agent）的人类 owner 时视同 creator 放行
    const settings = topic.settings || {};
    if (settings.visibility === Visibility.PRIVATE) {
      const participant = await this.participantRepo.findOne({
        where: { topicId, participantId: senderId, status: ParticipantStatus.ACTIVE },
      });
      if (!participant) {
        // admin 短路：不触发 owner 代理查询（性能短路铁律）
        const isAdmin = senderRole === UserRole.ADMIN;
        // owner 代理判定仅对 human 有效：senderType=system 在上方已归一为 AGENT，
        // actorType===HUMAN 前置判断天然排除 system/agent，不触发查询（评审 M-h 加固：
        // 显式声明 role，去除对「归一在前」语句顺序的隐式依赖）
        const ownerProxyActor: UnifiedActor = {
          id: senderId,
          type: actorType,
          // role 仅 human 有效；非 human 显式置 undefined（UnifiedActor.role 可选）
          role: senderType === ActorType.HUMAN ? senderRole : undefined,
        };
        const isOwnerProxy =
          !isAdmin && actorType === ActorType.HUMAN
            ? await this.ownerProxy.isOwnerProxy(topic.creatorId, ownerProxyActor)
            : false;
        if (!isAdmin && !isOwnerProxy) {
          throw new ForbiddenException({
            message: 'You must join the topic before sending messages',
            code: ErrorCode.AGENT_NOT_IN_TOPIC,
          });
        }
      }
    }

    // --- 1. replyTo 校验（非法格式 / 不存在 / 跨话题 → 400） ---
    if (dto.replyTo) {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(dto.replyTo)) {
        throw new BadRequestException({
          message: 'replyTo must be a valid UUID',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      const replyMessage = await this.messageRepo.findOne({
        where: { id: dto.replyTo },
        select: ['id', 'topicId'],
      });
      if (!replyMessage) {
        throw new BadRequestException({
          message: `Message ${dto.replyTo} not found`,
          code: ErrorCode.MESSAGE_NOT_FOUND,
        });
      }
      if (replyMessage.topicId !== topicId) {
        throw new BadRequestException({
          message: 'Cannot reply to a message from another topic',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
    }

    // --- 2. content 长度校验 ---
    const MAX_CONTENT_LENGTH = 10000;
    if (dto.content && dto.content.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestException({
        message: `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const { clientRequestId, ...messageDto } = dto;

    // ── 无幂等键：走原路径（零开销） ──
    if (!clientRequestId) {
      return this.sendMessageInternal(topicId, senderId, actorType, topic, messageDto);
    }

    // ── 有幂等键：事务保护 ──
    try {
      const { saved } = await this.dataSource.transaction(async (manager) => {
        const msgRepo = manager.getRepository(Message);
        const message = msgRepo.create({
          topicId,
          senderId,
          senderType: actorType,
          type: messageDto.type || MessageType.CHAT,
          content: messageDto.content,
          replyToId: messageDto.replyTo || null,
          metadata: messageDto.metadata || {},
        });
        const savedMsg = await msgRepo.save(message);

        // 写入幂等记录
        await manager.getRepository(IdempotencyRecord).save({
          actorId: senderId,
          clientRequestId,
          entityType: 'message',
          entityId: savedMsg.id,
        });

        // 自动 join（事务内，原子条件 upsert 防 PK 冲突 23505；
        // 不覆盖 role/joinedAt——见 AUTO_JOIN_PARTICIPANT_SQL 注释）
        // $3=savedMsg.id：发送即已读，发送者游标推进到本条消息（同事务内可见）
        await manager.query(AUTO_JOIN_PARTICIPANT_SQL, [topicId, senderId, savedMsg.id]);

        // topic 统计（message_count / last_message_at）由 DB trigger
        // trg_topics_message_stats 维护，应用层不写，避免双写。

        return { saved: savedMsg };
      });

      // 审计（Phase 2）：幂等键路径的真实写成功后记（replay 分支不记——决策 2
      // 「幂等 replay 不重复记」）；载荷与 sendMessageInternal 一致
      await this.auditService.log({
        action: AuditAction.CREATE,
        entityType: 'message',
        entityId: saved.id,
        actorId: senderId,
        newData: { messageId: saved.id, topicId, topicTitle: topic.title },
        source: 'api',
      });

      // 事务成功后执行副作用（更新 Agent 活跃时间、触发事件）
      if (actorType === ActorType.AGENT) {
        const agent = await this.agentRepo.findOne({ where: { id: senderId } });
        if (agent) {
          agent.lastActiveAt = new Date();
          await this.agentRepo.save(agent);
        }
      }

      await this.eventService.create({
        eventType: EventType.NEW_MESSAGE,
        resourceType: 'message',
        resourceId: saved.id,
        topicId: topic.id ?? undefined,
        actorId: senderId,
        actorType,
        payload: { messageId: saved.id, type: saved.type },
      });

      // 查询 sender 信息并构建一致响应
      return await this.buildMessageResponse(saved, senderId, actorType);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'uq_idempotency_actor_key') {
        // 幂等重放
        const idempotencyRepo = this.dataSource.getRepository(IdempotencyRecord);
        const record = await idempotencyRepo.findOne({
          where: { actorId: senderId, clientRequestId },
        });
        if (!record) {
          throw err;
        }
        const existingMsg = await this.messageRepo.findOne({
          where: { id: record.entityId },
        });
        if (!existingMsg) {
          throw new NotFoundException({
            message: 'Message not found for idempotent replay',
            code: ErrorCode.MESSAGE_NOT_FOUND,
          });
        }

        // 构建与正常路径一致的响应形状
        return {
          ...(await this.buildMessageResponse(existingMsg, senderId, actorType)),
          idempotentReplay: true,
        };
      }
      throw err;
    }
  }

  /**
   * sendMessage 无幂等键时的原路径（提取为独立方法，避免 sendMessage 过于臃肿）。
   */
  private async sendMessageInternal(
    topicId: string,
    senderId: string,
    actorType: ActorType,
    topic: Topic,
    dto: Omit<SendMessageDto, 'clientRequestId'>,
  ) {
    // --- 3. 保存消息（支持显式 type） ---
    const message = this.messageRepo.create({
      topicId,
      senderId,
      senderType: actorType,
      type: dto.type || MessageType.CHAT,
      content: dto.content,
      replyToId: dto.replyTo || null,
      metadata: dto.metadata || {},
    });
    const savedRaw = await this.messageRepo.save(message);
    const saved = Array.isArray(savedRaw) ? savedRaw[0] : savedRaw;

    // 审计（Phase 2）：CREATE + message；service 层（本方法是全仓唯一
    // messageRepo.create 点，roundtable 经它写座位/系统消息——controller 层会漏掉
    // 圆桌全部写，plan 决策 2）；newData 契约 = {messageId, topicId, topicTitle(快照)}
    // ——content 显式黑名单（决策 6），正文永不入审计
    await this.auditService.log({
      action: AuditAction.CREATE,
      entityType: 'message',
      entityId: saved.id,
      actorId: senderId,
      newData: { messageId: saved.id, topicId, topicTitle: topic.title },
      source: 'api',
    });

    // --- 4. 自动 join（原子条件 upsert 防并发 PK 冲突 23505；
    //         不覆盖 role/joinedAt——见 AUTO_JOIN_PARTICIPANT_SQL 注释） ---
    // $3=saved.id：发送即已读，发送者游标推进到本条消息
    await this.participantRepo.query(AUTO_JOIN_PARTICIPANT_SQL, [topicId, senderId, saved.id]);

    // --- 5. topic 统计由 DB trigger trg_topics_message_stats 维护，应用层不写 ---

    // --- 5.5 更新 Agent 最后活跃时间 ---
    if (actorType === ActorType.AGENT) {
      const agent = await this.agentRepo.findOne({ where: { id: senderId } });
      if (agent) {
        agent.lastActiveAt = new Date();
        await this.agentRepo.save(agent);
      }
    }

    // --- 5.6 触发事件 ---
    await this.eventService.create({
      eventType: EventType.NEW_MESSAGE,
      resourceType: 'message',
      resourceId: saved.id,
      topicId: topic.id ?? undefined,
      actorId: senderId,
      actorType,
      payload: { messageId: saved.id, type: saved.type },
    });

    // --- 6. 查询 sender 信息并构建一致响应 ---
    return this.buildMessageResponse(saved, senderId, actorType);
  }

  /**
   * 构建 sendMessage 一致响应形状：解析 sender 名称/头像 + 统一字段映射。
   * 正常路径与幂等 replay 路径共用，保证响应契约一致。
   * 统一批 A2：sender 解析改走公共 ActorProfileService（withDeleted 查询覆盖软删 actor，
   * 顺带修复软删 agent 因 eager join 过滤而 senderAvatar 恒 null 的既有缺陷——R7 行为变更）。
   */
  private async buildMessageResponse(msg: Message, senderId: string, actorType: ActorType) {
    const profile = (await this.actorProfileService.resolveProfiles([senderId])).get(senderId);
    // 真孤儿（actors 表无行）兜底：按 actorType 归位（契约：'Unknown' 仅留真孤儿）
    const senderName =
      profile?.name ?? (actorType === ActorType.HUMAN ? 'Unknown User' : 'Unknown Agent');
    const senderAvatar = profile?.avatarUrl ?? null;

    // 圆桌座位标签：仅透传 metadata.seatLabel 单键（座位子身份展示语义，
    // 设计 docs/roundtable-design.md §6/§7），不透全量 metadata——隐私/体积。
    // 无该键时字段缺省：条件展开让响应对象字面缺键，JSON 序列化不出 null。
    const seatLabel = msg.metadata?.seatLabel;
    // 圆桌主脑标记（M3 阶段 3，r13）：仅透传 metadata.seatCoordinator 单键
    // （仅主脑座位落库时写入 true，缺省不写——载荷瘦，普通座位/人类/系统响应
    // 字面缺键），web 消息流据此渲染主脑 badge（§3 from.coordinator 同源语义）
    const seatCoordinator = msg.metadata?.seatCoordinator === true;

    return {
      id: msg.id,
      topicId: msg.topicId,
      senderId: msg.senderId,
      senderType: actorType === ActorType.HUMAN ? 'human' : msg.senderType,
      senderName,
      senderAvatar,
      ...(typeof seatLabel === 'string' && seatLabel ? { seatLabel } : {}),
      ...(seatCoordinator ? { seatCoordinator: true } : {}),
      content: msg.content,
      replyTo: msg.replyToId,
      type: msg.type,
      createdAt: msg.createdAt,
    };
  }

  /**
   * 获取话题未读消息数与增量消息列表。
   *
   * 消息全序 = (created_at, id) ASC（plan §2.1 tie-break 契约）。
   * - 如果参与者没有 lastReadMessageId（首次进入话题/锚点消息已删），
   *   返回 topic.messageCount 作为 unreadCount，messages 从话题开头取前 limit 条。
   * - 否则返回 lastReadMessageId 之后的新消息数量（全序 after 语义），
   *   以及按全序 ASC 的前 limit 条未读消息。
   *
   * @param query.limit 返回消息条数 1~50，默认 20；不影响 unreadCount
   */
  async getUnread(
    topicId: string,
    query: UnreadQueryDto,
    actorId?: string,
    _actorType?: ActorType,
  ) {
    const topic = await this.findById(topicId);
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 50);

    // ── 无 actorId → 仅返回全量未读数 ──
    if (!actorId) {
      return { topicId, unreadCount: topic.messageCount, messages: [], hasMore: false };
    }

    const participant = await this.participantRepo.findOne({
      where: { topicId, participantId: actorId },
    });

    // ── 无有效锚点（从未读过 or 无 participant 行）→ 全量未读，messages 从头给 ──
    if (!participant || !participant.lastReadMessageId) {
      const messages = await this.fetchUnreadMessages(topicId, null, limit);
      return {
        topicId,
        unreadCount: topic.messageCount,
        messages,
        hasMore: topic.messageCount > messages.length,
      };
    }

    // 锚点存在性校验（软删则降级为全量未读）；谓词用子查询行比较，无需读回 createdAt
    const lastReadMessage = await this.messageRepo.findOne({
      where: { id: participant.lastReadMessageId },
      select: ['id'],
    });

    if (!lastReadMessage) {
      // 锚点消息已删 → 降级为全量未读，messages 从头给
      const messages = await this.fetchUnreadMessages(topicId, null, limit);
      return {
        topicId,
        unreadCount: topic.messageCount,
        messages,
        hasMore: topic.messageCount > messages.length,
      };
    }

    // tie-break after 语义：子查询行比较（DB 内微秒精度，避免 JS Date 毫秒截断误算锚点自身）
    const countQb = this.messageRepo
      .createQueryBuilder('msg')
      .where('msg.topic_id = :topicId', { topicId })
      .andWhere(
        '(msg.created_at, msg.id) > (SELECT rm.created_at, rm.id FROM messages rm WHERE rm.id = :lastReadId)',
        { lastReadId: participant.lastReadMessageId },
      )
      .andWhere('msg.deleted_at IS NULL');

    const unreadCount = await countQb.getCount();

    // 取前 limit 条未读消息
    const messages = await this.fetchUnreadMessages(topicId, participant.lastReadMessageId, limit);

    return {
      topicId,
      unreadCount,
      lastReadMessageId: participant.lastReadMessageId,
      messages,
      hasMore: unreadCount > messages.length,
    };
  }

  /**
   * 按全序 (created_at, id) ASC 拉取前 limit 条未读消息。
   * anchorId 为 null 时从话题开头取；否则按 after 语义取锚点之后的消息
   * （子查询行比较，DB 内微秒精度）。
   *
   * 消息对象形状与 getMessages 返回一致（含 senderName/senderAvatar 注入），
   * 复用 resolveActorProfiles 与同一映射逻辑。
   */
  private async fetchUnreadMessages(topicId: string, anchorId: string | null, limit: number) {
    const qb = this.messageRepo
      .createQueryBuilder('message')
      .where('message.topic_id = :topicId', { topicId })
      .andWhere('message.deleted_at IS NULL');

    if (anchorId) {
      qb.andWhere(
        '(message.created_at, message.id) > (SELECT am.created_at, am.id FROM messages am WHERE am.id = :anchorId)',
        { anchorId },
      );
    }

    qb.orderBy('message.createdAt', 'ASC').addOrderBy('message.id', 'ASC').take(limit);

    const items = await qb.getMany();

    return this.mapToMessageDtos(items);
  }

  /**
   * 将消息实体数组映射为 API 形状（批量注入发送者 profile）。
   * getMessages 与 fetchUnreadMessages 共用——形状变更只改这里，防止漂移。
   */
  private async mapToMessageDtos(items: Message[]) {
    const senderIds = [...new Set(items.map((m) => m.senderId))];
    const senderProfileMap = await this.resolveActorProfiles(senderIds);

    return items.map((msg) => {
      const profile = senderProfileMap.get(msg.senderId);
      const senderType = profile?.type ?? ActorType.SYSTEM;

      // 圆桌座位标签：仅透传 metadata.seatLabel 单键（与 buildMessageResponse 同规，
      // 设计 docs/roundtable-design.md §6/§7）；无该键时响应对象缺键。
      const seatLabel = msg.metadata?.seatLabel;
      // 圆桌主脑标记（M3 阶段 3，r13）：与 buildMessageResponse 同规单键透传
      const seatCoordinator = msg.metadata?.seatCoordinator === true;

      return {
        id: msg.id,
        topicId: msg.topicId,
        senderId: msg.senderId,
        senderType: senderType === ActorType.HUMAN ? ('human' as const) : senderType,
        senderName: profile?.name || 'System',
        senderAvatar: profile?.avatarUrl ?? null,
        ...(typeof seatLabel === 'string' && seatLabel ? { seatLabel } : {}),
        ...(seatCoordinator ? { seatCoordinator: true } : {}),
        content: msg.content,
        replyTo: msg.replyToId,
        type: msg.type,
        createdAt: msg.createdAt,
        // 软删信号透传（统一批契约 docs/spec.md §1）：软删 agent 的消息解析出真名 +
        // senderType='agent'（A1 前被 actors 查询软删过滤误归 'system'，行为变更）；
        // 真孤儿（不进 map）保持 'System' 兜底
        deletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
      };
    });
  }

  /**
   * 标记话题消息为已读（单调递增，不防回退时 advanced=false）。
   *
   * - 不传 messageId：取该话题最新消息（按全序 (created_at DESC, id DESC) LIMIT 1）
   * - 已有游标：DB 内行值比较新旧锚点 (created_at, id)（不读回 JS，避免毫秒精度截断）；
   *   新目标严格更旧 → 不写库，返回 advanced: false；
   *   相等（同消息重复标）→ 幂等成功 advanced: false；
   *   新目标更新 → 写库，返回 advanced: true。
   * - upsert 修复：参与者行存在 → 仅 update lastReadMessageId；
   *   不存在 → insert 完整行（自动 join 语义保持）。不覆盖 role/joinedAt 等字段。
   *
   * @returns { topicId, lastReadMessageId, advanced }
   */
  async markAsRead(topicId: string, actorId: string, actorType: ActorType, dto: MarkAsReadDto) {
    // 校验话题存在性
    await this.findById(topicId);

    let messageId = dto.messageId;
    if (!messageId) {
      // 取最新消息：全序 (created_at DESC, id DESC) LIMIT 1
      const latestMessage = await this.messageRepo.findOne({
        where: { topicId },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      messageId = latestMessage?.id;
    }

    if (!messageId) {
      return { topicId, lastReadMessageId: null, advanced: false };
    }

    // 校验目标消息存在且属于该话题
    const targetMessage = await this.messageRepo.findOne({
      where: { id: messageId, topicId },
      select: ['id'],
    });
    if (!targetMessage) {
      throw new NotFoundException({
        message: 'Message not found in this topic',
        code: ErrorCode.MESSAGE_NOT_FOUND,
      });
    }

    // ── 防回退：DB 内行值比较新旧锚点 (created_at, id) ──
    // 不把 timestamptz 读回 JS 比较：PG 是微秒精度，JS Date 只剩毫秒，
    // 读回再比较会丢精度误判（锚点生产验证实录）。行值比较在 DB 内完成，零精度丢失。
    const existingParticipant = await this.participantRepo.findOne({
      where: { topicId, participantId: actorId },
    });

    if (existingParticipant?.lastReadMessageId) {
      const rows: { newer: boolean }[] = await this.messageRepo.query(
        `SELECT (n.created_at, n.id) > (o.created_at, o.id) AS newer
         FROM messages n, messages o
         WHERE n.id = $1 AND o.id = $2 AND n.deleted_at IS NULL AND o.deleted_at IS NULL`,
        [messageId, existingParticipant.lastReadMessageId],
      );
      // rows 为空 → 旧锚点消息已删 → 允许推进（相当于首次阅读场景）
      if (rows.length > 0 && !rows[0].newer) {
        // 新目标不晚于当前游标（含同消息重复标）→ 不推进
        return {
          topicId,
          lastReadMessageId: existingParticipant.lastReadMessageId,
          advanced: false,
        };
      }
    }

    // ── upsert 修复：存在参与者行 → 只 update lastReadMessageId；不存在 → insert ──
    if (existingParticipant) {
      existingParticipant.lastReadMessageId = messageId;
      await this.participantRepo.save(existingParticipant);
    } else {
      // 无参与者行 → insert ACTIVE 新行（自动 join 语义）；显式写 joinedAt
      // （DB DEFAULT NOW() 已移除，active 行必须由应用写入 joinedAt）
      const newParticipant = this.participantRepo.create({
        topicId,
        participantId: actorId,
        participantType: actorType,
        role: TopicParticipantRole.MEMBER,
        status: ParticipantStatus.ACTIVE,
        lastReadMessageId: messageId,
        joinedAt: new Date(),
      });
      await this.participantRepo.save(newParticipant);
    }

    return { topicId, lastReadMessageId: messageId, advanced: true };
  }

  async removeMessage(topicId: string, messageId: string, actorId: string) {
    const message = await this.messageRepo.findOne({
      where: { id: messageId, topicId },
    });
    if (!message) {
      throw new NotFoundException({
        message: 'Message not found',
        code: ErrorCode.MESSAGE_NOT_FOUND,
      });
    }
    if (message.senderId !== actorId) {
      throw new ForbiddenException({
        message: 'You can only delete your own messages',
        code: ErrorCode.MESSAGE_CANNOT_DELETE,
      });
    }
    await this.messageRepo.softRemove(message);

    // 审计（Phase 2）：DELETE + message；actor=删除者（sender 本人）；newData 白名单
    // {messageId, topicId}（决策 6——content 黑名单不入）
    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: 'message',
      entityId: messageId,
      actorId,
      newData: { messageId, topicId },
      source: 'api',
    });

    return { messageId, deleted: true };
  }

  async updateAgenda(id: string, dto: UpdateAgendaDto) {
    const topic = await this.findById(id);
    topic.agenda = dto.agenda;
    return this.topicRepo.save(topic);
  }

  /**
   * 原子操作：邀请 Agent 加入 Topic
   * 使用 participant 关系表管理邀请状态（不再写入 topic.settings）
   * @param id - Topic ID
   * @param agentId - Agent ID
   * @returns 保存后的 Topic
   * @throws NotFoundException - Topic 不存在
   * @throws ConflictException - Agent 已是活跃参与者、已被邀请
   */
  async inviteAgent(id: string, agentId: string) {
    const topic = await this.topicRepo.findOne({ where: { id } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });

    // 校验 Agent 存在且未软删（Phase 2 + 统一批 A2.5：新邀请指向已删 agent = 活配置
    // 错误，统一 404 AGENT_NOT_FOUND——契约 docs/spec.md §1 规则 6）
    await this.actorProfileService.assertActorUsable(agentId);

    // 查找现有 participant 行
    const tp = await this.participantRepo.findOne({
      where: { topicId: id, participantId: agentId },
    });

    if (tp) {
      if (tp.status === ParticipantStatus.ACTIVE) {
        throw new ConflictException({
          message: 'Agent already has access via topic participation',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
      if (tp.status === ParticipantStatus.INVITED) {
        throw new ConflictException({
          message: 'Agent already invited',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
      // status === 'left': update status to 'invited'
      tp.status = ParticipantStatus.INVITED;
      await this.participantRepo.save(tp);
    } else {
      // No row: insert new invited row（有意不写 joinedAt，激活时才写入）
      // 未读游标初始化（v1.69 D3）：受邀时刻起算未读，邀请前历史不计
      const newTp = this.participantRepo.create({
        topicId: id,
        participantId: agentId,
        role: TopicParticipantRole.MEMBER,
        status: ParticipantStatus.INVITED,
        lastReadMessageId: await this.findLatestMessageId(id),
      });
      await this.participantRepo.save(newTp);
    }

    // 触发事件
    await this.eventService.create({
      eventType: EventType.AGENT_JOINED,
      resourceType: 'topic',
      resourceId: id,
      topicId: id ?? undefined,
      actorId: agentId,
      actorType: ActorType.AGENT,
      payload: { participantId: agentId },
    });

    return topic;
  }

  /**
   * 原子操作：提升 Agent 为 Topic editor（v1.46 TOPIC-PERM，镜像 Board add-editor）
   *
   * 权限由 Controller 收口（creator/admin-only，D2 ensureCreatorOrAdmin）。
   * 边界语义（D5）：
   * - 行不存在 → 校验 agent 存在后新建 role=editor + status=invited 行（有意不写
   *   joinedAt——受邀行语义：invited 为 NULL，激活时才写入）
   * - 行存在（invited/active）→ 置 role=editor，保留原 status（不隐式改状态，铁律 #18）
   * - 行 status=left → 409（需先重新 invite，不隐式复活历史行）
   * - 目标是 moderator 行（creator 自己）→ 400（creator 不能被降级/提级为 editor）
   * - editor 已提升 → 幂等成功（role 已是 editor 直接返回，不抛冲突）
   *
   * @param id - Topic ID
   * @param agentId - Agent ID
   * @returns 保存后的 Topic
   * @throws NotFoundException - Topic 或 Agent 不存在
   * @throws BadRequestException - 目标是 creator（moderator 行）
   * @throws ConflictException - 行已 left（需先 invite）
   */
  async addEditor(id: string, agentId: string) {
    const topic = await this.topicRepo.findOne({ where: { id } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });

    // 校验 Agent 存在且未软删（Phase 2 + 统一批 A2.5：提升已删 agent = 活配置错误，
    // 统一 404 AGENT_NOT_FOUND——契约 docs/spec.md §1 规则 6）
    await this.actorProfileService.assertActorUsable(agentId);

    const tp = await this.participantRepo.findOne({
      where: { topicId: id, participantId: agentId },
    });

    if (tp) {
      if (tp.role === TopicParticipantRole.MODERATOR) {
        throw new BadRequestException({
          message: 'Topic creator cannot be promoted to editor',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      if (tp.status === ParticipantStatus.LEFT) {
        throw new ConflictException({
          message: 'Agent has left the topic, re-invite before promoting to editor',
          code: ErrorCode.RESOURCE_CONFLICT,
        });
      }
      if (tp.role !== TopicParticipantRole.EDITOR) {
        // member → editor 升级（保留原 status：invited/active 均可，不隐式改状态）
        tp.role = TopicParticipantRole.EDITOR;
        await this.participantRepo.save(tp);
      }
    } else {
      // 无行：新建 editor + invited 行（D4：invited 未 join 的 editor 可直接编辑，
      // 与 hasTopicAccess 的 invited+active 语义一致，不强制先 join）
      // 未读游标初始化（v1.69 D3）：受邀时刻起算未读，邀请前历史不计
      const newTp = this.participantRepo.create({
        topicId: id,
        participantId: agentId,
        participantType: ActorType.AGENT,
        role: TopicParticipantRole.EDITOR,
        status: ParticipantStatus.INVITED,
        lastReadMessageId: await this.findLatestMessageId(id),
      });
      await this.participantRepo.save(newTp);
    }

    // 触发事件（与 inviteAgent 同构：editor 提升视为加入事件）
    await this.eventService.create({
      eventType: EventType.AGENT_JOINED,
      resourceType: 'topic',
      resourceId: id,
      topicId: id ?? undefined,
      actorId: agentId,
      actorType: ActorType.AGENT,
      payload: { participantId: agentId, role: TopicParticipantRole.EDITOR },
    });

    return topic;
  }

  /**
   * 原子操作：撤销 Agent 的 Topic editor 角色（v1.46 TOPIC-PERM，镜像 Board remove-editor）
   *
   * 权限由 Controller 收口（creator/admin-only，D2 ensureCreatorOrAdmin）。
   * 语义（D5）：editor → 降为 member（保留 status，不踢人——invited 的 editor
   * 降级后仍是受邀者，active 的 editor 降级后仍是活跃成员）；非 editor 行/不存在 → 404。
   *
   * @param id - Topic ID
   * @param agentId - Agent ID
   * @returns 保存后的 Topic
   * @throws NotFoundException - Topic / Agent / editor 行不存在
   */
  async removeEditor(id: string, agentId: string) {
    const topic = await this.topicRepo.findOne({ where: { id } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });

    // 校验 Agent 真实存在
    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    const tp = await this.participantRepo.findOne({
      where: { topicId: id, participantId: agentId },
    });
    if (!tp || tp.role !== TopicParticipantRole.EDITOR) {
      throw new NotFoundException({
        message: 'Agent is not an editor in this topic',
        code: ErrorCode.AGENT_NOT_IN_TOPIC,
      });
    }

    // editor → member 降级（保留 status/joinedAt，不踢人）
    tp.role = TopicParticipantRole.MEMBER;
    await this.participantRepo.save(tp);

    // 触发事件
    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: 'topic',
      resourceId: id,
      topicId: id ?? undefined,
      actorId: agentId,
      actorType: ActorType.AGENT,
      payload: { participantId: agentId, role: TopicParticipantRole.MEMBER },
    });

    return topic;
  }

  /**
   * 原子操作：取消 Agent 对 Topic 的访问邀请
   * 使用 participant 关系表管理（不再读取 topic.settings）
   * @param id - Topic ID
   * @param agentId - Agent ID
   * @returns 保存后的 Topic
   * @throws NotFoundException - Topic 不存在
   * @throws ConflictException - Agent 未被邀请
   */
  async uninviteAgent(id: string, agentId: string) {
    const topic = await this.topicRepo.findOne({ where: { id } });
    if (!topic)
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });

    // 校验 Agent 真实存在，避免对幽灵 ID 操作（Phase 2）
    await this.resourceValidator.exists(this.agentRepo, agentId, ErrorCode.AGENT_NOT_FOUND);

    const tp = await this.participantRepo.findOne({
      where: { topicId: id, participantId: agentId },
    });

    if (!tp) {
      throw new NotFoundException({
        message: 'Agent is not invited to this topic',
        code: ErrorCode.AGENT_NOT_IN_TOPIC,
      });
    }

    if (tp.status === ParticipantStatus.INVITED) {
      // Invited but not yet joined: delete the row entirely
      await this.participantRepo.remove(tp);
    } else if (tp.status === ParticipantStatus.ACTIVE) {
      // Already joined member: set status='left'
      tp.status = ParticipantStatus.LEFT;
      tp.leftAt = new Date();
      await this.participantRepo.save(tp);
    } else {
      // status === 'left' or other
      throw new ConflictException({
        message: 'Agent is not an active participant or invitee',
        code: ErrorCode.RESOURCE_CONFLICT,
      });
    }

    // 触发事件
    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: 'topic',
      resourceId: id,
      topicId: id ?? undefined,
      actorId: agentId,
      actorType: ActorType.AGENT,
      payload: { participantId: agentId },
    });

    return topic;
  }

  /**
   * 将人类用户从 Topic 参与者中移除
   * @param topicId - Topic ID
   * @param userId - 用户 ID
   * @returns 移除结果
   * @throws NotFoundException - Topic 不存在或用户不是参与者
   */
  async uninviteUser(topicId: string, userId: string) {
    const topic = await this.topicRepo.findOne({ where: { id: topicId } });
    if (!topic) {
      throw new NotFoundException({ message: 'Topic not found', code: ErrorCode.TOPIC_NOT_FOUND });
    }

    const tp = await this.participantRepo.findOne({
      where: {
        topicId,
        participantId: userId,
      },
    });
    if (!tp) {
      throw new NotFoundException({
        message: 'User is not a participant in this topic',
        code: ErrorCode.AGENT_NOT_IN_TOPIC,
      });
    }

    tp.status = ParticipantStatus.LEFT;
    tp.leftAt = new Date();
    await this.participantRepo.save(tp);

    await this.eventService.create({
      eventType: EventType.AGENT_LEFT,
      resourceType: 'topic',
      resourceId: topicId,
      topicId: topicId ?? undefined,
      actorId: userId,
      actorType: ActorType.HUMAN,
      payload: { participantId: userId, leftAt: tp.leftAt },
    });

    return { topicId, participantId: userId, leftAt: tp.leftAt };
  }
}
