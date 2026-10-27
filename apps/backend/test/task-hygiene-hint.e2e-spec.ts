/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - task 纪律族 `task_dependents_pending`（v1.94.0-dev，卡 04bb1801）的**端到端契约**：
 *     任务进入 review/done → 下游仍有**在办 blocks 依赖** → 响应 `data.hints[]` 出现该码
 *     （advisory：平台**不**自动解除依赖、**不**认定 review = 已交付）。
 *
 * [代码职责]
 *   - 钉住**下游查询的真库行为**（铁律 #23）：`task_dependencies` join `tasks` 上的
 *     blocks-only / `t.deleted_at IS NULL` / `t.status NOT IN (done, archived)` 四条谓词
 *     ——mock 单测只能断言 SQL 文本，**真 PG 才能证明它真的过滤掉了那些行**。
 *   - 钉住**窗口语义**：`resourceKey = {taskId}:{toStatus}` ⇒ review 与 done **各送达一次**，
 *     同态横跳被 6h 窗口压制（防疲劳的刻意漏报）。
 *   - 钉住 **report 路径**：`POST /tasks/:id/report`（内部 update → status_changed 事实）
 *     同样触发依赖引导；且同响应的另两码被各自的豁免规则压掉（via='report' + 有评论）。
 *   - 钉住 **data 键集封闭**与回显口径（只回 `{id,title,status}`，正文永不出现）。
 *   - ⑨–⑬ 钉住**撞重码**（`task_near_duplicate_suspected`，v1.95.0-dev）的端到端：真 HTTP
 *     `POST /tasks`（挂点在 create 内）与 `POST /tasks/batch`（批内互撞 + `sameBatch` +
 *     **不含自我撞题**的鉴别断言）、幂等重放无提示（replay 禁 emit 的产品口径）、
 *     系列/优先级/语义词三条负例护栏、白名单 tier2a 命中、done 同名不计候选。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.2「board 纪律族」/ §5（埋点与观测）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关联代码]
 *   - src/modules/task/task-hygiene-hint.provider.ts — 被判定的 provider（本文件的被测对象）
 *   - src/modules/task/task.service.ts — `task.status_changed` 事实挂点（update / reportResult）
 *   - src/modules/task/task-dependency.service.ts — 依赖读侧口径（provider 回显与它同口径）
 *   - src/hints/hint-registry.ts — `TASK_HYGIENE_DEFINITIONS`（6h 窗口）
 *   - src/config/app-hint-provider-chain.ts — 生产装配单源（本套件按它装配）
 *   - src/modules/task/task-hygiene-hint.provider.spec.ts — mock 侧判定矩阵（本文件补 SQL 行为面）
 *
 * [持久踩坑]
 *   HYG-E2E-CHAIN(链 = 生产单源 ⇒ 三个 provider 都要可解析): 本套件用
 *     `HINT_FACT_PROVIDER_CHAIN` 装配（不是手抄一份），而链里有 `MemoryNominationHintProvider`
 *     ⇒ **必须 import MemoryModule**（否则启动期 "Nest can't resolve dependencies"）。
 *     本套件不测提名判据（那是 memory-nomination-hint.e2e-spec 的职责），
 *     也不建记忆项目 ⇒ 提名码恒不产出，不影响本文件的按 code 断言。
 *   HYG-E2E-WINDOW(去重窗口是进程内单例): ⑥/⑦ 两条用例依赖窗口状态，**用例顺序有语义**
 *     ——**不要**把 `HintDedupService.reset()` 放进 beforeEach（那会让「第二次被压制」失去意义）。
 *     每条用例各自造**独立任务** ⇒ 不同 resourceKey，互不干扰（⑥ 内部刻意复用同一任务）。
 *   HYG-E2E-SHARED-DB(共享开发库): 全部数据带 RUN 后缀隔离；afterAll 先删子表再删父表
 *     （`task_dependencies` 有 CASCADE，显式先删只为把意图写清楚）。events / audit_logs
 *     无 FK，残留行无害、不清理（与 memory-nomination-hint.e2e-spec 同款处置）。
 * =============================================================================
 */

/**
 * 依赖引导提示 —— 真实 PG + 真实 HTTP 端到端套件。
 *
 * 为什么必须打真库：本能力的判据是一段 `task_dependencies ⋈ tasks` 的**过滤 SQL**
 * （blocks-only + 软删排除 + 状态排除）。mock 仓储只能证明「谓词被写进了查询」，
 * 证明「软删下游真的不算在等它」只有真 PG 能给出（铁律 #23）。
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
  TaskDependencyType,
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
import { Task } from '../src/database/entities/task.entity';
import { TaskDependency } from '../src/database/entities/task-dependency.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { TaskModule } from '../src/modules/task/task.module';
import { MemoryModule } from '../src/modules/memory/memory.module';
import { HintsModule } from '../src/modules/hints/hints.module';
import { HINT_FACT_PROVIDERS, HintInterceptor } from '../src/modules/hints/hint.interceptor';
import { HINT_FACT_PROVIDER_CHAIN } from '../src/config/app-hint-provider-chain';
import { TASK_HINT } from '../src/modules/task/task-hint.constants';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其它套件） */
const JWT_SECRET = 'task-hygiene-hint-e2e-secret';

/** 本次运行的唯一后缀：隔离数据（标题全带它） */
const RUN = `hyg-${Date.now().toString(36)}`;

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
class HygieneE2eAuthModule {}

/** 测试根模块：真库 + 真认证 + Task/Memory（链依赖）+ hint 基建（装配与生产同形） */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ jwt: { secret: JWT_SECRET, expiresIn: '2h' } })],
    }),
    // 生产由 AppModule 提供 EventEmitter（@Global）：TaskModule import EventModule，
    // 漏了它 = 启动期 "Nest can't resolve dependencies of the EventService"
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
    HygieneE2eAuthModule,
    CommonModule,
    PermissionModule,
    TaskModule,
    // **链里有提名 provider ⇒ 必须可解析**（见文件头 HYG-E2E-CHAIN）
    MemoryModule,
    HintsModule,
  ],
  providers: [
    // 与生产同序：信封拦截器在外、hint 拦截器在内
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HintInterceptor },
    // provider 链 = **生产单源常量**（不是手抄一份）
    {
      provide: HINT_FACT_PROVIDERS,
      useFactory: (...providers: unknown[]) => providers,
      inject: [...HINT_FACT_PROVIDER_CHAIN],
    },
  ],
})
class HygieneE2eModule {}

/** 响应信封 */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

/** 信封内的 hint 条目（断言用最小形状） */
interface HintItem {
  code: string;
  status: string;
  message: string;
  data?: Record<string, unknown>;
}

describe('task_dependents_pending（依赖引导）— 真实 PG + 真实 HTTP 集成', () => {
  let app: INestApplication;
  let ds: DataSource;
  let dbAvailable = false;

  let agentAId: string;
  let agentAKey: string;

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    boardIds: [] as string[],
    taskIds: [] as string[],
  };

  /** 带身份的 HTTP 助手（agent 通道 = 真 sha256 API Key 校验） */
  function req() {
    const agent = request(app.getHttpServer());
    return {
      patch: (path: string) => agent.patch(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
      post: (path: string) => agent.post(`${API_PREFIX}${path}`).set('X-API-Key', agentAKey),
    };
  }

  /** 取响应里某个 code 的条目（**键不出现 → undefined**）——同响应可能多 provider 并存 */
  function codeOf(body: unknown, code: string): HintItem[] | undefined {
    const hints = (body as Envelope<{ hints?: HintItem[] }>).data?.hints;
    const filtered = hints?.filter((hint) => hint.code === code);
    return filtered && filtered.length > 0 ? filtered : undefined;
  }

  /** 造「看板 → 列 → 任务」链（`creatorId = agent A` ⇒ 对任务有 write，PATCH 放行） */
  async function createBoardChain(label: string): Promise<{
    boardId: string;
    listId: string;
    taskId: string;
  }> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `hyg board ${RUN} ${label}`,
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
        name: `hyg list ${RUN} ${label}`,
        position: 0,
      }),
    );

    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `目标任务 ${RUN} ${label}`,
        description: null,
        position: 0,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);

    return { boardId: board.id, listId: list.id, taskId: task.id };
  }

  /** 在同一列下再挂一个任务（作为下游） */
  async function createDependentTask(
    listId: string,
    label: string,
    status: TaskStatus = TaskStatus.TODO,
  ): Promise<string> {
    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId,
        title: `下游任务 ${RUN} ${label}`,
        description: null,
        position: 1,
        status,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);
    return task.id;
  }

  /**
   * 造依赖：`任务A` 依赖 `任务B`（A 是依赖方，B 是被等待方）。
   *
   * 语义对齐 `task-dependency.service.addDependency(taskId, { dependsOnTaskId })`：
   * 本用例里「被等待的任务」= 进入 review/done 的那个（`dependsOnTaskId`）。
   */
  async function addDependency(
    taskId: string,
    dependsOnTaskId: string,
    type: TaskDependencyType = TaskDependencyType.BLOCKS,
  ): Promise<void> {
    await ds
      .getRepository(TaskDependency)
      .save(ds.getRepository(TaskDependency).create({ taskId, dependsOnTaskId, type }));
  }

  /** 软删一个任务（`Task.deletedAt` 是 select:false ⇒ 只能经仓储软删） */
  async function softDeleteTask(taskId: string): Promise<void> {
    await ds.getRepository(Task).softDelete(taskId);
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
        `[task-hygiene-hint e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }

    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('task_dependencies','tasks','board_lists')`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name).sort()).toEqual([
      'board_lists',
      'task_dependencies',
      'tasks',
    ]);
    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({ imports: [HygieneE2eModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: (
          await ds.getRepository(Actor).save(
            ds.getRepository(Actor).create({
              type: ActorType.HUMAN,
              displayName: `Hyg Owner ${RUN}`,
              status: AgentStatus.ACTIVE,
            }),
          )
        ).id,
        username: `hygowner${RUN}`.slice(0, 50),
        email: `hyg-owner-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(owner.id);

    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName: `Hyg Agent ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId: owner.id,
        name: `Hyg Agent ${RUN}`,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);

    const rawKey = `ask_hyg${RUN}`;
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
  }, 180000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();

    if (created.taskIds.length > 0) {
      // 依赖行有 CASCADE，显式先删只为把「子表先于父表」的意图写清楚
      await ds.query(`DELETE FROM task_dependencies WHERE depends_on_task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM task_dependencies WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM task_activities WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM task_comments WHERE task_id = ANY($1::uuid[])`, [
        created.taskIds,
      ]);
      await ds.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [created.taskIds]);
    }
    if (created.boardIds.length > 0) {
      await ds.query(`DELETE FROM board_lists WHERE board_id = ANY($1::uuid[])`, [
        created.boardIds,
      ]);
      await ds.query(`DELETE FROM boards WHERE id = ANY($1::uuid[])`, [created.boardIds]);
    }
    if (created.keyIds.length > 0) {
      await ds.query(`DELETE FROM api_keys WHERE id = ANY($1::uuid[])`, [created.keyIds]);
    }
    if (created.agentIds.length > 0) {
      await ds.query(`DELETE FROM agents WHERE id = ANY($1::uuid[])`, [created.agentIds]);
    }
    if (created.userIds.length > 0) {
      await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [created.userIds]);
    }
    if (created.actorIds.length > 0) {
      await ds.query(`DELETE FROM actors WHERE id = ANY($1::uuid[])`, [created.actorIds]);
    }
    await ds.destroy();
  }, 60000);

  // ─── 触发与过滤矩阵 ───────────────────────────────────────────────

  it('① review + 在办 blocks 下游 → 产出提示（data 键集封闭 + 回显口径 + 文案插值）', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-1');
    const downstreamA = await createDependentTask(listId, 'case-1-a', TaskStatus.IN_PROGRESS);
    const downstreamB = await createDependentTask(listId, 'case-1-b', TaskStatus.TODO);
    await addDependency(downstreamA, taskId);
    await addDependency(downstreamB, taskId);

    const res = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });

    expect(res.status).toBe(200);
    const hint = codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING);
    expect(hint).toHaveLength(1);
    expect(Object.keys(hint![0].data ?? {}).sort()).toEqual([
      'dependencyType',
      'dependents',
      'taskId',
      'toStatus',
      'totalCount',
    ]);
    expect(hint![0].data).toMatchObject({
      taskId,
      toStatus: 'review',
      dependencyType: 'blocks',
      totalCount: 2,
    });
    // 回显口径 = 读面同构 `{id,title,status}`（下游标题可见，正文不可见）
    const dependents = hint![0].data?.dependents as Array<Record<string, unknown>>;
    expect(dependents.map((d) => d.id).sort()).toEqual([downstreamA, downstreamB].sort());
    for (const dependent of dependents) {
      expect(Object.keys(dependent).sort()).toEqual(['id', 'status', 'title']);
    }
    // 文案是模板渲染（状态 + 数量 + 标题）
    expect(hint![0].message).toContain('任务已进入 review');
    expect(hint![0].message).toContain('仍有 2 个未完成下游任务依赖它');
    expect(hint![0].message).toContain(`下游任务 ${RUN} case-1-a`);
  });

  it('② relates_to / duplicates 依赖**不算**「在等它」（只有 blocks 表达下游被挡住）', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-2');
    const downstreamRelates = await createDependentTask(listId, 'case-2-relates');
    const downstreamDuplicates = await createDependentTask(listId, 'case-2-duplicates');
    await addDependency(downstreamRelates, taskId, TaskDependencyType.RELATES_TO);
    await addDependency(downstreamDuplicates, taskId, TaskDependencyType.DUPLICATES);

    const res = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });

    expect(res.status).toBe(200);
    expect(codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING)).toBeUndefined();
  });

  it('③ 下游全 done / archived → 不提示（「一切正常」不是提示素材）', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-3');
    const doneDownstream = await createDependentTask(listId, 'case-3-done', TaskStatus.DONE);
    const archivedDownstream = await createDependentTask(
      listId,
      'case-3-archived',
      TaskStatus.ARCHIVED,
    );
    await addDependency(doneDownstream, taskId);
    await addDependency(archivedDownstream, taskId);

    const res = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });

    expect(res.status).toBe(200);
    expect(codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING)).toBeUndefined();
  });

  it('④ 下游已**软删** → 不算在等它（`t.deleted_at IS NULL` 的真库证明，铁律 #23）', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-4');
    const downstream = await createDependentTask(listId, 'case-4-soft-deleted', TaskStatus.TODO);
    await addDependency(downstream, taskId);
    await softDeleteTask(downstream);

    const res = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });

    // `Task.deletedAt` 是 select:false ⇒ JS 侧过滤恒失效；漏掉 join 条件这条会假绿
    expect(res.status).toBe(200);
    expect(codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING)).toBeUndefined();
  });

  it('⑤ review → done **两跳各送达**（resourceKey 带 toStatus）', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-5');
    const downstream = await createDependentTask(listId, 'case-5-downstream');
    await addDependency(downstream, taskId);

    const first = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });
    expect(codeOf(first.body, TASK_HINT.DEPENDENTS_PENDING)).toHaveLength(1);
    expect(codeOf(first.body, TASK_HINT.DEPENDENTS_PENDING)![0].data?.toStatus).toBe('review');

    const second = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.DONE });
    expect(second.status).toBe(200);
    // 不同 resourceKey（`{taskId}:{toStatus}`）⇒ 窗口不压制第二跳
    const doneHint = codeOf(second.body, TASK_HINT.DEPENDENTS_PENDING);
    expect(doneHint).toHaveLength(1);
    expect(doneHint![0].data?.toStatus).toBe('done');
  });

  it('⑥ 同态横跳被 6h 窗口压制（review → in_progress → review：第二次不送达）', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-6');
    const downstream = await createDependentTask(listId, 'case-6-downstream');
    await addDependency(downstream, taskId);

    const first = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });
    expect(codeOf(first.body, TASK_HINT.DEPENDENTS_PENDING)).toHaveLength(1);

    await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.IN_PROGRESS });
    const second = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });

    // 事实照常产生，但窗口键 (actor, code, taskId:review) 6h 内命中 ⇒ 防疲劳的刻意漏报
    expect(second.status).toBe(200);
    expect(codeOf(second.body, TASK_HINT.DEPENDENTS_PENDING)).toBeUndefined();
  });

  it('⑦ report_task_result 路径同样送达；同响应另两码被各自豁免压掉', async () => {
    if (!dbAvailable) return;

    const { listId, taskId } = await createBoardChain('case-7');
    const downstream = await createDependentTask(listId, 'case-7-downstream');
    await addDependency(downstream, taskId);

    const res = await req()
      .post(`/tasks/${taskId}/report`)
      .send({ status: TaskStatus.DONE, comment: '已完工，附结果证据' });

    expect([200, 201]).toContain(res.status);
    // reportResult 内部走 update() ⇒ status_changed 事实照常产生 ⇒ 依赖引导送达
    expect(codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING)).toHaveLength(1);
    expect(codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING)![0].data?.toStatus).toBe('done');
    // 另两码：comment_on_done_task 被 `via='report'` 豁免；done_without_report 被「已有评论」豁免
    expect(codeOf(res.body, TASK_HINT.COMMENT_ON_DONE_TASK)).toBeUndefined();
    expect(codeOf(res.body, TASK_HINT.DONE_WITHOUT_REPORT)).toBeUndefined();
  });

  it('⑧ 无下游依赖 ⇒ 零提示（分母边界：没有下游就没有本码）', async () => {
    if (!dbAvailable) return;

    const { taskId } = await createBoardChain('case-8');
    const res = await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.REVIEW });

    expect(res.status).toBe(200);
    expect(codeOf(res.body, TASK_HINT.DEPENDENTS_PENDING)).toBeUndefined();
  });

  // ─── 撞重提示（`task_near_duplicate_suspected`，v1.95.0-dev） ───────────────
  // 这组用例必须走**真 HTTP POST /tasks**（挂点在 `create` 内，repo 直插不会产生事实）；
  // 负例一律**各自新建专用 board**（同板上的其它任务会污染「无提示」断言——见文件头
  // HYG-E2E-SHARED-DB 与 plan 的「负例专用 board」纪律）。

  /** 直插一张「已存在的卡」（造撞题对象） */
  async function seedTask(
    listId: string,
    title: string,
    status: TaskStatus = TaskStatus.TODO,
  ): Promise<string> {
    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId,
        title,
        description: null,
        position: 0,
        status,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);
    return task.id;
  }

  /** `POST /tasks`（登记返回的任务 id 供清理） */
  async function createTaskApi(
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown; id?: string }> {
    const res = await req().post('/tasks').send(body);
    const id = (res.body as Envelope<{ id?: string }>).data?.id;
    if (id) created.taskIds.push(id);
    return { status: res.status, body: res.body, id };
  }

  it('⑨ 带 clientRequestId 建撞题任务（MCP 主路径形态）→ 新码 + matches（matchedBy=tier1）', async () => {
    if (!dbAvailable) return;

    const { boardId, listId } = await createBoardChain('case-9');
    const existingId = await seedTask(listId, `修复登录bug ${RUN}`);

    const created9 = await createTaskApi({
      listId,
      title: `修复登录 bug ${RUN}`,
      clientRequestId: `dup9-${RUN}`,
    });

    expect([200, 201]).toContain(created9.status);
    const hint = codeOf(created9.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED);
    expect(hint).toHaveLength(1);
    // 信封 data 键集**封闭**（消费方只读这里）
    expect(Object.keys(hint![0].data ?? {}).sort()).toEqual([
      'boardId',
      'matches',
      'taskId',
      'totalCount',
    ]);
    expect(hint![0].data).toMatchObject({
      taskId: created9.id,
      boardId,
      totalCount: 1,
    });
    // matches 逐字段（含 sameBatch / matchedBy）
    const matches = hint![0].data?.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    expect(Object.keys(matches[0]).sort()).toEqual([
      'id',
      'matchedBy',
      'sameBatch',
      'status',
      'title',
    ]);
    expect(matches[0]).toMatchObject({
      id: existingId,
      title: `修复登录bug ${RUN}`,
      sameBatch: false,
      matchedBy: 'tier1',
    });
    // 文案是模板渲染（标题 + 计数）
    expect(hint![0].message).toContain(`修复登录bug ${RUN}`);
    expect(hint![0].message).toContain('共 1 个');
  });

  it('⑩ 同 clientRequestId 重放 → idempotentReplay 且**无**新提示（replay 禁 emit，产品口径钉死）', async () => {
    if (!dbAvailable) return;

    const { listId } = await createBoardChain('case-10');
    await seedTask(listId, `修复登录bug ${RUN}`);
    const key = `dup10-${RUN}`;

    // 自建前置（不依赖用例顺序）：首次调用真实写入 ⇒ 有提示
    const first = await createTaskApi({
      listId,
      title: `修复登录 bug ${RUN}`,
      clientRequestId: key,
    });
    expect(codeOf(first.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toHaveLength(1);

    // 同键重放：返回既有实体 + idempotentReplay，且**不进 create 事实路径** ⇒ 无提示
    const replay = await req()
      .post('/tasks')
      .send({
        listId,
        title: `修复登录 bug ${RUN}`,
        clientRequestId: key,
      });
    expect([200, 201]).toContain(replay.status);
    expect((replay.body as Envelope<{ idempotentReplay?: boolean }>).data?.idempotentReplay).toBe(
      true,
    );
    expect(codeOf(replay.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();
  });

  it('⑪ 批内互撞：batchCreate 两条同名 → 互相 sameBatch:true，且**都不含自我撞题**', async () => {
    if (!dbAvailable) return;

    const { listId } = await createBoardChain('case-11');
    const title = `冒烟批内互撞 ${RUN}`;

    const res = await req()
      .post('/tasks/batch')
      .send({
        tasks: [
          { listId, title },
          { listId, title },
        ],
      });

    expect([200, 201]).toContain(res.status);
    const items = (res.body as Envelope<{ items?: Array<{ id: string }> }>).data?.items ?? [];
    expect(items).toHaveLength(2);
    for (const item of items) created.taskIds.push(item.id);

    const hints = ((res.body as Envelope<{ hints?: HintItem[] }>).data?.hints ?? []).filter(
      (hint) => hint.code === TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
    );
    // 两条事实（各自 resourceKey = 自己的 taskId）⇒ 两条提示都送达（≤3 内）
    expect(hints).toHaveLength(2);

    for (const hint of hints) {
      const matches = hint.data?.matches as Array<Record<string, unknown>>;
      expect(matches).toHaveLength(1);
      // 撞的是**本批刚建**的兄弟卡
      expect(matches[0].sameBatch).toBe(true);
      // 鉴别断言：绝不含自我撞题（缓存不带 selfId 过滤，剔除在 per-fact 层——TASK-HYG-4）
      expect(matches[0].id).not.toBe(hint.data?.taskId);
      expect(items.map((item) => item.id)).toContain(matches[0].id as string);
    }
  });

  it('⑫ 系列护栏：序号 / 优先级 / 白名单外语义词 一律不提示（各用专用 board）', async () => {
    if (!dbAvailable) return;

    // ① 含数字序号（批量任务X1 vs X2）
    const serial = await createBoardChain('case-12-serial');
    await seedTask(serial.listId, `批量任务${RUN}X1`);
    const serialRes = await createTaskApi({ listId: serial.listId, title: `批量任务${RUN}X2` });
    expect(codeOf(serialRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();

    // ② 优先级形态（【P0】vs【P1】）——非白名单装饰，不剥
    const priority = await createBoardChain('case-12-priority');
    await seedTask(priority.listId, `【P0】冒烟${RUN}`);
    const priorityRes = await createTaskApi({
      listId: priority.listId,
      title: `【P1】冒烟${RUN}`,
    });
    expect(codeOf(priorityRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();

    // ③ 白名单**外**的承载区分语义词（前端 vs 后端）——看似装饰，实则区分
    const front = await createBoardChain('case-12-front');
    await seedTask(front.listId, `「前端」冒烟重构${RUN}`);
    const frontRes = await createTaskApi({
      listId: front.listId,
      title: `「后端」冒烟重构${RUN}`,
    });
    expect(codeOf(frontRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();
  });

  it('⑬ 白名单命中（tier2a）有提示；非重复标题 / 已完工同名 无提示（各用专用 board）', async () => {
    if (!dbAvailable) return;

    // ① 白名单装饰剥离后等值（「Bug」前缀）⇒ tier2a 命中
    const decorated = await createBoardChain('case-13-deco');
    const coreId = await seedTask(decorated.listId, `冒烟支付修复${RUN}`);
    const decoratedRes = await createTaskApi({
      listId: decorated.listId,
      title: `「Bug」冒烟支付修复${RUN}`,
    });
    const hint = codeOf(decoratedRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED);
    expect(hint).toHaveLength(1);
    expect(hint![0].data?.matches).toMatchObject([
      { id: coreId, matchedBy: 'tier2a', sameBatch: false },
    ]);

    // ② 非重复标题 ⇒ 无提示（分母边界）
    const unique = await createBoardChain('case-13-unique');
    await seedTask(unique.listId, `冒烟缓存清理${RUN}`);
    const uniqueRes = await createTaskApi({
      listId: unique.listId,
      title: `冒烟任务编排重构${RUN}`,
    });
    expect(codeOf(uniqueRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();

    // ③ 同名的**已完工**任务不算候选（done/archived 不进扫描）
    const done = await createBoardChain('case-13-done');
    await seedTask(done.listId, `冒烟支付回调${RUN}`, TaskStatus.DONE);
    const doneRes = await createTaskApi({
      listId: done.listId,
      title: `冒烟支付回调${RUN}`,
    });
    expect(codeOf(doneRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();

    // ④ 同名的**已软删**任务不算候选（`t.deleted_at IS NULL` 的真库面：`Task.deletedAt` 是
    //    select:false ⇒ JS 侧过滤恒失效，只有真 PG 能证明这条 SQL 条件真的在场）
    const soft = await createBoardChain('case-13-soft');
    const softTaskId = await seedTask(soft.listId, `冒烟软删同名${RUN}`);
    await softDeleteTask(softTaskId);
    const softRes = await createTaskApi({ listId: soft.listId, title: `冒烟软删同名${RUN}` });
    expect(codeOf(softRes.body, TASK_HINT.NEAR_DUPLICATE_SUSPECTED)).toBeUndefined();
  });
});
