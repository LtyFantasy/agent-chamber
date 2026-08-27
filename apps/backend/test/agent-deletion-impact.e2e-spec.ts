/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §5（Agents）+ docs/spec.md §1（统一批契约）
 *   - 补充: plan rictor-swamp-thing-hulkling.md §2 R13/R15 + 批次 A3
 *
 * [踩坑索引]
 *   - 铁律 #23：seatCount 的 jsonb config->>'bindActorId' 路径必须打真实 PG 验证
 *     SQL 生成（mock 单测测不出 ORM SQL）——本套件是唯一覆盖点
 *   - A3-1 R15：revoke+软删必须事务包裹（本套件断言删除后 Key 吊销状态）
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
 * Agent 删除影响面 + 删除即吊销 Key —— 真实 PG 集成套件（统一批 A3，2026-08-26）
 *
 * 覆盖：
 * ① A3-2 deletion-impact 四计数口径（openTask/message/topic/seat），其中 seatCount
 *   走 jsonb `config->>'bindActorId'` 路径——铁律 #23 硬要求打真实 PG（mock 单测
 *   测不出 ORM SQL 生成，findOne/find 嵌套 jsonb 条件生成整列等值永不命中）；
 * ② A3-1 remove() 事务化吊销：删除后 api_keys 行 revoked_at 非空 + revoked_reason
 *   = 'agent deleted'；
 * ③ 已删 agent 再调 deletion-impact → 404（findOne 软删判空）。
 *
 * 与 docspace-idempotency.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres，
 * PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按 FK 依赖逆序硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import {
  ActorType,
  AgentStatus,
  TaskStatus,
  MessageType,
  TopicStatus,
  UserRole,
  ErrorCode,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { AgentService } from '../src/modules/agent/agent.service';
import { Agent } from '../src/database/entities/agent.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { Message } from '../src/database/entities/message.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { Task } from '../src/database/entities/task.entity';
import { RoundtableSeat } from '../src/database/entities/roundtable-seat.entity';
import { User } from '../src/database/entities/user.entity';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据（清理范围） */
const RUN = `del-impact-${Date.now()}`;

describe('Agent 删除影响面 + 事务化吊销 Key — 真实 PG 集成', () => {
  let ds: DataSource;
  let service: AgentService;
  let dbAvailable = false;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: {
    seatIds: string[];
    taskIds: string[];
    listId?: string;
    boardId?: string;
    messageIds: string[];
    participantId?: string;
    topicId?: string;
    keyId?: string;
    agentId?: string;
    actorId?: string;
    ownerId?: string;
    ownerActorId?: string;
  } = { seatIds: [], taskIds: [], messageIds: [] };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
      // 与生产 AppModule 同款命名策略：未显式 name 的列（如 Agent.rateLimit）走 snake_case
      namingStrategy: new SnakeNamingStrategy(),
    });

    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[agent-deletion-impact e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：AgentService 三 repo（agent / apiKey / roundtableSeat）
    service = new AgentService(
      ds.getRepository(Agent),
      ds.getRepository(ApiKey),
      ds.getRepository(RoundtableSeat),
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.seatIds) await ds.getRepository(RoundtableSeat).delete({ id });
    for (const id of created.taskIds) await ds.getRepository(Task).delete({ id });
    if (created.listId) await ds.getRepository(BoardList).delete({ id: created.listId });
    if (created.boardId) await ds.getRepository(Board).delete({ id: created.boardId });
    for (const id of created.messageIds) await ds.getRepository(Message).delete({ id });
    if (created.participantId && created.topicId) {
      await ds
        .getRepository(TopicParticipant)
        .delete({ topicId: created.topicId, participantId: created.participantId });
    }
    if (created.topicId) await ds.getRepository(Topic).delete({ id: created.topicId });
    if (created.keyId) await ds.getRepository(ApiKey).delete({ id: created.keyId });
    if (created.agentId) await ds.getRepository(Agent).delete({ id: created.agentId });
    if (created.actorId) await ds.getRepository(Actor).delete({ id: created.actorId });
    if (created.ownerId) await ds.getRepository(User).delete({ id: created.ownerId });
    if (created.ownerActorId) await ds.getRepository(Actor).delete({ id: created.ownerActorId });
    await ds.destroy();
  }, 30000);

  it('deletion-impact 四计数口径正确（含 seatCount jsonb 路径）+ 删除后 Key 吊销 + 再查 404', async () => {
    if (!dbAvailable) return;

    // ── 1. 建 owner user + agent（actor + agents 行 + api_key 行）──
    // agents.owner_id 有物理 FK → users（onDelete RESTRICT），必须建真实 user 行；
    // users.id = actors.id（PrimaryColumn），需先建 HUMAN actor；role 用 EDITOR
    // （users 表有 idx_unique_admin 部分唯一索引，admin 已存在会撞唯一约束）
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `A3 Owner ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.ownerActorId = ownerActor.id;
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: `a3owner${RUN}`.slice(0, 50),
        email: `a3owner-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.ownerId = owner.id;
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `A3 Impact Agent ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorId = actor.id;
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `A3 Impact Agent ${RUN}`,
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
        keyHash: `hash-${RUN}`,
        keyPrefix: 'ask_xxxx',
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyId = apiKey.id;

    // ── 2. 建 topic + 拉入 participant（status=active）──
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `A3 Impact Topic ${RUN}`,
        creatorId: agent.id,
        status: TopicStatus.ACTIVE,
        settings: {},
      }),
    );
    created.topicId = topic.id;
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
    created.participantId = participant.participantId;

    // ── 3. 发消息（sender = agent）──
    const msg = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: agent.id,
        type: MessageType.CHAT,
        content: `A3 impact message ${RUN}`,
      }),
    );
    created.messageIds.push(msg.id);

    // ── 4. 建 board + list + 任务：1 个 open（todo）+ 1 个 done（openTaskCount 应排除）──
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        topicId: topic.id,
        name: `A3 Impact Board ${RUN}`,
        creatorId: agent.id,
        settings: {},
      }),
    );
    created.boardId = board.id;
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: 'To Do',
        position: 0,
        mappedStatus: null,
        color: '#e5e7eb',
      }),
    );
    created.listId = list.id;
    const openTask = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `A3 open task ${RUN}`,
        assigneeId: agent.id,
        status: TaskStatus.TODO,
      }),
    );
    created.taskIds.push(openTask.id);
    const doneTask = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `A3 done task ${RUN}`,
        assigneeId: agent.id,
        status: TaskStatus.DONE,
      }),
    );
    created.taskIds.push(doneTask.id);

    // ── 5. 建圆桌座位（config.bindActorId = agent，status=active）+ 1 个 removed（应排除）──
    const seat = await ds.getRepository(RoundtableSeat).save(
      ds.getRepository(RoundtableSeat).create({
        topicId: topic.id,
        label: `A3 Seat ${RUN}`,
        vendor: 'kimi',
        config: { permissionMode: 'default', cwd: '/tmp', bindActorId: agent.id },
        state: {},
        status: 'active',
      }),
    );
    created.seatIds.push(seat.id);
    const removedSeat = await ds.getRepository(RoundtableSeat).save(
      ds.getRepository(RoundtableSeat).create({
        topicId: topic.id,
        label: `A3 Removed Seat ${RUN}`,
        vendor: 'kimi',
        config: { permissionMode: 'default', cwd: '/tmp', bindActorId: agent.id },
        state: {},
        status: 'removed',
      }),
    );
    created.seatIds.push(removedSeat.id);

    // ── 6. 调 deletion-impact 断言四计数（jsonb 路径真实 SQL 生成验证，铁律 #23）──
    const impact = await service.getDeletionImpact(agent.id);
    expect(impact).toEqual({
      openTaskCount: 1, // done 任务被排除
      messageCount: 1,
      topicCount: 1,
      seatCount: 1, // removed 座位被排除
    });

    // ── 7. 删除 agent → 断言 Key 已吊销（revokedAt + revokedReason，A3-1）──
    const removed = await service.remove(agent.id);
    expect(removed).toBe(true);

    const keyAfterDelete = await ds.getRepository(ApiKey).findOneBy({ id: apiKey.id });
    expect(keyAfterDelete).not.toBeNull();
    expect(keyAfterDelete!.revokedAt).toBeInstanceOf(Date);
    expect(keyAfterDelete!.revokedReason).toBe('agent deleted');
    // agent 软删标记落 actors 表
    const actorAfterDelete = await ds
      .getRepository(Actor)
      .createQueryBuilder('actor')
      .withDeleted()
      .addSelect('actor.deletedAt')
      .where('actor.id = :id', { id: actor.id })
      .getOne();
    expect(actorAfterDelete?.deletedAt).toBeInstanceOf(Date);

    // ── 8. 已删 agent 再调 deletion-impact → 404（findOne 软删判空）──
    await expect(service.getDeletionImpact(agent.id)).rejects.toMatchObject({
      response: expect.objectContaining({ code: ErrorCode.AGENT_NOT_FOUND }),
    });
  }, 30000);
});
