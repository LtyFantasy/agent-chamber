import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { TaskDependencyService } from './task-dependency.service';
import { MilestoneService } from './milestone.service';
import { PermissionService } from '../../common/services/permission.service';
import { AuditService } from '../audit/audit.service';
import {
  ActorType,
  UserRole,
  TaskStatus,
  TaskDependencyType,
  ErrorCode,
} from '@agent-chamber/shared';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

describe('TaskController', () => {
  let controller: TaskController;
  let service: typeof mockService;
  let permService: typeof mockPermService;
  let auditService: { log: jest.Mock };

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const mockAgentActor = { id: 'agent-1', type: ActorType.AGENT };

  const mockService = {
    findAll: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    batchCreate: jest.fn(),
    resolveCreateBoard: jest.fn(),
    resolveTaskBoard: jest.fn(),
    update: jest.fn(),
    patchDescription: jest.fn(),
    remove: jest.fn(),
    move: jest.fn(),
    assign: jest.fn(),
    reportResult: jest.fn(),
    getComments: jest.fn(),
    addComment: jest.fn(),
    getActivities: jest.fn(),
    removeDocLink: jest.fn(),
  };

  const mockDepService = {
    findDependencies: jest.fn(),
    findDependents: jest.fn(),
    addDependency: jest.fn(),
    removeDependency: jest.fn(),
    findBlockers: jest.fn(),
    hasBlockers: jest.fn(),
  };

  const mockMilestoneService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    markDeployed: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
    can: jest.fn().mockResolvedValue(true),
  };
  const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        { provide: TaskService, useValue: mockService },
        { provide: TaskDependencyService, useValue: mockDepService },
        { provide: MilestoneService, useValue: mockMilestoneService },
        { provide: PermissionService, useValue: mockPermService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TaskController>(TaskController);
    service = module.get<TaskService>(TaskService) as unknown as typeof mockService;
    permService = module.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof mockPermService;
    auditService = module.get<AuditService>(AuditService) as unknown as { log: jest.Mock };
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should call service.findAll with query and actor and return result', async () => {
      const result = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      service.findAll.mockResolvedValue(result);

      expect(await controller.findAll({ page: 1 }, mockActor)).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith({ page: 1 }, mockActor);
    });
  });

  describe('findMilestones', () => {
    it('should call milestoneService.findAll with query and actor and return result', async () => {
      const result = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      mockMilestoneService.findAll.mockResolvedValue(result);

      expect(await controller.findMilestones({ boardId: 'board-1' }, mockActor)).toBe(result);
      expect(mockMilestoneService.findAll).toHaveBeenCalledWith({ boardId: 'board-1' }, mockActor);
    });
  });

  describe('create', () => {
    it('should ensure write permission on resolved board then create', async () => {
      const dto = { title: 'New Task', boardId: 'board-1', listId: 'list-1' };
      const board = { id: 'board-1' };
      const result = { id: 'task-1', title: 'New Task' };
      service.resolveCreateBoard.mockResolvedValue(board);
      service.create.mockResolvedValue(result);

      expect(await controller.create(dto, mockActor)).toBe(result);
      expect(service.resolveCreateBoard).toHaveBeenCalledWith(dto);
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.create).toHaveBeenCalledWith(dto, mockActor.id, mockActor.type);
    });

    it('should propagate ForbiddenException when actor lacks board write (B-58)', async () => {
      const dto = { title: 'New Task', boardId: 'board-1', listId: 'list-1' };
      const board = { id: 'board-1' };
      service.resolveCreateBoard.mockResolvedValue(board);
      permService.ensureCan.mockRejectedValueOnce(
        new ForbiddenException({
          message: 'Access denied: write on Board',
          code: ErrorCode.PERMISSION_DENIED,
        }),
      );

      await expect(controller.create(dto, mockActor)).rejects.toThrow(ForbiddenException);
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('batchCreate', () => {
    it('should ensure write permission on each distinct board then batch create', async () => {
      const dto = {
        tasks: [
          { title: 'T1', boardId: 'board-1', listId: 'list-1' },
          { title: 'T2', boardId: 'board-1', listId: 'list-2' },
          { title: 'T3', boardId: 'board-2', listId: 'list-3' },
        ],
      };
      const result = { items: [], count: 3 };
      service.resolveCreateBoard.mockImplementation((t: any) => Promise.resolve({ id: t.boardId }));
      service.batchCreate.mockResolvedValue(result);

      expect(await controller.batchCreate(dto as any, mockActor)).toBe(result);
      // 同 board 去重：board-1 只校验一次，board-2 校验一次
      expect(permService.ensureCan).toHaveBeenCalledTimes(2);
      expect(permService.ensureCan).toHaveBeenCalledWith({ id: 'board-1' }, mockActor, 'write');
      expect(permService.ensureCan).toHaveBeenCalledWith({ id: 'board-2' }, mockActor, 'write');
      expect(service.batchCreate).toHaveBeenCalledWith(dto, mockActor.id, mockActor.type);
    });
  });

  describe('deployMilestone', () => {
    it('should call milestoneService.markDeployed with id, dto and actor', async () => {
      const dto = { anchors: { health: 'ok' }, backup: 'b.sql' };
      const result = { id: 'ms-1', status: 'deployed' };
      mockMilestoneService.markDeployed.mockResolvedValue(result);

      expect(await controller.deployMilestone('ms-1', dto, mockAgentActor)).toBe(result);
      expect(mockMilestoneService.markDeployed).toHaveBeenCalledWith('ms-1', dto, mockAgentActor);
    });
  });

  describe('findOne', () => {
    it('should ensure read permission and return task', async () => {
      const task = { id: 'task-1', title: 'Test Task' };
      const result = { id: 'task-1', title: 'Test Task', dependencies: [] };
      service.findById.mockResolvedValue(task);
      service.findOne.mockResolvedValue(result);

      expect(await controller.findOne('task-1', mockActor)).toBe(result);
      expect(service.findById).toHaveBeenCalledWith('task-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'read');
      expect(service.findOne).toHaveBeenCalledWith('task-1');
    });
  });

  describe('update', () => {
    it('should ensure write permission then update', async () => {
      const task = { id: 'task-1' };
      const dto = { title: 'Updated Task' };
      const result = { id: 'task-1', title: 'Updated Task' };
      service.findById.mockResolvedValue(task);
      service.update.mockResolvedValue(result);

      expect(await controller.update('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.update).toHaveBeenCalledWith('task-1', dto, mockActor.id, mockActor.type);
    });
  });

  describe('remove', () => {
    it('should ensure delete permission then remove', async () => {
      const task = { id: 'task-1', title: 'Task 1' };
      service.findById.mockResolvedValue(task);
      service.remove.mockResolvedValue(true);

      expect(await controller.remove('task-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'delete');
      expect(service.remove).toHaveBeenCalledWith('task-1');
      // 审计（Phase 2）：DELETE + task
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'delete',
        entityType: 'task',
        entityId: 'task-1',
        actorId: mockActor.id,
        newData: { taskId: 'task-1', title: 'Task 1' },
        source: 'api',
      });
    });
  });

  describe('move', () => {
    it('should ensure write permission then move', async () => {
      const task = { id: 'task-1', title: 'Task 1', listId: 'list-1', status: 'todo' };
      const dto = { listId: 'list-2', order: 5 };
      const result = { id: 'task-1', listId: 'list-2', position: 5, status: 'in_progress' };
      service.findById.mockResolvedValue(task);
      service.move.mockResolvedValue(result);

      expect(await controller.move('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.move).toHaveBeenCalledWith('task-1', dto, mockActor.id, mockActor.type);
      // 审计（Phase 2）：UPDATE + task（move）；含 listId 前后值与 status 前后值
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'task',
        entityId: 'task-1',
        actorId: mockActor.id,
        newData: {
          taskId: 'task-1',
          title: 'Task 1',
          fromListId: 'list-1',
          toListId: 'list-2',
          status: 'in_progress',
          statusBefore: 'todo',
        },
        source: 'api',
      });
    });
  });

  describe('assign', () => {
    it('should ensure write permission then assign', async () => {
      const task = { id: 'task-1', title: 'Task 1', assigneeId: null };
      const dto = { assigneeId: 'user-2', assigneeType: ActorType.HUMAN };
      const result = { id: 'task-1', assigneeId: 'user-2', assigneeType: 'agent' };
      service.findById.mockResolvedValue(task);
      service.assign.mockResolvedValue(result);

      expect(await controller.assign('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.assign).toHaveBeenCalledWith('task-1', dto, mockActor.id, mockActor.type);
      // 审计（Phase 2）：UPDATE + task（assign）；含 assigneeId 前后值
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'update',
        entityType: 'task',
        entityId: 'task-1',
        actorId: mockActor.id,
        newData: {
          taskId: 'task-1',
          title: 'Task 1',
          assigneeId: 'user-2',
          assigneeIdBefore: null,
        },
        source: 'api',
      });
    });
  });

  describe('report', () => {
    it('should ensure write permission then call service.reportResult with dto and actor', async () => {
      const task = { id: 'task-1' };
      const dto = { status: TaskStatus.DONE, comment: 'done', clientRequestId: 'key-1' };
      const result = {
        task: { id: 'task-1', status: TaskStatus.DONE },
        comment: { id: 'comment-1' },
      };
      service.findById.mockResolvedValue(task);
      service.reportResult.mockResolvedValue(result);

      expect(await controller.report('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.reportResult).toHaveBeenCalledWith('task-1', dto, mockActor);
    });
  });

  describe('patchDescription', () => {
    it('should ensure write permission then call service.patchDescription with dto and actor', async () => {
      const task = { id: 'task-1' };
      const dto = { oldString: '旧', newString: '新', clientRequestId: 'key-1' };
      const result = { task: { id: 'task-1', description: '新' } };
      service.findById.mockResolvedValue(task);
      service.patchDescription.mockResolvedValue(result);

      expect(await controller.patchDescription('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.patchDescription).toHaveBeenCalledWith('task-1', dto, mockActor);
    });
  });

  describe('getComments', () => {
    it('should ensure read permission then call service.getComments with id and default limit', async () => {
      const task = { id: 'task-1' };
      const result = [{ id: 'comment-1', content: 'Test' }];
      service.findById.mockResolvedValue(task);
      service.getComments.mockResolvedValue(result);

      expect(await controller.getComments('task-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'read');
      expect(service.getComments).toHaveBeenCalledWith('task-1', undefined);
    });
  });

  describe('addComment', () => {
    it('should ensure write permission then add comment', async () => {
      const task = { id: 'task-1' };
      const dto = { content: 'New comment' };
      const result = { id: 'comment-1', content: 'New comment' };
      service.findById.mockResolvedValue(task);
      service.addComment.mockResolvedValue(result);

      expect(await controller.addComment('task-1', mockActor, dto)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.addComment).toHaveBeenCalledWith('task-1', mockActor.id, mockActor.type, dto);
    });
  });

  describe('getActivities', () => {
    it('should ensure read permission then call service.getActivities with id and default limit', async () => {
      const task = { id: 'task-1' };
      const result = [{ id: 'activity-1', action: 'created' }];
      service.findById.mockResolvedValue(task);
      service.getActivities.mockResolvedValue(result);

      expect(await controller.getActivities('task-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'read');
      expect(service.getActivities).toHaveBeenCalledWith('task-1', undefined);
    });
  });

  describe('findDependencies', () => {
    it('should ensure read permission then return dependencies', async () => {
      const task = { id: 'task-1' };
      const result = [{ id: 'dep-1', taskId: 'task-1' }];
      service.findById.mockResolvedValue(task);
      mockDepService.findDependencies.mockResolvedValue(result);

      expect(await controller.findDependencies('task-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'read');
      expect(mockDepService.findDependencies).toHaveBeenCalledWith('task-1');
    });
  });

  describe('findDependents', () => {
    it('should ensure read permission then return dependents', async () => {
      const task = { id: 'task-1' };
      const result = [{ id: 'dep-1', dependsOnTaskId: 'task-1' }];
      service.findById.mockResolvedValue(task);
      mockDepService.findDependents.mockResolvedValue(result);

      expect(await controller.findDependents('task-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'read');
      expect(mockDepService.findDependents).toHaveBeenCalledWith('task-1');
    });
  });

  describe('findBlockers', () => {
    it('should ensure read permission then return blockers', async () => {
      const task = { id: 'task-1' };
      const result = [{ id: 'dep-1', taskId: 'task-1' }];
      service.findById.mockResolvedValue(task);
      mockDepService.findBlockers.mockResolvedValue(result);

      expect(await controller.findBlockers('task-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'read');
      expect(mockDepService.findBlockers).toHaveBeenCalledWith('task-1');
    });
  });

  describe('addDependency', () => {
    it('should ensure write on both task and dependsOnTask boards then add dependency and audit', async () => {
      const dto = { dependsOnTaskId: 'task-2', type: TaskDependencyType.BLOCKS };
      const task = { id: 'task-1' };
      const dependsOnTask = { id: 'task-2' };
      const result = { id: 'dep-1', taskId: 'task-1', dependsOnTaskId: 'task-2', type: 'blocks' };
      service.findById.mockResolvedValueOnce(task).mockResolvedValueOnce(dependsOnTask);
      mockDepService.addDependency.mockResolvedValue(result);

      expect(await controller.addDependency('task-1', dto, mockActor)).toBe(result);
      // B-58：跨 board 依赖边保守选择——两端 board 都校验 write
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(permService.ensureCan).toHaveBeenCalledWith(dependsOnTask, mockActor, 'write');
      expect(mockDepService.addDependency).toHaveBeenCalledWith('task-1', dto);
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'create',
        entityType: 'task_dependency',
        entityId: 'dep-1',
        actorId: mockActor.id,
        newData: { taskId: 'task-1', dependsOnTaskId: 'task-2', type: 'blocks' },
        source: 'api',
      });
    });
  });

  describe('removeDependency', () => {
    it('should ensure write permission then remove dependency and audit', async () => {
      const task = { id: 'task-1' };
      service.findById.mockResolvedValue(task);
      mockDepService.removeDependency.mockResolvedValue(true);

      expect(await controller.removeDependency('task-1', 'dep-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(mockDepService.removeDependency).toHaveBeenCalledWith('task-1', 'dep-1');
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'delete',
        entityType: 'task_dependency',
        entityId: 'dep-1',
        actorId: mockActor.id,
        newData: { taskId: 'task-1', dependsOnTaskId: 'dep-1' },
        source: 'api',
      });
    });
  });

  describe('batchBlockers', () => {
    // B-61：ids 段必须合法 UUID（格式校验 400 先于权限 403）；以下用例全部用合法
    // UUID 假值，避免被格式校验提前拦截（否则会污染 findById Once-mock 队列）
    const uuidA = '11111111-1111-4111-8111-111111111111';
    const uuidB = '22222222-2222-4222-8222-222222222222';
    const uuidC = '33333333-3333-4333-8333-333333333333';

    it('should reject invalid UUID segment with 400 VALIDATION_ERROR (B-61)', async () => {
      await expect(controller.batchBlockers(`${uuidA},not-a-uuid`, mockActor)).rejects.toThrow(
        BadRequestException,
      );
      // 格式校验先于权限校验：非法段不得触发 findById / 权限判定
      expect(service.findById).not.toHaveBeenCalled();
      expect(permService.can).not.toHaveBeenCalled();
    });

    it('should ensure read on each distinct board then return blocker map', async () => {
      const task1 = { id: uuidA, listId: 'list-1' };
      const task2 = { id: uuidB, listId: 'list-2' };
      const task3 = { id: uuidC, listId: 'list-3' };
      const result = { [uuidA]: false, [uuidB]: true, [uuidC]: false };
      service.findById
        .mockResolvedValueOnce(task1)
        .mockResolvedValueOnce(task2)
        .mockResolvedValueOnce(task3);
      service.resolveTaskBoard
        .mockResolvedValueOnce({ id: 'board-1' })
        .mockResolvedValueOnce({ id: 'board-1' }) // task-2 同 board-1 → 去重
        .mockResolvedValueOnce({ id: 'board-2' });
      mockDepService.hasBlockers.mockResolvedValue(result);

      expect(await controller.batchBlockers(`${uuidA},${uuidB},${uuidC}`, mockActor)).toBe(result);
      // 去重后只校验 board-1 / board-2 两个 board
      expect(permService.can).toHaveBeenCalledTimes(2);
      expect(permService.can).toHaveBeenCalledWith({ id: 'board-1' }, mockActor, 'read');
      expect(permService.can).toHaveBeenCalledWith({ id: 'board-2' }, mockActor, 'read');
      expect(mockDepService.hasBlockers).toHaveBeenCalledWith([uuidA, uuidB, uuidC]);
    });

    it('should throw 403 when any distinct board is not readable (B-58)', async () => {
      const task1 = { id: uuidA, listId: 'list-1' };
      const task2 = { id: uuidB, listId: 'list-2' };
      service.findById.mockResolvedValueOnce(task1).mockResolvedValueOnce(task2);
      service.resolveTaskBoard
        .mockResolvedValueOnce({ id: 'board-1' })
        .mockResolvedValueOnce({ id: 'board-2' });
      permService.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(controller.batchBlockers(`${uuidA},${uuidB}`, mockActor)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockDepService.hasBlockers).not.toHaveBeenCalled();
    });

    it('should skip orphan tasks (public) in permission check', async () => {
      const task1 = { id: uuidA, listId: null };
      service.findById.mockResolvedValueOnce(task1);
      service.resolveTaskBoard.mockResolvedValueOnce(null);
      mockDepService.hasBlockers.mockResolvedValue({ [uuidA]: false });

      expect(await controller.batchBlockers(uuidA, mockActor)).toEqual({ [uuidA]: false });
      expect(permService.can).not.toHaveBeenCalled();
    });
  });

  describe('removeDocLink', () => {
    it('should remove doc link and audit DELETE + doc_link', async () => {
      const task = { id: 'task-1' };
      service.findById.mockResolvedValue(task);
      service.removeDocLink.mockResolvedValue(true);

      expect(await controller.removeDocLink('task-1', 'doc-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.removeDocLink).toHaveBeenCalledWith('task-1', 'doc-1');
      expect(auditService.log).toHaveBeenCalledWith({
        action: 'delete',
        entityType: 'doc_link',
        entityId: 'doc-1',
        actorId: mockActor.id,
        newData: { taskId: 'task-1', docId: 'doc-1' },
        source: 'api',
      });
    });
  });
});
