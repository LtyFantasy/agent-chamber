/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.1 (整体架构)
 *   - 补充: AGENTS.md §2.6 输入校验与资源存在性校验铁律
 *
 * [踩坑索引]
 *
 * [铁律关联] #21(双层校验) #22(findOne必须判空) #17(测试契约)
 *
 * [详细踩坑]（最多 5 条）
 *   （暂无）
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, In, ObjectLiteral } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ResourceValidator } from './resource-validator';
import { ErrorCode } from '@agent-chamber/shared';
import { Topic } from '../database/entities/topic.entity';

type MockRepo<T extends ObjectLiteral> = {
  findOne: jest.Mock;
  findBy: jest.Mock;
} & jest.Mocked<Repository<T>>;

describe('ResourceValidator', () => {
  let validator: ResourceValidator;
  let mockRepo: MockRepo<Topic>;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      findBy: jest.fn(),
    } as unknown as MockRepo<Topic>;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [ResourceValidator],
    }).compile();

    validator = moduleRef.get<ResourceValidator>(ResourceValidator);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('exists', () => {
    it('should return entity when resource exists', async () => {
      const entity = { id: 'topic-1', title: 'Test' } as Topic;
      mockRepo.findOne.mockResolvedValue(entity);

      const result = await validator.exists(
        mockRepo as unknown as Repository<Topic>,
        'topic-1',
        ErrorCode.TOPIC_NOT_FOUND,
      );

      expect(result).toBe(entity);
      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'topic-1' },
      });
    });

    it('should pass options to findOne', async () => {
      const entity = { id: 'topic-1', title: 'Test' } as Topic;
      mockRepo.findOne.mockResolvedValue(entity);

      await validator.exists(
        mockRepo as unknown as Repository<Topic>,
        'topic-1',
        ErrorCode.TOPIC_NOT_FOUND,
        { relations: ['participants'], withDeleted: true },
      );

      expect(mockRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'topic-1' },
        relations: ['participants'],
        withDeleted: true,
      });
    });

    it('should throw NotFoundException with correct code when resource not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(
        validator.exists(
          mockRepo as unknown as Repository<Topic>,
          'topic-missing',
          ErrorCode.TOPIC_NOT_FOUND,
        ),
      ).rejects.toThrow(NotFoundException);

      try {
        await validator.exists(
          mockRepo as unknown as Repository<Topic>,
          'topic-missing',
          ErrorCode.TOPIC_NOT_FOUND,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toMatchObject({
          message: 'Resource not found',
          code: ErrorCode.TOPIC_NOT_FOUND,
        });
      }
    });
  });

  describe('existsMany', () => {
    it('should return entities when all resources exist', async () => {
      const entities = [
        { id: 'agent-1', title: 'Agent 1' },
        { id: 'agent-2', title: 'Agent 2' },
      ] as Topic[];
      mockRepo.findBy.mockResolvedValue(entities);

      const result = await validator.existsMany(
        mockRepo as unknown as Repository<Topic>,
        ['agent-1', 'agent-2'],
        ErrorCode.AGENT_NOT_FOUND,
      );

      expect(result).toEqual(entities);
      expect(mockRepo.findBy).toHaveBeenCalledWith({ id: In(['agent-1', 'agent-2']) });
    });

    it('should return empty array when ids is empty', async () => {
      const result = await validator.existsMany(
        mockRepo as unknown as Repository<Topic>,
        [],
        ErrorCode.AGENT_NOT_FOUND,
      );

      expect(result).toEqual([]);
      expect(mockRepo.findBy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when some resources not found', async () => {
      mockRepo.findBy.mockResolvedValue([{ id: 'agent-1' }] as Topic[]);

      await expect(
        validator.existsMany(
          mockRepo as unknown as Repository<Topic>,
          ['agent-1', 'agent-2'],
          ErrorCode.AGENT_NOT_FOUND,
        ),
      ).rejects.toThrow(NotFoundException);

      try {
        await validator.existsMany(
          mockRepo as unknown as Repository<Topic>,
          ['agent-1', 'agent-2'],
          ErrorCode.AGENT_NOT_FOUND,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toMatchObject({
          message: 'Some resources not found',
          code: ErrorCode.AGENT_NOT_FOUND,
        });
      }
    });
  });
});
