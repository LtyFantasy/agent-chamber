/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (GET /doc-spaces/:id/docs/tree|facets)
 *   - 补充: plan docspace-lazy-tree-v1.md（v1.70.0-dev）——「SQL 形态硬约束」节
 *     （WHERE 只用 LIKE、substring/split_part 只进 SELECT/GROUP BY、plen JS 算好
 *     整数传入、folders total 子查询 COUNT、docs total getManyAndCount 双查）
 *   - 补充: 铁律 #23 教训（RT-SEAT-1）——LIKE 前缀扫描 + split_part 分组是 ORM
 *     SQL 生成路径，mock 单测测不出，必须有打真实 PG 的集成覆盖
 *
 * [踩坑索引]
 *   - off-by-one（plan A2）：substring(d.path from :plen) 的 plen 是 PG 1-based，
 *     归一化 prefix 含尾 / 时 plen = prefix.length + 1；本套件多级前缀用例
 *     （b/deep/）显式覆盖
 *   - LIKE 元字符：prefix 中的 % _ \ 必须逐字符转义（ESCAPE '\'），否则 x%y 会
 *     误命中 x_y 等目录；本套件三组特殊目录交叉验证
 *   - 根层语义：prefix='' 时直挂文档 = path 不含 '/' 的文档；带目录段的 path
 *     （如 <RUN>/root1.md）首段是目录，不属于根层直挂——种子数据因此不带 RUN
 *     前缀（space_id 隔离，无跨空间冲突）
 *
 * [铁律关联] #17(测试契约) #23(jsonb/ORM 集成覆盖) #8(测试绑定)
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 * =============================================================================
 */

/**
 * findTree / findFacets —— 真实 PG 集成套件（v1.70.0-dev 懒加载目录树）
 *
 * 与 docspace.e2e-spec.ts（全 mock）的分工：本套件打真实 PostgreSQL，直接实例化
 * DocService（真 TypeORM repo），验证 LIKE 前缀扫描 + split_part 分组 + 聚合计数
 * 的 ORM SQL 生成与真实数据一致性——mock 单测只能验证拼接逻辑，测不出 SQL 形态
 * 与 off-by-one（铁律 #23 教训）。
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据在独立空间内（space_id 隔离），afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { IdempotencyRecord } from '../src/database/entities/idempotency-record.entity';
import { DocService } from '../src/modules/docspace/doc.service';
import { DiagramRendererService } from '../src/modules/docspace/diagram-renderer.service';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { DocVersion } from '../src/database/entities/doc-version.entity';
import { DocCategory } from '../src/database/entities/doc-category.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Board } from '../src/database/entities/board.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import type { EventService } from '../src/modules/event/event.service';
import type { RouteHealthService } from '../src/modules/docspace/route-health.service';

/** 本地开发库连接（docker-compose 默认值；env 覆盖便于换环境跑） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本次运行的唯一后缀：隔离测试数据，防与开发库真实文档互相污染 */
const RUN = `tree-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，upsert 缺省 'system' 字面量会被 PG 拒绝） */
const testActor = { id: '00000000-0000-4000-8000-0000000000bb', type: ActorType.HUMAN };

describe('DocService.findTree/findFacets — 真实 PG 集成（懒加载目录树）', () => {
  let ds: DataSource;
  let service: DocService;
  let dbAvailable = false;

  let spaceId: string;
  let emptySpaceId: string;

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
      console.warn(`[docspace-tree e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // EventService / RouteHealthService 打桩：本套件只测目录树/聚合查询，
    // 事件/路由重检的行为由各自单测覆盖
    const eventStub = { create: jest.fn().mockResolvedValue({}) } as unknown as EventService;
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
      // Diagram IR v1：本套件不触发 diagram 分支，桩件仅防构造参数缺失
      { validateAndRender: jest.fn() } as unknown as DiagramRendererService,
    );

    // ── 种子：主空间（3 层目录 12 篇 + 转义目录 3 篇）+ 空空间 ──
    // path 不带 RUN 前缀：根层直挂文档 = path 不含 '/' 的文档（根层语义），
    // 带目录段的 path 首段是目录；隔离靠独立 space_id（docs unique 是
    // (space_id, path)，doc_categories 无全局 slug 约束，均无跨空间冲突）
    const spaceRepo = ds.getRepository(DocSpace);
    const space = await spaceRepo.save(
      spaceRepo.create({
        name: `Tree E2E ${RUN}`,
        slug: `tree-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceId = space.id;
    const emptySpace = await spaceRepo.save(
      spaceRepo.create({
        name: `Tree Empty ${RUN}`,
        slug: `tree-empty-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    emptySpaceId = emptySpace.id;

    const upsertDoc = async (
      path: string,
      content: string,
      extra: Record<string, unknown> = {},
    ) => {
      const r = await service.upsert(spaceId, { path, content, ...extra }, testActor);
      return r.id;
    };

    // 3 层目录 12 篇：a=4 guide/diary（Cat One）、b=3 memory/diary+daily、
    // c=2 note/daily（Cat Two，随后软删分类）、root=3 guide（根层直挂）。
    for (let i = 1; i <= 4; i++) {
      await upsertDoc(`a/a${i}.md`, `# A${i}`, {
        docType: 'guide',
        tags: ['diary'],
        category: 'Cat One',
      });
    }
    await upsertDoc('b/b1.md', '# B1', { docType: 'memory', tags: ['diary', 'daily'] });
    await upsertDoc('b/b2.md', '# B2', { docType: 'memory', tags: ['diary', 'daily'] });
    await upsertDoc('c/c1.md', '# C1', { docType: 'note', tags: ['daily'], category: 'Cat Two' });
    await upsertDoc('c/c2.md', '# C2', { docType: 'note', tags: ['daily'], category: 'Cat Two' });
    await upsertDoc('b/deep/bd1.md', '# BD1', { docType: 'memory', tags: ['diary'] });
    await upsertDoc('root1.md', '# R1', { docType: 'guide' });
    await upsertDoc('root2.md', '# R2', { docType: 'guide' });
    await upsertDoc('root3.md', '# R3', { docType: 'guide' });

    // LIKE 元字符目录：x%y / x_y / x\y（转义交叉验证用）
    await upsertDoc('x%y/z1.md', '# Z1');
    await upsertDoc('x_y/w1.md', '# W1');
    await upsertDoc('x\\y/v1.md', '# V1');

    // 软删分类 Cat Two（c 目录文档 categoryId 指向它 → facets 不计入）
    const catRepo = ds.getRepository(DocCategory);
    const catTwo = await catRepo.findOneBy({ spaceId, name: 'Cat Two' });
    if (catTwo) {
      await catRepo.softDelete({ id: catTwo.id });
    }

    // 固定 updated_at（sort=recent 确定性）：逐篇精确 path 匹配（避免原生 SQL
    // LIKE 里 % _ \ 的转义陷阱）：
    // a=2026-01-01、b=2026-03-01、c=2026-02-01、x%y=04-01、x_y=04-02、x\y=04-03
    const setUpdatedAt = async (path: string, ts: string) => {
      await ds.query(`UPDATE docs SET updated_at = $1 WHERE space_id = $2 AND path = $3`, [
        ts,
        spaceId,
        path,
      ]);
    };
    for (let i = 1; i <= 4; i++) await setUpdatedAt(`a/a${i}.md`, '2026-01-01T00:00:00Z');
    await setUpdatedAt('b/b1.md', '2026-03-01T00:00:00Z');
    await setUpdatedAt('b/b2.md', '2026-03-01T00:00:00Z');
    await setUpdatedAt('b/deep/bd1.md', '2026-03-01T00:00:00Z');
    await setUpdatedAt('c/c1.md', '2026-02-01T00:00:00Z');
    await setUpdatedAt('c/c2.md', '2026-02-01T00:00:00Z');
    await setUpdatedAt('x%y/z1.md', '2026-04-01T00:00:00Z');
    await setUpdatedAt('x_y/w1.md', '2026-04-02T00:00:00Z');
    await setUpdatedAt('x\\y/v1.md', '2026-04-03T00:00:00Z');
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;

    // 硬删兜底清理（sections 走 CASCADE，显式删更直白）
    for (const sid of [spaceId, emptySpaceId]) {
      if (!sid) continue;
      const docs = await ds.getRepository(Doc).find({ where: { spaceId: sid } });
      for (const d of docs) {
        await ds.getRepository(DocSection).delete({ docId: d.id });
        await ds.getRepository(Doc).delete({ id: d.id });
      }
      await ds.getRepository(DocCategory).delete({ spaceId: sid });
      await ds.getRepository(DocSpace).delete({ id: sid });
    }
    // upsert/remove 写 audit_logs（actorId = testActor.id）——必须同步清理，否则
    // 08-29 残留行会挤占 activity-logs 套件 admin 全量查询的 20 条窗口（createdAt
    // DESC）导致其 row-B/row-D/row-E（08-28 显式时间戳）被挤出分页（实测 429 行
    // 污染）。按 actorId 删（本套件专用哨兵 actor），覆盖软删文档（a5）的 audit 行
    // ——按 entityId 删会漏掉 find 默认排除的软删文档
    await ds.getRepository(AuditLog).delete({ actorId: testActor.id });
    await ds.destroy();
  });

  // ─── 根层 / 分层浏览 ────────────────────────────────────────

  it('根层（prefix=""）：folders=[a,b,c,x%y,x_y,x\\y] docs=[root1..3]，计数与 total/hasMore 正确', async () => {
    if (!dbAvailable) return;

    const tree = await service.findTree(spaceId, {});

    expect(tree.prefix).toBe('');
    // folders：6 个直接子目录，递归 docCount 正确
    expect(tree.folders.total).toBe(6);
    expect(tree.folders.hasMore).toBe(false);
    const byName = Object.fromEntries(tree.folders.items.map((f) => [f.name, f]));
    expect(byName['a']).toMatchObject({ path: 'a/', docCount: 4 });
    expect(byName['b']).toMatchObject({ path: 'b/', docCount: 3 });
    expect(byName['c']).toMatchObject({ path: 'c/', docCount: 2 });
    expect(byName['x%y']).toMatchObject({ path: 'x%y/', docCount: 1 });
    expect(byName['x_y']).toMatchObject({ path: 'x_y/', docCount: 1 });
    expect(byName['x\\y']).toMatchObject({ path: 'x\\y/', docCount: 1 });
    for (const f of tree.folders.items) {
      expect(f.latestDocAt).toBeTruthy();
    }
    // docs：3 篇根层直挂文档（path 不含 '/'）
    expect(tree.docs.total).toBe(3);
    expect(tree.docs.hasMore).toBe(false);
    expect(tree.docs.items.map((d) => d.path).sort()).toEqual(
      ['root1.md', 'root2.md', 'root3.md'].sort(),
    );
    expect(tree.docs.items[0]).toHaveProperty('id');
    expect(tree.docs.items[0]).toHaveProperty('title');
    expect(tree.docs.items[0]).toHaveProperty('docType', 'guide');
  });

  it('prefix 归一化：无尾 / 的 "a" 与 "a/" 结果一致（回显补 /）', async () => {
    if (!dbAvailable) return;

    const withSlash = await service.findTree(spaceId, { prefix: 'a/' });
    const withoutSlash = await service.findTree(spaceId, { prefix: 'a' });

    expect(withoutSlash.prefix).toBe('a/');
    expect(withoutSlash.folders.total).toBe(withSlash.folders.total);
    expect(withoutSlash.docs.total).toBe(withSlash.docs.total);
    expect(withoutSlash.docs.items.map((d) => d.path).sort()).toEqual(
      withSlash.docs.items.map((d) => d.path).sort(),
    );
  });

  it('多级前缀（off-by-one）："b/" 只含 b 层，deep 是子目录', async () => {
    if (!dbAvailable) return;

    const tree = await service.findTree(spaceId, { prefix: 'b/' });

    expect(tree.prefix).toBe('b/');
    expect(tree.folders.total).toBe(1);
    expect(tree.folders.items[0]).toMatchObject({ path: 'b/deep/', name: 'deep', docCount: 1 });
    expect(tree.docs.total).toBe(2);
    expect(tree.docs.items.map((d) => d.path).sort()).toEqual(['b/b1.md', 'b/b2.md'].sort());
  });

  it('多级前缀（off-by-one）："b/deep/" 只返回 bd1（plen 跳过两层）', async () => {
    if (!dbAvailable) return;

    const tree = await service.findTree(spaceId, { prefix: 'b/deep/' });

    expect(tree.folders.total).toBe(0);
    expect(tree.docs.total).toBe(1);
    expect(tree.docs.items[0].path).toBe('b/deep/bd1.md');
  });

  it('LIKE 元字符转义：x%y / x_y / x\\y 三目录互不误命中', async () => {
    if (!dbAvailable) return;

    // 转义验证语义：prefix 进入目录内部，只命中该目录的直挂文档——
    // 未转义时 'x%y/' 的 LIKE 模式 'x%y/%' 会误命中 x_y/w1.md 与 x\y/v1.md
    // （% 匹配任意串）；转义后只命中字面 x%y 目录
    const pct = await service.findTree(spaceId, { prefix: 'x%y/' });
    expect(pct.folders.total).toBe(0);
    expect(pct.docs.total).toBe(1);
    expect(pct.docs.items.map((d) => d.path)).toEqual(['x%y/z1.md']);

    // _ 未转义会匹配任意单字符——转义后只命中字面 x_y
    const under = await service.findTree(spaceId, { prefix: 'x_y/' });
    expect(under.folders.total).toBe(0);
    expect(under.docs.total).toBe(1);
    expect(under.docs.items.map((d) => d.path)).toEqual(['x_y/w1.md']);

    // \ 未转义会吞掉后续元字符——转义后只命中字面 x\y
    const back = await service.findTree(spaceId, { prefix: 'x\\y/' });
    expect(back.folders.total).toBe(0);
    expect(back.docs.total).toBe(1);
    expect(back.docs.items.map((d) => d.path)).toEqual(['x\\y/v1.md']);
  });

  it('空空间：folders/docs 全空，total=0 hasMore=false', async () => {
    if (!dbAvailable) return;

    const tree = await service.findTree(emptySpaceId, {});
    expect(tree.prefix).toBe('');
    expect(tree.folders).toEqual({ items: [], total: 0, hasMore: false });
    expect(tree.docs).toEqual({ items: [], total: 0, hasMore: false });
  });

  // ─── 排序 ──────────────────────────────────────────────────

  it('sort=name：目录按段名 ASC（a, b, c, x%y, x\\y, x_y）', async () => {
    if (!dbAvailable) return;

    const tree = await service.findTree(spaceId, { sort: 'name' });
    // ASCII：'%'(0x25) < '\\'(0x5C) < '_'(0x5F)
    expect(tree.folders.items.map((f) => f.name)).toEqual(['a', 'b', 'c', 'x%y', 'x\\y', 'x_y']);
  });

  it('sort=recent（默认）：目录按 latestDocAt DESC（x\\y=04-03, x_y=04-02, x%y=04-01, b=03月, c=02月, a=01月）', async () => {
    if (!dbAvailable) return;

    const tree = await service.findTree(spaceId, {});
    expect(tree.folders.items.map((f) => f.name)).toEqual(['x\\y', 'x_y', 'x%y', 'b', 'c', 'a']);
  });

  // ─── 分页 ──────────────────────────────────────────────────

  it('folders 分页：foldersLimit=2 → items=2 total=6 hasMore=true；offset 翻页后 hasMore=false', async () => {
    if (!dbAvailable) return;

    const page1 = await service.findTree(spaceId, { foldersLimit: 2, sort: 'name' });
    expect(page1.folders.items).toHaveLength(2);
    expect(page1.folders.total).toBe(6);
    expect(page1.folders.hasMore).toBe(true);

    const page2 = await service.findTree(spaceId, {
      foldersLimit: 2,
      foldersOffset: 2,
      sort: 'name',
    });
    expect(page2.folders.items).toHaveLength(2);
    expect(page2.folders.total).toBe(6);
    expect(page2.folders.hasMore).toBe(true);

    const page3 = await service.findTree(spaceId, {
      foldersLimit: 2,
      foldersOffset: 4,
      sort: 'name',
    });
    expect(page3.folders.items).toHaveLength(2);
    expect(page3.folders.total).toBe(6);
    expect(page3.folders.hasMore).toBe(false);
  });

  it('docs 分页：docsLimit=2 → items=2 total=4 hasMore=true；offset 翻页后 hasMore=false', async () => {
    if (!dbAvailable) return;

    const page1 = await service.findTree(spaceId, { prefix: 'a/', docsLimit: 2 });
    expect(page1.docs.items).toHaveLength(2);
    expect(page1.docs.total).toBe(4);
    expect(page1.docs.hasMore).toBe(true);

    const page2 = await service.findTree(spaceId, { prefix: 'a/', docsLimit: 2, docsOffset: 2 });
    expect(page2.docs.items).toHaveLength(2);
    expect(page2.docs.total).toBe(4);
    expect(page2.docs.hasMore).toBe(false);
  });

  // ─── facets 聚合 ───────────────────────────────────────────

  it('facets：types/tags/categories 三组聚合计数正确（软删分类不计入）', async () => {
    if (!dbAvailable) return;

    const facets = await service.findFacets(spaceId);

    // types：guide=7（a4+root3）、memory=3（b3）、note=2（c2），count DESC
    expect(facets.types).toEqual([
      { value: 'guide', count: 7 },
      { value: 'memory', count: 3 },
      { value: 'note', count: 2 },
    ]);
    // tags：diary=7（a4+b3+bd1）、daily=4（b1+b2+c1+c2），count DESC
    expect(facets.tags).toEqual([
      { value: 'diary', count: 7 },
      { value: 'daily', count: 4 },
    ]);
    // categories：Cat One=4；Cat Two 已软删 → 不计入
    expect(facets.categories).toEqual([{ slug: 'cat-one', name: 'Cat One', count: 4 }]);
  });

  it('facets 空空间：三组全空', async () => {
    if (!dbAvailable) return;

    const facets = await service.findFacets(emptySpaceId);
    expect(facets).toEqual({ types: [], tags: [], categories: [] });
  });

  // ⚠️ 本用例必须位于套件末尾：remove 后 setImmediate 触发 recalcSpaceLinkHealth，
  // 批量刷新同空间全部文档的 updated_at（实测）——若放在 sort=recent 之前会破坏
  // 其确定性（a 目录 latestDocAt 被刷成当前时间）。后续新增用例请放在本用例之前。
  it('软删文档不进计数（docs total 与 folders docCount 同步回落）', async () => {
    if (!dbAvailable) return;

    const a5 = await service.upsert(spaceId, { path: 'a/a5.md', content: '# A5' }, testActor);
    const before = await service.findTree(spaceId, { prefix: 'a/' });
    expect(before.docs.total).toBe(5);
    // a 目录 docCount 在根层 folders 上断言（prefix='a/' 时 folders 为空——无子目录）
    const rootBefore = await service.findTree(spaceId, {});
    expect(rootBefore.folders.items.find((f) => f.name === 'a')?.docCount).toBe(5);

    await service.remove(a5.id, 'native', testActor);
    const after = await service.findTree(spaceId, { prefix: 'a/' });
    expect(after.docs.total).toBe(4);
    const rootAfter = await service.findTree(spaceId, {});
    expect(rootAfter.folders.items.find((f) => f.name === 'a')?.docCount).toBe(4);
  });
});
