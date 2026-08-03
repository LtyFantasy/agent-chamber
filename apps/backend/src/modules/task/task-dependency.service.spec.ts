import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TaskDependencyService } from './task-dependency.service';
import { TaskDependency } from '../../database/entities/task-dependency.entity';
import { Task } from '../../database/entities/task.entity';
import { ErrorCode, TaskDependencyType, TaskStatus } from '@agent-chamber/shared';

describe('TaskDependencyService', () => {
  let service: TaskDependencyService;
  let depRepo: jest.Mocked<Repository<TaskDependency>>;
  let taskRepo: jest.Mocked<Repository<Task>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskDependencyService,
        {
          provide: getRepositoryToken(TaskDependency),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(() => ({
              leftJoinAndSelect: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getMany: jest.fn(),
            })),
          },
        },
        {
          provide: getRepositoryToken(Task),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TaskDependencyService>(TaskDependencyService);
    depRepo = module.get(getRepositoryToken(TaskDependency));
    taskRepo = module.get(getRepositoryToken(Task));
  });

  afterEach(() => jest.clearAllMocks());

  describe('addDependency', () => {
    it('should add a dependency successfully', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-b', type: TaskDependencyType.BLOCKS };
      taskRepo.findOne.mockResolvedValue({ id: 'task-b' } as Task);
      depRepo.findOne.mockResolvedValue(null);
      depRepo.find.mockResolvedValue([]);
      depRepo.create.mockReturnValue({ id: 'dep-1', ...dto, taskId } as TaskDependency);
      depRepo.save.mockResolvedValue({ id: 'dep-1', ...dto, taskId } as TaskDependency);

      const result = await service.addDependency(taskId, dto);

      expect(result.taskId).toBe(taskId);
      expect(result.dependsOnTaskId).toBe(dto.dependsOnTaskId);
      expect(result.type).toBe(dto.type);
    });

    it('should reject self-dependency', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-a' };

      await expect(service.addDependency(taskId, dto)).rejects.toThrow(BadRequestException);
      await expect(service.addDependency(taskId, dto)).rejects.toMatchObject({
        response: { code: ErrorCode.TASK_DEPENDENCY_SELF },
      });
    });

    it('should reject when target task not found', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-b' };
      taskRepo.findOne.mockResolvedValue(null);

      await expect(service.addDependency(taskId, dto)).rejects.toThrow(NotFoundException);
    });

    it('should reject duplicate dependency', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-b' };
      taskRepo.findOne.mockResolvedValue({ id: 'task-b' } as Task);
      depRepo.findOne.mockResolvedValue({ id: 'dep-1' } as TaskDependency);

      await expect(service.addDependency(taskId, dto)).rejects.toThrow(BadRequestException);
      await expect(service.addDependency(taskId, dto)).rejects.toMatchObject({
        response: { code: ErrorCode.TASK_ALREADY_DEPENDS },
      });
    });

    it('should detect direct cycle (A → B → A)', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-b' };
      taskRepo.findOne.mockResolvedValue({ id: 'task-b' } as Task);
      depRepo.findOne.mockResolvedValue(null);
      // B 依赖 A，形成循环
      depRepo.find.mockImplementation(async (opts) => {
        if ((opts as unknown as { where?: { taskId?: string } }).where?.taskId === 'task-b') {
          return [{ dependsOnTaskId: 'task-a' } as TaskDependency];
        }
        return [];
      });

      await expect(service.addDependency(taskId, dto)).rejects.toThrow(BadRequestException);
      await expect(service.addDependency(taskId, dto)).rejects.toMatchObject({
        response: { code: ErrorCode.TASK_DEPENDENCY_CYCLE },
      });
    });

    it('should detect indirect cycle (A → B → C → A)', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-b' };
      taskRepo.findOne.mockResolvedValue({ id: 'task-b' } as Task);
      depRepo.findOne.mockResolvedValue(null);
      depRepo.find.mockImplementation(async (opts) => {
        const map: Record<string, string[]> = {
          'task-b': ['task-c'],
          'task-c': ['task-a'],
        };
        const taskId = (opts as unknown as { where?: { taskId?: string } }).where?.taskId;
        const deps = taskId ? map[taskId] || [] : [];
        return deps.map((d: string) => ({ dependsOnTaskId: d }) as TaskDependency);
      });

      await expect(service.addDependency(taskId, dto)).rejects.toThrow(BadRequestException);
      await expect(service.addDependency(taskId, dto)).rejects.toMatchObject({
        response: { code: ErrorCode.TASK_DEPENDENCY_CYCLE },
      });
    });

    it('should allow non-cyclic dependency', async () => {
      const taskId = 'task-a';
      const dto = { dependsOnTaskId: 'task-b' };
      taskRepo.findOne.mockResolvedValue({ id: 'task-b' } as Task);
      depRepo.findOne.mockResolvedValue(null);
      // B 依赖 C，C 不依赖任何人 — 无循环
      depRepo.find.mockImplementation(async (opts) => {
        const map: Record<string, string[]> = {
          'task-b': ['task-c'],
          'task-c': [],
        };
        const taskId = (opts as unknown as { where?: { taskId?: string } }).where?.taskId;
        const deps = taskId ? map[taskId] || [] : [];
        return deps.map((d: string) => ({ dependsOnTaskId: d }) as TaskDependency);
      });
      depRepo.create.mockReturnValue({ id: 'dep-1', ...dto, taskId } as TaskDependency);
      depRepo.save.mockResolvedValue({ id: 'dep-1', ...dto, taskId } as TaskDependency);

      const result = await service.addDependency(taskId, dto);
      expect(result.taskId).toBe(taskId);
    });
  });

  describe('removeDependency', () => {
    it('should remove a dependency', async () => {
      depRepo.findOne.mockResolvedValue({ id: 'dep-1', taskId: 'task-a' } as TaskDependency);

      const result = await service.removeDependency('task-a', 'dep-1');

      expect(result).toBe(true);
      expect(depRepo.remove).toHaveBeenCalled();
    });

    it('should throw when dependency not found', async () => {
      depRepo.findOne.mockResolvedValue(null);

      await expect(service.removeDependency('task-a', 'dep-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findBlockers', () => {
    it('should return only incomplete blocks dependencies', async () => {
      // findBlockers 会传入 where: { taskId, type: BLOCKS }，mock 只返回 BLOCKS 类型的
      depRepo.find.mockResolvedValue([
        {
          type: TaskDependencyType.BLOCKS,
          dependsOnTask: { status: TaskStatus.IN_PROGRESS },
        } as TaskDependency,
        {
          type: TaskDependencyType.BLOCKS,
          dependsOnTask: { status: TaskStatus.DONE },
        } as TaskDependency,
      ]);

      const result = await service.findBlockers('task-a');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe(TaskDependencyType.BLOCKS);
      expect(result[0].dependsOnTask.status).toBe(TaskStatus.IN_PROGRESS);
    });
  });

  describe('hasBlockers', () => {
    it('should return blockers map for multiple tasks', async () => {
      const mockGetMany = jest
        .fn()
        .mockResolvedValue([
          { taskId: 'task-a' } as TaskDependency,
          { taskId: 'task-c' } as TaskDependency,
        ]);
      depRepo.createQueryBuilder.mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: mockGetMany,
      } as unknown as SelectQueryBuilder<TaskDependency>);

      const result = await service.hasBlockers(['task-a', 'task-b', 'task-c']);

      expect(result['task-a']).toBe(true);
      expect(result['task-b']).toBe(false);
      expect(result['task-c']).toBe(true);
    });

    it('should return empty map for empty input', async () => {
      const result = await service.hasBlockers([]);
      expect(result).toEqual({});
    });
  });
});
