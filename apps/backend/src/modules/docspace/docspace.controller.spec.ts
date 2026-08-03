import { Test, TestingModule } from '@nestjs/testing';
import { DocSpaceController } from './docspace.controller';
import { DocSpaceService } from './docspace.service';
import { PermissionService } from '../../common/services/permission.service';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
import { BoardService } from '../board/board.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ActorType, UserRole, ErrorCode, Visibility } from '@agent-chamber/shared';
import { ForbiddenException } from '@nestjs/common';

describe('DocSpaceController', () => {
  let controller: DocSpaceController;
  let service: typeof mockService;
  let permService: typeof mockPermService;
  let boardService: typeof mockBoardService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const nonAdminActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };

  const mockService = {
    findAll: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    enrich: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    inviteAgent: jest.fn(),
    uninviteAgent: jest.fn(),
    addEditor: jest.fn(),
    removeEditor: jest.fn(),
    createCategory: jest.fn(),
    findCategoryById: jest.fn(),
    updateCategory: jest.fn(),
    removeCategory: jest.fn(),
    getOverview: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };

  const mockBoardService = {
    findById: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DocSpaceController],
      providers: [
        { provide: DocSpaceService, useValue: mockService },
        { provide: PermissionService, useValue: mockPermService },
        { provide: BoardService, useValue: mockBoardService },
        { provide: OwnerProxyService, useValue: { isOwnerProxy: jest.fn().mockResolvedValue(false) } },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<DocSpaceController>(DocSpaceController);
    service = moduleRef.get<DocSpaceService>(DocSpaceService) as unknown as typeof service;
    permService = moduleRef.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof permService;
    boardService = moduleRef.get<BoardService>(
      BoardService,
    ) as unknown as typeof boardService;
  });

  afterEach(() => jest.resetAllMocks());

  // ─── findAll ──────────────────────────────────────────────

  describe('findAll', () => {
    it('calls service.findAll with query and actor', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0, hasNext: false, hasPrev: false };
      service.findAll.mockResolvedValue(result);

      const query = { page: 2, pageSize: 10 };
      const response = await controller.findAll(query, mockActor);
      expect(response).toBe(result);
      expect(service.findAll).toHaveBeenCalledWith(query, mockActor);
    });
  });

  // ─── create ───────────────────────────────────────────────

  describe('create', () => {
    it('creates a space', async () => {
      const result = { id: 'space-1' };
      service.create.mockResolvedValue(result);

      const dto = { name: 'New Space' };
      expect(await controller.create(mockActor, dto)).toBe(result);
      expect(service.create).toHaveBeenCalledWith(mockActor, dto);
    });

    it('throws 400 on both topicId and boardId', async () => {
      const dto = { name: 'Test', topicId: 't-1', boardId: 'b-1' };
      await expect(controller.create(mockActor, dto)).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.RESOURCE_CONFLICT }) }),
      );
      expect(service.create).not.toHaveBeenCalled();
    });

    it('validates board access when boardId provided', async () => {
      const board = { id: 'board-1', name: 'Board' };
      boardService.findById.mockResolvedValue(board);
      const result = { id: 'space-1' };
      service.create.mockResolvedValue(result);

      const dto = { name: 'Test', boardId: 'board-1' };
      await controller.create(mockActor, dto);
      expect(boardService.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
    });
  });

  // ─── findOne ──────────────────────────────────────────────

  describe('findOne', () => {
    it('ensures read permission and returns enriched space', async () => {
      const space = { id: 'space-1', name: 'Space', settings: { visibility: Visibility.OPEN } };
      const enriched = { id: 'space-1', name: 'Space', members: [], categories: [] };
      service.findById.mockResolvedValue(space);
      service.enrich.mockResolvedValue(enriched);

      const result = await controller.findOne('space-1', mockActor);
      expect(result).toEqual(enriched);
      expect(service.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(service.enrich).toHaveBeenCalledWith(space);
    });

    it('returns 404 for private space when unauthorized', async () => {
      const space = { id: 'space-1', name: 'Private', settings: { visibility: Visibility.PRIVATE }, creatorId: 'other' };
      service.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(controller.findOne('space-1', nonAdminActor)).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
    });
  });

  // ─── update ───────────────────────────────────────────────

  describe('update', () => {
    it('allows creator to update', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      const result = { id: 'space-1', name: 'Updated' };
      service.findById.mockResolvedValue(space);
      service.update.mockResolvedValue(result);

      const dto = { name: 'Updated' };
      expect(await controller.update('space-1', dto, mockActor)).toBe(result);
      expect(service.update).toHaveBeenCalledWith('space-1', dto);
    });

    it('rejects non-creator', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.update('space-1', { name: 'Test' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('validates board binding on re-bind', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      const board = { id: 'board-1', name: 'Board' };
      service.findById.mockResolvedValue(space);
      boardService.findById.mockResolvedValue(board);
      const result = { id: 'space-1', boardId: 'board-1' };
      service.update.mockResolvedValue(result);

      const dto = { boardId: 'board-1' };
      await controller.update('space-1', dto, mockActor);
      expect(boardService.findById).toHaveBeenCalledWith('board-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(board, mockActor, 'read');
    });
  });

  // ─── remove ───────────────────────────────────────────────

  describe('remove', () => {
    it('allows creator to delete and returns counts', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      const result = { deleted: true, docCount: 3, linkedTaskCount: 2 };
      service.findById.mockResolvedValue(space);
      service.remove.mockResolvedValue(result);

      expect(await controller.remove('space-1', mockActor)).toBe(result);
    });

    it('rejects non-creator', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);

      await expect(controller.remove('space-1', nonAdminActor)).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
    });
  });

  // ─── Members ──────────────────────────────────────────────

  describe('inviteAgent', () => {
    it('allows creator to invite', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      service.findById.mockResolvedValue(space);
      service.inviteAgent.mockResolvedValue(space);

      const dto = { agentId: 'agent-1' };
      expect(await controller.inviteAgent('space-1', dto, mockActor)).toBe(space);
      expect(service.inviteAgent).toHaveBeenCalledWith('space-1', 'agent-1');
    });

    it('rejects non-creator', async () => {
      const space = { id: 'space-1', creatorId: 'other' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.inviteAgent('space-1', { agentId: 'agent-1' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
    });
  });

  describe('uninviteAgent', () => {
    it('allows creator to uninvite', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      service.findById.mockResolvedValue(space);
      service.uninviteAgent.mockResolvedValue(space);

      await controller.uninviteAgent('space-1', { agentId: 'agent-1' }, mockActor);
      expect(service.uninviteAgent).toHaveBeenCalledWith('space-1', 'agent-1');
    });

    it('rejects non-creator', async () => {
      const space = { id: 'space-1', creatorId: 'other' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.uninviteAgent('space-1', { agentId: 'agent-1' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
    });
  });

  describe('addEditor', () => {
    it('allows creator to add editor', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      service.findById.mockResolvedValue(space);
      service.addEditor.mockResolvedValue(space);

      await controller.addEditor('space-1', { agentId: 'agent-1' }, mockActor);
      expect(service.addEditor).toHaveBeenCalledWith('space-1', 'agent-1');
    });

    it('rejects non-creator', async () => {
      const space = { id: 'space-1', creatorId: 'other' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.addEditor('space-1', { agentId: 'agent-1' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
    });
  });

  describe('removeEditor', () => {
    it('allows creator to remove editor', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      service.findById.mockResolvedValue(space);
      service.removeEditor.mockResolvedValue(space);

      await controller.removeEditor('space-1', { agentId: 'agent-1' }, mockActor);
      expect(service.removeEditor).toHaveBeenCalledWith('space-1', 'agent-1');
    });

    it('rejects non-creator', async () => {
      const space = { id: 'space-1', creatorId: 'other' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.removeEditor('space-1', { agentId: 'agent-1' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({ response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }) }),
      );
    });
  });

  // ─── Categories ───────────────────────────────────────────

  describe('createCategory', () => {
    it('ensures write permission then creates category', async () => {
      const space = { id: 'space-1', settings: { visibility: Visibility.OPEN } };
      const result = { id: 'cat-1', name: 'Architecture' };
      service.findById.mockResolvedValue(space);
      service.createCategory.mockResolvedValue(result);

      const dto = { name: 'Architecture' };
      expect(await controller.createCategory('space-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(service.createCategory).toHaveBeenCalledWith('space-1', dto);
    });
  });

  // ─── Overview ─────────────────────────────────────────────

  describe('getOverview', () => {
    it('ensures read permission and returns overview', async () => {
      const space = { id: 'space-1', settings: { visibility: Visibility.OPEN } };
      const result = { spaceId: 'space-1', spaceName: 'Test', categories: [], uncategorized: [], truncated: false };
      service.findById.mockResolvedValue(space);
      service.getOverview.mockResolvedValue(result);

      expect(await controller.getOverview('space-1', {}, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(service.getOverview).toHaveBeenCalledWith('space-1', {});
    });
  });
});
