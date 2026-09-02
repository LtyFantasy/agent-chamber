/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: plan .kimi/plans/diagram-ir-v1-plan.md §6.2（9 条覆盖链，本套件全部实现）
 *   - 补充: 铁律 #23（RT-SEAT-1 教训）——渲染门/合成节/搜索索引/bundle 回导涉及
 *     真实 PG trigger + 真实 vendored 渲染器（spawn 子进程），mock 单测测不出，
 *     必须有本套件的真实集成覆盖
 *
 * [踩坑索引]
 *   - 套件直接实例化 Service + 真实 DataSource（照 docspace-patch e2e 先例）；
 *     REST 装配层（CSP 头/权限 ensureCan 调用）由 diagram.controller.spec.ts 覆盖
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * Diagram IR v1 — 真实 PG + 真实渲染器集成套件（plan §6.2 九条覆盖链）。
 *
 * 与 mock 单测的分工：本套件打真实 PostgreSQL（tsvector trigger / jsonb / 事务）
 * 并真实 spawn vendored archify 渲染器（packages/diagram，fixture 5 型各 1 个）。
 * DB 目标 = 本地开发库（docker-compose 默认参数，env 可覆盖）；PG 不可达时整套
 * 降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ActorType, ErrorCode, Visibility } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocSpaceService } from '../src/modules/docspace/docspace.service';
import { DocService } from '../src/modules/docspace/doc.service';
import { DiagramService } from '../src/modules/docspace/diagram.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import { DocSearchService } from '../src/modules/docspace/doc-search.service';
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
import { PermissionService } from '../src/common/services/permission.service';
import { DocSpacePolicy } from '../src/common/policies/doc-space.policy';
import type { OwnerProxyService } from '../src/common/services/owner-proxy.service';
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
const RUN = `diagram-e2e-${Date.now()}`;

/**
 * 固定测试 actor（本套件专用哨兵 id，不与其他套件共用）：afterAll 按 actorId
 * 清理 audit_logs 时并行安全（08-29 套件污染修复教训）
 */
const testActor = { id: '00000000-0000-4000-8000-0000000000b1', type: ActorType.HUMAN };

/** 固定空间 creator（doc_spaces.creator_id 为 uuid 列） */
const spaceCreator = '00000000-0000-4000-8000-0000000000ee';

/** 无权限的外部 actor（权限用例） */
const outsiderActor = { id: '00000000-0000-4000-8000-0000000000b2', type: ActorType.AGENT };

/** vendored fixtures 目录（packages/diagram/test/fixtures，5 型各 1 个真实 IR） */
const FIXTURE_DIR = path.resolve(__dirname, '../../../packages/diagram/test/fixtures');
const FIXTURES: Record<string, string> = {
  architecture: 'web-app.architecture.json',
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'async-job-roundtrip.sequence.json',
  dataflow: 'product-analytics.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

function loadFixture(type: keyof typeof FIXTURES): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, FIXTURES[type]), 'utf8'));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Diagram IR v1 — 真实 PG + 真实渲染器（plan §6.2 全链）', () => {
  let ds: DataSource;
  let docService: DocService;
  let diagramService: DiagramService;
  let searchService: DocSearchService;
  let bundleService: DocBundleService;
  let permissionService: PermissionService;
  let dbAvailable = false;

  let spaceId: string;
  const createdDocIds: string[] = [];
  const spaceIds: string[] = [];

  /** 冲刷 setImmediate 队列（route health recheck fire-and-forget） */
  const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

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
        `[docspace-diagram e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }
    dbAvailable = true;

    // EventService / RouteHealthService 打桩：事件/路由重检由各自套件覆盖
    const eventStub = { create: jest.fn().mockResolvedValue({}) } as unknown as EventService;
    const routeHealthStub = {
      recheckSpace: jest.fn().mockResolvedValue({ rechecked: 0, broken: 0 }),
    } as unknown as RouteHealthService;

    // 真实渲染器（子进程 spawn packages/diagram；路径从 cwd 向上探测）
    const renderer = new DiagramRendererService();

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
      renderer,
    );
    diagramService = new DiagramService(
      docService,
      renderer,
      ds.getRepository(IdempotencyRecord),
      ds.getRepository(Doc),
    );
    searchService = new DocSearchService(
      ds.getRepository(DocSection),
      ds.getRepository(Doc),
      ds.getRepository(DocRoute),
      ds.getRepository(TaskDocLink),
    );

    // bundle round-trip 装配（照 docspace-bundle e2e 先例全构造 DocSpaceService）
    const accessQueryStub = {} as unknown as AccessQueryService;
    const resourceValidatorStub = {} as unknown as ResourceValidator;
    const actorProfileService = new ActorProfileService(
      ds.getRepository(Actor),
      ds.getRepository(Agent),
      ds.getRepository(User),
    );
    const auditServiceStub = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    const docspaceService = new DocSpaceService(
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
    const docRouteService = new DocRouteService(
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

    // 权限用例：真实 DocSpacePolicy（member 表真实查询）+ ownerProxy 打桩
    // （outsider 是 agent 类型，isOwnerProxyCandidate 不命中，不会触及该桩）
    const ownerProxyStub = {
      isOwnerProxy: jest.fn().mockResolvedValue(false),
      listOwnedAgentIds: jest.fn().mockResolvedValue([]),
    } as unknown as OwnerProxyService;
    const docSpacePolicy = new DocSpacePolicy(ds.getRepository(DocSpaceMember), ownerProxyStub);
    permissionService = new PermissionService(
      {} as never,
      {} as never,
      docSpacePolicy,
      {} as never,
      {} as never,
    );

    // ── 种子：一个 OPEN 空间 ──
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: `Diagram E2E ${RUN}`,
        slug: `diagram-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: spaceCreator,
        settings: {},
      }),
    );
    spaceId = space.id;
    spaceIds.push(spaceId);
  }, 120000);

  afterAll(async () => {
    if (!dbAvailable) return;
    // 硬删兜底清理（sections 显式删；versions/idempotency 按 doc 删）
    for (const id of createdDocIds) {
      await ds.getRepository(DocVersion).delete({ docId: id });
      await ds.getRepository(DocSection).delete({ docId: id });
      await ds.getRepository(Doc).delete({ id });
    }
    // import 回导可能产生同 path 新 docId——按空间兜底清一遍（含 sections/versions）
    for (const sid of spaceIds) {
      const docs = await ds.getRepository(Doc).find({ where: { spaceId: sid } });
      for (const d of docs) {
        await ds.getRepository(DocVersion).delete({ docId: d.id });
        await ds.getRepository(DocSection).delete({ docId: d.id });
        await ds.getRepository(Doc).delete({ id: d.id });
      }
      const cats = await ds.getRepository(DocCategory).find({ where: { spaceId: sid } });
      for (const c of cats) {
        await ds.getRepository(DocCategory).delete({ id: c.id });
      }
      await ds.getRepository(DocRoute).delete({ spaceId: sid });
      await ds.getRepository(DocSpace).delete({ id: sid });
    }
    // audit 行按哨兵 actor 清理（防挤占 activity-logs 套件分页窗口，08-29 教训）
    await ds.getRepository(AuditLog).delete({ actorId: testActor.id });
    await ds.destroy();
  }, 60000);

  /** 建图并登记清理 */
  async function upsertDiagram(
    type: keyof typeof FIXTURES,
    docPath: string,
    extra: { expectedContentHash?: string } = {},
  ) {
    const result = await diagramService.upsertDiagram(
      spaceId,
      { path: docPath, ir: loadFixture(type), ...extra },
      testActor,
    );
    createdDocIds.push(result.id);
    return result;
  }

  /** 带 renderedHtml 隐藏列读 doc 行 */
  async function readDocRow(docId: string): Promise<Doc | null> {
    return ds
      .getRepository(Doc)
      .createQueryBuilder('d')
      .addSelect('d.renderedHtml')
      .where('d.id = :id', { id: docId })
      .getOne();
  }

  // ─── ① 建图→读→HTML（含五型 sweep）─────────────────────────

  it('五型 fixture 全部过门（upsert_diagram → 渲染快照落库）', async () => {
    if (!dbAvailable) return;
    for (const type of Object.keys(FIXTURES) as (keyof typeof FIXTURES)[]) {
      const result = await upsertDiagram(type, `tmp/${RUN}-${type}.json`);
      expect(result.diagramType).toBe(type);
      expect(result.created).toBe(true);
      expect(result.sectionCount).toBe(1);
      expect(result.render?.qualityProfile).toBeTruthy();
      expect(result.render?.htmlSha256).toMatch(/^[a-f0-9]{64}$/);

      // 三列落库（不变量：docType='diagram' ⟺ diagram_type/rendered_html 非空）
      const row = await readDocRow(result.id);
      expect(row?.docType).toBe('diagram');
      expect(row?.diagramType).toBe(type);
      expect(row?.renderedHtml).toContain('<svg');
      expect(row?.renderMeta?.qualityProfile).toBeTruthy();
    }
  }, 120000);

  it('建图→读：readDiagram 返回解析后 IR（与规范化文本逐字节一致）+ contentHash + render', async () => {
    if (!dbAvailable) return;
    const fixture = loadFixture('architecture');
    const canonical = JSON.stringify(fixture, null, 2);
    const created = await upsertDiagram('architecture', `tmp/${RUN}-read.json`);

    const detail = await diagramService.readDiagram(created.id);
    expect(detail.diagramType).toBe('architecture');
    // 解析后对象再规范化 = 库存 canonical 文本（字节一致性）
    expect(JSON.stringify(detail.ir, null, 2)).toBe(canonical);
    // getContent(full=true) 通道同形（合成节重建逐字节等于落库内容）
    const full = await docService.getContent(created.id, true);
    expect(full.content).toBe(canonical);
    // contentHash 乐观锁 token = canonical 的 sha256
    expect(detail.contentHash).toBe(sha256(canonical));
    expect(created.contentHash).toBe(sha256(canonical));
    // render 元数据
    expect(detail.render.qualityProfile).toBe('showcase'); // fixture 声明 showcase
    expect(detail.render.composition).toEqual({ errors: 0, warnings: 0 });
    expect(detail.render.htmlBytes).toBeGreaterThan(100_000);

    // HTML 快照：sha256 与 render_meta 一致（确定性编译产物指纹）
    const { html } = await diagramService.getDiagramHtml(created.id);
    expect(html).toContain('<svg');
    expect(sha256(html)).toBe(detail.render.htmlSha256);
    expect(Buffer.byteLength(html, 'utf8')).toBe(detail.render.htmlBytes);
  }, 60000);

  it('diagram.html?lang=zh-CN：读时重渲染中文 viewer 文案（双向断言 + 不落库）', async () => {
    if (!dbAvailable) return;
    // fixture meta 无 locale 键 → 存储快照语言 = en（渲染器 resolveLocale 缺省回落）
    const created = await upsertDiagram('architecture', `tmp/${RUN}-lang.json`);
    const before = await readDocRow(created.id);

    // lang=zh-CN ≠ 存储 locale → 读时重渲染：legend.title 产物锚点 >图例< 出现
    const zh = await diagramService.getDiagramHtml(created.id, 'zh-CN');
    expect(zh.html).toContain('>图例<');
    expect(zh.html).toContain('"locale":"zh-CN"');
    expect(zh.langFallback).toBeUndefined();

    // 对照（双向锁定）：lang=en 直出存储快照，不含中文图例标题
    // （锚点取 >图例< 而非泛中文——节点标签是作者内容，本就可能含中文）
    const en = await diagramService.getDiagramHtml(created.id, 'en');
    expect(en.html).not.toContain('>图例<');
    expect(en.html).toBe(before?.renderedHtml);

    // 不落库不变量：存储快照/contentHash/render_meta 全部不动
    const after = await readDocRow(created.id);
    expect(after?.renderedHtml).toBe(before?.renderedHtml);
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.renderMeta?.htmlSha256).toBe(before?.renderMeta?.htmlSha256);
  }, 60000);

  it('unchanged 重放零渲染（R1）：同 IR 二次 upsert → unchanged:true，快照不动', async () => {
    if (!dbAvailable) return;
    const first = await upsertDiagram('lifecycle', `tmp/${RUN}-unchanged.json`);
    const rowBefore = await readDocRow(first.id);

    const second = await diagramService.upsertDiagram(
      spaceId,
      { path: `tmp/${RUN}-unchanged.json`, ir: loadFixture('lifecycle') },
      testActor,
    );
    expect(second.unchanged).toBe(true);
    const rowAfter = await readDocRow(first.id);
    // rendered_at 不变 = 未重渲染（重渲染会刷新 renderedAt/htmlSha256 对）
    expect((rowAfter?.renderMeta as { renderedAt?: string })?.renderedAt).toBe(
      (rowBefore?.renderMeta as { renderedAt?: string })?.renderedAt,
    );
  }, 60000);

  // ─── ② 版本断言（铁律 #18：内容变 ⟺ 版本行）─────────────────

  it('doc_versions 有 IR 文本快照（source=upsert，content=规范化 IR）', async () => {
    if (!dbAvailable) return;
    const fixture = loadFixture('sequence');
    const canonical = JSON.stringify(fixture, null, 2);
    const created = await upsertDiagram('sequence', `tmp/${RUN}-version.json`);

    const versions = await ds.getRepository(DocVersion).find({ where: { docId: created.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toBe('upsert');
    expect(versions[0].content).toBe(canonical);
    expect(versions[0].contentHash).toBe(sha256(canonical));
    // HTML 快照不进版本（派生字段哲学）：版本表无 rendered_html 列，行内只有 IR 文本
  }, 60000);

  // ─── ③ 搜索命中（铁律 #23 真实 PG tsvector 覆盖点）──────────

  it('以组件 label 搜索命中 diagram doc（tsvector trigger 索引合成节）', async () => {
    if (!dbAvailable) return;
    await upsertDiagram('architecture', `tmp/${RUN}-search.json`);
    await flushImmediates();

    // fixture 组件 label（web-app.architecture.json：id=auth 的组件）
    const hits = await searchService.search([spaceId], { q: 'Auth Provider' });
    const paths = hits.map((h) => h.docPath);
    expect(paths).toContain(`tmp/${RUN}-search.json`);
    // 命中带上 section 级定位（合成节 position=0）
    const hit = hits.find((h) => h.docPath === `tmp/${RUN}-search.json`);
    expect(hit?.position).toBe(0);
  }, 60000);

  // ─── ④ 通用 PUT /docs + 非法 IR → 422 + diagnostics 结构 ────

  it('通用 upsert（docType=diagram）+ 非法 IR → 422 DIAGRAM_VALIDATION_FAILED，diagnostics 结构齐全', async () => {
    if (!dbAvailable) return;
    const badIr = {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: 'bad' },
      components: [{ id: 'x', type: 'backend', label: 123, pos: [0, 0] }],
      connections: [],
    };
    try {
      await docService.upsert(
        spaceId,
        { path: `tmp/${RUN}-bad.json`, content: JSON.stringify(badIr), docType: 'diagram' },
        testActor,
      );
      fail('should have thrown');
    } catch (err) {
      const res = (
        err as {
          getResponse: () => {
            code: number;
            data: { stage: string; diagnostics: Record<string, unknown>[] };
          };
        }
      ).getResponse();
      expect(res.code).toBe(ErrorCode.DIAGRAM_VALIDATION_FAILED);
      expect(res.data.stage).toBe('schema');
      const diag = res.data.diagnostics[0];
      // 修复凭据结构断言（code/subject/supportedFixes 键在，plan §6.2 ④）
      expect(diag.code).toBe('schema/type');
      expect(diag.subject).toMatchObject({ diagramType: 'architecture' });
      expect(Array.isArray(diag.supportedFixes)).toBe(true);
      expect((diag.supportedFixes as string[])[0]).toContain('string');
    }
    // fail-closed：不落库
    const row = await ds
      .getRepository(Doc)
      .createQueryBuilder('d')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.path = :p', { p: `tmp/${RUN}-bad.json` })
      .getOne();
    expect(row).toBeNull();
  }, 60000);

  it('R3：meta.repository 在真实管线被平台前置拒绝（422，诊断指路移除字段，不走 --repo-root 误导）', async () => {
    if (!dbAvailable) return;
    const withRepo = {
      ...loadFixture('architecture'),
      meta: {
        title: 'repo evidence',
        repository: { url: 'https://github.com/foo/bar', revision: 'a'.repeat(40) },
      },
    };
    try {
      await diagramService.upsertDiagram(
        spaceId,
        { path: `tmp/${RUN}-repo.json`, ir: withRepo },
        testActor,
      );
      fail('should have thrown');
    } catch (err) {
      const res = (
        err as {
          getResponse: () => {
            code: number;
            data: {
              stage: string;
              diagnostics: { code: string; message: string; supportedFixes?: string[] }[];
            };
          };
        }
      ).getResponse();
      expect(res.code).toBe(ErrorCode.DIAGRAM_VALIDATION_FAILED);
      expect(res.data.stage).toBe('schema');
      expect(res.data.diagnostics[0].code).toBe('platform/repository-evidence-unsupported');
      expect(res.data.diagnostics[0].message).toContain('平台渲染环境不支持仓库证据');
      expect(res.data.diagnostics[0].supportedFixes?.[0]).toContain('remove');
    }
  }, 60000);

  // ─── ⑤ patch_diagram 四态 ─────────────────────────────────

  it('patch 四态：无 hash 400 / stale hash 409 / 坏 pointer 422 / 合法 200（htmlSha256 变 + 版本 source=patch）', async () => {
    if (!dbAvailable) return;
    const created = await upsertDiagram('workflow', `tmp/${RUN}-patch.json`);
    const detailBefore = await diagramService.readDiagram(created.id);

    // 态 1：无 expectedContentHash → 400 VALIDATION_ERROR
    await expect(
      diagramService.patchDiagram(
        created.id,
        { patches: [{ op: 'replace', path: '/meta/title', value: 'x' }], expectedContentHash: '' },
        testActor,
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCode.VALIDATION_ERROR } });

    // 态 2：stale hash → 409 DOC_CONTENT_CONFLICT
    await expect(
      diagramService.patchDiagram(
        created.id,
        {
          patches: [{ op: 'replace', path: '/meta/title', value: 'x' }],
          expectedContentHash: '0'.repeat(64),
        },
        testActor,
      ),
    ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_CONTENT_CONFLICT } });

    // 态 3：坏 pointer → 422 DIAGRAM_PATCH_FAILED 带 pointer/reason
    await expect(
      diagramService.patchDiagram(
        created.id,
        {
          patches: [{ op: 'replace', path: '/nodes/99/label', value: 'x' }],
          expectedContentHash: detailBefore.contentHash as string,
        },
        testActor,
      ),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.DIAGRAM_PATCH_FAILED,
        data: { pointer: '/nodes/99/label', supportedOps: ['replace', 'add', 'remove'] },
      },
    });

    // 态 4：合法 replace label → 200，htmlSha256 变化，版本行 source='patch'
    const patched = await diagramService.patchDiagram(
      created.id,
      {
        patches: [{ op: 'replace', path: '/meta/title', value: `Patched Title ${RUN}` }],
        expectedContentHash: detailBefore.contentHash as string,
      },
      testActor,
    );
    expect(patched.appliedPatches).toBe(1);
    expect(patched.contentHash).not.toBe(detailBefore.contentHash);
    expect(patched.render?.htmlSha256).not.toBe(detailBefore.render.htmlSha256);

    const detailAfter = await diagramService.readDiagram(created.id);
    expect((detailAfter.ir as { meta: { title: string } }).meta.title).toBe(`Patched Title ${RUN}`);

    const versions = await ds
      .getRepository(DocVersion)
      .find({ where: { docId: created.id }, order: { version: 'ASC' } });
    expect(versions).toHaveLength(2);
    expect(versions[1].source).toBe('patch');
    expect(versions[1].contentHash).toBe(patched.contentHash);
  }, 120000);

  // ─── ⑥ validate dry-run 零副作用 ───────────────────────────

  it('validate：ok=false 诊断齐全 + 零副作用（doc 行/版本计数/contentHash 不变）', async () => {
    if (!dbAvailable) return;
    const created = await upsertDiagram('dataflow', `tmp/${RUN}-validate.json`);
    const rowBefore = await readDocRow(created.id);
    const versionCountBefore = await ds
      .getRepository(DocVersion)
      .count({ where: { docId: created.id } });

    // (a) 裸 IR 非法 → ok:false（schema 诊断）
    const bad = await diagramService.validateDiagram(spaceId, {
      ir: { schema_version: 1, diagram_type: 'dataflow', meta: { title: 1 }, nodes: [] },
    });
    expect(bad.ok).toBe(false);
    expect(bad.stage).toBe('schema');
    expect(bad.diagnostics.length).toBeGreaterThan(0);
    expect(bad.diagnostics[0].code).toMatch(/^schema\//);

    // (b) 对存量 doc 模拟合法 patch → ok:true
    const ok = await diagramService.validateDiagram(spaceId, {
      docId: created.id,
      patches: [{ op: 'replace', path: '/meta/title', value: 'Dry Run Title' }],
    });
    expect(ok.ok).toBe(true);
    expect(ok.composition).toBeDefined();
    expect(ok.profile).toBeTruthy();

    // 零副作用断言
    const rowAfter = await readDocRow(created.id);
    const versionCountAfter = await ds
      .getRepository(DocVersion)
      .count({ where: { docId: created.id } });
    expect(rowAfter?.contentHash).toBe(rowBefore?.contentHash);
    expect(rowAfter?.updatedAt?.getTime()).toBe(rowBefore?.updatedAt?.getTime());
    expect(versionCountAfter).toBe(versionCountBefore);
  }, 120000);

  // ─── ⑦ bundle round-trip ──────────────────────────────────

  it('bundle round-trip：export → 删 → import，重校验重渲染成功且 content 与导出一致', async () => {
    if (!dbAvailable) return;
    const fixture = loadFixture('architecture');
    const canonical = JSON.stringify(fixture, null, 2);
    const created = await upsertDiagram('architecture', `tmp/${RUN}-bundle.json`);
    const detailBefore = await diagramService.readDiagram(created.id);

    const bundle = await bundleService.exportBundle(spaceId);
    const bundleDoc = bundle.docs.find((d) => d.path === `tmp/${RUN}-bundle.json`);
    expect(bundleDoc).toBeDefined();
    expect(bundleDoc?.docType).toBe('diagram');
    // 导出 content = 规范化 IR（派生字段 rendered_html/render_meta 不导出）
    expect(bundleDoc?.content).toBe(canonical);
    expect(JSON.stringify(bundleDoc)).not.toContain('renderedHtml');

    // 删（软删→硬删清干净，模拟丢失后从 bundle 恢复）
    await ds.getRepository(DocVersion).delete({ docId: created.id });
    await ds.getRepository(DocSection).delete({ docId: created.id });
    await ds.getRepository(Doc).delete({ id: created.id });

    // 回导：重校验重渲染（batchUpsert → upsert → diagram 分支）
    const result = await bundleService.importBundle(spaceId, bundle as never, testActor);
    const imported = result.docs.results.find((r) => r.path === `tmp/${RUN}-bundle.json`);
    expect(imported?.status).toBe('created');

    const reimported = await ds
      .getRepository(Doc)
      .createQueryBuilder('d')
      .where('d.space_id = :spaceId', { spaceId })
      .andWhere('d.path = :p', { p: `tmp/${RUN}-bundle.json` })
      .getOne();
    expect(reimported).toBeTruthy();
    createdDocIds.push(reimported!.id);
    const detailAfter = await diagramService.readDiagram(reimported!.id);
    expect(JSON.stringify(detailAfter.ir, null, 2)).toBe(canonical);
    // 确定性编译：同 IR → 同 HTML sha256
    expect(detailAfter.render.htmlSha256).toBe(detailBefore.render.htmlSha256);
  }, 120000);

  // ─── ⑧ 权限 + 软删 ────────────────────────────────────────

  it('非成员 write 权限拒绝（403 ForbiddenException）；软删后 readDiagram 404', async () => {
    if (!dbAvailable) return;
    const created = await upsertDiagram('lifecycle', `tmp/${RUN}-perm.json`);

    // 权限：outsider（agent，非成员非创建者）对该空间 write → ensureCan 抛 403
    // （HTTP 403 ForbiddenException，业务码 PERMISSION_DENIED；controller 的确切调用链：
    // findById → ensureCan(space, actor, 'write')）
    const space = await ds.getRepository(DocSpace).findOne({ where: { id: spaceId } });
    try {
      await permissionService.ensureCan(space!, outsiderActor, 'write');
      fail('should have thrown');
    } catch (err) {
      expect((err as { getStatus: () => number }).getStatus()).toBe(403);
      expect((err as { getResponse: () => { code: number } }).getResponse().code).toBe(
        ErrorCode.PERMISSION_DENIED,
      );
    }
    // 创建者本人 write → 放行（对照）
    await expect(
      permissionService.ensureCan(space!, { id: spaceCreator, type: ActorType.HUMAN }, 'write'),
    ).resolves.toBeUndefined();

    // 软删 → 读 404（findById fail-closed）
    await docService.remove(created.id, 'native', testActor);
    await expect(diagramService.readDiagram(created.id)).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
    await expect(diagramService.getDiagramHtml(created.id)).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
  }, 60000);

  // ─── ⑨ 回归说明：既有 docspace 全部 e2e 套件不动（本仓 test:e2e 全量运行即覆盖）──
});
