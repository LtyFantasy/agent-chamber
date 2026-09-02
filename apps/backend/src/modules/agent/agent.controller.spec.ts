import { Test, TestingModule } from '@nestjs/testing';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ActorType, UserRole, AuditAction } from '@agent-chamber/shared';
import { AuditService } from '../audit/audit.service';

describe('AgentController', () => {
  let controller: AgentController;
  let service: typeof mockService;
  let permService: typeof mockPermService;
  let auditService: { log: jest.Mock };

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
    findMyUnreadCounts: jest.fn(),
    getMyBriefing: jest.fn(),
    // 白名单裁剪的真实实现（AGENT-FIELD-WHITELIST 教训：controller 层 spec 断言
    // 裁剪行为，mock 必须复刻 14 字段白名单，否则 findAll 等既有断言失真）
    pickPublicAgentFields: jest.fn((agent: Record<string, unknown>) => ({
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      status: agent.status,
      ownerId: agent.ownerId,
      ownerName: agent.ownerName,
      description: agent.description,
      descriptionSnippet: agent.descriptionSnippet,
      capabilities: agent.capabilities,
      createdAt: agent.createdAt,
      lastActiveAt: agent.lastActiveAt,
      topicCount: agent.topicCount,
      messageCount: agent.messageCount,
      apiKeyPrefix: agent.apiKeyPrefix,
    })),
    getDeletionImpact: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };

  const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentService, useValue: mockService },
        { provide: PermissionService, useValue: mockPermService },
        { provide: AuditService, useValue: mockAuditService },
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
    auditService = module.get<AuditService>(AuditService) as unknown as { log: jest.Mock };
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

      expect(await controller.findAll({ page: 1, status: 'active' }, mockActor)).toEqual(result);
      expect(service.findAll).toHaveBeenCalledWith({ page: 1, status: 'active' });
    });

    it('should reject Agent (API Key) requests', async () => {
      await expect(controller.findAll({}, mockAgentActor)).rejects.toThrow('Permission denied');
    });

    it('should keep lastActiveAt/createdAt in admin list response (regression: pickPublicAgentFields whitelist)', async () => {
      const result = {
        items: [
          {
            id: 'agent-1',
            name: 'Hument GPT',
            status: 'active',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
            lastActiveAt: '2026-08-10T04:05:21.000Z',
            topicCount: 0,
            messageCount: 0,
            apiKeyPrefix: 'ask_xxxx',
            webhookUrl: 'https://example.com/hook', // 敏感字段应被剥离
            systemPrompt: 'secret',
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

      const res = await controller.findAll({}, mockActor);

      const item = res.items[0] as Record<string, unknown>;
      expect(item.lastActiveAt).toBe('2026-08-10T04:05:21.000Z');
      expect(item.createdAt).toBe('2026-08-09T00:00:00.000Z');
      // 敏感字段仍被白名单剥离
      expect(item.webhookUrl).toBeUndefined();
      expect(item.systemPrompt).toBeUndefined();
    });

    it('should include descriptionSnippet in admin list response (regression: pickPublicAgentFields whitelist)', async () => {
      // 模拟贴合真实 findAll 输出：service 已剥离 description，仅带 descriptionSnippet（agent.service.ts findAll）
      const result = {
        items: [
          {
            id: 'agent-1',
            name: 'Test Agent',
            status: 'active',
            descriptionSnippet: 'A brief introduction of the agent...',
            topicCount: 0,
            messageCount: 0,
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

      const res = await controller.findAll({}, mockActor);

      const item = res.items[0] as Record<string, unknown>;
      expect(item.descriptionSnippet).toBe('A brief introduction of the agent...');
      // 完整 description 在 service 层已被剥离，controller 白名单不应凭空引入
      expect(item.description).toBeUndefined();
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

      const response = await controller.findAll({ page: 1, status: 'active' }, nonAdminActor);

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

    it('should include descriptionSnippet in non-admin own-agents list response', async () => {
      const nonAdminActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      // 模拟贴合真实 findAll 输出：剥离 description、仅保留 descriptionSnippet
      const result = {
        items: [
          {
            id: 'agent-1',
            name: 'My Agent',
            status: 'active',
            ownerId: 'user-2',
            descriptionSnippet: 'Short introduction',
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

      const response = await controller.findAll({ page: 1 }, nonAdminActor);

      const item = response.items[0] as Record<string, unknown>;
      expect(item.descriptionSnippet).toBe('Short introduction');
      expect(item.description).toBeUndefined();
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

      const response = await controller.findAll({ page: 1, status: 'active' }, mockActor);

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
      // 审计（Phase 2）：CREATE + agent；newData 白名单 {agentId, name, status}
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.CREATE,
        entityType: 'agent',
        entityId: 'agent-1',
        actorId: 'user-1',
        newData: { agentId: 'agent-1', name: 'New Agent', status: 'active' },
        source: 'api',
      });
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
      // 审计（Phase 2）：UPDATE + agent；newData 只含白名单字段（name 变更）
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.UPDATE,
        entityType: 'agent',
        entityId: 'agent-1',
        actorId: 'user-1',
        newData: { agentId: 'agent-1', name: 'Updated Agent' },
        source: 'api',
      });
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
      // 审计（Phase 2）：DELETE + agent
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.DELETE,
          entityType: 'agent',
          entityId: 'agent-1',
          actorId: 'user-1',
          source: 'api',
        }),
      );
    });
  });

  describe('getDeletionImpact', () => {
    it('should ensure DELETE-level permission then return impact counts (R13: caller is the deleter)', async () => {
      const agent = { id: 'agent-1' };
      const impact = { openTaskCount: 3, messageCount: 7, topicCount: 2, seatCount: 1 };
      service.findOne.mockResolvedValue(agent);
      service.getDeletionImpact.mockResolvedValue(impact);

      expect(await controller.getDeletionImpact('agent-1', mockActor)).toEqual(impact);
      // 与 DELETE 同权——'read' 会向只读协作者泄露聚合计数
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'delete');
      expect(service.getDeletionImpact).toHaveBeenCalledWith('agent-1');
    });

    it('should not call service when agent not found (404 short-circuit)', async () => {
      service.findOne.mockRejectedValue(new Error('AGENT_NOT_FOUND'));

      await expect(controller.getDeletionImpact('missing', mockActor)).rejects.toThrow(
        'AGENT_NOT_FOUND',
      );
      expect(permService.ensureCan).not.toHaveBeenCalled();
      expect(service.getDeletionImpact).not.toHaveBeenCalled();
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
      // 审计（Phase 2）：RESET_API_KEY + agent；newData 带新 key 前缀（非明文）
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.RESET_API_KEY,
        entityType: 'agent',
        entityId: 'agent-1',
        actorId: 'user-1',
        newData: { agentId: 'agent-1', keyPrefix: 'ask_newk' },
        source: 'api',
      });
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
      // 审计（Phase 2）：TOGGLE_AGENT + agent；newData 带切换后 status
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.TOGGLE_AGENT,
        entityType: 'agent',
        entityId: 'agent-1',
        actorId: 'user-1',
        newData: { agentId: 'agent-1', status: 'disabled' },
        source: 'api',
      });
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
      // 审计（Phase 2）：CREATE + api_key；newData {keyId, keyPrefix, agentId}（决策 9）
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.CREATE,
          entityType: 'api_key',
          entityId: 'key-1',
          actorId: 'user-1',
          source: 'api',
        }),
      );
    });
  });

  describe('revokeKey', () => {
    it('should ensure write permission then revoke key', async () => {
      const agent = { id: 'agent-1' };
      service.findOne.mockResolvedValue(agent);
      service.revokeKey.mockResolvedValue(true);

      expect(await controller.revokeKey('agent-1', 'key-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(agent, mockActor, 'write');
      // 审计在 service 层（key 实体字段 controller 不可得）→ actor 透传
      expect(service.revokeKey).toHaveBeenCalledWith('key-1', 'user-1');
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
      // 审计（Phase 2）：UPDATE + agent；actor=自己（PATCH /agents/me）
      expect(auditService.log).toHaveBeenCalledWith({
        action: AuditAction.UPDATE,
        entityType: 'agent',
        entityId: 'agent-1',
        actorId: 'agent-1',
        newData: { agentId: 'agent-1', name: 'Updated Name' },
        source: 'api',
      });
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

      expect(await controller.getMyActivities(mockAgentActor, { limit: 20 })).toBe(result);
      expect(service.findMyActivities).toHaveBeenCalledWith(mockAgentActor.id, { limit: 20 });
    });

    it('should call service.findMyActivities with empty query when not provided', async () => {
      const result = { items: [], count: 0 };
      service.findMyActivities.mockResolvedValue(result);

      expect(await controller.getMyActivities(mockAgentActor, {})).toBe(result);
      expect(service.findMyActivities).toHaveBeenCalledWith(mockAgentActor.id, {});
    });
  });

  describe('getMyUnread', () => {
    it('should call service.findMyUnreadCounts with agentId and return result', async () => {
      const result = [{ topicId: 'topic-1', topicName: 'T1', unreadCount: 3 }];
      service.findMyUnreadCounts.mockResolvedValue(result);

      expect(await controller.getMyUnread(mockAgentActor)).toBe(result);
      expect(service.findMyUnreadCounts).toHaveBeenCalledWith(mockAgentActor.id);
    });
  });

  describe('getMyBriefing', () => {
    it('should delegate to service.getMyBriefing and return briefing with me whitelist-cropped (12-field full set, no auth/sensitive fields)', async () => {
      const briefing = {
        me: {
          id: 'agent-1',
          name: 'Test Agent',
          avatarUrl: 'https://example.com/avatar.png',
          status: 'active',
          ownerId: 'user-1',
          ownerName: 'Test Owner',
          description: 'A test agent',
          descriptionSnippet: 'A test agent',
          capabilities: ['chat'],
          createdAt: new Date('2024-01-01'),
          lastActiveAt: null,
          topicCount: 5,
          messageCount: 100,
          apiKeyPrefix: 'ask_xxxx',
          // 敏感字段：白名单最后一道裁剪必须剥离（AGENT-FIELD-WHITELIST 教训）
          webhookSecret: 'super-secret',
          systemPrompt: 'secret prompt',
          modelConfig: { model: 'gpt-4' },
          rateLimit: 100,
        },
        activeTasks: { items: [], total: 0 },
        unreadCounts: [{ topicId: 'topic-1', topicName: 'T1', unreadCount: 3 }],
        recentActivities: [],
      };
      service.getMyBriefing.mockResolvedValue(briefing);

      const query = { taskLimit: 5, statuses: ['todo', 'in_progress'] as never };
      const res = await controller.getMyBriefing(mockAgentActor, query);

      // 委托
      expect(service.getMyBriefing).toHaveBeenCalledWith(mockAgentActor, query);

      // me：12 字段全集（14 白名单 - avatarUrl - apiKeyPrefix），非子集断言
      const me = res.me as Record<string, unknown>;
      expect(Object.keys(me).sort()).toEqual([
        'capabilities',
        'createdAt',
        'description',
        'descriptionSnippet',
        'id',
        'lastActiveAt',
        'messageCount',
        'name',
        'ownerId',
        'ownerName',
        'status',
        'topicCount',
      ]);
      expect(me.id).toBe('agent-1');
      expect(me.topicCount).toBe(5);
      expect(me.messageCount).toBe(100);
      // 认证元数据 + 敏感字段剥离
      expect(me.avatarUrl).toBeUndefined();
      expect(me.apiKeyPrefix).toBeUndefined();
      expect(me.webhookSecret).toBeUndefined();
      expect(me.systemPrompt).toBeUndefined();
      expect(me.modelConfig).toBeUndefined();
      expect(me.rateLimit).toBeUndefined();

      // 其余键原样透传
      expect(res.activeTasks).toEqual({ items: [], total: 0 });
      expect(res.unreadCounts).toEqual([{ topicId: 'topic-1', topicName: 'T1', unreadCount: 3 }]);
      expect(res.recentActivities).toEqual([]);
    });
  });
});
