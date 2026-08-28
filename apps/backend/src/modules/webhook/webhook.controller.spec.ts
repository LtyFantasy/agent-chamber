import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '@agent-chamber/shared';

describe('WebhookController', () => {
  let controller: WebhookController;
  let service: typeof mockService;
  let auditService: { log: jest.Mock };

  const mockService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    test: jest.fn(),
  };
  const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: mockService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<WebhookController>(WebhookController);
    service = moduleRef.get<WebhookService>(WebhookService) as unknown as typeof service;
    auditService = moduleRef.get<AuditService>(AuditService) as unknown as { log: jest.Mock };
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should call service.findAll with query and return result', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.findAll.mockResolvedValue(result);

      const query = { page: 2, pageSize: 10 };
      expect(await controller.findAll(query)).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith(query);
    });
  });

  describe('findOne', () => {
    it('should call service.findOne with id and return result', async () => {
      const result = { id: 'wh-1' };
      service.findOne.mockResolvedValue(result);

      expect(await controller.findOne('wh-1')).toBe(result);
      expect(service.findOne).toHaveBeenCalledWith('wh-1');
    });
  });

  describe('test', () => {
    it('should call service.test with dto and return result', async () => {
      const dto = { url: 'http://example.com/webhook', payload: { event: 'test' } };
      const result = { success: true, message: 'Webhook test simulated', log: { id: 'wh-test' } };
      service.test.mockResolvedValue(result);

      expect(await controller.test(dto, 'admin-1')).toBe(result);
      expect(service.test).toHaveBeenCalledWith(dto);
      // 审计（Phase 2）：CREATE + webhook_delivery；newData 只记域名部分，payload 不入
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'create',
        entityType: 'webhook_delivery',
        entityId: 'wh-test',
        actorId: 'admin-1',
        newData: { deliveryId: 'wh-test', targetUrl: 'example.com' },
        source: 'api',
      });
    });
  });

  describe('guards and roles', () => {
    it('should require ADMIN role decorator at class level', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, WebhookController);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard at class level', () => {
      const guards = Reflect.getMetadata('__guards__', WebhookController);
      expect(guards).toBeDefined();
      const guardClasses = guards.map((g: unknown) =>
        (g as { name?: string }).name
          ? (g as { name?: string }).name
          : (g as { constructor?: { name?: string } }).constructor?.name || g,
      );
      expect(guardClasses).toContain('JwtAuthGuard');
      expect(guardClasses).toContain('RolesGuard');
    });
  });
});
