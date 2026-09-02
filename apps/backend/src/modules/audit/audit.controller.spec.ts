import { Test, TestingModule } from '@nestjs/testing';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { UnifiedActor } from '../../common/types/actor.types';

describe('AuditController', () => {
  let controller: AuditController;
  let service: typeof mockService;

  const mockService = {
    findScoped: jest.fn(),
  };

  const actor: UnifiedActor = {
    id: 'human-1',
    type: ActorType.HUMAN,
    name: 'Human 1',
    role: UserRole.EDITOR,
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useValue: mockService }],
    })
      // 方法级 @UseGuards(JwtOrApiKeyGuard) 会触发 guard 依赖解析（JwtService/
      // ConfigService/UserRepo/ApiKeyAuthService）——override 掉，与 topic 先例一致；
      // findAll 的 JwtAuthGuard 构造依赖 ApiKeyAuthService（B-59 起）同样 override
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<AuditController>(AuditController);
    service = moduleRef.get<AuditService>(AuditService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('findActivityLogs (GET /activity-logs)', () => {
    it('should call service.findScoped with query and current actor', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20, scope: ['human-1'] };
      service.findScoped.mockResolvedValue(result);

      const query = { page: 2, pageSize: 10, entityType: 'message' };
      expect(await controller.findActivityLogs(query, actor)).toBe(result);
      expect(service.findScoped).toHaveBeenCalledWith(query, actor);
    });
  });

  describe('findAll (GET /audit, admin-only)', () => {
    it('should call service.findScoped with query and current actor (admin scope)', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20, scope: null };
      service.findScoped.mockResolvedValue(result);

      const adminActor: UnifiedActor = {
        id: 'admin-1',
        type: ActorType.HUMAN,
        name: 'Admin',
        role: UserRole.ADMIN,
      };
      const query = { page: 2, pageSize: 10 };
      expect(await controller.findAll(query, adminActor)).toBe(result);
      expect(service.findScoped).toHaveBeenCalledWith(query, adminActor);
    });
  });
});
