import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyAuthService } from './api-key-auth.service';
import { ApiKey } from '../../database/entities/api-key.entity';
import { Agent } from '../../database/entities/agent.entity';
import { AgentStatus, ErrorCode } from '@agent-chamber/shared';

/**
 * ApiKeyAuthService 单测（M1 圆桌计划决策 4：两 guard 的 API Key 分支纯抽取，
 * 本 spec 覆盖抽取前 ApiKeyGuard 严格分支 + JwtOrApiKeyGuard 宽松分支的全部判定路径）
 */

function createMockRepo<T extends ObjectLiteral>() {
  return {
    findOne: jest.fn(),
    save: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

/** 构造 agent 对象（含 actor 关系，对齐 agentRepo.findOne relations:{actor:true}）。
 *  overrides 用宽松 Record 承接 actor 局部覆盖（避免 Partial<Agent> 对 Actor 全字段校验）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAgent(overrides: Record<string, any> = {}) {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    ownerId: 'owner-1',
    lastActiveAt: null as Date | null,
    actor: { status: AgentStatus.ACTIVE, deletedAt: null },
    ...overrides,
  } as unknown as Agent;
}

describe('ApiKeyAuthService', () => {
  let service: ApiKeyAuthService;
  let apiKeyRepo: jest.Mocked<Repository<ApiKey>>;
  let agentRepo: jest.Mocked<Repository<Agent>>;

  const VALID_KEY = 'ask_test_valid_key_123456';
  /** 与 service 内 crypto 实现保持一致的计算方式，用于断言 where.keyHash */
  const hashOf = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

  const validApiKey = (overrides: Partial<ApiKey> = {}) =>
    ({
      id: 'key-1',
      agentId: 'agent-1',
      keyHash: hashOf(VALID_KEY),
      permissions: { scopes: ['read', 'write'] },
      revokedAt: null,
      deletedAt: null,
      expiresAt: null,
      lastUsedAt: null,
      ...overrides,
    }) as unknown as ApiKey;

  beforeEach(async () => {
    apiKeyRepo = createMockRepo<ApiKey>();
    agentRepo = createMockRepo<Agent>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeyAuthService,
        { provide: getRepositoryToken(ApiKey), useValue: apiKeyRepo },
        { provide: getRepositoryToken(Agent), useValue: agentRepo },
      ],
    }).compile();

    service = moduleRef.get<ApiKeyAuthService>(ApiKeyAuthService);
  });

  it('should query api_keys by sha256(key) hash', async () => {
    apiKeyRepo.findOne.mockResolvedValue(null);
    await expect(service.authenticate(VALID_KEY)).rejects.toThrow(UnauthorizedException);
    expect(apiKeyRepo.findOne).toHaveBeenCalledWith({
      where: { keyHash: hashOf(VALID_KEY) },
      relations: ['agent'],
    });
  });

  describe('拒绝路径（ApiKeyGuard 严格分支语义）', () => {
    it('should reject unknown API Key with INVALID_API_KEY', async () => {
      apiKeyRepo.findOne.mockResolvedValue(null);
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'Invalid API Key', code: ErrorCode.INVALID_API_KEY },
      });
    });

    it('should reject revoked API Key with INVALID_API_KEY', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey({ revokedAt: new Date() }));
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'API Key has been revoked', code: ErrorCode.INVALID_API_KEY },
      });
    });

    it('should reject soft-deleted API Key with INVALID_API_KEY', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey({ deletedAt: new Date() }));
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'API Key has been revoked', code: ErrorCode.INVALID_API_KEY },
      });
    });

    it('should reject expired API Key with TOKEN_EXPIRED', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'API Key has expired', code: ErrorCode.TOKEN_EXPIRED },
      });
    });

    it('should accept not-yet-expired key (expiresAt in the future)', async () => {
      // 用明确的未来时间点做确定性断言（== now 边界存在毫秒级竞态，不可测）
      apiKeyRepo.findOne.mockResolvedValue(
        validApiKey({ expiresAt: new Date(Date.now() + 60_000) }),
      );
      agentRepo.findOne.mockResolvedValue(makeAgent());
      agentRepo.save.mockResolvedValue(makeAgent());
      const payload = await service.authenticate(VALID_KEY);
      expect(payload.id).toBe('agent-1');
    });

    it('should reject when agent missing with AGENT_NOT_FOUND', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(null);
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    it('should reject when agent actor deleted with AGENT_NOT_FOUND', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(
        makeAgent({ actor: { status: AgentStatus.ACTIVE, deletedAt: new Date() } }),
      );
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'Agent not found', code: ErrorCode.AGENT_NOT_FOUND },
      });
    });

    it('should reject non-active agent with AGENT_DISABLED', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(
        makeAgent({ actor: { status: AgentStatus.PENDING, deletedAt: null } }),
      );
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'Agent is not active', code: ErrorCode.AGENT_DISABLED },
      });
    });
  });

  describe('成功路径', () => {
    it('should return AgentPayload and touch lastUsedAt + lastActiveAt', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      const agent = makeAgent();
      agentRepo.findOne.mockResolvedValue(agent);
      apiKeyRepo.save.mockResolvedValue(validApiKey());
      agentRepo.save.mockResolvedValue(agent);

      const payload = await service.authenticate(VALID_KEY);

      expect(payload).toEqual({
        id: 'agent-1',
        name: 'Test Agent',
        ownerId: 'owner-1',
        permissions: { scopes: ['read', 'write'] },
      });
      expect(apiKeyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
      // lastActiveAt 异步 fire-and-forget：save 调用已发出（返回值由守卫 catch 吞掉）
      expect(agentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastActiveAt: expect.any(Date) }),
      );
      expect(agent.lastActiveAt).toBeInstanceOf(Date);
    });

    it('should not touch agent lastActiveAt when rejected (revoked path short-circuits)', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey({ revokedAt: new Date() }));
      await expect(service.authenticate(VALID_KEY)).rejects.toThrow(UnauthorizedException);
      expect(agentRepo.findOne).not.toHaveBeenCalled();
      expect(agentRepo.save).not.toHaveBeenCalled();
    });
  });
});
