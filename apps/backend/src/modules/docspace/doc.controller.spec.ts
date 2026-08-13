import { Test, TestingModule } from '@nestjs/testing';
import { DocController } from './doc.controller';
import { DocService } from './doc.service';
import { DocSpaceService } from './docspace.service';
import { DocSearchService } from './doc-search.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { ActorType, UserRole, ErrorCode, Visibility } from '@agent-chamber/shared';
import { ForbiddenException } from '@nestjs/common';

describe('DocController', () => {
  let controller: DocController;
  let docService: typeof mockDocService;
  let docSpaceService: typeof mockDocSpaceService;
  let permService: typeof mockPermService;

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };
  const nonAdminActor = { id: 'user-2', type: ActorType.HUMAN, role: UserRole.EDITOR };

  const mockDocService = {
    findById: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    getContent: jest.fn(),
    getSection: jest.fn(),
    upsert: jest.fn(),
    remove: jest.fn(),
  };

  const mockDocSearchService = {
    search: jest.fn(),
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

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DocController],
      providers: [
        { provide: DocService, useValue: mockDocService },
        { provide: DocSearchService, useValue: mockDocSearchService },
        { provide: DocSpaceService, useValue: mockDocSpaceService },
        { provide: PermissionService, useValue: mockPermService },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<DocController>(DocController);
    docService = moduleRef.get<DocService>(DocService) as unknown as typeof docService;
    docSpaceService = moduleRef.get<DocSpaceService>(
      DocSpaceService,
    ) as unknown as typeof docSpaceService;
    permService = moduleRef.get<PermissionService>(
      PermissionService,
    ) as unknown as typeof permService;
  });

  afterEach(() => jest.resetAllMocks());

  // ─── upsert ───────────────────────────────────────────────

  describe('upsert', () => {
    it('calls service.upsert after ensuring write permission', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const result = { id: 'doc-1', path: 'test.md', sectionCount: 1, tokenEstimate: 50 };
      docService.upsert.mockResolvedValue(result);

      const dto = { path: 'test.md', content: '# Hello' };
      expect(await controller.upsert('space-1', dto, mockActor)).toBe(result);

      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(docService.upsert).toHaveBeenCalledWith('space-1', dto, mockActor);
    });

    it('throws 403 when non-editor attempts write', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(
        controller.upsert('space-1', { path: 'test.md', content: '# Hello' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(docService.upsert).not.toHaveBeenCalled();
    });
  });

  // ─── findAll ──────────────────────────────────────────────

  describe('findAll', () => {
    it('calls service.findAll after ensuring read permission', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const result = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      docService.findAll.mockResolvedValue(result);

      const query = { page: 1, pageSize: 20 };
      expect(await controller.findAll('space-1', query, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(docService.findAll).toHaveBeenCalledWith('space-1', query);
    });
  });

  // ─── findOne ──────────────────────────────────────────────

  describe('findOne', () => {
    it('returns doc detail with sections (no content)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1', path: 'test.md', title: 'Test' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const detail = { id: 'doc-1', sections: [], mode: 'outline' };
      docService.findOne.mockResolvedValue(detail);

      // 未传 maxFullTokens → 透传 undefined（service 缺省用模块常量阈值）
      expect(await controller.findOne('doc-1', undefined, {}, mockActor)).toBe(detail);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(docService.findOne).toHaveBeenCalledWith('doc-1', undefined);
    });

    it('passes maxFullTokens query value through to service (threshold override)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const detail = { id: 'doc-1', mode: 'full', content: '...' };
      docService.findOne.mockResolvedValue(detail);

      // 放大阈值（5000）与强制 outline（0）都必须原样透传
      expect(await controller.findOne('doc-1', 5000, {}, mockActor)).toBe(detail);
      expect(docService.findOne).toHaveBeenCalledWith('doc-1', 5000);

      expect(await controller.findOne('doc-1', 0, {}, mockActor)).toBe(detail);
      expect(docService.findOne).toHaveBeenCalledWith('doc-1', 0);
    });
    // 注：非法值（非整数 / 越界 [0, 100000]）由 ParseIntPipe + DocDetailQueryDto 在请求
    // 管线层拦截返回 400（controller 单元测试直调不跑 pipe），DTO 校验见
    // doc-detail-query.dto.spec.ts；service 层收不到非法值。
  });

  // ─── getContent ───────────────────────────────────────────

  describe('getContent', () => {
    it('returns full concatenated content', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const content = {
        docId: 'doc-1',
        docPath: 'test.md',
        title: 'Test',
        content: '# Hello\n\nWorld',
      };
      docService.getContent.mockResolvedValue(content);

      expect(await controller.getContent('doc-1', mockActor)).toBe(content);
    });
  });

  // ─── getSection ───────────────────────────────────────────

  describe('getSection', () => {
    it('finds section by position', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const section = {
        docId: 'doc-1',
        docPath: 'test.md',
        position: 0,
        headingPath: 'Intro',
        headingLevel: 1,
        content: 'Hello',
        tokenEstimate: 10,
      };
      docService.getSection.mockResolvedValue(section);

      expect(await controller.getSection('doc-1', 0, undefined, mockActor)).toBe(section);
    });

    it('passes headingPath query param to service', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const section = {
        docId: 'doc-1',
        docPath: 'test.md',
        position: 1,
        headingPath: 'Setup',
        headingLevel: 2,
        content: 'Steps',
        tokenEstimate: 20,
      };
      docService.getSection.mockResolvedValue(section);

      await controller.getSection('doc-1', 0, 'Setup', mockActor);
      expect(docService.getSection).toHaveBeenCalledWith('doc-1', 0, 'Setup');
    });
  });

  // ─── remove ───────────────────────────────────────────────

  describe('remove', () => {
    it('soft-deletes after ensuring write permission', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = { deleted: true, path: 'test.md' };
      docService.remove.mockResolvedValue(result);

      expect(await controller.remove('doc-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      // 未带 source 时透传 undefined（native 文档照常删除）
      expect(docService.remove).toHaveBeenCalledWith('doc-1', undefined, mockActor);
    });

    it('passes the ?source= query param through to the service (source matching)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = { deleted: true, path: 'test.md' };
      docService.remove.mockResolvedValue(result);

      expect(await controller.remove('doc-1', mockActor, 'git:my-repo')).toBe(result);
      // ingest 清理链路（sync-docs.mjs）依赖 source 精确透传给 service 做匹配校验
      expect(docService.remove).toHaveBeenCalledWith('doc-1', 'git:my-repo', mockActor);
    });
  });

  // ─── Permission matrix sampling ────────────────────────────

  describe('permission matrix', () => {
    it('non-member gets read rejected on private space', async () => {
      const privateSpace = {
        id: 'space-1',
        settings: { visibility: Visibility.PRIVATE },
        creatorId: 'other',
      };
      docSpaceService.findById.mockResolvedValue(privateSpace);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(controller.findAll('space-1', {}, nonAdminActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
    });

    it('member without editor role gets write rejected (403)', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(
        controller.upsert('space-1', { path: 'test.md', content: '# Hello' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
    });
  });
});
