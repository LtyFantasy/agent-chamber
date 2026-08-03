import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog } from '../../database/entities/audit-log.entity';
import { AuditAction } from '@agent-chamber/shared';

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

describe('AuditService', () => {
  let service: AuditService;
  let mockRepo: jest.Mocked<Repository<AuditLog>>;

  beforeEach(async () => {
    mockRepo = createMockRepo<AuditLog>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [AuditService, { provide: getRepositoryToken(AuditLog), useValue: mockRepo }],
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
  });

  describe('findAll', () => {
    it('should return paginated results with default values', async () => {
      const items = [{ id: 'log-1' }] as AuditLog[];
      mockRepo.findAndCount.mockResolvedValue([items, 1]);

      const result = await service.findAll({});

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

      const result = await service.findAll({ page: 2, pageSize: 10 });

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
  });
});
