import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral, SelectQueryBuilder, InsertResult, In, DataSource, EntityManager } from 'typeorm';
import { NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { TopicService } from './topic.service';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { Message } from '../../database/entities/message.entity';
import { User } from '../../database/entities/user.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { Board } from '../../database/entities/board.entity';
import { Task } from '../../database/entities/task.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import { TopicStatus, ActorType, MessageType, UserRole, ErrorCode, ParticipantStatus, Visibility } from '@agent-chamber/shared';
import { EventService } from '../event/event.service';
import { AccessQueryService } from '../../common/services/access-query.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { ResourceValidator } from '../../common/resource-validator';

function createMockRepo<T extends ObjectLiteral>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    remove: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    findBy: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getRawMany: jest.fn(),
      getCount: jest.fn(),
      clone: jest.fn().mockReturnThis(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic-1',
    title: 'Test Topic',
    description: null,
    agenda: [],
    status: TopicStatus.OPEN,
    settings: {},
    creatorId: 'user-1',
    creatorType: ActorType.HUMAN,
    messageCount: 10,
    participantCount: 3,
    lastMessageAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    participants: [],
    messages: [],
    boards: [],
    tasks: [],
    ...overrides,
  } as Topic;
}

function createMockParticipant(overrides: Partial<TopicParticipant> = {}): TopicParticipant {
  return {
    topicId: 'topic-1',
    participantId: 'user-1',
    participantType: ActorType.HUMAN,
    role: 'member',
    joinedAt: new Date('2024-01-01'),
    leftAt: null,
    status: 'active',
    notificationSettings: {},
    lastReadMessageId: null,
    topic: null,
    ...overrides,
  } as TopicParticipant;
}

function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    topicId: 'topic-1',
    senderId: 'user-1',
    senderType: ActorType.HUMAN,
    type: MessageType.CHAT,
    content: 'Hello world',
    contentFormat: 'markdown',
    mentions: [],
    metadata: {},
    replyToId: null,
    replyCount: 0,
    editedAt: null,
    editHistory: [],
    sortOrder: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    deletedAt: null,
    topic: null,
    replyTo: null,
    replies: [],
    ...overrides,
  } as Message;
}

function createMockQueryBuilder(items: Message[], total: number) {
  const getManyAndCountMock = jest.fn().mockResolvedValue([items, total]);
  const getCountMock = jest.fn().mockResolvedValue(total);
  const getManyMock = jest.fn().mockResolvedValue(items);
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getManyAndCount: getManyAndCountMock,
    getCount: getCountMock,
    getMany: getManyMock,
    clone: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
    getRawMany: jest.fn(),
  };
}

describe('TopicService', () => {
  let service: TopicService;
  let mockTopicRepo: jest.Mocked<Repository<Topic>>;
  let mockParticipantRepo: jest.Mocked<Repository<TopicParticipant>>;
  let mockMessageRepo: jest.Mocked<Repository<Message>>;
  let mockUserRepo: jest.Mocked<Repository<User>>;
  let mockAgentRepo: jest.Mocked<Repository<Agent>>;
  let mockActorRepo: jest.Mocked<Repository<Actor>>;
  let mockBoardRepo: jest.Mocked<Repository<Board>>;
  let mockTaskRepo: jest.Mocked<Repository<Task>>;
  let mockAccessQuery: jest.Mocked<AccessQueryService>;
  let mockOwnerProxy: jest.Mocked<OwnerProxyService>;
  let mockResourceValidator: { exists: jest.Mock; existsMany: jest.Mock };
  let mockDataSource: jest.Mocked<DataSource>;
  let mockIdempotencyRepo: jest.Mocked<Repository<IdempotencyRecord>>;
  let mockEntityManager: { getRepository: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    mockTopicRepo = createMockRepo<Topic>();
    mockParticipantRepo = createMockRepo<TopicParticipant>();
    mockMessageRepo = createMockRepo<Message>();
    mockUserRepo = createMockRepo<User>();
    mockAgentRepo = createMockRepo<Agent>();
    mockActorRepo = createMockRepo<Actor>();
    mockBoardRepo = createMockRepo<Board>();
    mockTaskRepo = createMockRepo<Task>();
    mockIdempotencyRepo = createMockRepo<IdempotencyRecord>();
    mockAccessQuery = {
      getAccessibleTopicIds: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccessQueryService>;

    mockOwnerProxy = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
      getOwnedAgentIds: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<OwnerProxyService>;

    // ResourceValidator mock：exists 默认成功；existsMany 委托给真实 Agent repo.findBy
    mockResourceValidator = {
      exists: jest.fn().mockResolvedValue({ id: 'agent-1' } as Agent),
      existsMany: jest.fn(async (repo: Repository<ObjectLiteral>, ids: string[], errorCode: ErrorCode) => {
        if (ids.length === 0) return [];
        const entities = await repo.findBy({ id: In(ids) } as any);
        if (entities.length !== ids.length) {
          throw new NotFoundException({ message: 'Some resources not found', code: errorCode });
        }
        return entities;
      }),
    };

    // DataSource mock：transaction 默认透传回调
    mockDataSource = {
      transaction: jest.fn(async (cb: (manager: EntityManager) => Promise<unknown>) => {
        return cb(mockEntityManager as unknown as EntityManager);
      }),
      getRepository: jest.fn(),
    } as unknown as jest.Mocked<DataSource>;

    // EntityManager mock：getRepository 按类型返回对应 mock repo；
    // query 用于 sendMessage 事务路径的原子条件 upsert（AUTO_JOIN_PARTICIPANT_SQL）
    mockEntityManager = {
      getRepository: jest.fn((entityClass: unknown) => {
        if (entityClass === Topic) return mockTopicRepo;
        if (entityClass === TopicParticipant) return mockParticipantRepo;
        if (entityClass === Message) return mockMessageRepo;
        if (entityClass === IdempotencyRecord) return mockIdempotencyRepo;
        return createMockRepo();
      }),
      query: jest.fn().mockResolvedValue([]),
    };

    // 默认 getRepository 行为（23505 replay 路径使用）
    mockDataSource.getRepository.mockImplementation((entityClass: unknown) => {
      if (entityClass === IdempotencyRecord) return mockIdempotencyRepo;
      return createMockRepo();
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TopicService,
        { provide: getRepositoryToken(Topic), useValue: mockTopicRepo },
        { provide: getRepositoryToken(TopicParticipant), useValue: mockParticipantRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(Actor), useValue: mockActorRepo },
        { provide: getRepositoryToken(Board), useValue: mockBoardRepo },
        { provide: getRepositoryToken(Task), useValue: mockTaskRepo },
        { provide: EventService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        { provide: AccessQueryService, useValue: mockAccessQuery },
        { provide: OwnerProxyService, useValue: mockOwnerProxy },
        { provide: ResourceValidator, useValue: mockResourceValidator },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = moduleRef.get<TopicService>(TopicService);

    jest.clearAllMocks();

    // Actor 类型统一由 actors 表推导；默认实现根据 ID 前缀返回类型，便于消息/参与者测试
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
        .map((id) => ({ id, displayName: 'Alice', avatarUrl: null } as User));
    });
    mockAgentRepo.findBy.mockImplementation(async (criteria: any) => {
      const ids: string[] = criteria?.id?.value ?? [];
      return ids
        .filter((id) => id === 'agent-1')
        .map((id) => ({ id, name: 'Bot-1', avatarUrl: null } as Agent));
    });
  });

  describe('findAll', () => {
    function createMockQueryBuilder(items: Topic[], total: number) {
      const getManyAndCountMock = jest.fn().mockResolvedValue([items, total]);
      const andWhereMock = jest.fn().mockReturnThis();
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: andWhereMock,
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: getManyAndCountMock,
        getMany: jest.fn(),
        getOne: jest.fn(),
      } as unknown as SelectQueryBuilder<Topic> & {
        andWhere: jest.Mock;
        getManyAndCount: jest.Mock;
      };
    }

    it('should return paginated results with default values', async () => {
      const items = [createMockTopic()];
      const qbMock = createMockQueryBuilder(items, 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({});

      expect(mockTopicRepo.createQueryBuilder).toHaveBeenCalledWith('topic');
      expect(qbMock.getManyAndCount).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      // 列表项不含 description 大文本，仅含 descriptionSnippet
      expect(result.items[0]).not.toHaveProperty('description');
      expect(result.items[0]).toHaveProperty('descriptionSnippet');
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.totalPages).toBe(1);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(false);
    });

    it('should produce descriptionSnippet from description', async () => {
      const topic = createMockTopic({ description: 'A short description' });
      const qbMock = createMockQueryBuilder([topic], 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({});
      expect(result.items[0]).not.toHaveProperty('description');
      expect(result.items[0].descriptionSnippet).toBe('A short description');
    });

    it('should truncate long description to 200 characters', async () => {
      const longDesc = 'x'.repeat(300);
      const topic = createMockTopic({ description: longDesc });
      const qbMock = createMockQueryBuilder([topic], 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({});
      expect(result.items[0].descriptionSnippet).toHaveLength(200);
      expect(result.items[0].descriptionSnippet).toBe(longDesc.slice(0, 200));
    });

    it('should return null descriptionSnippet when description is null', async () => {
      const topic = createMockTopic({ description: null });
      const qbMock = createMockQueryBuilder([topic], 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({});
      expect(result.items[0].descriptionSnippet).toBeNull();
    });

    it('should filter by status', async () => {
      const items = [createMockTopic({ status: TopicStatus.CLOSED })];
      const qbMock = createMockQueryBuilder(items, 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({ status: 'closed' });

      expect(qbMock.andWhere).toHaveBeenCalledWith('topic.status = :status', { status: 'closed' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty('description');
      expect(result.items[0]).toHaveProperty('descriptionSnippet');
    });

    it('should filter by search query q', async () => {
      const items = [createMockTopic()];
      const qbMock = createMockQueryBuilder(items, 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({ q: 'test' });

      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(topic.title ILIKE :q OR topic.description ILIKE :q)',
        { q: '%test%' },
      );
      expect(result.items).toHaveLength(1);
    });

    it('should ignore status filter when status is all', async () => {
      const items = [createMockTopic()];
      const qbMock = createMockQueryBuilder(items, 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      await service.findAll({ status: 'all' });

      expect(qbMock.andWhere).not.toHaveBeenCalledWith('topic.status = :status', expect.anything());
    });

    it('should handle empty results', async () => {
      const qbMock = createMockQueryBuilder([], 0);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);

      const result = await service.findAll({});

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

    it('should not add IN filter for admin actor', async () => {
      const items = [createMockTopic()];
      const qbMock = createMockQueryBuilder(items, 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(null);

      const adminActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      await service.findAll({}, adminActor);

      expect(mockAccessQuery.getAccessibleTopicIds).toHaveBeenCalledWith(adminActor);
      expect(qbMock.andWhere).not.toHaveBeenCalledWith(
        'topic.id IN (:...accessibleTopicIds)',
        expect.anything(),
      );
    });

    it('should add IN filter for non-admin actor', async () => {
      const items = [createMockTopic({ id: 'topic-1' })];
      const qbMock = createMockQueryBuilder(items, 1);
      mockTopicRepo.createQueryBuilder.mockReturnValue(qbMock);
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue(['topic-1']);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({}, actor);

      expect(mockAccessQuery.getAccessibleTopicIds).toHaveBeenCalledWith(actor);
      expect(qbMock.andWhere).toHaveBeenCalledWith('topic.id IN (:...accessibleTopicIds)', {
        accessibleTopicIds: ['topic-1'],
      });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('should return empty pagination when accessible topic ids is empty', async () => {
      mockAccessQuery.getAccessibleTopicIds.mockResolvedValue([]);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({ page: 1, pageSize: 20 }, actor);

      expect(mockTopicRepo.createQueryBuilder).not.toHaveBeenCalled();
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
  });

  describe('findOne', () => {
    it('should return a topic', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      const result = await service.findById('topic-1');

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(result).toEqual(topic);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.findById('not-found')).rejects.toThrow(NotFoundException);
      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'not-found' } });
    });
  });

  describe('create', () => {
    it('should create topic and add creator as participant', async () => {
      const dto = { title: 'New Topic', description: 'Desc', type: 'discussion' };
      const createdTopic = createMockTopic(dto);
      const savedTopic = createMockTopic({ ...dto, id: 'topic-new' });
      const createdParticipant = createMockParticipant({
        topicId: savedTopic.id,
        role: 'moderator',
      });
      const savedParticipant = createMockParticipant({
        topicId: savedTopic.id,
        role: 'moderator',
      });

      mockTopicRepo.create.mockReturnValue(createdTopic);
      mockTopicRepo.save.mockResolvedValue(savedTopic);
      mockParticipantRepo.create.mockReturnValue(createdParticipant);
      mockParticipantRepo.save.mockResolvedValue(savedParticipant);

      const result = await service.create('user-1', ActorType.HUMAN, dto);

      expect(mockTopicRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: dto.title,
          description: dto.description,
          creatorId: 'user-1',
          creatorType: 'human',
          status: TopicStatus.ACTIVE,
          settings: expect.objectContaining({
            visibility: 'open',
          }),
        }),
      );
      expect(mockTopicRepo.save).toHaveBeenCalledWith(createdTopic);
      expect(mockParticipantRepo.create).toHaveBeenCalledWith({
        topicId: savedTopic.id,
        participantId: 'user-1',
        participantType: 'human',
        role: 'moderator',
        status: ParticipantStatus.ACTIVE,
        joinedAt: expect.any(Date), // creator 即 active，显式写 joinedAt
      });
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(createdParticipant);
      expect(result).toEqual(savedTopic);
    });

    it('should not create invited row for creator when creatorId is in invitedAgentIds', async () => {
      // review 回归：creator 已是 moderator/active 行，invited 行 save upsert 会覆盖降级
      const dto = { title: 'New Topic', invitedAgentIds: ['user-1', 'agent-2'] };
      const savedTopic = createMockTopic({ id: 'topic-new' });

      mockTopicRepo.create.mockReturnValue(savedTopic);
      mockTopicRepo.save.mockResolvedValue(savedTopic);
      mockAgentRepo.findBy.mockResolvedValue([{ id: 'user-1' }, { id: 'agent-2' }] as any);
      mockParticipantRepo.create.mockImplementation((x) => x as TopicParticipant);
      mockParticipantRepo.save.mockResolvedValue({} as TopicParticipant);

      await service.create('user-1', ActorType.HUMAN, dto);

      // create 仅 2 次：creator moderator 行 + agent-2 invited 行（creator 被排除）
      expect(mockParticipantRepo.create).toHaveBeenCalledTimes(2);
      expect(mockParticipantRepo.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ participantId: 'user-1', role: 'moderator' }),
      );
      expect(mockParticipantRepo.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          participantId: 'agent-2',
          role: 'member',
          status: ParticipantStatus.INVITED,
        }),
      );
      // invited 行有意不写 joinedAt（语义：受邀时 NULL，激活时才写入）
      expect(mockParticipantRepo.create).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({ joinedAt: expect.anything() }),
      );
    });

    it('should throw AGENT_NOT_FOUND when invitedAgentIds contains non-existent agent', async () => {
      const dto = {
        title: 'New Topic',
        invitedAgentIds: ['agent-missing'],
      };
      mockTopicRepo.create.mockReturnValue(createMockTopic(dto));
      mockTopicRepo.save.mockResolvedValue(createMockTopic({ ...dto, id: 'topic-new' }));
      mockParticipantRepo.create.mockReturnValue(createMockParticipant());
      mockParticipantRepo.save.mockResolvedValue(createMockParticipant());

      await expect(service.create('user-1', ActorType.HUMAN, dto as any)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.create('user-1', ActorType.HUMAN, dto as any)).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    // ── Idempotency: clientRequestId ──

    it('should create topic normally when clientRequestId is not provided (zero overhead)', async () => {
      const dto = { title: 'Normal Topic' } as any;
      const topic = createMockTopic({ title: 'Normal Topic' });
      mockTopicRepo.create.mockReturnValue(topic);
      mockTopicRepo.save.mockResolvedValue({ ...topic, id: 'topic-new-1' });
      mockParticipantRepo.create.mockReturnValue(createMockParticipant());
      mockParticipantRepo.save.mockResolvedValue(createMockParticipant());

      await service.create('user-1', ActorType.HUMAN, dto);

      // 事务不应被调用（无 clientRequestId）
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });

    it('should create topic with idempotency key and write idempotency record', async () => {
      const dto = { title: 'Idempotent Topic', clientRequestId: 'req-topic-001' } as any;
      const topic = createMockTopic({ id: 'topic-idem-1', title: 'Idempotent Topic' });
      mockTopicRepo.create.mockReturnValue(topic);
      mockTopicRepo.save.mockResolvedValue(topic);
      mockParticipantRepo.create.mockReturnValue(createMockParticipant());
      mockParticipantRepo.save.mockResolvedValue(createMockParticipant());
      mockIdempotencyRepo.save.mockResolvedValue({ id: 'rec-1', actorId: 'user-1', clientRequestId: 'req-topic-001', entityType: 'topic', entityId: 'topic-idem-1' } as IdempotencyRecord);

      const result = await service.create('user-1', ActorType.HUMAN, dto);

      // 事务被调用
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      // 幂等记录被写入
      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          clientRequestId: 'req-topic-001',
          entityType: 'topic',
          entityId: 'topic-idem-1',
        }),
      );
      // 返回无 idempotentReplay 标记
      expect(result).not.toHaveProperty('idempotentReplay');
    });

    it('should return existing topic with idempotentReplay on 23505 (replay)', async () => {
      const dto = { title: 'Replay Topic', clientRequestId: 'req-topic-002' } as any;

      // Transaction 抛出 23505
      const pgError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_idempotency_actor_key',
      });
      mockDataSource.transaction.mockRejectedValueOnce(pgError);

      // idempotency record lookup
      mockIdempotencyRepo.findOne.mockResolvedValue({
        id: 'rec-2',
        actorId: 'user-1',
        clientRequestId: 'req-topic-002',
        entityType: 'topic',
        entityId: 'topic-existing-1',
      } as IdempotencyRecord);

      // findOne returns the existing topic
      const existingTopic = createMockTopic({ id: 'topic-existing-1', title: 'Existing Topic' });
      mockTopicRepo.findOne.mockResolvedValue(existingTopic);

      const result = await service.create('user-1', ActorType.HUMAN, dto);

      expect(result).toHaveProperty('idempotentReplay', true);
      expect(result.id).toBe('topic-existing-1');
    });

    it('should rethrow non-idempotency 23505 error for topic create', async () => {
      const dto = { title: 'Other Error Topic', clientRequestId: 'req-topic-003' } as any;

      const pgError = Object.assign(new Error('other unique violation'), {
        code: '23505',
        constraint: 'some_other_constraint',
      });
      mockDataSource.transaction.mockRejectedValueOnce(pgError);

      await expect(service.create('user-1', ActorType.HUMAN, dto)).rejects.toThrow('other unique violation');
    });

  });

  describe('update', () => {
    it('should update and save a topic', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockTopicRepo.save.mockResolvedValue(topic);

      const dto = { title: 'Updated Topic' };
      const result = await service.update('topic-1', dto);

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(topic.title).toBe('Updated Topic');
      expect(mockTopicRepo.save).toHaveBeenCalledWith(topic);
      expect(result).toEqual(topic);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.update('not-found', { title: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when topic is closed', async () => {
      const topic = createMockTopic({ status: TopicStatus.CLOSED });
      mockTopicRepo.findOne.mockResolvedValue(topic);

      await expect(service.update('topic-1', { title: 'X' })).rejects.toThrow(BadRequestException);
    });

    it('should throw AGENT_NOT_FOUND when invitedAgentIds contains non-existent agent', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      await expect(
        service.update('topic-1', { invitedAgentIds: ['agent-missing'] }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.update('topic-1', { invitedAgentIds: ['agent-missing'] }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.AGENT_NOT_FOUND } });
    });

    it('should not downgrade existing active/left participants when invitedAgentIds includes them', async () => {
      // review 回归：save 按 PK upsert，toAdd 不排除已有行会把 active/left 覆盖降级为 invited
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockAgentRepo.findBy.mockResolvedValue([
        { id: 'agent-active' },
        { id: 'agent-left' },
        { id: 'agent-new' },
      ] as any);
      mockParticipantRepo.find
        // 第一次调用：currentInvited（status='invited'）
        .mockResolvedValueOnce([
          {
            topicId: 'topic-1',
            participantId: 'agent-invited',
            status: ParticipantStatus.INVITED,
          } as TopicParticipant,
        ])
        // 第二次调用：existingRows（任意状态）
        .mockResolvedValueOnce([
          { participantId: 'agent-active' },
          { participantId: 'agent-left' },
          { participantId: 'agent-invited' },
        ] as TopicParticipant[]);
      mockParticipantRepo.create.mockImplementation((x) => x as TopicParticipant);
      mockParticipantRepo.save.mockResolvedValue({} as TopicParticipant);

      await service.update('topic-1', {
        invitedAgentIds: ['agent-active', 'agent-left', 'agent-new'],
      });

      // 仅 agent-new 被插入 invited 行；active/left 行不被覆盖
      expect(mockParticipantRepo.create).toHaveBeenCalledTimes(1);
      expect(mockParticipantRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          participantId: 'agent-new',
          status: ParticipantStatus.INVITED,
        }),
      );
      // agent-invited 不在新集合 → 其 invited 行被移除
      expect(mockParticipantRepo.remove).toHaveBeenCalledWith([
        expect.objectContaining({ participantId: 'agent-invited' }),
      ]);
    });
  });

  describe('remove', () => {
    it('should soft remove a topic', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockTopicRepo.softRemove.mockResolvedValue(topic);

      const result = await service.remove('topic-1');

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(mockTopicRepo.softRemove).toHaveBeenCalledWith(topic);
      expect(result).toBe(true);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('not-found')).rejects.toThrow(NotFoundException);
    });
  });

  describe('changeStatus', () => {
    it('should change topic status', async () => {
      const topic = createMockTopic({ status: TopicStatus.OPEN });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockTopicRepo.save.mockResolvedValue(topic);

      const result = await service.changeStatus('topic-1', TopicStatus.CLOSED);

      expect(topic.status).toBe(TopicStatus.CLOSED);
      expect(mockTopicRepo.save).toHaveBeenCalledWith(topic);
      expect(result).toEqual(topic);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.changeStatus('not-found', TopicStatus.CLOSED)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('join', () => {
    it('should add new participant', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      const createdParticipant = createMockParticipant({
        participantId: 'user-2',
        role: 'member',
      });
      const savedParticipant = createMockParticipant({
        participantId: 'user-2',
        role: 'member',
      });
      mockParticipantRepo.create.mockReturnValue(createdParticipant);
      mockParticipantRepo.save.mockResolvedValue(savedParticipant);

      const result = await service.join('topic-1', 'user-2', ActorType.HUMAN);

      // 新行显式写 joinedAt（DB DEFAULT NOW() 已移除，active 行必须由应用写入）
      expect(mockParticipantRepo.create).toHaveBeenCalledWith({
        topicId: 'topic-1',
        participantId: 'user-2',
        participantType: 'human',
        role: 'member',
        status: ParticipantStatus.ACTIVE,
        joinedAt: expect.any(Date),
      });
      expect(result).toEqual({
        topicId: 'topic-1',
        participantId: 'user-2',
        joinedAt: savedParticipant.joinedAt,
      });
    });

    it('should reactivate existing participant', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      // left 行带历史 joinedAt（旧激活时间）
      const oldJoinedAt = new Date('2024-01-01T00:00:00Z');
      const existingParticipant = createMockParticipant({
        participantId: 'user-2',
        status: 'left',
        leftAt: new Date(),
        joinedAt: oldJoinedAt,
      });
      mockParticipantRepo.findOne.mockResolvedValue(existingParticipant);
      mockParticipantRepo.save.mockResolvedValue(existingParticipant);

      const result = await service.join('topic-1', 'user-2', ActorType.HUMAN);

      expect(existingParticipant.status).toBe('active');
      expect(existingParticipant.leftAt).toBeNull();
      // re-join 语义：joinedAt 刷新为本次激活时间（不再是 left 前的旧值）
      expect(existingParticipant.joinedAt).toBeInstanceOf(Date);
      expect(existingParticipant.joinedAt!.getTime()).toBeGreaterThan(oldJoinedAt.getTime());
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ joinedAt: existingParticipant.joinedAt }),
      );
      expect(result).toEqual({
        topicId: 'topic-1',
        participantId: 'user-2',
        joinedAt: existingParticipant.joinedAt,
      });
    });

    it('should refresh joinedAt when invited participant joins', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      // invited 行 joined_at 应为 NULL（v1.40 语义：受邀时不记录加入时间）
      const invitedParticipant = createMockParticipant({
        participantId: 'agent-2',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.INVITED,
        joinedAt: null,
      });
      mockParticipantRepo.findOne.mockResolvedValue(invitedParticipant);
      mockParticipantRepo.save.mockResolvedValue(invitedParticipant);

      await service.join('topic-1', 'agent-2', ActorType.AGENT);

      expect(invitedParticipant.status).toBe(ParticipantStatus.ACTIVE);
      // 激活时写入 joinedAt
      expect(invitedParticipant.joinedAt).toBeInstanceOf(Date);
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ joinedAt: expect.any(Date) }),
      );
    });

    it('should throw BadRequestException when topic is closed', async () => {
      const topic = createMockTopic({ status: TopicStatus.CLOSED });
      mockTopicRepo.findOne.mockResolvedValue(topic);

      await expect(service.join('topic-1', 'user-2', ActorType.HUMAN)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.join('not-found', 'user-2', ActorType.HUMAN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('leave', () => {
    it('should mark participant as inactive', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const participant = createMockParticipant({ participantId: 'user-2' });
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockParticipantRepo.save.mockResolvedValue(participant);

      const result = await service.leave('topic-1', 'user-2', ActorType.HUMAN);

      expect(participant.status).toBe('left');
      expect(participant.leftAt).toBeInstanceOf(Date);
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(participant);
      expect(result).toEqual({
        topicId: 'topic-1',
        participantId: 'user-2',
        leftAt: participant.leftAt,
      });
    });

    it('should throw ForbiddenException when participant not in topic', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      await expect(service.leave('topic-1', 'user-2', ActorType.HUMAN)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.leave('not-found', 'user-2', ActorType.HUMAN)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getMessages', () => {
    it('should return messages with sender info and pagination', async () => {
      const msg1 = createMockMessage({
        id: 'msg-1',
        senderId: 'user-1',
        senderType: ActorType.HUMAN,
      });
      const msg2 = createMockMessage({
        id: 'msg-2',
        senderId: 'agent-1',
        senderType: ActorType.AGENT,
      });
      // mock DESC 排序结果 [msg-2, msg-1]，reverse 后 [msg-1, msg-2]
      const qbMock = createMockQueryBuilder([msg2, msg1], 2);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: 'https://example.com/alice.png' } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([
        { id: 'agent-1', name: 'Bot-1', avatarUrl: 'https://example.com/bot.png' } as Agent,
      ]);

      const result = await service.getMessages('topic-1', { limit: 20 });

      expect(mockMessageRepo.createQueryBuilder).toHaveBeenCalledWith('message');
      expect(qbMock.where).toHaveBeenCalledWith('message.topic_id = :topicId', {
        topicId: 'topic-1',
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith('message.deleted_at IS NULL');
      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'DESC');
      expect(qbMock.take).toHaveBeenCalledWith(20);
      expect(mockUserRepo.findBy).toHaveBeenCalledWith(
        expect.objectContaining({ id: In(['user-1']) }),
      );
      expect(mockAgentRepo.findBy).toHaveBeenCalledWith(
        expect.objectContaining({ id: In(['agent-1']) }),
      );

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toMatchObject({
        id: 'msg-1',
        senderType: 'human',
        senderName: 'Alice',
        senderAvatar: 'https://example.com/alice.png',
        type: 'chat',
      });
      expect(result.messages[1]).toMatchObject({
        id: 'msg-2',
        senderType: 'agent',
        senderName: 'Bot-1',
        senderAvatar: 'https://example.com/bot.png',
        type: 'chat',
      });
      expect(result.nextCursor).toBe('msg-1');
      expect(result.hasMore).toBe(false);
    });

    it('should handle empty results', async () => {
      const qbMock = createMockQueryBuilder([], 0);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      const result = await service.getMessages('topic-1', { limit: 20 });

      expect(result.messages).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });

    it('should apply after cursor filter', async () => {
      const afterId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      mockMessageRepo.findOne.mockResolvedValue(
        createMockMessage({ id: afterId }),
      );

      const msg2 = createMockMessage({ id: 'msg-2', content: 'After message' });
      const qbMock = createMockQueryBuilder([msg2], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { after: afterId, limit: 20 });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: afterId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) > (SELECT am.created_at, am.id FROM messages am WHERE am.id = :afterId)',
        { afterId },
      );
      expect(result.messages).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it('should map system sender to System name and no avatar', async () => {
      const msgSys = createMockMessage({
        id: 'msg-sys',
        senderId: 'system',
        senderType: ActorType.SYSTEM,
      });
      const qbMock = createMockQueryBuilder([msgSys], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { limit: 20 });

      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'DESC');
      expect(result.messages[0]).toMatchObject({
        senderType: 'system',
        senderName: 'System',
        senderAvatar: null,
      });
    });

    it('should ignore deprecated senderType query param and filter only by senderId', async () => {
      const msg = createMockMessage({ id: 'msg-1', senderId: 'user-1', senderType: ActorType.HUMAN });
      const qbMock = createMockQueryBuilder([msg], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      await service.getMessages('topic-1', {
        senderId: 'user-1',
        senderType: 'agent',
      } as unknown as Parameters<typeof service.getMessages>[1]);

      expect(qbMock.andWhere).toHaveBeenCalledWith('message.sender_id = :senderId', {
        senderId: 'user-1',
      });
      expect(qbMock.andWhere).not.toHaveBeenCalledWith(
        expect.stringContaining('sender_type'),
        expect.anything(),
      );
    });

    it('should return latest messages by default (DESC then reversed)', async () => {
      const msg3 = createMockMessage({ id: 'msg-3', createdAt: new Date('2024-01-01T00:00:03Z') });
      const msg4 = createMockMessage({ id: 'msg-4', createdAt: new Date('2024-01-01T00:00:04Z') });
      const msg5 = createMockMessage({ id: 'msg-5', createdAt: new Date('2024-01-01T00:00:05Z') });

      // DESC 排序后取前 3 条 = [msg-5, msg-4, msg-3]
      const qbMock = createMockQueryBuilder([msg5, msg4, msg3], 5);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { limit: 3 });

      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'DESC');
      expect(result.messages).toHaveLength(3);
      // reverse 后应为正序 [msg-3, msg-4, msg-5]
      expect(result.messages[0].id).toBe('msg-3');
      expect(result.messages[1].id).toBe('msg-4');
      expect(result.messages[2].id).toBe('msg-5');
      // reverse 模式下 nextCursor 是最旧的消息 id
      expect(result.nextCursor).toBe('msg-3');
      expect(result.hasMore).toBe(true); // 5 > 3
    });

    it('should apply before cursor filter', async () => {
      const beforeId = '55555555-5555-5555-5555-555555555555';
      mockMessageRepo.findOne.mockResolvedValue(
        createMockMessage({ id: beforeId }),
      );

      const msg1 = createMockMessage({ id: 'msg-1', createdAt: new Date('2024-01-01T00:00:01Z') });
      const msg2 = createMockMessage({ id: 'msg-2', createdAt: new Date('2024-01-01T00:00:02Z') });

      const qbMock = createMockQueryBuilder([msg2, msg1], 4);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { before: beforeId, limit: 2 });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: beforeId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) < (SELECT am.created_at, am.id FROM messages am WHERE am.id = :beforeId)',
        { beforeId },
      );
      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'DESC');
      // reverse 后 [msg-1, msg-2]
      expect(result.messages[0].id).toBe('msg-1');
      expect(result.messages[1].id).toBe('msg-2');
      expect(result.nextCursor).toBe('msg-1');
      expect(result.hasMore).toBe(true); // 4 > 2
    });

    it('should throw NotFoundException when before message not found or belongs to another topic', async () => {
      mockMessageRepo.findOne.mockResolvedValue(null);

      const nonexistentId = '00000000-0000-0000-0000-000000000000';
      await expect(
        service.getMessages('topic-1', { before: nonexistentId, limit: 20 }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getMessages('topic-1', { before: nonexistentId, limit: 20 }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.TOPIC_MESSAGE_NOT_FOUND } });
      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: nonexistentId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
    });

    it('should apply since timestamp filter', async () => {
      const sinceDate = new Date('2024-01-01T12:00:00Z');
      const msg1 = createMockMessage({
        id: 'msg-1',
        senderId: 'user-1',
        senderType: ActorType.HUMAN,
      });
      const qbMock = createMockQueryBuilder([msg1], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', {
        since: '2024-01-01T12:00:00Z',
        limit: 20,
      });

      expect(qbMock.andWhere).toHaveBeenCalledWith('message.created_at > :sinceDate', {
        sinceDate,
      });
      expect(result.messages).toHaveLength(1);
    });

    it('should apply both after and since filters together', async () => {
      const sinceDate = new Date('2024-01-01T12:00:00Z');
      const afterId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      mockMessageRepo.findOne.mockResolvedValue(
        createMockMessage({ id: afterId }),
      );

      const msg1 = createMockMessage({
        id: 'msg-1',
        senderId: 'user-1',
        senderType: ActorType.HUMAN,
      });
      const qbMock = createMockQueryBuilder([msg1], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', {
        after: afterId,
        since: '2024-01-01T12:00:00Z',
        limit: 20,
      });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: afterId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) > (SELECT am.created_at, am.id FROM messages am WHERE am.id = :afterId)',
        { afterId },
      );
      expect(qbMock.andWhere).toHaveBeenCalledWith('message.created_at > :sinceDate', {
        sinceDate,
      });
      expect(result.messages).toHaveLength(1);
    });

    it('should ignore invalid since format', async () => {
      const msg1 = createMockMessage({
        id: 'msg-1',
        senderId: 'user-1',
        senderType: ActorType.HUMAN,
      });
      const qbMock = createMockQueryBuilder([msg1], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { since: 'not-a-date', limit: 20 });

      // since 是 invalid 日期，不应该调用 created_at > sinceDate
      const sinceCalls = qbMock.andWhere.mock.calls.filter(
        (call: unknown[]) => call[0] === 'message.created_at > :sinceDate',
      );
      expect(sinceCalls).toHaveLength(0);
      expect(result.messages).toHaveLength(1);
    });

    it('should include start message and messages after it', async () => {
      const startId = '22222222-2222-2222-2222-222222222222';
      mockMessageRepo.findOne.mockResolvedValue(
        createMockMessage({ id: startId }),
      );

      const startMsg = createMockMessage({ id: startId, createdAt: new Date('2024-01-01T00:00:02Z') });
      const afterMsg = createMockMessage({
        id: 'msg-3',
        createdAt: new Date('2024-01-01T00:00:03Z'),
      });
      const qbMock = createMockQueryBuilder([startMsg, afterMsg], 2);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { start: startId, limit: 2 });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: startId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) >= (SELECT am.created_at, am.id FROM messages am WHERE am.id = :startId)',
        { startId },
      );
      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'ASC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'ASC');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].id).toBe(startId);
      expect(result.messages[1].id).toBe('msg-3');
      expect(result.nextCursor).toBe('msg-3');
    });

    it('should return only start message when limit is 1', async () => {
      const startId = '22222222-2222-2222-2222-222222222222';
      const startMsg = createMockMessage({ id: startId, createdAt: new Date('2024-01-01T00:00:02Z') });
      mockMessageRepo.findOne.mockResolvedValue(startMsg);

      const qbMock = createMockQueryBuilder([startMsg], 1);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { start: startId, limit: 1 });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe(startId);
      expect(result.hasMore).toBe(false);
    });

    it('should throw NotFoundException when start message does not exist', async () => {
      mockMessageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getMessages('topic-1', { start: '22222222-2222-2222-2222-222222222222', limit: 20 }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getMessages('topic-1', { start: '22222222-2222-2222-2222-222222222222', limit: 20 }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.TOPIC_MESSAGE_NOT_FOUND } });
    });

    it('should throw NotFoundException when start message belongs to another topic', async () => {
      // findOne 的条件同时包含 id 与 topicId，跨 topic 时返回 null
      mockMessageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getMessages('topic-1', { start: '33333333-3333-3333-3333-333333333333', limit: 20 }),
      ).rejects.toThrow(NotFoundException);
      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: '33333333-3333-3333-3333-333333333333', topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
    });

    it('should throw BadRequestException when start and after are both provided', async () => {
      await expect(
        service.getMessages('topic-1', {
          start: '22222222-2222-2222-2222-222222222222',
          after: '11111111-1111-1111-1111-111111111111',
          limit: 20,
        }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
      expect(mockMessageRepo.findOne).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when after message not found or belongs to another topic', async () => {
      mockMessageRepo.findOne.mockResolvedValue(null);

      const nonexistentId = '00000000-0000-0000-0000-000000000000';
      await expect(
        service.getMessages('topic-1', { after: nonexistentId, limit: 20 }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getMessages('topic-1', { after: nonexistentId, limit: 20 }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.TOPIC_MESSAGE_NOT_FOUND } });
      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: nonexistentId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
    });

    it('should include end message and messages before it', async () => {
      const endId = '22222222-2222-2222-2222-222222222222';
      const endMsg = createMockMessage({ id: endId, createdAt: new Date('2024-01-01T00:00:03Z') });
      const prevMsg = createMockMessage({
        id: 'msg-1',
        createdAt: new Date('2024-01-01T00:00:01Z'),
      });
      mockMessageRepo.findOne.mockResolvedValue(endMsg);

      // reverse 模式：DESC 取 [endMsg, prevMsg]，reverse 后为正序 [prevMsg, endMsg]
      const qbMock = createMockQueryBuilder([endMsg, prevMsg], 2);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', { end: endId, limit: 2 });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: endId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) <= (SELECT am.created_at, am.id FROM messages am WHERE am.id = :endId)',
        { endId },
      );
      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'DESC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'DESC');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].id).toBe('msg-1');
      expect(result.messages[1].id).toBe(endId);
      expect(result.nextCursor).toBe('msg-1');
    });

    it('should return messages in closed interval [start, end]', async () => {
      const startId = '22222222-2222-2222-2222-222222222222';
      const endId = '33333333-3333-3333-3333-333333333333';
      const startMsg = createMockMessage({ id: startId, createdAt: new Date('2024-01-01T00:00:02Z') });
      const endMsg = createMockMessage({ id: endId, createdAt: new Date('2024-01-01T00:00:04Z') });
      const middleMsg = createMockMessage({
        id: 'msg-3',
        createdAt: new Date('2024-01-01T00:00:03Z'),
      });

      mockMessageRepo.findOne
        .mockResolvedValueOnce(startMsg)
        .mockResolvedValueOnce(endMsg);

      const qbMock = createMockQueryBuilder([startMsg, middleMsg, endMsg], 3);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getMessages('topic-1', {
        start: startId,
        end: endId,
        limit: 10,
      });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: startId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: endId, topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) >= (SELECT am.created_at, am.id FROM messages am WHERE am.id = :startId)',
        { startId },
      );
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(message.created_at, message.id) <= (SELECT am.created_at, am.id FROM messages am WHERE am.id = :endId)',
        { endId },
      );
      expect(qbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'ASC');
      expect(qbMock.addOrderBy).toHaveBeenCalledWith('message.id', 'ASC');
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].id).toBe(startId);
      expect(result.messages[2].id).toBe(endId);
    });

    it('should throw NotFoundException when end message does not exist', async () => {
      mockMessageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getMessages('topic-1', { end: '22222222-2222-2222-2222-222222222222', limit: 20 }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getMessages('topic-1', { end: '22222222-2222-2222-2222-222222222222', limit: 20 }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.TOPIC_MESSAGE_NOT_FOUND } });
    });

    it('should throw NotFoundException when end message belongs to another topic', async () => {
      mockMessageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getMessages('topic-1', { end: '33333333-3333-3333-3333-333333333333', limit: 20 }),
      ).rejects.toThrow(NotFoundException);
      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: '33333333-3333-3333-3333-333333333333', topicId: 'topic-1' },
        select: ['createdAt', 'id'],
      });
    });

    it('should throw BadRequestException when end and before are both provided', async () => {
      await expect(
        service.getMessages('topic-1', {
          end: '22222222-2222-2222-2222-222222222222',
          before: '11111111-1111-1111-1111-111111111111',
          limit: 20,
        }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
      expect(mockMessageRepo.findOne).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when start date is later than end date', async () => {
      const startId = '22222222-2222-2222-2222-222222222222';
      const endId = '33333333-3333-3333-3333-333333333333';
      mockMessageRepo.findOne
        .mockResolvedValueOnce(createMockMessage({ id: startId, createdAt: new Date('2024-01-01T00:00:05Z') }))
        .mockResolvedValueOnce(createMockMessage({ id: endId, createdAt: new Date('2024-01-01T00:00:02Z') }));

      await expect(
        service.getMessages('topic-1', { start: startId, end: endId, limit: 20 }),
      ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });
    });
  });

  describe('sendMessage', () => {
    it('should create and save a message', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      const dto = { content: 'Hello' };
      const createdMessage = createMockMessage(dto);
      const savedMessage = createMockMessage(dto);
      mockMessageRepo.create.mockReturnValue(createdMessage);
      mockMessageRepo.save.mockResolvedValue(savedMessage);
      mockUserRepo.findOne.mockResolvedValue({
        id: 'user-1',
        displayName: 'Test User',
        avatarUrl: null,
      } as unknown as User);

      const result = await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, dto);

      expect(mockMessageRepo.create).toHaveBeenCalledWith({
        topicId: 'topic-1',
        senderId: 'user-1',
        senderType: 'human',
        type: 'chat',
        content: dto.content,
        replyToId: null,
        metadata: {},
      });
      expect(mockMessageRepo.save).toHaveBeenCalledWith(createdMessage);
      // topic 统计由 DB trigger trg_topics_message_stats 维护，应用层不写
      expect(mockTopicRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: savedMessage.id,
        topicId: savedMessage.topicId,
        senderId: savedMessage.senderId,
        senderType: 'human',
        senderName: 'Test User',
        senderAvatar: null,
        content: savedMessage.content,
        replyTo: savedMessage.replyToId,
        type: savedMessage.type,
        createdAt: savedMessage.createdAt,
      });
    });

    it('should derive sender info for an agent sender', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      const dto = { content: 'Agent report' };
      const messageBase = {
        senderId: 'agent-1',
        senderType: ActorType.AGENT,
      };
      const createdMessage = createMockMessage({ ...dto, ...messageBase });
      const savedMessage = createMockMessage({ ...dto, ...messageBase });
      mockMessageRepo.create.mockReturnValue(createdMessage);
      mockMessageRepo.save.mockResolvedValue(savedMessage);
      mockUserRepo.findOne.mockResolvedValue(null);
      mockAgentRepo.findOne.mockResolvedValue({
        id: 'agent-1',
        name: 'Agent One',
        avatarUrl: 'https://example.com/agent.png',
      } as unknown as Agent);

      const result = await service.sendMessage('topic-1', 'agent-1', ActorType.AGENT, dto);

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderId: 'agent-1',
          senderType: 'agent',
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          senderId: 'agent-1',
          senderType: 'agent',
          senderName: 'Agent One',
          senderAvatar: 'https://example.com/agent.png',
        }),
      );
      expect(mockAgentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-1',
          lastActiveAt: expect.any(Date),
        }),
      );
      // topic 统计由 DB trigger 维护，应用层不写
      expect(mockTopicRepo.save).not.toHaveBeenCalled();
    });

    it('should not update lastActiveAt when human sends a message', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      const dto = { content: 'Hello from human' };
      const createdMessage = createMockMessage({ content: dto.content, senderId: 'user-1', senderType: ActorType.HUMAN });
      const savedMessage = createMockMessage({ content: dto.content, senderId: 'user-1', senderType: ActorType.HUMAN });
      mockMessageRepo.create.mockReturnValue(createdMessage);
      mockMessageRepo.save.mockResolvedValue(savedMessage);
      mockUserRepo.findOne.mockResolvedValue({
        id: 'user-1',
        displayName: 'Human User',
        avatarUrl: null,
      } as unknown as User);

      await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, dto);

      expect(mockAgentRepo.findOne).not.toHaveBeenCalled();
      expect(mockAgentRepo.save).not.toHaveBeenCalled();
      // topic 统计由 DB trigger 维护，应用层不写
      expect(mockTopicRepo.save).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when topic is closed', async () => {
      const topic = createMockTopic({ status: TopicStatus.CLOSED });
      mockTopicRepo.findOne.mockResolvedValue(topic);

      await expect(
        service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when topic is paused', async () => {
      const topic = createMockTopic({ status: TopicStatus.PAUSED });
      mockTopicRepo.findOne.mockResolvedValue(topic);

      await expect(
        service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(
        service.sendMessage('not-found', 'user-1', ActorType.HUMAN, { content: 'Hello' }),
      ).rejects.toThrow(NotFoundException);
    });

    // ── PRIVATE topic 硬校验（v1.37：admin / owner 代理放行，普通人仍 403） ──

    it('should throw ForbiddenException when non-participant sends to private topic', async () => {
      const topic = createMockTopic({ settings: { visibility: Visibility.PRIVATE } });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      await expect(
        service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello' }),
      ).rejects.toThrow(ForbiddenException);
      // 普通人：owner 代理判定为 false，仍拒绝
      expect(mockOwnerProxy.isOwnerProxy).toHaveBeenCalledWith('user-1', {
        id: 'user-1',
        type: ActorType.HUMAN,
      });
    });

    it('should allow admin to send to private topic without joining (v1.37 behavior change)', async () => {
      const topic = createMockTopic({ settings: { visibility: Visibility.PRIVATE } });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);
      const savedMsg = createMockMessage({ id: 'msg-admin', content: 'Admin message' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Admin' } as User);

      const result = await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Admin message' }, UserRole.ADMIN);

      expect(result).toEqual(expect.objectContaining({ id: 'msg-admin' }));
      // admin 放行：不触发 owner 代理查询（短路）
      expect(mockOwnerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('should allow owner human to send to agent-created private topic (owner proxy)', async () => {
      const topic = createMockTopic({
        creatorId: 'agent-1',
        creatorType: ActorType.AGENT,
        settings: { visibility: Visibility.PRIVATE },
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);
      mockOwnerProxy.isOwnerProxy.mockResolvedValue(true);
      const savedMsg = createMockMessage({ id: 'msg-owner', content: 'Owner message' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Owner' } as User);

      const result = await service.sendMessage('topic-1', 'owner-1', ActorType.HUMAN, { content: 'Owner message' });

      expect(result).toEqual(expect.objectContaining({ id: 'msg-owner' }));
      expect(mockOwnerProxy.isOwnerProxy).toHaveBeenCalledWith('agent-1', {
        id: 'owner-1',
        type: ActorType.HUMAN,
      });
    });

    it('should reject non-owner human sending to agent-created private topic', async () => {
      const topic = createMockTopic({
        creatorId: 'agent-1',
        creatorType: ActorType.AGENT,
        settings: { visibility: Visibility.PRIVATE },
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);
      mockOwnerProxy.isOwnerProxy.mockResolvedValue(false);

      await expect(
        service.sendMessage('topic-1', 'stranger-1', ActorType.HUMAN, { content: 'Hello' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject agent sending to private topic it does not participate in', async () => {
      const topic = createMockTopic({ settings: { visibility: Visibility.PRIVATE } });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      await expect(
        service.sendMessage('topic-1', 'agent-1', ActorType.AGENT, { content: 'Hello' }),
      ).rejects.toThrow(ForbiddenException);
      // agent actor：owner 代理判定不触发（性能短路）
      expect(mockOwnerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    it('should allow active participant to send to private topic', async () => {
      const topic = createMockTopic({ settings: { visibility: Visibility.PRIVATE } });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(
        createMockParticipant({ participantId: 'user-1' }),
      );
      const savedMsg = createMockMessage({ id: 'msg-participant', content: 'Hi' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Member' } as User);

      const result = await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hi' });

      expect(result).toEqual(expect.objectContaining({ id: 'msg-participant' }));
      expect(mockOwnerProxy.isOwnerProxy).not.toHaveBeenCalled();
    });

    // ── Idempotency: clientRequestId ──

    it('should send message normally when clientRequestId is not provided (zero overhead)', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const savedMsg = createMockMessage({ id: 'msg-1', content: 'Hello' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Alice' } as User);

      await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello' });

      // 事务不应被调用（无 clientRequestId）
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
      // topic 统计由 DB trigger 维护，应用层不写
      expect(mockTopicRepo.save).not.toHaveBeenCalled();
    });

    it('should auto-join via atomic conditional upsert SQL without overwriting role (non-key path)', async () => {
      // v1.40：sendMessage 自动 join 改用原生 SQL 原子条件 upsert——
      // 禁止 find/save（并发首消息/幂等重试 PK 冲突 23505）；
      // role 不出现在 SET 子句（moderator 不被降级）；
      // status/joined_at 仅对 invited/left 行激活刷新（active 行保持原值）。
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const savedMsg = createMockMessage({ id: 'msg-1', content: 'Hello' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Alice' } as User);

      await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello' });

      expect(mockParticipantRepo.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockParticipantRepo.query.mock.calls[0];
      // 原子 upsert + 条件更新
      expect(sql).toContain('INSERT INTO topic_participants');
      expect(sql).toContain('ON CONFLICT (topic_id, participant_id) DO UPDATE');
      expect(sql).toContain('CASE WHEN topic_participants.status IN');
      // SET 子句中不得出现 role（moderator 不被降级为 member）
      expect(sql).not.toContain('SET role');
      expect(sql).not.toMatch(/role\s*=/);
      // 参数 = (topicId, senderId)
      expect(params).toEqual(['topic-1', 'user-1']);
    });

    it('should auto-join via atomic conditional upsert SQL inside idempotency transaction', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const savedMsg = createMockMessage({ id: 'msg-idem-sql', content: 'Hello' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockIdempotencyRepo.save.mockResolvedValue({ id: 'rec-sql' } as IdempotencyRecord);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Alice' } as User);

      await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, {
        content: 'Hello',
        clientRequestId: 'req-msg-sql',
      });

      // 事务路径同样走原生 SQL（manager.query），不做 TypeORM upsert
      expect(mockEntityManager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockEntityManager.query.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (topic_id, participant_id) DO UPDATE');
      expect(sql).not.toMatch(/role\s*=/);
      expect(params).toEqual(['topic-1', 'user-1']);
    });

    it('should send message with idempotency key and write idempotency record', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const savedMsg = createMockMessage({ id: 'msg-idem-1', content: 'Hello' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockIdempotencyRepo.save.mockResolvedValue({ id: 'rec-1', actorId: 'user-1', clientRequestId: 'req-msg-001', entityType: 'message', entityId: 'msg-idem-1' } as IdempotencyRecord);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Alice' } as User);

      const result = await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello', clientRequestId: 'req-msg-001' });

      // 事务被调用
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
      // 幂等记录被写入
      expect(mockIdempotencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user-1',
          clientRequestId: 'req-msg-001',
          entityType: 'message',
          entityId: 'msg-idem-1',
        }),
      );
      // 返回无 idempotentReplay 标记
      expect(result).not.toHaveProperty('idempotentReplay');
    });

    it('should normalize senderType to actorType in idempotent path (consistent with non-key path)', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const savedMsg = createMockMessage({ id: 'msg-idem-9', content: 'Hello' });
      mockMessageRepo.create.mockReturnValue(savedMsg);
      mockMessageRepo.save.mockResolvedValue(savedMsg);
      mockIdempotencyRepo.save.mockResolvedValue({ id: 'rec-9' } as IdempotencyRecord);
      mockAgentRepo.findOne.mockResolvedValue({ name: 'Bot' } as Agent);

      // 传入未归一化的 SYSTEM：写库值必须与无 key 路径一致（归一化为 AGENT）
      await service.sendMessage('topic-1', 'agent-1', ActorType.SYSTEM, { content: 'Hello', clientRequestId: 'req-msg-009' });

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ senderType: ActorType.AGENT }),
      );
    });

    it('should return existing message with idempotentReplay on 23505 (replay)', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      // Transaction 抛出 23505
      const pgError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_idempotency_actor_key',
      });
      mockDataSource.transaction.mockRejectedValueOnce(pgError);

      // idempotency record lookup
      mockIdempotencyRepo.findOne.mockResolvedValue({
        id: 'rec-2',
        actorId: 'user-1',
        clientRequestId: 'req-msg-002',
        entityType: 'message',
        entityId: 'msg-existing-1',
      } as IdempotencyRecord);

      // findOne returns existing message
      const existingMsg = createMockMessage({ id: 'msg-existing-1', content: 'Existing', senderId: 'user-1' });
      mockMessageRepo.findOne.mockResolvedValue(existingMsg);
      mockUserRepo.findOne.mockResolvedValue({ displayName: 'Alice' } as User);

      const result = await service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello', clientRequestId: 'req-msg-002' });

      expect(result).toHaveProperty('idempotentReplay', true);
      expect(result.id).toBe('msg-existing-1');
    });

    it('should rethrow non-idempotency 23505 error for sendMessage', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      const pgError = Object.assign(new Error('other unique violation'), {
        code: '23505',
        constraint: 'some_other_constraint',
      });
      mockDataSource.transaction.mockRejectedValueOnce(pgError);

      await expect(
        service.sendMessage('topic-1', 'user-1', ActorType.HUMAN, { content: 'Hello', clientRequestId: 'req-msg-003' }),
      ).rejects.toThrow('other unique violation');
    });

  });

  describe('getUnread', () => {
    it('should return total message count when no participant record exists', async () => {
      const topic = createMockTopic({ messageCount: 15 });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      // fetchUnreadMessages — 无锚点从话题开头取，返回 15 条消息
      const msgs = Array.from({ length: 15 }, (_, i) =>
        createMockMessage({ id: `msg-${i + 1}`, senderId: 'user-1', senderType: ActorType.HUMAN }),
      );
      const qbMock = createMockQueryBuilder(msgs, 15);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );
      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getUnread('topic-1', { limit: 20 }, 'user-1', ActorType.HUMAN);

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(mockParticipantRepo.findOne).toHaveBeenCalledWith({
        where: { topicId: 'topic-1', participantId: 'user-1' },
      });
      expect(result.topicId).toBe('topic-1');
      expect(result.unreadCount).toBe(15);
      expect(result.messages).toHaveLength(15);
      expect(result.hasMore).toBe(false); // 15 messages returned, 15 unread → no more
    });

    it('should return total message count when lastReadMessageId is null', async () => {
      const topic = createMockTopic({ messageCount: 20 });
      const participant = createMockParticipant({ lastReadMessageId: null });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(participant);

      const msgs = Array.from({ length: 20 }, (_, i) =>
        createMockMessage({ id: `msg-${i + 1}`, senderId: 'user-1', senderType: ActorType.HUMAN }),
      );
      const qbMock = createMockQueryBuilder(msgs, 20);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        qbMock as unknown as SelectQueryBuilder<Message>,
      );
      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getUnread('topic-1', { limit: 20 }, 'user-1');

      expect(result.unreadCount).toBe(20);
      expect(result.messages).toHaveLength(20);
      expect(result.hasMore).toBe(false);
    });

    it('should return unread count based on lastReadMessageId', async () => {
      const topic = createMockTopic({ messageCount: 30 });
      const participant = createMockParticipant({ lastReadMessageId: 'msg-5' });
      const lastReadMessage = createMockMessage({
        id: 'msg-5',
        createdAt: new Date('2024-01-01T10:00:00Z'),
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockMessageRepo.findOne.mockResolvedValue(lastReadMessage);

      // First createQueryBuilder: count QB (returns 7)
      const countQbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(7),
      };
      // Second createQueryBuilder: fetch QB (returns empty)
      const fetchMsgs = [
        createMockMessage({ id: 'msg-6', senderId: 'user-1', senderType: ActorType.HUMAN }),
      ];
      const fetchQbMock = createMockQueryBuilder(fetchMsgs as Message[], 1);
      mockMessageRepo.createQueryBuilder
        .mockReturnValueOnce(countQbMock as unknown as SelectQueryBuilder<Message>)
        .mockReturnValueOnce(fetchQbMock as unknown as SelectQueryBuilder<Message>);

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getUnread('topic-1', { limit: 20 }, 'user-1', ActorType.HUMAN);

      expect(mockParticipantRepo.findOne).toHaveBeenCalledWith({
        where: { topicId: 'topic-1', participantId: 'user-1' },
      });
      expect(result.topicId).toBe('topic-1');
      expect(result.unreadCount).toBe(7);
      expect(result.lastReadMessageId).toBe('msg-5');
      expect(result.hasMore).toBe(true); // 7 unread, only 1 returned

      // count QB uses tie-break after predicate (subquery row comparison)
      expect(countQbMock.andWhere).toHaveBeenCalledWith(
        '(msg.created_at, msg.id) > (SELECT rm.created_at, rm.id FROM messages rm WHERE rm.id = :lastReadId)',
        { lastReadId: 'msg-5' },
      );
    });

    it('should return total message count when actorId is not provided', async () => {
      const topic = createMockTopic({ messageCount: 10 });
      mockTopicRepo.findOne.mockResolvedValue(topic);

      const result = await service.getUnread('topic-1', { limit: 20 });

      expect(result.topicId).toBe('topic-1');
      expect(result.unreadCount).toBe(10);
      expect(result.hasMore).toBe(false);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getUnread('not-found', { limit: 20 }, 'user-1', ActorType.HUMAN),
      ).rejects.toThrow(NotFoundException);
    });

    it('should use tie-break predicate (created_at, id) for count', async () => {
      const topic = createMockTopic({ messageCount: 30 });
      const participant = createMockParticipant({ lastReadMessageId: 'msg-5' });
      const lastReadMessage = createMockMessage({
        id: 'msg-5',
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockMessageRepo.findOne.mockResolvedValue(lastReadMessage);

      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(3),
      };
      // fetchUnreadMessages uses a separate QB
      const fetchQbMock = createMockQueryBuilder([], 0);
      mockMessageRepo.createQueryBuilder
        .mockReturnValueOnce(qbMock as unknown as SelectQueryBuilder<Message>)
        .mockReturnValueOnce(fetchQbMock as unknown as SelectQueryBuilder<Message>);

      await service.getUnread('topic-1', { limit: 20 }, 'user-1', ActorType.HUMAN);

      // count QB: tie-break after predicate (subquery row comparison)
      expect(qbMock.andWhere).toHaveBeenCalledWith(
        '(msg.created_at, msg.id) > (SELECT rm.created_at, rm.id FROM messages rm WHERE rm.id = :lastReadId)',
        { lastReadId: 'msg-5' },
      );
    });

    it('should return messages from beginning when no anchor', async () => {
      const topic = createMockTopic({ messageCount: 5 });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      const msg1 = createMockMessage({ id: 'msg-1', senderId: 'user-1', senderType: ActorType.HUMAN });
      const msg2 = createMockMessage({ id: 'msg-2', senderId: 'agent-1', senderType: ActorType.AGENT });
      const fetchQbMock = createMockQueryBuilder([msg1, msg2], 2);
      mockMessageRepo.createQueryBuilder.mockReturnValue(
        fetchQbMock as unknown as SelectQueryBuilder<Message>,
      );

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([
        { id: 'agent-1', name: 'Bot', avatarUrl: null } as Agent,
      ]);

      const result = await service.getUnread('topic-1', { limit: 10 }, 'user-1', ActorType.HUMAN);

      expect(result.unreadCount).toBe(5);
      expect(result.messages).toHaveLength(2);
      expect(result.hasMore).toBe(true); // 5 > 2
      expect(result.messages[0].senderName).toBe('Alice');
      expect(result.messages[1].senderName).toBe('Bot');
      // fetchUnreadMessages: ASC + ASC order
      expect(fetchQbMock.orderBy).toHaveBeenCalledWith('message.createdAt', 'ASC');
    });

    it('should return hasMore=true when unreadCount > messages.length', async () => {
      const topic = createMockTopic({ messageCount: 100 });
      const participant = createMockParticipant({ lastReadMessageId: 'msg-50' });
      const lastReadMessage = createMockMessage({
        id: 'msg-50',
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockMessageRepo.findOne.mockResolvedValue(lastReadMessage);

      // count QB
      const countQbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(80),
      };
      // fetch QB returns only 5 messages (limit)
      const msgs = Array.from({ length: 5 }, (_, i) =>
        createMockMessage({ id: `msg-${i + 51}`, senderId: 'user-1', senderType: ActorType.HUMAN }),
      );
      const fetchQbMock = createMockQueryBuilder(msgs, 5);
      mockMessageRepo.createQueryBuilder
        .mockReturnValueOnce(countQbMock as unknown as SelectQueryBuilder<Message>)
        .mockReturnValueOnce(fetchQbMock as unknown as SelectQueryBuilder<Message>);

      mockUserRepo.findBy.mockResolvedValue([
        { id: 'user-1', displayName: 'Alice', avatarUrl: null } as User,
      ]);
      mockAgentRepo.findBy.mockResolvedValue([]);

      const result = await service.getUnread('topic-1', { limit: 5 }, 'user-1', ActorType.HUMAN);

      expect(result.unreadCount).toBe(80);
      expect(result.messages).toHaveLength(5);
      expect(result.hasMore).toBe(true);
    });

    it('should default limit to 20 when not provided', async () => {
      const topic = createMockTopic({ messageCount: 30 });
      const participant = createMockParticipant({ lastReadMessageId: 'msg-5' });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockMessageRepo.findOne.mockResolvedValue(
        createMockMessage({ id: 'msg-5' }),
      );

      const countQbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(10),
      };
      const fetchQbMock = createMockQueryBuilder([], 0);
      mockMessageRepo.createQueryBuilder
        .mockReturnValueOnce(countQbMock as unknown as SelectQueryBuilder<Message>)
        .mockReturnValueOnce(fetchQbMock as unknown as SelectQueryBuilder<Message>);

      await service.getUnread('topic-1', {}, 'user-1', ActorType.HUMAN);

      // fetchUnreadMessages should be called with limit 20 (default)
      expect(fetchQbMock.take).toHaveBeenCalledWith(20);
    });
  });

  describe('markAsRead', () => {
    it('should mark as read with provided messageId and return advanced=true', async () => {
      const topic = createMockTopic();
      const message = createMockMessage({ id: 'msg-10' });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockMessageRepo.findOne.mockResolvedValue(message);
      // 无已有 participant 行 → insert
      mockParticipantRepo.findOne.mockResolvedValue(null);
      const savedParticipant = createMockParticipant({ lastReadMessageId: 'msg-10' });
      mockParticipantRepo.create.mockReturnValue(savedParticipant);
      mockParticipantRepo.save.mockResolvedValue(savedParticipant);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {
        messageId: 'msg-10',
      });

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'msg-10', topicId: 'topic-1' },
        select: ['id'],
      });
      expect(mockParticipantRepo.upsert).not.toHaveBeenCalled();
      expect(mockParticipantRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          topicId: 'topic-1',
          participantId: 'user-1',
          participantType: ActorType.HUMAN,
          role: 'member',
          lastReadMessageId: 'msg-10',
          // 无行时 insert ACTIVE 新行（自动 join 语义），显式写 joinedAt
          joinedAt: expect.any(Date),
        }),
      );
      expect(result).toEqual({ topicId: 'topic-1', lastReadMessageId: 'msg-10', advanced: true });
    });

    it('should auto-use latest message when messageId not provided', async () => {
      const topic = createMockTopic();
      const latestMessage = createMockMessage({ id: 'msg-99' });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockMessageRepo.findOne
        .mockResolvedValueOnce(latestMessage) // latest
        .mockResolvedValueOnce(latestMessage); // target validation
      mockParticipantRepo.findOne.mockResolvedValue(null);
      const savedParticipant = createMockParticipant({ lastReadMessageId: 'msg-99' });
      mockParticipantRepo.create.mockReturnValue(savedParticipant);
      mockParticipantRepo.save.mockResolvedValue(savedParticipant);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {});

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { topicId: 'topic-1' },
        order: { createdAt: 'DESC', id: 'DESC' as any },
      });
      expect(result).toEqual({ topicId: 'topic-1', lastReadMessageId: 'msg-99', advanced: true });
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.markAsRead('not-found', 'user-1', ActorType.HUMAN, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when message not found in topic', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne
        .mockResolvedValueOnce(topic) // findById (called in markAsRead)
        .mockResolvedValueOnce(topic); // doesn't matter
      mockMessageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, { messageId: 'nonexistent' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return null lastReadMessageId when topic has no messages', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockMessageRepo.findOne.mockResolvedValue(null);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {});

      expect(result).toEqual({ topicId: 'topic-1', lastReadMessageId: null, advanced: false });
    });

    it('should not regress cursor (advanced=false) when target is older', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      // target message: older than existing cursor
      const targetMsg = createMockMessage({
        id: 'msg-5',
        createdAt: new Date('2024-01-01T10:00:00Z'),
      });
      mockMessageRepo.findOne.mockResolvedValue(targetMsg); // target validation only

      // DB 内行值比较：新目标更旧 → newer=false
      mockMessageRepo.query.mockResolvedValue([{ newer: false }]);

      const existingParticipant = createMockParticipant({ lastReadMessageId: 'msg-10' });
      mockParticipantRepo.findOne.mockResolvedValue(existingParticipant);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {
        messageId: 'msg-5',
      });

      expect(mockMessageRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT (n.created_at, n.id) > (o.created_at, o.id) AS newer'),
        ['msg-5', 'msg-10'],
      );
      expect(mockParticipantRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        topicId: 'topic-1',
        lastReadMessageId: 'msg-10',
        advanced: false,
      });
    });

    it('should mark same message idempotent (advanced=false)', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const sameMsg = createMockMessage({
        id: 'msg-10',
        createdAt: new Date('2024-01-01T10:00:00Z'),
      });
      mockMessageRepo.findOne.mockResolvedValue(sameMsg); // target validation only

      // DB 内行值比较：同消息 → newer=false（幂等）
      mockMessageRepo.query.mockResolvedValue([{ newer: false }]);

      const existingParticipant = createMockParticipant({ lastReadMessageId: 'msg-10' });
      mockParticipantRepo.findOne.mockResolvedValue(existingParticipant);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {
        messageId: 'msg-10',
      });

      expect(mockMessageRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT (n.created_at, n.id) > (o.created_at, o.id) AS newer'),
        ['msg-10', 'msg-10'],
      );
      expect(mockParticipantRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        topicId: 'topic-1',
        lastReadMessageId: 'msg-10',
        advanced: false,
      });
    });

    it('should advance cursor (advanced=true) when target is newer', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const targetMsg = createMockMessage({
        id: 'msg-20',
        createdAt: new Date('2024-01-01T14:00:00Z'),
      });
      mockMessageRepo.findOne.mockResolvedValue(targetMsg); // target validation only

      // DB 内行值比较：新目标更新 → newer=true
      mockMessageRepo.query.mockResolvedValue([{ newer: true }]);

      const existingParticipant = createMockParticipant({ lastReadMessageId: 'msg-10' });
      mockParticipantRepo.findOne.mockResolvedValue(existingParticipant);
      mockParticipantRepo.save.mockResolvedValue(existingParticipant);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {
        messageId: 'msg-20',
      });

      expect(mockMessageRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT (n.created_at, n.id) > (o.created_at, o.id) AS newer'),
        ['msg-20', 'msg-10'],
      );
      expect(mockParticipantRepo.save).toHaveBeenCalled();
      expect(result).toEqual({
        topicId: 'topic-1',
        lastReadMessageId: 'msg-20',
        advanced: true,
      });
    });

    it('should not overwrite role/joinedAt on existing participant (upsert bug fix)', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const targetMsg = createMockMessage({
        id: 'msg-20',
        createdAt: new Date('2024-01-01T14:00:00Z'),
      });
      mockMessageRepo.findOne.mockResolvedValue(targetMsg); // target validation only

      // DB 内行值比较：新目标更新 → newer=true
      mockMessageRepo.query.mockResolvedValue([{ newer: true }]);

      // existing participant is an owner, not member
      const existingParticipant = createMockParticipant({
        lastReadMessageId: 'msg-10',
        role: 'moderator',
        joinedAt: new Date('2024-01-01T00:00:00Z'),
      });
      mockParticipantRepo.findOne.mockResolvedValue(existingParticipant);
      mockParticipantRepo.save.mockResolvedValue(existingParticipant);

      await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {
        messageId: 'msg-20',
      });

      // save should only update lastReadMessageId, not role/joinedAt
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(existingParticipant);
      expect(existingParticipant.lastReadMessageId).toBe('msg-20');
      expect(existingParticipant.role).toBe('moderator'); // unchanged
      expect(existingParticipant.joinedAt).toEqual(new Date('2024-01-01T00:00:00Z')); // unchanged
    });

    it('should use tie-break for same-created_at newer detection', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const sameDate = new Date('2024-01-01T12:00:00Z');
      // new target: msg-bbb, same date but lexicographically after
      const targetMsg = createMockMessage({ id: 'msg-bbb', createdAt: sameDate });
      mockMessageRepo.findOne.mockResolvedValue(targetMsg); // target validation only

      // DB 内行值比较：msg-bbb > msg-aaa → newer=true
      mockMessageRepo.query.mockResolvedValue([{ newer: true }]);

      const existingParticipant = createMockParticipant({ lastReadMessageId: 'msg-aaa' });
      mockParticipantRepo.findOne.mockResolvedValue(existingParticipant);
      mockParticipantRepo.save.mockResolvedValue(existingParticipant);

      const result = await service.markAsRead('topic-1', 'user-1', ActorType.HUMAN, {
        messageId: 'msg-bbb',
      });

      // msg-bbb > msg-aaa lexicographically → advanced
      expect(result).toEqual({
        topicId: 'topic-1',
        lastReadMessageId: 'msg-bbb',
        advanced: true,
      });
    });
  });

  describe('updateAgenda', () => {
    it('should update and save topic agenda', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockTopicRepo.save.mockResolvedValue(topic);

      const dto = {
        agenda: [
          { title: 'Item 1', status: 'pending' as const, order: 1 },
          { title: 'Item 2', status: 'in_progress' as const, order: 2 },
        ],
      };
      const result = await service.updateAgenda('topic-1', dto);

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(topic.agenda).toEqual(dto.agenda);
      expect(mockTopicRepo.save).toHaveBeenCalledWith(topic);
      expect(result).toEqual(topic);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.updateAgenda('not-found', { agenda: [] })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('inviteAgent', () => {
    it('should create participant with invited status', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);
      const newParticipant = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-1',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.INVITED,
      });
      mockParticipantRepo.create.mockReturnValue(newParticipant);
      mockParticipantRepo.save.mockResolvedValue(newParticipant);

      const result = await service.inviteAgent('topic-1', 'agent-1');

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(mockParticipantRepo.findOne).toHaveBeenCalledWith({
        where: {
          topicId: 'topic-1',
          participantId: 'agent-1',
        },
      });
      expect(mockParticipantRepo.create).toHaveBeenCalledWith({
        topicId: 'topic-1',
        participantId: 'agent-1',
        role: 'member',
        status: ParticipantStatus.INVITED,
      });
      expect(mockParticipantRepo.save).toHaveBeenCalled();
      expect(result).toEqual(topic);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.inviteAgent('not-found', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException when agent already invited', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(
        createMockParticipant({
          topicId: 'topic-1',
          participantId: 'agent-1',
          participantType: ActorType.AGENT,
          status: ParticipantStatus.INVITED,
        }),
      );

      await expect(service.inviteAgent('topic-1', 'agent-1')).rejects.toThrow(ConflictException);
      expect(mockParticipantRepo.create).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when agent is already an active participant', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(
        createMockParticipant({
          topicId: 'topic-1',
          participantId: 'agent-1',
          participantType: ActorType.AGENT,
          status: ParticipantStatus.ACTIVE,
        }),
      );

      await expect(service.inviteAgent('topic-1', 'agent-1')).rejects.toThrow(ConflictException);
      expect(mockParticipantRepo.create).not.toHaveBeenCalled();
    });

    it('should allow re-inviting after uninvite', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);

      // First invite: no existing participant
      const newParticipant = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-1',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.INVITED,
      });
      mockParticipantRepo.findOne.mockResolvedValue(null);
      mockParticipantRepo.create.mockReturnValue(newParticipant);
      mockParticipantRepo.save.mockResolvedValue(newParticipant);

      await service.inviteAgent('topic-1', 'agent-1');

      // Uninvite simulation: participant now has status 'left'
      const leftParticipant = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-1',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.LEFT,
      });
      mockParticipantRepo.findOne.mockResolvedValue(leftParticipant);
      mockParticipantRepo.save.mockResolvedValue(leftParticipant);

      // Re-invite: should update status from 'left' to 'invited'
      const result = await service.inviteAgent('topic-1', 'agent-1');

      expect(leftParticipant.status).toBe(ParticipantStatus.INVITED);
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(leftParticipant);
      expect(result).toEqual(topic);
    });

    it('should invite multiple agents', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const newParticipant1 = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-1',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.INVITED,
      });
      mockParticipantRepo.findOne.mockResolvedValue(null);
      mockParticipantRepo.create.mockReturnValue(newParticipant1);
      mockParticipantRepo.save.mockResolvedValue(newParticipant1);

      await service.inviteAgent('topic-1', 'agent-1');
      expect(mockParticipantRepo.create).toHaveBeenCalledWith({
        topicId: 'topic-1',
        participantId: 'agent-1',
        role: 'member',
        status: ParticipantStatus.INVITED,
      });

      const newParticipant2 = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-2',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.INVITED,
      });
      mockParticipantRepo.create.mockReturnValue(newParticipant2);

      const result = await service.inviteAgent('topic-1', 'agent-2');
      expect(mockParticipantRepo.create).toHaveBeenCalledWith({
        topicId: 'topic-1',
        participantId: 'agent-2',
        role: 'member',
        status: ParticipantStatus.INVITED,
      });
      expect(result).toEqual(topic);
    });

    it('should throw AGENT_NOT_FOUND when agent does not exist', async () => {
      const topic = createMockTopic({ settings: { invitedAgentIds: [] } });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);
      mockResourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.inviteAgent('topic-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });
  });

  describe('uninviteAgent', () => {
    it('should remove invited participant row', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const participant = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-1',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.INVITED,
      });
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockParticipantRepo.remove.mockResolvedValue(participant);

      const result = await service.uninviteAgent('topic-1', 'agent-1');

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(mockParticipantRepo.findOne).toHaveBeenCalledWith({
        where: { topicId: 'topic-1', participantId: 'agent-1' },
      });
      expect(mockParticipantRepo.remove).toHaveBeenCalledWith(participant);
      expect(result).toEqual(topic);
    });

    it('should set active participant to left status', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      const participant = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'agent-1',
        participantType: ActorType.AGENT,
        status: ParticipantStatus.ACTIVE,
      });
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockParticipantRepo.save.mockResolvedValue(participant);

      const result = await service.uninviteAgent('topic-1', 'agent-1');

      expect(participant.status).toBe(ParticipantStatus.LEFT);
      expect(participant.leftAt).toBeInstanceOf(Date);
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(participant);
      expect(result).toEqual(topic);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.uninviteAgent('not-found', 'agent-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when agent is not invited', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      await expect(service.uninviteAgent('topic-1', 'agent-2')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockParticipantRepo.remove).not.toHaveBeenCalled();
    });

    it('should throw AGENT_NOT_FOUND when agent does not exist', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockResourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND }),
      );

      await expect(service.uninviteAgent('topic-1', 'agent-missing')).rejects.toMatchObject({
        response: { code: ErrorCode.AGENT_NOT_FOUND },
      });
    });
  });

  describe('uninviteUser', () => {
    it('should set participant isActive to false and emit event', async () => {
      const topic = createMockTopic();
      const participant = createMockParticipant({
        topicId: 'topic-1',
        participantId: 'user-2',
        participantType: ActorType.HUMAN,
        status: 'active',
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(participant);
      mockParticipantRepo.save.mockResolvedValue(participant);

      const result = await service.uninviteUser('topic-1', 'user-2');

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({ where: { id: 'topic-1' } });
      expect(mockParticipantRepo.findOne).toHaveBeenCalledWith({
        where: {
          topicId: 'topic-1',
          participantId: 'user-2',
        },
      });
      expect(participant.status).toBe('left');
      expect(participant.leftAt).toBeInstanceOf(Date);
      expect(mockParticipantRepo.save).toHaveBeenCalledWith(participant);
      expect(result).toEqual({
        topicId: 'topic-1',
        participantId: 'user-2',
        leftAt: participant.leftAt,
      });
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(service.uninviteUser('not-found', 'user-2')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when user is not a participant', async () => {
      const topic = createMockTopic();
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockParticipantRepo.findOne.mockResolvedValue(null);

      await expect(service.uninviteUser('topic-1', 'user-2')).rejects.toThrow(NotFoundException);
      expect(mockParticipantRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('findOneWithParticipants', () => {
    /** Build a task QueryBuilder stub with chainable methods */
    function createTaskQb(overrides: {
      getMany?: any;
      getCount?: number;
    } = {}) {
      return {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(overrides.getMany ?? []),
        getCount: jest.fn().mockResolvedValue(overrides.getCount ?? 0),
      } as unknown as SelectQueryBuilder<Task>;
    }

    it('should return topic with participants, boards, and task counts via QB', async () => {
      const topic = createMockTopic({
        participants: [
          createMockParticipant({
            participantId: 'user-1',
            role: 'moderator',
            status: ParticipantStatus.ACTIVE,
          }),
          createMockParticipant({
            participantId: 'agent-1',
            role: 'member',
            status: ParticipantStatus.ACTIVE,
          }),
        ],
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);

      // Board mocks
      const boards = [
        { id: 'b1', name: 'Board 1', taskCount: 3 },
      ];
      mockBoardRepo.find.mockResolvedValue(boards as Board[]);
      mockBoardRepo.count.mockResolvedValue(1);

      // Task mocks via QB chain (4 createQueryBuilder calls in Promise.all)
      const task1 = { id: 't1', title: 'Task 1', status: 'todo', priority: 'p1' } as Task;
      const task2 = { id: 't2', title: 'Task 2', status: 'done', priority: 'p2' } as Task;

      // Override createQueryBuilder to return pre-configured QBs per call:
      // call 1 → tasks (getMany), call 2 → taskCount (getCount),
      // call 3 → openTaskCount (getCount), call 4 → doneTaskCount (getCount)
      const tasksQb = createTaskQb({ getMany: [task1, task2] });
      mockTaskRepo.createQueryBuilder
        .mockReturnValueOnce(tasksQb)
        .mockReturnValueOnce(createTaskQb({ getCount: 5 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 3 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 2 }));

      const result = await service.findOneWithParticipants('topic-1');

      expect(mockTopicRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'topic-1' },
        relations: ['participants'],
      });

      // Verify QB was created 4 times with correct entity
      expect(mockTaskRepo.createQueryBuilder).toHaveBeenCalledTimes(4);
      expect(mockTaskRepo.createQueryBuilder).toHaveBeenCalledWith('task');

      // 回归守卫（B-51/B-55 同类 bug）：orderBy 必须用实体属性名 createdAt 而非列名
      // created_at，否则 take+join+orderBy 触发 TypeORM 0.3.x
      // createOrderByCombinedWithSelectExpression bug（v1.24.0-dev 生产 500 教训）
      expect(tasksQb.orderBy).toHaveBeenCalledWith('task.createdAt', 'DESC');

      // Verify board queries
      expect(mockBoardRepo.find).toHaveBeenCalledWith({
        where: { topicId: 'topic-1' },
        order: { createdAt: 'DESC' },
        take: 5,
      });
      expect(mockBoardRepo.count).toHaveBeenCalledWith({
        where: { topicId: 'topic-1' },
      });

      // Response shape assertions
      expect(result.participants).toHaveLength(2);
      expect(result.participants![0]).toMatchObject({
        participantId: 'user-1',
        role: 'moderator',
        status: ParticipantStatus.ACTIVE,
      });
      expect(result.boardCount).toBe(1);
      expect(result.taskCount).toBe(5);
      expect(result.openTaskCount).toBe(3);
      expect(result.doneTaskCount).toBe(2);
      expect(result.boards).toEqual([
        { id: 'b1', name: 'Board 1', taskCount: 3 },
      ]);
      expect(result.tasks).toEqual([
        { id: 't1', title: 'Task 1', status: 'todo', priority: 'p1' },
        { id: 't2', title: 'Task 2', status: 'done', priority: 'p2' },
      ]);
    });

    it('should handle empty tasks and boards', async () => {
      const topic = createMockTopic({ participants: [] });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockBoardRepo.find.mockResolvedValue([]);
      mockBoardRepo.count.mockResolvedValue(0);

      mockTaskRepo.createQueryBuilder
        .mockReturnValueOnce(createTaskQb({ getMany: [] }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }));

      const result = await service.findOneWithParticipants('topic-1');

      expect(result.participants).toEqual([]);
      expect(result.boardCount).toBe(0);
      expect(result.taskCount).toBe(0);
      expect(result.openTaskCount).toBe(0);
      expect(result.doneTaskCount).toBe(0);
      expect(result.boards).toEqual([]);
      expect(result.tasks).toEqual([]);
    });

    it('should derive invitedAgentIds from participants with invited status', async () => {
      const topic = createMockTopic({
        participants: [
          createMockParticipant({
            participantId: 'user-1',
            status: ParticipantStatus.ACTIVE,
          }),
          createMockParticipant({
            participantId: 'agent-1',
            participantType: ActorType.AGENT,
            status: ParticipantStatus.INVITED,
          }),
          createMockParticipant({
            participantId: 'agent-2',
            participantType: ActorType.AGENT,
            status: ParticipantStatus.INVITED,
          }),
        ],
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockBoardRepo.find.mockResolvedValue([]);
      mockBoardRepo.count.mockResolvedValue(0);

      mockTaskRepo.createQueryBuilder
        .mockReturnValueOnce(createTaskQb({ getMany: [] }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }));

      const result = await service.findOneWithParticipants('topic-1');

      expect(result.invitedAgentIds).toEqual(['agent-1', 'agent-2']);
    });

    it('should throw NotFoundException when topic not found', async () => {
      mockTopicRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findOneWithParticipants('not-found'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.findOneWithParticipants('not-found'),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.TOPIC_NOT_FOUND },
      });
    });

    it('should filter out left participants from participant list', async () => {
      const topic = createMockTopic({
        participants: [
          createMockParticipant({
            participantId: 'user-1',
            status: ParticipantStatus.ACTIVE,
          }),
          createMockParticipant({
            participantId: 'user-2',
            status: ParticipantStatus.LEFT,
          }),
        ],
      });
      mockTopicRepo.findOne.mockResolvedValue(topic);
      mockBoardRepo.find.mockResolvedValue([]);
      mockBoardRepo.count.mockResolvedValue(0);

      mockTaskRepo.createQueryBuilder
        .mockReturnValueOnce(createTaskQb({ getMany: [] }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }))
        .mockReturnValueOnce(createTaskQb({ getCount: 0 }));

      const result = await service.findOneWithParticipants('topic-1');

      expect(result.participants).toHaveLength(1);
      expect(result.participants![0].participantId).toBe('user-1');
      expect(result.participants![0].status).toBe(ParticipantStatus.ACTIVE);
    });
  });

  describe('removeMessage', () => {
    it('should soft remove own message', async () => {
      const message = createMockMessage({ senderId: 'agent-1' });
      mockMessageRepo.findOne.mockResolvedValue(message);
      mockMessageRepo.softRemove.mockResolvedValue(message);

      const result = await service.removeMessage('topic-1', 'msg-1', 'agent-1');

      expect(mockMessageRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'msg-1', topicId: 'topic-1' },
      });
      expect(mockMessageRepo.softRemove).toHaveBeenCalledWith(message);
      expect(result).toEqual({ messageId: 'msg-1', deleted: true });
    });

    it('should throw NotFoundException when message not found', async () => {
      mockMessageRepo.findOne.mockResolvedValue(null);

      await expect(service.removeMessage('topic-1', 'msg-1', 'agent-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when deleting others message', async () => {
      const message = createMockMessage({ senderId: 'agent-2' });
      mockMessageRepo.findOne.mockResolvedValue(message);

      await expect(service.removeMessage('topic-1', 'msg-1', 'agent-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockMessageRepo.softRemove).not.toHaveBeenCalled();
    });
  });
});
