/**
 * DocBundleService 单元测试（任务 T6：空间级全量导出/回导；P2 批 5：媒体段）
 *
 * 覆盖：导出 bundle 形状（space meta/categories/docs 全文/routes 含 codeEntryType）、
 * 孤儿路由 primaryDocPath=null、formatVersion 校验（400 VALIDATION_ERROR）、
 * categories 按 name 幂等（存在更新/歧义 failed）、routes 按 intent+primaryDocPath
 * 幂等（存在更新/解析失败 per-item failed 不中止）、space meta 默认不回写 +
 * overwriteSpaceMeta=true 显式覆盖（保留空间身份字段）。
 *
 * P2 批 5（媒体段）覆盖：media 打包与确定性排序 + 缩略图、联合预算（docs 段参与扣减）、
 * skipped 双形态（too_large / budget_exceeded）、mediaOmitted（topic 绑定断链）、
 * 对象读失败/自洽不符不入包、六阶段顺序、正文 URL 重写两形态 + 无映射不重写、
 * v1 兼容（跳 media、信封全零值）、media 段三源失败合并。
 *
 * 媒体门面（AttachmentService）在本套件是**桩**：字节证据/复用键/配额等实现细节
 * 由 attachment-bundle.spec.ts 单测 + docspace-bundle.e2e-spec.ts 真 PG/真 MinIO 覆盖。
 * 真实 PG 的 roundtrip 无损/幂等再导入/导入冲突覆盖在 docspace-bundle.e2e-spec.ts
 * （铁律 #23：ORM SQL 生成与 chunk 往返 mock 测不出）。
 */
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ActorType, ErrorCode, Visibility } from '@agent-chamber/shared';
import { DocSpaceService } from './docspace.service';
import { AuditService } from '../audit/audit.service';
import { DocService } from './doc.service';
import { DocRouteService } from './doc-route.service';
import { DocBundleService } from './doc-bundle.service';
import { AttachmentService } from '../attachments/attachment.service';
import { DOC_BUNDLE_FORMAT_VERSION } from './dto';
import { DOC_BUNDLE_MAX_BYTES, DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES } from './doc-bundle.constants';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { DocCategory } from '../../database/entities/doc-category.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { Attachment } from '../../database/entities/attachment.entity';

const mockActor = { id: 'actor-0001', type: ActorType.HUMAN };
const mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

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

/** 造一行 doc 绑定附件（导出侧候选 / mediaOmitted 判定用） */
function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    uploaderId: 'user-1',
    bucket: 'agent-chamber-attachments',
    objectKey: 'obj-1.png',
    originalName: 'img.png',
    mimeType: 'image/png',
    sizeBytes: '4',
    sha256: 'a'.repeat(64),
    status: 'ready',
    topicId: null,
    docId: 'doc-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    thumbKey: null,
    thumbWidth: null,
    thumbHeight: null,
    thumbSizeBytes: null,
    thumbSha256: null,
    ...overrides,
  } as Attachment;
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
  let attachmentService: {
    listByDocIds: jest.Mock;
    listByIds: jest.Mock;
    readObjectBytes: jest.Mock;
    importFromBundle: jest.Mock;
    bindBundleMedia: jest.Mock;
  };
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
      attachmentService as unknown as AttachmentService,
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
    // 媒体门面桩（默认：无候选、无引用、空结果）
    attachmentService = {
      listByDocIds: jest.fn(async () => []),
      listByIds: jest.fn(async () => []),
      readObjectBytes: jest.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      importFromBundle: jest.fn(async () => ({
        created: 0,
        reused: 0,
        skipped: 0,
        failed: [],
        bindings: [],
      })),
      bindBundleMedia: jest.fn(async () => ({ bound: 0, failures: [] })),
    };
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
        docId: 'doc-1', // v1.62.0：导出 doc item 增 docId（informational）
        path: 'docs/a.md',
        title: 'Doc A',
        summary: '摘要 A',
        docType: 'guide',
        tags: ['backend'],
        category: 'Arch',
        content: '# Doc A\n\n正文。',
        contentHash: 'abc', // v1.62.0：原始写入 payload 的 SHA-256（makeDoc 默认），权威 revision 标识
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

  // ─── export：media 段（P2 批 5）─────────────────────────────

  describe('exportBundle 媒体段', () => {
    /** 按对象键返回字节（导出侧读对象用） */
    function bytesByKey(entries: Record<string, Buffer>): jest.Mock {
      return jest.fn(async (key: string) => {
        const buf = entries[key];
        if (!buf) throw new Error(`object not found: ${key}`);
        return buf;
      });
    }

    const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

    it('doc 绑定附件打包：base64/sha/缩略图齐备，排序 docPath→originalName→attachmentId', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([
        makeDoc({ id: 'doc-1', path: 'docs/a.md' }),
        makeDoc({ id: 'doc-2', path: 'docs/b.md' }),
      ]);
      routeRepo.find = findFrom<DocRoute>([]);

      const bodyA = Buffer.from('PNG-BYTES-A');
      const bodyZ = Buffer.from('PNG-BYTES-Z');
      const thumb = Buffer.from('WEBP-THUMB');
      // 库内候选顺序刻意打乱：导出必须自行排序（不能信 DB 返回序）
      attachmentService.listByDocIds.mockResolvedValue([
        makeAttachment({
          id: 'att-z',
          docId: 'doc-2',
          originalName: 'z.png',
          objectKey: 'obj-z',
          sizeBytes: String(bodyZ.length),
          sha256: sha256(bodyZ),
        }),
        makeAttachment({
          id: 'att-b',
          docId: 'doc-1',
          originalName: 'b.png',
          objectKey: 'obj-b',
          sizeBytes: String(bodyA.length),
          sha256: sha256(bodyA),
        }),
        makeAttachment({
          id: 'att-a',
          docId: 'doc-1',
          originalName: 'a.png',
          objectKey: 'obj-a',
          sizeBytes: String(bodyA.length),
          sha256: sha256(bodyA),
          thumbKey: 'thumb-a',
          thumbWidth: 64,
          thumbHeight: 32,
          thumbSizeBytes: String(thumb.length),
          thumbSha256: sha256(thumb),
        }),
      ]);
      attachmentService.readObjectBytes.mockImplementation(
        bytesByKey({ 'obj-a': bodyA, 'obj-b': bodyA, 'obj-z': bodyZ, 'thumb-a': thumb }),
      );

      const bundle = await service.exportBundle('space-1');

      expect(bundle.formatVersion).toBe(2);
      expect(bundle.media.map((m) => ('skipped' in m ? m.skipped : m.sourceAttachmentId))).toEqual([
        'att-a',
        'att-b',
        'att-z',
      ]);
      const first = bundle.media[0];
      expect('skipped' in first).toBe(false);
      if ('skipped' in first) throw new Error('unreachable');
      expect(first).toMatchObject({
        sourceAttachmentId: 'att-a',
        docPath: 'docs/a.md',
        originalName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: bodyA.length,
        sha256: sha256(bodyA),
        contentBase64: bodyA.toString('base64'),
      });
      expect(first.thumbnail).toEqual({
        width: 64,
        height: 32,
        sizeBytes: thumb.length,
        sha256: sha256(thumb),
        contentBase64: thumb.toString('base64'),
      });
      // 无缩略图的行不带 thumbnail 键（增强项，缺席即无）
      const second = bundle.media[1];
      if ('skipped' in second) throw new Error('unreachable');
      expect(Object.hasOwn(second, 'thumbnail')).toBe(false);
      expect(bundle.mediaOmitted).toEqual([]);
    });

    it('联合预算：docs 段字节参与扣减（超剩余额度 → budget_exceeded，小项仍可打包）', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      // docs 段 ≥3MB：额度被压缩到 10MiB − 3MiB − 64KiB
      const bigContent = `# 大文档\n\n${'x'.repeat(3 * 1024 * 1024)}`;
      docRepo.find = findFrom<Doc>([makeDoc({ id: 'doc-1', path: 'docs/big.md' })]);
      routeRepo.find = findFrom<DocRoute>([]);
      (docService.getContent as jest.Mock).mockImplementation(async () => ({
        docId: 'doc-1',
        docPath: 'docs/big.md',
        title: '大文档',
        content: bigContent,
      }));

      // 5.75MiB（≤ 单项上限 6MiB）：base64 后 8.03MB > 剩余额度（10MiB − 3MiB − 64KiB ≈ 7.1MB）
      const hugeBytes = Buffer.alloc(5.75 * 1024 * 1024, 0x41);
      const tinyBytes = Buffer.from('TINY');
      attachmentService.listByDocIds.mockResolvedValue([
        makeAttachment({
          id: 'att-huge',
          docId: 'doc-1',
          originalName: 'a-huge.png',
          objectKey: 'obj-huge',
          sizeBytes: String(hugeBytes.length),
          sha256: sha256(hugeBytes),
        }),
        makeAttachment({
          id: 'att-tiny',
          docId: 'doc-1',
          originalName: 'b-tiny.png',
          objectKey: 'obj-tiny',
          sizeBytes: String(tinyBytes.length),
          sha256: sha256(tinyBytes),
        }),
      ]);
      attachmentService.readObjectBytes.mockImplementation(
        bytesByKey({ 'obj-huge': hugeBytes, 'obj-tiny': tinyBytes }),
      );

      const bundle = await service.exportBundle('space-1');

      // 预判阶段即拒绝（未读对象）：docs 段已占 3MB，5MiB 图 base64 后 ≈6.99MB > 剩余额度
      expect(bundle.media[0]).toMatchObject({
        skipped: 'budget_exceeded',
        sourceAttachmentId: 'att-huge',
        docPath: 'docs/big.md',
      });
      expect(attachmentService.readObjectBytes).not.toHaveBeenCalledWith('obj-huge');
      // 小项仍按剩余额度打包
      expect(bundle.media[1]).toMatchObject({ sourceAttachmentId: 'att-tiny' });
    });

    it('单项超 6MiB → skipped too_large（不读对象）', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([makeDoc()]);
      routeRepo.find = findFrom<DocRoute>([]);
      attachmentService.listByDocIds.mockResolvedValue([
        makeAttachment({
          id: 'att-big',
          docId: 'doc-1',
          sizeBytes: String(DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES + 1),
        }),
      ]);

      const bundle = await service.exportBundle('space-1');

      expect(bundle.media).toEqual([
        {
          skipped: 'too_large',
          sourceAttachmentId: 'att-big',
          docPath: 'docs/a.md',
          originalName: 'img.png',
          sizeBytes: DOC_BUNDLE_MEDIA_ITEM_MAX_BYTES + 1,
        },
      ]);
      expect(attachmentService.readObjectBytes).not.toHaveBeenCalled();
    });

    it('mediaOmitted：正文引用的 topic 绑定附件报出；doc 绑定项不进清单', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([makeDoc({ id: 'doc-1', path: 'docs/a.md' })]);
      routeRepo.find = findFrom<DocRoute>([]);
      const topicAttId = '11111111-1111-4111-8111-111111111111';
      const docAttId = '22222222-2222-4222-8222-222222222222';
      (docService.getContent as jest.Mock).mockImplementation(async () => ({
        docId: 'doc-1',
        docPath: 'docs/a.md',
        title: 'Doc A',
        content:
          `# Doc A\n\n![t](/api/v1/attachments/${topicAttId}/content)\n\n` +
          `![d](/api/v1/attachments/${docAttId}/content)\n`,
      }));
      attachmentService.listByIds.mockResolvedValue([
        makeAttachment({ id: topicAttId, docId: null, topicId: 'topic-1' }),
        makeAttachment({ id: docAttId, docId: 'doc-1' }),
      ]);
      attachmentService.listByDocIds.mockResolvedValue([]);

      const bundle = await service.exportBundle('space-1');

      expect(bundle.mediaOmitted).toEqual([
        { docPath: 'docs/a.md', attachmentId: topicAttId, reason: 'topic_bound' },
      ]);
      expect(attachmentService.listByIds).toHaveBeenCalledWith([topicAttId, docAttId]);
    });

    it('对象读失败 / 字节与行元数据不符 → 该项不入 media（bundle 自洽优先）', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      docRepo.find = findFrom<Doc>([makeDoc()]);
      routeRepo.find = findFrom<DocRoute>([]);
      const good = Buffer.from('GOOD');
      attachmentService.listByDocIds.mockResolvedValue([
        makeAttachment({
          id: 'att-read-fail',
          docId: 'doc-1',
          originalName: 'a.png',
          objectKey: 'obj-missing',
          sizeBytes: '4',
          sha256: sha256(Buffer.from('GOOD')),
        }),
        makeAttachment({
          id: 'att-tampered',
          docId: 'doc-1',
          originalName: 'b.png',
          objectKey: 'obj-tampered',
          sizeBytes: '4',
          sha256: sha256(Buffer.from('REAL')),
        }),
        makeAttachment({
          id: 'att-ok',
          docId: 'doc-1',
          originalName: 'c.png',
          objectKey: 'obj-ok',
          sizeBytes: String(good.length),
          sha256: sha256(good),
        }),
      ]);
      attachmentService.readObjectBytes.mockImplementation(
        bytesByKey({ 'obj-tampered': good, 'obj-ok': good }),
      );

      const bundle = await service.exportBundle('space-1');

      expect(bundle.media.map((m) => ('skipped' in m ? m.skipped : m.sourceAttachmentId))).toEqual([
        'att-ok',
      ]);
    });
  });

  // ─── import：媒体段（P2 批 5）─────────────────────────────

  describe('importBundle 媒体段', () => {
    const oldId = '11111111-1111-4111-8111-111111111111';
    const newId = '99999999-9999-4999-8999-999999999999';

    /** 带媒体项的 v2 bundle（docs[] 正文引用旧附件 URL） */
    function makeMediaBundle(overrides: Partial<Record<string, unknown>> = {}) {
      return makeBundle({
        docs: [
          {
            path: 'docs/a.md',
            title: 'Doc A',
            content: `# Doc A\n\n![img](/api/v1/attachments/${oldId}/content)\n`,
          },
        ],
        media: [
          {
            sourceAttachmentId: oldId,
            docPath: 'docs/a.md',
            originalName: 'img.png',
            mimeType: 'image/png',
            sizeBytes: 4,
            sha256: 'a'.repeat(64),
            contentBase64: 'AAAA',
          },
        ],
        ...overrides,
      });
    }

    beforeEach(() => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      categoryRepo.find = findFrom<DocCategory>([]);
      // routes 阶段按 path 解析 doc（阶段 ③ 的产物等价物）：空表会让 routes.create 不被调用
      docRepo.find = findFrom<Doc>([makeDoc({ id: 'doc-new-1', path: 'docs/a.md' })]);
      routeRepo.find = findFrom<DocRoute>([]);
      attachmentService.importFromBundle.mockResolvedValue({
        created: 1,
        reused: 0,
        skipped: 0,
        failed: [],
        bindings: [
          {
            sourceAttachmentId: oldId,
            attachmentId: newId,
            docPath: 'docs/a.md',
            originalName: 'img.png',
          },
        ],
      });
      attachmentService.bindBundleMedia.mockResolvedValue({ bound: 1, failures: [] });
      // docs 阶段的落库产物：docPath → 新 docId（回绑需要）
      (docService.batchUpsert as jest.Mock).mockImplementation(
        async (_spaceId: string, docs: Array<{ path: string }>) => ({
          results: docs.map((d) => ({ path: d.path, status: 'created' as const, id: 'doc-new-1' })),
          summary: {
            total: docs.length,
            created: docs.length,
            updated: 0,
            unchanged: 0,
            failed: 0,
          },
        }),
      );
    });

    it('六阶段顺序 + 正文 URL 重写（相对与同源绝对两形态都换成新 id）', async () => {
      const bundle = makeBundle({
        docs: [
          {
            path: 'docs/a.md',
            title: 'Doc A',
            content:
              `# Doc A\n\n![rel](/api/v1/attachments/${oldId}/content)\n\n` +
              `![abs](https://platform.example.com/api/v1/attachments/${oldId}/content)\n\n` +
              `![other](/api/v1/attachments/22222222-2222-4222-8222-222222222222/content)\n`,
          },
        ],
        media: [
          {
            sourceAttachmentId: oldId,
            docPath: 'docs/a.md',
            originalName: 'img.png',
            mimeType: 'image/png',
            sizeBytes: 4,
            sha256: 'a'.repeat(64),
            contentBase64: 'AAAA',
          },
        ],
      });

      const result = await service.importBundle('space-1', bundle as never, mockActor);

      // 阶段顺序：media stage-1 → docs → media stage-2 → routes
      const order = [
        attachmentService.importFromBundle.mock.invocationCallOrder[0],
        (docService.batchUpsert as jest.Mock).mock.invocationCallOrder[0],
        attachmentService.bindBundleMedia.mock.invocationCallOrder[0],
        (docRouteService.create as jest.Mock).mock.invocationCallOrder[0],
      ];
      expect(order[0]).toBeLessThan(order[1]);
      expect(order[1]).toBeLessThan(order[2]);
      expect(order[2]).toBeLessThan(order[3]);

      // 重写：两种形态都换 id；无映射的旧 URL 原样保留（无映射不重写）
      const sentDocs = (docService.batchUpsert as jest.Mock).mock.calls[0][1] as Array<{
        content: string;
      }>;
      expect(sentDocs[0].content).toContain(`/api/v1/attachments/${newId}/content`);
      expect(sentDocs[0].content).toContain(
        `https://platform.example.com/api/v1/attachments/${newId}/content`,
      );
      expect(sentDocs[0].content).toContain(
        '/api/v1/attachments/22222222-2222-4222-8222-222222222222/content',
      );
      expect(sentDocs[0].content).not.toContain(oldId);

      // 回绑：新行 id + docs 阶段产出的 docId
      expect(attachmentService.bindBundleMedia).toHaveBeenCalledWith([
        {
          attachmentId: newId,
          docId: 'doc-new-1',
          sourceAttachmentId: oldId,
          docPath: 'docs/a.md',
          originalName: 'img.png',
        },
      ]);
      expect(result.media).toEqual({ created: 1, reused: 0, skipped: 0, failed: [] });
      expect(result.formatVersion).toBe(2);
    });

    it('formatVersion 1：整段跳过 media（不调门面），信封 media 全零值形状', async () => {
      // v1 包即便被手改塞了 media 字段也不处理（版本语义优先）
      const v1 = makeMediaBundle({
        formatVersion: 1,
        media: [{ skipped: 'too_large', docPath: 'docs/a.md' }],
      });

      const result = await service.importBundle('space-1', v1 as never, mockActor);

      expect(result.formatVersion).toBe(1);
      expect(result.media).toEqual({ created: 0, reused: 0, skipped: 0, failed: [] });
      expect(attachmentService.importFromBundle).not.toHaveBeenCalled();
      expect(attachmentService.bindBundleMedia).not.toHaveBeenCalled();
      // 正文零重写（映射为空）
      const sentDocs = (docService.batchUpsert as jest.Mock).mock.calls[0][1] as Array<{
        content: string;
      }>;
      expect(sentDocs[0].content).toContain(oldId);
    });

    it('media 信封：stage-1 失败 + doc upsert 失败（回绑不了）+ stage-2 失败 三源合并', async () => {
      const otherId = '33333333-3333-4333-8333-333333333333';
      attachmentService.importFromBundle.mockResolvedValue({
        created: 1,
        reused: 0,
        skipped: 1,
        failed: [{ docPath: 'docs/a.md', originalName: 'bad.png', reason: 'sha mismatch' }],
        bindings: [
          {
            sourceAttachmentId: oldId,
            attachmentId: newId,
            docPath: 'docs/a.md',
            originalName: 'img.png',
          },
          {
            sourceAttachmentId: otherId,
            attachmentId: 'att-unbindable',
            docPath: 'docs/b.md',
            originalName: 'other.png',
          },
        ],
      });
      attachmentService.bindBundleMedia.mockResolvedValue({
        bound: 1,
        failures: [
          { docPath: 'docs/a.md', originalName: 'img.png', reason: 'attachment row disappeared' },
        ],
      });
      // docs 阶段：docs/a.md 失败（无 id）→ 该项回绑不了；docs/b.md 成功
      (docService.batchUpsert as jest.Mock).mockImplementation(async () => ({
        results: [
          { path: 'docs/a.md', status: 'failed' as const, error: { message: 'boom', code: 1 } },
          { path: 'docs/b.md', status: 'created' as const, id: 'doc-b' },
        ],
        summary: { total: 2, created: 1, updated: 0, unchanged: 0, failed: 1 },
      }));

      const result = await service.importBundle('space-1', makeMediaBundle() as never, mockActor);

      expect(result.media.skipped).toBe(1);
      expect(result.media.created).toBe(1);
      // 三源失败都在（顺序：stage-1 → 回绑不了（doc 失败）→ stage-2）
      expect(result.media.failed.map((f) => f.reason.split(/[;:]/)[0])).toEqual([
        'sha mismatch',
        'doc upsert failed for this docPath',
        'attachment row disappeared',
      ]);
      // 只有能解析出 docId 的绑定才进入 stage-2（docs/a.md 失败 → 该项不进）
      expect(attachmentService.bindBundleMedia).toHaveBeenCalledWith([
        {
          attachmentId: 'att-unbindable',
          docId: 'doc-b',
          sourceAttachmentId: otherId,
          docPath: 'docs/b.md',
          originalName: 'other.png',
        },
      ]);
    });

    it('不支持版本 → 400 + 逐字消息（指导重新导出）', async () => {
      docspaceService.findById.mockResolvedValue(makeSpace());
      await expect(
        service.importBundle('space-1', makeBundle({ formatVersion: 3 }) as never, mockActor),
      ).rejects.toThrow(
        'Unsupported bundle formatVersion 3; this server accepts 1 (no media) and 2 (with media). ' +
          'Re-export from a compatible server version.',
      );
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
      expect(docspaceService.createCategory).toHaveBeenCalledWith(
        'space-1',
        {
          name: 'Arch',
          slug: 'arch',
          description: null,
          sortOrder: 0,
        },
        'actor-0001',
      );
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
      expect(docspaceService.updateCategory).toHaveBeenCalledWith(
        'cat-existing',
        {
          name: 'Arch',
          slug: 'arch',
          description: null,
          sortOrder: 0,
        },
        'actor-0001',
      );
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
        'actor-0001',
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
