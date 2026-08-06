import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { DocRouteController } from './doc-route.controller';
import { DocRouteService } from './doc-route.service';
import { DocSpaceService } from './docspace.service';
import { RouteHealthService } from './route-health.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ActorType, ErrorCode, UserRole, Visibility } from '@agent-chamber/shared';

/**
 * DocRouteController 测试（v1.42 批次 B5）
 *
 * 覆盖：权限边界（GET=space read、POST=space write、PATCH/DELETE=所属空间 write）、
 * 404 透传（PATCH/DELETE 先解析路由拿 spaceId）、service 装配参数。
 */
describe('DocRouteController', () => {
  let controller: DocRouteController;
  let routeService: typeof mockRouteService;
  let docSpaceService: typeof mockDocSpaceService;
  let routeHealthService: typeof mockRouteHealthService;
  let permService: typeof mockPermService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const nonAdminActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };

  const mockRouteService = {
    findById: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };

  const mockRouteHealthService = {
    recheckSpace: jest.fn(),
  };

  const mockDocSpaceService = {
    findById: jest.fn(),
  };

  const mockPermService = {
    ensureCan: jest.fn().mockResolvedValue(undefined),
  };

  const space = {
    id: 'space-1',
    name: 'Space',
    settings: { visibility: Visibility.OPEN },
    creatorId: 'user-1',
  };

  const route = {
    id: 'route-1',
    spaceId: 'space-1',
    intent: '我要了解系统架构',
    primaryDocId: 'doc-1',
    sortOrder: 0,
    createdBy: 'user-1',
  };

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DocRouteController],
      providers: [
        { provide: DocRouteService, useValue: mockRouteService },
        { provide: DocSpaceService, useValue: mockDocSpaceService },
        { provide: RouteHealthService, useValue: mockRouteHealthService },
        { provide: PermissionService, useValue: mockPermService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<DocRouteController>(DocRouteController);
    routeService = moduleRef.get<DocRouteService>(
      DocRouteService,
    ) as unknown as typeof routeService;
    docSpaceService = moduleRef.get<DocSpaceService>(
      DocSpaceService,
    ) as unknown as typeof docSpaceService;
    routeHealthService = moduleRef.get<RouteHealthService>(
      RouteHealthService,
    ) as unknown as typeof routeHealthService;
    permService = moduleRef.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof permService;
  });

  afterEach(() => jest.resetAllMocks());

  // ─── GET /doc-spaces/:id/routes ───────────────────────────

  describe('findAll', () => {
    it('ensures space read permission then returns service result', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const result = [route];
      routeService.findAll.mockResolvedValue(result);

      expect(await controller.findAll('space-1', mockActor)).toBe(result);
      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(routeService.findAll).toHaveBeenCalledWith('space-1');
    });

    it('does not call service when read permission denied (404)', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'denied', code: ErrorCode.PERMISSION_DENIED }),
      );
      await expect(controller.findAll('space-1', nonAdminActor)).rejects.toThrow();
      expect(routeService.findAll).not.toHaveBeenCalled();
    });
  });

  // ─── POST /doc-spaces/:id/routes/recheck（批次 C1）────────────────

  describe('recheckRoutes', () => {
    it('ensures space write permission then returns recheckSpace counts', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const counts = { rechecked: 3, broken: 1 };
      routeHealthService.recheckSpace.mockResolvedValue(counts);

      expect(await controller.recheckRoutes('space-1', mockActor)).toBe(counts);
      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(routeHealthService.recheckSpace).toHaveBeenCalledWith('space-1');
    });

    it('does not recheck when space write denied (403)', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'denied', code: ErrorCode.PERMISSION_DENIED }),
      );
      await expect(controller.recheckRoutes('space-1', nonAdminActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(routeHealthService.recheckSpace).not.toHaveBeenCalled();
    });
  });

  // ─── POST /doc-spaces/:id/routes ──────────────────────────

  describe('create', () => {
    it('ensures space write permission then creates with actor', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const dto = { intent: '我要了解系统架构', primaryDocId: 'doc-1' };
      const result = { id: 'route-1', ...dto };
      routeService.create.mockResolvedValue(result);

      expect(await controller.create('space-1', dto as any, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(routeService.create).toHaveBeenCalledWith('space-1', dto, mockActor);
    });

    it('does not call service when write permission denied (403)', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'denied', code: ErrorCode.PERMISSION_DENIED }),
      );
      await expect(
        controller.create('space-1', { intent: 'i', primaryDocId: 'doc-1' } as any, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(routeService.create).not.toHaveBeenCalled();
    });
  });

  // ─── PATCH /doc-routes/:id ────────────────────────────────

  describe('update', () => {
    it('resolves route → space, ensures space write, then updates', async () => {
      routeService.findById.mockResolvedValue(route);
      docSpaceService.findById.mockResolvedValue(space);
      const result = { ...route, sortOrder: 5 };
      routeService.update.mockResolvedValue(result);

      expect(await controller.update('route-1', { sortOrder: 5 } as any, mockActor)).toBe(result);
      expect(routeService.findById).toHaveBeenCalledWith('route-1');
      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(routeService.update).toHaveBeenCalledWith('route-1', { sortOrder: 5 });
    });

    it('does not call service when space write denied (403)', async () => {
      routeService.findById.mockResolvedValue(route);
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'denied', code: ErrorCode.PERMISSION_DENIED }),
      );
      await expect(controller.update('route-1', { sortOrder: 1 } as any, nonAdminActor)).rejects
        .toThrow();
      expect(routeService.update).not.toHaveBeenCalled();
    });

    it('does not check permission when route not found (404 passes through)', async () => {
      routeService.findById.mockRejectedValue(
        new ForbiddenException({ message: 'not found', code: ErrorCode.DOC_ROUTE_NOT_FOUND }),
      );
      await expect(controller.update('route-1', { sortOrder: 1 } as any, mockActor)).rejects
        .toThrow();
      expect(docSpaceService.findById).not.toHaveBeenCalled();
      expect(routeService.update).not.toHaveBeenCalled();
    });
  });

  // ─── DELETE /doc-routes/:id ───────────────────────────────

  describe('remove', () => {
    it('resolves route → space, ensures space write, then deletes', async () => {
      routeService.findById.mockResolvedValue(route);
      docSpaceService.findById.mockResolvedValue(space);
      routeService.remove.mockResolvedValue({ deleted: true });

      expect(await controller.remove('route-1', mockActor)).toEqual({ deleted: true });
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(routeService.remove).toHaveBeenCalledWith('route-1');
    });

    it('does not call service when space write denied (403)', async () => {
      routeService.findById.mockResolvedValue(route);
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'denied', code: ErrorCode.PERMISSION_DENIED }),
      );
      await expect(controller.remove('route-1', nonAdminActor)).rejects.toThrow();
      expect(routeService.remove).not.toHaveBeenCalled();
    });
  });
});
