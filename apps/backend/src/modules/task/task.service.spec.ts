import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral, In, FindOneOptions, DataSource, EntityManager } from 'typeorm';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ActorType,
  TaskStatus,
  Priority,
  UserRole,
  ErrorCode,
  EventType,
} from '@agent-chamber/shared';
import { TaskService } from './task.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { TaskActivity } from '../../database/entities/task-activity.entity';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Board } from '../../database/entities/board.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Milestone } from '../../database/entities/milestone.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { EventService } from '../event/event.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ResourceValidator } from '../../common/resource-validator';
import { DocSpacePolicy } from '../../common/policies/doc-space.policy';
import { ActorProfileService, ActorProfile } from '../../common/services/actor-profile.service';

function createMockRepo<T extends ObjectLiteral>() {
  const qb = {
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn(),
    getMany: jest.fn(),
    getOne: jest.fn(),
  };
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    findBy: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
    manager: {
      query: jest.fn(),
    },
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    listId: 'list-1',
    topicId: null,
    parentId: null,
    title: 'Test Task',
    description: null,
    descriptionFormat: 'markdown',
    status: TaskStatus.BACKLOG,
    priority: Priority.P2,
    assigneeId: null,
    assigneeType: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    labels: null,
    position: 0,
    customFields: {},
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    list: null,
    topic: null,
    parent: null,
    subtasks: [],
    comments: [],
    activities: [],
    dependencies: [],
    dependents: [],
    blockers: [],
    ...overrides,
  } as Task;
}

function createMockTaskComment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: 'comment-1',
    taskId: 'task-1',
    authorId: 'user-1',
    authorType: ActorType.HUMAN,
    content: 'Test comment',
    contentFormat: 'markdown',
    replyToId: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    task: null,
    replyTo: null,
    replies: [],
    ...overrides,
  } as TaskComment;
}

function createMockTaskActivity(overrides: Partial<TaskActivity> = {}): TaskActivity {
  return {
    id: 'activity-1',
    taskId: 'task-1',
    action: 'created',
    fieldName: null,
    oldValue: null,
    newValue: null,
    meta: {},
    actorId: 'user-1',
    actorType: ActorType.HUMAN,
    createdAt: new Date('2024-01-01'),
    task: null,
    ...overrides,
  } as TaskActivity;
}

describe('TaskService', () => {
  let service: TaskService;
  let mockTaskRepo: jest.Mocked<Repository<Task>>;
  let mockCommentRepo: jest.Mocked<Repository<TaskComment>>;
  let mockActivityRepo: jest.Mocked<Repository<TaskActivity>>;
  let mockDepRepo: jest.Mocked<Repository<TaskDependency>>;
  let mockBoardListRepo: jest.Mocked<Repository<BoardList>>;
  let mockBoardRepo: jest.Mocked<Repository<Board>>;
  let mockAgentRepo: jest.Mocked<Repository<Agent>>;
  let mockUserRepo: jest.Mocked<Repository<User>>;
  let mockActorRepo: jest.Mocked<Repository<Actor>>;
  let mockMilestoneRepo: jest.Mocked<Repository<Milestone>>;
  let mockAccessQuery: jest.Mocked<AccessQueryService>;
  let mockResourceValidator: { exists: jest.Mock; existsMany: jest.Mock };
  let mockDataSource: jest.Mocked<DataSource>;
  let mockIdempotencyRepo: jest.Mocked<Repository<IdempotencyRecord>>;
  let mockDocLinkRepo: jest.Mocked<Repository<TaskDocLink>>;
  let mockDocRepo: jest.Mocked<Repository<Doc>>;
  let mockDocSpaceRepo: jest.Mocked<Repository<DocSpace>>;
  let mockDocSpacePolicy: { can: jest.Mock };
  let mockEventService: { create: jest.Mock };
  let mockActorProfileService: { resolveProfiles: jest.Mock; assertActorUsable: jest.Mock };

  beforeEach(async () => {
    mockTaskRepo = createMockRepo<Task>();
    mockCommentRepo = createMockRepo<TaskComment>();
    mockActivityRepo = createMockRepo<TaskActivity>();
    mockDepRepo = createMockRepo<TaskDependency>();
    mockBoardListRepo = createMockRepo<BoardList>();
    mockBoardRepo = createMockRepo<Board>();
    mockAgentRepo = createMockRepo<Agent>();
    mockUserRepo = createMockRepo<User>();
    mockActorRepo = createMockRepo<Actor>();
    mockMilestoneRepo = createMockRepo<Milestone>();
    mockIdempotencyRepo = createMockRepo<IdempotencyRecord>();
    mockDocLinkRepo = createMockRepo<TaskDocLink>();
    mockDocRepo = createMockRepo<Doc>();
    mockDocSpaceRepo = createMockRepo<DocSpace>();
    mockDocSpacePolicy = { can: jest.fn().mockResolvedValue(true) };
    mockEventService = { create: jest.fn().mockResolvedValue({}) };
    mockAccessQuery = {
      getAccessibleBoardIds: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccessQueryService>;

    // ResourceValidator mock：委托给真实 Repository mock，保持现有测试零改动
    mockResourceValidator = {
      exists: jest.fn(async (repo: Repository<ObjectLiteral>, id: string, errorCode: ErrorCode) => {
        const entity = await repo.findOne({ where: { id } as any });
        if (!entity) {
          throw new NotFoundException({ message: 'Resource not found', code: errorCode });
        }
        return entity;
      }),
      existsMany: jest.fn(
        async (repo: Repository<ObjectLiteral>, ids: string[], errorCode: ErrorCode) => {
          if (ids.length === 0) return [];
          const entities = await repo.findBy({ id: In(ids) } as any);
          if (entities.length !== ids.length) {
            throw new NotFoundException({ message: 'Some resources not found', code: errorCode });
          }
          return entities;
        },
      ),
    };

    // 统一批 A2：assignee/活动执行者解析委托 ActorProfileService。mock 默认实现
    // 复用三个 repo mock（actorRepo.find 取 type、user/agent repo 取 profile），
    // 行为等价（公共服务自身逻辑在 actor-profile.service.spec.ts 单独验证）。
    // deletedAt 从 actor 行透传——软删用例通过 actorRepo.find 返回带 deletedAt 的行驱动。
    mockActorProfileService = {
      resolveProfiles: jest.fn(async (actorIds: string[]): Promise<Map<string, ActorProfile>> => {
        const uniqueIds = [...new Set(actorIds)].filter(Boolean);
        const map = new Map<string, ActorProfile>();
        if (uniqueIds.length === 0) return map;
        const typeRows = await mockActorRepo.find({ where: { id: In(uniqueIds) } } as any);
        const typeMap = new Map(typeRows.map((a) => [a.id, a.type]));
        const actorRowMap = new Map(typeRows.map((a) => [a.id, a]));
        const humanIds = uniqueIds.filter((id) => typeMap.get(id) === ActorType.HUMAN);
        const agentIds = uniqueIds.filter((id) => typeMap.get(id) === ActorType.AGENT);
        const [humans, agents] = await Promise.all([
          humanIds.length > 0
            ? mockUserRepo.findBy({ id: In(humanIds) } as any)
            : Promise.resolve([] as User[]),
          agentIds.length > 0
            ? mockAgentRepo.findBy({ id: In(agentIds) } as any)
            : Promise.resolve([] as Agent[]),
        ]);
        const humanMap = new Map(humans.map((u) => [u.id, u]));
        const agentMap = new Map(agents.map((a) => [a.id, a]));
        for (const id of uniqueIds) {
          const type = typeMap.get(id);
          const deletedAt = actorRowMap.get(id)?.deletedAt ?? null;
          if (type === ActorType.HUMAN) {
            const u = humanMap.get(id);
            map.set(id, {
              type,
              name: u?.displayName || u?.username || 'Unknown User',
              avatarUrl: u?.avatarUrl ?? null,
              description: null,
              deletedAt,
            });
          } else if (type === ActorType.AGENT) {
            const a = agentMap.get(id);
            map.set(id, {
              type,
              name: a?.name || 'Unknown Agent',
              avatarUrl: a?.avatarUrl ?? null,
              description: a?.description ?? null,
              deletedAt,
            });
          } else if (type) {
            map.set(id, {
              type,
              name: 'System',
              avatarUrl: null,
              description: null,
              deletedAt,
            });
          }
        }
        return map;
      }),
      assertActorUsable: jest.fn().mockResolvedValue(undefined),
    };

    // DataSource mock：transaction 默认透传回调
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: EntityManager) => Promise<unknown>) => {
        return cb(mockEntityManager as unknown as EntityManager);
      }),
      getRepository: jest.fn(),
    } as unknown as jest.Mocked<DataSource>;

    // EntityManager mock：getRepository 按类型返回对应 mock repo
    const mockEntityManager = {
      getRepository: jest.fn((entityClass: unknown) => {
        if (entityClass === Task) return mockTaskRepo;
        if (entityClass === IdempotencyRecord) return mockIdempotencyRepo;
        return createMockRepo();
      }),
    };

    // 默认 getRepository 行为
    mockDataSource.getRepository.mockImplementation((entityClass: unknown) => {
      if (entityClass === IdempotencyRecord) return mockIdempotencyRepo;
      return createMockRepo();
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TaskService,
        { provide: getRepositoryToken(Task), useValue: mockTaskRepo },
        { provide: getRepositoryToken(TaskComment), useValue: mockCommentRepo },
        { provide: getRepositoryToken(TaskActivity), useValue: mockActivityRepo },
        { provide: getRepositoryToken(BoardList), useValue: mockBoardListRepo },
        { provide: getRepositoryToken(Board), useValue: mockBoardRepo },
        { provide: getRepositoryToken(TaskDependency), useValue: mockDepRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Actor), useValue: mockActorRepo },
        { provide: getRepositoryToken(Milestone), useValue: mockMilestoneRepo },
        { provide: getRepositoryToken(TaskDocLink), useValue: mockDocLinkRepo },
        { provide: getRepositoryToken(Doc), useValue: mockDocRepo },
        { provide: getRepositoryToken(DocSpace), useValue: mockDocSpaceRepo },
        { provide: DocSpacePolicy, useValue: mockDocSpacePolicy },
        { provide: EventService, useValue: mockEventService },
        { provide: AccessQueryService, useValue: mockAccessQuery },
        { provide: ResourceValidator, useValue: mockResourceValidator },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ActorProfileService, useValue: mockActorProfileService },
      ],
    }).compile();

    service = moduleRef.get<TaskService>(TaskService);
    jest.clearAllMocks();
    // 默认返回空依赖，避免 findOne 中的依赖查询报错（必须在 clearAllMocks 之后设置）
    mockDepRepo.find.mockResolvedValue([]);
    // Actor 类型统一由 actors 表推导；默认实现根据 ID 前缀返回类型（user-/agent-），
    // 未命中的 id 视为真孤儿（不进 map，由调用方兜底）
    mockActorRepo.find.mockImplementation(async (options: any) => {
      const ids: string[] = options?.where?.id?.value ?? [];
      return ids.map((id) => {
        if (id.startsWith('user-')) return { id, type: ActorType.HUMAN } as Actor;
        if (id.startsWith('agent-')) return { id, type: ActorType.AGENT } as Actor;
        return { id, type: ActorType.SYSTEM } as Actor;
      });
    });
    mockUserRepo.findBy.mockImplementation(async (criteria: any) => {
      const ids: string[] = criteria?.id?.value ?? [];
      return ids
        .filter((id) => id === 'user-1')
        .map((id) => ({ id, displayName: 'Alice', username: 'alice', avatarUrl: null }) as User);
    });
    mockAgentRepo.findBy.mockImplementation(async (criteria: any) => {
      const ids: string[] = criteria?.id?.value ?? [];
      return ids
        .filter((id) => id === 'agent-1')
        .map((id) => ({ id, name: 'Kimi', avatarUrl: null }) as Agent);
    });
  });

  describe('findAll', () => {
    it('should return paginated results with default values', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({});

      expect(mockTaskRepo.createQueryBuilder).toHaveBeenCalledWith('task');
      // WS-A 扁平化：leftJoinAndSelect 整行水合 → leftJoin + addSelect 部分列
      expect(qb.leftJoin).toHaveBeenCalledWith('task.list', 'list');
      expect(qb.addSelect).toHaveBeenCalledWith(['list.id', 'list.name', 'list.boardId']);
      expect(qb.leftJoin).toHaveBeenCalledWith('list.board', 'board');
      expect(qb.addSelect).toHaveBeenCalledWith(['board.id', 'board.name', 'board.topicId']);
      expect(qb.where).toHaveBeenCalledWith('task.deleted_at IS NULL');
      expect(qb.orderBy).toHaveBeenCalledWith('task.createdAt', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.totalPages).toBe(1);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(false);
    });

    it('should return paginated results with custom page and pageSize', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 25]);

      const result = await service.findAll({ page: 2, pageSize: 10 });

      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(25);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.totalPages).toBe(3);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(true);
    });

    it('should support limit as alias for pageSize', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({ limit: 15 });

      expect(qb.take).toHaveBeenCalledWith(15);
      expect(result.pageSize).toBe(15);
    });

    it('should batch resolve assigneeName for tasks with assignee', async () => {
      const items = [
        createMockTask({ assigneeId: 'agent-1', assigneeType: ActorType.AGENT }),
        createMockTask({ id: 'task-2', assigneeId: 'user-1', assigneeType: ActorType.HUMAN }),
        createMockTask({ id: 'task-3', assigneeId: null }),
      ];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 3]);
      mockAgentRepo.findBy.mockResolvedValue([{ id: 'agent-1', name: 'Kimi' } as Agent]);
      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', username: 'alice', displayName: 'Alice' } as User,
      ]);

      const result = await service.findAll({});

      // 统一批 A2：assignee 解析改走公共 ActorProfileService——actors 主查询一次 IN 批次，
      // agent/user 补查按类型过滤后各自查（不再全量交叉查）
      expect(mockActorRepo.find).toHaveBeenCalledWith({
        where: { id: In(['agent-1', 'user-1']) },
      });
      expect(mockAgentRepo.findBy).toHaveBeenCalledWith({ id: In(['agent-1']) });
      expect(mockUserRepo.findBy).toHaveBeenCalledWith({ id: In(['user-1']) });
      expect(result.items[0].assigneeName).toBe('Kimi');
      expect(result.items[0].assigneeDeletedAt).toBeNull();
      expect(result.items[1].assigneeName).toBe('Alice');
      expect(result.items[2].assigneeName).toBeNull();
      expect(result.items[2].assigneeDeletedAt).toBeNull();
    });

    it('should handle findAll with no assignees', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({});

      expect(mockAgentRepo.findBy).not.toHaveBeenCalled();
      expect(mockUserRepo.findBy).not.toHaveBeenCalled();
      expect(result.items[0].assigneeName).toBeNull();
    });

    it('软删 assignee：真名保留 + assigneeDeletedAt 非空（统一批契约）', async () => {
      const items = [createMockTask({ assigneeId: 'agent-1', assigneeType: ActorType.AGENT })];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);
      // 软删行：actors 带 deletedAt（withDeleted 语义经 mock 透传）
      mockActorRepo.find.mockResolvedValueOnce([
        {
          id: 'agent-1',
          type: ActorType.AGENT,
          deletedAt: new Date('2024-06-01T00:00:00Z'),
        } as Actor,
      ]);

      const result = await service.findAll({});

      expect(result.items[0]).toMatchObject({
        assigneeId: 'agent-1',
        assigneeName: 'Kimi',
        assigneeDeletedAt: '2024-06-01T00:00:00.000Z',
      });
    });

    it('should filter by boardId via list join', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({ boardId: 'board-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('list.board_id = :boardId', { boardId: 'board-1' });
    });

    it('should filter by status', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({ status: TaskStatus.IN_PROGRESS });

      expect(qb.andWhere).toHaveBeenCalledWith('task.status IN (:...statuses)', {
        statuses: ['in_progress'],
      });
    });

    it('should filter by status array', async () => {
      const items = [
        createMockTask({ id: 'task-1', status: TaskStatus.TODO }),
        createMockTask({ id: 'task-2', status: TaskStatus.IN_PROGRESS }),
        createMockTask({ id: 'task-3', status: TaskStatus.DONE }),
      ];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 3]);

      const result = await service.findAll({
        status: [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
      });

      expect(qb.andWhere).toHaveBeenCalledWith('task.status IN (:...statuses)', {
        statuses: ['todo', 'in_progress'],
      });
      expect(result.items).toHaveLength(3);
    });

    it('should not filter status when status is all', async () => {
      const items = [
        createMockTask({ id: 'task-1', status: TaskStatus.TODO }),
        createMockTask({ id: 'task-2', status: TaskStatus.DONE }),
      ];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 2]);

      const result = await service.findAll({ status: 'all' });

      expect(qb.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('task.status IN'),
        expect.anything(),
      );
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('should handle empty results', async () => {
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

      const result = await service.findAll({ page: 3, pageSize: 5 });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(5);
      expect(result.totalPages).toBe(0);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(true);
    });

    it('should not add IN filter for admin actor', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(null);

      const adminActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      await service.findAll({}, adminActor);

      expect(mockAccessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(adminActor);
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'list.board_id IN (:...accessibleBoardIds)',
        expect.anything(),
      );
    });

    it('should add IN filter for non-admin actor', async () => {
      const items = [createMockTask({ list: { boardId: 'board-1' } as BoardList })];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({}, actor);

      expect(mockAccessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(actor);
      expect(qb.andWhere).toHaveBeenCalledWith('list.board_id IN (:...accessibleBoardIds)', {
        accessibleBoardIds: ['board-1'],
      });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('should return empty pagination when accessible board ids is empty', async () => {
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue([]);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({ page: 1, pageSize: 20 }, actor);

      expect(mockTaskRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('should enrich items with boardId and topicId from list→board join', async () => {
      const items = [
        createMockTask({
          list: { boardId: 'board-1', board: { topicId: 'topic-1' } } as unknown as BoardList,
        }),
      ];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({});

      expect(result.items[0].boardId).toBe('board-1');
      // topicId 从 list→board join 派生，不再来自 task.topicId（列为已删除）
      expect(result.items[0].topicId).toBe('topic-1');
    });

    it('should filter by topicId via board join instead of task.topic_id', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({ topicId: 'topic-1' });

      // Batch 3: topicId 过滤已改为 board.topic_id join，不再使用 task.topic_id
      expect(qb.andWhere).toHaveBeenCalledWith('board.topic_id = :topicId', { topicId: 'topic-1' });
    });

    it('should leftJoin list.board for topicId derivation', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({});

      // Batch 3: findAll 新增 list.board join 以派生 topicId + topicId 过滤
      // WS-A 扁平化：join 保留（WHERE 过滤依赖），select 改为部分列
      expect(qb.leftJoin).toHaveBeenCalledWith('list.board', 'board');
      expect(qb.addSelect).toHaveBeenCalledWith(['board.id', 'board.name', 'board.topicId']);
    });

    it('should assemble items via explicit whitelist without nested entities', async () => {
      const items = [
        createMockTask({
          list: {
            id: 'list-1',
            name: 'To Do',
            boardId: 'board-1',
            board: { id: 'board-1', name: 'My Board', topicId: 'topic-1' },
          } as unknown as BoardList,
        }),
      ];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({});

      // WS-A 扁平化：白名单组装，嵌套实体键一律不出现
      expect(result.items[0]).not.toHaveProperty('list');
      expect(result.items[0]).not.toHaveProperty('board');
      expect(result.items[0]).not.toHaveProperty('dependencies');
      expect(result.items[0]).not.toHaveProperty('dependents');
      expect(result.items[0]).not.toHaveProperty('description');
      // 扁平字段：listId 显式列出 + boardName/listName 从部分水合 join 派生
      expect(result.items[0]).toMatchObject({
        listId: 'list-1',
        boardId: 'board-1',
        topicId: 'topic-1',
        boardName: 'My Board',
        listName: 'To Do',
      });
    });

    it('should fall back to null for list-derived fields when list is missing', async () => {
      const items = [createMockTask()]; // list 默认 null
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({});

      expect(result.items[0]).toMatchObject({
        listId: 'list-1', // Task 实体直接列，与 join 无关
        boardId: null,
        topicId: null,
        boardName: null,
        listName: null,
      });
    });

    it('should order by status priority CASE with updatedAt/id tie-breakers when sort=statusPriority', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({ sort: 'statusPriority' });

      // 权重序：in_progress > todo > blocked > backlog > 其余（review/done/archived 恒末位）。
      // CASE 经 addSelect 命名列（TypeORM 对含 "." 的 orderBy 键按 alias.property 解析，
      // 表达式必须走 addSelect+别名模式；别名全小写防 PG 大小写折叠），orderBy 引用别名
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining("WHEN 'in_progress' THEN 0"),
        'status_priority_order',
      );
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining("WHEN 'todo' THEN 1"),
        'status_priority_order',
      );
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining("WHEN 'blocked' THEN 2"),
        'status_priority_order',
      );
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining("WHEN 'backlog' THEN 3"),
        'status_priority_order',
      );
      expect(qb.addSelect).toHaveBeenCalledWith(
        expect.stringContaining('ELSE 4 END'),
        'status_priority_order',
      );
      expect(qb.orderBy).toHaveBeenCalledWith('status_priority_order', 'ASC');
      // 次键 updatedAt DESC + 第三键 id ASC 兜底稳定分页
      expect(qb.addOrderBy).toHaveBeenCalledWith('task.updatedAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('task.id', 'ASC');
    });

    it('should keep default createdAt DESC ordering when sort is omitted', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({});

      expect(qb.orderBy).toHaveBeenCalledWith('task.createdAt', 'DESC');
      expect(qb.addOrderBy).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a task without comments/activities fields and derive boardId/topicId from list→board', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
        board: { topicId: 'topic-1' },
      } as BoardList);

      const result = await service.findOne('task-1');

      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        relations: ['milestone'],
      });
      expect(mockBoardListRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'list-1' },
        relations: ['board'],
      });
      // 验证响应不含 comments / activities 属性
      expect(result).not.toHaveProperty('comments');
      expect(result).not.toHaveProperty('activities');
      // Batch 3: boardId 和 topicId 从 list→board 派生填充
      expect(result.boardId).toBe('board-1');
      expect(result.topicId).toBe('topic-1');
    });

    it('should map embedded dependency tasks to summary {id, title, status}', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
        board: { topicId: 'topic-1' },
      } as BoardList);

      // 模拟依赖关系：dependsOnTask 内嵌完整 Task 实体（含 description）
      const fullTask = {
        id: 'dep-task-1',
        title: 'Dep Task',
        description: 'should be stripped',
        status: TaskStatus.IN_PROGRESS,
      };
      mockDepRepo.find
        .mockResolvedValueOnce([
          {
            id: 'dep-rel-1',
            taskId: 'task-1',
            dependsOnTaskId: 'dep-task-1',
            type: 'blocks',
            createdAt: new Date('2024-01-01'),
            dependsOnTask: fullTask,
            task: null,
          } as any,
        ])
        .mockResolvedValueOnce([
          {
            id: 'dep-rel-2',
            taskId: 'dep-task-2',
            dependsOnTaskId: 'task-1',
            type: 'blocks',
            createdAt: new Date('2024-01-01'),
            dependsOnTask: null,
            task: {
              id: 'dep-task-2',
              title: 'Dependent Task',
              description: 'should be stripped too',
              status: TaskStatus.DONE,
            },
          } as any,
        ]);

      mockActorRepo.findOne.mockResolvedValue(null);

      const result = await service.findOne('task-1');

      // dependencies: dependsOnTask 应仅有 {id, title, status}
      expect(result.dependencies).toHaveLength(1);
      expect(result.dependencies![0].dependsOnTask).toEqual({
        id: 'dep-task-1',
        title: 'Dep Task',
        status: TaskStatus.IN_PROGRESS,
      });
      expect(result.dependencies![0].dependsOnTask as any).not.toHaveProperty('description');

      // dependents: task 应仅有 {id, title, status}
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents![0].task).toEqual({
        id: 'dep-task-2',
        title: 'Dependent Task',
        status: TaskStatus.DONE,
      });
      expect(result.dependents![0].task as any).not.toHaveProperty('description');
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('not-found')).rejects.toThrow(NotFoundException);
      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'not-found' },
        relations: ['milestone'],
      });
    });

    it('should include docs field populated from doc links', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
        board: { topicId: 'topic-1' },
      } as BoardList);
      mockDepRepo.find.mockResolvedValue([]);
      mockActorRepo.findOne.mockResolvedValue(null);

      // Mock docLinkRepo.find to return a link
      mockDocLinkRepo.find.mockResolvedValue([
        { taskId: 'task-1', docId: 'doc-1' } as unknown as TaskDocLink,
      ]);

      // Mock docRepo.createQueryBuilder chain for doc lookup
      const docQb = {
        select: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            {
              d_id: 'doc-1',
              d_path: 'docs/readme.md',
              d_title: 'Readme',
              d_summary: 'A readme file',
            },
          ]),
        getOne: jest.fn(),
        getMany: jest.fn(),
        getManyAndCount: jest.fn(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
      };
      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(docQb);

      const result = await service.findOne('task-1');

      expect(result.docs).toEqual([
        {
          docId: 'doc-1',
          path: 'docs/readme.md',
          title: 'Readme',
          summary: 'A readme file',
        },
      ]);
    });

    it("详情响应含 descriptionHash（sha256(description ?? '')，乐观锁 token）", async () => {
      const task = createMockTask({ description: '第一段' });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
        board: { topicId: 'topic-1' },
      } as BoardList);
      mockDepRepo.find.mockResolvedValue([]);
      mockActorRepo.findOne.mockResolvedValue(null);

      const result = await service.findOne('task-1');

      const { createHash } = require('crypto');
      expect(result.descriptionHash).toBe(createHash('sha256').update('第一段').digest('hex'));
    });

    it("description 为 null → descriptionHash = sha256('')", async () => {
      const task = createMockTask(); // description: null
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
        board: { topicId: 'topic-1' },
      } as BoardList);
      mockDepRepo.find.mockResolvedValue([]);
      mockActorRepo.findOne.mockResolvedValue(null);

      const result = await service.findOne('task-1');

      const { createHash } = require('crypto');
      expect(result.descriptionHash).toBe(createHash('sha256').update('').digest('hex'));
    });
  });

  describe('create', () => {
    it('should create task and log activity with real actorId', async () => {
      const dto = {
        title: 'New Task',
        boardId: 'board-1',
        listId: 'list-1',
      };
      const createdTask = createMockTask({ title: 'New Task', assigneeId: 'creator-1' });
      const savedTask = createMockTask({ title: 'New Task', assigneeId: 'creator-1' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockBoardRepo.findOne).toHaveBeenCalledWith({ where: { id: 'board-1' } });
      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Task',
          listId: 'list-1',
          assigneeId: 'creator-1',
        }),
      );
      expect(mockTaskRepo.save).toHaveBeenCalledWith(createdTask);
      expect(mockActivityRepo.save).toHaveBeenCalledWith({
        taskId: savedTask.id,
        action: 'created',
        actorId: 'creator-1',
        actorType: 'human',
        details: '创建了任务',
      });
      // Batch 3: create 返回 boardId/topicId，由 board→topic 派生填充
      expect(result).toEqual({ ...savedTask, boardId: 'board-1', topicId: 'topic-1' });
    });

    it('should derive assigneeType from Actor when creating task with assigneeId', async () => {
      const dto = {
        title: 'Agent Task',
        boardId: 'board-1',
        listId: 'list-1',
        assigneeId: 'agent-1',
      };
      const createdTask = createMockTask({ title: 'Agent Task', assigneeId: 'agent-1' });
      const savedTask = createMockTask({
        title: 'Agent Task',
        assigneeId: 'agent-1',
        assigneeType: ActorType.AGENT,
      });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockActorRepo.findOne.mockResolvedValue({ id: 'agent-1', type: ActorType.AGENT } as Actor);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockActorRepo.findOne).toHaveBeenCalledWith({ where: { id: 'agent-1' } });
      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: 'agent-1', assigneeType: ActorType.AGENT }),
      );
      expect(result).toEqual(
        expect.objectContaining({ assigneeId: 'agent-1', assigneeType: ActorType.AGENT }),
      );
    });

    it('create assigneeId：指向已软删 agent → 4xx AGENT_NOT_FOUND（统一批 A2.5）', async () => {
      const dto = {
        title: 'Agent Task',
        boardId: 'board-1',
        listId: 'list-1',
        assigneeId: 'agent-deleted',
      };
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('create assigneeId：指向已软删 user → 同样 4xx AGENT_NOT_FOUND（任意 actor type）', async () => {
      const dto = {
        title: 'Agent Task',
        boardId: 'board-1',
        listId: 'list-1',
        assigneeId: 'user-deleted',
      };
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
    });

    it('should update lastActiveAt when agent creates a task', async () => {
      const dto = {
        title: 'Agent Created Task',
        boardId: 'board-1',
        listId: 'list-1',
      };
      const createdTask = createMockTask({ title: 'Agent Created Task' });
      const savedTask = createMockTask({ title: 'Agent Created Task' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);
      mockAgentRepo.findOne.mockResolvedValue({ id: 'agent-1' } as unknown as Agent);

      await service.create(dto, 'agent-1', ActorType.AGENT);

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'agent-1' } });
      expect(mockAgentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-1',
          lastActiveAt: expect.any(Date),
        }),
      );
    });

    it('should not update lastActiveAt when human creates a task', async () => {
      const dto = {
        title: 'Human Created Task',
        boardId: 'board-1',
        listId: 'list-1',
      };
      const createdTask = createMockTask({ title: 'Human Created Task' });
      const savedTask = createMockTask({ title: 'Human Created Task' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      await service.create(dto, 'user-1', ActorType.HUMAN);

      expect(mockAgentRepo.findOne).not.toHaveBeenCalled();
      expect(mockAgentRepo.save).not.toHaveBeenCalled();
    });

    it('should default assigneeId to creator when not provided', async () => {
      const dto = {
        title: 'Unassigned Task',
        boardId: 'board-1',
        listId: 'list-1',
      };
      const createdTask = createMockTask({ title: 'Unassigned Task' });
      const savedTask = createMockTask({ title: 'Unassigned Task' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);
      mockActorRepo.findOne.mockResolvedValue({ id: 'agent-1', type: ActorType.AGENT } as Actor);

      await service.create(dto, 'agent-1', ActorType.AGENT);

      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Unassigned Task',
          assigneeId: 'agent-1',
        }),
      );
    });

    it('should throw BOARD_NOT_FOUND when boardId does not exist', async () => {
      const dto = { title: 'New Task', boardId: 'board-missing', listId: 'list-1' };
      mockBoardRepo.findOne.mockResolvedValue(null);

      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
      await expect(service.create(dto)).rejects.toMatchObject({
        response: { code: ErrorCode.BOARD_NOT_FOUND },
      });
    });

    it('should support optional milestoneId on create', async () => {
      const dto = { title: 'Task with Milestone', listId: 'list-1', milestoneId: 'ms-1' };
      const createdTask = createMockTask({ title: 'Task with Milestone', milestoneId: 'ms-1' });
      const savedTask = createMockTask({ title: 'Task with Milestone', milestoneId: 'ms-1' });

      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      // P2: milestone 必须存在且同 board
      mockMilestoneRepo.findOne.mockResolvedValue({
        id: 'ms-1',
        boardId: 'board-1',
      } as Milestone);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      const result = await service.create(dto);

      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Task with Milestone',
          milestoneId: 'ms-1',
        }),
      );
      // Batch 3: create 返回 boardId（从 list 推断），topicId 当 list.board 不可用时为 null
      expect(result).toEqual({ ...savedTask, boardId: 'board-1', topicId: null });
    });

    it('should reject create when milestone does not exist (P2)', async () => {
      const dto = { title: 'Task', listId: 'list-1', milestoneId: 'ms-missing' };
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      // milestone 不存在 → resourceValidator 抛 NotFoundException
      mockMilestoneRepo.findOne.mockResolvedValue(null);

      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
      await expect(service.create(dto)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_NOT_FOUND },
      });
    });

    it('should reject create when milestone belongs to different board (P2)', async () => {
      const dto = { title: 'Task', listId: 'list-1', milestoneId: 'ms-1' };
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      // milestone 属于 board-2，与 task 的 board-1 不同
      mockMilestoneRepo.findOne.mockResolvedValue({
        id: 'ms-1',
        boardId: 'board-2',
      } as Milestone);

      await expect(service.create(dto)).rejects.toThrow(
        'Milestone does not belong to the same board as the task',
      );
    });

    it('should support optional status field on create', async () => {
      const dto = {
        title: 'New Task',
        boardId: 'board-1',
        listId: 'list-1',
        status: TaskStatus.IN_PROGRESS,
      };
      const createdTask = createMockTask({ title: 'New Task', status: TaskStatus.IN_PROGRESS });
      const savedTask = createMockTask({ title: 'New Task', status: TaskStatus.IN_PROGRESS });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Task',
          status: TaskStatus.IN_PROGRESS,
        }),
      );
      expect(result).toEqual({ ...savedTask, boardId: 'board-1', topicId: 'topic-1' });
    });

    it('should support customFields on create', async () => {
      const dto = {
        title: 'New Task',
        boardId: 'board-1',
        listId: 'list-1',
        customFields: { priority: 'urgent', source: 'slack' },
      };
      const createdTask = createMockTask({
        title: 'New Task',
        customFields: { priority: 'urgent', source: 'slack' },
      });
      const savedTask = createMockTask({
        title: 'New Task',
        customFields: { priority: 'urgent', source: 'slack' },
      });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Task',
          customFields: { priority: 'urgent', source: 'slack' },
        }),
      );
      expect(result).toEqual({ ...savedTask, boardId: 'board-1', topicId: 'topic-1' });
    });

    it('should not log activity when no actorId provided', async () => {
      const dto = { title: 'New Task', boardId: 'board-1', listId: 'list-1' };
      const createdTask = createMockTask({ title: 'New Task' });
      const savedTask = createMockTask({ title: 'New Task' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      await service.create(dto);

      expect(mockActivityRepo.save).not.toHaveBeenCalled();
    });

    it('should infer boardId and topicId from listId when boardId not provided', async () => {
      const dto = { title: 'New Task', listId: 'list-1' };
      const createdTask = createMockTask({ title: 'New Task' });
      const savedTask = createMockTask({ title: 'New Task' });

      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'inferred-board-1',
        board: { id: 'inferred-board-1', topicId: 'topic-1' },
      } as BoardList);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockBoardListRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'list-1' },
        relations: ['board'],
      });
      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Task',
          listId: 'list-1',
        }),
      );
    });

    it('should throw LIST_NOT_FOUND when listId does not exist', async () => {
      const dto = { title: 'New Task', listId: 'non-existent-list' };
      mockBoardListRepo.findOne.mockResolvedValue(null);

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toMatchObject({
        response: {
          message: 'Board list not found',
          code: ErrorCode.LIST_NOT_FOUND,
        },
      });

      expect(mockTaskRepo.create).not.toHaveBeenCalled();
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    // ── Idempotency: clientRequestId ──

    it('should create task normally when clientRequestId is not provided (zero overhead)', async () => {
      const dto = {
        title: 'Normal Task',
        boardId: 'board-1',
        listId: 'list-1',
      };
      const createdTask = createMockTask({ title: 'Normal Task', assigneeId: 'creator-1' });
      const savedTask = createMockTask({ title: 'Normal Task', assigneeId: 'creator-1' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      await service.create(dto, 'creator-1', ActorType.HUMAN);

      // 事务不应被调用（无 clientRequestId）
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('should create task with idempotency key and write idempotency record', async () => {
      const dto = {
        title: 'Idempotent Task',
        boardId: 'board-1',
        listId: 'list-1',
        clientRequestId: 'req-001',
      };
      const createdTask = createMockTask({ title: 'Idempotent Task', assigneeId: 'creator-1' });
      const savedTask = createMockTask({
        id: 'task-idem-1',
        title: 'Idempotent Task',
        assigneeId: 'creator-1',
      });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);
      mockIdempotencyRepo.save.mockResolvedValue({
        id: 'rec-1',
        actorId: 'creator-1',
        clientRequestId: 'req-001',
        entityType: 'task',
        entityId: 'task-idem-1',
      } as IdempotencyRecord);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      // 事务被调用
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      // 幂等记录被写入
      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'creator-1',
          clientRequestId: 'req-001',
          entityType: 'task',
          entityId: 'task-idem-1',
        }),
      );
      // 返回无 idempotentReplay 标记
      expect(result).not.toHaveProperty('idempotentReplay');
    });

    it('should return existing task with idempotentReplay on 23505 (replay)', async () => {
      const dto = {
        title: 'Replay Task',
        boardId: 'board-1',
        listId: 'list-1',
        clientRequestId: 'req-002',
      };

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);

      // Transaction 抛出 23505
      const pgError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_idempotency_actor_key',
      });
      mockDataSource.transaction.mockRejectedValueOnce(pgError);

      // idempotency record lookup
      mockIdempotencyRepo.findOne.mockResolvedValue({
        id: 'rec-2',
        actorId: 'creator-1',
        clientRequestId: 'req-002',
        entityType: 'task',
        entityId: 'task-existing-1',
      } as IdempotencyRecord);

      // findOne returns the existing task
      const existingTask = createMockTask({ id: 'task-existing-1', title: 'Existing Task' });
      mockTaskRepo.findOne.mockResolvedValue(existingTask);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(result).toHaveProperty('idempotentReplay', true);
      expect(result.id).toBe('task-existing-1');
    });

    it('should rethrow non-idempotency 23505 error', async () => {
      const dto = {
        title: 'Other Error Task',
        boardId: 'board-1',
        listId: 'list-1',
        clientRequestId: 'req-003',
      };

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);

      // Transaction 抛出不同的 23505（不是 uq_idempotency_actor_key）
      const pgError = Object.assign(new Error('other unique violation'), {
        code: '23505',
        constraint: 'some_other_constraint',
      });
      mockDataSource.transaction.mockRejectedValueOnce(pgError);

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toThrow(
        'other unique violation',
      );
    });

    it('should rethrow non-23505 error', async () => {
      const dto = {
        title: 'Other Error Task',
        boardId: 'board-1',
        listId: 'list-1',
        clientRequestId: 'req-004',
      };

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);

      mockDataSource.transaction.mockRejectedValueOnce(new Error('connection error'));

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toThrow(
        'connection error',
      );
    });

    // ── statusName → listId 解析（与 MCP create_task resolveList 契约对齐）──

    it('should resolve listId from statusName via mappedStatus ci exact match (layer 1)', async () => {
      const dto = { title: 'StatusName Task', boardId: 'board-1', statusName: 'TODO' };
      const createdTask = createMockTask({ title: 'StatusName Task', listId: 'list-1' });
      const savedTask = createMockTask({ title: 'StatusName Task', listId: 'list-1' });

      // layer 1: mappedStatus 大小写不敏感精确命中（'TODO' → 'todo'）
      mockBoardListRepo.find.mockResolvedValue([
        { id: 'list-1', name: 'To Do', mappedStatus: 'todo' } as BoardList,
      ]);
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      const result = await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockBoardListRepo.find).toHaveBeenCalledWith({ where: { boardId: 'board-1' } });
      // 解析出的 listId 落入 taskRepo.create，且 statusName 必须被剥离（否则 TypeORM unknown column）
      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'StatusName Task', listId: 'list-1' }),
      );
      expect(mockTaskRepo.create.mock.calls[0][0]).not.toHaveProperty('statusName');
      expect(result).toEqual({ ...savedTask, boardId: 'board-1', topicId: 'topic-1' });
    });

    it('should resolve listId from statusName via list name ci exact match (layer 2)', async () => {
      const dto = { title: 'Layer2 Task', boardId: 'board-1', statusName: 'to do' };

      // layer 2: 列名 ci 精确命中（'to do' → 'To Do'），mappedStatus 不匹配
      mockBoardListRepo.find.mockResolvedValue([
        { id: 'list-1', name: 'To Do', mappedStatus: 'in_progress' } as BoardList,
      ]);
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(
        createMockTask({ title: 'Layer2 Task', listId: 'list-1' }),
      );
      mockTaskRepo.save.mockResolvedValue(
        createMockTask({ title: 'Layer2 Task', listId: 'list-1' }),
      );

      await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Layer2 Task', listId: 'list-1' }),
      );
      expect(mockTaskRepo.create.mock.calls[0][0]).not.toHaveProperty('statusName');
    });

    it('should resolve listId from statusName via list name ci substring match (layer 3)', async () => {
      const dto = { title: 'Layer3 Task', boardId: 'board-1', statusName: 'Do' };

      // layer 3: 列名子串命中（'Do' ⊂ 'To Do'）
      mockBoardListRepo.find.mockResolvedValue([
        { id: 'list-1', name: 'To Do', mappedStatus: null } as BoardList,
      ]);
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(
        createMockTask({ title: 'Layer3 Task', listId: 'list-1' }),
      );
      mockTaskRepo.save.mockResolvedValue(
        createMockTask({ title: 'Layer3 Task', listId: 'list-1' }),
      );

      await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Layer3 Task', listId: 'list-1' }),
      );
    });

    it('should reject statusName with 400 + available options when 0 lists match', async () => {
      const dto = { title: 'NoMatch Task', boardId: 'board-1', statusName: 'nonexistent' };

      // boardListRepo.find 默认 mockResolvedValue([]) → 0 命中
      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toMatchObject({
        response: {
          message: expect.stringContaining('did not match any list'),
          code: ErrorCode.VALIDATION_ERROR,
        },
      });

      expect(mockTaskRepo.create).not.toHaveBeenCalled();
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('should reject statusName with 400 + candidates when multiple lists match', async () => {
      const dto = { title: 'Ambiguous Task', boardId: 'board-1', statusName: 'todo' };

      // 两个列 mappedStatus 均为 todo → 多命中，绝不静默挑选
      mockBoardListRepo.find.mockResolvedValue([
        { id: 'list-1', name: 'To Do', mappedStatus: 'todo' } as BoardList,
        { id: 'list-2', name: 'Todos', mappedStatus: 'todo' } as BoardList,
      ]);

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toMatchObject({
        response: {
          message: expect.stringContaining('matches 2 lists via mappedStatus'),
          code: ErrorCode.VALIDATION_ERROR,
          candidates: [
            { id: 'list-1', name: 'To Do', mappedStatus: 'todo' },
            { id: 'list-2', name: 'Todos', mappedStatus: 'todo' },
          ],
          isAmbiguous: true,
        },
      });
    });

    it('should prefer listId and ignore statusName when both are provided', async () => {
      const dto = {
        title: 'Both Provided',
        boardId: 'board-1',
        listId: 'list-1',
        statusName: 'todo',
      };
      const createdTask = createMockTask({ title: 'Both Provided', listId: 'list-1' });
      const savedTask = createMockTask({ title: 'Both Provided', listId: 'list-1' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      await service.create(dto, 'creator-1', ActorType.HUMAN);

      // listId 优先：解析不触发，statusName 仅被剥离不落库
      expect(mockBoardListRepo.find).not.toHaveBeenCalled();
      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Both Provided', listId: 'list-1' }),
      );
      expect(mockTaskRepo.create.mock.calls[0][0]).not.toHaveProperty('statusName');
    });

    it('should reject 400 when neither listId nor statusName is provided', async () => {
      const dto = { title: 'No Target' };

      await expect(service.create(dto)).rejects.toMatchObject({
        response: {
          message: 'Either listId or statusName is required',
          code: ErrorCode.VALIDATION_ERROR,
        },
      });
    });

    it('should reject 400 when statusName is provided without boardId', async () => {
      const dto = { title: 'No Board', statusName: 'todo' };

      await expect(service.create(dto)).rejects.toMatchObject({
        response: {
          message: 'boardId is required when resolving the target list by statusName',
          code: ErrorCode.VALIDATION_ERROR,
        },
      });
      expect(mockBoardListRepo.find).not.toHaveBeenCalled();
    });

    it('should not trigger statusName resolution when only listId is provided (legacy path)', async () => {
      const dto = { title: 'Legacy Task', listId: 'list-1' };
      const createdTask = createMockTask({ title: 'Legacy Task' });
      const savedTask = createMockTask({ title: 'Legacy Task' });

      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);

      await service.create(dto, 'creator-1', ActorType.HUMAN);

      expect(mockBoardListRepo.find).not.toHaveBeenCalled();
      expect(mockTaskRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Legacy Task', listId: 'list-1' }),
      );
    });
  });

  describe('update', () => {
    it('should update and save a task', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { title: 'Updated Task' };
      const result = await service.update('task-1', dto);

      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        relations: ['milestone'],
      });
      expect(result.title).toBe('Updated Task');
      expect(mockTaskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Updated Task' }),
      );
      expect(result).toEqual(expect.objectContaining({ title: 'Updated Task' }));
    });

    it('should persist milestoneId update even when old milestone relation is loaded', async () => {
      const task = createMockTask({
        milestoneId: 'ms-old',
        milestone: { id: 'ms-old', name: 'Old Milestone' } as Milestone,
        listId: 'list-1',
        list: { boardId: 'board-1' } as BoardList,
      });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));
      // P2: milestone 必须存在且同 board；boardId 经 listId→BoardList 显式查询推断
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      mockMilestoneRepo.findOne.mockResolvedValue({
        id: 'ms-new',
        boardId: 'board-1',
      } as Milestone);

      const dto = { milestoneId: 'ms-new' };
      const result = await service.update('task-1', dto);

      expect(result.milestoneId).toBe('ms-new');
      expect(mockTaskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          milestoneId: 'ms-new',
          milestone: expect.objectContaining({ id: 'ms-new' }),
        }),
      );
    });

    it('should update assigneeId and derive assigneeType from Actor', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));
      mockActorRepo.findOne.mockResolvedValue({ id: 'user-2', type: ActorType.HUMAN } as Actor);

      const dto = { assigneeId: 'user-2' };
      const result = await service.update('task-1', dto, 'actor-1', ActorType.HUMAN);

      expect(result.assigneeId).toBe('user-2');
      expect(result.assigneeType).toBe('human');
      expect(mockActorRepo.findOne).toHaveBeenCalledWith({ where: { id: 'user-2' } });
      expect(mockActivityRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          action: 'updated',
          fieldName: 'assigneeId',
          newValue: { assigneeId: 'user-2' },
          actorId: 'actor-1',
          actorType: 'human',
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ assigneeId: 'user-2', assigneeType: 'human' }),
      );
    });

    it('should derive assigneeType from Actor when only assigneeId provided', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));
      mockActorRepo.findOne.mockResolvedValue({ id: 'user-2', type: ActorType.HUMAN } as Actor);

      const dto = { assigneeId: 'user-2' };
      const result = await service.update('task-1', dto);

      expect(result.assigneeId).toBe('user-2');
      expect(result.assigneeType).toBe('human');
    });

    it('update assigneeId：指向已软删 agent → 4xx AGENT_NOT_FOUND（统一批 A2.5）', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.update('task-1', { assigneeId: 'agent-deleted' })).rejects.toMatchObject(
        {
          response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
        },
      );
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('update assigneeId：指向已软删 user → 同样 4xx AGENT_NOT_FOUND（任意 actor type）', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.update('task-1', { assigneeId: 'user-deleted' })).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
    });

    it('should clear assigneeType when assigneeId set to empty', async () => {
      const task = createMockTask({ assigneeId: 'user-1', assigneeType: ActorType.HUMAN });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { assigneeId: '' };
      const result = await service.update('task-1', dto);

      expect(result.assigneeId).toBeNull();
      expect(result.assigneeType).toBeNull();
    });

    it('should not change assignee when assigneeId is not provided in update', async () => {
      const task = createMockTask({ assigneeId: 'user-1', assigneeType: ActorType.HUMAN });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      // 只传 title，不传 assigneeId，assignee 应保持不变
      const dto = { title: 'New Title Only' };
      const result = await service.update('task-1', dto, 'actor-1', ActorType.HUMAN);

      expect(result.assigneeId).toBe('user-1');
      expect(result.assigneeType).toBe('human');
      expect(result.title).toBe('New Title Only');
    });

    it('should auto-move task to mapped list when status changes', async () => {
      const task = createMockTask({ listId: 'list-backlog' });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      // 当前列属于 board-1，board 下有 mappedStatus=in_progress 的列
      mockBoardListRepo.findOne.mockResolvedValueOnce({
        id: 'list-backlog',
        boardId: 'board-1',
      } as BoardList); // 查当前列的 boardId
      const qb = mockBoardListRepo.createQueryBuilder();
      (qb.getOne as jest.Mock).mockResolvedValueOnce({
        id: 'list-in-progress',
        boardId: 'board-1',
        mappedStatus: 'in_progress',
      } as BoardList); // 查目标列

      const dto = { status: TaskStatus.IN_PROGRESS };
      const result = await service.update('task-1', dto);

      expect(result.status).toBe('in_progress');
      expect(result.listId).toBe('list-in-progress');
      expect(mockTaskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'in_progress', listId: 'list-in-progress' }),
      );
    });

    it('should not move task when no mapped list for status', async () => {
      const task = createMockTask({ listId: 'list-backlog' });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      // 当前列属于 board-1，但 board 下没有 mappedStatus=blocked 的列
      mockBoardListRepo.findOne.mockResolvedValueOnce({
        id: 'list-backlog',
        boardId: 'board-1',
      } as BoardList);
      const qb = mockBoardListRepo.createQueryBuilder();
      (qb.getOne as jest.Mock).mockResolvedValueOnce(null);

      const dto = { status: TaskStatus.BLOCKED };
      const result = await service.update('task-1', dto);

      expect(result.status).toBe('blocked');
      expect(result.listId).toBe('list-backlog'); // 保持不变
    });

    it('should update customFields', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { customFields: { priority: 'urgent', source: 'slack' } };
      const result = await service.update('task-1', dto);

      expect(result.customFields).toEqual({ priority: 'urgent', source: 'slack' });
    });

    it('should set completedAt when status changes to done', async () => {
      const task = createMockTask({ status: TaskStatus.IN_PROGRESS });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { status: TaskStatus.DONE };
      const result = await service.update('task-1', dto);

      expect(result.completedAt).toBeInstanceOf(Date);
    });

    it('should update lastActiveAt for agent actor and assignee when task is done', async () => {
      const task = createMockTask({
        status: TaskStatus.IN_PROGRESS,
        assigneeId: 'agent-2',
      });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));
      mockAgentRepo.findOne.mockImplementation(async (options: FindOneOptions<Agent>) => {
        const where = options.where as { id: string };
        return { id: where?.id } as unknown as Agent;
      });

      const dto = { status: TaskStatus.DONE };
      await service.update('task-1', dto, 'agent-1', ActorType.AGENT);

      // actor agent-1 被更新
      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'agent-1' } });
      // assignee agent-2 被更新
      expect(mockAgentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-1',
          lastActiveAt: expect.any(Date),
        }),
      );
      expect(mockAgentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-2',
          lastActiveAt: expect.any(Date),
        }),
      );
    });

    it('should not update lastActiveAt when human updates a task', async () => {
      const task = createMockTask({ status: TaskStatus.IN_PROGRESS });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { status: TaskStatus.DONE };
      await service.update('task-1', dto, 'user-1', ActorType.HUMAN);

      expect(mockAgentRepo.findOne).not.toHaveBeenCalledWith({ where: { id: 'user-1' } });
    });

    it('should clear completedAt when status changes from done to non-done', async () => {
      const task = createMockTask({ status: TaskStatus.DONE, completedAt: new Date('2024-01-01') });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { status: TaskStatus.IN_PROGRESS };
      const result = await service.update('task-1', dto);

      expect(result.completedAt).toBeNull();
    });

    it('should set startedAt when status changes to in_progress and not already set', async () => {
      const task = createMockTask({ status: TaskStatus.BACKLOG });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const dto = { status: TaskStatus.IN_PROGRESS };
      const result = await service.update('task-1', dto);

      expect(result.startedAt).toBeInstanceOf(Date);
    });

    it('should throw LIST_NOT_FOUND when listId changed to non-existent list', async () => {
      const task = createMockTask({ listId: 'list-1' });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue(null);

      await expect(service.update('task-1', { listId: 'list-missing' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.update('task-1', { listId: 'list-missing' })).rejects.toMatchObject({
        response: { code: ErrorCode.LIST_NOT_FOUND },
      });
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(service.update('not-found', { title: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('should reject update when milestone does not exist (P2)', async () => {
      const task = createMockTask({ listId: 'list-1', list: { boardId: 'board-1' } as BoardList });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockMilestoneRepo.findOne.mockResolvedValue(null);

      await expect(service.update('task-1', { milestoneId: 'ms-missing' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.update('task-1', { milestoneId: 'ms-missing' })).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_NOT_FOUND },
      });
    });

    it('should reject update when milestone belongs to different board (P2)', async () => {
      const task = createMockTask({ listId: 'list-1', list: { boardId: 'board-1' } as BoardList });
      mockTaskRepo.findOne.mockResolvedValue(task);
      // task 所在 board 经 listId→BoardList 显式查询推断为 board-1
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      // milestone 属于 board-2，与 task 的 board-1 不同
      mockMilestoneRepo.findOne.mockResolvedValue({
        id: 'ms-1',
        boardId: 'board-2',
      } as Milestone);

      await expect(service.update('task-1', { milestoneId: 'ms-1' })).rejects.toThrow(
        'Milestone does not belong to the same board as the task',
      );
    });

    it('should allow unbinding milestone when milestoneId is null (P2)', async () => {
      const task = createMockTask({
        listId: 'list-1',
        milestoneId: 'ms-old',
        list: { boardId: 'board-1' } as BoardList,
      });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.update('task-1', { milestoneId: null as any });

      // 解绑不应查询 milestone repo
      expect(mockMilestoneRepo.findOne).not.toHaveBeenCalled();
      expect(result.milestone).toBeNull();
    });
  });

  describe('remove', () => {
    it('should soft remove a task', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.softDelete.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      const result = await service.remove('task-1');

      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        relations: ['milestone'],
      });
      expect(mockTaskRepo.softDelete).toHaveBeenCalledWith('task-1');
      expect(result).toBe(true);
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('not-found')).rejects.toThrow(NotFoundException);
    });
  });

  describe('batchCreate', () => {
    it('should create multiple tasks', async () => {
      const task1 = createMockTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createMockTask({ id: 'task-2', title: 'Task 2' });
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1' } as Board);
      mockTaskRepo.create.mockReturnValueOnce(task1).mockReturnValueOnce(task2);
      mockTaskRepo.save.mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);

      const result = await service.batchCreate({
        tasks: [
          { boardId: 'board-1', listId: 'list-1', title: 'Task 1' } as CreateTaskDto,
          { boardId: 'board-1', listId: 'list-1', title: 'Task 2' } as CreateTaskDto,
        ],
      });

      expect(result.count).toBe(2);
      expect(result.items).toHaveLength(2);
    });

    it('should create mixed batch items (one with listId, one with statusName)', async () => {
      const task1 = createMockTask({ id: 'task-1', title: 'Task 1' });
      const task2 = createMockTask({ id: 'task-2', title: 'Task 2' });
      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1' } as Board);
      // item2 走 statusName 解析（mappedStatus 命中）
      mockBoardListRepo.find.mockResolvedValue([
        { id: 'list-1', name: 'To Do', mappedStatus: 'todo' } as BoardList,
      ]);
      mockTaskRepo.create.mockReturnValueOnce(task1).mockReturnValueOnce(task2);
      mockTaskRepo.save.mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);

      const result = await service.batchCreate({
        tasks: [
          { boardId: 'board-1', listId: 'list-1', title: 'Task 1' } as CreateTaskDto,
          { boardId: 'board-1', statusName: 'todo', title: 'Task 2' } as CreateTaskDto,
        ],
      });

      expect(result.count).toBe(2);
      // 仅第二个 item 触发解析（boardListRepo.find 一次）；解析出的 listId 落入 create
      expect(mockBoardListRepo.find).toHaveBeenCalledTimes(1);
      expect(mockTaskRepo.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ title: 'Task 2', listId: 'list-1' }),
      );
      expect(mockTaskRepo.create.mock.calls[1][0]).not.toHaveProperty('statusName');
    });
  });

  describe('move', () => {
    it('should update listId and position via order and derive boardId/topicId from target list', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-2',
        boardId: 'board-2',
        board: { topicId: 'topic-2' },
      } as BoardList);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.move('task-1', {
        listId: '3757faa2-9306-4944-99ba-b7588c270970',
        order: 5,
      });

      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        relations: ['milestone'],
      });
      // Batch 3: move 加载目标 list 时附带 board 关系以派生 topicId
      expect(mockBoardListRepo.findOne).toHaveBeenCalledWith({
        where: { id: '3757faa2-9306-4944-99ba-b7588c270970' },
        relations: ['board'],
      });
      expect(result.listId).toBe('3757faa2-9306-4944-99ba-b7588c270970');
      expect(result.position).toBe(5);
      // Batch 3: 返回的 boardId 和 topicId 从目标 list→board 派生
      expect(result.boardId).toBe('board-2');
      expect(result.topicId).toBe('topic-2');
      expect(mockTaskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ listId: '3757faa2-9306-4944-99ba-b7588c270970', position: 5 }),
      );
      expect(result).toEqual(
        expect.objectContaining({ listId: '3757faa2-9306-4944-99ba-b7588c270970', position: 5 }),
      );
    });

    it('should prioritize position over order', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({ id: 'list-2' } as BoardList);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.move('task-1', {
        listId: '3757faa2-9306-4944-99ba-b7588c270970',
        order: 5,
        position: 10,
      });

      expect(result.position).toBe(10);
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(service.move('not-found', { listId: 'list-2', order: 0 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when list not found', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue(null);

      await expect(
        service.move('task-1', { listId: '00000000-0000-0000-0000-000000000000', order: 0 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when listId is not a valid UUID', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);

      await expect(service.move('task-1', { listId: 'not-a-uuid', order: 0 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should auto-sync status when target list has mappedStatus', async () => {
      const task = createMockTask({ status: TaskStatus.BACKLOG });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-done',
        mappedStatus: 'done',
      } as BoardList);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.move('task-1', {
        listId: '3757faa2-9306-4944-99ba-b7588c270970',
        order: 0,
      });

      expect(result.status).toBe('done');
      expect(result.completedAt).toBeInstanceOf(Date);
    });

    it('should auto-sync status to in_progress and set startedAt', async () => {
      const task = createMockTask({ status: TaskStatus.BACKLOG, startedAt: null });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-progress',
        mappedStatus: 'in_progress',
      } as BoardList);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.move('task-1', {
        listId: '3757faa2-9306-4944-99ba-b7588c270970',
        order: 0,
      });

      expect(result.status).toBe('in_progress');
      expect(result.startedAt).toBeInstanceOf(Date);
    });

    it('should not change status when target list has no mappedStatus', async () => {
      const task = createMockTask({ status: TaskStatus.BACKLOG });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-generic',
        mappedStatus: null,
      } as BoardList);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.move('task-1', {
        listId: '3757faa2-9306-4944-99ba-b7588c270970',
        order: 0,
      });

      expect(result.status).toBe('backlog');
    });

    it('should derive new topicId when moving task to list on a different board', async () => {
      // 模拟任务原本在 board-1/list-1 (topic-1)，移动到 board-2/list-2 (topic-2)
      const task = createMockTask({ listId: 'list-1' });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-2',
        boardId: 'board-2',
        board: { topicId: 'topic-adyge' },
      } as BoardList);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.move('task-1', {
        listId: '3757faa2-9306-4944-99ba-b7588c270970',
        order: 0,
      });

      // Batch 3: 跨 board 移动时 topicId 从新 board 派生，不再依赖已删除的 task.topicId 列
      expect(result.boardId).toBe('board-2');
      expect(result.topicId).toBe('topic-adyge');
    });
  });

  describe('assign', () => {
    it('should update assigneeId and derive assigneeType from Actor', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));
      mockActorRepo.findOne.mockResolvedValue({ id: 'user-2', type: ActorType.HUMAN } as Actor);

      const result = await service.assign('task-1', {
        assigneeId: 'user-2',
      });

      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        relations: ['milestone'],
      });
      expect(mockActorRepo.findOne).toHaveBeenCalledWith({ where: { id: 'user-2' } });
      expect(result.assigneeId).toBe('user-2');
      expect(result.assigneeType).toBe(ActorType.HUMAN);
      expect(mockTaskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: 'user-2', assigneeType: ActorType.HUMAN }),
      );
      expect(result).toEqual(
        expect.objectContaining({ assigneeId: 'user-2', assigneeType: ActorType.HUMAN }),
      );
    });

    it('should clear assigneeId and assigneeType when assigneeId is empty', async () => {
      const task = createMockTask({ assigneeId: 'user-1', assigneeType: ActorType.HUMAN });
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockTaskRepo.save.mockImplementation((t) => Promise.resolve(t as Task));

      const result = await service.assign('task-1', { assigneeId: '' });

      expect(result.assigneeId).toBeNull();
      expect(result.assigneeType).toBeNull();
    });

    it('should throw AGENT_NOT_FOUND when assigneeId actor does not exist', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      // 统一批 A2.5（R14）：错误码由 USER_NOT_FOUND 统一为 AGENT_NOT_FOUND——"从未存在"
      // 与"已删除"消费方正确动作相同，单一语义
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.assign('task-1', { assigneeId: 'user-missing' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.assign('task-1', { assigneeId: 'user-missing' })).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
    });

    it('assign：指向已软删 agent → 4xx AGENT_NOT_FOUND（统一批 A2.5）', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.assign('task-1', { assigneeId: 'agent-deleted' })).rejects.toMatchObject(
        {
          response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
        },
      );
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('assign：指向已软删 user → 同样 4xx AGENT_NOT_FOUND（assertActorUsable 覆盖任意 actor type）', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockActorProfileService.assertActorUsable.mockRejectedValue(
        new NotFoundException({
          message: 'Agent not found or deleted',
          code: ErrorCode.AGENT_NOT_FOUND,
        }),
      );

      await expect(service.assign('task-1', { assigneeId: 'user-deleted' })).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND, message: 'Agent not found or deleted' },
      });
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(service.assign('not-found', { assigneeId: 'user-2' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getComments', () => {
    it('should return comments for a task with default limit 50', async () => {
      const comments = [createMockTaskComment()];
      mockCommentRepo.find.mockResolvedValue(comments);

      const result = await service.getComments('task-1');

      expect(mockCommentRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 50,
      });
      expect(result).toEqual(comments);
    });

    it('should apply explicit limit parameter', async () => {
      mockCommentRepo.find.mockResolvedValue([]);

      await service.getComments('task-1', 10);

      expect(mockCommentRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 10,
      });
    });

    it('should clamp limit > 200 to 200', async () => {
      mockCommentRepo.find.mockResolvedValue([]);

      await service.getComments('task-1', 500);

      expect(mockCommentRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 200,
      });
    });

    it('should use default limit 50 when limit is not a number', async () => {
      mockCommentRepo.find.mockResolvedValue([]);

      // NaN from +'abc' causes safeLimit to fall back to 50
      await service.getComments('task-1', 'abc' as any);

      expect(mockCommentRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 50,
      });
    });

    it('should clamp limit < 1 to 1', async () => {
      mockCommentRepo.find.mockResolvedValue([]);

      await service.getComments('task-1', 0);

      expect(mockCommentRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 1,
      });
    });
  });

  describe('addComment', () => {
    it('should add a comment to a task', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);

      const createdComment = createMockTaskComment({ content: 'New comment' });
      const savedComment = createMockTaskComment({ content: 'New comment' });

      mockCommentRepo.create.mockReturnValue(createdComment);
      mockCommentRepo.save.mockResolvedValue(savedComment);

      const result = await service.addComment('task-1', 'user-1', ActorType.HUMAN, {
        content: 'New comment',
      });

      expect(mockTaskRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'task-1' },
        relations: ['milestone'],
      });
      expect(mockCommentRepo.create).toHaveBeenCalledWith({
        taskId: 'task-1',
        authorId: 'user-1',
        authorType: 'human',
        // 统一批 A2：authorName 经公共解析注入（回退链 displayName 优先）
        authorName: 'Alice',
        content: 'New comment',
      });
      expect(mockCommentRepo.save).toHaveBeenCalledWith(createdComment);
      expect(result).toEqual(savedComment);
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(
        service.addComment('not-found', 'user-1', ActorType.HUMAN, { content: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getActivities', () => {
    it('should return activities for a task with default limit 50', async () => {
      const activities = [createMockTaskActivity()];
      mockActivityRepo.find.mockResolvedValue(activities);

      const result = await service.getActivities('task-1');

      expect(mockActivityRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 50,
      });
      // 统一批 A2：注入 actorName（公共解析，user-1 → Alice）+ actorDeletedAt（未删 null）
      expect(result).toEqual([{ ...activities[0], actorName: 'Alice', actorDeletedAt: null }]);
    });

    it('should apply explicit limit parameter', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      await service.getActivities('task-1', 10);

      expect(mockActivityRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 10,
      });
    });

    it('should clamp limit > 200 to 200', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      await service.getActivities('task-1', 500);

      expect(mockActivityRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 200,
      });
    });

    it('软删执行者：actorName 真名保留 + actorDeletedAt 非空（前端不再 fallback 裸 UUID）', async () => {
      const activities = [createMockTaskActivity({ actorId: 'agent-1' })];
      mockActivityRepo.find.mockResolvedValue(activities);
      // 软删行：actors 带 deletedAt（withDeleted 语义经 mock 透传）
      mockActorRepo.find.mockResolvedValueOnce([
        {
          id: 'agent-1',
          type: ActorType.AGENT,
          deletedAt: new Date('2024-06-01T00:00:00Z'),
        } as Actor,
      ]);

      const result = await service.getActivities('task-1');

      expect(result).toEqual([
        { ...activities[0], actorName: 'Kimi', actorDeletedAt: '2024-06-01T00:00:00.000Z' },
      ]);
    });

    it('should use default limit 50 when limit is not a number', async () => {
      mockActivityRepo.find.mockResolvedValue([]);

      await service.getActivities('task-1', 'abc' as any);

      expect(mockActivityRepo.find).toHaveBeenCalledWith({
        where: { taskId: 'task-1' },
        order: { createdAt: 'DESC' },
        take: 50,
      });
    });
  });

  describe('addDocLink', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN };

    function createDocQb(docOrNull: any) {
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(docOrNull),
        getMany: jest.fn(),
        getManyAndCount: jest.fn(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
      };
    }

    it('creates link when doc exists and actor has read access', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' } as Doc;
      const space = { id: 'space-1' } as DocSpace;

      // Mock docRepo createQueryBuilder → getOne returns doc
      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(doc));

      // Mock docSpaceRepo createQueryBuilder → getOne returns space
      mockDocSpaceRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(space));

      // Policy allows read
      mockDocSpacePolicy.can.mockResolvedValue(true);

      // No existing link
      mockDocLinkRepo.findOne.mockResolvedValue(null);

      const link = {
        id: 'link-1',
        taskId: 'task-1',
        docId: 'doc-1',
        createdBy: 'user-1',
      } as unknown as TaskDocLink;
      mockDocLinkRepo.create.mockReturnValue(link);
      mockDocLinkRepo.save.mockResolvedValue(link);

      const result = await service.addDocLink('task-1', 'doc-1', actor);

      expect(result).toEqual(link);
      expect(result.taskId).toBe('task-1');
      expect(result.docId).toBe('doc-1');
      expect(mockDocLinkRepo.create).toHaveBeenCalledWith({
        taskId: 'task-1',
        docId: 'doc-1',
        createdBy: 'user-1',
      });
      expect(mockDocLinkRepo.save).toHaveBeenCalled();
    });

    it('idempotent on re-add', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' } as Doc;
      const space = { id: 'space-1' } as DocSpace;

      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(doc));
      mockDocSpaceRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(space));
      mockDocSpacePolicy.can.mockResolvedValue(true);

      const existing = {
        id: 'link-1',
        taskId: 'task-1',
        docId: 'doc-1',
        createdBy: 'user-1',
      } as unknown as TaskDocLink;
      mockDocLinkRepo.findOne.mockResolvedValue(existing);

      const result = await service.addDocLink('task-1', 'doc-1', actor);

      expect(result).toEqual(existing);
      expect(mockDocLinkRepo.create).not.toHaveBeenCalled();
      expect(mockDocLinkRepo.save).not.toHaveBeenCalled();
    });

    it("throws 403 when actor lacks read access to doc's space", async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' } as Doc;
      const space = { id: 'space-1' } as DocSpace;

      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(doc));
      mockDocSpaceRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(space));
      mockDocLinkRepo.findOne.mockResolvedValue(null);

      // Policy denies read
      mockDocSpacePolicy.can.mockResolvedValue(false);

      await expect(service.addDocLink('task-1', 'doc-1', actor)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws 404 when doc not found', async () => {
      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(null));

      await expect(service.addDocLink('task-1', 'doc-1', actor)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_NOT_FOUND },
      });
    });
  });

  describe('removeDocLink', () => {
    it('removes link when found', async () => {
      const link = { id: 'link-1', taskId: 'task-1', docId: 'doc-1' } as unknown as TaskDocLink;
      mockDocLinkRepo.findOne.mockResolvedValue(link);
      mockDocLinkRepo.remove.mockResolvedValue(link);

      const result = await service.removeDocLink('task-1', 'doc-1');

      expect(result).toBe(true);
      expect(mockDocLinkRepo.remove).toHaveBeenCalledWith(link);
    });

    it('throws DOC_LINK_NOT_FOUND when link missing', async () => {
      mockDocLinkRepo.findOne.mockResolvedValue(null);

      await expect(service.removeDocLink('task-1', 'doc-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_LINK_NOT_FOUND },
      });
    });
  });

  describe('reportResult', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN };
    const taskId = 'task-1';
    // 注意：dto 透传顺序须与实现一致（实现用字面量对象 {taskId,status,comment,commitSha,docIds}，
    // JSON.stringify 丢弃 undefined 字段）
    function reportRequestHash(dto: {
      taskId: string;
      status: TaskStatus;
      comment?: string;
      commitSha?: string;
      docIds?: string[];
    }) {
      const { createHash } = require('crypto');
      return createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    }
    function idemRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
      return {
        id: 'record-1',
        actorId: 'user-1',
        clientRequestId: 'key-1',
        entityType: 'task_report',
        entityId: taskId,
        requestHash: 'unused-hash',
        responseSnapshot: null,
        createdAt: new Date('2024-01-01'),
        ...overrides,
      } as IdempotencyRecord;
    }
    /** mock addComment 链路：任务存在校验 + comment 落库 */
    function mockCommentFlow(comment: any = { id: 'comment-1', content: 'x' }) {
      mockTaskRepo.findOne.mockResolvedValue(createMockTask());
      mockCommentRepo.create.mockReturnValue(comment);
      mockCommentRepo.save.mockResolvedValue(comment);
      mockActivityRepo.save.mockResolvedValue({} as any);
    }
    /** mock update 链路：findById + 状态列联动 + save */
    function mockUpdateFlow(saved: Task = createMockTask({ status: TaskStatus.DONE })) {
      mockTaskRepo.findOne.mockResolvedValue(createMockTask());
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
      } as BoardList);
      mockTaskRepo.save.mockResolvedValue(saved);
      mockActivityRepo.save.mockResolvedValue({} as any);
    }
    /** mock addDocLink 链路（doc + space 查询放行） */
    function mockDocLinkFlow(docOrNulls: (Doc | null)[]) {
      const docQbs = docOrNulls.map((d) => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(d),
        getMany: jest.fn(),
        getManyAndCount: jest.fn(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
      }));
      mockDocRepo.createQueryBuilder
        .mockReturnValueOnce(docQbs[0] as any)
        .mockReturnValueOnce((docQbs[1] ?? docQbs[0]) as any);
      mockDocSpaceRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'space-1' } as DocSpace),
        getMany: jest.fn(),
        getManyAndCount: jest.fn(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
      } as any);
      mockDocSpacePolicy.can.mockResolvedValue(true);
      mockDocLinkRepo.findOne.mockResolvedValue(null);
      mockDocLinkRepo.create.mockImplementation((l: any) => l);
      mockDocLinkRepo.save.mockImplementation((l: any) => Promise.resolve(l));
    }

    it('无 comment/commitSha → 跳过步骤 1，仅改状态；无 key 时幂等零开销', async () => {
      mockUpdateFlow();

      const result = await service.reportResult(taskId, { status: TaskStatus.DONE }, actor);

      expect(mockCommentRepo.save).not.toHaveBeenCalled();
      expect(mockTaskRepo.save).toHaveBeenCalledTimes(1);
      expect(result.task.status).toBe(TaskStatus.DONE);
      expect(result.comment).toBeUndefined();
      expect(result.idempotentReplay).toBeUndefined();
      // 零开销：无幂等记录读写
      expect(mockIdempotencyRepo.findOne).not.toHaveBeenCalled();
      expect(mockIdempotencyRepo.save).not.toHaveBeenCalled();
    });

    it('仅 comment → 评论文本 = comment', async () => {
      const comment = { id: 'comment-1', content: '已完成' };
      mockCommentFlow(comment);
      mockUpdateFlow();

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, comment: '已完成' },
        actor,
      );

      expect(mockCommentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ content: '已完成' }),
      );
      expect(result.comment).toEqual(comment);
    });

    it('仅 commitSha → 评论文本 = "Commit: <sha>"', async () => {
      mockCommentFlow({ id: 'comment-1', content: 'Commit: abc123' });
      mockUpdateFlow();

      await service.reportResult(taskId, { status: TaskStatus.DONE, commitSha: 'abc123' }, actor);

      expect(mockCommentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Commit: abc123' }),
      );
    });

    it('comment + commitSha → 拼接为 "comment\\n\\nCommit: <sha>"', async () => {
      mockCommentFlow({ id: 'comment-1', content: '修复完成\n\nCommit: abc123' });
      mockUpdateFlow();

      await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, comment: '修复完成', commitSha: 'abc123' },
        actor,
      );

      expect(mockCommentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ content: '修复完成\n\nCommit: abc123' }),
      );
    });

    it('空字符串 comment 且无 commitSha → 跳过评论步骤', async () => {
      mockUpdateFlow();

      await service.reportResult(taskId, { status: TaskStatus.DONE, comment: '' }, actor);

      expect(mockCommentRepo.save).not.toHaveBeenCalled();
    });

    it('docIds 全成功 → docLinks.succeeded 含全部、failed 为空', async () => {
      mockUpdateFlow();
      mockDocLinkFlow([
        { id: 'doc-1', spaceId: 'space-1' } as Doc,
        { id: 'doc-2', spaceId: 'space-1' } as Doc,
      ]);

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, docIds: ['doc-1', 'doc-2'] },
        actor,
      );

      expect(result.docLinks).toEqual({ succeeded: ['doc-1', 'doc-2'], failed: [] });
    });

    it('docIds 部分失败 → 失败内嵌 docLinks.failed（status/code），主体仍成功', async () => {
      mockUpdateFlow();
      // doc-1 存在；doc-2 不存在 → 404 DOC_NOT_FOUND
      mockDocLinkFlow([{ id: 'doc-1', spaceId: 'space-1' } as Doc, null]);

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, docIds: ['doc-1', 'doc-2'] },
        actor,
      );

      expect(result.docLinks).toEqual({
        succeeded: ['doc-1'],
        failed: [
          {
            docId: 'doc-2',
            status: 404,
            code: ErrorCode.DOC_NOT_FOUND,
            error: 'Document not found',
          },
        ],
      });
      expect(result.task.status).toBe(TaskStatus.DONE);
    });

    it('同 key 完整快照重放 → 返回快照 + idempotentReplay，评论/状态零副作用', async () => {
      const dto = {
        taskId,
        status: TaskStatus.DONE,
        comment: 'done',
        commitSha: undefined,
        docIds: ['doc-1'],
      };
      const snapshot = {
        task: { id: taskId, status: TaskStatus.DONE },
        comment: { id: 'comment-1', content: 'done' },
        docLinks: { succeeded: ['doc-1'], failed: [] },
      };
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({ requestHash: reportRequestHash(dto), responseSnapshot: snapshot }),
      );

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, comment: 'done', docIds: ['doc-1'], clientRequestId: 'key-1' },
        actor,
      );

      expect(result).toEqual({ ...snapshot, idempotentReplay: true });
      expect(mockCommentRepo.save).not.toHaveBeenCalled();
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
      expect(mockDocLinkRepo.save).not.toHaveBeenCalled();
    });

    it('同 key 不同 payload（hash 不符）→ 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({
          requestHash: 'another-request-hash',
          responseSnapshot: { task: { id: taskId, status: TaskStatus.DONE } },
        }),
      );

      await expect(
        service.reportResult(
          taskId,
          { status: TaskStatus.DONE, comment: '不同评论', clientRequestId: 'key-1' },
          actor,
        ),
      ).rejects.toMatchObject({ response: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT } });
    });

    it('同 key 但 entityType 非 task_report（task 旧记录）→ 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({ entityType: 'task', requestHash: null, responseSnapshot: null }),
      );

      await expect(
        service.reportResult(taskId, { status: TaskStatus.DONE, clientRequestId: 'key-1' }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT } });
    });

    it('部分成功恢复：快照仅含 comment → 跳过评论只补状态，快照补全 {comment,task}', async () => {
      const dto = {
        taskId,
        status: TaskStatus.DONE,
        comment: 'done',
        commitSha: undefined,
        docIds: undefined,
      };
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({
          requestHash: reportRequestHash(dto),
          responseSnapshot: { comment: { id: 'comment-1', content: 'done' } },
        }),
      );
      mockIdempotencyRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockUpdateFlow();

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, comment: 'done', clientRequestId: 'key-1' },
        actor,
      );

      // 评论不重发；评论结果回放首次快照
      expect(mockCommentRepo.save).not.toHaveBeenCalled();
      expect(mockTaskRepo.save).toHaveBeenCalledTimes(1);
      expect(result.comment).toEqual({ id: 'comment-1', content: 'done' });
      expect(result.task.status).toBe(TaskStatus.DONE);
      expect(result.idempotentReplay).toBeUndefined();
      // 最终 checkpoint 写入合并快照（含 task）
      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'record-1',
          responseSnapshot: expect.objectContaining({
            task: expect.anything(),
            comment: { id: 'comment-1', content: 'done' },
          }),
        }),
      );
    });

    it('status 失败 → 错误透传（comment 已发 + checkpoint 落 {comment}）', async () => {
      mockCommentFlow({ id: 'comment-1', content: 'done' });
      mockIdempotencyRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      // update 链路：任务存在，但 save 抛错
      mockTaskRepo.findOne.mockResolvedValue(createMockTask());
      mockTaskRepo.save.mockRejectedValue(new Error('db down'));

      await expect(
        service.reportResult(
          taskId,
          { status: TaskStatus.DONE, comment: 'done', clientRequestId: 'key-1' },
          actor,
        ),
      ).rejects.toThrow('db down');

      expect(mockCommentRepo.save).toHaveBeenCalledTimes(1);
      // 评论 checkpoint 已落快照（仅 comment，无 task）
      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          clientRequestId: 'key-1',
          entityType: 'task_report',
          responseSnapshot: expect.objectContaining({
            comment: { id: 'comment-1', content: 'done' },
          }),
        }),
      );
    });

    it('status 步骤抛 4xx 且本次已发评论 → 错误响应 data 带 commentPosted:true，幂等恢复路径不受影响', async () => {
      mockCommentFlow({ id: 'comment-1', content: 'done' });
      mockIdempotencyRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      // update 链路：任务存在，但 save 抛 4xx 业务错误
      mockTaskRepo.findOne.mockResolvedValue(createMockTask());
      const forbidden = new ForbiddenException({
        message: 'No permission',
        code: ErrorCode.PERMISSION_DENIED,
      });
      mockTaskRepo.save.mockRejectedValue(forbidden);

      const err = await service
        .reportResult(
          taskId,
          { status: TaskStatus.DONE, comment: 'done', clientRequestId: 'key-1' },
          actor,
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      // 部分成功语义显式化：本次调用发了评论 → data 槽透传 commentPosted（MCP 层归一到 details）
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        data: { commentPosted: true },
      });
      // 幂等恢复路径不受影响：checkpoint {comment} 已先落库，带 key 重试仍跳过评论步骤
      expect(mockCommentRepo.save).toHaveBeenCalledTimes(1);
      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          clientRequestId: 'key-1',
          entityType: 'task_report',
          responseSnapshot: expect.objectContaining({
            comment: { id: 'comment-1', content: 'done' },
          }),
        }),
      );
    });

    it('恢复路径：快照含 task 但缺 docLinks + 请求带 docIds → 只补跑 docLinks', async () => {
      const dto = {
        taskId,
        status: TaskStatus.DONE,
        comment: undefined,
        commitSha: undefined,
        docIds: ['doc-1'],
      };
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({
          requestHash: reportRequestHash(dto),
          responseSnapshot: { task: { id: taskId, status: TaskStatus.DONE } },
        }),
      );
      mockIdempotencyRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockDocLinkFlow([{ id: 'doc-1', spaceId: 'space-1' } as Doc]);

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, docIds: ['doc-1'], clientRequestId: 'key-1' },
        actor,
      );

      expect(mockCommentRepo.save).not.toHaveBeenCalled();
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
      expect(mockDocLinkRepo.save).toHaveBeenCalledTimes(1);
      expect(result.task).toEqual({ id: taskId, status: TaskStatus.DONE });
      expect(result.docLinks).toEqual({ succeeded: ['doc-1'], failed: [] });
      expect(result.idempotentReplay).toBeUndefined();
    });

    it('并发同 key：评论 checkpoint 撞 23505 → 重读胜者记录继续（不重复 checkpoint 插入）', async () => {
      const dto = {
        taskId,
        status: TaskStatus.DONE,
        comment: 'done',
        commitSha: undefined,
        docIds: undefined,
      };
      // 入口查询 miss（并发窗口内无记录）
      mockIdempotencyRepo.findOne.mockResolvedValueOnce(null);
      mockCommentFlow({ id: 'comment-1', content: 'done' });
      // 胜者已先插入 {comment} 快照；本请求 checkpoint 撞 23505
      const pg23505 = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_idempotency_actor_key',
      });
      mockIdempotencyRepo.save.mockRejectedValueOnce(pg23505);
      const winnerRecord = idemRecord({
        requestHash: reportRequestHash(dto),
        responseSnapshot: { comment: { id: 'comment-winner', content: 'done' } },
      });
      mockIdempotencyRepo.findOne.mockResolvedValueOnce(winnerRecord);
      // 后续 checkpoint 正常
      mockIdempotencyRepo.save.mockImplementation((e: any) => Promise.resolve(e));
      mockUpdateFlow();

      const result = await service.reportResult(
        taskId,
        { status: TaskStatus.DONE, comment: 'done', clientRequestId: 'key-1' },
        actor,
      );

      // 败者评论已真实落库（无共享事务，无法回滚），保留自身评论；
      // 胜者记录成为后续 checkpoint 基础（不重复插入），状态照常补跑
      expect(result.comment).toEqual({ id: 'comment-1', content: 'done' });
      expect(mockTaskRepo.save).toHaveBeenCalledTimes(1);
      // checkpoint 两次：首次撞 23505（拒绝），后续基于胜者记录更新
      expect(mockIdempotencyRepo.save).toHaveBeenCalledTimes(2);
      expect(mockIdempotencyRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'record-1' }),
      );
    });
  });

  describe('patchDescription', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN };
    const taskId = 'task-1';

    function sha256(text: string) {
      const { createHash } = require('crypto');
      return createHash('sha256').update(text).digest('hex');
    }

    /** 与实现同款 canonical payload 哈希（字面量对象 key 顺序：taskId/oldString/newString/expectedDescriptionHash） */
    function patchRequestHash(dto: {
      taskId: string;
      oldString: string;
      newString: string;
      expectedDescriptionHash?: string;
    }) {
      const { createHash } = require('crypto');
      return createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    }

    function idemRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
      return {
        id: 'record-1',
        actorId: 'user-1',
        clientRequestId: 'key-1',
        entityType: 'task_description',
        entityId: taskId,
        requestHash: 'unused-hash',
        responseSnapshot: null,
        createdAt: new Date('2024-01-01'),
        ...overrides,
      } as IdempotencyRecord;
    }

    /** mock 主事务链路：锁行查询（findOne）+ list 派生 + save */
    function mockPatchFlow(task: Task = createMockTask({ description: '第一段' })) {
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockBoardListRepo.findOne.mockResolvedValue({
        id: 'list-1',
        boardId: 'board-1',
        board: { topicId: 'topic-1' },
      } as BoardList);
      mockTaskRepo.save.mockImplementation(async (t: any) => ({ ...t, id: task.id }));
      mockActivityRepo.save.mockResolvedValue({} as any);
    }

    it('0 命中 → 404 DOC_NOT_FOUND，不写库', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));

      await expect(
        service.patchDescription(taskId, { oldString: '不存在的片段', newString: 'x' }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_NOT_FOUND } });
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('>1 命中 → 409 RESOURCE_CONFLICT + data.matchCount，不写库', async () => {
      mockPatchFlow(createMockTask({ description: '重复 重复' }));

      await expect(
        service.patchDescription(taskId, { oldString: '重复', newString: 'x' }, actor),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT, data: { matchCount: 2 } },
      });
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('恰好 1 命中 → 替换成功，响应 task 含新 description + descriptionHash', async () => {
      mockPatchFlow(createMockTask({ description: '第一段\n第二段' }));

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段', newString: '新第一段' },
        actor,
      );

      expect(mockTaskRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ description: '新第一段\n第二段' }),
      );
      expect(result.task.description).toBe('新第一段\n第二段');
      expect(result.task.descriptionHash).toBe(sha256('新第一段\n第二段'));
      expect(result.idempotentReplay).toBeUndefined();
    });

    it('newString 空串 = 删除该片段', async () => {
      mockPatchFlow(createMockTask({ description: '第一段\n第二段' }));

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段\n', newString: '' },
        actor,
      );

      expect(result.task.description).toBe('第二段');
    });

    it('$ 模式按字面量处理（函数式 replacer 不被 replace 解释）', async () => {
      mockPatchFlow(createMockTask({ description: '价格 $5 元' }));

      const result = await service.patchDescription(
        taskId,
        { oldString: '$5', newString: '$&$1' },
        actor,
      );

      expect(result.task.description).toBe('价格 $&$1 元');
    });

    it('成功 → 事务提交后副作用：TASK_UPDATE 事件 + activity updated/description', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));

      await service.patchDescription(taskId, { oldString: '第一段', newString: '新' }, actor);

      expect(mockEventService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EventType.TASK_UPDATE,
          resourceType: 'task',
          resourceId: taskId,
          payload: expect.objectContaining({ action: 'updated', fieldName: 'description' }),
        }),
      );
      expect(mockActivityRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          action: 'updated',
          fieldName: 'description',
          oldValue: '第一段',
          newValue: '新',
        }),
      );
    });

    it('expectedDescriptionHash 相符 → 通过', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段', newString: '新', expectedDescriptionHash: sha256('第一段') },
        actor,
      );

      expect(result.task.description).toBe('新');
    });

    it('expectedDescriptionHash 不符 → 409 DOC_CONTENT_CONFLICT + data.currentDescriptionHash，不写库', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));

      await expect(
        service.patchDescription(
          taskId,
          { oldString: '第一段', newString: '新', expectedDescriptionHash: 'wrong-hash' },
          actor,
        ),
      ).rejects.toMatchObject({
        response: {
          code: ErrorCode.DOC_CONTENT_CONFLICT,
          data: { currentDescriptionHash: sha256('第一段') },
        },
      });
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
    });

    it('缺省 expectedDescriptionHash → 跳过前提', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段', newString: '新' },
        actor,
      );

      expect(result.task.description).toBe('新');
    });

    it('无 key → 幂等零开销（无记录读写）', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));

      await service.patchDescription(taskId, { oldString: '第一段', newString: '新' }, actor);

      expect(mockIdempotencyRepo.findOne).not.toHaveBeenCalled();
      expect(mockIdempotencyRepo.save).not.toHaveBeenCalled();
    });

    it('有 key 首次成功 → 幂等记录与业务写同事务（快照 = 本入口响应）', async () => {
      mockPatchFlow(createMockTask({ description: '第一段' }));
      mockIdempotencyRepo.save.mockImplementation((e: any) => Promise.resolve(e));

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段', newString: '新', clientRequestId: 'key-1' },
        actor,
      );

      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          clientRequestId: 'key-1',
          entityType: 'task_description',
          entityId: taskId,
          responseSnapshot: expect.objectContaining({
            task: expect.objectContaining({ description: '新' }),
          }),
        }),
      );
      expect(result.idempotentReplay).toBeUndefined();
    });

    it('同 key 重放 → 返回快照 + idempotentReplay，零副作用（save 不重复）', async () => {
      const dto = {
        taskId,
        oldString: '第一段',
        newString: '新',
        expectedDescriptionHash: undefined,
      };
      const snapshot = {
        task: { id: taskId, description: '新', descriptionHash: 'snapshot-hash' },
      };
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({ requestHash: patchRequestHash(dto), responseSnapshot: snapshot }),
      );

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段', newString: '新', clientRequestId: 'key-1' },
        actor,
      );

      expect(result).toEqual({ ...snapshot, idempotentReplay: true });
      expect(mockTaskRepo.save).not.toHaveBeenCalled();
      expect(mockIdempotencyRepo.save).not.toHaveBeenCalled();
      expect(mockEventService.create).not.toHaveBeenCalled();
    });

    it('同 key 不同 payload（hash 不符）→ 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({ requestHash: 'another-hash', responseSnapshot: { task: { id: taskId } } }),
      );

      await expect(
        service.patchDescription(
          taskId,
          { oldString: '第一段', newString: '不同', clientRequestId: 'key-1' },
          actor,
        ),
      ).rejects.toMatchObject({ response: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT } });
    });

    it('同 key 但 entityType 非 task_description（task 旧记录）→ 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(
        idemRecord({ entityType: 'task', requestHash: null, responseSnapshot: null }),
      );

      await expect(
        service.patchDescription(
          taskId,
          { oldString: '第一段', newString: '新', clientRequestId: 'key-1' },
          actor,
        ),
      ).rejects.toMatchObject({ response: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT } });
    });

    it('并发同 key：事务内幂等记录撞 23505 → 重读胜者快照返回 + idempotentReplay', async () => {
      const dto = {
        taskId,
        oldString: '第一段',
        newString: '新',
        expectedDescriptionHash: undefined,
      };
      // 入口查询 miss（并发窗口内无记录）
      mockIdempotencyRepo.findOne.mockResolvedValueOnce(null);
      mockPatchFlow(createMockTask({ description: '第一段' }));
      // 事务内幂等记录 save 撞 23505（胜者已先插入）
      const pg23505 = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_idempotency_actor_key',
      });
      mockIdempotencyRepo.save.mockRejectedValueOnce(pg23505);
      const winnerRecord = idemRecord({
        requestHash: patchRequestHash(dto),
        responseSnapshot: {
          task: { id: taskId, description: '新', descriptionHash: 'winner-hash' },
        },
      });
      mockIdempotencyRepo.findOne.mockResolvedValueOnce(winnerRecord);

      const result = await service.patchDescription(
        taskId,
        { oldString: '第一段', newString: '新', clientRequestId: 'key-1' },
        actor,
      );

      expect(result).toEqual({
        task: { id: taskId, description: '新', descriptionHash: 'winner-hash' },
        idempotentReplay: true,
      });
      // 业务写已随事务回滚（同事务），不重复 save；无副作用
      expect(mockTaskRepo.save).toHaveBeenCalledTimes(1);
      expect(mockEventService.create).not.toHaveBeenCalled();
    });
  });
});
