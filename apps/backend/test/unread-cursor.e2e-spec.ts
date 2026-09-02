/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan .kimi/plans/unread-cursor-semantics.md（D1 发送即已读 / D2 join 初始化 / D3 邀请初始化）
 *   - 补充: docs/api-definition.md §6.11（topic 消息/未读契约）
 *
 * [踩坑索引]
 *   - UNREAD-CURSOR: AUTO_JOIN_PARTICIPANT_SQL 的 ON CONFLICT CASE 语义（单调推进方向、
 *     旧锚点软删 NOT EXISTS 逃生口）mock 测不出 PG 真实执行（铁律 #23 精神），
 *     本套件直连真 PG 验证五场景；历史消息 created_at 显式 UPDATE 到 2024 年，
 *     新发送消息 now() 天然最新，无需调全序
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
 * 未读游标语义修正（v1.69，Kimi-Kairos 反馈采纳）—— 真实 PG 集成套件
 *
 * 覆盖（plan unread-cursor-semantics.md §测试 五场景）：
 * ① D1 发送即已读：发送者游标推进到自己刚发的消息，自己消息不计入自己未读；
 *    其他参与者游标不动、未读 +1（ON CONFLICT CASE 比较方向实证）。
 * ② D2 新参与者 join → 游标初始化为当前最新消息，unread=0。
 * ③ D2 left→re-join 保留原游标 → 离开期间的消息仍计未读。
 * ④ D3 邀请建行游标 = 邀请时刻最新 → 邀请前历史不计，邀请后新消息计 1。
 * ⑤ D1 悬空锚点逃生口：游标锚定消息被软删后再发消息 → 游标正常推进、
 *    unread 不退化为全量（NOT EXISTS 分支方向实证）。
 *
 * 环境约定与 agent-unread.e2e-spec.ts 同款：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，
 * afterAll 按 FK 依赖逆序硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { ActorType, AgentStatus, MessageType, TopicStatus, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { TopicService } from '../src/modules/topic/topic.service';
import { EventService } from '../src/modules/event/event.service';
import { AccessQueryService } from '../src/common/services/access-query.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import { User } from '../src/database/entities/user.entity';
import { Board } from '../src/database/entities/board.entity';
import { Task } from '../src/database/entities/task.entity';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据 */
const runSuffix = (): string => `cur-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('未读游标语义修正（v1.69 发送即已读 + join/邀请初始化）— 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let topicService: TopicService;

  /** 本次运行创建的实体（afterAll 按 FK 依赖逆序清理） */
  const created = {
    messageIds: [] as string[],
    participantKeys: [] as { topicId: string; participantId: string }[],
    topicIds: [] as string[],
    keyIds: [] as string[],
    agentIds: [] as string[],
    actorIds: [] as string[],
    ownerIds: [] as string[],
    ownerActorIds: [] as string[],
  };

  /**
   * 历史消息 created_at 序列全局计数器（模块级，套件内串行执行，无并行共享问题）：
   * createHistoryMessages 跨调用共享递增——否则每次调用都从 00:00:01 起算，测试④
   * 邀请前后各建 1 条时 msg1/msg2 created_at 相同，getUnread 行值比较 tie-break 落到
   * 随机 uuid，约 1/3 概率 msg2.id < msg1.id → unreadCount=0 断言失败（08-29 实测
   * 1139fde9 偶发）
   */
  let historySeq = 0;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[unread-cursor e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // 与生产同构直连 TopicService；事件/审计/访问查询非被测面，最小桩替代
    // （避免 events/audit_logs 表写入与 ACCESS_QUERY_STORE 依赖，减少清理面）
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
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
    for (const key of created.participantKeys) {
      await ds.getRepository(TopicParticipant).delete({
        topicId: key.topicId,
        participantId: key.participantId,
      });
    }
    for (const id of created.topicIds) await ds.getRepository(Topic).delete({ id });
    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    for (const id of created.ownerIds) await ds.getRepository(User).delete({ id });
    for (const id of created.ownerActorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
  }, 30000);

  /** 建 owner user + agent（actor + agents + api_key 行），返回 agent 实体 */
  async function createAgentWithOwner(): Promise<Agent> {
    const s = runSuffix();
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `C Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `cowner${s}`.slice(0, 50),
        email: `cowner-${s}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerIds.push(owner.id);

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `C Agent ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `C Agent ${s}`,
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

  /** 建 open topic（visibility 缺省 = open，sendMessage 无私密门禁） */
  async function createTopic(creatorId: string): Promise<Topic> {
    const s = runSuffix();
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `C Cursor Topic ${s}`,
        creatorId,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicIds.push(topic.id);
    return topic;
  }

  /** 建参与行（status/cursor 可指定），返回行 */
  async function createParticipant(
    topicId: string,
    participantId: string,
    opts: { status?: 'invited' | 'active' | 'left'; cursor?: string | null } = {},
  ): Promise<TopicParticipant> {
    const status = opts.status ?? 'active';
    const row = await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId,
        participantId,
        role: 'member',
        status,
        joinedAt: status === 'invited' ? null : new Date(),
        leftAt: status === 'left' ? new Date() : null,
        notificationSettings: { mute: false, mentions_only: false },
        lastReadMessageId: opts.cursor ?? null,
      }),
    );
    created.participantKeys.push({ topicId, participantId });
    return row;
  }

  /**
   * 建 count 条历史消息，created_at 显式钉到 2024-01-01 起递增（全序确定）；
   * 服务路径新发送的消息 created_at=now() 天然晚于全部历史消息。
   * 起始秒 = historySeq（跨调用全局递增，见上），保证多次调用间 created_at 严格递增。
   */
  async function createHistoryMessages(
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
          content: `C history message ${i} ${runSuffix()}`,
        }),
      );
      created.messageIds.push(msg.id);
      msgs.push(msg);
    }
    for (let i = 0; i < msgs.length; i++) {
      // 完整时间戳参数（非 '00:00:0N' 字符串拼接）：historySeq 递增无个位上限，
      // 秒数 > 59 时 Date.UTC 自动进位到分钟/小时
      const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, historySeq + i + 1)).toISOString();
      await ds.query(`UPDATE messages SET created_at = $2 WHERE id = $1`, [msgs[i].id, ts]);
    }
    historySeq += count;
    return msgs;
  }

  /** 查参与行游标（直查库，绕开任何读路径加工） */
  async function getCursor(topicId: string, participantId: string): Promise<string | null> {
    const row = await ds.getRepository(TopicParticipant).findOne({
      where: { topicId, participantId },
    });
    return row?.lastReadMessageId ?? null;
  }

  it('① D1 发送即已读：发送者游标推进到自己消息、自己未读=0；其他参与者游标不动、未读+1', async () => {
    if (!dbAvailable) return;

    const sender = await createAgentWithOwner();
    const observer = await createAgentWithOwner();
    const topic = await createTopic(sender.id);
    const [msg1] = await createHistoryMessages(topic.id, observer.id, 1);
    await createParticipant(topic.id, sender.id, { cursor: msg1.id });
    await createParticipant(topic.id, observer.id, { cursor: msg1.id });

    const sent = await topicService.sendMessage(topic.id, sender.id, ActorType.AGENT, {
      content: `C d1 send ${runSuffix()}`,
    });

    // 发送者游标推进到自己刚发的消息（ON CONFLICT CASE 比较方向实证）
    expect(await getCursor(topic.id, sender.id)).toBe(sent.id);
    // 其他参与者游标不动
    expect(await getCursor(topic.id, observer.id)).toBe(msg1.id);

    // 发送者自己未读=0（自己消息不计入）；观察者未读=1
    const senderUnread = await topicService.getUnread(topic.id, {}, sender.id, ActorType.AGENT);
    expect(senderUnread.unreadCount).toBe(0);
    const observerUnread = await topicService.getUnread(topic.id, {}, observer.id, ActorType.AGENT);
    expect(observerUnread.unreadCount).toBe(1);
  }, 30000);

  it('② D2 新参与者 join → 游标初始化为当前最新消息，unread=0', async () => {
    if (!dbAvailable) return;

    const creator = await createAgentWithOwner();
    const newcomer = await createAgentWithOwner();
    const topic = await createTopic(creator.id);
    const msgs = await createHistoryMessages(topic.id, creator.id, 2);

    await topicService.join(topic.id, newcomer.id, ActorType.AGENT);

    expect(await getCursor(topic.id, newcomer.id)).toBe(msgs[1].id);
    const unread = await topicService.getUnread(topic.id, {}, newcomer.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(0);
  }, 30000);

  it('③ D2 left→re-join 保留原游标 → 离开期间消息仍计未读', async () => {
    if (!dbAvailable) return;

    const creator = await createAgentWithOwner();
    const rejoiner = await createAgentWithOwner();
    const topic = await createTopic(creator.id);
    const msgs = await createHistoryMessages(topic.id, creator.id, 2);
    // left 时游标停在 msg1（msg2 是离开期间到达的）
    await createParticipant(topic.id, rejoiner.id, { status: 'left', cursor: msgs[0].id });

    await topicService.join(topic.id, rejoiner.id, ActorType.AGENT);

    // 游标保留 msg1，不被重置为 msg2
    expect(await getCursor(topic.id, rejoiner.id)).toBe(msgs[0].id);
    const unread = await topicService.getUnread(topic.id, {}, rejoiner.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(1);
  }, 30000);

  it('④ D3 邀请建行游标=邀请时刻最新 → 邀请前历史不计、邀请后新消息计 1', async () => {
    if (!dbAvailable) return;

    const creator = await createAgentWithOwner();
    const invitee = await createAgentWithOwner();
    const topic = await createTopic(creator.id);
    const [msg1] = await createHistoryMessages(topic.id, creator.id, 1);

    await topicService.inviteAgent(topic.id, invitee.id);

    // invited 行游标 = 邀请时刻最新消息
    expect(await getCursor(topic.id, invitee.id)).toBe(msg1.id);

    // 邀请后到达的新消息计入未读
    const [msg2] = await createHistoryMessages(topic.id, creator.id, 1);
    void msg2;
    const unread = await topicService.getUnread(topic.id, {}, invitee.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(1);
  }, 30000);

  it('⑤ D1 悬空锚点逃生口：游标锚定消息被软删后再发消息 → 游标推进、unread 不退化全量', async () => {
    if (!dbAvailable) return;

    const sender = await createAgentWithOwner();
    const other = await createAgentWithOwner();
    const topic = await createTopic(sender.id);
    const msgs = await createHistoryMessages(topic.id, other.id, 2);
    // 发送者游标锚在 msg1，随后 msg1 被软删（锚点悬空）
    await createParticipant(topic.id, sender.id, { cursor: msgs[0].id });
    await ds.getRepository(Message).softDelete({ id: msgs[0].id });

    const sent = await topicService.sendMessage(topic.id, sender.id, ActorType.AGENT, {
      content: `C dangling ${runSuffix()}`,
    });

    // NOT EXISTS 逃生口：悬空游标仍推进到新消息（比较方向实证——
    // 若逃生口缺失/写反，游标钉在已删 msg1，getUnread 降级全量=2 而非 0）
    expect(await getCursor(topic.id, sender.id)).toBe(sent.id);
    const unread = await topicService.getUnread(topic.id, {}, sender.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(0);
  }, 30000);
});
