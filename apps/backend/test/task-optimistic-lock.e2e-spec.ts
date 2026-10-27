/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §7. Tasks（PATCH /tasks/:id 的 expectedUpdatedAt + 409 契约）
 *   - 补充: docs/spec.md 任务节（并发语义）、docs/api-definition.md §18.7（"可选的锁 = 没有锁"
 *     的一般结论——本端点是**有意例外**）
 *   - 代码 Hook: apps/backend/src/modules/task/task.service.ts 的 update()/lockTaskForUpdate()/
 *     applyTaskUpdate()/finishTaskUpdate() 四段注释，以及 UpdateTaskDto.expectedUpdatedAt
 *
 * [踩坑索引]
 *   - LOCK-LOCKED-ROW（卡 09ffa9a8）: 乐观锁必须"锁内重读 + 锁内比对 + 锁内重跑权限"。
 *     先 findOne 比 token 再 save 是 TOCTOU 窗口：并发双写会**双双通过**后写覆盖前写
 *     （与 experience.service 的 M3 同款事故）。**本套件必须打真 PG**——铁律 #23：
 *     mock 单测桩掉 queryBuilder/事务，锁语义与 ORM SQL 生成完全无关，证不了任何东西。
 *   - LOCK-TOCTOU-PERM: controller 的第一份快照判权**不是充分条件**——并发 move 可在
 *     "判权"与"加锁"之间把任务换到当前 actor 无写权的 board。故 service 锁内基于**锁定行**
 *     重跑判定，且排在 token 比对之前（无权限 + stale token = 403 而非 409）。
 *   - LOCK-JS-COMPARE: token 只在 JS 侧比毫秒 getTime()。PG 的 UPDATE 由 TypeORM 追加
 *     `updated_at = CURRENT_TIMESTAMP`（typeorm/query-builder/UpdateQueryBuilder.js:403-407，
 *     列默认 NOW()）⇒ **微秒**精度（实测 tasks 55/55 行带微秒），读侧经 pg 驱动进 JS `Date`
 *     被**截到毫秒** ⇒ SQL 级时间等值谓词会静默不命中（症状是"一切 409"）。JS 侧毫秒等值
 *     才与 token 的表达能力（ISO 毫秒串）同域。已知限制 = 两次写的事务开始时刻落在同一毫秒
 *     （`CURRENT_TIMESTAMP` 取事务开始而非语句时刻）则 ABA 双通过。
 *   - LOCK-POOL-EXHAUST: 锁路径事务持 1 条连接，锁内权限重跑与派生写仍走全局 Repository
 *     （每条并发请求再借 1 条）；pg `Pool.connect()` 默认不超时 ⇒ 「带 token 的并发 PATCH 数
 *     ≥ poolSize」时**永久挂死**。本批把 poolSize 显式设为 PG_POOL_SIZE=20（抬高阈值，不消除）；
 *     真修法（事务 manager 透传）跨模块，需单独立卡。
 *   - LOCK-TOKEN-LEAK: `expectedUpdatedAt` 是锁 token 不是实体字段，必须剥在合并回环之外，
 *     否则经 toPlain() 的 `...task` 展开泄漏进 PATCH 响应（本套件用例 ① 有断言守卫）。
 *
 * [铁律关联] #23(ORM 语义须真 PG 覆盖) #17(测试契约) #18(不变量检查) #21/#22(4xx 而非 500)
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
 * PATCH /tasks/:id 可选乐观锁 —— 真实 PG 集成套件（卡 09ffa9a8）。
 *
 * 服务层等价于 HTTP 契约（沿用 task-list-projection / soft-deleted-login 套件范式）：
 * `PATCH /tasks/:id` → TaskService.update()、`POST /tasks/:id/report` →
 * TaskService.reportResult()（其内部状态步就是 update()）、`GET /tasks/:id` →
 * TaskService.findOne()（token 的捕获通道）。
 *
 * 覆盖（plan v3 测试契约逐条）：
 * ① **正向锚点**（必补）：GET 取 updatedAt → 原样回传 PATCH → 200 且内容已改。
 *    精度系统性错配的失败形态是"一切 409"，没有这条就没有探针；同时守卫
 *    "锁 token 不得泄漏进 PATCH 响应"。
 * ② stale token 顺序重放 → 409 + `data.currentUpdatedAt` 可取，且该值**立即可用**
 *    （原样回传即 200——证明回吐的是真 token 而不是同义词）。
 * ③ `Promise.allSettled` 并发双 PATCH（同一 token）→ **恰好一个成功**，且最终行内容
 *    = 成功者提交的那份（不依赖毫秒差：失败者被 FOR UPDATE 串行化后重读到胜者的
 *    updatedAt，必然不符）；失败者只留 409、不落事件/审计痕迹。
 * ④ 不带 token → 旧行为不变（回归：不进事务、不拿行锁）。
 * ⑤ `reportResult` 之后旧 token 409（最高频踩踏源：report 内部路径不传 token 但**会**
 *    推进 updated_at，使别人手里的 token 全部失效）。
 * ⑥ 无权限者带 token → **403 而非 409**，且并发 move（TOCTOU 场景）后同一调用也是 403
 *    ——证明判定用的是**锁定行**、且排在 token 比对之前。
 *
 * 环境约定（同 task-list-projection / soft-deleted-login 套件）：本地开发库
 * chamber-postgres（localhost:8744），PG 不可达整套降级跳过（`dbAvailable` 判定行打进
 * 日志，防"跳过也算绿"）；RUN 后缀隔离测试数据；afterAll 按 FK 依赖逆序硬删兜底清理。
 * ⚠️ 不导入 test-setup.ts（该文件 mock 掉 crypto/bcrypt），本套件用真实现。
 * ⚠️ 事件 / 活动日志 / 审计用 jest 替身（可断言"失败路径不留痕"）；其余协作方（权限
 * Policy、资源校验、ActorProfile）一律真实现——本套件的判定必须走真链路。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Task } from '../src/database/entities/task.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Milestone } from '../src/database/entities/milestone.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { TaskService } from '../src/modules/task/task.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { BoardPolicy } from '../src/common/policies/board.policy';
import { TaskPolicy } from '../src/common/policies/task.policy';
import { PermissionService } from '../src/common/services/permission.service';
import { ResourceValidator } from '../src/common/resource-validator';
import { ActorType, ErrorCode, TaskStatus, Visibility } from '@agent-chamber/shared';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次运行唯一后缀：隔离测试数据 */
const runSuffix = (): string => `tlock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * 无权限场景用的 board 创建者哨兵 id：`boards.creator_id` 无 FK 约束，
 * 且**绝不能**是真 actor——否则 BoardPolicy 的 isCreator 分支会放行。
 */
const OTHER_CREATOR_ID = '00000000-0000-4000-8000-0000000b0b0b';

/** 被断言异常的最小形状（NestJS HttpException 子集，避免引入类型耦合） */
interface CapturedHttpError {
  getStatus?: () => number;
  getResponse?: () => { message?: string; code?: number; data?: { currentUpdatedAt?: string } };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('PATCH /tasks/:id 可选乐观锁（LOCK-LOCKED-ROW）— 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let taskService: TaskService;

  /** 副作用替身：断言"冲突路径不留痕"用（事件 / 活动日志 / 审计） */
  const mockEventService = { create: jest.fn(async () => ({})) };
  const mockActivityRepo = { save: jest.fn(async (v: unknown) => v) };
  const mockAuditService = { log: jest.fn(async () => undefined) };

  /** 本运行创建的实体 id（afterAll 按 FK 依赖逆序硬删兜底） */
  const created = { boardIds: [] as string[], listIds: [] as string[], taskIds: [] as string[] };

  /** 有写权 actor（= 它自己创建的 board 之 creator） */
  const ownerActorId = '00000000-0000-4000-8000-0000000a0a0a';
  /** 无写权 actor（不是任何 board 的 creator，也没有 board_members 行） */
  const outsiderActorId = '00000000-0000-4000-8000-0000000c0c0c';

  const ownerActor = { id: ownerActorId, type: ActorType.HUMAN, name: 'Lock Owner' };
  const outsiderActor = { id: outsiderActorId, type: ActorType.HUMAN, name: 'Lock Outsider' };

  let boardId: string;
  let listId: string;
  /** 用例 ⑥ 用：他人私密 board + 其 list + 迁过去的任务 */
  let foreignBoardId: string;
  let foreignListId: string;

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
        `[task-optimistic-lock e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;
    // 正向判定行：完工报告贴运行输出时用它证"真跑"而不是降级跳过整套（铁律 #23）
    console.log(
      `[task-optimistic-lock e2e] dbAvailable=true (real PG ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database})`,
    );

    // ── 与生产同构的判定链路：真 Policy + 真 PermissionService ──
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const ownerProxy = new OwnerProxyService(ds.getRepository(Agent));
    const boardPolicy = new BoardPolicy(ds.getRepository(BoardMember), ownerProxy);
    const taskPolicy = new TaskPolicy(ds.getRepository(BoardList), boardPolicy, ownerProxy);
    // topic/docSpace/agent 三个 policy 是惰性的：本套件只喂 Task 实体，
    // PermissionService.can 的 duck-typing 会命中 isTask 分支（Task 无 creatorId/slug/lists）
    const permService = new PermissionService(
      {} as never,
      boardPolicy,
      {} as never,
      taskPolicy,
      {} as never,
    );

    taskService = new TaskService(
      ds.getRepository(Task),
      ds.getRepository(entities.TaskComment), // commentRepo（findOne 不内嵌 comments，但保真直连）
      mockActivityRepo as never, // activityRepo（副作用面替身）
      ds.getRepository(BoardList),
      ds.getRepository(Board),
      ds.getRepository(Milestone),
      ds.getRepository(entities.TaskDependency), // depRepo（findOne 的依赖投影走它）
      ds.getRepository(Agent),
      ds.getRepository(User),
      ds.getRepository(Actor),
      mockEventService as never, // eventService（副作用面替身）
      { getAccessibleBoardIds: async () => null } as never, // accessQuery（未触达）
      new ResourceValidator(),
      ds,
      ds.getRepository(entities.TaskDocLink),
      ds.getRepository(entities.Doc),
      ds.getRepository(entities.DocSpace),
      {} as never, // docSpacePolicy（未触达）
      actorProfileService,
      mockAuditService as never, // auditService（副作用面替身）
      permService,
    );

    // ── 测试数据：owner 自己的 board（写权来自 isCreator）+ 他人私密 board ──
    const s = runSuffix();
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `Lock Board ${s}`,
        topicId: null,
        creatorId: ownerActorId,
        settings: { visibility: Visibility.PRIVATE },
      }),
    );
    boardId = board.id;
    created.boardIds.push(board.id);

    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `Lock List ${s}`,
        position: 0,
        // mappedStatus 留空：避免 status 变更触发"list 吸附"改写 listId（本套件的判据不含它）
        mappedStatus: null,
      }),
    );
    listId = list.id;
    created.listIds.push(list.id);

    const foreignBoard = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `Lock Foreign Board ${s}`,
        topicId: null,
        creatorId: OTHER_CREATOR_ID, // 非 ownerActorId ⇒ BoardPolicy.write 的 isCreator 不命中
        settings: { visibility: Visibility.PRIVATE },
      }),
    );
    foreignBoardId = foreignBoard.id;
    created.boardIds.push(foreignBoard.id);

    const foreignList = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: foreignBoard.id,
        name: `Lock Foreign List ${s}`,
        position: 0,
        mappedStatus: null,
      }),
    );
    foreignListId = foreignList.id;
    created.listIds.push(foreignList.id);
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删：tasks（含 activity/dependency/comment 的 CASCADE）→ lists → boards
    for (const id of created.taskIds) {
      await ds.getRepository(Task).delete({ id });
    }
    for (const id of created.listIds) {
      await ds.getRepository(Task).delete({ listId: id });
      await ds.getRepository(BoardList).delete({ id });
    }
    for (const id of created.boardIds) {
      await ds.getRepository(Board).delete({ id });
    }
    await ds.destroy();
  }, 30000);

  // ───────────────────────── 助手 ─────────────────────────

  beforeEach(() => {
    mockEventService.create.mockClear();
    mockActivityRepo.save.mockClear();
    mockAuditService.log.mockClear();
  });

  /** 建一个任务（每个用例独立建，避免用例间互相污染 updatedAt） */
  async function seedTask(title: string, list = listId): Promise<string> {
    const task = await ds
      .getRepository(Task)
      .save(
        ds.getRepository(Task).create({ listId: list, title, description: 'seed description' }),
      );
    created.taskIds.push(task.id);
    return task.id;
  }

  /**
   * 取"详情响应形态"的 updatedAt —— 等价于 HTTP 上 `GET /tasks/:id` 后拿到的字符串。
   *
   * 必须复刻 wire 形态（JSON 把 Date 序列化成 ISO 毫秒串）：进程内直接 `String(date)`
   * 得到的是 `Thu Oct 16 2026 ...` 这种**非 ISO** 形态，用它当 token 是在测一个真实
   * 调用方永远不会发的载荷。
   */
  async function captureToken(taskId: string): Promise<string> {
    const detail = await taskService.findOne(taskId);
    return JSON.parse(JSON.stringify((detail as { updatedAt: Date }).updatedAt)) as string;
  }

  /** 直读库内行（断言真落盘，不信 service 的返回值） */
  async function readRow(taskId: string): Promise<Task> {
    const row = await ds.getRepository(Task).findOne({ where: { id: taskId } });
    if (!row) throw new Error(`task ${taskId} disappeared`);
    return row;
  }

  // ───────────────────────── ① 正向锚点 ─────────────────────────

  it('① 详情取 token 原样回传 PATCH → 200 且内容已改（锁不放行"一切 409"）', async () => {
    if (!dbAvailable) return;
    const taskId = await seedTask('lock-1-original');
    const token = await captureToken(taskId);

    const res = (await taskService.update(
      taskId,
      { title: 'lock-1-updated', expectedUpdatedAt: token },
      ownerActorId,
      ActorType.HUMAN,
      ownerActor,
    )) as Record<string, unknown>;

    expect(res.title).toBe('lock-1-updated');
    // 锁 token 不是实体字段：绝不能经 toPlain() 的 `...task` 展开泄漏进响应
    expect(res.expectedUpdatedAt).toBeUndefined();
    expect('expectedUpdatedAt' in res).toBe(false);
    // 真落盘
    expect((await readRow(taskId)).title).toBe('lock-1-updated');
    // 成功路径的副作用照常发生（锁路径 = 提交之后跑）
    expect(mockEventService.create).toHaveBeenCalledTimes(1);
    expect(mockAuditService.log).toHaveBeenCalledTimes(1);
  });

  // ───────────────────────── ② stale token 顺序重放 ─────────────────────────

  it('② 旧 token 顺序重放 → 409 RESOURCE_CONFLICT + data.currentUpdatedAt 立即可复用', async () => {
    if (!dbAvailable) return;
    const taskId = await seedTask('lock-2-original');
    const staleToken = await captureToken(taskId);
    // 拉开与 token 时间戳的距离：下一次写的事务开始时刻若与 token 落在同一毫秒，
    // 新写入的 updated_at 截到毫秒后仍等于旧 token ⇒ 旧 token **没有**失效，重放会 200
    // （毫秒 ABA 窗口，见文件头 LOCK-JS-COMPARE）。与用例 ③ 同款隔离。
    await sleep(5);

    // 先做一次合法写（token 随即失效）
    const first = (await taskService.update(
      taskId,
      { title: 'lock-2-first', expectedUpdatedAt: staleToken },
      ownerActorId,
      ActorType.HUMAN,
      ownerActor,
    )) as Record<string, unknown>;
    expect(first.title).toBe('lock-2-first');

    // 清掉第一次合法写的副作用计数——下面只断言"冲突这一次不留痕"
    mockEventService.create.mockClear();
    mockActivityRepo.save.mockClear();
    mockAuditService.log.mockClear();

    // 再用旧 token 重放 → 409 + data.currentUpdatedAt
    const err = (await taskService
      .update(
        taskId,
        { title: 'lock-2-loser', expectedUpdatedAt: staleToken },
        ownerActorId,
        ActorType.HUMAN,
        ownerActor,
      )
      .catch((e: unknown) => e)) as CapturedHttpError;
    expect(err.getStatus?.()).toBe(409);
    const body = err.getResponse?.() as { message?: string; code?: number; data?: unknown };
    expect(body.code).toBe(ErrorCode.RESOURCE_CONFLICT);
    // message 是教学化契约稿：含重读指引 + "别用同一个 token 重试"
    expect(body.message).toContain('Re-read it (GET /tasks/:id)');
    expect(body.message).toContain('do NOT retry with the same token');
    const current = (body.data as { currentUpdatedAt?: string })?.currentUpdatedAt;
    expect(typeof current).toBe('string');

    // 冲突路径不留痕（副作用在提交后，事务抛错就不会跑到）
    expect(mockEventService.create).not.toHaveBeenCalled();
    expect(mockAuditService.log).not.toHaveBeenCalled();
    // 失败者的写没有落盘
    expect((await readRow(taskId)).title).toBe('lock-2-first');

    // 回吐的 currentUpdatedAt **立即可用**（原样回传 → 200）：证明它是真 token
    const retry = (await taskService.update(
      taskId,
      { title: 'lock-2-retry', expectedUpdatedAt: current },
      ownerActorId,
      ActorType.HUMAN,
      ownerActor,
    )) as Record<string, unknown>;
    expect(retry.title).toBe('lock-2-retry');
    expect((await readRow(taskId)).title).toBe('lock-2-retry');
  });

  // ───────────────────────── ③ 并发双写 ─────────────────────────

  it('③ Promise.allSettled 并发双 PATCH（同 token）→ 恰好一个成功，最终内容 = 胜者那份', async () => {
    if (!dbAvailable) return;
    const taskId = await seedTask('lock-3-original');
    const token = await captureToken(taskId);
    // 拉开与 token 时间戳的距离：让"胜者写入的新 updatedAt"必然 ≠ token
    // （否则若两次写落在同一毫秒，"恰好一个成功"就退化成了概率断言）
    await sleep(5);

    const results = await Promise.allSettled([
      taskService.update(
        taskId,
        { title: 'lock-3-A', expectedUpdatedAt: token },
        ownerActorId,
        ActorType.HUMAN,
        ownerActor,
      ),
      taskService.update(
        taskId,
        { title: 'lock-3-B', expectedUpdatedAt: token },
        ownerActorId,
        ActorType.HUMAN,
        ownerActor,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // 恰好一个成功：两个都成功 = 丢更新（锁没生效）；两个都失败 = 锁把合法写也挡了
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const loserErr = rejected[0].reason as CapturedHttpError;
    expect(loserErr.getStatus?.()).toBe(409);
    expect((loserErr.getResponse?.() as { code?: number }).code).toBe(ErrorCode.RESOURCE_CONFLICT);

    // 最终行 = 胜者提交的那一份（不依赖毫秒差）
    const winnerTitle = (fulfilled[0] as PromiseFulfilledResult<Record<string, unknown>>).value
      .title as string;
    expect(['lock-3-A', 'lock-3-B']).toContain(winnerTitle);
    expect((await readRow(taskId)).title).toBe(winnerTitle);
    // 副作用只发生一次（失败者在事务里抛出，没跑到提交后的副作用阶段）
    expect(mockEventService.create).toHaveBeenCalledTimes(1);
    expect(mockActivityRepo.save).toHaveBeenCalledTimes(1);
  });

  // ───────────────────────── ④ 无锁回归 ─────────────────────────

  it('④ 不带 token → 旧行为不变（无锁写照常成功，回归）', async () => {
    if (!dbAvailable) return;
    // ⚠️ "不进事务 / 不拿行锁"那半句**不在本套件断言**：真 PG 侧无法观测"有没有拿行锁"。
    // 该断言由单测代偿（task.service.spec.ts「不传 token → 不进事务」查
    // `dataSource.transaction` 未被调用）。本套件只钉"无 token 的写仍然成功"。
    const taskId = await seedTask('lock-4-original');

    const res = (await taskService.update(
      taskId,
      { title: 'lock-4-updated' },
      ownerActorId,
      ActorType.HUMAN,
      ownerActor,
    )) as Record<string, unknown>;
    expect(res.title).toBe('lock-4-updated');
    expect((await readRow(taskId)).title).toBe('lock-4-updated');
  });

  // ───────────────────────── ⑤ reportResult 使旧 token 失效 ─────────────────────────

  it('⑤ reportResult 之后旧 token → 409（report 内部路径不传 token 但会推进 updated_at）', async () => {
    if (!dbAvailable) return;
    const taskId = await seedTask('lock-5-original');
    const token = await captureToken(taskId);
    // 同前：report 内部那次写若与 token 落在同一毫秒，旧 token 不会失效（毫秒 ABA 窗口）
    await sleep(5);

    const report = await taskService.reportResult(taskId, { status: TaskStatus.DONE }, ownerActor);
    expect((report.task as { status?: string }).status).toBe(TaskStatus.DONE);

    const err = (await taskService
      .update(
        taskId,
        { title: 'lock-5-after-report', expectedUpdatedAt: token },
        ownerActorId,
        ActorType.HUMAN,
        ownerActor,
      )
      .catch((e: unknown) => e)) as CapturedHttpError;
    expect(err.getStatus?.()).toBe(409);
    expect((err.getResponse?.() as { code?: number }).code).toBe(ErrorCode.RESOURCE_CONFLICT);
    expect((await readRow(taskId)).title).toBe('lock-5-original');
  });

  // ───────────────────────── ⑥ 锁内重跑权限（TOCTOU） ─────────────────────────

  it('⑥ 无权限者带 token → 403 而非 409；并发 move 后判定仍基于锁定行', async () => {
    if (!dbAvailable) return;
    // (a) 任务在**他人私密 board**：outsider 不是 creator、无 board_members 行
    const foreignTaskId = await seedTask('lock-6-foreign', foreignListId);
    const foreignToken = await captureToken(foreignTaskId);

    const forbidden = (await taskService
      .update(
        foreignTaskId,
        { title: 'lock-6-should-not-happen', expectedUpdatedAt: foreignToken },
        outsiderActorId,
        ActorType.HUMAN,
        outsiderActor,
      )
      .catch((e: unknown) => e)) as CapturedHttpError;
    expect(forbidden.getStatus?.()).toBe(403);
    expect((forbidden.getResponse?.() as { code?: number }).code).toBe(ErrorCode.PERMISSION_DENIED);
    expect((await readRow(foreignTaskId)).title).toBe('lock-6-foreign');

    // (b) TOCTOU 形态：任务先在「当前 actor 有写权」的 board，随后被并发 move 到他人 board，
    //     此时同一请求必须 403。⚠️ 本套件**直调 service**（控制器那份快照从未参与过），
    //     故这里能证明的是：锁内判定读到的 listId 是被 move 改写后的值（⇒ 403）；
    //     "判定排在 token 比对之前"由 (b-1) 的鉴别性体现（stale token 也必须是 403 而非 409，
    //     而 409 才是"只比 token"的自然产物）。「用的是锁定行而不是控制器快照」这一条由代码
    //     结构保证（lockTaskForUpdate → ensureCan(task)），不由本套件断言。
    const movedTaskId = await seedTask('lock-6-moved', listId);
    const beforeMoveToken = await captureToken(movedTaskId);
    // 模拟并发 move（直接改 list_id；显式推进 updated_at，与 TypeORM 的 @UpdateDateColumn 同款）
    await ds
      .getRepository(Task)
      .update({ id: movedTaskId }, { listId: foreignListId, updatedAt: new Date() });

    // (b-1) 拿 move 之前的 token → 若只比 token 会得 409；必须先是 403（判权在比对之前）
    const afterMoveStale = (await taskService
      .update(
        movedTaskId,
        { title: 'lock-6-moved-a', expectedUpdatedAt: beforeMoveToken },
        outsiderActorId,
        ActorType.HUMAN,
        outsiderActor,
      )
      .catch((e: unknown) => e)) as CapturedHttpError;
    expect(afterMoveStale.getStatus?.()).toBe(403);

    // (b-2) 拿 move 之后的**新鲜** token → 也是 403（排除了"只是 token 过期"的解释）
    const afterMoveFresh = await captureToken(movedTaskId);
    const stillForbidden = (await taskService
      .update(
        movedTaskId,
        { title: 'lock-6-moved-b', expectedUpdatedAt: afterMoveFresh },
        outsiderActorId,
        ActorType.HUMAN,
        outsiderActor,
      )
      .catch((e: unknown) => e)) as CapturedHttpError;
    expect(stillForbidden.getStatus?.()).toBe(403);
    expect((await readRow(movedTaskId)).title).toBe('lock-6-moved');
  });

  // ───────────────────────── 环境自证 ─────────────────────────

  it('套件确实打了真 PG（dbAvailable 判定行）', () => {
    expect(dbAvailable).toBe(true);
  });
});
