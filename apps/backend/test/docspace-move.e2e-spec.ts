/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.2.10 (DocSpace Module) + plan venom-longshot-ragman.md
 *     （v1.60.0-dev P1 双件：73cadb0d 原子 move_doc / 8d763914 move impact）
 *   - 补充: docs/api-definition.md §16（POST /docs/:id/move、GET /docs/:id/move-impact）
 *
 * [踩坑索引]
 *   - audit_action 枚举缺口（v1.60.0-dev 新坑，本套件实证）：AuditAction.MOVE_DOC 落库
 *     需 PG 枚举 audit_action 有 move_doc 值——1787043711624 只补了 event_type，
 *     1787045000000-AddAuditMoveDocAction 补齐；mock 单测测不出（auditRepo mock），
 *     必须打真实 PG（本套件 move happy 断言 audit 落库）
 *   - B-51/SSE actor 过滤（906a5a3）：DOC_MOVED 事件 topicId/boardId 必须经
 *     getSpaceEventContext 从空间绑定派生（本套件断言事件载荷与派生结果一致）
 *   - 本地库 agents.rate_limit 缺列（债务 94502fef）：owner 代理解析全列查询会炸，
 *     本套件不触及 OwnerProxyService（EventService 打桩），同 sse.e2e-spec.ts 处理
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
 * DocMoveService 原子 move + move impact —— 真实 PG 集成套件（v1.60.0-dev P1 双件）
 *
 * 与 doc-move.service.spec.ts（全 mock）的分工：本套件打真实 PostgreSQL，直接实例化
 * DocService + DocMoveService（真 TypeORM repo + 真 chunker/重建管线/真 recalc
 * SpaceLinkHealth），验证 plan §6 验收场景全链路——入链反扫 SQL、FOR UPDATE 事务、
 * 23505 唯一约束、audit_action 枚举落库、DOC_MOVED 事件、move 后版本/任务关联/路由
 * 引用不变量、oldPath 释放 + newPath 命中、异步 linkHealth 重算——mock 单测测不出
 * ORM SQL 生成与 PG 枚举/约束行为（铁律 #23 教训）。
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
import { DocMoveService } from '../src/modules/docspace/doc-move.service';
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
const RUN = `move-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，upsert 缺省 'system' 字面量会被 PG 拒绝） */
const testActor: UnifiedActor = {
  id: '00000000-0000-4000-8000-0000000000aa',
  type: ActorType.HUMAN,
};

/** 种子 taskId（task_doc_links 裸 uuid 无 FK，无需真实 Task 行） */
const TASK_ID = '00000000-0000-4000-8000-0000000000bb';

describe('DocMoveService — 真实 PG 集成（原子 move + move impact）', () => {
  let ds: DataSource;
  let service: DocService;
  let moveService: DocMoveService;
  let dbAvailable = false;

  /** 事件桩：记录全部 create 调用（种子 upsert 也会发 doc_created/updated，断言时过滤） */
  let eventCalls: Array<Record<string, unknown>>;

  let spaceId: string;
  let docA: Doc; // 被移目标（两版本 + task link + route 引用）
  let docB: Doc; // 入链来源（path 链接 + ?doc= 平台链接）
  let docC: Doc; // 目标 path 占用者（collision 场景）
  let docE: Doc; // outbound 出链源（自身含相对 .md 出链，跨目录移动后漂移面）
  let docF: Doc; // outbound 同目录目标（./f.md 移动前健康）
  let ingestDoc: Doc | null; // 非 native 来源（source mismatch 场景）

  const oldPath = `tmp/${RUN}/a.md`;
  const newPath = `tmp/${RUN}/a-renamed.md`;
  /** B 正文里指向 A 的相对 .md 链接（同目录裸相对：tmp/RUN/b.md 内 ./a.md
   *  → tmp/RUN/a.md 精确命中 docA.path——v1.61.0 严格源解析语义） */
  const hrefToA = `./a.md`;
  /** B 正文里指向 A 的平台规范链接（按 docId 引用，move 不受影响） */
  const hrefDocRef = () => `/docs/${spaceId}?doc=${docA.id}`;
  /** B 里指向 docC 的其他文档链接（不应出现在 A 的入链清单） */
  const hrefToC = `./c.md`;

  /** 等待异步 setImmediate 链完成（recalcSpaceLinkHealth 是 fire-and-forget DB I/O，
   *  单次 setImmediate 覆盖不了——轮询内部状态，5s 超时防挂死） */
  async function waitForLinkHealthBroken(
    docId: string,
    href: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const doc = await service.findById(docId);
      const broken = (doc.linkHealth as { broken?: string[] } | null)?.broken ?? [];
      if (broken.includes(href)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`linkHealth broken wait timeout for href "${href}" (doc ${docId})`);
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
      console.warn(`[docspace-move e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // EventService 打桩：move 事务后的 DOC_MOVED 由本套件直接断言 create 调用
    // （不接真 EventService——它依赖 owner 代理解析，本地库 agents.rate_limit 缺列会炸，
    //  对齐 sse.e2e-spec.ts 的 OwnerProxyService 打桩先例；事件表写入属 EventService 单测面）
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

    moveService = new DocMoveService(
      ds.getRepository(Doc),
      ds.getRepository(DocSection),
      ds.getRepository(DocRoute),
      ds.getRepository(TaskDocLink),
      ds.getRepository(AuditLog),
      ds.getRepository(IdempotencyRecord),
      service,
      eventStub,
    );

    // ── 种子数据：一个空间 + 文档 + 任务关联 + 意图路由（全部带 RUN 隔离）──
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Move E2E ${RUN}`,
        slug: `move-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceId = space.id;

    const upsertDoc = async (path: string, content: string, source?: string) => {
      const r = await service.upsert(
        spaceId,
        { path, content, ...(source ? { source } : {}) },
        testActor,
      );
      return service.findById(r.id);
    };

    // docA：两版本（upsert 两次 content 变化 → doc_versions 2 行）
    docA = await upsertDoc(oldPath, `# 文档 A\n\n## 版本一\n\n首版正文。`);
    docA = await upsertDoc(oldPath, `# 文档 A\n\n## 版本二\n\n第二版正文。`);

    // docB：入链来源——path 链接（指向 A）+ ?doc= 平台链接（指向 A）+ 指向 C 的链接
    docB = await upsertDoc(
      `tmp/${RUN}/b.md`,
      [
        '# 文档 B',
        '',
        '## 引用段',
        '',
        `见 [A](./a.md) 与 [A 平台](/docs/${spaceId}?doc=${docA.id})，还有 [C](./c.md)。`,
        '',
        '## 无关段',
        '',
        '本段无链接。',
      ].join('\n'),
    );

    // docC：collision 占用者（toPath == docC.path 时命中的目标）
    docC = await upsertDoc(`tmp/${RUN}/c.md`, `# 文档 C\n\n占用目标 path。`);

    // docE：outbound 出链源——自身同时含同目录相对链（./f.md 健康）、自引用（./e.md）、
    // 悬空链（./ghost.md）与平台链（?doc= 指向 docC——move 不受影响；指向 A 会
    // 污染 impact 入链用例的计数，刻意避开）
    docE = await upsertDoc(
      `tmp/${RUN}/e.md`,
      [
        '# 文档 E',
        '',
        `见 [F](./f.md) 与 [self](./e.md) 与 [ghost](./ghost.md) 与 ` +
          `[plat](/docs/${spaceId}?doc=${docC.id})。`,
      ].join('\n'),
    );
    // docF：outbound 同目录目标（./f.md 从 tmp/RUN/e.md 严格解析 = tmp/RUN/f.md）
    docF = await upsertDoc(`tmp/${RUN}/f.md`, `# 文档 F\n\n占用目标。`);

    // 非 native 文档（source mismatch 场景，随用随建由本用例负责清理）
    ingestDoc = null;

    // task_doc_links：docA 关联一个任务
    await ds.getRepository(TaskDocLink).save(
      ds.getRepository(TaskDocLink).create({
        taskId: TASK_ID,
        docId: docA.id,
        createdBy: testActor.id,
      }),
    );

    // doc_routes：primary 指向 docA（带 headingPath 锚点），secondary 指向 docC
    // （后者不应出现在 A 的 docRoutes 清单）
    await ds.getRepository(DocRoute).save(
      ds.getRepository(DocRoute).create({
        spaceId,
        intent: `我要了解 move 目标 ${RUN}`,
        category: null,
        primaryDocId: docA.id,
        primaryHeadingPath: '文档 A § 版本二',
        secondaryDocId: docC.id,
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
    for (const doc of [docA, docB, docC, docE, docF, ingestDoc]) {
      if (doc?.id) {
        await ds.getRepository(DocSection).delete({ docId: doc.id });
        await ds.getRepository(Doc).delete({ id: doc.id });
      }
    }
    await ds.getRepository(TaskDocLink).delete({ docId: docA.id });
    await ds.getRepository(DocRoute).delete({ spaceId });
    // audit 行按种子 docId 清理（move 写 audit，entity_id = docId）
    await ds.query(`DELETE FROM audit_logs WHERE entity_type = 'doc' AND entity_id = ANY($1)`, [
      [docA.id, docB.id, docC.id, docE.id, docF.id],
    ]);
    if (spaceId) {
      await ds.getRepository(DocSpace).delete({ id: spaceId });
    }
    await ds.destroy();
  });

  it('impact：三清单全命中（入链 path + ?doc= 双形态 + section 定位 / taskLinks / docRoutes）+ 非命中隔离', async () => {
    if (!dbAvailable) return;

    const impact = await moveService.computeMoveImpact(spaceId, docA, newPath);

    // ① 入链：B 的 path 链接（isPathBased + section 定位）与 ?doc= 链接（非 pathBased）各一
    expect(impact.inboundLinks).toHaveLength(2);
    const pathLink = impact.inboundLinks.find((l) => l.href === hrefToA);
    expect(pathLink).toMatchObject({
      sourceDocId: docB.id,
      sourcePath: docB.path,
      sourceTitle: docB.title,
      href: hrefToA,
      isPathBased: true,
    });
    // section 定位 = 该 href 首个命中 section 的 position/headingPath（「引用段」）
    expect(pathLink?.sectionPosition).toBeGreaterThanOrEqual(0);
    expect(pathLink?.headingPath).toContain('引用段');

    const docRefLink = impact.inboundLinks.find((l) => l.href === hrefDocRef());
    expect(docRefLink).toMatchObject({
      sourceDocId: docB.id,
      href: hrefDocRef(),
      isPathBased: false,
    });
    // 指向 docC 的链接不命中 A 的清单（反向隔离）
    expect(impact.inboundLinks.some((l) => l.href === hrefToC)).toBe(false);

    // ② taskLinks：seed 的任务在清单
    expect(impact.taskLinks).toContain(TASK_ID);

    // ③ docRoutes：primary 指向 A（headingPath 同步）；secondary=docC 不入清单
    expect(impact.docRoutes).toHaveLength(1);
    expect(impact.docRoutes[0]).toMatchObject({
      role: 'primary',
      intent: expect.stringContaining('move 目标'),
      headingPath: '文档 A § 版本二',
    });

    // ④ proposedPath 已传：samePath/targetCollision 判定随响应返回
    expect(impact.proposedPath).toBe(newPath);
    expect(impact.samePath).toBeUndefined();
    expect(impact.targetCollision).toBeUndefined();

    // ⑤ v1.62.0：move-impact root contentHash === DB docs.content_hash（乐观锁 token，
    // 与读出重建正文不可互算）
    expect(impact.contentHash).toBe(docA.contentHash);
  });

  it('collision：toPath 撞空间内未删 doc → 409 RESOURCE_CONFLICT + conflictDocId', async () => {
    if (!dbAvailable) return;

    const err = await moveService
      .move(docA.id, { toPath: docC.path }, testActor)
      .then(() => null)
      .catch((e: unknown) => e as { response?: { code?: string; data?: unknown } });

    expect(err?.response).toMatchObject({
      code: ErrorCode.RESOURCE_CONFLICT,
      data: { conflictDocId: docC.id },
    });
    // 拒绝后 A 仍原地（DB 落库前路径未动）
    const fresh = await service.findById(docA.id);
    expect(fresh.path).toBe(oldPath);
  });

  it('stale expectedContentHash：事务外快速失败 → 409 DOC_CONTENT_CONFLICT（带当前 hash）', async () => {
    if (!dbAvailable) return;

    const err = await moveService
      .move(docA.id, { toPath: newPath, expectedContentHash: 'stale-deadbeef' }, testActor)
      .then(() => null)
      .catch((e: unknown) => e as { response?: { code?: string; data?: unknown } });

    expect(err?.response).toMatchObject({
      code: ErrorCode.DOC_CONTENT_CONFLICT,
      data: { currentContentHash: docA.contentHash },
    });
    const fresh = await service.findById(docA.id);
    expect(fresh.path).toBe(oldPath);
  });

  it('toPath == 当前 path → 409 RESOURCE_CONFLICT（no-op 拒绝）', async () => {
    if (!dbAvailable) return;

    const err = await moveService
      .move(docA.id, { toPath: oldPath }, testActor)
      .then(() => null)
      .catch((e: unknown) => e as { response?: { code?: string } });

    expect(err?.response).toMatchObject({ code: ErrorCode.RESOURCE_CONFLICT });
  });

  it('dryRun：跑完整校验链（含真实 hash 前提）→ wouldMove 预演视图，不写库', async () => {
    if (!dbAvailable) return;
    const eventsBefore = eventCalls.length;

    const result = await moveService.move(
      docA.id,
      { toPath: newPath, expectedContentHash: docA.contentHash!, dryRun: true },
      testActor,
    );

    expect(result.moved).toBe(false);
    expect(result.wouldMove).toBe(true);
    expect(result.oldPath).toBe(oldPath);
    expect(result.newPath).toBe(newPath);
    expect(result.impact.pathBasedLinksToRewrite).toEqual(
      expect.arrayContaining([expect.objectContaining({ href: hrefToA })]),
    );

    // 不落库：path 未变、无 audit、无 DOC_MOVED 事件
    const fresh = await service.findById(docA.id);
    expect(fresh.path).toBe(oldPath);
    await expect(
      ds.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='doc' AND entity_id=$1 AND action='move_doc'`,
        [docA.id],
      ),
    ).resolves.toEqual([{ n: 0 }]);
    expect(eventCalls.slice(eventsBefore).some((e) => e.eventType === EventType.DOC_MOVED)).toBe(
      false,
    );
  });

  it('非 native 来源 → 409 DOC_SOURCE_MISMATCH（ingest 文档由适配器管）', async () => {
    if (!dbAvailable) return;

    const r = await service.upsert(
      spaceId,
      { path: `tmp/${RUN}/ingest.md`, content: '# Ingest\n\n同步文档。', source: 'git:test' },
      testActor,
    );
    ingestDoc = await service.findById(r.id);

    const err = await moveService
      .move(ingestDoc.id, { toPath: `tmp/${RUN}/ingest-moved.md` }, testActor)
      .then(() => null)
      .catch((e: unknown) => e as { response?: { code?: string } });

    expect(err?.response).toMatchObject({ code: ErrorCode.DOC_SOURCE_MISMATCH });
    const fresh = await service.findById(ingestDoc.id);
    expect(fresh.path).toBe(`tmp/${RUN}/ingest.md`);
  });

  it('happy：原子 move 全链路——引用面不变量 + oldPath 释放 newPath 命中 + audit + DOC_MOVED 事件 + linkHealth 重算', async () => {
    if (!dbAvailable) return;

    // 前置基线（铁律 #18 不变量检查：move 前后引用面零行变更）
    const versionsBefore = (
      (await ds.query(`SELECT count(*)::int AS n FROM doc_versions WHERE doc_id = $1`, [
        docA.id,
      ])) as Array<{ n: number }>
    )[0].n;
    expect(versionsBefore).toBe(2); // A 两版本 seed 前提
    const taskLinksBefore = (
      (await ds.query(`SELECT count(*)::int AS n FROM task_doc_links WHERE doc_id = $1`, [
        docA.id,
      ])) as Array<{ n: number }>
    )[0].n;
    expect(taskLinksBefore).toBe(1);

    // B 移动前 linkHealth：hrefToA 健康（指向存在 docA），broken 为空
    const bBefore = await service.findById(docB.id);
    expect((bBefore.linkHealth as { broken?: string[] } | null)?.broken ?? []).not.toContain(
      hrefToA,
    );

    const readBefore = eventCalls.length;

    const result = await moveService.move(
      docA.id,
      { toPath: newPath, expectedContentHash: docA.contentHash! },
      testActor,
    );

    // ── 响应：docId 不变 + 新旧 path + contentHash 不变（move 不重建内容）+ moved + rewrite 清单
    expect(result).toMatchObject({
      docId: docA.id,
      oldPath,
      newPath,
      contentHash: docA.contentHash,
      moved: true,
    });
    expect(result.impact.pathBasedLinksToRewrite).toEqual(
      expect.arrayContaining([expect.objectContaining({ href: hrefToA, isPathBased: true })]),
    );
    // ?doc= 平台链接不在 rewrite 清单（按 docId 引用不受影响）
    expect(result.impact.pathBasedLinksToRewrite.some((l) => l.href === hrefDocRef())).toBe(false);

    // ── 引用面不变量：versions / task links / route 引用行级不变 ──
    // updatedAt 必须 bump（QueryBuilder.update 不触发 @UpdateDateColumn，
    // 显式 NOW() 钉回归——「最近更新」排序面依赖该时间戳）
    const movedFresh = await service.findById(docA.id);
    expect(movedFresh.updatedAt.getTime()).toBeGreaterThan(docA.updatedAt.getTime());
    const versionsAfter = (
      (await ds.query(`SELECT count(*)::int AS n FROM doc_versions WHERE doc_id = $1`, [
        docA.id,
      ])) as Array<{ n: number }>
    )[0].n;
    expect(versionsAfter).toBe(versionsBefore);
    const taskLinksAfter = (
      (await ds.query(`SELECT count(*)::int AS n FROM task_doc_links WHERE doc_id = $1`, [
        docA.id,
      ])) as Array<{ n: number }>
    )[0].n;
    expect(taskLinksAfter).toBe(taskLinksBefore);
    const routeRows = (await ds.query(
      `SELECT id, primary_doc_id AS "primaryDocId" FROM doc_routes WHERE space_id = $1`,
      [spaceId],
    )) as Array<{ id: string; primaryDocId: string }>;
    expect(routeRows).toHaveLength(1);
    expect(routeRows[0].primaryDocId).toBe(docA.id); // 裸 uuid 引用不随 move 变化

    // ── path 精确语义：oldPath 释放（未删 doc 零命中）+ newPath 精确命中 ──
    const oldHit = (await ds.query(
      `SELECT id FROM docs WHERE space_id = $1 AND path = $2 AND deleted_at IS NULL`,
      [spaceId, oldPath],
    )) as Array<{ id: string }>;
    expect(oldHit).toHaveLength(0);
    const newHit = (await ds.query(
      `SELECT id FROM docs WHERE space_id = $1 AND path = $2 AND deleted_at IS NULL`,
      [spaceId, newPath],
    )) as Array<{ id: string }>;
    expect(newHit).toHaveLength(1);
    expect(newHit[0].id).toBe(docA.id);

    // ── audit 落库（PG 枚举 audit_action 真实写入——mock 测不出）──
    const auditRows = (await ds.query(
      `SELECT action, new_data FROM audit_logs WHERE entity_type='doc' AND entity_id=$1 AND action='move_doc' ORDER BY created_at DESC`,
      [docA.id],
    )) as Array<{ action: string; new_data: Record<string, unknown> }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].new_data).toMatchObject({ oldPath, newPath });

    // ── DOC_MOVED 事件：payload 完整 + topicId/boardId 经 getSpaceEventContext 派生
    //    （B-51 SSE actor 过滤下与 doc_created/updated/deleted 同源；本空间无绑定 → 均为空）
    const movedEvent = eventCalls
      .slice(readBefore)
      .find((e) => e.eventType === EventType.DOC_MOVED);
    expect(movedEvent).toBeDefined();
    expect(movedEvent).toMatchObject({
      resourceType: 'doc',
      resourceId: docA.id,
      payload: { spaceId, docId: docA.id, oldPath, newPath, title: docA.title },
    });
    expect(movedEvent?.topicId).toBeUndefined();
    expect(movedEvent?.boardId).toBeUndefined();

    // ── 异步 linkHealth 重算触发：旧 path 入链即刻变断链可见（轮询等 fire-and-forget）──
    await waitForLinkHealthBroken(docB.id, hrefToA);
    // ?doc= 链接按 docId 引用：move 后仍健康，不误报断链
    const bAfter = await service.findById(docB.id);
    expect((bAfter.linkHealth as { broken?: string[] } | null)?.broken ?? []).not.toContain(
      hrefDocRef(),
    );
  });

  it('outbound：跨目录移动 dryRun——自身相对出链漂移面逐条标注（exists 三态 + 自引用 new path 命中 + ?doc= 豁免）', async () => {
    if (!dbAvailable) return;

    // 同名换目录移动（真实的「归档到子目录」场景）：docE 的 ./e.md 自引用在移动后
    // 解析到自身 newPath——正是「被移文档自身以 newPath 计入集合」的判定依据
    const toDeep = `tmp/${RUN}/deep/e.md`;
    const result = await moveService.move(docE.id, { toPath: toDeep, dryRun: true }, testActor);

    // 清单存在（proposedPath 非空）且含三条 path-based 出链
    expect(result.impact.outboundPathLinksToRewrite).toHaveLength(3);

    // ① ./f.md：移前 tmp/RUN/f.md 存在（oldTargetExists=true）→ 移后 tmp/RUN/deep/f.md
    //    不存在（targetExists=false）——跨目录移动的真实失效项
    expect(
      result.impact.outboundPathLinksToRewrite!.find((l) => l.href === './f.md'),
    ).toMatchObject({
      oldResolvedTarget: `tmp/${RUN}/f.md`,
      newResolvedTarget: `tmp/${RUN}/deep/f.md`,
      oldTargetExists: true,
      targetExists: false,
    });

    // ② ./e.md 自引用：移后命中自身 newPath（移动后 path 集合含 proposedPath）
    //    → targetExists=true + targetDocId=docE.id（自引用按新 path 正确存活）
    expect(
      result.impact.outboundPathLinksToRewrite!.find((l) => l.href === './e.md'),
    ).toMatchObject({
      oldResolvedTarget: `tmp/${RUN}/e.md`,
      newResolvedTarget: toDeep,
      oldTargetExists: true,
      targetExists: true,
      targetDocId: docE.id,
    });

    // ③ ./ghost.md：移动前后都悬空 → oldTargetExists=false 显式标注（防已断误导）
    expect(
      result.impact.outboundPathLinksToRewrite!.find((l) => l.href === './ghost.md'),
    ).toMatchObject({
      oldResolvedTarget: `tmp/${RUN}/ghost.md`,
      newResolvedTarget: `tmp/${RUN}/deep/ghost.md`,
      oldTargetExists: false,
      targetExists: false,
    });

    // ?doc= 平台链接按 docId 引用不受 move 影响 → 不收录
    expect(result.impact.outboundPathLinksToRewrite!.some((l) => l.href.startsWith('/docs/'))).toBe(
      false,
    );

    // dryRun 不落库：docE 仍在原位
    const fresh = await service.findById(docE.id);
    expect(fresh.path).toBe(`tmp/${RUN}/e.md`);
  });

  it('recheck：单文档重检落库 + 404 判空 + 空间级全量 {checked, broken}（真实 PG）', async () => {
    if (!dbAvailable) return;

    // 单文档：B 的 ./a.md 在 A 移动后已断（依赖 happy 用例先执行，jest 顺序保证）→
    // 重检计算 + 落库，broken 含 ./a.md
    const single = await service.recheckDocLinkHealth(docB.id);
    expect(single.total).toBe(3); // ./a.md + ?doc= + ./c.md
    expect(single.broken).toContain('./a.md');
    const persisted = await service.findById(docB.id);
    expect((persisted.linkHealth as { broken?: string[] } | null)?.broken).toContain('./a.md');

    // 单文档 404：findById 判空（铁律 #22）不透传
    await expect(
      service.recheckDocLinkHealth('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_NOT_FOUND } });

    // 空间级：全量重算（批量 sections IN 查询——铁律 #23 真实 SQL 面）返回计数；
    // checked ≥ 5（A/B/C/E/F，另有 source mismatch 用例的 ingestDoc 未删 → 实际 6）
    const counts = await service.recalcSpaceLinkHealth(spaceId);
    expect(counts.checked).toBeGreaterThanOrEqual(5);
    expect(counts.broken).toBeGreaterThanOrEqual(1); // B 的 ./a.md 至少 1 条
  });

  it('文档不存在 → 404 DOC_NOT_FOUND（findById 判空，铁律 #22）', async () => {
    if (!dbAvailable) return;

    await expect(
      moveService.move('00000000-0000-4000-8000-0000000000ff', { toPath: 'x.md' }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
  });
});
