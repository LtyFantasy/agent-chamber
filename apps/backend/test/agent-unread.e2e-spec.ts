/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §5. Agents（GET /agents/me/unread）
 *   - 补充: plan forge-jubilee-robin.md Workstream B（跨 topic 未读计数）
 *
 * [踩坑索引]
 *   - WS-B: 未读 SQL 语义（无游标/锚点软删→全量、行值比较 after、自己发的计入）
 *     mock 测不出 PG 真实执行（铁律 #23 精神），本套件直连真 PG 验证七场景；
 *     PG now() 同事务同值 → 消息 created_at 必须显式 UPDATE 才能确定全序
 *
 * [铁律关联] #17(测试契约) #23(jsonb查询集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * GET /agents/me/unread 跨 topic 未读计数 —— 真实 PG 集成套件（WS-B，2026-08-27）
 *
 * 覆盖（plan forge-jubilee-robin.md Workstream B 七语义）：
 * ① 无游标（last_read_message_id IS NULL）→ 该 topic 全量未删消息计数；
 * ② 游标中段 → 只计 (created_at, id) 行值比较之后的消息；
 * ③ 自己发的消息计入（无 sender 过滤，与 TopicService.getUnread 同语义）；
 * ④ status='left' 的旧参与行排除；
 * ⑤ 游标消息被软删 → 锚点 join 落空 → 降级全量；
 * ⑥ unreadCount=0 的 topic 不出现在结果（HAVING 过滤）；
 * ⑦ 无任何参与行 → 空数组。
 *
 * 与 deleted-actor-projection.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按 FK
 * 依赖逆序硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { ActorType, AgentStatus, MessageType, TopicStatus, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AgentService } from '../src/modules/agent/agent.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import { User } from '../src/database/entities/user.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';

/** system 哨兵固定 UUID（roundtable.service 播种，公告通道 join 的 actor） */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `unrd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('GET /agents/me/unread 跨 topic 未读计数 — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let agentService: AgentService;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    messageIds: string[];
    participantIds: string[];
    topicIds: string[];
    keyIds: string[];
    agentIds: string[];
    actorIds: string[];
    ownerIds: string[];
    ownerActorIds: string[];
    systemActorCreated?: boolean;
  } = {
    messageIds: [],
    participantIds: [],
    topicIds: [],
    keyIds: [],
    agentIds: [],
    actorIds: [],
    ownerIds: [],
    ownerActorIds: [],
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      // 与生产 AppModule 同款命名策略：未显式 name 的列走 snake_case
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[agent-unread e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：AgentService 三 repo（findMyUnreadCounts 只走 agentRepo.manager.query）
    agentService = new AgentService(
      ds.getRepository(Agent),
      ds.getRepository(ApiKey),
      ds.getRepository(RoundtableSeat),
      // 活动日志插桩（Phase 2）：本套件只读路径不触发，真实例防误触
      new AuditService(
        ds.getRepository(AuditLog),
        new OwnerProxyService(ds.getRepository(Agent)),
        new ActorProfileService(
          ds.getRepository(Actor),
          ds.getRepository(Agent),
          ds.getRepository(User),
        ),
      ),
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
    for (const id of created.participantIds) {
      await ds
        .getRepository(TopicParticipant)
        .delete({ topicId: created.topicIds[0], participantId: id });
    }
    for (const id of created.topicIds) await ds.getRepository(Topic).delete({ id });
    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    if (created.systemActorCreated) {
      await ds.getRepository(Actor).delete({ id: SYSTEM_ACTOR_ID });
    }
    for (const id of created.ownerIds) await ds.getRepository(User).delete({ id });
    for (const id of created.ownerActorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
  }, 30000);

  /** 建 owner user + agent（actor + agents + api_key 行），返回 agent 实体 */
  async function createAgentWithOwner(): Promise<Agent> {
    // 函数内单次取后缀：同一 it 的所有名字共享，保证断言可引用 agent.name
    const s = runSuffix();
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `U Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `uowner${s}`.slice(0, 50),
        email: `uowner-${s}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerIds.push(owner.id);

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `U Agent ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `U Agent ${s}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    const apiKey = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: `hash-${s}`,
        keyPrefix: 'ask_xxxx',
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyIds.push(apiKey.id);
    return agent;
  }

  /** 建 topic + agent 参与行（status 可指定，默认 active），返回 topic 实体 */
  async function createTopic(
    agent: Agent,
    opts: { status?: 'invited' | 'active' | 'left' } = {},
  ): Promise<Topic> {
    const s = runSuffix();
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `U Unread Topic ${s}`,
        creatorId: agent.id,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicIds.push(topic.id);
    const status = opts.status ?? 'active';
    const participant = await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: topic.id,
        participantId: agent.id,
        role: 'member',
        status,
        joinedAt: new Date(),
        leftAt: status === 'left' ? new Date() : null,
        notificationSettings: { mute: false, mentions_only: false },
        lastReadMessageId: null,
      }),
    );
    created.participantIds.push(participant.participantId);
    return topic;
  }

  /**
   * 建 count 条消息（sender 可指定），返回消息数组。
   * ⚠️ PG now() 同事务同值：save 后必须显式 UPDATE created_at 递增，
   * 否则 (created_at, id) 行值比较的 tie-break 落到随机 uuid，全序不确定。
   */
  async function createMessages(
    topicId: string,
    senderId: string,
    count: number,
  ): Promise<Message[]> {
    const msgs: Message[] = [];
    for (let i = 0; i < count; i++) {
      const msg = await ds.getRepository(Message).save(
        ds.getRepository(Message).create({
          topicId,
          senderId,
          type: MessageType.CHAT,
          content: `U unread message ${i} ${runSuffix()}`,
        }),
      );
      created.messageIds.push(msg.id);
      msgs.push(msg);
    }
    for (let i = 0; i < msgs.length; i++) {
      await ds.query(
        `UPDATE messages SET created_at = ('2024-01-01T00:00:0' || $2 || '.000Z')::timestamptz WHERE id = $1`,
        [msgs[i].id, String(i + 1)],
      );
    }
    return msgs;
  }

  /** 推进参与行游标（等价 get_topic_digest markRead=true 的落库效果） */
  async function setReadCursor(topicId: string, agentId: string, messageId: string) {
    await ds
      .getRepository(TopicParticipant)
      .update({ topicId, participantId: agentId }, { lastReadMessageId: messageId });
  }

  /** 确保 system 哨兵 actor 存在（场景③ 混合 sender 用） */
  async function ensureSystemActor(): Promise<void> {
    const existing = await ds.getRepository(Actor).findOne({
      where: { id: SYSTEM_ACTOR_ID },
      withDeleted: true,
    });
    if (!existing) {
      await ds.getRepository(Actor).save(
        ds.getRepository(Actor).create({
          id: SYSTEM_ACTOR_ID,
          type: ActorType.SYSTEM,
          displayName: 'System',
          status: AgentStatus.ACTIVE,
        }),
      );
      created.systemActorCreated = true;
    }
  }

  it('① 无游标 → 该 topic 全量未删消息计数', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    await createMessages(topic.id, agent.id, 3);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 3 }]);
  }, 30000);

  it('② 游标中段 → 只计 (created_at, id) 之后的消息', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    const msgs = await createMessages(topic.id, agent.id, 3);
    // 游标 = 第 2 条消息 → 只计第 3 条
    await setReadCursor(topic.id, agent.id, msgs[1].id);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 1 }]);
  }, 30000);

  it('③ 自己发的消息计入（无 sender 过滤，与 getUnread 同语义）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    await ensureSystemActor();
    // 1 条自己发 + 1 条 system 发，无游标 → 全量 2（若 SQL 误排自己发的会是 1）
    await createMessages(topic.id, agent.id, 1);
    await createMessages(topic.id, SYSTEM_ACTOR_ID, 1);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 2 }]);
  }, 30000);

  it('④ status=left 的旧参与行排除', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent, { status: 'left' });
    await createMessages(topic.id, agent.id, 2);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([]);
  }, 30000);

  it('⑤ 游标消息被软删 → 锚点落空 → 降级全量（未删消息数）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    const msgs = await createMessages(topic.id, agent.id, 3);
    // 游标 = 第 1 条消息，随后软删该消息 → 锚点 join 落空 → 降级全量。
    // 全量口径 = 未删消息数（message_count 由 DB trigger 同步递减，与
    // getUnread 的 topic.messageCount 降级路径一致）→ 3 条中软删 1 条 = 2
    await setReadCursor(topic.id, agent.id, msgs[0].id);
    await ds.getRepository(Message).softDelete({ id: msgs[0].id });

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 2 }]);
  }, 30000);

  it('⑥ unreadCount=0 的 topic 不出现在结果（HAVING 过滤）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    const msgs = await createMessages(topic.id, agent.id, 3);
    // 游标 = 最后一条消息 → 无新消息 → unreadCount=0 → 不出现
    await setReadCursor(topic.id, agent.id, msgs[2].id);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([]);
  }, 30000);

  it('⑦ 无任何参与行 → 空数组', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([]);
  }, 30000);
});
