import { Test, TestingModule } from '@nestjs/testing';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ActorType, UserRole } from '@agent-chamber/shared';

describe('AgentController', () => {
  let controller: AgentController;
  let service: typeof mockService;
  let permService: typeof mockPermService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const mockAgentActor = { id: 'agent-1', type: ActorType.AGENT };

  const mockService = {
    findAll: jest.fn(),
    findDirectory: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    resetKey: jest.fn(),
    toggle: jest.fn(),
    stats: jest.fn(),
    heartbeat: jest.fn(),
    findKeys: jest.fn(),
    createKey: jest.fn(),
    revokeKey: jest.fn(),
    updateMe: jest.fn(),
    findMyTopics: jest.fn(),
    findMyActivities: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentService, useValue: mockService },
        { provide: PermissionService, useValue: mockPermService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AgentController>(AgentController);
    service = module.get<AgentService>(AgentService) as unknown as typeof mockService;
    permService = module.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof mockPermService;
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should call service.findAll with query and return result for admin', async () => {
      const result = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      service.findAll.mockResolvedValue(result);

      expect(
        await controller.findAll({ page: 1, status: 'active' }, { headers: {} }, mockActor),
      ).toEqual(result);
      expect(service.findAll).toHaveBeenCalledWith({ page: 1, status: 'active' });
    });

    it('should reject Agent (API Key) requests', async () => {
      await expect(
        controller.findAll({}, { headers: { 'x-api-key': 'test-key' } }, mockAgentActor),
      ).rejects.toThrow('Permission denied');
    });

    it('should return only own agents for non-admin user', async () => {
      const nonAdminActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = {
        items: [
          {
            id: 'agent-1',
            name: 'My Agent',
            avatarUrl: null,
            status: 'active',
            ownerId: 'user-2',
            description: null,
            capabilities: [],
            createdAt: new Date('2024-01-01'),
            topicCount: 1,
            messageCount: 10,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      service.findAll.mockResolvedValue(result);

      const response = await controller.findAll(
        { page: 1, status: 'active' },
        { headers: {} },
        nonAdminActor,
      );

      // Non-admin calls service with ownerId = actor.id
      expect(service.findAll).toHaveBeenCalledWith({
        page: 1,
        status: 'active',
        ownerId: 'user-2',
      });

      expect(response).toEqual(result);
      expect(response.items).toHaveLength(1);
      expect(response.items[0].ownerId).toBe('user-2');
    });

    it('should return public fields and strip apiKeyPrefix for non-owned agents when admin', async () => {
      const agentWithAllFields = {
        id: 'agent-1',
        name: 'Test Agent',
        avatarUrl: 'https://example.com/avatar.png',
        status: 'active',
        ownerId: 'user-3',
        ownerName: 'Test Owner',
        description: 'A test agent',
        capabilities: ['chat'],
        createdAt: new Date('2024-01-01'),
        topicCount: 5,
        messageCount: 100,
        apiKeyPrefix: 'ask_xxxx',
        webhookUrl: 'https://secret.webhook.com',
        webhookSecret: 'super-secret',
        systemPrompt: 'You are a secret agent',
        modelConfig: { model: 'gpt-4' },
        rateLimit: 100,
        webhookEvents: ['message.created'],
        webhookTimeoutMs: 5000,
        webhookRetryMax: 3,
      };
      const result = {
        items: [agentWithAllFields],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      service.findAll.mockResolvedValue(result);

      const response = await controller.findAll(
        { page: 1, status: 'active' },
        { headers: {} },
        mockActor,
      );

      const expectedPublicAgent = {
        id: 'agent-1',
        name: 'Test Agent',
        avatarUrl: 'https://example.com/avatar.png',
        status: 'active',
        ownerId: 'user-3',
        ownerName: 'Test Owner',
        description: 'A test agent',
        capabilities: ['chat'],
        createdAt: new Date('2024-01-01'),
        topicCount: 5,
        messageCount: 100,
      };
      expect(response).toEqual({
        ...result,
        items: [expectedPublicAgent],
      });
      expect(service.findAll).toHaveBeenCalledWith({ page: 1, status: 'active' });

      const agent = response.items[0];
      // Sensitive fields must be stripped
      expect((agent as { webhookUrl?: string }).webhookUrl).toBeUndefined();
      expect((agent as { webhookSecret?: string }).webhookSecret).toBeUndefined();
      expect((agent as { systemPrompt?: string }).systemPrompt).toBeUndefined();
      expect((agent as { modelConfig?: unknown }).modelConfig).toBeUndefined();
      expect((agent as { rateLimit?: number }).rateLimit).toBeUndefined();
      expect((agent as { webhookEvents?: string[] }).webhookEvents).toBeUndefined();
      expect((agent as { webhookTimeoutMs?: number }).webhookTimeoutMs).toBeUndefined();
      expect((agent as { webhookRetryMax?: number }).webhookRetryMax).toBeUndefined();

      // apiKeyPrefix must be stripped because the agent is owned by user-3, not admin user-1
      expect((agent as { apiKeyPrefix?: string }).apiKeyPrefix).toBeUndefined();
    });
  });

  describe('directory', () => {
    const directoryResult = {
      items: [
        {
          id: 'agent-1',
          name: 'Public Agent',
          type: 'agent',
          avatarUrl: 'https://example.com/avatar.png',
          capabilities: ['chat'],
          status: 'active',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    };

    it('should call service.findDirectory with query and return result', async () => {
      service.findDirectory.mockResolvedValue(directoryResult);

      const result = await controller.directory({ q: 'Kimi' });

      expect(service.findDirectory).toHaveBeenCalledWith({ q: 'Kimi' });
      expect(result).toEqual(directoryResult);
    });

    it('should not contain sensitive fields in response', async () => {
      service.findDirectory.mockResolvedValue(directoryResult);

      const result = await controller.directory({ q: 'Kimi' });

      for (const item of result.items) {
        const agent = item as Record<string, unknown>;
        // 白名单字段应存在
        expect(agent.id).toBeDefined();
        expect(agent.name).toBeDefined();
        expect(agent.type).toBe('agent');
        expect(agent).toHaveProperty('avatarUrl');
        expect(agent).toHaveProperty('capabilities');
        expect(agent).toHaveProperty('status');
        // 敏感字段不应存在
        expect(agent.ownerId).toBeUndefined();
        expect(agent.webhookUrl).toBeUndefined();
        expect(agent.webhookSecret).toBeUndefined();
        expect(agent.systemPrompt).toBeUndefined();
        expect(agent.modelConfig).toBeUndefined();
        expect(agent.rateLimit).toBeUndefined();
        expect(agent.lastActiveAt).toBeUndefined();
        expect(agent.apiKeyPrefix).toBeUndefined();
        expect(agent.ownerName).toBeUndefined();
        expect(agent.topicCount).toBeUndefined();
        expect(agent.messageCount).toBeUndefined();
        expect(agent.description).toBeUndefined();
      }
    });

    it('should handle empty results', async () => {
      service.findDirectory.mockResolvedValue({
        ...directoryResult,
        items: [],
        total: 0,
        totalPages: 0,
      });

      const result = await controller.directory({ page: 3, pageSize: 5 });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  const publicAgentFields = {
    id: 'agent-1',
    name: 'Test Agent',
    avatarUrl: 'https://example.com/avatar.png',
    status: 'active',
    ownerId: 'user-1',
    ownerName: 'Test Owner',
    description: 'A test agent',
    capabilities: ['chat'],
    createdAt: new Date('2024-01-01'),
    topicCount: 5,
    messageCount: 100,
  };

  describe('create', () => {
    it('should call service.create with actor id and dto and return public fields with apiKey', async () => {
      const dto = { name: 'New Agent' };
      const result = { ...publicAgentFields, name: 'New Agent', apiKey: 'ask_newkey' };
      service.create.mockResolvedValue(result);

      const response = await controller.create(mockActor, dto);
      expect(response).toEqual({
        ...publicAgentFields,
        name: 'New Agent',
        apiKey: 'ask_newkey',
      });
      expect(service.create).toHaveBeenCalledWith(mockActor.id, dto);
    });
  });

  describe('findOne', () => {
    it('should ensure read permission and return public agent fields', async () => {
      const result = {
        ...publicAgentFields,
        webhookSecret: 'super-secret',
        systemPrompt: 'secret prompt',
        modelConfig: { model: 'gpt-4' },
      };
      service.findOne.mockResolvedValue(result);

      const response = await controller.findOne('agent-1', mockActor);
      expect(response).toEqual(publicAgentFields);
      expect(permService.ensureCan).toHaveBeenCalledWith(result, mockActor, 'read');
      expect(service.findOne).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('update', () => {
    it('should ensure write permission then update and return public fields', async () => {
      const agent = { id: 'agent-1', name: 'Test Agent' };
      const dto = { name: 'Updated Agent' };
      const result = {
        ...publicAgentFields,
        name: 'Updated Agent',
        webhookSecret: 'super-secret',
      };
      service.findOne.mockResolvedValue(agent);
      service.update.mockResolvedValue(result);

      const response = await controller.update('agent-1', dto, mockActor);
      expect(response).toEqual({ ...publicAgentFields, name: 'Updated Agent' });
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.update).toHaveBeenCalledWith('agent-1', dto);
    });
  });

  describe('remove', () => {
    it('should ensure delete permission then remove', async () => {
      const agent = { id: 'agent-1' };
      service.findOne.mockResolvedValue(agent);
      service.remove.mockResolvedValue(true);

      expect(await controller.remove('agent-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'delete');
      expect(service.remove).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('resetKey', () => {
    it('should ensure write permission then reset key', async () => {
      const agent = { id: 'agent-1' };
      const result = { apiKey: 'ask_newkey' };
      service.findOne.mockResolvedValue(agent);
      service.resetKey.mockResolvedValue(result);

      expect(await controller.resetKey('agent-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.resetKey).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('toggle', () => {
    it('should ensure write permission then toggle', async () => {
      const agent = { id: 'agent-1' };
      const result = { id: 'agent-1', status: 'disabled' };
      service.findOne.mockResolvedValue(agent);
      service.toggle.mockResolvedValue(result);

      expect(await controller.toggle('agent-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.toggle).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('stats', () => {
    it('should ensure write permission then return stats', async () => {
      const agent = { id: 'agent-1' };
      const query = { start: '2024-01-01', end: '2024-01-31' };
      const result = {
        agentId: 'agent-1',
        period: query,
        messageCount: 0,
        topicCount: 0,
        taskCount: 0,
        avgResponseTime: 0,
        tokenUsage: 0,
        dailyActivity: [],
      };
      service.findOne.mockResolvedValue(agent);
      service.stats.mockResolvedValue(result);

      expect(await controller.stats('agent-1', query, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.stats).toHaveBeenCalledWith('agent-1', query);
    });
  });

  describe('heartbeat', () => {
    it('should ensure write permission then heartbeat', async () => {
      const agent = { id: 'agent-1' };
      const dto = { timestamp: new Date().toISOString() };
      const result = { id: 'agent-1', lastActiveAt: new Date() };
      service.findOne.mockResolvedValue(agent);
      service.heartbeat.mockResolvedValue(result);

      expect(await controller.heartbeat('agent-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.heartbeat).toHaveBeenCalledWith('agent-1', dto);
    });
  });

  describe('findKeys', () => {
    it('should ensure write permission then return keys', async () => {
      const agent = { id: 'agent-1' };
      const result = [{ id: 'key-1', name: 'Key 1', keyPrefix: 'ask_mock' }];
      service.findOne.mockResolvedValue(agent);
      service.findKeys.mockResolvedValue(result);

      expect(await controller.findKeys('agent-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.findKeys).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('createKey', () => {
    it('should ensure write permission then create key', async () => {
      const agent = { id: 'agent-1' };
      const dto = { name: 'New Key' };
      const result = { id: 'key-1', name: 'New Key', apiKey: 'ask_abc123' };
      service.findOne.mockResolvedValue(agent);
      service.createKey.mockResolvedValue(result);

      expect(await controller.createKey('agent-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.createKey).toHaveBeenCalledWith('agent-1', dto);
    });
  });

  describe('revokeKey', () => {
    it('should ensure write permission then revoke key', async () => {
      const agent = { id: 'agent-1' };
      service.findOne.mockResolvedValue(agent);
      service.revokeKey.mockResolvedValue(true);

      expect(await controller.revokeKey('agent-1', 'key-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      expect(service.revokeKey).toHaveBeenCalledWith('key-1');
    });
  });

  describe('updateMe', () => {
    it('should call service.updateMe with agentId and dto and return public fields', async () => {
      const dto = { name: 'Updated Name' };
      const result = {
        ...publicAgentFields,
        name: 'Updated Name',
        webhookSecret: 'super-secret',
      };
      service.updateMe.mockResolvedValue(result);

      const response = await controller.updateMe(mockAgentActor, dto);
      expect(response).toEqual({ ...publicAgentFields, name: 'Updated Name' });
      expect(service.updateMe).toHaveBeenCalledWith(mockAgentActor.id, dto);
    });
  });

  describe('getMyTopics', () => {
    it('should call service.findMyTopics with agentId and query', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.findMyTopics.mockResolvedValue(result);

      expect(await controller.getMyTopics(mockAgentActor, { page: 1, pageSize: 10 })).toBe(result);
      expect(service.findMyTopics).toHaveBeenCalledWith(mockAgentActor.id, {
        page: 1,
        pageSize: 10,
      });
    });
  });

  describe('getMyActivities', () => {
    it('should call service.findMyActivities with agentId and query', async () => {
      const result = { items: [], count: 0 };
      service.findMyActivities.mockResolvedValue(result);

      expect(await controller.getMyActivities(mockAgentActor, { limit: '20' })).toBe(result);
      expect(service.findMyActivities).toHaveBeenCalledWith(mockAgentActor.id, { limit: '20' });
    });

    it('should call service.findMyActivities with empty query when not provided', async () => {
      const result = { items: [], count: 0 };
      service.findMyActivities.mockResolvedValue(result);

      expect(await controller.getMyActivities(mockAgentActor, {})).toBe(result);
      expect(service.findMyActivities).toHaveBeenCalledWith(mockAgentActor.id, {});
    });
  });
});
