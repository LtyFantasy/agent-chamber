/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - hint「该提名了」提示的**端到端契约**（真实 PG + 真实 HTTP）：写路径
 *     （任务状态真实变更 / 新建任务评论 / 发送话题消息 / 单文档 upsert）→ 资源被 ≥1 个
 *     active 记忆项目绑定 → 触发者对该资源有 write 权限 → 10min 去重节流 →
 *     响应 `data.hints[]` 出现 `memory_nomination_suggested`
 *     （**通用触发**：缺省不读正文；env `MEMORY_NOMINATION_HINT_KEYWORDS=preset` 启用词表精调层 ③b）。
 *
 * [代码职责]
 *   - 钉住判据的**合取**：①事实真的产生（只改 title 不产生状态事实）②绑定判定真的命中
 *     （jsonb containment 打真 PG，铁律 #23：mock 测不出 SQL 生成）③触发者对资源有 write
 *     权限（⑨）；（词表命中只在精调模式下参与判据，见 ③/③b）。
 *   - 钉住**节流与豁免边界**：窗口内同 actor 同资源二次触发无 hints；归档项目不提示。
 *   - 钉住**幂等 replay 不 emit**：清空去重窗口后重放同一 clientRequestId ⇒ 仍无 hints
 *     （证明"无 hints"不是被窗口压制造成的假象）。
 *   - 钉住 M1 缺口：`GET /memory/projects?bindingType=board&bindingId=` 真 PG 命中。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *   - 补充: AGENTS.md §5.3（memory 分支消费纪律）/ kairos-project-engineering §14.2（词表来源）
 *
 * [关键不变量]（改断言前先想清楚在防什么）
 *   - **hints 只在 2xx 且只进 `data`**：本套件所有断言都读 `body.data.hints`；无命中时
 *     **键不出现**（不是 `[]`、不是 null）。
 *   - **advisory 不得改业务结果**：①的 `data.status` 必须同时是 `done`（提示与状态机互不干扰）。
 *   - **绑定判定必须打真 PG**：本套件是「containment 谓词真的命中」的唯一证据（单测全是 mock 仓储）。
 *   - **归档项目 ≠ 可提示**：`status='archived'` 的项目仍可读、但不产生新提示（⑦）。
 *   - **窗口键 = (actor, code, resourceKey=taskId/topicId)**：④ 用同一 task 的第二次状态变更
 *     验证压制；其余用例各自用独立 task/topic ⇒ 互不干扰。
 *
 * [关联代码]
 *   - src/modules/memory/memory-nomination-hint.provider.ts — 被判定的 provider
 *   - src/modules/hints/hint.interceptor.ts — 求值入口（APP_INTERCEPTOR）
 *   - src/config/app-hint-provider-chain.ts — 生产装配单源（本套件按它装配，保证与生产同形）
 *   - src/modules/task/task.service.ts / src/modules/topic/topic.service.ts — 三个 emitFact 挂点
 *   - test/memory.e2e-spec.ts — 同款真 PG + 真 HTTP bootstrap 先例（清理顺序同规）
 *
 * [持久踩坑]
 *   MEMHINT-E2E-DOCPATH(⑨b/⑨c 走 provider 直调，**自觉偏离**): 本套件刻意不 import
 *     `DocSpaceModule`——它 `forwardRef(() => AttachmentModule)`，而 AttachmentModule 挂着
 *     `ScheduleModule.forRoot()`（全应用唯一挂载点，三轨 GC cron）。为两个「docSpace 绑定
 *     containment 是否真命中」的判据拉起 cron 面不值当，故 ⑨b/⑨c 直接注入 provider
 *     （`app.get(MemoryNominationHintProvider)`）+ 真 PG 调 `build`，钉住的是**同一条
 *     containment SQL**（docSpace needle 逐字）。doc 写口的「何时陈述事实」门控
 *     （unchanged / rechunked / replay 三者不 emit）由 `doc.controller.spec.ts` 的真值表覆盖；
 *     HTTP 级 doc upsert → 信封 的整链不在本套件（如实记账，不当已覆盖）。
 *   MEMHINT-E2E-MULTIPROVIDER(同响应多 provider 并存): 阶段三起 task 写路径的响应里
 *     **可能同时**有 `memory_nomination_suggested` 与 task 纪律族两码（⑨d 钉住）⇒
 *     本套件所有「无 hints」断言都必须按 **code** 取值（`hintsOf` 已按提名码过滤），
 *     直接断言 `payload` 上没有 `hints` 键会随 provider 增多而误红。
 *   MEMHINT-E2E-SHARED-DB(共享开发库): 本套件打共享库，全部数据带 RUN 后缀隔离；
 *     afterAll 先删子表再删父表（boards / topics 的 FK 均为 ON DELETE CASCADE，
 *     显式顺序只是把意图写清楚）。events / audit_logs **无 FK**（audit_logs 无 FK 是既定先例），
 *     残留行无害，故不清理（与 memory.e2e-spec.ts 同款处置）。
 *   MEMHINT-E2E-WINDOW(去重窗口是进程内单例): ④/⑤-replay 两条用例依赖窗口状态，
 *     用例顺序有语义——**不要**把 `HintDedupService.reset()` 放进 beforeEach
 *     （那会让"第二次触发被压制"的断言失去意义）。
 *   MEMHINT-E2E-GLOBAL-COUNT(共享库的全局计数断言): ⑤b 用 clientRequestId 走幂等事务路径
 *     （replay-不-emit 的唯一取证方式），因此会**并发**写 `idempotency_records` 一行。
 *     已知既有 flake（**与本批无关，已取证**）：`docspace-governance.e2e-spec.ts:374` 用
 *     `IdempotencyRecord.count()` 的全局计数做 dryRun 零副作用断言，与任何并发写幂等表的套件
 *     （含既有的 `docspace-idempotency.e2e-spec.ts`）互相干扰——2/3 次复现。
 *     本套件的处置：afterAll 主动删掉自己那一行（不留下全局计数漂移）。
 * =============================================================================
 */

/**
 * 「该提名了」提示 —— 真实 PG + 真实 HTTP 端到端套件（卡 ac2f6ce4 阶段二 e2e 矩阵）。
 *
 * 为什么不是 mock 链：本能力的判据跨三张表 + 一段 jsonb containment SQL（铁律 #23）——
 * 「绑定真的命中」这件事只有真 PG 能证伪；而"提示真的挂进信封 data"只有真 HTTP 能证。
 *
 * 装配与生产同形（**诚实表述**）：
 * - provider 链 = **生产单源常量** `HINT_FACT_PROVIDER_CHAIN`（不是手抄一份）；
 * - 拦截器链 = **手抄同序**（`ResponseInterceptor` 在外 → `HintInterceptor` 在内），
 *   与 `APP_INTERCEPTOR_CHAIN` 的相邻次序一致——顺序的**守卫**归 `src/app.module.spec.ts`
 *   （本套件刻意不 import AppModule：那会拉起 WS gateway / schedule 启动面，见该 spec 文件头），
 *   故此处的次序是"照抄"，不是"被守卫"。改动拦截器链序时**两处都要改**。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import request = require('supertest');
import {
  API_PREFIX,
  ActorType,
  AgentStatus,
  BoardMemberRole,
  TaskStatus,
  UserRole,
} from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { User } from '../src/database/entities/user.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Task } from '../src/database/entities/task.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { MemoryProject, type MemoryBinding } from '../src/database/entities/memory-project.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { TaskModule } from '../src/modules/task/task.module';
import { TopicModule } from '../src/modules/topic/topic.module';
import { MemoryModule } from '../src/modules/memory/memory.module';
import { HintsModule } from '../src/modules/hints/hints.module';
import { HINT_FACT_PROVIDERS, HintInterceptor } from '../src/modules/hints/hint.interceptor';
import { HintDedupService } from '../src/modules/hints/hint-dedup.service';
import { HINT_FACT_PROVIDER_CHAIN } from '../src/config/app-hint-provider-chain';
import {
  MEMORY_NOMINATION_HINT_CODE,
  MEMORY_NOMINATION_HINT_MESSAGE,
  MEMORY_RULING_KEYWORDS,
} from '../src/modules/memory/memory.constants';
// 词表精调层的 env 键（③b 用它切换模式）+ provider 类（⑨b/c 直调，验 docSpace 绑定真 PG 命中）
import {
  MEMORY_NOMINATION_HINT_KEYWORDS_ENV,
  MemoryNominationHintProvider,
} from '../src/modules/memory/memory-nomination-hint.provider';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其它套件） */
const JWT_SECRET = 'memory-nomination-hint-e2e-secret';

/** 本次运行的唯一后缀：隔离数据（slug / 标题 / 正文全带它） */
const RUN = `memhint-${Date.now().toString(36)}`;

/** 词表里的两个代表词（①/⑤ 各取一个，逐词覆盖由 provider 单测的 it.each 承担） */
const RULING_WORD = '拍板';
const RULING_WORD_COMMENT = '一律';
const RULING_WORD_MESSAGE = '禁止';

/** 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态：方法级 guard 在声明它的模块上下文实例化） */
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
class NominationE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + Task/Topic/Memory + hint 基建（装配与生产同形） */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    // ⚠️ 生产由 AppModule 的 `EventEmitterModule.forRoot()` 提供 EventEmitter（@Global）：
    // TaskModule / TopicModule 都 import EventModule，而 EventService 注入了 EventEmitter2——
    // 漏了它 = 本套件启动期就报 "Nest can't resolve dependencies of the EventService"
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
    NominationE2eAuthModule,
    CommonModule,
    PermissionModule,
    TaskModule,
    TopicModule,
    MemoryModule,
    // @Global，但显式 import 让"hint 基建被装配"这件事在本文件里可见
    HintsModule,
  ],
  providers: [
    // 与生产同序（config/app-interceptor-chain.ts）：信封拦截器在外、hint 拦截器在内
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HintInterceptor },
    // provider 链 = **生产单源常量**（不是手抄一份）；AppModule 里是同一行写法
    {
      provide: HINT_FACT_PROVIDERS,
      useFactory: (...providers: unknown[]) => providers,
      inject: [...HINT_FACT_PROVIDER_CHAIN],
    },
  ],
})
class NominationE2eModule {}

/** 响应信封 */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  timestamp: string;
  requestId: string;
}

/** 信封内的 hint 条目（断言用最小形状） */
interface HintItem {
  code: string;
  status: string;
  message: string;
  data?: {
    projectIds?: string[];
    /** 来源标识（卡 43b31046：结构化出口，消费方不解析 message） */
    source?: { type: string; id: string };
    suggestedTool?: string;
    suggestedParams?: { id?: string; page?: number; pageSize?: number };
  };
}

describe('「该提名了」提示（hint 阶段二）— 真实 PG + 真实 HTTP 集成', () => {
  let app: INestApplication;
  let ds: DataSource;
  let dedup: HintDedupService;
  let dbAvailable = false;

  let agentAId: string;
  let agentAKey: string;
  let agentBId: string;
  let agentBKey: string;

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    boardIds: [] as string[],
    // board_members 是复合主键（board_id + actor_id）：显式登记以便按板清理
    memberRows: [] as { boardId: string; actorId: string }[],
    taskIds: [] as string[],
    topicIds: [] as string[],
    projectIds: [] as string[],
    spaceIds: [] as string[],
    docIds: [] as string[],
  };

  /** 本套件创建的任务描述（带唯一后缀，便于核对"命中词来自哪一行"） */
  function taskTitle(label: string): string {
    return `任务 ${RUN} ${label}`;
  }

  // ─── HTTP 助手 ───────────────────────────────────────────────────

  /** 带身份的 HTTP 助手（agent 通道 = 真 sha256 API Key 校验） */
  function req() {
    const agent = request(app.getHttpServer());
    return {
      patch: (path: string) => agent.patch(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
      post: (path: string) => agent.post(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
      get: (path: string) => agent.get(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
    };
  }

  /** 以**另一个** actor 的 key 发请求（⑨ 权限过滤用例：可写任务但不可写 board 的 assignee） */
  function reqAs(apiKey: string) {
    const agent = request(app.getHttpServer());
    return {
      patch: (path: string) => agent.patch(`${API_PREFIX}${path}`).set('X-API-Key', apiKey),
    };
  }

  /**
   * 取响应里 `memory_nomination_suggested` 的条目（**键不出现 → undefined**；**不是**空数组）。
   *
   * ⚠️ **必须按 code 过滤**（阶段三）：同响应现在可能有**多个 provider** 的候选并存
   * （task 纪律族的 `task_done_without_report` / `comment_on_done_task` 与提名词条同信封），
   * 全量断言会把别的 provider 的产出算进来 ⇒ 本套件的判定一律以本函数取值。
   * 需要看全量信封（共存性断言）时用 {@link allHintsOf}。
   */
  function hintsOf(body: unknown): HintItem[] | undefined {
    const filtered = allHintsOf(body)?.filter((hint) => hint.code === MEMORY_NOMINATION_HINT_CODE);
    return filtered && filtered.length > 0 ? filtered : undefined;
  }

  /** 取响应 **全部** hints（多 provider 并存时的共存性断言用） */
  function allHintsOf(body: unknown): HintItem[] | undefined {
    return (body as Envelope<{ hints?: HintItem[] }>).data.hints;
  }

  // ─── 夹具 ─────────────────────────────────────────────────────────

  /** 造「看板 → 列 → 任务」链（`creatorId = agent A` ⇒ 对 board 有 write，PATCH/评论才放行） */
  async function createBoardChain(
    description: string | null,
    label: string,
  ): Promise<{ boardId: string; listId: string; taskId: string }> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `hint board ${RUN} #${created.boardIds.length}`,
        creatorId: agentAId,
        settings: { visibility: 'open' },
        taskCount: 0,
        completedTaskCount: 0,
      }),
    );
    created.boardIds.push(board.id);

    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `hint list ${RUN} ${label}`,
        position: 0,
      }),
    );

    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: taskTitle(label),
        description,
        position: 0,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);

    return { boardId: board.id, listId: list.id, taskId: task.id };
  }

  /** 造开放话题（creatorId = agent A；open 话题不查参与者，发消息即自动 join） */
  async function createTopic(label: string): Promise<string> {
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `hint topic ${RUN} ${label}`,
        creatorId: agentAId,
        settings: { visibility: 'open' },
        participantCount: 0,
        messageCount: 0,
      }),
    );
    created.topicIds.push(topic.id);
    return topic.id;
  }

  /**
   * 在同一 board 下再挂一列（可带 `mappedStatus`）——move 的自动状态联动靠它
   * （board_lists 有 `(board_id, mapped_status)` 的部分唯一索引，故一 board 一个 done 列即可）
   */
  async function createList(
    boardId: string,
    label: string,
    mappedStatus?: TaskStatus,
  ): Promise<string> {
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId,
        name: `hint list ${RUN} ${label}`,
        position: 1,
        ...(mappedStatus ? { mappedStatus } : {}),
      }),
    );
    return list.id;
  }

  /**
   * 造记忆项目（直插库：本套件考的是 provider 的读侧判据，不是项目创建写路径——
   * 后者由 memory.e2e-spec.ts 覆盖）。
   */
  async function createProject(
    bindings: MemoryBinding[],
    status: 'active' | 'archived',
    label: string,
  ): Promise<string> {
    const project = await ds.getRepository(MemoryProject).save(
      ds.getRepository(MemoryProject).create({
        slug: `memhint-${RUN}-${label}`,
        name: `记忆项目 ${RUN} ${label}`,
        bindings,
        engine: 'none',
        status,
        // createdBy = agent A ⇒ 治理观察者 ⇒ ⑧ 的列表反查对 A 必可见（与 board 权限解耦）
        createdBy: agentAId,
      }),
    );
    created.projectIds.push(project.id);
    return project.id;
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
      console.warn(
        `[memory-nomination-hint e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }

    // 表必须在（迁移链产物）——缺表即环境未跑迁移，显式失败而非静默跳过
    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('memory_projects','tasks','topics')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual(['memory_projects', 'tasks', 'topics']);
    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({ imports: [NominationE2eModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    // 去重窗口单例（④ / ⑤-replay 两条用例的可观测面）
    dedup = app.get(HintDedupService);

    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: (
          await ds.getRepository(Actor).save(
            ds.getRepository(Actor).create({
              type: ActorType.HUMAN,
              displayName: `Hint Owner ${RUN}`,
              status: AgentStatus.ACTIVE,
            }),
          )
        ).id,
        username: `hintowner${RUN}`.slice(0, 50),
        email: `hint-owner-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(owner.id);

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `Hint Agent ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `Hint Agent ${RUN}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);

    const rawKey = `ask_hint${RUN}`;
    const key = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyIds.push(key.id);

    agentAId = agent.id;
    agentAKey = rawKey;

    // ── agent B：⑨ 权限过滤用例的对照组（可写**被分配的任务**，但不可写 board） ──
    const actorB = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `Hint Agent B ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actorB.id);
    const agentB = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actorB.id,
        actor: actorB,
        ownerId: owner.id,
        name: `Hint Agent B ${RUN}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agentB.id);
    const rawKeyB = `ask_hintb${RUN}`;
    const keyB = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agentB.id,
        keyHash: crypto.createHash('sha256').update(rawKeyB).digest('hex'),
        keyPrefix: rawKeyB.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: owner.id,
      }),
    );
    created.keyIds.push(keyB.id);
    agentBId = agentB.id;
    agentBKey = rawKeyB;
  }, 180000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();

    // 清理顺序：子表显式先删（FK 均为 ON DELETE CASCADE，顺序意在把意图写清楚）
    // events / audit_logs 无 FK，残留行无害、不清理（与 memory.e2e-spec.ts 同款处置）
    if (created.taskIds.length > 0) {
      await ds.query(`DELETE FROM task_activities WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM task_comments WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [created.taskIds]);
    }
    if (created.boardIds.length > 0) {
      for (const row of created.memberRows) {
        await ds.query(`DELETE FROM board_members WHERE board_id = $1 AND actor_id = $2`, [
          row.boardId,
          row.actorId,
        ]);
      }
      await ds.query(`DELETE FROM board_lists WHERE board_id = ANY($1::uuid[])`, [
        created.boardIds,
      ]);
      await ds.query(`DELETE FROM boards WHERE id = ANY($1::uuid[])`, [created.boardIds]);
    }
    if (created.topicIds.length > 0) {
      await ds.query(`DELETE FROM messages WHERE topic_id = ANY($1::uuid[])`, [created.topicIds]);
      await ds.query(`DELETE FROM topic_participants WHERE topic_id = ANY($1::uuid[])`, [
        created.topicIds,
      ]);
      await ds.query(`DELETE FROM topics WHERE id = ANY($1::uuid[])`, [created.topicIds]);
    }
    if (created.projectIds.length > 0) {
      await ds.query(`DELETE FROM memory_projects WHERE id = ANY($1::uuid[])`, [
        created.projectIds,
      ]);
    }
    // ⑩c/⑩d 的关联文档 + task_doc_links（**先删 link 再删 doc**：link 是裸 uuid 中间表无 FK）
    if (created.docIds.length > 0) {
      await ds.query(`DELETE FROM task_doc_links WHERE doc_id = ANY($1::uuid[])`, [created.docIds]);
      await ds.query(`DELETE FROM docs WHERE id = ANY($1::uuid[])`, [created.docIds]);
    }
    // ⑨b/⑨c/⑩ 的临时空间（**先删项目/文档再删空间**：bindings 是裸 jsonb，无 FK，顺序只表意图）
    if (created.spaceIds.length > 0) {
      await ds.query(`DELETE FROM doc_spaces WHERE id = ANY($1::uuid[])`, [created.spaceIds]);
    }
    // ⑤b 的幂等记录：主动清掉（**不为别的套件留全局计数漂移**——已知
    // `docspace-governance.e2e-spec.ts` 用 `IdempotencyRecord.count()` 的**全局**计数做
    // "dryRun 零副作用"断言，任何并发写幂等表的套件都会让它 flaky，见本文件头 MEMHINT-E2E-WINDOW）
    await ds.query(
      `DELETE FROM idempotency_records WHERE actor_id = $1 AND client_request_id = $2`,
      [agentAId, `replay-${RUN}-5b`],
    );
    for (const id of created.keyIds) await ds.getRepository(ApiKey).delete({ id });
    for (const id of created.agentIds) await ds.getRepository(Agent).delete({ id });
    for (const id of created.userIds) await ds.getRepository(User).delete({ id });
    for (const id of created.actorIds) await ds.getRepository(Actor).delete({ id });
    await ds.destroy();
  }, 120000);

  // ══════════════════════════════════════════════════════════════════
  // ① 命中三要素齐备：状态真实变更 + 绑定命中 + 裁决词命中
  // ══════════════════════════════════════════════════════════════════

  it('① 绑定 board 的活跃项目 + PATCH status→done（描述含裁决词）→ data.hints 含该码与 projectIds', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(
      `本条${RULING_WORD}：以后都按这个来`,
      'case-1',
    );
    const projectId = await createProject([{ type: 'board', id: boardId }], 'active', 'case-1');

    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(res.status).toBe(200);
    const data = (res.body as Envelope<{ status: string; hints?: HintItem[] }>).data;
    // advisory 不得改业务结果：状态机照常走到 done
    expect(data.status).toBe('done');

    const hints = hintsOf(res.body);
    expect(hints).toHaveLength(1);
    expect(hints?.[0]).toEqual({
      code: MEMORY_NOMINATION_HINT_CODE,
      status: 'suggestion',
      message: MEMORY_NOMINATION_HINT_MESSAGE,
      data: {
        projectIds: [projectId],
        source: { type: 'task', id: taskId },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: projectId, page: 1, pageSize: 10 },
      },
    });
  });

  it('①b 词表契约：裁决词取自 MEMORY_RULING_KEYWORDS 单源（本用例是 e2e 侧的锚点）', () => {
    expect([...MEMORY_RULING_KEYWORDS]).toContain(RULING_WORD);
    expect([...MEMORY_RULING_KEYWORDS]).toContain(RULING_WORD_COMMENT);
    expect([...MEMORY_RULING_KEYWORDS]).toContain(RULING_WORD_MESSAGE);
  });

  // ══════════════════════════════════════════════════════════════════
  // ②③⑦ 负向三态：未绑定 / 无命中词 / 归档项目
  // ══════════════════════════════════════════════════════════════════

  it('② 未绑定 board 的任务同样操作 → 响应**无 hints 键**', async () => {
    if (!dbAvailable) return;

    // 有绑定，但绑的是**另一个** board（本任务所在 board 无项目绑定）
    const bound = await createBoardChain(null, 'case-2-bound');
    await createProject([{ type: 'board', id: bound.boardId }], 'active', 'case-2');
    const { taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-2-target');

    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(hintsOf(res.body)).toBeUndefined();
  });

  it('③ 通用触发（**缺省模式**）：已绑定即提示——正文不含任何裁决词也照常产出', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain('普通描述，没有任何裁决语义', 'case-3');
    const projectId = await createProject([{ type: 'board', id: boardId }], 'active', 'case-3');

    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(res.status).toBe(200);
    // 阶段三决策 1：不读正文、不扫词——「这个资源上有值得进记忆的写入」本身就是提示理由
    expect(hintsOf(res.body)?.[0]).toMatchObject({
      code: MEMORY_NOMINATION_HINT_CODE,
      data: { projectIds: [projectId] },
    });
  });

  it('③b 词表**精调层**（env=preset）：未命中裁决词 → 不提示（精调收紧的真库取证）', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain('普通描述，没有任何裁决语义', 'case-3b');
    await createProject([{ type: 'board', id: boardId }], 'active', 'case-3b');

    process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV] = 'preset';
    try {
      const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });
      expect(res.status).toBe(200);
      expect(hintsOf(res.body)).toBeUndefined();

      // 反向自检：同模式下**命中**词的内容照常提示（证明"无 hints"来自词表判定，而不是链路坏了）
      const { boardId: boardId2, taskId: taskId2 } = await createBoardChain(
        `本条${RULING_WORD}：以后都按这个来`,
        'case-3b-hit',
      );
      const projectId2 = await createProject(
        [{ type: 'board', id: boardId2 }],
        'active',
        'case-3b-hit',
      );
      const hit = await req().patch(`/tasks/${taskId2}`).send({ status: 'done' });
      expect(hintsOf(hit.body)?.[0]).toMatchObject({
        code: MEMORY_NOMINATION_HINT_CODE,
        data: { projectIds: [projectId2] },
      });
    } finally {
      delete process.env[MEMORY_NOMINATION_HINT_KEYWORDS_ENV];
    }
  });

  it('⑦ 归档项目的绑定 → 无 hints（归档 = 退出当前工作语境，不是"不可读"）', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-7');
    await createProject([{ type: 'board', id: boardId }], 'archived', 'case-7');

    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(hintsOf(res.body)).toBeUndefined();
  });

  it('⑦b 软删项目的绑定 → 无 hints（软删 = 不存在；`deleted_at IS NULL` 谓词的真库证明）', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-7b');
    const projectId = await createProject([{ type: 'board', id: boardId }], 'active', 'case-7b');

    const first = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });
    expect(hintsOf(first.body)).toHaveLength(1); // 软删前：照常提示

    // 软删该项目（走裸 SQL：TypeORM 的 softDelete 会顺带改 updatedAt，这里只要 deleted_at）
    await ds.query(`UPDATE memory_projects SET deleted_at = now() WHERE id = $1`, [projectId]);

    // 同一 task 的第二次状态变更：窗口虽已被第一次占用，但**先把窗口清空**再触发，
    // 保证"无 hints"只能归因于软删过滤（而不是被 24h 窗口压制）
    dedup.reset();
    const second = await req().patch(`/tasks/${taskId}`).send({ status: 'in_progress' });

    expect(second.status).toBe(200);
    expect(hintsOf(second.body)).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ 24h 去重窗口（同 actor 同资源二次触发被压制）
  // ══════════════════════════════════════════════════════════════════

  it('④ 同 actor 同 task 二次状态变更 → 24h 窗口内无 hints（第一次有）', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-4');
    await createProject([{ type: 'board', id: boardId }], 'active', 'case-4');

    const first = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });
    expect(first.status).toBe(200);
    expect(hintsOf(first.body)).toHaveLength(1);

    // 同一 task 的**第二次真实状态变更**（done → in_progress）：事实照常产生，但窗口压制
    const second = await req().patch(`/tasks/${taskId}`).send({ status: 'in_progress' });
    expect(second.status).toBe(200);
    expect((second.body as Envelope<{ status: string }>).data.status).toBe('in_progress');
    expect(hintsOf(second.body)).toBeUndefined();
    // 窗口确实被第一次占用（不是"第二次压根没产生事实"）
    expect(dedup.isSuppressed(agentAId, MEMORY_NOMINATION_HINT_CODE, taskId)).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ 评论与话题消息两条写路径（含幂等 replay 的负向锁）
  // ══════════════════════════════════════════════════════════════════

  it('⑤a POST /tasks/:id/comments 含裁决词 → hints（resourceKey = taskId）', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(null, 'case-5a');
    const projectId = await createProject([{ type: 'board', id: boardId }], 'active', 'case-5a');

    const res = await req()
      .post(`/tasks/${taskId}/comments`)
      .send({ content: `这条以后${RULING_WORD_COMMENT}照办` });

    expect(res.status).toBe(201);
    const hints = hintsOf(res.body);
    expect(hints).toHaveLength(1);
    // resourceKey = taskId（评论挂在任务上）；data.projectIds = 命中的活跃项目
    expect(hints?.[0]).toEqual({
      code: MEMORY_NOMINATION_HINT_CODE,
      status: 'suggestion',
      message: MEMORY_NOMINATION_HINT_MESSAGE,
      data: {
        projectIds: [projectId],
        source: { type: 'task', id: taskId },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: projectId, page: 1, pageSize: 10 },
      },
    });
    expect(dedup.isSuppressed(agentAId, MEMORY_NOMINATION_HINT_CODE, taskId)).toBe(true);
  });

  it('⑤b POST /topics/:id/messages 含裁决词（**幂等事务路径**）→ hints + 重放不 emit', async () => {
    if (!dbAvailable) return;

    const topicId = await createTopic('case-5b');
    const projectId = await createProject([{ type: 'topic', id: topicId }], 'active', 'case-5b');
    const clientRequestId = `replay-${RUN}-5b`;

    const first = await req()
      .post(`/topics/${topicId}/messages`)
      .send({ content: `${RULING_WORD_MESSAGE}这样干`, clientRequestId });

    expect([200, 201]).toContain(first.status);
    expect(hintsOf(first.body)?.[0]).toMatchObject({
      code: MEMORY_NOMINATION_HINT_CODE,
      status: 'suggestion',
      data: { projectIds: [projectId] },
    });

    // 清空窗口后再重放同一 clientRequestId：**replay 分支绝不 emit 事实**——
    // 若 replay 也 emit，窗口空 ⇒ 本次必然出现 hints（这正是本断言要排除的形态）
    dedup.reset();
    const replay = await req()
      .post(`/topics/${topicId}/messages`)
      .send({ content: `${RULING_WORD_MESSAGE}这样干`, clientRequestId });

    expect([200, 201]).toContain(replay.status);
    expect((replay.body as Envelope<Record<string, unknown>>).data.idempotentReplay).toBe(true);
    expect((replay.body as { data: object }).data).not.toHaveProperty('hints');
  });

  it('⑤c POST /topics/:id/messages **不带 clientRequestId**（非幂等原路径）→ hints', async () => {
    if (!dbAvailable) return;

    const topicId = await createTopic('case-5c');
    const projectId = await createProject([{ type: 'topic', id: topicId }], 'active', 'case-5c');

    // 与 ⑤b 的差别 = **不带 clientRequestId** ⇒ 走 sendMessageInternal（无事务的原路径），
    // 这是第三条 emitFact 挂点的独立取证（⑤b 走的是幂等事务分支）
    const res = await req()
      .post(`/topics/${topicId}/messages`)
      .send({ content: `这条${RULING_WORD_MESSAGE}这样干` });

    expect([200, 201]).toContain(res.status);
    const hints = hintsOf(res.body);
    expect(hints).toHaveLength(1);
    expect(hints?.[0]).toEqual({
      code: MEMORY_NOMINATION_HINT_CODE,
      status: 'suggestion',
      message: MEMORY_NOMINATION_HINT_MESSAGE,
      data: {
        projectIds: [projectId],
        source: { type: 'topic', id: topicId },
        suggestedTool: 'memory_controller_list_nominations',
        suggestedParams: { id: projectId, page: 1, pageSize: 10 },
      },
    });
    // 窗口按 (actor, code, topicId) 落位 ⇒ 同话题二次发送被压制（原路径也占窗口）
    expect(dedup.isSuppressed(agentAId, MEMORY_NOMINATION_HINT_CODE, topicId)).toBe(true);
  });

  it('⑥b POST /tasks/:id/move 到 mappedStatus=done 的列（自动改状态）→ hints', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-6b');
    const projectId = await createProject([{ type: 'board', id: boardId }], 'active', 'case-6b');
    const doneListId = await createList(boardId, 'case-6b-done', TaskStatus.DONE);

    const res = await req().post(`/tasks/${taskId}/move`).send({ listId: doneListId });

    // `@Post` 无 @HttpCode ⇒ Nest 返回 201（与 POST 语义一致；本套件照实钉住）
    expect(res.status).toBe(201);
    const data = (res.body as Envelope<{ status: string; listId: string }>).data;
    // 自动状态联动照常生效（hint 是 advisory，不改业务结果）
    expect(data.status).toBe('done');
    expect(data.listId).toBe(doneListId);
    // **P2-3 触发链缺口**：move 引起的真实状态变更也必须产生事实 ⇒ 提示
    expect(hintsOf(res.body)).toEqual([
      {
        code: MEMORY_NOMINATION_HINT_CODE,
        status: 'suggestion',
        message: MEMORY_NOMINATION_HINT_MESSAGE,
        data: {
          projectIds: [projectId],
          source: { type: 'task', id: taskId },
          suggestedTool: 'memory_controller_list_nominations',
          suggestedParams: { id: projectId, page: 1, pageSize: 10 },
        },
      },
    ]);
    expect(dedup.isSuppressed(agentAId, MEMORY_NOMINATION_HINT_CODE, taskId)).toBe(true);
  });

  it('⑥c 同 board 内 move 到**无** mappedStatus 的列 → 无状态变更 ⇒ 无 hints', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-6c');
    await createProject([{ type: 'board', id: boardId }], 'active', 'case-6c');
    const plainListId = await createList(boardId, 'case-6c-plain');

    const res = await req().post(`/tasks/${taskId}/move`).send({ listId: plainListId });

    expect(res.status).toBe(201); // 同上：`@Post` 默认 201
    expect(hintsOf(res.body)).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ PATCH 只改 title（无状态变更）→ 不产生状态事实 ⇒ 无 hints
  //    （状态事实的**两条**来源 = PATCH status / move 自动联动，分别由 ⑥ 与 ⑥b 覆盖）
  // ══════════════════════════════════════════════════════════════════

  it('⑥ PATCH 只改 title（含裁决词也不提示）→ 无 hints；随后状态变更照常提示', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-6');
    await createProject([{ type: 'board', id: boardId }], 'active', 'case-6');

    const titleOnly = await req()
      .patch(`/tasks/${taskId}`)
      .send({ title: `新标题 ${RULING_WORD} ${RUN}` });
    expect(titleOnly.status).toBe(200);
    expect(hintsOf(titleOnly.body)).toBeUndefined();

    // 反向自检：这条链路是通的（同 task 的状态变更仍能提示），
    // 故 ⑥ 的"无 hints"只能归因于「无状态变更 ⇒ 无事实」，不是别处坏了
    const statusChange = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });
    expect(statusChange.status).toBe(200);
    expect(hintsOf(statusChange.body)).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑨ 阶段三新增判据：权限过滤 / doc 写口 / fail-closed / 多 provider 共存
  // ══════════════════════════════════════════════════════════════════

  it('⑨ 权限过滤（真 PG 权限链）：可写任务（assignee）但不可写 board（private 非 editor 成员）→ 无提名条目', async () => {
    if (!dbAvailable) return;

    // private board（creator = A）：B 是 **role=member 的非 editor 成员** ⇒ 对 board 无 write
    // （BoardPolicy write 只认 creator/editor/ownerProxy），但可读；任务是 B 的 assignee
    // ⇒ TaskPolicy 放行任务写（F4-2 后这是「能写这条资源、却不该被提示提名它」的**唯一**
    // 合法形态：assignee ∧ boardRead 成立，而 board write 不成立）。
    //
    // ⚠️ F4-2 语义变更（本用例原以「B **完全不在** private board 上」铺场景）：那条路径
    // 已按安全要求收紧为**一律拒绝**（被指派不再是授权来源，见 task.policy.ts 的 F4-2 注释），
    // 若继续用它，本用例的 `expect(200)` 会与 F4-2 直接冲突。改用「非 editor 成员」既保住
    // 本用例的原意（任务可写、board 不可写），也与新语义自洽。
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `hint board ${RUN} #p9`,
        creatorId: agentAId,
        settings: { visibility: 'private' },
        taskCount: 0,
        completedTaskCount: 0,
      }),
    );
    created.boardIds.push(board.id);
    const memberRow = await ds.getRepository(BoardMember).save(
      ds.getRepository(BoardMember).create({
        boardId: board.id,
        actorId: agentBId,
        role: BoardMemberRole.MEMBER,
      }),
    );
    created.memberRows.push(memberRow);
    const list = await ds
      .getRepository(BoardList)
      .save(
        ds
          .getRepository(BoardList)
          .create({ boardId: board.id, name: `hint list ${RUN} p9`, position: 0 }),
      );
    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: taskTitle('case-9'),
        description: `本条${RULING_WORD}`,
        position: 0,
        customFields: {},
        assigneeId: agentBId,
      }),
    );
    created.taskIds.push(task.id);
    await createProject([{ type: 'board', id: board.id }], 'active', 'case-9');

    const byB = await reqAs(agentBKey).patch(`/tasks/${task.id}`).send({ status: 'done' });
    expect(byB.status).toBe(200);
    // 绑定确实命中（board 被 active 项目绑定），但触发者对 board 无 write ⇒ 不提示提名
    expect(hintsOf(byB.body)).toBeUndefined();

    // 对照组（同 board 同绑定）：creator A 对 board 有 write ⇒ 照常提示——
    // 证明"无 hints"来自权限过滤，而不是绑定/事实链路坏了
    const task2 = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: taskTitle('case-9-control'),
        description: `本条${RULING_WORD}`,
        position: 1,
        customFields: {},
      }),
    );
    created.taskIds.push(task2.id);
    const byA = await req().patch(`/tasks/${task2.id}`).send({ status: 'done' });
    expect(hintsOf(byA.body)?.[0]).toMatchObject({ code: MEMORY_NOMINATION_HINT_CODE });
  });

  it('⑨b doc.upserted（doc 写口）→ docSpace 绑定**真 PG** 命中（provider 直调，铁律 #23）', async () => {
    if (!dbAvailable) return;

    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `hint space ${RUN}`,
        slug: `hint-space-${RUN}-9b`,
        creatorId: agentAId,
        settings: {},
      }),
    );
    created.spaceIds.push(space.id);
    const projectId = await createProject(
      [{ type: 'docSpace', id: space.id }],
      'active',
      'case-9b',
    );

    const provider = app.get(MemoryNominationHintProvider);
    const docId = crypto.randomUUID();
    const candidates = await provider.build(
      [{ name: 'doc.upserted', payload: { docId, spaceId: space.id } }],
      null,
      { actor: { id: agentAId, type: ActorType.AGENT } as never },
    );

    // containment needle = `[{type:'docSpace', id: spaceId}]` 逐字：真库命中才证明这条写口通
    expect(candidates).toHaveLength(1);
    expect(candidates[0].data).toEqual({
      projectIds: [projectId],
      source: { type: 'doc', id: docId },
      suggestedTool: 'memory_controller_list_nominations',
      suggestedParams: { id: projectId, page: 1, pageSize: 10 },
    });
  });

  it('⑨c fail-closed：**缺 ctx**（视为匿名）→ 无候选（正确性修正不可被静默绕过）', async () => {
    if (!dbAvailable) return;

    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `hint space ${RUN} anon`,
        slug: `hint-space-${RUN}-9c`,
        creatorId: agentAId,
        settings: {},
      }),
    );
    created.spaceIds.push(space.id);
    await createProject([{ type: 'docSpace', id: space.id }], 'active', 'case-9c');

    const provider = app.get(MemoryNominationHintProvider);
    // 两参调用（无 ctx）= 匿名 ⇒ 权限判定必不过 ⇒ 无候选
    const candidates = await provider.build(
      [{ name: 'doc.upserted', payload: { docId: crypto.randomUUID(), spaceId: space.id } }],
      null,
    );

    expect(candidates).toEqual([]);
  });

  it('⑨d 多 provider 共存：task 纪律码与提名码**同信封**（「首个胜出」退役的真库取证）', async () => {
    if (!dbAvailable) return;

    const { boardId, taskId } = await createBoardChain(`本条${RULING_WORD}`, 'case-9d');
    await createProject([{ type: 'board', id: boardId }], 'active', 'case-9d');

    // 完工 + 无评论 + 无关联文档 ⇒ 两个 provider 各产一条（task_hygiene + memory_nomination）
    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });
    expect(res.status).toBe(200);

    const codes = (allHintsOf(res.body) ?? []).map((hint) => hint.code);
    expect(codes).toContain(MEMORY_NOMINATION_HINT_CODE);
    expect(codes).toContain('task_done_without_report');
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑩ task 纪律族（task_hygiene provider）——真 PG：证据链 join / report 豁免 / 窗口压制
  // ══════════════════════════════════════════════════════════════════

  /** 取某 code 的条目（同一响应可能多 provider 并存 ⇒ 必须按 code 取值） */
  function codeOf(body: unknown, code: string): HintItem[] | undefined {
    const filtered = allHintsOf(body)?.filter((hint) => hint.code === code);
    return filtered && filtered.length > 0 ? filtered : undefined;
  }

  /** 造一个可用空间（⑩c/⑩d 的关联文档落它下面） */
  async function createSpace(label: string): Promise<string> {
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `hygiene space ${RUN} ${label}`,
        slug: `hygiene-space-${RUN}-${label}`,
        creatorId: agentAId,
        settings: {},
      }),
    );
    created.spaceIds.push(space.id);
    return space.id;
  }

  /** 关联一个文档到任务（`softDeleted=true` ⇒ 文档已软删） */
  async function linkDoc(taskId: string, spaceId: string, label: string, softDeleted = false) {
    const doc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId,
        path: `hygiene/${RUN}/${label}.md`,
        title: label,
        summary: null,
        contentHash: crypto.randomUUID(),
        sectionCount: 0,
        tags: [],
        source: 'native',
        createdBy: agentAId,
        ...(softDeleted ? { deletedAt: new Date() } : {}),
      }),
    );
    created.docIds.push(doc.id);
    await ds.query(`INSERT INTO task_doc_links (task_id, doc_id, created_by) VALUES ($1,$2,$3)`, [
      taskId,
      doc.id,
      agentAId,
    ]);
    return doc.id;
  }

  it('⑩a 完工 + 无评论 + 无关联文档 → task_done_without_report（无需任何项目绑定）', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10a');
    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(codeOf(res.body, 'task_done_without_report')).toHaveLength(1);
  });

  it('⑩b **有过任何评论即永久豁免**（触发人群刻意窄化）→ 完工后无该码', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10b');
    await req().post(`/tasks/${taskId}/comments`).send({ content: '先记一笔进度' });
    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(codeOf(res.body, 'task_done_without_report')).toBeUndefined();
  });

  it('⑩c 有指向**未软删**文档的关联 → 有证据 ⇒ 无该码', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10c');
    const spaceId = await createSpace('10c');
    await linkDoc(taskId, spaceId, 'alive');

    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(codeOf(res.body, 'task_done_without_report')).toBeUndefined();
  });

  it('⑩d 关联文档**已软删** → 证据不算数 ⇒ 仍提示（join `doc.deleted_at IS NULL` 的真库证明）', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10d');
    const spaceId = await createSpace('10d');
    await linkDoc(taskId, spaceId, 'soft-deleted', true);

    const res = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    // 铁律 #23：`task_doc_links` 是裸 uuid 中间表，软删语义只在 join 条件里——
    // 漏掉 `doc.deleted_at IS NULL` 会让这条变成假绿（提示静默消失）
    expect(codeOf(res.body, 'task_done_without_report')).toHaveLength(1);
  });

  it('⑩e 对**已完工**任务评论 → comment_on_done_task', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10e');
    await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    const res = await req().post(`/tasks/${taskId}/comments`).send({ content: '复盘一下' });

    expect(res.status).toBe(201);
    expect(codeOf(res.body, 'comment_on_done_task')).toHaveLength(1);
  });

  it('⑩f **report(status=done, comment) 不产出「复活码」**（via=report 豁免的真库取证）', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10f');
    const res = await req()
      .post(`/tasks/${taskId}/report`)
      .send({ status: 'done', comment: '已完工，附结果' });

    expect([200, 201]).toContain(res.status);
    // ① 复活码被 `via='report'` 豁免；② 完工缺证据码被「report 自己发的那条评论」豁免
    expect(codeOf(res.body, 'comment_on_done_task')).toBeUndefined();
    expect(codeOf(res.body, 'task_done_without_report')).toBeUndefined();
  });

  it('⑩g 复活再 done：同 actor 同 task 在窗口内第二次 done → 压制（刻意漏报，e2e 钉住）', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain(null, 'case-10g');
    const first = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });
    expect(codeOf(first.body, 'task_done_without_report')).toHaveLength(1);

    // 挪回进行中（复活）再完工：事实照常产生，但 6h 窗口压制（窗口键 = (actor, code, taskId)）
    await req().patch(`/tasks/${taskId}`).send({ status: 'in_progress' });
    const second = await req().patch(`/tasks/${taskId}`).send({ status: 'done' });

    expect(second.status).toBe(200);
    expect(codeOf(second.body, 'task_done_without_report')).toBeUndefined();
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑧ 绑定反查真 PG 回归（M1 补既存缺口：jsonb containment 走真库）
  // ══════════════════════════════════════════════════════════════════

  it('⑧ GET /memory/projects?bindingType=board&bindingId=<id> 真 PG 命中（containment 反查）', async () => {
    if (!dbAvailable) return;

    const { boardId } = await createBoardChain(null, 'case-8');
    const projectId = await createProject([{ type: 'board', id: boardId }], 'active', 'case-8');
    const otherProjectId = await createProject(
      [{ type: 'board', id: (await createBoardChain(null, 'case-8-other')).boardId }],
      'active',
      'case-8-other',
    );

    const res = await req().get(`/memory/projects?bindingType=board&bindingId=${boardId}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Envelope<{ items: Array<{ id: string }> }>).data.items.map(
      (i) => i.id,
    );
    expect(ids).toContain(projectId);
    // 绑的是别的 board ⇒ 不得被反查命中（谓词不是"全部返回"）
    expect(ids).not.toContain(otherProjectId);
  });
});
