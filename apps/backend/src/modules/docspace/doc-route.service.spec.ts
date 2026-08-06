import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DocRouteService } from './doc-route.service';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocService } from './doc.service';
import { ActorType, ErrorCode, UserRole } from '@agent-chamber/shared';

/**
 * DocRouteService 测试（v1.42 批次 B5）
 *
 * 覆盖：CRUD（排序/404）、写时校验矩阵（doc 不存在/软删/跨空间/heading 不可解析/
 * codeEntry 三种非法/超长）、PATCH 重校验触发语义（只改 sortOrder 不触发）。
 */
describe('DocRouteService', () => {
  let service: DocRouteService;
  let routeRepo: jest.Mocked<Repository<DocRoute>>;
  let docRepo: jest.Mocked<Repository<Doc>>;
  let docService: { sectionExistsByHeadingPath: jest.Mock };

  const mockActor = { id: 'user-1', type: ActorType.HUMAN, role: UserRole.ADMIN };

  function makeRoute(overrides: Partial<DocRoute> = {}): DocRoute {
    return {
      id: 'route-1',
      spaceId: 'space-1',
      intent: '我要了解系统架构',
      category: 'architecture',
      primaryDocId: 'doc-1',
      primaryHeadingPath: '## 3. 架构总览',
      secondaryDocId: null,
      secondaryHeadingPath: null,
      codeEntry: 'apps/backend/src/app.module.ts',
      sortOrder: 0,
      createdBy: 'user-1',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      ...overrides,
    } as DocRoute;
  }

  function makeDoc(overrides: Partial<Doc> = {}): Doc {
    return {
      id: 'doc-1',
      spaceId: 'space-1',
      categoryId: null,
      path: 'docs/architecture.md',
      title: '架构',
      summary: null,
      docType: null,
      tags: [],
      source: 'native',
      contentHash: null,
      sectionCount: 1,
      tokenEstimate: 10,
      linkHealth: null,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      ...overrides,
    } as Doc;
  }

  beforeEach(() => {
    routeRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as jest.Mocked<Repository<DocRoute>>;

    docRepo = {
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<Doc>>;

    docService = { sectionExistsByHeadingPath: jest.fn() };

    service = new DocRouteService(
      routeRepo,
      docRepo,
      docService as unknown as DocService,
    );
  });

  afterEach(() => jest.resetAllMocks());

  // ─── findAll ─────────────────────────────────────────────

  describe('findAll', () => {
    it('queries by spaceId with sortOrder ASC then createdAt ASC', async () => {
      const routes = [makeRoute(), makeRoute({ id: 'route-2' })];
      routeRepo.find.mockResolvedValue(routes);

      const result = await service.findAll('space-1');
      expect(result).toBe(routes);
      expect(routeRepo.find).toHaveBeenCalledWith({
        where: { spaceId: 'space-1' },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
    });

    it('returns empty array when no routes', async () => {
      routeRepo.find.mockResolvedValue([]);
      expect(await service.findAll('space-1')).toEqual([]);
    });
  });

  // ─── findById ────────────────────────────────────────────

  describe('findById', () => {
    it('returns route when found', async () => {
      const route = makeRoute();
      routeRepo.findOne.mockResolvedValue(route);
      expect(await service.findById('route-1')).toBe(route);
    });

    it('throws 404 DOC_ROUTE_NOT_FOUND when missing', async () => {
      routeRepo.findOne.mockResolvedValue(null);
      await expect(service.findById('route-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_NOT_FOUND },
      });
    });
  });

  // ─── create ──────────────────────────────────────────────

  describe('create', () => {
    it('persists with createdBy=actor.id and null normalization', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc());
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);

      const dto = {
        intent: '我要了解系统架构',
        category: 'architecture',
        primaryDocId: 'doc-1',
        primaryHeadingPath: '## 3. 架构总览',
        secondaryDocId: undefined,
        secondaryHeadingPath: undefined,
        codeEntry: undefined,
        sortOrder: 3,
      } as any;

      const result = await service.create('space-1', dto, mockActor as any);
      expect(routeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          spaceId: 'space-1',
          createdBy: 'user-1',
          category: 'architecture',
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          sortOrder: 3,
        }),
      );
      expect(result.spaceId).toBe('space-1');
    });

    it('defaults sortOrder to 0', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc());

      const dto = { intent: 'i', primaryDocId: 'doc-1' } as any;
      await service.create('space-1', dto, mockActor as any);
      expect(routeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder: 0 }),
      );
    });
  });

  // ─── 写时校验矩阵（铁律 #21/#22）──────────────────────────

  describe('write-time validation', () => {
    const dto = (overrides: Record<string, unknown> = {}) =>
      ({ intent: 'i', primaryDocId: 'doc-1', ...overrides }) as any;

    it('400 DOC_ROUTE_DOC_NOT_FOUND when primary doc does not exist', async () => {
      docRepo.findOne.mockResolvedValue(null);
      await expect(service.create('space-1', dto(), mockActor as any)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND },
      });
    });

    it('400 DOC_ROUTE_DOC_NOT_FOUND when primary doc soft-deleted (findOne 软删过滤视同不存在)', async () => {
      docRepo.findOne.mockResolvedValue(null);
      await expect(service.create('space-1', dto(), mockActor as any)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND },
      });
    });

    it('400 DOC_ROUTE_DOC_NOT_FOUND when primary doc belongs to another space', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc({ spaceId: 'space-other' }));
      await expect(service.create('space-1', dto(), mockActor as any)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND },
      });
    });

    it('400 DOC_ROUTE_DOC_NOT_FOUND when secondary doc does not exist', async () => {
      docRepo.findOne
        .mockResolvedValueOnce(makeDoc()) // primary ok
        .mockResolvedValueOnce(null); // secondary missing
      await expect(
        service.create('space-1', dto({ secondaryDocId: 'doc-2' }), mockActor as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND },
      });
    });

    it('400 DOC_ROUTE_HEADING_UNRESOLVED when primary headingPath does not resolve', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc());
      docService.sectionExistsByHeadingPath.mockResolvedValue(false);
      await expect(
        service.create('space-1', dto({ primaryHeadingPath: '## 不存在的节' }), mockActor as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_HEADING_UNRESOLVED },
      });
    });

    it('400 DOC_ROUTE_HEADING_UNRESOLVED when secondary headingPath does not resolve', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc());
      docService.sectionExistsByHeadingPath
        .mockResolvedValueOnce(true) // primary ok
        .mockResolvedValueOnce(false); // secondary miss
      await expect(
        service.create(
          'space-1',
          dto({
            primaryHeadingPath: '## 3. 架构总览',
            secondaryDocId: 'doc-2',
            secondaryHeadingPath: '## 不存在的节',
          }),
          mockActor as any,
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_HEADING_UNRESOLVED },
      });
    });

    it('passes when primary headingPath resolves (exact match through docService)', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc());
      docService.sectionExistsByHeadingPath.mockResolvedValue(true);
      await service.create('space-1', dto({ primaryHeadingPath: '## 3. 架构总览' }), mockActor as any);
      expect(docService.sectionExistsByHeadingPath).toHaveBeenCalledWith(
        'doc-1',
        '## 3. 架构总览',
      );
    });

    // ── codeEntry 非法矩阵（三种 + 超长）──

    it.each([
      ['/etc/passwd', 'POSIX 绝对路径'],
      ['C:\\repo\\main.ts', 'Windows 盘符绝对路径'],
      ['../outside.ts', '.. 段（正斜杠）'],
      ['src\\..\\escape.ts', '.. 段（反斜杠）'],
      ['a'.repeat(513), '超长（>512）'],
    ])('400 DOC_ROUTE_INVALID_CODE_ENTRY for %s (%s)', async (codeEntry) => {
      docRepo.findOne.mockResolvedValue(makeDoc());
      await expect(
        service.create('space-1', dto({ codeEntry }), mockActor as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_INVALID_CODE_ENTRY },
      });
    });

    it('accepts a valid relative codeEntry', async () => {
      docRepo.findOne.mockResolvedValue(makeDoc());
      await service.create(
        'space-1',
        dto({ codeEntry: 'apps/backend/src/modules/docspace/doc.service.ts' }),
        mockActor as any,
      );
      expect(routeRepo.save).toHaveBeenCalled();
    });
  });

  // ─── update ──────────────────────────────────────────────

  describe('update', () => {
    it('throws 404 DOC_ROUTE_NOT_FOUND when route missing', async () => {
      routeRepo.findOne.mockResolvedValue(null);
      await expect(service.update('route-1', { sortOrder: 1 } as any)).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_NOT_FOUND },
      });
    });

    it('updates sortOrder without re-running refs validation (refs unchanged)', async () => {
      routeRepo.findOne.mockResolvedValue(makeRoute());
      routeRepo.save.mockImplementation(async (r: any) => r);

      const result = await service.update('route-1', { sortOrder: 9 } as any);
      expect(result.sortOrder).toBe(9);
      expect(docRepo.findOne).not.toHaveBeenCalled();
      expect(docService.sectionExistsByHeadingPath).not.toHaveBeenCalled();
    });

    it('re-validates merged view when headingPath changes (existing primaryDocId)', async () => {
      routeRepo.findOne.mockResolvedValue(makeRoute());
      docRepo.findOne.mockResolvedValue(makeDoc());
      docService.sectionExistsByHeadingPath.mockResolvedValue(false);

      await expect(
        service.update('route-1', { primaryHeadingPath: '## 新节' } as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_HEADING_UNRESOLVED },
      });
      // 合并视图：用现有 primaryDocId 校验新 headingPath
      expect(docService.sectionExistsByHeadingPath).toHaveBeenCalledWith('doc-1', '## 新节');
    });

    it('re-validates new primaryDocId ownership when primaryDocId changes', async () => {
      routeRepo.findOne.mockResolvedValue(makeRoute());
      docRepo.findOne.mockResolvedValue(makeDoc({ id: 'doc-new', spaceId: 'space-other' }));

      await expect(
        service.update('route-1', { primaryDocId: 'doc-new' } as any),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND },
      });
    });

    it('applies non-ref field updates and persists', async () => {
      routeRepo.findOne.mockResolvedValue(makeRoute());
      routeRepo.save.mockImplementation(async (r: any) => r);

      const result = await service.update('route-1', { intent: '新意图', category: 'guide' } as any);
      expect(result.intent).toBe('新意图');
      expect(result.category).toBe('guide');
      expect(routeRepo.save).toHaveBeenCalled();
    });
  });

  // ─── remove ──────────────────────────────────────────────

  describe('remove', () => {
    it('throws 404 when route missing', async () => {
      routeRepo.findOne.mockResolvedValue(null);
      await expect(service.remove('route-1')).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_ROUTE_NOT_FOUND },
      });
    });

    it('hard-deletes and returns { deleted: true }', async () => {
      routeRepo.findOne.mockResolvedValue(makeRoute());
      const result = await service.remove('route-1');
      expect(result).toEqual({ deleted: true });
      expect(routeRepo.delete).toHaveBeenCalledWith({ id: 'route-1' });
    });
  });
});
