import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { DashboardService } from './dashboard.service';
import { User } from '../../database/entities/user.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Task } from '../../database/entities/task.entity';
import { Message } from '../../database/entities/message.entity';
import { Board } from '../../database/entities/board.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Doc } from '../../database/entities/doc.entity';
import { Actor } from '../../database/entities/actor.entity';
import { AgentStatus, TopicStatus, TaskStatus } from '@agent-chamber/shared';

function createMockRepo<T extends ObjectLiteral>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    softRemove: jest.fn(),
    count: jest.fn(),
    countBy: jest.fn(),
    manager: {
      query: jest.fn().mockResolvedValue([]),
    },
    createQueryBuilder: jest.fn(() => ({
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getCount: jest.fn(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      // 默认 resolve undefined，模拟空表 SUM 场景（service 端有 ?? '0' 兜底）
      getRawOne: jest.fn().mockResolvedValue(undefined),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockAgent(overrides: Partial<Agent> & Partial<Actor> = {}): Agent {
  const actor = new Actor();
  actor.id = overrides.id ?? 'agent-1';
  actor.createdAt = overrides.createdAt ?? new Date('2024-01-01');
  actor.avatarUrl = overrides.avatarUrl ?? null;

  const agent = new Agent();
  agent.id = overrides.id ?? 'agent-1';
  agent.actor = actor;
  agent.name = overrides.name ?? 'Test Agent';
  agent.lastActiveAt = overrides.lastActiveAt ?? null;
  return agent;
}

describe('DashboardService', () => {
  let service: DashboardService;
  let mockUserRepo: jest.Mocked<Repository<User>>;
  let mockAgentRepo: jest.Mocked<Repository<Agent>>;
  let mockTopicRepo: jest.Mocked<Repository<Topic>>;
  let mockTaskRepo: jest.Mocked<Repository<Task>>;
  let mockMessageRepo: jest.Mocked<Repository<Message>>;
  let mockBoardRepo: jest.Mocked<Repository<Board>>;
  let mockDocSpaceRepo: jest.Mocked<Repository<DocSpace>>;
  let mockDocRepo: jest.Mocked<Repository<Doc>>;

  beforeEach(async () => {
    mockUserRepo = createMockRepo<User>();
    mockAgentRepo = createMockRepo<Agent>();
    mockTopicRepo = createMockRepo<Topic>();
    mockTaskRepo = createMockRepo<Task>();
    mockMessageRepo = createMockRepo<Message>();
    mockBoardRepo = createMockRepo<Board>();
    mockDocSpaceRepo = createMockRepo<DocSpace>();
    mockDocRepo = createMockRepo<Doc>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(Topic), useValue: mockTopicRepo },
        { provide: getRepositoryToken(Task), useValue: mockTaskRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getRepositoryToken(Board), useValue: mockBoardRepo },
        { provide: getRepositoryToken(DocSpace), useValue: mockDocSpaceRepo },
        { provide: getRepositoryToken(Doc), useValue: mockDocRepo },
      ],
    }).compile();

    service = moduleRef.get<DashboardService>(DashboardService);
  });

  function createAgentQueryBuilder(agents: Agent[]) {
    const qb = {
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(agents),
    };
    return {
      qb,
      mock: jest.fn().mockReturnValue(qb),
    };
  }

  describe('stats', () => {
    it('should return aggregated stats', async () => {
      mockAgentRepo.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(5),
      } as any);
      mockTopicRepo.count.mockResolvedValueOnce(20);
      mockTopicRepo.count.mockResolvedValueOnce(8);
      mockTaskRepo.count.mockResolvedValueOnce(50);
      mockTaskRepo.count.mockResolvedValueOnce(30);
      mockMessageRepo.count.mockResolvedValueOnce(100);
      mockBoardRepo.count.mockResolvedValueOnce(3);
      // Board 冗余列 SUM 聚合：PG SUM 返回字符串，service 端 parseInt。
      // 注意 createQueryBuilder 工厂每次返回新对象，需用 mockReturnValue 固定返回同一个 QB。
      const boardQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ boardTaskCount: '15', boardCompletedTaskCount: '9' }),
      };
      mockBoardRepo.createQueryBuilder.mockReturnValue(boardQb as any);
      mockDocSpaceRepo.count.mockResolvedValueOnce(4);
      mockDocRepo.count.mockResolvedValueOnce(12);

      const result = await service.stats();

      expect(mockAgentRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(mockAgentRepo.createQueryBuilder('agent').getCount).toHaveBeenCalledTimes(2);
      expect(mockTopicRepo.count).toHaveBeenCalledTimes(2);
      expect(mockTopicRepo.count).toHaveBeenNthCalledWith(2, {
        where: { status: TopicStatus.ACTIVE },
      });
      expect(mockTaskRepo.count).toHaveBeenCalledTimes(2);
      expect(mockTaskRepo.count).toHaveBeenNthCalledWith(2, { where: { status: TaskStatus.DONE } });
      expect(result).toEqual({
        totalAgents: 10,
        activeAgents: 5,
        totalTopics: 20,
        activeTopics: 8,
        totalTasks: 50,
        completedTasks: 30,
        totalMessages: 100,
        totalBoards: 3,
        boardTaskCount: 15,
        boardCompletedTaskCount: 9,
        docSpaceCount: 4,
        docCount: 12,
      });
    });

    it('should count doc spaces and docs via repo.count (soft-delete filtered by TypeORM)', async () => {
      mockAgentRepo.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      } as any);
      mockTopicRepo.count.mockResolvedValue(0);
      mockTaskRepo.count.mockResolvedValue(0);
      mockMessageRepo.count.mockResolvedValue(0);
      mockBoardRepo.count.mockResolvedValue(0);
      mockDocSpaceRepo.count.mockResolvedValue(2);
      mockDocRepo.count.mockResolvedValue(7);

      const result = await service.stats();

      // 口径对齐现有 stats：无参 count()，软删除由 @DeleteDateColumn 自动过滤
      expect(mockDocSpaceRepo.count).toHaveBeenCalledWith();
      expect(mockDocRepo.count).toHaveBeenCalledWith();
      expect(result.docSpaceCount).toBe(2);
      expect(result.docCount).toBe(7);
      // Board SUM 聚合 raw 为空（空表/无数据）时兜底为 0，不产生 NaN
      expect(result.boardTaskCount).toBe(0);
      expect(result.boardCompletedTaskCount).toBe(0);
    });
  });

  describe('agentActivity', () => {
    it('should return top 10 agents with real message/task counts', async () => {
      const agents = [
        createMockAgent({ id: 'a1', name: 'Agent One', lastActiveAt: new Date('2024-06-01') }),
        createMockAgent({ id: 'a2', name: 'Agent Two', lastActiveAt: new Date('2024-06-02') }),
      ];
      const { mock } = createAgentQueryBuilder(agents);
      mockAgentRepo.createQueryBuilder = mock;
      (mockMessageRepo.manager.query as jest.Mock).mockResolvedValue([
        { agentId: 'a1', count: '5' },
        { agentId: 'a2', count: '3' },
      ]);
      (mockTaskRepo.manager.query as jest.Mock).mockResolvedValue([{ agentId: 'a1', count: '2' }]);

      const result = await service.agentActivity();

      expect(result).toHaveLength(2);
      const byId = new Map(result.map((item) => [item.agentId, item]));
      expect(byId.get('a1')).toMatchObject({
        agentId: 'a1',
        agentName: 'Agent One',
        messageCount: 5,
        taskCount: 2,
      });
      expect(byId.get('a2')).toMatchObject({
        agentId: 'a2',
        agentName: 'Agent Two',
        messageCount: 3,
        taskCount: 0,
      });
    });

    it('should fallback to createdAt when lastActiveAt is null', async () => {
      const agents = [createMockAgent({ id: 'a1', name: 'Agent One', lastActiveAt: null })];
      const { mock } = createAgentQueryBuilder(agents);
      mockAgentRepo.createQueryBuilder = mock;

      const result = await service.agentActivity();

      expect(result[0].lastActiveAt).toBe(agents[0].createdAt.toISOString());
    });
  });

  describe('leaderboard', () => {
    it('should return top 5 agents sorted by activityScore', async () => {
      const agents = [
        createMockAgent({ id: 'a1', name: 'Agent One' }),
        createMockAgent({ id: 'a2', name: 'Agent Two' }),
        createMockAgent({ id: 'a3', name: 'Agent Three' }),
      ];
      const { mock } = createAgentQueryBuilder(agents);
      mockAgentRepo.createQueryBuilder = mock;
      (mockMessageRepo.manager.query as jest.Mock).mockResolvedValue([
        { agentId: 'a1', count: '10' },
        { agentId: 'a2', count: '5' },
        { agentId: 'a3', count: '20' },
      ]);
      (mockTaskRepo.manager.query as jest.Mock).mockResolvedValue([
        { agentId: 'a1', count: '2' },
        { agentId: 'a2', count: '5' },
        { agentId: 'a3', count: '1' },
      ]);

      const result = await service.leaderboard();

      expect(result).toHaveLength(3);
      // a3: 20 + 1*3 = 23
      expect(result[0]).toMatchObject({
        id: 'a3',
        messageCount: 20,
        completedTaskCount: 1,
        activityScore: 23,
      });
      // a2: 5 + 5*3 = 20
      expect(result[1]).toMatchObject({
        id: 'a2',
        messageCount: 5,
        completedTaskCount: 5,
        activityScore: 20,
      });
      // a1: 10 + 2*3 = 16
      expect(result[2]).toMatchObject({
        id: 'a1',
        messageCount: 10,
        completedTaskCount: 2,
        activityScore: 16,
      });
    });

    it('should include actor avatarUrl and fall back to null when unset', async () => {
      const agents = [
        createMockAgent({ id: 'a1', name: 'Agent One', avatarUrl: '/api/v1/avatars/a1.svg' }),
        createMockAgent({ id: 'a2', name: 'Agent Two' }),
      ];
      const { mock } = createAgentQueryBuilder(agents);
      mockAgentRepo.createQueryBuilder = mock;

      const result = await service.leaderboard();

      expect(result).toHaveLength(2);
      expect(result.find((i) => i.id === 'a1')?.avatarUrl).toBe('/api/v1/avatars/a1.svg');
      expect(result.find((i) => i.id === 'a2')?.avatarUrl).toBeNull();
    });

    it('should return empty array when no agents exist', async () => {
      const { mock } = createAgentQueryBuilder([]);
      mockAgentRepo.createQueryBuilder = mock;

      const result = await service.leaderboard();

      expect(result).toEqual([]);
    });
  });

  describe('recentTopics', () => {
    it('should return top 5 recent topics ordered by updatedAt desc', async () => {
      const topics = [{ id: 't1' }, { id: 't2' }] as Topic[];
      mockTopicRepo.find.mockResolvedValue(topics);

      const result = await service.recentTopics();

      expect(mockTopicRepo.find).toHaveBeenCalledWith({
        order: { updatedAt: 'DESC' },
        take: 5,
      });
      expect(result).toEqual(topics);
    });
  });
});
