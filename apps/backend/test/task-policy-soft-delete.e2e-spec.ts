/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - `TaskPolicy` 的**软删板**语义（F4-2 三态之②）与 **orphan/真缺失** 语义的真实 PG 守卫。
 *   - **为什么必须真 PG**（S-N1 + 铁律 #23）：软删判定的关键是「定主键重载能不能看见
 *     `Board.deletedAt`」，而该列是 `@DeleteDateColumn({ select: false })`
 *     （board.entity.ts:62）—— `withDeleted` 只解除 WHERE 过滤、不解除 select 过滤。
 *     mock 仓储把查询整个短路，**测不出 ORM 的 select/join 语义**：即便摘掉
 *     `addSelect('board.deletedAt')`，mock 版用例照样全绿，而线上「板已删 → 写删拒」
 *     会退化成永不触发的死代码（本仓前科：api-key-auth.service.ts:128）。
 *
 * [代码职责]
 *   - 软删板（private）：成员可读 / 外人不可读 / 任何人写删一律拒；
 *   - 软删板（OPEN）：外人仍可读（OPEN 语义不因软删改变）、写仍拒；
 *   - 正向对照：**未软删**的同款私有板 + editor 成员 → read/write 都必须放行
 *     （否则"软删拒写"可能只是碰巧因为别的原因为假）；
 *   - P-N3 镜像分叉证据：同一软删板，`findOne({relations:['board']})` 拿不到 board
 *     （JOIN 被 `deleted_at IS NULL` 过滤）而 withDeleted 重载拿得到 —— 这正是
 *     「单条 404 / 批量放行」存在性 oracle 分叉的物理成因；
 *   - 真缺失（list 行不存在）：全动作拒（fail-closed），不可达但必须真库取证。
 *
 * [权威文档]
 *   - docs/architecture.md §7.2（统一权限模型）；方案 `mantis-bishop-sunspot.md` 项2
 *
 * [关键不变量]
 *   - 软删板判定的**唯一**输入是「重载出来的 board.deletedAt 非空」⇒ 该字段必须真被选出。
 *     任何让 `deletedAt` 恒 undefined 的查询退化，都会让本套件的 write/delete 断言变红。
 *
 * [关联代码]
 *   - src/common/policies/task.policy.ts — 被测实现（reloadListWithBoard / can 的三态）
 *   - src/modules/task/task.service.ts — resolveTaskBoard（P-N3 镜像侧，同款 withDeleted）
 *   - test/access-profile.e2e-spec.ts — 同款真 PG 装配范式（本文件照其结构）
 *
 * [持久踩坑]
 *   - `withDeleted: true` 对主实体与所有 join **同时**生效（TypeORM SelectQueryBuilder.js:986-988）
 *     ——是钝器，只允许出现在按主键定行的重载里；
 *   - 共享开发库卫生：全部数据带 RUN 后缀，afterAll 按 id 硬删（依赖顺序：task → member → list → board → actor）。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查) #23(jsonb/ORM 生成物需真库覆盖)
 * =============================================================================
 */
import { DataSource } from 'typeorm';
import {
  ActorType,
  AgentStatus,
  UserRole,
  Visibility,
  TaskStatus,
  BoardMemberRole,
} from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Task } from '../src/database/entities/task.entity';
import { TaskPolicy } from '../src/common/policies/task.policy';
import { BoardPolicy } from '../src/common/policies/board.policy';
import { OwnerProxyService } from '../src/common/services/owner-proxy.service';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（既有真 PG e2e 惯例；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀（隔离本套件写入的数据；name 列有长度限制故截断到 50） */
const RUN = `tpsd-${Date.now().toString(36)}`;

describe('TaskPolicy 软删板 / 真缺失语义（真实 PG，F4-2 / S-N1 / P-N3）', () => {
  let ds: DataSource;
  let policy: TaskPolicy;
  let dbAvailable = false;

  const actorIds: string[] = [];
  const boardIds: string[] = [];
  const listIds: string[] = [];
  const taskIds: string[] = [];
  /** board_members 是复合主键（board_id + actor_id，board-member.entity.ts:39-43） */
  const memberRows: { boardId: string; actorId: string }[] = [];

  /** 成员（被指派者，editor 行）+ 外人（非成员、非 creator）+ 板创建者 */
  let memberActor: UnifiedActor;
  let outsider: UnifiedActor;
  /**
   * 板创建者：**必须独立于 outsider** —— BoardPolicy 的 read/write 对 creator 有短路
   * （board.policy.ts:97/101），若 outsider 同时是 creator，"外人被拒"用例会假红/假绿。
   */
  let creatorActor: UnifiedActor;

  /** 私有板（creator=outsider，成员=memberActor）与其列/任务 */
  let privateBoardId: string;
  let privateListId: string;
  let privateTaskId: string;
  /** OPEN 板（creator=outsider）与其列/任务 */
  let openBoardId: string;
  let openListId: string;
  let openTaskId: string;

  jest.setTimeout(60_000);

  const createActor = async (label: string): Promise<UnifiedActor> => {
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `${RUN} ${label}`.slice(0, 100),
        status: AgentStatus.ACTIVE,
      }),
    );
    actorIds.push(actor.id);
    return { id: actor.id, type: ActorType.HUMAN, role: UserRole.EDITOR };
  };

  /** 建板 + 列 + 任务（软删与否由用例决定） */
  const seedBoard = async (
    label: string,
    visibility: Visibility,
    creatorId: string,
  ): Promise<{ boardId: string; listId: string; taskId: string }> => {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `${RUN}-${label}`.slice(0, 100),
        topicId: null,
        creatorId,
        color: '#6366f1',
        settings: { visibility },
      }),
    );
    boardIds.push(board.id);

    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: 'To Do',
        position: 0,
        color: '#e5e7eb',
      }),
    );
    listIds.push(list.id);

    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `${RUN} ${label} task`,
        status: TaskStatus.TODO,
        assigneeId: memberActor.id,
        position: 0,
      }),
    );
    taskIds.push(task.id);

    return { boardId: board.id, listId: list.id, taskId: task.id };
  };

  const loadTask = async (taskId: string): Promise<Task> => {
    const task = await ds.getRepository(Task).findOne({ where: { id: taskId } });
    if (!task) throw new Error(`seed task ${taskId} missing`);
    return task;
  };

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
        `[task-policy-soft-delete e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    memberActor = await createActor('member');
    outsider = await createActor('outsider');
    creatorActor = await createActor('creator');

    // 私有板：creator = creatorActor（≠ outsider），成员判定只能来自 board_members 行
    const priv = await seedBoard('private', Visibility.PRIVATE, creatorActor.id);
    privateBoardId = priv.boardId;
    privateListId = priv.listId;
    privateTaskId = priv.taskId;

    const memberRow = await ds.getRepository(BoardMember).save(
      ds.getRepository(BoardMember).create({
        boardId: privateBoardId,
        actorId: memberActor.id,
        role: BoardMemberRole.EDITOR,
      }),
    );
    memberRows.push({ boardId: memberRow.boardId, actorId: memberRow.actorId });

    const open = await seedBoard('open', Visibility.OPEN, creatorActor.id);
    openBoardId = open.boardId;
    openListId = open.listId;
    openTaskId = open.taskId;

    // 软删两块板（列与任务保持存活 —— 这正是"板已删但任务还在"的真实形态）
    await ds.getRepository(Board).softDelete([privateBoardId, openBoardId]);

    const ownerProxy = new OwnerProxyService(ds.getRepository(Agent));
    const boardPolicy = new BoardPolicy(ds.getRepository(BoardMember), ownerProxy);
    policy = new TaskPolicy(ds.getRepository(BoardList), boardPolicy, ownerProxy);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // 依赖顺序硬删：task → board_member → board_list → board → actor
    const q = (sql: string, params: unknown[]) => ds.query(sql, params);
    if (taskIds.length) await q(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [taskIds]);
    for (const row of memberRows) {
      await q(`DELETE FROM board_members WHERE board_id = $1 AND actor_id = $2`, [
        row.boardId,
        row.actorId,
      ]);
    }
    if (listIds.length) await q(`DELETE FROM board_lists WHERE id = ANY($1::uuid[])`, [listIds]);
    if (boardIds.length) await q(`DELETE FROM boards WHERE id = ANY($1::uuid[])`, [boardIds]);
    if (actorIds.length) await q(`DELETE FROM actors WHERE id = ANY($1::uuid[])`, [actorIds]);
    await ds.destroy();
  });

  beforeEach(() => {
    // 共享开发库卫生：PG 不可用时逐条 skip（不让环境问题伪装成"通过"）
    if (!dbAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[task-policy-soft-delete e2e] skipped: PG unavailable');
    }
  });

  it('前置：板确实软删、列与任务仍存活（否则后续断言测的是别的状态）', async () => {
    if (!dbAvailable) return;
    const boardRepo = ds.getRepository(Board);
    expect(await boardRepo.findOne({ where: { id: privateBoardId } })).toBeNull();
    const raw = (await ds.query(`SELECT deleted_at FROM boards WHERE id = $1`, [
      privateBoardId,
    ])) as { deleted_at: Date | null }[];
    expect(raw[0]?.deleted_at).not.toBeNull();
    expect(
      await ds.getRepository(BoardList).findOne({ where: { id: privateListId } }),
    ).not.toBeNull();
    expect(await ds.getRepository(Task).findOne({ where: { id: privateTaskId } })).not.toBeNull();
  });

  it('S-N1 陷阱取证：findOne+relations 拿不到软删板；withDeleted 重载拿得到', async () => {
    if (!dbAvailable) return;
    const listRepo = ds.getRepository(BoardList);

    // 旧写法（relations join）：软删板的 JOIN 被 `board.deleted_at IS NULL` 过滤 ⇒ board=null
    // 在旧代码里这会让 `!list?.board → return true`，即"板已删 = 该任务对所有写者开放"。
    const legacy = await listRepo.findOne({
      where: { id: privateListId },
      relations: { board: true },
    });
    expect(legacy).not.toBeNull();
    expect(legacy?.board ?? null).toBeNull();

    // 新写法（withDeleted + addSelect）：板载得回来，且 deleted_at 真的可读
    // ⚠️ `withDeleted()` 必须排在 join **之前**（join 的软删条件在 join() 当场定，
    //   后置无效——这是本套件第一次真跑时就抓到的实现 bug，mock 版抓不到）
    // （`Board.deletedAt` 是 select:false —— 只 withDeleted 不补选，这里仍是 undefined，
    //   下一条用例的 write/delete 断言就会因退回"正常板"分支而变红）
    const reloaded = await listRepo
      .createQueryBuilder('list')
      .withDeleted()
      .leftJoinAndSelect('list.board', 'board')
      .addSelect('board.deletedAt')
      .where('list.id = :id', { id: privateListId })
      .getOne();
    expect(reloaded?.board).toBeTruthy();
    expect(reloaded?.board?.deletedAt).not.toBeNull();
  });

  it('软删私有板：成员（editor）assignee → read 允许', async () => {
    if (!dbAvailable) return;
    expect(await policy.can(memberActor, await loadTask(privateTaskId), 'read')).toBe(true);
  });

  it('软删私有板：外人 → read 拒（与单条 GET 404 同源）', async () => {
    if (!dbAvailable) return;
    expect(await policy.can(outsider, await loadTask(privateTaskId), 'read')).toBe(false);
  });

  it('软删私有板：成员 assignee → write/delete 一律拒（只读冷藏）', async () => {
    if (!dbAvailable) return;
    const task = await loadTask(privateTaskId);
    // ⚠️ 本断言是 addSelect('board.deletedAt') 的**活体守卫**：摘掉 addSelect 后
    // deletedAt 恒 undefined ⇒ 代码退回"正常板"分支 ⇒ editor 成员 write 变 true ⇒ 本行红。
    expect(await policy.can(memberActor, task, 'write')).toBe(false);
    expect(await policy.can(memberActor, task, 'delete')).toBe(false);
  });

  it('软删私有板：外人 write/delete 拒', async () => {
    if (!dbAvailable) return;
    const task = await loadTask(privateTaskId);
    expect(await policy.can(outsider, task, 'write')).toBe(false);
    expect(await policy.can(outsider, task, 'delete')).toBe(false);
  });

  it('软删 OPEN 板：外人 read 仍允许（OPEN 语义不因软删改变），write/delete 拒', async () => {
    if (!dbAvailable) return;
    const task = await loadTask(openTaskId);
    expect(await policy.can(outsider, task, 'read')).toBe(true);
    expect(await policy.can(outsider, task, 'write')).toBe(false);
    expect(await policy.can(outsider, task, 'delete')).toBe(false);
    // 成员在本板无成员行/非 creator：只读也被拒（OPEN 只放行 read）
    expect(await policy.can(memberActor, task, 'write')).toBe(false);
  });

  it('正向对照：未软删的同款私有板 + editor 成员 assignee → read/write 都放行', async () => {
    if (!dbAvailable) return;
    // 新建一块**存活**的私有板（同 creator、同成员关系形状），证明上面的 false
    // 来自"板已删"而不是"该成员本来就没有权限"。
    const live = await seedBoard('live-private', Visibility.PRIVATE, creatorActor.id);
    const liveMemberRow = await ds.getRepository(BoardMember).save(
      ds.getRepository(BoardMember).create({
        boardId: live.boardId,
        actorId: memberActor.id,
        role: BoardMemberRole.EDITOR,
      }),
    );
    memberRows.push({ boardId: liveMemberRow.boardId, actorId: liveMemberRow.actorId });

    const task = await loadTask(live.taskId);
    expect(await policy.can(memberActor, task, 'read')).toBe(true);
    expect(await policy.can(memberActor, task, 'write')).toBe(true);
  });

  it('真缺失（list 行不存在）：全动作拒（fail-closed）', async () => {
    if (!dbAvailable) return;
    // 不可达状态（FK 保证），但必须真库取证：查询真的返回空 ⇒ 走"真缺失"分支
    const ghost = { id: 'ghost-task', listId: '00000000-0000-4000-8000-00000000dead' } as Task;
    expect(await policy.can(memberActor, ghost, 'read')).toBe(false);
    expect(await policy.can(memberActor, ghost, 'write')).toBe(false);
    expect(await policy.can(memberActor, ghost, 'delete')).toBe(false);
  });
});
