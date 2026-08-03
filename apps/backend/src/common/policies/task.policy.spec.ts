import { TaskPolicy } from './task.policy';
import { BoardPolicy } from './board.policy';
import { BoardList } from '../../database/entities/board-list.entity';
import { Task } from '../../database/entities/task.entity';
import { UnifiedActor } from '../types/actor.types';
import { OwnerProxyService } from '../services/owner-proxy.service';
import { ActorType, UserRole, TaskStatus } from '@agent-chamber/shared';
import { Repository } from 'typeorm';

describe('TaskPolicy', () => {
  let policy: TaskPolicy;
  let listRepo: jest.Mocked<Repository<BoardList>>;
  let boardPolicy: jest.Mocked<BoardPolicy>;
  let ownerProxy: jest.Mocked<OwnerProxyService>;

  beforeEach(() => {
    listRepo = {
      findOne: jest.fn(),
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

  const mockList = () => {
    listRepo.findOne.mockResolvedValue({
      id: 'list-1',
      boardId: 'board-1',
      board: {
        id: 'board-1',
        creatorId: 'creator-1',
        creatorType: 'human',
        settings: {},
      },
    } as unknown as BoardList);
  };

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
  });

  describe('delete', () => {
    it('editor cannot delete others task', async () => {
      mockList();
      const task = makeTask({ assigneeId: 'other-agent' });
      const result = await policy.can(makeActor({ id: 'editor-1' }), task, 'delete');
      expect(result).toBe(false);
    });

    it('assignee can delete own task', async () => {
      mockList();
      const task = makeTask({ assigneeId: 'editor-1' });
      const result = await policy.can(makeActor({ id: 'editor-1' }), task, 'delete');
      expect(result).toBe(true);
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
});
