import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { SearchService } from './search.service';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { SearchQueryDto, SearchType } from './dto';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { AccessQueryService } from '../../common/services/access-query.service';
import type { UnifiedActor } from '../../common/types/actor.types';

/** 创建一个链式 QueryBuilder mock */
function createMockQueryBuilder() {
  const builder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
    getCount: jest.fn().mockResolvedValue(0),
  };
  return builder;
}

function createMockRepo<T extends object>() {
  const queryBuilder = createMockQueryBuilder();

  const mock = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findBy: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn(),
    save: jest.fn((entity) => Promise.resolve(entity)),
    create: jest.fn((entity) => entity),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilder),
    manager: {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    },
  } as unknown as jest.Mocked<Repository<T>>;

  return { mock, queryBuilder };
}

/** 构造最小 Message mock 实体，包含显式构造所需的所有字段 */
function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    topicId: 'topic-1',
    senderId: 'sender-1',
    type: 'chat' as any,
    content: 'hello world',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    // 以下字段 search 摘要不关心，但 TypeORM cast 需要存在
    contentFormat: 'markdown',
    mentions: [],
    metadata: {},
    replyToId: null,
    replyCount: 0,
    editedAt: null,
    editHistory: [],
    searchVector: null,
    sortOrder: null,
    // 非 DB 字段，Service 注入
    senderType: 'human' as any,
    topic: null as any,
    replyTo: null as any,
    replies: [] as any,
    ...overrides,
  } as Message;
}

/** 构造最小 Task mock 实体，包含显式构造所需的所有字段 */
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    listId: 'list-1',
    title: 'hello task',
    status: 'todo' as any,
    priority: 'p2' as any,
    assigneeId: null,
    assigneeType: null,
    position: 0,
    dueDate: null,
    labels: null,
    milestoneId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    description: 'task description text',
    descriptionFormat: 'markdown',
    parentId: null,
    topicId: null,
    startedAt: null,
    completedAt: null,
    customFields: {},
    searchVector: null,
    // relations
    list: { id: 'list-1', boardId: 'board-1' } as any,
    topic: null as any,
    parent: null as any,
    subtasks: [] as any,
    comments: [] as any,
    activities: [] as any,
    dependencies: [] as any,
    dependents: [] as any,
    milestone: null as any,
    ...overrides,
  } as Task;
}

describe('SearchService', () => {
  let service: SearchService;
  let mockMessageRepo: jest.Mocked<Repository<Message>>;
  let mockTaskRepo: jest.Mocked<Repository<Task>>;
  let mockAgentRepo: jest.Mocked<Repository<Agent>>;
  let mockUserRepo: jest.Mocked<Repository<User>>;
  let mockAccessQuery: jest.Mocked<AccessQueryService>;
  let messageQb: ReturnType<typeof createMockQueryBuilder>;
  let taskQb: ReturnType<typeof createMockQueryBuilder>;
  /** taskRepo.manager.createQueryBuilder() 用于 resolveBoardTopicIds */
  let boardTopicQb: ReturnType<typeof createMockQueryBuilder>;

  beforeEach(async () => {
    const messageRepoPair = createMockRepo<Message>();
    mockMessageRepo = messageRepoPair.mock;
    messageQb = messageRepoPair.queryBuilder;

    const taskRepoPair = createMockRepo<Task>();
    mockTaskRepo = taskRepoPair.mock;
    taskQb = taskRepoPair.queryBuilder;

    const agentRepoPair = createMockRepo<Agent>();
    mockAgentRepo = agentRepoPair.mock;

    const userRepoPair = createMockRepo<User>();
    mockUserRepo = userRepoPair.mock;

    mockAccessQuery = {
      getAccessibleTopicIds: jest.fn(),
      getAccessibleBoardIds: jest.fn(),
    } as unknown as jest.Mocked<AccessQueryService>;

    // resolveBoardTopicIds 使用的 raw query builder
    boardTopicQb = createMockQueryBuilder();
    // 默认返回空结果
    boardTopicQb.getRawMany.mockResolvedValue([]);
    // 让 taskRepo.manager.createQueryBuilder() 不带参数时也使用该 qb
    (mockTaskRepo.manager.createQueryBuilder as jest.Mock).mockReturnValue(boardTopicQb);

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getRepositoryToken(Task), useValue: mockTaskRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: AccessQueryService, useValue: mockAccessQuery },
      ],
    }).compile();

    service = moduleRef.get<SearchService>(SearchService);
  });

  afterEach(() => jest.clearAllMocks());

  /** 设置 Message 搜索的 mock：权限查询 + 主查询 + highlight 查询 */
  function setupMessageSearchMock(
    accessibleTopicIds: string[] | null,
    entities: Message[],
    total: number,
    highlights: Map<string, string>,
  ) {
    mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(accessibleTopicIds);

    // 主查询
    messageQb.getManyAndCount.mockResolvedValue([entities, total]);

    // highlight 查询
    const highlightQb = createMockQueryBuilder();
    highlightQb.getRawMany.mockResolvedValue(
      Array.from(highlights.entries()).map(([id, highlight]) => ({
        id,
        highlight,
      })),
    );

    mockMessageRepo.createQueryBuilder
      .mockReturnValueOnce(messageQb as unknown as SelectQueryBuilder<Message>)
      .mockReturnValueOnce(highlightQb as unknown as SelectQueryBuilder<Message>);
  }

  /** 设置 Task 搜索的 mock：权限查询 + 主查询 + highlight 查询 */
  function setupTaskSearchMock(
    accessibleBoardIds: string[] | null,
    entities: Task[],
    total: number,
    highlights: Map<string, string>,
  ) {
    mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(accessibleBoardIds);

    // 主查询
    taskQb.getManyAndCount.mockResolvedValue([entities, total]);

    // highlight 查询
    const highlightQb = createMockQueryBuilder();
    highlightQb.getRawMany.mockResolvedValue(
      Array.from(highlights.entries()).map(([id, highlight]) => ({
        id,
        highlight,
      })),
    );

    mockTaskRepo.createQueryBuilder
      .mockReturnValueOnce(taskQb as unknown as SelectQueryBuilder<Task>)
      .mockReturnValueOnce(highlightQb as unknown as SelectQueryBuilder<Task>);
  }

  // ============================================================================
  // 摘要字段回归断言工具
  // ============================================================================

  /**
   * 断言消息搜索结果仅包含摘要字段，不含全文/元数据/编辑历史等敏感字段
   */
  function expectMessageSummaryKeys(item: Record<string, unknown>) {
    const allowedKeys = [
      'id', 'topicId', 'senderId', 'senderType', 'senderName',
      'type', 'createdAt', 'contentSnippet', 'highlight',
    ];
    const actualKeys = Object.keys(item).sort();
    const extraKeys = actualKeys.filter((k) => !allowedKeys.includes(k));
    expect(extraKeys).toEqual([]);
    // 验证必含字段都存在
    for (const key of allowedKeys) {
      expect(item).toHaveProperty(key);
    }
  }

  /**
   * 断言任务搜索结果仅包含 TaskSummary + boardId/topicId + 摘要字段
   */
  function expectTaskSummaryKeys(item: Record<string, unknown>) {
    const forbiddenKeys = ['description', 'customFields'];
    for (const key of forbiddenKeys) {
      expect(item).not.toHaveProperty(key);
    }
    // 必含字段
    const requiredKeys = [
      'id', 'listId', 'title', 'status', 'priority',
      'boardId', 'topicId', 'descriptionSnippet', 'highlight',
    ];
    for (const key of requiredKeys) {
      expect(item).toHaveProperty(key);
    }
  }

  // ============================================================================
  // search with type=all
  // ============================================================================
  describe('search with type=all', () => {
    it('should return paginated messages and tasks with highlights', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello world', senderId: 'sender-1' })];
      const tasks = [makeTask({ id: 'task-1', title: 'hello task' })];

      // sender resolution
      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 'sender-1', displayName: 'Test User', username: 'test' } as any]);

      // boardId/topicId resolution
      boardTopicQb.getRawMany.mockResolvedValue([
        { list_id: 'list-1', board_id: 'board-1', topic_id: 'topic-1' },
      ]);

      setupMessageSearchMock(['topic-1'], messages, 1, new Map([['msg-1', '<<<hello>>> world']]));
      setupTaskSearchMock(['board-1'], tasks, 1, new Map([['task-1', '<<<hello>>> task']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.ALL,
        page: 1,
        pageSize: 20,
      };
      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.search(dto, actor);

      // 消息断言
      expect(result.messages).not.toBeNull();
      expect(result.messages!.items).toHaveLength(1);
      expect(result.messages!.items[0].highlight).toBe('<<<hello>>> world');
      expectMessageSummaryKeys(result.messages!.items[0] as any);
      expect(result.messages!.items[0].contentSnippet).toBe('hello world');
      expect(result.messages!.items[0].senderName).toBe('Test User');
      expect(result.messages!.items[0].senderType).toBe('human');
      expect(result.messages!.total).toBe(1);
      expect(result.messages!.page).toBe(1);

      // 任务断言
      expect(result.tasks).not.toBeNull();
      expect(result.tasks!.items).toHaveLength(1);
      expect(result.tasks!.items[0].highlight).toBe('<<<hello>>> task');
      expectTaskSummaryKeys(result.tasks!.items[0] as any);
      expect(result.tasks!.items[0].descriptionSnippet).toBe('task description text');
      expect(result.tasks!.items[0].boardId).toBe('board-1');
      expect(result.tasks!.items[0].topicId).toBe('topic-1');
      expect(result.tasks!.total).toBe(1);
    });

    it('should return empty paginated results when no matches', async () => {
      setupMessageSearchMock([], [], 0, new Map());
      setupTaskSearchMock([], [], 0, new Map());

      const dto: SearchQueryDto = {
        q: 'nonexistent',
        type: SearchType.ALL,
        page: 1,
        pageSize: 20,
      };
      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.search(dto, actor);

      expect(result.messages!.items).toHaveLength(0);
      expect(result.messages!.total).toBe(0);
      expect(result.messages!.totalPages).toBe(0);
      expect(result.messages!.hasNext).toBe(false);
      expect(result.messages!.hasPrev).toBe(false);

      expect(result.tasks!.items).toHaveLength(0);
      expect(result.tasks!.total).toBe(0);
    });
  });

  // ============================================================================
  // search with type=messages
  // ============================================================================
  describe('search with type=messages', () => {
    it('should return only messages and null tasks', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 'sender-1' })];

      mockAgentRepo.findBy.mockResolvedValue([{ id: 'sender-1', name: 'TestAgent' } as any]);
      mockUserRepo.findBy.mockResolvedValue([]);

      setupMessageSearchMock(['topic-1'], messages, 1, new Map([['msg-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };
      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.search(dto, actor);

      expect(result.messages).not.toBeNull();
      expect(result.messages!.items).toHaveLength(1);
      expect(result.messages!.items[0].senderName).toBe('TestAgent');
      expect(result.messages!.items[0].senderType).toBe('agent');
      expect(result.tasks).toBeNull();
    });

    it('should inject contentSnippet truncated to 200 chars', async () => {
      const longContent = 'x'.repeat(300);
      const messages = [makeMsg({ id: 'msg-1', content: longContent, senderId: 'sender-1' })];

      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 'sender-1', displayName: 'U', username: 'u' } as any]);

      setupMessageSearchMock(['topic-1'], messages, 1, new Map([['msg-1', '<<<x>>>']]));

      const dto: SearchQueryDto = { q: 'x', type: SearchType.MESSAGES, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      const snippet = result.messages!.items[0].contentSnippet;
      expect(snippet.length).toBeLessThanOrEqual(200);
      expect(snippet).toBe(longContent.slice(0, 200));
    });

    it('should default senderType to system and senderName to System for unknown sender', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 'unknown-1' })];

      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([]);

      setupMessageSearchMock(['topic-1'], messages, 1, new Map([['msg-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.MESSAGES, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      expect(result.messages!.items[0].senderName).toBe('System');
      expect(result.messages!.items[0].senderType).toBe('system');
    });
  });

  // ============================================================================
  // search with type=tasks
  // ============================================================================
  describe('search with type=tasks', () => {
    it('should return only tasks and null messages', async () => {
      const tasks = [makeTask({ id: 'task-1', title: 'hello' })];

      // boardId/topicId resolution
      boardTopicQb.getRawMany.mockResolvedValue([
        { list_id: 'list-1', board_id: 'board-1', topic_id: null },
      ]);

      setupTaskSearchMock(['board-1'], tasks, 1, new Map([['task-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.TASKS,
        page: 1,
        pageSize: 20,
      };
      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.search(dto, actor);

      expect(result.tasks).not.toBeNull();
      expect(result.tasks!.items).toHaveLength(1);
      expectTaskSummaryKeys(result.tasks!.items[0] as any);
      expect(result.tasks!.items[0].descriptionSnippet).toBe('task description text');
      expect(result.messages).toBeNull();
    });

    it('should inject descriptionSnippet truncated to 200 chars', async () => {
      const longDesc = 'y'.repeat(300);
      const tasks = [makeTask({ id: 'task-1', title: 'hello', description: longDesc })];

      boardTopicQb.getRawMany.mockResolvedValue([
        { list_id: 'list-1', board_id: 'board-1', topic_id: 'topic-1' },
      ]);

      setupTaskSearchMock(['board-1'], tasks, 1, new Map([['task-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.TASKS, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      const snippet = result.tasks!.items[0].descriptionSnippet;
      expect(snippet!.length).toBeLessThanOrEqual(200);
      expect(snippet).toBe(longDesc.slice(0, 200));
    });

    it('should set descriptionSnippet to null when task has no description', async () => {
      const tasks = [makeTask({ id: 'task-1', title: 'hello', description: null })];

      boardTopicQb.getRawMany.mockResolvedValue([]);

      setupTaskSearchMock(['board-1'], tasks, 1, new Map([['task-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.TASKS, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      expect(result.tasks!.items[0].descriptionSnippet).toBeNull();
    });
  });

  // ============================================================================
  // B-55 QueryBuilder orderBy select 回归测试
  // ============================================================================
  describe('B-55 QueryBuilder orderBy select regression', () => {
    it('searchMessages should addSelect rank before skip/take/orderBy', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 's' })];
      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 's', displayName: 'U', username: 'u' } as any]);
      setupMessageSearchMock(['topic-1'], messages, 1, new Map([['msg-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };
      await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      // 防止 TypeORM 0.3.30 在 skip/take + innerJoin + orderBy(计算别名) 时
      // 生成 `distinctAlias.rank does not exist` 的回归
      expect(messageQb.addSelect).toHaveBeenCalledWith(
        'ts_rank(m.search_vector, plainto_tsquery(:q))',
        'rank',
      );
      expect(messageQb.orderBy).toHaveBeenCalledWith('rank', 'DESC');
      expect(messageQb.skip).toHaveBeenCalledWith(0);
      expect(messageQb.take).toHaveBeenCalledWith(20);
    });

    it('searchTasks should addSelect rank before skip/take/orderBy', async () => {
      const tasks = [makeTask({ id: 'task-1', title: 'hello' })];
      boardTopicQb.getRawMany.mockResolvedValue([]);
      setupTaskSearchMock(['board-1'], tasks, 1, new Map([['task-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.TASKS,
        page: 1,
        pageSize: 20,
      };
      await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      expect(taskQb.addSelect).toHaveBeenCalledWith(
        'ts_rank(task.search_vector, plainto_tsquery(:q))',
        'rank',
      );
      expect(taskQb.orderBy).toHaveBeenCalledWith('rank', 'DESC');
      expect(taskQb.skip).toHaveBeenCalledWith(0);
      expect(taskQb.take).toHaveBeenCalledWith(20);
    });
  });

  // ============================================================================
  // pagination
  // ============================================================================
  describe('pagination', () => {
    it('should calculate pagination correctly for multi-page results', async () => {
      const tasks = Array.from({ length: 5 }, (_, i) =>
        makeTask({ id: `task-${i}`, title: `task ${i}` }),
      );
      boardTopicQb.getRawMany.mockResolvedValue([]);

      setupTaskSearchMock(
        ['board-1'],
        tasks,
        25,
        new Map(tasks.map((t) => [t.id, `<<<task>>> ${t.title}`])),
      );

      const dto: SearchQueryDto = {
        q: 'task',
        type: SearchType.TASKS,
        page: 2,
        pageSize: 5,
      };
      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.search(dto, actor);

      expect(result.tasks!.page).toBe(2);
      expect(result.tasks!.pageSize).toBe(5);
      expect(result.tasks!.total).toBe(25);
      expect(result.tasks!.totalPages).toBe(5);
      expect(result.tasks!.hasNext).toBe(true);
      expect(result.tasks!.hasPrev).toBe(true);
    });

    it('should set hasNext=false on last page', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 's' })];

      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 's', displayName: 'U', username: 'u' } as any]);

      setupMessageSearchMock(['topic-1'], messages, 3, new Map([['msg-1', '<<<hello>>>']])); // total=3, page=1, pageSize=20

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };
      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.search(dto, actor);

      expect(result.messages!.hasNext).toBe(false);
      expect(result.messages!.hasPrev).toBe(false);
    });
  });

  // ============================================================================
  // permission filtering
  // ============================================================================
  describe('permission filtering', () => {
    it('should allow admin to search all topics/boards without IN filter', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 's' })];
      const tasks = [makeTask({ id: 'task-1', title: 'hello' })];

      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 's', displayName: 'U', username: 'u' } as any]);
      boardTopicQb.getRawMany.mockResolvedValue([]);

      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(null);
      mockAccessQuery.getAccessibleBoardIds.mockResolvedValue(null);

      // 主查询
      messageQb.getManyAndCount.mockResolvedValue([messages, 1]);
      taskQb.getManyAndCount.mockResolvedValue([tasks, 1]);

      // highlight 查询
      const messageHighlightQb = createMockQueryBuilder();
      messageHighlightQb.getRawMany.mockResolvedValue([{ id: 'msg-1', highlight: '<<<hello>>>' }]);
      const taskHighlightQb = createMockQueryBuilder();
      taskHighlightQb.getRawMany.mockResolvedValue([{ id: 'task-1', highlight: '<<<hello>>>' }]);

      mockMessageRepo.createQueryBuilder
        .mockReturnValueOnce(messageQb as unknown as SelectQueryBuilder<Message>)
        .mockReturnValueOnce(messageHighlightQb as unknown as SelectQueryBuilder<Message>);

      mockTaskRepo.createQueryBuilder
        .mockReturnValueOnce(taskQb as unknown as SelectQueryBuilder<Task>)
        .mockReturnValueOnce(taskHighlightQb as unknown as SelectQueryBuilder<Task>);

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.ALL,
        page: 1,
        pageSize: 20,
      };
      const adminActor: UnifiedActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      const result = await service.search(dto, adminActor);

      // Admin 触发权限查询但返回 null（不过滤）
      expect(mockAccessQuery.getAccessibleTopicIds).toHaveBeenCalledWith(adminActor);
      expect(mockAccessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(adminActor);
      // 主查询不应被 IN 过滤
      expect(messageQb.andWhere).not.toHaveBeenCalledWith(
        't.id IN (:...accessibleTopicIds)',
        expect.anything(),
      );
      expect(taskQb.andWhere).not.toHaveBeenCalledWith(
        'b.id IN (:...accessibleBoardIds)',
        expect.anything(),
      );

      expect(result.messages!.items).toHaveLength(1);
      expect(result.tasks!.items).toHaveLength(1);
    });

    it('should filter out messages from inaccessible private topics for non-admin', async () => {
      // user-b 只能访问 topic-b，搜索 user-a 的 topic-a 消息应该为空
      setupMessageSearchMock(['topic-b'], [], 0, new Map());

      const dto: SearchQueryDto = {
        q: 'secret',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };
      const userB: UnifiedActor = { id: 'user-b', type: ActorType.HUMAN };
      const result = await service.search(dto, userB);

      expect(result.messages!.items).toHaveLength(0);
      expect(result.messages!.total).toBe(0);
      // 验证主查询被 IN 过滤
      expect(messageQb.andWhere).toHaveBeenCalledWith('t.id IN (:...accessibleTopicIds)');
    });

    it('should filter out tasks from inaccessible boards for agent of another user', async () => {
      // agent-b 属于 user-b，不能访问 user-a 的 board-a
      setupTaskSearchMock(['board-b'], [], 0, new Map());

      const dto: SearchQueryDto = {
        q: 'secret',
        type: SearchType.TASKS,
        page: 1,
        pageSize: 20,
      };
      const agentB: UnifiedActor = { id: 'agent-b', type: ActorType.AGENT };
      const result = await service.search(dto, agentB);

      expect(result.tasks!.items).toHaveLength(0);
      expect(result.tasks!.total).toBe(0);
      // 验证主查询被 IN 过滤
      expect(taskQb.andWhere).toHaveBeenCalledWith('b.id IN (:...accessibleBoardIds)');
    });

    it('should allow non-admin to search their own created topics', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 's' })];

      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 's', displayName: 'U', username: 'u' } as any]);

      // user-a 创建了 topic-a，白名单包含 topic-a
      setupMessageSearchMock(['topic-a'], messages, 1, new Map([['msg-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };
      const userA: UnifiedActor = { id: 'user-a', type: ActorType.HUMAN };
      const result = await service.search(dto, userA);

      expect(result.messages!.items).toHaveLength(1);
      expect(result.messages!.items[0].id).toBe('msg-1');
    });

    it('should allow non-admin to search topics they participate in', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 's' })];

      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([{ id: 's', displayName: 'U', username: 'u' } as any]);

      // user-b 是 topic-a 的 participant
      setupMessageSearchMock(['topic-a'], messages, 1, new Map([['msg-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = {
        q: 'hello',
        type: SearchType.MESSAGES,
        page: 1,
        pageSize: 20,
      };
      const userB: UnifiedActor = { id: 'user-b', type: ActorType.HUMAN };
      const result = await service.search(dto, userB);

      expect(result.messages!.items).toHaveLength(1);
    });
  });
});
