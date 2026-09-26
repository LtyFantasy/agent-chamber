/**
 * DocSpace 搜索重排（判别能力 `rerank`）— 真实 PG 端到端。
 *
 * 设计意图：重排是**跨三层的组合行为**（SQL 池 → 通用判别编排 → 位置带求解 → 命中构建），
 * 单测各自为战时漏掉的正是"层级交界处"：能力启用判定、闸门落行、日志标量、EXPLAIN 计划回退。
 * 故本套件在**迁移链临时库**上真跑一遍，并逐条钉死：
 * ① agent + 能力启用 ⇒ 页被重排（`reranked:true`）且日志行落 `operation='rerank'`；
 * ② 人类身份 / 能力未启用 ⇒ **完全不碰内核**（无调用、无日志行）；
 * ③ provider 失败 ⇒ fail-open 回 SQL 序（`finalOrderKeys: null`，状态仍是 provider 的真实状态）；
 * ④ 池内候选属私有空间 ⇒ `visibility_blocked` 标量行 + 结果与原路径一致；
 * ⑤ 查询词命中密钥形态 ⇒ `egress_blocked` 标量行 + **不调用 provider**（不出境）；
 * ⑥ 池 SQL 加入可见性投影后，预过滤仍在 ⇒ EXPLAIN 仍走索引路径（**不断言计划形状**，
 *     理由见 doc-search-prefilter 套件文件头的同款不变量：小 fixture 下 planner 必走 Index Scan）。
 *
 * 不变量：返回 `(docId, position)` ⊆ SQL 候选集；`reranked` 只在"启用且成功"时出现。
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../src/database/data-source';
import { DocSearchService } from '../src/modules/docspace/doc-search.service';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { ExperienceJudgmentRecord } from '../src/database/entities/experience-judgment-record.entity';
import { JudgmentQuotaService } from '../src/modules/judgment/judgment-quota.service';
import { JudgmentRunnerService } from '../src/modules/judgment/judgment-runner.service';
import { docSearchRerankCapability } from '../src/modules/docspace/rerank/doc-search-rerank';
import type { JudgmentConfig } from '../src/config/judgment.config';

const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};
const MAINTENANCE_DB = DB_CONFIG.database;
const TEMP_DB_NAME = `ass_ds_rerank_${process.pid}`;
const SPACE_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-0000000000a1';

const AGENT = { id: '00000000-0000-4000-8000-0000000000a2', type: 'agent' } as never;
const HUMAN = { id: '00000000-0000-4000-8000-0000000000a3', type: 'human' } as never;

/** 池候选：12 篇（limit=5 ⇒ poolSize=15，池不满），内容都含查询词「反向代理」 */
const DOCS = Array.from({ length: 12 }, (_, index) => ({
  docId: `00000000-0000-4000-8000-0000000d${String(index).padStart(4, '0')}`,
  path: `docs/rerank-${index}.md`,
  title: `反向代理配置 ${index}`,
  content: `反向代理 ${index} 的配置说明与验证方式。`.repeat(4),
}));

function configOf(overrides: Partial<JudgmentConfig> = {}): JudgmentConfig {
  return {
    provider: 'typesafe',
    baseUrl: 'http://127.0.0.1:1', // 钉本机不可路由端口：万一接线回归，绝不打到生产计费 API
    apiKey: 'inline-test-key',
    typesafeModel: 'jev-latest',
    timeoutMs: 5000,
    rateLimitPerHour: 100000,
    globalRateLimitPerHour: 100000,
    capabilityRateLimitPerHour: 100000,
    capabilities: ['rerank'],
    warnings: [],
    ...overrides,
  };
}

describe('DocSpace 搜索重排 — 真实 PG（迁移链临时库）', () => {
  // 真实 PG 套件的建库 + 全链迁移在并行跑（46 套件）时可能超过 jest 默认 5s hook 超时
  // ⇒ **必须在模块/describe 作用域设超时**（写在 beforeAll 里已经太晚：hook 的超时在
  // 进入前就已定死）。批次 1-d2 实测：并行下 beforeAll 超 5s 会让整套 8 例全红（假红）。
  jest.setTimeout(300_000);
  let adminDs: DataSource;
  let db: DataSource;
  let dbAvailable = false;
  let service: DocSearchService;
  /** fake provider 控制面 */
  const provider = {
    name: 'typesafe',
    enabled: true,
    mode: 'ok' as 'ok' | 'error',
    calls: 0,
  };
  /** 最近一次池查询的实际 SQL（EXPLAIN 复核用；仅测试内替换私有方法，不改产品代码） */
  let capturedPoolQuery: { getQueryAndParameters: () => [string, unknown[]] } | null = null;

  /** 直接驱动"逐候选档位"：把最靠后的候选给最高档（页外候选尝试进入返回页） */
  const tiersFromPoolSize = (count: number): number[] =>
    Array.from({ length: count }, (_, index) => (index >= 5 ? 3 : 0));

  /** fake provider 工厂（每例新建；控制面在 `provider` 上，跨实例共享） */
  function fakeProviderOf(_settings: JudgmentConfig) {
    return {
      name: 'typesafe',
      enabled: true,
      run: async (capability: { buildState: (input: unknown) => unknown }, input: unknown) => {
        provider.calls += 1;
        if (provider.mode === 'error') {
          return {
            status: 'error',
            request: { state: capability.buildState(input) },
            response: { error: 'fake provider error' },
            latencyMs: 1,
          };
        }
        return {
          status: 'ok',
          value: { tiers: tiersFromPoolSize(12) },
          meta: {
            provider: 'typesafe',
            model: 'jev-fake',
            judgedAt: new Date().toISOString(),
            rubricVersion: 'v1',
          },
          request: { state: capability.buildState(input) },
          response: { raw: { model: 'jev-fake' } },
          latencyMs: 7,
        };
      },
    };
  }
  /** 装配服务并捕获池 SQL（供 EXPLAIN 复核；只包一层私有方法，不改产品代码） */
  function buildService(judgment: JudgmentRunnerService): DocSearchService {
    const built = new DocSearchService(
      db.getRepository(DocSection),
      db.getRepository(Doc),
      db.getRepository(DocRoute),
      db.getRepository(TaskDocLink),
      judgment,
    );
    const internal = built as unknown as {
      buildScoredQuery: (...args: unknown[]) => unknown;
    };
    const original = internal.buildScoredQuery.bind(built);
    internal.buildScoredQuery = (...args: unknown[]) => {
      const qb = original(...args) as { getQueryAndParameters: () => [string, unknown[]] };
      capturedPoolQuery = qb;
      return qb;
    };
    return built;
  }

  /** 每例一套新内核：配额与 skip 记账是进程内内存（有界键含槽位+能力+actor）⇒ 不隔离会互相压制 */
  function freshJudgment(settings: JudgmentConfig = configOf()): JudgmentRunnerService {
    return new JudgmentRunnerService(
      new JudgmentQuotaService(settings),
      fakeProviderOf(settings) as never,
      settings,
      db.getRepository(ExperienceJudgmentRecord),
    );
  }

  beforeAll(async () => {
    adminDs = new DataSource({
      ...(AppDataSource.options as DataSourceOptions),
      name: 'doc-search-rerank-admin',
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      username: DB_CONFIG.username,
      password: DB_CONFIG.password,
      database: MAINTENANCE_DB,
      entities: [],
      migrations: [],
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      logging: false,
    } as DataSourceOptions);
    try {
      await adminDs.initialize();
    } catch (err) {
      console.warn(`[rerank e2e] PG unavailable, suite skipped: ${(err as Error).message}`);
      return;
    }
    await adminDs.query(`DROP DATABASE IF EXISTS "${TEMP_DB_NAME}"`);
    await adminDs.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);

    db = new DataSource({
      ...(AppDataSource.options as DataSourceOptions),
      name: 'doc-search-rerank-temp',
      host: DB_CONFIG.host,
      port: DB_CONFIG.port,
      username: DB_CONFIG.username,
      password: DB_CONFIG.password,
      database: TEMP_DB_NAME,
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      logging: false,
    } as DataSourceOptions);
    await db.initialize();
    await db.runMigrations();

    // 真实内核（真配额 + 真日志表），provider 换成内存 fake
    const settings = configOf();
    const fakeProvider = fakeProviderOf(settings);
    const judgment = new JudgmentRunnerService(
      new JudgmentQuotaService(settings),
      fakeProvider as never,
      settings,
      db.getRepository(ExperienceJudgmentRecord),
    );
    service = buildService(judgment);

    await db.query(`INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`, [
      SPACE_ID,
      'rerank-fixture',
      `rr-${process.pid}`,
      ACTOR_ID,
    ]);
    for (const [index, fixture] of DOCS.entries()) {
      await db.query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [fixture.docId, SPACE_ID, fixture.path, fixture.title, ACTOR_ID],
      );
      await db.query(
        `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 0, $2, $3)`,
        [fixture.docId, `反向代理 ${index}`, fixture.content],
      );
    }
    dbAvailable = true;
  });

  afterAll(async () => {
    provider.enabled = true;
    if (db?.isInitialized) await db.destroy();
    if (adminDs?.isInitialized) {
      await adminDs.query(`DROP DATABASE IF EXISTS "${TEMP_DB_NAME}"`).catch(() => undefined);
      await adminDs.destroy();
    }
  });

  beforeEach(async () => {
    provider.mode = 'ok';
    provider.calls = 0;
    capturedPoolQuery = null;
    if (!dbAvailable) return;
    // 每例一套新内核 + 新服务：配额与 skip 记账是进程内内存（有界键含槽位+能力+actor）
    service = buildService(freshJudgment());
    await db.query(`DELETE FROM experience_judgments WHERE operation = 'rerank'`);
    await db.query(`UPDATE doc_spaces SET settings = '{}'::jsonb WHERE id = $1`, [SPACE_ID]);
  });

  /** 本套件产生的重排行（按时间） */
  const rerankRows = async (): Promise<
    Array<{ status: string; request: Record<string, unknown>; provider: string }>
  > =>
    await db.query(
      `SELECT status, request, provider FROM experience_judgments
        WHERE operation = 'rerank' ORDER BY created_at ASC, id ASC`,
    );

  // v1.86 信封契约（主脑裁决 #1）：service.search 返回 `{ hits, hint? }`，
  // 本套件只关心 hits——helper 统一解信封，调用方形态与改动前一致
  const search = async (actor: never, extra: Record<string, unknown> = {}): Promise<unknown[]> =>
    (
      await service.search(
        [SPACE_ID],
        { q: '反向代理', limit: 5, ...extra },
        { actor, traceId: 'req_e2e_trace' },
      )
    ).hits;

  it('agent + 能力启用 ⇒ 页被重排（reranked:true）+ 日志行落 rerank 标量', async () => {
    if (!dbAvailable) return;
    const hits = (await search(AGENT)) as Array<{ docId: string; reranked?: true }>;
    expect(hits).toHaveLength(5);
    expect(hits.every((hit) => hit.reranked === true)).toBe(true);
    // 页外候选（池内 i≥5）被提进返回页 ⇒ 与 SQL 序不同
    expect(hits.map((hit) => hit.docId)).not.toEqual(DOCS.slice(0, 5).map((doc) => doc.docId));
    expect(provider.calls).toBe(1);

    const rows = await rerankRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('typesafe');
    const payload = rows[0].request as {
      candidateDocIds: string[];
      candidatePositions: number[];
      sqlRanks: number[];
      candidateCount: number;
      finalOrderKeys: string[] | null;
      modelScores: Array<number | null>;
      traceId: string | null;
      candidatesTruncated: boolean;
      eligibleForPromotion: number;
      medianExcerptBytes: number;
    };
    // ── 排列式断言（1-d2，主脑裁决；高危机理 #2「恒真空转」修法）────────────────
    // 旧形态 `expect(payload.sqlRanks).toEqual([...Array(12).keys()])` 由实现
    // `candidates.map(c => c.index)` 直接决定 ⇒ 恒真：池序/打分式/平局键怎么变都不会红。
    // 真正有判别力的是「落日志的候选序 == **真实 SQL 池序**」——故用抓到的池 SQL 重跑一次
    // 逐位比较（池序变化、可见性投影吃掉平局键、预过滤被移除导致池成员变化，本断言都会红）。
    const [poolSql, poolParams] = (
      capturedPoolQuery as { getQueryAndParameters: () => [string, unknown[]] }
    ).getQueryAndParameters();
    const poolRows = (await db.query(poolSql, poolParams)) as {
      doc_id: string;
      section_position: number;
    }[];
    expect(poolRows).toHaveLength(payload.candidateCount);
    expect(payload.candidateDocIds).toEqual(poolRows.map((row) => row.doc_id));
    expect(payload.candidatePositions).toEqual(poolRows.map((row) => row.section_position));
    expect(payload.sqlRanks).toEqual(poolRows.map((_row, index) => index)); // 下标 == 池位次
    expect(payload.finalOrderKeys).not.toBeNull();
    expect(payload.modelScores.filter((tier) => tier === 3).length).toBeGreaterThan(0);
    expect(payload.traceId).toBe('req_e2e_trace'); // 非空且来自 @RequestId 穿线
    expect(payload.eligibleForPromotion).toBe(12 - 5);
    expect(payload.medianExcerptBytes).toBeGreaterThan(0);
    // 不落原文：查询词不在日志标量里（只落 id 与标量）
    expect(JSON.stringify(payload)).not.toContain('反向代理');
  });

  it('人类身份 ⇒ 不重排、不落行（web 面不受判别延迟影响）', async () => {
    if (!dbAvailable) return;
    const hits = (await search(HUMAN)) as Array<{ reranked?: true }>;
    expect(hits).toHaveLength(5);
    expect(hits.some((hit) => hit.reranked === true)).toBe(false);
    expect(provider.calls).toBe(0);
    expect(await rerankRows()).toHaveLength(0);
  });

  it('能力未启用（JUDGMENT_CAPABILITIES 为空）⇒ 不调用、不落行', async () => {
    if (!dbAvailable) return;
    const disabled = buildService(freshJudgment(configOf({ capabilities: [] })));
    const { hits } = await disabled.search(
      [SPACE_ID],
      { q: '反向代理', limit: 5 },
      { actor: AGENT },
    );
    expect(hits).toHaveLength(5);
    expect(await rerankRows()).toHaveLength(0);
  });

  it('provider 失败 ⇒ fail-open 回 SQL 序 + 日志 status=error（finalOrderKeys=null）', async () => {
    if (!dbAvailable) return;
    provider.mode = 'error';
    const hits = (await search(AGENT)) as Array<{ docId: string; reranked?: true }>;
    expect(hits).toHaveLength(5);
    expect(hits.some((hit) => hit.reranked === true)).toBe(false);
    // fail-open 现已**统一走原路径**（终审 MAJOR-3 口径）：与"未启用重排"（人类基线）
    // **有序逐字相等**——不再有"池序 vs 原路径在平局样本上可能不同序"的余地（复审 NEW-2：
    // 旧注释描述的池切片口径已作废，断言也从"集合相等"升级为"有序相等"，判别性更强）。
    const baseline = (await search(HUMAN)) as Array<{ docId: string }>;
    expect(hits.map((hit) => hit.docId)).toEqual(baseline.map((hit) => hit.docId));

    const rows = await rerankRows();
    expect(rows[0].status).toBe('error');
    expect((rows[0].request as { finalOrderKeys: unknown }).finalOrderKeys).toBeNull();
  });

  it('池内候选属**私有空间** ⇒ visibility_blocked 标量行 + 结果与原路径一致', async () => {
    if (!dbAvailable) return;
    await db.query(
      `UPDATE doc_spaces SET settings = '{"visibility":"private"}'::jsonb WHERE id = $1`,
      [SPACE_ID],
    );
    const baseline = (await search(HUMAN)) as Array<{ docId: string }>;
    const hits = (await search(AGENT)) as Array<{ docId: string; reranked?: true }>;
    expect(provider.calls).toBe(0);
    expect(hits.some((hit) => hit.reranked === true)).toBe(false);
    // 可见性闸命中 ⇒ 结果与**未启用重排**（人类基线）一致
    expect(hits.map((hit) => hit.docId)).toEqual(baseline.map((hit) => hit.docId));

    const rows = await rerankRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect((rows[0].request as { reason: string }).reason).toBe('visibility_blocked');
    // 标量行**不带候选清单**（防反向泄露私有空间里存在哪些文档）
    expect(JSON.stringify(rows[0].request)).not.toContain('candidateDocIds');
    expect(JSON.stringify(rows[0].request)).not.toContain(DOCS[0].docId);
  });

  it('查询词命中密钥形态 ⇒ egress_blocked 标量行 + **不调用 provider**（不出境）', async () => {
    if (!dbAvailable) return;
    const { hits } = (await service.search(
      [SPACE_ID],
      { q: 'ask_deadbeef 反向代理', limit: 5 },
      { actor: AGENT, traceId: 'req_egress' },
    )) as { hits: Array<{ docId: string; reranked?: true }> };
    expect(provider.calls).toBe(0);
    expect(hits.some((hit) => hit.reranked === true)).toBe(false);
    // 出境闸跳过同样走原路径 ⇒ 与人类基线**有序逐字相等**（复审 NEW-2 的同构升级）
    const { hits: baseline } = (await service.search(
      [SPACE_ID],
      { q: 'ask_deadbeef 反向代理', limit: 5 },
      { actor: HUMAN, traceId: null },
    )) as { hits: Array<{ docId: string }> };
    expect(hits.map((hit) => hit.docId)).toEqual(baseline.map((hit) => hit.docId));

    const rows = await rerankRows();
    expect(rows).toHaveLength(1);
    expect((rows[0].request as { reason: string }).reason).toBe('egress_blocked');
    // 不落查询词（闸门日志不许成为泄漏面）
    expect(JSON.stringify(rows[0].request)).not.toContain('deadbeef');
  });

  it('池 SQL 的 EXPLAIN 仍走索引路径（可见性投影不得吃掉预过滤 / 拖回退计划）', async () => {
    if (!dbAvailable) return;
    await search(AGENT);
    expect(capturedPoolQuery).not.toBeNull();
    const [sql, params] = (
      capturedPoolQuery as { getQueryAndParameters: () => [string, unknown[]] }
    ).getQueryAndParameters();
    // 可见性投影确实在池 SQL 里（否则这条 EXPLAIN 验的不是池查询）
    expect(sql).toContain('space_visibility');
    // 预过滤按 arms 分两态（v1.87 `%` 腿消融）：本查询（`反向代理`）arms≥1 ⇒ 候选 = ts-only。
    // 守卫对象不变——**可见性投影不得吃掉保留的预过滤与 K-gate**（池查询必须仍是"带门带过滤"
    // 的那条，否则 EXPLAIN 验的是另一条 SQL）。
    expect(sql).toContain("@@ to_tsquery('simple', $"); // ts 预过滤在场
    expect(sql).not.toMatch(/"content" % \$\d/); // content `%` 腿已消融（成本本体）
    expect(sql).not.toMatch(/"heading_path" % \$\d/); // arms≥1 态下 heading `%` 腿亦消融
    expect(sql).toMatch(/::int >= \$\d/); // K-gate 门仍在（结构门，逐 arm 计数求和）
    const plan = (await db.query(`EXPLAIN ${sql}`, params)) as Array<Record<string, string>>;
    const text = plan.map((row) => Object.values(row)[0]).join('\n');
    // ⚠️ **不断言计划形状（BitmapOr）**：本仓既有不变量（doc-search-prefilter.e2e-spec 文件头）
    // 明确写着"小 fixture 表下 planner 必走 Index Scan，不得断言计划形状"。
    // 这里断言可稳定复核的那一面：预过滤保留 ⇒ `doc_sections` / `docs` 仍走索引路径（非全表扫描）。
    expect(text).not.toMatch(/Seq Scan on (doc_sections|docs)/);
    expect(text).toContain('Index');
  });

  it('返回 (docId, position) ⊆ SQL 候选集（重排只重排、不引入新文档）', async () => {
    if (!dbAvailable) return;
    const hits = (await search(AGENT)) as Array<{ docId: string; position: number }>;
    const allowed = new Set(DOCS.map((doc) => `${doc.docId}#0`));
    for (const hit of hits) {
      expect(allowed.has(`${hit.docId}#${hit.position}`)).toBe(true);
    }
    // 能力对象身份自检（本套件驱动的就是它）
    expect(docSearchRerankCapability.name).toBe('rerank');
  });
});
