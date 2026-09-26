/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 检索「零召回损失」常量不变量：预过滤阈值 / 打分权重 / 合成分地板三角
 *
 * [代码职责]
 *   - 用纯常量断言（不连库、不构造 SQL）钉住 `(TRGM_CONTENT + 活 headingW) × 阈值
 *     < SCORE_FLOOR`：**保留的 `%` 腿**（trgm-only 两腿 / normal arms=0 的 heading 腿）
 *     仍是召回超集的前提；以及阈值确实经连接级 options 下发
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: src/modules/docspace/doc-search.service.ts — [关键不变量] 与预过滤谓词注释
 *     （超集判据的完整推导）
 *
 * [关键不变量]
 *   - 被**两条 trgm 腿都在阈值下**的预过滤排除 ⇒ 合成分 < (TRGM_CONTENT + **活** heading
 *     权重) × 阈值 < SCORE_FLOOR ⇒ 地板本就会滤掉它。**余量 0.025**（批次 1-d1 起 heading
 *     权重是活旋钮 0.5，不再取已删除的静态 0.8）：阈值/权重/地板任一上调都可能击穿该不等式
 *     （本套件就是它的警报器）。
 *   - ⚠️ **该不等式的作用域自 v1.87 起收窄**（`%` 腿消融，REV-2）：normal 模式删掉了
 *     content `%` 腿（arms≥1 连 heading 腿一并删）⇒ 「被排除 ⇒ 两腿都在阈值下」不再普遍
 *     成立（content 相似度对 arms=0 的排除集无上界）。残余证明力 = **trgm-only 模式**
 *     （两腿都在）与两态预过滤下两腿都在阈值下的子集；normal arms=0 的「content 相似但
 *     heading 不相似」行属**接受的语义代价**（content 级 typo 容忍下线）。详见
 *     doc-search.service.ts 文件头 [关键不变量]。
 *   - 阈值必须 < PG 默认 0.3，否则**保留**的 `%` 腿会漏掉 0.05~0.3 档的候选（其合成分可达 0.16）。
 *   - 阈值必须经**连接级** options 下发（连接池语义），不得由查询级 SET 承载。
 *   - ts 腿活权重是 `SEARCH_TS_W1`、heading 腿活权重是 `SEARCH_TRGM_HEADING_W`；
 *     `RANK_WEIGHTS` 里**只剩活成员 `TRGM_CONTENT`**（`TS_RANK`(1.0) / `TRGM_HEADING`(0.8)
 *     两个历史成员已于 v1.87/`f4658c70` 删除——全仓属性访问为零后清理）——cd 单点尺度与
 *     W1 的真库实测在 test/search-cjk.e2e-spec.ts ② 与 test/search-invariants.e2e-spec.ts ④。
 *
 * [关联代码]
 *   - src/modules/docspace/doc-search.service.ts — RANK_WEIGHTS / SCORE_FLOOR + 预过滤谓词
 *   - src/database/pg-session-defaults.ts — PG_TRGM_SIMILARITY_THRESHOLD / PG_CONNECTION_EXTRA
 *   - test/doc-search-prefilter.e2e-spec.ts — 真库侧的召回超集判决（本文件只钉常量）
 *   - common/utils/search/keycap-tokens.ts — messages 面 keycap 加分（与地板三角无关，
 *     但同属「检索打分常量」家族，改 rank 表达式时一并复核）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { RANK_WEIGHTS, SCORE_FLOOR } from './doc-search.service';
import {
  SEARCH_TRGM_HEADING_W,
  SEARCH_TS_W1,
} from '../../common/utils/search/search-tuning';
import {
  PG_CONNECTION_EXTRA,
  PG_TRGM_SIMILARITY_THRESHOLD,
} from '../../database/pg-session-defaults';

describe('DocSearch 预过滤常量不变量（阈值 / 权重 / 地板三角）', () => {
  it('两腿都在阈值下的被排除候选，其上界严格低于合成分地板（三角的残余作用域）', () => {
    // 被排除且两 leg 都不真 ⇔ ts_rank = 0 且 content/heading 相似度都 < 阈值
    // ⇒ 合成分 < (TRGM_CONTENT + 活 heading 权重) × 阈值。该上限必须 < SCORE_FLOOR，
    // 否则地板本会保留的行会被预过滤丢掉（静默丢召回，无任何报错）。
    // ⚠️ 作用域自 v1.87 起收窄（`%` 腿消融，REV-2）：normal 模式删了 content `%` 腿
    // （arms≥1 连 heading 腿一并删）⇒「被排除 ⇒ 两腿都在阈值下」不再普遍成立。本不等式
    // 仍须成立的部分 = trgm-only 模式（两腿都在场）+ 两态预过滤下两腿都在阈值下的子集；
    // 其余排除行（content 相似但 heading 不相似）属 REV-2 明记的**接受代价**。
    // ⚠️ heading 权重自批次 1-d1 起是**活旋钮**（search-tuning.ts 单源，非 RANK_WEIGHTS
    // 成员——该组现只剩 TRGM_CONTENT）——本断言因此读活值：env 越界（≥1）会被旋钮的解析
    // 防御回落本旋钮默认值 0.5，但默认值本身一旦被改大，这条断言先红而不是等生产丢召回。
    const excludedScoreUpperBound =
      (RANK_WEIGHTS.TRGM_CONTENT + SEARCH_TRGM_HEADING_W) * PG_TRGM_SIMILARITY_THRESHOLD;

    expect(excludedScoreUpperBound).toBeLessThan(SCORE_FLOOR);
    // 余量与推导值一并钉住：改任一常量都会让这条断言先红，而不是等生产丢召回
    // （数值按**当前活默认** 0.6 + 0.5 推出 = 0.055，余量 0.025；改默认 W 须同步本行）
    expect(excludedScoreUpperBound).toBeCloseTo(0.055, 10);
    expect(SCORE_FLOOR - excludedScoreUpperBound).toBeCloseTo(0.025, 10);
  });

  it('ts 腿活权重是旋钮 SEARCH_TS_W1，且单点命中即可过地板（OR 语义的依据）', () => {
    // ⚠️ 本用例在批次 1-d2 前是「ts_rank 阶梯 0.0608 / 0.0991 / 0.2683」的常数自证——
    // 那套数字自批次 1 起**不再代表现实**（B 类静默错通，已核销）：打分换
    // `ts_rank_cd` flag 0（长度无关，单 bigram 命中 ≈0.1，真库实测见
    // test/search-cjk.e2e-spec.ts ② 与 test/search-invariants.e2e-spec.ts ④），
    // 且 tsquery 由编译器产出（OR 链，不再是 plainto 全词 AND）⇒「命中 n/m 词」的旧
    // 框架整个失效。真库数值由上述两个 e2e 承接，本文件只钉两条**仍成立**的关系：
    //   ① 单点命中（cd ≈0.1）× 活 W1 必须 > SCORE_FLOOR——否则「部分命中可过线」不成立，
    //      预过滤的 OR 语义（以及 W1 的整个量级选择）就失去依据；
    //   ② 活 W1 ≥ 2 是结构性要求（批次 1-c/1-d1 实测结论）：0.1×W1 要压过 heading trgm
    //      噪声（headingW=0.5 时仍达 0.14~0.18），W1=1 会退回噪声主导的排序。
    const CD_SINGLE_POINT = 0.1; // 真库实测单点档（与两个 e2e 的同值断言互为佐证）
    expect(CD_SINGLE_POINT * SEARCH_TS_W1).toBeGreaterThan(SCORE_FLOOR);
    expect(SEARCH_TS_W1).toBeGreaterThanOrEqual(2);
  });

  it('heading 权重活旋钮合法域 (0,1) —— 上界由地板三角决定（1-d1 旋钮化）', () => {
    // W ≥ 1 ⇒ (0.6 + W) × 0.05 ≥ 0.08 = SCORE_FLOOR ⇒ 三角击穿（预过滤不再是地板命中
    // 集超集）。旋钮的解析防御把 ≥1 一律回落默认值 0.5，本断言钉住"默认值必须落在合法域内"。
    expect(SEARCH_TRGM_HEADING_W).toBeGreaterThan(0);
    expect(SEARCH_TRGM_HEADING_W).toBeLessThan(1);
  });

  it('阈值必须比 PG 默认 0.3 更宽松（否则 0.05~0.3 档候选被静默剔除）', () => {
    expect(PG_TRGM_SIMILARITY_THRESHOLD).toBeLessThan(0.3);
    expect(PG_TRGM_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
  });

  it('阈值只经连接级 options 下发，且 options 串与常量同源（防字面量漂移）', () => {
    // 连接级（建连即 SET）是唯一可靠形态：事后 SET / set_limit 会随连接归还污染连接池，
    // 无事务 SET LOCAL 只 WARNING 不生效（静默收窄召回）——详见 pg-session-defaults.ts
    expect(Object.keys(PG_CONNECTION_EXTRA)).toEqual(['options']);
    expect(PG_CONNECTION_EXTRA.options).toBe(
      `-c pg_trgm.similarity_threshold=${PG_TRGM_SIMILARITY_THRESHOLD}`,
    );
  });
});
