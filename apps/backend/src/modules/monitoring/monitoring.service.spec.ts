import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { MonitoringService } from './monitoring.service';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AuditAction, ActorType } from '@agent-chamber/shared';

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

describe('MonitoringService', () => {
  let service: MonitoringService;
  let mockRepo: jest.Mocked<Repository<AuditLog>>;

  beforeEach(async () => {
    mockRepo = createMockRepo<AuditLog>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [MonitoringService, { provide: getRepositoryToken(AuditLog), useValue: mockRepo }],
    }).compile();

    service = moduleRef.get<MonitoringService>(MonitoringService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getApiLogs', () => {
    it('should return paginated results with default values', async () => {
      const items = [
        {
          id: 'log-1',
          action: AuditAction.LOGIN,
          entityType: 'user',
          entityId: 'user-1',
          actorId: 'user-1',
          actorType: ActorType.HUMAN,
          ipAddress: '127.0.0.1',
          createdAt: new Date(),
        },
      ] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 1]);

      const result = await service.getApiLogs({});

      expect(mockRepo.findAndCount).toHaveBeenCalledWith({
        skip: 0,
        take: 20,
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        items,
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('should return paginated results with custom page and pageSize', async () => {
      const items = [{ id: 'log-2' }] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 25]);

      const result = await service.getApiLogs({ page: 2, pageSize: 10 });

      expect(mockRepo.findAndCount).toHaveBeenCalledWith({
        skip: 10,
        take: 10,
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        items,
        total: 25,
        page: 2,
        pageSize: 10,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });
    });

    it('should handle empty results', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.getApiLogs({ page: 3, pageSize: 5 });

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

    it('should handle last page correctly', async () => {
      const items = [{ id: 'log-3' }] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 21]);

      const result = await service.getApiLogs({ page: 2, pageSize: 20 });

      expect(result).toEqual({
        items,
        total: 21,
        page: 2,
        pageSize: 20,
        totalPages: 2,
        hasNext: false,
        hasPrev: true,
      });
    });
  });

  describe('exportApiLogs', () => {
    it('should return exported logs with count and timestamp', async () => {
      const logs = [
        { id: 'log-1', action: AuditAction.LOGIN },
        { id: 'log-2', action: AuditAction.CREATE },
      ] as AuditLog[];
      mockRepo.find.mockResolvedValue(logs);

      const result = await service.exportApiLogs({});

      expect(mockRepo.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        take: 1000,
      });
      expect(result.data).toEqual(logs);
      expect(result.count).toBe(2);
      expect(result.exportedAt).toBeDefined();
      expect(new Date(result.exportedAt).toISOString()).toBe(result.exportedAt);
    });

    it('should handle empty logs export', async () => {
      mockRepo.find.mockResolvedValue([]);

      const result = await service.exportApiLogs({});

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.exportedAt).toBeDefined();
    });
  });
});
