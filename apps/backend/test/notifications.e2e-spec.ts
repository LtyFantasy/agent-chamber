/**
 * Notifications 一期 S4 —— 两个端点的**端点级** e2e（真 PG + 真守卫 + 真 HTTP，内存 fake 出口）。
 *
 * 为什么是"真守卫 + 真 HTTP"而不是 `createTestingApp`（mock 链）：本批次的全部风险都长在
 * HTTP 层——`@HttpCode(200)` 是否真的覆盖 POST 的缺省 201、`Retry-After` 头是否能穿过全局
 * 异常过滤器落到响应上（过滤器**从不 setHeader**，头只能由 controller 显式设置）、
 * `JwtOrApiKeyGuard` 的双分支与 `RolesGuard` 的角色闸是否真的挡住——这些在 mock 链里
 * （test-setup.ts 把守卫全换成 dummy）**一律测不出**。
 *
 * 出口用内存 fake（**不联网**）：`NOTIFY_PROVIDER_LIST` 整体替换，记录出境面并返回可控终态。
 * 真实飞书叶子的 HTTP 行为由 `feishu.notify-provider.spec.ts` 用 mock fetch 覆盖。
 *
 * 环境：本地开发库 chamber-postgres（8744），PG 不可达时整套降级跳过；本运行写入的行一律带
 * RUN 后缀文本，afterAll 按文本硬删（投递表无 FK，可独立清理）。
 *
 * ⚠️ **一个 agent 一个入口窗口**：测试配置把 `NOTIFY_DIRECT_RATE_LIMIT_PER_WINDOW` 收到 1
 * （好让 429 在运行内可达），而窗口是 **per-actor** 的——故每个需要"能成功投递"的用例都领一个
 * 自己的 agent（5 个），而不是共用一个（否则第 2 个用例就会撞 429，测试变成顺序耦合）。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import request = require('supertest');
import { API_PREFIX, ActorType, AgentStatus, ErrorCode, UserRole } from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { User } from '../src/database/entities/user.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { NotificationsModule } from '../src/modules/notifications/notifications.module';
import { NotifyOrchestrator } from '../src/modules/notifications/notify-orchestrator.service';
import { NotifyDirectService } from '../src/modules/notifications/notify-direct.service';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORIES,
  type NotificationsConfig,
} from '../src/config/notifications.config';
import {
  NOTIFY_PROVIDER_LIST,
  type DeliveryOutcome,
  type NotifyProvider,
  type NotifySendOptions,
  type RenderedNotification,
} from '../src/modules/notifications/notify-provider.interface';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其他套件） */
const JWT_SECRET = 'notifications-e2e-secret';

/** 本次运行的唯一后缀（隔离数据：username / 正文 / 断言互不串味） */
const RUN = `ntf-${Date.now().toString(36)}`;

/** owner 的平台 username（写进配置 ⇒ 编排器启动时解析成 actorId，自回声判定才生效） */
const OWNER_USERNAME = `ntfowner${RUN}`.slice(0, 50);

/** 收件人 open_id（fake 出口只用它当窗口维度，不发任何真实请求） */
const RECIPIENT = `ou_${RUN}`;

/**
 * 测试用 notifications 配置（经 ConfigModule.load 注入，`config.get('notifications')` 可取）。
 *
 * ⚠️ `directRateLimitPerWindow: 1`：把入口闸收到 1 条，让"第 2 次 429"在一次运行内可达；
 * 窗口按 actor 分开记账 ⇒ 需要 200 的用例各自领一个 agent（见文件头说明）。
 */
const NOTIFY_TEST_CONFIG: NotificationsConfig = {
  ...NOTIFICATIONS_CONFIG_FALLBACK,
  enabled: true,
  categories: [...NOTIFY_CATEGORIES],
  providers: ['feishu'],
  feishuRecipientOpenId: RECIPIENT,
  webBaseUrl: 'https://platform.example.com',
  ownerUsernames: [OWNER_USERNAME],
  // ⚠️ **二期批 2 起这两把"假凭据"是必需的**（与 pipeline e2e 同款）：收件人不再取自
  // `FEISHU_RECIPIENT_OPEN_ID`，而是取"有 deliveryEligible 绑定的用户"——绑定由 D4 播种
  // (`seedFromEnv`) 落库，而播种的前提是 feishu 三键齐。**给假值即可**（本套件的出口是内存
  // fake，不发任何真实请求；密钥只参与"能不能播种"这一个判据）；不给 ⇒ 播种静默跳过 ⇒
  // 直发全部降级成 `recipient_not_bound`（症状是所有正向用例齐刷刷"没投递"）。
  feishuAppId: 'cli_notifications_e2e',
  feishuAppSecret: 'notifications-e2e-secret',
  directRateLimitPerWindow: 1,
  directRateWindowSeconds: 600,
  // ⚠️ L2 是**按收件人**记账的，而本套件所有直发都发往同一个 `RECIPIENT`：额度 5 会被用例数
  // 恰好用满（零余量 ⇒ 以后随便加一条直发用例就变成 429 假失败）。放大到 20 留余量。
  globalRateLimit: 20,
  globalRateWindowSeconds: 600,
};

/** 成功终态（`deliveredAt` 由 fake 在每次发送时补齐） */
const SUCCESS_OUTCOME: DeliveryOutcome = {
  status: 'success',
  attempts: 1,
  responseStatus: 200,
  lastError: null,
  deliveredAt: null,
};

/** 失败终态（网络层失败：没有响应码） */
const FAILED_OUTCOME: DeliveryOutcome = {
  status: 'failed',
  attempts: 2,
  responseStatus: null,
  lastError: 'network: connection refused',
  deliveredAt: null,
};

/**
 * 内存 fake 出口（**不联网**）：记录每次投递的出境面与重试预算，返回可控终态。
 */
const fakeProvider = {
  key: 'feishu',
  sent: [] as RenderedNotification[],
  outcome: SUCCESS_OUTCOME as DeliveryOutcome,
  /** 收到的重试预算（断言直发的 ≤2 次 / ≤10s 真的传到了叶子） */
  budgets: [] as Array<NotifySendOptions | undefined>,
  async send(
    notification: RenderedNotification,
    opts?: NotifySendOptions,
  ): Promise<DeliveryOutcome> {
    fakeProvider.sent.push(notification);
    fakeProvider.budgets.push(opts);
    const outcome = fakeProvider.outcome;
    return { ...outcome, deliveredAt: outcome.status === 'success' ? new Date() : null };
  },
  reset(): void {
    fakeProvider.sent = [];
    fakeProvider.budgets = [];
    fakeProvider.outcome = SUCCESS_OUTCOME;
  },
};

/**
 * 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态：方法级 guard 在**声明它的模块**
 * 上下文实例化，其 @InjectRepository 依赖要从那里解析）。
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
class NotificationsE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + 被验证的 NotificationsModule（+ 真响应信封） */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => ({
          jwt: { secret: JWT_SECRET, expiresIn: '2h' },
          notifications: NOTIFY_TEST_CONFIG,
        }),
      ],
    }),
    // 编排器的 @OnEvent 订阅需要 EventEmitter2（生产由 AppModule 提供）——缺它订阅静默丢失
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    NotificationsE2eAuthModule,
    // AgentService 等依赖的 ActorProfileService / OwnerProxyService 由 @Global() 两模块提供
    CommonModule,
    PermissionModule,
    NotificationsModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
})
class NotificationsE2eModule {}

/** 本套件领用的 agent（每个自带一个独立的直发入口窗口；见文件头说明） */
type AgentKey = 'main' | 'idem' | 'throttle' | 'failed' | 'list' | 'gate' | 'unbound';

describe('Notifications 两端点 — 真实 PG + 真实守卫 + 真实 HTTP', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwtService: JwtService;
  let orchestrator: NotifyOrchestrator;
  let dbAvailable = false;

  let adminToken: string;
  let editorToken: string;
  let ownerToken: string;
  /** 另一个人类（名下 agent 的直发收件人）：**刻意没有任何渠道绑定** */
  let unboundOwnerId: string;
  /** owner 的 actorId（自回声用例的对照锚点） */
  let ownerActorId: string;
  /** 各 agent 的明文 API Key */
  const agentKeys = new Map<AgentKey, string>();

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      synchronize: false,
      logging: false,
      namingStrategy: new SnakeNamingStrategy(),
    });
    try {
      await ds.initialize();
    } catch (err) {
      console.warn(`[notifications e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }

    // 表必须在（S2 迁移链产物）——缺表即环境未跑迁移，显式失败而非静默跳过
    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = 'notification_deliveries'`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name)).toEqual(['notification_deliveries']);

    // owner 必须先存在：编排器在 app.init()（onModuleInit）里解析 NOTIFY_OWNER_USERNAMES
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntf Owner ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: OWNER_USERNAME,
        email: `ntf-owner-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(owner.id);
    ownerActorId = owner.id;

    // 各用例各领一个 agent（窗口 per-actor；owner 可共用——ownerId 只是一个 FK）
    for (const key of ['main', 'idem', 'throttle', 'failed', 'list', 'gate'] as AgentKey[]) {
      agentKeys.set(key, await createAgent(key, owner.id));
    }

    // 二期批 2：**另一个人类**（名下 agent 的直发收件人），**刻意不给它任何渠道绑定** ——
    // 用来端到端验证 `recipient_not_bound`（"你的 creator 没绑渠道"）与它的**不进幂等缓存**语义。
    const unboundActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntf Unbound ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(unboundActor.id);
    const unboundOwner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: unboundActor.id,
        actor: unboundActor,
        username: `ntfunbound${RUN}`.slice(0, 50),
        email: `ntf-unbound-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(unboundOwner.id);
    unboundOwnerId = unboundOwner.id;
    agentKeys.set('unbound', await createAgent('unbound', unboundOwner.id));

    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({ imports: [NotificationsE2eModule] })
      // 出口整体换成内存 fake（**不联网**）——事件链路与直发链路共用这个 token
      .overrideProvider(NOTIFY_PROVIDER_LIST)
      .useValue([fakeProvider as unknown as NotifyProvider])
      .compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 逐字对齐：校验管道 + 全局前缀（响应信封由 APP_INTERCEPTOR 提供）
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    jwtService = app.get(JwtService);
    orchestrator = app.get(NotifyOrchestrator);
    adminToken = await resolveAdminToken();
    // 403 用例需要一个**与 owner 不同**的非 admin 人类（同一个人的 token 会让"被拒"看起来像
    // "同一身份在两条路径上行为不一致"，而不是"角色闸挡住了另一个人"）
    const editorActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntf Editor ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(editorActor.id);
    const editor = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: editorActor.id,
        actor: editorActor,
        username: `ntfeditor${RUN}`.slice(0, 50),
        email: `ntf-editor-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(editor.id);
    editorToken = jwtService.sign({ sub: editor.id, role: UserRole.EDITOR });
    ownerToken = jwtService.sign({ sub: owner.id, role: UserRole.EDITOR });
  }, 120000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();
    // 投递表无 FK：按本运行的正文特征删（直发行的 body 就是调用方传的 RUN 文本）
    await ds.query(`DELETE FROM notification_deliveries WHERE body LIKE $1`, [`%${RUN}%`]);
    // FK 依赖逆序硬删：api_keys → agents → **users → actors**（users.id 与 agents.id 都外键到
    // actors.id ⇒ actors 必须最后删）。逐条 try/catch：一条 FK 报错不得吞掉后续清理
    const sweep = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        console.warn(`[notifications e2e] cleanup ${label} skipped: ${(err as Error).message}`);
      }
    };
    for (const id of created.keyIds)
      await sweep('api_key', () => ds.getRepository(ApiKey).delete({ id }));
    for (const id of created.agentIds)
      await sweep('agent', () => ds.getRepository(Agent).delete({ id }));
    for (const id of created.userIds)
      await sweep('user', () => ds.getRepository(User).delete({ id }));
    for (const id of created.actorIds)
      await sweep('actor', () => ds.getRepository(Actor).delete({ id }));
    await ds.destroy();
  }, 60000);

  // ─── 数据构造 ───────────────────────────────────────────────────

  /**
   * 建一个 agent（actor + agents + api_key），返回明文 API Key。
   *
   * `keyHash` 必须是**真 sha256**（生产 ApiKeyAuthService 直接比哈希），否则认证分支永远失败。
   */
  async function createAgent(key: AgentKey, ownerId: string): Promise<string> {
    const displayName = `Ntf Agent ${key} ${RUN}`;
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId,
        name: displayName,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    const rawKey = `ask_${RUN}_${key}`;
    const saved = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: ownerId,
      }),
    );
    created.keyIds.push(saved.id);
    return rawKey;
  }

  /** 取一个可用的 admin 并签 token（优先复用库里已有 admin——唯一部分索引不允许重复插入） */
  async function resolveAdminToken(): Promise<string> {
    // ⚠️ `users` 表**没有** `deleted_at` 列（User 实体无 `@DeleteDateColumn`，软删事实在
    // `actors` 行上——见 notify-orchestrator.service.ts 的 resolveOwners 注释）。故只过滤 actor。
    const rows = (await ds.query(
      `SELECT u.id FROM users u
         JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' AND a.deleted_at IS NULL
        LIMIT 1`,
    )) as { id: string }[];
    if (rows.length > 0) return jwtService.sign({ sub: rows[0].id, role: UserRole.ADMIN });
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntf Admin ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const admin = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        actor,
        username: `ntfadmin${RUN}`.slice(0, 50),
        email: `ntf-admin-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.ADMIN,
        preferences: {},
      }),
    );
    created.userIds.push(admin.id);
    return jwtService.sign({ sub: admin.id, role: UserRole.ADMIN });
  }

  /** 取某 agent 的显示名（出境面前缀断言；避免在断言里硬编码序号） */
  function agentName(key: AgentKey): string {
    return `Ntf Agent ${key} ${RUN}`;
  }

  /**
   * 临时改写**直发服务**的生效配置（手法与 pipeline e2e 的 `withSettings` 同一套）。
   *
   * 为什么需要：本套件缺省 `directRateLimitPerWindow=1`（为了让"同一个 agent 第 2 次 ⇒ 429"
   * 在一次运行内可达），而「同 key 重试在绑定补上后能成功」这类用例必须让同一个 agent 连发两次。
   * 改的是**生产同一行代码读的那个配置快照对象**（`settings.directRateLimitPerWindow`）——
   * 等价于"用另一份配置启动"，不是绕过判定。
   */
  async function withDirectSettings<T>(
    patch: Partial<NotificationsConfig>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const target = (
      app.get(NotifyDirectService) as unknown as { settings: Record<string, unknown> }
    ).settings;
    const saved: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) saved[key] = target[key];
    Object.assign(target, patch);
    try {
      return await fn();
    } finally {
      Object.assign(target, saved);
    }
  }

  /** 直发端点请求：`auth` 可以是 agent key 名、人类 JWT，或 null（无凭证） */
  function post(body: Record<string, unknown>, auth: AgentKey | string | null) {
    const req = request(app.getHttpServer()).post(`${API_PREFIX}/notifications/messages`);
    if (auth !== null) {
      const key = agentKeys.get(auth as AgentKey);
      if (key) req.set('X-API-Key', key);
      else req.set('Authorization', `Bearer ${auth}`);
    }
    return req.send(body);
  }

  /** 读本运行写下的投递行（直发行的 body = 我们传的 RUN 文本） */
  async function deliveryRows(body: string): Promise<
    Array<{
      category: string;
      status: string;
      attempts: number;
      event_id: string | null;
      channel: string;
      recipient: string;
    }>
  > {
    return ds.query(
      `SELECT category, status, attempts, event_id, channel, recipient
         FROM notification_deliveries WHERE body = $1 ORDER BY created_at DESC`,
      [body],
    );
  }

  beforeEach(() => {
    fakeProvider.reset();
  });

  // ─── POST /notifications/messages（直发） ─────────────────────────

  it('401：无任何凭证（真 JwtOrApiKeyGuard 拦下）', async () => {
    if (!dbAvailable) return;
    await post({ text: `no-auth ${RUN}` }, null).expect(401);
    expect(fakeProvider.sent).toHaveLength(0);
  });

  it('200（**不是 201**）：直发成功 + delivered=1 + 落库一行 direct/event_id NULL', async () => {
    if (!dbAvailable) return;
    const text = `e2e direct ok ${RUN}`;

    const res = await post(
      { text, link: '/tasks/8f14e45f-ceea-467a-9e2f-1b2c3d4e5f60' },
      'main',
    ).expect(200);

    expect(res.body.data).toEqual({ delivered: 1, channels: ['feishu'] });
    // 出境面：前缀 = agent 显示名；正文 = agent 自填；链接由服务端用 NOTIFY_WEB_BASE_URL 拼
    expect(fakeProvider.sent).toHaveLength(1);
    expect(fakeProvider.sent[0].title).toBe(`[${agentName('main')}]`);
    expect(fakeProvider.sent[0].body).toBe(text);
    expect(fakeProvider.sent[0].link).toBe(
      'https://platform.example.com/tasks/8f14e45f-ceea-467a-9e2f-1b2c3d4e5f60',
    );
    // 预算：直发 ≤2 次尝试 / ≤10s（agent 客户端超时保护）
    expect(fakeProvider.budgets[0]).toEqual({ maxAttempts: 2, budgetMs: 10_000 });

    const rows = await deliveryRows(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'direct',
      status: 'success',
      channel: 'feishu',
      recipient: RECIPIENT,
      // 直发没有事件源：NULL 让"事件触发的通知"在数据面可分辨
      event_id: null,
    });
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
  });

  it('400：link 是绝对 URL（DTO 层拦下，出口一次都没被调用）', async () => {
    if (!dbAvailable) return;
    await post({ text: `bad link ${RUN}`, link: 'https://evil.example/tasks/1' }, 'main').expect(
      400,
    );
    expect(fakeProvider.sent).toHaveLength(0);
  });

  it('429 三件套：Retry-After 头 + code 429 + data.retryAfterSeconds（专用 agent）', async () => {
    if (!dbAvailable) return;
    await post({ text: `throttle first ${RUN}` }, 'throttle').expect(200);

    const res = await post({ text: `throttle second ${RUN}` }, 'throttle').expect(429);

    // ① 头：全局过滤器从不 setHeader ⇒ 这条断言证明 controller 真的显式设置了
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // ② code 与 ③ data.retryAfterSeconds（同一个数，两处同源）
    expect(res.body.code).toBe(ErrorCode.RATE_LIMITED);
    expect(res.body.data.retryAfterSeconds).toBe(Number(res.headers['retry-after']));
    expect(res.body.message).toContain('Do NOT retry immediately');
    // 被挡下的那条**没有投递、没有落库**
    expect(fakeProvider.sent).toHaveLength(1);
    expect(await deliveryRows(`throttle second ${RUN}`)).toHaveLength(0);
  });

  it('幂等：同 key 同载荷重放返回首信封；同 key 异载荷 ⇒ 409/9002', async () => {
    if (!dbAvailable) return;
    const text = `idem ${RUN}`;
    const key = `e2e-${RUN}-k1`;

    const first = await post({ text, clientRequestId: key }, 'idem').expect(200);
    expect(first.body.data).toEqual({ delivered: 1, channels: ['feishu'] });

    // 重放：同信封、不重复投递（出口只被调用一次）
    const replay = await post({ text, clientRequestId: key }, 'idem').expect(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(fakeProvider.sent).toHaveLength(1);

    // 同 key 异载荷：409（拒绝重放一个描述着"另一条消息"的信封）
    const conflict = await post({ text: `${text} changed`, clientRequestId: key }, 'idem').expect(
      409,
    );
    expect(conflict.body.code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
    expect(fakeProvider.sent).toHaveLength(1);
  });

  it('自回声：**人类**调用者（给自己发）⇒ 200 + delivered=0 + reason=self_echo', async () => {
    if (!dbAvailable) return;
    const text = `self echo ${RUN}`;

    const res = await post({ text }, ownerToken).expect(200);

    expect(res.body.data).toEqual({ delivered: 0, channels: [], reason: 'self_echo' });
    expect(fakeProvider.sent).toHaveLength(0);
    expect(await deliveryRows(text)).toHaveLength(0);

    // 对照（**必须有**，否则"自回声"恒为真也会让上面两条绿）：**同一条消息换成 owner 名下的
    // agent 调用 ⇒ 真的投出去**。它一次守住两件事：
    //   ① 这个部署的直发链路是通的（不是"配置坏了所以没投"）；
    //   ② **agent 不会被自回声吞掉**——收件人就是它的 owner（"调用者 ∈ 收件人的 agents"恒成立），
    //      事件链路那条"我的 agent"泛化在这里是错的（plan §D3 写死的例外）。
    await withDirectSettings({ directRateLimitPerWindow: 10 }, async () => {
      const viaAgent = await post({ text }, 'gate').expect(200);
      expect(viaAgent.body.data).toEqual({ delivered: 1, channels: ['feishu'] });
    });
    expect(fakeProvider.sent).toHaveLength(1);
    // 而且**是发给了 owner 本人**（收件人 = 调用 agent 的 ownerId ⇒ 他的绑定地址）
    expect(fakeProvider.sent[0].recipient).toBe(RECIPIENT);
  });

  it('升级门（回归）：D4 播种出来的 `env_seed` 绑定 ⇒ 直发**立即投递** delivered=1', async () => {
    if (!dbAvailable) return;
    // 播种行必须真的在库里、且满足 deliveryEligible（这就是升级日的生产路径：存量用户
    // 从"部署级单 Owner"迁到多用户模型时，靠这一行不至于静默断流）
    const rows = (await ds.query(
      `SELECT source, enabled, last_test_status, recipient_address
         FROM user_notification_channels WHERE user_id = $1 AND provider = 'feishu'`,
      [ownerActorId],
    )) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'env_seed',
      enabled: true,
      last_test_status: 'seeded',
      recipient_address: RECIPIENT,
    });

    const text = `seeded upgrade gate ${RUN}`;
    await withDirectSettings({ directRateLimitPerWindow: 10 }, async () => {
      const res = await post({ text }, 'gate').expect(200);
      expect(res.body.data).toEqual({ delivered: 1, channels: ['feishu'] });
    });
    const written = await deliveryRows(text);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      category: 'direct',
      status: 'success',
      recipient: RECIPIENT,
    });
  });

  it('recipient_not_bound：creator 没绑渠道 ⇒ 200 降级；**不进幂等缓存**（绑好后同键重发能成功）', async () => {
    if (!dbAvailable) return;
    const text = `unbound creator ${RUN}`;
    const key = `e2e-${RUN}-unbound`;

    // ⚠️ 放宽入口闸：本用例要让**同一个 agent** 连发两次（缺省 1 条/窗口，见 withDirectSettings）
    await withDirectSettings({ directRateLimitPerWindow: 10 }, async () => {
      const first = await post({ text, clientRequestId: key }, 'unbound').expect(200);
      // 文案是可推导的下一步（"告诉你的 creator 去 Settings → Notifications 绑一个渠道"）
      expect(first.body.data).toEqual({
        delivered: 0,
        channels: [],
        reason: 'recipient_not_bound',
      });
      expect(fakeProvider.sent).toHaveLength(0);

      // creator 自己把渠道绑上了（用户的动作，10 分钟内完全可能发生）——走的是生产写路径的
      // 两件事：插入一条满足 deliveryEligible 的行 + `invalidateUser`（快照失效钩子）。
      const address = `ou_unbound_${RUN}`;
      await ds.query(
        `INSERT INTO user_notification_channels
           (user_id, provider, recipient_address, enabled, last_test_status, last_test_address, source)
         VALUES ($1, 'feishu', $2, TRUE, 'ok', $2, 'user')`,
        [unboundOwnerId, address],
      );
      orchestrator.invalidateUser(unboundOwnerId);

      const second = await post({ text, clientRequestId: key }, 'unbound').expect(200);

      // 若 `recipient_not_bound` 进了幂等缓存，这里会拿到 10 分钟前那句"没绑渠道"的旧结论
      // ——调用方被骗满 10 分钟，而人明明已经绑好了（plan §D5 点名"不进幂等缓存"）。
      expect(second.body.data).toEqual({ delivered: 1, channels: ['feishu'] });
      expect(fakeProvider.sent).toHaveLength(1);
      expect(fakeProvider.sent[0].recipient).toBe(address);
    });

    // 落库归属 = **creator**（不是 agent 自己）：admin 按人过滤时，这条行必须挂在被通知的人名下
    const written = await deliveryRows(text);
    expect(written).toHaveLength(1);
    const owner = (await ds.query(
      `SELECT recipient_user_id FROM notification_deliveries WHERE body = $1`,
      [text],
    )) as Array<{ recipient_user_id: string | null }>;
    expect(owner[0].recipient_user_id).toBe(unboundOwnerId);
  });

  it('admin `recipientUserId` 过滤：归属列端到端贯通（按人筛得出，别人的归属筛不出）', async () => {
    if (!dbAvailable) return;
    const listFor = async (recipientUserId: string) => {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/notifications/deliveries`)
        .query({ category: 'direct', recipientUserId, pageSize: 100 })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      return res.body.data as {
        items: Array<{ body: string; recipientUserId: string | null }>;
        total: number;
      };
    };

    // 直发行的归属 = 收件人（上面几条用例已经写过 owner 名下的行）
    const mine = await listFor(ownerActorId);
    expect(mine.items.length).toBeGreaterThan(0);
    for (const item of mine.items) expect(item.recipientUserId).toBe(ownerActorId);

    // 另一个人的归属筛不出 owner 的行（过滤真的下推到了 SQL，不是"拉全表再筛"）
    const theirs = await listFor('00000000-0000-4000-8000-000000000000');
    expect(theirs.total).toBe(0);
    expect(theirs.items).toHaveLength(0);
  });

  it('投递失败：出口返回 failed ⇒ delivered=0 + reason=delivery_failed，且落一行 failed 终态', async () => {
    if (!dbAvailable) return;
    fakeProvider.outcome = FAILED_OUTCOME;
    const text = `delivery failed ${RUN}`;

    const res = await post({ text }, 'failed').expect(200);

    expect(res.body.data).toEqual({ delivered: 0, channels: [], reason: 'delivery_failed' });
    const rows = await deliveryRows(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'direct', status: 'failed' });
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
  });

  // ─── GET /notifications/deliveries（admin 只读） ───────────────────

  it('401：无凭证（真 JwtAuthGuard）', async () => {
    if (!dbAvailable) return;
    await request(app.getHttpServer()).get(`${API_PREFIX}/notifications/deliveries`).expect(401);
  });

  it('403：非 admin 人类（@Roles(ADMIN) + 真 RolesGuard）', async () => {
    if (!dbAvailable) return;
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .set('Authorization', `Bearer ${editorToken}`)
      .expect(403);
    expect(res.body.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('admin：200 + 分页信封 + category 过滤命中本运行的直发行 + createdAt DESC 全序', async () => {
    if (!dbAvailable) return;
    const text = `list me ${RUN}`;
    await post({ text }, 'list').expect(200);

    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .query({ category: 'direct', page: 1, pageSize: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const page = res.body.data as {
      items: Array<{
        body: string;
        category: string;
        status: string;
        eventId: string | null;
        createdAt: string;
      }>;
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
    // 信封形状（与 webhook 列表同形）
    expect(Object.keys(page).sort()).toEqual([
      'hasNext',
      'hasPrev',
      'items',
      'page',
      'pageSize',
      'total',
      'totalPages',
    ]);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(100);
    expect(page.hasPrev).toBe(false);
    // 本运行的那一行在列表里，且**全类别 = direct**（过滤真的下推到了 SQL，不是拉全表再筛）
    const mine = page.items.filter((item) => item.body === text);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ category: 'direct', status: 'success', eventId: null });
    for (const item of page.items) expect(item.category).toBe('direct');
    // 全序：createdAt 非递增（同刻由 id DESC 兜底，避免翻页漏行/重复）
    for (let index = 1; index < page.items.length; index += 1) {
      expect(new Date(page.items[index - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(page.items[index].createdAt).getTime(),
      );
    }
  });

  it('admin：`status` 过滤（failed 只回失败行）', async () => {
    if (!dbAvailable) return;
    // 直接播种一行失败行（**不经过直发端点**）：本用例的主语是"读侧的 status 过滤"，
    // 让它依赖写路径只会把两个失败面搅在一起（且写路径的入口窗口在本套件里只有 1 条额度）
    const text = `seeded failed ${RUN}`;
    await ds.query(
      `INSERT INTO notification_deliveries
         (channel, recipient, category, event_id, title, body, status, attempts, last_error, response_status)
       VALUES ('feishu', $1, 'direct', NULL, $2, $3, 'failed', 2, 'network: connection refused', NULL)`,
      [RECIPIENT, `[seeded ${RUN}]`, text],
    );

    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .query({ status: 'failed', pageSize: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const items = (res.body.data as { items: Array<{ status: string; body: string }> }).items;
    expect(items.some((item) => item.body === text)).toBe(true);
    for (const item of items) expect(item.status).toBe('failed');
  });

  it('admin：`digest` 是合法的 category 过滤值（L2 摘要行可达——它不在 NOTIFY_CATEGORIES 里）', async () => {
    if (!dbAvailable) return;
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .query({ category: 'digest' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('admin：`system_alert` 是合法的 category 过滤值（运维类别，同样不在 NOTIFY_CATEGORIES 里）', async () => {
    if (!dbAvailable) return;
    // 与 `digest` 行**对称**：运维必须能查"告警到底投递出去过没有"（plan D6 的告警历史两面）。
    // 直接播种一行（不经过 sendSystemAlert）：本用例的主语是读侧的值域与过滤，写路径由
    // pipeline e2e 的 ⑰ 覆盖。
    const text = `seeded system alert ${RUN}`;
    await ds.query(
      `INSERT INTO notification_deliveries
         (channel, recipient, category, event_id, title, body, status, attempts, last_error, response_status)
       VALUES ('feishu', $1, 'system_alert', NULL, $2, $3, 'success', 1, NULL, 200)`,
      [RECIPIENT, `[seeded system_alert ${RUN}]`, text],
    );

    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .query({ category: 'system_alert', pageSize: 100 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const items = (res.body.data as { items: Array<{ category: string; body: string }> }).items;
    expect(items.some((item) => item.body === text)).toBe(true);
    for (const item of items) expect(item.category).toBe('system_alert');
  });

  it('admin：400 校验（pageSize > 100 / 未知 category）', async () => {
    if (!dbAvailable) return;
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .query({ pageSize: 101 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/notifications/deliveries`)
      .query({ category: 'not_a_category' })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('终态不变量：本运行写下的每一行 status ∈ {success, failed} 且 attempts ≥ 1', async () => {
    if (!dbAvailable) return;
    const rows = (await ds.query(
      `SELECT status, attempts FROM notification_deliveries WHERE body LIKE $1`,
      [`%${RUN}%`],
    )) as Array<{ status: string; attempts: number }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['success', 'failed']).toContain(row.status);
      expect(row.attempts).toBeGreaterThanOrEqual(1);
    }
  });
});
