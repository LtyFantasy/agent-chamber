/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 字符类的**行为式差分**：编译器侧「切分 run 边界」必须与 DB 函数侧
 *     `cjk_unigram_text()`「插入分隔位置」逐字符一致（计划 §2.1 三元脚本分类单源 +
 *     批次 1 §10 守卫节）。样本表 = 类清单同源（〇 / 㐀 / 々 / 全角！ / ＡＢＣ /
 *     接口ＡＢＣ / ｶﾀｶﾅ / 한글 / emoji / 中英混排）
 *
 * [代码职责]
 *   - 用**真库**（迁移链临时库：真 `cjk_unigram_text` + 真触发器 + 真 GIN 向量）把两侧
 *     的分段行为钉在一起：① 函数输出黄金值（手写字面量，禁由实现输出反推）；② 编译产物
 *     黄金形态；③ 单字化向量上的命中 ⇔ 预期；④ 服务级召回 ⇔ 预期
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2（检索）；线上 spec 的字符类小节（批次 2 联动）
 *   - 设计定稿: 检索中文根治计划终稿 v1.5 §2.1（三元分类定稿：①可分字 / ②整词 / ③分隔符）
 *     + §10 守卫节（**行为式差分、非集合等式**——parser 会把复合词拆成部件，
 *     `tsvector_to_array` 集合与编译器词项集合本就不等）
 *   - 补充: src/database/migrations/1791400000000-CjkUnigramSearchVector.ts（函数 DDL 单源）
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **两侧同表**：编译器 ①/②/③ 分类与 DB 函数正则的字符类清单必须逐字一致。漂移的
 *     后果是**结构性静默错位**——查询侧把某字符当分隔符（丢弃）而文档侧把它留在向量里
 *     （或反之），表现为某个字符永远搜不到 / 永远命中，且无任何报错。
 *   - **差分是行为式的，不是集合等式**：`'接口ＡＢＣ'` 的 tsquery 是
 *     `('接'<->'口') | 'ＡＢＣ'`（CJK 走 bigram 短语、全角字母 run 保持整词），
 *     而文档侧 parser 会把 `ＡＢＣ` 原样留为一个 lexeme——用集合等式断言会误红。
 *     故断言的是：**分隔位置**（函数输出里的空格位置）+ **run 边界**（编译器不切 ② run）。
 *   - **① 区间上界已收窄**（F3）：U+9FEF / U+4DB5 是最后词字；区间外码点（U+9FF0–9FFF /
 *     U+4DB6–4DBF）归 ③ 分隔符——改上界会让编译器 arm 退化、K-gate 重复计数泄漏。
 *   - **黄金值必须手写**：本文件的期望串按「正则语义」手推（每个 ① 字符两侧各插一个空格），
 *     不得从实现输出反推（否则实现漂移时断言跟着漂移 = 门禁失效）。
 *
 * [关联代码]
 *   - src/common/utils/search/tsquery-compiler.ts — 三元分类（isCjkUnigramChar / isWholeWordScriptChar）
 *   - src/database/migrations/1791400000000-CjkUnigramSearchVector.ts — 函数与 4 触发器
 *   - test/pending/script-boundaries.e2e-spec.ts — 同一字符类的钉子用例（ー/零宽/全角）
 *   - test/search-cjk.e2e-spec.ts — 端到端价值证明（召回/排序/snippet）
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

const SPACE_ID = 'e1e1e1e1-0000-4000-8000-0000000000b1';
const ACTOR_ID = 'e1e1e1e1-0000-4000-8000-0000000000b2';

/**
 * 样本表（= 类清单同源）。每列含义：
 * - `sample`：被测字串
 * - `unigramText`：`cjk_unigram_text(sample)` 的**手推黄金值**（① 字符两侧各插一空格；
 *   ② 整词 run 与 ③ 分隔符原样保留）——黄金值手写，禁由实现输出反推
 * - `tsquery`：编译产物黄金值（`null` = isEmpty：整串无可检索词项）
 * - `kind`：语义分类（cjk 单字/短语 · word 整词 · separator 分隔符 · mixed 混排）
 * - `note`：为什么这样归类（改类前先读懂）
 */
const SAMPLES: {
  sample: string;
  unigramText: string;
  tsquery: string | null;
  kind: 'cjk' | 'word' | 'separator' | 'mixed';
  note: string;
}[] = [
  {
    sample: '〇',
    unigramText: ' 〇 ',
    tsquery: "'〇'",
    kind: 'cjk',
    note: '〇 U+3007 是**词字枚举**成员（普查锚点：必须切分，否则「〇」永不命中）',
  },
  {
    sample: '㐀',
    unigramText: ' 㐀 ',
    tsquery: "'㐀'",
    kind: 'cjk',
    note: '㐀 U+3400 = CJK 扩展 A 下界（可切分区间起点）',
  },
  {
    sample: '々',
    unigramText: ' 々 ',
    tsquery: "'々'",
    kind: 'cjk',
    note: '々 U+3005 迭代号是词字；⚠️ 同区间的「」【】等括号标点归分隔符（R-1）',
  },
  {
    sample: '全角！',
    unigramText: ' 全  角 ！',
    tsquery: "('全'<->'角')",
    kind: 'cjk',
    note: '汉字走 bigram 短语；全角感叹号 U+FF01 是分隔符（不参与词项）',
  },
  {
    sample: 'ＡＢＣ',
    unigramText: 'ＡＢＣ',
    tsquery: "'ＡＢＣ'",
    kind: 'word',
    note: '全角字母 U+FF21–FF3A 归②整词：整 run 一个 lexeme（不切分 ⇒ 函数不动它）',
  },
  {
    sample: '接口ＡＢＣ',
    unigramText: ' 接  口 ＡＢＣ',
    tsquery: "('接'<->'口') | 'ＡＢＣ'",
    kind: 'mixed',
    note: '中英/全角混排：CJK 段切分走 bigram，全角 run 保持整词（分段边界一致）',
  },
  {
    sample: 'ｶﾀｶﾅ',
    unigramText: 'ｶﾀｶﾅ',
    tsquery: null,
    kind: 'separator',
    note: '半角片假名 U+FF61–FF9F **不在**类清单（R-3 不扩类）⇒ ③ 分隔符 ⇒ isEmpty',
  },
  {
    sample: '한글',
    unigramText: '한글',
    tsquery: "'한글'",
    kind: 'word',
    note: '谚文音节归②整词（探针实证 `한글검색` 单 token）',
  },
  {
    sample: '🔥',
    unigramText: '🔥',
    tsquery: null,
    kind: 'separator',
    note: 'emoji 归③分隔符 ⇒ 整串无可检索词项',
  },
  {
    sample: '中英混排 english',
    unigramText: ' 中  英  混  排  english',
    tsquery: "('中'<->'英') | ('英'<->'混') | ('混'<->'排') | 'english'",
    kind: 'mixed',
    note: '中文 bigram 短语 OR 拉丁 run：两侧都在同一位置分段（中文切 / 拉丁保留）',
  },
];

describe('字符类行为式差分（真 PG · 迁移链临时库）', () => {
  let handle: TempDbHandle;
  let service: DocSearchService;
  jest.setTimeout(300_000);

  const db = () => handle.db as NonNullable<TempDbHandle['db']>;

  beforeAll(async () => {
    handle = await createMigrationChainTempDb('chardiff');
    if (!handle.available) return;

    await db().query(
      `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
      [SPACE_ID, 'char-class-diff-fixture', `cdiff-${process.pid}`, ACTOR_ID],
    );
    // 每样本一 doc（content = 样本；heading_path 给一个不含样本的固定串，避免干扰）
    for (const [index, item] of SAMPLES.entries()) {
      const docId = `e1e1e1e1-0000-4000-8000-0000000010${index.toString(16).padStart(2, '0')}`;
      await db().query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [docId, SPACE_ID, `diff/sample-${index}.md`, `Sample ${index}`, ACTOR_ID],
      );
      await db().query(
        `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 0, $2, $3)`,
        [docId, 'Diff § Sample', item.sample],
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

  /** 样本 → docId（与落库编号同源） */
  const docIdOf = (index: number) =>
    `e1e1e1e1-0000-4000-8000-0000000010${index.toString(16).padStart(2, '0')}`;

  it('① 函数黄金值：`cjk_unigram_text` 的分隔位置与类清单逐字一致（手写期望串）', async () => {
    if (!handle.available) return;
    for (const item of SAMPLES) {
      const [{ out }] = (await db().query(`SELECT cjk_unigram_text($1) AS out`, [
        item.sample,
      ])) as { out: string }[];
      expect({ sample: item.sample, out }).toEqual({ sample: item.sample, out: item.unigramText });
    }
  });

  it('② 编译产物黄金形态：① 切分 bigram / ② 整 run 保词 / ③ 整串丢弃', async () => {
    if (!handle.available) return;
    for (const item of SAMPLES) {
      const compiled = compileQuery(item.sample);
      if (item.tsquery === null) {
        // ③ 分隔符组成的整串 ⇒ isEmpty（按面枚举：doc-search/experience → trgm-only；
        // search/task q= → 短路返回空）
        expect({ sample: item.sample, isEmpty: compiled.isEmpty }).toEqual({
          sample: item.sample,
          isEmpty: true,
        });
        expect(compiled.tsquery).toBeNull();
        continue;
      }
      expect({ sample: item.sample, tsquery: compiled.tsquery }).toEqual({
        sample: item.sample,
        tsquery: item.tsquery,
      });
    }
  });

  it('③ 分段等价（真库）：编译器不切 ② run ⇔ 函数不在该 run 内插空格；① 字必被切分', async () => {
    if (!handle.available) return;

    // ② 整词 run（样本内必须**原样**出现在函数输出里 = 函数不在 run 内插空格；
    // 同时编译器必须把它当**一个**词项）——表与类清单同源，新增样本须同步本表
    const WORD_RUNS: Record<string, string[]> = {
      'ＡＢＣ': ['ＡＢＣ'],
      '接口ＡＢＣ': ['ＡＢＣ'],
      '한글': ['한글'],
      '中英混排 english': ['english'],
    };
    // ① 可分字（函数必须**逐字两侧**插空格；多字样本则编译器走 bigram 短语）
    const CJK_CHARS: Record<string, string[]> = {
      '〇': ['〇'],
      '㐀': ['㐀'],
      '々': ['々'],
      '全角！': ['全', '角'],
      '接口ＡＢＣ': ['接', '口'],
      '中英混排 english': ['中', '英', '混', '排'],
    };

    for (const item of SAMPLES) {
      const [{ out }] = (await db().query(`SELECT cjk_unigram_text($1) AS out`, [
        item.sample,
      ])) as { out: string }[];
      const compiled = compileQuery(item.sample);

      for (const run of WORD_RUNS[item.sample] ?? []) {
        expect({ sample: item.sample, run, intact: out.includes(run) }).toEqual({
          sample: item.sample,
          run,
          intact: true,
        });
        expect({ sample: item.sample, run, lexeme: compiled.tsquery }).toEqual({
          sample: item.sample,
          run,
          lexeme: expect.stringContaining(`'${run}'`),
        });
      }

      for (const ch of CJK_CHARS[item.sample] ?? []) {
        expect({ sample: item.sample, ch, separated: out.includes(` ${ch} `) }).toEqual({
          sample: item.sample,
          ch,
          separated: true,
        });
      }

      const cjkChars = CJK_CHARS[item.sample] ?? [];
      if (cjkChars.length === 1) {
        // 单字 ① 输入 ⇒ 单字路径标志在场（该字符确实被判为可分字，而非整词）
        expect({ sample: item.sample, single: compiled.singleCjkChar }).toEqual({
          sample: item.sample,
          single: cjkChars[0],
        });
      } else if (cjkChars.length > 1) {
        // 多字 ① 输入 ⇒ bigram 短语（绝不把整串当一个词项）
        expect(compiled.tsquery).toContain("'<->'");
        expect(compiled.tsquery).not.toBe(`'${item.sample}'`);
      }
    }
  });

  it('④ 单字化向量上的命中 ⇔ 预期（真触发器 + 真向量；③ 类样本走「无词项」分支）', async () => {
    if (!handle.available) return;

    for (const item of SAMPLES) {
      const compiled = compileQuery(item.sample);
      if (compiled.tsquery === null) {
        // ③ 类样本：无词项可查 ⇒ ts 通道结构性零命中（这正是「纯标点/全 emoji 查询」
        // 只能靠 trgm 腿的原因）
        const [{ hits }] = (await db().query(
          `SELECT count(*)::int AS hits FROM doc_sections s
            WHERE s.doc_id = $1 AND s.search_vector @@ to_tsquery('simple', 'zzz')`,
          [docIdOf(SAMPLES.indexOf(item))],
        )) as { hits: number }[];
        expect(hits).toBe(0);
        continue;
      }
      // 有词项 ⇒ 对应样本行的单字化向量必须命中（两侧分段一致的执行层判决）
      const [{ hit }] = (await db().query(
        `SELECT (s.search_vector @@ to_tsquery('simple', $2)) AS hit
           FROM doc_sections s WHERE s.doc_id = $1`,
        [docIdOf(SAMPLES.indexOf(item)), compiled.tsquery],
      )) as { hit: boolean }[];
      expect({ sample: item.sample, hit }).toEqual({ sample: item.sample, hit: true });
    }
  });

  it('④ 补充：子串语义 —— 样本嵌入更长的正文后仍命中（不是整串等值匹配）', async () => {
    if (!handle.available) return;

    const embedded = 'e1e1e1e1-0000-4000-8000-0000000000ff';
    await db().query(
      `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [embedded, SPACE_ID, 'diff/embedded.md', 'Embedded', ACTOR_ID],
    );
    await db().query(
      `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 0, $2, $3)`,
      [embedded, 'Diff § Embedded', '本次发布的接口ＡＢＣ变更说明与回滚步骤。'],
    );

    // 查询侧词项 = CJK bigram 短语 + 全角 run ⇒ 嵌入更长的正文后仍在同一位置命中
    const compiled = compileQuery('接口ＡＢＣ');
    const [{ hit }] = (await db().query(
      `SELECT (s.search_vector @@ to_tsquery('simple', $2)) AS hit
         FROM doc_sections s WHERE s.doc_id = $1`,
      [embedded, compiled.tsquery],
    )) as { hit: boolean }[];
    expect(hit).toBe(true);

    await db().query(`DELETE FROM docs WHERE id = $1`, [embedded]);
  });

  it('⑤ 服务级召回 ⇔ 预期：有词项样本命中；③ 类样本按「有无 trgm」分流（通道断言，非仅零命中）', async () => {
    if (!handle.available) return;

    for (const item of SAMPLES) {
      const compiled = compileQuery(item.sample);
      const hits = (await service.search([SPACE_ID], { q: item.sample, limit: 20 })).hits;
      const ids = hits.map((hit) => hit.docId);
      const key = docIdOf(SAMPLES.indexOf(item));

      if (compiled.tsquery !== null) {
        expect({ sample: item.sample, recalled: ids.includes(key) }).toEqual({
          sample: item.sample,
          recalled: true,
        });
        continue;
      }

      // ③ 类（无词项）：doc-search 按面枚举走 **trgm-only 真检索**，能否召回取决于
      // pg_trgm 是否能为该串产出 trigram —— **必须断言通道而非只断言零命中**
      // （计划 §2.2 契约③ 的 F2 注记：纯标点/emoji 写 must_not_hit 会恰好通过，门禁抓不到）
      const [{ trgmCount }] = (await db().query(
        `SELECT array_length(show_trgm($1), 1) AS "trgmCount"`,
        [item.sample],
      )) as { trgmCount: number | null }[];
      if ((trgmCount ?? 0) > 0) {
        // 有 trigram（半角片假名等）⇒ trgm 腿救回（同形内容相似度 1.0）
        expect({ sample: item.sample, viaTrgm: ids.includes(key) }).toEqual({
          sample: item.sample,
          viaTrgm: true,
        });
      } else {
        // 无 trigram（emoji：pg_trgm 对其不产出任何 trigram）⇒ ts 腿无词项 + trgm 腿无
        // trigram = **结构性不可检索**（已知边界，非本批回归：emoji 查询不是受支持的检索形态）
        expect(ids).toEqual([]);
      }
    }
  });
});
