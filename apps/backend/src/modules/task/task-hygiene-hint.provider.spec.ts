/**
 * TaskHygieneHintProvider 单测（mock 仓储）
 *
 * 覆盖（阶段三决策 9 的设计矩阵）：
 * - `task_done_without_report`：toStatus ci 判定 / 回库状态复核（复活）/ 证据缺失三态
 *   （评论数 0 ∧ 未软删关联文档 0）——**有过任何评论即永久豁免**（触发人群刻意窄化）；
 * - `comment_on_done_task`：只在任务**当前已是 done** 时提示；**`via='report'` 豁免**
 *   （且豁免在最前面 ⇒ 零查库）；
 * - **`report(status=done, comment)` 形态不产出「复活码」**（plan H 显式要求）；
 * - join 谓词守卫：`task_doc_links` 的软删语义靠 `doc.deleted_at IS NULL`（TASK-HYG-1）；
 * - 调用级记忆化（同 task 只点查一次）/ 完全重复事实折叠 / per-fact fail-open；
 * - 委托：文案单源 / 族 'board' / ttlOf 6h 经注册表 / priority 序列 / surface。
 *
 * ⚠️ **mock 测不出 ORM 生成的 SQL**（铁律 #23）：join 的**行为面**（真实过滤软删 doc）
 * 由 `test/task-hygiene-hint.e2e-spec.ts` 打真 PG 覆盖。
 */
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { TaskStatus } from '@agent-chamber/shared';
import { HintRegistry } from '../hints/hint-registry';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { TaskHygieneHintProvider } from './task-hygiene-hint.provider';
import { TASK_HINT, TASK_HINT_MESSAGES } from './task-hint.constants';
import type { HintFact } from '../hints/hint-facts';

/** 假 join QueryBuilder（记录 innerJoin/where，断言软删过滤条件在场） */
function makeJoinQb(linkCount: number) {
  const joins: Array<{ entity: unknown; alias: string; condition: string }> = [];
  const wheres: Array<{ sql: string; params?: unknown }> = [];
  const qb = {
    innerJoin: jest.fn(),
    where: jest.fn(),
    getCount: jest.fn(),
  };
  qb.innerJoin.mockImplementation((entity: unknown, alias: string, condition: string) => {
    joins.push({ entity, alias, condition });
    return qb;
  });
  qb.where.mockImplementation((sql: string, params?: unknown) => {
    wheres.push({ sql, params });
    return qb;
  });
  qb.getCount.mockResolvedValue(linkCount);
  return { qb, joins, wheres };
}

/** 一条下游任务的回显形状（`dep.task` 关系实体） */
interface DependentRow {
  id: string;
  title: string;
  status: string;
}

/**
 * 假「下游在办依赖」QueryBuilder（v1.94.0-dev 依赖引导码）。
 *
 * ⚠️ **mock 测不出 SQL 行为**（铁律 #23）：本桩只记录 SQL 条件与取值，用于断言
 * 「软删 / 状态 / blocks-only / take」这些**谓词真的写进了查询**；而「真的过滤掉软删下游」
 * 由 `test/task-hygiene-hint.e2e-spec.ts` 打真 PG 覆盖。
 */
function makeDependentsQb(totalCount: number, rows: DependentRow[] = []) {
  const joins: Array<{ relation: string; alias: string; condition: string }> = [];
  const wheres: Array<{ sql: string; params?: unknown }> = [];
  const takes: number[] = [];
  const qb = {
    innerJoinAndSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    take: jest.fn(),
    getCount: jest.fn(),
    getMany: jest.fn(),
  };
  qb.innerJoinAndSelect.mockImplementation((relation: string, alias: string, condition: string) => {
    joins.push({ relation, alias, condition });
    return qb;
  });
  qb.where.mockImplementation((sql: string, params?: unknown) => {
    wheres.push({ sql, params });
    return qb;
  });
  qb.andWhere.mockImplementation((sql: string, params?: unknown) => {
    wheres.push({ sql, params });
    return qb;
  });
  qb.orderBy.mockImplementation(() => qb);
  qb.take.mockImplementation((count: number) => {
    takes.push(count);
    return qb;
  });
  qb.getCount.mockResolvedValue(totalCount);
  qb.getMany.mockResolvedValue(rows.map((row) => ({ task: row })));
  return { qb, joins, wheres, takes };
}

interface Harness {
  provider: TaskHygieneHintProvider;
  tasks: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  comments: { count: jest.Mock };
  joins: Array<{ entity: unknown; alias: string; condition: string }>;
  wheres: Array<{ sql: string; params?: unknown }>;
  depJoins: Array<{ relation: string; alias: string; condition: string }>;
  depWheres: Array<{ sql: string; params?: unknown }>;
  depTakes: number[];
  depQueries: number;
  /** 板级扫描 QB 的采集面（撞重码）：join 条件 / where / orderBy / limit */
  boardJoins: Array<{ entity: unknown; alias: string; condition: string }>;
  boardWheres: Array<{ sql: string; params?: unknown }>;
  boardOrders: string[];
  boardLimits: number[];
  /** 板级扫描的 `select` 列集（列集封闭断言：不得退化整实体加载 = 不取正文） */
  boardSelects: unknown[][];
  /** 板级扫描次数（**getter**：读当下的调用数，构造时快照会让「记忆化」断言空转） */
  boardQueries: number;
}

/** 一条同板候选行（撞重判定的输入投影） */
interface BoardRow {
  id: string;
  title: string;
  status: string;
}

/**
 * 假「同板 open 候选」QueryBuilder（撞重码）。
 *
 * ⚠️ **mock 测不出 SQL 行为**（铁律 #23）：本桩只记录**谓词与形态**（join 目标/软删排除/
 * 状态排除/排序/LIMIT），「真的过滤掉 done 与软删任务」由 `test/task-hygiene-hint.e2e-spec.ts`
 * 打真 PG 覆盖。
 */
function makeBoardQb(rows: BoardRow[]) {
  const joins: Array<{ entity: unknown; alias: string; condition: string }> = [];
  const wheres: Array<{ sql: string; params?: unknown }> = [];
  const orders: string[] = [];
  const limits: number[] = [];
  /** `select` 的列集（逐次调用记录；数组形与变参形都归一成列名数组） */
  const selects: unknown[][] = [];
  const qb = {
    innerJoin: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    select: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    limit: jest.fn(),
    getMany: jest.fn(),
  };
  qb.innerJoin.mockImplementation((entity: unknown, alias: string, condition: string) => {
    joins.push({ entity, alias, condition });
    return qb;
  });
  qb.where.mockImplementation((sql: string, params?: unknown) => {
    wheres.push({ sql, params });
    return qb;
  });
  qb.andWhere.mockImplementation((sql: string, params?: unknown) => {
    wheres.push({ sql, params });
    return qb;
  });
  qb.select.mockImplementation((...args: unknown[]) => {
    selects.push(args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args);
    return qb;
  });
  qb.orderBy.mockImplementation((sql: string, direction: string) => {
    orders.push(`${sql} ${direction}`);
    return qb;
  });
  qb.addOrderBy.mockImplementation((sql: string, direction: string) => {
    orders.push(`${sql} ${direction}`);
    return qb;
  });
  qb.limit.mockImplementation((count: number) => {
    limits.push(count);
    return qb;
  });
  qb.getMany.mockResolvedValue(rows);
  return { qb, joins, wheres, orders, limits, selects };
}

/** 组装 provider（默认：任务当前 = done、评论 0 条、未软删关联 0 条、下游在办 0 条、板内无候选行） */
function buildHarness(
  over: {
    task?: { id: string; status: string } | null;
    commentCount?: number;
    linkCount?: number;
    dependents?: { total: number; rows?: DependentRow[] };
    boardRows?: BoardRow[];
  } = {},
): Harness {
  const { qb, joins, wheres } = makeJoinQb(over.linkCount ?? 0);
  const deps = makeDependentsQb(over.dependents?.total ?? 0, over.dependents?.rows ?? []);
  const board = makeBoardQb(over.boardRows ?? []);
  const tasks = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        over.task === undefined ? { id: 'task-1', status: TaskStatus.DONE } : over.task,
      ),
    createQueryBuilder: jest.fn(() => board.qb),
  };
  const comments = { count: jest.fn().mockResolvedValue(over.commentCount ?? 0) };
  const docLinks = { createQueryBuilder: jest.fn(() => qb) };
  const dependencies = {
    createQueryBuilder: jest.fn(() => deps.qb),
  };

  const provider = new TaskHygieneHintProvider(
    tasks as unknown as Repository<Task>,
    comments as unknown as Repository<TaskComment>,
    docLinks as unknown as Repository<TaskDocLink>,
    dependencies as unknown as Repository<TaskDependency>,
    new HintRegistry(),
  );
  return {
    provider,
    tasks,
    comments,
    joins,
    wheres,
    depJoins: deps.joins,
    depWheres: deps.wheres,
    depTakes: deps.takes,
    boardJoins: board.joins,
    boardWheres: board.wheres,
    boardOrders: board.orders,
    boardLimits: board.limits,
    boardSelects: board.selects,
    // **getter 而非构造时快照**：`depQueries` / `boardQueries` 断言的是「本次 build 有没有
    // 查库」，构造时求值恒为 0 ⇒ 断言永真、用例空转（评审 P2-2）。getter 让它读**当下**调用数。
    get depQueries(): number {
      return dependencies.createQueryBuilder.mock.calls.length;
    },
    get boardQueries(): number {
      return tasks.createQueryBuilder.mock.calls.length;
    },
  };
}

/** `task.status_changed` 事实（默认 done） */
function statusFact(over: Record<string, unknown> = {}): HintFact {
  return {
    name: 'task.status_changed',
    payload: {
      taskId: 'task-1',
      boardId: 'board-1',
      fromStatus: 'in_progress',
      toStatus: 'done',
      ...over,
    },
  };
}

/** `task.comment_added` 事实 */
function commentFact(over: Record<string, unknown> = {}): HintFact {
  return { name: 'task.comment_added', payload: { taskId: 'task-1', commentId: 'c-1', ...over } };
}

describe('TaskHygieneHintProvider', () => {
  describe('task_done_without_report（完工缺结果证据）', () => {
    it('完工 + 评论 0 + 未软删关联 0 → 产出候选（resourceKey = taskId）', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build([statusFact()], null);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        code: TASK_HINT.DONE_WITHOUT_REPORT,
        status: 'suggestion',
        resourceKey: 'task-1',
        data: { taskId: 'task-1', commentCount: 0, docLinkCount: 0 },
      });
    });

    it('toStatus 的 ci 判定：`DONE` / `Done` 一样命中', async () => {
      for (const toStatus of ['DONE', 'Done']) {
        const h = buildHarness();
        const candidates = await h.provider.build([statusFact({ toStatus })], null);
        expect(candidates).toHaveLength(1);
      }
    });

    it('toStatus 非 done / 缺失 → 空候选（零查库）', async () => {
      const inProgress = buildHarness();
      expect(
        await inProgress.provider.build([statusFact({ toStatus: 'in_progress' })], null),
      ).toEqual([]);
      expect(inProgress.tasks.findOne).not.toHaveBeenCalled();

      const missing = buildHarness();
      expect(await missing.provider.build([statusFact({ toStatus: undefined })], null)).toEqual([]);
      expect(missing.tasks.findOne).not.toHaveBeenCalled();
    });

    it('回库复核：任务当前**不是** done（复活/并发回退）→ 空候选', async () => {
      const h = buildHarness({ task: { id: 'task-1', status: TaskStatus.IN_PROGRESS } });

      expect(await h.provider.build([statusFact()], null)).toEqual([]);
    });

    it('任务不存在（判空，铁律 #22）→ 空候选', async () => {
      const h = buildHarness({ task: null });

      expect(await h.provider.build([statusFact()], null)).toEqual([]);
    });

    it('**有过任何评论即永久豁免**（触发人群刻意窄化）→ 空候选且不再查关联文档', async () => {
      const h = buildHarness({ commentCount: 1 });

      expect(await h.provider.build([statusFact()], null)).toEqual([]);
      // 评论已足以构成证据 ⇒ 零额外查询
      expect(h.joins).toHaveLength(0);
    });

    it('有指向**未软删** doc 的关联 → 空候选（已有文档证据）', async () => {
      const h = buildHarness({ linkCount: 1 });

      expect(await h.provider.build([statusFact()], null)).toEqual([]);
      // join 谓词含软删过滤（TASK-HYG-1：裸 uuid 无 FK，软删语义只在 join 条件里）
      expect(h.joins[0].condition).toContain('doc.deleted_at IS NULL');
      expect(h.wheres[0]).toMatchObject({
        sql: 'link.task_id = :taskId',
        params: { taskId: 'task-1' },
      });
    });
  });

  describe('comment_on_done_task（对已完工任务追加评论）', () => {
    it('任务当前 = done → 产出候选（resourceKey = taskId）', async () => {
      const h = buildHarness();

      const candidates = await h.provider.build([commentFact()], null);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        code: TASK_HINT.COMMENT_ON_DONE_TASK,
        resourceKey: 'task-1',
        data: { taskId: 'task-1' },
      });
    });

    it('任务非 done → 空候选（不打扰进行中的任务）', async () => {
      const h = buildHarness({ task: { id: 'task-1', status: TaskStatus.REVIEW } });

      expect(await h.provider.build([commentFact()], null)).toEqual([]);
    });

    it('任务不存在 → 空候选', async () => {
      const h = buildHarness({ task: null });

      expect(await h.provider.build([commentFact()], null)).toEqual([]);
    });

    it("**`via='report'` 豁免**（验收补证不是「新增未完成工作」）→ 空候选且**零查库**", async () => {
      const h = buildHarness();

      expect(await h.provider.build([commentFact({ via: 'report' })], null)).toEqual([]);
      expect(h.tasks.findOne).not.toHaveBeenCalled();
    });

    it('**report(status=done, comment) 形态不产出「复活码」**（plan H 显式矩阵）', async () => {
      const h = buildHarness({ commentCount: 1 }); // report 自己发的那条评论

      const candidates = await h.provider.build(
        [statusFact(), commentFact({ via: 'report' })],
        null,
      );

      // 复活码被 via 豁免；完工缺证据码被「已有评论」豁免 ⇒ 本次零提示（刻意窄化的正常结果）
      expect(candidates).toEqual([]);
    });
  });

  describe('task_dependents_pending（进入 review/done 但下游仍在办）', () => {
    /** 只取依赖引导码（同响应可能还有完工缺证据码，见下） */
    async function dependentsCandidates(h: Harness, over: Record<string, unknown> = {}) {
      const candidates = await h.provider.build(
        [statusFact({ toStatus: 'review', ...over })],
        null,
      );
      return candidates.filter((c) => c.code === TASK_HINT.DEPENDENTS_PENDING);
    }

    it('review + 有在办 blocks 下游 → 产出候选（resourceKey 带 toStatus / data 键集封闭）', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        dependents: {
          total: 2,
          rows: [
            { id: 'd-1', title: '下游一', status: TaskStatus.IN_PROGRESS },
            { id: 'd-2', title: '下游二', status: TaskStatus.TODO },
          ],
        },
      });

      const [candidate] = await dependentsCandidates(h);

      expect(candidate).toBeDefined();
      expect(candidate).toMatchObject({
        code: TASK_HINT.DEPENDENTS_PENDING,
        status: 'suggestion',
        resourceKey: 'task-1:review',
        data: {
          taskId: 'task-1',
          toStatus: 'review',
          dependencyType: 'blocks',
          totalCount: 2,
          dependents: [
            { id: 'd-1', title: '下游一', status: TaskStatus.IN_PROGRESS },
            { id: 'd-2', title: '下游二', status: TaskStatus.TODO },
          ],
        },
      });
      // **data 键集封闭**：消费方只读这里（结构化值），不解析 message
      expect(Object.keys(candidate.data ?? {}).sort()).toEqual([
        'dependencyType',
        'dependents',
        'taskId',
        'toStatus',
        'totalCount',
      ]);
      // 文案是模板渲染（含状态与数量），不是手写串
      expect(candidate.message).toContain('任务已进入 review');
      expect(candidate.message).toContain('仍有 2 个未完成下游任务依赖它');
      expect(candidate.message).toContain('下游一、下游二');
      expect(candidate.message).toContain('task_controller_remove_dependency');
      expect(candidate.message).toContain('忽略本提示即可');
    });

    it('done + 下游在办 → **同时**产出「完工缺证据」与「依赖引导」两条（resourceKey 不同）', async () => {
      const h = buildHarness({
        commentCount: 0,
        dependents: { total: 1, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
      });

      const candidates = await h.provider.build([statusFact()], null);

      expect(candidates.map((c) => c.code).sort()).toEqual([
        TASK_HINT.DEPENDENTS_PENDING,
        TASK_HINT.DONE_WITHOUT_REPORT,
      ]);
      expect(candidates.map((c) => c.resourceKey).sort()).toEqual(['task-1', 'task-1:done']);
    });

    it('toStatus 门：in_progress / todo / backlog / archived 一律不提示（且**零查库**——门在最前）', async () => {
      for (const toStatus of ['in_progress', 'todo', 'backlog', 'archived']) {
        const h = buildHarness({
          task: { id: 'task-1', status: toStatus },
          dependents: { total: 3, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
        });

        expect(await dependentsCandidates(h, { toStatus })).toEqual([]);
        expect(h.depQueries).toBe(0);
      }
    });

    it('toStatus 大小写不敏感（事实是领域语言）：`REVIEW` / `Done` 同样命中', async () => {
      for (const [toStatus, taskStatus] of [
        ['REVIEW', TaskStatus.REVIEW],
        ['Done', TaskStatus.DONE],
      ] as const) {
        const h = buildHarness({
          task: { id: 'task-1', status: taskStatus },
          commentCount: 1, // 压掉完工缺证据码（只观察依赖引导）
          dependents: { total: 1, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
        });

        const candidates = await dependentsCandidates(h, { toStatus });
        expect(candidates).toHaveLength(1);
        expect(candidates[0].resourceKey).toBe(`task-1:${toStatus.toLowerCase()}`);
      }
    });

    it('resourceKey 带 toStatus ⇒ review 与 done 各送达一次（同态横跳才被窗口压制）', async () => {
      const review = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        commentCount: 1,
        dependents: { total: 1, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
      });
      const done = buildHarness({
        task: { id: 'task-1', status: TaskStatus.DONE },
        commentCount: 1,
        dependents: { total: 1, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
      });

      expect((await dependentsCandidates(review))[0].resourceKey).toBe('task-1:review');
      expect(
        (await done.provider.build([statusFact({ toStatus: 'done' })], null)).filter(
          (c) => c.code === TASK_HINT.DEPENDENTS_PENDING,
        )[0].resourceKey,
      ).toBe('task-1:done');
    });

    it('**回库复核**：事实说 review，但库中当前是别的状态（并发回退）→ 空候选', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.IN_PROGRESS },
        dependents: { total: 3, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
      });

      expect(await dependentsCandidates(h)).toEqual([]);
      expect(h.depQueries).toBe(0);
    });

    it('任务不存在（判空，铁律 #22）→ 空候选', async () => {
      const h = buildHarness({
        task: null,
        dependents: { total: 3, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
      });

      expect(await dependentsCandidates(h)).toEqual([]);
    });

    it('**下游在办 0 条 ⇒ 不产出**（「一切正常」不是提示素材）——count 与 list 都查了', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        dependents: { total: 0 },
      });

      expect(await dependentsCandidates(h)).toEqual([]);
      // count 短路后不再拉列表（省一次查询）
      expect(h.depTakes).toEqual([]);
    });

    it('**SQL 下沉的谓词**：blocks-only / 软删排除 / done·archived 排除 / take 3（铁律 #23：行为面归 e2e）', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        dependents: { total: 1, rows: [{ id: 'd-1', title: '下游', status: TaskStatus.TODO }] },
      });

      await dependentsCandidates(h);

      // 软删语义写在 **join 条件**里（`Task.deletedAt` 是 select:false ⇒ JS 侧过滤恒失效）
      expect(h.depJoins[0]).toMatchObject({ relation: 'dep.task', alias: 't' });
      expect(h.depJoins[0].condition).toContain('t.deleted_at IS NULL');
      const wheresBySql = new Map(h.depWheres.map((entry) => [entry.sql, entry.params]));
      expect(wheresBySql.get('dep.depends_on_task_id = :taskId')).toEqual({ taskId: 'task-1' });
      // **只有 blocks 算「在等它」**：relates_to / duplicates 不表达下游被挡住
      expect(wheresBySql.get('dep.dependency_type = :type')).toEqual({ type: 'blocks' });
      expect(wheresBySql.get('t.status NOT IN (:...doneStatuses)')).toEqual({
        doneStatuses: [TaskStatus.DONE, TaskStatus.ARCHIVED],
      });
      expect(h.depTakes).toEqual([3]);
    });

    it('回显口径：只回 `{id, title, status}`（**描述/评论正文永不出现**）', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        dependents: {
          total: 1,
          rows: [
            {
              id: 'd-1',
              title: '下游一',
              status: TaskStatus.TODO,
              // 模拟实体上带正文（回显必须把它丢掉）
              ...({ description: '下游任务的完整描述正文' } as object),
            },
          ],
        },
      });

      const [candidate] = await dependentsCandidates(h);

      expect(candidate.data?.dependents).toEqual([
        { id: 'd-1', title: '下游一', status: TaskStatus.TODO },
      ]);
      expect(JSON.stringify(candidate.data)).not.toContain('完整描述正文');
      expect(candidate.message).not.toContain('完整描述正文');
    });

    it('cap 3 + totalCount：回显最多 3 条，`totalCount` 报全量，文案带「等 N 个」', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        dependents: {
          total: 5,
          rows: [
            { id: 'd-1', title: '下游一', status: TaskStatus.TODO },
            { id: 'd-2', title: '下游二', status: TaskStatus.TODO },
            { id: 'd-3', title: '下游三', status: TaskStatus.TODO },
          ],
        },
      });

      const [candidate] = await dependentsCandidates(h);

      expect((candidate.data?.dependents as unknown[]).length).toBe(3);
      expect(candidate.data?.totalCount).toBe(5);
      expect(candidate.message).toContain('仍有 5 个未完成下游任务依赖它');
      expect(candidate.message).toContain('下游一、下游二、下游三等 5 个');
    });

    it('total ≤ 3 ⇒ 不渲染「等 N 个」（overflow 为空串）', async () => {
      const h = buildHarness({
        task: { id: 'task-1', status: TaskStatus.REVIEW },
        dependents: { total: 1, rows: [{ id: 'd-1', title: '下游一', status: TaskStatus.TODO }] },
      });

      const [candidate] = await dependentsCandidates(h);

      expect(candidate.message).toContain('下游一');
      expect(candidate.message).not.toContain('等 ');
    });
  });

  describe('成本与健壮性', () => {
    it('同 task 的两条事实 → 状态点查**只打一次**（调用级记忆化）', async () => {
      const h = buildHarness();

      await h.provider.build([statusFact(), commentFact()], null);

      expect(h.tasks.findOne).toHaveBeenCalledTimes(1);
    });

    it('**完全重复**的事实被折叠（同事实名 + 同载荷）', async () => {
      const h = buildHarness();
      const duplicate = commentFact();

      const candidates = await h.provider.build(
        [duplicate, { ...duplicate, payload: { ...duplicate.payload } }],
        null,
      );

      expect(candidates).toHaveLength(1);
      expect(h.tasks.findOne).toHaveBeenCalledTimes(1);
    });

    it('仓储抛错 → **不抛**，失败事实跳过、其余事实照常产出（不同资源不受牵连）', async () => {
      const h = buildHarness();
      // task-1 点查炸（且失败被同键记忆化 ⇒ 该资源的两条事实都跳过）；
      // task-2 正常 ⇒ 仍然产出——per-fact fail-open 的隔离面
      h.tasks.findOne.mockImplementation(async (options: { where?: { id?: string } }) => {
        if (options?.where?.id === 'task-1') throw new Error('db down');
        return { id: 'task-2', status: TaskStatus.DONE };
      });

      const candidates = await h.provider.build(
        [statusFact(), statusFact({ taskId: 'task-2' })],
        null,
      );

      expect(candidates.map((c) => c.resourceKey)).toEqual(['task-2']);
    });

    it('不关心的事实名 / 载荷畸形 → 空候选（不抛）', async () => {
      const h = buildHarness();

      expect(await h.provider.build([{ name: 'doc.upserted', payload: {} }], null)).toEqual([]);
      expect(
        await h.provider.build([{ name: 'task.status_changed', payload: { taskId: 42 } }], null),
      ).toEqual([]);
      expect(await h.provider.build([{ name: 'task.comment_added' }], null)).toEqual([]);
    });
  });

  describe('委托契约', () => {
    it('文案单源 / 族 board / 窗口 6h（经注册表）/ surface / priority / factNames', () => {
      const h = buildHarness();

      expect(h.provider.surface).toBe('task_hygiene');
      expect(h.provider.familyOf()).toBe('board');
      expect(h.provider.priority).toEqual([
        TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
        TASK_HINT.DONE_WITHOUT_REPORT,
        TASK_HINT.DEPENDENTS_PENDING,
        TASK_HINT.COMMENT_ON_DONE_TASK,
      ]);
      for (const code of [
        TASK_HINT.DONE_WITHOUT_REPORT,
        TASK_HINT.DEPENDENTS_PENDING,
        TASK_HINT.COMMENT_ON_DONE_TASK,
        TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
      ]) {
        expect(h.provider.ttlOf(code)).toBe(6 * 60 * 60 * 1000);
      }
      expect(h.provider.ttlOf('same_key_resend')).toBeUndefined();
      // 依赖引导**复用** `task.status_changed`（零新事实）；撞重码**新增** `task.created`
      expect([...h.provider.factNames].sort()).toEqual([
        'task.comment_added',
        'task.created',
        'task.status_changed',
      ]);

      // resolveMessage 走单源文案；候选自带 message 时覆盖优先
      const candidate = {
        code: TASK_HINT.DONE_WITHOUT_REPORT,
        status: 'suggestion' as const,
        resourceKey: 'task-1',
      };
      expect(h.provider.resolveMessage(candidate)).toBe(
        TASK_HINT_MESSAGES[TASK_HINT.DONE_WITHOUT_REPORT],
      );
      expect(h.provider.resolveMessage({ ...candidate, message: '覆盖文案' })).toBe('覆盖文案');
      // 模板码：无 message 时用候选的 data 渲染（未登代码回落 code 本身）
      expect(
        h.provider.resolveMessage({
          code: TASK_HINT.DEPENDENTS_PENDING,
          status: 'suggestion',
          resourceKey: 'task-1:review',
          data: { toStatus: 'review', total: 2, titles: 'A、B', overflow: '' },
        }),
      ).toContain('仍有 2 个未完成下游任务依赖它');
      expect(
        h.provider.resolveMessage({
          code: 'not_a_real_code',
          status: 'suggestion',
          resourceKey: 'x',
        }),
      ).toBe('not_a_real_code');
    });

    it('四条文案都自带「可忽略」出口（纪律提醒不是闸门）', () => {
      expect(TASK_HINT_MESSAGES[TASK_HINT.COMMENT_ON_DONE_TASK]).toContain('忽略本提示');
      expect(TASK_HINT_MESSAGES[TASK_HINT.DONE_WITHOUT_REPORT]).toContain('未附结果证据');
      expect(TASK_HINT_MESSAGES[TASK_HINT.DEPENDENTS_PENDING]).toContain('忽略本提示即可');
      expect(TASK_HINT_MESSAGES[TASK_HINT.NEAR_DUPLICATE_SUSPECTED]).toContain('忽略本提示即可');
      // v1.94.0-dev 改写锚点（下一步指引 + 证据形态）
      expect(TASK_HINT_MESSAGES[TASK_HINT.DONE_WITHOUT_REPORT]).toContain('report_task_result');
      expect(TASK_HINT_MESSAGES[TASK_HINT.DONE_WITHOUT_REPORT]).toContain('commit SHA');
    });

    it('埋点面契约：未产出的错误路径不落 emitted 行（本 provider 只报 emitted）', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const h = buildHarness();
        await h.provider.build([statusFact()], null);
        // provider 自身不埋点（埋点由 intercept/emit 层做）——只在异常时落文本 warn
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('task_near_duplicate_suspected（同板 open 任务撞题）', () => {
    /** 一条 `task.created` 事实（撞重码的唯一输入） */
    function createdFact(over: Record<string, unknown> = {}): HintFact {
      return {
        name: 'task.created',
        payload: { taskId: 'task-new', boardId: 'board-1', title: '修复登录 bug', ...over },
      };
    }

    /** 造一条板内候选行（真库投影 = `{id, title, status}`） */
    function row(id: string, title: string, status: string = TaskStatus.TODO): BoardRow {
      return { id, title, status };
    }

    it('tier1 命中 → 候选的 data 键集封闭 / matches 逐字段 / 文案插值', async () => {
      const h = buildHarness({ boardRows: [row('t-1', '修复登录bug'), row('t-2', '别的任务')] });

      const candidates = await h.provider.build([createdFact()], null);

      expect(candidates).toHaveLength(1);
      const [candidate] = candidates;
      expect(candidate).toMatchObject({
        code: TASK_HINT.NEAR_DUPLICATE_SUSPECTED,
        status: 'suggestion',
        // resourceKey = **新 taskId**（行为 join 可直接读；不是 title 的 hash，见 provider 注释）
        resourceKey: 'task-new',
        data: {
          taskId: 'task-new',
          boardId: 'board-1',
          totalCount: 1,
          matches: [
            {
              id: 't-1',
              title: '修复登录bug',
              status: TaskStatus.TODO,
              sameBatch: false,
              matchedBy: 'tier1',
            },
          ],
        },
      });
      // **信封 data 键集封闭**：消费方只读这里（不解析 message）
      expect(Object.keys(candidate.data ?? {}).sort()).toEqual([
        'boardId',
        'matches',
        'taskId',
        'totalCount',
      ]);
      expect(Object.keys((candidate.data?.matches as object[])[0]).sort()).toEqual([
        'id',
        'matchedBy',
        'sameBatch',
        'status',
        'title',
      ]);
      // 文案 = 模板插值（预拼串标题 + 计数 + 忽略出口）
      expect(candidate.message).toContain('修复登录bug');
      expect(candidate.message).toContain('共 1 个');
      expect(candidate.message).toContain('忽略本提示即可');
    });

    it('tier2a 命中（白名单装饰剥离）→ matchedBy=tier2a；非白名单装饰不命中', async () => {
      const hit = buildHarness({
        boardRows: [row('t-1', '冒烟支付修复')],
      });
      const [candidate] = await hit.provider.build(
        [createdFact({ title: '「Bug」冒烟支付修复' })],
        null,
      );
      expect(candidate.data?.matches).toEqual([
        {
          id: 't-1',
          title: '冒烟支付修复',
          status: TaskStatus.TODO,
          sameBatch: false,
          matchedBy: 'tier2a',
        },
      ]);

      // 「前端/后端」是**白名单外**的承载区分语义词 ⇒ 不剥、不命中（负例护栏的单测面）
      const miss = buildHarness({ boardRows: [row('t-1', '「前端」冒烟重构')] });
      expect(await miss.provider.build([createdFact({ title: '「后端」冒烟重构' })], null)).toEqual(
        [],
      );
    });

    it('**不撞自己**：板级候选含本任务 ⇒ per-fact 层剔除（缓存不带 selfId 过滤）', async () => {
      const h = buildHarness({ boardRows: [row('task-new', '修复登录 bug')] });

      expect(await h.provider.build([createdFact()], null)).toEqual([]);
      // 板级扫描确实把「自己」也拿回来了（证明剔除发生在 per-fact 层，而不是靠 SQL 排除自己）
      expect(h.boardQueries).toBe(1);
    });

    it('批内互撞：同请求两条同名 → 互相标 sameBatch:true，且**都不含自我撞题**', async () => {
      const h = buildHarness({
        boardRows: [row('task-new-a', '修复登录bug'), row('task-new-b', '修复登录 bug')],
      });

      const candidates = await h.provider.build(
        [
          {
            name: 'task.created',
            payload: { taskId: 'task-new-a', boardId: 'board-1', title: '修复登录bug' },
          },
          {
            name: 'task.created',
            payload: { taskId: 'task-new-b', boardId: 'board-1', title: '修复登录 bug' },
          },
        ],
        null,
      );

      expect(candidates).toHaveLength(2);
      for (const candidate of candidates) {
        const matches = candidate.data?.matches as Array<{ id: string; sameBatch: boolean }>;
        expect(matches).toHaveLength(1);
        expect(matches[0].sameBatch).toBe(true); // 撞的是**本批刚建**的卡
        // 鉴别断言：任何一条都不是自我撞题
        expect(matches[0].id).not.toBe(candidate.data?.taskId);
      }
      // 记忆化：同板只扫一次库（**缓存的是板级候选，不含 selfId 过滤**——见 TASK-HYG-4）
      expect(h.boardQueries).toBe(1);
    });

    it('SQL 谓词形态：列→板 join / 软删排除 / 状态排除 / created_at ASC,id ASC / LIMIT 501（铁律 #23）', async () => {
      const h = buildHarness({ boardRows: [row('t-1', '修复登录bug')] });

      await h.provider.build([createdFact()], null);

      expect(h.boardJoins[0]).toMatchObject({ alias: 'bl', condition: 'bl.id = t.list_id' });
      const wheresBySql = new Map(h.boardWheres.map((entry) => [entry.sql, entry.params]));
      expect(wheresBySql.get('bl.board_id = :boardId')).toEqual({ boardId: 'board-1' });
      // 软删语义写在 SQL 里（`Task.deletedAt` 是 select:false ⇒ JS 侧过滤恒失效）
      expect(wheresBySql.has('t.deleted_at IS NULL')).toBe(true);
      // done / archived 不算「在办」（与 task-dependency.service 的同一集合）
      expect(wheresBySql.get('t.status NOT IN (:...closedStatuses)')).toEqual({
        closedStatuses: [TaskStatus.DONE, TaskStatus.ARCHIVED],
      });
      // 原始卡优先展示 + 同 created_at 的确定性兜底
      expect(h.boardOrders).toEqual(['t.created_at ASC', 't.id ASC']);
      expect(h.boardLimits).toEqual([501]);
      // **列集封闭**：只取判定与回显需要的三列（不取 description/正文——见文件头不变量）；
      // 去掉 `.select` 会退化成整实体加载，本断言即红
      expect(h.boardSelects).toEqual([['t.id', 't.title', 't.status']]);
    });

    it('巨板 fail-open：> 500 行 ⇒ 固定前缀 warn + 放弃，且「放弃」结论被记忆化（同请求只扫一次）', async () => {
      const rows = Array.from({ length: 501 }, (_unused, i) => row(`t-${i}`, `任务${i}`));
      const h = buildHarness({ boardRows: rows });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const candidates = await h.provider.build(
          [
            {
              name: 'task.created',
              payload: { taskId: 'task-new-a', boardId: 'board-1', title: '任务1' },
            },
            {
              name: 'task.created',
              payload: { taskId: 'task-new-b', boardId: 'board-1', title: '任务2' },
            },
          ],
          null,
        );

        expect(candidates).toEqual([]); // fail-open：巨板宁可不提示，也不拖慢写路径
        expect(h.boardQueries).toBe(1); // 第 2 条事实复用「放弃」结论
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const warning = warnSpy.mock.calls[0][0] as string;
        expect(warning).toContain('[TASK_HYGIENE_HINT_BOARD_TOO_LARGE]');
        expect(warning).toContain('board-1');
        // 日志**不含任何用户内容**（固定前缀 warn 的意义）
        expect(warning).not.toContain('任务1');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('载荷缺 boardId / title / taskId → 跳过且**零查库**（fail-closed，绝不猜板）', async () => {
      for (const over of [
        { boardId: undefined },
        { title: undefined },
        { title: '' },
        { taskId: undefined },
      ]) {
        const h = buildHarness();
        expect(await h.provider.build([createdFact(over)], null)).toEqual([]);
        expect(h.boardQueries).toBe(0);
      }
    });

    it('板级扫描抛错 → 不抛、跳过（per-fact fail-open）', async () => {
      const h = buildHarness();
      h.tasks.createQueryBuilder.mockImplementation(() => {
        throw new Error('db down');
      });

      expect(await h.provider.build([createdFact()], null)).toEqual([]);
    });

    it('totalCount > 3：回显仍 ≤3，文案带「等 N 个」', async () => {
      const rows = Array.from({ length: 5 }, (_unused, i) => row(`t-${i}`, '修复登录bug'));
      const h = buildHarness({ boardRows: rows });

      const [candidate] = await h.provider.build([createdFact()], null);

      expect((candidate.data?.matches as unknown[]).length).toBe(3);
      expect(candidate.data?.totalCount).toBe(5);
      expect(candidate.message).toContain('共 5 个');
      expect(candidate.message).toContain('等 5 个');
    });

    it('非字符串标题 / 无关事实名 → 空候选（不抛）', async () => {
      const h = buildHarness({ boardRows: [row('t-1', '修复登录bug')] });
      expect(await h.provider.build([createdFact({ title: 42 })], null)).toEqual([]);
      expect(
        await h.provider.build([{ name: 'doc.upserted', payload: { taskId: 'x' } }], null),
      ).toEqual([]);
      expect(h.boardQueries).toBe(0); // 无关事实根本进不了撞重分支
    });
  });
});
