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
    // 保留 save spy：认证遥测不得整对象持久化，默认 Promise 兼容旧实现的 RED 验证。
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] }),
  } as unknown as jest.Mocked<Repository<T>>;
}

/** 显式控制写入完成/失败与调用到达的屏障，不用定时等待猜测异步顺序。 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
      keyPrefix: 'ask_test',
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

  afterEach(() => {
    jest.useRealTimers();
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

    it('should reject when agent actor is missing (soft-deleted row filtered by eager join) with AGENT_DISABLED', async () => {
      // 统一批 A3-1b 死代码清理后：actor.deletedAt 是 select:false 列，正常查询恒 undefined，
      // 软删 agent 的拦截语义由 status 兜底承担——eager LEFT JOIN 的 actor 行被软删过滤后
      // agent.actor = null → actor.status !== ACTIVE → AGENT_DISABLED 拒绝。
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(makeAgent({ actor: null }));
      await expect(service.authenticate(VALID_KEY)).rejects.toMatchObject({
        response: { message: 'Agent is not active', code: ErrorCode.AGENT_DISABLED },
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
    it('should update only telemetry columns without mutating snapshots and preserve the payload', async () => {
      const now = new Date('2026-10-25T08:00:00.000Z');
      jest.useFakeTimers({ now });
      const agent = makeAgent();
      const apiKey = validApiKey({
        agent: agent.actor,
        permissions: { scopes: ['read', 'write'], integration: { source: 'runner' } },
      });
      const keySnapshot = structuredClone(apiKey);
      const agentSnapshot = structuredClone(agent);
      apiKeyRepo.findOne.mockResolvedValue(apiKey);
      agentRepo.findOne.mockResolvedValue(agent);

      const payload = await service.authenticate(VALID_KEY);

      expect(payload).toEqual({
        id: 'agent-1',
        name: 'Test Agent',
        ownerId: 'owner-1',
        permissions: { scopes: ['read', 'write'], integration: { source: 'runner' } },
        keyPrefix: 'ask_test',
      });
      expect(payload.permissions).toBe(apiKey.permissions);
      expect(apiKeyRepo.update).toHaveBeenCalledTimes(1);
      expect(apiKeyRepo.update).toHaveBeenCalledWith('key-1', { lastUsedAt: now });
      expect(agentRepo.update).toHaveBeenCalledTimes(1);
      expect(agentRepo.update).toHaveBeenCalledWith('agent-1', { lastActiveAt: now });
      expect(apiKeyRepo.save).not.toHaveBeenCalled();
      expect(agentRepo.save).not.toHaveBeenCalled();
      expect(apiKey).toEqual(keySnapshot);
      expect(agent).toEqual(agentSnapshot);
    });

    it('should await the key timestamp write before starting agent telemetry or returning', async () => {
      const keyWrite = createDeferred<void>();
      const keyWriteStarted = createDeferred<void>();
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(makeAgent());
      apiKeyRepo.update.mockImplementation(async () => {
        keyWriteStarted.resolve();
        await keyWrite.promise;
        return { affected: 1, raw: [], generatedMaps: [] };
      });
      let settled = false;
      const authentication = service.authenticate(VALID_KEY).then((payload) => {
        settled = true;
        return payload;
      });

      try {
        // 旧实现会先返回；正确实现停在 update。两条路径均有显式完成信号供 RED 断言。
        await Promise.race([keyWriteStarted.promise, authentication]);
        expect(apiKeyRepo.update).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(agentRepo.update).not.toHaveBeenCalled();
        expect(agentRepo.save).not.toHaveBeenCalled();
      } finally {
        keyWrite.resolve();
        await authentication;
      }

      expect(settled).toBe(true);
      expect(agentRepo.update).toHaveBeenCalledTimes(1);
    });

    it('should propagate a rejected key timestamp write without starting agent telemetry', async () => {
      const failure = new Error('key timestamp write failed');
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(makeAgent());
      apiKeyRepo.update.mockRejectedValue(failure);

      await expect(service.authenticate(VALID_KEY)).rejects.toBe(failure);

      expect(agentRepo.update).not.toHaveBeenCalled();
      expect(agentRepo.save).not.toHaveBeenCalled();
    });

    it('should return while the agent timestamp write is still pending', async () => {
      const agentWrite = createDeferred<void>();
      const apiKey = validApiKey();
      apiKeyRepo.findOne.mockResolvedValue(apiKey);
      agentRepo.findOne.mockResolvedValue(makeAgent());
      agentRepo.update.mockImplementation(async () => {
        await agentWrite.promise;
        return { affected: 1, raw: [], generatedMaps: [] };
      });

      try {
        const payload = await service.authenticate(VALID_KEY);
        expect(agentRepo.update).toHaveBeenCalledTimes(1);
        expect(payload.id).toBe('agent-1');
        expect(payload.permissions).toBe(apiKey.permissions);
        expect(agentRepo.save).not.toHaveBeenCalled();
      } finally {
        // 认证返回以后才释放写入；若服务改为 await，测试会因无法返回而失败。
        agentWrite.resolve();
      }
    });

    it('should catch a rejected agent timestamp write and still authenticate', async () => {
      const failure = new Error('agent timestamp write failed');
      apiKeyRepo.findOne.mockResolvedValue(validApiKey());
      agentRepo.findOne.mockResolvedValue(makeAgent());
      agentRepo.update.mockRejectedValue(failure);

      await expect(service.authenticate(VALID_KEY)).resolves.toMatchObject({
        id: 'agent-1',
        keyPrefix: 'ask_test',
      });
      expect(agentRepo.update).toHaveBeenCalledTimes(1);
      expect(agentRepo.save).not.toHaveBeenCalled();
    });

    it('should not touch agent lastActiveAt when rejected (revoked path short-circuits)', async () => {
      apiKeyRepo.findOne.mockResolvedValue(validApiKey({ revokedAt: new Date() }));
      await expect(service.authenticate(VALID_KEY)).rejects.toThrow(UnauthorizedException);
      expect(agentRepo.findOne).not.toHaveBeenCalled();
      expect(apiKeyRepo.update).not.toHaveBeenCalled();
      expect(apiKeyRepo.save).not.toHaveBeenCalled();
      expect(agentRepo.update).not.toHaveBeenCalled();
      expect(agentRepo.save).not.toHaveBeenCalled();
    });
  });
});
