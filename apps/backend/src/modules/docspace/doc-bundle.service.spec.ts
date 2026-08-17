/**
 * DocBundleService 单元测试（任务 T6：空间级全量导出/回导）
 *
 * 覆盖：导出 bundle 形状（space meta/categories/docs 全文/routes 含 codeEntryType）、
 * 孤儿路由 primaryDocPath=null、formatVersion 校验（400 VALIDATION_ERROR）、
 * categories 按 name 幂等（存在更新/歧义 failed）、routes 按 intent+primaryDocPath
 * 幂等（存在更新/解析失败 per-item failed 不中止）、space meta 默认不回写 +
 * overwriteSpaceMeta=true 显式覆盖（保留空间身份字段）。
 *
 * 真实 PG 的 roundtrip 无损/幂等再导入/导入冲突覆盖在 docspace-bundle.e2e-spec.ts
 * （铁律 #23：ORM SQL 生成与 chunk 往返 mock 测不出）。
 */
import { BadRequestException } from '@nestjs/common';
import { ActorType, ErrorCode, Visibility } from '@agent-chamber/shared';
import { DocSpaceService } from './docspace.service';
import { DocService } from './doc.service';
import { DocRouteService } from './doc-route.service';
import { DocBundleService } from './doc-bundle.service';
import { DOC_BUNDLE_FORMAT_VERSION } from './dto';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';

const mockActor = { id: 'actor-0001', type: ActorType.HUMAN };

function makeSpace(overrides: Partial<DocSpace> = {}): DocSpace {
  return {
    id: 'space-1',
    name: 'Source Space',
    slug: 'source-space',
    description: '图例',
    topicId: null,
    boardId: null,
    creatorId: 'user-1',
    settings: { visibility: Visibility.OPEN, overviewFilter: { excludeTypes: ['memory'] } },
    docCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as DocSpace;
}

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'doc-1',
    spaceId: 'space-1',
    categoryId: 'cat-1',
    path: 'docs/a.md',
    title: 'Doc A',
    summary: '摘要 A',
    docType: 'guide',
    tags: ['backend'],
    source: 'native',
    contentHash: 'abc',
    sourceSha: null,
    sectionCount: 2,
    tokenEstimate: 100,
    linkHealth: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as Doc;
}

function makeRoute(overrides: Partial<DocRoute> = {}): DocRoute {
  return {
    id: 'route-1',
    spaceId: 'space-1',
    intent: '我要了解架构',
    category: 'architecture',
    primaryDocId: 'doc-1',
    primaryHeadingPath: null,
    secondaryDocId: null,
    secondaryHeadingPath: null,
    codeEntry: 'apps/backend/src/',
    codeEntryType: 'exact',
    health: null,
    sortOrder: 10,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DocRoute;
}

/**
 * 简易内存 find（按 where 等值匹配；IsNull 操作符特判为 null/undefined 匹配）。
 * 单测不依赖真实 ORM SQL 生成（那是 e2e 的职责，铁律 #23）。
 */
function findFrom<T extends object>(store: T[]): jest.Mock {
  return jest.fn(async (opts?: { where?: Record<string, unknown> }) => {
    const where = opts?.where ?? {};
    return store.filter((item) =>
      Object.entries(where).every(([k, v]) => {
        const actual = (item as unknown as Record<string, unknown>)[k];
        if (
          v &&
          typeof v === 'object' &&
          typeof (v as { type?: string }).type === 'string' &&
          (v as { type: string }).type === 'isNull'
        ) {
          return actual === null || actual === undefined;
        }
        return actual === v;
      }),
    );
  });
}

describe('DocBundleService', () => {
  let service: DocBundleService;
  let docspaceService: jest.Mocked<
    Pick<DocSpaceService, 'findById' | 'createCategory' | 'updateCategory'>
  >;
  let docService: jest.Mocked<Pick<DocService, 'getContent' | 'batchUpsert'>>;
  let docRouteService: jest.Mocked<Pick<DocRouteService, 'create' | 'update'>>;
  let spaceRepo: { save: jest.Mock };
  let categoryRepo: { find: jest.Mock };
  let docRepo: { find: jest.Mock };
  let routeRepo: { find: jest.Mock };

  /** 注入真实私有方法依赖（DocBundleService 无 DI 框架时直接 new + 私有方法经公有入口触达） */
  function buildService() {
    service = new DocBundleService(
      docspaceService as unknown as DocSpaceService,
      docService as unknown as DocService,
      docRouteService as unknown as DocRouteService,
      spaceRepo as unknown as never,
      categoryRepo as unknown as never,
      docRepo as unknown as never,
      routeRepo as unknown as never,
    );
  }

  /** 构造一个最小合法 bundle（导出产物同形） */
  function makeBundle(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      formatVersion: DOC_BUNDLE_FORMAT_VERSION,
      exportedAt: '2026-08-16T00:00:00.000Z',
      space: {
        name: 'Source Space',
        description: '图例',
        visibility: Visibility.OPEN,
        settings: { visibility: Visibility.OPEN, overviewFilter: { excludeTypes: ['memory'] } },
      },
      categories: [{ name: 'Arch', slug: 'arch', description: null, sortOrder: 0 }],
      routes: [
        {
          intent: '我要了解架构',
          category: 'architecture',
          primaryDocPath: 'docs/a.md',
          primaryHeadingPath: null,
          secondaryDocPath: null,
          secondaryHeadingPath: null,
          codeEntry: 'apps/backend/src/',
          codeEntryType: 'exact',
          sortOrder: 10,
        },
      ],
      docs: [
        {
          path: 'docs/a.md',
          title: 'Doc A',
          summary: '摘要 A',
          docType: 'guide',
          tags: ['backend'],
          category: 'Arch',
          content: '# Doc A\n\n正文。',
        },
      ],
      ...overrides,
    } as never; // 顶层 as never 交由 importBundle 的 ImportDocBundleDto 参数在运行时透传（单测只测行为不测 DTO 校验）
  }

  beforeEach(() => {
    docspaceService = {
      findById: jest.fn(),
      createCategory: jest.fn(async (spaceId: string, dto: { name: string }) => ({
        id: `cat-new-${dto.name}`,
        spaceId,
        ...dto,
        slug: (dto as { slug?: string }).slug ?? dto.name,
        description: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      })),
      updateCategory: jest.fn(async (id: string, dto: Record<string, unknown>) => ({
        id,
        ...dto,
        deletedAt: null,
      })),
    } as never;

    docService = {
      getContent: jest.fn(async (docId: string, full: boolean) => ({
        docId,
        docPath: 'docs/a.md',
        title: 'Doc A',
        content: full ? '# Doc A\n\n正文。' : '去重版',
      })),
      batchUpsert: jest.fn(
        async (_spaceId: string, docs: Array<{ path: string }>, _actor: unknown) => ({
          results: docs.map((d) => ({
            path: d.path,
            status: 'created' as const,
            id: `doc-${d.path}`,
          })),
          summary: {
            total: docs.length,
            created: docs.length,
            updated: 0,
            unchanged: 0,
            failed: 0,
          },
        }),
      ),
    } as never;

    docRouteService = {
      create: jest.fn(
        async (spaceId: string, dto: Record<string, unknown>, actor: { id: string }) => ({
          id: 'route-new',
          spaceId,
          ...dto,
          createdBy: actor.id,
        }),
      ),
      update: jest.fn(async (id: string, dto: Record<string, unknown>) => ({ id, ...dto })),
    } as never;

    spaceRepo = { save: jest.fn(async (x: unknown) => x) };
    categoryRepo = { find: findFrom<DocCategory>([]) };
    docRepo = { find: findFrom<Doc>([]) };
    routeRepo = { find: findFrom<DocRoute>([]) };
    buildService();
  });

  // ─── export ────────────────────────────────────────────────

  describe('exportBundle', () => {
    it('happy：完整 bundle 形状——space meta / categories / docs 全文 / routes（含 codeEntryType）', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([
        {
          id: 'cat-1',
          spaceId: 'space-1',
          name: 'Arch',
          slug: 'arch',
          description: null,
          sortOrder: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      ]);
      docRepo.find = findFrom<Doc>([makeDoc()]);
      routeRepo.find = findFrom<DocRoute>([makeRoute()]);

      const bundle = await service.exportBundle('space-1');

      expect(bundle.formatVersion).toBe(DOC_BUNDLE_FORMAT_VERSION);
      expect(bundle.exportedAt).toBeDefined();
      // space meta：visibility 从 settings 派生、settings 原样透传
      expect(bundle.space).toEqual({
        name: 'Source Space',
        description: '图例',
        visibility: Visibility.OPEN,
        settings: { visibility: Visibility.OPEN, overviewFilter: { excludeTypes: ['memory'] } },
      });
      // categories：策展字段全量
      expect(bundle.categories).toEqual([
        { name: 'Arch', slug: 'arch', description: null, sortOrder: 5 },
      ]);
      // docs：category 解析为 name、content 走 full=true 完整原文
      expect(bundle.docs).toHaveLength(1);
      expect(bundle.docs[0]).toMatchObject({
        path: 'docs/a.md',
        title: 'Doc A',
        summary: '摘要 A',
        docType: 'guide',
        tags: ['backend'],
        category: 'Arch',
        content: '# Doc A\n\n正文。',
      });
      expect(docService.getContent).toHaveBeenCalledWith('doc-1', true);
      // routes：docId → path 解析 + codeEntryType 透传
      expect(bundle.routes).toEqual([
        {
          intent: '我要了解架构',
          category: 'architecture',
          primaryDocPath: 'docs/a.md',
          primaryHeadingPath: null,
          secondaryDocPath: null,
          secondaryHeadingPath: null,
          codeEntry: 'apps/backend/src/',
          codeEntryType: 'exact',
          sortOrder: 10,
        },
      ]);
    });

    it('孤儿路由：primaryDocId 指向的 doc 不在导出集（软删）→ primaryDocPath=null 保真不丢行', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([makeDoc()]);
      // 路由指向 doc-999（不存在/软删）
      routeRepo.find = findFrom<DocRoute>([
        makeRoute({ id: 'route-orphan', primaryDocId: 'doc-999' }),
      ]);

      const bundle = await service.exportBundle('space-1');

      expect(bundle.routes).toHaveLength(1);
      expect(bundle.routes[0].primaryDocPath).toBeNull();
      expect(bundle.routes[0].intent).toBe('我要了解架构');
    });

    it('doc 指向已软删分类 → category=null（未分类），不炸导出', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]); // 无该分类（等同已删）
      docRepo.find = findFrom<Doc>([makeDoc({ categoryId: 'cat-deleted' })]);
      routeRepo.find = findFrom<DocRoute>([]);

      const bundle = await service.exportBundle('space-1');

      expect(bundle.docs[0].category).toBeNull();
    });
  });

  // ─── import：formatVersion ─────────────────────────────────

  describe('importBundle formatVersion 校验', () => {
    it('不匹配 → 400 BadRequestException + VALIDATION_ERROR，不触碰任何写', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());

      const bad = makeBundle({ formatVersion: 99 });
      await expect(service.importBundle('space-1', bad as never, mockActor)).rejects.toMatchObject({
        response: { code: ErrorCode.VALIDATION_ERROR },
      });
      expect(docService.batchUpsert).not.toHaveBeenCalled();
      expect(docRouteService.create).not.toHaveBeenCalled();
      expect(spaceRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── import：四阶段 + 幂等 ─────────────────────────────────

  describe('importBundle', () => {
    it('happy：categories → docs → routes 有序执行，space meta 默认跳过', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      // importRoutes 的 path→docId 解析表 = docs 阶段落库产物（batchUpsert 是 mock，
      // 这里手工铺一份等价结果）
      docRepo.find = findFrom<Doc>([makeDoc()]);
      routeRepo.find = findFrom<DocRoute>([]);

      const result = await service.importBundle('space-1', makeBundle(), mockActor);

      // 阶段① categories：创建
      expect(result.categories.summary).toEqual({ total: 1, created: 1, updated: 0, failed: 0 });
      expect(docspaceService.createCategory).toHaveBeenCalledWith('space-1', {
        name: 'Arch',
        slug: 'arch',
        description: null,
        sortOrder: 0,
      });
      // 阶段② docs：batchUpsert 收 bundle docs（category/tags 原样透传）
      expect(result.docs.summary).toEqual({
        total: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        failed: 0,
      });
      expect(docService.batchUpsert).toHaveBeenCalledWith(
        'space-1',
        [
          expect.objectContaining({
            path: 'docs/a.md',
            content: '# Doc A\n\n正文。',
            title: 'Doc A',
            summary: '摘要 A',
            docType: 'guide',
            tags: ['backend'],
            category: 'Arch',
          }),
        ],
        mockActor,
      );
      // 阶段③ routes：创建（path 解析到 doc-1）
      expect(result.routes.summary).toEqual({ total: 1, created: 1, updated: 0, failed: 0 });
      expect(docRouteService.create).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({
          intent: '我要了解架构',
          primaryDocId: 'doc-1',
          codeEntryType: 'exact',
          sortOrder: 10,
        }),
        mockActor,
      );
      // 阶段④：默认跳过（applied=false）
      expect(result.spaceMeta).toEqual({ applied: false, status: 'skipped' });
      expect(spaceRepo.save).not.toHaveBeenCalled();

      // 顺序：categories 先于 docs 先于 routes
      const order = [
        (docspaceService.createCategory as jest.Mock).mock.invocationCallOrder[0],
        (docService.batchUpsert as jest.Mock).mock.invocationCallOrder[0],
        (docRouteService.create as jest.Mock).mock.invocationCallOrder[0],
      ];
      expect(order[0]).toBeLessThan(order[1]);
      expect(order[1]).toBeLessThan(order[2]);
    });

    it('categories 幂等：name 已存在 → update 而非 create；重复 name → 该条 failed 不中止', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      // 目标空间已有同名分类 + 一条重复 name（歧义场景）
      categoryRepo.find = findFrom<DocCategory>([
        {
          id: 'cat-existing',
          spaceId: 'space-1',
          name: 'Arch',
          slug: 'old-slug',
          description: null,
          sortOrder: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      ]);
      docRepo.find = findFrom<Doc>([]);
      routeRepo.find = findFrom<DocRoute>([]);

      // 先导入一次（update 路径）
      const r1 = await service.importBundle('space-1', makeBundle(), mockActor);
      expect(r1.categories.summary).toEqual({ total: 1, created: 0, updated: 1, failed: 0 });
      expect(docspaceService.updateCategory).toHaveBeenCalledWith('cat-existing', {
        name: 'Arch',
        slug: 'arch',
        description: null,
        sortOrder: 0,
      });
      expect(docspaceService.createCategory).not.toHaveBeenCalled();

      // 歧义：同名两条 → 该条 failed，批次继续（docs/routes 不受影响）
      categoryRepo.find = findFrom<DocCategory>([
        {
          id: 'cat-x',
          spaceId: 'space-1',
          name: 'Arch',
          slug: 'a',
          description: null,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
        {
          id: 'cat-y',
          spaceId: 'space-1',
          name: 'Arch',
          slug: 'b',
          description: null,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      ]);
      const r2 = await service.importBundle('space-1', makeBundle(), mockActor);
      expect(r2.categories.summary).toEqual({ total: 1, created: 0, updated: 0, failed: 1 });
      expect(r2.categories.results[0].error?.message).toContain('Ambiguous category name');
      expect(r2.docs.summary.created).toBe(1); // 批次未中止
    });

    it('routes 幂等：(intent, primaryDocPath) 已存在 → update；primaryDocPath 解析不到 → 该条 failed 不中止', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      // 目标空间已有同 intent + 同 primaryDocId 的路由
      routeRepo.find = findFrom<DocRoute>([
        {
          id: 'route-existing',
          spaceId: 'space-1',
          intent: '我要了解架构',
          primaryDocId: 'doc-1',
          category: 'architecture',
          primaryHeadingPath: null,
          secondaryDocId: null,
          secondaryHeadingPath: null,
          codeEntry: null,
          codeEntryType: 'exact',
          sortOrder: 0,
          createdBy: 'u',
          createdAt: new Date(),
          updatedAt: new Date(),
          health: null,
        },
      ]);
      // docs 阶段产物：doc-1 存在
      docRepo.find = findFrom<Doc>([makeDoc()]);

      const r1 = await service.importBundle('space-1', makeBundle(), mockActor);
      expect(r1.routes.summary).toEqual({ total: 1, created: 0, updated: 1, failed: 0 });
      expect(docRouteService.update).toHaveBeenCalledWith(
        'route-existing',
        expect.objectContaining({
          intent: '我要了解架构',
          primaryDocId: 'doc-1',
          codeEntry: 'apps/backend/src/',
        }),
      );
      expect(docRouteService.create).not.toHaveBeenCalled();

      // 解析失败：bundle 路由指向目标空间不存在的 doc path → per-item failed，批次继续
      const r2 = await service.importBundle(
        'space-1',
        makeBundle({
          routes: [
            {
              intent: '孤路由',
              category: null,
              primaryDocPath: 'docs/ghost.md',
              primaryHeadingPath: null,
              secondaryDocPath: null,
              secondaryHeadingPath: null,
              codeEntry: null,
              codeEntryType: 'exact',
              sortOrder: 0,
            },
            {
              intent: '正常路由',
              category: null,
              primaryDocPath: 'docs/a.md',
              primaryHeadingPath: null,
              secondaryDocPath: null,
              secondaryHeadingPath: null,
              codeEntry: null,
              codeEntryType: 'exact',
              sortOrder: 1,
            },
          ],
        }),
        mockActor,
      );
      expect(r2.routes.summary).toEqual({ total: 2, created: 1, updated: 0, failed: 1 });
      expect(r2.routes.results.find((x) => x.intent === '孤路由')?.status).toBe('failed');
      expect(r2.routes.results.find((x) => x.intent === '孤路由')?.error?.message).toContain(
        'does not resolve',
      );
      expect(r2.routes.results.find((x) => x.intent === '正常路由')?.status).toBe('created');
    });

    it('孤儿路由（primaryDocPath=null）→ per-item failed，不中止批次', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([makeDoc()]);
      routeRepo.find = findFrom<DocRoute>([]);

      const r = await service.importBundle(
        'space-1',
        makeBundle({
          routes: [
            {
              intent: '孤儿',
              category: null,
              primaryDocPath: null,
              primaryHeadingPath: null,
              secondaryDocPath: null,
              secondaryHeadingPath: null,
              codeEntry: null,
              codeEntryType: 'exact',
              sortOrder: 0,
            },
          ],
        }),
        mockActor,
      );
      expect(r.routes.summary).toEqual({ total: 1, created: 0, updated: 0, failed: 1 });
      expect(r.routes.results[0].error?.message).toContain('primaryDocPath is null');
      expect(docRouteService.create).not.toHaveBeenCalled();
    });

    it('overwriteSpaceMeta=true：覆盖 name/description/settings（visibility 缺省保留现值），保留空间身份字段', async () => {
      const targetSpace = makeSpace({
        id: 'space-target',
        name: 'Target Space',
        description: '目标图例',
        slug: 'target-space',
        settings: { visibility: Visibility.PRIVATE },
      });
      docspaceService.findById.mockResolvedValue(targetSpace);
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([]);
      routeRepo.find = findFrom<DocRoute>([]);

      const r = await service.importBundle('space-target', makeBundle(), mockActor, true);

      expect(r.spaceMeta).toEqual({ applied: true, status: 'updated' });
      expect(spaceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'space-target',
          name: 'Source Space',
          description: '图例',
          settings: {
            visibility: Visibility.OPEN, // bundle 显式 visibility 生效
            overviewFilter: { excludeTypes: ['memory'] }, // bundle settings 整对象覆盖
          },
          // 身份字段不随 bundle 迁移
          slug: 'target-space',
          creatorId: 'user-1',
          topicId: null,
          boardId: null,
        }),
      );
    });

    it('overwriteSpaceMeta 缺省 false：space 元数据零写', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([]);
      routeRepo.find = findFrom<DocRoute>([]);

      const r = await service.importBundle('space-1', makeBundle(), mockActor);
      expect(r.spaceMeta.applied).toBe(false);
      expect(spaceRepo.save).not.toHaveBeenCalled();
    });

    it('BadRequestException 从 per-item 捕获：不会因单条业务失败冒泡', async () => {
      // 路由指向不存在的 doc 时 create 内部抛 BadRequest——由 per-item catch 吞掉
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      // path 解析必须成功（doc-1 存在），让失败发生在 docRouteService.create 内部
      docRepo.find = findFrom<Doc>([makeDoc()]);
      routeRepo.find = findFrom<DocRoute>([]);
      (docRouteService.create as jest.Mock).mockRejectedValueOnce(
        new BadRequestException({
          message: 'Document does not exist or does not belong to this space',
          code: ErrorCode.DOC_ROUTE_DOC_NOT_FOUND,
        }),
      );

      const r = await service.importBundle('space-1', makeBundle(), mockActor);
      expect(r.routes.summary.failed).toBe(1);
      expect(r.routes.results[0].error?.code).toBe(ErrorCode.DOC_ROUTE_DOC_NOT_FOUND);
    });
  });
});
