/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 接口/MCP 工具调用频率统计（plan rocket-batwoman-booster-gold）：采集 →
 *     UTC 小时桶预聚合 → flush 落库 → admin 查询面 / MCP 上报面
 *
 * [代码职责]
 *   - 十条不变量端到端钉死（plan §4 批 4.1）：同维度累加 / anonymous 同等累加 /
 *     批内去重 / GREATEST / NULLS NOT DISTINCT / 404 不落行 / 上报 202 与自统计排除 /
 *     三 groupBy 与两口径隔离 / UTC 整点桶与路由模板 / migration up-down 往返
 *   - **唯一同时打真实 PG + 真实 HTTP 请求链路的套件**（既有真 PG 套件只直调服务）
 *
 * [权威文档]
 *   - 主文档: docs/api-definition.md §Usage Stats — 端点契约 + 统计口径专章
 *   - 补充: docs/database.md §api_usage_stats_hourly — 表结构/索引/保留策略
 *
 * [关键不变量]（本套件是这些不变量的守门人，改动断言前先想清楚在防什么）
 *   - 同 9 维重复计数必须**累加进同一行**（唯一索引 + ON CONFLICT），否则"调用频率"
 *     退化成"插了多少行"
 *   - `actor_id IS NULL` 的匿名行**同样**受唯一性约束（NULLS NOT DISTINCT）：默认
 *     NULL 语义下同维度会重复插行，且**零报错**（⑤ 断言 indexdef、② 断言行为）
 *   - `actor_type` 列宽必须 ≥ 'anonymous'（9 字符）：PG 对超长 varchar 报 22001 不截断，
 *     一行坏值会让**整批** flush 静默失败（② 同时断言列宽与 flush 返回 failed=false）
 *   - `latency_max_ms` 走 GREATEST（不是覆盖、不是求和）
 *   - 上报端点 `@SkipUsageStats()`：MCP 每次工具调用不得额外产生 `channel=rest` 行
 *   - 窗口是**半开** `[from, to)`：含终点会把未走完的当前小时桶算进来
 *   - `groupBy=tool` 默认口径由端点强制（不靠调用方自觉带 metric），
 *     invocation 行与扇出 REST 行**两口径不串味**
 *
 * [关联代码]
 *   - src/modules/usage-stats/usage-stats.interceptor.ts — REST 采集（finalize + exactly-once）
 *   - src/modules/usage-stats/usage-stats-buffer.service.ts — flush SQL（USAGE_STATS_INSERT_SQL）
 *   - src/modules/usage-stats/api-usage-query.service.ts — 查询面口径隔离与 meta 回显
 *   - src/database/migrations/1789484900000-AddApiUsageStatsHourly.ts — 表与索引定义
 *
 * [持久踩坑]
 *   USAGE-STATS-SUITE-ENV(环境约定): 本套件起**真库 app**，与既有 mock e2e
 *     （createTestingApp 全 override）不同构。安全方向: 数据一律带 RUN 后缀 +
 *     专用 actor 隔离，afterAll 按标记硬删；`USAGE_FLUSH_INTERVAL_MS` 抬高避免
 *     自动 flush 与断言交错。
 *   USAGE-STATS-MIGRATION-DESTRUCTIVE(⑩ 的偏离): 直接 revertLastMigration 会真的
 *     DROP 掉共享开发库的表（并行套件/dev 后端同在）。安全方向: 事务内 down→up→
 *     rollback（PG 的 DDL 可回滚），既验证真 DDL 又不改变库状态。
 *
 * [修改检查]
 *   □ 已读 [权威文档] 与 plan §4 批 4.1 十条，确认断言仍对应同一不变量
 *   □ 已核对 [关键不变量]：断言变松等于护栏失效（尤其 ②/⑤ 两条防"静默不累加"）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

/**
 * 接口/MCP 调用频率统计 —— 真实 PG + 真实 HTTP 集成套件（plan §4 批 4.1）
 *
 * 为什么不是 createTestingApp（既有 mock e2e 惯例）：本功能的全部风险都长在
 * **ORM/SQL/索引语义**上——flush 的 jsonb_to_recordset + ON CONFLICT 累加、
 * `NULLS NOT DISTINCT` 唯一索引、varchar 列宽（22001 静默失败）、
 * `req.route.path` 模板（而非含真实 ID 的 req.path）——mock 仓储与 mock DataSource
 * 对这些**一律测不出**（铁律 #23）。故本套件自建最小 app：
 *
 *   TypeOrmModule.forRoot（真 8744）+ 真 JwtStrategy/ApiKeyAuthService（真 JWT 与
 *   真 sha256 API Key）+ UsageStatsModule（全局采集拦截器）+ main.ts 同款的
 *   全局前缀 `/api/v1` / ValidationPipe / ResponseInterceptor（响应信封）。
 *
 * 另注册一个**仅测试存在**的 probe 控制器（路径带 RUN 后缀）：
 * 让"匿名/agent 身份 × 指定状态码 × 指定路由模板"可确定复现，并给清理一个稳定锚点；
 * 它不进任何生产模块。
 *
 * 环境：本地开发库 chamber-postgres（8744），PG 不可达时整套降级跳过（与既有真 PG
 * 套件一致）。所有测试数据带 RUN 后缀 + 专用 actor（无 FK，按标记硬删兜底）。
 */
import {
  Controller,
  Get,
  Module,
  Param,
  Post,
  Body,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Global, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IsInt } from 'class-validator';
import { Type } from 'class-transformer';
import request = require('supertest');
import * as crypto from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { API_PREFIX, ActorType, AgentStatus, UserRole } from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import {
  ApiUsageStatsHourly,
  API_USAGE_STATS_HOURLY_UNIQUE_KEY,
} from '../src/database/entities/api-usage-stats-hourly.entity';
import { AddApiUsageStatsHourly1789484900000 } from '../src/database/migrations/1789484900000-AddApiUsageStatsHourly';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { UsageStatsModule } from '../src/modules/usage-stats/usage-stats.module';
import {
  USAGE_STATS_INSERT_SQL,
  UsageStatsBufferService,
} from '../src/modules/usage-stats/usage-stats-buffer.service';
import {
  USAGE_STATS_TOOL_METHOD,
  USAGE_STATS_TOOL_ROUTE,
  toUtcHourBucket,
} from '../src/modules/usage-stats/usage-stats.constants';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用的 JWT 密钥（**不读 env**：避免污染同 worker 内其他套件的进程环境） */
const JWT_SECRET = 'usage-stats-e2e-secret';

/** 本次运行的唯一后缀：隔离测试数据（清理范围）与 probe 路由名 */
const RUN = `usg-${Date.now().toString(36)}`;

/** probe 控制器基路径（带 RUN 后缀 → 该套件产生的行都可用 `LIKE '/api/v1/<此值>%'` 收口） */
const PROBE = `usage-probe-${RUN}`;

/** probe 路由模板（`req.route.path` 的字面形态：含全局前缀 + `:param`） */
const PROBE_ANON_ROUTE = `${API_PREFIX}/${PROBE}/anon/:probeId`;
const PROBE_AGENT_ROUTE = `${API_PREFIX}/${PROBE}/agent`;
const PROBE_VALIDATED_ROUTE = `${API_PREFIX}/${PROBE}/validated`;

/**
 * flush 间隔抬高到 1 小时（D10 的 `USAGE_FLUSH_INTERVAL_MS` 注入点）：
 * 本套件只在自己显式 `flush()` 的时点落库，避免定时器与断言交错。
 * 在 app 引导前设置（buffer 构造期读取），afterAll 复原。
 */
process.env.USAGE_FLUSH_INTERVAL_MS = '3600000';

/**
 * probe 控制器的请求体 DTO（只用来触发 ValidationPipe 的 400 分支）。
 * 「DTO 校验 400 会被记为 4xx」是 D1 明写的口径（pipes 在拦截器链**内侧**），
 * 需要一条真实请求才能证明。
 */
class ProbePayloadDto {
  /** 必须是整数：传字符串 → 400（本 DTO 的全部用途） */
  @Type(() => Number)
  @IsInt()
  probeValue: number;
}

/**
 * 仅测试存在的探针控制器（**不属于生产代码**，只在本文的测试模块里注册）。
 *
 * 三个 handler 各自代表一类采集语义：
 * - `anon/:probeId`：无 guard → 未认证身份（actor_type='anonymous'）；
 *   `:probeId` 同时是"route 记模板而非真实 ID"的断言对象；
 * - `validated`：POST + DTO → 校验 400 路径；
 * - `agent`：真 `JwtOrApiKeyGuard` → 真 API Key → `request.agent`（actor_type='agent'
 *   + 可携带 `X-MCP-Tool`/`X-MCP-Surface` 头构造扇出 REST 行）。
 */
@Controller(PROBE)
class UsageProbeController {
  @Get('anon/:probeId')
  anon(@Param('probeId') probeId: string): { probeId: string } {
    return { probeId };
  }

  @Post('validated')
  validated(@Body() body: ProbePayloadDto): { probeValue: number } {
    return { probeValue: body.probeValue };
  }

  @Get('agent')
  @UseGuards(JwtOrApiKeyGuard)
  agent(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * 测试用认证模块（**镜像生产 AuthModule 的 @Global() 形态**）。
 *
 * 为什么必须 @Global()：`@UseGuards(JwtAuthGuard)` 的类级 guard 在
 * **声明 controller 的模块**（UsageStatsModule）上下文里实例化，其构造依赖
 * `ApiKeyAuthService` 必须对该模块可见——生产正是靠 AuthModule 的 @Global() 满足
 * 这一点。若改成普通模块导入，UsageStatsModule 会解析不到依赖而炸。
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
  // `TypeOrmModule` 必须显式导出：forFeature 生成的仓储 provider 默认不外泄，而
  // `@UseGuards(JwtOrApiKeyGuard)` 在本测试根模块上下文实例化，其 @InjectRepository(User)
  // 要从这里解析（生产侧对应 AuthModule 自身的 forFeature + @Global，路径不同但效果一致）
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
class UsageStatsE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + 被验证的 UsageStatsModule + probe 控制器 */
@Module({
  imports: [
    // jwt 命名空间内联提供（等价于生产的 config/jwt.config.ts，但不读 env）
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false, // 库已跑 migration，测试禁改 schema
      migrationsRun: false, // ⑩ 单独验证 migration，不在此处顺带跑
      logging: false,
    }),
    UsageStatsE2eAuthModule,
    UsageStatsModule,
  ],
  controllers: [UsageProbeController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
})
class UsageStatsE2eModule {}

/** 被统计维度集合（断言用；与 flush SQL 的 jsonb 别名一一对应） */
interface UsageRow {
  bucket_start: Date;
  channel: string;
  mcp_surface: string;
  tool_name: string;
  method: string;
  route: string;
  actor_id: string | null;
  actor_type: string;
  status_class: string;
  call_count: number;
  latency_sum_ms: string | number;
  latency_max_ms: number;
}

/** 原始 SQL 执行器（DataSource / QueryRunner 通用） */
type SqlExecutor = { query(sql: string, params?: any[]): Promise<any> };

/** 造行的部分维度（其余按 REST 匿名行默认） */
interface ProbeRowInput {
  route: string;
  method?: string;
  channel?: string;
  toolName?: string;
  mcpSurface?: string;
  actorId?: string | null;
  actorType?: string;
  statusClass?: string;
  bucketStart?: Date;
  callCount?: number;
  latencySumMs?: number;
  latencyMaxMs?: number;
}

/** 构造 flush SQL（jsonb_to_recordset）的一行（字段名 = SQL 内的 AS r(...) 别名） */
function makeFlushRow(row: ProbeRowInput): Record<string, string | number | null> {
  return {
    b: (row.bucketStart ?? toUtcHourBucket(new Date())).toISOString(),
    ch: row.channel ?? 'rest',
    sf: row.mcpSurface ?? '',
    tn: row.toolName ?? '',
    m: row.method ?? 'GET',
    rt: row.route,
    a: row.actorId ?? null,
    at: row.actorType ?? 'anonymous',
    sc: row.statusClass ?? '2xx',
    cc: row.callCount ?? 1,
    ls: row.latencySumMs ?? 1,
    lm: row.latencyMaxMs ?? 1,
  };
}

describe('接口/MCP 调用频率统计 — 真实 PG + 真实 HTTP 集成（plan 批 4.1 十条）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let buffer: UsageStatsBufferService;
  let jwtService: JwtService;
  let dbAvailable = false;

  /** 套件启动时刻（清理的时间下界：只删本次运行产生的行） */
  const testStartedAt = new Date();

  /** 认证与身份（RUN 隔离；afterAll 硬删） */
  let adminUserId: string;
  let adminToken: string;
  let editorUserId: string;
  let editorToken: string;
  let agentId: string;
  let agentDisplayName: string;
  let agentApiKey: string;
  /** 无 actors 行的 actor_id（证明统计行无 FK、可回显 'deleted actor'） */
  const ORPHAN_ACTOR_ID = 'b1a7c3d5-0000-4000-8000-00000000feed';

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
  };

  /** 取 `route` 维度的一组行（精确断言用；按唯一维度值查询） */
  async function selectRows(
    executor: SqlExecutor,
    where: string,
    params: unknown[],
  ): Promise<UsageRow[]> {
    return (await executor.query(
      `SELECT bucket_start, channel, mcp_surface, tool_name, method, route, actor_id,
              actor_type, status_class, call_count, latency_sum_ms, latency_max_ms
         FROM api_usage_stats_hourly WHERE ${where}`,
      params,
    )) as UsageRow[];
  }

  /** 表是否存在（to_regclass 尊重当前事务内的 DDL，⑩ 用） */
  async function tableExists(executor: SqlExecutor): Promise<boolean> {
    const rows = (await executor.query(
      `SELECT to_regclass('api_usage_stats_hourly') AS reg`,
    )) as Array<{ reg: string | null }>;
    return rows[0].reg !== null;
  }

  /** 唯一索引定义（⑤ 的断言对象：NULLS NOT DISTINCT 只能从这里看出来） */
  async function uniqueIndexDef(executor: SqlExecutor): Promise<string> {
    const rows = (await executor.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [
      API_USAGE_STATS_HOURLY_UNIQUE_KEY,
    ])) as Array<{ indexdef: string }>;
    return rows[0]?.indexdef ?? '';
  }

  /** 走 `GET /system/api-usage`（admin JWT），返回信封内的 data */
  async function apiUsage(
    query: Record<string, string | number>,
    token: string = adminToken,
  ): Promise<{ status: number; items: Array<Record<string, any>>; meta: Record<string, any> }> {
    const res = await request(app.getHttpServer())
      .get(`${API_PREFIX}/system/api-usage`)
      .set('Authorization', `Bearer ${token}`)
      .query(query as any);
    return {
      status: res.status,
      items: res.body?.data?.items ?? [],
      meta: res.body?.data?.meta ?? {},
    };
  }

  /**
   * 造人（actor + user 行；JwtStrategy 要求 actor status=active 且未软删）。
   * 返回 userId（= actorId）。
   */
  async function createHuman(
    role: UserRole,
    seq: number,
    label: string,
  ): Promise<{ userId: string; displayName: string }> {
    const displayName = `Usage Stats ${label} ${RUN} #${seq}`;
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
        username: `usagestats${RUN}${seq}`.slice(0, 50),
        email: `usage-stats-${RUN}-${seq}@example.com`,
        authProvider: 'local',
        role,
        preferences: {},
      }),
    );
    created.userIds.push(user.id);
    return { userId: user.id, displayName };
  }

  /**
   * 取 admin 身份：**优先复用库里已有的唯一 admin，没有才新建**。
   *
   * 为什么不能一律新建：`idx_unique_admin` 是 users 表上的**全局唯一部分索引**
   * （`UNIQUE (role) WHERE role='admin'`）——一个库最多一个 admin，重复插入直接
   * 23505。故本套件在已有 admin 的环境（开发库/CI 预置）复用其 user 行，只读用途；
   * 复用的行不进 `created`，afterAll 不删。
   */
  async function resolveAdmin(): Promise<{ userId: string }> {
    const existing = (await ds.query(
      `SELECT u.id AS id
         FROM users u JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' AND a.status = 'active' AND a.deleted_at IS NULL
        LIMIT 1`,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return { userId: existing[0].id };
    const created_ = await createHuman(UserRole.ADMIN, 1, 'Admin');
    return { userId: created_.userId };
  }

  /** 造 agent（actor + agents 行 + 真 sha256 api_key 行），返回 agentId 与明文 key */
  async function createAgentWithKey(seq: number): Promise<{
    agentId: string;
    displayName: string;
    rawKey: string;
  }> {
    const displayName = `Usage Stats Agent ${RUN} #${seq}`;
    const owner = await createHuman(UserRole.EDITOR, seq + 100, 'Owner');
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
        ownerId: owner.userId,
        name: displayName,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    // 真 API Key：guard 走 sha256(key) 查库，故这里必须写真实 hash（不是任意字符串）
    const rawKey = `ask_${RUN}_${String(seq).padStart(3, '0')}`;
    const key = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.userId,
      }),
    );
    created.keyIds.push(key.id);
    return { agentId: agent.id, displayName, rawKey };
  }

  /** 上报一次 MCP invocation（走真实 202 端点 + 真 API Key 认证） */
  async function reportInvocation(body: Record<string, unknown>): Promise<number> {
    const res = await request(app.getHttpServer())
      .post(`${API_PREFIX}/system/usage-events`)
      .set('X-API-Key', agentApiKey)
      .send(body);
    return res.status;
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
      console.warn(`[usage-stats e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({ imports: [UsageStatsE2eModule] }).compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 对齐：校验管道 + 全局前缀 + 响应信封（202 契约的断言对象是信封内 data）
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    buffer = app.get(UsageStatsBufferService);
    jwtService = app.get(JwtService);

    const admin = await resolveAdmin();
    adminUserId = admin.userId;
    adminToken = jwtService.sign({
      sub: adminUserId,
      email: `usage-stats-${RUN}-1@example.com`,
      role: UserRole.ADMIN,
    });
    const editor = await createHuman(UserRole.EDITOR, 2, 'Editor');
    editorUserId = editor.userId;
    editorToken = jwtService.sign({
      sub: editorUserId,
      email: `usage-stats-${RUN}-2@example.com`,
      role: UserRole.EDITOR,
    });

    const agent = await createAgentWithKey(3);
    agentId = agent.agentId;
    agentDisplayName = agent.displayName;
    agentApiKey = agent.rawKey;
  }, 60000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // 先排空 buffer 再关 app（app.close 会触发关停终局 flush；空 buffer → 无操作）
    if (buffer) await buffer.flush().catch(() => undefined);
    if (app) await app.close();

    // 清理（表无 FK，直接 DELETE）三条收口口径，取并集：
    // ① probe 路由标记：本套件独有的路由模板（匿名行、DTO 400 行、窗口行都在此）；
    // ② tool_name 含 RUN：上报行与扇出 REST 行；
    // ③ 本套件 actor 的 `GET /system/api-usage` 行——**带时间下界**：admin 可能是
    //    复用的既有管理员（其历史行属真实数据，不得删）。
    const actorIds = [agentId, adminUserId, editorUserId, ORPHAN_ACTOR_ID];
    await ds.query(
      `DELETE FROM api_usage_stats_hourly
        WHERE route LIKE $1
           OR tool_name LIKE $2
           OR (actor_id = ANY($3::uuid[]) AND route = $4 AND bucket_start >= $5)`,
      [
        `${API_PREFIX}/${PROBE}%`,
        `%${RUN}%`,
        actorIds,
        `${API_PREFIX}/system/api-usage`,
        toUtcHourBucket(testStartedAt),
      ],
    );
    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.userIds) await ds.getRepository(User).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
    delete process.env.USAGE_FLUSH_INTERVAL_MS;
  }, 60000);

  it('① 同维度重复请求 → flush 后恰好 1 行且 call_count 累加（真实请求链路）', async () => {
    if (!dbAvailable) return;

    // 间隔 flush 被抬高到 1h（D10 注入生效）——本套件完全掌控落库时点
    expect(buffer.flushIntervalMs).toBe(3600000);
    expect(buffer.bufferedKeyCount).toBe(0);

    // 3 次真实请求（匿名、同一维度：同 route/method/status/actor）
    for (const probeId of ['p1', 'p2', 'p3']) {
      await request(app.getHttpServer()).get(`${API_PREFIX}/${PROBE}/anon/${probeId}`).expect(200);
    }

    const flushResult = await buffer.flush();
    expect(flushResult.failed).toBe(false);
    expect(buffer.bufferedKeyCount).toBe(0);

    const rows = await selectRows(ds, `route = $1 AND method = $2`, [PROBE_ANON_ROUTE, 'GET']);
    // 3 次请求 → **1 行**（不是 3 行），计数累加在唯一索引上的 ON CONFLICT 分支
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.call_count).toBe(3);
    expect(row.channel).toBe('rest');
    expect(row.method).toBe('GET');
    expect(row.actor_id).toBeNull();
    expect(row.actor_type).toBe('anonymous');
    expect(row.mcp_surface).toBe(''); // 头缺失 = 非 MCP 直连流量（'' 与 'unknown' 语义不同）
    expect(row.tool_name).toBe('');
    expect(row.status_class).toBe('2xx');
    expect(Number(row.latency_sum_ms)).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('② anonymous 维度跨 flush 同样累加（列宽 + NULLS NOT DISTINCT 索引漂移双探测器）', async () => {
    if (!dbAvailable) return;

    // 列宽：'anonymous' 是 9 字符，varchar(8) 会让本批 INSERT 报 22001 而**整批静默失败**
    const widthRows = (await ds.query(
      `SELECT column_name, character_maximum_length AS len
         FROM information_schema.columns
        WHERE table_name = 'api_usage_stats_hourly' AND column_name IN ('actor_type', 'tool_name', 'route')`,
    )) as Array<{ column_name: string; len: number }>;
    const width = new Map(widthRows.map((r) => [r.column_name, Number(r.len)]));
    expect(width.get('actor_type')).toBeGreaterThanOrEqual('anonymous'.length);
    expect(width.get('tool_name')).toBeGreaterThanOrEqual(128);

    // 第一轮：1 次匿名请求 → flush → 1 行 call_count=1
    await request(app.getHttpServer()).get(`${API_PREFIX}/${PROBE}/anon/anon-1`).expect(200);
    const first = await buffer.flush();
    expect(first.failed).toBe(false); // 22001 会让整批失败：这里必须 false 才证明列宽够
    const rowsAfterFirst = await selectRows(ds, `route = $1`, [PROBE_ANON_ROUTE]);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0].call_count).toBe(4); // ① 的 3 次 + 本次 1 次

    // 第二轮：再来 1 次同维度 → flush → **仍 1 行**（call_count 继续累加）
    // 若唯一索引丢了 NULLS NOT DISTINCT：actor_id IS NULL 永不冲突 → 这里会变成 2 行，
    // 且**没有任何报错**（这就是最危险的静默退化）
    await request(app.getHttpServer()).get(`${API_PREFIX}/${PROBE}/anon/anon-2`).expect(200);
    const second = await buffer.flush();
    expect(second.failed).toBe(false);
    const rowsAfterSecond = await selectRows(ds, `route = $1`, [PROBE_ANON_ROUTE]);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0].call_count).toBe(5);
    expect(rowsAfterSecond[0].actor_type).toBe('anonymous');
  }, 30000);

  it('③ 批内同维度多行 flush 不炸 21000（直调 flush SQL 构造同键重复行）', async () => {
    if (!dbAvailable) return;

    // 同一批 JSON 里放两条同维度行：缺 SQL 里的 GROUP BY 批内去重 → 21000
    // "ON CONFLICT DO UPDATE command cannot affect row a second time"。
    // 行顺序**故意反向**（2 在前、3 在后）：SQL 的 ORDER BY 定序还要负责防并发死锁。
    const toolName = `batchedup-${RUN}`;
    const base: ProbeRowInput = {
      route: USAGE_STATS_TOOL_ROUTE,
      method: USAGE_STATS_TOOL_METHOD,
      channel: 'mcp',
      toolName,
      actorId: ORPHAN_ACTOR_ID, // 无 actors 行 → groupBy=actor 回显 'deleted actor'（⑧）
      actorType: 'agent',
      callCount: 2,
      latencyMaxMs: 100,
    };
    await ds.query(USAGE_STATS_INSERT_SQL, [
      JSON.stringify([
        makeFlushRow(base),
        makeFlushRow({ ...base, callCount: 3, latencyMaxMs: 50 }),
      ]),
    ]);

    let rows = await selectRows(ds, `route = $1 AND tool_name = $2`, [
      USAGE_STATS_TOOL_ROUTE,
      toolName,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(5); // 批内 2 + 3（GROUP BY 去重后再累加）
    expect(rows[0].latency_max_ms).toBe(100); // 批内 max()

    // 再打一次同维度（单行）→ 仍 1 行，累加到 6：证明 conflict_target 与唯一索引列严格对齐
    await ds.query(USAGE_STATS_INSERT_SQL, [
      JSON.stringify([makeFlushRow({ ...base, callCount: 1 })]),
    ]);
    rows = await selectRows(ds, `route = $1 AND tool_name = $2`, [
      USAGE_STATS_TOOL_ROUTE,
      toolName,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(6);
  }, 30000);

  it('④ latency_max_ms 走 GREATEST 累加（非覆盖、非求和）', async () => {
    if (!dbAvailable) return;

    // 直调 buffer（D10 的测试入口）：耗时可控——真请求链路的 latency 无法精确指定
    const route = `${API_PREFIX}/${PROBE}/latency`;
    const dims = {
      bucketStart: toUtcHourBucket(new Date()),
      channel: 'rest',
      mcpSurface: '',
      toolName: '',
      method: 'GET',
      route,
      actorId: null,
      actorType: 'anonymous',
    };
    const latencyOf = async (): Promise<{ max: number; sum: number; count: number }> => {
      const rows = await selectRows(ds, `route = $1`, [route]);
      expect(rows).toHaveLength(1);
      return {
        max: rows[0].latency_max_ms,
        sum: Number(rows[0].latency_sum_ms),
        count: rows[0].call_count,
      };
    };

    buffer.recordHttpCall({ ...dims, statusClass: '2xx', latencyMs: 300 });
    await buffer.flush();
    expect(await latencyOf()).toEqual({ max: 300, sum: 300, count: 1 });

    // 更大的耗时 → 覆盖（这正是"峰值"语义）
    buffer.recordHttpCall({ ...dims, statusClass: '2xx', latencyMs: 700 });
    await buffer.flush();
    expect(await latencyOf()).toEqual({ max: 700, sum: 1000, count: 2 });

    // 更小的耗时 → max 保持不变（不是"最后一次"，也不是求和）
    buffer.recordHttpCall({ ...dims, statusClass: '2xx', latencyMs: 200 });
    await buffer.flush();
    expect(await latencyOf()).toEqual({ max: 700, sum: 1200, count: 3 });
  }, 30000);

  it('⑤ 唯一索引 indexdef 含 NULLS NOT DISTINCT 且全 9 列有序 + entity 元数据同名同列', async () => {
    if (!dbAvailable) return;

    const indexdef = await uniqueIndexDef(ds);
    expect(indexdef).toContain('CREATE UNIQUE INDEX');
    expect(indexdef).toContain('NULLS NOT DISTINCT'); // 匿名行累加的唯一保障
    // 列顺序 = flush SQL 的 conflict_target 序 = ORDER BY 定序序（三处必须一致）
    const columns = [
      'bucket_start',
      'channel',
      'mcp_surface',
      'tool_name',
      'method',
      'route',
      'actor_id',
      'actor_type',
      'status_class',
    ];
    expect(indexdef).toContain(`(${columns.join(', ')})`);

    // 二级索引只允许 (actor_id, bucket_start)：为 distinctActors 再加 route 索引是净亏
    const secondary = (await ds.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'api_usage_stats_hourly' AND indexname = 'idx_api_usage_stats_actor_bucket'`,
    )) as Array<{ indexdef: string }>;
    expect(secondary).toHaveLength(1);
    expect(secondary[0].indexdef).toContain('(actor_id, bucket_start)');

    // 表级 autovacuum 收紧（月度删 ~94 万死元组低于默认 0.2 阈值 → 不收紧就长期膨胀）
    const reloptions = (await ds.query(
      `SELECT reloptions FROM pg_class WHERE relname = 'api_usage_stats_hourly'`,
    )) as Array<{ reloptions: string[] | null }>;
    expect(reloptions[0].reloptions ?? []).toContain('autovacuum_vacuum_scale_factor=0.02');

    // entity 侧护栏：TypeORM 0.3.30 不认识 NULLS NOT DISTINCT，按名匹配不到就会在
    // migration:generate 时**静默 DROP** 本索引（后果 = 同维度不再累加）。实体必须
    // 同名同列显式声明 @Index，这里直接核对元数据→DB 索引的列名与顺序。
    const metadata = ds
      .getMetadata(ApiUsageStatsHourly)
      .indices.find((index) => index.name === API_USAGE_STATS_HOURLY_UNIQUE_KEY);
    expect(metadata).toBeDefined();
    expect(metadata?.isUnique).toBe(true);
    expect(metadata?.columns.map((column) => column.databaseName)).toEqual(columns);
  }, 30000);

  it('⑥ 未匹配路由 404 不落行；DTO 校验 400 落行（D1：guard 短路不记 ≠ 校验错不记）', async () => {
    if (!dbAvailable) return;

    const before = (await selectRows(ds, `route LIKE $1`, [`${API_PREFIX}/${PROBE}%`])).length;

    // ① 未匹配路由：Nest 在拦到 handler 之前即 404 → 采集拦截器根本不会执行
    await request(app.getHttpServer()).get(`${API_PREFIX}/${PROBE}/definitely-missing`).expect(404);
    // ② 校验失败：pipes 在拦截器链**内侧**，异常沿 observable 传出 → 记为 4xx
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/${PROBE}/validated`)
      .send({ probeValue: 'not-an-int' })
      .expect(400);

    const flushResult = await buffer.flush();
    expect(flushResult.failed).toBe(false);

    // 404 不落行
    const notFoundRows = await selectRows(ds, `route LIKE $1`, ['%definitely-missing%']);
    expect(notFoundRows).toHaveLength(0);

    // 400 落行，且 status_class 归 4xx
    const badRequestRows = await selectRows(ds, `route = $1`, [PROBE_VALIDATED_ROUTE]);
    expect(badRequestRows).toHaveLength(1);
    expect(badRequestRows[0].status_class).toBe('4xx');
    expect(badRequestRows[0].call_count).toBe(1);

    // 本轮新增行恰好 1 条（= 那条 400 行；404 与 guard 短路都不进统计）
    const after = (await selectRows(ds, `route LIKE $1`, [`${API_PREFIX}/${PROBE}%`])).length;
    expect(after - before).toBe(1);
  }, 30000);

  it('⑦ 上报端点连报两次 → 1 行 invocation（call_count=2）+ viaFallbackAuth→system，且拦截器不自统计', async () => {
    if (!dbAvailable) return;

    const toolName = `report-${RUN}`;
    const payload = { toolName, surface: 'mcp', ok: true, latencyMs: 42 };

    // 202 契约：受理 ≠ 已落库（落库由 flush 决定），调用方 fire-and-forget
    const first = await request(app.getHttpServer())
      .post(`${API_PREFIX}/system/usage-events`)
      .set('X-API-Key', agentApiKey)
      .send(payload);
    expect(first.status).toBe(202);
    expect(first.body.data).toEqual({ accepted: true });
    expect(await reportInvocation(payload)).toBe(202);

    // 未认证上报 → 401（guard 短路，不落行——下面一并断言）
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/system/usage-events`)
      .send(payload)
      .expect(401);

    // 非法载荷 → 400（DTO 词表/长度/数值边界，铁律 #21 第一层）
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/system/usage-events`)
      .set('X-API-Key', agentApiKey)
      .send({ ...payload, surface: 'not-a-surface' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`${API_PREFIX}/system/usage-events`)
      .set('X-API-Key', agentApiKey)
      .send({ ...payload, latencyMs: -1 })
      .expect(400);
    // 失败态上报（ok=false）→ 5xx 行；viaFallbackAuth（共享 --api-key）→ actor_type='system'
    const fallbackTool = `fallback-${RUN}`;
    expect(
      await reportInvocation({
        toolName: fallbackTool,
        surface: 'unknown',
        ok: false,
        latencyMs: 7,
        viaFallbackAuth: true,
      }),
    ).toBe(202);

    const flushResult = await buffer.flush();
    expect(flushResult.failed).toBe(false);

    // 两次上报 → 1 行（route='mcp://tools/call' + method='TOOL' 的行形状由 buffer 钉死）
    const rows = await selectRows(ds, `route = $1 AND tool_name = $2`, [
      USAGE_STATS_TOOL_ROUTE,
      toolName,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].call_count).toBe(2);
    expect(rows[0].channel).toBe('mcp');
    expect(rows[0].method).toBe(USAGE_STATS_TOOL_METHOD);
    expect(rows[0].mcp_surface).toBe('mcp');
    expect(rows[0].actor_id).toBe(agentId); // 上报方身份（API Key → request.agent）
    expect(rows[0].actor_type).toBe('agent');
    expect(rows[0].status_class).toBe('2xx'); // ok=true → 2xx
    expect(Number(rows[0].latency_sum_ms)).toBe(84);
    expect(rows[0].latency_max_ms).toBe(42);

    // 拦截器不自统计：上报端点自身（含 401/400 两次失败调用）不得产生 channel=rest 行
    const selfRows = await selectRows(ds, `route = $1`, [`${API_PREFIX}/system/usage-events`]);
    expect(selfRows).toHaveLength(0);

    // viaFallbackAuth=true → actor_type='system'（"身份不可信"归因标记，'system' 的唯一生产者）；
    // 同时 ok=false 的失败态落 5xx（上报只有成败两态，无 HTTP 状态可继承）
    const fallbackRows = await selectRows(ds, `tool_name = $1`, [fallbackTool]);
    expect(fallbackRows).toHaveLength(1);
    expect(fallbackRows[0].actor_type).toBe('system');
    expect(fallbackRows[0].status_class).toBe('5xx');
    expect(fallbackRows[0].route).toBe(USAGE_STATS_TOOL_ROUTE);
    expect(fallbackRows[0].method).toBe(USAGE_STATS_TOOL_METHOD);
  }, 30000);

  it('⑧ 三个 groupBy 各出数 + 两口径不串味 + sortBy 枚举 400 + 非 admin 403', async () => {
    if (!dbAvailable) return;

    const dualTool = `dual-${RUN}`;
    // 同一工具名同时出现在两个口径里：invocation 行（两次上报）与扇出 REST 行（一次带头的 REST 请求）
    expect(
      await reportInvocation({ toolName: dualTool, surface: 'mcp-full', ok: true, latencyMs: 10 }),
    ).toBe(202);
    expect(
      await reportInvocation({ toolName: dualTool, surface: 'mcp-full', ok: true, latencyMs: 20 }),
    ).toBe(202);
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/${PROBE}/agent`)
      .set('X-API-Key', agentApiKey)
      .set('X-MCP-Tool', dualTool)
      .set('X-MCP-Surface', 'mcp-full')
      .expect(200);

    const flushResult = await buffer.flush();
    expect(flushResult.failed).toBe(false);

    // 扇出 REST 行形状：channel=rest + 头解析出的 tool/surface + agent 身份
    const fanoutRows = await selectRows(ds, `route = $1 AND tool_name = $2`, [
      PROBE_AGENT_ROUTE,
      dualTool,
    ]);
    expect(fanoutRows).toHaveLength(1);
    expect(fanoutRows[0].call_count).toBe(1);
    expect(fanoutRows[0].channel).toBe('rest');
    expect(fanoutRows[0].mcp_surface).toBe('mcp-full');
    expect(fanoutRows[0].actor_type).toBe('agent');
    expect(fanoutRows[0].actor_id).toBe(agentId);

    // ── groupBy=tool：默认 invocation 口径（端点强制，不靠调用方带 metric）──
    const invocations = await apiUsage({ groupBy: 'tool', tool: dualTool });
    expect(invocations.status).toBe(200);
    expect(invocations.meta.groupBy).toBe('tool');
    expect(invocations.meta.metric).toBe('invocations'); // 口径回显（meta 六字段之一）
    expect(invocations.items).toHaveLength(1);
    expect(invocations.items[0]).toMatchObject({
      key: dualTool,
      callCount: 2, // 两次上报；扇出 REST 行**不**计入本口径
      distinctActors: 1,
      maxLatencyMs: 20,
    });

    // ── metric=rest_calls：同一工具的另一个口径，不串味 ──
    const restCalls = await apiUsage({ groupBy: 'tool', tool: dualTool, metric: 'rest_calls' });
    expect(restCalls.meta.metric).toBe('rest_calls');
    expect(restCalls.items).toHaveLength(1);
    expect(restCalls.items[0]).toMatchObject({ key: dualTool, callCount: 1, distinctActors: 1 });

    // 只有 invocation 行的工具（report-<RUN>）在 rest_calls 口径下必须**不出现**
    const restCallsAll = await apiUsage({ groupBy: 'tool', metric: 'rest_calls', limit: 100 });
    expect(restCallsAll.items.some((item) => item.key === `report-${RUN}`)).toBe(false);
    expect(restCallsAll.items.some((item) => item.key === dualTool)).toBe(true);

    // ── groupBy=route ──
    const routeHit = await apiUsage({ groupBy: 'route', route: PROBE_AGENT_ROUTE });
    expect(routeHit.meta.metric).toBeNull(); // 口径回显：非 tool 分组时 metric 不适用
    expect(routeHit.items).toHaveLength(1);
    expect(routeHit.items[0]).toMatchObject({ key: PROBE_AGENT_ROUTE, callCount: 1 });
    // 默认排除 mcp://% 伪路由（否则工具口径的行会混进"REST 路由热度榜"）
    const allRoutes = await apiUsage({ groupBy: 'route', limit: 100 });
    expect(allRoutes.items.some((item) => String(item.key).startsWith('mcp://'))).toBe(false);
    // 显式 route 覆盖默认排除
    const invocationRoute = await apiUsage({
      groupBy: 'route',
      route: USAGE_STATS_TOOL_ROUTE,
      limit: 100,
    });
    expect(invocationRoute.items).toHaveLength(1);
    expect(invocationRoute.items[0].key).toBe(USAGE_STATS_TOOL_ROUTE);
    // ③ 的批内行（6）+ ⑦ 的两次上报（2）+ 上面的两次上报（2）= 10；本断言只防口径泄漏
    expect(invocationRoute.items[0].callCount).toBeGreaterThanOrEqual(6);

    // ── groupBy=actor：invocation 行与扇出 REST 行求和（单位混用，见口径专章）──
    // 过滤 actorType='agent'：同一 actor_id 上可能同时有 'agent' 行与 'system' 行
    // （⑦ 的 viaFallbackAuth 上报——身份不可信的归因标记）。actor_id 是分组键，
    // 其 actor_type 只能取 MAX（见 service 实现注释）；要精确看待哪一类必须显式过滤。
    const actorAll = await apiUsage({
      groupBy: 'actor',
      actorId: agentId,
      actorType: 'agent',
      limit: 100,
    });
    expect(actorAll.meta.metric).toBeNull();
    expect(actorAll.items).toHaveLength(1);
    expect(actorAll.items[0].actorName).toBe(agentDisplayName); // join actors.display_name
    expect(actorAll.items[0].actorType).toBe('agent');
    expect(actorAll.items[0].distinctActors).toBe(1);
    const actorMcp = await apiUsage({
      groupBy: 'actor',
      actorId: agentId,
      actorType: 'agent',
      channel: 'mcp',
      limit: 100,
    });
    const actorRest = await apiUsage({
      groupBy: 'actor',
      actorId: agentId,
      actorType: 'agent',
      channel: 'rest',
      limit: 100,
    });
    // 求和语义：不分组过滤 = 两个通道之和
    expect(actorAll.items[0].callCount).toBe(
      actorMcp.items[0].callCount + actorRest.items[0].callCount,
    );
    expect(actorMcp.items[0].callCount).toBe(4); // ⑦ 两次 + 上面两次上报
    expect(actorRest.items[0].callCount).toBe(1); // 扇出 REST 一次
    // fallback-auth 行可按 actorType 摘出来（"distinctActors 失真"从文档声明变成可过滤标记）：
    // 同一个 actor_id 既在 'agent' 视图又在 'system' 视图里被精确区分
    const actorFallback = await apiUsage({
      groupBy: 'actor',
      actorId: agentId,
      actorType: 'system',
      limit: 100,
    });
    expect(actorFallback.items).toHaveLength(1);
    expect(actorFallback.items[0].actorType).toBe('system');
    expect(actorFallback.items[0].callCount).toBe(1); // 仅 ⑦ 的那次 viaFallbackAuth 上报
    // 匿名行：key=null、回显 'anonymous'、distinctActors 恒 0（COUNT(DISTINCT) 天然忽略 NULL）。
    // 注意：匿名行**只能在不带 actorId 过滤的查询里看到**（actor_id IS NULL 不匹配任何 UUID）
    const actorOverview = await apiUsage({ groupBy: 'actor', limit: 100 });
    const anonymous = actorOverview.items.find((item) => item.key === null);
    expect(anonymous).toBeDefined();
    expect(anonymous?.actorName).toBe('anonymous');
    expect(anonymous?.actorType).toBe('anonymous');
    expect(anonymous?.distinctActors).toBe(0);
    // 无 actors 行的 actor_id（③ 造的孤儿 actor）：统计行无 FK，回显 'deleted actor'
    const deleted = await apiUsage({ groupBy: 'actor', actorId: ORPHAN_ACTOR_ID, limit: 100 });
    expect(deleted.items).toHaveLength(1);
    expect(deleted.items[0].actorName).toBe('deleted actor');

    // ── 负向：sortBy 枚举钉死（distinctActors 刻意不在词表——它来自 pass2 二次查询）──
    for (const sortBy of ['distinctActors', 'nonsense']) {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/system/api-usage`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ groupBy: 'route', sortBy });
      expect(res.status).toBe(400);
    }
    // 口径互斥：metric 只在 groupBy=tool 有意义；工具口径下 metric=invocations × route 自相矛盾
    for (const query of [
      { groupBy: 'route', metric: 'rest_calls' },
      { groupBy: 'tool', metric: 'invocations', route: '/x' },
      { groupBy: 'tool', metric: 'invocations', tool: dualTool, order: 'sideways' },
      { groupBy: 'route', limit: 1000 },
      { groupBy: 'route', from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
    ]) {
      const res = await request(app.getHttpServer())
        .get(`${API_PREFIX}/system/api-usage`)
        .set('Authorization', `Bearer ${adminToken}`)
        .query(query as any);
      expect(res.status).toBe(400);
    }
    // 无认证 → 401；非 admin → 403（admin-only 三元组的守门断言）
    await request(app.getHttpServer())
      .get(`${API_PREFIX}/system/api-usage`)
      .query({ groupBy: 'route' })
      .expect(401);
    const forbidden = await request(app.getHttpServer())
      .get(`${API_PREFIX}/system/api-usage`)
      .set('Authorization', `Bearer ${editorToken}`)
      .query({ groupBy: 'route' });
    expect(forbidden.status).toBe(403);
  }, 60000);

  it('⑨ UTC 整点桶 + route 为 /api/v1 前缀的 :param 模板 + meta 六字段与半开窗口', async () => {
    if (!dbAvailable) return;

    // 先把上一测试的 api-usage 请求行落库（间隔 1h 不会自动 flush）：
    // 下面要断言"真实平台路由也记 /api/v1 模板"，靠的就是那些行
    const flushed = await buffer.flush();
    expect(flushed.failed).toBe(false);

    // ── 桶必须落在 UTC 整点上（应用侧截断，不用 DB date_trunc）──
    const offGrid = (await ds.query(
      `SELECT count(*)::int AS bad FROM api_usage_stats_hourly
        WHERE route LIKE $1 AND date_trunc('hour', bucket_start) <> bucket_start`,
      [`${API_PREFIX}/${PROBE}%`],
    )) as Array<{ bad: number }>;
    expect(offGrid[0].bad).toBe(0);
    const future = (await ds.query(
      `SELECT count(*)::int AS bad FROM api_usage_stats_hourly WHERE bucket_start > now()`,
    )) as Array<{ bad: number }>;
    expect(future[0].bad).toBe(0);

    // ── route 是路由模板：含全局前缀 + `:param`，且**不含**真实 ID ──
    const template = await selectRows(ds, `route = $1`, [PROBE_ANON_ROUTE]);
    expect(template[0].route.startsWith(`${API_PREFIX}/`)).toBe(true);
    expect(template[0].route).toContain(':probeId');
    expect(template[0].route).not.toContain('/anon/p1'); // 用 req.path（真实 ID）就会命中这里
    // 真实平台路由同样记模板形态（这是"高频 REST 晋升 MCP 工具"配方的 join 键）
    const realRoute = await selectRows(ds, `route = $1`, [`${API_PREFIX}/system/api-usage`]);
    expect(realRoute.length).toBeGreaterThanOrEqual(1);
    expect(realRoute[0].route.startsWith(`${API_PREFIX}/`)).toBe(true);

    // ── meta 六字段 ──
    const metaRes = await apiUsage({ groupBy: 'tool', limit: 5 });
    const meta = metaRes.meta;
    expect(Object.keys(meta).sort()).toEqual(
      [
        'dataCoverageDays',
        'earliestBucketStart',
        'groupBy',
        'metric',
        'windowFrom',
        'windowTo',
      ].sort(),
    );
    expect(Number.isNaN(Date.parse(meta.windowFrom))).toBe(false);
    expect(Number.isNaN(Date.parse(meta.windowTo))).toBe(false);
    expect(meta.windowFrom.endsWith('Z')).toBe(true); // UTC 归一
    expect(meta.windowTo.endsWith('Z')).toBe(true);
    expect(new Date(meta.windowTo).getTime()).toBeGreaterThan(new Date(meta.windowFrom).getTime());
    expect(meta.earliestBucketStart).not.toBeNull();
    expect(typeof meta.dataCoverageDays).toBe('number');
    expect(meta.groupBy).toBe('tool');
    expect(meta.metric).toBe('invocations');
    // 默认窗口 = 最近 7 天（缺省锚点由端点钉死）
    const spanDays =
      (new Date(meta.windowTo).getTime() - new Date(meta.windowFrom).getTime()) / 86400000;
    expect(Math.round(spanDays)).toBe(7);

    // ── 窗口半开 [from, to)：起点行在、终点行不在 ──
    const to = new Date(Date.now() - 3600_000);
    const from = new Date(to.getTime() - 3600_000);
    const windowFromRoute = `${API_PREFIX}/${PROBE}/window-from`;
    const windowToRoute = `${API_PREFIX}/${PROBE}/window-to`;
    const windowDims = {
      channel: 'rest',
      mcpSurface: '',
      toolName: '',
      method: 'GET',
      actorId: null,
      actorType: 'anonymous',
    };
    buffer.recordHttpCall({
      ...windowDims,
      bucketStart: from,
      route: windowFromRoute,
      statusClass: '2xx',
      latencyMs: 1,
    });
    buffer.recordHttpCall({
      ...windowDims,
      bucketStart: to,
      route: windowToRoute,
      statusClass: '2xx',
      latencyMs: 1,
    });
    await buffer.flush();

    const windowed = await apiUsage({
      groupBy: 'route',
      from: from.toISOString(),
      to: to.toISOString(),
      limit: 100,
    });
    expect(windowed.meta.windowFrom).toBe(from.toISOString());
    expect(windowed.meta.windowTo).toBe(to.toISOString());
    const keys = windowed.items.map((item) => item.key);
    expect(keys).toContain(windowFromRoute); // bucket_start >= from（含）
    expect(keys).not.toContain(windowToRoute); // bucket_start < to（不含）

    // 跨度上限 90 天的文案必须可操作（铁律 #9 同理：拒绝也要给出下一步）
    const tooWide = await request(app.getHttpServer())
      .get(`${API_PREFIX}/system/api-usage`)
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ groupBy: 'route', from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' });
    expect(tooWide.status).toBe(400);
    expect(JSON.stringify(tooWide.body)).toContain('请分段查询');
  }, 30000);

  it('⑩ migration down/up 真 DDL 往返（事务内验证后回滚，不销毁共享库的表）', async () => {
    if (!dbAvailable) return;

    // 为什么不用 `ds.undoLastMigration()`：那会真的 DROP 掉**共享开发库**的表
    // （并行套件 / dev 后端同在一条库上），且中途失败会把库留在缺表状态。
    // PG 的 DDL 可回滚，故在自持事务里跑真实 migration 类的 down→up：
    // 验证的是同一份 DDL 代码与同一张真实表，结束后 ROLLBACK 还原一切。
    const runner: QueryRunner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      expect(await tableExists(runner)).toBe(true);

      const migration = new AddApiUsageStatsHourly1789484900000();
      await migration.down(runner);
      expect(await tableExists(runner)).toBe(false); // down 真的把表删了

      await migration.up(runner);
      expect(await tableExists(runner)).toBe(true); // up 真的把表建回来了
      expect(await uniqueIndexDef(runner)).toContain('NULLS NOT DISTINCT');
      const reloptions = (await runner.query(
        `SELECT reloptions FROM pg_class WHERE relname = 'api_usage_stats_hourly'`,
      )) as Array<{ reloptions: string[] | null }>;
      expect(reloptions[0].reloptions ?? []).toContain('autovacuum_vacuum_scale_factor=0.02');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }

    // 回滚后：表与索引仍是原样（本套件绝不改变共享库 schema）
    expect(await tableExists(ds)).toBe(true);
    expect(await uniqueIndexDef(ds)).toContain('NULLS NOT DISTINCT');
  }, 30000);
});
