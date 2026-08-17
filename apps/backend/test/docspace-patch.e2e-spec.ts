/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/api-definition.md §16 (PATCH /docs/:id/sections/:position)
 *   - 补充: 铁律 #23 教训（RT-SEAT-1）——section 重建管线涉及 ORM SQL 生成 +
 *     chunk/reconstruct 互逆，mock 单测测不出，必须有打真实 PG 的集成覆盖
 *
 * [踩坑索引]
 *   - Hument 事故（topic msg 6dbc4da3）：stale position fail-open → fail-closed
 *     （2026-08-16）：本套件新增 Hument 场景复现（长节 chunk 漂移后旧 position +
 *     错 hash → 409 写不进去）、match 模式端到端、stale expectedContentHash → 409
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
 * patch_doc section 级写 —— 真实 PG 集成套件（v1.55 任务 T3）
 *
 * 与 docspace.e2e-spec.ts（全 mock）的分工：本套件打真实 PostgreSQL，直接实例化
 * DocService（真 TypeORM repo + 真 chunker/重建管线），验证 section 替换后
 * outline/position/contentHash/tokenEstimate/linkHealth 派生数据一致性——
 * mock 单测只能验证拼接逻辑，测不出 ORM SQL 生成与 chunk 往返（铁律 #23 教训）。
 *
 * DB 目标 = 本地开发库 chamber-postgres（docker-compose 默认参数，env 可覆盖）。
 * PG 不可达时整套降级跳过（warn 提示）——保持 test:e2e 在无库环境仍可全绿。
 * 所有测试数据带 RUN 后缀隔离，afterAll 硬删兜底清理。
 */
import { DataSource } from 'typeorm';
import { ActorType, ErrorCode } from '@agent-chamber/shared';
import * as entities from '../src/database/entities';
import { DocService } from '../src/modules/docspace/doc.service';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSection } from '../src/database/entities/doc-section.entity';
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
const RUN = `patch-e2e-${Date.now()}`;

/** 固定测试 actor（docs.created_by 为 uuid 列，upsert 缺省 'system' 字面量会被 PG 拒绝） */
const testActor = { id: '00000000-0000-4000-8000-0000000000aa', type: ActorType.HUMAN };

describe('DocService.patchSection — 真实 PG 集成（section 重建管线）', () => {
  let ds: DataSource;
  let service: DocService;
  let dbAvailable = false;

  let spaceId: string;
  let docA: Doc; // 多节文档（happy / 越界 / 往返）
  let docB: Doc; // 结构变更 position 漂移演示
  let docC: Doc; // 空 content 删节
  let docD: Doc; // linkHealth 被链目标
  let docE: Doc; // 长节文档（Hument 场景复现：chunk 漂移 + stale hash）
  let docF: Doc; // 字节一致性文档（首 H1==title + 长节 + 空分组，v1.57.1 MATCH 面字节一致性验收）
  let docG: Doc; // 同名 sibling 标题文档（v1.57.3 run-dedup 回归）

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
      console.warn(`[docspace-patch e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    dbAvailable = true;

    // EventService / RouteHealthService 打桩：本套件只测 section 重建管线，
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
      eventStub,
      routeHealthStub,
    );

    // ── 种子数据：一个空间 + 四个文档（路径带 RUN 后缀隔离）──
    const spaceRepo = ds.getRepository(DocSpace);
    const space = await spaceRepo.save(
      spaceRepo.create({
        name: `Patch E2E ${RUN}`,
        slug: `patch-e2e-${RUN}`.slice(0, 128),
        description: null,
        creatorId: '00000000-0000-4000-8000-0000000000ee',
        settings: {},
      }),
    );
    spaceId = space.id;

    const upsertDoc = async (path: string, content: string) => {
      const r = await service.upsert(spaceId, { path, content }, testActor);
      return service.findById(r.id);
    };

    docA = await upsertDoc(
      `tmp/${RUN}-a.md`,
      `# 集成测试文档 A\n\n引言段落。\n\n## 第一节\n\n第一节正文。\n\n## 第二节\n\n第二节正文。`,
    );
    docB = await upsertDoc(`tmp/${RUN}-b.md`, `# 文档 B\n\n## 目标节\n\n旧正文。`);
    docC = await upsertDoc(
      `tmp/${RUN}-c.md`,
      `# 文档 C\n\n## 待删节\n\n将被删除。\n\n## 保留节\n\n保留。`,
    );
    docD = await upsertDoc(`tmp/${RUN}-d.md`, `# 文档 D\n\n被链目标。`);

    // docE：>4000 字符的长节（触发 chunker step 4 段落二次切分，兄弟 chunk 共用同一
    // headingPath）+ 尾部节——复现 Hument 事故的长节 chunk 结构（topic msg 6dbc4da3）
    const longBody = Array.from(
      { length: 60 },
      (_, i) => `段落 ${i}：` + '长节正文内容。'.repeat(10),
    ).join('\n\n');
    docE = await upsertDoc(
      `tmp/${RUN}-e.md`,
      `# 长节文档\n\n## 长节\n\n${longBody}\n\n## 尾部节\n\n尾部正文。`,
    );
  }, 30000);

  afterAll(async () => {
    if (!dbAvailable) return;

    // 硬删兜底清理（sections 走 CASCADE，显式删更直白）
    for (const doc of [docA, docB, docC, docD, docE, docF, docG]) {
      if (doc?.id) {
        await ds.getRepository(DocSection).delete({ docId: doc.id });
        await ds.getRepository(Doc).delete({ id: doc.id });
      }
    }
    if (spaceId) {
      await ds.getRepository(DocSpace).delete({ id: spaceId });
    }
    await ds.destroy();
  });

  it('happy：整节替换后 outline/position/派生数据全部一致', async () => {
    if (!dbAvailable) return;

    const beforeHash = docA.contentHash;
    const result = await service.patchSection(
      docA.id,
      1,
      '## 第一节\n\n全新第一节正文。',
      'native',
      testActor,
    );
    await flushImmediates();

    // upsert 管线返回值：sectionCount/tokenEstimate 已重算
    expect(result.id).toBe(docA.id);
    expect(result.sectionCount).toBe(3);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    expect(result.unchanged).toBeFalsy();

    // getSection 读侧对称：position 1 的正文已被替换
    const section = await service.getSection(docA.id, 1);
    expect(section.content).toBe('全新第一节正文。');
    expect(section.headingPath).toContain('第一节');

    // outline 一致性：sectionCount === outline 长度，position 严格 0..N-1
    const detail = await service.findOne(docA.id, 0);
    expect(detail.sections ?? []).toHaveLength(3);
    expect((detail.sections ?? []).map((s) => s.position)).toEqual([0, 1, 2]);
    expect(detail.sectionCount).toBe(3);

    // contentHash 变化（全文已变）+ 未触碰的节完好
    const freshDoc = await service.findById(docA.id);
    expect(freshDoc.contentHash).not.toBe(beforeHash);
    expect(freshDoc.tokenEstimate).toBeGreaterThan(0);
    const untouched = await service.getSection(docA.id, 2);
    expect(untouched.content).toBe('第二节正文。');

    // 全文保真重建（web full=true 通道）：新旧节都在，替换生效
    const full = await service.getContent(docA.id, true);
    expect(full.content).toContain('全新第一节正文。');
    expect(full.content).toContain('第二节正文。');
    expect(full.content).toContain('引言段落。');
  });

  it('幂等：以现存渲染片段原样 patch → unchanged:true（hash 短路）', async () => {
    if (!dbAvailable) return;

    // 读出现存节的渲染片段（标题行 + 正文，与 patch content 契约同形）
    const section = await service.getSection(docB.id, 1);
    const headingLine = '#'.repeat(Math.min(section.headingLevel, 6));
    const headingText = section.headingPath?.split(' § ').pop() ?? '';
    const rendered = `${headingLine} ${headingText}\n\n${section.content}`;

    const result = await service.patchSection(docB.id, 1, rendered, 'native', testActor);
    await flushImmediates();

    expect(result.unchanged).toBe(true);
    // sectionCount 不变（未重建）
    const fresh = await service.findById(docB.id);
    expect(fresh.sectionCount).toBe(2);
  });

  it('结构变更：新 content 引入新标题 → sectionCount 增长（position 漂移是调用方责任）', async () => {
    if (!dbAvailable) return;

    const result = await service.patchSection(
      docB.id,
      1,
      '## 目标节\n\n新正文。\n\n## 插入节\n\n插入的正文。',
      'native',
      testActor,
    );
    await flushImmediates();

    // re-chunk 后多出一节；后续节的 position 已漂移（调用方须重取 outline）
    expect(result.sectionCount).toBe(3);
    const detail = await service.findOne(docB.id, 0);
    expect(detail.sections ?? []).toHaveLength(3);
    expect((detail.sections ?? []).map((s) => s.position)).toEqual([0, 1, 2]);
    const inserted = await service.getSection(docB.id, 2);
    expect(inserted.content).toBe('插入的正文。');
  });

  it('空 content = 删除该节', async () => {
    if (!dbAvailable) return;

    const result = await service.patchSection(docC.id, 1, '', 'native', testActor);
    await flushImmediates();

    expect(result.sectionCount).toBe(2);
    const detail = await service.findOne(docC.id, 0);
    expect(detail.sections).toHaveLength(2);
    // 剩余节内容完好（待删节消失，保留节健在）
    const full = await service.getContent(docC.id, true);
    expect(full.content).not.toContain('将被删除。');
    expect(full.content).toContain('保留。');
  });

  it('linkHealth 一致：patch 引入的链接按空间候选重算（健康 + 断链两向）', async () => {
    if (!dbAvailable) return;

    // 健康链接：指向同空间 docD 的相对 .md 路径
    const healthyResult = await service.patchSection(
      docA.id,
      2,
      `## 第二节\n\n第二节正文，引用 [文档 D](./tmp/${RUN}-d.md)。`,
      'native',
      testActor,
    );
    await flushImmediates();
    expect(healthyResult.sectionCount).toBe(3);

    let fresh = await service.findById(docA.id);
    expect(fresh.linkHealth).not.toBeNull();
    expect((fresh.linkHealth as { total: number }).total).toBe(1);
    expect((fresh.linkHealth as { broken: string[] }).broken).toEqual([]);

    // 断链：不存在的 .md 路径 → broken 收录该 href
    await service.patchSection(
      docA.id,
      2,
      `## 第二节\n\n第二节正文，引用 [幽灵](./tmp/${RUN}-ghost.md)。`,
      'native',
      testActor,
    );
    await flushImmediates();

    fresh = await service.findById(docA.id);
    expect((fresh.linkHealth as { broken: string[] }).broken).toEqual([`./tmp/${RUN}-ghost.md`]);
  });

  it('position 越界 → 404 DOC_NOT_FOUND（业务存在性层）', async () => {
    if (!dbAvailable) return;

    await expect(service.patchSection(docA.id, 99, 'x', 'native', testActor)).rejects.toMatchObject(
      {
        response: { code: ErrorCode.DOC_NOT_FOUND },
      },
    );
    // 负数防御（Controller 层先行拦截，Service 直调兜底同款 code）
    await expect(service.patchSection(docA.id, -1, 'x', 'native', testActor)).rejects.toMatchObject(
      {
        response: { code: ErrorCode.DOC_NOT_FOUND },
      },
    );
  });

  it('文档不存在 → 404 DOC_NOT_FOUND（findById 判空，铁律 #22）', async () => {
    if (!dbAvailable) return;

    await expect(
      service.patchSection('00000000-0000-4000-8000-0000000000ff', 0, 'x', 'native', testActor),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
  });

  it('source 隔离：非 native 文档携带不匹配 source → 409 DOC_SOURCE_MISMATCH', async () => {
    if (!dbAvailable) return;

    // 造一个 source='git:test' 的文档（直接走 upsert 携带 source）
    const ingest = await service.upsert(
      spaceId,
      {
        path: `tmp/${RUN}-ingest.md`,
        content: '# Ingest\n\n同步文档。',
        source: 'git:test',
      },
      testActor,
    );
    await flushImmediates();

    try {
      // native 身份 patch ingest 文档 → upsert 隔离检查 409
      await expect(
        service.patchSection(ingest.id, 0, '# Ingest\n\n篡改。', 'native', testActor),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.DOC_SOURCE_MISMATCH },
      });

      // 匹配 source → 放行
      const ok = await service.patchSection(
        ingest.id,
        0,
        '# Ingest\n\n合法修改。',
        'git:test',
        testActor,
      );
      await flushImmediates();
      expect(ok.sectionCount).toBe(1);
    } finally {
      await ds.getRepository(DocSection).delete({ docId: ingest.id });
      await ds.getRepository(Doc).delete({ id: ingest.id });
    }
  });

  // ==================== v1.55 T4 读侧：getSections 批量 + headingQuery 模糊（真实 PG，铁律 #23） ====================
  // 批量/模糊定位的 ORM SQL 生成（IN 语义、ILIKE 转义、position ASC 排序）mock 单测测不出，
  // 本段打真实 PG 验证——与 patchSection 同款「ORM 集成覆盖」动机。

  it('getSections：批量读节去重 + position ASC + 越界进 missing（真实 PG 排序语义）', async () => {
    if (!dbAvailable) return;

    // docA 结构（前序用例链之后）：position 0=H1 引言、1=第一节、2=第二节
    const result = await service.getSections(docA.id, [2, 0, 2, 99]);

    expect(result.docId).toBe(docA.id);
    expect(result.docPath).toContain(RUN);
    // 重复 position 去重、结果按 position ASC（真实 SQL ORDER BY 而非 Node 侧排序）
    expect(result.sections.map((s) => s.position)).toEqual([0, 2]);
    expect(result.sections[0].content).toContain('引言');
    // 越界 position 不整体报错，单独列入 missing（部分失败友好契约）
    expect(result.missing).toEqual([99]);
  });

  it('getSections：文档不存在 → 404 DOC_NOT_FOUND（findById 判空，铁律 #22）', async () => {
    if (!dbAvailable) return;

    await expect(
      service.getSections('00000000-0000-4000-8000-0000000000ff', [0]),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
  });

  it('getSectionByHeadingQuery：唯一命中（ILIKE 子串匹配真实 SQL）', async () => {
    if (!dbAvailable) return;

    const section = await service.getSectionByHeadingQuery(docA.id, '第一节');

    expect(section.position).toBe(1);
    expect(section.headingPath).toContain('第一节');
    expect(section.content).toContain('第一节正文');
  });

  it('getSectionByHeadingQuery：多命中 → 409 RESOURCE_CONFLICT + candidates 按 position ASC（绝不静默挑选）', async () => {
    if (!dbAvailable) return;

    // '节' 子串命中「第一节」与「第二节」两个 headingPath → 歧义
    await expect(service.getSectionByHeadingQuery(docA.id, '节')).rejects.toMatchObject({
      response: {
        code: ErrorCode.RESOURCE_CONFLICT,
        data: {
          candidates: [
            { position: 1, headingPath: expect.stringContaining('第一节') as unknown as string },
            { position: 2, headingPath: expect.stringContaining('第二节') as unknown as string },
          ],
        },
      },
    });
  });

  it('getSectionByHeadingQuery：零命中 → 404 DOC_NOT_FOUND（提示走 outline 核对）', async () => {
    if (!dbAvailable) return;

    await expect(
      service.getSectionByHeadingQuery(docA.id, '不存在的标题xyz'),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
  });

  it('getSectionByHeadingQuery：LIKE 通配符 % 按字面量转义（不膨胀命中）', async () => {
    if (!dbAvailable) return;

    // 若 % 未转义：pattern %%% 会匹配所有非空 headingPath → 409 膨胀；转义后匹配
    // 字面 % → 0 命中 → 404。404 即证明转义生效（真实 PG ILIKE 语义）
    await expect(service.getSectionByHeadingQuery(docA.id, '%')).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_NOT_FOUND },
    });
  });

  // ==================== fail-closed 改造（Hument 事故 6dbc4da3）：match 模式 + 前提校验（真实 PG，铁律 #23） ====================
  // sectionHash 派生比对、match 计数 SQL 往返、事务内 FOR UPDATE 复核均为 ORM/真实数据行为，
  // mock 单测测不出，必须打真实 PG。

  it('读通道三态都带 sectionHash（真实 PG 派生可复算）', async () => {
    if (!dbAvailable) return;

    const single = await service.getSection(docD.id, 0);
    expect(single.sectionHash).toMatch(/^[0-9a-f]{64}$/);

    const batch = await service.getSections(docD.id, [0]);
    expect(batch.sections[0].sectionHash).toBe(single.sectionHash);

    const fuzzy = await service.getSectionByHeadingQuery(docD.id, '文档 D');
    expect(fuzzy.sectionHash).toBe(single.sectionHash);
  });

  it('match 模式端到端：唯一命中替换生效，响应 contentHash 与落库一致', async () => {
    if (!dbAvailable) return;

    const result = await service.patchByMatch(
      docD.id,
      '被链目标。',
      '被链目标已更新。',
      'native',
      testActor,
    );
    await flushImmediates();

    expect(result.id).toBe(docD.id);
    expect(result.unchanged).toBeFalsy();

    const full = await service.getContent(docD.id, true);
    expect(full.content).toContain('被链目标已更新。');

    // 写响应携带的 contentHash = 落库后的真实 contentHash（链式写免重读契约）
    const fresh = await service.findById(docD.id);
    expect(result.contentHash).toBe(fresh.contentHash);
  });

  it('match 模式：0 命中 → 404 / 多命中 → 409 + matchCount（真实全文计数）', async () => {
    if (!dbAvailable) return;

    const r = await service.upsert(
      spaceId,
      {
        path: `tmp/${RUN}-match.md`,
        content: '# 匹配文档\n\n重复词 alpha 出现。\n\n## 二节\n\nalpha 再来一次。',
      },
      testActor,
    );
    await flushImmediates();

    try {
      // 0 命中 → 404
      await expect(
        service.patchByMatch(r.id, '不存在的字符串xyz', 'x', 'native', testActor),
      ).rejects.toMatchObject({ response: { code: ErrorCode.DOC_NOT_FOUND } });

      // 'alpha' 全文出现 2 次 → 409 + matchCount=2
      await expect(
        service.patchByMatch(r.id, 'alpha', 'x', 'native', testActor),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.RESOURCE_CONFLICT, data: { matchCount: 2 } },
      });
    } finally {
      await ds.getRepository(DocSection).delete({ docId: r.id });
      await ds.getRepository(Doc).delete({ id: r.id });
    }
  });

  it('Hument 场景复现：长节 chunk 漂移后旧 position + 错 hash → 409 写不进去；重拉后正确 hash → 放行', async () => {
    if (!dbAvailable) return;

    // ① 漂移前：定位「尾部节」（长节被 step 4 切成若干兄弟 chunk，尾部节在末尾）
    const outlineBefore = await service.findOne(docE.id, 0);
    const sectionsBefore = outlineBefore.sections ?? [];
    // 长节确实被二次切分（兄弟 chunk > 1），否则本用例没复现 Hument 的结构前提
    const longChunks = sectionsBefore.filter((s) => s.headingPath?.endsWith('长节'));
    expect(longChunks.length).toBeGreaterThan(1);
    const tail = sectionsBefore[sectionsBefore.length - 1];
    expect(tail.headingPath).toContain('尾部节');
    const stalePosition = tail.position;
    const staleHash = (await service.getSections(docE.id, [stalePosition])).sections[0].sectionHash;
    expect(staleHash).toMatch(/^[0-9a-f]{64}$/);

    // ② 他方在文首插入新节 → re-chunk 后全体 position 漂移（Hument 事故前奏）
    await service.patchSection(
      docE.id,
      0,
      '# 长节文档\n\n## 插入节\n\n插入正文。',
      'native',
      testActor,
    );
    await flushImmediates();

    // ③ 持旧 outline 的调用方用旧 position + 旧 hash 写 → fail-closed 409（而非静默写错块）
    await expect(
      service.patchSection(
        docE.id,
        stalePosition,
        '## 尾部节\n\n篡改正文。',
        'native',
        testActor,
        staleHash,
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_CONTENT_CONFLICT },
    });

    // ④ 写错块未发生：重拉 outline 后「尾部节」正文仍是原文
    const outlineAfter = await service.findOne(docE.id, 0);
    const tailAfter = (outlineAfter.sections ?? []).find((s) => s.headingPath?.endsWith('尾部节'));
    expect(tailAfter).toBeDefined();
    const freshSection = await service.getSection(docE.id, tailAfter!.position);
    expect(freshSection.content).toBe('尾部正文。');

    // ⑤ 重拉 outline 后用新 position + 新 hash → 放行
    const ok = await service.patchSection(
      docE.id,
      tailAfter!.position,
      '## 尾部节\n\n尾部正文已合法更新。',
      'native',
      testActor,
      freshSection.sectionHash,
    );
    await flushImmediates();
    expect(ok.unchanged).toBeFalsy();
    const finalSection = await service.getSection(docE.id, tailAfter!.position);
    expect(finalSection.content).toBe('尾部正文已合法更新。');
  });

  it('upsert 乐观锁：stale expectedContentHash → 409；正确 → 放行；doc 不存在 → 409', async () => {
    if (!dbAvailable) return;

    // 正确 hash → 放行，响应带新 contentHash
    const before = await service.findById(docD.id);
    const ok = await service.upsert(
      spaceId,
      {
        path: docD.path,
        content: '# 文档 D\n\n被链目标已更新。v2',
        expectedContentHash: before.contentHash!,
      },
      testActor,
    );
    await flushImmediates();
    expect(ok.unchanged).toBeFalsy();
    expect(ok.contentHash).not.toBe(before.contentHash);

    // stale hash（上一步之前的值）→ 409 DOC_CONTENT_CONFLICT
    await expect(
      service.upsert(
        spaceId,
        {
          path: docD.path,
          content: '# 文档 D\n\n并发篡改。',
          expectedContentHash: before.contentHash!,
        },
        testActor,
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_CONTENT_CONFLICT },
    });
    // 409 后内容未被篡改
    const full = await service.getContent(docD.id, true);
    expect(full.content).toContain('v2');
    expect(full.content).not.toContain('并发篡改');

    // doc 不存在 + 携带 expectedContentHash → 409（不得静默降级为新建）
    await expect(
      service.upsert(
        spaceId,
        {
          path: `tmp/${RUN}-ghost.md`,
          content: '# 幽灵',
          expectedContentHash: 'deadbeef',
        },
        testActor,
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.DOC_CONTENT_CONFLICT },
    });
  });

  // ==================== v1.57.1 MATCH 模式字节一致性（Hument 事故在 match 面的同类场景） ====================
  // 工具描述「read_doc 返回文本与 match 匹配面相同」曾失实：full 丢首标题 / section 幻影标题
  // （续 chunk 无标题行）/ 空正文尾部 \n\n 三处字节不一致 → 复制的 oldString 必 0 命中。
  // 修复：findOne full 分支 = getContent(full=true) 逐字节同形、section 读通道 markdown =
  // renderSectionPart 口径的字节级子串。本节打真实 PG 验证字节一致性——chunk 往返的真实
  // 渲染序 mock 测不出（铁律 #23），必须真实 PG。

  it('字节一致性：findOne(full) content === getContent(full=true) content（首 H1 保留）+ 每节 markdown 是 full 全文的字节级子串', async () => {
    if (!dbAvailable) return;

    // 构造 docF：首 H1 == title + 长逻辑节（>4000 字符触发 chunker step 4 段落二次切分，
    // 兄弟 chunk 共用同一 headingPath）+ 空 H2 分组标题——三种字节形态一次覆盖
    const longBody = Array.from(
      { length: 60 },
      (_, i) => `字节段落 ${i}：` + '一致性验证正文内容。'.repeat(10),
    ).join('\n\n');
    const upserted = await service.upsert(
      spaceId,
      {
        path: `tmp/${RUN}-byteidentity.md`,
        title: '字节一致性文档', // 显式 title = 首 H1 → 验证 skipDuplicateTitle=false 保真语义
        content: `# 字节一致性文档\n\n## 长节\n\n${longBody}\n\n## 空分组\n\n## 尾部节\n\n尾部正文。`,
      },
      testActor,
    );
    docF = await service.findById(upserted.id); // upsert 返回 UpsertDocResult，重取 Doc 实体
    await flushImmediates();

    // ── 断言 1：findOne full 模式（maxFullTokens=50000 覆盖阈值，文档 tokenEstimate 超 2000
    // 缺省阈值）content 与 full=true 通道逐字节相等 —— 修复前 findOne 走 skipDuplicateTitle=true，
    // 首 H1 被丢，两者不等 ──
    const detail = await service.findOne(docF.id, 50000);
    expect(detail.mode).toBe('full');
    const full = await service.getContent(docF.id, true);
    expect(detail.content).toBe(full.content);
    // 保真语义：首 H1（与 title 同名）保留，不是 web 渲染侧的丢标题形态
    expect(full.content.startsWith('# 字节一致性文档')).toBe(true);

    // ── 断言 2：每节 markdown 都是 full=true 全文的字节级子串；续 chunk 无幻影标题；
    // 空分组节 markdown = 仅标题行（无尾部 \n\n）──
    const outline = (await service.findOne(docF.id, 0)).sections ?? []; // maxFullTokens=0 强制 outline
    const longChunkPositions = outline
      .filter((s) => s.headingPath?.endsWith('长节'))
      .map((s) => s.position);
    // 长节确实被 step 4 二次切分（兄弟 chunk > 1），否则本用例没有字节形态前提
    expect(longChunkPositions.length).toBeGreaterThan(1);

    const batch = await service.getSections(docF.id, longChunkPositions);
    expect(batch.sections).toHaveLength(longChunkPositions.length);
    expect(batch.sections[0].isContinuation).toBe(false);
    expect(batch.sections.slice(1).every((item) => item.isContinuation === true)).toBe(true);
    for (const item of batch.sections) {
      expect(item.markdown).toBeDefined();
      // 字节级子串：每节 markdown 都在 full=true 全文原样出现（oldString 安全）
      expect(full.content.includes(item.markdown!)).toBe(true);
    }
    // 兄弟续 chunk：markdown = 裸正文（无标题行）—— 修复前 MCP 本地渲染会插幻影标题行，
    // 该片段不在 full 全文出现（正是 Hument 事故形态）
    const firstChunk = batch.sections[0];
    expect(firstChunk.markdown).toBe(`## 长节\n\n${firstChunk.content}`);
    const secondChunk = batch.sections[1];
    expect(secondChunk.markdown).not.toMatch(/^## /);
    expect(secondChunk.markdown).toBe(secondChunk.content);

    // 空分组节：仅标题行、不带尾部空行（renderSectionPart 空 content 分支）
    const emptyPosition = outline.find((s) => s.headingPath?.endsWith('空分组'))?.position!;
    const emptySection = await service.getSection(docF.id, emptyPosition);
    expect(emptySection.markdown).toBe('## 空分组');
    expect(full.content.includes('## 空分组')).toBe(true);
  });

  it('v1.57.3 回归：同父节下真实同名 sibling 标题经 upsert/full 读取仍保真', async () => {
    if (!dbAvailable) return;

    const upserted = await service.upsert(
      spaceId,
      {
        path: `tmp/${RUN}-same-heading.md`,
        title: '同名标题回归文档',
        content: [
          '# 同名标题回归文档',
          '',
          '## 父节',
          '',
          '### 分组',
          '',
          '#### 修改内容',
          '第一份独立正文。',
          '',
          '#### 修改内容',
          '第二份独立正文。',
        ].join('\n'),
      },
      testActor,
    );
    docG = await service.findById(upserted.id);
    await flushImmediates();

    const full = await service.getContent(docG.id, true);
    expect(full.content).toContain('#### 修改内容\n\n第一份独立正文。');
    expect(full.content).toContain('#### 修改内容\n\n第二份独立正文。');
    expect(full.content.match(/^#### 修改内容$/gm)).toHaveLength(2);

    const detail = await service.findOne(docG.id, 0);
    const sameHeadings = (detail.sections ?? []).filter((s) => s.headingPath?.endsWith('修改内容'));
    expect(sameHeadings).toHaveLength(2);
    const persistedSections = await service.getSections(
      docG.id,
      sameHeadings.map((section) => section.position),
    );
    expect(persistedSections.sections).toHaveLength(2);
    expect(persistedSections.sections.every((section) => section.isContinuation === false)).toBe(
      true,
    );
  });

  it('Hument 场景复现（match 面）：从续 chunk markdown 复制 oldString → patchByMatch 200（修复前带幻影标题必 404）', async () => {
    if (!dbAvailable) return;
    if (!docF) return; // docF 由上一个用例创建；单独跑本用例时跳过（套件顺序执行即覆盖）

    // 前提：docF 已在上一用例创建；重拉 outline 定位兄弟续 chunk
    const outline = (await service.findOne(docF.id, 0)).sections ?? [];
    const longChunkPositions = outline
      .filter((s) => s.headingPath?.endsWith('长节'))
      .map((s) => s.position);
    expect(longChunkPositions.length).toBeGreaterThan(1);

    // 续 chunk 的 markdown = 裸正文（无幻影标题），且每段含唯一前缀「字节段落 N：」——
    // 整个片段作 oldString 唯一命中（修复前 MCP 渲染的「## 长节\n\n正文」带幻影标题，
    // 在 full=true 全文失配 → 必 404）
    const secondChunk = (await service.getSections(docF.id, [longChunkPositions[1]])).sections[0];
    expect(secondChunk.markdown).not.toMatch(/^## /);
    const oldString = secondChunk.markdown!;
    const newString = oldString.replace('一致性验证', '字节一致性已更新');

    const result = await service.patchByMatch(docF.id, oldString, newString, 'native', testActor);
    await flushImmediates();
    expect(result.unchanged).toBeFalsy();
    expect(result.id).toBe(docF.id);

    // 替换生效：全文包含 newString、不再以旧串形式出现（且整篇仍保真可重建）
    const full = await service.getContent(docF.id, true);
    expect(full.content).toContain(newString);
    expect(full.content).not.toContain(oldString);
  });
});
