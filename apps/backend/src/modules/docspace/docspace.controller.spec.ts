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
    // v1.45 DOCSPACE-PERM：creator 转让
    transferCreator: jest.fn(),
    createCategory: jest.fn(),
    findCategoryById: jest.fn(),
    updateCategory: jest.fn(),
    removeCategory: jest.fn(),
    getOverview: jest.fn(),
    // v1.42 批次 C2：repo-manifest 上报
    updateRepoManifest: jest.fn(),
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
        {
          provide: OwnerProxyService,
          useValue: { isOwnerProxy: jest.fn().mockResolvedValue(false) },
        },
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
    boardService = moduleRef.get<BoardService>(BoardService) as unknown as typeof boardService;
  });

  afterEach(() => jest.resetAllMocks());

  // ─── findAll ──────────────────────────────────────────────

  describe('findAll', () => {
    it('calls service.findAll with query and actor', async () => {
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
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
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

  // ─── updateRepoManifest（v1.42 批次 C2）────────────────────

  describe('updateRepoManifest', () => {
    const dto = {
      sha: 'e75475d3c9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d',
      files: ['apps/backend/src/app.module.ts'],
    };

    it('要求 space write 权限（ensureCan write），通过后透传 dto 到 service', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      const result = {
        repoManifest: { ...dto, reportedAt: '2026-08-06T00:00:00.000Z' },
      };
      service.findById.mockResolvedValue(space);
      service.updateRepoManifest.mockResolvedValue(result);

      const response = await controller.updateRepoManifest('space-1', dto, mockActor);

      expect(service.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(service.updateRepoManifest).toHaveBeenCalledWith('space-1', dto);
      expect(response).toBe(result);
    });

    it('无 write 权限 → 403，service 不调用（权限门在 Controller，铁律 #21）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(controller.updateRepoManifest('space-1', dto, nonAdminActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.updateRepoManifest).not.toHaveBeenCalled();
    });

    it('空间不存在 → findById 404 透传（不落库）', async () => {
      service.findById.mockRejectedValue(
        new ForbiddenException({ message: 'Not found', code: ErrorCode.DOC_SPACE_NOT_FOUND }),
      );

      await expect(controller.updateRepoManifest('space-1', dto, mockActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.DOC_SPACE_NOT_FOUND }),
        }),
      );
      expect(permService.ensureCan).not.toHaveBeenCalled();
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
      const space = {
        id: 'space-1',
        name: 'Private',
        settings: { visibility: Visibility.PRIVATE },
        creatorId: 'other',
      };
      service.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(controller.findOne('space-1', nonAdminActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
    });
  });

  // ─── update（v1.45 字段级分权：内容字段 policy write / 结构字段 creator-only）───

  describe('update', () => {
    // 非 admin 的创建者（R4 语义：creator 判定必须用非 admin 身份验证，防 admin bypass 污染）
    const creatorActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };
    // 非 creator 非 admin（editor 成员身份由 permService mock 模拟）
    const editorActor = { id: 'editor-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('creator（非 admin）全字段可更新', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      const result = { id: 'space-1', name: 'Updated' };
      service.findById.mockResolvedValue(space);
      service.update.mockResolvedValue(result);

      const dto = { name: 'Updated', visibility: Visibility.PRIVATE };
      expect(await controller.update('space-1', dto, creatorActor)).toBe(result);
      expect(service.update).toHaveBeenCalledWith('space-1', dto);
    });

    it('editor 纯内容字段（name/description）→ 放行（policy write）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      const result = { id: 'space-1', name: 'Updated' };
      service.findById.mockResolvedValue(space);
      service.update.mockResolvedValue(result);

      const dto = { name: 'Updated' };
      expect(await controller.update('space-1', dto, editorActor)).toBe(result);
      // 内容路径直接走 policy write（不自造 isCreatorOrEditor 判断）
      expect(permService.ensureCan).toHaveBeenCalledWith(space, editorActor, 'write');
      expect(service.update).toHaveBeenCalledWith('space-1', dto);
    });

    it('editor + visibility → 403，消息列出结构字段名（R1）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.update('space-1', { visibility: Visibility.PRIVATE }, editorActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.PERMISSION_DENIED,
            message: expect.stringContaining('visibility'),
          }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor + boardId: null → 403（显式 null 也算「出现」= 解绑语义，truthy 判断是 bug）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);

      await expect(controller.update('space-1', { boardId: null }, editorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: ErrorCode.PERMISSION_DENIED,
            message: expect.stringContaining('boardId'),
          }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('editor + 多结构字段 → 403 消息列出全部出现字段（R1 自修正能力）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.update(
          'space-1',
          { visibility: Visibility.PRIVATE, boardId: null },
          editorActor,
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            message: expect.stringContaining('visibility'),
          }),
        }),
      );
      await expect(
        controller.update(
          'space-1',
          { visibility: Visibility.PRIVATE, boardId: null },
          editorActor,
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            message: expect.stringContaining('boardId'),
          }),
        }),
      );
    });

    it('非成员 human + name → 403（policy write 拒绝）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      service.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(controller.update('space-1', { name: 'Test' }, editorActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.update).not.toHaveBeenCalled();
    });

    it('admin 结构字段可更新（全局 bypass，非 creator 也放行）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      const result = { id: 'space-1', visibility: Visibility.PRIVATE };
      service.findById.mockResolvedValue(space);
      service.update.mockResolvedValue(result);

      expect(
        await controller.update('space-1', { visibility: Visibility.PRIVATE }, mockActor),
      ).toBe(result);
      expect(service.update).toHaveBeenCalledWith('space-1', { visibility: Visibility.PRIVATE });
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
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
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
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
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
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
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
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
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
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
    });
  });

  describe('transferCreator', () => {
    const creatorActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.EDITOR };

    it('creator（非 admin）可转让，返回 enrich 后的 space', async () => {
      const space = { id: 'space-1', creatorId: 'user-1' };
      const updated = { id: 'space-1', creatorId: 'agent-9' };
      const enriched = { id: 'space-1', creatorId: 'agent-9', members: [], categories: [] };
      service.findById.mockResolvedValue(space);
      service.transferCreator.mockResolvedValue(updated);
      service.enrich.mockResolvedValue(enriched);

      const dto = { newCreatorId: 'agent-9' };
      expect(await controller.transferCreator('space-1', dto, creatorActor)).toBe(enriched);
      expect(service.transferCreator).toHaveBeenCalledWith('space-1', 'agent-9');
      expect(service.enrich).toHaveBeenCalledWith(updated);
    });

    it('rejects non-creator（editor 403，service 不调用）', async () => {
      const space = { id: 'space-1', creatorId: 'other' };
      service.findById.mockResolvedValue(space);

      await expect(
        controller.transferCreator('space-1', { newCreatorId: 'agent-9' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(service.transferCreator).not.toHaveBeenCalled();
    });

    it('admin 可转让（全局 bypass，非 creator 也放行）', async () => {
      const space = { id: 'space-1', creatorId: 'other-user' };
      const updated = { id: 'space-1', creatorId: 'agent-9' };
      service.findById.mockResolvedValue(space);
      service.transferCreator.mockResolvedValue(updated);
      service.enrich.mockResolvedValue(updated);

      expect(
        await controller.transferCreator('space-1', { newCreatorId: 'agent-9' }, mockActor),
      ).toBe(updated);
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
      const result = {
        spaceId: 'space-1',
        spaceName: 'Test',
        categories: [],
        uncategorized: [],
        truncated: false,
      };
      service.findById.mockResolvedValue(space);
      service.getOverview.mockResolvedValue(result);

      expect(await controller.getOverview('space-1', {}, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(service.getOverview).toHaveBeenCalledWith('space-1', {});
    });
  });
});
