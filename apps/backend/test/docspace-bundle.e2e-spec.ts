/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块) —— 任务 T6（空间级全量导出/回导）
 *   - 补充: 铁律 #23 教训（RT-SEAT-1）——导出/回导涉及 chunk/reconstruct 全文往返与
 *     ORM SQL 生成（sections/headingPath 重建、jsonb settings 读写），mock 单测测不出，
 *     必须有打真实 PG 的集成覆盖
 *
 * [踩坑索引] -
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [详细踩坑]（最多 5 条最近/最严重的，LRU 淘汰）
 *   -
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #11）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * DocSpace 导出→回导 roundtrip —— 真实 PG 集成套件（任务 T6）
 *
 * 与 docspace-patch.e2e-spec.ts 同款基建：打本地开发库 chamber-postgres，
 * 直接实例化 DocSpaceService/DocService/DocRouteService/DocBundleService
 * （真 TypeORM repo + 真 chunker/重建管线）。PG 不可达时整套降级跳过。
 *
 * 覆盖（验收标准 4）：
 * ① roundtrip 无损：导出 → 导入新空间后 docs（全文 content 逐字节相等 + 策展元数据）、
 *    categories、routes（含 codeEntryType/headingPath）内容一致
 * ② per-doc 失败不中止：目标空间存在 source 冲突文档（git:）→ 该篇 failed，其余成功
 * ③ 幂等再导入：重复导入不重复创建（doc/category/route 计数不变）
 * ④ formatVersion 校验：99 → 400 VALIDATION_ERROR
 * ⑤ overwriteSpaceMeta 默认关闭（空间元数据零写）+ 显式开启（覆盖 name/description/settings，
 *    保留 slug/creator）
 *
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode, Visibility } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { DocService } from '../src/modules/docspace/doc.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import { DocRouteService } from '../src/modules/docspace/doc-route.service';
import { DocBundleService } from '../src/modules/docspace/doc-bundle.service';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { DocSpaceMember } from '../src/database/entities/doc-space-member.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { User } from '../src/database/entities/user.entity';
import { Actor } from '../src/database/entities/actor.entity';
import { Board } from '../src/database/entities/board.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';
import type { AccessQueryService } from '../src/common/services/access-query.service';
import { ActorProfileService } from '../src/common/services/actor-profile.service';
import type { ResourceValidator } from '../src/common/resource-validator';
import type { AuditService } from '../src/modules/audit/audit.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `bundle-e2e-${Date.now()}`;

/**
 * 固定测试 actor（docs.created_by 为 uuid 列，upsert 缺省 'system' 字面量会被 PG 拒绝）。
 * 本套件专用哨兵 id（不与 docspace-move/patch-metadata 共用 '...00aa'）：afterAll 按
 * actorId 清理 audit_logs 时并行安全，不误删其他套件行（08-29 套件污染修复）
 */
const testActor = { id: '00000000-0000-4000-8000-0000000000a4', type: ActorType.HUMAN };

/** 固定空间 creator（doc_spaces.creator_id 为 uuid 列） */
const spaceCreator = '00000000-0000-4000-8000-0000000000ee';

/** 固定回归标题：裸 §3.2 属于标题正文，不得被误当作 headingPath 层级分隔符 */
const specialHeading = '2.1 TTK 目标区间（以 `numeric-equations.md` §3.2 为准）';

describe('DocBundleService 导出→回导 roundtrip — 真实 PG 集成', () => {
  let ds: DataSource;
  let dbAvailable = false;

  let docspaceService: DocSpaceService;
  let docService: DocService;
  let docRouteService: DocRouteService;
  let bundleService: DocBundleService;

  /** 源空间 + 目标空间（afterAll 兜底清理） */
  let srcSpaceId: string;
  let tgtSpaceId: string;
  const srcDocIds: string[] = [];
  const tgtDocIds: string[] = [];
  const srcRouteIds: string[] = [];
  const tgtRouteIds: string[] = [];

  /** 冲刷 setImmediate 队列（route health recheck fire-and-forget） */
  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** 铺一个测试空间（空 settings 显式透传，避免依赖 DB default） */
  async function makeSpace(name: string): Promise<string> {
    const repo = ds.getRepository(DocSpace);
    const saved = await repo.save(
      repo.create({
        name,
        slug: `${name}-${RUN}`.slice(0, 128),
        description: null,
        creatorId: spaceCreator,
        settings: {},
      }),
    );
    return saved.id;
  }

  /** 通过真实 upsert 管线铺文档（sections/headingPath 由 chunker 生成，与导入路径同管线） */
  async function seedDoc(spaceId: string, path: string, content: string): Promise<Doc> {
    const r = await docService.upsert(spaceId, { path, content }, testActor);
    await flushImmediates();
    return docService.findById(r.id);
  }

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((e) => typeof e === 'function'),
      synchronize: false, // 开发库已跑过 migration，禁止测试改 schema
      logging: false,
    });

    try {
      await ds.initialize();
    } catch (err) {
      // PG 不可达 → 整套降级跳过（本套件是环境依赖型集成测试）
      console.warn(
        `[docspace-bundle e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // ── Service 装配：真 repo + 打桩的 Event/RouteHealth/AccessQuery/ResourceValidator ──
    const eventStub = { create: jest.fn().mockResolvedValue({}) } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;
    const accessQueryStub = {} as unknown as AccessQueryService;
    const resourceValidatorStub = {} as unknown as ResourceValidator;
    // 统一批 A1：DocSpaceService 构造新增 actorProfileService（真实例，成员 enrich 走公共解析）
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    // 统一批 A2：DocSpaceService/DocRouteService 构造新增 auditService（本套件断言不触达
    // 审计行，log 打桩防 createCategory/update 等写路径抛错）
    const auditServiceStub = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;

    docspaceService = new DocSpaceService(
      ds.getRepository(DocSpace),
      ds.getRepository(DocSpaceMember),
      ds.getRepository(DocCategory),
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(TaskDocLink),
      ds.getRepository(DocRoute),
      ds.getRepository(Agent),
      ds.getRepository(User),
      ds.getRepository(Actor),
      ds.getRepository(Board),
      ds.getRepository(Topic),
      accessQueryStub,
      resourceValidatorStub,
      eventStub,
      actorProfileService,
      auditServiceStub,
    );
    docService = new DocService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocCategory),
      ds.getRepository(AuditLog),
      ds.getRepository(DocSpace),
      ds.getRepository(Board),
      ds.getRepository(DocVersion),
      eventStub,
      routeHealthStub,
      ds.getRepository(IdempotencyRecord),
      // Diagram IR v1：bundle 回导 diagram 的重校验重渲染由 docspace-diagram e2e 覆盖；本套件桩件仅防构造参数缺失
      { validateAndRender: jest.fn() } as unknown as DiagramRendererService,
    );
    docRouteService = new DocRouteService(
      ds.getRepository(DocRoute),
      ds.getRepository(Doc),
      docService,
      auditServiceStub,
    );
    bundleService = new DocBundleService(
      docspaceService,
      docService,
      docRouteService,
      ds.getRepository(DocSpace),
      ds.getRepository(DocCategory),
      ds.getRepository(Doc),
      ds.getRepository(DocRoute),
    );

    // ── 源空间种子：2 分类 + 3 文档 + 2 路由（含 headingPath 锚点与 pattern codeEntry）──
    srcSpaceId = await makeSpace(`BundleSrc ${RUN}`);
    await docspaceService.createCategory(srcSpaceId, {
      name: '架构',
      slug: 'arch',
      description: '架构类文档',
      sortOrder: 5,
    });
    await docspaceService.createCategory(srcSpaceId, {
      name: '运维',
      slug: 'ops',
      sortOrder: 1,
    });

    const docA = await seedDoc(
      srcSpaceId,
      `tmp/${RUN}-a.md`,
      `# 导出文档 A\n\n引言段落。\n\n## 架构总览\n\n架构正文。\n\n## ${specialHeading}\n\n特殊标题正文。\n\n### 嵌套子标题\n\n嵌套子标题正文。\n\n## 数据流\n\n数据流正文。`,
    );
    const docB = await seedDoc(srcSpaceId, `tmp/${RUN}-b.md`, `# 导出文档 B\n\n运维指南。`);
    const docC = await seedDoc(srcSpaceId, `tmp/${RUN}-c.md`, `# 导出文档 C\n\n未分类。`);
    srcDocIds.push(docA.id, docB.id, docC.id);

    // 给 docA 补策展元数据（category/tags/docType/summary），验证导出元数据保真
    await docService.upsert(
      srcSpaceId,
      {
        path: docA.path,
        content: `# 导出文档 A\n\n引言段落。\n\n## 架构总览\n\n架构正文。\n\n## ${specialHeading}\n\n特殊标题正文。\n\n### 嵌套子标题\n\n嵌套子标题正文。\n\n## 数据流\n\n数据流正文。`,
        title: '导出文档 A',
        summary: '策展摘要 A',
        docType: 'guide',
        category: '架构',
        tags: ['backend', 'roundtrip'],
      },
      testActor,
    );
    await flushImmediates();
    // docB 归入运维分类
    await docService.upsert(
      srcSpaceId,
      {
        path: docB.path,
        content: `# 导出文档 B\n\n运维指南。`,
        title: '导出文档 B',
        docType: 'operations',
        category: '运维',
        tags: ['ops'],
      },
      testActor,
    );
    await flushImmediates();

    // 路由 1：headingPath 锚点（取 chunker 真实产物，避免硬编码分隔符细节）+ pattern codeEntry
    const headingPath = (
      await ds
        .getRepository(DocSection)
        .createQueryBuilder('s')
        .where('s.doc_id = :docId', { docId: docA.id })
        .andWhere('s.heading_path LIKE :headingPath', { headingPath: `%${specialHeading}%` })
        .getOne()
    )?.headingPath;
    expect(headingPath).toBe(`导出文档 A § ${specialHeading}`);
    const route1 = await docRouteService.create(
      srcSpaceId,
      {
        intent: '我要了解导出文档 A 的架构',
        category: '架构',
        primaryDocId: docA.id,
        primaryHeadingPath: headingPath ?? undefined,
        secondaryDocId: docB.id,
        codeEntry: 'apps/backend/src/modules/docspace/**',
        codeEntryType: 'pattern',
        sortOrder: 10,
      },
      testActor,
    );
    // 路由 2：文档级跳转（无 headingPath，codeEntryType 缺省 exact）
    const route2 = await docRouteService.create(
      srcSpaceId,
      {
        intent: '我要看运维指南',
        category: '运维',
        primaryDocId: docB.id,
        codeEntry: 'apps/backend/src/modules/docspace/doc.service.ts',
        sortOrder: 20,
      },
      testActor,
    );
    srcRouteIds.push(route1.id, route2.id);
  }, 60000);

  afterAll(async () => {
    if (!dbAvailable) return;

    // 硬删兜底清理（sections 走 CASCADE，显式删更直白；路由/分类先行防 FK 逻辑残留）
    for (const id of [...tgtRouteIds, ...srcRouteIds]) {
      await ds.getRepository(DocRoute).delete({ id });
    }
    for (const id of [...tgtDocIds, ...srcDocIds]) {
      await ds.getRepository(DocSection).delete({ docId: id });
      await ds.getRepository(Doc).delete({ id });
    }
    if (tgtSpaceId) {
      const tgtCats = await ds.getRepository(DocCategory).find({ where: { spaceId: tgtSpaceId } });
      for (const c of tgtCats) {
        await ds.getRepository(DocCategory).delete({ id: c.id });
      }
      await ds.getRepository(DocSpace).delete({ id: tgtSpaceId });
    }
    if (srcSpaceId) {
      const srcCats = await ds.getRepository(DocCategory).find({ where: { spaceId: srcSpaceId } });
      for (const c of srcCats) {
        await ds.getRepository(DocCategory).delete({ id: c.id });
      }
      await ds.getRepository(DocSpace).delete({ id: srcSpaceId });
    }
    // upsert/importBundle 写 audit_logs（actorId = testActor.id）——必须同步清理，否则
    // 残留行会挤占 activity-logs 套件 admin 全量查询的 20 条窗口（createdAt DESC）导致
    // 其 row-B/row-D/row-E 被挤出分页（08-29 实测 82+ 行污染）。按 actorId 删（本套件
    // 专用哨兵 actor，并行安全），覆盖用例内临时 doc 的 audit 行
    await ds.getRepository(AuditLog).delete({ actorId: testActor.id });
    await ds.destroy();
  }, 30000);

  // ─── ① roundtrip 无损 ───────────────────────────────────────

  it('roundtrip 无损：导出→导入新空间，docs 全文+元数据 / categories / routes 内容一致', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.docs).toHaveLength(3);
    expect(bundle.categories).toHaveLength(2);
    expect(bundle.routes).toHaveLength(2);

    // v1.62.0：导出 docs[] item 增 docId + contentHash（原始写入 payload 的 SHA-256，
    // 权威 revision 标识——content 是重建产物，其 SHA-256 ≠ contentHash）；且该新形状
    // bundle 直接回导不炸（含 docId/contentHash 字段不被 forbidNonWhitelisted 拒绝）
    for (const item of bundle.docs as Array<{ docId: string; contentHash: string | null }>) {
      expect(item.docId).toBeTruthy();
      expect(item.contentHash).toBeTruthy();
    }

    // 目标空间（空壳）导入
    tgtSpaceId = await makeSpace(`BundleTgt ${RUN}`);
    const result = await bundleService.importBundle(tgtSpaceId, bundle as never, testActor);
    await flushImmediates();

    // docs：全部 created、零失败
    expect(result.docs.summary).toEqual({
      total: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    // categories：全部 created
    expect(result.categories.summary).toEqual({ total: 2, created: 2, updated: 0, failed: 0 });
    // routes：全部 created（headingPath 写时校验通过 = 目标 sections 与源一致）
    expect(result.routes.summary).toEqual({ total: 2, created: 2, updated: 0, failed: 0 });
    // space meta：默认不回写
    expect(result.spaceMeta).toEqual({ applied: false, status: 'skipped' });

    // ── 逐篇对比：全文（getContent full=true 逐字节）+ 策展元数据 ──
    for (const srcDoc of await ds.getRepository(Doc).find({ where: { spaceId: srcSpaceId } })) {
      const tgtDoc = await ds
        .getRepository(Doc)
        .createQueryBuilder('d')
        .where('d.space_id = :spaceId', { spaceId: tgtSpaceId })
        .andWhere('d.path = :path', { path: srcDoc.path })
        .getOne();
      expect(tgtDoc).toBeTruthy();
      tgtDocIds.push(tgtDoc!.id);

      const srcFull = await docService.getContent(srcDoc.id, true);
      const tgtFull = await docService.getContent(tgtDoc!.id, true);
      expect(tgtFull.content).toBe(srcFull.content);
      expect(tgtDoc!.title).toBe(srcDoc.title);
      expect(tgtDoc!.summary).toBe(srcDoc.summary);
      expect(tgtDoc!.docType).toBe(srcDoc.docType);
      expect([...(tgtDoc!.tags ?? [])].sort()).toEqual([...(srcDoc.tags ?? [])].sort());
    }

    // ── 分类对比 ──
    const srcCats = await ds
      .getRepository(DocCategory)
      .find({ where: { spaceId: srcSpaceId }, order: { name: 'ASC' } });
    const tgtCats = await ds
      .getRepository(DocCategory)
      .find({ where: { spaceId: tgtSpaceId }, order: { name: 'ASC' } });
    expect(tgtCats.map((c) => [c.name, c.slug, c.description, c.sortOrder])).toEqual(
      srcCats.map((c) => [c.name, c.slug, c.description, c.sortOrder]),
    );

    // ── 路由对比（docId → path 归一对齐）──
    const pathOf = async (docId: string | null): Promise<string | null> => {
      if (!docId) return null;
      const doc = await ds.getRepository(Doc).findOne({ where: { id: docId } });
      return doc?.path ?? null;
    };
    const srcRoutes = await ds.getRepository(DocRoute).find({ where: { spaceId: srcSpaceId } });
    const tgtRoutes = await ds.getRepository(DocRoute).find({ where: { spaceId: tgtSpaceId } });
    tgtRouteIds.push(...tgtRoutes.map((r) => r.id));
    expect(tgtRoutes).toHaveLength(srcRoutes.length);

    const normRoute = async (r: DocRoute) => ({
      intent: r.intent,
      category: r.category,
      primaryDocPath: await pathOf(r.primaryDocId),
      primaryHeadingPath: r.primaryHeadingPath,
      secondaryDocPath: await pathOf(r.secondaryDocId),
      secondaryHeadingPath: r.secondaryHeadingPath,
      codeEntry: r.codeEntry,
      codeEntryType: r.codeEntryType,
      sortOrder: r.sortOrder,
    });
    const srcNorm = (await Promise.all(srcRoutes.map(normRoute))).sort((a, b) =>
      a.intent.localeCompare(b.intent),
    );
    const tgtNorm = (await Promise.all(tgtRoutes.map(normRoute))).sort((a, b) =>
      a.intent.localeCompare(b.intent),
    );
    expect(tgtNorm).toEqual(srcNorm);
  }, 60000);

  // ─── ② per-doc 失败不中止 ───────────────────────────────────

  it('per-doc 失败不中止：source 冲突文档该篇 failed，其余文档照常 created', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    // 目标空间预先放一篇 source='git:' 的同路径文档（真实冲突：native 导入必 409 DOC_SOURCE_MISMATCH）
    const conflictPath = `tmp/${RUN}-a.md`;
    const conflictSpace = await makeSpace(`BundleConflict ${RUN}`);
    const conflictDoc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: conflictSpace,
        categoryId: null,
        path: conflictPath,
        title: 'git 同步版',
        summary: null,
        docType: null,
        tags: [],
        source: 'git:test-sync',
        contentHash: 'conflict-hash',
        sourceSha: null,
        sectionCount: 1,
        tokenEstimate: 1,
        createdBy: spaceCreator,
      }),
    );
    try {
      const result = await bundleService.importBundle(conflictSpace, bundle as never, testActor);
      await flushImmediates();

      // 该篇 failed（DOC_SOURCE_MISMATCH），其余 2 篇 created——批次未中止
      expect(result.docs.summary.failed).toBe(1);
      expect(result.docs.summary.created).toBe(2);
      const failedItem = result.docs.results.find((r) => r.path === conflictPath);
      expect(failedItem?.status).toBe('failed');
      expect(failedItem?.error?.code).toBe(ErrorCode.DOC_SOURCE_MISMATCH);
      // 冲突文档未被改动（source 隔离校验拒绝写入）
      const stillThere = await ds.getRepository(Doc).findOne({ where: { id: conflictDoc.id } });
      expect(stillThere?.source).toBe('git:test-sync');
    } finally {
      // 清理冲突空间
      await ds.getRepository(DocSection).delete({ docId: conflictDoc.id });
      await ds.getRepository(Doc).delete({ id: conflictDoc.id });
      const cats = await ds.getRepository(DocCategory).find({ where: { spaceId: conflictSpace } });
      for (const c of cats) await ds.getRepository(DocCategory).delete({ id: c.id });
      const routes = await ds.getRepository(DocRoute).find({ where: { spaceId: conflictSpace } });
      for (const r of routes) await ds.getRepository(DocRoute).delete({ id: r.id });
      await ds.getRepository(DocSpace).delete({ id: conflictSpace });
    }
  }, 60000);

  // ─── ③ 幂等再导入 ───────────────────────────────────────────

  it('幂等再导入：重复导入同一 bundle 不重复创建（计数不变、docs unchanged/updated）', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    if (!tgtSpaceId) {
      tgtSpaceId = await makeSpace(`BundleTgt ${RUN}`);
      await bundleService.importBundle(tgtSpaceId, bundle as never, testActor);
      await flushImmediates();
    }

    const countDocs = () => ds.getRepository(Doc).count({ where: { spaceId: tgtSpaceId } });
    const countCats = () => ds.getRepository(DocCategory).count({ where: { spaceId: tgtSpaceId } });
    const countRoutes = () => ds.getRepository(DocRoute).count({ where: { spaceId: tgtSpaceId } });
    const before = {
      docs: await countDocs(),
      cats: await countCats(),
      routes: await countRoutes(),
    };

    const again = await bundleService.importBundle(tgtSpaceId, bundle as never, testActor);
    await flushImmediates();

    // 无 created：docs 内容相同 → unchanged；categories/routes 业务键命中 → updated
    expect(again.docs.summary.created).toBe(0);
    expect(again.docs.summary.unchanged).toBe(3);
    expect(again.categories.summary).toEqual({ total: 2, created: 0, updated: 2, failed: 0 });
    expect(again.routes.summary).toEqual({ total: 2, created: 0, updated: 2, failed: 0 });

    const after = {
      docs: await countDocs(),
      cats: await countCats(),
      routes: await countRoutes(),
    };
    expect(after).toEqual(before);
  }, 60000);

  // ─── ④ formatVersion 校验 ───────────────────────────────────

  it('formatVersion 不匹配 → 400 VALIDATION_ERROR，零写入', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    const bad = { ...bundle, formatVersion: 99 };
    const probeSpace = await makeSpace(`BundleProbe ${RUN}`);
    try {
      await expect(
        bundleService.importBundle(probeSpace, bad as never, testActor),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.VALIDATION_ERROR },
      });
      expect(await ds.getRepository(Doc).count({ where: { spaceId: probeSpace } })).toBe(0);
      expect(await ds.getRepository(DocCategory).count({ where: { spaceId: probeSpace } })).toBe(0);
    } finally {
      await ds.getRepository(DocSpace).delete({ id: probeSpace });
    }
  }, 60000);

  // ─── ⑤ overwriteSpaceMeta ───────────────────────────────────

  it('overwriteSpaceMeta：默认关闭零写；显式开启覆盖 name/description/settings，保留 slug/creator', async () => {
    if (!dbAvailable) return;

    const bundle = await bundleService.exportBundle(srcSpaceId);
    const metaSpace = await makeSpace(`BundleMeta ${RUN}`);
    const metaRepo = ds.getRepository(DocSpace);
    try {
      // 默认关闭：空间元数据不被 bundle 触碰
      const before = await metaRepo.findOne({ where: { id: metaSpace } });
      expect(before?.name).toBe(`BundleMeta ${RUN}`);
      expect(before?.description).toBeNull();

      const r1 = await bundleService.importBundle(metaSpace, bundle as never, testActor);
      expect(r1.spaceMeta.applied).toBe(false);
      const afterDefault = await metaRepo.findOne({ where: { id: metaSpace } });
      expect(afterDefault?.name).toBe(`BundleMeta ${RUN}`); // 未覆盖
      expect(afterDefault?.description).toBeNull();

      // 显式开启：name/description/settings 整对象覆盖
      await docspaceService.update(metaSpace, { description: '目标图例' });
      const r2 = await bundleService.importBundle(metaSpace, bundle as never, testActor, true);
      expect(r2.spaceMeta).toEqual({ applied: true, status: 'updated' });

      const after = await metaRepo.findOne({ where: { id: metaSpace } });
      expect(after?.name).toBe(bundle.space.name);
      expect(after?.description).toBe(bundle.space.description);
      expect(after?.settings.visibility).toBe(Visibility.OPEN);
      // 身份字段不随 bundle 迁移
      expect(after?.slug).toContain('BundleMeta');
      expect(after?.creatorId).toBe(spaceCreator);
    } finally {
      await ds.getRepository(DocSpace).delete({ id: metaSpace });
    }
  }, 60000);
});
