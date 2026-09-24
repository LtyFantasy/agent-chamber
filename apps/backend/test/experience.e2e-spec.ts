/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）端到端契约：检索三路融合 / 传参协议 / 反馈计数联动 /
 *     质量治理角色矩阵（v1.81.0 起为**纯角色判定**，禁自审四态已退役）/ 空间成员四端点 /
 *     owner 代理 / 软删 / 索引与 trigger 在场 / migration 往返 / 归属人名字与按录入者检索
 *
 * [代码职责]
 *   - 用**真实 PG + 真实 HTTP**（真 JWT、真 sha256 API Key）钉死 plan 的 e2e 清单，
 *     并补齐**漂移门禁盲区**的守卫：索引的 indexdef + search_vector trigger + reloptions
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（匹配契约）/§3（API 契约）/§7（测试计划）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章
 *
 * [关键不变量]（本套件是这些不变量的守门人，改动断言前先想清楚在防什么）
 *   - **数组参数形态**：`signals=a&signals=b`（重复参数）必须命中；`signals[]=` 必须 400。
 *     两者在 qs 解析后 `req.query` 形状**相同**，只有真实 HTTP 请求能证伪——mock 测不出
 *   - **signals 匹配是 ANY-overlap 的精确相等**：共享至少一个即命中（加更多 signal 是**扩大**
 *     结果集）；部分关键词（子串）**不中**——若退化成子串匹配，检索会变成噪声
 *   - **归一化双向对称**：写入 `ECONNREFUSED` 后用小写查询必须命中（两边 trim+lowercase）
 *   - **异词汇召回**：录「端口映射失效」→ 搜「端口不可达」也能召回（trgm 通道的价值所在，
 *     只有 tsvector 通道时这类查询恒零命中）
 *   - **反馈三列与反馈行同事务**：并发 N 个不同 actor 的反馈后 `distinct_helped_count == N`
 *     （丢了任何一次更新都会让计数与实际行数不符）
 *   - **反馈不顶 `updated_at`**：否则 `sort=recent` 会被反馈刷屏
 *   - **软删对读写一律 404**，且 facets 不再计入
 *   - **质量终审角色矩阵**：无终审角色（agent Key / 非 admin 人类）→ 403/13004；
 *     空间 owner/reviewer → 200。**自 v1.81.0 起禁自审四态已退役**：持角色者可终审**任意**
 *     条目（含本人所录）——旧 403/13002 已不存在，故这里必须钉住"本人所录 → 200"
 *     （旧约束若静默回流，线上表现为待审队列永久空转、无任何报错）
 *   - **归属人名字**：`createdByName`/`verifiedByName` 由服务端换名（裸 UUID 不上屏）；
 *     软删 actor 的名字**仍在**（配 `createdByDeletedAt`），真孤儿 name=null（不造兜底词）
 *   - **按录入者检索**：`?createdById=<uuid>` 精确相等命中，且是**真过滤**（计入真检索埋点）
 *   - **一期 11 条索引 + trigger 在场**：纯表达式索引（indkey 全 0）与 trigger 对漂移门禁
 *     **结构性不可见**（TypeORM 的索引查询 INNER JOIN pg_attribute 会滤掉 indkey=0，
 *     trigger 从不加载），本套件是它们唯一的守卫（见 migration-drift-baseline.txt 盲区注释）
 *   - **第二期两新表**（experience_space_members / experience_judgments）在场，且
 *     judgments 的**两条索引 indexdef（含 DESC 全序）+ 表级 reloptions** 在场：
 *     reloptions 漂移门禁根本不比对，分页全序索引缺失只在翻页时表现为漏行/重复
 *
 * [关联代码]
 *   - src/modules/experience/experience.controller.ts — 12 端点与逐方法守卫
 *   - src/modules/experience/experience.service.ts — 匹配/打分/计数联动/埋点/终审写入/名字投影
 *   - src/modules/experience/experience-member.service.ts — 成员四端点 + 终审资格（纯角色判定）
 *   - src/modules/experience/experience-judgment.service.ts — 判断日志（`actorName` 补名）
 *   - src/database/migrations/1790000000000-AddExperienceEntries.ts — 两表 + 11 索引 + trigger
 *   - src/database/migrations/1790100000000-AddExperienceSearchEvents.ts — 零命中埋点表
 *   - src/database/migrations/1790200000000-AddExperiencePhase2.ts — 第二期两表 + judgment 列
 *     （表存在性 5 表断言 + 往返套件 + judgments 索引/reloptions 断言的守卫对象）
 *   - test/usage-stats.e2e-spec.ts — 本套件的装配范式来源（真库最小 app + RUN 隔离）
 *
 * [持久踩坑]
 *   EXPERIENCE-E2E-MIGRATION(共享库往返): 直接 `migration:revert` 会真 DROP 掉共享开发库
 *     的表（并行套件/dev 后端同在）。安全方向: 自持事务内 down→up→ROLLBACK（PG 的 DDL
 *     可回滚），既验证真 DDL 又不改库状态。
 *   EXPERIENCE-E2E-FLOOR(分数下限实证): 单 token 精确匹配的 ts_rank ≈ 0.0608 **低于**
 *     SCORE_FLOOR 0.08 ⇒ q 通道实际靠 trgm 通道（title×0.8 / content×0.6）把分数抬过线。
 *     故 e2e 的 q 断言必须建在"词出现在标题或正文里"的真实语料上（§9 有钉住该行为的用例）。
 * =============================================================================
 */

/**
 * 经验库 —— 真实 PG + 真实 HTTP 端到端套件（plan §7）
 *
 * 为什么不是 createTestingApp（mock 链）：本功能的全部风险都长在 SQL/索引/事务语义上
 * ——`&&` overlap 是否真走 GIN、`->>` 表达式索引是否真建、`plainto_tsquery`+`similarity`
 * 融合分与 SCORE_FLOOR 的实际交互、`ON CONFLICT` 仲裁者、计数三列并发原子性、软删与
 * facets 的口径一致性——mock 仓储对这些**一律测不出**（铁律 #23）。故自建最小 app：
 * 真库（8744）+ 真 JwtStrategy/ApiKeyAuthService（真 JWT 与真 sha256 Key）+ ExperienceModule
 * + main.ts 同款的全局前缀 `/api/v1` / ValidationPipe / ResponseInterceptor。
 *
 * 环境：本地开发库 chamber-postgres（8744），PG 不可达时整套降级跳过；所有测试数据带
 * RUN 后缀隔离，afterAll 按 id 硬删（experience_entries 无外键到 actors）。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { ExperienceModule } from '../src/modules/experience/experience.module';
import { ExperienceService } from '../src/modules/experience/experience.service';
import {
  JUDGMENT_PROVIDER,
  type ExperienceCheckInput,
  type JudgmentOutcome,
} from '../src/modules/experience/judgment/judgment-provider.interface';
import { JUDGMENT_CONFIG } from '../src/modules/experience/judgment/judgment-provider.factory';
import type { JudgmentConfig } from '../src/config/judgment.config';
import { AddExperienceEntries1790000000000 } from '../src/database/migrations/1790000000000-AddExperienceEntries';
import { AddExperienceSearchEvents1790100000000 } from '../src/database/migrations/1790100000000-AddExperienceSearchEvents';
import { AddExperiencePhase2_1790200000000 } from '../src/database/migrations/1790200000000-AddExperiencePhase2';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其他套件） */
const JWT_SECRET = 'experience-e2e-secret';

/** 本次运行的唯一后缀：隔离数据（信号/领域/来源项目全带它） */
const RUN = `exp-${Date.now().toString(36)}`;

/**
 * 判别服务的**内联 fake provider**（e2e 不联网：真 typesafe 冒烟是单独一次人工动作）。
 *
 * 控制面（每个用例改它决定"下次判定"的行为）：
 * - `mode`：ok / error / timeout（映射到 provider 契约的三种结果）
 * - `gate`：一次性闸门（**首次** checkEntry 会 await 它）——用于构造"判定在途期间条目被再改"
 *   的版本守卫场景（第二次调用不再阻塞，否则会自锁）
 * - `calls`：收到过的判定输入（断言"发的是什么"）
 * - `judgment`：ok 模式下返回的快照（各用例可换 model 以区分是哪一次判定）
 */
const fakeJudgment = {
  enabled: true,
  name: 'jev',
  mode: 'ok' as 'ok' | 'error' | 'timeout',
  gate: null as null | (() => Promise<void>),
  calls: [] as ExperienceCheckInput[],
  judgment: {
    provider: 'jev',
    model: 'jev-fake',
    judgedAt: '2026-09-22T10:00:01.000Z',
    // rubric 代际（v1.82.0）：真实 provider 由 rubric 常量写入，fixture 照抄以断言透传
    rubricVersion: 'v2',
    completeness: { level: 'partial', confidence: 0.7 },
    reusability: { level: 'broad', confidence: 0.6 },
    signalQuality: { level: 'weak', confidence: 0.3 },
    duplicate: { verdict: 'distinct', confidence: 0.9 },
    intentSuggestion: { verdict: 'keep', value: null, confidence: 0.5 },
    domainSuggestion: { verdict: 'none_fits', value: null, confidence: 0.4 },
    admissionSuggestion: { verdict: 'needs_human', confidence: 0.42 },
  },
  reset(): void {
    this.mode = 'ok';
    this.gate = null;
    this.calls = [];
    this.judgment = { ...fakeJudgment.judgment, model: 'jev-fake' };
  },
  async checkEntry(input: ExperienceCheckInput): Promise<JudgmentOutcome> {
    this.calls.push(input);
    // 一次性闸门（只挡第一次，见上方注释）
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      await gate();
    }
    const request = { questions: {}, state: { content: input.content.slice(0, 2000) } };
    if (this.mode === 'error') {
      return { status: 'error', request, response: { error: 'fake provider error' }, latencyMs: 5 };
    }
    if (this.mode === 'timeout') {
      return {
        status: 'timeout',
        request,
        response: { error: 'fake provider timeout' },
        latencyMs: 8000,
      };
    }
    return {
      status: 'ok',
      judgment: this.judgment as never,
      request,
      response: { normalized: this.judgment, raw: { model: this.judgment.model } },
      latencyMs: 42,
    };
  },
};

/** judgment 限流额度（e2e 默认抬高；限流用例临时改小） */
const fakeJudgmentConfig: JudgmentConfig = {
  provider: 'typesafe',
  baseUrl: 'https://api.typesafe.ai',
  apiKey: 'inline-test-key',
  // typesafe 下 model 是请求参数；**类型标注**让"漏字段"变成编译期 fail-closed
  typesafeModel: 'jev-latest',
  timeoutMs: 8000,
  rateLimitPerHour: 100000,
};

/**
 * 录入限流阈值抬高到 100000：本套件要造 30+ 条条目（同一个 agent actor），默认 30/h
 * 会把后半段测试全部打成 429。阈值在 ExperienceService **构造期**读取（app 引导时），
 * 故此处（模块作用域）设置即可生效；afterAll 复原。真阈值的 429 行为由 service 单测覆盖。
 */
process.env.EXPERIENCE_CREATE_RATE_LIMIT = '100000';

/** 响应信封类型（全局 ResponseInterceptor 包装后的形状） */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
  requestId: string;
}

/** 列表信封 data 形状（只列断言用到的字段） */
interface ListData {
  items: Array<{
    id: string;
    title: string;
    signals: string[];
    domains: string[];
    quality: string;
    expired: boolean;
    distinctHelpedCount: number;
    expiresAt: string | null;
    score?: number;
    signalsMatched?: string[];
    // v1.81.0 归属字段：查询维度（createdById）+ 展示维度（名字/头像/软删）与终审人名字
    createdById?: string;
    createdByType?: string;
    createdByName?: string | null;
    createdByAvatarUrl?: string | null;
    createdByDeletedAt?: string | null;
    verifiedByName?: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  hint?: string;
  appliedFilters?: Record<string, unknown>;
  availableDomains?: string[];
}

/** facets data 形状（v1.81.0：+ byCreator / byCreatorTruncated） */
interface FacetsData {
  total: number;
  byIntent: Record<string, number>;
  byQuality: Record<string, number>;
  availableDomains: string[];
  byCreator?: Array<{
    createdById: string;
    createdByType: string;
    createdByName: string | null;
    createdByDeletedAt: string | null;
    count: number;
  }>;
  byCreatorTruncated?: boolean;
  suspectCount?: number;
  viewerIsReviewer?: boolean;
}

/**
 * 详情 data 形状（v1.81.0：viewer 字段 = 纯角色判定；归属人名字；`viewerReviewBlockReason`
 * **已停发**，故此处刻意**没有**该键——需要负向断言时用 `in` 判键缺席）。
 */
interface DetailData {
  id: string;
  title: string;
  summary: string;
  content: string;
  quality: string;
  signals: string[];
  expired: boolean;
  updatedAt: string;
  verifiedBy: string | null;
  verifiedByName?: string | null;
  verifiedByDeletedAt?: string | null;
  verifiedAt: string | null;
  createdById: string;
  createdByType?: string;
  createdByName?: string | null;
  createdByDeletedAt?: string | null;
  sourceProject: string | null;
  judgment?: unknown;
  judgmentSuppressed?: boolean;
  viewerCanReview?: boolean;
}

/** 反馈 data 形状 */
interface FeedbackData {
  experienceId: string;
  outcome: string;
  helpedCount: number;
  notHelpfulCount: number;
  distinctHelpedCount: number;
  alreadyRecorded?: boolean;
  idempotentReplay?: boolean;
}

/**
 * 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态：方法级 guard 在**声明它的
 * 模块**上下文实例化，其 @InjectRepository 依赖要从那里解析）。
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
class ExperienceE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + 被验证的 ExperienceModule */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    ExperienceE2eAuthModule,
    // AuditService（经验库插桩依赖）注入的 ActorProfileService / OwnerProxyService 分别由
    // @Global() CommonModule / PermissionModule 提供 —— 生产由 AppModule 注册，这里同构
    CommonModule,
    PermissionModule,
    ExperienceModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
})
class ExperienceE2eModule {}

describe('经验库 — 真实 PG + 真实 HTTP 集成（plan §7）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let jwtService: JwtService;
  let service: ExperienceService;
  let dbAvailable = false;

  /** 认证身份（RUN 隔离；afterAll 硬删） */
  let adminUserId: string;
  let adminToken: string;
  let editorUserId: string;
  let editorToken: string;
  let ownerUserId: string;
  let ownerToken: string;
  let strangerUserId: string;
  let strangerToken: string;
  let agentId: string;
  let agentApiKey: string;
  /** 与主 agent **不同 owner** 的独立 agent（历史上用于避开"同 owner 兄弟"，现为无亲缘关系 reviewer） */
  let unrelatedReviewerId: string;
  let unrelatedReviewerApiKey: string;
  /** 并发反馈用的额外 agent（每个 actor 一条反馈才能抬高 distinct 计数） */
  const extraAgents: { agentId: string; apiKey: string }[] = [];

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    experienceIds: [] as string[],
  };

  /** 套件启动时刻（零命中埋点表清理的时间下界） */
  const testStartedAt = new Date();

  // ─── 认证装饰 ───────────────────────────────────────────────────

  /**
   * 给请求挂上认证头。
   *
   * 三种形态（**必须显式区分**）：`'agent'` = 主 agent API Key；`'key:<apiKey>'` = 其它
   * agent 的 API Key（并发反馈需要多个不同 actor）；其余字符串 = 人类 JWT。把 API Key
   * 误当 JWT 发到 Authorization 头会得到 401（本套件踩过）。
   */
  function authed(req: request.Test, auth: 'agent' | string): request.Test {
    if (auth === 'agent') return req.set('X-API-Key', agentApiKey);
    if (auth.startsWith('key:')) return req.set('X-API-Key', auth.slice('key:'.length));
    return req.set('Authorization', `Bearer ${auth}`);
  }

  /** POST /experiences（默认 agent 身份） */
  function createExperience(
    body: Record<string, unknown>,
    auth: 'agent' | string = 'agent',
  ): request.Test {
    return authed(request(app.getHttpServer()).post(`${API_PREFIX}/experiences`), auth).send(body);
  }

  /** 造一条 RUN 隔离的条目载荷（signals/domains/sourceProject 全带 RUN ⇒ 断言互不串味） */
  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: `exp-e2e ${RUN} default title`,
      summary: `summary ${RUN}`,
      content: '## Symptom\nx\n## Root cause\ny\n## Fix\nz\n## How verified\nran twice',
      intent: 'repair',
      signals: [`sig-${RUN}`],
      domains: [`dom-${RUN}`],
      sourceProject: RUN,
      ...overrides,
    };
  }

  /** 建条目并登记待清理 id（失败会显式抛出，避免后续断言建立在空数据上） */
  async function seed(
    overrides: Record<string, unknown> = {},
    auth: 'agent' | string = 'agent',
  ): Promise<string> {
    const res = await createExperience(payload(overrides), auth);
    expect(res.status).toBe(201);
    const id = (res.body as Envelope<{ id: string }>).data.id;
    created.experienceIds.push(id);
    return id;
  }

  /** GET /experiences（列表/检索） */
  function list(query: string, auth: 'agent' | string = 'agent'): request.Test {
    return authed(request(app.getHttpServer()).get(`${API_PREFIX}/experiences?${query}`), auth);
  }

  const detail = (id: string, auth: 'agent' | string = 'agent') =>
    authed(request(app.getHttpServer()).get(`${API_PREFIX}/experiences/${id}`), auth);

  const feedback = (id: string, body: Record<string, unknown>, auth: 'agent' | string = 'agent') =>
    authed(
      request(app.getHttpServer()).post(`${API_PREFIX}/experiences/${id}/feedback`),
      auth,
    ).send(body);

  // ─── 身份构造 ───────────────────────────────────────────────────

  /** 造人类 actor + user 行 */
  async function createHuman(
    role: UserRole,
    seq: number,
    label: string,
  ): Promise<{ userId: string }> {
    const displayName = `Exp ${label} ${RUN} #${seq}`;
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
        username: `experience${RUN}${seq}`.slice(0, 50),
        email: `experience-${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    created.userIds.push(user.id);
    return { userId: user.id };
  }

  /**
   * 取 admin：优先复用库里已有 admin（`idx_unique_admin` 是全局唯一部分索引，重复插入
   * 直接 23505；复用的行不进 created，afterAll 不删）。
   */
  async function resolveAdmin(): Promise<{ userId: string }> {
    const existing = (await ds.query(
      `SELECT u.id AS id FROM users u JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' AND a.status = 'active' AND a.deleted_at IS NULL LIMIT 1`,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return { userId: existing[0].id };
    return createHuman(UserRole.ADMIN, 1, 'Admin');
  }

  /** 造 agent（actor + agents 行 + 真 sha256 key）；ownerUserId 为 null 时自造 owner */
  async function createAgentWithKey(
    seq: number,
    ownerUserIdIn?: string,
  ): Promise<{ agentId: string; apiKey: string }> {
    const owner = ownerUserIdIn ?? (await createHuman(UserRole.EDITOR, seq + 200, 'Owner')).userId;
    const displayName = `Exp Agent ${RUN} #${seq}`;
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
    const rawKey = `ask_${RUN}_${String(seq).padStart(3, '0')}`;
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
      console.warn(`[experience e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    // 表必须在（迁移链产物）——缺表即环境未跑迁移，显式失败而非静默跳过
    // （第二期批 1：3 → 5 表，含双新表 experience_space_members / experience_judgments）
    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('experience_entries','experience_feedback','experience_search_events','experience_space_members','experience_judgments')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'experience_entries',
      'experience_feedback',
      'experience_judgments',
      'experience_search_events',
      'experience_space_members',
    ]);

    // 第二期：judgments 的两条索引与表级 reloptions 在**漂移门禁之外**（后者不比对
    // reloptions，前者虽可比对但基线只保证"与实体一致"）——本套件是它们的行为级守卫。
    // 分页全序索引必须以 DESC 在场：缺它翻页会同刻乱序（漏行/重复），而 SQL 单测测不出。
    const judgmentIndexes = (await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='experience_judgments'
        ORDER BY indexname`,
    )) as { indexname: string; indexdef: string }[];
    const indexNames = judgmentIndexes.map((row) => row.indexname);
    expect(indexNames).toContain('idx_experience_judgments_created_at_id');
    expect(indexNames).toContain('idx_experience_judgments_experience_created_at');
    const fullOrder = judgmentIndexes.find(
      (row) => row.indexname === 'idx_experience_judgments_created_at_id',
    );
    expect(fullOrder?.indexdef).toMatch(/created_at DESC, id DESC/);

    const reloptions = (await ds.query(
      `SELECT reloptions FROM pg_class WHERE relname='experience_judgments'`,
    )) as { reloptions: string[] | null }[];
    expect(reloptions[0]?.reloptions ?? []).toContain('autovacuum_vacuum_scale_factor=0.02');
    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({ imports: [ExperienceE2eModule] })
      // 判别服务换成内存 fake（不联网）——判定的**传输实现**由 typesafe.judgment-provider.spec
      // 用 mock fetch 覆盖；本套件测的是"接线与落库纪律"（真 PG）
      .overrideProvider(JUDGMENT_PROVIDER)
      .useValue(fakeJudgment)
      .overrideProvider(JUDGMENT_CONFIG)
      .useValue(fakeJudgmentConfig)
      .compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 逐字对齐：校验管道 + 全局前缀（响应信封由 APP_INTERCEPTOR 提供）
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    jwtService = app.get(JwtService);
    service = app.get(ExperienceService);

    const admin = await resolveAdmin();
    adminUserId = admin.userId;
    adminToken = jwtService.sign({ sub: adminUserId, role: UserRole.ADMIN });

    const editor = await createHuman(UserRole.EDITOR, 2, 'Editor');
    editorUserId = editor.userId;
    editorToken = jwtService.sign({ sub: editorUserId, role: UserRole.EDITOR });

    const owner = await createHuman(UserRole.EDITOR, 3, 'AgentOwner');
    ownerUserId = owner.userId;
    ownerToken = jwtService.sign({ sub: ownerUserId, role: UserRole.EDITOR });

    const stranger = await createHuman(UserRole.EDITOR, 4, 'Stranger');
    strangerUserId = stranger.userId;
    strangerToken = jwtService.sign({ sub: strangerUserId, role: UserRole.EDITOR });

    const agent = await createAgentWithKey(1, ownerUserId);
    agentId = agent.agentId;
    agentApiKey = agent.apiKey;

    // 并发反馈用：4 个额外 agent（每个不同 actor 才能把 distinct 计数抬起来）
    for (let i = 5; i < 9; i += 1) {
      extraAgents.push(await createAgentWithKey(i, ownerUserId));
    }

    // 独立 owner 的 agent（第二期：终审资格矩阵需要"与作者无亲缘关系"的 reviewer）
    const unrelated = await createAgentWithKey(11);
    unrelatedReviewerId = unrelated.agentId;
    unrelatedReviewerApiKey = unrelated.apiKey;
  }, 120000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();

    // 清理：条目硬删（FK ON DELETE CASCADE 带走反馈行）+ 本套件时段内的埋点行
    if (created.experienceIds.length > 0) {
      await ds.query(`DELETE FROM experience_entries WHERE id = ANY($1::uuid[])`, [
        created.experienceIds,
      ]);
    }
    // 埋点表只有本套件写入（本批新表），用时间下界收口即可
    await ds.query(`DELETE FROM experience_search_events WHERE created_at >= $1`, [testStartedAt]);

    // ── 第二期两新表清理（plan §1.4 明文交付项；**批 1 起就要有**，不等批 2 补）──
    // 两表都**无 FK 不级联**，故不会随上面的 entry/actor 删除自动清掉：
    // ① experience_space_members：**全局授权态**（actor_id 是 PK，不挂条目），残留行会让
    //    后续套件/下一次运行看到"凭空多出的成员"，污染终审判定（批 2 起影响面真实存在）。
    //    按本套件自建 actorIds 精确删（不能按时间窗——成员行没有"本套件时段"语义）。
    // ② experience_judgments：append-only 日志，按测试起始时间窗删（created_at 有
    //    DEFAULT now()，时间下界足够收口；无 FK 故不随条目删除）。
    //    注意：条目**软删 ≠ 日志清除**是产品语义（admin 走 DB 人工窗口）；这里是测试卫生，
    //    与产品保留策略无关。
    if (created.actorIds.length > 0) {
      await ds.query(`DELETE FROM experience_space_members WHERE actor_id = ANY($1::uuid[])`, [
        created.actorIds,
      ]);
    }
    await ds.query(`DELETE FROM experience_judgments WHERE created_at >= $1`, [testStartedAt]);

    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.userIds) await ds.getRepository(User).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
    delete process.env.EXPERIENCE_CREATE_RATE_LIMIT;
  }, 60000);

  // ══════════════════════════════════════════════════════════════════
  // ① CRUD + 幂等重放
  // ══════════════════════════════════════════════════════════════════

  describe('① CRUD + 幂等重放', () => {
    it('录入 → 详情 → 编辑（乐观锁）→ 软删 → 404 全链路', async () => {
      if (!dbAvailable) return;

      const key = `crud-${RUN}`;
      const created_ = await createExperience(
        payload({ clientRequestId: key, title: `crud ${RUN}` }),
      );
      expect(created_.status).toBe(201);
      const createdData = (created_.body as Envelope<{ id: string; quality: string }>).data;
      expect(createdData.quality).toBe('unverified');
      created.experienceIds.push(createdData.id);

      // 幂等重放：同 key 同 payload → 同 id + idempotentReplay，零二次写入
      const replay = await createExperience(
        payload({ clientRequestId: key, title: `crud ${RUN}` }),
      );
      expect(replay.status).toBe(201);
      const replayData = (replay.body as Envelope<{ id: string; idempotentReplay?: boolean }>).data;
      expect(replayData.id).toBe(createdData.id);
      expect(replayData.idempotentReplay).toBe(true);

      // 同 key 不同 payload → 409 / 9002
      const conflict = await createExperience(
        payload({ clientRequestId: key, title: `crud ${RUN} DIFFERENT` }),
      );
      expect(conflict.status).toBe(409);
      expect((conflict.body as { code: number }).code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);

      // 详情含正文全文
      const detailRes = await detail(createdData.id);
      expect(detailRes.status).toBe(200);
      const detailData = (detailRes.body as Envelope<DetailData>).data;
      expect(detailData.content).toContain('## How verified');
      expect(detailData.createdById).toBe(agentId);

      // 编辑：正确乐观锁 → 200；陈旧乐观锁 → 409
      const patched = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${createdData.id}`)
        .set('X-API-Key', agentApiKey)
        .send({ title: `crud ${RUN} patched`, expectedUpdatedAt: detailData.updatedAt });
      expect(patched.status).toBe(200);
      expect((patched.body as Envelope<DetailData>).data.title).toBe(`crud ${RUN} patched`);

      const stale = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${createdData.id}`)
        .set('X-API-Key', agentApiKey)
        .send({ title: 'stale write', expectedUpdatedAt: detailData.updatedAt });
      expect(stale.status).toBe(409);
      expect((stale.body as { code: number }).code).toBe(ErrorCode.RESOURCE_CONFLICT);

      // 软删 → 读写一律 404/13000
      const removed = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/experiences/${createdData.id}`)
        .set('X-API-Key', agentApiKey);
      expect(removed.status).toBe(200);
      expect((removed.body as Envelope<{ deleted: boolean }>).data.deleted).toBe(true);

      const afterDelete = await detail(createdData.id);
      expect(afterDelete.status).toBe(404);
      expect((afterDelete.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_NOT_FOUND);
    });

    it('B1：PATCH 非清空字段传显式 null → **400**（曾直通 service 表现为 500 / env 被静默清空）', async () => {
      if (!dbAvailable) return;
      const id = await seed({
        title: `b1null ${RUN}`,
        signals: [`b1null-${RUN}`],
        env: { os: 'wsl2' },
      });
      const before = (await detail(id)).body as Envelope<DetailData>;

      for (const field of ['title', 'summary', 'content', 'intent', 'signals', 'domains', 'env']) {
        const res = await request(app.getHttpServer())
          .patch(`${API_PREFIX}/experiences/${id}`)
          .set('X-API-Key', agentApiKey)
          .send({ [field]: null, expectedUpdatedAt: before.data.updatedAt });

        // 400（校验拒绝）而非 500（TypeError / NOT NULL 违约）
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain(field);
      }

      // 关键：一次都没落库——env 没有被静默清空、其余字段也原样
      const after = (await detail(id)).body as Envelope<DetailData>;
      expect((after.data as unknown as { env: Record<string, string> }).env).toEqual({
        os: 'wsl2',
      });
      expect(after.data.title).toBe(before.data.title);
      expect(after.data.signals).toEqual(before.data.signals);
      expect(after.data.updatedAt).toBe(before.data.updatedAt);

      // 对照：两个可空字段的 null 仍然放行（清空语义）
      const clears = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({ sourceProject: null, expectedUpdatedAt: before.data.updatedAt });
      expect(clears.status).toBe(200);
      expect((clears.body as Envelope<DetailData>).data.sourceProject).toBeNull();
    });

    it(':id 非 UUID → 400（ParseUUIDPipe，格式错误不过业务层）', async () => {
      if (!dbAvailable) return;
      const res = await detail('not-a-uuid');
      expect(res.status).toBe(400);
      const listRes = await list('page=1', 'agent');
      expect(listRes.status).toBe(200);
    });

    it('客户端自传 quality / createdById → 400（全局 forbidNonWhitelisted）', async () => {
      if (!dbAvailable) return;
      const res = await createExperience(payload({ quality: 'verified' }));
      expect(res.status).toBe(400);
      const res2 = await createExperience(payload({ createdById: adminUserId }));
      expect(res2.status).toBe(400);
    });

    it('B1：疑似重复候选透出真实 id/title/quality（真库 raw-key 形状；曾静默退化成 [{}]）', async () => {
      if (!dbAvailable) return;
      const shared = `dup-shared-${RUN}`;
      const existingId = await seed({
        title: `dup title ${RUN}`,
        summary: `dup summary ${RUN}`,
        signals: [shared],
      });

      // 同 title 再录一条（title trgm 相似度 → 1；signals 也共享一个元素）
      const res = await createExperience(
        payload({
          title: `dup title ${RUN}`,
          summary: `another summary ${RUN}`,
          signals: [shared],
        }),
      );
      expect(res.status).toBe(201);
      const data = (res.body as Envelope<{ id: string; possibleDuplicates?: unknown[] }>).data;
      created.experienceIds.push(data.id);

      const dupes = data.possibleDuplicates as
        | {
            id?: string;
            title?: string;
            quality?: string;
            signalsMatched?: string[];
            titleSimilarity?: number;
          }[]
        | undefined;
      expect(dupes).toBeDefined();
      expect(dupes).toHaveLength(1);
      // shared `ExperienceDuplicateCandidate` 的 id/title/quality **必填**：三者都得是真值
      // （raw-key 形状失真时这里是 undefined，响应会退化成 [{}]）
      expect(dupes?.[0].id).toBe(existingId);
      expect(dupes?.[0].title).toBe(`dup title ${RUN}`);
      expect(dupes?.[0].quality).toBe('unverified');
      // 两条命中路径各自透出可解释字段
      expect(dupes?.[0].signalsMatched).toEqual([shared]);
      expect(dupes?.[0].titleSimilarity).toBeGreaterThan(0.5);

      // 顺带证明它是**软提示**：写入照样成功
      expect((await detail(data.id)).status).toBe(200);
    });

    it('密钥闸门：正文含 password= → 400，且响应不回显密钥', async () => {
      if (!dbAvailable) return;
      const secret = `password=${RUN}supersecret`;
      const res = await createExperience(payload({ content: `## Fix\nDSN: ${secret}` }));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('supersecret');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ② signals 匹配 + 归一化实证
  // ══════════════════════════════════════════════════════════════════

  describe('② signals `&&` overlap + 归一化（真实 SQL）', () => {
    it('写入大写 → 落库小写；小写查询命中；部分关键词（子串）不中', async () => {
      if (!dbAvailable) return;

      const upper = `ECONNREFUSED-${RUN}`.toUpperCase();
      const id = await seed({
        title: `signals ${RUN}`,
        signals: [upper, `Port-Unreachable-${RUN}`],
      });

      const stored = (await detail(id)).body as Envelope<DetailData>;
      expect(stored.data.signals).toEqual([`econnrefused-${RUN}`, `port-unreachable-${RUN}`]);

      // 小写查询命中（读侧同样归一化）
      const lower = await list(`signals=econnrefused-${RUN}`);
      expect(lower.status).toBe(200);
      expect((lower.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);

      // 大小写混合 + 前后空白（URL 编码）同样命中
      const messy = await list(`signals=%20Port-Unreachable-${RUN}%20`);
      expect((messy.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);

      // 子串不算命中（精确相等，不是 substring）——退化成子串匹配会毁掉信号语义
      const substring = await list(`signals=econnrefused`);
      expect((substring.body as Envelope<ListData>).data.items.map((i) => i.id)).not.toContain(id);

      // 未命中的信号 → 零结果 + hint（成功信封）
      const miss = await list(`signals=nope-${RUN}`);
      expect(miss.status).toBe(200);
      const missData = (miss.body as Envelope<ListData>).data;
      expect(missData.total).toBe(0);
      expect(missData.items).toEqual([]);
      expect(missData.hint).toContain('No prior experience matched');
    });

    it('ANY-overlap：共享任一 signal 即命中（加更多 signal 是扩大结果集）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `any ${RUN}`, signals: [`s1-${RUN}`, `s2-${RUN}`] });

      const one = await list(`signals=s1-${RUN}`);
      expect((one.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);

      const two = await list(`signals=s1-${RUN}&signals=s2-${RUN}`);
      const twoData = (two.body as Envelope<ListData>).data;
      expect(twoData.items.map((i) => i.id)).toContain(id);
      // 同一数组内的多值是 OR（命中面 ≥ 单值），不是 AND
      expect(twoData.total).toBeGreaterThanOrEqual(1);
      expect(twoData.appliedFilters?.signals).toEqual([`s1-${RUN}`, `s2-${RUN}`]);
    });

    it('signalsMatched 透出命中原因（可解释性）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `explain ${RUN}`, signals: [`m1-${RUN}`, `m2-${RUN}`] });
      const res = await list(`signals=m1-${RUN}&signals=m2-${RUN}`);
      const item = (res.body as Envelope<ListData>).data.items.find((i) => i.id === id);
      expect(item?.signalsMatched).toEqual([`m1-${RUN}`, `m2-${RUN}`]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ③ 真实 query 串形态（qs 归一陷阱）
  // ══════════════════════════════════════════════════════════════════

  describe('③ 传参协议（真实 query 串形态）', () => {
    it('`signals=a&signals=b`（契约形态）命中', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `form ${RUN}`, signals: [`f1-${RUN}`] });
      const res = await list(`signals=f1-${RUN}&signals=f2-${RUN}`);
      expect(res.status).toBe(200);
      expect((res.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);
    });

    it('`signals[]=` 括号形态 → **明确 400**（不是静默忽略/静默接受）', async () => {
      if (!dbAvailable) return;
      await seed({ title: `bracket ${RUN}`, signals: [`b1-${RUN}`] });

      const res = await list(`signals[]=b1-${RUN}`);
      expect(res.status).toBe(400);
      const message = JSON.stringify(res.body);
      expect(message).toContain('signals[]');
      expect(message).toContain('&signals=');
      expect((res.body as { code: number }).code).toBe(ErrorCode.VALIDATION_ERROR);

      // 对照：同一取值用契约形态是 200（证明差异只来自形态）
      expect((await list(`signals=b1-${RUN}`)).status).toBe(200);
    });

    it('元素含逗号 → 400（一个元素一条症状；不按逗号拆分）', async () => {
      if (!dbAvailable) return;
      const res = await list(`signals=a-${RUN},b-${RUN}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('一个元素一条signal');
    });

    it('数组元素数 / 元素长度上限 → 400（20×50）', async () => {
      if (!dbAvailable) return;
      const tooLong = 'x'.repeat(51);
      expect((await list(`signals=${tooLong}`)).status).toBe(400);
      const many = Array.from({ length: 21 }, (_, i) => `s${i}-${RUN}`)
        .map((s) => `signals=${s}`)
        .join('&');
      expect((await list(many)).status).toBe(400);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ env 四键过滤（`->>` 精确相等 + AND）
  // ══════════════════════════════════════════════════════════════════

  describe('④ env 环境指纹过滤', () => {
    it('四键各自可过滤；大小写归一；不同值不命中；多参数是 AND', async () => {
      if (!dbAvailable) return;
      const id = await seed({
        title: `env ${RUN}`,
        signals: [`env-${RUN}`],
        env: { os: 'WSL2', tool: 'Docker', version: '24.0.7', runtime: 'Node-20' },
      });

      const stored = (await detail(id)).body as Envelope<DetailData>;
      // 值归一化（trim + lowercase）落库
      expect((stored.data as unknown as { env: Record<string, string> }).env).toEqual({
        os: 'wsl2',
        tool: 'docker',
        version: '24.0.7',
        runtime: 'node-20',
      });

      for (const [param, value] of [
        ['envOs', 'wsl2'],
        ['envTool', 'docker'],
        ['envVersion', '24.0.7'],
        ['envRuntime', 'node-20'],
      ] as const) {
        const res = await list(`signals=env-${RUN}&${param}=${value}`);
        expect((res.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);
      }

      // 查询侧同样归一化（大写查询命中）
      const upper = await list(`signals=env-${RUN}&envOs=WSL2`);
      expect((upper.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);

      // 值不符 → 不命中
      const wrong = await list(`signals=env-${RUN}&envTool=podman`);
      expect((wrong.body as Envelope<ListData>).data.items.map((i) => i.id)).not.toContain(id);

      // 多参数 AND：其中一个是错值 → 整体不命中
      const anded = await list(`signals=env-${RUN}&envOs=wsl2&envTool=podman`);
      expect((anded.body as Envelope<ListData>).data.items.map((i) => i.id)).not.toContain(id);
    });

    it('env 键白名单外 → 400 且回显合法键', async () => {
      if (!dbAvailable) return;
      const res = await createExperience(payload({ env: { platform: 'wsl2' } }));
      expect(res.status).toBe(400);
      const message = JSON.stringify(res.body);
      expect(message).toContain('platform');
      for (const key of ['os', 'tool', 'version', 'runtime']) {
        expect(message).toContain(key);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ 中文 q 命中 + 异词汇召回（融合打分的价值证明）
  // ══════════════════════════════════════════════════════════════════

  describe('⑤ 全文融合检索（中文 + 异词汇）', () => {
    it('中文 q 命中（tsvector 通道；simple 配置不切词但 CJK 整串成 token）', async () => {
      if (!dbAvailable) return;
      const id = await seed({
        title: `端口映射失效 ${RUN}`,
        summary: '宿主机访问不到已发布端口',
        content:
          '## Symptom\ncurl 端口无响应\n## Root cause\n端口镜像未生效\n## How verified\n复现两次',
        signals: [`cn-${RUN}`],
      });

      const res = await list(`q=%E7%AB%AF%E5%8F%A3%E6%98%A0%E5%B0%84%E5%A4%B1%E6%95%88`); // 端口映射失效
      expect(res.status).toBe(200);
      const data = (res.body as Envelope<ListData>).data;
      expect(data.items.map((i) => i.id)).toContain(id);
      // 融合分透出（score 字段只在带 q 时出现）
      expect(typeof data.items.find((i) => i.id === id)?.score).toBe('number');
      // q 存在时排序由融合分接管 ⇒ appliedFilters 不回显 sort
      expect(data.appliedFilters?.sort).toBeUndefined();
      expect(data.appliedFilters?.q).toBe('端口映射失效');
    });

    it('异词汇召回：录「端口映射失效」→ 搜「端口不可达」（trgm 通道）', async () => {
      if (!dbAvailable) return;
      // 标题刻意保持**纯 CJK**：pg_trgm 的相似度会被标题里的 ASCII（RUN 后缀）稀释，
      // 而本用例要证明的正是"标题 trigram 重叠足以召回异词汇"（RUN 放 summary 做隔离，
      // summary 不参与打分）
      const id = await seed({
        title: '端口映射失效',
        summary: `宿主机访问不到已发布端口 ${RUN}`,
        content: '## Symptom\ncurl 无响应\n## Fix\n重启 docker-desktop\n## How verified\n复现两次',
        signals: [`vocab-${RUN}`],
      });

      const res = await list(`q=%E7%AB%AF%E5%8F%A3%E4%B8%8D%E5%8F%AF%E8%BE%BE`); // 端口不可达
      const data = (res.body as Envelope<ListData>).data;
      const hit = data.items.find((i) => i.id === id);
      expect(hit).toBeDefined();
      // 融合分透出且高于下限（异词汇召回是 trgm 通道的功劳，不是 tsvector）
      expect(hit?.score).toBeGreaterThan(0.08);
    });

    it('q 是过滤：不相关的条目被排除（低于 SCORE_FLOOR 不进结果集）', async () => {
      if (!dbAvailable) return;
      const unrelated = await seed({
        title: `完全无关主题 ${RUN}`,
        content: '## Symptom\naaa\n## Fix\nbbb\n## How verified\nccc',
        signals: [`unrelated-${RUN}`],
      });

      const res = await list(`q=%E7%AB%AF%E5%8F%A3%E6%98%A0%E5%B0%84%E5%A4%B1%E6%95%88`);
      const data = (res.body as Envelope<ListData>).data;
      expect(data.items.map((i) => i.id)).not.toContain(unrelated);
    });

    it('分数下限实证：q 命中面靠 trgm 通道抬分（单 token ts_rank ≈0.061 < 0.08）', async () => {
      if (!dbAvailable) return;
      // 该条目把标识符只放在 signals 里：ts_rank 通道有匹配（≈0.061）但 title/content
      // 的 trgm 贡献接近 0 ⇒ 融合分低于 0.08 ⇒ **不返回**。这是 plan §2 权重与
      // SCORE_FLOOR 的既定交互（详见本文件头 EXPERIENCE-E2E-FLOOR 踩坑条）。
      // 查询串**刻意不含 RUN**：RUN 是所有条目的公共子串，含它会让每条都靠 trgm 命中，
      // 本用例要孤立的正是"标识符只出现在 signals（→ 只进 search_vector）"这一形态
      const token = `qzzidentifier${Date.now().toString(36)}`;
      const onlyInSignals = await seed({
        title: '纯中文标题',
        // summary 带 RUN 做隔离（summary 不参与打分），title/content **必须完全无 ASCII**：
        // 一旦有 'How verified' 之类英文，trgm 会与 identifier 共享 'ifi'/'fie' trigram
        // （实测把融合分从 0.061 抬到 ≈0.105）→ 本用例的隔离前提就没了
        summary: `没有任何英文标识符出现在标题或正文 ${RUN}`,
        content: '只有中文描述 中文解法 中文验证',
        signals: [token],
      });

      const res = await list(`q=${token}`);
      const ids = (res.body as Envelope<ListData>).data.items.map((i) => i.id);
      expect(ids).not.toContain(onlyInSignals);

      // 对照：同一标识符出现在**标题**里就命中（trgm(title)×0.8 抬过下限）
      const inTitle = await seed({
        title: `${token} 出现在标题`,
        summary: `对照条目 ${RUN}`,
        content: '## How verified\nran twice',
        signals: [`other-${RUN}`],
      });
      const res2 = await list(`q=${token}`);
      expect((res2.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(inTitle);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ 排序 / 分页 / 分面 / 词表
  // ══════════════════════════════════════════════════════════════════

  describe('⑥ 排序与分页稳定性', () => {
    it('most_used 分层：verified 层优先 → distinct_helped_count → updated_at（无 q）', async () => {
      if (!dbAvailable) return;

      const proj = `sort-${RUN}`;
      // A: unverified, 2 个不同 actor 反馈 helped
      const a = await seed({ title: `A ${RUN}`, signals: [`a-${RUN}`], sourceProject: proj });
      await feedback(a, { outcome: 'helped', clientRequestId: `a1-${RUN}` }, 'agent').expect(200);
      await feedback(a, { outcome: 'helped', clientRequestId: `a2-${RUN}` }, editorToken).expect(
        200,
      );

      // B: unverified, 无反馈
      const b = await seed({ title: `B ${RUN}`, signals: [`b-${RUN}`], sourceProject: proj });

      // C: verified（admin 终审），无反馈 —— 必须排在 A 之前（分层优先于计数）
      const c = await seed({ title: `C ${RUN}`, signals: [`c-${RUN}`], sourceProject: proj });
      const reviewed = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${c}/quality`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ quality: 'verified', reason: `e2e ${RUN}` });
      expect(reviewed.status).toBe(200);

      const res = await list(`sourceProject=${proj}&sort=most_used`);
      expect(res.status).toBe(200);
      const ids = (res.body as Envelope<ListData>).data.items.map((i) => i.id);
      expect(ids).toEqual([c, a, b]);
      expect((res.body as Envelope<ListData>).data.appliedFilters?.sort).toBe('most_used');
    });

    it('无 q 分页稳定性：逐页拼接 == 全量顺序（全序排序无漂移）', async () => {
      if (!dbAvailable) return;
      const proj = `page-${RUN}`;
      for (let i = 0; i < 5; i += 1) {
        await seed({ title: `page ${i} ${RUN}`, signals: [`p${i}-${RUN}`], sourceProject: proj });
      }

      const all = (await list(`sourceProject=${proj}&pageSize=100`)).body as Envelope<ListData>;
      expect(all.data.total).toBe(5);

      const paged: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const res = await list(`sourceProject=${proj}&pageSize=2&page=${page}`);
        paged.push(...(res.body as Envelope<ListData>).data.items.map((i) => i.id));
      }
      expect(paged).toEqual(all.data.items.map((i) => i.id));
      expect(new Set(paged).size).toBe(5);
    });

    it('facets：键全量零填充 + availableDomains 词表；非 admin 无 suspectCount、admin 有', async () => {
      if (!dbAvailable) return;
      const domain = `facet-${RUN}`;
      await seed({ title: `facet ${RUN}`, signals: [`facet-${RUN}`], domains: [domain] });

      const asAgent = await authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`),
        'agent',
      );
      expect(asAgent.status).toBe(200);
      const agentFacets = (asAgent.body as Envelope<Record<string, unknown>>).data as {
        total: number;
        byIntent: Record<string, number>;
        byQuality: Record<string, number>;
        availableDomains: string[];
        suspectCount?: number;
      };
      expect(Object.keys(agentFacets.byIntent).sort()).toEqual([
        'decision',
        'howto',
        'optimize',
        'pitfall',
        'repair',
      ]);
      expect(Object.keys(agentFacets.byQuality).sort()).toEqual([
        'suspect',
        'unverified',
        'verified',
      ]);
      expect(agentFacets.availableDomains).toContain(domain);
      expect(agentFacets).not.toHaveProperty('suspectCount');

      const asAdmin = await authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`),
        adminToken,
      );
      expect(asAdmin.status).toBe(200);
      expect(
        (asAdmin.body as Envelope<{ suspectCount?: number }>).data.suspectCount,
      ).toBeGreaterThanOrEqual(0);
    });

    it('facets 路由不被 :id 抢占（facets 声明在 :id 之前）', async () => {
      if (!dbAvailable) return;
      const res = await authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`),
        'agent',
      );
      // 若被 :id 匹配，ParseUUIDPipe 会给 400 —— 200 即证明顺序正确
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑦ 反馈（去重 / 改判 / 并发 / 过期）
  // ══════════════════════════════════════════════════════════════════

  describe('⑦ 反馈计数联动（plan §1.2 不变量）', () => {
    it('新增 helped → 1/0/1；同 key 同 payload 重放零变化；改判三列联动', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `fb ${RUN}`, signals: [`fb-${RUN}`] });

      const first = await feedback(id, { outcome: 'helped', clientRequestId: `fb1-${RUN}` });
      expect(first.status).toBe(200);
      expect((first.body as Envelope<FeedbackData>).data).toMatchObject({
        helpedCount: 1,
        notHelpfulCount: 0,
        distinctHelpedCount: 1,
      });

      // 同 key 同 payload → 重放（零变化）
      const replay = await feedback(id, { outcome: 'helped', clientRequestId: `fb1-${RUN}` });
      expect(replay.status).toBe(200);
      expect((replay.body as Envelope<FeedbackData>).data).toMatchObject({
        helpedCount: 1,
        notHelpfulCount: 0,
        distinctHelpedCount: 1,
        alreadyRecorded: true,
        idempotentReplay: true,
      });

      // 改判（换新 key）→ helped−1 / notHelpful+1 / distinct−1
      const flipped = await feedback(id, { outcome: 'not_helpful', clientRequestId: `fb2-${RUN}` });
      expect(flipped.status).toBe(200);
      expect((flipped.body as Envelope<FeedbackData>).data).toMatchObject({
        helpedCount: 0,
        notHelpfulCount: 1,
        distinctHelpedCount: 0,
        alreadyRecorded: true,
      });

      // 改回 helped（新 key）→ 回到 1/0/1
      const back = await feedback(id, { outcome: 'helped', clientRequestId: `fb3-${RUN}` });
      expect((back.body as Envelope<FeedbackData>).data).toMatchObject({
        helpedCount: 1,
        notHelpfulCount: 0,
        distinctHelpedCount: 1,
      });

      // 库内三列与反馈行一致（不变量：行数 == 计数）
      const [row] = (await ds.query(
        `SELECT helped_count, not_helpful_count, distinct_helped_count FROM experience_entries WHERE id=$1`,
        [id],
      )) as { helped_count: number; not_helpful_count: number; distinct_helped_count: number }[];
      expect(row).toMatchObject({
        helped_count: 1,
        not_helpful_count: 0,
        distinct_helped_count: 1,
      });
      const [{ count }] = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_feedback WHERE experience_id=$1`,
        [id],
      )) as { count: number }[];
      expect(count).toBe(1);
    });

    it('同 key 不同 outcome → 409/9002（勿重试；改判必须换新 key）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `fb-key ${RUN}`, signals: [`fbk-${RUN}`] });
      await feedback(id, { outcome: 'helped', clientRequestId: `same-${RUN}` }).expect(200);
      const conflict = await feedback(id, {
        outcome: 'not_helpful',
        clientRequestId: `same-${RUN}`,
      });
      expect(conflict.status).toBe(409);
      expect((conflict.body as { code: number }).code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);
    });

    it('M1：改判的新 key 落库 → 同 outcome 重发重放、换 outcome 409、用到别的条目 409', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `m1 ${RUN}`, signals: [`m1-${RUN}`] });

      // 首判 helped（key K1），改判 not_helpful（key K2）——K2 必须落库
      await feedback(id, { outcome: 'helped', clientRequestId: `k1-${RUN}` }).expect(200);
      const flipped = await feedback(id, { outcome: 'not_helpful', clientRequestId: `k2-${RUN}` });
      expect(flipped.status).toBe(200);

      const stored = (await ds.query(
        `SELECT outcome, client_request_id FROM experience_feedback WHERE experience_id=$1`,
        [id],
      )) as { outcome: string; client_request_id: string }[];
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ outcome: 'not_helpful', client_request_id: `k2-${RUN}` });

      // ① 改判 key 同 outcome 重发 → 重放（零变化）
      const replay = await feedback(id, { outcome: 'not_helpful', clientRequestId: `k2-${RUN}` });
      expect(replay.status).toBe(200);
      expect((replay.body as Envelope<FeedbackData>).data).toMatchObject({
        alreadyRecorded: true,
        idempotentReplay: true,
        helpedCount: 0,
        notHelpfulCount: 1,
        distinctHelpedCount: 0,
      });

      // ② 改判 key 换 outcome 再发 → 409/9002（不得静默二次改判）
      const conflict = await feedback(id, { outcome: 'helped', clientRequestId: `k2-${RUN}` });
      expect(conflict.status).toBe(409);
      expect((conflict.body as { code: number }).code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);

      // ③ 改判 key 用到另一条目 → 409/9002（键空间不因改判失守）
      const other = await seed({ title: `m1-other ${RUN}`, signals: [`m1o-${RUN}`] });
      const stolen = await feedback(other, { outcome: 'helped', clientRequestId: `k2-${RUN}` });
      expect(stolen.status).toBe(409);
      expect((stolen.body as { code: number }).code).toBe(ErrorCode.IDEMPOTENCY_KEY_CONFLICT);

      // 库内行数与计数不漂移（全程只有一行）
      const [{ count }] = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_feedback WHERE experience_id=$1`,
        [id],
      )) as { count: number }[];
      expect(count).toBe(1);
    });

    it('缺少 clientRequestId → 400（表列 NOT NULL；不允许无键反馈）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `fb-nokey ${RUN}`, signals: [`fbn-${RUN}`] });
      expect((await feedback(id, { outcome: 'helped' })).status).toBe(400);
    });

    it('并发 N 个不同 actor 的反馈 → 计数不丢（distinct == N，行数 == N）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `fb-conc ${RUN}`, signals: [`fbc-${RUN}`] });

      const actors: ('agent' | string)[] = [
        'agent',
        editorToken,
        ownerToken,
        strangerToken,
        ...extraAgents.map((a) => `key:${a.apiKey}`),
      ];
      const results = await Promise.all(
        actors.map((auth, i) =>
          feedback(id, { outcome: 'helped', clientRequestId: `conc-${RUN}-${i}` }, auth),
        ),
      );
      for (const res of results) expect(res.status).toBe(200);

      const [row] = (await ds.query(
        `SELECT helped_count, distinct_helped_count FROM experience_entries WHERE id=$1`,
        [id],
      )) as { helped_count: number; distinct_helped_count: number }[];
      expect(row.helped_count).toBe(actors.length);
      expect(row.distinct_helped_count).toBe(actors.length);
      const [{ count }] = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_feedback WHERE experience_id=$1`,
        [id],
      )) as { count: number }[];
      expect(count).toBe(actors.length);
    });

    it('反馈**不顶** updated_at（否则 sort=recent 会被反馈刷屏）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `fb-ts ${RUN}`, signals: [`fbt-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;
      await feedback(id, { outcome: 'helped', clientRequestId: `ts-${RUN}` }).expect(200);
      const after = (await detail(id)).body as Envelope<DetailData>;
      expect(after.data.updatedAt).toBe(before.data.updatedAt);
    });

    it('过期条目拒绝反馈 → 409，文案指引勿重试', async () => {
      if (!dbAvailable) return;
      const id = await seed({
        title: `fb-expired ${RUN}`,
        signals: [`fbx-${RUN}`],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      // 写入面禁止过去时刻，故直接改库造出"已过期"状态（真实场景：时间流逝）
      await ds.query(
        `UPDATE experience_entries SET expires_at = now() - interval '1 hour' WHERE id=$1`,
        [id],
      );

      const res = await feedback(id, { outcome: 'helped', clientRequestId: `exp-${RUN}` });
      expect(res.status).toBe(409);
      expect((res.body as { code: number }).code).toBe(ErrorCode.RESOURCE_CONFLICT);
      expect(JSON.stringify(res.body)).toContain('Do NOT retry');

      // 过期条目详情仍可见且带 expired 标记（复核动线）
      const d = (await detail(id)).body as Envelope<DetailData>;
      expect(d.data.expired).toBe(true);
    });

    it('默认排除过期条目；includeExpired=true 才可见', async () => {
      if (!dbAvailable) return;
      const id = await seed({
        title: `expired-list ${RUN}`,
        signals: [`expl-${RUN}`],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await ds.query(
        `UPDATE experience_entries SET expires_at = now() - interval '1 hour' WHERE id=$1`,
        [id],
      );

      const excluded = await list(`signals=expl-${RUN}`);
      expect((excluded.body as Envelope<ListData>).data.total).toBe(0);

      const included = await list(`signals=expl-${RUN}&includeExpired=true`);
      const data = (included.body as Envelope<ListData>).data;
      expect(data.items.map((i) => i.id)).toContain(id);
      expect(data.items.find((i) => i.id === id)?.expired).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑧ 质量治理（三身份 + 双向门 + 内容改写回落）
  // ══════════════════════════════════════════════════════════════════

  describe('⑧ 质量终审（角色矩阵；v1.81.0 起为纯角色判定，真 PG）', () => {
    const review = (id: string, auth: 'agent' | string, body: Record<string, unknown>) =>
      authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
        auth,
      ).send(body);

    /** 直接插/删成员行（**仅用于铺场景**；成员端点自身行为由 ⑭ 块的 HTTP 用例覆盖） */
    const seedMemberRow = (actorId: string, role: 'owner' | 'reviewer') =>
      ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, $2)
         ON CONFLICT (actor_id) DO UPDATE SET role = EXCLUDED.role`,
        [actorId, role],
      );
    const dropMemberRow = (actorId: string) =>
      ds.query(`DELETE FROM experience_space_members WHERE actor_id = $1`, [actorId]);

    it('无终审角色：agent API Key / 非 admin JWT → 403/13004；admin → 200', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `review ${RUN}`, signals: [`rv-${RUN}`] });

      const asAgent = await review(id, 'agent', { quality: 'verified', reason: `e2e ${RUN}` });
      expect(asAgent.status).toBe(403);
      expect((asAgent.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);

      const asEditor = await review(id, editorToken, { quality: 'verified', reason: `e2e ${RUN}` });
      expect(asEditor.status).toBe(403);
      expect((asEditor.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);

      const asAdmin = await review(id, adminToken, { quality: 'verified', reason: `e2e ${RUN}` });
      expect(asAdmin.status).toBe(200);
      const data = (
        asAdmin.body as Envelope<{ quality: string; verifiedBy: string; verifiedAt: string }>
      ).data;
      expect(data.quality).toBe('verified');
      expect(data.verifiedBy).toBe(adminUserId);
      expect(data.verifiedAt).toBeTruthy();
    });

    it('空间 reviewer（agent，API Key）→ 200（第二期核心：终审权不再是人类专属）', async () => {
      if (!dbAvailable) return;
      await seedMemberRow(unrelatedReviewerId, 'reviewer');
      try {
        const id = await seed({ title: `rev-agent ${RUN}`, signals: [`ra-${RUN}`] });
        const res = await review(id, `key:${unrelatedReviewerApiKey}`, {
          quality: 'verified',
          reason: `reviewed by space reviewer ${RUN}`,
        });
        expect(res.status).toBe(200);
        const data = (
          res.body as Envelope<{
            quality: string;
            verifiedBy: string;
            verifiedByName: string | null;
          }>
        ).data;
        expect(data.quality).toBe('verified');
        expect(data.verifiedBy).toBe(unrelatedReviewerId);
        // v1.81.0：终审响应带 verifiedByName（调用方不必再发一次详情请求）
        expect(data.verifiedByName).toBeTruthy();
      } finally {
        await dropMemberRow(unrelatedReviewerId);
      }
    });

    it('**admin 审自己录的条目 → 200**（v1.81.0 四态退役核心：旧行为是 403/13002）', async () => {
      if (!dbAvailable) return;
      const ownId = await seed({ title: `self ${RUN}` }, adminToken);
      const res = await review(ownId, adminToken, { quality: 'verified', reason: `self ${RUN}` });
      expect(res.status).toBe(200);
      expect(
        ((res.body as Envelope<{ quality: string }>).data as { quality: string }).quality,
      ).toBe('verified');
    });

    it('**人类 owner 审自己 agent 录的条目 → 200**（旧态 2 的对应位）', async () => {
      if (!dbAvailable) return;
      await seedMemberRow(ownerUserId, 'owner');
      try {
        // agent（本套件主 agent）的 owner 就是 ownerUserId
        const id = await seed({ title: `owner-proxy ${RUN}`, signals: [`op-${RUN}`] });
        const res = await review(id, ownerToken, { quality: 'verified', reason: `proxy ${RUN}` });
        expect(res.status).toBe(200);
      } finally {
        await dropMemberRow(ownerUserId);
      }
    });

    it('**agent 审自己 owner 录的条目 → 200**（旧态 3 的对应位）', async () => {
      if (!dbAvailable) return;
      await seedMemberRow(extraAgents[0].agentId, 'reviewer');
      try {
        // 条目由人类 owner 录入 → createdById = ownerUserId = 该 agent 的 ownerId
        const id = await seed({ title: `own-owner ${RUN}`, signals: [`oo-${RUN}`] }, ownerToken);
        const res = await review(id, `key:${extraAgents[0].apiKey}`, {
          quality: 'verified',
          reason: `state3 ${RUN}`,
        });
        expect(res.status).toBe(200);
      } finally {
        await dropMemberRow(extraAgents[0].agentId);
      }
    });

    it('**同 owner 兄弟 agent 互审 → 200**（旧态 4 的对应位；四态退役的第四态）', async () => {
      if (!dbAvailable) return;
      // extraAgents[1] 与主 agent 同为 ownerUserId 名下 → 兄弟关系
      await seedMemberRow(extraAgents[1].agentId, 'reviewer');
      try {
        const id = await seed({ title: `sibling ${RUN}`, signals: [`sib-${RUN}`] });
        const res = await review(id, `key:${extraAgents[1].apiKey}`, {
          quality: 'verified',
          reason: `state4 ${RUN}`,
        });
        expect(res.status).toBe(200);
      } finally {
        await dropMemberRow(extraAgents[1].agentId);
      }
    });

    it('越权尝试写 denied 审计行（reason=no_review_role；自审不再产生拒绝行）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `deny-audit ${RUN}`, signals: [`da-${RUN}`] });
      await review(id, 'agent', { quality: 'verified', reason: `no-role ${RUN}` });
      const ownId = await seed({ title: `deny-audit-self ${RUN}` }, adminToken);
      // 自审（本人所录）现在**放行**：不得写任何 denied 行
      await review(ownId, adminToken, { quality: 'verified', reason: `self ${RUN}` });

      const rows = (await ds.query(
        `SELECT actor_id, entity_id, new_data FROM audit_logs
          WHERE entity_type = 'experience' AND entity_id = ANY($1::uuid[])
          ORDER BY created_at DESC`,
        [[id, ownId]],
      )) as Array<{ actor_id: string; entity_id: string; new_data: Record<string, unknown> }>;

      const noRole = rows.find((r) => r.entity_id === id);
      expect(noRole?.new_data).toMatchObject({ denied: true, reason: 'no_review_role' });
      // 本人所录条目上**没有任何 denied 行**（旧实现这里是 self_review:self）
      const deniedOnOwn = rows.filter((r) => r.entity_id === ownId && r.new_data.denied === true);
      expect(deniedOnOwn).toHaveLength(0);
    });

    it('双向门：verified → suspect 可改回（suspect 仍可详情读取）；审计留 old→new+reason', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `gate ${RUN}`, signals: [`gate-${RUN}`] });

      await review(id, adminToken, { quality: 'verified', reason: `verify ${RUN}` }).expect(200);
      const toSuspect = await review(id, adminToken, {
        quality: 'suspect',
        reason: `cannot reproduce ${RUN}`,
      });
      expect(toSuspect.status).toBe(200);

      // suspect 默认从检索排除
      const excluded = await list(`signals=gate-${RUN}`);
      expect((excluded.body as Envelope<ListData>).data.total).toBe(0);
      // 显式 quality=suspect 放开排除（复核出口）
      const explicit = await list(`signals=gate-${RUN}&quality=suspect`);
      expect((explicit.body as Envelope<ListData>).data.items.map((i) => i.id)).toContain(id);
      // 详情始终可见（带 quality 标记）
      const d = (await detail(id)).body as Envelope<DetailData>;
      expect(d.data.quality).toBe('suspect');

      // 改回 verified（双向门）
      expect(
        (await review(id, adminToken, { quality: 'verified', reason: `re-verify ${RUN}` })).status,
      ).toBe(200);

      // 审计插桩：old→new + reason 都在
      const rows = (await ds.query(
        `SELECT action, old_data, new_data FROM audit_logs
          WHERE entity_type='experience' AND entity_id=$1 ORDER BY created_at ASC`,
        [id],
      )) as {
        action: string;
        old_data: Record<string, unknown>;
        new_data: Record<string, unknown>;
      }[];
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const last = rows[rows.length - 1];
      expect(last.new_data.reason).toContain(`re-verify ${RUN}`);
      expect(last.old_data).toMatchObject({ quality: 'suspect' });
      expect(last.new_data).toMatchObject({ quality: 'verified' });
    });

    it('M2：先录干净内容再 PATCH 塞凭据 → 400（编辑通道同样受闸门约束）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `m2 ${RUN}`, signals: [`m2-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;

      const patched = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({
          content: `## Fix\nDSN: password=${RUN}topsecret`,
          expectedUpdatedAt: before.data.updatedAt,
        });
      expect(patched.status).toBe(400);
      expect(JSON.stringify(patched.body)).not.toContain('topsecret');

      // 库内正文未被改动（闸门在落库之前拦截）
      const after = (await detail(id)).body as Envelope<DetailData>;
      expect(after.data.content).toBe(before.data.content);
      expect(after.data.updatedAt).toBe(before.data.updatedAt);
    });

    it('m1：facets 也拦下括号数组形态（400，与列表同口径）', async () => {
      if (!dbAvailable) return;
      const res = await authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets?signals[]=a`),
        'agent',
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('signals[]');
      // 对照：契约形态放行
      expect(
        (
          await authed(
            request(app.getHttpServer()).get(
              `${API_PREFIX}/experiences/facets?signals=a&signals=b`,
            ),
            'agent',
          )
        ).status,
      ).toBe(200);
    });

    it('includeSuspect：无终审角色 → 403/13004；空间 reviewer / admin → 200（第二期放宽）', async () => {
      if (!dbAvailable) return;
      const res = await list('includeSuspect=true');
      expect(res.status).toBe(403);
      expect((res.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);

      await ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, 'reviewer')
         ON CONFLICT (actor_id) DO UPDATE SET role = EXCLUDED.role`,
        [unrelatedReviewerId],
      );
      try {
        const asReviewer = await list('includeSuspect=true', `key:${unrelatedReviewerApiKey}`);
        expect(asReviewer.status).toBe(200);
      } finally {
        await ds.query(`DELETE FROM experience_space_members WHERE actor_id = $1`, [
          unrelatedReviewerId,
        ]);
      }

      const asAdmin = await list('includeSuspect=true', adminToken);
      expect(asAdmin.status).toBe(200);
    });

    it('终审后改内容 → quality 回落 unverified 且清 verified_by/at', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `fallback ${RUN}`, signals: [`fb2-${RUN}`] });
      await review(id, adminToken, { quality: 'verified', reason: `verify ${RUN}` }).expect(200);

      const before = (await detail(id)).body as Envelope<DetailData>;
      expect(before.data.quality).toBe('verified');
      expect(before.data.verifiedBy).toBe(adminUserId);

      const patched = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({
          content: '## Fix\nrewritten\n## How verified\nagain',
          expectedUpdatedAt: before.data.updatedAt,
        });
      expect(patched.status).toBe(200);
      const after = (patched.body as Envelope<DetailData>).data;
      expect(after.quality).toBe('unverified');
      expect(after.verifiedBy).toBeNull();
      expect(after.verifiedAt).toBeNull();
    });

    it('M3：并发双写同一 expectedUpdatedAt → 恰一方 200、另一方 409（行锁内复核，无 TOCTOU）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `toctou ${RUN}`, signals: [`tc-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;

      const results = await Promise.all(
        ['A', 'B'].map((suffix) =>
          request(app.getHttpServer())
            .patch(`${API_PREFIX}/experiences/${id}`)
            .set('X-API-Key', agentApiKey)
            .send({ summary: `toctou ${suffix} ${RUN}`, expectedUpdatedAt: before.data.updatedAt }),
        ),
      );
      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      // 事务内 FOR UPDATE 行锁 + 锁内复核 ⇒ 后到者读到新 updatedAt → 409（不是双 200 覆盖）
      expect(statuses).toEqual([200, 409]);

      const after = (await detail(id)).body as Envelope<DetailData>;
      expect([`toctou A ${RUN}`, `toctou B ${RUN}`]).toContain(after.data.summary);
    });

    it('只改元数据（intent）不触发回落', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `metadata ${RUN}`, signals: [`md-${RUN}`] });
      await review(id, adminToken, { quality: 'verified', reason: `verify ${RUN}` }).expect(200);
      const before = (await detail(id)).body as Envelope<DetailData>;

      const patched = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({ intent: 'howto', expectedUpdatedAt: before.data.updatedAt });
      expect(patched.status).toBe(200);
      expect((patched.body as Envelope<DetailData>).data.quality).toBe('verified');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑨ 作者判定与 owner 代理
  // ══════════════════════════════════════════════════════════════════

  describe('⑨ 作者判定（creator / owner 代理 / admin / 越权）', () => {
    it('creator（agent 自己）可改可删', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `author ${RUN}`, signals: [`au-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;
      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({ summary: `updated ${RUN}`, expectedUpdatedAt: before.data.updatedAt });
      expect(res.status).toBe(200);
    });

    it('owner 代理（人类 owner 拥有创建该条目的 agent）可 PATCH / DELETE', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `ownerproxy ${RUN}`, signals: [`op-${RUN}`] });

      const before = (await detail(id)).body as Envelope<DetailData>;
      const patched = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ summary: `owner edit ${RUN}`, expectedUpdatedAt: before.data.updatedAt });
      expect(patched.status).toBe(200);
      expect((patched.body as Envelope<DetailData>).data.id).toBe(id);

      const removed = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/experiences/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(removed.status).toBe(200);
    });

    it('无关人类 → 403/13001 + 越权尝试审计行', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `stranger ${RUN}`, signals: [`st-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;

      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({ summary: 'nope', expectedUpdatedAt: before.data.updatedAt });
      expect(res.status).toBe(403);
      expect((res.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_FORBIDDEN);

      const rows = (await ds.query(
        `SELECT new_data FROM audit_logs
          WHERE entity_type='experience' AND entity_id=$1 AND new_data->>'denied' = 'true'`,
        [id],
      )) as { new_data: Record<string, unknown> }[];
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].new_data).toMatchObject({ denied: true, attempt: 'update' });

      // DELETE 越权同样 403 + 插桩
      const del = await request(app.getHttpServer())
        .delete(`${API_PREFIX}/experiences/${id}`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect(del.status).toBe(403);
    });

    it('admin 可改可删他人条目（不触发 owner 代理查询）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `admin ${RUN}`, signals: [`ad-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;
      const res = await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ summary: `admin edit ${RUN}`, expectedUpdatedAt: before.data.updatedAt });
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑩ 软删口径 + 零命中埋点
  // ══════════════════════════════════════════════════════════════════

  describe('⑩ 软删口径与零命中埋点', () => {
    it('软删后：详情 404 / 列表不计 / facets 不计 / 反馈 404', async () => {
      if (!dbAvailable) return;
      const proj = `softdel-${RUN}`;
      const id = await seed({ title: `soft ${RUN}`, signals: [`sd-${RUN}`], sourceProject: proj });

      const facetsBefore = (
        await authed(request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`), 'agent')
      ).body as Envelope<{ total: number }>;

      await request(app.getHttpServer())
        .delete(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .expect(200);

      expect((await detail(id)).status).toBe(404);
      expect((await list(`sourceProject=${proj}`)).body as Envelope<ListData>).toMatchObject({
        data: { total: 0 },
      });
      const facetsAfter = (
        await authed(request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`), 'agent')
      ).body as Envelope<{ total: number }>;
      expect(facetsAfter.data.total).toBe(facetsBefore.data.total - 1);

      const fb = await feedback(id, { outcome: 'helped', clientRequestId: `sd-${RUN}` });
      expect(fb.status).toBe(404);
    });

    it('零命中埋点：真检索落行（had_results 两态都记）、裸浏览与翻页不记', async () => {
      if (!dbAvailable) return;
      const before = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_search_events WHERE created_at >= $1`,
        [testStartedAt],
      )) as { count: number }[];

      // 零命中检索 → had_results=false
      await list(`signals=definitely-none-${RUN}`);
      // 有结果检索 → had_results=true
      await seed({ title: `instrument ${RUN}`, signals: [`inst-${RUN}`] });
      await list(`signals=inst-${RUN}`);
      // 裸浏览（无 q 无过滤）→ 不记
      await list('pageSize=1');
      // 第 2 页 → 不记
      await list(`signals=inst-${RUN}&page=2`);

      const rows = (await ds.query(
        `SELECT had_results, count(*)::int AS count FROM experience_search_events
          WHERE created_at >= $1 GROUP BY had_results`,
        [testStartedAt],
      )) as { had_results: boolean; count: number }[];
      const after = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_search_events WHERE created_at >= $1`,
        [testStartedAt],
      )) as { count: number }[];

      // 恰好 2 行新增（零命中 1 + 有结果 1；裸浏览与第 2 页被门槛挡掉）
      expect(after[0].count - before[0].count).toBe(2);
      const byFlag = Object.fromEntries(rows.map((r) => [String(r.had_results), r.count]));
      expect(byFlag.true).toBeGreaterThanOrEqual(1);
      expect(byFlag.false).toBeGreaterThanOrEqual(1);
    });

    it('埋点指纹是 hash 而非原文（观测表不做第二个内容泄漏面）', async () => {
      if (!dbAvailable) return;
      await list(`q=${encodeURIComponent(`端口映射失效 ${RUN}`)}`);
      const rows = (await ds.query(
        `SELECT query_hash FROM experience_search_events WHERE created_at >= $1 ORDER BY created_at DESC LIMIT 1`,
        [testStartedAt],
      )) as { query_hash: string }[];
      expect(rows[0].query_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].query_hash).not.toContain('端口');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑪ 漂移门禁盲区守卫：11 条索引 + trigger（plan §7 批 1 评审升级项）
  // ══════════════════════════════════════════════════════════════════

  describe('⑪ 索引与 trigger 在场（漂移门禁结构性盲区的守卫）', () => {
    it('11 条索引逐条 indexdef 断言（4 GIN + 4 env 表达式 + 1 排序部分表达式 + 2 UNIQUE）', async () => {
      if (!dbAvailable) return;
      const rows = (await ds.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename IN ('experience_entries','experience_feedback')`,
      )) as { indexname: string; indexdef: string }[];
      const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));

      // 索引清单本身（少一条即被门禁漏掉的一条真实约束消失）
      const expectedNames = [
        'idx_experience_entries_signals',
        'idx_experience_entries_domains',
        'idx_experience_entries_search_vector',
        'idx_experience_entries_content_trgm',
        'idx_experience_entries_env_os',
        'idx_experience_entries_env_tool',
        'idx_experience_entries_env_version',
        'idx_experience_entries_env_runtime',
        'idx_experience_entries_sort',
        'uq_experience_feedback_experience_actor',
        'uq_experience_feedback_actor_key',
      ];
      for (const name of expectedNames) {
        expect(defs.has(name)).toBe(true);
      }

      // 逐条形态（**纯表达式索引与部分索引对漂移门禁不可见**，只有这里能拦住"被误删/改写"）
      expect(defs.get('idx_experience_entries_signals')).toContain('USING gin (signals)');
      expect(defs.get('idx_experience_entries_domains')).toContain('USING gin (domains)');
      expect(defs.get('idx_experience_entries_search_vector')).toContain(
        'USING gin (search_vector)',
      );
      expect(defs.get('idx_experience_entries_content_trgm')).toContain('gin_trgm_ops');
      expect(defs.get('idx_experience_entries_env_os')).toContain("((env ->> 'os'::text))");
      expect(defs.get('idx_experience_entries_env_tool')).toContain("((env ->> 'tool'::text))");
      expect(defs.get('idx_experience_entries_env_version')).toContain(
        "((env ->> 'version'::text))",
      );
      expect(defs.get('idx_experience_entries_env_runtime')).toContain(
        "((env ->> 'runtime'::text))",
      );
      const sortDef = defs.get('idx_experience_entries_sort') ?? '';
      expect(sortDef).toContain("'verified'::text");
      expect(sortDef).toContain('distinct_helped_count DESC');
      expect(sortDef).toContain('updated_at DESC');
      expect(sortDef).toContain('WHERE (deleted_at IS NULL)');
      expect(defs.get('uq_experience_feedback_experience_actor')).toContain(
        'UNIQUE INDEX uq_experience_feedback_experience_actor',
      );
      expect(defs.get('uq_experience_feedback_actor_key')).toContain(
        'UNIQUE INDEX uq_experience_feedback_actor_key',
      );

      // 三条**不该存在**的索引（误补会增写放大；plan §1.3 明文取舍）
      expect(defs.has('idx_experience_entries_title_trgm')).toBe(false);
      expect(defs.has('idx_experience_entries_summary_trgm')).toBe(false);
      expect(defs.has('idx_experience_entries_content_gin')).toBe(false);
    });

    it('search_vector trigger 在场且函数体逐段 COALESCE（5 段；漏一段 = 该段 NULL 时整行永久不可搜）', async () => {
      if (!dbAvailable) return;

      const triggers = (await ds.query(
        `SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
          WHERE tgrelid = 'experience_entries'::regclass AND NOT tgisinternal`,
      )) as { tgname: string; def: string }[];
      expect(triggers.map((t) => t.tgname)).toContain('trg_experience_entries_search_vector');
      const triggerDef = triggers.find(
        (t) => t.tgname === 'trg_experience_entries_search_vector',
      )!.def;
      expect(triggerDef).toContain('BEFORE INSERT OR UPDATE');
      expect(triggerDef).toContain('FOR EACH ROW');

      const [{ pg_get_functiondef: fnDef }] = (await ds.query(
        `SELECT pg_get_functiondef('maintain_experience_entry_search_vector()'::regprocedure) AS pg_get_functiondef`,
      )) as { pg_get_functiondef: string }[];
      // 5 段 COALESCE（title/summary/signals/domains/content）——段数是这条不变量的全部意义
      expect(fnDef.match(/COALESCE\(/g)?.length).toBe(5);
      expect(fnDef).toContain('to_tsvector');
      expect(fnDef).toContain("'simple'");
    });

    it('trigger 真实生效：更新 signals 后 search_vector 同步（且非内容列更新不重算）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `trigger ${RUN}`, signals: [`tg-${RUN}`] });

      const before = (await ds.query(
        `SELECT search_vector::text AS v FROM experience_entries WHERE id=$1`,
        [id],
      )) as { v: string }[];
      expect(before[0].v).toContain(`tg-${RUN}`);

      // signals 变化触发重算
      const d = (await detail(id)).body as Envelope<DetailData>;
      await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({ signals: [`tg2-${RUN}`], expectedUpdatedAt: d.data.updatedAt })
        .expect(200);
      const after = (await ds.query(
        `SELECT search_vector::text AS v FROM experience_entries WHERE id=$1`,
        [id],
      )) as { v: string }[];
      expect(after[0].v).toContain(`tg2-${RUN}`);
      expect(after[0].v).not.toContain(`tg-${RUN}`);

      // m5：**非内容列**更新（sourceProject）不重算向量——trigger 的 WHEN 只看
      // title/summary/content/signals/domains 五列，元数据列变化不该白跑一次 to_tsvector
      const d2 = (await detail(id)).body as Envelope<DetailData>;
      await request(app.getHttpServer())
        .patch(`${API_PREFIX}/experiences/${id}`)
        .set('X-API-Key', agentApiKey)
        .send({ sourceProject: RUN, expectedUpdatedAt: d2.data.updatedAt })
        .expect(200);
      const afterMeta = (await ds.query(
        `SELECT search_vector::text AS v FROM experience_entries WHERE id=$1`,
        [id],
      )) as { v: string }[];
      expect(afterMeta[0].v).toBe(after[0].v);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑫ migration 往返（事务内 down→up→ROLLBACK，护共享库）
  // ══════════════════════════════════════════════════════════════════

  describe('⑫ migration 往返（自持事务 + ROLLBACK）', () => {
    it('三条经验库迁移 down→up 可往返，且回滚后库状态不变', async () => {
      if (!dbAvailable) return;

      const entriesBefore = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_entries`,
      )) as { count: number }[];
      const judgmentsBefore = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_judgments`,
      )) as { count: number }[];

      const runner = ds.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        // PG 的 DDL 可回滚 ⇒ 真实执行 down/up 的同一份代码，结束后 ROLLBACK 还原一切
        // （逆序：phase2 先下——它含 entries 的 `judgment` 增列与两张新表；
        //   phase1 两条再下，顺序：先 search_events 后 entries）
        await new AddExperiencePhase2_1790200000000().down(runner);
        await new AddExperienceSearchEvents1790100000000().down(runner);
        await new AddExperienceEntries1790000000000().down(runner);

        const dropped = (await runner.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_name LIKE 'experience%'`,
        )) as { table_name: string }[];
        expect(dropped).toHaveLength(0);

        // 正向：phase1 → phase1 → phase2（与迁移链时间戳顺序一致）
        await new AddExperienceEntries1790000000000().up(runner);
        await new AddExperienceSearchEvents1790100000000().up(runner);
        await new AddExperiencePhase2_1790200000000().up(runner);

        const recreated = (await runner.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_name LIKE 'experience%' ORDER BY table_name`,
        )) as { table_name: string }[];
        expect(recreated.map((t) => t.table_name)).toEqual([
          'experience_entries',
          'experience_feedback',
          'experience_judgments',
          'experience_search_events',
          'experience_space_members',
        ]);

        // `judgment` 增列也必须回来（drop→add 往返的真检验；回滚后列不可见 = 迁移有状态泄漏）
        const judgmentCol = (await runner.query(
          `SELECT count(*)::int AS count FROM information_schema.columns
            WHERE table_schema='public' AND table_name='experience_entries' AND column_name='judgment'`,
        )) as { count: number }[];
        expect(judgmentCol[0].count).toBe(1);

        // 重建后的索引与 trigger 也要回来（DDL 幂等性的真检验）
        const idx = (await runner.query(
          `SELECT count(*)::int AS count FROM pg_indexes WHERE tablename = 'experience_entries'`,
        )) as { count: number }[];
        expect(idx[0].count).toBeGreaterThanOrEqual(10);
        const trg = (await runner.query(
          `SELECT count(*)::int AS count FROM pg_trigger
            WHERE tgrelid = 'experience_entries'::regclass AND NOT tgisinternal`,
        )) as { count: number }[];
        expect(trg[0].count).toBe(1);
      } finally {
        // 无论断言是否失败都回滚：**绝不真 revert**（共享开发库里有真实数据）
        await runner.rollbackTransaction();
        await runner.release();
      }

      const entriesAfter = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_entries`,
      )) as { count: number }[];
      expect(entriesAfter[0].count).toBe(entriesBefore[0].count);

      // 新表行数同样不变：往返是**事务内**的（ROLLBACK 后不得留下任何行/结构痕迹）
      const judgmentsAfter = (await ds.query(
        `SELECT count(*)::int AS count FROM experience_judgments`,
      )) as { count: number }[];
      expect(judgmentsAfter[0].count).toBe(judgmentsBefore[0].count);

      // 回滚后服务仍可写（连接与 schema 状态完好）
      await expect(
        seed({ title: `post-rollback ${RUN}`, signals: [`pr-${RUN}`] }),
      ).resolves.toBeTruthy();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑬ 分面/词表与 service 直调（补 service 层的真库口径断言）
  // ══════════════════════════════════════════════════════════════════

  describe('⑬ service 直调补测（真库口径）', () => {
    it('availableDomains 按出现频次降序回显（写入者枚举开放词表的唯一通道）', async () => {
      if (!dbAvailable) return;
      const hot = `hotdom-${RUN}`;
      const cold = `colddom-${RUN}`;
      await seed({ title: `dom a ${RUN}`, signals: [`d1-${RUN}`], domains: [hot] });
      await seed({ title: `dom b ${RUN}`, signals: [`d2-${RUN}`], domains: [hot] });
      await seed({ title: `dom c ${RUN}`, signals: [`d3-${RUN}`], domains: [cold] });

      // 过滤维度**不能是 domains 自身**：词表是与当前结果集同口径的聚合，用 domains=hot
      // 过滤会天然把 cold 排除在外（那不是 bug，是口径）；用 sourceProject 过滤同时纳入两条
      const res = await list(`sourceProject=${RUN}`);
      const data = (res.body as Envelope<ListData>).data;
      expect(data.availableDomains).toContain(hot);
      expect(data.availableDomains).toContain(cold);
      expect(data.availableDomains?.indexOf(hot)).toBeLessThan(
        data.availableDomains?.indexOf(cold) ?? Number.MAX_SAFE_INTEGER,
      );
    });

    it('service.search 直调：suspect 默认排除、quality=suspect 豁免（baseQuery 收口）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `direct ${RUN}`, signals: [`dr-${RUN}`] });
      await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
        adminToken,
      )
        .send({ quality: 'suspect', reason: `e2e ${RUN}` })
        .expect(200);

      const actor = { id: agentId, type: ActorType.AGENT } as const;
      const excluded = await service.search({ signals: [`dr-${RUN}`] } as never, actor as never);
      expect(excluded.total).toBe(0);

      const included = await service.search(
        { signals: [`dr-${RUN}`], quality: 'suspect' } as never,
        actor as never,
      );
      expect(included.items.map((i) => i.id)).toContain(id);
      expect(included.appliedFilters?.quality).toBe('suspect');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑭ 空间成员管理（四端点全链，真 PG）
  // ══════════════════════════════════════════════════════════════════

  describe('⑭ 空间成员管理（GET/POST/PATCH/DELETE 全链）', () => {
    const membersList = (auth: 'agent' | string = 'agent') =>
      authed(request(app.getHttpServer()).get(`${API_PREFIX}/experiences/members`), auth);
    const addMember = (body: Record<string, unknown>, auth: 'agent' | string) =>
      authed(request(app.getHttpServer()).post(`${API_PREFIX}/experiences/members`), auth).send(
        body,
      );
    const patchMember = (actorId: string, body: Record<string, unknown>, auth: 'agent' | string) =>
      authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/members/${actorId}`),
        auth,
      ).send(body);
    const dropMember = (actorId: string, auth: 'agent' | string) =>
      authed(
        request(app.getHttpServer()).delete(`${API_PREFIX}/experiences/members/${actorId}`),
        auth,
      );

    /** 读成员行（直查库，作为 HTTP 响应的独立验证） */
    async function memberRow(
      actorId: string,
    ): Promise<{ role: string; invited_by: string | null } | null> {
      const rows = (await ds.query(
        `SELECT role, invited_by FROM experience_space_members WHERE actor_id = $1`,
        [actorId],
      )) as Array<{ role: string; invited_by: string | null }>;
      return rows[0] ?? null;
    }

    /** 清掉本块铺的行（避免污染后续用例；afterAll 也有兜底） */
    async function cleanupMember(actorId: string): Promise<void> {
      await ds.query(`DELETE FROM experience_space_members WHERE actor_id = $1`, [actorId]);
    }

    it('GET：任何认证身份可读；invitedBy 仅 admin/owner 透出（reviewer/无关身份为 null）', async () => {
      if (!dbAvailable) return;
      const target = extraAgents[2].agentId;
      await addMember({ actorId: target, role: 'reviewer' }, adminToken).expect(201);
      try {
        const asAdmin = await membersList(adminToken);
        expect(asAdmin.status).toBe(200);
        const adminItems = (asAdmin.body as Envelope<{ items: Array<Record<string, unknown>> }>)
          .data.items;
        const adminRow = adminItems.find((m) => m.actorId === target);
        expect(adminRow).toMatchObject({ role: 'reviewer', invitedBy: adminUserId });
        // 档案解析生效（成员行只存 actorId，name/type 来自 ActorProfileService）
        expect(adminRow?.actorType).toBe('agent');

        // 无关身份（主 agent，非成员、非 admin/owner）→ invitedBy 收敛为 null
        const asStranger = await membersList('agent');
        expect(asStranger.status).toBe(200);
        const strangerItems = (
          asStranger.body as Envelope<{ items: Array<Record<string, unknown>> }>
        ).data.items;
        expect(strangerItems.find((m) => m.actorId === target)?.invitedBy).toBeNull();
      } finally {
        await cleanupMember(target);
      }
    });

    it('POST：admin 授权 reviewer → 201 + 落库 + audit CREATE；同角色重发 → 200 幂等；异角色 → 409/13005', async () => {
      if (!dbAvailable) return;
      const target = extraAgents[3].agentId;
      try {
        const first = await addMember({ actorId: target, role: 'reviewer' }, adminToken);
        expect(first.status).toBe(201);
        expect(await memberRow(target)).toMatchObject({
          role: 'reviewer',
          invited_by: adminUserId,
        });

        // 幂等：同角色重发 → **200**（plan §2.2 码表：同角色 200 / 新建 201），不新增行
        const replay = await addMember({ actorId: target, role: 'reviewer' }, adminToken);
        expect(replay.status).toBe(200);
        const count = (await ds.query(
          `SELECT count(*)::int AS c FROM experience_space_members WHERE actor_id = $1`,
          [target],
        )) as Array<{ c: number }>;
        expect(count[0].c).toBe(1);

        // 异角色 → 409/13005 且指引走 PATCH
        const conflict = await addMember({ actorId: target, role: 'owner' }, adminToken);
        expect(conflict.status).toBe(409);
        expect((conflict.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_MEMBER_EXISTS);

        // audit CREATE 行（授权可复盘"谁给谁什么角色"）
        const audits = (await ds.query(
          `SELECT new_data FROM audit_logs
            WHERE entity_type = 'experience_space_member' AND entity_id = $1 AND action = 'create'`,
          [target],
        )) as Array<{ new_data: Record<string, unknown> }>;
        expect(audits.length).toBeGreaterThan(0);
        expect(audits[0].new_data).toMatchObject({ role: 'reviewer', targetActorId: target });
      } finally {
        await cleanupMember(target);
      }
    });

    it('POST：owner 可授 reviewer；授 owner → 403/13004 + denied 审计 + 零写入', async () => {
      if (!dbAvailable) return;
      const ownerRow = extraAgents[2].agentId;
      const target = extraAgents[3].agentId;
      await ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, 'owner')
         ON CONFLICT (actor_id) DO UPDATE SET role = 'owner'`,
        [ownerRow],
      );
      try {
        const grantReviewer = await addMember(
          { actorId: target, role: 'reviewer' },
          `key:${extraAgents[2].apiKey}`,
        );
        expect(grantReviewer.status).toBe(201);
        await cleanupMember(target);

        const grantOwner = await addMember(
          { actorId: target, role: 'owner' },
          `key:${extraAgents[2].apiKey}`,
        );
        expect(grantOwner.status).toBe(403);
        expect((grantOwner.body as { code: number }).code).toBe(
          ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
        );
        expect(await memberRow(target)).toBeNull(); // 零写入

        const denied = (await ds.query(
          `SELECT new_data FROM audit_logs
            WHERE entity_type = 'experience_space_member' AND entity_id = $1`,
          [target],
        )) as Array<{ new_data: Record<string, unknown> }>;
        expect(denied.some((row) => row.new_data?.denied === true)).toBe(true);
      } finally {
        await cleanupMember(ownerRow);
        await cleanupMember(target);
      }
    });

    it('POST：目标 actor 不存在 → 404/AGENT_NOT_FOUND（5000）', async () => {
      if (!dbAvailable) return;
      const ghost = '99999999-9999-4999-8999-999999999999';
      const res = await addMember({ actorId: ghost, role: 'reviewer' }, adminToken);
      expect(res.status).toBe(404);
      expect((res.body as { code: number }).code).toBe(ErrorCode.AGENT_NOT_FOUND);
    });

    it('POST：目标 actorId 非 UUID → 400（DTO 层格式校验，不进业务）', async () => {
      if (!dbAvailable) return;
      const res = await addMember({ actorId: 'not-a-uuid', role: 'reviewer' }, adminToken);
      expect(res.status).toBe(400);
    });

    it('PATCH：admin 改角色（reviewer→owner）→ 200 + old→new 审计；同角色 → 200 no-op', async () => {
      if (!dbAvailable) return;
      const target = extraAgents[3].agentId;
      await ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, 'reviewer')`,
        [target],
      );
      try {
        const promote = await patchMember(target, { role: 'owner' }, adminToken);
        expect(promote.status).toBe(200);
        expect(await memberRow(target)).toMatchObject({ role: 'owner' });

        // 同角色 PATCH → 幂等 no-op（200）
        const noop = await patchMember(target, { role: 'owner' }, adminToken);
        expect(noop.status).toBe(200);

        const audits = (await ds.query(
          `SELECT old_data, new_data FROM audit_logs
            WHERE entity_type = 'experience_space_member' AND entity_id = $1 AND action = 'update'`,
          [target],
        )) as Array<{ old_data: Record<string, unknown>; new_data: Record<string, unknown> }>;
        expect(
          audits.some((row) => row.old_data?.role === 'reviewer' && row.new_data?.role === 'owner'),
        ).toBe(true);
      } finally {
        await cleanupMember(target);
      }
    });

    it('PATCH：owner 双约束——把 reviewer 提成 owner → 403 且角色未变；非成员 → 404/13003', async () => {
      if (!dbAvailable) return;
      const ownerRow = extraAgents[2].agentId;
      const reviewerRow = extraAgents[3].agentId;
      await ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, 'owner'), ($2, 'reviewer')`,
        [ownerRow, reviewerRow],
      );
      try {
        const promote = await patchMember(
          reviewerRow,
          { role: 'owner' },
          `key:${extraAgents[2].apiKey}`,
        );
        expect(promote.status).toBe(403);
        expect((promote.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);
        expect(await memberRow(reviewerRow)).toMatchObject({ role: 'reviewer' }); // 未被改写

        const missing = await patchMember(
          '99999999-9999-4999-8999-999999999999',
          { role: 'reviewer' },
          adminToken,
        );
        expect(missing.status).toBe(404);
        expect((missing.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND);
      } finally {
        await cleanupMember(ownerRow);
        await cleanupMember(reviewerRow);
      }
    });

    it('DELETE：夺权**即时生效**——撤销后该 agent 终审 → 403/13004（真机链路一）', async () => {
      if (!dbAvailable) return;
      const target = unrelatedReviewerId;
      const auth = `key:${unrelatedReviewerApiKey}`;

      // ① 授权 → 可终审
      await addMember({ actorId: target, role: 'reviewer' }, adminToken).expect(201);
      const id = await seed({ title: `revoke-chain ${RUN}`, signals: [`rc-${RUN}`] });
      await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
        auth,
      )
        .send({ quality: 'verified', reason: `before revoke ${RUN}` })
        .expect(200);

      // ② 夺权（物理删）→ 立刻不可终审（无缓存、无软删态）
      const revoked = await dropMember(target, adminToken);
      expect(revoked.status).toBe(200);
      expect(await memberRow(target)).toBeNull();

      const second = await seed({ title: `revoke-chain2 ${RUN}`, signals: [`rc2-${RUN}`] });
      const denied = await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${second}/quality`),
        auth,
      ).send({ quality: 'verified', reason: `after revoke ${RUN}` });
      expect(denied.status).toBe(403);
      expect((denied.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);

      // ③ 非成员再删 → 404/13003
      const again = await dropMember(target, adminToken);
      expect(again.status).toBe(404);
      expect((again.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_MEMBER_NOT_FOUND);

      // 夺权审计（含被夺角色与执行者）
      const audits = (await ds.query(
        `SELECT new_data FROM audit_logs
          WHERE entity_type = 'experience_space_member' AND entity_id = $1 AND action = 'delete'`,
        [target],
      )) as Array<{ new_data: Record<string, unknown> }>;
      expect(audits[0].new_data).toMatchObject({ role: 'reviewer', revokedBy: adminUserId });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑮ 详情 viewer 字段 + 防锚定 suppression（服务端单源）
  // ══════════════════════════════════════════════════════════════════

  describe('⑮ viewer 字段与防锚定 suppression', () => {
    const seedMemberRow = (actorId: string, role: 'owner' | 'reviewer') =>
      ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, $2)
         ON CONFLICT (actor_id) DO UPDATE SET role = EXCLUDED.role`,
        [actorId, role],
      );
    const dropMemberRow = (actorId: string) =>
      ds.query(`DELETE FROM experience_space_members WHERE actor_id = $1`, [actorId]);

    it('viewerCanReview=true（空间 reviewer，非自审）→ judgmentSuppressed=true、judgment=null', async () => {
      if (!dbAvailable) return;
      await seedMemberRow(unrelatedReviewerId, 'reviewer');
      try {
        const id = await seed({ title: `suppress ${RUN}`, signals: [`sp-${RUN}`] });
        const res = await detail(id, `key:${unrelatedReviewerApiKey}`);
        const data = (res.body as Envelope<DetailData>).data;
        expect(data.viewerCanReview).toBe(true);
        // v1.81.0：`viewerReviewBlockReason` 已停发（字段从响应里消失，不是变成 null）
        expect('viewerReviewBlockReason' in (data as unknown as Record<string, unknown>)).toBe(
          false,
        );
        expect(data.judgment).toBeNull();
        expect(data.judgmentSuppressed).toBe(true);
      } finally {
        await dropMemberRow(unrelatedReviewerId);
      }
    });

    it('终审后（quality=verified）→ suppression 解除（可对照）', async () => {
      if (!dbAvailable) return;
      await seedMemberRow(unrelatedReviewerId, 'reviewer');
      try {
        const id = await seed({ title: `suppress-off ${RUN}`, signals: [`so-${RUN}`] });
        await authed(
          request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
          `key:${unrelatedReviewerApiKey}`,
        )
          .send({ quality: 'verified', reason: `verify ${RUN}` })
          .expect(200);

        const data = (
          (await detail(id, `key:${unrelatedReviewerApiKey}`)).body as Envelope<DetailData>
        ).data;
        expect(data.quality).toBe('verified');
        expect(data.viewerCanReview).toBe(true);
        expect(data.judgmentSuppressed).toBe(false);
      } finally {
        await dropMemberRow(unrelatedReviewerId);
      }
    });

    it('无终审角色的读者**不**受 suppression（observe 期数据消费者）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `no-suppress ${RUN}`, signals: [`ns-${RUN}`] });
      const data = ((await detail(id, strangerToken)).body as Envelope<DetailData>).data;
      expect(data.viewerCanReview).toBe(false);
      expect(data.judgmentSuppressed).toBe(false);
    });

    it('viewerCanReview 是**纯角色标记**：作者本人也 true（v1.81.0，旧行为是 false + self）', async () => {
      if (!dbAvailable) return;
      // 主 agent 看自己录的条目，先给它 reviewer 角色
      await seedMemberRow(agentId, 'reviewer');
      // extraAgents[1] 与主 agent 同 owner（旧态 4 的兄弟关系）
      await seedMemberRow(extraAgents[1].agentId, 'reviewer');
      try {
        const own = await seed({ title: `role-flag ${RUN}`, signals: [`rf-${RUN}`] });

        const selfData = ((await detail(own, 'agent')).body as Envelope<DetailData>).data;
        expect(selfData.viewerCanReview).toBe(true);

        const siblingData = (
          (await detail(own, `key:${extraAgents[1].apiKey}`)).body as Envelope<DetailData>
        ).data;
        expect(siblingData.viewerCanReview).toBe(true);

        // 与角色无关的读者仍是 false —— 证明"true"来自角色而不是"任何人对任何条目都 true"
        const strangerData = ((await detail(own, strangerToken)).body as Envelope<DetailData>).data;
        expect(strangerData.viewerCanReview).toBe(false);
      } finally {
        await dropMemberRow(agentId);
        await dropMemberRow(extraAgents[1].agentId);
      }
    });

    it('summary 列表投影带 createdById/createdByType **+ 名字三件套**（v1.81.0）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `summary-proj ${RUN}`, signals: [`spr-${RUN}`] });
      const res = await list(`signals=spr-${RUN}`);
      const item = (res.body as Envelope<ListData>).data.items.find((i) => i.id === id) as
        | Record<string, unknown>
        | undefined;
      expect(item?.createdById).toBe(agentId);
      expect(item?.createdByType).toBe('agent');
      // 展示维度：名字由服务端解析（裸 UUID 不上屏）；未终审 → verifiedByName null
      expect(item?.createdByName).toBe(`Exp Agent ${RUN} #1`);
      expect(item?.createdByDeletedAt).toBeNull();
      expect(item?.verifiedByName).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑯ suspect 粘性（治理修订）+ facets 角标门 + 密钥闸门闭类变体
  // ══════════════════════════════════════════════════════════════════

  describe('⑯ suspect 粘性 / facets 角标门 / 密钥闭类变体（真 PG）', () => {
    const review = (id: string, auth: 'agent' | string, body: Record<string, unknown>) =>
      authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
        auth,
      ).send(body);

    it('suspect 粘性：作者改内容后 suspect **不回落**（只能终审人经双向门解除）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `sticky ${RUN}`, signals: [`st-${RUN}`] });
      await review(id, adminToken, { quality: 'suspect', reason: `suspect ${RUN}` }).expect(200);

      const before = (await detail(id)).body as Envelope<DetailData>;
      const patched = await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}`),
        'agent',
      )
        .send({
          content: '## Symptom\nrewritten\n## Fix\nstill suspect?',
          expectedUpdatedAt: before.data.updatedAt,
        })
        .expect(200);
      const after = (patched.body as Envelope<DetailData>).data;
      expect(after.quality).toBe('suspect'); // 粘性：不回落
      expect(after.verifiedBy).toBe(adminUserId); // 终审留痕保留

      // 终审人仍可解除（双向门）：suspect → verified
      await review(id, adminToken, { quality: 'verified', reason: `cleared ${RUN}` }).expect(200);
      const cleared = (await detail(id)).body as Envelope<DetailData>;
      expect(cleared.data.quality).toBe('verified');
    });

    it('facets 角标门：reviewer → viewerIsReviewer=true + suspectCount；无关身份 → false 且无 suspectCount', async () => {
      if (!dbAvailable) return;
      await ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, 'reviewer')
         ON CONFLICT (actor_id) DO UPDATE SET role = EXCLUDED.role`,
        [unrelatedReviewerId],
      );
      try {
        const asReviewer = await authed(
          request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`),
          `key:${unrelatedReviewerApiKey}`,
        );
        const reviewerData = (
          asReviewer.body as Envelope<{ viewerIsReviewer?: boolean; suspectCount?: number }>
        ).data;
        expect(reviewerData.viewerIsReviewer).toBe(true);
        expect(reviewerData.suspectCount).toBeDefined();
      } finally {
        await ds.query(`DELETE FROM experience_space_members WHERE actor_id = $1`, [
          unrelatedReviewerId,
        ]);
      }

      const asOutsider = await authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`),
        'agent',
      );
      const outsiderData = (
        asOutsider.body as Envelope<{ viewerIsReviewer?: boolean; suspectCount?: number }>
      ).data;
      expect(outsiderData.viewerIsReviewer).toBe(false);
      expect(outsiderData.suspectCount).toBeUndefined();

      const asAdmin = await authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets`),
        adminToken,
      );
      expect((asAdmin.body as Envelope<{ viewerIsReviewer?: boolean }>).data.viewerIsReviewer).toBe(
        true,
      );
    });

    it('密钥闭类闸门（真 PG）：OPENSSH 私钥头 → 400；英文散文负例 → 201 放行', async () => {
      if (!dbAvailable) return;
      // 正例：旧写法（/begin private key/i）漏掉的标准变体
      const blocked = await createExperience(
        payload({
          title: `ssh key ${RUN}`,
          content: '## Fix\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n',
        }),
      );
      expect(blocked.status).toBe(400);
      expect((blocked.body as { code: number }).code).toBe(ErrorCode.VALIDATION_ERROR);

      // 负例：散文里含 "begin ... private key"（v1.1 的 /i 闭类写法会误伤）
      const prose = await createExperience(
        payload({
          title: `prose ${RUN}`,
          content:
            '## Symptom\nBegin by generating a private key pair, then test the rotation flow.\n## Fix\nBegin with a private key file.\n## How verified\nran twice',
        }),
      );
      expect(prose.status).toBe(201);
      const proseId = (prose.body as Envelope<{ id: string }>).data.id;
      created.experienceIds.push(proseId);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑰ 判别服务接线（fake provider + 真 PG）
  //
  // 传输实现由 typesafe.judgment-provider.spec 用 mock fetch 覆盖；本块测**接线与落库纪律**：
  // 日志是事实、快照是缓存、版本守卫、失败置 NULL、幂等重放回填、限流 skipped。
  // ══════════════════════════════════════════════════════════════════

  describe('⑰ 判别服务接线（fake provider）', () => {
    /** 该条目的判断日志行（按落库顺序） */
    const judgmentRows = async (
      experienceId: string,
    ): Promise<
      Array<{
        status: string;
        provider: string;
        model: string | null;
        request: Record<string, unknown>;
        response: Record<string, unknown> | null;
        latency_ms: number | null;
        actor_id: string;
      }>
    > =>
      (await ds.query(
        `SELECT status, provider, model, request, response, latency_ms, actor_id
           FROM experience_judgments WHERE experience_id = $1 ORDER BY created_at ASC, id ASC`,
        [experienceId],
      )) as never;

    /** 条目快照列 + updated_at（判定写绝不能改它） */
    const entrySnapshot = async (
      id: string,
    ): Promise<{ judgment: Record<string, unknown> | null; updated_at: string | Date }> =>
      (
        (await ds.query(`SELECT judgment, updated_at FROM experience_entries WHERE id = $1`, [
          id,
        ])) as Array<{ judgment: Record<string, unknown> | null; updated_at: string | Date }>
      )[0];

    beforeEach(() => {
      fakeJudgment.reset();
      // 限流额度**每个用例复位**：限流用例会临时改小，若只在 afterAll 复位，
      // 后续用例（幂等重放等）会拿到被限流的状态 ⇒ 判定被跳过、快照为空（踩过）
      fakeJudgmentConfig.rateLimitPerHour = 100000;
    });

    it('录入全链：响应带 judgment + 日志行 ok + 快照列写入', async () => {
      if (!dbAvailable) return;
      const res = await createExperience(
        payload({ title: `judge-ok ${RUN}`, signals: [`jo-${RUN}`], clientRequestId: `jo-${RUN}` }),
      );
      expect(res.status).toBe(201);
      const data = (res.body as Envelope<{ id: string; judgment: Record<string, unknown> | null }>)
        .data;
      created.experienceIds.push(data.id);

      // 响应就是判定结果（七维；fake 提供）——含第 7 维准入建议与 rubric 代际（v1.82.0）
      expect(data.judgment).toMatchObject({
        provider: 'jev',
        model: 'jev-fake',
        rubricVersion: 'v2',
        admissionSuggestion: { verdict: 'needs_human', confidence: 0.42 },
      });

      // 日志行：事实源（status/provider/model/request/response/actor 齐备）
      const rows = await judgmentRows(data.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'ok',
        provider: 'jev',
        model: 'jev-fake',
        actor_id: agentId,
      });
      expect(rows[0].latency_ms).toBe(42);
      expect((rows[0].request as { state: { content: string } }).state.content).toContain('##');

      // 快照列也写了（详情读路径的缓存）：第 7 维与 rubric 代际随快照落库
      const snapshot = await entrySnapshot(data.id);
      expect(snapshot.judgment).toMatchObject({
        model: 'jev-fake',
        rubricVersion: 'v2',
        admissionSuggestion: { verdict: 'needs_human', confidence: 0.42 },
      });

      // 详情能读到快照（作者不可审 ⇒ 不触发 suppression）
      const detailData = ((await detail(data.id)).body as Envelope<DetailData>).data;
      expect(detailData.viewerCanReview).toBe(false);
      expect(detailData.judgment).toMatchObject({
        model: 'jev-fake',
        rubricVersion: 'v2',
        admissionSuggestion: { verdict: 'needs_human', confidence: 0.42 },
      });
      expect(detailData.judgmentSuppressed).toBe(false);
    });

    it('fail-open：provider error → 录入仍 201、响应 judgment=null、日志 status=error、快照 NULL', async () => {
      if (!dbAvailable) return;
      fakeJudgment.mode = 'error';
      const res = await createExperience(
        payload({ title: `judge-error ${RUN}`, signals: [`je-${RUN}`] }),
      );
      expect(res.status).toBe(201);
      const data = (res.body as Envelope<{ id: string; judgment: unknown }>).data;
      created.experienceIds.push(data.id);

      expect(data.judgment).toBeNull();
      const rows = await judgmentRows(data.id);
      expect(rows[0]).toMatchObject({ status: 'error' });
      expect((rows[0].response as { error: string }).error).toContain('fake provider error');
      expect((await entrySnapshot(data.id)).judgment).toBeNull();
    });

    it('fail-open：provider 超时 → 日志 status=timeout（与 error 分码，供失败率分母）', async () => {
      if (!dbAvailable) return;
      fakeJudgment.mode = 'timeout';
      const res = await createExperience(
        payload({ title: `judge-timeout ${RUN}`, signals: [`jt-${RUN}`] }),
      );
      const data = (res.body as Envelope<{ id: string }>).data;
      created.experienceIds.push(data.id);
      expect((await judgmentRows(data.id))[0]).toMatchObject({
        status: 'timeout',
        latency_ms: 8000,
      });
    });

    it('内容改写：PATCH 响应 judgment == 库内快照，**updatedAt 不被判定改写**，且 token 立即可复用', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `judge-patch ${RUN}`, signals: [`jp-${RUN}`] });
      const before = (await detail(id)).body as Envelope<DetailData>;

      fakeJudgment.judgment = { ...fakeJudgment.judgment, model: 'jev-fake-v2' } as never;
      const patched = await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}`),
        'agent',
      )
        .send({
          content: '## Symptom\nrewritten for judging\n## How verified\nran twice',
          expectedUpdatedAt: before.data.updatedAt,
        })
        .expect(200);
      const patchedData = (patched.body as Envelope<DetailData>).data;

      const snapshot = await entrySnapshot(id);
      // 响应与库内一致（客户端敢用这个 token 立即再写）
      expect(patchedData.judgment).toEqual(snapshot.judgment);
      expect((patchedData.judgment as { model: string }).model).toBe('jev-fake-v2');
      // 判定写不触碰 updated_at（pg 驱动把 timestamptz 解析成 Date，统一成 ISO 再比）
      expect(new Date(snapshot.updated_at).toISOString()).toBe(patchedData.updatedAt);

      // 立即用同一 token 再 PATCH（不 409）——证明 updatedAt 未被后台判定顶掉
      await authed(request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}`), 'agent')
        .send({ sourceProject: RUN, expectedUpdatedAt: patchedData.updatedAt })
        .expect(200);
    });

    it('内容改写 + 判定失败 → 快照**必须置 NULL**（旧快照描述旧内容）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `judge-null ${RUN}`, signals: [`jn-${RUN}`] });
      expect((await entrySnapshot(id)).judgment).not.toBeNull(); // 先有成功判定的快照

      fakeJudgment.mode = 'error';
      const before = (await detail(id)).body as Envelope<DetailData>;
      await authed(request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}`), 'agent')
        .send({
          content: '## Symptom\nrewritten then judge fails\n## How verified\nx',
          expectedUpdatedAt: before.data.updatedAt,
        })
        .expect(200);

      expect((await entrySnapshot(id)).judgment).toBeNull();
      const rows = await judgmentRows(id);
      expect(rows[rows.length - 1]).toMatchObject({ status: 'error' });
    });

    it('版本守卫：判定在途期间条目被再改 → 旧判定丢弃（快照留新值，日志留两条）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `judge-stale ${RUN}`, signals: [`js-${RUN}`] });

      // 闸门：第一次判定会挂起，等测试放行
      let release: () => void = () => undefined;
      fakeJudgment.gate = () =>
        new Promise<void>((resolve) => {
          release = resolve;
        });
      fakeJudgment.judgment = { ...fakeJudgment.judgment, model: 'jev-stale-first' } as never;

      // ① 第一次 PATCH：事务已提交，判定挂起（updated_at = t1）
      const t1 = ((await detail(id)).body as Envelope<DetailData>).data.updatedAt;
      // ⚠️ 计数基准要先取（seed 自己也会触发一次判定）
      const callsBeforeFirstPatch = fakeJudgment.calls.length;
      const firstPatch = authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}`),
        'agent',
      )
        .send({ content: '## Symptom\nversion one\n## How verified\nx', expectedUpdatedAt: t1 })
        .then((res) => res);

      // 等**本次**判定真的进入（否则下面的第二次改动可能抢在事务提交之前）
      for (let i = 0; i < 150 && fakeJudgment.calls.length === callsBeforeFirstPatch; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fakeJudgment.calls.length).toBe(callsBeforeFirstPatch + 1);

      try {
        // ② 在途期间再改一次（内容 v2 + 新 token）——它的判定不阻塞，先写入快照
        fakeJudgment.judgment = { ...fakeJudgment.judgment, model: 'jev-stale-second' } as never;
        const t2 = ((await detail(id)).body as Envelope<DetailData>).data.updatedAt;
        await authed(request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}`), 'agent')
          .send({ content: '## Symptom\nversion two\n## How verified\ny', expectedUpdatedAt: t2 })
          .expect(200);
      } finally {
        // ③ 无论断言是否失败都要放行第一次判定：否则该请求永远挂起 → afterAll 关不掉 app
        release();
      }

      const firstRes = (await firstPatch).body as Envelope<DetailData>;
      expect(firstRes.data.judgment).toBeNull(); // 响应与库内一致（不报一个库里没有的结论）

      const snapshot = await entrySnapshot(id);
      expect((snapshot.judgment as { model: string }).model).toBe('jev-stale-second');
      const rows = await judgmentRows(id);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it('限流：超额度 → skipped 占位行且**计入额度**（provider 不再被调用；行写入有界）', async () => {
      if (!dbAvailable) return;
      // ⚠️ 用**专用 actor**：额度窗口是进程内共享的（同一 actor 会被前面用例填满），
      // 只有全新 actor 才能确定"第一次真调用、第二次才超限"
      const rateActor = await createAgentWithKey(21, ownerUserId);
      fakeJudgmentConfig.rateLimitPerHour = 1;
      const asRateActor = `key:${rateActor.apiKey}`;

      const first = await createExperience(
        payload({ title: `judge-rate-1 ${RUN}`, signals: [`jr1-${RUN}`] }),
        asRateActor,
      );
      const firstId = (first.body as Envelope<{ id: string }>).data.id;
      created.experienceIds.push(firstId);
      const callsAfterFirst = fakeJudgment.calls.length;

      // 第二次：额度已满 ⇒ 不调用 provider，只写一条 skipped 占位行
      const second = await createExperience(
        payload({ title: `judge-rate-2 ${RUN}`, signals: [`jr2-${RUN}`] }),
        asRateActor,
      );
      const secondId = (second.body as Envelope<{ id: string }>).data.id;
      created.experienceIds.push(secondId);
      expect(fakeJudgment.calls.length).toBe(callsAfterFirst); // 未再调用 provider
      const rows = await judgmentRows(secondId);
      expect(rows[0]).toMatchObject({ status: 'skipped' });
      expect(rows[0].request).toMatchObject({ skipped: true, reason: 'judgment_rate_limited' });
      expect(rows[0].response).toBeNull();

      // P2-5：**每窗口每 actor 至多一条** skipped 行——第三次超限不再落行（行写入有界）
      const third = await createExperience(
        payload({ title: `judge-rate-3 ${RUN}`, signals: [`jr3-${RUN}`] }),
        asRateActor,
      );
      const thirdId = (third.body as Envelope<{ id: string }>).data.id;
      created.experienceIds.push(thirdId);
      expect(fakeJudgment.calls.length).toBe(callsAfterFirst);
      expect(await judgmentRows(thirdId)).toHaveLength(0);
    });

    it('幂等重放：从快照列回填 judgment 且**不重判**', async () => {
      if (!dbAvailable) return;
      const key = `judge-replay-${RUN}`;
      const first = await createExperience(
        payload({ title: `judge-replay ${RUN}`, signals: [`jrp-${RUN}`], clientRequestId: key }),
      );
      const firstData = (first.body as Envelope<{ id: string; judgment: unknown }>).data;
      created.experienceIds.push(firstData.id);
      const callsAfterFirst = fakeJudgment.calls.length;

      // 换掉 fake 的结论：若重放走了重判，响应会变成 v9
      fakeJudgment.judgment = { ...fakeJudgment.judgment, model: 'jev-should-not-run' } as never;
      const replay = await createExperience(
        payload({ title: `judge-replay ${RUN}`, signals: [`jrp-${RUN}`], clientRequestId: key }),
      );
      const replayData = (
        replay.body as Envelope<{
          id: string;
          judgment: { model: string };
          idempotentReplay?: boolean;
        }>
      ).data;

      expect(replayData.idempotentReplay).toBe(true);
      expect(replayData.id).toBe(firstData.id);
      expect(replayData.judgment.model).toBe('jev-fake'); // 首次判定值（从快照列回填）
      expect(fakeJudgment.calls.length).toBe(callsAfterFirst); // 未重判
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑱ 判断日志端点（GET /experiences/judgments）
  // ══════════════════════════════════════════════════════════════════

  describe('⑱ 判断日志端点', () => {
    const judgments = (query: string, auth: 'agent' | string = 'agent') =>
      authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/judgments?${query}`),
        auth,
      );

    const seedMemberRow = (actorId: string) =>
      ds.query(
        `INSERT INTO experience_space_members (actor_id, role) VALUES ($1, 'reviewer')
         ON CONFLICT (actor_id) DO UPDATE SET role = 'reviewer'`,
        [actorId],
      );
    const dropMemberRow = (actorId: string) =>
      ds.query(`DELETE FROM experience_space_members WHERE actor_id = $1`, [actorId]);

    beforeEach(() => fakeJudgment.reset());

    it('判权：作者 agent（非成员）→ 403/13004；空间 reviewer → 200', async () => {
      if (!dbAvailable) return;
      const denied = await judgments('pageSize=1');
      expect(denied.status).toBe(403);
      expect((denied.body as { code: number }).code).toBe(ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN);

      await seedMemberRow(unrelatedReviewerId);
      try {
        const ok = await judgments('pageSize=1', `key:${unrelatedReviewerApiKey}`);
        expect(ok.status).toBe(200);
      } finally {
        await dropMemberRow(unrelatedReviewerId);
      }

      const asAdmin = await judgments('pageSize=1', adminToken);
      expect(asAdmin.status).toBe(200);
    });

    it('过滤词表白名单：未知 status / operation → 400（不静默空页）', async () => {
      if (!dbAvailable) return;
      const badStatus = await judgments('status=definitely_not_a_status', adminToken);
      expect(badStatus.status).toBe(400);
      const badOperation = await judgments('operation=maybe_rerank', adminToken);
      expect(badOperation.status).toBe(400);
    });

    it('分页上限与格式：pageSize=999 → 400；experienceId 非 UUID → 400', async () => {
      if (!dbAvailable) return;
      expect((await judgments('pageSize=999', adminToken)).status).toBe(400);
      expect((await judgments('experienceId=not-a-uuid', adminToken)).status).toBe(400);
    });

    it('experienceId 过滤 + total 自检 + 全序（created_at DESC, id DESC）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `judge-list ${RUN}`, signals: [`jl-${RUN}`] });

      const res = await judgments(`experienceId=${id}&pageSize=50`, adminToken);
      expect(res.status).toBe(200);
      const data = (
        res.body as Envelope<{
          items: Array<{
            experienceId: string;
            status: string;
            operation: string;
            createdAt: string;
          }>;
          total: number;
          page: number;
          pageSize: number;
        }>
      ).data;

      expect(data.total).toBeGreaterThanOrEqual(1);
      expect(data.items.every((item) => item.experienceId === id)).toBe(true);
      expect(data.items[0]).toMatchObject({ status: 'ok', operation: 'record_check' });
      // 全序：同刻多行也按 id DESC 兜底
      const keys = data.items.map((i) => `${i.createdAt}|${(i as { id?: string }).id ?? ''}`);
      expect([...keys].sort().reverse()).toEqual(keys);
    });

    it('status 过滤命中 / 时间窗过滤生效', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `judge-filter ${RUN}`, signals: [`jf-${RUN}`] });

      const okOnly = await judgments(`experienceId=${id}&status=ok`, adminToken);
      expect(
        (okOnly.body as Envelope<{ items: unknown[] }>).data.items.length,
      ).toBeGreaterThanOrEqual(1);
      const skippedOnly = await judgments(`experienceId=${id}&status=skipped`, adminToken);
      expect((skippedOnly.body as Envelope<{ items: unknown[] }>).data.items).toHaveLength(0);

      const future = new Date(Date.now() + 86_400_000).toISOString();
      const windowed = await judgments(`experienceId=${id}&from=${future}`, adminToken);
      expect((windowed.body as Envelope<{ items: unknown[]; total: number }>).data.total).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑲ 归属人投影 + 按录入者检索 + judgments 名字（v1.81.0，真 PG）
  // ══════════════════════════════════════════════════════════════════

  describe('⑲ 归属人名字 / ?createdById / facets.byCreator / judgments.actorName（真 PG）', () => {
    const facetsReq = (query: string, auth: 'agent' | string = 'agent') =>
      authed(request(app.getHttpServer()).get(`${API_PREFIX}/experiences/facets?${query}`), auth);
    const judgmentsReq = (query: string, auth: 'agent' | string = 'agent') =>
      authed(
        request(app.getHttpServer()).get(`${API_PREFIX}/experiences/judgments?${query}`),
        auth,
      );

    it('详情 + 列表：createdByName / verifiedByName 由服务端换名（同一份投影口径）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `names ${RUN}`, signals: [`nm-${RUN}`] });
      // admin 终审（v1.81.0 起允许终审任意条目，含本人所录）
      await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
        adminToken,
      )
        .send({ quality: 'verified', reason: `names ${RUN}` })
        .expect(200);

      const detailData = ((await detail(id)).body as Envelope<DetailData>).data;
      expect(detailData.createdById).toBe(agentId);
      expect(detailData.createdByName).toBe(`Exp Agent ${RUN} #1`);
      expect(detailData.verifiedBy).toBe(adminUserId);
      expect(detailData.verifiedByName).toBeTruthy();

      const item = ((await list(`signals=nm-${RUN}`)).body as Envelope<ListData>).data.items.find(
        (i) => i.id === id,
      );
      expect(item?.createdByName).toBe(`Exp Agent ${RUN} #1`);
      expect(item?.verifiedByName).toBe(detailData.verifiedByName);
    });

    it('软删 actor：createdByName **仍在** + createdByDeletedAt 非空（不回退裸 UUID）', async () => {
      if (!dbAvailable) return;
      const target = extraAgents[3];
      const id = await seed(
        { title: `softdel-creator ${RUN}`, signals: [`sd-${RUN}`] },
        `key:${target.apiKey}`,
      );
      try {
        await ds.query(`UPDATE actors SET deleted_at = now() WHERE id = $1`, [target.agentId]);
        const data = ((await detail(id)).body as Envelope<DetailData>).data;
        // 名字是历史归因：软删不清名，只是多一个删除标记
        expect(data.createdByName).toBe(`Exp Agent ${RUN} #8`);
        expect(data.createdByDeletedAt).toBeTruthy();
      } finally {
        // 复原，避免污染后续用例（软删是 UPDATE 一列，可逆）
        await ds.query(`UPDATE actors SET deleted_at = NULL WHERE id = $1`, [target.agentId]);
      }
    });

    it('?createdById= 精确相等过滤：total 与全部 item 都属于该录入者；回显 appliedFilters', async () => {
      if (!dbAvailable) return;
      const mine = await seed({ title: `by-creator ${RUN} a`, signals: [`bc-${RUN}`] });
      const theirs = await seed(
        { title: `by-creator ${RUN} b`, signals: [`bc-${RUN}`] },
        adminToken,
      );

      const res = await list(`signals=bc-${RUN}&createdById=${agentId}`);
      expect(res.status).toBe(200);
      const data = (res.body as Envelope<ListData>).data;
      expect(data.items.some((i) => i.id === mine)).toBe(true);
      expect(data.items.some((i) => i.id === theirs)).toBe(false);
      expect(data.items.every((i) => i.createdById === agentId)).toBe(true);
      expect(data.appliedFilters).toMatchObject({ createdById: agentId });
    });

    it('?createdById= 非 UUID → 400（DTO 层格式校验，不进业务）', async () => {
      if (!dbAvailable) return;
      const res = await list(`createdById=not-a-uuid`);
      expect(res.status).toBe(400);
    });

    it('facets.byCreator：结构（id/type/name/deletedAt/count）+ byCreatorTruncated 字段在场', async () => {
      if (!dbAvailable) return;
      await seed({ title: `facet-creator ${RUN}`, signals: [`fc-${RUN}`] });

      const data = ((await facetsReq(`signals=fc-${RUN}`)).body as Envelope<FacetsData>).data;
      expect(typeof data.byCreatorTruncated).toBe('boolean');
      expect(Array.isArray(data.byCreator)).toBe(true);
      const row = data.byCreator?.find((c) => c.createdById === agentId);
      expect(row).toMatchObject({
        createdById: agentId,
        createdByType: 'agent',
        createdByName: `Exp Agent ${RUN} #1`,
        createdByDeletedAt: null,
      });
      expect(row?.count).toBeGreaterThanOrEqual(1);
    });

    it('facets.byCreator 与列表口径一致：带 createdById 过滤时该录入者 count 等于列表 total', async () => {
      if (!dbAvailable) return;
      const listData = (
        (await list(`signals=nm-${RUN}&createdById=${agentId}`)).body as Envelope<ListData>
      ).data;
      const facetData = (
        (await facetsReq(`signals=nm-${RUN}&createdById=${agentId}`)).body as Envelope<FacetsData>
      ).data;
      const row = facetData.byCreator?.find((c) => c.createdById === agentId);
      expect(row?.count).toBe(listData.total);
    });

    it('judgments：actorName 由服务端补名（actorId 保留机器可归因）', async () => {
      if (!dbAvailable) return;
      const id = await seed({ title: `judge-name ${RUN}`, signals: [`jn-${RUN}`] });
      await authed(
        request(app.getHttpServer()).patch(`${API_PREFIX}/experiences/${id}/quality`),
        adminToken,
      )
        .send({ quality: 'verified', reason: `jn ${RUN}` })
        .expect(200);

      const data = (
        (await judgmentsReq(`experienceId=${id}&status=ok`, adminToken)).body as Envelope<{
          items: Array<{ actorId: string | null; actorName?: string | null }>;
        }>
      ).data;

      expect(data.items.length).toBeGreaterThanOrEqual(1);
      const row = data.items.find((i) => i.actorId === agentId);
      expect(row).toBeDefined();
      expect(row?.actorName).toBe(`Exp Agent ${RUN} #1`);
    });
  });
});
