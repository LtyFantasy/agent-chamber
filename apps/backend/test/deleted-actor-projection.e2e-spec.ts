/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/spec.md §1（已删除 Actor 呈现语义契约）+ docs/api-definition.md §6.11
 *   - 补充: plan rictor-swamp-thing-hulkling.md 批次 A2/C-1 + R1/R9/R12
 *
 * [踩坑索引]
 *   - R1: Actor.deletedAt 是 @DeleteDateColumn({ select: false })——withDeleted 只解除
 *     过滤不选列，本套件经 ActorProfileService（公共解析收口点）验证投影语义，
 *     禁止自建 queryBuilder 复述（收口见 common/services/actor-profile.service.ts）
 *   - R12: topic participants 过滤 = `!profile || profile.type === SYSTEM`（真孤儿 +
 *     system 哨兵统一挡在返回数组外）——本套件用真实 system 哨兵 participant 行验证
 *   - R9: agent 名回退链 = `agents.name || actors.displayName || 'Unknown Agent'`
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
 * 已删除 Actor 消息/参与者投影语义 —— 真实 PG 集成套件（统一批 C-1，2026-08-26）
 *
 * 覆盖（契约 docs/spec.md §1 规则 1/2/3）：
 * ① 软删 agent 的消息投影：senderName 保留真名（agents.name 优先，R9）+ senderType
 *   ='agent'（A1 前被软删过滤误归 'system' 的行为变更）+ deletedAt 非空；
 * ② topic 详情 participants：软删 agent 行带 deletedAt 且 name 保留；
 * ③ participants 列表不含 system 哨兵（SYSTEM_ACTOR_ID，公告通道 join 的行，R12 过滤）；
 * ④ 未删状态对照：deletedAt 恒 null。
 *
 * 与 agent-deletion-impact.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按 FK
 * 依赖逆序硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { ActorType, AgentStatus, MessageType, TopicStatus, UserRole } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AgentService } from '../src/modules/agent/agent.service';
import { TopicService } from '../src/modules/topic/topic.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import { Board } from '../src/database/entities/board.entity';
import { Task } from '../src/database/entities/task.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { User } from '../src/database/entities/user.entity';

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
const runSuffix = (): string => `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('已删除 Actor 消息/参与者投影语义 — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let topicService: TopicService;
  let agentService: AgentService;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    messageIds: string[];
    participantIds: string[];
    topicId?: string;
    keyId?: string;
    agentId?: string;
    actorId?: string;
    systemActorCreated?: boolean;
    ownerId?: string;
    ownerActorId?: string;
  } = { messageIds: [], participantIds: [] };

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
      console.warn(
        `[deleted-actor-projection e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：ActorProfileService 三 repo（actor / agent / user）——
    // 投影语义的唯一收口点（R1），TopicService 其余依赖用空 mock（本套件
    // 只走消息投影 + participants 投影路径，不触达事件/权限/事务）
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    topicService = new TopicService(
      ds.getRepository(Topic),
      ds.getRepository(TopicParticipant),
      ds.getRepository(Message),
      ds.getRepository(User),
      ds.getRepository(Agent),
      ds.getRepository(Actor),
      {} as never, // eventService（未触达）
      ds.getRepository(Board),
      ds.getRepository(Task),
      {} as never, // accessQuery（未触达）
      {} as never, // resourceValidator（未触达）
      {} as never, // dataSource（未触达）
      {} as never, // ownerProxy（未触达）
      actorProfileService,
    );
    agentService = new AgentService(
      ds.getRepository(Agent),
      ds.getRepository(ApiKey),
      ds.getRepository(RoundtableSeat),
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
    for (const id of created.participantIds) {
      await ds
        .getRepository(TopicParticipant)
        .delete({ topicId: created.topicId!, participantId: id });
    }
    if (created.topicId) await ds.getRepository(Topic).delete({ id: created.topicId });
    if (created.keyId) await ds.getRepository(ApiKey).delete({ id: created.keyId });
    if (created.agentId) await ds.getRepository(Agent).delete({ id: created.agentId });
    if (created.actorId) await ds.getRepository(Actor).delete({ id: created.actorId });
    if (created.systemActorCreated) {
      await ds.getRepository(Actor).delete({ id: SYSTEM_ACTOR_ID });
    }
    if (created.ownerId) await ds.getRepository(User).delete({ id: created.ownerId });
    if (created.ownerActorId) await ds.getRepository(Actor).delete({ id: created.ownerActorId });
    await ds.destroy();
  }, 30000);

  /** 建 owner user + agent（actor + agents + api_key 行），返回 agent 实体 */
  async function createOwnerAndAgent(): Promise<Agent> {
    // 函数内单次取后缀：同一 it 的所有名字共享，保证断言可引用 agent.name
    const s = runSuffix();
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `C Owner ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorId = ownerActor.id;
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
    created.ownerId = owner.id;

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `C Projection Agent ${s}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorId = actor.id;
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `C Projection Agent ${s}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentId = agent.id;
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
    created.keyId = apiKey.id;
    return agent;
  }

  /** 建 topic + agent participant（status=active）+ system 哨兵 participant + 1 条消息 */
  async function createTopicWithData(agent: Agent) {
    const s = runSuffix();
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `C Projection Topic ${s}`,
        creatorId: agent.id,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicId = topic.id;

    // agent 参与者（active）
    const participant = await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: topic.id,
        participantId: agent.id,
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
        notificationSettings: { mute: false, mentions_only: false },
      }),
    );
    created.participantIds.push(participant.participantId);

    // system 哨兵参与者（公告通道 join 的行，不应出现在 participants 返回数组——R12）
    const existingSystem = await ds.getRepository(Actor).findOne({
      where: { id: SYSTEM_ACTOR_ID },
      withDeleted: true,
    });
    if (!existingSystem) {
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
    const systemParticipant = await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: topic.id,
        participantId: SYSTEM_ACTOR_ID,
        role: 'member',
        status: 'active',
        joinedAt: new Date(),
        notificationSettings: { mute: false, mentions_only: false },
      }),
    );
    created.participantIds.push(systemParticipant.participantId);

    // 消息（sender = agent）
    const msg = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agent.id,
        type: MessageType.CHAT,
        content: `C projection message ${s}`,
      }),
    );
    created.messageIds.push(msg.id);
    return { topic, msg };
  }

  it('消息列表投影：软删 agent 真名保留 + senderType=agent + deletedAt 非空（未删对照 null）', async () => {
    if (!dbAvailable) return;

    const agent = await createOwnerAndAgent();
    const { msg } = await createTopicWithData(agent);

    // ── 删除前对照：真名 + senderType='agent' + deletedAt=null ──
    const before = await (
      topicService as unknown as {
        mapToMessageDtos(
          items: Message[],
        ): Promise<Array<{ senderName: string; senderType: string; deletedAt: string | null }>>;
      }
    ).mapToMessageDtos([msg]);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      senderName: agent.name,
      senderType: 'agent',
      deletedAt: null,
    });

    // ── 软删（AgentService.remove：revoke key + 置 actors.deleted_at，A3-1）──
    const removed = await agentService.remove(agent.id);
    expect(removed).toBe(true);

    // ── 删除后：真名保留 + senderType 仍 'agent'（A1 前误归 'system' 的行为变更）+ deletedAt 非空 ──
    const after = await (
      topicService as unknown as {
        mapToMessageDtos(
          items: Message[],
        ): Promise<Array<{ senderName: string; senderType: string; deletedAt: string | null }>>;
      }
    ).mapToMessageDtos([msg]);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      senderName: agent.name,
      senderType: 'agent',
    });
    expect(after[0].deletedAt).not.toBeNull();
    expect(typeof after[0].deletedAt).toBe('string');
  }, 30000);

  it('topic 详情 participants：软删 agent 带 deletedAt + 名字保留 + 不含 system 哨兵', async () => {
    if (!dbAvailable) return;

    const agent = await createOwnerAndAgent();
    const { topic } = await createTopicWithData(agent);

    // ── 删除前：agent 参与者 deletedAt=null，system 哨兵被过滤 ──
    const before = await topicService.findOneWithParticipants(topic.id);
    expect(before.participants).toBeDefined();
    const agentBefore = before.participants!.find((p) => p.participantId === agent.id);
    expect(agentBefore).toBeDefined();
    expect(agentBefore).toMatchObject({
      participantType: 'agent',
      name: agent.name,
      deletedAt: null,
    });
    expect(before.participants!.some((p) => p.participantId === SYSTEM_ACTOR_ID)).toBe(false);

    // ── 软删 ──
    const removed = await agentService.remove(agent.id);
    expect(removed).toBe(true);

    // ── 删除后：deletedAt 非空 + 名字保留 + 哨兵仍过滤 ──
    const after = await topicService.findOneWithParticipants(topic.id);
    expect(after.participants).toBeDefined();
    const agentAfter = after.participants!.find((p) => p.participantId === agent.id);
    expect(agentAfter).toBeDefined();
    expect(agentAfter!.name).toBe(agent.name);
    expect(agentAfter!.participantType).toBe('agent');
    expect(agentAfter!.deletedAt).not.toBeNull();
    expect(after.participants!.some((p) => p.participantId === SYSTEM_ACTOR_ID)).toBe(false);
  }, 30000);
});
