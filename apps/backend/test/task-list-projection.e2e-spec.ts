/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §7. Tasks（/tasks item 扁平化 + sort 参数）
 *   - 补充: plan forge-jubilee-robin.md Workstream A（WS-A 扁平化 + statusPriority）
 *
 * [踩坑索引]
 *   - WS-A: leftJoin+addSelect 部分水合是仓内首次使用——ORM 行为 mock 测不出
 *     （铁律 #23 精神），本套件直连真 PG 验证：list/board 只水合选中列、
 *     item 无嵌套键、listId/boardName/listName 派生正确、statusPriority 排序生效
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
 * Task 列表投影扁平化 + statusPriority 排序 —— 真实 PG 集成套件（WS-A，2026-08-27）
 *
 * 覆盖（plan forge-jubilee-robin.md Workstream A）：
 * ① findAll 的 leftJoin+addSelect 部分水合：item 无 list/board/dependencies/dependents
 *   嵌套键，含扁平 listId/boardName/listName（真 PG 验证，mock 测不出 ORM 水合行为）；
 * ② 默认排序 createdAt DESC 不变；
 * ③ sort=statusPriority 排序生效：in_progress > todo > blocked > backlog > 其余
 *   （review/done/archived 恒末位）。
 *
 * 与 deleted-actor-projection.e2e-spec.ts 同款环境约定：本地开发库 chamber-postgres
 * （localhost:8744），PG 不可达整套降级跳过；RUN 后缀隔离测试数据，afterAll 按 FK
 * 依赖逆序硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import { TaskStatus } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { TaskService } from '../src/modules/task/task.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { Task } from '../src/database/entities/task.entity';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 每次生成唯一后缀：隔离测试数据（同进程多用例串行，模块级常量会跨用例复用导致唯一冲突） */
const runSuffix = (): string => `ws-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('Task 列表投影扁平化 + statusPriority 排序 — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;
  let taskService: TaskService;

  /** 本次运行创建的实体 id（afterAll 按 FK 依赖逆序清理） */
  const created: { boardId?: string; listId?: string; taskIds: string[] } = { taskIds: [] };

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
        `[task-list-projection e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // 与生产同构直连：TaskService 其余依赖用空 mock（本套件只走 findAll 路径，
    // 不触达事件/权限/事务）；accessQuery 返回 null = admin 语义（不过滤 board）
    const actorProfileService = new ActorProfileService(
      ds.getRepository(entities.Actor),
      ds.getRepository(entities.Agent),
      ds.getRepository(entities.User),
    );
    taskService = new TaskService(
      ds.getRepository(Task),
      ds.getRepository(entities.TaskComment),
      ds.getRepository(entities.TaskActivity),
      ds.getRepository(BoardList),
      ds.getRepository(Board),
      ds.getRepository(entities.Milestone),
      ds.getRepository(entities.TaskDependency),
      ds.getRepository(entities.Agent),
      ds.getRepository(entities.User),
      ds.getRepository(entities.Actor),
      {} as never, // eventService（未触达）
      { getAccessibleBoardIds: async () => null } as never, // accessQuery（admin 语义）
      {} as never, // resourceValidator（未触达）
      {} as never, // dataSource（未触达）
      ds.getRepository(entities.TaskDocLink),
      ds.getRepository(entities.Doc),
      ds.getRepository(entities.DocSpace),
      {} as never, // docSpacePolicy（未触达）
      actorProfileService,
      {} as never, // auditService（未触达）
    );

    // 测试数据：1 board + 1 list + 5 tasks（覆盖全部优先级组，assignee 全 null
    // 避免 actorProfileService 依赖；created_at/updated_at 显式 UPDATE 保证排序可控）
    const s = runSuffix();
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `WS-A Board ${s}`,
        topicId: null,
        creatorId: '00000000-0000-0000-0000-000000000001', // 无 FK 约束，哨兵值
        settings: {},
      }),
    );
    created.boardId = board.id;
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `WS-A List ${s}`,
        position: 0,
        mappedStatus: null,
      }),
    );
    created.listId = list.id;

    // 建 5 个任务：status 覆盖 in_progress/todo/blocked/backlog/done
    const statuses: TaskStatus[] = [
      TaskStatus.IN_PROGRESS,
      TaskStatus.TODO,
      TaskStatus.BLOCKED,
      TaskStatus.BACKLOG,
      TaskStatus.DONE,
    ];
    for (const status of statuses) {
      const task = await ds.getRepository(Task).save(
        ds.getRepository(Task).create({
          listId: list.id,
          title: `WS-A Task ${status} ${s}`,
          status,
          assigneeId: null,
          labels: null,
        }),
      );
      created.taskIds.push(task.id);
    }
    // 显式时间戳：created_at 按 status 递增（默认排序断言用），updated_at 递减
    // （statusPriority 次键）。position 列全为 0 不可用，故按 status 映射固定值；
    // 字符串拼接结果需 ::timestamptz 显式转换（PG 不做 text→timestamptz 隐式赋值转换）
    await ds.query(
      `UPDATE tasks SET
        created_at = ('2024-01-01T00:00:0' || CASE status
          WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 WHEN 'blocked' THEN 3
          WHEN 'backlog' THEN 4 ELSE 5 END || '.000Z')::timestamptz,
        updated_at = ('2024-01-01T00:00:0' || CASE status
          WHEN 'in_progress' THEN 5 WHEN 'todo' THEN 4 WHEN 'blocked' THEN 3
          WHEN 'backlog' THEN 2 ELSE 1 END || '.000Z')::timestamptz
       WHERE id = ANY($1)`,
      [created.taskIds],
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // FK 依赖逆序硬删兜底清理（本运行 RUN 后缀隔离，不碰任何既有数据）
    for (const id of created.taskIds) await ds.getRepository(Task).delete({ id });
    if (created.listId) await ds.getRepository(BoardList).delete({ id: created.listId });
    if (created.boardId) await ds.getRepository(Board).delete({ id: created.boardId });
    await ds.destroy();
  }, 30000);

  it('findAll 默认：item 无嵌套实体键，含扁平 listId/boardName/listName（部分水合）', async () => {
    // listId 过滤隔离本套件数据（accessQuery 为 admin 语义不过滤 board）
    const result = await taskService.findAll({ listId: created.listId! });

    expect(result.items).toHaveLength(5);
    for (const item of result.items) {
      // WS-A 扁平化：白名单组装，嵌套实体键一律不出现
      expect(item).not.toHaveProperty('list');
      expect(item).not.toHaveProperty('board');
      expect(item).not.toHaveProperty('dependencies');
      expect(item).not.toHaveProperty('dependents');
      expect(item).not.toHaveProperty('description');
      // 扁平字段：listId 显式列出 + boardName/listName 从部分水合 join 派生
      expect(item.listId).toBe(created.listId);
      expect(item.boardName).toBeTruthy();
      expect(item.listName).toBeTruthy();
      expect(item.boardId).toBe(created.boardId);
    }
  });

  it('findAll 默认排序：createdAt DESC 不变', async () => {
    const result = await taskService.findAll({ listId: created.listId! });

    // created_at 已显式设为 1..5 递增 → 默认排序应倒序（5..1）
    const ids = result.items.map((i) => i.id);
    expect(ids).toEqual([...created.taskIds].reverse());
  });

  it('findAll sort=statusPriority：in_progress > todo > blocked > backlog > done（其余恒末位）', async () => {
    const result = await taskService.findAll({ listId: created.listId!, sort: 'statusPriority' });

    const statuses = result.items.map((i) => i.status);
    expect(statuses).toEqual([
      TaskStatus.IN_PROGRESS,
      TaskStatus.TODO,
      TaskStatus.BLOCKED,
      TaskStatus.BACKLOG,
      TaskStatus.DONE,
    ]);
  });
});
