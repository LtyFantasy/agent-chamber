import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MilestoneService } from './milestone.service';
import { Milestone } from '../../database/entities/milestone.entity';
import { Task } from '../../database/entities/task.entity';
import { Board } from '../../database/entities/board.entity';
import { AccessQueryService } from '../../common/services/access-query.service';
import { PermissionService } from '../../common/services/permission.service';
import { ResourceValidator } from '../../common/resource-validator';
import { ErrorCode, MilestoneStatus, TaskStatus, UserRole, ActorType } from '@agent-chamber/shared';

describe('MilestoneService', () => {
  let service: MilestoneService;
  let milestoneRepo: jest.Mocked<Repository<Milestone>>;
  let taskRepo: jest.Mocked<Repository<Task>>;
  let boardRepo: jest.Mocked<Repository<Board>>;
  let accessQuery: jest.Mocked<AccessQueryService>;
  let resourceValidator: { exists: jest.Mock; existsMany: jest.Mock };
  let permService: { ensureCan: jest.Mock; can: jest.Mock };

  beforeEach(async () => {
    accessQuery = {
      getAccessibleBoardIds: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AccessQueryService>;

    resourceValidator = {
      exists: jest.fn().mockResolvedValue({ id: 'board-1' } as Board),
      existsMany: jest.fn().mockResolvedValue([]),
    };

    permService = {
      ensureCan: jest.fn().mockResolvedValue(undefined),
      can: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MilestoneService,
        {
          provide: getRepositoryToken(Milestone),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              skip: jest.fn().mockReturnThis(),
              take: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
            })),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Task),
          useValue: {
            find: jest.fn(),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Board),
          useValue: {
            findOne: jest.fn(),
          },
        },
        { provide: AccessQueryService, useValue: accessQuery },
        { provide: ResourceValidator, useValue: resourceValidator },
        { provide: PermissionService, useValue: permService },
      ],
    }).compile();

    service = module.get<MilestoneService>(MilestoneService);
    milestoneRepo = module.get(getRepositoryToken(Milestone));
    taskRepo = module.get(getRepositoryToken(Task));
    boardRepo = module.get(getRepositoryToken(Board));
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('should create a milestone', async () => {
      const dto = { name: 'v1.3.0', boardId: 'board-1', status: MilestoneStatus.ACTIVE };
      milestoneRepo.create.mockReturnValue({ id: 'ms-1', ...dto } as Milestone);
      milestoneRepo.save.mockResolvedValue({ id: 'ms-1', ...dto } as Milestone);

      const result = await service.create(dto, actor);

      expect(result.id).toBe('ms-1');
      expect(result.name).toBe(dto.name);
      // 方案 A：创建时写入创建者 Actor ID
      expect(milestoneRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ creatorId: actor.id }),
      );
      expect(resourceValidator.exists).toHaveBeenCalledWith(
        expect.anything(),
        'board-1',
        ErrorCode.BOARD_NOT_FOUND,
      );
      // D-B1-3: create = board read（不传 context）
      expect(permService.ensureCan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'board-1' }),
        actor,
        'read',
      );
    });

    it('should throw BOARD_NOT_FOUND when boardId does not exist', async () => {
      const dto = { name: 'v1.3.0', boardId: 'board-missing', status: MilestoneStatus.ACTIVE };
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND }),
      );

      await expect(service.create(dto, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.BOARD_NOT_FOUND },
      });
    });

    it('should reject creation when actor has no read access to board', async () => {
      const dto = { name: 'v1.3.0', boardId: 'board-1', status: MilestoneStatus.ACTIVE };
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(service.create(dto, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.PERMISSION_DENIED },
      });
    });
  });

  describe('findAll', () => {
    function createMockQueryBuilder(items: Milestone[], total: number) {
      const getManyAndCountMock = jest.fn().mockResolvedValue([items, total]);
      const andWhereMock = jest.fn().mockReturnThis();
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: andWhereMock,
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getManyAndCount: getManyAndCountMock,
      } as unknown as any;
    }

    it('should return paginated milestones with stats', async () => {
      const items = [{ id: 'ms-1', name: 'v1.3.0' }] as Milestone[];
      const qb = createMockQueryBuilder(items, 1);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.find.mockResolvedValue([
        { milestoneId: 'ms-1', status: TaskStatus.DONE } as Task,
        { milestoneId: 'ms-1', status: TaskStatus.IN_PROGRESS } as Task,
        { milestoneId: 'ms-1', status: TaskStatus.TODO } as Task,
      ]);

      const result = await service.findAll({});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].stats).toEqual({ total: 3, done: 1, inProgress: 1, open: 1 });
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });

    it('should filter by boardId', async () => {
      const qb = createMockQueryBuilder([], 0);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ boardId: 'board-1' });

      expect(qb.andWhere).toHaveBeenCalledWith('milestone.board_id = :boardId', {
        boardId: 'board-1',
      });
    });

    it('should not add IN filter for admin actor', async () => {
      const items = [{ id: 'ms-1', name: 'v1.3.0' }] as Milestone[];
      const qb = createMockQueryBuilder(items, 1);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);
      accessQuery.getAccessibleBoardIds.mockResolvedValue(null);
      taskRepo.find.mockResolvedValue([]);

      const adminActor = { id: 'admin-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
      await service.findAll({}, adminActor);

      expect(accessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(adminActor);
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'milestone.board_id IN (:...accessibleBoardIds)',
        expect.anything(),
      );
    });

    it('should add IN filter for non-admin actor', async () => {
      const items = [{ id: 'ms-1', name: 'v1.3.0', boardId: 'board-1' }] as Milestone[];
      const qb = createMockQueryBuilder(items, 1);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);
      accessQuery.getAccessibleBoardIds.mockResolvedValue(['board-1']);
      taskRepo.find.mockResolvedValue([]);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({}, actor);

      expect(accessQuery.getAccessibleBoardIds).toHaveBeenCalledWith(actor);
      expect(qb.andWhere).toHaveBeenCalledWith(
        'milestone.board_id IN (:...accessibleBoardIds)',
        { accessibleBoardIds: ['board-1'] },
      );
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('should return empty pagination when accessible board ids is empty', async () => {
      accessQuery.getAccessibleBoardIds.mockResolvedValue([]);

      const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const result = await service.findAll({ page: 1, pageSize: 20 }, actor);

      expect(milestoneRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      });
    });

    it('should only calculate stats for filtered milestones', async () => {
      const items = [{ id: 'ms-1', name: 'v1.3.0' }] as Milestone[];
      const qb = createMockQueryBuilder(items, 1);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.find.mockResolvedValue([
        { milestoneId: 'ms-1', status: TaskStatus.DONE } as Task,
        // 越权 milestone 的任务不应被统计
        { milestoneId: 'ms-2', status: TaskStatus.DONE } as Task,
      ]);

      const result = await service.findAll({});

      expect(taskRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { milestoneId: In(['ms-1']) } }),
      );
      expect(result.items[0].stats).toEqual({ total: 1, done: 1, inProgress: 0, open: 0 });
    });
  });

  describe('findOne', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('should return milestone with stats only, no embedded tasks', async () => {
      const milestone = {
        id: 'ms-1',
        name: 'v1.3.0',
        boardId: 'board-1',
      } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      taskRepo.find.mockResolvedValue([
        { status: TaskStatus.DONE } as Task,
        { status: TaskStatus.IN_PROGRESS } as Task,
        { status: TaskStatus.TODO } as Task,
        { status: TaskStatus.ARCHIVED } as Task,
      ]);

      const result = await service.findOne('ms-1', actor);

      // 不再使用 relations: ['tasks']，避免一次性返回全部 Task 实体
      expect(milestoneRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ms-1' } }),
      );
      // D-B1-3: findOne = board read
      expect(resourceValidator.exists).toHaveBeenCalledWith(
        expect.anything(),
        'board-1',
        ErrorCode.BOARD_NOT_FOUND,
      );
      expect(permService.ensureCan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'board-1' }),
        actor,
        'read',
      );
      expect(result.stats).toEqual({ total: 4, done: 2, inProgress: 1, open: 1 });
      // 响应不应包含 tasks 键
      expect(result).not.toHaveProperty('tasks');
    });

    it('should throw when milestone not found', async () => {
      milestoneRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('ms-1', actor)).rejects.toThrow(NotFoundException);
      await expect(service.findOne('ms-1', actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_NOT_FOUND },
      });
    });

    it('should reject when board not found for the milestone', async () => {
      const milestone = {
        id: 'ms-1',
        name: 'v1.3.0',
        boardId: 'board-1',
      } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND }),
      );

      await expect(service.findOne('ms-1', actor)).rejects.toMatchObject({
        response: { code: ErrorCode.BOARD_NOT_FOUND },
      });
    });

    it('should reject when actor has no read access to board', async () => {
      const milestone = {
        id: 'ms-1',
        name: 'v1.3.0',
        boardId: 'board-1',
      } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      permService.ensureCan.mockRejectedValue(
        new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND }),
      );

      await expect(service.findOne('ms-1', actor)).rejects.toMatchObject({
        response: { code: ErrorCode.BOARD_NOT_FOUND },
      });
    });
  });

  describe('update', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('should update a milestone', async () => {
      const milestone = {
        id: 'ms-1',
        name: 'v1.3.0',
        boardId: 'board-1',
        status: MilestoneStatus.PLANNED,
      } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockResolvedValue({
        ...milestone,
        name: 'v1.3.1',
        status: MilestoneStatus.ACTIVE,
      } as Milestone);

      const result = await service.update('ms-1', {
        name: 'v1.3.1',
        status: MilestoneStatus.ACTIVE,
      }, actor);

      expect(result.name).toBe('v1.3.1');
      expect(result.status).toBe(MilestoneStatus.ACTIVE);
      // D-B1-3: update = board write（非 creator）
      expect(permService.ensureCan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'board-1' }),
        actor,
        'write',
      );
    });

    it('should throw when milestone not found', async () => {
      milestoneRepo.findOne.mockResolvedValue(null);

      await expect(service.update('ms-1', {}, actor)).rejects.toThrow(NotFoundException);
    });

    it('should throw BOARD_NOT_FOUND when boardId changed to non-existent board', async () => {
      const milestone = { id: 'ms-1', name: 'v1.3.0', boardId: 'board-1' } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      resourceValidator.exists.mockRejectedValue(
        new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND }),
      );

      await expect(
        service.update('ms-1', { boardId: 'board-missing' }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.BOARD_NOT_FOUND } });
    });

    it('should reject update when actor lacks write permission on board', async () => {
      const milestone = { id: 'ms-1', name: 'v1.3.0', boardId: 'board-1' } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(service.update('ms-1', { name: 'x' }, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.PERMISSION_DENIED },
      });
    });

    it('should allow creator to update without checking board write permission', async () => {
      // 方案 A 核心：milestone.creatorId === actor.id 时直接放行，不查询 board 写权限
      const milestone = {
        id: 'ms-1',
        name: 'v1.3.0',
        boardId: 'board-1',
        creatorId: actor.id,
      } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockResolvedValue({ ...milestone, name: 'v1.3.1' } as Milestone);

      const result = await service.update('ms-1', { name: 'v1.3.1' }, actor);

      expect(result.name).toBe('v1.3.1');
      expect(permService.ensureCan).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('should remove milestone and cascade clear task milestoneIds', async () => {
      const milestone = { id: 'ms-1', boardId: 'board-1' } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);

      const result = await service.remove('ms-1', actor);

      // D-B1-3: remove = board write（非 creator）
      expect(permService.ensureCan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'board-1' }),
        actor,
        'write',
      );
      expect(taskRepo.update).toHaveBeenCalledWith({ milestoneId: 'ms-1' }, { milestoneId: null });
      expect(milestoneRepo.remove).toHaveBeenCalledWith(milestone);
      expect(result).toBe(true);
    });

    it('should throw when milestone not found', async () => {
      milestoneRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('ms-1', actor)).rejects.toThrow(NotFoundException);
    });

    it('should reject removal when actor lacks write permission on board', async () => {
      const milestone = { id: 'ms-1', boardId: 'board-1' } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(service.remove('ms-1', actor)).rejects.toMatchObject({
        response: { code: ErrorCode.PERMISSION_DENIED },
      });
    });

    it('should allow creator to remove without checking board write permission', async () => {
      // 方案 A 核心：milestone.creatorId === actor.id 时直接放行，不查询 board 写权限
      const milestone = { id: 'ms-1', boardId: 'board-1', creatorId: actor.id } as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);

      const result = await service.remove('ms-1', actor);

      expect(permService.ensureCan).not.toHaveBeenCalled();
      expect(taskRepo.update).toHaveBeenCalledWith({ milestoneId: 'ms-1' }, { milestoneId: null });
      expect(milestoneRepo.remove).toHaveBeenCalledWith(milestone);
      expect(result).toBe(true);
    });
  });
});
