/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (DocSpace 模块, PATCH /docs/:id/metadata)
 *   - 补充: plan patriot-cyclone-deadman.md §2.3（v1.61.0 批次 2 测试：partial 矩阵 /
 *     hash stale 409 / category 解析开关 / 引用面不变量 / e2e 真实 PG 全链路）
 *
 * [踩坑索引]
 *   - mock 测不出 ORM SQL 生成（铁律 #23）：partial UPDATE 的 jsonb/数组列写面、
 *     FOR UPDATE 事务、audit jsonb newData 落库，全必须打真实 PG（本套件职责）
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #23(jsonb/ORM 集成覆盖) #22(findOne必须判空)
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
 * DocService.patchMetadata —— 真实 PG 集成套件（v1.61.0 批次 2，任务 201ae04f）
 *
 * 与 doc.service.spec.ts patchMetadata 段（全 mock）的分工：本套件打真实
 * PostgreSQL，直接实例化 DocService（真 TypeORM repo + 真事务 FOR UPDATE），
 * 验证游戏方 6 条契约全链路——partial UPDATE SQL 生成（数组列/可空列写面）、
 * 引用面四表不变量（sectionCount/contentHash/doc_versions/task_doc_links/
 * doc_routes）、category 解析开关、audit jsonb 落库、DOC_UPDATED 事件载荷。
 * mock 单测测不出 ORM SQL 生成与 PG 约束行为（铁律 #23 教训）。
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode, EventType } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Board } from '../src/database/entities/board.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';
import type { UnifiedActor } from '../src/common/types/actor.types';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `mdpatch-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，'system' 字面量会被 PG 拒绝） */
const testActor: UnifiedActor = {
  id: '00000000-0000-4000-8000-0000000000aa',
  type: ActorType.HUMAN,
};

/** 种子 taskId（task_doc_links 裸 uuid 无 FK，无需真实 Task 行） */
const TASK_ID = '00000000-0000-4000-8000-0000000000bb';

/** 断言 4xx 错误体的 code（NestJS HttpException.response 结构） */
async function expectErrorCode(promise: Promise<unknown>, code: number): Promise<void> {
  await expect(promise).rejects.toMatchObject({ response: { code } });
}

describe('DocService.patchMetadata — 真实 PG 集成（metadata-only patch）', () => {
  let ds: DataSource;
  let service: DocService;
  let dbAvailable = false;

  /** 事件桩：记录全部 create 调用（种子 upsert 也会发 doc_created/updated，断言时过滤） */
  let eventCalls: Array<Record<string, unknown>>;

  let spaceId: string;
  let doc: Doc; // patch 目标（两版本 + task link + route 引用）
  let ingestDoc: Doc; // 非 native 来源（DOC_SOURCE_MISMATCH 场景）
  let seedCategoryId: string; // 空间内既有分类（resolve-only 命中用）

  const docPath = `tmp/${RUN}/target.md`;

  /** 引用面快照：patch 前采集，patch 后逐表比对（铁律 #18 不变量） */
  async function snapshotReferenceSurface(docId: string) {
    const sections = await ds.getRepository(DocSection).find({
      where: { docId },
      order: { position: 'ASC' },
    });
    const versionCount = await ds.getRepository(DocVersion).count({ where: { docId } });
    const taskLinks = await ds.getRepository(TaskDocLink).find({ where: { docId } });
    const routes = await ds.getRepository(DocRoute).find({
      where: [{ primaryDocId: docId }, { secondaryDocId: docId }],
    });
    return { sections, versionCount, taskLinks, routes };
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
        `[docspace-patch-metadata e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // EventService 打桩：DOC_UPDATED（metadataOnly）由本套件直接断言 create 调用
    // （不接真 EventService——它依赖 owner 代理解析，本地库缺列会炸，对齐 move 套件先例）
    eventCalls = [];
    const eventStub = {
      create: jest.fn(async (e: Record<string, unknown>) => {
        eventCalls.push(e);
        return {};
      }),
    } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;

    service = new DocService(
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
    );

    // ── 种子数据：一个空间 + 目标文档（双版本）+ 任务关联 + 意图路由 + 既有分类 ──
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `MdPatch E2E ${RUN}`,
        slug: `mdpatch-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceId = space.id;

    // 既有分类（resolve-only 命中场景 + category patch 目标）
    const seedCategory = await ds.getRepository(DocCategory).save(
      ds.getRepository(DocCategory).create({
        spaceId,
        name: `既有分类-${RUN}`,
        slug: `seed-cat-${RUN}`.slice(0, 128),
        description: null,
        sortOrder: 0,
      }),
    );
    seedCategoryId = seedCategory.id;

    // 目标文档：两次内容变更 → doc_versions 2 行 + 多 section 结构
    await service.upsert(
      spaceId,
      { path: docPath, content: `# 目标文档\n\n## 第一节\n\n首版正文。`, tags: ['seed'] },
      testActor,
    );
    const r2 = await service.upsert(
      spaceId,
      {
        path: docPath,
        content: `# 目标文档\n\n## 第一节\n\n第二版正文。\n\n## 第二节\n\n更多正文。`,
        tags: ['seed'],
        summary: '种子摘要',
        docType: 'note',
      },
      testActor,
    );
    doc = await service.findById(r2.id);

    // 非 native 文档（DOC_SOURCE_MISMATCH 场景）
    const rIngest = await service.upsert(
      spaceId,
      { path: `tmp/${RUN}/ingest.md`, content: `# Ingest\n\n只读来源。`, source: 'git:other-repo' },
      testActor,
    );
    ingestDoc = await service.findById(rIngest.id);

    // task_doc_links：目标文档关联一个任务
    await ds.getRepository(TaskDocLink).save(
      ds.getRepository(TaskDocLink).create({
        taskId: TASK_ID,
        docId: doc.id,
        createdBy: testActor.id,
      }),
    );

    // doc_routes：primary 指向目标文档（带 headingPath 锚点）
    await ds.getRepository(DocRoute).save(
      ds.getRepository(DocRoute).create({
        spaceId,
        intent: `我要了解 metadata patch 目标 ${RUN}`,
        category: null,
        primaryDocId: doc.id,
        primaryHeadingPath: '目标文档 § 第一节',
        secondaryDocId: null,
        secondaryHeadingPath: null,
        codeEntry: null,
        codeEntryType: 'exact',
        health: null,
        sortOrder: 0,
        createdBy: testActor.id,
      }),
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;

    // 硬删兜底清理（sections 走 CASCADE，显式删更直白；引用面按 docId 精确删除）
    for (const d of [doc, ingestDoc]) {
      if (d?.id) {
        await ds.getRepository(DocSection).delete({ docId: d.id });
        await ds.getRepository(DocVersion).delete({ docId: d.id });
        await ds.getRepository(Doc).delete({ id: d.id });
      }
    }
    await ds.getRepository(TaskDocLink).delete({ docId: doc.id });
    await ds.getRepository(DocRoute).delete({ spaceId });
    // allowCreateCategory 用例可能创建的测试分类（按空间清理本 RUN 全部）
    await ds.getRepository(DocCategory).delete({ spaceId });
    // audit 行按种子 docId 清理
    await ds.query(`DELETE FROM audit_logs WHERE entity_type = 'doc' AND entity_id = ANY($1)`, [
      [doc.id, ingestDoc.id],
    ]);
    if (spaceId) {
      await ds.getRepository(DocSpace).delete({ id: spaceId });
    }
    await ds.destroy();
  });

  it('全链路 partial patch：title+tags+category 变更，summary/docType 缺席不动', async () => {
    if (!dbAvailable) return;

    const before = await snapshotReferenceSurface(doc.id);
    const hashBefore = doc.contentHash;

    const result = await service.patchMetadata(
      doc.id,
      {
        title: '元数据新标题',
        tags: ['patched', 'e2e'],
        category: `既有分类-${RUN}`,
        expectedContentHash: hashBefore!,
      },
      testActor,
    );

    // 响应契约：changedFields 精确 + 最终元数据回传 + contentHash 不变
    expect(result.docId).toBe(doc.id);
    expect(result.path).toBe(docPath);
    expect(result.unchanged).toBe(false);
    expect(result.changedFields.sort()).toEqual(['category', 'tags', 'title']);
    expect(result.contentHash).toBe(hashBefore);
    expect(result.metadata).toMatchObject({
      title: '元数据新标题',
      summary: '种子摘要', // 缺席字段不动
      docType: 'note', // 缺席字段不动
      tags: ['patched', 'e2e'],
      categoryId: seedCategoryId,
      categoryName: `既有分类-${RUN}`,
    });

    // 落库核对（不信响应，直查行）
    const fresh = await service.findById(doc.id);
    expect(fresh.title).toBe('元数据新标题');
    expect(fresh.tags).toEqual(['patched', 'e2e']);
    expect(fresh.categoryId).toBe(seedCategoryId);
    expect(fresh.summary).toBe('种子摘要');
    expect(fresh.docType).toBe('note');
    expect(fresh.contentHash).toBe(hashBefore);

    // 不变量（铁律 #18）：引用面四表零行变更
    const after = await snapshotReferenceSurface(doc.id);
    expect(fresh.sectionCount).toBe(before.sections.length);
    expect(after.sections.length).toBe(before.sections.length);
    expect(after.sections.map((s) => [s.position, s.headingPath, s.content])).toEqual(
      before.sections.map((s) => [s.position, s.headingPath, s.content]),
    );
    expect(after.versionCount).toBe(before.versionCount); // 不落 doc_versions
    expect(after.taskLinks.map((l) => l.taskId)).toEqual(before.taskLinks.map((l) => l.taskId));
    expect(after.routes.map((r) => r.id)).toEqual(before.routes.map((r) => r.id));
    expect(fresh.id).toBe(doc.id); // docId 不变
    expect(fresh.path).toBe(docPath); // path 不变

    // audit 落库（action=update + metadataOnly + changedFields 前后值）
    const audits = await ds.query(
      `SELECT action, new_data FROM audit_logs WHERE entity_type = 'doc' AND entity_id = $1 AND action = 'update' ORDER BY created_at DESC LIMIT 1`,
      [doc.id],
    );
    expect(audits.length).toBe(1);
    const newData =
      typeof audits[0].new_data === 'string' ? JSON.parse(audits[0].new_data) : audits[0].new_data;
    expect(newData.metadataOnly).toBe(true);
    expect(newData.changedFields.sort()).toEqual(['category', 'tags', 'title']);
    expect(newData.before.title).toBe('目标文档');
    expect(newData.after.title).toBe('元数据新标题');
    expect(newData.before.tags).toEqual(['seed']);
    expect(newData.after.tags).toEqual(['patched', 'e2e']);

    // DOC_UPDATED 事件：payload 标 metadataOnly + changedFields
    const mdEvents = eventCalls.filter(
      (e) =>
        e.eventType === EventType.DOC_UPDATED &&
        (e.payload as { metadataOnly?: boolean }).metadataOnly,
    );
    expect(mdEvents.length).toBe(1);
    expect(mdEvents[0].resourceId).toBe(doc.id);
    const payload = mdEvents[0].payload as { changedFields: string[]; spaceId: string };
    expect(payload.changedFields.sort()).toEqual(['category', 'tags', 'title']);
    expect(payload.spaceId).toBe(spaceId);
  });

  it('tags: [] 清空语义（空数组 = 显式清空，非缺席）', async () => {
    if (!dbAvailable) return;

    const current = await service.findById(doc.id);
    expect(current.tags.length).toBeGreaterThan(0); // 上一用例落了非空 tags

    const result = await service.patchMetadata(
      doc.id,
      { tags: [], expectedContentHash: current.contentHash! },
      testActor,
    );

    expect(result.changedFields).toEqual(['tags']);
    const fresh = await service.findById(doc.id);
    expect(fresh.tags).toEqual([]);
    expect(fresh.contentHash).toBe(current.contentHash); // 内容面不动
  });

  it('unchanged 短路：全字段与现值相同 → 无 UPDATE/audit/事件，contentHash 不变', async () => {
    if (!dbAvailable) return;

    const current = await service.findById(doc.id);
    const auditCountBefore = (
      await ds.query(
        `SELECT count(*)::int AS c FROM audit_logs WHERE entity_type = 'doc' AND entity_id = $1`,
        [doc.id],
      )
    )[0].c as number;
    const eventCountBefore = eventCalls.length;

    const result = await service.patchMetadata(
      doc.id,
      {
        title: current.title,
        summary: current.summary ?? undefined,
        docType: current.docType ?? undefined,
        tags: [...current.tags],
        expectedContentHash: current.contentHash!,
      },
      testActor,
    );

    expect(result.unchanged).toBe(true);
    expect(result.changedFields).toEqual([]);
    expect(result.contentHash).toBe(current.contentHash);

    // 零写操作证明：audit 行数与事件数不增
    const auditCountAfter = (
      await ds.query(
        `SELECT count(*)::int AS c FROM audit_logs WHERE entity_type = 'doc' AND entity_id = $1`,
        [doc.id],
      )
    )[0].c as number;
    expect(auditCountAfter).toBe(auditCountBefore);
    expect(eventCalls.length).toBe(eventCountBefore);
  });

  it('hash stale → 409 DOC_CONTENT_CONFLICT 带 currentContentHash（事务外快速失败径）', async () => {
    if (!dbAvailable) return;

    await expectErrorCode(
      service.patchMetadata(doc.id, { title: 'x', expectedContentHash: 'f'.repeat(64) }),
      ErrorCode.DOC_CONTENT_CONFLICT,
    );

    // 409 不落任何写：标题不变
    const fresh = await service.findById(doc.id);
    expect(fresh.title).not.toBe('x');
  });

  it('非 native source → 409 DOC_SOURCE_MISMATCH（native-only 契约）', async () => {
    if (!dbAvailable) return;

    await expectErrorCode(
      service.patchMetadata(ingestDoc.id, {
        title: 'x',
        expectedContentHash: ingestDoc.contentHash!,
      }),
      ErrorCode.DOC_SOURCE_MISMATCH,
    );
  });

  it('文档不存在 → 404 DOC_NOT_FOUND（findById fail-closed，铁律 #22）', async () => {
    if (!dbAvailable) return;

    await expectErrorCode(
      service.patchMetadata('00000000-0000-4000-8000-00000000dead', {
        title: 'x',
        expectedContentHash: 'a'.repeat(64),
      }),
      ErrorCode.DOC_NOT_FOUND,
    );
  });

  it('category resolve-only 未命中 → 404 DOC_CATEGORY_NOT_FOUND（防拼写近似分类）', async () => {
    if (!dbAvailable) return;

    const current = await service.findById(doc.id);
    await expectErrorCode(
      service.patchMetadata(doc.id, {
        category: `拼错分类-${RUN}`,
        expectedContentHash: current.contentHash!,
      }),
      ErrorCode.DOC_CATEGORY_NOT_FOUND,
    );

    // 未创建任何分类（resolve-only 契约）
    const created = await ds.getRepository(DocCategory).findOne({
      where: { spaceId, name: `拼错分类-${RUN}` },
    });
    expect(created).toBeNull();
  });

  it('allowCreateCategory=true：未命中自动创建分类并落 categoryId', async () => {
    if (!dbAvailable) return;

    const current = await service.findById(doc.id);
    const newCatName = `新建分类-${RUN}`;

    const result = await service.patchMetadata(
      doc.id,
      {
        category: newCatName,
        allowCreateCategory: true,
        expectedContentHash: current.contentHash!,
      },
      testActor,
    );

    expect(result.changedFields).toEqual(['category']);
    expect(result.metadata.categoryName).toBe(newCatName);
    const fresh = await service.findById(doc.id);
    expect(fresh.categoryId).toBe(result.metadata.categoryId);
    expect(fresh.contentHash).toBe(current.contentHash);
  });
});
