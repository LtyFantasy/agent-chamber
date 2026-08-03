import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '@agent-chamber/shared';

describe('MonitoringController', () => {
  let controller: MonitoringController;
  let service: typeof mockService;

  const mockService = {
    getApiLogs: jest.fn(),
    exportApiLogs: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [MonitoringController],
      providers: [{ provide: MonitoringService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<MonitoringController>(MonitoringController);
    service = moduleRef.get<MonitoringService>(MonitoringService) as unknown as typeof service;
  });

  afterEach(() => jest.clearAllMocks());

  describe('getApiLogs', () => {
    it('should call service.getApiLogs with query and return result', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.getApiLogs.mockResolvedValue(result);

      const query = { page: 2, pageSize: 10 };
      expect(await controller.getApiLogs(query)).toBe(result);
      expect(service.getApiLogs).toHaveBeenCalledWith(query);
    });

    it('should call service.getApiLogs with empty query', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.getApiLogs.mockResolvedValue(result);

      expect(await controller.getApiLogs({})).toBe(result);
      expect(service.getApiLogs).toHaveBeenCalledWith({});
    });
  });

  describe('exportApiLogs', () => {
    it('should call service.exportApiLogs with query and return result', async () => {
      const result = { data: [], count: 0, exportedAt: new Date().toISOString() };
      service.exportApiLogs.mockResolvedValue(result);

      const query = { startDate: '2024-01-01' };
      expect(await controller.exportApiLogs(query)).toBe(result);
      expect(service.exportApiLogs).toHaveBeenCalledWith(query);
    });

    it('should call service.exportApiLogs with empty query', async () => {
      const result = { data: [], count: 0, exportedAt: new Date().toISOString() };
      service.exportApiLogs.mockResolvedValue(result);

      expect(await controller.exportApiLogs({})).toBe(result);
      expect(service.exportApiLogs).toHaveBeenCalledWith({});
    });
  });

  describe('guards and roles', () => {
    it('should require ADMIN role decorator at class level', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, MonitoringController);
      expect(roles).toContain(UserRole.ADMIN);
    });

    it('should require JwtAuthGuard and RolesGuard at class level', () => {
      const guards = Reflect.getMetadata('__guards__', MonitoringController);
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
