/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 检索的**索引化预过滤**正确性：预过滤必须是「合成分 ≥ SCORE_FLOOR」的
 *     召回超集（2026-09-25 生产实证 2128ms → 28ms 的那道谓词）；批次 1（中文根治）
 *     起预过滤 ts 分支 = **编译产物** `sv @@ to_tsquery('simple', :compiledQ)`，
 *     对照件因此改为**消费真编译器 + 真导出组**（不再手抄词项 OR 复刻件）
 *
 * [代码职责]
 *   - 在**迁移链临时库**（唯一同时具备两条既有 GIN 索引 + 新 heading GIN 索引 + 单字化
 *     触发器 + `cjk_unigram_text()` 的环境）上用真 SQL 钉死：
 *     ① 召回超集判决（同 fixture 上「无预过滤」与「有预过滤」返回同一 `docId#position`
 *     集合，**权重取活旋钮**）；② 三条反例 fixture 真的有牙（朴素形状必丢）；③ 阈值真生效；
 *     ④ 词形表驱动（编译器产物在真实单字化向量上命中）；⑤ indexdef 在场；
 *     ⑥ **四模式**口径（trgm-only / single-char / df-degraded / normal）各自的 SQL 形态；
 *     ⑦ 预过滤在场守卫（4 消费点枚举 + 无插值负面断言 + createQueryBuilder 调用序）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: src/modules/docspace/doc-search.service.ts — 四模式 SQL 形态与零召回损失证明
 *     （本套件是该证明在执行层的守卫）
 *   - 设计定稿: 检索中文根治计划终稿 v1.5 §2.2/§2.3/§2.5 + §10 守卫节
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **预过滤不改分数、不改排序**：`none`（无预过滤）与 `prefilter`（有预过滤）的
 *     `docId#position` 集合必须**完全相等**——预过滤只许缩小候选集，不许增删结果。
 *     ⚠️ 批次 1-b 起 K-gate 是**有意收窄**的结构门（≠ 预过滤：门会丢过地板的行），
 *     故等式只对「过门」的 fixture 成立——本套件用**独立空间**放会撞门的 fixture（⑫），
 *     主 fixture 表不出现「过地板但过不了门」的行，否则 ① 必红的根因会被误读成预过滤坏。
 *     ⚠️ v1.87 `%` 腿消融后本条对 **arms≥1（CJK）** 查询多一层隐含前提：候选 = ts-only ⇒
 *     主 fixture 表也不得出现「过地板、无 ts 命中、却能靠 trgm 腿进最终集」的行（否则
 *     ① 会真红——那是消融的**接受代价**而非 bug）。当前 fixture 表满足该前提（近形行一律
 *     靠 heading `%` 进集，且都是 arms=0 的 ASCII 查询）。
 *   - **`%` 腿按 arms 分两态**（v1.87 消融，⑪ 守形态）：arms≥1 ⇒ 两腿皆无；arms=0 ⇒
 *     删 content 腿、留 heading 腿。镜像件（`buildMirrorQuery` / `evidence`）的谓词必须
 *     与服务**同态**，否则 ① 的集合相等断言会因为"镜像比服务宽"而假红。
 *   - **对照件的权重必须读活旋钮**：合成分 = `cd × SEARCH_TS_W1 + sim_content × TRGM_CONTENT
 *     + sim_heading × SEARCH_TRGM_HEADING_W`。直读 `RANK_WEIGHTS.TS_RANK/TRGM_HEADING`
 *     （1.0/0.8，**两成员已于 v1.87 删除**）会让对照件的**地板命中集**≠ 服务的，于是 ①
 *     看起来像"预过滤改变了结果"，实为两侧尺度不同（1-d1 实测：W1=3/headingW=0.5 时必红）。
 *   - **对照件的谓词必须来自真导出组**：ts 两处（score / prefilter）与 K-gate 一律取
 *     `buildSearchSql()` 的产物。手抄 = 迟早漂移。
 *   - **fixture 的 ts 命中前提已随单字化反转**：`search_vector` 含 `heading_path`
 *     （migration `1785326619653:211-213`）且 CJK 逐字切分（`1791400000000`）⇒
 *     旧「CJK 整串 = 1 token 故 heading 不 ts 命中」的 fixture 前提**不再成立**。
 *     故 heading `%` 唯一救主 / 阈值带两条反例改用 **ASCII 近形**（`Dep1oyment` /
 *     `the dep1oyment pipeline notes`）——近形不产生 ts 命中而 trgm 相似度够高，
 *     前提可复现且语义与旧用例同（数值实测见各 fixture 注释）。**v1.87 起阈值带的近形
 *     落在 heading 上**（content `%` 腿已消融，原版落在 content 的用例必红）。
 *   - **阈值必须经连接级 options 下发为 0.05**（src/database/pg-session-defaults.ts）：
 *     本套件克隆 AppDataSource.options 建临时库，故 `current_setting` 断言同时守卫
 *     「阈值常量」与「连接级下发」两件事。
 *   - **不得断言执行计划形状**（BitmapOr / Seq Scan）：小 fixture 表下 planner 必走
 *     Seq Scan，那是脆弱用例；索引在场的守卫走 pg_indexes.indexdef。
 *   - **ts 腿一律 `to_tsquery('simple', :param)` 包裹**（1-b tsqueryin 原子语义防线）：
 *     裸绑定/`::tsquery` cast 走 tsqueryin = 保大小写、不拆元语法的原子词位语义，
 *     与文档侧 parser 分词错位（`'Hello'`/`a&b`/`ＡＢＣ` 零命中回归）。
 *
 * [关联代码]
 *   - src/modules/docspace/doc-search.service.ts — 被验证的实现（四模式 SQL）
 *   - src/common/utils/search/tsquery-compiler.ts — 编译产物（本套件对照件的输入）
 *   - src/common/utils/search/search-sql.ts — 导出组（score/prefilter/headline/kGate 单源）
 *   - src/common/utils/search/search-tuning.ts — 活旋钮（W1 / heading 权重 / K 覆盖）
 *   - src/database/pg-session-defaults.ts — 阈值单源（连接级下发）
 *   - test/migration-drift.e2e-spec.ts — 本套件的临时库装配范式来源（TEST_DB_* + runMigrations）
 *
 * [持久踩坑]
 *   - DOCSEARCH-E2E-TEMPDB(为何必须临时库): dev 库的 doc_sections **缺两条既有 GIN 索引**
 *     （`idx_doc_sections_content_trgm` / `idx_doc_sections_search_vector`）——该库不是迁移链
 *     产物，这两条 CREATE INDEX 从未在它上面跑过。安全方向: 临时库 + runMigrations()。
 *   - DOCSEARCH-E2E-FLOOR(地板与尺度): 单 token 精确匹配的 `ts_rank` ≈ 0.06 **低于**地板
 *     0.08；换 `ts_rank_cd` + W1 后单次命中 ≈ 0.1×W1。设计 fixture 时必须同时算三项
 *     （cd×W1 / content trgm×0.6 / heading trgm×活权重），别只算一项。
 *   - DOCSEARCH-E2E-QBORDER(createQueryBuilder 调用序，批次 1-b 起)：
 *     **df 预检（typed QB `createQueryBuilder('s')`）占第 0 位**——normal 模式下一次
 *     `service.search()` 的 QueryBuilder 序列前两位 = [df 预检, 检索主查询]（其后还有
 *     boost 两路与 snippet 查询，数量随实现变化，故**不得断言总数**）。在场守卫按
 *     「SQL 特征挑选 + 前两位调用序断言」定位主查询。
 *   - DOCSEARCH-E2E-PARAMS(位置参数纪律): TypeORM `DataSource.query()` **不做命名参数替换**
 *     （裸 `:name` 原样直发 node-postgres ⇒ 42601），而位置参数必须**编号连续且逐个被引用**
 *     （多送一个 ⇒ "bind message supplies N parameters"；$1 未被引用 ⇒ "could not
 *     determine data type of parameter $1"）。故对照件用**符号占位 `@name` 构建 + 末位
 *     按首次出现重编号**，只下发真正被引用的参数。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

/**
 * DocSpace 检索预过滤 —— 真实 PG 端到端套件（真库 + 真迁移链 + 真索引 + 真编译器）
 *
 * 为什么不是 mock：本改动的全部风险都在 SQL 语义与索引/阈值上——编译产物与文档侧
 * parser 的错位、`%` 算子的会话阈值、GIN 索引是否真的建在裸列上、NULL heading_path
 * 的三值逻辑、K-gate 的收窄边界——mock 仓储对这些**一律测不出**（铁律 #23）。
 *
 * 为什么是**临时库**：见文件头 DOCSEARCH-E2E-TEMPDB。
 *
 * 装配：维护连接 CREATE DATABASE → 克隆 data-source.ts 的 options 指到临时库
 * → runMigrations() → 直接用临时库仓储手工 new DocSearchService（真 SQL、真索引）。
 * 不启 Nest app：本改动的契约层（HTTP/DTO）未被触碰，docspace.e2e-spec.ts 已覆盖。
 */
import { DataSource, type DataSourceOptions } from 'typeorm';
import { AppDataSource } from '../src/database/data-source';
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
import { AddDocSectionHeadingPathTrgmIndex1791000000000 } from '../src/database/migrations/1791000000000-AddDocSectionHeadingPathTrgmIndex';
import { compileQuery, type CompiledQuery } from '../src/common/utils/search/tsquery-compiler';
import {
  buildSearchSql,
  COMPILED_Q_PARAM,
  K_GATE_K_PARAM,
  K_GATE_ARM_PARAM_PREFIX,
} from '../src/common/utils/search/search-sql';
import {
  SEARCH_KGATE_K_OVERRIDE,
  SEARCH_TRGM_HEADING_W,
  SEARCH_TS_W1,
} from '../src/common/utils/search/search-tuning';
import { DOC_SEARCH_POSITIONAL_ORDER_HINT } from '@agent-chamber/shared';

/** 本地开发库连接（既有真 PG e2e 的 TEST_DB_* 覆盖约定；禁止在此写死生产凭据） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 维护库：PG 不允许在目标库内部 CREATE/DROP 自己，故建库/删库连一个"别的"库 */
const MAINTENANCE_DB = process.env.TEST_DB_MAINTENANCE_DATABASE ?? 'postgres';

/** 临时库名（全局资源，带 pid + base36 时间戳防并行/残留撞名） */
const TEMP_DB_NAME = `docsearch_tmp_${process.pid}_${Date.now().toString(36)}`;

/** PG 默认相似度阈值（反例对照用：朴素形状的历史阈值） */
const PG_DEFAULT_TRGM_THRESHOLD = 0.3;

/** 服务端 limit 上限（本套件 fixture 远少于它，故「无预过滤」对照查询也用同值，集合才可比） */
const COMPARE_LIMIT = 20;

// ─── fixture 标识（固定字面量 uuid：断言可读、失败信息可定位） ────────────────
const SPACE_ID = 'a0000000-0000-4000-8000-000000000001';
const ACTOR_ID = 'a0000000-0000-4000-8000-0000000000ff';

/**
 * **K-gate 专用空间**：放「过地板但过不了门」的行。
 * 与主 fixture 空间隔离的原因见文件头 [关键不变量]——这类行会让 ① 的等式红，
 * 而根因是门（有意收窄）而非预过滤（不许增删）。
 */
const GATE_SPACE_ID = 'b0000000-0000-4000-8000-000000000001';

/**
 * fixture 表 —— 每条 = 一个 doc + 一个 section（预过滤的最小可比单元）
 *
 * 设计意图（每条对应 [关键不变量] 里的一条）：
 * - longPartial：**ts 部分命中反例**（ASCII）。长正文含 alpha/beta 而无 zzz ⇒
 *   编译产物 `'alpha' | 'beta' | 'zzz'` 命中、`@@ plainto_tsquery`（AND）为 false
 *   ⇒ 朴素形状必丢、OR 预过滤必留。
 * - headingOnlyNearMiss：**heading `%` 分支的唯一救主**。heading 是查询的近形
 *   （`Dep1oyment` vs `deployment`：trgm 0.571 过阈、**ts 不命中**），content 与查询
 *   基本无关（trgm 0.024 < 0.05 ⇒ content `%` 也不真）⇒ 只有 heading `%` 能放它进来。
 *   ⚠️ 旧用例用 CJK（「端口映射失效排查笔记」）的前提已被单字化反转（heading 也进 ts
 *   腿且逐字切分 ⇒ ts 命中恒 true），故改 ASCII 近形复现同一前提。
 * - thresholdBand：**阈值带反例**。近形落在 **heading** 上（`the dep1oyment pipeline notes`
 *   vs `deployment`：heading trgm ≈ 0.2424 ∈ (0.05, 0.3)、**无 ts 命中**）⇒ 阈值 0.3 下必被
 *   丢、0.05 下必留（其合成分 ≈ 0.5×0.2424 = 0.121 > 地板 0.08）。
 *   ⚠️ v1.87：近形原本在 **content**（救主是 content `%` 腿）——该腿消融后本用例必红，
 *   故把近形搬到**保留腿** heading 上（语义不变：0.05 留 / 0.3 丢；数值同值 0.2424）；
 *   content 换成与查询无关的文本（sim 0.019 < 0.05），否则"heading 唯一救主"前提不成立。
 * - partialCjk：**CJK 部分命中**。正文只覆盖查询 7 个 bigram 中的 3 个 ⇒ cd 命中但
 *   `@@ plainto_tsquery` 结构性不命中（查询侧未单字化）。
 * - noise：**双双零命中**的纯噪音（预过滤与地板都不许放它进来）。
 * - word*：词形表 fixtures（连字符 / 加号 / 撇号 / 纯 CJK / 中英混排 / 引号 URL）。
 */
const FIXTURES = {
  longPartial: {
    docId: 'a0000000-0000-4000-8000-000000000101',
    path: 'fixtures/long-partial.md',
    title: 'Long Partial ASCII',
    headingPath: 'Notes § Misc',
    content:
      'alpha beta are two stages of the deployment pipeline; the remaining stages are gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.',
  },
  headingOnlyNearMiss: {
    docId: 'a0000000-0000-4000-8000-000000000102',
    path: 'fixtures/heading-only-near-miss.md',
    title: 'Heading Only Near Miss',
    headingPath: 'Dep1oyment',
    content: 'Quarterly budget review notes about travel reimbursements and office supplies.',
  },
  thresholdBand: {
    docId: 'a0000000-0000-4000-8000-000000000103',
    path: 'fixtures/threshold-band.md',
    title: 'Threshold Band',
    // v1.87：近形从 content 搬到**保留腿** heading（content `%` 腿已消融）——
    // trgm 0.2424 ∈ (0.05, 0.3)；content 换成与查询无关的文本（sim 0.019）以保「唯一救主」前提
    headingPath: 'the dep1oyment pipeline notes',
    content: 'Weekly inventory reconciliation checklist.',
  },
  partialCjk: {
    docId: 'a0000000-0000-4000-8000-00000000010c',
    path: 'fixtures/partial-cjk.md',
    title: 'Partial CJK',
    headingPath: 'Ops § Partial',
    content: '端口映射与运维手册',
  },
  noise: {
    docId: 'a0000000-0000-4000-8000-000000000104',
    path: 'fixtures/noise.md',
    title: 'Noise',
    headingPath: 'Budget § Travel',
    content: 'Quarterly budget review notes about travel reimbursements and office supplies.',
  },
  wordFooBar: {
    docId: 'a0000000-0000-4000-8000-000000000105',
    path: 'fixtures/word-foo-bar.md',
    title: 'Word Form Hyphen',
    headingPath: 'Word Forms § Hyphen',
    content: 'foo-bar is the config key name',
  },
  wordReadOnly: {
    docId: 'a0000000-0000-4000-8000-000000000106',
    path: 'fixtures/word-read-only.md',
    title: 'Word Form Readonly',
    headingPath: 'Word Forms § Readonly',
    content: 'read-only mode flag',
  },
  wordCpp: {
    docId: 'a0000000-0000-4000-8000-000000000107',
    path: 'fixtures/word-cpp.md',
    title: 'Word Form Plus',
    headingPath: 'Word Forms § Cpp',
    content: 'c++ bindings for the sdk',
  },
  wordApostrophe: {
    docId: 'a0000000-0000-4000-8000-000000000108',
    path: 'fixtures/word-apostrophe.md',
    title: 'Word Form Apostrophe',
    headingPath: 'Word Forms § Apostrophe',
    content: "it's fine to retry",
  },
  wordCjk: {
    docId: 'a0000000-0000-4000-8000-000000000109',
    path: 'fixtures/word-cjk.md',
    title: 'Word Form CJK',
    headingPath: 'Word Forms § Cjk',
    content: '端口映射失效排查',
  },
  wordMixed: {
    docId: 'a0000000-0000-4000-8000-00000000010a',
    path: 'fixtures/word-mixed.md',
    title: 'Word Form Mixed',
    headingPath: 'Word Forms § Mixed',
    content: '中文 english 混排示例',
  },
  wordQuotedUrl: {
    docId: 'a0000000-0000-4000-8000-00000000010b',
    path: 'fixtures/word-quoted-url.md',
    title: 'Word Form Quoted URL',
    headingPath: 'Word Forms § Url',
    content: "see http://a.com/?q='x' here",
  },
} as const;

/** K-gate 专用 fixture（独立空间，不进 ① 的对照面） */
const GATE_FIXTURES = {
  /** 只命中 1 个 bigram（端-口）⇒ K=2 门下被拒；但 cd 命中 ×W1 = 0.3 过地板 */
  singleArmCjk: {
    docId: 'b0000000-0000-4000-8000-000000000101',
    path: 'fixtures/gate-single-arm.md',
    title: 'Gate Single Arm',
    headingPath: 'Ops § Gate',
    content: '端口与运维手册',
  },
  /** 命中 3 个 bigram ⇒ 过门（同一查询下的对照） */
  multiArmCjk: {
    docId: 'b0000000-0000-4000-8000-000000000102',
    path: 'fixtures/gate-multi-arm.md',
    title: 'Gate Multi Arm',
    headingPath: 'Ops § Gate',
    content: '端口映射与运维手册',
  },
} as const;

type Fixture =
  | (typeof FIXTURES)[keyof typeof FIXTURES]
  | (typeof GATE_FIXTURES)[keyof typeof GATE_FIXTURES];

/** 集合判决用例表：每条 = 一个查询 + 该查询下"必须被召回"的 fixture（防两侧都空而假绿） */
const QUERY_CASES: { q: string; mustInclude: Fixture[]; note: string }[] = [
  {
    q: 'alpha beta zzz',
    mustInclude: [FIXTURES.longPartial],
    note: 'ts 部分命中反例（@@ plainto_tsquery 为 false，编译产物 OR 命中）',
  },
  {
    q: 'deployment',
    mustInclude: [FIXTURES.headingOnlyNearMiss, FIXTURES.thresholdBand],
    note: 'ASCII 近形：heading % 唯一救主 + 阈值带命中',
  },
  {
    q: '端口映射失效排查',
    mustInclude: [FIXTURES.wordCjk, FIXTURES.partialCjk],
    note: 'CJK 精确命中 + CJK 部分命中（3/7 bigram，过门）',
  },
  {
    q: 'foo-bar',
    mustInclude: [FIXTURES.wordFooBar],
    note: '连字符词项（to_tsquery 再解析为短语链）',
  },
  { q: 'read-only', mustInclude: [FIXTURES.wordReadOnly], note: '连字符词项（第二形态）' },
  { q: 'c++', mustInclude: [FIXTURES.wordCpp], note: '加号词项（parser 把词位拆成 c）' },
  { q: "it's", mustInclude: [FIXTURES.wordApostrophe], note: '撇号词项（拆成 it / s）' },
  {
    q: '混排 english',
    mustInclude: [FIXTURES.wordMixed],
    note: '中英混排（bigram 短语 OR 单字词项）',
  },
  {
    q: "http://a.com/?q='x'",
    mustInclude: [FIXTURES.wordQuotedUrl],
    note: '引号 URL 词形（词位含单引号，再解析成短语链）',
  },
  {
    q: 'zzz-nonexistent-term-xyz',
    mustInclude: [],
    note: '零命中查询：两侧都必须为空（noise 不许被放进来）',
  },
];

/** 词形表驱动用例：查询词形 → 含该词形的正文（断言编译产物在真实单字化向量上命中） */
const WORD_FORM_CASES: { q: string; text: string; note: string }[] = [
  { q: 'foo-bar', text: 'foo-bar', note: '连字符：部件位置紧跟复合词，短语链命中' },
  { q: 'read-only', text: 'read-only mode', note: '连字符（第二形态）' },
  { q: 'c++', text: 'c++ bindings', note: '加号：词位退化为 c' },
  { q: "it's", text: "it's fine", note: '撇号：拆成 it / s 两个词项' },
  {
    q: '端口映射失效排查',
    text: '端口映射失效排查',
    note: '纯 CJK：bigram 短语在单字化向量上命中',
  },
  { q: '混排 english', text: '中文 english 混排示例', note: '中英混排：短语 OR 词项覆盖' },
  {
    q: "http://a.com/?q='x'",
    text: "see http://a.com/?q='x' here",
    note: '引号 URL：词位含单引号；再解析成短语链后仍在单字化向量上命中',
  },
  {
    q: 'JUDGMENT_CAPABILITIES',
    text: 'env key JUDGMENT_CAPABILITIES must be set',
    note: '下划线：`_` 在词元白名单内 ⇒ 整串一个 run，不得拆成 JUDGMENT / CAPABILITIES（拆开 = 丢 lexeme）',
  },
  {
    q: 'ECONNREFUSED',
    text: 'connect ECONNREFUSED 127.0.0.1:8743',
    note: '全大写标识符：`simple` 小写化在两侧对称发生（白名单另含 A–Z 是承重项）',
  },
  {
    q: 'race.service.ts:92',
    text: 'at race.service.ts:92 (compiled)',
    note: '点分（`.`/`:` 均在白名单）⇒ 查询侧一个 run、文档侧同一 tokenizer 再分词，双侧对齐',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 对照件（mirror）：消费真编译器 + 真导出组，只切换预过滤/门的组合
// ═══════════════════════════════════════════════════════════════════════════

/** 四模式口径（与服务 resolveMode 的裁决面一致；`degraded` = single-char ∪ df-degraded） */
type MirrorMode = 'normal' | 'trgm-only' | 'degraded';

/** 对照臂：none = 无预过滤 / prefilter = 有预过滤 / gated = 预过滤 + K-gate / naive = 被否形状 */
type MirrorArm = 'none' | 'prefilter' | 'gated' | 'naive';

/**
 * 符号占位（`@name`）——构建期只用符号，末尾按**首次出现顺序**重编号为 `$1..$n` 并收集
 * 参数值（见文件头 DOCSEARCH-E2E-PARAMS：位置参数必须连续且逐个被引用）。 */
const T_Q = '@q';
const T_SPACE = '@space';
const T_FLOOR = '@floor';
const T_COMPILED_Q = '@compiledQ';

/** 导出组的命名参数 → 符号占位（**只替换已知名**，避开 `::int` cast 的 `:int` 假匹配） */
function bindNamedParams(expr: string, armCount: number): string {
  let out = expr.split(`:${COMPILED_Q_PARAM}`).join(T_COMPILED_Q);
  for (let i = 0; i < armCount; i += 1) {
    out = out.split(`:arm${i + 1}`).join(`@arm${i + 1}`);
  }
  out = out.split(':kGateK').join('@kGateK');
  // 防漏绑：残留命名占位一律抛（新增导出组参数名而忘记映射 = 把 `:name` 原样发给 PG）
  const leftover = out.match(/(?<!:):([A-Za-z_]\w*)/);
  if (leftover !== null) {
    throw new Error(`bindNamedParams: unbound named parameter ${leftover[0]}`);
  }
  return out;
}

/** 符号占位 → 位置参数 + 值数组（首次出现即编号；未被引用的符号不下发） */
function finalizeParams(
  sql: string,
  values: Record<string, string | number>,
): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [];
  const assigned = new Map<string, number>();
  const text = sql.replace(/@([A-Za-z_]\w*)/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`finalizeParams: no value bound for @${name}`);
    let index = assigned.get(name);
    if (index === undefined) {
      params.push(values[name]);
      index = params.length;
      assigned.set(name, index);
    }
    return `$${index}`;
  });
  return { sql: text, params };
}

/**
 * 合成分表达式（**权重取活旋钮**，见文件头 [关键不变量]）。
 * - normal：`cd × SEARCH_TS_W1 + sim_content × TRGM_CONTENT + sim_heading × SEARCH_TRGM_HEADING_W`
 * - trgm-only：去 ts 腿（该模式 ts 项恒 0）
 * - degraded：常数分（绕开逐行打分，全行同分）
 */
function compositeScore(alias: string, mode: MirrorMode): string {
  if (mode === 'degraded') return `(${SINGLE_CHAR_CONST_SCORE})`;
  const trgm =
    `${alias}.trgm_content_score * ${RANK_WEIGHTS.TRGM_CONTENT}` +
    ` + ${alias}.trgm_heading_score * ${SEARCH_TRGM_HEADING_W}`;
  return mode === 'trgm-only'
    ? `(${trgm})`
    : `(${alias}.ts_rank_score * ${SEARCH_TS_W1} + ${trgm})`;
}

/**
 * 构建对照查询（复刻 DocSearchService 的 SQL 形状，只切换预过滤谓词 / 门的组合）。
 *
 * ts 两处与 K-gate 一律取 `buildSearchSql()` 产物（**副本↔生产谓词一致性**由构造保证）；
 * trgm-only 模式不建导出组（与服务 `group = null` 同款——该模式本就不用 ts 段）。
 */
function buildMirrorQuery(
  mode: MirrorMode,
  arm: MirrorArm,
  q: string,
  spaceId: string,
): { sql: string; params: (string | number)[] } {
  const compiled: CompiledQuery | null = mode === 'trgm-only' ? null : compileQuery(q);
  if (compiled !== null && compiled.tsquery === null) {
    throw new Error(`buildMirrorQuery: "${q}" 是 isEmpty 查询（只允许走 trgm-only 模式）`);
  }

  const group =
    compiled === null
      ? null
      : buildSearchSql(
          { vector: 's.search_vector', text: 's.content' },
          compiled,
          { startSel: '', stopSel: '' },
          SEARCH_KGATE_K_OVERRIDE,
        );
  const armTexts = compiled?.arms ?? [];
  if (group === null && mode !== 'trgm-only') {
    throw new Error('buildMirrorQuery: 导出组为空（编译产物缺失）');
  }

  const tsScore = group === null ? '' : bindNamedParams(group.scoreExpr, armTexts.length);
  const tsPrefilter = group === null ? '' : bindNamedParams(group.prefilterExpr, armTexts.length);
  const kGate =
    group === null || group.kGateExpr === null
      ? null
      : bindNamedParams(group.kGateExpr, armTexts.length);

  // 模式分支：打分三列 + 预过滤谓词（与服务 buildScoredQuery 的模式分支一一对应）
  // ⚠️ v1.87 `%` 腿消融：normal 的 prefilter 谓词**按 arms 分两态**——arms≥1 ⇒ ts-only，
  // arms=0 ⇒ ts OR 仅 heading `%`（content `%` 腿已删）。镜像件必须同源，否则 ① 的集合
  // 相等断言会因为"镜像比服务宽"而假红。
  const degraded = mode === 'degraded';
  const normalAblatedPrefilter =
    armTexts.length > 0 ? tsPrefilter : `(${tsPrefilter} OR s.heading_path % ${T_Q})`;
  const tsColumns = degraded
    ? '1 AS ts_rank_score, 0 AS trgm_content_score, 0 AS trgm_heading_score'
    : mode === 'trgm-only'
      ? `0 AS ts_rank_score,
             similarity(s.content, ${T_Q}) AS trgm_content_score,
             similarity(COALESCE(s.heading_path, ''), ${T_Q}) AS trgm_heading_score`
      : `COALESCE(${tsScore}, 0) AS ts_rank_score,
             similarity(s.content, ${T_Q}) AS trgm_content_score,
             similarity(COALESCE(s.heading_path, ''), ${T_Q}) AS trgm_heading_score`;

  const prefilter =
    arm === 'none'
      ? ''
      : arm === 'naive'
        ? ` AND (s.search_vector @@ plainto_tsquery('simple', ${T_Q})` +
          ` OR similarity(s.content, ${T_Q}) >= ${PG_DEFAULT_TRGM_THRESHOLD}` +
          ` OR similarity(COALESCE(s.heading_path, ''), ${T_Q}) >= ${PG_DEFAULT_TRGM_THRESHOLD})`
        : degraded
          ? ` AND ${tsPrefilter}`
          : mode === 'trgm-only'
            ? ` AND (s.content % ${T_Q} OR s.heading_path % ${T_Q})`
            : ` AND ${normalAblatedPrefilter}`;

  const gate = arm === 'gated' && kGate !== null && mode === 'normal' ? ` AND ${kGate}` : '';

  // 降级模式排序 = `section_position ASC, doc_id ASC`（双键不变量，计划 §2.5）
  const orderBy = degraded
    ? 'ORDER BY sub.section_position ASC, sub.doc_id ASC'
    : 'ORDER BY score DESC, sub.section_position ASC';

  const sql = `
    SELECT sub.doc_id, sub.section_position, ${compositeScore('sub', mode)} AS score
    FROM (
      SELECT d.id AS doc_id, d.path AS doc_path, d.title AS doc_title,
             d.created_at AS doc_created_at, s.position AS section_position,
             s.heading_path AS heading_path, s.content AS section_content,
             ${tsColumns}
      FROM doc_sections s
      INNER JOIN docs d ON d.id = s.doc_id
      LEFT JOIN doc_categories dc ON dc.id = d.category_id
      WHERE d.deleted_at IS NULL AND d.space_id = ${T_SPACE}${prefilter}${gate}
    ) sub
    WHERE ${compositeScore('sub', mode)} > ${T_FLOOR}
    ${orderBy}
    LIMIT ${COMPARE_LIMIT}
  `;

  // 参数值单源 = 导出组自己产出的 kGateParams（K 由 chooseKGateK 按 CJK 字数裁决，
  // 缺省规则 ≤4 字 K=1 / 更长 K=2）+ 消费方绑定的 compiled 产物。
  // ⚠️ 不得用 armTexts.length 当 K（那是 arm 数，不是门限——写错会让门恒不可达）
  const groupParams = group?.kGateParams ?? {};
  return finalizeParams(sql, {
    q,
    space: spaceId,
    floor: SCORE_FLOOR,
    compiledQ: compiled?.tsquery ?? '',
    kGateK: (groupParams[K_GATE_K_PARAM] as number | undefined) ?? 0,
    ...Object.fromEntries(
      armTexts.map((text, i) => [
        `${K_GATE_ARM_PARAM_PREFIX}${i + 1}`,
        (groupParams[`${K_GATE_ARM_PARAM_PREFIX}${i + 1}`] as string | undefined) ?? text,
      ]),
    ),
  });
}

/** 单行 fixture 的逐项 SQL 证据（对 fixture 的**唯一 section** 取） */
interface RowEvidence {
  /** 编译产物在**单字化向量**上的命中（服务 ts 通道的真实判据） */
  ts_compiled_hit: boolean;
  /** 朴素形状的 ts 判据（`@@ plainto_tsquery` 全词 AND） */
  ts_and_hit: boolean;
  content_sim: number;
  heading_sim: number;
  content_pct: boolean | null;
  heading_pct: boolean | null;
  prefilter_admit: boolean;
  composite: number;
}

describe('DocSpace 检索预过滤 — 真实 PG（迁移链临时库 + 真编译器）', () => {
  /** 维护连接：只做 CREATE/DROP DATABASE */
  let adminDs: DataSource;
  /** 临时库连接：跑全链迁移（故三条 GIN 索引 + 单字化触发器 + cjk_unigram_text 都在场） */
  let db: DataSource;
  /** 临时库是否已建出来（决定 afterAll 是否要 drop） */
  let tempDbCreated = false;
  /** PG 不可达（降级跳过；**建库/迁移失败不跳过**，与 migration-drift 同口径） */
  let dbAvailable = false;
  /** 被测服务（手工装配：真仓储 + 真 SQL，不启 Nest app） */
  let service: DocSearchService;

  jest.setTimeout(300_000);

  /** 查询 → 编译产物（一次编译，对照件与服务共用同一产物） */
  const compiledFor = (q: string): CompiledQuery => {
    const compiled = compileQuery(q);
    if (compiled.tsquery === null) throw new Error(`compiledFor: "${q}" 是 isEmpty 查询`);
    return compiled;
  };

  /** 跑对照查询，返回 `${docId}#${position}` 排序集合 */
  const mirrorKeys = async (
    mode: MirrorMode,
    arm: MirrorArm,
    q: string,
    spaceId: string = SPACE_ID,
  ): Promise<string[]> => {
    const { sql, params } = buildMirrorQuery(mode, arm, q, spaceId);
    const rows = (await db.query(sql, params)) as {
      doc_id: string;
      section_position: number;
    }[];
    return rows.map((r) => `${r.doc_id}#${r.section_position}`).sort();
  };

  /** 走被测服务的真实入口（四模式裁决 + 预过滤 + 地板 + 门 + boost 融合全链路） */
  const serviceKeys = async (q: string, spaceId: string = SPACE_ID): Promise<string[]> => {
    // 信封契约（主脑裁决 #1）：service.search 返回 `{ hits, hint? }`
    const { hits } = await service.search([spaceId], { q, limit: COMPARE_LIMIT });
    return hits.map((h) => `${h.docId}#${h.position}`).sort();
  };

  /** 单行 fixture 的逐项证据（编译产物走绑定参数，与实现对同一消费形态） */
  const evidence = async (fixture: Fixture, q: string): Promise<RowEvidence> => {
    const compiled = compiledFor(q);
    // 服务实际预过滤谓词（v1.87 `%` 腿消融后按 arms 分两态）——证据行的 `prefilter_admit`
    // 必须与生产谓词同源，否则 ②③④ 的「必须放行 / 必须拒绝」会用错判据。
    const prefilterAdmit =
      compiled.arms.length > 0
        ? `s.search_vector @@ to_tsquery('simple', $3)`
        : `(s.search_vector @@ to_tsquery('simple', $3) OR s.heading_path % $2)`;
    const rows = (await db.query(
      `
      SELECT
        (s.search_vector @@ to_tsquery('simple', $3)) AS ts_compiled_hit,
        (s.search_vector @@ plainto_tsquery('simple', $2)) AS ts_and_hit,
        similarity(s.content, $2) AS content_sim,
        similarity(COALESCE(s.heading_path, ''), $2) AS heading_sim,
        (s.content % $2) AS content_pct,
        (s.heading_path % $2) AS heading_pct,
        (${prefilterAdmit}) AS prefilter_admit,
        (COALESCE(ts_rank_cd(s.search_vector, to_tsquery('simple', $3)), 0) * ${SEARCH_TS_W1}
         + similarity(s.content, $2) * ${RANK_WEIGHTS.TRGM_CONTENT}
         + similarity(COALESCE(s.heading_path, ''), $2) * ${SEARCH_TRGM_HEADING_W}) AS composite
      FROM doc_sections s
      WHERE s.doc_id = $1
      `,
      [fixture.docId, q, compiled.tsquery],
    )) as RowEvidence[];
    expect(rows.length).toBe(1);
    return rows[0];
  };

  /** 捕获一次 `service.search()` 产出的全部 QueryBuilder SQL（顺序 = 调用序） */
  const captureSqls = async (q: string, spaceId: string = SPACE_ID): Promise<string[]> => {
    const created: { getSql: () => string }[] = [];
    const manager = db.manager;
    const original = manager.createQueryBuilder.bind(manager);
    const spy = jest
      .spyOn(manager, 'createQueryBuilder')
      .mockImplementation((...args: unknown[]) => {
        const qb = (original as (...a: unknown[]) => { getSql: () => string })(...args);
        created.push(qb);
        return qb as never;
      });
    try {
      await service.search([spaceId], { q });
    } finally {
      spy.mockRestore();
    }
    return created.map((qb) => qb.getSql());
  };

  /**
   * 定位「检索主查询」SQL：normal 模式前两位 = [df 预检, 主查询]；降级/trgm-only 无 df 预检
   * ⇒ 主查询在第 0 位（文件头 DOCSEARCH-E2E-QBORDER）。其后还有 boost 两路与 snippet，
   * 数量随实现变化，故只断言前两位调用序，不做总数断言。
   */
  const pickMainSql = (sqls: string[], mode: MirrorMode): string => {
    if (mode === 'normal') {
      expect(sqls[0]).toContain('count(*)'); // df 预检占第 0 位
      expect(sqls[0]).toContain("@@ to_tsquery('simple'");
      expect(sqls[1]).toContain('similarity(');
      return sqls[1];
    }
    expect(sqls[0]).not.toContain('count(*)'); // 单字/df 降级在 df 预检前短路
    return sqls[0];
  };

  beforeAll(async () => {
    adminDs = new DataSource({
      ...(AppDataSource.options as DataSourceOptions),
      name: 'doc-search-prefilter-admin',
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
      console.warn(
        `[doc-search-prefilter e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }

    // 建库失败**不降级跳过**：PG 可达却建不出库 = 角色缺 CREATEDB，静默跳过等于这道门禁消失
    try {
      await adminDs.query(`CREATE DATABASE "${TEMP_DB_NAME}"`);
      tempDbCreated = true;
    } catch (err) {
      throw new Error(
        `[doc-search-prefilter e2e] 无法创建临时库 "${TEMP_DB_NAME}"：${(err as Error).message}\n` +
          '本套件要求连接角色具备 CREATEDB 权限（本地 docker-compose 的 chamber 角色满足）。',
      );
    }

    // 克隆 data-source.ts 的 options（**唯一 schema/连接事实源**）：故也继承了连接级
    // pg_trgm 阈值（extra.options）——「阈值真生效」用例正是在验这条链路。
    db = new DataSource({
      ...(AppDataSource.options as DataSourceOptions),
      name: 'doc-search-prefilter-temp',
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

    // 手工装配服务（真仓储；manager.createQueryBuilder 产出的就是真 SQL）
    service = new DocSearchService(
      db.getRepository(DocSection),
      db.getRepository(Doc),
      db.getRepository(DocRoute),
      db.getRepository(TaskDocLink),
      // 判别重排内核（v1.85.0 批次 3）：本套件只测**原路径**的预过滤等价性 ⇒ 能力恒未启用
      { isEnabled: () => false, run: jest.fn(), recordSkip: jest.fn() } as never,
    );

    // ─── fixture 落地（真表 + 真触发器维护 search_vector：单字化 + 含 heading_path）───
    for (const spaceId of [SPACE_ID, GATE_SPACE_ID]) {
      await db.query(
        `INSERT INTO doc_spaces (id, name, slug, creator_id) VALUES ($1, $2, $3, $4)`,
        [
          spaceId,
          `prefilter-fixture-${spaceId.slice(0, 1)}`,
          `dsp-${process.pid}-${spaceId.slice(0, 1)}`,
          ACTOR_ID,
        ],
      );
    }
    for (const fixture of [...Object.values(FIXTURES), ...Object.values(GATE_FIXTURES)]) {
      const spaceId = fixture.docId.startsWith('b') ? GATE_SPACE_ID : SPACE_ID;
      await db.query(
        `INSERT INTO docs (id, space_id, path, title, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [fixture.docId, spaceId, fixture.path, fixture.title, ACTOR_ID],
      );
      await db.query(
        `INSERT INTO doc_sections (doc_id, position, heading_path, content) VALUES ($1, 0, $2, $3)`,
        [fixture.docId, fixture.headingPath, fixture.content],
      );
    }

    dbAvailable = true;
  });

  afterAll(async () => {
    // 先断临时库连接（否则 DROP 会被活动连接挡住），再 drop，最后断维护连接；
    // 用 try/finally 串起来保证「测试红了也要 drop」
    try {
      if (db?.isInitialized) await db.destroy();
    } finally {
      try {
        if (tempDbCreated && adminDs?.isInitialized) {
          await adminDs.query(`DROP DATABASE IF EXISTS "${TEMP_DB_NAME}" WITH (FORCE)`);
        }
      } finally {
        if (adminDs?.isInitialized) await adminDs.destroy();
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // ① 召回超集判决：无预过滤（改动前形状）与有预过滤（改动后实现）集合相等
  // ══════════════════════════════════════════════════════════════════════

  it('① 召回超集判决：同一 fixture 上「无预过滤」与「预过滤」返回同一 docId#position 集合', async () => {
    if (!dbAvailable) return;

    for (const testCase of QUERY_CASES) {
      const legacy = await mirrorKeys('normal', 'none', testCase.q);
      const prefixed = await mirrorKeys('normal', 'prefilter', testCase.q);
      const viaService = await serviceKeys(testCase.q);

      // 前提自证：结果数远小于 LIMIT，故两侧都是「地板命中全集」而非被截断的前 N 条
      expect({ q: testCase.q, truncated: legacy.length >= COMPARE_LIMIT }).toEqual({
        q: testCase.q,
        truncated: false,
      });

      // 核心不变量（对照件内部）：预过滤只许缩小候选集，不许增删地板命中结果
      expect({ q: testCase.q, ids: prefixed }).toEqual({ q: testCase.q, ids: legacy });

      // 真服务与对照件一致 —— 前提：主 fixture 表里没有「过地板但过不了 K-gate」的行
      // （那条约束由 ⑫ 在独立空间单独守；违反时本断言先红且根因是门，见文件头 [关键不变量]）
      expect({ q: testCase.q, ids: viaService }).toEqual({ q: testCase.q, ids: legacy });

      // 防"两侧都空而假绿"：该查询下必须真的有 fixture 被召回（零命中用例除外）
      for (const fixture of testCase.mustInclude) {
        expect({ q: testCase.q, hit: legacy.includes(`${fixture.docId}#0`) }).toEqual({
          q: testCase.q,
          hit: true,
        });
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // ② 反例 fixture 有牙：朴素形状（`@@ plainto_tsquery` + 阈值 0.3）必须丢它们
  // ══════════════════════════════════════════════════════════════════════

  it('② 反例(a)：ts 部分命中（>地板 / 全词 AND=false）不被丢弃，朴素 AND 预过滤必丢', async () => {
    if (!dbAvailable) return;
    const q = 'alpha beta zzz';
    const fixture = FIXTURES.longPartial;
    const e = await evidence(fixture, q);

    // 反例前提逐项自证（前提不成立 ⇒ 本条用例失去意义，必须先红）
    expect(e.ts_and_hit).toBe(false); // 全词 AND 不命中
    expect(e.ts_compiled_hit).toBe(true); // 编译产物 OR 命中（正确预过滤的依据）
    expect(e.composite).toBeGreaterThan(SCORE_FLOOR); // ⇒ 合成分过地板，改动前会被返回
    expect(e.prefilter_admit).toBe(true); // ⇒ 正确预过滤必须放行

    const legacy = await mirrorKeys('normal', 'none', q);
    const viaService = await serviceKeys(q);
    const naive = await mirrorKeys('normal', 'naive', q);
    const key = `${fixture.docId}#0`;

    expect(legacy).toEqual([key]); // 改动前：只返回它
    expect(viaService).toEqual(legacy); // 改动后：仍返回它（零召回损失）
    expect(naive).not.toContain(key); // 朴素 AND 预过滤：丢掉它（这正是被否掉的原因）
    expect(naive.length).toBeLessThan(legacy.length);
  });

  it('② 反例(b)：content 完全不含查询词的 heading 近形命中也必须被召回（heading % 唯一救主）', async () => {
    if (!dbAvailable) return;
    const q = 'deployment';
    const fixture = FIXTURES.headingOnlyNearMiss;
    const e = await evidence(fixture, q);

    // 前提：content 通道与 ts 通道**双双不命中**，只有 heading 相似度过阈值
    //（旧版用 CJK 形态，前提已被单字化反转——见文件头 [关键不变量]）
    expect(e.ts_compiled_hit).toBe(false);
    expect(e.content_sim).toBeLessThan(PG_TRGM_SIMILARITY_THRESHOLD);
    expect(e.content_pct).toBe(false);
    expect(e.heading_sim).toBeGreaterThan(PG_TRGM_SIMILARITY_THRESHOLD);
    expect(e.heading_pct).toBe(true); // `%` 裸列判定（NULL 语义：非 NULL 才为真）
    expect(e.composite).toBeGreaterThan(SCORE_FLOOR);

    const key = `${fixture.docId}#0`;
    expect(await mirrorKeys('normal', 'none', q)).toContain(key);
    expect(await serviceKeys(q)).toContain(key);
  });

  it('③ CJK 部分命中（bigram OR）不被丢弃，朴素形状对 CJK 结构性失配必丢', async () => {
    if (!dbAvailable) return;
    const q = '端口映射失效排查';
    const fixture = FIXTURES.partialCjk;
    const e = await evidence(fixture, q);

    expect(e.ts_compiled_hit).toBe(true); // 3/7 bigram 命中 ⇒ 编译产物 OR 放行
    expect(e.ts_and_hit).toBe(false); // 朴素形状：查询侧未单字化 ⇒ 整串 token 永不命中
    expect(e.composite).toBeGreaterThan(SCORE_FLOOR);

    const key = `${fixture.docId}#0`;
    expect(await mirrorKeys('normal', 'none', q)).toContain(key);
    expect(await serviceKeys(q)).toContain(key);
    expect(await mirrorKeys('normal', 'naive', q)).not.toContain(key);
  });

  it('② 反例(c)：纯噪音双双零命中（预过滤与地板都不许放行）', async () => {
    if (!dbAvailable) return;
    const q = 'alpha beta zzz';
    const fixture = FIXTURES.noise;
    const e = await evidence(fixture, q);

    expect(e.ts_compiled_hit).toBe(false);
    expect(e.content_sim).toBeLessThan(PG_TRGM_SIMILARITY_THRESHOLD);
    expect(e.heading_sim).toBeLessThan(PG_TRGM_SIMILARITY_THRESHOLD);
    expect(e.prefilter_admit).toBe(false);
    // 证明的余量落点：合成分 = 0 + 0.6×cs + W×hs < 0.07 < SCORE_FLOOR（W<1 是三角前提）
    expect(e.composite).toBeLessThan(SCORE_FLOOR);
    expect(e.composite).toBeLessThan(
      (RANK_WEIGHTS.TRGM_CONTENT + SEARCH_TRGM_HEADING_W) * PG_TRGM_SIMILARITY_THRESHOLD,
    );

    const key = `${fixture.docId}#0`;
    expect(await mirrorKeys('normal', 'none', q)).not.toContain(key);
    expect(await serviceKeys(q)).not.toContain(key);
  });

  // ══════════════════════════════════════════════════════════════════════
  // ④ 阈值真生效（连接级 0.05；退回 0.3 必须响亮地红）
  // ══════════════════════════════════════════════════════════════════════

  it('④ 阈值真生效：0.05 < heading 相似度 < 0.3 且无 ts 命中的行必须被召回（退回 0.3 必丢）', async () => {
    if (!dbAvailable) return;
    const q = 'deployment';
    const fixture = FIXTURES.thresholdBand;

    // 先钉住「阈值确实经连接级下发」——若 extra.options 被摘掉/改成 0.3，这条先红
    const [{ threshold }] = (await db.query(
      `SELECT current_setting('pg_trgm.similarity_threshold') AS threshold`,
    )) as { threshold: string }[];
    expect(threshold).toBe(String(PG_TRGM_SIMILARITY_THRESHOLD));

    const e = await evidence(fixture, q);
    // v1.87：救主 = **heading `%` 腿**（content `%` 腿已消融，近形因此落在 heading 上）。
    // 该行仍落在「PG 默认阈值 0.3 会丢、0.05 必须留」的窗口内，且合成分过地板。
    expect(e.heading_sim).toBeGreaterThan(PG_TRGM_SIMILARITY_THRESHOLD);
    expect(e.heading_sim).toBeLessThan(PG_DEFAULT_TRGM_THRESHOLD);
    expect(e.ts_compiled_hit).toBe(false); // 无 ts 命中 ⇒ 唯一救主就是保留的 heading `%` 腿
    expect(e.heading_pct).toBe(true);
    expect(e.content_pct).toBe(false); // content 与查询无关（「heading 唯一救主」前提自证）
    expect(e.prefilter_admit).toBe(true); // 服务实际谓词（arms=0 态）必须放行
    expect(e.composite).toBeGreaterThan(SCORE_FLOOR);

    const key = `${fixture.docId}#0`;
    const legacy = await mirrorKeys('normal', 'none', q);
    expect(legacy).toContain(key); // 改动前被返回
    expect(await serviceKeys(q)).toContain(key); // 改动后仍被返回

    // 反证：把阈值退回 PG 默认 0.3（朴素形状）必须丢掉它 —— 阈值回归即红
    expect(await mirrorKeys('normal', 'naive', q)).not.toContain(key);
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑤ 词形表驱动：编译产物在**真实单字化向量**上命中（编译器 ↔ DB 函数一致性）
  // ══════════════════════════════════════════════════════════════════════

  it('⑤ 词形表驱动：编译产物对每类词形都能命中真实单字化向量，且引号词位经 to_tsquery 再解析', async () => {
    if (!dbAvailable) return;

    for (const form of WORD_FORM_CASES) {
      const compiled = compiledFor(form.q);
      const rows = (await db.query(
        `
        SELECT
          to_tsvector('simple', cjk_unigram_text($1)) @@ to_tsquery('simple', $2) AS compiled_hit,
          to_tsvector('simple', cjk_unigram_text($1)) @@ plainto_tsquery('simple', $3) AS plain_hit
        `,
        [form.text, compiled.tsquery, form.q],
      )) as { compiled_hit: boolean; plain_hit: boolean }[];

      // 编译产物必命中真实单字化向量（预过滤放行的依据）；plain 命中 ⇒ 编译产物也命中（超集关系）
      expect({ q: form.q, hit: rows[0].compiled_hit }).toEqual({ q: form.q, hit: true });
      if (rows[0].plain_hit) {
        expect({ q: form.q, hit: rows[0].compiled_hit }).toEqual({ q: form.q, hit: true });
      }
    }

    // 引号词位的**再解析**形态（1-b tsqueryin 防线的行为依据）：`'foo-bar'` 经
    // to_tsquery 重过 parser → 短语链 `'foo-bar' <-> 'foo' <-> 'bar'`（实测 PG15）。
    // 若因 PG 大版本升级而红，请复核上面两条行为断言后更新本断言，不要只删掉它。
    const hyphenReparse = (await db.query(`SELECT to_tsquery('simple', $1)::text AS t`, [
      compiledFor('foo-bar').tsquery,
    ])) as { t: string }[];
    for (const lexeme of ["'foo-bar'", "'foo'", "'bar'"]) {
      expect(hyphenReparse[0].t).toContain(lexeme);
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑥ 索引在场（漂移门禁对 GIN 只报 DROP、不比 opclass ⇒ 必须另有 indexdef 断言）
  // ══════════════════════════════════════════════════════════════════════

  it('⑥ 三条预过滤索引都在场，且新 heading 索引经迁移链建出（USING gin + gin_trgm_ops）', async () => {
    if (!dbAvailable) return;

    const rows = (await db.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'doc_sections'`,
    )) as { indexname: string; indexdef: string }[];
    const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    // 新索引（本批迁移引入）：名字 + 形态都钉住
    const headingIdx = defs.get('idx_doc_sections_heading_path_trgm');
    expect(headingIdx).toBeDefined();
    expect(headingIdx).toContain('USING gin');
    expect(headingIdx).toContain('gin_trgm_ops');
    expect(headingIdx).toContain('heading_path'); // 必须建在**裸列**上（COALESCE 会破坏匹配）

    // 两条既有索引是预过滤另外两条分支的前提（少一条则对应分支退化为顺序扫描）
    expect(defs.get('idx_doc_sections_content_trgm')).toContain('gin_trgm_ops');
    expect(defs.get('idx_doc_sections_search_vector')).toContain('USING gin');

    // 新索引确实是**迁移链产物**（而非别的路径顺手建的）
    const applied = (await db.query(`SELECT name FROM migrations WHERE name = $1`, [
      'AddDocSectionHeadingPathTrgmIndex1791000000000',
    ])) as { name: string }[];
    expect(applied.length).toBe(1);
    expect(AddDocSectionHeadingPathTrgmIndex1791000000000.name).toBe(
      'AddDocSectionHeadingPathTrgmIndex1791000000000',
    );
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑦ 空查询短路（预过滤新增的防御分支）
  // ══════════════════════════════════════════════════════════════════════

  it('⑦ 空/纯空白 q 短路返回空信封（且不抛 to_tsquery 相关错误）', async () => {
    if (!dbAvailable) return;
    // 信封契约：短路返回 `{ hits: [] }`（空 q 不带 hint、不落零命中日志）
    expect(await service.search([SPACE_ID], { q: '' })).toEqual({ hits: [] });
    expect(await service.search([SPACE_ID], { q: '   ' })).toEqual({ hits: [] });
    // 与改动前语义一致：对照查询同样是地板全滤的零命中（trgm-only 形态，无 ts 段可查）
    expect(await mirrorKeys('trgm-only', 'none', '   ')).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑧ 四模式之 trgm-only（isEmpty：纯标点）——去 ts 段，只走 `%` 两腿
  // ══════════════════════════════════════════════════════════════════════

  it('⑧ trgm-only 模式（isEmpty 纯标点）：SQL 无任何 ts 段，结果与 trgm-only 对照件一致', async () => {
    if (!dbAvailable) return;

    const compiled = compileQuery('!!!');
    expect(compiled.isEmpty).toBe(true); // 前提：纯标点 = 编译期词项表空

    const sqls = await captureSqls('!!!');
    const main = pickMainSql(sqls, 'trgm-only');
    expect(main).not.toContain("to_tsquery('simple'"); // 去 ts 段（四模式口径）
    expect(main).not.toContain('ts_rank_cd('); // 打分不含 ts 腿（`ts_rank_score` 列名仍出现，值恒 0）
    expect(main).toMatch(/"content" % \$\d/);
    expect(main).toMatch(/"heading_path" % \$\d/);

    // 结果与 trgm-only 对照件一致（同一空间、同一 floor、同一活权重）
    expect(await serviceKeys('!!!')).toEqual(await mirrorKeys('trgm-only', 'none', '!!!'));
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑨ 四模式之 single-char（单 CJK 字）——ts-only 候选 + 常数分 + 位置序
  // ══════════════════════════════════════════════════════════════════════

  it('⑨ single-char 模式：ts-only 候选 + 常数分 + 位置序 + 位置序 hint，且 SQL 无 `%`/similarity', async () => {
    if (!dbAvailable) return;

    const q = '端';
    const compiled = compileQuery(q);
    expect(compiled.singleCjkChar).toBe(q); // 前提：整查询 = 一个单 CJK 字词项

    const expected = await mirrorKeys('degraded', 'prefilter', q);
    expect(expected.length).toBeGreaterThan(0); // 防两侧都空而假绿

    const { hits, hint, hintCode } = await service.search([SPACE_ID], { q, limit: COMPARE_LIMIT });
    expect(hits.map((h) => `${h.docId}#${h.position}`).sort()).toEqual(expected);
    // 常数分（全行同分：绕开逐行打分的可读刻度）+ 位置序声明 hint
    for (const hit of hits) expect(hit.score).toBe(SINGLE_CHAR_CONST_SCORE);
    expect(hint).toBe(DOC_SEARCH_POSITIONAL_ORDER_HINT);
    expect(hintCode).toBe('positional_order');

    const sqls = await captureSqls(q);
    const main = pickMainSql(sqls, 'degraded');
    // 单字路径不跑 df 预检（模式裁决在它之前命中）⇒ 无 `count(*)` 查询
    expect(sqls.some((s) => s.includes('count(*)'))).toBe(false);
    expect(main).not.toMatch(/"content" % \$\d/); // 两 `%` 腿明文不查（精度增益）
    expect(main).not.toContain('similarity('); // 绕开逐行 similarity（557ms 病理防线）
    // ts 过滤保留（GIN）：主查询仍带包裹后的编译产物
    expect(main).toContain("to_tsquery('simple', $");
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑩ 四模式之 df-degraded（高频 bigram）——与 single-char 同杠杆
  // ══════════════════════════════════════════════════════════════════════

  it('⑩ df-degraded 模式：df 预检超阈时同单字杠杆（ts-only + 常数分 + 位置序）', async () => {
    if (!dbAvailable) return;

    const q = '端口映射失效排查';
    // 只强制「模式裁决」这一步（df 预检结果），其余（SQL 形态/打分/排序）全走真实实现
    const asSpy = service as unknown as { isDfOverThreshold: (c: unknown) => Promise<boolean> };
    const spy = jest.spyOn(asSpy, 'isDfOverThreshold').mockResolvedValue(true);
    try {
      const expected = await mirrorKeys('degraded', 'prefilter', q);
      expect(expected.length).toBeGreaterThan(0);

      const { hits, hint, hintCode } = await service.search([SPACE_ID], {
        q,
        limit: COMPARE_LIMIT,
      });
      expect(hits.map((h) => `${h.docId}#${h.position}`).sort()).toEqual(expected);
      for (const hit of hits) expect(hit.score).toBe(SINGLE_CHAR_CONST_SCORE);
      expect(hint).toBe(DOC_SEARCH_POSITIONAL_ORDER_HINT);
      expect(hintCode).toBe('positional_order');

      const sqls = await captureSqls(q);
      // 预检结果已被 mock ⇒ 不再发 count 查询；降级主查询占第 0 位（pickMainSql 口径）
      const main = pickMainSql(sqls, 'degraded');
      expect(sqls.some((s) => s.includes('count(*)'))).toBe(false);
      expect(main).not.toContain('similarity('); // 降级同杠杆：两 similarity 腿不查
      expect(main).not.toMatch(/"content" % \$\d/); // 候选 = ts-only
      expect(main).toContain("to_tsquery('simple', $");
    } finally {
      spy.mockRestore();
    }

    // 对照组：不降级时走 normal —— 同一查询两种形态的差别只在模式（且 df 预检真实发生）
    const normalSqls = await captureSqls(q);
    const normalMain = pickMainSql(normalSqls, 'normal');
    expect(normalMain).toContain('similarity(');
    expect(normalSqls.some((s) => s.includes('count(*)'))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑪ 优化在场守卫（防预过滤被静默移除）
  // ══════════════════════════════════════════════════════════════════════

  it('⑪ `%` 腿消融两态与预过滤在场：arms≥1 删双腿 / arms=0 删 content 留 heading', async () => {
    if (!dbAvailable) return;

    // 预过滤只可能**减少**候选行（召回保全由 K-gate 结构引理承担，见 ①）——故它被删掉时
    // ①②③④ 照样绿。这条用例是该优化「在场」的唯一守卫：抓取服务真实产出的 SQL 与形态。

    // ── 态① arms≥1（含 CJK bigram）：两 `%` 腿**都不得出现**（cost body 与 heading 腿一并消融）
    const cjkQuery = '端口映射失效';
    const cjkCompiled = compiledFor(cjkQuery);
    expect(cjkCompiled.arms.length).toBeGreaterThan(0); // 前提自证（分态依据 = arms）
    const cjkSqls = await captureSqls(cjkQuery);
    const cjkSql = pickMainSql(cjkSqls, 'normal');
    expect(cjkSql).not.toMatch(/"content" % \$\d/);
    expect(cjkSql).not.toMatch(/"heading_path" % \$\d/);
    // 4 消费点枚举（score / prefilter / kGate 在主查询 + headline 在 snippet 查询）：
    // 主查询里 ts_rank_cd 只在**子查询打分列**出现一次（外层合成分与 floor WHERE 引用的是
    // `sub.ts_rank_score` 别名）——故期望数 = 1（score）+ 1（prefilter）+ arms.length（kGate）
    const scoreRefs = (cjkSql.match(/ts_rank_cd\(/g) ?? []).length;
    expect(scoreRefs).toBe(1);
    const tsOccurrences = cjkSql.match(/to_tsquery\('simple', \$\d+/g) ?? [];
    expect(tsOccurrences.length).toBe(scoreRefs + 1 /* prefilter */ + cjkCompiled.arms.length);
    // headline 段（snippet 查询）：ts_headline 作用于单字化文本
    const snippetSql = cjkSqls.find((s) => s.includes('ts_headline('));
    expect(snippetSql).toBeDefined();
    expect(snippetSql).toContain('cjk_unigram_text(');
    expect(snippetSql).toContain("to_tsquery('simple', $");

    // ── 态② arms=0（纯 ASCII/全角）：删 content 腿、**保留** heading 腿 ──
    //    （heading 腿 ~70ms 便宜 + v1.84 heading 召回通道；content 腿是成本本体）
    const asciiQuery = 'deployment';
    const asciiCompiled = compiledFor(asciiQuery);
    expect(asciiCompiled.arms.length).toBe(0); // 前提自证
    const asciiSql = pickMainSql(await captureSqls(asciiQuery), 'normal');
    expect(asciiSql).not.toMatch(/"content" % \$\d/);
    expect(asciiSql).toMatch(/"heading_path" % \$\d/);
    // heading 的 `%` 分支必须裸列：`COALESCE(s.heading_path, '') % $n` 形态不得出现
    // （COALESCE 会丢索引匹配；NULL % q = NULL 与 COALESCE 语义一致）
    expect(asciiSql).not.toMatch(/COALESCE\("?heading_path"?, ''\) %/);

    // ── 无插值负面断言（对象 = 一切编译产物字面量，不止 `:q`）──────────────────
    // 编译产物含引号词位（如 `('端'<->'口')`）——一旦被内联，SQL 里必然出现查询字面量
    for (const captured of [...cjkSqls, ...(await captureSqls(asciiQuery))]) {
      expect(captured).not.toContain('端');
      expect(captured).not.toContain('端口');
      expect(captured).not.toContain('tsvector_to_array(');
      expect(captured).not.toContain('quote_literal(');
      expect(captured).not.toContain('@@ plainto_tsquery');
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑫ K-gate 在场且**会收窄**（有意设计：过地板 ≠ 过门）
  // ══════════════════════════════════════════════════════════════════════

  it('⑫ K-gate 结构门：bigram 命中数 < K 的行被拒（过地板也不过门），≥K 的放行', async () => {
    if (!dbAvailable) return;

    const q = '端口映射失效排查';
    const compiled = compiledFor(q);
    expect(compiled.cjkCharCount).toBeGreaterThan(4); // ⇒ 缺省 K=2（≤4 字为 1）
    expect(compiled.arms.length).toBeGreaterThanOrEqual(2);

    // gate 空间：单臂行（只命中 端-口）+ 多臂行
    const singleArm = await evidence(GATE_FIXTURES.singleArmCjk, q);
    const multiArm = await evidence(GATE_FIXTURES.multiArmCjk, q);
    expect(singleArm.ts_compiled_hit).toBe(true); // 过 ts 预过滤
    expect(singleArm.prefilter_admit).toBe(true);
    expect(singleArm.composite).toBeGreaterThan(SCORE_FLOOR); // 过地板 ⇒ 差别只在门
    expect(multiArm.composite).toBeGreaterThan(SCORE_FLOOR);

    const legacy = await mirrorKeys('normal', 'none', q, GATE_SPACE_ID);
    const gated = await mirrorKeys('normal', 'gated', q, GATE_SPACE_ID);
    const viaService = await serviceKeys(q, GATE_SPACE_ID);

    const singleKey = `${GATE_FIXTURES.singleArmCjk.docId}#0`;
    const multiKey = `${GATE_FIXTURES.multiArmCjk.docId}#0`;

    // 无门时两行都在（证明"被拒"确实出自门，而非预过滤/地板）
    expect(legacy).toEqual([singleKey, multiKey].sort());
    // 挂门后单臂行被拒、多臂行放行
    expect(gated).toContain(multiKey);
    expect(gated).not.toContain(singleKey);
    // 真服务与门镜像一致（服务确实挂了门）
    expect(viaService).toEqual(gated);
  });
});
