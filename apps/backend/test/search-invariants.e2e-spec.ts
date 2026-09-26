/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 检索中文根治（批次 1）的**不变量矩阵**：14 条跨切面不变量各一条「最廉价的充分断言」
 *     （真 DB 能验的走迁移链临时库；纯契约的走编译器/导出组/常量）
 *
 * [代码职责]
 *   - 把散落在各实现文件 hook、计划正文与评审结论里的不变量集中成一张**可执行清单**，
 *     每条注明「深水区所有者」（哪个套件做完整验证）——本文件是矩阵视图，不替代深水区
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2（检索四模式与预过滤）
 *   - 设计定稿: 检索中文根治计划终稿 v1.5 §2.1/§2.2/§2.3/§2.5/§2.6 + §10 守卫节
 *   - 深水区: test/doc-search-prefilter.e2e-spec.ts（四模式 + 在场守卫 + K-gate 收窄）、
 *     test/search-cjk.e2e-spec.ts（召回/排序/snippet）、test/search-char-class-diff.e2e-spec.ts
 *     （字符类行为式差分）、src/modules/docspace/doc-search-constants.spec.ts（地板三角）
 *
 * [关键不变量]（本文件即这 14 条的守卫；改动任一条先读计划对应 §）
 *   ① 预过滤按 arms 分态（v1.87 `%` 腿消融）：arms≥1 = **ts-only**（召回保全由 K-gate 的
 *      结构引理承担——`compiledQ` 假 ⇒ 每 arm 假 ⇒ 门计数 0 < K）；arms=0 = ts 腿 +
 *      **仅 heading `%` 腿**（content `%` 腿删除 = content 级 typo 容忍下线的接受代价，REV-2）
 *   ② 零召回损失三角 `(TRGM_CONTENT + 活 heading 权重) × 阈值 < 地板`（余量 0.025）——
 *      作用域 = 两腿都在阈值下的行 + trgm-only 模式（消融后收窄，见 doc-search.service.ts）
 *   ③ heading 权重活旋钮合法域 (0, 1)（≥1 击穿三角 = 静默丢召回）
 *   ④ `ts_rank_cd` flag 0：单 bigram 命中 ≈0.1 且与章节长度无关；命中数单调
 *   ⑤ 编译产物**零插值**（一切产物只经绑定参数下发，生成串不含查询字面量）
 *   ⑥ ts 腿一律 `to_tsquery('simple', :param)` **包裹**（tsqueryin 原子语义防线）
 *   ⑦ 参数名保留契约（compiledQ / arm1..N / kGateK）+ arms 与 compiledQ 同集合（64 cap 同施）
 *   ⑧ K 缺省规则（≤4 CJK 字 K=1 / 更长 K=2）且恒被钳制到 ≤ armCount
 *   ⑨ `doc_sections.search_vector` 含 `heading_path`（heading 命中即向量命中）
 *   ⑩ 降级路径（单字/df）= ts-only 候选 + 常数分 + `(position, doc_id)` 双键位置序
 *   ⑪ 空 q（短路，不落零命中日志）与 isEmpty（trgm-only 真检索，落日志）**是两条路径**
 *   ⑫ 弱命中线两侧分家（doc-search = 基准 × W1 现构；task q= = 基准值不换算）
 *   ⑬ 零命中日志形状单源（tag + JSONL 单行 + 截断/脱敏），四消费方各调一次由服务 spec 承接
 *   ⑭ messages 面 keycap rank 表达式可在真库**执行**（数组参数 + 小数 boost 的类型推断；
 *      `CASE … THEN :boost ELSE 0` 的整数分支会把 boost 推成 integer ⇒ 必带 `::float8`）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './pending/_temp-db';
import {
  DocSearchService,
  RANK_WEIGHTS,
  SCORE_FLOOR,
  SINGLE_CHAR_CONST_SCORE,
} from '../src/modules/docspace/doc-search.service';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { PG_TRGM_SIMILARITY_THRESHOLD } from '../src/database/pg-session-defaults';
import {
  buildSearchSql,
  COMPILED_Q_PARAM,
  K_GATE_ARM_PARAM_PREFIX,
  K_GATE_K_PARAM,
} from '../src/common/utils/search/search-sql';
import {
  chooseKGateK,
  compileQuery,
  K_GATE_ARM_CAP,
} from '../src/common/utils/search/tsquery-compiler';
import {
  DOC_SEARCH_WEAK_HIT_SCORE,
  SEARCH_KGATE_K_OVERRIDE,
  SEARCH_TRGM_HEADING_W,
  SEARCH_TS_W1,
} from '../src/common/utils/search/search-tuning';
import { DOC_SEARCH_STRONG_HIT_SCORE, TASK_SEARCH_WEAK_HIT_SCORE } from '@agent-chamber/shared';
import * as zeroHitLog from '../src/common/utils/search/zero-hit-log';

const SPACE_ID = 'e2e2e2e2-0000-4000-8000-0000000000c1';
const ACTOR_ID = 'e2e2e2e2-0000-4000-8000-0000000000c2';

/** 编译产物消费点枚举（计划 §2.2：score / prefilter / headline / kGate 四处） */
const CONSUMER_POINTS = ['scoreExpr', 'prefilterExpr', 'headlineExpr', 'kGateExpr'] as const;

describe('检索中文根治不变量矩阵（14 条）', () => {
  let handle: TempDbHandle;
  let service: DocSearchService;
  jest.setTimeout(300_000);
  const db = () => handle.db as NonNullable<TempDbHandle['db']>;

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('invariants');
    if (!handle.available) return;

    await db().query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'invariants-fixture', `inv-${process.pid}`, ACTOR_ID],
    );
    // 三条：ts 命中行 / heading 命中行（内容不含查询词）/ 噪音行
    const fixtures: [string, string, string][] = [
      [
        'e2e2e2e2-0000-4000-8000-000000000101',
        'Ops § Ports',
        '端口映射失效的排查思路与运维手册总纲',
      ],
      [
        'e2e2e2e2-0000-4000-8000-000000000102',
        '端口映射失效排查笔记',
        'Deployment checklist for the release train.',
      ],
      [
        'e2e2e2e2-0000-4000-8000-000000000103',
        'Finance § Budget',
        'Quarterly budget review notes about travel reimbursements.',
      ],
    ];
    for (const [docId, headingPath, content] of fixtures) {
      await db().query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [docId, SPACE_ID, `inv/${docId.slice(-4)}.md`, 'Inv', ACTOR_ID],
      );
      await db().query(
        `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 0, $2, $3)`,
        [docId, headingPath, content],
      );
    }
    service = new DocSearchService(
      db().getRepository(DocSection),
      db().getRepository(Doc),
      db().getRepository(DocRoute),
      db().getRepository(TaskDocLink),
      { isEnabled: () => false, run: jest.fn(), recordSkip: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  // ── ① 预过滤超集（深水区：doc-search-prefilter ①）────────────────────────
  it('① 预过滤按 arms 分态（v1.87 % 腿消融）：结构引理 + 残余地板界各自成立', async () => {
    if (!handle.available) return;
    const q = '端口映射失效排查';
    const compiled = compileQuery(q);
    // 前提自证：该查询 arms≥1（CJK bigram）⇒ normal 走「ts-only 候选」态（两 `%` 腿消融）
    expect(compiled.arms.length).toBeGreaterThan(0);

    const armSum = compiled.arms
      .map((_, i) => `(s.search_vector @@ to_tsquery('simple', $${i + 3}))::int`)
      .join(' + ');

    // (a) **结构引理（REV-2 的证明级安全）**：`NOT (sv @@ compiledQ)` ⇒ 每 arm 假
    //     ⇒ K-gate 计数 0 < K ⇒ 该行本就进不了最终集 ⇒ ts-only 预过滤零损失。
    //     这一条取代了旧「预过滤 ⊇ 地板命中集」的表述——消融后超集性质由门而非相似度承担。
    const [lemma] = (await db().query(
      `
      SELECT count(*)::int AS violations FROM doc_sections s
        INNER JOIN docs d ON d.id = s.doc_id
       WHERE d.space_id = $1
         AND NOT (s.search_vector @@ to_tsquery('simple', $2))
         AND (${armSum}) > 0
      `,
      [SPACE_ID, compiled.tsquery, ...compiled.arms],
    )) as { violations: number }[];
    expect(lemma.violations).toBe(0);

    // (b) **残余地板界（三角现作用域）**：两 trgm 腿都在阈值下且被预过滤排除的行，
    //     合成分必须 < SCORE_FLOOR。⚠️ 消融后该界**不再覆盖**「content 相似但 heading
    //     不相似」的行（content `%` 腿已删）——那类行的排除属 REV-2 明记的接受代价
    //     （content 级 typo 模糊容忍下线），故这里只断言仍在证明覆盖内的子集。
    const [triad] = (await db().query(
      `
      SELECT count(*)::int AS violations FROM (
        SELECT
          (s.search_vector @@ to_tsquery('simple', $1)) AS ts_hit,
          (s.content % $2) AS content_pct,
          (s.heading_path % $2) AS heading_pct,
          (COALESCE(ts_rank_cd(s.search_vector, to_tsquery('simple', $1)), 0) * ${SEARCH_TS_W1}
           + similarity(s.content, $2) * ${RANK_WEIGHTS.TRGM_CONTENT}
           + similarity(COALESCE(s.heading_path, ''), $2) * ${SEARCH_TRGM_HEADING_W}) AS composite
        FROM doc_sections s
        INNER JOIN docs d ON d.id = s.doc_id
        WHERE d.space_id = $3
      ) rows
      WHERE NOT (ts_hit OR content_pct OR heading_pct) AND composite > $4
      `,
      [compiled.tsquery, q, SPACE_ID, SCORE_FLOOR],
    )) as { violations: number }[];
    expect(triad.violations).toBe(0);
  });

  // ── ② 地板三角余量（深水区：doc-search-constants.spec）──────────────────
  it('② 零召回损失三角：被排除行的合成分上界 < SCORE_FLOOR（余量 > 0）', () => {
    const upper =
      (RANK_WEIGHTS.TRGM_CONTENT + SEARCH_TRGM_HEADING_W) * PG_TRGM_SIMILARITY_THRESHOLD;
    expect(upper).toBeLessThan(SCORE_FLOOR);
    expect(SCORE_FLOOR - upper).toBeGreaterThan(0);
  });

  // ── ③ heading 权重合法域（深水区：doc-search-constants.spec）────────────
  it('③ heading trgm 权重活旋钮落在合法域 (0,1)（≥1 即击穿三角）', () => {
    expect(SEARCH_TRGM_HEADING_W).toBeGreaterThan(0);
    expect(SEARCH_TRGM_HEADING_W).toBeLessThan(1);
  });

  // ── ④ cd 尺度（深水区：search-cjk ②）───────────────────────────────────
  it('④ `ts_rank_cd` flag 0：单 bigram 命中 ≈0.1、与章节长度无关、命中数单调', async () => {
    if (!handle.available) return;
    const q = '端口映射失效排查';
    const compiled = compileQuery(q);
    const ids = [
      'e2e2e2e2-0000-4000-8000-000000000201',
      'e2e2e2e2-0000-4000-8000-000000000202',
      'e2e2e2e2-0000-4000-8000-000000000203',
    ];
    for (const id of ids) {
      await db().query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [id, SPACE_ID, `inv/cd-${id.slice(-3)}.md`, 'CD', ACTOR_ID],
      );
    }
    await db().query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES
         ($1, 0, 'Ops § CD', '端口'),
         ($2, 0, 'Ops § CD', '端口' || $4),
         ($3, 0, 'Ops § CD', '端口映射')`,
      [ids[0], ids[1], ids[2], '无关内容填充'.repeat(40)],
    );
    const rows = (await db().query(
      `SELECT s.doc_id, ts_rank_cd(s.search_vector, to_tsquery('simple', $1))::float8 AS cd
         FROM doc_sections s WHERE s.doc_id = ANY($2::uuid[])`,
      [compiled.tsquery, ids],
    )) as { doc_id: string; cd: number }[];
    const cd = (id: string) => rows.find((r) => r.doc_id === id)?.cd as number;

    expect(Math.abs(cd(ids[1]) - cd(ids[0]))).toBeLessThan(0.02); // 长度无关
    expect(cd(ids[0])).toBeGreaterThan(0.05);
    expect(cd(ids[0])).toBeLessThan(0.2); // 单点档 ≈0.1
    expect(cd(ids[2])).toBeGreaterThan(cd(ids[0])); // 命中数单调

    await db().query(`DELETE FROM docs WHERE id = ANY($1::uuid[])`, [ids]);
  });

  // ── ⑤ 零插值（深水区：search-sql.spec + prefilter ⑪）──────────────────
  it('⑤ 编译产物零插值：导出组四段不含查询字面量，只含绑定参数占位', () => {
    const queries = ['端口映射失效排查', "it's", 'foo-bar', "http://a.com/?q='x'"];
    for (const q of queries) {
      const compiled = compileQuery(q);
      const group = buildSearchSql({ vector: 's.search_vector', text: 's.content' }, compiled, {
        startSel: '',
        stopSel: '',
      }) as NonNullable<ReturnType<typeof buildSearchSql>>;
      // 生成串 = 纯模板（列名 + 函数名 + 参数占位）⇒ 原查询串与其任一码点都不得出现
      const exprs = [
        group.scoreExpr,
        group.prefilterExpr,
        group.headlineExpr,
        group.kGateExpr ?? '',
      ];
      for (const expr of exprs) {
        expect(expr).not.toContain(q); // 原串不得内联
        // CJK 码点绝不出现在模板里（模板全 ASCII）⇒ 这是"无插值"的最强判别。
        // ASCII 查询不比单码点：模板关键字（to_tsquery/similarity/s.content）本就含字母
        for (const ch of q) {
          if (/[\u3041-\u30fa\u3400-\u9fff\u3005-\u3007]/.test(ch)) expect(expr).not.toContain(ch);
        }
      }
    }
  });

  // ── ⑥ to_tsquery 包裹（深水区：prefilter ⑪ 4 消费点枚举）───────────────
  it("⑥ 四消费点均经 `to_tsquery('simple', :param)` 包裹，且无裸 `::tsquery` cast", () => {
    const compiled = compileQuery('端口映射失效排查');
    const group = buildSearchSql({ vector: 's.search_vector', text: 's.content' }, compiled, {
      startSel: '',
      stopSel: '',
    }) as NonNullable<ReturnType<typeof buildSearchSql>>;

    expect(group.scoreExpr).toContain(`to_tsquery('simple', :${COMPILED_Q_PARAM})`);
    expect(group.prefilterExpr).toContain(`to_tsquery('simple', :${COMPILED_Q_PARAM})`);
    expect(group.headlineExpr).toContain(`to_tsquery('simple', :${COMPILED_Q_PARAM})`);
    expect(group.kGateExpr).toContain(`to_tsquery('simple', :${K_GATE_ARM_PARAM_PREFIX}1)`);
    // 导出组整体形态：四处齐备 + 无裸 cast（cast 是为裸 @@ 的 operator 解析，包裹后不再需要）
    expect(
      CONSUMER_POINTS.filter((key) => group[key] !== null && group[key] !== undefined),
    ).toHaveLength(4);
    for (const expr of [group.scoreExpr, group.prefilterExpr, group.kGateExpr ?? '']) {
      expect(expr).not.toContain('::tsquery');
    }
  });

  // ── ⑦ 参数名与 arm 集合（深水区：search-sql.spec）───────────────────────
  it('⑦ 参数名保留契约 + arms 与 compiledQ 同集合（64 cap 同施）', () => {
    const compiled = compileQuery('端口映射失效排查');
    const group = buildSearchSql({ vector: 's.search_vector', text: 's.content' }, compiled, {
      startSel: '',
      stopSel: '',
    }) as NonNullable<ReturnType<typeof buildSearchSql>>;

    const paramNames = Object.keys(group.kGateParams).sort();
    expect(paramNames).toContain(K_GATE_K_PARAM);
    for (let i = 1; i <= compiled.arms.length; i += 1) {
      expect(paramNames).toContain(`${K_GATE_ARM_PARAM_PREFIX}${i}`);
    }
    expect(paramNames).toHaveLength(compiled.arms.length + 1);
    // 保留参数名：PG 类型名不得作参数名（TypeORM 0.3.30 替换正则会扫出 ::tsquery 假参数）
    for (const name of paramNames) expect(name).not.toBe('tsquery');
    // 64 cap 同施：arm 数不得超过 cap（compiledQ 与门的 arm 集合同一集合）
    expect(compiled.arms.length).toBeLessThanOrEqual(K_GATE_ARM_CAP);
  });

  // ── ⑧ K 缺省规则与钳制（深水区：prefilter ⑫ + k-gate-semantics 钉子）───
  it('⑧ K 缺省规则（≤4 CJK 字 K=1 / 更长 K=2）且恒钳制到 ≤ armCount', () => {
    expect(chooseKGateK(4, 3)).toBe(1);
    expect(chooseKGateK(5, 3)).toBe(2);
    expect(chooseKGateK(9, 2)).toBe(2); // armCount 限制：K 不得超 arm 数（否则门恒不可达）
    expect(chooseKGateK(0, 0)).toBeNull(); // 无 arm 不挂门（纯 ASCII 查询）
    expect(chooseKGateK(5, 7, SEARCH_KGATE_K_OVERRIDE)).toBe(2); // 缺省 override（undefined）时走规则
  });

  // ── ⑨ 向量含 heading_path（深水区：prefilter ② 前提）───────────────────
  it('⑨ doc_sections 向量含 heading_path：内容不含查询词但 heading 命中的行照样向量命中', async () => {
    if (!handle.available) return;
    const compiled = compileQuery('端口映射失效排查');
    const [{ hit }] = (await db().query(
      `SELECT (s.search_vector @@ to_tsquery('simple', $2)) AS hit
         FROM doc_sections s WHERE s.doc_id = $1`,
      ['e2e2e2e2-0000-4000-8000-000000000102', compiled.tsquery], // heading 命中行（内容为英文）
    )) as { hit: boolean }[];
    expect(hit).toBe(true);
  });

  // ── ⑩ 降级路径（深水区：prefilter ⑨⑩）────────────────────────────────
  it('⑩ 降级路径 = 常数分 + `(position, doc_id)` 双键位置序（不按相关度）', async () => {
    if (!handle.available) return;
    const hits = (await service.search([SPACE_ID], { q: '端', limit: 20 })).hits;
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.score).toBe(SINGLE_CHAR_CONST_SCORE);
    const keys = hits.map((hit) => `${hit.position}#${hit.docId}`);
    expect(keys).toEqual([...keys].sort()); // position 升序 + docId 升序（全序可复现）
  });

  // ── ⑪ 空 q vs isEmpty 两条路径（深水区：prefilter ⑦⑧ + task spy 断言）──
  it('⑪ 空 q（短路，不落日志）与 isEmpty（trgm-only 真检索，落日志）是两条路径', async () => {
    if (!handle.available) return;
    const spy = jest.spyOn(zeroHitLog, 'logSearchZeroHit');
    try {
      // 空 q：短路返回空信封，且**不是**「检索未命中」⇒ 不落零命中日志
      expect(await service.search([SPACE_ID], { q: '   ' })).toEqual({ hits: [] });
      expect(spy).not.toHaveBeenCalled();

      // isEmpty（纯标点）：真检索（trgm-only）⇒ 零结果时照常落零命中日志
      expect(compileQuery('!!!').isEmpty).toBe(true);
      await service.search([SPACE_ID], { q: '!!!' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toMatchObject({ surface: 'doc', query: '!!!' });
    } finally {
      spy.mockRestore();
    }
  });

  // ── ⑫ 弱命中线两侧分家（深水区：search-tuning.spec + doc-search/task spec）──
  it('⑫ 弱命中线两侧分家：doc-search = 基准 × W1 现构；task q= = 基准值不换算', () => {
    expect(DOC_SEARCH_WEAK_HIT_SCORE).toBeCloseTo(DOC_SEARCH_STRONG_HIT_SCORE * SEARCH_TS_W1, 10);
    expect(TASK_SEARCH_WEAK_HIT_SCORE).toBe(DOC_SEARCH_STRONG_HIT_SCORE);
    expect(TASK_SEARCH_WEAK_HIT_SCORE).not.toBe(DOC_SEARCH_WEAK_HIT_SCORE);
  });

  // ── ⑬ 零命中日志形状（深水区：zero-hit-log.spec + 四消费方 spy 断言）────
  it('⑬ 零命中日志单行 JSONL 形状（tag + surface + 截断查询），四消费方各调一次由服务 spec 承接', () => {
    const logger = { warn: jest.fn() } as never;
    zeroHitLog.logSearchZeroHit(logger, {
      surface: 'doc',
      query: `多行\n查询${'长'.repeat(120)}`,
      queryTruncated: true,
      armTruncatedCount: 3,
    });
    const line = (logger as unknown as { warn: jest.Mock }).warn.mock.calls[0][0] as string;
    expect(line.includes('\n')).toBe(false); // JSONL 单行纪律
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.tag).toBe(zeroHitLog.ZERO_HIT_LOG_TAG);
    expect(parsed.surface).toBe('doc');
    expect((parsed.q as string).length).toBeLessThanOrEqual(zeroHitLog.ZERO_HIT_QUERY_MAX_CHARS);
    expect(parsed.queryTruncated).toBe(true);
  });

  // ── ⑭ keycap rank 表达式的真库可执行性（深水区：search.service.spec 的形态断言）──
  it('⑭ messages 面 keycap rank 表达式可在真库执行（数组参数 + 小数 boost 的类型推断）', async () => {
    if (!handle.available) return;
    // ⚠️ 这条测的是 **PG 类型推断**，不是字符串形态（形态由 search.service.spec 钉住）：
    // `CASE WHEN … THEN $boost ELSE 0 END` 里的整数分支 `0` 会把 `$boost` 推成 integer，
    // 小数 boost（标定值 2.7）报 `invalid input syntax for type integer: "2.7"`
    // （v1.87 批次 1 staging 实测 = messages 面 HTTP 500）。修法 = 两侧显式 `::float8`。
    // mock 单测测不出 ORM SQL 生成与参数类型推断 ⇒ 必须在真库跑一次表达式形态（铁律 #23）。
    const rows = (await db().query(
      `SELECT (ts_rank_cd(m.search_vector, to_tsquery('simple', $1))
               + CASE WHEN m.content LIKE ALL($2) THEN $3::float8 ELSE 0::float8 END) AS rank
         FROM messages m LIMIT 1`,
      [`'1'`, ['%1\uFE0F\u20E3%'], 2.7],
    )) as { rank: number }[];
    // 空表 ⇒ 0 行也算通过（本用例断言的是"语句可执行"，不是"有数据"）
    expect(Array.isArray(rows)).toBe(true);

    // 反证：去掉 `::float8`（回到出事的形态）必须报错——否则本用例失去判别力
    await expect(
      db().query(
        `SELECT (ts_rank_cd(m.search_vector, to_tsquery('simple', $1))
                 + CASE WHEN m.content LIKE ALL($2) THEN $3 ELSE 0 END) AS rank
           FROM messages m LIMIT 1`,
        [`'1'`, ['%1\uFE0F\u20E3%'], 2.7],
      ),
    ).rejects.toThrow(/invalid input syntax for type integer/);
  });
});
