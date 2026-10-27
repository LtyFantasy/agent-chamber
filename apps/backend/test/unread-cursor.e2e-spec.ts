/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan .kimi/plans/unread-cursor-semantics.md（v1.69 历史：D1 发送即已读 / D2 join 初始化 / D3 邀请初始化）
 *   - 主文档（现行）: docs/api-definition.md §6.11（topic 消息/未读契约）——v1.96.0-dev 未读语义批 D1/D2/D3/D4/D5 取代发送即已读
 *
 * [踩坑索引]
 *   - UNREAD-CURSOR: AUTO_JOIN_PARTICIPANT_SQL 的 INSERT 例外 + ON CONFLICT 不推进游标
 *     （D1 行为变更）mock 测不出 PG 真实执行（铁律 #23 精神），本套件直连真 PG 验证；
 *     历史消息 created_at 显式 UPDATE 到 2024 年，新发送消息 now() 天然最新，无需调全序
 *   - MENTIONS: `mentions @> '["id"]'::jsonb` / `@> '"*"'::jsonb`（数组含标量特例）与
 *     notification_settings @> 的语义只能在真 PG 上验（PG 15 实测，见 D4 用例）
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
 * 未读游标语义 —— 真实 PG 集成套件
 *
 * v1.96.0-dev 未读语义批（现行，取代 v1.69「发送即已读」）：
 * ① **D1 发送不推进既有参与者行游标**（反向断言：发送前后游标不动、未读不被清零）；
 * ② D2 新参与者 join → 游标初始化为当前最新消息，unread=0（**不受本批影响**）；
 * ③ D2 left→re-join 保留原游标 → 离开期间的消息仍计未读（**不受本批影响**）；
 * ④ D3 邀请建行游标 = 邀请时刻最新 → 邀请前历史不计，邀请后新消息计 1（**不受本批影响**）；
 * ⑤ **D1 悬空锚点：发送不自愈 → 降级全量 → markAsRead 自愈 → 0**（行为变更，取代旧
 *    「NOT EXISTS 逃生口在发送时推进」）；
 * ⑥ v1.85 降级路径排自发：无游标 + 仅自发消息 → 0 / [] / false（**不受本批影响**）；
 * ⑦ D1 INSERT 例外：无参与者行向 OPEN topic 首发 = auto-join，游标落本条（加入点即已读点）；
 * ⑧ D1 顺序/hasMore：既有行的发送不改变未读，且 unreadCount 与 messages/hasMore 同口径；
 * ⑨ D4 mentions_only 过滤：开启后只数提及我（或 @all）的消息；
 * ⑩ D4 @all 命中：mentions 含标量 `"*"` 的消息对**所有人**计入；
 * ⑪ D4 关闭模式不变：mentions_only=false → 全部消息照常计数（模式切换可逆）；
 * ⑫ D4 双点同步：TopicService.getUnread 与 AgentService.findMyUnreadCounts 同口径
 *    （同一 @ 消息两面都计 1，含锚点悬空变体）——**落点在 agent-unread.e2e-spec.ts ⑩**
 *    （跨面对照需要同时构造 TopicService 与 AgentService 两个真例，故不在本文件）；
 *   本文件只锁 TopicService 单面（⑨⑩⑪）。
 * ⑬ D2/D3 send 响应字段：unreadCount 快照 + mentions 提取结果（真 PG 落库回读）；
 * ⑭ D3 leave→@→rejoin：leave 期间被 @ 的消息在 rejoin 后进入未读；
 * ⑮ D5 PATCH 契约锁：键名读回 / 重复 true 恒附同值 / mute 保留（jsonb 合并不整列覆盖）；
 * ⑯ D3 replyTo 计入：回复某人 = 提及该父消息发送者；
 * ⑰ D6 drain：markAsRead 到指定消息后，更新的消息仍计未读（多轮排空语义）。
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
import { Attachment } from '../src/database/entities/attachment.entity';
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

describe('未读游标语义（v1.96.0-dev 未读语义批：发送不冲未读 + mentions_only）— 真实 PG 集成', () => {
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
      // v2 消息附件绑定（plan §4.1）：TopicService 构造末尾追加的 attachmentRepo
      ds.getRepository(Attachment),
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

  it('① D1 发送不推进既有参与者行游标：游标不动、未读不被清零（反向断言）', async () => {
    if (!dbAvailable) return;

    const sender = await createAgentWithOwner();
    const observer = await createAgentWithOwner();
    const topic = await createTopic(sender.id);
    // msg1 作为双方共同起点；msg2 由 observer 发出（对 sender 是"别人发的新消息"）
    const [msg1] = await createHistoryMessages(topic.id, observer.id, 1);
    await createParticipant(topic.id, sender.id, { cursor: msg1.id });
    await createParticipant(topic.id, observer.id, { cursor: msg1.id });
    const [msg2] = await createHistoryMessages(topic.id, observer.id, 1);
    void msg2;

    // 发送前：sender 有 1 条未读（observer 的 msg2）
    const beforeSend = await topicService.getUnread(topic.id, {}, sender.id, ActorType.AGENT);
    expect(beforeSend.unreadCount).toBe(1);

    const sent = await topicService.sendMessage(topic.id, sender.id, ActorType.AGENT, {
      content: `C d1 send ${runSuffix()}`,
    });

    // ① 反向断言：游标**不动**（旧 v1.69 行为会推进到 sent.id）
    expect(await getCursor(topic.id, sender.id)).toBe(msg1.id);
    expect(await getCursor(topic.id, sender.id)).not.toBe(sent.id);
    // ② 行为变更核心：发送不冲未读——sender 的未读仍是 1（旧行为会被清零）
    const afterSend = await topicService.getUnread(topic.id, {}, sender.id, ActorType.AGENT);
    expect(afterSend.unreadCount).toBe(1);
    // ③ 其他参与者同样不受影响
    expect(await getCursor(topic.id, observer.id)).toBe(msg1.id);
    const observerUnread = await topicService.getUnread(topic.id, {}, observer.id, ActorType.AGENT);
    expect(observerUnread.unreadCount).toBe(1); // sender 的 sent（msg2 是 observer 自发，不计）
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

  it('⑤ D1 悬空锚点：发送不自愈（降级全量=1）→ markAsRead 自愈 → 0', async () => {
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

    // ① 发送**不自愈**（D1 行为变更）：游标仍钉在已软删的 msg1 上，不推进到 sent.id
    //    （旧 v1.69 的 NOT EXISTS 逃生口在发送时推进——本批把自愈窗口移到读到时）
    expect(await getCursor(topic.id, sender.id)).toBe(msgs[0].id);
    expect(await getCursor(topic.id, sender.id)).not.toBe(sent.id);

    // ② 降级为全量未读（v1.85 口径 = 未软删 且非自发）：本场景只有 other 的 msgs[1]
    const degraded = await topicService.getUnread(topic.id, {}, sender.id, ActorType.AGENT);
    expect(degraded.unreadCount).toBe(1);
    expect(degraded).not.toHaveProperty('lastReadMessageId'); // 降级分支不回带锚点

    // ③ markAsRead 自愈：旧锚点已软删 → 「rows 空 → 允许推进」→ 游标跳到最新
    const markResult = await topicService.markAsRead(topic.id, sender.id, ActorType.AGENT, {});
    expect(markResult.advanced).toBe(true);
    expect(await getCursor(topic.id, sender.id)).toBe(sent.id);

    // ④ 自愈后未读归零（游标路径：sent 之后无新消息）
    const healed = await topicService.getUnread(topic.id, {}, sender.id, ActorType.AGENT);
    expect(healed.unreadCount).toBe(0);
    expect(healed.lastReadMessageId).toBe(sent.id);
  }, 30000);

  it('⑥ v1.85 降级路径排自发：无游标 + 仅自发消息 → unreadCount=0 / messages=[] / hasMore=false', async () => {
    if (!dbAvailable) return;

    const agent = await createAgentWithOwner();
    const topic = await createTopic(agent.id);
    // 参与行存在但游标为 null（从未读过 → 走降级分支）；3 条消息全自己发
    // （裸插绕过 sendMessage 的 auto-join 游标初始化——否则 INSERT 分支会写入游标，
    //  走游标路径而非本用例要锁的降级路径）
    await createParticipant(topic.id, agent.id);
    await createHistoryMessages(topic.id, agent.id, 3);

    // 三口径同源（buildUnreadMessageQb）：count/list/hasMore 一致排自发 → 0 / [] / false。
    // sender 排除若从谓词丢失，此处会得 3 / 3 条（真 PG 行为锁，mock 测不出谓词丢失）
    const unread = await topicService.getUnread(topic.id, {}, agent.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(0);
    expect(unread.messages).toEqual([]);
    expect(unread.hasMore).toBe(false);
  }, 30000);

  /**
   * 建带 mentions 的消息（直插绕过写路径提取，用于精确构造过滤场景）。
   * 注意 created_at 与其它 helper 同规显式钉到 2024 递增，保证全序确定。
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
        content: `C mention msg ${runSuffix()}`,
        mentions,
      }),
    );
    created.messageIds.push(msg.id);
    historySeq += 1;
    await ds.query(`UPDATE messages SET created_at = $2 WHERE id = $1`, [
      msg.id,
      new Date(Date.UTC(2024, 0, 1, 0, 0, historySeq)).toISOString(),
    ]);
    return msg;
  }

  /** 直接改参与行的 notification_settings（D4/D5 场景构造） */
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

  it('⑦ D1 INSERT 例外：无参与者行向 OPEN topic 首发 = auto-join，游标落本条（加入点即已读点）', async () => {
    if (!dbAvailable) return;

    const creator = await createAgentWithOwner();
    const newcomer = await createAgentWithOwner();
    const topic = await createTopic(creator.id);
    // 加入前已有 2 条历史（creator 发）——若 INSERT 例外缺失，新参与者会看到全量洪水
    await createHistoryMessages(topic.id, creator.id, 2);
    // 注意：**不建参与者行**（本次首发即 auto-join）

    const sent = await topicService.sendMessage(topic.id, newcomer.id, ActorType.AGENT, {
      content: `C first send ${runSuffix()}`,
    });

    // INSERT 分支的 $3 生效：游标 = 本条消息
    expect(await getCursor(topic.id, newcomer.id)).toBe(sent.id);
    // 加入点即已读点：加入前历史不计入 → 未读 0
    const unread = await topicService.getUnread(topic.id, {}, newcomer.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(0);
    expect(unread.lastReadMessageId).toBe(sent.id);
    // 与 join() 的初始化语义一致（② 用例同一契约）
    const joined = await createAgentWithOwner();
    await topicService.join(topic.id, joined.id, ActorType.AGENT);
    expect(await getCursor(topic.id, joined.id)).toBe(sent.id);
  }, 30000);

  it('⑧ D1 顺序/hasMore：既有行的发送不改变未读，unreadCount 与 messages/hasMore 同口径', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader.id);
    // reader 游标 = 话题开头（无游标）→ 走降级全量路径；writer 发 3 条
    await createParticipant(topic.id, reader.id);
    await createHistoryMessages(topic.id, writer.id, 3);

    const before = await topicService.getUnread(topic.id, { limit: 2 }, reader.id, ActorType.AGENT);
    expect(before.unreadCount).toBe(3);
    expect(before.messages).toHaveLength(2);
    expect(before.hasMore).toBe(true); // 3 未读 / 2 返回

    // reader 发送一条（自己发的不计入）→ 未读数不变，顺序/分页口径不变
    await topicService.sendMessage(topic.id, reader.id, ActorType.AGENT, {
      content: `C own send ${runSuffix()}`,
    });

    const after = await topicService.getUnread(topic.id, { limit: 2 }, reader.id, ActorType.AGENT);
    expect(after.unreadCount).toBe(3);
    expect(after.messages).toHaveLength(2);
    expect(after.hasMore).toBe(true);
    // 消息列表恒按全序 ASC（最老优先），且不含自发消息
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages.every((m) => m.senderId !== reader.id)).toBe(true);
  }, 30000);

  it('⑨ D4 mentions_only 过滤：开启后只数提及我（或 @all）的消息', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader.id);
    await createParticipant(topic.id, reader.id); // 无游标 → 降级全量
    // 3 条他人消息：1 条点名 reader、1 条 @all、1 条谁都没提
    await createMessageWithMentions(topic.id, writer.id, [reader.id.toLowerCase()]);
    await createMessageWithMentions(topic.id, writer.id, ['*']);
    await createMessageWithMentions(topic.id, writer.id, []);

    // 关闭模式：3 条全算
    const off = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(off.unreadCount).toBe(3);
    expect(off.mentionsOnly).toBe(false);

    await setNotificationSettings(topic.id, reader.id, { mute: false, mentions_only: true });

    // 开启模式：只剩「点名我」+「@all」两条
    const on = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(on.mentionsOnly).toBe(true);
    expect(on.unreadCount).toBe(2);
    expect(on.messages).toHaveLength(2);
    expect(on.hasMore).toBe(false);
    // 未提及的那条确实不在列表里（谓词真的生效，而不是只改了计数）
    const listed = on.messages.map((m) => m.content);
    expect(listed.some((c) => c.includes('mention msg'))).toBe(true);
  }, 30000);

  it('⑩ D4 @all（mentions 含标量 "*"）对所有人计入', async () => {
    if (!dbAvailable) return;

    const a = await createAgentWithOwner();
    const b = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(writer.id);
    await createParticipant(topic.id, a.id);
    await createParticipant(topic.id, b.id);
    await createMessageWithMentions(topic.id, writer.id, ['*']);

    // 两个不同 actor 都命中（'"*"'::jsonb 数组含标量特例的真 PG 实证）
    for (const who of [a, b]) {
      await setNotificationSettings(topic.id, who.id, { mentions_only: true });
      const unread = await topicService.getUnread(topic.id, {}, who.id, ActorType.AGENT);
      expect(unread.mentionsOnly).toBe(true);
      expect(unread.unreadCount).toBe(1);
    }
  }, 30000);

  it('⑪ D4 关闭模式不变：mentions_only=false → 全部消息照常计数（切换可逆）', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader.id);
    await createParticipant(topic.id, reader.id);
    await createMessageWithMentions(topic.id, writer.id, [reader.id.toLowerCase()]);
    await createMessageWithMentions(topic.id, writer.id, []);

    // 开 → 关：计数回到全量（模式切换非单向）
    await setNotificationSettings(topic.id, reader.id, { mentions_only: true });
    const on = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(on.unreadCount).toBe(1);

    await setNotificationSettings(topic.id, reader.id, { mentions_only: false });
    const off = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(off.mentionsOnly).toBe(false);
    expect(off.unreadCount).toBe(2);
  }, 30000);

  it('⑬ D2/D3 send 响应字段：unreadCount 快照 + mentions 真 PG 落库回读', async () => {
    if (!dbAvailable) return;

    const sender = await createAgentWithOwner();
    const target = await createAgentWithOwner();
    const topic = await createTopic(sender.id);
    const [anchor] = await createHistoryMessages(topic.id, target.id, 1);
    await createParticipant(topic.id, sender.id, { cursor: anchor.id });
    await createParticipant(topic.id, target.id, { cursor: anchor.id });
    // 一条 target 发的、点名 sender 的消息 → sender 未读 1，且 target 名字可被 @
    await createMessageWithMentions(topic.id, target.id, [sender.id.toLowerCase()]);

    const sent = await topicService.sendMessage(topic.id, sender.id, ActorType.AGENT, {
      content: `@${target.name} please take a look`,
    });

    // mentions：@target 的显示名 → target 的 id（真 PG 上 resolveProfiles 走真库）
    expect(sent.mentions).toEqual([target.id.toLowerCase()]);
    // unreadCount：sender 视角 = target 那 1 条（sent 本身是自发，不计入）
    expect(sent.unreadCount).toBe(1);
    // 落库回读：mentions 列真的写了
    const row = await ds.getRepository(Message).findOne({ where: { id: sent.id } });
    expect(row?.mentions).toEqual([target.id.toLowerCase()]);
  }, 30000);

  it('⑭ D3 leave→@→rejoin：leave 期间被 @ 的消息在 rejoin 后进入未读', async () => {
    if (!dbAvailable) return;

    const member = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(writer.id);
    // member 处于 left（有行、非 invited/active）→ 不进未读汇总
    await createParticipant(topic.id, member.id, { status: 'left', cursor: null });
    const [anchor] = await createHistoryMessages(topic.id, writer.id, 1);
    await ds
      .getRepository(TopicParticipant)
      .update({ topicId: topic.id, participantId: member.id }, { lastReadMessageId: anchor.id });
    await setNotificationSettings(topic.id, member.id, { mentions_only: true });
    // leave 期间被 @
    await createMessageWithMentions(topic.id, writer.id, [member.id.toLowerCase()]);

    // 写时提取**包含 left 行**（D3 全谱规则）：@ 被真的记进了 mentions 列
    // ——若候选只取 active 行，这条 @ 会永久丢失（rejoin 后也无从恢复）
    const mentionRow = await ds
      .getRepository(Message)
      .findOne({ where: { topicId: topic.id }, order: { createdAt: 'DESC' } });
    expect(mentionRow?.mentions).toEqual([member.id.toLowerCase()]);

    // 注：per-topic getUnread **没有** status 门槛（既有语义，本批不改），故 left 期间
    // 该 @ 仍会出现在其 per-topic 未读里；「left 不进跨 topic 汇总（status IN
    // invited/active）」由 agent-unread.e2e-spec.ts 锁。

    // rejoin：游标保留（leave 期间消息仍算未读）→ 被 @ 的那条现在计入
    await topicService.join(topic.id, member.id, ActorType.AGENT);
    expect(await getCursor(topic.id, member.id)).toBe(anchor.id);
    const after = await topicService.getUnread(topic.id, {}, member.id, ActorType.AGENT);
    expect(after.mentionsOnly).toBe(true);
    expect(after.unreadCount).toBe(1);
  }, 30000);

  it('⑮ D5 PATCH 契约锁：键名读回 / 重复 true 恒附同值 / mute 保留', async () => {
    if (!dbAvailable) return;

    const actor = await createAgentWithOwner();
    const topic = await createTopic(actor.id);
    await createParticipant(topic.id, actor.id);
    // 预置 mute=true（未被接线的既有键——合并必须保留它，不能整列覆盖）
    await setNotificationSettings(topic.id, actor.id, { mute: true, mentions_only: false });
    const [m1] = await createHistoryMessages(topic.id, actor.id, 1);
    void m1;
    const other = await createAgentWithOwner();
    await createParticipant(topic.id, other.id);
    await createHistoryMessages(topic.id, other.id, 2); // 2 条他人消息（无提及）

    const first = await topicService.updateNotificationSettings(topic.id, actor.id, {
      mentionsOnly: true,
    });
    // 键名读回（库读回，不是内存推导）
    expect(first.mentionsOnly).toBe(true);
    // 模式为 true → hiddenUnreadCount 恒附（状态语义）；定义 = off − on = 2 − 0
    expect(first.hiddenUnreadCount).toBe(2);
    // mute 被保留（jsonb 合并，不是整列覆盖）
    const row = await ds.getRepository(TopicParticipant).findOne({
      where: { topicId: topic.id, participantId: actor.id },
    });
    expect(row?.notificationSettings).toEqual({ mute: true, mentions_only: true });

    // 重复提交同一值 → 同结果（幂等；hiddenUnreadCount 恒附同值）
    const second = await topicService.updateNotificationSettings(topic.id, actor.id, {
      mentionsOnly: true,
    });
    expect(second).toEqual(first);

    // 关闭 → 模式为 false 时**省略** hiddenUnreadCount（省略 ≠ 0）
    const off = await topicService.updateNotificationSettings(topic.id, actor.id, {
      mentionsOnly: false,
    });
    expect(off.mentionsOnly).toBe(false);
    expect(off).not.toHaveProperty('hiddenUnreadCount');
    // mute 仍在
    const row2 = await ds.getRepository(TopicParticipant).findOne({
      where: { topicId: topic.id, participantId: actor.id },
    });
    expect(row2?.notificationSettings).toEqual({ mute: true, mentions_only: false });
  }, 30000);

  it('⑯ D3 replyTo 计入：回复某人 = 提及该父消息发送者', async () => {
    if (!dbAvailable) return;

    const replier = await createAgentWithOwner();
    const author = await createAgentWithOwner();
    const topic = await createTopic(replier.id);
    await createParticipant(topic.id, replier.id);
    await createParticipant(topic.id, author.id);
    const [parent] = await createHistoryMessages(topic.id, author.id, 1);

    // 正文完全没有 @，只有 replyTo → 必须仍把 author 记进 mentions（闭环）
    const sent = await topicService.sendMessage(topic.id, replier.id, ActorType.AGENT, {
      content: 'replying without any at-sign',
      replyTo: parent.id,
    });

    expect(sent.mentions).toEqual([author.id.toLowerCase()]);
    // 对 author 而言：replier 的这条点名了他 → 未读可见（开静默后仍可见）
    await setNotificationSettings(topic.id, author.id, { mentions_only: true });
    const authorUnread = await topicService.getUnread(topic.id, {}, author.id, ActorType.AGENT);
    expect(authorUnread.mentionsOnly).toBe(true);
    expect(authorUnread.unreadCount).toBe(1);
  }, 30000);

  it('⑰ D6 drain：markAsRead 到指定消息后，更新的消息仍计未读（多轮排空语义）', async () => {
    if (!dbAvailable) return;

    const reader = await createAgentWithOwner();
    const writer = await createAgentWithOwner();
    const topic = await createTopic(reader.id);
    await createParticipant(topic.id, reader.id, { cursor: null });
    const msgs = await createHistoryMessages(topic.id, writer.id, 3);

    // 只标到第 2 条（= digest 只看到前 2 条时的精确推进）
    const marked = await topicService.markAsRead(topic.id, reader.id, ActorType.AGENT, {
      messageId: msgs[1].id,
    });
    expect(marked.advanced).toBe(true);

    // 第 3 条仍计未读 —— 这正是"多轮 drain"契约：取读之间新到/未返回的消息不被吞掉
    const unread = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(unread.unreadCount).toBe(1);
    expect(unread.messages.map((m) => m.id)).toEqual([msgs[2].id]);

    // 再标到第 3 条 → 收敛为 0（drain 收敛）
    await topicService.markAsRead(topic.id, reader.id, ActorType.AGENT, {
      messageId: msgs[2].id,
    });
    const drained = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(drained.unreadCount).toBe(0);

    // 排空后新到消息重新计入（"取读之间新到消息仍计未读"）
    await createHistoryMessages(topic.id, writer.id, 1);
    const fresh = await topicService.getUnread(topic.id, {}, reader.id, ActorType.AGENT);
    expect(fresh.unreadCount).toBe(1);
  }, 30000);
});
