import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { Hash } from 'crypto';
import { SelectQueryBuilder } from 'typeorm';
import { AgentService } from './agent.service';
import { Agent } from '../../database/entities/agent.entity';
import { Actor } from '../../database/entities/actor.entity';
import { User } from '../../database/entities/user.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { RoundtableSeat } from '../../database/entities/roundtable-seat.entity';
import { AgentStatus, ActorType, AuditAction } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';

jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({ toString: jest.fn(() => 'mocked_random_string') })),
  createHash: jest.fn(() => ({
    update: jest.fn(() => ({ digest: jest.fn(() => 'mocked_hash') })),
  })),
}));

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
    update: jest.fn(),
    manager: {
      query: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((entity) => {
        if (!entity.id) {
          entity.id = 'agent-new';
        }
        return Promise.resolve(entity);
      }),
    },
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
      getCount: jest.fn(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

function createMockAgent(overrides: Partial<Agent> & Partial<Actor> = {}): Agent {
  const actor = new Actor();
  actor.id = overrides.id ?? 'agent-1';
  actor.type = ActorType.AGENT;
  actor.displayName = overrides.name ?? 'Test Agent';
  actor.avatarUrl = overrides.avatarUrl ?? null;
  actor.status = (overrides.status as string) ?? AgentStatus.ACTIVE;
  actor.createdAt = overrides.createdAt ?? new Date('2024-01-01');
  actor.updatedAt = overrides.updatedAt ?? new Date('2024-01-01');
  actor.deletedAt = overrides.deletedAt ?? null;
  if (overrides.actor) {
    Object.assign(actor, overrides.actor);
  }

  const agent = new Agent();
  agent.id = overrides.id ?? 'agent-1';
  agent.actor = actor;
  agent.ownerId = overrides.ownerId ?? 'user-1';
  agent.name = overrides.name ?? 'Test Agent';
  agent.description = overrides.description ?? null;
  agent.webhookUrl = overrides.webhookUrl ?? null;
  agent.webhookSecret = overrides.webhookSecret ?? null;
  agent.webhookEvents = overrides.webhookEvents ?? [];
  agent.webhookTimeoutMs = overrides.webhookTimeoutMs ?? 30000;
  agent.webhookRetryMax = overrides.webhookRetryMax ?? 3;
  agent.capabilities = overrides.capabilities ?? null;
  agent.systemPrompt = overrides.systemPrompt ?? null;
  agent.modelConfig = overrides.modelConfig ?? {};
  agent.rateLimit = overrides.rateLimit ?? {};
  agent.lastActiveAt = overrides.lastActiveAt ?? null;
  agent.version = overrides.version ?? null;
  agent.owner = (overrides.owner ?? null) as unknown as User;
  agent.apiKeys = [];
  agent.webhookDeliveries = [];
  return agent;
}

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-1',
    agentId: 'agent-1',
    keyHash: 'mocked_hash',
    keyPrefix: 'ask_mock',
    name: 'Default Key',
    permissions: { scopes: ['read', 'write'] },
    ipWhitelist: null,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date('2024-01-01'),
    createdBy: 'user-1',
    deletedAt: null,
    agent: null,
    creator: null,
    ...overrides,
  } as ApiKey;
}

describe('AgentService', () => {
  let service: AgentService;
  let mockAgentRepo: jest.Mocked<Repository<Agent>>;
  let mockApiKeyRepo: jest.Mocked<Repository<ApiKey>>;
  let mockSeatRepo: jest.Mocked<Repository<RoundtableSeat>>;
  let mockAuditService: { log: jest.Mock };

  beforeEach(async () => {
    // NestJS module-token-factory uses crypto.createHash to generate module tokens.
    // If createHash always returns the same value, module tokens collide and providers
    // cannot be resolved. We temporarily return unique values during compilation.
    let hashCounter = 0;
    jest.mocked(crypto.createHash).mockImplementation(
      () =>
        ({
          update: jest.fn(() => ({
            digest: jest.fn(() => `unique_hash_${++hashCounter}`),
          })),
        }) as unknown as Hash,
    );

    mockAgentRepo = createMockRepo<Agent>();
    mockApiKeyRepo = createMockRepo<ApiKey>();
    mockSeatRepo = createMockRepo<RoundtableSeat>();
    mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: getRepositoryToken(Agent), useValue: mockAgentRepo },
        { provide: getRepositoryToken(ApiKey), useValue: mockApiKeyRepo },
        { provide: getRepositoryToken(RoundtableSeat), useValue: mockSeatRepo },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = moduleRef.get<AgentService>(AgentService);

    // Restore createHash to return predictable 'mocked_hash' for service tests
    jest.mocked(crypto.createHash).mockImplementation(
      () =>
        ({
          update: jest.fn(() => ({
            digest: jest.fn(() => 'mocked_hash'),
          })),
        }) as unknown as Hash,
    );

    jest.clearAllMocks();
  });

  function createFindAllQueryBuilder(items: Agent[], total: number) {
    const getManyAndCountMock = jest.fn().mockResolvedValue([items, total]);
    const andWhereMock = jest.fn().mockReturnThis();
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: andWhereMock,
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: getManyAndCountMock,
      getMany: jest.fn(),
      getOne: jest.fn(),
    } as unknown as SelectQueryBuilder<Agent> & {
      andWhere: jest.Mock;
      getManyAndCount: jest.Mock;
    };
  }

  describe('findAll', () => {
    it('should return paginated results with default values', async () => {
      const items = [createMockAgent()];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({});

      expect(mockAgentRepo.createQueryBuilder).toHaveBeenCalledWith('agent');
      expect(qb.getManyAndCount).toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      // 列表项不含 description 大文本，仅含 descriptionSnippet
      expect(result.items[0]).not.toHaveProperty('description');
      expect(result.items[0]).toHaveProperty('descriptionSnippet');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { owner: _owner, actor: _actor, description: _desc, ...expectedItem } = items[0];
      expect(result.items[0]).toMatchObject({
        ...expectedItem,
        descriptionSnippet: null,
        topicCount: 0,
        messageCount: 0,
        ownerName: '-',
        createdAt: items[0].createdAt,
        updatedAt: items[0].updatedAt,
        lastActiveAt: items[0].lastActiveAt,
      });
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.totalPages).toBe(1);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(false);
    });

    it('should produce descriptionSnippet from agent description', async () => {
      const items = [createMockAgent({ description: 'An agent description' })];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({});
      expect(result.items[0]).not.toHaveProperty('description');
      expect(result.items[0].descriptionSnippet).toBe('An agent description');
    });

    it('should truncate long agent description to 200 characters', async () => {
      const longDesc = 'z'.repeat(300);
      const items = [createMockAgent({ description: longDesc })];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({});
      expect(result.items[0].descriptionSnippet).toHaveLength(200);
      expect(result.items[0].descriptionSnippet).toBe(longDesc.slice(0, 200));
    });

    it('should return null descriptionSnippet when agent description is null', async () => {
      const items = [createMockAgent({ description: null })];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({});
      expect(result.items[0].descriptionSnippet).toBeNull();
    });

    it('should include apiKeyPrefix from the latest active key', async () => {
      const items = [createMockAgent({ id: 'agent-1' })];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);
      (mockApiKeyRepo.manager.query as jest.Mock).mockResolvedValue([
        { agentId: 'agent-1', keyPrefix: 'ask_mock' },
      ]);

      const result = await service.findAll({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].apiKeyPrefix).toBe('ask_mock');
    });

    it('should map ownerName from owner.displayName or username', async () => {
      const ownerWithDisplay = createMockAgent({
        id: 'owner-1',
        name: 'Owner One',
      }) as unknown as User;
      const ownerWithUsername = createMockAgent({
        id: 'owner-2',
        name: 'owner2',
      }) as unknown as User;
      const items = [
        createMockAgent({
          id: 'agent-with-display',
          owner: { ...ownerWithDisplay, displayName: 'Display Owner', username: 'owner1' } as User,
        }),
        createMockAgent({
          id: 'agent-with-username',
          owner: { ...ownerWithUsername, displayName: null, username: 'owner2' } as User,
        }),
        createMockAgent({
          id: 'agent-no-owner',
          owner: null as unknown as User,
        }),
      ];
      const qb = createFindAllQueryBuilder(items, 3);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({});

      expect(result.items).toHaveLength(3);
      expect(result.items[0].ownerName).toBe('Display Owner');
      expect(result.items[1].ownerName).toBe('owner2');
      expect(result.items[2].ownerName).toBe('-');
      // 确认未返回完整 owner 嵌套对象
      expect(result.items[0]).not.toHaveProperty('owner');
    });

    it('should filter by status', async () => {
      const items = [createMockAgent({ status: AgentStatus.DISABLED })];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({ status: 'disabled' });

      expect(qb.andWhere).toHaveBeenCalledWith('actor.status = :status', { status: 'disabled' });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { owner: _owner1, actor: _actor1, description: _d1, ...expectedItem1 } = items[0];
      expect(result.items[0]).toMatchObject({
        ...expectedItem1,
        descriptionSnippet: null,
        topicCount: 0,
        messageCount: 0,
      });
    });

    it('should filter by search query q', async () => {
      const items = [createMockAgent()];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({ q: 'test' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(agent.name ILIKE :q OR agent.description ILIKE :q)',
        { q: '%test%' },
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { owner: _owner2, actor: _actor2, description: _d2, ...expectedItem2 } = items[0];
      expect(result.items[0]).toMatchObject({
        ...expectedItem2,
        descriptionSnippet: null,
        topicCount: 0,
        messageCount: 0,
      });
    });

    it('should ignore status filter when status is all', async () => {
      const items = [createMockAgent()];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ status: 'all' });

      expect(qb.andWhere).not.toHaveBeenCalledWith('actor.status = :status', expect.anything());
    });

    it('should handle empty results', async () => {
      const qb = createFindAllQueryBuilder([], 0);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({ page: 3, pageSize: 5 });

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 3,
        pageSize: 5,
        totalPages: 0,
        hasNext: false,
        hasPrev: true,
      });
    });

    it('should query topic counts via status column (guard: is_active was dropped by ConsolidateMembership)', async () => {
      // 生产事故守卫：topic_participants.is_active 列已删除，raw SQL 必须用
      // status IN ('invited','active')，否则 /agents 列表 500 column does not exist
      const items = [createMockAgent({ id: 'agent-1' })];
      const qb = createFindAllQueryBuilder(items, 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({});

      const topicCountSql = (mockAgentRepo.manager.query as jest.Mock).mock.calls[0][0] as string;
      expect(topicCountSql).toContain("tp.status IN ('invited', 'active')");
      expect(topicCountSql).not.toContain('is_active');
    });
  });

  describe('findMyTopics', () => {
    it('should return paginated topics the agent participates in', async () => {
      (mockAgentRepo.manager.query as jest.Mock)
        .mockResolvedValueOnce([{ total: '2' }])
        .mockResolvedValueOnce([
          { id: 'topic-1', title: 'T1' },
          { id: 'topic-2', title: 'T2' },
        ]);

      const result = await service.findMyTopics('agent-1', { page: 1, pageSize: 20 });

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it('should query via status column (guard: is_active was dropped by ConsolidateMembership)', async () => {
      // 生产事故守卫：/agents/me/topics 500 column tp.is_active does not exist——
      // count 与 items 两条 raw SQL 都必须用 status IN ('invited','active')
      (mockAgentRepo.manager.query as jest.Mock)
        .mockResolvedValueOnce([{ total: '0' }])
        .mockResolvedValueOnce([]);

      await service.findMyTopics('agent-1', {});

      const calls = (mockAgentRepo.manager.query as jest.Mock).mock.calls;
      expect(calls).toHaveLength(2);
      for (const [sql] of calls as Array<[string, unknown[]]>) {
        expect(sql).toContain("tp.status IN ('invited', 'active')");
        expect(sql).not.toContain('is_active');
      }
    });
  });

  describe('findDirectory', () => {
    function createDirectoryQueryBuilder(items: Agent[], total: number) {
      const getManyAndCountMock = jest.fn().mockResolvedValue([items, total]);
      const andWhereMock = jest.fn().mockReturnThis();
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: andWhereMock,
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: getManyAndCountMock,
      } as unknown as SelectQueryBuilder<Agent> & {
        andWhere: jest.Mock;
        getManyAndCount: jest.Mock;
      };
    }

    it('should return white-listed fields only', async () => {
      const agent = createMockAgent({
        id: 'agent-1',
        name: 'Public Agent',
        capabilities: ['chat'],
        status: AgentStatus.ACTIVE,
        avatarUrl: 'https://example.com/avatar.png',
      });
      const qb = createDirectoryQueryBuilder([agent], 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findDirectory({});

      expect(result.items).toHaveLength(1);
      const item = result.items[0] as Record<string, unknown>;
      // 白名单字段
      expect(item.id).toBe('agent-1');
      expect(item.name).toBe('Public Agent');
      expect(item.type).toBe('agent');
      expect(item.avatarUrl).toBe('https://example.com/avatar.png');
      expect(item.capabilities).toEqual(['chat']);
      expect(item.status).toBe('active');
      // 敏感字段不应存在
      expect(item.ownerId).toBeUndefined();
      expect(item.webhookUrl).toBeUndefined();
      expect(item.webhookSecret).toBeUndefined();
      expect(item.systemPrompt).toBeUndefined();
      expect(item.modelConfig).toBeUndefined();
      expect(item.rateLimit).toBeUndefined();
      expect(item.lastActiveAt).toBeUndefined();
      expect(item.description).toBeUndefined();
      expect(item.topicCount).toBeUndefined();
      expect(item.messageCount).toBeUndefined();
    });

    it('should select real columns only (guard: status/avatarUrl are getter proxies on actor, not agent columns)', async () => {
      // 生产事故守卫：'agent.status' 会被原样拼进 SQL 报 column does not exist——
      // status/avatarUrl 是 agent entity getter 代理到 actor 的兼容属性，QB select 必须写 'actor.xxx'
      const qb = createDirectoryQueryBuilder([], 0);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findDirectory({});

      const selectArg = (qb.select as jest.Mock).mock.calls[0][0] as string[];
      expect(selectArg).toContain('actor.status');
      expect(selectArg).toContain('actor.avatarUrl');
      expect(selectArg).not.toContain('agent.status');
      expect(selectArg).not.toContain('agent.avatarUrl');
    });

    it('should filter by q on agent name', async () => {
      const agent = createMockAgent({ name: 'Kimi' });
      const qb = createDirectoryQueryBuilder([agent], 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findDirectory({ q: 'Kimi' });

      expect(qb.andWhere).toHaveBeenCalledWith('agent.name ILIKE :q', { q: '%Kimi%' });
    });

    it('should exclude soft-deleted agents', async () => {
      const agent = createMockAgent({ id: 'agent-alive' });
      const qb = createDirectoryQueryBuilder([agent], 1);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findDirectory({});

      expect(qb.where).toHaveBeenCalledWith('actor.deleted_at IS NULL');
    });

    it('should handle pagination', async () => {
      const items = [
        createMockAgent({ id: 'agent-a', name: 'Agent A' }),
        createMockAgent({ id: 'agent-b', name: 'Agent B' }),
      ];
      const qb = createDirectoryQueryBuilder(items, 10);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findDirectory({ page: 2, pageSize: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(10);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(2);
      expect(result.totalPages).toBe(5);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(true);
    });

    it('should handle empty results', async () => {
      const qb = createDirectoryQueryBuilder([], 0);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findDirectory({ q: 'NoSuchAgent' });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should order by agent name ascending', async () => {
      const qb = createDirectoryQueryBuilder([], 0);
      mockAgentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findDirectory({});

      expect(qb.orderBy).toHaveBeenCalledWith('agent.name', 'ASC');
    });
  });

  describe('findOne', () => {
    it('should return an agent', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);

      const result = await service.findOne('agent-1');

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      expect(result).toEqual(agent);
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('not-found')).rejects.toThrow(NotFoundException);
      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'not-found' },
        relations: { actor: true },
      });
    });
  });

  describe('create', () => {
    it('should create agent and api key', async () => {
      const dto = { name: 'New Agent', description: 'Desc' };
      const savedAgent = createMockAgent({
        id: 'agent-new',
        name: 'New Agent',
        description: 'Desc',
        status: AgentStatus.ACTIVE,
      });
      const createdApiKey = createMockApiKey({ agentId: savedAgent.id });
      const savedApiKey = createMockApiKey({ agentId: savedAgent.id });

      mockAgentRepo.create.mockReturnValue(savedAgent);
      mockAgentRepo.save.mockResolvedValue(savedAgent);
      mockApiKeyRepo.create.mockReturnValue(createdApiKey);
      mockApiKeyRepo.save.mockResolvedValue(savedApiKey);

      const result = await service.create('user-1', dto);

      expect(mockAgentRepo.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ActorType.AGENT,
          displayName: dto.name,
          status: AgentStatus.ACTIVE,
        }),
      );
      expect(mockAgentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ...dto,
          ownerId: 'user-1',
          id: 'agent-new',
        }),
      );
      expect(mockAgentRepo.save).toHaveBeenCalledWith(savedAgent);
      expect(crypto.randomBytes).toHaveBeenCalledWith(24);
      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith({
        agentId: savedAgent.id,
        keyHash: 'mocked_hash',
        keyPrefix: 'ask_mock',
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: 'user-1',
      });
      expect(mockApiKeyRepo.save).toHaveBeenCalledWith(createdApiKey);
      expect(result).toEqual({ ...savedAgent, apiKey: 'ask_mocked_random_string' });
    });
  });

  describe('update', () => {
    it('should update and save an agent', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);

      const dto = { name: 'Updated Agent' };
      const result = await service.update('agent-1', dto);

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      expect(agent.name).toBe('Updated Agent');
      expect(mockAgentRepo.save).toHaveBeenCalledWith(agent);
      expect(result).toEqual(agent);
    });

    it('should clear avatarSvg when avatar is cleared or replaced with an external URL', async () => {
      // 联动清理：avatar 变更后 actors.avatar_svg 不得残留为无引用孤儿数据
      const agent = createMockAgent();
      agent.actor.avatarSvg = '<svg></svg>';
      agent.actor.avatarUrl = '/api/v1/avatars/agent-1.svg';
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);

      await service.update('agent-1', { avatar: 'https://example.com/new.png' });
      expect(agent.actor.avatarSvg).toBeNull();

      agent.actor.avatarSvg = '<svg></svg>';
      await service.update('agent-1', { avatar: null });
      expect(agent.actor.avatarUrl).toBeNull();
      expect(agent.actor.avatarSvg).toBeNull();
    });

    it('should keep avatarSvg when avatar is re-set to the same site SVG short-link', async () => {
      const agent = createMockAgent();
      agent.actor.avatarSvg = '<svg></svg>';
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);

      await service.update('agent-1', { avatar: '/api/v1/avatars/agent-1.svg' });

      expect(agent.actor.avatarSvg).toBe('<svg></svg>');
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.update('not-found', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    /**
     * 事务包裹 revoke+软删（统一批 A3-1，R15）：
     * - 事务内先批量 revoke 后软删（revoke 失败时 agent 未删可恢复）；
     * - revokedReason='agent deleted' 写入断言（resetKey 先例未设，本次新增）；
     * - revoke 失败 → 事务回滚，软删不发生。
     */
    function mockTransactionAndRevoke() {
      // manager.transaction 直接执行回调，回调收到同一 manager mock（事务内 createQueryBuilder 用 manager 的）
      (mockAgentRepo.manager as unknown as { transaction: jest.Mock }).transaction = jest.fn(
        async (cb: (m: typeof mockAgentRepo.manager) => Promise<unknown>) =>
          cb(mockAgentRepo.manager),
      );
      const revokeQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      // 事务回调内用的是 manager.createQueryBuilder()（EntityManager 快速 update 写法）
      (mockAgentRepo.manager as unknown as { createQueryBuilder: jest.Mock }).createQueryBuilder =
        jest.fn().mockReturnValue(revokeQb);
      return revokeQb;
    }

    it('should revoke keys then soft delete inside a transaction (order: revoke before soft-delete)', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);
      const revokeQb = mockTransactionAndRevoke();

      const result = await service.remove('agent-1');

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      // 事务包裹断言
      expect(mockAgentRepo.manager.transaction).toHaveBeenCalled();
      // 先 revoke 后软删（R15 顺序断言）——事务回调内 save 走 manager.save
      expect(revokeQb.execute.mock.invocationCallOrder[0]).toBeLessThan(
        (mockAgentRepo.manager.save as jest.Mock).mock.invocationCallOrder[0],
      );
      expect(agent.actor.deletedAt).toBeInstanceOf(Date);
      expect(mockAgentRepo.manager.save).toHaveBeenCalledWith(agent);
      expect(result).toBe(true);
    });

    it('should write revokedReason "agent deleted" when revoking keys', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);
      const revokeQb = mockTransactionAndRevoke();

      await service.remove('agent-1');

      // resetKey 先例只设 revokedAt，revokedReason 为 A3-1 新增（便于审计回溯删除动作）
      expect(revokeQb.set).toHaveBeenCalledWith({
        revokedAt: expect.any(Date),
        revokedReason: 'agent deleted',
      });
      expect(revokeQb.where).toHaveBeenCalledWith('agent_id = :id AND revoked_at IS NULL', {
        id: 'agent-1',
      });
    });

    it('should NOT soft delete when revoke fails (transaction rollback)', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      const revokeQb = mockTransactionAndRevoke();
      revokeQb.execute.mockRejectedValueOnce(new Error('db down'));

      await expect(service.remove('agent-1')).rejects.toThrow('db down');
      // 事务内 revoke 抛错 → 回调中断，save（软删）从未执行
      expect(mockAgentRepo.manager.save).not.toHaveBeenCalled();
      expect(agent.actor.deletedAt).toBeNull();
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('not-found')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDeletionImpact', () => {
    it('should return four counts (open tasks / messages / topics / seats)', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      // 前三个 count 走 raw SQL，依次返回 openTask / message / topic
      (mockAgentRepo.manager.query as jest.Mock)
        .mockResolvedValueOnce([{ count: '3' }])
        .mockResolvedValueOnce([{ count: '7' }])
        .mockResolvedValueOnce([{ count: '2' }]);
      // seatCount 走 queryBuilder jsonb 路径（铁律 #23）
      const seatQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(1),
      };
      mockSeatRepo.createQueryBuilder.mockReturnValue(
        seatQb as unknown as SelectQueryBuilder<RoundtableSeat>,
      );

      const result = await service.getDeletionImpact('agent-1');

      expect(result).toEqual({ openTaskCount: 3, messageCount: 7, topicCount: 2, seatCount: 1 });
      // 计数口径断言：task 排除 done/archived + 未软删；message 未软删；participant 仅 invited/active
      const sqls = (mockAgentRepo.manager.query as jest.Mock).mock.calls.map(
        (c: [string, unknown[]]) => c[0] as string,
      );
      expect(sqls[0]).toContain("status NOT IN ('done', 'archived')");
      expect(sqls[0]).toContain('deleted_at IS NULL');
      expect(sqls[1]).toContain('deleted_at IS NULL');
      expect(sqls[2]).toContain("status IN ('invited', 'active')");
      // ⚠️ jsonb 路径必须 queryBuilder config->>'bindActorId'（findOne 嵌套条件整列等值永不命中）
      expect(mockSeatRepo.createQueryBuilder).toHaveBeenCalledWith('seat');
      expect(seatQb.where).toHaveBeenCalledWith("seat.config->>'bindActorId' = :id", {
        id: 'agent-1',
      });
      expect(seatQb.andWhere).toHaveBeenCalledWith("seat.status != 'removed'");
    });

    it('should return zero counts when no traces exist', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      (mockAgentRepo.manager.query as jest.Mock).mockResolvedValue([{ count: '0' }]);
      const seatQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      };
      mockSeatRepo.createQueryBuilder.mockReturnValue(
        seatQb as unknown as SelectQueryBuilder<RoundtableSeat>,
      );

      const result = await service.getDeletionImpact('agent-1');
      expect(result).toEqual({ openTaskCount: 0, messageCount: 0, topicCount: 0, seatCount: 0 });
    });

    it('should throw NotFoundException for a soft-deleted / missing agent (findOne 404)', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.getDeletionImpact('not-found')).rejects.toThrow(NotFoundException);
      // findOne 失败即短路，不执行任何计数查询
      expect(mockAgentRepo.manager.query).not.toHaveBeenCalled();
      expect(mockSeatRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('resetKey', () => {
    it('should revoke old keys and create new key', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);

      const executeMock = jest.fn().mockResolvedValue(undefined);
      mockApiKeyRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: executeMock,
      } as unknown as SelectQueryBuilder<ApiKey>);

      const createdApiKey = createMockApiKey({ name: 'Reset Key' });
      const savedApiKey = createMockApiKey({ name: 'Reset Key' });
      mockApiKeyRepo.create.mockReturnValue(createdApiKey);
      mockApiKeyRepo.save.mockResolvedValue(savedApiKey);

      const result = await service.resetKey('agent-1');

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      expect(mockApiKeyRepo.createQueryBuilder).toHaveBeenCalled();
      expect(executeMock).toHaveBeenCalled();
      expect(crypto.randomBytes).toHaveBeenCalledWith(24);
      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith({
        agentId: agent.id,
        keyHash: 'mocked_hash',
        keyPrefix: 'ask_mock',
        name: 'Reset Key',
        permissions: { scopes: ['read', 'write'] },
      });
      expect(mockApiKeyRepo.save).toHaveBeenCalledWith(createdApiKey);
      expect(result).toEqual({ apiKey: 'ask_mocked_random_string' });
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.resetKey('not-found')).rejects.toThrow(NotFoundException);
    });
  });

  describe('toggle', () => {
    it('should toggle from active to disabled', async () => {
      const agent = createMockAgent({ status: AgentStatus.ACTIVE });
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);

      const result = await service.toggle('agent-1');

      expect(agent.status).toBe('disabled');
      expect(mockAgentRepo.save).toHaveBeenCalledWith(agent);
      expect(result).toEqual({ id: 'agent-1', status: 'disabled' });
    });

    it('should toggle from disabled to active', async () => {
      const agent = createMockAgent({ status: AgentStatus.DISABLED });
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);

      const result = await service.toggle('agent-1');

      expect(agent.status).toBe('active');
      expect(mockAgentRepo.save).toHaveBeenCalledWith(agent);
      expect(result).toEqual({ id: 'agent-1', status: 'active' });
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.toggle('not-found')).rejects.toThrow(NotFoundException);
    });
  });

  describe('stats', () => {
    it('should return agent stats', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);

      const query = { start: '2024-01-01', end: '2024-01-31' };
      const result = await service.stats('agent-1', query);

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      expect(result).toEqual({
        agentId: 'agent-1',
        period: query,
        messageCount: 0,
        topicCount: 0,
        taskCount: 0,
        avgResponseTime: 0,
        tokenUsage: 0,
        dailyActivity: [],
      });
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.stats('not-found', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('heartbeat', () => {
    it('should update lastActiveAt and return agent', async () => {
      const agent = createMockAgent();
      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockAgentRepo.save.mockResolvedValue(agent);

      const result = await service.heartbeat('agent-1', {});

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      expect(agent.lastActiveAt).toBeInstanceOf(Date);
      expect(mockAgentRepo.save).toHaveBeenCalledWith(agent);
      expect(result).toEqual(agent);
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.heartbeat('not-found', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('findKeys', () => {
    it('should return keys list ordered by createdAt DESC', async () => {
      const keys = [createMockApiKey({ id: 'key-1' }), createMockApiKey({ id: 'key-2' })];
      mockApiKeyRepo.find.mockResolvedValue(keys);

      const result = await service.findKeys('agent-1');

      expect(mockApiKeyRepo.find).toHaveBeenCalledWith({
        where: { agentId: 'agent-1' },
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual(keys);
    });
  });

  describe('createKey', () => {
    it('should create key and return with apiKey plaintext', async () => {
      const agent = createMockAgent();
      const dto = { name: 'Custom Key' };
      const createdApiKey = createMockApiKey({ name: 'Custom Key' });
      const savedApiKey = createMockApiKey({ name: 'Custom Key' });

      mockAgentRepo.findOne.mockResolvedValue(agent);
      mockApiKeyRepo.create.mockReturnValue(createdApiKey);
      mockApiKeyRepo.save.mockResolvedValue(savedApiKey);

      const result = await service.createKey('agent-1', dto);

      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        relations: { actor: true },
      });
      expect(crypto.randomBytes).toHaveBeenCalledWith(24);
      expect(crypto.createHash).toHaveBeenCalledWith('sha256');
      expect(mockApiKeyRepo.create).toHaveBeenCalledWith({
        agentId: agent.id,
        keyHash: 'mocked_hash',
        keyPrefix: 'ask_mock',
        name: 'Custom Key',
        permissions: { scopes: ['read', 'write'] },
      });
      expect(mockApiKeyRepo.save).toHaveBeenCalledWith(createdApiKey);
      expect(result).toEqual({ ...savedApiKey, apiKey: 'ask_mocked_random_string' });
    });

    it('should throw NotFoundException when agent not found', async () => {
      mockAgentRepo.findOne.mockResolvedValue(null);

      await expect(service.createKey('not-found', { name: 'Key' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockAgentRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'not-found' },
        relations: { actor: true },
      });
    });
  });

  describe('revokeKey', () => {
    it('should revoke key and return true', async () => {
      const key = createMockApiKey();
      mockApiKeyRepo.findOne.mockResolvedValue(key);
      mockApiKeyRepo.save.mockResolvedValue(key);

      const result = await service.revokeKey('key-1');

      expect(mockApiKeyRepo.findOne).toHaveBeenCalledWith({ where: { id: 'key-1' } });
      expect(key.revokedAt).toBeInstanceOf(Date);
      expect(mockApiKeyRepo.save).toHaveBeenCalledWith(key);
      // 审计（Phase 2）：DELETE + api_key；service 层（key 实体含 agentId/keyPrefix）；
      // actor 缺省 = key.agentId
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DELETE,
          entityType: 'api_key',
          entityId: 'key-1',
          actorId: 'agent-1',
          newData: { keyId: 'key-1', keyPrefix: 'ask_mock', agentId: 'agent-1' },
          source: 'api',
        }),
      );
      expect(result).toBe(true);
    });

    it('should use operatorActorId when provided (decision 8)', async () => {
      const key = createMockApiKey();
      mockApiKeyRepo.findOne.mockResolvedValue(key);
      mockApiKeyRepo.save.mockResolvedValue(key);

      await service.revokeKey('key-1', 'admin-1');

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'key-1', actorId: 'admin-1' }),
      );
    });

    it('should throw NotFoundException when key not found', async () => {
      mockApiKeyRepo.findOne.mockResolvedValue(null);

      await expect(service.revokeKey('not-found')).rejects.toThrow(NotFoundException);
      expect(mockApiKeyRepo.findOne).toHaveBeenCalledWith({ where: { id: 'not-found' } });
      // 失败路径不记审计
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  describe('findMyUnreadCounts', () => {
    it('should return mapped unread counts from raw SQL (plan WS-B)', async () => {
      (mockAgentRepo.manager.query as jest.Mock).mockResolvedValue([
        { topicId: 'topic-1', topicName: 'T1', unreadCount: 3 },
        { topicId: 'topic-2', topicName: 'T2', unreadCount: 1 },
      ]);

      const result = await service.findMyUnreadCounts('agent-1');

      expect(result).toEqual([
        { topicId: 'topic-1', topicName: 'T1', unreadCount: 3 },
        { topicId: 'topic-2', topicName: 'T2', unreadCount: 1 },
      ]);
      const [sql, params] = (mockAgentRepo.manager.query as jest.Mock).mock.calls[0] as [
        string,
        unknown[],
      ];
      // 参数绑定：participant_id = $1
      expect(params).toEqual(['agent-1']);
      // 关键谓词（对照 getUnread 语义，plan WS-B SQL 逐字）：
      expect(sql).toContain('tp.participant_id = $1');
      expect(sql).toContain("tp.status IN ('invited','active')"); // left 参与行排除
      expect(sql).toContain('t.deleted_at IS NULL'); // 已删 topic 排除
      expect(sql).toContain('a.deleted_at IS NULL'); // 游标消息软删 → 锚点落空 → 全量
      expect(sql).toContain('(m.created_at, m.id) > (a.created_at, a.id)'); // 行值比较 after 语义
      expect(sql).toContain('HAVING COUNT(m.id) > 0'); // 只返 unreadCount>0
      expect(sql).toContain('LIMIT 50');
      // 自己发的计入：无 sender 过滤（与 getUnread 同语义）
      expect(sql).not.toContain('sender_id');
    });

    it('should return empty array when no participation rows', async () => {
      (mockAgentRepo.manager.query as jest.Mock).mockResolvedValue([]);

      const result = await service.findMyUnreadCounts('agent-1');

      expect(result).toEqual([]);
    });
  });
});
