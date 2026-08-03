import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, ObjectLiteral } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ErrorCode } from '@agent-chamber/shared';
import { WebhookService } from './webhook.service';
import { WebhookDelivery } from '../../database/entities/webhook-delivery.entity';

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

describe('WebhookService', () => {
  let service: WebhookService;
  let mockRepo: jest.Mocked<Repository<WebhookDelivery>>;

  beforeEach(async () => {
    mockRepo = createMockRepo<WebhookDelivery>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: getRepositoryToken(WebhookDelivery), useValue: mockRepo },
      ],
    }).compile();

    service = moduleRef.get<WebhookService>(WebhookService);
  });

  describe('findAll', () => {
    it('should return paginated results with default values', async () => {
      const items = [{ id: 'wh-1' }] as WebhookDelivery[];
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
      const items = [{ id: 'wh-2' }] as WebhookDelivery[];
      mockRepo.findAndCount.mockResolvedValue([items, 30]);

      const result = await service.findAll({ page: 2, pageSize: 15 });

      expect(mockRepo.findAndCount).toHaveBeenCalledWith({
        skip: 15,
        take: 15,
        order: { createdAt: 'DESC' },
      });
      expect(result).toEqual({
        items,
        total: 30,
        page: 2,
        pageSize: 15,
        totalPages: 2,
        hasNext: false,
        hasPrev: true,
      });
    });

    it('should handle empty results', async () => {
      mockRepo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.findAll({ page: 1, pageSize: 10 });

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });
  });

  describe('findOne', () => {
    it('should return a webhook delivery by id', async () => {
      const webhook = { id: 'wh-1', status: 'success' } as WebhookDelivery;
      mockRepo.findOne.mockResolvedValue(webhook);

      const result = await service.findOne('wh-1');

      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
      expect(result).toEqual(webhook);
    });

    it('should throw NotFoundException when webhook is not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('not-found')).rejects.toThrow(NotFoundException);
      await expect(service.findOne('not-found')).rejects.toMatchObject({
        response: {
          message: 'Webhook not found',
          code: ErrorCode.NOT_FOUND,
        },
      });
      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { id: 'not-found' } });
    });
  });

  describe('test', () => {
    it('should create and save a simulated webhook log', async () => {
      const dto = { url: 'http://example.com/webhook', payload: { event: 'test' } };
      const createdLog = {
        id: 'wh-test',
        targetUrl: dto.url,
        payload: dto.payload,
      } as unknown as WebhookDelivery;
      const savedLog = { ...createdLog } as unknown as WebhookDelivery;

      mockRepo.create.mockReturnValue(createdLog);
      mockRepo.save.mockResolvedValue(savedLog);

      const result = await service.test(dto);

      expect(mockRepo.create).toHaveBeenCalledWith({
        agentId: '00000000-0000-0000-0000-000000000000',
        eventType: 'system',
        targetUrl: dto.url,
        payload: dto.payload,
        status: 'success',
        responseStatus: 200,
      });
      expect(mockRepo.save).toHaveBeenCalledWith(createdLog);
      expect(result).toEqual({
        success: true,
        message: 'Webhook test simulated',
        log: savedLog,
      });
    });
  });
});
