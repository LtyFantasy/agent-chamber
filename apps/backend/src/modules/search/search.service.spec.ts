import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder, In } from 'typeorm';
import { SearchService } from './search.service';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { Agent } from '../../database/entities/agent.entity';
import { User } from '../../database/entities/user.entity';
import { Actor } from '../../database/entities/actor.entity';
import { SearchQueryDto, SearchType } from './dto';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { AccessQueryService } from '../../common/services/access-query.service';
import { ActorProfileService, ActorProfile } from '../../common/services/actor-profile.service';
import type { UnifiedActor } from '../../common/types/actor.types';
import { Doc } from '../../database/entities/doc.entity';
import { DocSearchService } from '../docspace/doc-search.service';
import type { DocSearchHit, DocSearchHitWithSpace } from '@agent-chamber/shared';

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
  let mockDocRepo: jest.Mocked<Repository<Doc>>;
  let mockActorRepo: jest.Mocked<Repository<Actor>>;
  let mockDocSearchService: jest.Mocked<DocSearchService>;
  let mockAccessQuery: jest.Mocked<AccessQueryService>;
  let mockActorProfileService: { resolveProfiles: jest.Mock; assertActorUsable: jest.Mock };
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

    const docRepoPair = createMockRepo<Doc>();
    mockDocRepo = docRepoPair.mock;

    const actorRepoPair = createMockRepo<Actor>();
    mockActorRepo = actorRepoPair.mock;

    // DocSearchService 默认空命中：type=all 的既有用例（不关心 docs）不会因 docs 分支崩掉；
    // docs 专项用例在 setupDocSearchMock 中覆盖默认值
    mockDocSearchService = {
      search: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DocSearchService>;

    mockAccessQuery = {
      getAccessibleTopicIds: jest.fn(),
      getAccessibleBoardIds: jest.fn(),
      getAccessibleDocSpaceIds: jest.fn(),
    } as unknown as jest.Mocked<AccessQueryService>;

    // resolveBoardTopicIds 使用的 raw query builder
    boardTopicQb = createMockQueryBuilder();
    // 默认返回空结果
    boardTopicQb.getRawMany.mockResolvedValue([]);
    // 让 taskRepo.manager.createQueryBuilder() 不带参数时也使用该 qb
    (mockTaskRepo.manager.createQueryBuilder as jest.Mock).mockReturnValue(boardTopicQb);

    // 统一批 A2：发送者解析委托 ActorProfileService。mock 默认实现以 actorRepo.find 返回
    // 的 actors 行为准（deletedAt 透传）——默认 find 为空 → 真孤儿不进 map → 调用方
    // 以 'System'/'system' 兜底（对齐公共服务 R12 语义）。
    mockActorProfileService = {
      resolveProfiles: jest.fn(async (actorIds: string[]): Promise<Map<string, ActorProfile>> => {
        const uniqueIds = [...new Set(actorIds)].filter(Boolean);
        const map = new Map<string, ActorProfile>();
        if (uniqueIds.length === 0) return map;
        const typeRows = await mockActorRepo.find({} as any);
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

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getRepositoryToken(Task), useValue: mockTaskRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Doc), useValue: mockDocRepo },
        { provide: getRepositoryToken(Actor), useValue: mockActorRepo },
        { provide: DocSearchService, useValue: mockDocSearchService },
        { provide: AccessQueryService, useValue: mockAccessQuery },
        { provide: ActorProfileService, useValue: mockActorProfileService },
      ],
    }).compile();

    service = moduleRef.get<SearchService>(SearchService);
    // 默认无 actors 行（真孤儿 → 'System' 兜底）；软删/有主用例用 mockResolvedValueOnce 覆盖
    mockActorRepo.find.mockResolvedValue([]);
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

  /**
   * 设置 Doc 搜索的 mock：权限查询 + DocSearchService 命中 + spaceId 补全查询
   *
   * @param accessibleSpaceIds 白名单（null=admin 全量；[]=无空间）
   * @param hits DocSearchService 返回的原始命中（不含 spaceId）
   * @param spaceRows docRepo 补查返回的 { id, spaceId } 行
   */
  function setupDocSearchMock(
    accessibleSpaceIds: string[] | null,
    hits: DocSearchHit[],
    spaceRows: Array<{ id: string; spaceId: string }> = [],
  ) {
    mockAccessQuery.getAccessibleDocSpaceIds.mockResolvedValue(accessibleSpaceIds);
    mockDocSearchService.search.mockResolvedValue(hits);
    mockDocRepo.find.mockResolvedValue(spaceRows as unknown as Doc[]);
  }

  // ============================================================================
  // 摘要字段回归断言工具
  // ============================================================================

  /**
   * 断言消息搜索结果仅包含摘要字段，不含全文/元数据/编辑历史等敏感字段
   */
  function expectMessageSummaryKeys(item: Record<string, unknown>) {
    const allowedKeys = [
      'id',
      'topicId',
      'senderId',
      'senderType',
      'senderName',
      'senderDeletedAt',
      'type',
      'createdAt',
      'contentSnippet',
      'highlight',
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
      'id',
      'listId',
      'title',
      'status',
      'priority',
      'boardId',
      'topicId',
      'descriptionSnippet',
      'highlight',
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

      // sender resolution（统一批 A2：公共解析经 actorRepo.find 驱动）
      mockActorRepo.find.mockResolvedValueOnce([
        { id: 'sender-1', type: ActorType.HUMAN } as Actor,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);
      mockUserRepo.findBy.mockResolvedValue([
        { id: 'sender-1', displayName: 'Test User', username: 'test' } as any,
      ]);

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

      // 文档断言（本用例未造文档命中，默认 mock 返回空）
      expect(result.docs).toEqual([]);
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

      mockActorRepo.find.mockResolvedValueOnce([
        { id: 'sender-1', type: ActorType.AGENT } as Actor,
      ]);
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
      mockUserRepo.findBy.mockResolvedValue([
        { id: 'sender-1', displayName: 'U', username: 'u' } as any,
      ]);

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
      // 真孤儿 senderDeletedAt 兜底 null（契约：'System' 仅留真孤儿）
      expect(result.messages!.items[0].senderDeletedAt).toBeNull();
    });

    it('软删 agent 发送者：真名保留 + senderDeletedAt 非空（统一批契约，原归 System 行为变更）', async () => {
      const messages = [makeMsg({ id: 'msg-1', content: 'hello', senderId: 'sender-1' })];

      // 软删行：actors 带 deletedAt（withDeleted 语义经 mock 透传）
      mockActorRepo.find.mockResolvedValueOnce([
        {
          id: 'sender-1',
          type: ActorType.AGENT,
          deletedAt: new Date('2024-06-01T00:00:00Z'),
        } as Actor,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([{ id: 'sender-1', name: 'TestAgent' } as any]);
      mockUserRepo.findBy.mockResolvedValue([]);

      setupMessageSearchMock(['topic-1'], messages, 1, new Map([['msg-1', '<<<hello>>>']]));

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.MESSAGES, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      expect(result.messages!.items[0].senderName).toBe('TestAgent');
      expect(result.messages!.items[0].senderType).toBe('agent');
      expect(result.messages!.items[0].senderDeletedAt).toBe('2024-06-01T00:00:00.000Z');
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
  // search with type=docs（v1.48.0：全局搜索接入 DocSpace 文档）
  // ============================================================================
  describe('search with type=docs', () => {
    /** 构造最小 DocSearchHit mock */
    function makeHit(overrides: Partial<DocSearchHit> = {}): DocSearchHit {
      return {
        docId: 'doc-1',
        docPath: 'docs/architecture.md',
        docTitle: 'Architecture',
        position: 0,
        headingPath: 'Architecture',
        snippet: 'hello from doc',
        score: 0.5,
        ...overrides,
      };
    }

    it('should return only docs, null messages/tasks, and inject spaceId', async () => {
      setupDocSearchMock(
        ['space-1'],
        [makeHit({ docId: 'doc-1' }), makeHit({ docId: 'doc-2' })],
        [
          { id: 'doc-1', spaceId: 'space-1' },
          { id: 'doc-2', spaceId: 'space-1' },
        ],
      );

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.DOCS, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      expect(result.messages).toBeNull();
      expect(result.tasks).toBeNull();
      expect(result.docs).not.toBeNull();
      expect(result.docs).toHaveLength(2);
      expect(result.docs![0]).toMatchObject({
        docId: 'doc-1',
        spaceId: 'space-1',
        docTitle: 'Architecture',
      });
      expect(result.docs![1].spaceId).toBe('space-1');
      // 权限白名单 + limit=20 透传给 DocSearchService
      expect(mockDocSearchService.search).toHaveBeenCalledWith(['space-1'], {
        q: 'hello',
        limit: 20,
      });
    });

    it('should pass null (admin all-spaces) to DocSearchService and skip spaceId query on empty hits', async () => {
      setupDocSearchMock(null, [], []);

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.DOCS, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'admin-1', type: ActorType.HUMAN });

      expect(result.docs).toEqual([]);
      // admin：白名单为 null 原样透传（DocSearchService 语义：null=全量不过滤）
      expect(mockDocSearchService.search).toHaveBeenCalledWith(null, { q: 'hello', limit: 20 });
      // 空命中短路：不触发 docRepo 补查（避免无谓查询）
      expect(mockDocRepo.find).not.toHaveBeenCalled();
    });

    it('should pass empty whitelist through and return empty docs (non-admin with no accessible spaces)', async () => {
      setupDocSearchMock([], [], []);

      const dto: SearchQueryDto = { q: 'hello', type: SearchType.DOCS, page: 1, pageSize: 20 };
      const result = await service.search(dto, { id: 'user-1', type: ActorType.HUMAN });

      expect(result.docs).toEqual([]);
      // 空白名单语义对齐 messages/tasks：透传 []（DocSearchService 内部短路），不触发补查
      expect(mockDocSearchService.search).toHaveBeenCalledWith([], { q: 'hello', limit: 20 });
      expect(mockDocRepo.find).not.toHaveBeenCalled();
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
      const adminActor: UnifiedActor = {
        id: 'admin-1',
        type: ActorType.HUMAN,
        role: UserRole.ADMIN,
      };
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
