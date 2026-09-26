/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 中文检索根治的**端到端价值证明**（批次 1 §2.1/§2.3/§2.2，真库）：
 *     ① AND→OR 召回增益（编译产物 OR 链把「部分命中」召回，旧口径 `@@ plainto_tsquery`
 *     对单字化向量**结构性零命中**）；② `ts_rank_cd` flag 0 的排序性质（命中 bigram
 *     越多分越高、单点尺度与章节长度无关 —— 这是 W1 必须 ≥2 的结构性原因）；
 *     ③ CJK 高亮（ts_headline 作用于**单字化文本**后经 cleanup 还原可读片段）
 *
 * [代码职责]
 *   - 在**迁移链临时库**上用真触发器/真向量/真 SQL 跑真 DocSearchService，把「中文搜不到」
 *     这一原始痛点钉成可回归的端到端断言（单元 mock 测不出向量形态与 cd 尺度）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2（DocSpace 检索；批次 1 接线后同步落线上）
 *   - 设计定稿: 检索中文根治计划终稿 v1.5 §2.1（单字化）/§2.2（编译产物消费）/§2.3（flag 0）
 *   - 补充: src/database/migrations/1791400000000-CjkUnigramSearchVector.ts（函数与触发器）
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **朴素形状对 CJK 结构性零命中**：文档向量是**单字化**文本（` 端  口  映 …`，
 *     每字一个 token），而 `plainto_tsquery('simple', '端口映射失效排查')` 是**未单字化**
 *     的整串 token ⇒ 永不命中。这正是"改造前中文搜不到"的机理，本套件用真库把它钉死
 *     （它同时是「预过滤必须用编译器产物」而非 `plainto_tsquery` 的实证根据）。
 *   - **cd 尺度与长度无关**：单 bigram 命中 `ts_rank_cd` 恒 ≈0.1（单字化向量均匀分布
 *     使然，批次 1-c 实测）；命中**不同** bigram 越多分越高。两个性质一起决定 W1 的
 *     量级选择（0.1×W1 要压过 heading trgm 噪声 0.22~0.29 ⇒ W1 ≥ 2）。
 *   - **snippet 必须经 cleanup**：ts_headline 作用在单字化文本上，原始产物带 CJK 字间
 *     双空格；未清理就外发 = 泄漏内部表示（见 snippet-cleanup.ts 契约三态）。
 *   - **不得断言执行计划形状**：小 fixture 表下 planner 必走 Seq Scan（既有不变量）。
 *
 * [关联代码]
 *   - src/modules/docspace/doc-search.service.ts — 被验证的实现（四模式 + snippet）
 *   - src/common/utils/search/tsquery-compiler.ts — 编译产物（OR 链的产出方）
 *   - src/common/utils/search/snippet-cleanup.ts — snippet 清理（③ 的被验对象）
 *   - test/pending/_temp-db.ts — 迁移链临时库装配（本套件复用之）
 *   - test/doc-search-prefilter.e2e-spec.ts — 预过滤侧的同一装配范式
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  createMigrationChainTempDb,
  destroyMigrationChainTempDb,
  type TempDbHandle,
} from './pending/_temp-db';
import { DocSearchService } from '../src/modules/docspace/doc-search.service';
import { DocSection } from '../src/database/entities/doc-section.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocRoute } from '../src/database/entities/doc-route.entity';
import { TaskDocLink } from '../src/database/entities/task-doc-link.entity';
import { compileQuery } from '../src/common/utils/search/tsquery-compiler';

/** 空间 / actor 锚点（固定字面量 uuid，断言可读、失败可定位） */
const SPACE_ID = 'e0e0e0e0-0000-4000-8000-0000000000a1';
const ACTOR_ID = 'e0e0e0e0-0000-4000-8000-0000000000a2';

/**
 * snippet 通道判别用的长正文填充（左右各一份 ⇒ ±150 窗口**两侧都被裁** ⇒ trgm 通道
 * 必产 `…` 省略标记；ts 通道（ts_headline）不产 U+2026）
 */
const SNIPPET_FILLER = 'unrelated filler about travel reimbursements and office supplies. '.repeat(4);

/**
 * fixture：五条 doc（各 1 section），覆盖五种召回形态
 * - ops：**目标节**（查询「端口映射失效排查」的真命中；命中 5/6 bigram）
 * - docker：**部分命中节**（只含 `不可达` 等相邻词形，命中 1 个 bigram ⇒ 只走 trgm/部分命中）
 * - budget：**噪音节**（与查询零重叠，预过滤与地板都不许放行）
 * - longTsRow / longTrgmRow：**snippet 通道判别对**（查询 `deployment`）——同一长正文
 *   布局下，前者含精确词 token（走 ts_headline 通道），后者含近形 `dep1oyment`
 *   （ts 不命中、靠 heading `%` + heading 相似度入候选 ⇒ 走 ±150 trgm 窗口通道）
 */
const DOCS = {
  ops: {
    docId: 'e0e0e0e0-0000-4000-8000-000000000101',
    path: 'cjk/ops-ports.md',
    title: '端口映射运维手册',
    headingPath: '运维 § 端口',
    content: '端口映射失效的排查思路：先确认宿主机端口未被占用，再检查镜像端口转发。',
  },
  docker: {
    docId: 'e0e0e0e0-0000-4000-8000-000000000102',
    path: 'cjk/docker-net.md',
    title: 'Docker 网络笔记',
    headingPath: 'Docker § 网络',
    content: 'Docker 网络排查笔记：容器之间不可达时先看 iptables 规则与网桥配置。',
  },
  budget: {
    docId: 'e0e0e0e0-0000-4000-8000-000000000103',
    path: 'cjk/budget.md',
    title: 'Budget Notes',
    headingPath: 'Finance § Budget',
    content: 'Quarterly budget review notes about travel reimbursements and office supplies.',
  },
  longTsRow: {
    docId: 'e0e0e0e0-0000-4000-8000-000000000104',
    path: 'cjk/long-ts.md',
    title: 'Long TS Row',
    // heading 含精确词（heading 腿抬过地板；content 单独在长正文里相似度会被稀释）
    headingPath: 'Deployment runbook',
    content: `${SNIPPET_FILLER}deployment pipeline notes${SNIPPET_FILLER}`,
  },
  longTrgmRow: {
    docId: 'e0e0e0e0-0000-4000-8000-000000000105',
    path: 'cjk/long-trgm.md',
    title: 'Long Trgm Row',
    headingPath: 'Dep1oyment notes',
    content: `${SNIPPET_FILLER}dep1oyment pipeline notes${SNIPPET_FILLER}`,
  },
} as const;

describe('中文检索端到端（真 PG · 迁移链临时库）', () => {
  let handle: TempDbHandle;
  let service: DocSearchService;
  jest.setTimeout(300_000);

  /** 便捷取库连接（beforeAll 后恒非空） */
  const db = () => handle.db as NonNullable<TempDbHandle['db']>;

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('searchcjk');
    if (!handle.available) return;

    await db().query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'search-cjk-fixture', `cjk-${process.pid}`, ACTOR_ID],
    );
    for (const doc of Object.values(DOCS)) {
      await db().query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [doc.docId, SPACE_ID, doc.path, doc.title, ACTOR_ID],
      );
      await db().query(
        `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 0, $2, $3)`,
        [doc.docId, doc.headingPath, doc.content],
      );
    }

    service = new DocSearchService(
      db().getRepository(DocSection),
      db().getRepository(Doc),
      db().getRepository(DocRoute),
      db().getRepository(TaskDocLink),
      // 重排内核恒未启用：本套件验的是**检索与 snippet** 本身（重排是可选增强）
      { isEnabled: () => false, run: jest.fn(), recordSkip: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    await destroyMigrationChainTempDb(handle);
  });

  const search = async (q: string) =>
    (await service.search([SPACE_ID], { q, limit: 20 })).hits;

  // ══════════════════════════════════════════════════════════════════════
  // ① AND→OR 召回增益（改造前「中文搜不到」的机理与修复的实证）
  // ══════════════════════════════════════════════════════════════════════

  it('① AND→OR 召回增益：朴素 `plainto_tsquery` 对单字化向量恒零命中，编译产物 OR 链召回目标节', async () => {
    if (!handle.available) return;
    const q = '端口映射失效排查';
    const compiled = compileQuery(q);
    expect(compiled.isEmpty).toBe(false);

    // 文档向量侧证据：单字化把 CJK 逐字切开（每字一个 token）
    const [{ vector }] = (await db().query(
      `SELECT s.search_vector::text AS vector FROM doc_sections s WHERE s.doc_id = $1`,
      [DOCS.ops.docId],
    )) as { vector: string }[];
    expect(vector).toContain("'端'");
    expect(vector).toContain("'口'");
    expect(vector).not.toContain('端口映射失效排查'); // 整串 token 已不存在

    // 朴素形状（旧口径 `@@ plainto_tsquery` 全词 AND）：未单字化的整串 token ⇒ 全库零命中
    const [{ naive }] = (await db().query(
      `SELECT count(*)::int AS naive FROM doc_sections s
        WHERE s.search_vector @@ plainto_tsquery('simple', $1)`,
      [q],
    )) as { naive: number }[];
    expect(naive).toBe(0);

    // 编译产物（bigram 短语 OR 链）：命中目标节
    const [{ compiledHits }] = (await db().query(
      `SELECT count(*)::int AS "compiledHits" FROM doc_sections s
        WHERE s.search_vector @@ to_tsquery('simple', $1)`,
      [compiled.tsquery],
    )) as { compiledHits: number }[];
    expect(compiledHits).toBeGreaterThanOrEqual(1);

    // 服务级：目标节必须被召回（核心痛点「中文搜不到」的执行层判决）
    const hits = await search(q);
    expect(hits.map((hit) => hit.docId)).toContain(DOCS.ops.docId);
  });

  it('① 补充：部分命中被召回，只共享 1 个 bigram 的被 K-gate 拒（门的粒度 = 不同 bigram 计数）', async () => {
    if (!handle.available) return;
    // 「端口不可达」= 5 CJK 字 ⇒ 缺省 K=2：
    // - docker 节含「不可达」⇒ 命中 `不-可`、`可-达` 两个 bigram ⇒ 过门并被召回
    // - ops 节只共享 `端-口` 一个 bigram ⇒ **被门拒**（过地板也不过门 = 有意收窄）
    const q = '端口不可达';
    const compiled = compileQuery(q);
    expect(compiled.cjkCharCount).toBe(5);

    const hits = await search(q);
    const ids = hits.map((hit) => hit.docId);
    expect(ids).toContain(DOCS.docker.docId); // 2 个 bigram 共享 ⇒ 召回
    expect(ids).not.toContain(DOCS.ops.docId); // 仅 1 个 bigram ⇒ 门拒
    expect(ids).not.toContain(DOCS.budget.docId); // 零重叠的噪音节仍被挡（地板/预过滤）
  });

  // ══════════════════════════════════════════════════════════════════════
  // ② cd flag 0 的排序性质（长度无关 + 命中数单调）
  // ══════════════════════════════════════════════════════════════════════

  it('② cd 排序：命中 bigram 越多分越高；单点尺度与章节长度无关（W1≥2 的结构性原因）', async () => {
    if (!handle.available) return;

    // 三个临时章节（测完即删）：
    // - singleShort / singleLong：**同一单一 bigram 命中集**，长度差 20 倍（验长度无关）
    // - triple：3 个 bigram（端-口 / 口-映 / 映-射）
    const singleShort = 'e0e0e0e0-0000-4000-8000-000000000201';
    const singleLong = 'e0e0e0e0-0000-4000-8000-000000000202';
    const triple = 'e0e0e0e0-0000-4000-8000-000000000203';
    const filler = '无关内容填充'.repeat(40);
    for (const [docId, path, title] of [
      [singleShort, 'cjk/cd-short.md', 'CD Short'],
      [singleLong, 'cjk/cd-long.md', 'CD Long'],
      [triple, 'cjk/cd-triple.md', 'CD Triple'],
    ] as const) {
      await db().query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [docId, SPACE_ID, path, title, ACTOR_ID],
      );
    }
    await db().query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES
         ($1, 0, $2, $3), ($4, 0, $2, $3 || $5), ($6, 0, $2, $7)`,
      [singleShort, 'Ops § CD', '端口', singleLong, filler, triple, '端口映射'],
    );

    const q = '端口映射失效排查';
    const compiled = compileQuery(q);
    const rows = (await db().query(
      `SELECT s.doc_id,
              ts_rank_cd(s.search_vector, to_tsquery('simple', $1)) AS cd
         FROM doc_sections s
        WHERE s.doc_id = ANY($2::uuid[])`,
      [compiled.tsquery, [singleShort, singleLong, triple]],
    )) as { doc_id: string; cd: number }[];
    const cdOf = (id: string) => Number(rows.find((r) => r.doc_id === id)?.cd);

    // 长度无关（flag 0 = 不做长度归一）：同一命中集下 cd 相等（容差 0.02 防浮点微差）
    expect(Math.abs(cdOf(singleLong) - cdOf(singleShort))).toBeLessThan(0.02);
    // 单点档可读刻度：单一 bigram 命中 ≈ 0.1 量级（批次 1-c 实测；地板 0.08 的邻居）
    expect(cdOf(singleShort)).toBeGreaterThan(0.05);
    expect(cdOf(singleShort)).toBeLessThan(0.2);
    // 命中数单调：3 个 bigram > 1 个 bigram
    expect(cdOf(triple)).toBeGreaterThan(cdOf(singleShort));

    // ops 节（5/6 bigram）> 3 bigram 章节 ⇒ 命中越多分越高
    const [{ opsCd }] = (await db().query(
      `SELECT ts_rank_cd(s.search_vector, to_tsquery('simple', $1)) AS "opsCd"
         FROM doc_sections s WHERE s.doc_id = $2`,
      [compiled.tsquery, DOCS.ops.docId],
    )) as { opsCd: number }[];
    expect(Number(opsCd)).toBeGreaterThan(cdOf(triple));

    // 服务级排序：命中更多的节排在前面（score DESC；同分才看 position）。
    // 两者都过 K=2 门（ops 5 个 / triple 3 个 bigram）⇒ 排序差完全由 cd 决定
    const hits = await search(q);
    const opsIndex = hits.findIndex((hit) => hit.docId === DOCS.ops.docId);
    const tripleIndex = hits.findIndex((hit) => hit.docId === triple);
    expect(opsIndex).toBeGreaterThanOrEqual(0);
    expect(tripleIndex).toBeGreaterThanOrEqual(0);
    expect(opsIndex).toBeLessThan(tripleIndex);

    await db().query(`DELETE FROM docs WHERE id = ANY($1::uuid[])`, [
      [singleShort, singleLong, triple],
    ]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // ③ CJK 高亮（ts_headline 作用在单字化文本 + cleanup 还原可读片段）
  // ══════════════════════════════════════════════════════════════════════

  it('③ CJK snippet：命中行走 ts_headline 通道且产物经 cleanup（无双空格/无标记残留/不泄漏单字化表示）', async () => {
    if (!handle.available) return;

    const hits = await search('端口映射失效排查');
    const hit = hits.find((h) => h.docId === DOCS.ops.docId);
    expect(hit).toBeDefined();

    const snippet = hit?.snippet ?? '';
    expect(snippet.length).toBeGreaterThan(0);
    // 查询字符出现在片段里（高亮生效的最弱可读判据——空标记通道刻意不带 <<<>>>）
    expect(snippet).toContain('端');
    // cleanup 三态：无连续空格、首尾无空格、无标记残留
    expect(snippet).not.toMatch(/ {2,}/);
    expect(snippet).toBe(snippet.trim());
    expect(snippet).not.toContain('<<<');
    expect(snippet).not.toContain('>>>');
    // 不泄漏单字化内部表示：字间只剩**单**空格（双空格已被归并）
    expect(snippet).not.toMatch(/端 {2}口/);
    // 上限契约（SNIPPET_MAX_CHARS=300）
    expect(snippet.length).toBeLessThanOrEqual(300);
  });

  // ══════════════════════════════════════════════════════════════════════
  // ④ snippet 通道判别（1-d2 终审 MAJOR-1 / QA M5 #10）
  // ══════════════════════════════════════════════════════════════════════

  it('④ snippet 通道判别：ts 命中行走 ts_headline，纯 trgm 命中行走 ±150 窗口（判别钉本体 + 省略标记）', async () => {
    if (!handle.available) return;

    // 判别钉本体 = 私有方法调用序（`buildHit` 的 `tsMatched` 分支）：
    // 只断言"片段长什么样"不足以抓住"ts 行被误判成 trgm"这一方向的静默降级
    // （±150 窗口在长正文上也给得出看起来合理的片段），故直接钉调用面。
    const internal = service as unknown as {
      buildTsHeadlineSnippet: (docId: string, position: number, compiled: unknown, q: string) => Promise<unknown>;
    };
    const spy = jest.spyOn(internal, 'buildTsHeadlineSnippet');
    let hits: Awaited<ReturnType<typeof search>>;
    // ⚠️ `spy.mockRestore()` 会连带 `mockReset()`（清空 mock.calls）⇒ 调用记录必须在
    // 恢复前取出（终审批实测：恢复后再读 = 恒空，断言假红）
    let calledDocIds: string[] = [];
    try {
      hits = await search('deployment');
      calledDocIds = spy.mock.calls.map((call) => call[0]);
    } finally {
      spy.mockRestore();
    }

    const tsHit = hits.find((h) => h.docId === DOCS.longTsRow.docId);
    const trgmHit = hits.find((h) => h.docId === DOCS.longTrgmRow.docId);
    expect(tsHit).toBeDefined();
    expect(trgmHit).toBeDefined();

    // 调用面：ts 行走 headline 通道；近形行**不得**走 headline（走的就是 trgm 窗口）
    expect(calledDocIds).toContain(DOCS.longTsRow.docId);
    expect(calledDocIds).not.toContain(DOCS.longTrgmRow.docId);

    // 产物面（可读判据）：trgm 窗口在长正文上两侧都被裁 ⇒ `…`（U+2026）；
    // ts_headline 通道不产 U+2026（若将来它也开始产，本断言会红——那是通道语义变更，须复核）
    expect(trgmHit?.snippet).toContain('…');
    expect(tsHit?.snippet).not.toContain('…');
  });
});
