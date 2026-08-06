import { Test, TestingModule } from '@nestjs/testing';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';
import { TaskDependencyService } from './task-dependency.service';
import { MilestoneService } from './milestone.service';
import { PermissionService } from '../../common/services/permission.service';
import { ActorType, UserRole } from '@agent-chamber/shared';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';

describe('TaskController', () => {
  let controller: TaskController;
  let service: typeof mockService;
  let permService: typeof mockPermService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const mockAgentActor = { id: 'agent-1', type: ActorType.AGENT };

  const mockService = {
    findAll: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    move: jest.fn(),
    assign: jest.fn(),
    getComments: jest.fn(),
    addComment: jest.fn(),
    getActivities: jest.fn(),
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
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TaskController],
      providers: [
        { provide: TaskService, useValue: mockService },
        { provide: TaskDependencyService, useValue: mockDepService },
        { provide: MilestoneService, useValue: mockMilestoneService },
        { provide: PermissionService, useValue: mockPermService },
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
    it('should call service.create with dto and actor', async () => {
      const dto = { title: 'New Task', boardId: 'board-1', listId: 'list-1' };
      const result = { id: 'task-1', title: 'New Task' };
      service.create.mockResolvedValue(result);

      expect(await controller.create(dto, mockActor)).toBe(result);
      expect(service.create).toHaveBeenCalledWith(dto, mockActor.id, mockActor.type);
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
      const task = { id: 'task-1' };
      service.findById.mockResolvedValue(task);
      service.remove.mockResolvedValue(true);

      expect(await controller.remove('task-1', mockActor)).toBe(true);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'delete');
      expect(service.remove).toHaveBeenCalledWith('task-1');
    });
  });

  describe('move', () => {
    it('should ensure write permission then move', async () => {
      const task = { id: 'task-1' };
      const dto = { listId: 'list-2', order: 5 };
      const result = { id: 'task-1', listId: 'list-2', position: 5 };
      service.findById.mockResolvedValue(task);
      service.move.mockResolvedValue(result);

      expect(await controller.move('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.move).toHaveBeenCalledWith('task-1', dto, mockActor.id, mockActor.type);
    });
  });

  describe('assign', () => {
    it('should ensure write permission then assign', async () => {
      const task = { id: 'task-1' };
      const dto = { assigneeId: 'user-2', assigneeType: ActorType.HUMAN };
      const result = { id: 'task-1', assigneeId: 'user-2', assigneeType: 'agent' };
      service.findById.mockResolvedValue(task);
      service.assign.mockResolvedValue(result);

      expect(await controller.assign('task-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(task, mockActor, 'write');
      expect(service.assign).toHaveBeenCalledWith('task-1', dto, mockActor.id, mockActor.type);
    });
  });

  describe('getComments', () => {
    it('should call service.getComments with id and default limit', async () => {
      const result = [{ id: 'comment-1', content: 'Test' }];
      service.getComments.mockResolvedValue(result);

      expect(await controller.getComments('task-1')).toBe(result);
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
    it('should call service.getActivities with id and default limit', async () => {
      const result = [{ id: 'activity-1', action: 'created' }];
      service.getActivities.mockResolvedValue(result);

      expect(await controller.getActivities('task-1')).toBe(result);
      expect(service.getActivities).toHaveBeenCalledWith('task-1', undefined);
    });
  });
});
