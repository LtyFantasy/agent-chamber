/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期批 2「**编排器路由泛化**」的真实 PG 守卫：`NotifyOrchestrator.resolveRecipients`
 *     的双层判据（安全层 read ∧ 注意力层成员/归属）、候选集合查询、快照缓存与失效、查询计数。
 *
 * [代码职责]
 *   - 钉死**真实 SQL 生成物**能给出的结论（mock 给不出的那一半）：
 *     ① 候选集合的**嵌套关系过滤**真的按 `actors.deleted_at IS NULL` 过滤（软删用户零候选）；
 *     ② `AccessQueryService` 剖面在真库上的 open / creator(含 owner-proxy) / member / admin 判定；
 *     ③ `doc_deleted` 的 `withDeleted` 变体（整空间删除后仍能判权限）；
 *     ④ D4 播种出来的 `env_seed` 行**真的被解析成候选**（升级日回归门）；
 *     ⑤ 路由查询数与候选人数**无关**（TypeORM logger 计真实 SQL 条数）。
 *   - 不重复单测已覆盖的纯逻辑（自回声 / single-flight / 偏好 / 失效钩子语义 —— 那些不需要 DB）。
 *
 * [权威文档]
 *   - 主文档: plan `red-tornado-wonder-woman-blue-devil.md` §D3（双层判据 / 逐类别表 / 快照 /
 *     性能承诺）/ §D7（安全矩阵）/ §5 风险表（残留声明）
 *
 * [关键不变量]
 *   - **本套件的主语是"路由判据"，不是"投递"**：直接调 `resolveRecipients(event, category)` 并断言
 *     返回的 userId 集合，不经过渲染/节流/出口（那些由 notifications-pipeline.e2e-spec.ts 守卫）。
 *   - **候选集合必须走真实 PG**：`channelRepo.find({ where: {...deliveryEligibleWhere(), user:
 *     { actor: { deletedAt: IsNull() } } } })` 的**关系路径过滤**是 ORM 生成物——mock 只能证明
 *     "查询被发出去了"，证明"软删用户的绑定真的不被算作候选"只有真库能给（铁律 #23）。
 *   - **权限判据零缓存**：剖面每个事件实时查询 ⇒ 本套件不需要（也不该）在用例之间清任何权限缓存。
 *   - **快照缓存要清**：`resolveRecipients` 的 per-user 快照是进程内的，跨用例必须清（否则
 *     "改了绑定但快照还在"会让断言假绿）。
 *   - **共享开发库卫生**：全部数据带 RUN 后缀 / 唯一 email；afterAll 按 id 硬删
 *     （`user_notification_channels` 有 FK CASCADE ⇒ 删 user 行即连带清理）。
 *
 * [持久踩坑]
 *   本文件的所有断言都必须在**同一进程的同一个 orchestrator 实例**上做——`resolveRecipients`
 *   的缓存与内存态是实例级的，每个用例新建实例会让"缓存相关"的断言失去意义（也会让播种重复跑）。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查) #23(jsonb/真库行为)
 * =============================================================================
 */
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  ActorType,
  AgentStatus,
  EventType,
  ParticipantStatus,
  ResourceType,
  UserRole,
} from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Task } from '../src/database/entities/task.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { User } from '../src/database/entities/user.entity';
import { UserNotificationChannel } from '../src/database/entities/user-notification-channel.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { NotificationsModule } from '../src/modules/notifications/notifications.module';
import {
  NotifyOrchestrator,
  type NotifyRecipient,
} from '../src/modules/notifications/notify-orchestrator.service';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORY,
  NOTIFY_CATEGORIES,
  type NotificationsConfig,
} from '../src/config/notifications.config';

/** 本地开发库连接（与既有真 PG 套件同约定） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离本套件写入的数据） */
const RUN = `ntrt-${Date.now().toString(36)}`;

/** 播种源用户名（配置里恰好一人 ⇒ D4 会给他落一条 `env_seed` 绑定） */
const SEEDED_USERNAME = `ntrtseed${RUN}`.slice(0, 50);

/** 播种地址（`FEISHU_RECIPIENT_OPEN_ID`；本套件不给任何出口，纯路由断言） */
const SEEDED_ADDRESS = `ou_seed_${RUN}`;

/**
 * 真实 SQL 计数器（TypeORM logger）。
 *
 * `logging: ['query']` + 自定义 logger ⇒ 每条经驱动的 SQL 都进 `count`（含 ORM 生成的 join/子查询）。
 * 这是"查询数与候选人数无关"这条承诺唯一诚实的证据来源。
 */
const queryCounter = { count: 0, statements: [] as string[] };
const countingLogger = {
  logQuery(query: string): void {
    queryCounter.count += 1;
    if (queryCounter.statements.length < 200) queryCounter.statements.push(query);
  },
  logQueryError(): void {},
  logQuerySlow(): void {},
  logSchemaBuild(): void {},
  logMigration(): void {},
  log(): void {},
};

const NOTIFY_TEST_CONFIG: NotificationsConfig = {
  ...NOTIFICATIONS_CONFIG_FALLBACK,
  enabled: true,
  categories: [...NOTIFY_CATEGORIES],
  // ⚠️ 必须含 'feishu'：D4 播种的前提之一是"providers 含 feishu"（本套件不投递，
  // 但播种判据要过）——否则 env_seed 回归门会静默"没播种"，测成假绿
  providers: ['feishu'],
  // D4 播种三件套（假值即可：本套件没有出口，凭据只参与"能不能播种"这一个判据）
  feishuAppId: 'cli_routing_e2e',
  feishuAppSecret: 'routing-e2e-secret',
  feishuRecipientOpenId: SEEDED_ADDRESS,
  ownerUsernames: [SEEDED_USERNAME],
  webBaseUrl: 'https://platform.example.com',
  globalRateLimit: 100,
};

/**
 * 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态）。
 *
 * ⚠️ 为什么要它：`NotificationsModule` 装配了 `NotificationsController`，其方法级守卫
 * `JwtOrApiKeyGuard` 在**声明它的模块上下文**里实例化，依赖 `JwtService` / `ApiKeyAuthService`
 * ——不提供就会在 `Test.createTestingModule().compile()` 阶段直接报
 * "Nest can't resolve dependencies of the JwtOrApiKeyGuard"（本套件不发 HTTP，但装配是整体的）。
 */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get('jwt.secret'),
        signOptions: { expiresIn: '2h' },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([User, ApiKey, Agent]),
  ],
  providers: [JwtStrategy, ApiKeyAuthService, JwtAuthGuard, JwtOrApiKeyGuard, RolesGuard],
  exports: [
    JwtModule,
    PassportModule,
    TypeOrmModule,
    ApiKeyAuthService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    RolesGuard,
  ],
})
class NotifyRoutingAuthModule {}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => ({ jwt: { secret: 'notify-routing-e2e-secret' }, notifications: NOTIFY_TEST_CONFIG }),
      ],
    }),
    // 编排器的 `@OnEvent` 订阅需要 EventEmitter2（生产由 AppModule 提供）
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: ['query'],
      logger: countingLogger,
    }),
    NotifyRoutingAuthModule,
    CommonModule,
    PermissionModule,
    NotificationsModule,
  ],
})
class NotifyRoutingE2eModule {}

describe('通知路由双层判据（Notifications 二期批 2）— 真实 PG', () => {
  let app: INestApplication;
  let ds: DataSource;
  let orchestrator: NotifyOrchestrator;
  let dbAvailable = false;

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    boardIds: [] as string[],
    spaceIds: [] as string[],
    topicIds: [] as string[],
    docIds: [] as string[],
  };

  /** 播种出来的用户（env_seed 行的归属） */
  let seededUserId: string;
  /** 另一个人类（被邀请成成员 / 被指派，用于"注意力层"的正侧） */
  let memberUserId: string;
  /**
   * ⚠️ **本套件刻意不造 admin 账号**：`idx_unique_admin` 是**全库唯一**的部分唯一索引
   * （`users(role) WHERE role='admin'`），再造一个必撞 23505（实证）。
   * "admin 安全层通过"这条矩阵项由 `test/access-profile.e2e-spec.ts` 在**剖面方法本身**上守卫
   * （那里同样复用已存在的 admin）——路由层对 admin 无特判（剖面返回什么就用什么），
   * 无需重复断言。
   */
  /** 拥有合格绑定但 actor 被软删的用户（候选集合必须把他滤掉） */
  let softDeletedUserId: string;
  /** seeded 用户名下的 agent（owner-proxy 用） */
  let seededAgentId: string;

  jest.setTimeout(60_000);

  // ─── 数据构造 ────────────────────────────────────────────────────

  /** 造人类 actor + users 行（返回 userId） */
  async function createHuman(
    role: UserRole,
    label: string,
    username = `${RUN}-${label}`,
  ): Promise<string> {
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `${RUN} ${label}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        actor,
        username: username.slice(0, 50),
        email: `${RUN}-${label}@example.com`,
        authProvider: 'local',
        role,
        preferences: { notificationCategories: allCategoriesEnabled() },
      }),
    );
    created.userIds.push(user.id);
    return user.id;
  }

  /** 全类别打开的用户偏好（用户缺省只含 task_done+direct，会被偏好层整体拦掉 ⇒ 用例要显式打开） */
  function allCategoriesEnabled(): Record<string, boolean> {
    return Object.fromEntries(NOTIFY_CATEGORIES.map((category) => [category, true]));
  }

  /** 给某用户插一条 deliveryEligible 的飞书绑定（地址按 label 唯一，避免撞部分唯一索引） */
  async function bindChannel(userId: string, label: string): Promise<void> {
    await ds.getRepository(UserNotificationChannel).save(
      ds.getRepository(UserNotificationChannel).create({
        userId,
        provider: 'feishu',
        recipientAddress: `ou_${RUN}_${label}`,
        enabled: true,
        lastTestStatus: 'ok',
        lastTestAddress: `ou_${RUN}_${label}`,
        source: 'user',
      }),
    );
  }

  /** 造「看板 → 列 → 任务」链 */
  async function createBoard(
    label: string,
    opts: { creatorId: string; visibility?: string; memberIds?: string[] },
  ): Promise<{ boardId: string; listId: string; taskId: string }> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `${RUN} board ${label}`,
        creatorId: opts.creatorId,
        settings: { visibility: opts.visibility ?? 'open' },
        taskCount: 0,
        completedTaskCount: 0,
      }),
    );
    created.boardIds.push(board.id);
    for (const actorId of opts.memberIds ?? []) {
      await ds
        .getRepository(BoardMember)
        .save(
          ds
            .getRepository(BoardMember)
            .create({ boardId: board.id, actorId, role: 'member', invitedBy: null }),
        );
    }
    const list = await ds
      .getRepository(BoardList)
      .save(
        ds
          .getRepository(BoardList)
          .create({ boardId: board.id, name: `${RUN} list ${label}`, position: 0 }),
      );
    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `${RUN} task ${label}`,
        description: null,
        position: 0,
        customFields: {},
      }),
    );
    return { boardId: board.id, listId: list.id, taskId: task.id };
  }

  /** 造「空间 → 文档」对 */
  async function createSpaceWithDoc(
    label: string,
    opts: { creatorId: string; visibility?: string; createdBy: string },
  ): Promise<{ spaceId: string; docId: string }> {
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `${RUN} space ${label}`,
        slug: `${RUN}-space-${label}`,
        creatorId: opts.creatorId,
        settings: { visibility: opts.visibility ?? 'open' },
      }),
    );
    created.spaceIds.push(space.id);
    const doc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: space.id,
        path: `${RUN}/${label}.md`,
        title: `${RUN} doc ${label}`,
        createdBy: opts.createdBy,
      }),
    );
    created.docIds.push(doc.id);
    return { spaceId: space.id, docId: doc.id };
  }

  /** 造话题 + 参与者行 */
  async function createTopic(label: string, participantIds: string[]): Promise<string> {
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `${RUN} topic ${label}`,
        description: null,
        creatorId: seededAgentId,
        status: 'active' as never,
      }),
    );
    created.topicIds.push(topic.id);
    for (const participantId of participantIds) {
      await ds.getRepository(TopicParticipant).save(
        ds.getRepository(TopicParticipant).create({
          topicId: topic.id,
          participantId,
          role: 'member',
          status: ParticipantStatus.ACTIVE,
          // active 行必须带 joinedAt（DB CHECK: status != 'active' OR joined_at IS NOT NULL）
          joinedAt: new Date(),
          leftAt: null,
          notificationSettings: { mute: false, mentions_only: false },
        }),
      );
    }
    return topic.id;
  }

  /** 事件行工厂（只需要 id / eventType / resourceType / resourceId / topicId / actorId / payload） */
  function makeEvent(
    overrides: Record<string, unknown>,
  ): Parameters<NotifyOrchestrator['resolveRecipients']>[0] {
    return {
      id: 'evt-1',
      eventType: EventType.TASK_UPDATE,
      resourceType: ResourceType.TASK,
      resourceId: 'task-1',
      topicId: null,
      boardId: null,
      actorId: null,
      payload: {},
      ...overrides,
    } as never;
  }

  /** 收件人 id 集合（断言可读） */
  const idsOf = (recipients: NotifyRecipient[]): string[] =>
    recipients.map((recipient) => recipient.userId).sort();

  /** 清进程内快照缓存（跨用例污染的唯一来源） */
  function resetSnapshots(): void {
    (orchestrator as unknown as { snapshots: { clear(): void } }).snapshots.clear();
  }

  // ─── 生命周期 ────────────────────────────────────────────────────

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      logging: false,
    });
    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[notify-routing e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    // 播种用户必须**先存在**：编排器在 app.init() 的 onModuleInit 里解析 NOTIFY_OWNER_USERNAMES
    seededUserId = await createHuman(UserRole.EDITOR, 'seeded', SEEDED_USERNAME);
    // seeded 用户名下的 agent（owner-proxy 用例的 creator 源）
    const agentActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `${RUN} seeded-agent`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(agentActor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: agentActor.id,
        actor: agentActor,
        ownerId: seededUserId,
        name: `${RUN} seeded-agent`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    seededAgentId = agent.id;

    memberUserId = await createHuman(UserRole.EDITOR, 'member');
    softDeletedUserId = await createHuman(UserRole.EDITOR, 'soft');
    await bindChannel(memberUserId, 'member');
    await bindChannel(softDeletedUserId, 'soft');

    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({
      imports: [NotifyRoutingE2eModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    orchestrator = app.get(NotifyOrchestrator);
  }, 120_000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();
    const sweep = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        console.warn(`[notify-routing e2e] cleanup ${label} skipped: ${(err as Error).message}`);
      }
    };
    for (const id of created.docIds)
      await sweep('docs', () => ds.query(`DELETE FROM docs WHERE id = $1`, [id]));
    for (const id of created.spaceIds)
      await sweep('doc_spaces', () => ds.query(`DELETE FROM doc_spaces WHERE id = $1`, [id]));
    for (const id of created.topicIds)
      await sweep('topics', () => ds.query(`DELETE FROM topics WHERE id = $1`, [id]));
    for (const id of created.boardIds) {
      await sweep('board_lists', () =>
        ds.query(`DELETE FROM board_lists WHERE board_id = $1`, [id]),
      );
      await sweep('boards', () => ds.query(`DELETE FROM boards WHERE id = $1`, [id]));
    }
    // ⚠️ 顺序钉死：`agents.owner_id` 有 FK → `users`，故 agent 行必须先删，否则删 user 会被拒绝
    for (const id of created.agentIds)
      await sweep('agent', () => ds.query(`DELETE FROM agents WHERE id = $1`, [id]));
    // user_notification_channels 有 FK ON DELETE CASCADE ⇒ 删 user 行即连带清理绑定行
    for (const id of created.userIds)
      await sweep('user', () => ds.query(`DELETE FROM users WHERE id = $1`, [id]));
    for (const id of created.actorIds)
      await sweep('actor', () => ds.query(`DELETE FROM actors WHERE id = $1`, [id]));
    await ds.destroy();
  }, 90_000);

  beforeEach(() => {
    if (!dbAvailable) return;
    resetSnapshots();
  });

  // ══════════════════════════════════════════════════════════════════
  // 回归门：D4 播种行真的被解析成候选（升级日不断流的底座）
  // ══════════════════════════════════════════════════════════════════

  it('env_seed 回归门：播种出来的绑定让该用户成为候选（source=env_seed 且 last_test_status=seeded）', async () => {
    if (!dbAvailable) return;

    const rows = (await ds.query(
      `SELECT source, last_test_status AS status, enabled, unbound_at AS unbound
         FROM user_notification_channels WHERE user_id = $1`,
      [seededUserId],
    )) as { source: string; status: string; enabled: boolean; unbound: Date | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'env_seed',
      status: 'seeded',
      enabled: true,
      unbound: null,
    });

    // 路由层：该用户是 active 参与者的话题 ⇒ 出现在候选里（topic 判据不需要任何看板/空间）
    const topicId = await createTopic('seed-candidate', [seededUserId]);
    const recipients = await orchestrator.resolveRecipients(
      makeEvent({
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: 'msg-1',
        topicId,
        actorId: null,
      }),
      NOTIFY_CATEGORY.TOPIC,
    );
    expect(idsOf(recipients)).toEqual([seededUserId]);
  });

  it('软删用户零候选：actor 软删后其 deliveryEligible 绑定不再算候选（关系路径过滤真生效）', async () => {
    if (!dbAvailable) return;

    const topicId = await createTopic('soft-delete', [softDeletedUserId]);

    // 对照：软删前是候选
    const before = await orchestrator.resolveRecipients(
      makeEvent({
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: 'msg-1',
        topicId,
        actorId: null,
      }),
      NOTIFY_CATEGORY.TOPIC,
    );
    expect(idsOf(before)).toContain(softDeletedUserId);

    // 软删（事实在 actors 行上；users 没有 deleted_at 列）
    await ds.query(`UPDATE actors SET deleted_at = NOW() WHERE id = $1`, [softDeletedUserId]);
    resetSnapshots();
    queryCounter.statements.length = 0;
    const after = await orchestrator.resolveRecipients(
      makeEvent({
        eventType: EventType.NEW_MESSAGE,
        resourceType: ResourceType.MESSAGE,
        resourceId: 'msg-2',
        topicId,
        actorId: null,
      }),
      NOTIFY_CATEGORY.TOPIC,
    );
    expect(idsOf(after)).not.toContain(softDeletedUserId);
  });

  // ══════════════════════════════════════════════════════════════════
  // 安全层：PRIVATE 资源只发给可读的人
  // ══════════════════════════════════════════════════════════════════

  it('PRIVATE 看板：非成员/非 creator 零推送；owner-proxy（本人的 agent 建的）应收', async () => {
    if (!dbAvailable) return;

    // ① 别人的 PRIVATE 看板：seeded 用户什么都读不到
    const foreign = await createBoard('private-foreign', {
      creatorId: memberUserId,
      visibility: 'private',
    });
    const denied = await orchestrator.resolveRecipients(
      makeEvent({ eventType: EventType.TASK_UPDATE, resourceId: foreign.taskId }),
      NOTIFY_CATEGORY.TASK_UPDATED,
    );
    expect(idsOf(denied)).not.toContain(seededUserId);

    // ② 本人的 agent 建的 PRIVATE 看板：owner-proxy ⇒ 收（creator 源 + 注意力层同时命中）
    const owned = await createBoard('private-owned', {
      creatorId: seededAgentId,
      visibility: 'private',
    });
    const allowed = await orchestrator.resolveRecipients(
      makeEvent({ eventType: EventType.TASK_UPDATE, resourceId: owned.taskId }),
      NOTIFY_CATEGORY.TASK_UPDATED,
    );
    expect(idsOf(allowed)).toEqual([seededUserId]);
  });

  it('open 看板：安全层全员放行，但注意力层只说"与我有关"（成员/creator 才收）', async () => {
    if (!dbAvailable) return;

    const open = await createBoard('open-noise', {
      creatorId: memberUserId,
      visibility: 'open',
      memberIds: [seededUserId],
    });
    const recipients = await orchestrator.resolveRecipients(
      makeEvent({ eventType: EventType.TASK_UPDATE, resourceId: open.taskId }),
      NOTIFY_CATEGORY.TASK_UPDATED,
    );
    // seeded 是成员 ⇒ 收；member 是 creator ⇒ 收。第三方候选（有绑定、open 可读、但既非成员
    // 也非 creator）**不收**——这正是"注意力层防噪音"的可见形态（见上一用例的对照）
    expect(idsOf(recipients)).toEqual([memberUserId, seededUserId].sort());

    // 对照：把 soft 用户加成成员 ⇒ 他立刻进入收件人集合（注意力层的正侧）
    // ⚠️ 用**软删之前**的实例？不：本用例与软删用例共用同一用户会互相干扰，故新造一个候选
    const extra = await createHuman(UserRole.EDITOR, 'open-member');
    await bindChannel(extra, 'open-member');
    await ds.query(
      `INSERT INTO board_members (board_id, actor_id, role) VALUES ($1, $2, 'member')`,
      [open.boardId, extra],
    );
    resetSnapshots();
    const withMember = await orchestrator.resolveRecipients(
      makeEvent({ eventType: EventType.TASK_ASSIGNED, resourceId: open.taskId }),
      NOTIFY_CATEGORY.TASK_ASSIGNED,
    );
    expect(idsOf(withMember)).toContain(extra);
  });

  it('三方拦截根因：assignee ≠ board 读 / topic 参与者 ≠ space 读', async () => {
    if (!dbAvailable) return;

    // assignee ≠ board 读：被指派给 seeded 任务的那张 PRIVATE 看板他读不到 ⇒ 不投
    const privateBoard = await createBoard('assignee-denied', {
      creatorId: memberUserId,
      visibility: 'private',
    });
    await ds.query(`UPDATE tasks SET assignee_id = $1 WHERE id = $2`, [
      seededUserId,
      privateBoard.taskId,
    ]);
    const byAssignee = await orchestrator.resolveRecipients(
      makeEvent({ eventType: EventType.TASK_ASSIGNED, resourceId: privateBoard.taskId }),
      NOTIFY_CATEGORY.TASK_ASSIGNED,
    );
    expect(idsOf(byAssignee)).not.toContain(seededUserId);

    // topic 参与者 ≠ space 读：seeded 在话题里活跃，但某个 PRIVATE 空间与他无关 ⇒ 文档通知不投
    await createTopic('space-denied', [seededUserId]);
    const foreignSpace = await createSpaceWithDoc('private-space', {
      creatorId: memberUserId,
      visibility: 'private',
      createdBy: memberUserId,
    });
    const bySpace = await orchestrator.resolveRecipients(
      makeEvent({
        eventType: EventType.DOC_UPDATED,
        resourceType: ResourceType.DOC,
        resourceId: foreignSpace.docId,
      }),
      NOTIFY_CATEGORY.DOC_UPDATED,
    );
    expect(idsOf(bySpace)).not.toContain(seededUserId);
  });

  // ══════════════════════════════════════════════════════════════════
  // doc_deleted 的 withDeleted 变体（整空间删除后仍能判权限）
  // ══════════════════════════════════════════════════════════════════

  it('doc_deleted 整空间删除：space 行与 doc 行同批软删后，判据仍按删除前的可见性成立', async () => {
    if (!dbAvailable) return;

    const space = await createSpaceWithDoc('deleted-space', {
      creatorId: seededAgentId,
      visibility: 'open',
      createdBy: seededAgentId,
    });
    // 复刻 docspace.service.remove() 的真实时序：先软删 doc、再软删 space
    await ds.query(`UPDATE docs SET deleted_at = NOW() WHERE id = $1`, [space.docId]);
    await ds.query(`UPDATE doc_spaces SET deleted_at = NOW() WHERE id = $1`, [space.spaceId]);

    const recipients = await orchestrator.resolveRecipients(
      makeEvent({
        eventType: EventType.DOC_DELETED,
        resourceType: ResourceType.DOC,
        resourceId: space.docId,
        payload: { spaceId: space.spaceId },
      }),
      NOTIFY_CATEGORY.DOC_DELETED,
    );
    // 不带 withDeleted ⇒ 空间行取不到 ⇒ 判据不可用 ⇒ 零推送（这正是 A1 要守的死路）
    expect(idsOf(recipients)).toEqual([seededUserId]);
  });

  // ══════════════════════════════════════════════════════════════════
  // 性能承诺：路由查询数与候选人数无关
  // ══════════════════════════════════════════════════════════════════

  it('查询计数：稳态（快照已缓存）下，路由 SQL 条数与候选人数**无关**', async () => {
    if (!dbAvailable) return;

    const board = await createBoard('query-count', {
      creatorId: seededAgentId,
      visibility: 'open',
    });
    const event = () => makeEvent({ eventType: EventType.TASK_UPDATE, resourceId: board.taskId });
    const measure = async (): Promise<{ count: number; statements: string[] }> => {
      queryCounter.count = 0;
      queryCounter.statements.length = 0;
      await orchestrator.resolveRecipients(event(), NOTIFY_CATEGORY.TASK_UPDATED);
      return { count: queryCounter.count, statements: [...queryCounter.statements] };
    };
    /**
     * **快照重建语句的指纹**（flake 加固的核心判据）。稳态测量里**一条都不该出现**。
     *
     * 三个判别式都是**实测**出来的（2026-10-13，见下面每条的理由）——稳态的 7 条基线里
     * 也有语句碰这三张表，所以不能只按"表名"筛：
     *   ① **快照的渠道读取** = `channelRepo.find(...)` ⇒ 别名是**实体类名**
     *      `"user_notification_channels" "UserNotificationChannel"`；而候选集合查询走
     *      QueryBuilder（别名 `channel` + `INNER JOIN users`）⇒ 用别名区分。
     *   ② **快照的用户偏好读取** = `userRepo.findOne` ⇒ `FROM "users" "User" WHERE "User"."id" = …`；
     *      而剖面里的角色查询是**裸 SQL**（`SELECT id, role FROM users WHERE id = ANY($1)`，
     *      无别名）⇒ 用 `"users" "User"` 区分。
     *   ③ **快照的"我的 agent"读取** = `agentRepo.find({where:{ownerId}})` ⇒
     *      `"Agent"."owner_id" = $1`；而 owner-proxy 的**批量**查询是 `owner_id IN (…)`
     *      ⇒ 用"单值等号 vs IN"区分。
     *
     * 为什么必须换掉"条数相等"式的断言：本用例曾经按 `withMany === withFew` 判——只要并行跑的
     * 另一个 suite 让某次快照重建落进测量窗口（或暖机没焐热），条数就会飘（**实测出现过 7 vs 11
     * 的假红，差额 4 正好是一次快照重建**）。而"稳态下不该有任何重建"是**不变量**：它一旦被违反，
     * 说明承诺真的破了，且失败信息直接指出是哪几条 SQL（可诊断），不是一句"7 ≠ 11"。
     */
    const rebuildStatements = (statements: string[]): string[] =>
      statements.filter(
        (sql) =>
          sql.includes('"user_notification_channels" "UserNotificationChannel"') ||
          sql.includes('"users" "User"') ||
          /"Agent"\."owner_id"\s*=\s*\$/.test(sql),
      );

    /**
     * **候选集合规模的校验**（"共享 dev 库上还有别人的行"必须被**如实计入**，不能变成条数漂移）。
     *
     * 用**冷/稳态之差**反推，而不是自己再写一遍 `deliveryEligible` 谓词（第二份谓词 = 漂移源）：
     * 冷路径 = 稳态基线 + **每候选 4 条**快照重建（渠道 1 / 用户偏好 2（`User.actor` 的 eager
     * 关系多发一条）/ agent 1，见 orchestrator 的 `buildUserSnapshot` 注释）⇒
     * `冷 − 稳 == 4 × 候选数`。
     *
     * ⚠️ **不硬编码绝对条数**：本套件跑在**共享开发库**上，库里可能有别的套件/历史运行留下的
     * 合格绑定行（实测本机存在）。故先量出基线档的**候选数**，再断言"多造 8 个候选 ⇒ 冷路径
     * 恰好多 4×8 条"——这既钉住了"每候选 4 条"的账，又让"两次测量之间有人插行"这类外部干扰
     * 变成**显式失败**。
     */
    const coldToSteadyPerCandidate = 4;

    // 冷测一次（把快照建起来）、再测一次拿稳态基线
    resetSnapshots();
    const coldFew = await measure();
    const withFew = await measure();

    // ① **不变量**：稳态下**不含任何快照重建语句**（与并行噪声无关；违反即承诺真的破了，
    //    且失败信息直接指出是哪几条 SQL）。
    expect(rebuildStatements(withFew.statements)).toEqual([]);
    // ② 候选规模：冷/稳之差必须是 4 的整数倍（即"每候选 4 条"这条账在真库上成立），且本套件
    //    自己造的两个候选（seeded + member）确实在里面。
    const candidatesFew = (coldFew.count - withFew.count) / coldToSteadyPerCandidate;
    expect(Number.isInteger(candidatesFew)).toBe(true);
    expect(candidatesFew).toBeGreaterThanOrEqual(2);

    // 再加 8 个"有绑定但与本资源无关"的候选：稳态条数**不得变化**，冷路径恰好多 4×8
    for (let index = 0; index < 8; index += 1) {
      const extra = await createHuman(UserRole.EDITOR, `bulk-${index}`);
      await bindChannel(extra, `bulk-${index}`);
    }
    resetSnapshots();
    const coldMany = await measure();
    const withMany = await measure();

    expect(rebuildStatements(withMany.statements)).toEqual([]);
    expect(coldMany.count - withMany.count).toBe((candidatesFew + 8) * coldToSteadyPerCandidate);
    expect(withMany.count).toBe(withFew.count);
    // 上界声明（**实测值写进注释，避免"上界拍脑袋"**）：本机稳态 **7 条 SQL**（实测 statements
    // 逐条核对）：候选 1 + task 的 `distinctAlias` 1 + task 主查 1 + 看板行 1 + 剖面 role 1
    // + 剖面 members 1 + owner-proxy 批量 1。**与候选人数无关**（上面两条已经钉住），本上界只防
    // "悄悄涨回 O(N)"。
    expect(withMany.count).toBeLessThanOrEqual(8);
  });
});
