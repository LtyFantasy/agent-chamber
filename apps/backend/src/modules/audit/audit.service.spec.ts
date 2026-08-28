import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral, In, Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { AuditAction, ActorType, UserRole } from '@agent-chamber/shared';
import { UnifiedActor } from '../../common/types/actor.types';

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
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
      getMany: jest.fn(),
      getOne: jest.fn(),
    })),
  } as unknown as jest.Mocked<Repository<T>>;
}

/** 组装一条含全部响应字段的审计行（enrich 断言用） */
function makeRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'log-1',
    action: AuditAction.CREATE,
    entityType: 'message',
    entityId: 'e-1',
    actorId: 'actor-1',
    actorType: null,
    oldData: null,
    newData: { messageId: 'm-1' },
    diff: null,
    ipAddress: '1.2.3.4',
    userAgent: 'Mozilla/5.0',
    requestId: 'r-1',
    sessionId: 's-1',
    source: 'api',
    createdAt: new Date('2026-08-28T00:00:00Z'),
    ...overrides,
  };
}

describe('AuditService', () => {
  let service: AuditService;
  let mockRepo: jest.Mocked<Repository<AuditLog>>;
  let mockOwnerProxy: { getOwnedAgentIds: jest.Mock };
  let mockActorProfile: { resolveProfiles: jest.Mock };

  const agentActor: UnifiedActor = { id: 'agent-1', type: ActorType.AGENT, name: 'Agent 1' };
  const humanActor: UnifiedActor = {
    id: 'human-1',
    type: ActorType.HUMAN,
    name: 'Human 1',
    role: UserRole.EDITOR,
  };
  const adminActor: UnifiedActor = {
    id: 'admin-1',
    type: ActorType.HUMAN,
    name: 'Admin',
    role: UserRole.ADMIN,
  };

  beforeEach(async () => {
    mockRepo = createMockRepo<AuditLog>();
    mockOwnerProxy = { getOwnedAgentIds: jest.fn().mockResolvedValue(['agent-1', 'agent-2']) };
    mockActorProfile = { resolveProfiles: jest.fn().mockResolvedValue(new Map()) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditLog), useValue: mockRepo },
        { provide: OwnerProxyService, useValue: mockOwnerProxy },
        { provide: ActorProfileService, useValue: mockActorProfile },
      ],
    }).compile();

    service = moduleRef.get<AuditService>(AuditService);
  });

  describe('log', () => {
    it('should create and save an audit log', async () => {
      const dto: Partial<AuditLog> = { action: AuditAction.LOGIN, actorId: 'user-1' };
      const created = { id: 'log-1', ...dto } as AuditLog;
      const saved = { id: 'log-1', ...dto } as AuditLog;

      mockRepo.create.mockReturnValue(created);
      mockRepo.save.mockResolvedValue(saved);

      const result = await service.log(dto);

      expect(mockRepo.create).toHaveBeenCalledWith(dto);
      expect(mockRepo.save).toHaveBeenCalledWith(created);
      expect(result).toEqual(saved);
    });

    it('fail-open: save 抛错 → 返回 undefined 不向上抛（plan 决策 3）', async () => {
      const dto: Partial<AuditLog> = { action: AuditAction.LOGIN, actorId: 'user-1' };
      mockRepo.create.mockReturnValue({ id: 'log-1', ...dto } as AuditLog);
      mockRepo.save.mockRejectedValue(new Error('db down'));

      // 审计写失败绝不阻断业务：不 throw
      await expect(service.log(dto)).resolves.toBeUndefined();
    });
  });

  describe('findScoped — 权限矩阵', () => {
    it('agent 查自己 OK：where.actorId = In([自己])，scope 回声 = [自己]', async () => {
      const rows = [makeRow({ actorId: 'agent-1' })];
      mockRepo.findAndCount.mockResolvedValue([rows, 1]);

      const result = await service.findScoped({}, agentActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ actorId: In(['agent-1']) }),
          order: { createdAt: 'DESC' },
        }),
      );
      expect(result.scope).toEqual(['agent-1']);
      expect(result.total).toBe(1);
      expect(mockOwnerProxy.getOwnedAgentIds).not.toHaveBeenCalled();
    });

    it('agent 传他人 actorId → 收窄为自身 scope，scope 回声正确（不 403）', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.findScoped({ actorId: 'agent-999' }, agentActor);

      // 越权参数被忽略 → 按自身 scope 查
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ actorId: In(['agent-1']) }) }),
      );
      expect(result.scope).toEqual(['agent-1']);
    });

    it('human 非 admin 查自己 + 名下 agent（含软删 agent）：In([自己, ...owned])', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.findScoped({}, humanActor);

      expect(mockOwnerProxy.getOwnedAgentIds).toHaveBeenCalledWith(humanActor);
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ actorId: In(['human-1', 'agent-1', 'agent-2']) }),
        }),
      );
      expect(result.scope).toEqual(['human-1', 'agent-1', 'agent-2']);
    });

    it('human 传名下 agent 的 actorId → 精确过滤该 agent', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped({ actorId: 'agent-2' }, humanActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ actorId: In(['agent-2']) }) }),
      );
    });

    it('human 查他人 agent（不在名下）→ 收窄为自身 scope，看不到目标行', async () => {
      const rows = [makeRow({ actorId: 'agent-999', id: 'log-x' })];
      mockRepo.findAndCount.mockResolvedValue([rows, 1]);

      const result = await service.findScoped({ actorId: 'agent-999' }, humanActor);

      // 越权参数被忽略 → 按 scope 查（scope 不含 agent-999）
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ actorId: In(['human-1', 'agent-1', 'agent-2']) }),
        }),
      );
      expect(result.scope).toEqual(['human-1', 'agent-1', 'agent-2']);
    });

    it('admin 全量：无 actorId 过滤（含 actorId=null 行可见），scope = null', async () => {
      const rows = [makeRow({ actorId: null }), makeRow({ actorId: 'someone-else' })];
      mockRepo.findAndCount.mockResolvedValue([rows, 2]);

      const result = await service.findScoped({}, adminActor);

      // admin 全量：where 不含 actorId 键 → SQL 不排除 NULL 行
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ actorId: expect.anything() }),
        }),
      );
      expect(result.scope).toBeNull();
      expect(result.total).toBe(2);
      // admin 视图保留 ipAddress/userAgent/sessionId（不剔除）
      expect(result.items[0]).toHaveProperty('ipAddress');
      expect(result.items[0]).toHaveProperty('userAgent');
    });

    it('admin 传 actorId → 精确过滤任意 actor（不限本人）', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped({ actorId: 'someone-else' }, adminActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ actorId: 'someone-else' }) }),
      );
      expect(mockOwnerProxy.getOwnedAgentIds).not.toHaveBeenCalled();
    });

    it('actorId=null 行仅 admin 可见：非 admin 用 In(...) 查询 → SQL 天然排除 NULL', async () => {
      // mock 层验证非 admin 的 where 恒为 In(scope)（NULL 排除是 SQL 语义，
      // 真 PG 行为由 e2e activity-logs.e2e-spec.ts 覆盖）
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped({}, humanActor);

      const call = mockRepo.findAndCount.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.actorId).toEqual(In(['human-1', 'agent-1', 'agent-2']));
    });

    it('匿名 actor（防御）→ 空结果 + scope=[]', async () => {
      const result = await service.findScoped({}, null);

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
        scope: [],
      });
      expect(mockRepo.findAndCount).not.toHaveBeenCalled();
    });
  });

  describe('findScoped — 过滤组合', () => {
    it('entityType + action 透传 where', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped({ entityType: 'message', action: AuditAction.CREATE }, agentActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entityType: 'message',
            action: AuditAction.CREATE,
          }),
        }),
      );
    });

    it('from + to → Between 闭区间', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped(
        { from: '2026-08-27T00:00:00Z', to: '2026-08-27T23:59:59Z' },
        agentActor,
      );

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: Between(new Date('2026-08-27T00:00:00Z'), new Date('2026-08-27T23:59:59Z')),
          }),
        }),
      );
    });

    it('仅 from → MoreThanOrEqual（单边退化）', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped({ from: '2026-08-27T00:00:00Z' }, agentActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: MoreThanOrEqual(new Date('2026-08-27T00:00:00Z')),
          }),
        }),
      );
    });

    it('仅 to → LessThanOrEqual（单边退化）', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.findScoped({ to: '2026-08-27T23:59:59Z' }, agentActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: LessThanOrEqual(new Date('2026-08-27T23:59:59Z')),
          }),
        }),
      );
    });

    it('分页：page/pageSize 透传 skip/take，hasNext/hasPrev 正确', async () => {
      const rows = [makeRow()];
      mockRepo.findAndCount.mockResolvedValue([rows, 25]);

      const result = await service.findScoped({ page: 2, pageSize: 10 }, agentActor);

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.totalPages).toBe(3);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(true);
    });
  });

  describe('findScoped — actor 名解析与非 admin 剔除', () => {
    it('resolveProfiles 补齐 actorName/actorType/actorDeletedAt', async () => {
      const rows = [makeRow({ actorId: 'actor-1' })];
      mockRepo.findAndCount.mockResolvedValue([rows, 1]);
      mockActorProfile.resolveProfiles.mockResolvedValue(
        new Map([
          [
            'actor-1',
            {
              type: ActorType.AGENT,
              name: 'Prod Kimi',
              avatarUrl: null,
              description: null,
              deletedAt: new Date('2026-08-01T00:00:00Z'),
            },
          ],
        ]),
      );

      const result = await service.findScoped({}, agentActor);

      expect(mockActorProfile.resolveProfiles).toHaveBeenCalledWith(['actor-1']);
      expect(result.items[0].actorName).toBe('Prod Kimi');
      expect(result.items[0].actorType).toBe(ActorType.AGENT);
      expect(result.items[0].actorDeletedAt).toBe('2026-08-01T00:00:00.000Z');
    });

    it('真孤儿 actor（profile 无行）→ actorName/actorType/actorDeletedAt 兜底 null（R12）', async () => {
      const rows = [makeRow({ actorId: 'orphan-1' })];
      mockRepo.findAndCount.mockResolvedValue([rows, 1]);
      mockActorProfile.resolveProfiles.mockResolvedValue(new Map());

      const result = await service.findScoped({}, adminActor);

      expect(result.items[0].actorName).toBeNull();
      expect(result.items[0].actorType).toBeNull();
      expect(result.items[0].actorDeletedAt).toBeNull();
    });

    it('非 admin 响应剔除 ipAddress/userAgent/sessionId（最小披露，决策 7）', async () => {
      const rows = [makeRow()];
      mockRepo.findAndCount.mockResolvedValue([rows, 1]);

      const result = await service.findScoped({}, humanActor);

      expect(result.items[0]).not.toHaveProperty('ipAddress');
      expect(result.items[0]).not.toHaveProperty('userAgent');
      expect(result.items[0]).not.toHaveProperty('sessionId');
      // 业务字段保留
      expect(result.items[0]).toHaveProperty('newData');
      expect(result.items[0]).toHaveProperty('source');
      expect(result.items[0]).toHaveProperty('actorName');
    });
  });
});
