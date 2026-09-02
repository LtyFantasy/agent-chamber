import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';
import { PermissionService } from '../../common/services/permission.service';
import { AuditService } from '../audit/audit.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ActorType, UserRole, ErrorCode, Visibility } from '@agent-chamber/shared';
import { FindListTasksQueryDto } from './dto';

describe('BoardController', () => {
  let controller: BoardController;
  let service: typeof mockService;
  let permService: typeof mockPermService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const mockAgentActor = { id: 'agent-1', type: ActorType.AGENT };

  const mockService = {
    findAll: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    findLists: jest.fn(),
    findListTasks: jest.fn(),
    enrich: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    createList: jest.fn(),
    reorderLists: jest.fn(),
    updateList: jest.fn(),
    removeList: jest.fn(),
    reorderTasks: jest.fn(),
    findList: jest.fn(),
    inviteAgent: jest.fn(),
    uninviteAgent: jest.fn(),
    addEditor: jest.fn(),
    removeEditor: jest.fn(),
    getDigest: jest.fn(),
    updateMetrics: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };
  const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

  /** OwnerProxyService mock：beforeEach 重置默认返回 false（clearAllMocks 不清 mock 实现） */
  const mockOwnerProxyService = {
    isOwnerProxy: jest.fn().mockResolvedValue(false),
  };

  beforeEach(async () => {
    mockOwnerProxyService.isOwnerProxy.mockResolvedValue(false);
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BoardController],
      providers: [
        { provide: BoardService, useValue: mockService },
        { provide: PermissionService, useValue: mockPermService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: OwnerProxyService, useValue: mockOwnerProxyService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<BoardController>(BoardController);
    service = moduleRef.get<BoardService>(BoardService) as unknown as typeof service;
    permService = moduleRef.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof permService;
  });

  afterEach(() => jest.clearAllMocks());

  describe('findAll', () => {
    it('should call service.findAll with query and actor', async () => {
      const result = {
        items: [{ id: 'board-1' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      service.findAll.mockResolvedValue(result);

      const query = { page: 2, pageSize: 10 };
      const response = await controller.findAll(query, mockActor);
      expect(response).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith(query, mockActor);
    });
  });

  describe('create', () => {
    it('should call service.create with actor id and type', async () => {
      const result = { id: 'board-1', name: 'New Board' };
      service.create.mockResolvedValue(result);

      const dto = { name: 'New Board' };
      expect(await controller.create(mockActor, dto)).toBe(result);
      expect(service.create).toHaveBeenCalledWith(mockActor.id, mockActor.type, dto);
      // 审计（Phase 2）：CREATE + board
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'create',
        entityType: 'board',
        entityId: 'board-1',
        actorId: mockActor.id,
        newData: { boardId: 'board-1', name: 'New Board' },
        source: 'api',
      });
    });
  });

  describe('findOne', () => {
    it('should ensure read permission and return enriched board', async () => {
      const board = { id: 'board-1', name: 'Board', topicId: 'topic-1' };
      const enriched = {
        id: 'board-1',
        name: 'Board',
        taskCount: 0,
        lists: [{ id: 'list-1', name: 'To Do', taskCount: 0 }],
      };
      service.findById.mockResolvedValue(board);
      service.enrich.mockResolvedValue(enriched);

      const result = await controller.findOne('board-1', mockActor);

      expect(result).toEqual(enriched);
      expect(result.lists[0]).not.toHaveProperty('tasks');
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
      expect(service.enrich).toHaveBeenCalledWith(board);
    });

    it('should return board even when no topicId', async () => {
      const board = { id: 'board-1', name: 'Board', topicId: null };
      const enriched = { id: 'board-1', name: 'Board', taskCount: 0, lists: [] };
      service.findById.mockResolvedValue(board);
      service.enrich.mockResolvedValue(enriched);

      const result = await controller.findOne('board-1', mockActor);

      expect(result).toEqual(enriched);
    });
  });

  describe('findLists', () => {
    it('should ensure read permission and return board lists', async () => {
      const board = { id: 'board-1', name: 'Board' };
      const lists = [{ id: 'list-1', name: 'To Do', taskCount: 0 }];
      service.findById.mockResolvedValue(board);
      service.findLists.mockResolvedValue(lists);

      const result = await controller.findLists('board-1', mockActor);

      expect(result).toBe(lists);
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
      expect(service.findLists).toHaveBeenCalledWith('board-1');
    });
  });

  describe('findListTasks', () => {
    it('should ensure read permission and return paginated tasks', async () => {
      const board = { id: 'board-1', name: 'Board' };
      const paginated = {
        items: [{ id: 'task-1', title: 'Task 1', status: 'todo' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      service.findById.mockResolvedValue(board);
      service.findListTasks.mockResolvedValue(paginated);

      const query = { status: 'todo', page: 1, pageSize: 20 } as FindListTasksQueryDto;
      const result = await controller.findListTasks('board-1', 'list-1', query, mockActor);

      expect(result).toBe(paginated);
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
      expect(service.findListTasks).toHaveBeenCalledWith('board-1', 'list-1', query, mockActor);
    });
  });

  describe('remove', () => {
    it('should ensure delete permission then remove', async () => {
      const board = { id: 'board-1', name: 'Board 1' };
      const result = true;
      service.findById.mockResolvedValue(board);
      service.remove.mockResolvedValue(result);

      expect(await controller.remove('board-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'delete');
      expect(service.remove).toHaveBeenCalledWith('board-1');
      // 审计（Phase 2）：DELETE + board
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'delete',
        entityType: 'board',
        entityId: 'board-1',
        actorId: mockActor.id,
        newData: { boardId: 'board-1', name: 'Board 1' },
        source: 'api',
      });
    });
  });

  describe('createList', () => {
    it('should ensure write permission then create list', async () => {
      const board = { id: 'board-1' };
      const result = { id: 'list-1' };
      service.findById.mockResolvedValue(board);
      service.createList.mockResolvedValue(result);

      const dto = { name: 'To Do' };
      const listResult = { id: 'list-1', name: 'To Do' };
      service.createList.mockResolvedValue(listResult);
      expect(await controller.createList('board-1', dto, mockActor)).toBe(listResult);
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.createList).toHaveBeenCalledWith('board-1', dto);
      // 审计（Phase 2）：CREATE + board_list
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'create',
        entityType: 'board_list',
        entityId: 'list-1',
        actorId: mockActor.id,
        newData: { boardId: 'board-1', listId: 'list-1', name: 'To Do' },
        source: 'api',
      });
    });
  });

  describe('reorderLists', () => {
    it('should ensure write permission then reorder', async () => {
      const board = { id: 'board-1' };
      const result = [{ id: 'list-1', position: 0 }];
      service.findById.mockResolvedValue(board);
      service.reorderLists.mockResolvedValue(result);

      const dto = { lists: [{ id: 'list-1', position: 0 }] };
      expect(await controller.reorderLists('board-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.reorderLists).toHaveBeenCalledWith('board-1', dto);
    });
  });

  describe('updateList', () => {
    it('should ensure write permission then update list', async () => {
      const list = { id: 'list-1', boardId: 'board-1' };
      const board = { id: 'board-1' };
      const result = { id: 'list-1', name: 'Updated' };
      service.findList.mockResolvedValue(list);
      service.findById.mockResolvedValue(board);
      service.updateList.mockResolvedValue(result);

      const dto = { name: 'Updated', position: 5 };
      expect(await controller.updateList('list-1', dto, mockActor)).toBe(result);
      expect(service.findList).toHaveBeenCalledWith('list-1');
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.updateList).toHaveBeenCalledWith('list-1', dto);
    });
  });

  describe('removeList', () => {
    it('should ensure write permission then remove list', async () => {
      const list = { id: 'list-1', boardId: 'board-1' };
      const board = { id: 'board-1' };
      const result = true;
      service.findList.mockResolvedValue(list);
      service.findById.mockResolvedValue(board);
      service.removeList.mockResolvedValue(result);

      expect(await controller.removeList('list-1', { moveTasksTo: 'list-2' }, mockActor)).toBe(
        result,
      );
      expect(service.findList).toHaveBeenCalledWith('list-1');
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.removeList).toHaveBeenCalledWith('list-1', 'list-2');
    });
  });

  describe('reorderTasks', () => {
    it('should ensure write permission then reorder tasks', async () => {
      const list = { id: 'list-1', boardId: 'board-1' };
      const board = { id: 'board-1' };
      const result = [{ id: 'task-1', position: 0 }];
      service.findList.mockResolvedValue(list);
      service.findById.mockResolvedValue(board);
      service.reorderTasks.mockResolvedValue(result);

      const dto = { tasks: [{ id: 'task-1', position: 0 }] };
      expect(await controller.reorderTasks('list-1', dto, mockActor)).toBe(result);
      expect(service.findList).toHaveBeenCalledWith('list-1');
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.reorderTasks).toHaveBeenCalledWith('list-1', dto);
    });
  });

  describe('findList', () => {
    it('should ensure read permission on the list board then return list (B-58)', async () => {
      const result = { id: 'list-1', name: 'To Do', boardId: 'board-1' };
      const board = { id: 'board-1' };
      service.findList.mockResolvedValue(result);
      service.findById.mockResolvedValue(board);

      expect(await controller.findList('list-1', mockActor)).toBe(result);
      expect(service.findList).toHaveBeenCalledWith('list-1');
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
    });
  });

  describe('inviteAgent', () => {
    it('should allow creator to invite agent', async () => {
      const board = { id: 'board-1', creatorId: 'user-1', creatorType: 'human' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.inviteAgent.mockResolvedValue(result);

      const dto = { agentId: 'agent-2' };
      expect(await controller.inviteAgent('board-1', dto, mockActor)).toBe(result);
      expect(service.inviteAgent).toHaveBeenCalledWith('board-1', 'agent-2');
      // 审计（Phase 2）：CREATE + board_member
      expect(mockAuditService.log).toHaveBeenCalledWith({
        action: 'create',
        entityType: 'board_member',
        entityId: 'agent-2',
        actorId: mockActor.id,
        newData: { boardId: 'board-1', actorId: 'agent-2', role: 'member' },
        source: 'api',
      });
    });

    it('should reject non-creator from inviting agent', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      const nonCreatorActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-2' };
      await expect(controller.inviteAgent('board-1', dto, nonCreatorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.inviteAgent).not.toHaveBeenCalled();
    });

    it('should allow human owner of creator agent to invite agent (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.inviteAgent.mockResolvedValue(result);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(true);

      const ownerActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-2' };
      expect(await controller.inviteAgent('board-1', dto, ownerActor)).toBe(result);
      expect(mockOwnerProxyService.isOwnerProxy).toHaveBeenCalledWith('agent-9', ownerActor);
      expect(service.inviteAgent).toHaveBeenCalledWith('board-1', 'agent-2');
    });

    it('should reject non-owner human on agent-created board (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      service.findById.mockResolvedValue(board);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(false);

      const strangerActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-2' };
      await expect(controller.inviteAgent('board-1', dto, strangerActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.inviteAgent).not.toHaveBeenCalled();
    });
  });

  describe('uninviteAgent', () => {
    it('should allow creator to uninvite agent', async () => {
      const board = { id: 'board-1', creatorId: 'user-1', creatorType: 'human' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.uninviteAgent.mockResolvedValue(result);

      const dto = { agentId: 'agent-2' };
      expect(await controller.uninviteAgent('board-1', dto, mockActor)).toBe(result);
      expect(service.uninviteAgent).toHaveBeenCalledWith('board-1', 'agent-2');
    });

    it('should reject non-creator from uninviting agent', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      const nonCreatorActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-2' };
      await expect(controller.uninviteAgent('board-1', dto, nonCreatorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.uninviteAgent).not.toHaveBeenCalled();
    });

    it('should allow human owner of creator agent to uninvite agent (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.uninviteAgent.mockResolvedValue(result);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(true);

      const ownerActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-2' };
      expect(await controller.uninviteAgent('board-1', dto, ownerActor)).toBe(result);
      expect(mockOwnerProxyService.isOwnerProxy).toHaveBeenCalledWith('agent-9', ownerActor);
      expect(service.uninviteAgent).toHaveBeenCalledWith('board-1', 'agent-2');
    });

    it('should reject non-owner human on agent-created board (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      service.findById.mockResolvedValue(board);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(false);

      const strangerActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-2' };
      await expect(controller.uninviteAgent('board-1', dto, strangerActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.uninviteAgent).not.toHaveBeenCalled();
    });
  });

  describe('addEditor', () => {
    it('should allow creator to add editor', async () => {
      const board = { id: 'board-1', creatorId: 'user-1', creatorType: 'human' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.addEditor.mockResolvedValue(result);

      const dto = { agentId: 'agent-1' };
      expect(await controller.addEditor('board-1', dto, mockActor)).toBe(result);
      expect(service.addEditor).toHaveBeenCalledWith('board-1', 'agent-1');
    });

    it('should reject non-creator from adding editor', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      const nonCreatorActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-1' };
      await expect(controller.addEditor('board-1', dto, nonCreatorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.addEditor).not.toHaveBeenCalled();
    });

    it('should allow human owner of creator agent to add editor (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.addEditor.mockResolvedValue(result);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(true);

      const ownerActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-1' };
      expect(await controller.addEditor('board-1', dto, ownerActor)).toBe(result);
      expect(mockOwnerProxyService.isOwnerProxy).toHaveBeenCalledWith('agent-9', ownerActor);
      expect(service.addEditor).toHaveBeenCalledWith('board-1', 'agent-1');
    });

    it('should reject non-owner human on agent-created board (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      service.findById.mockResolvedValue(board);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(false);

      const strangerActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-1' };
      await expect(controller.addEditor('board-1', dto, strangerActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.addEditor).not.toHaveBeenCalled();
    });
  });

  describe('removeEditor', () => {
    it('should allow creator to remove editor', async () => {
      const board = { id: 'board-1', creatorId: 'user-1', creatorType: 'human' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.removeEditor.mockResolvedValue(result);

      const dto = { agentId: 'agent-1' };
      expect(await controller.removeEditor('board-1', dto, mockActor)).toBe(result);
      expect(service.removeEditor).toHaveBeenCalledWith('board-1', 'agent-1');
    });

    it('should reject non-creator from removing editor', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      const nonCreatorActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-1' };
      await expect(controller.removeEditor('board-1', dto, nonCreatorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.removeEditor).not.toHaveBeenCalled();
    });

    it('should allow human owner of creator agent to remove editor (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      const result = { id: 'board-1' };
      service.findById.mockResolvedValue(board);
      service.removeEditor.mockResolvedValue(result);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(true);

      const ownerActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-1' };
      expect(await controller.removeEditor('board-1', dto, ownerActor)).toBe(result);
      expect(mockOwnerProxyService.isOwnerProxy).toHaveBeenCalledWith('agent-9', ownerActor);
      expect(service.removeEditor).toHaveBeenCalledWith('board-1', 'agent-1');
    });

    it('should reject non-owner human on agent-created board (v1.37 owner proxy)', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      service.findById.mockResolvedValue(board);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(false);

      const strangerActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { agentId: 'agent-1' };
      await expect(controller.removeEditor('board-1', dto, strangerActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.removeEditor).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should ensure write permission then update', async () => {
      const board = { id: 'board-1', creatorId: 'user-1', creatorType: 'human' };
      const result = { id: 'board-1', name: 'Updated' };
      service.findById.mockResolvedValue(board);
      service.update.mockResolvedValue(result);

      const dto = { name: 'Updated' };
      expect(await controller.update('board-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.update).toHaveBeenCalledWith('board-1', dto);
    });

    // ─── D6（v1.46 TOPIC-PERM）：结构字段显式 403 替代 v1.37 静默剥离（用户拍板新契约）───

    // 非 admin 的创建者（R4 语义：creator 判定必须用非 admin 身份验证，防 admin bypass 污染）
    const creatorActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
    const editorActor = { id: 'editor-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('editor PATCH topicId → 403，消息列出结构字段名（不再 200 装傻）', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      await expect(
        controller.update('board-1', { topicId: 'topic-2' }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.PERMISSION_DENIED,
            message: expect.stringContaining('topicId'),
          }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor name+topicId → 403 无部分应用（整体拒绝）', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      await expect(
        controller.update('board-1', { name: 'Updated', topicId: 'topic-2' }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor topicId: null 显式值也算结构字段出现（`!== undefined` 探测 = 解绑语义）', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      service.findById.mockResolvedValue(board);

      await expect(
        controller.update('board-1', { topicId: null as never }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.PERMISSION_DENIED,
            message: expect.stringContaining('topicId'),
          }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor 纯内容字段（name/description）→ service 收全 dto（透传，不再剥离）', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      const result = { id: 'board-1', name: 'Updated', description: 'Desc' };
      service.findById.mockResolvedValue(board);
      service.update.mockResolvedValue(result);

      const dto = { name: 'Updated', description: 'Desc' };
      expect(await controller.update('board-1', dto, editorActor)).toBe(result);
      expect(service.update).toHaveBeenCalledWith('board-1', dto);
    });

    it('creator（非 admin）全字段可更新 → 透传持久化', async () => {
      const board = { id: 'board-1', creatorId: 'user-1', creatorType: 'human' };
      const result = { id: 'board-1', name: 'Updated', topicId: 'topic-2' };
      service.findById.mockResolvedValue(board);
      service.update.mockResolvedValue(result);

      const dto = { name: 'Updated', topicId: 'topic-2' };
      expect(await controller.update('board-1', dto, creatorActor)).toBe(result);
      expect(service.update).toHaveBeenCalledWith('board-1', dto);
    });

    it('admin 结构字段可更新（全局 bypass，非 creator 也放行）', async () => {
      const board = { id: 'board-1', creatorId: 'other-user', creatorType: 'human' };
      const result = { id: 'board-1', topicId: 'topic-2' };
      service.findById.mockResolvedValue(board);
      service.update.mockResolvedValue(result);

      const dto = { topicId: 'topic-2' };
      expect(await controller.update('board-1', dto, mockActor)).toBe(result);
      expect(service.update).toHaveBeenCalledWith('board-1', dto);
    });

    it('人类 owner 代理（非 admin 非直接 creator）结构字段可更新（v1.37 owner proxy）', async () => {
      const board = { id: 'board-1', creatorId: 'agent-9', creatorType: 'agent' };
      const result = { id: 'board-1', visibility: Visibility.PRIVATE };
      service.findById.mockResolvedValue(board);
      service.update.mockResolvedValue(result);
      mockOwnerProxyService.isOwnerProxy.mockResolvedValue(true);

      const ownerActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
      const dto = { visibility: Visibility.PRIVATE };
      expect(await controller.update('board-1', dto, ownerActor)).toBe(result);
      expect(mockOwnerProxyService.isOwnerProxy).toHaveBeenCalledWith('agent-9', ownerActor);
      expect(service.update).toHaveBeenCalledWith('board-1', dto);
    });
  });

  describe('getDigest', () => {
    it('should ensure read permission (findOne 读路径) then assemble digest', async () => {
      const board = { id: 'board-1', name: 'Board' };
      const digest = { boardId: 'board-1', boardName: 'Board', truncated: false };
      service.findById.mockResolvedValue(board);
      service.getDigest.mockResolvedValue(digest);

      const query = { openLimit: 5, doneLimit: 3 };
      expect(await controller.getDigest('board-1', query, mockActor)).toBe(digest);
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
      expect(service.getDigest).toHaveBeenCalledWith('board-1', query);
    });

    it('should propagate 403 when read permission denied (ForbiddenException)', async () => {
      const board = { id: 'board-1', name: 'Board' };
      service.findById.mockResolvedValue(board);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({
          message: 'Access denied',
          code: ErrorCode.PERMISSION_DENIED,
        }),
      );

      await expect(controller.getDigest('board-1', {}, mockActor)).rejects.toThrow(
        ForbiddenException,
      );
      expect(service.getDigest).not.toHaveBeenCalled();
    });

    it('should propagate 404 when board does not exist (NotFoundException)', async () => {
      service.findById.mockRejectedValue(
        new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND }),
      );

      await expect(controller.getDigest('board-404', {}, mockActor)).rejects.toThrow(
        NotFoundException,
      );
      expect(permService.ensureCan).not.toHaveBeenCalled();
      expect(service.getDigest).not.toHaveBeenCalled();
    });
  });

  describe('updateMetrics (PUT /boards/:id/metrics, v1.42)', () => {
    it('should ensure write permission then store metrics via service', async () => {
      // 恢复 ensureCan 默认实现：前序 403 测试的 mockRejectedValue 会跨测试残留
      permService.ensureCan.mockResolvedValue(undefined);
      const board = { id: 'board-1', name: 'Board' };
      const stored = { metrics: { testBaseline: { backend: { suites: 76, tests: 1229 } } } };
      service.findById.mockResolvedValue(board);
      service.updateMetrics.mockResolvedValue(stored);

      const dto = { metrics: { testBaseline: { backend: { suites: 76, tests: 1229 } } } };
      expect(await controller.updateMetrics('board-1', dto, mockActor)).toBe(stored);
      expect(service.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'write');
      expect(service.updateMetrics).toHaveBeenCalledWith('board-1', dto.metrics);
    });

    it('should propagate 403 when write permission denied (ForbiddenException)', async () => {
      const board = { id: 'board-1', name: 'Board' };
      service.findById.mockResolvedValue(board);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({
          message: 'Access denied',
          code: ErrorCode.PERMISSION_DENIED,
        }),
      );

      await expect(controller.updateMetrics('board-1', { metrics: {} }, mockActor)).rejects.toThrow(
        ForbiddenException,
      );
      expect(service.updateMetrics).not.toHaveBeenCalled();
    });

    it('should propagate 404 when board does not exist (NotFoundException)', async () => {
      service.findById.mockRejectedValue(
        new NotFoundException({ message: 'Board not found', code: ErrorCode.BOARD_NOT_FOUND }),
      );

      await expect(
        controller.updateMetrics('board-404', { metrics: {} }, mockActor),
      ).rejects.toThrow(NotFoundException);
      expect(permService.ensureCan).not.toHaveBeenCalled();
      expect(service.updateMetrics).not.toHaveBeenCalled();
    });
  });
});
