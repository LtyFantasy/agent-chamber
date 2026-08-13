import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
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

    it('should default status to dev when version is set', async () => {
      const dto = { name: 'v1.42.0', boardId: 'board-1', version: '1.42.0' };
      milestoneRepo.create.mockReturnValue({
        id: 'ms-1',
        ...dto,
        status: MilestoneStatus.DEV,
      } as unknown as Milestone);
      milestoneRepo.save.mockResolvedValue({
        id: 'ms-1',
        ...dto,
        status: MilestoneStatus.DEV,
      } as unknown as Milestone);

      const result = await service.create(dto, actor);

      expect(result.status).toBe(MilestoneStatus.DEV);
      expect(milestoneRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: MilestoneStatus.DEV, version: '1.42.0' }),
      );
    });

    it('should accept explicit ready status when version is set', async () => {
      const dto = {
        name: 'v1.42.0',
        boardId: 'board-1',
        version: '1.42.0',
        status: MilestoneStatus.READY,
      };
      milestoneRepo.create.mockReturnValue({ id: 'ms-1', ...dto } as unknown as Milestone);
      milestoneRepo.save.mockResolvedValue({ id: 'ms-1', ...dto } as unknown as Milestone);

      const result = await service.create(dto, actor);

      expect(result.status).toBe(MilestoneStatus.READY);
    });

    it.each([
      MilestoneStatus.PLANNED,
      MilestoneStatus.ACTIVE,
      MilestoneStatus.COMPLETED,
      MilestoneStatus.CANCELLED,
      MilestoneStatus.VERIFIED,
    ])('should reject explicit %s status when version is set', async (status) => {
      const dto = { name: 'v1.42.0', boardId: 'board-1', version: '1.42.0', status };

      await expect(service.create(dto, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION },
      });
      expect(milestoneRepo.save).not.toHaveBeenCalled();
    });

    it('should reject explicit deployed status when version is set (deploy via endpoint only)', async () => {
      const dto = {
        name: 'v1.42.0',
        boardId: 'board-1',
        version: '1.42.0',
        status: MilestoneStatus.DEPLOYED,
      };

      await expect(service.create(dto, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT },
      });
    });

    it.each([
      MilestoneStatus.DEV,
      MilestoneStatus.READY,
      MilestoneStatus.DEPLOYED,
      MilestoneStatus.VERIFIED,
    ])(
      'should reject %s status for normal milestone without version (普通态隔离)',
      async (status) => {
        const dto = { name: 'S1', boardId: 'board-1', status };

        await expect(service.create(dto, actor)).rejects.toMatchObject({
          response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION },
        });
      },
    );

    it('should keep normal milestone behavior unchanged without version', async () => {
      const dto = { name: 'S1', boardId: 'board-1', status: MilestoneStatus.ACTIVE };
      milestoneRepo.create.mockReturnValue({ id: 'ms-1', ...dto } as Milestone);
      milestoneRepo.save.mockResolvedValue({ id: 'ms-1', ...dto } as Milestone);

      const result = await service.create(dto, actor);

      expect(result.status).toBe(MilestoneStatus.ACTIVE);
    });

    it('should translate version unique violation to 409 on create', async () => {
      const dto = { name: 'v1.42.0', boardId: 'board-1', version: '1.42.0' };
      milestoneRepo.create.mockReturnValue({ id: 'ms-1', ...dto } as unknown as Milestone);
      milestoneRepo.save.mockRejectedValue({
        code: '23505',
        constraint: 'uq_milestones_board_version',
      });

      await expect(service.create(dto, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_VERSION_CONFLICT },
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
      expect(qb.andWhere).toHaveBeenCalledWith('milestone.board_id IN (:...accessibleBoardIds)', {
        accessibleBoardIds: ['board-1'],
      });
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

    it('should project list items: body -> bodySnippet(300), no deployMeta, no body', async () => {
      // 列表投影契约（响应体积规范）：body 截断 300 字符为 bodySnippet，deployMeta 不返回
      const items = [
        {
          id: 'ms-1',
          name: 'v1.42.0',
          body: 'x'.repeat(500),
          deployMeta: { backup: 'b.sql' },
        },
      ] as unknown as Milestone[];
      const qb = createMockQueryBuilder(items, 1);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.find.mockResolvedValue([]);

      const result = await service.findAll({});

      expect(result.items[0].bodySnippet).toBe('x'.repeat(300));
      expect(result.items[0]).not.toHaveProperty('body');
      expect(result.items[0]).not.toHaveProperty('deployMeta');
    });

    it('should return bodySnippet null when body is null', async () => {
      const items = [{ id: 'ms-1', name: 'v1.42.0', body: null }] as Milestone[];
      const qb = createMockQueryBuilder(items, 1);
      milestoneRepo.createQueryBuilder.mockReturnValue(qb);
      taskRepo.find.mockResolvedValue([]);

      const result = await service.findAll({});

      expect(result.items[0].bodySnippet).toBeNull();
      expect(result.items[0]).not.toHaveProperty('body');
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

    it('should return full detail: body and deployMeta preserved (findOne 详情全量)', async () => {
      const milestone = {
        id: 'ms-1',
        name: 'v1.42.0',
        boardId: 'board-1',
        version: '1.42.0',
        body: 'full release body',
        deployMeta: { backup: 'b.sql', anchors: { health: 'ok' } },
      } as unknown as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      taskRepo.find.mockResolvedValue([]);

      const result = await service.findOne('ms-1', actor);

      // 详情接口与列表投影相反：body/deployMeta 全量返回
      expect(result.body).toBe('full release body');
      expect(result.deployMeta).toEqual({ backup: 'b.sql', anchors: { health: 'ok' } });
      expect(result).not.toHaveProperty('bodySnippet');
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
        version: null,
      } as unknown as Milestone;
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockResolvedValue({
        ...milestone,
        name: 'v1.3.1',
        status: MilestoneStatus.ACTIVE,
      } as Milestone);

      const result = await service.update(
        'ms-1',
        {
          name: 'v1.3.1',
          status: MilestoneStatus.ACTIVE,
        },
        actor,
      );

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

  // ===== Release 状态机（v1.42 批次 B1）=====
  // 活文档：合法/非法流转矩阵与 docs/spec.md §3.2 MilestoneStatus 同步维护
  describe('update — release 状态机矩阵', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
    const releaseMilestone = (status: MilestoneStatus): Milestone =>
      ({
        id: 'ms-1',
        name: 'v1.42.0',
        boardId: 'board-1',
        status,
        version: '1.42.0',
        deployMeta: null,
        deployedAt: null,
        verifiedAt: null,
      }) as unknown as Milestone;
    const normalMilestone = (status: MilestoneStatus): Milestone =>
      ({
        id: 'ms-1',
        name: 'S1',
        boardId: 'board-1',
        status,
        version: null,
        deployMeta: null,
        deployedAt: null,
        verifiedAt: null,
      }) as unknown as Milestone;

    // 合法流转（dev→ready/deployed/cancelled；ready→deployed/cancelled；deployed→verified；
    // deployed→deployed 重部署 = 同值 no-op；verified=终态。deployed 目标只经端点）
    const LEGAL_TRANSITIONS: Array<[MilestoneStatus, MilestoneStatus]> = [
      [MilestoneStatus.DEV, MilestoneStatus.READY],
      [MilestoneStatus.DEV, MilestoneStatus.CANCELLED],
      [MilestoneStatus.READY, MilestoneStatus.CANCELLED],
      [MilestoneStatus.DEPLOYED, MilestoneStatus.VERIFIED],
    ];

    // 非法流转（400 MILESTONE_INVALID_TRANSITION；verified→deployed 单独用例走端点拦截码）
    const ILLEGAL_TRANSITIONS: Array<[MilestoneStatus, MilestoneStatus]> = [
      [MilestoneStatus.DEV, MilestoneStatus.VERIFIED],
      [MilestoneStatus.DEV, MilestoneStatus.PLANNED],
      [MilestoneStatus.DEV, MilestoneStatus.ACTIVE],
      [MilestoneStatus.DEV, MilestoneStatus.COMPLETED],
      [MilestoneStatus.READY, MilestoneStatus.DEV],
      [MilestoneStatus.READY, MilestoneStatus.VERIFIED],
      [MilestoneStatus.READY, MilestoneStatus.PLANNED],
      [MilestoneStatus.READY, MilestoneStatus.ACTIVE],
      [MilestoneStatus.READY, MilestoneStatus.COMPLETED],
      [MilestoneStatus.DEPLOYED, MilestoneStatus.READY],
      [MilestoneStatus.DEPLOYED, MilestoneStatus.CANCELLED],
      [MilestoneStatus.DEPLOYED, MilestoneStatus.COMPLETED],
      [MilestoneStatus.VERIFIED, MilestoneStatus.READY],
      [MilestoneStatus.VERIFIED, MilestoneStatus.DEV],
      [MilestoneStatus.VERIFIED, MilestoneStatus.CANCELLED],
      [MilestoneStatus.CANCELLED, MilestoneStatus.DEV],
      [MilestoneStatus.CANCELLED, MilestoneStatus.READY],
      [MilestoneStatus.CANCELLED, MilestoneStatus.VERIFIED],
    ];

    it.each(LEGAL_TRANSITIONS)('release %s -> %s 合法', async (from, to) => {
      milestoneRepo.findOne.mockResolvedValue(releaseMilestone(from));
      milestoneRepo.save.mockResolvedValue(releaseMilestone(to));

      const result = await service.update('ms-1', { status: to }, actor);

      expect(result.status).toBe(to);
      expect(milestoneRepo.save).toHaveBeenCalled();
    });

    it.each(ILLEGAL_TRANSITIONS)('release %s -> %s 非法 (400)', async (from, to) => {
      milestoneRepo.findOne.mockResolvedValue(releaseMilestone(from));

      await expect(service.update('ms-1', { status: to }, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION },
      });
      expect(milestoneRepo.save).not.toHaveBeenCalled();
    });

    it('PATCH dev -> deployed 拒绝（MILESTONE_DEPLOY_VIA_ENDPOINT）', async () => {
      milestoneRepo.findOne.mockResolvedValue(releaseMilestone(MilestoneStatus.DEV));

      await expect(
        service.update('ms-1', { status: MilestoneStatus.DEPLOYED }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT } });
      expect(milestoneRepo.save).not.toHaveBeenCalled();
    });

    it('PATCH verified -> deployed 拒绝（终态 + 端点专属码）', async () => {
      milestoneRepo.findOne.mockResolvedValue(releaseMilestone(MilestoneStatus.VERIFIED));

      await expect(
        service.update('ms-1', { status: MilestoneStatus.DEPLOYED }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT } });
    });

    it.each([
      MilestoneStatus.DEV,
      MilestoneStatus.DEPLOYED,
      MilestoneStatus.PLANNED,
      MilestoneStatus.ACTIVE,
    ])('release 同值 no-op %s -> %s 放行', async (status) => {
      const milestone = releaseMilestone(status);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockResolvedValue({ ...milestone, name: 'renamed' } as Milestone);

      const result = await service.update('ms-1', { status, name: 'renamed' }, actor);

      expect(result.name).toBe('renamed');
      expect(milestoneRepo.save).toHaveBeenCalled();
    });

    it('deployed -> verified 落 verifiedAt（不变量：verified ⇔ verifiedAt）', async () => {
      const milestone = releaseMilestone(MilestoneStatus.DEPLOYED);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockImplementation((m) => Promise.resolve(m as Milestone));

      await service.update('ms-1', { status: MilestoneStatus.VERIFIED }, actor);

      expect(milestone.verifiedAt).toBeInstanceOf(Date);
    });

    it('非 verified 流转不写 verifiedAt', async () => {
      const milestone = releaseMilestone(MilestoneStatus.DEV);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockImplementation((m) => Promise.resolve(m as Milestone));

      await service.update('ms-1', { status: MilestoneStatus.READY }, actor);

      expect(milestone.verifiedAt).toBeNull();
    });

    // 普通态隔离：version 为空的 milestone 禁落 release 四态，其余既有行为零变更
    it.each([MilestoneStatus.DEV, MilestoneStatus.READY, MilestoneStatus.VERIFIED])(
      '普通 milestone planned -> %s 非法 (400)',
      async (to) => {
        milestoneRepo.findOne.mockResolvedValue(normalMilestone(MilestoneStatus.PLANNED));

        await expect(service.update('ms-1', { status: to }, actor)).rejects.toMatchObject({
          response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION },
        });
      },
    );

    it('普通 milestone planned -> deployed 非法（version 为空分支，非端点码）', async () => {
      milestoneRepo.findOne.mockResolvedValue(normalMilestone(MilestoneStatus.PLANNED));

      await expect(
        service.update('ms-1', { status: MilestoneStatus.DEPLOYED }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION } });
    });

    it.each([
      [MilestoneStatus.PLANNED, MilestoneStatus.ACTIVE],
      [MilestoneStatus.PLANNED, MilestoneStatus.COMPLETED],
      [MilestoneStatus.PLANNED, MilestoneStatus.CANCELLED],
      [MilestoneStatus.ACTIVE, MilestoneStatus.PLANNED],
    ])('普通 milestone %s -> %s 既有行为零变更', async (from, to) => {
      const milestone = normalMilestone(from);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockResolvedValue({ ...milestone, status: to } as Milestone);

      const result = await service.update('ms-1', { status: to }, actor);

      expect(result.status).toBe(to);
    });

    // 存量补挂 version：须同请求携带 release 状态，禁止「version 非空 + 普通态」中间态
    it('补挂 version 不带 status -> 400', async () => {
      milestoneRepo.findOne.mockResolvedValue(normalMilestone(MilestoneStatus.PLANNED));

      await expect(service.update('ms-1', { version: '1.42.0' }, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION },
      });
    });

    it.each([MilestoneStatus.DEV, MilestoneStatus.READY])(
      '补挂 version + status=%s 合法（初始化进 release 生命周期）',
      async (to) => {
        const milestone = normalMilestone(MilestoneStatus.PLANNED);
        milestoneRepo.findOne.mockResolvedValue(milestone);
        milestoneRepo.save.mockResolvedValue({
          ...milestone,
          version: '1.42.0',
          status: to,
        } as unknown as Milestone);

        const result = await service.update('ms-1', { version: '1.42.0', status: to }, actor);

        expect(result.version).toBe('1.42.0');
        expect(result.status).toBe(to);
        expect(milestone.version).toBe('1.42.0');
        expect(milestone.status).toBe(to);
      },
    );

    it.each([
      MilestoneStatus.PLANNED,
      MilestoneStatus.ACTIVE,
      MilestoneStatus.VERIFIED,
      MilestoneStatus.CANCELLED,
    ])('补挂 version + status=%s -> 400（禁止中间态）', async (to) => {
      milestoneRepo.findOne.mockResolvedValue(normalMilestone(MilestoneStatus.PLANNED));

      await expect(
        service.update('ms-1', { version: '1.42.0', status: to }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION } });
    });

    it('补挂 version + status=deployed -> 400（端点专属码）', async () => {
      milestoneRepo.findOne.mockResolvedValue(normalMilestone(MilestoneStatus.PLANNED));

      await expect(
        service.update('ms-1', { version: '1.42.0', status: MilestoneStatus.DEPLOYED }, actor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.MILESTONE_DEPLOY_VIA_ENDPOINT } });
    });

    it('update 改 version 触发 23505 -> 409（同 board 重复；不同 board 由索引天然放行）', async () => {
      const milestone = releaseMilestone(MilestoneStatus.DEV);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockRejectedValue({
        code: '23505',
        constraint: 'uq_milestones_board_version',
      });

      await expect(service.update('ms-1', { version: '1.42.1' }, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_VERSION_CONFLICT },
      });
    });

    it('非 version 冲突的 23505 原样抛出（不误翻译）', async () => {
      const milestone = releaseMilestone(MilestoneStatus.DEV);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockRejectedValue({
        code: '23505',
        constraint: 'some_other_constraint',
      });

      await expect(service.update('ms-1', { name: 'x' }, actor)).rejects.toEqual({
        code: '23505',
        constraint: 'some_other_constraint',
      });
    });
  });

  // ===== deployed 端点（POST /tasks/milestones/:id/deployed）=====
  describe('markDeployed', () => {
    const actor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
    const releaseMilestone = (status: MilestoneStatus): Milestone =>
      ({
        id: 'ms-1',
        name: 'v1.42.0',
        boardId: 'board-1',
        status,
        version: '1.42.0',
        deployMeta: null,
        deployedAt: null,
        verifiedAt: null,
      }) as unknown as Milestone;

    it('dev -> deployed 成功：置状态、deployedAt=now、deployMeta 写入、响应含 stats', async () => {
      const milestone = releaseMilestone(MilestoneStatus.DEV);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockImplementation((m) => Promise.resolve(m as Milestone));
      taskRepo.find.mockResolvedValue([{ status: TaskStatus.DONE } as Task]);

      const result = await service.markDeployed(
        'ms-1',
        { anchors: { health: 'ok' }, backup: 'b.sql', migrations: ['M1'] },
        actor,
      );

      expect(milestone.status).toBe(MilestoneStatus.DEPLOYED);
      expect(milestone.deployedAt).toBeInstanceOf(Date);
      expect(milestone.deployMeta).toEqual({
        anchors: { health: 'ok' },
        backup: 'b.sql',
        migrations: ['M1'],
      });
      // 响应 = 详情投影：deployMeta/body 全量 + stats
      expect(result.status).toBe(MilestoneStatus.DEPLOYED);
      expect(result.deployMeta).toEqual(milestone.deployMeta);
      expect(result.stats).toEqual({ total: 1, done: 1, inProgress: 0, open: 0 });
      // 权限：board write
      expect(permService.ensureCan).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'board-1' }),
        actor,
        'write',
      );
    });

    it('payload deployedAt 优先（历史部署回填）', async () => {
      const milestone = releaseMilestone(MilestoneStatus.READY);
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockImplementation((m) => Promise.resolve(m as Milestone));
      taskRepo.find.mockResolvedValue([]);

      await service.markDeployed('ms-1', { deployedAt: '2026-08-04T02:00:00.000Z' }, actor);

      expect(milestone.deployedAt?.toISOString()).toBe('2026-08-04T02:00:00.000Z');
    });

    it('幂等重部署 deployed -> deployed：deployMeta 合并、deployedAt 刷新', async () => {
      const milestone = releaseMilestone(MilestoneStatus.DEPLOYED);
      milestone.deployMeta = { backup: 'old.sql', anchors: { health: 'ok' } };
      milestone.deployedAt = new Date('2026-08-04T02:00:00.000Z');
      milestoneRepo.findOne.mockResolvedValue(milestone);
      milestoneRepo.save.mockImplementation((m) => Promise.resolve(m as Milestone));
      taskRepo.find.mockResolvedValue([]);

      await service.markDeployed('ms-1', { backup: 'new.sql', migrations: ['M2'] }, actor);

      // 只覆盖显式提供的键：backup 更新、anchors 保留、migrations 新增
      expect(milestone.deployMeta).toEqual({
        backup: 'new.sql',
        anchors: { health: 'ok' },
        migrations: ['M2'],
      });
      expect(milestone.status).toBe(MilestoneStatus.DEPLOYED);
      // deployedAt 刷新为 now（> 旧时间）
      expect(milestone.deployedAt!.getTime()).toBeGreaterThan(
        new Date('2026-08-04T02:00:00.000Z').getTime(),
      );
    });

    it.each([MilestoneStatus.VERIFIED, MilestoneStatus.CANCELLED])(
      '非法前置态 %s -> deployed -> 400',
      async (status) => {
        milestoneRepo.findOne.mockResolvedValue(releaseMilestone(status));

        await expect(service.markDeployed('ms-1', {}, actor)).rejects.toMatchObject({
          response: { code: ErrorCode.MILESTONE_INVALID_TRANSITION },
        });
        expect(milestoneRepo.save).not.toHaveBeenCalled();
      },
    );

    it('should reject when milestone not found (404)', async () => {
      milestoneRepo.findOne.mockResolvedValue(null);

      await expect(service.markDeployed('ms-1', {}, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.MILESTONE_NOT_FOUND },
      });
    });

    it('should reject when actor lacks write permission on board (403)', async () => {
      milestoneRepo.findOne.mockResolvedValue(releaseMilestone(MilestoneStatus.DEV));
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(service.markDeployed('ms-1', {}, actor)).rejects.toMatchObject({
        response: { code: ErrorCode.PERMISSION_DENIED },
      });
      expect(milestoneRepo.save).not.toHaveBeenCalled();
    });
  });
});
