/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **Memory Usage 两读面**（`GET /memory/projects/:id/usage/summary|trace`）的真实 PG +
 *     真实 HTTP 端到端契约：200 形状（engine 无 target / 外层 camelCase target /
 *     usageCaveat）、权限矩阵（admin / 全绑定可读 / 部分可读 / 零绑定）、共享与 claim
 *     归属（含 archived/软删行、拒绝时引擎 0 调用）、默认时间窗、游标双通道、null/0 三态、
 *     旧 Hub 404 / 429 / 503 的错误分桶、**所有出口 `Cache-Control: no-store`**、canReadUsage
 *
 * [代码职责]
 *   - 用真库证明 mock 证不了的事：`withDeleted` 共享扫描、claim 归属、REST 全链路的
 *     ValidationPipe / guard / throttler / middleware / exception filter 组合
 *
 * [权威文档]
 *   - 计划 `constantine-pantha-lockjaw.md` §2.1–2.3 / §3.4.4
 *   - 合同事实源（只读）: `~/.hument/chamber-dev/upgrade-alpha19/usage-*.schema.json`
 *
 * [关键不变量]（本套件是守门人）
 *   - **拒绝时 Hub 0 调用**：共享/claim/权限/可用性任一失败，ScriptedUsageEngine 的
 *     usage 计数不得增加。
 *   - **共享扫描覆盖 archived + 软删**：`memory_projects` 的 withDeleted 全量行都算"历史归属"。
 *   - **engine 块无 target**：`data.engine.target` 不存在；身份只在外层 target；响应不含
 *     credentialRef/binding_id/namespace_id。
 *   - **totals 与页大小无关**：limit=1 时 `total_rows`/`totals.counts.evidence_rows` 仍是全匹配集。
 *   - **游标双通道**：改 limit ⇒ 400 invalid_argument；数据变 ⇒ 409 conflict；平台都落
 *     502/14004 + hintCode=cursor_reset_required。
 *   - **所有出口 no-store**：200/400/401/403/404/409/429/502/503 全断言。
 *
 * [持久踩坑]
 *   MEMORY-USAGE-E2E-LEGACY-DB: 本套件使用独立临时库的 179250 前快照，保留历史共享负例；
 *     afterAll 关闭 Nest/数据库连接后释放整库，禁止在共享 dev 表删除当前唯一索引。
 *   MEMORY-USAGE-E2E-ENGINE-CLOCK: FakeEngine 的 usage 行时间 = 记忆的确定性 createdAt
 *     （2026-01-01 UTC 起），故数据断言必须用**显式窗口**；默认窗口（now-7d）只用于
 *     "窗口零记录 + filter 回声"的断言。
 * =============================================================================
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../src/database/data-source';
import request = require('supertest');
import {
  ActorType,
  AgentStatus,
  API_PREFIX,
  ErrorCode,
  MEMORY_UNAVAILABLE_REASON,
  ParticipantStatus,
  TopicParticipantRole,
  UserRole,
} from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { MemoryModule } from '../src/modules/memory/memory.module';
import { HintsModule } from '../src/modules/hints/hints.module';
import {
  MEMORY_ENGINE_RAW,
  type HumentMemoryGraphView,
  type HumentMemoryGraphViewQuery,
  type HumentMemoryRelations,
  type HumentMemoryViewDetail,
  type HumentMemoryViewHistory,
  type HumentMemoryViewHistoryQuery,
  type HumentMemoryViewRepresentation,
  type HumentMemoryViewRelationsQuery,
  type HumentUsageSummary,
  type HumentUsageSummaryQuery,
  type HumentUsageTrace,
  type HumentUsageTraceQuery,
  type InspectCorrectionInput,
  type InspectNominationInput,
  type MemoryCorrectionResult,
  type MemoryEngine,
  type MemoryEngineResult,
  type MemoryEngineTarget,
  type MemoryNominationResult,
  type MemoryReadResult,
  type MemoryRecallResult,
  type NominateMemoryInput,
  type RecallMemoryInput,
} from '../src/modules/memory/engines/memory-engine.interface';
import { MEMORY_CONFIG } from '../src/modules/memory/engines/memory-engine.factory';
import { MEMORY_USAGE_CLOCK } from '../src/modules/memory/memory-usage.service';
import { FakeEngine } from '../src/modules/memory/engines/fake.engine';
import { NotifyOrchestrator } from '../src/modules/notifications/notify-orchestrator.service';
import type { MemoryConfig } from '../src/config/memory.config';

const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};
const JWT_SECRET = 'memory-usage-e2e-secret';
const RUN = `musage-${Date.now().toString(36)}`;
/** Usage 必须能诊断历史共享态；在独立旧 schema 中保留这些负例，绝不拆共享 dev 索引。 */
const TEMP_DB_NAME = `memory_usage_${process.pid}_${Date.now().toString(36)}`;

/** fake 引擎的确定性时钟起点（2026-01-01 UTC）附近的显式窗口 */
const FAKE_WINDOW = {
  since: '2026-01-01T00:00:00.000Z',
  until: '2026-01-02T00:00:00.000Z',
};

function makeMemoryConfig(): MemoryConfig {
  return {
    engine: 'fake',
    humentBaseUrl: 'http://127.0.0.1:1',
    humentTimeoutMs: 90000,
    provisioningEnabled: false,
    operatorSocketPath: null,
    operatorBindingId: 'binding-ops-chamber',
    provisioningTenantId: 'chamber',
    healthProbeEnabled: false,
    warnings: [],
  };
}

/** 可脚本化 usage 引擎：默认委托 FakeEngine；失败面用队列注入（**不把故障开关塞进 FakeEngine**） */
class ScriptedUsageEngine implements MemoryEngine {
  readonly name = 'fake';
  private readonly inner = new FakeEngine();

  summaryCalls = 0;
  traceCalls = 0;
  summaryQueue: MemoryEngineResult<HumentUsageSummary>[] = [];
  traceQueue: MemoryEngineResult<HumentUsageTrace>[] = [];
  lastSummaryQuery: HumentUsageSummaryQuery | null = null;
  lastTraceQuery: HumentUsageTraceQuery | null = null;

  reset(): void {
    this.summaryCalls = 0;
    this.traceCalls = 0;
    this.summaryQueue.length = 0;
    this.traceQueue.length = 0;
    this.lastSummaryQuery = null;
    this.lastTraceQuery = null;
    this.inner.reset();
  }

  async getUsageSummary(
    target: MemoryEngineTarget,
    query: HumentUsageSummaryQuery,
  ): Promise<MemoryEngineResult<HumentUsageSummary>> {
    this.summaryCalls += 1;
    this.lastSummaryQuery = query;
    const queued = this.summaryQueue.shift();
    if (queued) return queued;
    return this.inner.getUsageSummary(target, query);
  }

  async getUsageTrace(
    target: MemoryEngineTarget,
    query: HumentUsageTraceQuery,
  ): Promise<MemoryEngineResult<HumentUsageTrace>> {
    this.traceCalls += 1;
    this.lastTraceQuery = query;
    const queued = this.traceQueue.shift();
    if (queued) return queued;
    return this.inner.getUsageTrace(target, query);
  }

  // ── 其余动词一律委托（本套件只测 usage；不委托 = 接口编译红） ──
  nominate(t: never, i: never): Promise<MemoryEngineResult<MemoryNominationResult>> {
    return this.inner.nominate(t, i);
  }
  inspectNomination(
    t: never,
    i: InspectNominationInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    return this.inner.inspectNomination(t, i);
  }
  recall(t: never, i: never): Promise<MemoryEngineResult<MemoryRecallResult>> {
    return this.inner.recall(t, i);
  }
  correct(t: never, i: never): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    return this.inner.correct(t, i);
  }
  inspectCorrection(
    t: never,
    i: InspectCorrectionInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    return this.inner.inspectCorrection(t, i);
  }
  readMemory(t: never, id: never): Promise<MemoryEngineResult<MemoryReadResult>> {
    return this.inner.readMemory(t, id);
  }
  getGraphView(
    t: never,
    q: HumentMemoryGraphViewQuery,
  ): Promise<MemoryEngineResult<HumentMemoryGraphView>> {
    return this.inner.getGraphView(t, q);
  }
  getMemoryView(
    t: never,
    id: never,
    q: HumentMemoryViewRelationsQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewDetail>> {
    return this.inner.getMemoryView(t, id, q);
  }
  getMemoryViewHistory(
    t: never,
    id: never,
    r: never,
    q: HumentMemoryViewHistoryQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewHistory>> {
    return this.inner.getMemoryViewHistory(t, id, r, q);
  }
  getMemoryViewRepresentation(
    t: never,
    id: never,
    r: never,
  ): Promise<MemoryEngineResult<HumentMemoryViewRepresentation>> {
    return this.inner.getMemoryViewRepresentation(t, id, r);
  }
  getMemoryRelations(t: never, id: never): Promise<MemoryEngineResult<HumentMemoryRelations>> {
    return this.inner.getMemoryRelations(t, id);
  }
  healthCheck(): Promise<MemoryEngineResult<void>> {
    return this.inner.healthCheck();
  }
}

const scriptedEngine = new ScriptedUsageEngine();

/** 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态） */
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
class UsageE2eAuthModule {}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      database: TEMP_DB_NAME,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    UsageE2eAuthModule,
    CommonModule,
    PermissionModule,
    EventEmitterModule.forRoot(),
    MemoryModule,
    HintsModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
})
class UsageE2eModule {}

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

interface UsageBody {
  engine: Record<string, unknown> & {
    totals: {
      counts: { evidence_rows: number };
      tokens: { input_tokens: number | null };
    };
    filter: Record<string, string>;
    rows?: Array<Record<string, unknown>>;
    total_rows?: number;
    has_more?: boolean;
    next_cursor?: string;
  };
  target: { workspaceId: string; actorId: string; scope: string };
  usageCaveat: string;
}

describe('Memory Usage — 真实 PG + 真实 HTTP 集成（alpha.19）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwtService: JwtService;
  let dbAvailable = false;
  /** 维护连接只建/删本 run 的临时库，afterAll 即使 setup 失败也清理。 */
  let adminDs: DataSource;
  let tempDbCreated = false;

  let agentAId = '';
  let agentAKey = '';
  let agentBId = '';
  let agentBKey = '';
  let adminUserId = '';
  let adminToken = '';
  let topicAPrivate = '';
  let topicBPrivate = '';

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    projectIds: [] as string[],
    topicIds: [] as string[],
    // 共享/冒领夹具里 claim 的 project_id 可能是合成 id
    syntheticClaimProjectIds: [] as string[],
  };

  const notifyStub = { sendSystemAlert: jest.fn().mockResolvedValue('delivered') };

  /**
   * 可控时钟（N4）：默认窗口必须**只物化一次**。调用计数是"第二页有没有重算 now"的判别器
   * ——固定返回值下即使重算也得到同一串，只有计数能证伪。
   */
  let usageClockCalls = 0;
  const usageClock = (): Date => {
    usageClockCalls += 1;
    return new Date('2026-01-01T02:00:00.000Z');
  };

  function req(key: string) {
    return {
      get: (path: string) =>
        request(app.getHttpServer()).get(`${API_PREFIX}${path}`).set('X-API-Key', key),
      post: (path: string) =>
        request(app.getHttpServer()).post(`${API_PREFIX}${path}`).set('X-API-Key', key),
      patch: (path: string) =>
        request(app.getHttpServer()).patch(`${API_PREFIX}${path}`).set('X-API-Key', key),
    };
  }

  async function createHuman(role: UserRole, seq: number, label: string): Promise<string> {
    const displayName = `Usage ${label} ${RUN} #${seq}`;
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const user = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: actor.id,
        actor,
        username: `usage${RUN}${seq}`.slice(0, 50),
        email: `usage-${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    created.userIds.push(user.id);
    return user.id;
  }

  async function createAgentWithKey(
    seq: number,
    ownerUserId?: string,
  ): Promise<{ agentId: string; apiKey: string }> {
    const owner = ownerUserId ?? (await createHuman(UserRole.EDITOR, seq + 300, 'Owner'));
    const displayName = `Usage Agent ${RUN} #${seq}`;
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
        ownerId: owner,
        name: displayName,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    const rawKey = `ask_usage${RUN}${String(seq).padStart(3, '0')}`.slice(0, 40);
    const key = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner,
      }),
    );
    created.keyIds.push(key.id);
    return { agentId: agent.id, apiKey: rawKey };
  }

  async function createPrivateTopic(creatorId: string): Promise<string> {
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `usage topic ${RUN} ${created.topicIds.length}`,
        creatorId,
        settings: { visibility: 'private' },
        participantCount: 0,
        messageCount: 0,
      }),
    );
    created.topicIds.push(topic.id);
    return topic.id;
  }

  async function addParticipant(
    topicId: string,
    actorId: string,
    role: TopicParticipantRole = TopicParticipantRole.EDITOR,
  ): Promise<void> {
    await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId,
        participantId: actorId,
        role,
        status: ParticipantStatus.ACTIVE,
        joinedAt: new Date(),
      }),
    );
  }

  /** 建项目（显式三元组；每个项目唯一 ⇒ claim 不冲突） */
  async function createProject(
    overrides: Record<string, unknown> = {},
    key: string = agentAKey,
  ): Promise<string> {
    const seq = created.projectIds.length;
    const res = await req(key)
      .post('/memory/projects')
      .send({
        slug: `usage-${RUN}-${seq}`,
        name: `usage project ${RUN} #${seq}`,
        bindings: [{ type: 'topic', id: topicAPrivate }],
        engine: 'hument',
        engineWorkspaceId: `ws-${RUN}-${seq}`,
        engineActorId: `act-${RUN}-${seq}`,
        engineCredentialRef: `ref-${RUN}-${seq}`,
        ...overrides,
      });
    if (res.status !== 201) {
      throw new Error(`createProject failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const id = (res.body as Envelope<{ id: string }>).data.id;
    created.projectIds.push(id);
    return id;
  }

  function claim(token: string): Record<string, unknown> {
    return {
      category: 'ruling',
      subject: `usage 主张 ${token}`,
      scope: `usage 适用 ${RUN}`,
      effectiveNote: '自本批次起生效',
      rationale: `usage 理由 ${token}`,
    };
  }

  async function nominate(projectId: string, token: string): Promise<void> {
    const res = await req(agentAKey)
      .post(`/memory/projects/${projectId}/nominations`)
      .send(claim(token));
    if (res.status !== 201) {
      throw new Error(`nominate failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }

  function usagePath(projectId: string, mode: 'summary' | 'trace', query: Record<string, unknown>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const search = params.toString();
    return `/memory/projects/${projectId}/usage/${mode}${search ? `?${search}` : ''}`;
  }

  beforeAll(async () => {
    adminDs = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      database: process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres',
      entities: [],
      migrations: [],
      logging: false,
    });
    try {
      await adminDs.initialize();
    } catch (err) {
      console.warn(`[memory usage e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    await adminDs.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);
    tempDbCreated = true;
    ds = new DataSource({
      ...AppDataSource.options,
      ...DB_CONFIG,
      database: TEMP_DB_NAME,
      synchronize: false,
      migrationsRun: false,
      logging: false,
    } as DataSourceOptions);
    await ds.initialize();
    // 历史共享的 active/archived 夹具只在加固前快照出现，测试不篡改新设计数据。
    const legacyMigrations = ds.migrations.filter(
      (migration) =>
        Number((migration.name ?? migration.constructor.name).slice(-13)) < 1792500000000,
    );
    // DataSource.migrations 属性只读，数组本身可变；保留真实入口已加载的迁移实例。
    ds.migrations.splice(0, ds.migrations.length, ...legacyMigrations);
    await ds.runMigrations();

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
        ('memory_projects','memory_nominations','memory_engine_binding_claims')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'memory_engine_binding_claims',
      'memory_nominations',
      'memory_projects',
    ]);
    dbAvailable = true;

    const agentA = await createAgentWithKey(1);
    agentAId = agentA.agentId;
    agentAKey = agentA.apiKey;
    const agentB = await createAgentWithKey(2);
    agentBId = agentB.agentId;
    agentBKey = agentB.apiKey;

    // 库里只允许一个 admin（idx_unique_admin）；优先复用既有 active admin
    const admins = (await ds.query(
      `SELECT u.id AS id FROM users u JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' AND a.status = 'active' AND a.deleted_at IS NULL LIMIT 1`,
    )) as Array<{ id: string }>;
    adminUserId = admins[0]?.id ?? (await createHuman(UserRole.ADMIN, 3, 'Admin'));

    const moduleRef = await Test.createTestingModule({ imports: [UsageE2eModule] })
      .overrideProvider(MEMORY_ENGINE_RAW)
      .useValue(scriptedEngine)
      .overrideProvider(MEMORY_CONFIG)
      .useValue(makeMemoryConfig())
      // N4：默认 7 天窗口的时钟固定到 fake 记忆时间附近；计数证明第二页不重算
      .overrideProvider(MEMORY_USAGE_CLOCK)
      .useValue(usageClock)
      .overrideProvider(NotifyOrchestrator)
      .useValue(notifyStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    jwtService = app.get(JwtService);
    adminToken = jwtService.sign({
      sub: adminUserId,
      email: `admin-${RUN}@example.com`,
      role: UserRole.ADMIN,
    });

    topicAPrivate = await createPrivateTopic(agentAId);
    await addParticipant(topicAPrivate, agentAId);
    topicBPrivate = await createPrivateTopic(agentBId);
    await addParticipant(topicBPrivate, agentBId);
  }, 180000);

  afterAll(async () => {
    // 整库仅本套件持有，失败也释放；先关 Nest 连接再删库，不触碰任何共享开发数据。
    try {
      if (app) await app.close();
    } finally {
      if (ds?.isInitialized) await ds.destroy();
      if (tempDbCreated) await adminDs.query(`DROP DATABASE "${TEMP_DB_NAME}" WITH (FORCE)`);
      if (adminDs?.isInitialized) await adminDs.destroy();
    }
  }, 120000);

  beforeEach(() => {
    // 每个用例只清队列/计数，**不清记忆**（共享 fake 状态由唯一 token 控制）
    scriptedEngine.summaryQueue.length = 0;
    scriptedEngine.traceQueue.length = 0;
    scriptedEngine.summaryCalls = 0;
    scriptedEngine.traceCalls = 0;
    scriptedEngine.lastSummaryQuery = null;
    scriptedEngine.lastTraceQuery = null;
    usageClockCalls = 0;
  });

  it('summary 200：engine 无 target / 外层 camelCase target / usageCaveat / no-store', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    for (let i = 0; i < 4; i += 1) await nominate(projectId, `summary-${i}-${RUN}`);

    const res = await req(agentAKey).get(
      usagePath(projectId, 'summary', { since: FAKE_WINDOW.since, until: FAKE_WINDOW.until }),
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const triple = (await ds.query(
      `SELECT engine_workspace_id, engine_actor_id FROM memory_projects WHERE id = $1`,
      [projectId],
    )) as Array<{ engine_workspace_id: string; engine_actor_id: string }>;
    const data = (res.body as Envelope<UsageBody>).data;
    expect(Object.keys(data.engine).sort()).toEqual(
      [
        'as_of',
        'coverage',
        'filter',
        'groups',
        'schema_version',
        'snapshot',
        'time_basis',
        'totals',
      ].sort(),
    );
    expect('target' in data.engine).toBe(false);
    expect(data.target).toEqual({
      workspaceId: triple[0].engine_workspace_id,
      actorId: triple[0].engine_actor_id,
      scope: 'actor_private',
    });
    expect(typeof data.usageCaveat).toBe('string');
    expect(data.usageCaveat).toContain('null = 未知');
    expect(data.engine.totals.counts.evidence_rows).toBe(4);
    expect(data.engine.filter).toEqual({ since: FAKE_WINDOW.since, until: FAKE_WINDOW.until });
    // 敏感身份不回显
    expect(JSON.stringify(data)).not.toContain(`ref-${RUN}`);
    expect(JSON.stringify(data)).not.toContain('binding-fake');
    expect(JSON.stringify(data)).not.toContain(`ns-`);
    expect(JSON.stringify(data.engine)).not.toContain('"target"');
  });

  it('trace 200：limit 1 分页 / totals 与页大小无关 / null 与 0 三态保留', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    for (let i = 0; i < 4; i += 1) await nominate(projectId, `trace-${i}-${RUN}`);

    const first = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        limit: 1,
      }),
    );
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const firstData = (first.body as Envelope<UsageBody>).data;
    expect(firstData.engine.rows).toHaveLength(1);
    expect(firstData.engine.total_rows).toBe(4);
    expect(firstData.engine.has_more).toBe(true);
    expect(firstData.engine.next_cursor).toBeTruthy();
    // totals 覆盖全匹配集（不是本页 1 条）
    expect(firstData.engine.totals.counts.evidence_rows).toBe(4);
    // index 0 行：input=null, output=0（fake 的确定性三态）
    expect(firstData.engine.rows?.[0].input_tokens).toBeNull();
    expect(firstData.engine.rows?.[0].output_tokens).toBe(0);
    expect('started_at' in (firstData.engine.rows?.[0] ?? {})).toBe(true);

    const second = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        limit: 1,
        cursor: firstData.engine.next_cursor,
      }),
    );
    expect(second.status).toBe(200);
    const secondData = (second.body as Envelope<UsageBody>).data;
    expect(secondData.engine.rows?.[0].id).not.toBe(firstData.engine.rows?.[0].id);
    // index 1 行：input=0, output=null
    expect(secondData.engine.rows?.[0].input_tokens).toBe(0);
    expect(secondData.engine.rows?.[0].output_tokens).toBeNull();
    expect(secondData.engine.totals.tokens.input_tokens).toBeNull();
  });

  it('过滤缩小全匹配集（providerOperation=generation ⇒ 2 条）', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    for (let i = 0; i < 4; i += 1) await nominate(projectId, `filter-${i}-${RUN}`);

    const res = await req(agentAKey).get(
      usagePath(projectId, 'summary', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        providerOperation: 'generation',
      }),
    );
    expect(res.status).toBe(200);
    const data = (res.body as Envelope<UsageBody>).data;
    expect(data.engine.totals.counts.evidence_rows).toBe(2);
    expect(data.engine.filter.provider_operation).toBe('generation');
  });

  it('默认时间窗：省略 since/until ⇒ 7 天绝对窗口经 engine.filter 回声（窗口零记录也 200）', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();

    const summary = await req(agentAKey).get(usagePath(projectId, 'summary', {}));
    expect(summary.status).toBe(200);
    const summaryData = (summary.body as Envelope<UsageBody>).data;
    expect(summaryData.engine.filter.since).toMatch(/Z$/);
    expect(summaryData.engine.filter.until).toMatch(/Z$/);
    const span =
      Date.parse(summaryData.engine.filter.until) - Date.parse(summaryData.engine.filter.since);
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
    // fake 的记忆在 2026-01-01，当前 7 天窗口必然零记录
    expect(summaryData.engine.totals.counts.evidence_rows).toBe(0);

    const trace = await req(agentAKey).get(usagePath(projectId, 'trace', {}));
    expect(trace.status).toBe(200);
    const traceData = (trace.body as Envelope<UsageBody>).data;
    expect(traceData.engine.total_rows).toBe(0);
    expect(traceData.engine.limit).toBe(100);
  });

  it('默认窗口首页 → 用 engine.filter 的绝对 since/until + cursor 取第二页：不重算 now、不 409', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    for (let i = 0; i < 4; i += 1) await nominate(projectId, `default-cursor-${i}-${RUN}`);

    // 首页：**省略** since/until（服务端用固定时钟物化 7 天窗口）
    const first = await req(agentAKey).get(usagePath(projectId, 'trace', { limit: 1 }));
    expect(first.status).toBe(200);
    const firstData = (first.body as Envelope<UsageBody>).data;
    expect(firstData.engine.has_more).toBe(true);
    expect(firstData.engine.filter).toEqual({
      since: '2025-12-25T02:00:00.000Z',
      until: '2026-01-01T02:00:00.000Z',
    });
    expect(firstData.engine.total_rows).toBe(4);
    expect(usageClockCalls).toBe(1);
    const cursor = firstData.engine.next_cursor;
    expect(cursor).toBeTruthy();

    // 第二页：**原样回送** engine.filter 的绝对时间窗 + 同一 limit + cursor
    const second = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: firstData.engine.filter.since,
        until: firstData.engine.filter.until,
        limit: 1,
        cursor,
      }),
    );
    expect(second.status).toBe(200);
    const secondData = (second.body as Envelope<UsageBody>).data;
    expect(secondData.engine.total_rows).toBe(4);
    expect(secondData.engine.rows?.[0].id).not.toBe(firstData.engine.rows?.[0].id);

    // 判别器：第二页**不得**再调用时钟（否则就是重算 now）；引擎收到的窗口必须与首页回声逐字一致
    expect(usageClockCalls).toBe(1);
    expect(scriptedEngine.lastTraceQuery).toMatchObject({
      since: '2025-12-25T02:00:00.000Z',
      until: '2026-01-01T02:00:00.000Z',
      limit: 1,
      cursor,
    });
  });

  it('游标双通道：改 limit ⇒ 400 invalid_argument；数据变 ⇒ 409 conflict；平台都落 502 + cursor_reset_required', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    for (let i = 0; i < 3; i += 1) await nominate(projectId, `cursor-${i}-${RUN}`);

    const first = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        limit: 1,
      }),
    );
    expect(first.status).toBe(200);
    const cursor = (first.body as Envelope<UsageBody>).data.engine.next_cursor;
    expect(cursor).toBeTruthy();

    const changed = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        limit: 2,
        cursor,
      }),
    );
    expect(changed.status).toBe(502);
    expect(changed.headers['cache-control']).toBe('no-store');
    const changedBody = changed.body as Envelope<unknown> & { data: Record<string, unknown> };
    expect(changedBody.code).toBe(ErrorCode.MEMORY_ENGINE_ERROR);
    expect(changedBody.data.hintCode).toBe('cursor_reset_required');
    expect(changedBody.data.engineCode).toBe('invalid_argument');

    // 数据变（新记忆形成）⇒ 409 conflict
    await nominate(projectId, `cursor-new-${RUN}`);
    const stale = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        limit: 1,
        cursor,
      }),
    );
    expect(stale.status).toBe(502);
    const staleBody = stale.body as Envelope<unknown> & { data: Record<string, unknown> };
    expect(staleBody.data.hintCode).toBe('cursor_reset_required');
    expect(staleBody.data.engineCode).toBe('conflict');

    // 重拉首页一次 ⇒ 200
    const reset = await req(agentAKey).get(
      usagePath(projectId, 'trace', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
        limit: 1,
      }),
    );
    expect(reset.status).toBe(200);
  });

  it('权限矩阵：非成员 404 / 部分可读 403 / 零绑定 creator 403 / admin 200', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();

    // ① B 不是 private topic 参与者 ⇒ 非治理 + 全不可读 ⇒ 404
    const notMine = await req(agentBKey).get(usagePath(projectId, 'summary', {}));
    expect(notMine.status).toBe(404);
    expect((notMine.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_PROJECT_NOT_FOUND);
    expect(notMine.headers['cache-control']).toBe('no-store');

    // ② 部分可读：项目同时绑 A 的 private topic 与 B 的 private topic（SQL 造夹具）
    const partial = await createProject();
    await ds.query(`UPDATE memory_projects SET bindings = $2::jsonb WHERE id = $1`, [
      partial,
      JSON.stringify([
        { type: 'topic', id: topicAPrivate },
        { type: 'topic', id: topicBPrivate },
      ]),
    ]);
    const partialA = await req(agentAKey).get(usagePath(partial, 'summary', {}));
    expect(partialA.status).toBe(403);
    expect((partialA.body as Envelope<unknown>).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect(partialA.headers['cache-control']).toBe('no-store');
    const partialB = await req(agentBKey).get(usagePath(partial, 'summary', {}));
    expect(partialB.status).toBe(403);

    // ③ creator 清空绑定 ⇒ 403（治理观察者但 Usage 需要全绑定可读且非空）
    const empty = await createProject();
    const cleared = await req(agentAKey).patch(`/memory/projects/${empty}`).send({ bindings: [] });
    expect(cleared.status).toBe(200);
    const emptyRes = await req(agentAKey).get(usagePath(empty, 'summary', {}));
    expect(emptyRes.status).toBe(403);

    // ④ admin JWT ⇒ 200（不需要绑定）
    const adminRes = await request(app.getHttpServer())
      .get(`${API_PREFIX}${usagePath(empty, 'summary', {})}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers['cache-control']).toBe('no-store');

    // ⑤ 无认证 ⇒ 401 + no-store
    const anonymous = await request(app.getHttpServer()).get(
      `${API_PREFIX}${usagePath(projectId, 'summary', {})}`,
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
  });

  it('共享/claim：活跃/软删同三元组、claim 缺失或他人占用 ⇒ 409 + 引擎 0 调用', async () => {
    if (!dbAvailable) return;

    // ① 活跃重复行（同三元组）
    const shared = await createProject();
    const row = (await ds.query(
      `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref FROM memory_projects WHERE id = $1`,
      [shared],
    )) as Array<Record<string, string>>;
    const duplicateId = crypto.randomUUID();
    created.projectIds.push(duplicateId);
    await ds.query(
      `INSERT INTO memory_projects
        (id, slug, name, bindings, engine, engine_workspace_id, engine_actor_id,
         engine_credential_ref, status, retain_query_text, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'active',true,$9,now(),now())`,
      [
        duplicateId,
        `usage-dup-${RUN}`,
        `usage dup ${RUN}`,
        JSON.stringify([{ type: 'topic', id: topicAPrivate }]),
        row[0].engine,
        row[0].engine_workspace_id,
        row[0].engine_actor_id,
        row[0].engine_credential_ref,
        agentAId,
      ],
    );
    const before = scriptedEngine.summaryCalls;
    const sharedRes = await req(agentAKey).get(usagePath(shared, 'summary', {}));
    expect(sharedRes.status).toBe(409);
    expect(sharedRes.headers['cache-control']).toBe('no-store');
    expect((sharedRes.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_USAGE_CONFLICT);
    expect((sharedRes.body as Envelope<{ hintCode: string }>).data.hintCode).toBe(
      'shared_engine_binding',
    );
    expect(scriptedEngine.summaryCalls).toBe(before);

    // ② 只有软删重复行（withDeleted 扫描必须看见）
    const soft = await createProject();
    const softRow = (await ds.query(
      `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref FROM memory_projects WHERE id = $1`,
      [soft],
    )) as Array<Record<string, string>>;
    const softDupId = crypto.randomUUID();
    created.projectIds.push(softDupId);
    await ds.query(
      `INSERT INTO memory_projects
        (id, slug, name, bindings, engine, engine_workspace_id, engine_actor_id,
         engine_credential_ref, status, retain_query_text, created_by, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'active',true,$9,now(),now(),now())`,
      [
        softDupId,
        `usage-soft-${RUN}`,
        `usage soft ${RUN}`,
        JSON.stringify([{ type: 'topic', id: topicAPrivate }]),
        softRow[0].engine,
        softRow[0].engine_workspace_id,
        softRow[0].engine_actor_id,
        softRow[0].engine_credential_ref,
        agentAId,
      ],
    );
    const softRes = await req(agentAKey).get(usagePath(soft, 'summary', {}));
    expect(softRes.status).toBe(409);

    // ③ claim 缺失
    const missing = await createProject();
    await ds.query(`DELETE FROM memory_engine_binding_claims WHERE project_id = $1`, [missing]);
    const missingBefore = scriptedEngine.summaryCalls;
    const missingRes = await req(agentAKey).get(usagePath(missing, 'summary', {}));
    expect(missingRes.status).toBe(409);
    expect(scriptedEngine.summaryCalls).toBe(missingBefore);

    // ④ claim 归属他人（合成 project id；清理按 id 精确删除）
    const foreign = await createProject();
    const syntheticOwner = crypto.randomUUID();
    created.syntheticClaimProjectIds.push(syntheticOwner);
    await ds.query(
      `UPDATE memory_engine_binding_claims SET project_id = $2 WHERE project_id = $1`,
      [foreign, syntheticOwner],
    );
    const foreignRes = await req(agentAKey).get(usagePath(foreign, 'summary', {}));
    expect(foreignRes.status).toBe(409);
  });

  it('archived：当前项目 archived 仍可读；active+archived / active+软删重复行都 409 且引擎 0 调用', async () => {
    if (!dbAvailable) return;

    async function tripleOf(projectId: string) {
      const rows = (await ds.query(
        `SELECT engine, engine_workspace_id, engine_actor_id, engine_credential_ref
           FROM memory_projects WHERE id = $1`,
        [projectId],
      )) as Array<Record<string, string>>;
      return rows[0];
    }

    async function insertDuplicate(
      triple: Record<string, string>,
      options: { slug: string; status: 'active' | 'archived'; deleted: boolean },
    ): Promise<string> {
      const id = crypto.randomUUID();
      created.projectIds.push(id);
      await ds.query(
        `INSERT INTO memory_projects
          (id, slug, name, bindings, engine, engine_workspace_id, engine_actor_id,
           engine_credential_ref, status, retain_query_text, created_by, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,true,$10,now(),now(),$11)`,
        [
          id,
          options.slug,
          options.slug,
          JSON.stringify([{ type: 'topic', id: topicAPrivate }]),
          triple.engine,
          triple.engine_workspace_id,
          triple.engine_actor_id,
          triple.engine_credential_ref,
          options.status,
          agentAId,
          options.deleted ? new Date() : null,
        ],
      );
      return id;
    }

    // ① 当前项目 archived（唯一三元组）⇒ 读路径放行 200
    const archivedCurrent = await createProject();
    const archived = await req(agentAKey)
      .patch(`/memory/projects/${archivedCurrent}`)
      .send({ status: 'archived' });
    expect(archived.status).toBe(200);
    const archivedRes = await req(agentAKey).get(
      usagePath(archivedCurrent, 'summary', {
        since: FAKE_WINDOW.since,
        until: FAKE_WINDOW.until,
      }),
    );
    expect(archivedRes.status).toBe(200);

    // ② active 当前 + archived 重复行 ⇒ 409，引擎 0 调用
    const withArchivedDup = await createProject();
    await insertDuplicate(await tripleOf(withArchivedDup), {
      slug: `usage-arch-dup-${RUN}`,
      status: 'archived',
      deleted: false,
    });
    const archivedDupBefore = scriptedEngine.summaryCalls;
    const archivedDup = await req(agentAKey).get(usagePath(withArchivedDup, 'summary', {}));
    expect(archivedDup.status).toBe(409);
    expect((archivedDup.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_USAGE_CONFLICT);
    expect(scriptedEngine.summaryCalls).toBe(archivedDupBefore);

    // ③ active 当前 + 软删重复行 ⇒ 409，引擎 0 调用
    const withDeletedDup = await createProject();
    await insertDuplicate(await tripleOf(withDeletedDup), {
      slug: `usage-del-dup-${RUN}`,
      status: 'active',
      deleted: true,
    });
    const deletedDupBefore = scriptedEngine.summaryCalls;
    const deletedDup = await req(agentAKey).get(usagePath(withDeletedDup, 'summary', {}));
    expect(deletedDup.status).toBe(409);
    expect((deletedDup.body as Envelope<unknown>).code).toBe(ErrorCode.MEMORY_USAGE_CONFLICT);
    expect(scriptedEngine.summaryCalls).toBe(deletedDupBefore);
  });

  it('503：项目未绑引擎 / 旧 Hub 404（version unsupported）；400 DTO 也 no-store', async () => {
    if (!dbAvailable) return;

    // ① 项目 engine=none ⇒ 503 project_engine_unbound
    const none = await createProject({
      engine: 'none',
      engineWorkspaceId: null,
      engineActorId: null,
      engineCredentialRef: null,
    });
    const noneRes = await req(agentAKey).get(usagePath(none, 'summary', {}));
    expect(noneRes.status).toBe(503);
    expect(noneRes.headers['cache-control']).toBe('no-store');
    expect((noneRes.body as Envelope<{ reason: string }>).data.reason).toBe(
      MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
    );

    // ② 旧 Hub 404 ⇒ 503 engine_version_unsupported
    const oldHub = await createProject();
    scriptedEngine.summaryQueue.push({
      ok: false,
      failure: {
        kind: 'http',
        message: 'not found',
        httpStatus: 404,
        engineCode: 'resource_not_found',
        latencyMs: 1,
      },
    });
    const oldHubRes = await req(agentAKey).get(usagePath(oldHub, 'summary', {}));
    expect(oldHubRes.status).toBe(503);
    expect(oldHubRes.headers['cache-control']).toBe('no-store');
    expect((oldHubRes.body as Envelope<{ reason: string }>).data.reason).toBe(
      MEMORY_UNAVAILABLE_REASON.ENGINE_VERSION_UNSUPPORTED,
    );

    // ③ DTO 400（无时区）也 no-store
    const projectId = await createProject();
    const bad = await req(agentAKey).get(
      usagePath(projectId, 'summary', { since: '2026-10-01T00:00:00' }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe('no-store');
  });

  it('429：上游 Retry-After ⇒ 平台 429 + Retry-After 头 + no-store', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    scriptedEngine.summaryQueue.push({
      ok: false,
      failure: {
        kind: 'http',
        message: 'slow down',
        httpStatus: 429,
        engineCode: 'overloaded',
        retryAfterSeconds: 7,
        latencyMs: 1,
      },
    });

    const res = await req(agentAKey).get(usagePath(projectId, 'summary', {}));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Envelope<{ retryAfterSeconds: number }>).data.retryAfterSeconds).toBe(7);
  });

  it('canReadUsage：项目列表/详情按「admin 或全绑定可读」投影（不是 canReadContent）', async () => {
    if (!dbAvailable) return;
    const projectId = await createProject();
    const partial = await createProject();
    await ds.query(`UPDATE memory_projects SET bindings = $2::jsonb WHERE id = $1`, [
      partial,
      JSON.stringify([
        { type: 'topic', id: topicAPrivate },
        { type: 'topic', id: topicBPrivate },
      ]),
    ]);

    const slugRows = (await ds.query(
      `SELECT id, slug FROM memory_projects WHERE id = ANY($1::uuid[])`,
      [[projectId, partial]],
    )) as Array<{ id: string; slug: string }>;
    const projectSlug = slugRows.find((row) => row.id === projectId)!.slug;
    const partialSlug = slugRows.find((row) => row.id === partial)!.slug;

    const list = await req(agentAKey).get(
      `/memory/projects?slug=${encodeURIComponent(projectSlug)}`,
    );
    expect(list.status).toBe(200);
    const item = (
      list.body as Envelope<{
        items: Array<{ id: string; canReadContent: boolean; canReadUsage: boolean }>;
      }>
    ).data.items.find((entry) => entry.id === projectId);
    expect(item).toBeDefined();
    expect(item?.canReadContent).toBe(true);
    expect(item?.canReadUsage).toBe(true);

    const partialList = await req(agentAKey).get(
      `/memory/projects?slug=${encodeURIComponent(partialSlug)}`,
    );
    const partialItem = (
      partialList.body as Envelope<{ items: Array<{ id: string; canReadUsage: boolean }> }>
    ).data.items.find((entry) => entry.id === partial);
    expect(partialItem?.canReadUsage).toBe(false);

    const adminList = await request(app.getHttpServer())
      .get(`${API_PREFIX}/memory/projects?slug=${encodeURIComponent(partialSlug)}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminList.status).toBe(200);
    const adminItem = (
      adminList.body as Envelope<{ items: Array<{ id: string; canReadUsage: boolean }> }>
    ).data.items.find((entry) => entry.id === partial);
    expect(adminItem?.canReadUsage).toBe(true);
  });
});
