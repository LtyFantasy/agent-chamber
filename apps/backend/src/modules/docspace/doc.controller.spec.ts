import { Test, TestingModule } from '@nestjs/testing';
import { DocController } from './doc.controller';
import { DocService } from './doc.service';
import { DocMoveService } from './doc-move.service';
import { DocSpaceService } from './docspace.service';
import { DocSearchService } from './doc-search.service';
import { PermissionService } from '../../common/services/permission.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-api-key.guard';
import { UnifiedActor } from '../../common/types/actor.types';
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
    findTree: jest.fn(),
    findFacets: jest.fn(),
    findOne: jest.fn(),
    getContent: jest.fn(),
    getSection: jest.fn(),
    getSections: jest.fn(),
    getSectionByHeadingQuery: jest.fn(),
    patchSection: jest.fn(),
    patchByMatch: jest.fn(),
    appendDoc: jest.fn(),
    upsert: jest.fn(),
    remove: jest.fn(),
    findVersions: jest.fn(),
    findVersion: jest.fn(),
  };

  const mockDocMoveService = {
    computeMoveImpact: jest.fn(),
    move: jest.fn(),
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
        { provide: DocMoveService, useValue: mockDocMoveService },
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
      expect(docService.upsert).toHaveBeenCalledWith('space-1', dto, mockActor, undefined);
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

  // ─── findTree / findFacets（v1.70.0-dev 懒加载目录树）────────

  describe('findTree', () => {
    it('calls service.findTree after ensuring read permission', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const result = {
        prefix: '',
        folders: { items: [], total: 0, hasMore: false },
        docs: { items: [], total: 0, hasMore: false },
      };
      docService.findTree.mockResolvedValue(result);

      const query = {
        prefix: 'memory/',
        sort: 'recent' as const,
        docsLimit: 50,
        foldersLimit: 200,
      };
      expect(await controller.findTree('space-1', query, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(docService.findTree).toHaveBeenCalledWith('space-1', query);
    });

    it('passes null actor through as null (anonymous read allowed)', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      docService.findTree.mockResolvedValue({
        prefix: '',
        folders: { items: [], total: 0, hasMore: false },
        docs: { items: [], total: 0, hasMore: false },
      });

      // CurrentActor 在无认证请求时返回 null（controller 内 actor ?? null 透传）
      await controller.findTree('space-1', {}, null as unknown as UnifiedActor);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, null, 'read');
    });
  });

  describe('findFacets', () => {
    it('calls service.findFacets after ensuring read permission', async () => {
      docSpaceService.findById.mockResolvedValue(space);
      const result = { types: [], tags: [], categories: [] };
      docService.findFacets.mockResolvedValue(result);

      expect(await controller.findFacets('space-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(docService.findFacets).toHaveBeenCalledWith('space-1');
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

      expect(
        await controller.getSection('doc-1', 0, undefined, undefined, undefined, mockActor),
      ).toBe(section);
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

      await controller.getSection('doc-1', 0, 'Setup', undefined, undefined, mockActor);
      expect(docService.getSection).toHaveBeenCalledWith('doc-1', 0, 'Setup');
    });

    it('position takes priority over headingPath', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      docService.getSection.mockResolvedValue({});

      // position + headingPath 同传 → getSection（position 优先，与既有契约一致）
      await controller.getSection('doc-1', 2, 'Setup', undefined, undefined, mockActor);
      expect(docService.getSection).toHaveBeenCalledWith('doc-1', 2, 'Setup');
      expect(docService.getSectionByHeadingQuery).not.toHaveBeenCalled();
    });
  });

  // ─── getSection v1.55：positions[] 批量通道 ──────────────────

  describe('getSection positions[] batch channel', () => {
    it('positions= batch → calls service.getSections and returns batch result', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const batch = {
        docId: 'doc-1',
        docPath: 'test.md',
        sections: [
          {
            position: 1,
            headingPath: 'Setup',
            headingLevel: 2,
            content: 'Steps',
            tokenEstimate: 20,
          },
        ],
        missing: [9],
      };
      docService.getSections.mockResolvedValue(batch);

      expect(
        await controller.getSection('doc-1', undefined, undefined, '1,3,5', undefined, mockActor),
      ).toBe(batch);
      // 权限边界与单节一致：doc → space 解析 + read 校验
      expect(docService.findById).toHaveBeenCalledWith('doc-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      // 逗号分隔字符串解析为 number[]（空白容差）
      expect(docService.getSections).toHaveBeenCalledWith('doc-1', [1, 3, 5]);
    });

    it('rejects batch mixed with single-section locators (400 VALIDATION_ERROR)', async () => {
      await expect(
        controller.getSection('doc-1', 0, undefined, '1,3', undefined, mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      // 格式层快速失败：不发起 doc 解析/权限/批量读取
      expect(docService.findById).not.toHaveBeenCalled();
      expect(docService.getSections).not.toHaveBeenCalled();
    });

    it('rejects malformed positions (non-integer / negative / empty / oversized) with 400', async () => {
      // 非整数
      await expect(
        controller.getSection('doc-1', undefined, undefined, '1,a', undefined, mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      // 负数
      await expect(
        controller.getSection('doc-1', undefined, undefined, '-1', undefined, mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      // 空串
      await expect(
        controller.getSection('doc-1', undefined, undefined, '', undefined, mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      // 超过 MAX_BATCH_POSITIONS(100)
      const tooMany = Array.from({ length: 101 }, (_, i) => i).join(',');
      await expect(
        controller.getSection('doc-1', undefined, undefined, tooMany, undefined, mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      // 全部格式错误都在 findById 之前拦截（层 1 先于层 2）
      expect(docService.findById).not.toHaveBeenCalled();
      expect(docService.getSections).not.toHaveBeenCalled();
    });

    it('still enforces read permission for well-formed batch requests', async () => {
      docService.findById.mockResolvedValue({ id: 'doc-1', spaceId: 'space-1' });
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(
        controller.getSection('doc-1', undefined, undefined, '1', undefined, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(docService.getSections).not.toHaveBeenCalled();
    });
  });

  // ─── getSection v1.55：headingQuery 模糊通道 ─────────────────

  describe('getSection headingQuery fuzzy channel', () => {
    it('headingQuery alone → calls service.getSectionByHeadingQuery', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const section = {
        docId: 'doc-1',
        docPath: 'test.md',
        position: 2,
        headingPath: '2 Design',
        headingLevel: 2,
        content: 'Design',
        tokenEstimate: 10,
      };
      docService.getSectionByHeadingQuery.mockResolvedValue(section);

      expect(
        await controller.getSection('doc-1', undefined, undefined, undefined, 'Design', mockActor),
      ).toBe(section);
      expect(docService.getSectionByHeadingQuery).toHaveBeenCalledWith('doc-1', 'Design');
      expect(docService.getSection).not.toHaveBeenCalled();
    });

    it('position + headingQuery → getSection wins (priority contract)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      docService.getSection.mockResolvedValue({});

      await controller.getSection('doc-1', 3, undefined, undefined, 'Design', mockActor);
      expect(docService.getSection).toHaveBeenCalledWith('doc-1', 3, undefined);
      expect(docService.getSectionByHeadingQuery).not.toHaveBeenCalled();
    });

    it('headingPath + headingQuery → headingPath wins (priority contract)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      docService.getSection.mockResolvedValue({});

      await controller.getSection('doc-1', undefined, 'Setup', undefined, 'Design', mockActor);
      expect(docService.getSection).toHaveBeenCalledWith('doc-1', undefined, 'Setup');
      expect(docService.getSectionByHeadingQuery).not.toHaveBeenCalled();
    });

    it('rejects empty/whitespace headingQuery with 400 (substring match on empty string is meaningless)', async () => {
      docService.findById.mockResolvedValue({ id: 'doc-1', spaceId: 'space-1' });
      docSpaceService.findById.mockResolvedValue(space);

      await expect(
        controller.getSection('doc-1', undefined, undefined, undefined, '', mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      await expect(
        controller.getSection('doc-1', undefined, undefined, undefined, '   ', mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      expect(docService.getSectionByHeadingQuery).not.toHaveBeenCalled();
    });
  });

  // ─── patchSection（section 级写，v1.55 T3）──────────────────

  describe('patchSection', () => {
    it('delegates to service after ensuring write permission (source defaults to native)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = { id: 'doc-1', path: 'test.md', sectionCount: 2, tokenEstimate: 60 };
      docService.patchSection.mockResolvedValue(result);

      expect(
        await controller.patchSection('doc-1', 1, { content: '## A\n\nnew' }, undefined, mockActor),
      ).toBe(result);

      // 权限边界：先 doc → space 解析，再 write 校验（铁律 #21 权限在 Controller 层）
      expect(docService.findById).toHaveBeenCalledWith('doc-1');
      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      // source 缺省 native（与 upsert 契约一致）；expectedSectionHash 缺省 → undefined 透传
      expect(docService.patchSection).toHaveBeenCalledWith(
        'doc-1',
        1,
        '## A\n\nnew',
        'native',
        mockActor,
        undefined,
        undefined, // clientRequestId 透传（v1.63.0）
      );
    });

    it('passes the ?source= query param through to the service', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      docService.patchSection.mockResolvedValue({
        id: 'doc-1',
        path: 'test.md',
        sectionCount: 1,
        tokenEstimate: 10,
      });

      await controller.patchSection('doc-1', 0, { content: 'x' }, 'git:my-repo', mockActor);
      expect(docService.patchSection).toHaveBeenCalledWith(
        'doc-1',
        0,
        'x',
        'git:my-repo',
        mockActor,
        undefined,
        undefined, // clientRequestId 透传（v1.63.0）
      );
    });

    it('passes body.expectedSectionHash through to the service (fail-closed precondition)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      docService.patchSection.mockResolvedValue({
        id: 'doc-1',
        path: 'test.md',
        sectionCount: 1,
        tokenEstimate: 10,
      });

      await controller.patchSection(
        'doc-1',
        0,
        { content: 'x', expectedSectionHash: 'hash-abc' },
        undefined,
        mockActor,
      );
      expect(docService.patchSection).toHaveBeenCalledWith(
        'doc-1',
        0,
        'x',
        'native',
        mockActor,
        'hash-abc',
        undefined, // clientRequestId 透传（v1.63.0）
      );
    });

    it('rejects negative position with 400 VALIDATION_ERROR before any service call (format layer)', async () => {
      await expect(
        controller.patchSection('doc-1', -1, { content: 'x' }, undefined, mockActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      expect(docService.findById).not.toHaveBeenCalled();
      expect(docService.patchSection).not.toHaveBeenCalled();
    });
  });

  // ─── appendDoc（追加写原语，v1.65.0 消费者反馈批 7601e2f5）──────────

  describe('appendDoc', () => {
    it('delegates to service after ensuring write permission (source defaults to native)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = {
        id: 'doc-1',
        path: 'test.md',
        sectionCount: 2,
        tokenEstimate: 60,
        contentHash: 'new-hash',
      };
      docService.appendDoc.mockResolvedValue(result);

      expect(
        await controller.appendDoc('doc-1', { content: '追加内容' }, undefined, mockActor),
      ).toBe(result);

      // 权限边界：先 doc → space 解析，再 write 校验（与 patch 两入口同款）
      expect(docService.findById).toHaveBeenCalledWith('doc-1');
      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      // source 缺省 native；position/headingPath 缺省 → undefined 透传（服务端归一化 'end'）
      expect(docService.appendDoc).toHaveBeenCalledWith(
        'doc-1',
        { content: '追加内容', position: undefined, headingPath: undefined },
        'native',
        mockActor,
        undefined, // clientRequestId 透传（v1.63.0）
      );
    });

    it('passes ?source= / position / headingPath / clientRequestId through to the service', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      docService.appendDoc.mockResolvedValue({
        id: 'doc-1',
        path: 'test.md',
        sectionCount: 1,
        tokenEstimate: 10,
      });

      await controller.appendDoc(
        'doc-1',
        {
          content: 'x',
          position: 'under-heading',
          headingPath: 'Test § 节',
          clientRequestId: 'key-1',
        },
        'git:my-repo',
        mockActor,
      );
      expect(docService.appendDoc).toHaveBeenCalledWith(
        'doc-1',
        { content: 'x', position: 'under-heading', headingPath: 'Test § 节' },
        'git:my-repo',
        mockActor,
        'key-1',
      );
    });

    it('throws 403 when non-editor attempts write (permission in controller layer)', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(
        controller.appendDoc('doc-1', { content: 'x' }, undefined, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(docService.appendDoc).not.toHaveBeenCalled();
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

  // ─── Doc version history (doc history MVP) ─────────────────

  describe('getVersions', () => {
    it('lists version metadata after ensuring read permission', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = [
        {
          version: 2,
          contentHash: 'h2',
          authorActorId: 'u1',
          source: 'patch',
          createdAt: new Date(),
          contentSize: 10,
        },
      ];
      docService.findVersions.mockResolvedValue(result);

      expect(await controller.getVersions('doc-1', mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(docService.findVersions).toHaveBeenCalledWith('doc-1');
    });
  });

  describe('getVersion', () => {
    it('returns version detail after ensuring read permission', async () => {
      const doc = { id: 'doc-1', spaceId: 'space-1' };
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = { version: 2, content: 'x', diff: null };
      docService.findVersion.mockResolvedValue(result);

      expect(await controller.getVersion('doc-1', 2, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'read');
      expect(docService.findVersion).toHaveBeenCalledWith('doc-1', 2);
    });

    it('rejects non-positive version with 400 VALIDATION_ERROR (no service call)', async () => {
      await expect(controller.getVersion('doc-1', 0, mockActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
        }),
      );
      expect(docService.findById).not.toHaveBeenCalled();
      expect(docService.findVersion).not.toHaveBeenCalled();
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

  // ─── getMoveImpact（v1.60：GET /docs/:id/move-impact）─────────────────

  describe('getMoveImpact', () => {
    const doc = { id: 'doc-1', spaceId: 'space-1', path: 'docs/a.md', title: 'A' };

    it('calls computeMoveImpact after resolving doc + read permission', async () => {
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const impact = {
        docId: 'doc-1',
        path: 'docs/a.md',
        inboundLinks: [],
        docRoutes: [],
        taskLinks: [],
        pathBasedLinksToRewrite: [],
      };
      mockDocMoveService.computeMoveImpact.mockResolvedValue(impact);

      expect(await controller.getMoveImpact('doc-1', undefined)).toBe(impact);
      expect(docService.findById).toHaveBeenCalledWith('doc-1');
      expect(docSpaceService.findById).toHaveBeenCalledWith('space-1');
      expect(permService.ensureCan).toHaveBeenCalledWith(space, null, 'read');
      expect(mockDocMoveService.computeMoveImpact).toHaveBeenCalledWith('space-1', doc, undefined);
    });

    it('forwards proposedPath when provided', async () => {
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      mockDocMoveService.computeMoveImpact.mockResolvedValue({});

      await controller.getMoveImpact('doc-1', 'docs/b.md');
      expect(mockDocMoveService.computeMoveImpact).toHaveBeenCalledWith(
        'space-1',
        doc,
        'docs/b.md',
      );
    });

    it('403 when actor lacks read permission (service not called)', async () => {
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(controller.getMoveImpact('doc-1', undefined, nonAdminActor)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(mockDocMoveService.computeMoveImpact).not.toHaveBeenCalled();
    });
  });

  // ─── move（v1.60：POST /docs/:id/move）─────────────────────────────

  describe('move', () => {
    const doc = { id: 'doc-1', spaceId: 'space-1', path: 'docs/a.md', title: 'A' };

    it('calls docMoveService.move after ensuring write permission', async () => {
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      const result = {
        docId: 'doc-1',
        oldPath: 'docs/a.md',
        newPath: 'docs/b.md',
        contentHash: 'h',
        moved: true,
        impact: {},
      };
      mockDocMoveService.move.mockResolvedValue(result);

      const dto = { toPath: 'docs/b.md' };
      expect(await controller.move('doc-1', dto, mockActor)).toBe(result);
      expect(permService.ensureCan).toHaveBeenCalledWith(space, mockActor, 'write');
      expect(mockDocMoveService.move).toHaveBeenCalledWith('doc-1', dto, mockActor);
    });

    it('403 when actor lacks write permission (service not called)', async () => {
      docService.findById.mockResolvedValue(doc);
      docSpaceService.findById.mockResolvedValue(space);
      permService.ensureCan.mockRejectedValue(
        new ForbiddenException({ message: 'Access denied', code: ErrorCode.PERMISSION_DENIED }),
      );

      await expect(
        controller.move('doc-1', { toPath: 'docs/b.md' }, nonAdminActor),
      ).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: ErrorCode.PERMISSION_DENIED }),
        }),
      );
      expect(mockDocMoveService.move).not.toHaveBeenCalled();
    });
  });
});
