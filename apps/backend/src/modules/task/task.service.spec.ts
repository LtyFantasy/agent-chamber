import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral, In, FindOneOptions, DataSource, EntityManager } from 'typeorm';
import { NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ActorType, TaskStatus, Priority, UserRole, ErrorCode } from '@agent-chamber/shared';
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

function createMockRepo<T extends ObjectLiteral>() {
  const qb = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
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
        { provide: EventService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        { provide: AccessQueryService, useValue: mockAccessQuery },
        { provide: ResourceValidator, useValue: mockResourceValidator },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = moduleRef.get<TaskService>(TaskService);
    jest.clearAllMocks();
    // 默认返回空依赖，避免 findOne 中的依赖查询报错（必须在 clearAllMocks 之后设置）
    mockDepRepo.find.mockResolvedValue([]);
  });

  describe('findAll', () => {
    it('should return paginated results with default values', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      const result = await service.findAll({});

      expect(mockTaskRepo.createQueryBuilder).toHaveBeenCalledWith('task');
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('task.list', 'list');
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('list.board', 'board');
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
      mockUserRepo.findBy.mockResolvedValue([{ id: 'user-1', username: 'alice', displayName: 'Alice' } as User]);

      const result = await service.findAll({});

      expect(mockAgentRepo.findBy).toHaveBeenCalledWith({ id: In(['agent-1', 'user-1']) });
      expect(mockUserRepo.findBy).toHaveBeenCalledWith({ id: In(['agent-1', 'user-1']) });
      expect(result.items[0].assigneeName).toBe('Kimi');
      expect(result.items[1].assigneeName).toBe('Alice');
      expect(result.items[2].assigneeName).toBeNull();
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

    it('should leftJoinSelect list.board for topicId derivation', async () => {
      const items = [createMockTask()];
      const qb = mockTaskRepo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([items, 1]);

      await service.findAll({});

      // Batch 3: findAll 新增 list.board join 以派生 topicId + topicId 过滤
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith('list.board', 'board');
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
      expect((result.dependencies![0].dependsOnTask as any)).not.toHaveProperty('description');

      // dependents: task 应仅有 {id, title, status}
      expect(result.dependents).toHaveLength(1);
      expect(result.dependents![0].task).toEqual({
        id: 'dep-task-2',
        title: 'Dependent Task',
        status: TaskStatus.DONE,
      });
      expect((result.dependents![0].task as any)).not.toHaveProperty('description');
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
        getRawMany: jest.fn().mockResolvedValue([
          { d_id: 'doc-1', d_path: 'docs/readme.md', d_title: 'Readme', d_summary: 'A readme file' },
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

      await expect(service.create(dto)).rejects.toThrow('Milestone does not belong to the same board as the task');
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
      const savedTask = createMockTask({ id: 'task-idem-1', title: 'Idempotent Task', assigneeId: 'creator-1' });

      mockBoardRepo.findOne.mockResolvedValue({ id: 'board-1', topicId: 'topic-1' } as Board);
      mockTaskRepo.create.mockReturnValue(createdTask);
      mockTaskRepo.save.mockResolvedValue(savedTask);
      mockIdempotencyRepo.save.mockResolvedValue({ id: 'rec-1', actorId: 'creator-1', clientRequestId: 'req-001', entityType: 'task', entityId: 'task-idem-1' } as IdempotencyRecord);

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

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toThrow('other unique violation');
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

      await expect(service.create(dto, 'creator-1', ActorType.HUMAN)).rejects.toThrow('connection error');
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
      mockBoardListRepo.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' } as BoardList);
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
      mockBoardListRepo.findOne.mockResolvedValue({ id: 'list-1', boardId: 'board-1' } as BoardList);
      // milestone 属于 board-2，与 task 的 board-1 不同
      mockMilestoneRepo.findOne.mockResolvedValue({
        id: 'ms-1',
        boardId: 'board-2',
      } as Milestone);

      await expect(
        service.update('task-1', { milestoneId: 'ms-1' }),
      ).rejects.toThrow('Milestone does not belong to the same board as the task');
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

    it('should throw USER_NOT_FOUND when assigneeId actor does not exist', async () => {
      const task = createMockTask();
      mockTaskRepo.findOne.mockResolvedValue(task);
      mockActorRepo.findOne.mockResolvedValue(null);

      await expect(service.assign('task-1', { assigneeId: 'user-missing' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.assign('task-1', { assigneeId: 'user-missing' })).rejects.toMatchObject({
        response: { code: ErrorCode.USER_NOT_FOUND },
      });
    });

    it('should throw NotFoundException when task not found', async () => {
      mockTaskRepo.findOne.mockResolvedValue(null);

      await expect(
        service.assign('not-found', { assigneeId: 'user-2' }),
      ).rejects.toThrow(NotFoundException);
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
        authorName: null,
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
      expect(result).toEqual(activities);
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

      const link = { id: 'link-1', taskId: 'task-1', docId: 'doc-1', createdBy: 'user-1' } as unknown as TaskDocLink;
      mockDocLinkRepo.create.mockReturnValue(link);
      mockDocLinkRepo.save.mockResolvedValue(link);

      const result = await service.addDocLink('task-1', 'doc-1', actor);

      expect(result).toEqual(link);
      expect(result.taskId).toBe('task-1');
      expect(result.docId).toBe('doc-1');
      expect(mockDocLinkRepo.create).toHaveBeenCalledWith({ taskId: 'task-1', docId: 'doc-1', createdBy: 'user-1' });
      expect(mockDocLinkRepo.save).toHaveBeenCalled();
    });

    it('idempotent on re-add', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' } as Doc;
      const space = { id: 'space-1' } as DocSpace;

      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(doc));
      mockDocSpaceRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(space));
      mockDocSpacePolicy.can.mockResolvedValue(true);

      const existing = { id: 'link-1', taskId: 'task-1', docId: 'doc-1', createdBy: 'user-1' } as unknown as TaskDocLink;
      mockDocLinkRepo.findOne.mockResolvedValue(existing);

      const result = await service.addDocLink('task-1', 'doc-1', actor);

      expect(result).toEqual(existing);
      expect(mockDocLinkRepo.create).not.toHaveBeenCalled();
      expect(mockDocLinkRepo.save).not.toHaveBeenCalled();
    });

    it('throws 403 when actor lacks read access to doc\'s space', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' } as Doc;
      const space = { id: 'space-1' } as DocSpace;

      mockDocRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(doc));
      mockDocSpaceRepo.createQueryBuilder = jest.fn().mockReturnValue(createDocQb(space));
      mockDocLinkRepo.findOne.mockResolvedValue(null);

      // Policy denies read
      mockDocSpacePolicy.can.mockResolvedValue(false);

      await expect(service.addDocLink('task-1', 'doc-1', actor)).rejects.toThrow(ForbiddenException);
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
});
