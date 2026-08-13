import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AsyncLocalStorage } from 'async_hooks';
import { AccessQueryService, ACCESS_QUERY_STORE, AccessQueryStore } from './access-query.service';
import { Topic } from '../../database/entities/topic.entity';
import { Board } from '../../database/entities/board.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { BoardMember } from '../../database/entities/board-member.entity';
import { DocSpaceMember } from '../../database/entities/doc-space-member.entity';
import { OwnerProxyService } from './owner-proxy.service';
import { ActorType, UserRole, Visibility } from '@agent-chamber/shared';
import type { UnifiedActor } from '../types/actor.types';

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
      createQueryBuilder: jest.fn(() => queryBuilder),
    },
  } as unknown as jest.Mocked<Repository<T>>;

  return { mock, queryBuilder };
}

describe('AccessQueryService', () => {
  let service: AccessQueryService;
  let mockTopicRepo: jest.Mocked<Repository<Topic>>;
  let mockBoardRepo: jest.Mocked<Repository<Board>>;
  let mockDocSpaceRepo: jest.Mocked<Repository<DocSpace>>;
  let mockParticipantRepo: jest.Mocked<Repository<TopicParticipant>>;
  let mockMemberRepo: jest.Mocked<Repository<BoardMember>>;
  let mockDocSpaceMemberRepo: jest.Mocked<Repository<DocSpaceMember>>;
  let mockOwnerProxy: jest.Mocked<OwnerProxyService>;
  let topicQb: ReturnType<typeof createMockQueryBuilder>;
  let boardQb: ReturnType<typeof createMockQueryBuilder>;
  let docSpaceQb: ReturnType<typeof createMockQueryBuilder>;
  let participantQb: ReturnType<typeof createMockQueryBuilder>;
  let memberQb: ReturnType<typeof createMockQueryBuilder>;
  let docSpaceMemberQb: ReturnType<typeof createMockQueryBuilder>;
  let store: AccessQueryStore;

  beforeEach(async () => {
    const topicRepoPair = createMockRepo<Topic>();
    mockTopicRepo = topicRepoPair.mock;
    topicQb = topicRepoPair.queryBuilder;

    const boardRepoPair = createMockRepo<Board>();
    mockBoardRepo = boardRepoPair.mock;
    boardQb = boardRepoPair.queryBuilder;

    const docSpaceRepoPair = createMockRepo<DocSpace>();
    mockDocSpaceRepo = docSpaceRepoPair.mock;
    docSpaceQb = docSpaceRepoPair.queryBuilder;

    const participantRepoPair = createMockRepo<TopicParticipant>();
    mockParticipantRepo = participantRepoPair.mock;
    participantQb = participantRepoPair.queryBuilder;

    const memberRepoPair = createMockRepo<BoardMember>();
    mockMemberRepo = memberRepoPair.mock;
    memberQb = memberRepoPair.queryBuilder;

    const docSpaceMemberRepoPair = createMockRepo<DocSpaceMember>();
    mockDocSpaceMemberRepo = docSpaceMemberRepoPair.mock;
    docSpaceMemberQb = docSpaceMemberRepoPair.queryBuilder;

    // OwnerProxy mock：默认无 owned agents（白名单 creator = 本人）
    mockOwnerProxy = {
      getOwnedAgentIds: jest.fn().mockResolvedValue([]),
      isOwnerProxy: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<OwnerProxyService>;

    store = new AsyncLocalStorage<Map<string, Promise<string[] | null>>>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AccessQueryService,
        { provide: getRepositoryToken(Topic), useValue: mockTopicRepo },
        { provide: getRepositoryToken(Board), useValue: mockBoardRepo },
        { provide: getRepositoryToken(DocSpace), useValue: mockDocSpaceRepo },
        { provide: getRepositoryToken(TopicParticipant), useValue: mockParticipantRepo },
        { provide: getRepositoryToken(BoardMember), useValue: mockMemberRepo },
        { provide: getRepositoryToken(DocSpaceMember), useValue: mockDocSpaceMemberRepo },
        { provide: ACCESS_QUERY_STORE, useValue: store },
        { provide: OwnerProxyService, useValue: mockOwnerProxy },
      ],
    }).compile();

    service = moduleRef.get<AccessQueryService>(AccessQueryService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getAccessibleTopicIds', () => {
    it('should return null for admin', async () => {
      const admin: UnifiedActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      const result = await service.getAccessibleTopicIds(admin);
      expect(result).toBeNull();
      expect(mockTopicRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return only OPEN topics for anonymous actor', async () => {
      topicQb.getRawMany.mockResolvedValueOnce([{ id: 'topic-open' }]);

      const result = await service.getAccessibleTopicIds(undefined);

      expect(result).toEqual(['topic-open']);
      expect(mockTopicRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should return OPEN + creator + accessible topics for normal actor', async () => {
      // Batch 2: invited + active via topic_participants.status (single query replaces old jsonb invited)
      topicQb.getRawMany
        .mockResolvedValueOnce([{ id: 'topic-open' }])
        .mockResolvedValueOnce([{ id: 'topic-creator' }]);
      participantQb.getRawMany.mockResolvedValueOnce([{ id: 'topic-accessible' }]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleTopicIds(actor);

      expect(result).toEqual(
        expect.arrayContaining(['topic-open', 'topic-creator', 'topic-accessible']),
      );
      expect(result).toHaveLength(3);
      expect(mockTopicRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockParticipantRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate topic ids across conditions', async () => {
      topicQb.getRawMany
        .mockResolvedValueOnce([{ id: 'topic-shared' }])
        .mockResolvedValueOnce([{ id: 'topic-shared' }]);
      participantQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleTopicIds(actor);

      expect(result).toEqual(['topic-shared']);
    });

    it('should include topics created by owned agents (owner proxy whitelist)', async () => {
      // 人类 owner 拥有 agent-1 / agent-2：其创建的私有话题进入白名单
      mockOwnerProxy.getOwnedAgentIds.mockResolvedValue(['agent-1', 'agent-2']);
      topicQb.getRawMany
        .mockResolvedValueOnce([{ id: 'topic-open' }])
        .mockResolvedValueOnce([{ id: 'topic-agent-created' }]);
      participantQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleTopicIds(actor);

      expect(result).toEqual(expect.arrayContaining(['topic-open', 'topic-agent-created']));
      expect(result).toHaveLength(2);
      // creator 查询按 IN (本人 + owned agent ids) 过滤
      expect(topicQb.setParameter).toHaveBeenCalledWith('creatorIds', [
        'user-1',
        'agent-1',
        'agent-2',
      ]);
      expect(mockOwnerProxy.getOwnedAgentIds).toHaveBeenCalledWith(actor);
    });

    it('should not query owned agent ids for agent actor', async () => {
      topicQb.getRawMany
        .mockResolvedValueOnce([{ id: 'topic-open' }])
        .mockResolvedValueOnce([{ id: 'topic-creator' }]);
      participantQb.getRawMany.mockResolvedValueOnce([]);

      const agentActor: UnifiedActor = { id: 'agent-9', type: ActorType.AGENT };
      const result = await service.getAccessibleTopicIds(agentActor);

      expect(result).toEqual(expect.arrayContaining(['topic-open', 'topic-creator']));
      // agent actor：不触发 owner 代理查询（性能短路）
      expect(mockOwnerProxy.getOwnedAgentIds).not.toHaveBeenCalled();
    });
  });

  describe('getAccessibleBoardIds', () => {
    it('should return null for admin', async () => {
      const admin: UnifiedActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      const result = await service.getAccessibleBoardIds(admin);
      expect(result).toBeNull();
      expect(mockBoardRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return only OPEN boards for anonymous actor', async () => {
      boardQb.getRawMany.mockResolvedValueOnce([{ id: 'board-open' }]);

      const result = await service.getAccessibleBoardIds(undefined);

      expect(result).toEqual(['board-open']);
      expect(mockBoardRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should return accessible boards for normal actor', async () => {
      // Batch 2: 3 sources — open boards, creator boards, member boards (via board_members)
      boardQb.getRawMany
        .mockResolvedValueOnce([{ id: 'board-open' }])
        .mockResolvedValueOnce([{ id: 'board-creator' }]);
      memberQb.getRawMany.mockResolvedValueOnce([{ id: 'board-member' }]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleBoardIds(actor);

      expect(result).toEqual(
        expect.arrayContaining(['board-open', 'board-creator', 'board-member']),
      );
      expect(result).toHaveLength(3);
      expect(mockBoardRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockMemberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should return empty when actor has no boards', async () => {
      boardQb.getRawMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      memberQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleBoardIds(actor);

      expect(result).toEqual([]);
      expect(mockBoardRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockMemberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should include boards created by owned agents (owner proxy whitelist)', async () => {
      mockOwnerProxy.getOwnedAgentIds.mockResolvedValue(['agent-1']);
      boardQb.getRawMany
        .mockResolvedValueOnce([{ id: 'board-open' }])
        .mockResolvedValueOnce([{ id: 'board-agent-created' }]);
      memberQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleBoardIds(actor);

      expect(result).toEqual(expect.arrayContaining(['board-open', 'board-agent-created']));
      expect(result).toHaveLength(2);
      expect(boardQb.setParameter).toHaveBeenCalledWith('creatorIds', ['user-1', 'agent-1']);
    });
  });

  describe('getAccessibleDocSpaceIds', () => {
    it('should return null for admin', async () => {
      const admin: UnifiedActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      const result = await service.getAccessibleDocSpaceIds(admin);
      expect(result).toBeNull();
      expect(mockDocSpaceRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should return only OPEN spaces for anonymous actor', async () => {
      docSpaceQb.getRawMany.mockResolvedValueOnce([{ id: 'space-open' }]);

      const result = await service.getAccessibleDocSpaceIds(undefined);

      expect(result).toEqual(['space-open']);
      expect(mockDocSpaceRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should return OPEN + creator + member spaces for normal actor', async () => {
      docSpaceQb.getRawMany
        .mockResolvedValueOnce([{ id: 'space-open' }])
        .mockResolvedValueOnce([{ id: 'space-creator' }]);
      docSpaceMemberQb.getRawMany.mockResolvedValueOnce([{ id: 'space-member' }]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleDocSpaceIds(actor);

      expect(result).toEqual(
        expect.arrayContaining(['space-open', 'space-creator', 'space-member']),
      );
      expect(result).toHaveLength(3);
      expect(mockDocSpaceRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockDocSpaceMemberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should return empty when actor has no spaces', async () => {
      docSpaceQb.getRawMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      docSpaceMemberQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleDocSpaceIds(actor);

      expect(result).toEqual([]);
      expect(mockDocSpaceRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockDocSpaceMemberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should include spaces created by owned agents (owner proxy whitelist)', async () => {
      mockOwnerProxy.getOwnedAgentIds.mockResolvedValue(['agent-1']);
      docSpaceQb.getRawMany
        .mockResolvedValueOnce([{ id: 'space-open' }])
        .mockResolvedValueOnce([{ id: 'space-agent-created' }]);
      docSpaceMemberQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };
      const result = await service.getAccessibleDocSpaceIds(actor);

      expect(result).toEqual(expect.arrayContaining(['space-open', 'space-agent-created']));
      expect(result).toHaveLength(2);
      expect(docSpaceQb.setParameter).toHaveBeenCalledWith('creatorIds', ['user-1', 'agent-1']);
    });
  });

  describe('request-level cache', () => {
    it('should cache topic ids within the same request context', async () => {
      topicQb.getRawMany
        .mockResolvedValueOnce([{ id: 'topic-open' }])
        .mockResolvedValueOnce([{ id: 'topic-creator' }]);
      participantQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };

      await store.run(new Map(), async () => {
        const first = await service.getAccessibleTopicIds(actor);
        const second = await service.getAccessibleTopicIds(actor);
        expect(first).toEqual(['topic-open', 'topic-creator']);
        expect(second).toEqual(['topic-open', 'topic-creator']);
      });

      // 3 parallel queries total (2 topic + 1 participant)，缓存命中后不再查 DB
      expect(mockTopicRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockParticipantRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('should cache board ids within the same request context', async () => {
      boardQb.getRawMany.mockResolvedValueOnce([{ id: 'board-open' }]).mockResolvedValueOnce([]);
      memberQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };

      await store.run(new Map(), async () => {
        const first = await service.getAccessibleBoardIds(actor);
        const second = await service.getAccessibleBoardIds(actor);
        expect(first).toEqual(['board-open']);
        expect(second).toEqual(['board-open']);
      });

      // 3 parallel queries total (2 board + 1 member)，缓存命中后不再查 DB
      expect(mockBoardRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockMemberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
    it('should cache docspace ids within the same request context', async () => {
      docSpaceQb.getRawMany.mockResolvedValueOnce([{ id: 'space-open' }]).mockResolvedValueOnce([]);
      docSpaceMemberQb.getRawMany.mockResolvedValueOnce([]);

      const actor: UnifiedActor = { id: 'user-1', type: ActorType.HUMAN };

      await store.run(new Map(), async () => {
        const first = await service.getAccessibleDocSpaceIds(actor);
        const second = await service.getAccessibleDocSpaceIds(actor);
        expect(first).toEqual(['space-open']);
        expect(second).toEqual(['space-open']);
      });

      // 3 parallel queries total (2 space + 1 member)，缓存命中后不再查 DB
      expect(mockDocSpaceRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockDocSpaceMemberRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });
});
