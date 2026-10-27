import { TaskPolicy } from './task.policy';
import { BoardPolicy } from './board.policy';
import { Board } from '../../database/entities/board.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Task } from '../../database/entities/task.entity';
import { UnifiedActor } from '../types/actor.types';
import { OwnerProxyService } from '../services/owner-proxy.service';
import { ActorType, UserRole, TaskStatus } from '@agent-chamber/shared';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';

/**
 * TaskPolicy 单测矩阵（F4-2 加固后的形状）。
 *
 * 两个**真实机制**必须在 mock 里如实体现在，否则测的是假想实现：
 * ① 权限来源是 `BoardPolicy.can`（本 spec 只 mock 它的返回值，不重写它的逻辑）——
 *    "assignee 通道合取 boardRead"因此表现为「同一 actor 在 write/read 两个 action 上
 *    拿到不同返回值」，而不是在 policy 内部硬编码 read 判定；
 * ② 软删板判定依赖**定主键重载**（`createQueryBuilder → withDeleted + addSelect`）——
 *    `Board.deletedAt` 是 `select: false`，`findOne({withDeleted:true})` 读不到它。
 *    mock 抓不到 ORM 的 select 语义（真 PG 覆盖见
 *    `test/task-policy-soft-delete.e2e-spec.ts`），故此处额外断言**查询形状**
 *    （withDeleted + addSelect('board.deletedAt')）作为 S-N1 死代码坑的守卫。
 */
describe('TaskPolicy', () => {
  let policy: TaskPolicy;
  let listRepo: jest.Mocked<Repository<BoardList>>;
  let boardPolicy: jest.Mocked<BoardPolicy>;
  let ownerProxy: jest.Mocked<OwnerProxyService>;
  /** 重载链的末端（`getOne`）——每个用例控制「本策略查到了什么」 */
  let reloadGetOne: jest.Mock;
  /** 最近一次 QB 链（用于断言 withDeleted / addSelect 形状） */
  let lastChain: Record<string, jest.Mock>;

  beforeEach(() => {
    reloadGetOne = jest.fn();
    listRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const chain = {
          leftJoinAndSelect: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          withDeleted: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: reloadGetOne,
        };
        lastChain = chain as unknown as Record<string, jest.Mock>;
        return chain;
      }),
    } as unknown as jest.Mocked<Repository<BoardList>>;
    boardPolicy = {
      can: jest.fn(),
    } as unknown as jest.Mocked<BoardPolicy>;
    ownerProxy = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<OwnerProxyService>;
    policy = new TaskPolicy(listRepo, boardPolicy, ownerProxy);
  });

  afterEach(() => jest.clearAllMocks());

  const makeActor = (overrides: Partial<UnifiedActor> = {}): UnifiedActor =>
    ({
      id: 'actor-1',
      type: ActorType.AGENT,
      role: UserRole.EDITOR,
      ...overrides,
    }) as UnifiedActor;

  const makeTask = (overrides: Partial<Task> = {}): Task =>
    ({
      id: 'task-1',
      title: 'Test Task',
      listId: 'list-1',
      assigneeId: 'assignee-1',
      assigneeType: ActorType.AGENT,
      status: TaskStatus.TODO,
      ...overrides,
    }) as Task;

  const makeBoard = (overrides: Partial<Board> = {}): Board =>
    ({
      id: 'board-1',
      creatorId: 'creator-1',
      creatorType: 'human',
      settings: {},
      // 正常板 = 未软删；软删板用例显式传 deletedAt
      deletedAt: null,
      ...overrides,
    }) as unknown as Board;

  /** 重载命中：list + board（board 形状可覆盖，用于软删板 / PRIVATE 场景） */
  const mockList = (boardOverrides: Partial<Board> = {}) => {
    reloadGetOne.mockResolvedValue({
      id: 'list-1',
      boardId: 'board-1',
      board: makeBoard(boardOverrides),
    } as unknown as BoardList);
  };

  /** 重载未命中（真缺失 / list 行不存在） */
  const mockListMissing = () => reloadGetOne.mockResolvedValue(null);

  /** BoardPolicy 返回：write/read 给不同答案（模拟"非 editor 成员"这类真实组合） */
  const mockBoardPolicy = (opts: { read: boolean; write?: boolean }) => {
    boardPolicy.can.mockImplementation(async (_actor, _board, action) =>
      action === 'write' ? (opts.write ?? false) : opts.read,
    );
  };

  describe('定主键重载形状（S-N1 死代码坑守卫）', () => {
    it('重载带 withDeleted + addSelect(board.deletedAt)：否则软删板分支永不触发', async () => {
      mockList();
      boardPolicy.can.mockResolvedValue(true);

      await policy.can(makeActor(), makeTask(), 'read');

      expect(listRepo.createQueryBuilder).toHaveBeenCalledWith('list');
      expect(listRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(lastChain.withDeleted).toHaveBeenCalledTimes(1);
      // Board.deletedAt 是 select:false：只 withDeleted 不补选 → 字段恒 undefined
      expect(lastChain.addSelect).toHaveBeenCalledWith('board.deletedAt');
      // ⚠️ **顺序**即语义：join 的软删条件在 join() 当场按 withDeleted 决定要不要追加，
      // 后置的 withDeleted 救不了已建立的 join（半吊子查询 → 软删板载不回来 → 掉进
      // "真缺失"分支）。真 PG 取证见 test/task-policy-soft-delete.e2e-spec.ts。
      expect(lastChain.withDeleted.mock.invocationCallOrder[0]).toBeLessThan(
        lastChain.leftJoinAndSelect.mock.invocationCallOrder[0],
      );
      expect(lastChain.leftJoinAndSelect.mock.invocationCallOrder[0]).toBeLessThan(
        lastChain.addSelect.mock.invocationCallOrder[0],
      );
      // ⚠️ 禁止退化回 findOne（findOne 无 withDeleted 时软删板的 JOIN 被过滤，
      // 「板已删」会伪装成「板不存在」）
      expect(listRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('orphan task（无 listId）', () => {
    it('read 允许（文档化公开语义，与 blockers/batch 同口径）', async () => {
      const result = await policy.can(
        makeActor(),
        makeTask({ listId: undefined as never }),
        'read',
      );
      expect(result).toBe(true);
      // orphan 分支不查库
      expect(listRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('write 拒绝（F4-2 fail-closed）', async () => {
      const result = await policy.can(
        makeActor({ id: 'assignee-1' }),
        makeTask({ listId: undefined as never }),
        'write',
      );
      expect(result).toBe(false);
      expect(listRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('delete 拒绝（F4-2 fail-closed）', async () => {
      const result = await policy.can(
        makeActor({ id: 'assignee-1' }),
        makeTask({ listId: undefined as never }),
        'delete',
      );
      expect(result).toBe(false);
    });
  });

  describe('真缺失（list/board 行不存在 = 数据损坏）', () => {
    it('list 行不存在：全动作拒 + 告警', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      mockListMissing();
      const actor = makeActor({ id: 'assignee-1' });

      await expect(policy.can(actor, makeTask(), 'read')).resolves.toBe(false);
      await expect(policy.can(actor, makeTask(), 'write')).resolves.toBe(false);
      await expect(policy.can(actor, makeTask(), 'delete')).resolves.toBe(false);
      // ops 可见性：静默 500/拒绝对排查毫无帮助（S-N1）
      expect(warn).toHaveBeenCalledTimes(3);
      warn.mockRestore();
    });

    it('board 行缺失（list 存在但 JOIN 不到板）：全动作拒', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      reloadGetOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1', board: null });

      await expect(policy.can(makeActor(), makeTask(), 'read')).resolves.toBe(false);
      await expect(policy.can(makeActor(), makeTask(), 'write')).resolves.toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('软删板（只读冷藏，F4-2 三态之②）', () => {
    const softDeleted = () => mockList({ deletedAt: new Date('2026-01-01T00:00:00Z') });

    it('成员 read 允许：委托 BoardPolicy（软删不改变可见性判定）', async () => {
      softDeleted();
      boardPolicy.can.mockResolvedValue(true);
      const actor = makeActor({ id: 'member-1' });

      await expect(policy.can(actor, makeTask(), 'read')).resolves.toBe(true);
      expect(boardPolicy.can).toHaveBeenCalledWith(actor, expect.anything(), 'read');
    });

    it('OPEN 软删板外人 read 仍允许（OPEN 语义不变）', async () => {
      softDeleted();
      // OPEN 语义由 BoardPolicy 承载（此处只验证"委托给它"，不重写其逻辑）
      boardPolicy.can.mockResolvedValue(true);

      await expect(policy.can(makeActor({ id: 'outsider' }), makeTask(), 'read')).resolves.toBe(
        true,
      );
    });

    it('任何人 write/delete 一律拒，且不查询 BoardPolicy', async () => {
      softDeleted();
      boardPolicy.can.mockResolvedValue(true); // 即使板策略放行也必须拒（软删冷藏）
      const assignee = makeActor({ id: 'assignee-1' });

      await expect(policy.can(assignee, makeTask(), 'write')).resolves.toBe(false);
      await expect(policy.can(assignee, makeTask(), 'delete')).resolves.toBe(false);
      expect(boardPolicy.can).not.toHaveBeenCalled();
    });
  });

  describe('write', () => {
    it('editor can write any task', async () => {
      mockList();
      boardPolicy.can.mockResolvedValue(true);
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(makeActor({ id: 'editor-1' }), task, 'write');
      expect(result).toBe(true);
    });

    it('non-editor cannot write others task', async () => {
      mockList();
      boardPolicy.can.mockResolvedValue(false);
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(makeActor({ id: 'stranger-1' }), task, 'write');
      expect(result).toBe(false);
    });

    it('私有板非成员 assignee：write 拒（F4-2：被指派 ≠ 授权来源）', async () => {
      mockList();
      mockBoardPolicy({ read: false, write: false });
      const task = makeTask({ assigneeId: 'outsider-assignee' });
      const result = await policy.can(makeActor({ id: 'outsider-assignee' }), task, 'write');
      expect(result).toBe(false);
    });

    it('私有板成员 assignee 非 editor：write 允许（boardRead 命中）', async () => {
      mockList();
      mockBoardPolicy({ read: true, write: false });
      const task = makeTask({ assigneeId: 'member-1' });
      const result = await policy.can(makeActor({ id: 'member-1' }), task, 'write');
      expect(result).toBe(true);
    });

    it('board 通道命中时不追加 read 查询（蕴含证明：write ⇒ read）', async () => {
      mockList();
      mockBoardPolicy({ read: true, write: true });
      // 非 assignee：只能靠 board 通道
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(makeActor({ id: 'editor-1' }), task, 'write');
      expect(result).toBe(true);
      // 只查一次（write）；再查一次 read 是纯浪费且掩盖"board write ⇒ read"的蕴含关系
      expect(boardPolicy.can).toHaveBeenCalledTimes(1);
      expect(boardPolicy.can).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'write');
    });

    it('write delegates owner proxy to BoardPolicy (no duplicate query)', async () => {
      mockList();
      // BoardPolicy 内部已含 owner 代理判定：返回 true 即代表 owner 代理放行
      boardPolicy.can.mockResolvedValue(true);
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(
        makeActor({ id: 'human-owner-1', type: ActorType.HUMAN }),
        task,
        'write',
      );
      expect(result).toBe(true);
      // write 分支不直接触发 ownerProxy（由 BoardPolicy 委托，避免重复查询）
      expect(ownerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('editor cannot delete others task', async () => {
      mockList();
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(makeActor({ id: 'editor-1' }), task, 'delete');
      expect(result).toBe(false);
    });

    it('assignee can delete own task（能读板时）', async () => {
      mockList();
      mockBoardPolicy({ read: true, write: false });
      const task = makeTask({ assigneeId: 'editor-1' });
      const result = await policy.can(makeActor({ id: 'editor-1' }), task, 'delete');
      expect(result).toBe(true);
    });

    it('私有板非成员 assignee：delete 拒（F4-2 合取 boardRead）', async () => {
      mockList();
      mockBoardPolicy({ read: false, write: false });
      const task = makeTask({ assigneeId: 'outsider-assignee' });
      const result = await policy.can(makeActor({ id: 'outsider-assignee' }), task, 'delete');
      expect(result).toBe(false);
    });

    it('board creator can delete any task', async () => {
      mockList();
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(
        makeActor({ id: 'creator-1', type: ActorType.HUMAN }),
        task,
        'delete',
      );
      expect(result).toBe(true);
      // creator 分支已蕴含 read（board.policy read 短路含 creator），不再查询
      expect(boardPolicy.can).not.toHaveBeenCalled();
    });

    it('owner human (of board creator agent) can delete any task', async () => {
      mockList();
      ownerProxy.isOwnerProxy.mockResolvedValue(true);
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(
        makeActor({ id: 'human-owner-1', type: ActorType.HUMAN }),
        task,
        'delete',
      );
      expect(result).toBe(true);
      expect(ownerProxy.isOwnerProxy).toHaveBeenCalledWith('creator-1', expect.anything());
    });

    it('non-owner human cannot delete others task', async () => {
      mockList();
      ownerProxy.isOwnerProxy.mockResolvedValue(false);
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(
        makeActor({ id: 'stranger-human', type: ActorType.HUMAN }),
        task,
        'delete',
      );
      expect(result).toBe(false);
    });
  });

  describe('read', () => {
    it('私有板非成员 assignee：read 拒（与单条 GET 404 同源）', async () => {
      mockList({ settings: { visibility: 'private' } });
      mockBoardPolicy({ read: false });
      const task = makeTask({ assigneeId: 'outsider-assignee' });
      const result = await policy.can(makeActor({ id: 'outsider-assignee' }), task, 'read');
      expect(result).toBe(false);
    });
  });

  describe('admin', () => {
    it('admin 全局 bypass：不查库', async () => {
      const result = await policy.can(makeActor({ role: UserRole.ADMIN }), makeTask(), 'delete');
      expect(result).toBe(true);
      expect(listRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
