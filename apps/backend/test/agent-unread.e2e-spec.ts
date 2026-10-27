/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §5. Agents（GET /agents/me/unread）
 *   - 补充: plan forge-jubilee-robin.md Workstream B（跨 topic 未读计数）
 *
 * [踩坑索引]
 *   - WS-B: 未读 SQL 语义（无游标/锚点软删→全量、行值比较 after、自发排除（v1.85））
 *     mock 测不出 PG 真实执行（铁律 #23 精神），本套件直连真 PG 验证；
 *     PG now() 同事务同值 → 消息 created_at 必须显式 UPDATE 才能确定全序
 *     （且 createMessages 每次调用都从 00:00:01 起算——跨调用必须再显式错开）
 *   - MENTIONS: `m.mentions @> jsonb_build_array(tp.participant_id::text)` / `@> '"*"'::jsonb`
 *     与 `tp.notification_settings @> '{"mentions_only": true}'::jsonb` 三者的组合语义
 *     只能在真 PG 上验（PG 15 实测）；谓词必须在 LEFT JOIN 的 ON 子句内（写 WHERE 会让
 *     未命中提及的 topic 整行消失）
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
 * 覆盖（plan forge-jubilee-robin.md Workstream B 七语义 + v1.85 自发排除八场景）：
 * ① 无游标（last_read_message_id IS NULL）→ 该 topic 全量未读计数（未删且非自发）；
 * ② 游标中段 → 只计 (created_at, id) 行值比较之后的消息；
 * ③ 自己发的消息**不**计入未读（v1.85）——发送者用第二个 actor 作对照，system 消息仍计入；
 * ④ status='left' 的旧参与行排除；
 * ⑤ 游标消息被软删 → 锚点 join 落空 → 降级全量（真 COUNT，仍排除自发）；
 * ⑥ unreadCount=0 的 topic 不出现在结果（HAVING 过滤）；
 * ⑦ 无任何参与行 → 空数组；
 * ⑧ topic 内只有自发消息 → unreadCount=0 → 不出现（自发排除的直接锁）。
 *
 * v1.96.0-dev 未读语义批新增：
 * ⑨ D4 mentions_only 过滤：开启后只数提及我（或 @all）的消息；
 * ⑩ **D4 跨面一致性**：同一 @ 消息 TopicService.getUnread 与 findMyUnreadCounts 都计 1
 *    （含**锚点悬空变体**——模式与锚点正交，悬空时两面必须仍同口径）；
 * ⑪ D1 跨面：发送不推进游标 → findMyUnreadCounts 的未读不被自己发送清零。
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
import { TopicService } from '../src/modules/topic/topic.service';
import { EventService } from '../src/modules/event/event.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { Board } from '../src/database/entities/board.entity';
import { Task } from '../src/database/entities/task.entity';
import { Attachment } from '../src/database/entities/attachment.entity';
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
  /** 跨面一致性（D4）需要 TopicService：同一 @ 消息两面必须同口径 */
  let topicService: TopicService;

  /**
   * 直插消息的 created_at 递增计数器（模块级，套件内串行执行）：
   * PG now() 同事务同值，必须显式钉时间戳才能让 (created_at, id) 行值比较有确定全序。
   */
  let mentionSeq = 0;

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
      // getMyBriefing 编排依赖（plan captain-atom-crimson-avenger-rocket-dc §2.5 A1）：
      // 本套件不触达 briefing 路径，mock 即可
      {} as never, // taskService（未触达）
      {} as never, // taskDependencyService（未触达）
    );

    // 跨面一致性（D4）需要 TopicService 真实例——两面同谓词的两个实现点必须同口径。
    // 事件/审计/访问查询非被测面，最小桩替代（同 unread-cursor.e2e-spec.ts 约定）。
    topicService = new TopicService(
      ds.getRepository(Topic),
      ds.getRepository(TopicParticipant),
      ds.getRepository(Message),
      ds.getRepository(User),
      ds.getRepository(Agent),
      ds.getRepository(Actor),
      { create: async () => ({}) } as unknown as EventService,
      ds.getRepository(Board),
      ds.getRepository(Task),
      {} as unknown as AccessQueryService,
      new ResourceValidator(),
      ds,
      new OwnerProxyService(ds.getRepository(Agent)),
      new ActorProfileService(
        ds.getRepository(Actor),
        ds.getRepository(Agent),
        ds.getRepository(User),
      ),
      { log: async () => undefined } as unknown as AuditService,
      ds.getRepository(Attachment),
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

  it('① 无游标 → 该 topic 全量未读计数（未删且非自发）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    // 发送者用第二个 actor：本用例锁定「无游标 → 全量」本身，
    // 自发排除由 ③/⑧ 单独锁定，两者互不掩盖
    const sender = await createAgentWithOwner();
    const topic = await createTopic(agent);
    await createMessages(topic.id, sender.id, 3);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 3 }]);
  }, 30000);

  it('② 游标中段 → 只计 (created_at, id) 之后的消息', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const sender = await createAgentWithOwner();
    const topic = await createTopic(agent);
    const msgs = await createMessages(topic.id, sender.id, 3);
    // 游标 = 第 2 条消息 → 只计第 3 条
    await setReadCursor(topic.id, agent.id, msgs[1].id);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 1 }]);
  }, 30000);

  it('③ 自己发的消息不计入未读（裸插自发消息——旧「无 sender 过滤」语义已废）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    await ensureSystemActor();
    // 1 条自己发 + 1 条 system 发，无游标 → 未读应为 1（自发被排除；若 SQL 误含自发会是 2）
    await createMessages(topic.id, agent.id, 1);
    await createMessages(topic.id, SYSTEM_ACTOR_ID, 1);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 1 }]);
  }, 30000);

  it('④ status=left 的旧参与行排除', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    // 发送者用第二个 actor：让本用例只验证 status 过滤，不与自发排除混淆
    const sender = await createAgentWithOwner();
    const topic = await createTopic(agent, { status: 'left' });
    await createMessages(topic.id, sender.id, 2);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([]);
  }, 30000);

  it('⑤ 游标消息被软删 → 锚点落空 → 降级全量（未删且非自发）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const sender = await createAgentWithOwner();
    const topic = await createTopic(agent);
    const msgs = await createMessages(topic.id, sender.id, 3);
    // 游标 = 第 1 条消息，随后软删该消息 → 锚点 join 落空 → 降级全量。
    // 全量口径（v1.85）= 未软删 **且非自发** 的消息数 → 3 条中软删 1 条 = 2
    // （不再依赖 topics.message_count，SQL 直接 COUNT）
    await setReadCursor(topic.id, agent.id, msgs[0].id);
    await ds.getRepository(Message).softDelete({ id: msgs[0].id });

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([{ topicId: topic.id, topicName: topic.title, unreadCount: 2 }]);
  }, 30000);

  it('⑥ unreadCount=0 的 topic 不出现在结果（HAVING 过滤）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const sender = await createAgentWithOwner();
    const topic = await createTopic(agent);
    const msgs = await createMessages(topic.id, sender.id, 3);
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

  it('⑧ 只有自发消息的 topic 不出现在结果（v1.85 自发排除直接锁）', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent);
    // 无游标 + 3 条全是自己发的（裸插，绕过 sendMessage 的游标推进）→
    // COUNT(m.id) = 0 → HAVING 过滤掉该 topic（旧 SQL 会报 unreadCount=3）
    await createMessages(topic.id, agent.id, 3);

    const result = await agentService.findMyUnreadCounts(agent.id);

    expect(result).toEqual([]);
  }, 30000);

  /**
   * 建带 mentions 的消息（直插，精确构造提及过滤场景；created_at 显式钉递增）
   */
  async function createMessageWithMentions(
    topicId: string,
    senderId: string,
    mentions: string[],
  ): Promise<Message> {
    const msg = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId,
        senderId,
        type: MessageType.CHAT,
        content: `U mention message ${runSuffix()}`,
        mentions,
      }),
    );
    created.messageIds.push(msg.id);
    // 全序确定：模块级计数器递增（同 unread-cursor 套件的 historySeq 教训）
    mentionSeq += 1;
    await ds.query(
      `UPDATE messages SET created_at = ('2024-01-01T00:00:' || $2 || '.000Z')::timestamptz WHERE id = $1`,
      [msg.id, String(mentionSeq % 60).padStart(2, '0')],
    );
    return msg;
  }

  /** 直接改参与行的 notification_settings */
  async function setNotificationSettings(
    topicId: string,
    participantId: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    await ds.query(
      `UPDATE topic_participants SET notification_settings = $3::jsonb
        WHERE topic_id = $1 AND participant_id = $2`,
      [topicId, participantId, JSON.stringify(settings)],
    );
  }

  it('⑨ D4 mentions_only 过滤：只数提及我（或 @all）的消息，未提及的不出现', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader);
    await createMessageWithMentions(topic.id, writer.id, [reader.id.toLowerCase()]);
    await createMessageWithMentions(topic.id, writer.id, ['*']);
    await createMessageWithMentions(topic.id, writer.id, []);

    // 关闭模式：3 条全算
    const off = await agentService.findMyUnreadCounts(reader.id);
    expect(off.find((r) => r.topicId === topic.id)?.unreadCount).toBe(3);

    await setNotificationSettings(topic.id, reader.id, { mute: false, mentions_only: true });

    // 开启模式：点名我 + @all = 2（未提及的那条被 ON 子句滤掉）
    const on = await agentService.findMyUnreadCounts(reader.id);
    expect(on.find((r) => r.topicId === topic.id)?.unreadCount).toBe(2);

    // 硬删**被点名的那条**（全序最旧 = 第 1 条 createMessageWithMentions）→ 剩「@all」+「未提及」
    // 两条物理消息，其中只有 @all 命中过滤 → 计数 1。
    // （断言 1 而非 0 正是本步的意义：证明 @all 那条**仍然计入**，被删的确实是点名那条。）
    await ds.getRepository(Message).delete({
      id: (await ds
        .getRepository(Message)
        .findOne({ where: { topicId: topic.id }, order: { createdAt: 'ASC' } }))!.id,
    });
    const after = await agentService.findMyUnreadCounts(reader.id);
    expect(after.find((r) => r.topicId === topic.id)?.unreadCount).toBe(1);
  }, 30000);

  it('⑩ D4 跨面一致性：同一 @ 消息 TopicService.getUnread 与 findMyUnreadCounts 都计 1（含锚点悬空变体）', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader);
    const msgs = await createMessages(topic.id, writer.id, 2);
    // 两条都点名 reader；游标停在 msgs[0] 之后（先无游标基线，再精确设锚）
    await createMessageWithMentions(topic.id, writer.id, [reader.id.toLowerCase()]);
    await createMessageWithMentions(topic.id, writer.id, [reader.id.toLowerCase()]);
    void msgs;
    await setNotificationSettings(topic.id, reader.id, { mentions_only: true });

    // ── 变体 A：正常锚点（游标 null → 降级全量，两面都走全量口径）──
    const face1 = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    const face2 = (await agentService.findMyUnreadCounts(reader.id)).find(
      (r) => r.topicId === topic.id,
    );
    expect(face1.mentionsOnly).toBe(true);
    expect(face1.unreadCount).toBe(2);
    expect(face2?.unreadCount).toBe(2); // 跨面一致（同一 @ 消息两面都计）

    // ── 变体 B：锚点悬空（游标指向被软删消息）──
    // getUnread 走降级分支但仍沿用该行设置；findMyUnreadCounts 的锚点 join 落空同样降级。
    // 若 getUnread 在悬空时把模式改判 false（本批禁止的分岔），此处两面会不等。
    await setReadCursor(topic.id, reader.id, msgs[0].id);
    await ds.getRepository(Message).softDelete({ id: msgs[0].id });

    const dangling1 = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    const dangling2 = (await agentService.findMyUnreadCounts(reader.id)).find(
      (r) => r.topicId === topic.id,
    );
    expect(dangling1.mentionsOnly).toBe(true); // 模式与锚点正交（沿用该行设置）
    expect(dangling1.unreadCount).toBe(2);
    expect(dangling2?.unreadCount).toBe(2);
    expect(dangling1.unreadCount).toBe(dangling2?.unreadCount);
  }, 30000);

  it('⑪ D1 跨面：发送不推进游标 → findMyUnreadCounts 的未读不被自己发送清零', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader);
    const [anchor] = await createMessages(topic.id, writer.id, 1);
    await setReadCursor(topic.id, reader.id, anchor.id);
    const [later] = await createMessages(topic.id, writer.id, 1); // 别人发的新消息 → 未读 1
    // ⚠️ createMessages 每次调用都从 00:00:01 起算（跨调用时间戳相同）→ 显式错开，
    // 否则 (created_at, id) 行值比较的 tie-break 落到随机 uuid，全序不确定
    await ds.query(
      `UPDATE messages SET created_at = '2024-01-01T00:00:09.000Z'::timestamptz WHERE id = $1`,
      [later.id],
    );

    const before = (await agentService.findMyUnreadCounts(reader.id)).find(
      (r) => r.topicId === topic.id,
    );
    expect(before?.unreadCount).toBe(1);

    // reader 自己发一条（既有参与行）→ 游标不动（D1）→ 未读仍是 1
    await topicService.sendMessage(topic.id, reader.id, ActorType.AGENT, {
      content: `U own send ${runSuffix()}`,
    });

    const after = (await agentService.findMyUnreadCounts(reader.id)).find(
      (r) => r.topicId === topic.id,
    );
    expect(after?.unreadCount).toBe(1);
  }, 30000);
});
