/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 检索中文根治（路线 A）的**可调旋钮单源**：ts 腿权重 W1 / K-gate K 覆盖值 /
 *     高频降级 df 阈值——批次 1-c 标定矩阵（W1×K）与 df 阈值选定的调参入口
 *     （计划 v1.5 §2.3 标定矩阵、§2.5 高频/单字降级；主脑裁决 #3/#4）
 *
 * [代码职责]
 *   - 定义四个 env 可调常量：`SEARCH_TS_W1`（默认 3.0）/ `SEARCH_KGATE_K_OVERRIDE`
 *     （缺省 = 不覆盖）/ `SEARCH_DF_DEGRADE_THRESHOLD`（默认 20000）/
 *     `SEARCH_TRGM_HEADING_W`（默认 0.5，批次 1-d1 新增）——df 阈值为**批次 1-c 标定
 *     终值**、W1/heading 权重为**批次 1-d1 排序扫描终值**（均 2026-09-26 演练库实测裁决）
 *   - 解析防御：非法值（NaN / 非有限 / 非正数）一律回落缺省——"配置写错就静默
 *     改变检索语义"是最糟的失败模式（judgment.config.ts 同款纪律）
 *
 * [权威文档]
 *   - 主文档: 检索中文根治计划终稿 v1.5 §2.3（W1×K 标定矩阵）/ §2.5（df 预检降级）
 *   - 补充: 批次 1-b 侦察报告 `.kimi/b1b-recon-handoff.md` §6 裁决 #3/#4（df union-count
 *     口径 / env 键草拟照准）
 *
 * [关键不变量]
 *   - **模块加载期求值**（attachment.constants.ts / auth THROTTLE 先例）：env 覆盖
 *     仅影响新进程；消费方 import 常量而非直读 `process.env`（防第二事实源）。
 *   - **本文件是"服务侧常量 + env 直读"惯例**（主脑裁决 #4 核仓惯例后选定）：不建
 *     `src/config/` registerAs 工厂——三个旋钮都是进程级调参，且 doc-search 在
 *     测试中大量手工 new（prefilter e2e 等装配点零改动前提）。
 *   - **`SEARCH_TS_W1` 是打分尺度参数**：改它 = 改地板三角的一侧——doc-search 侧
 *     三角证明（预过滤是**最终召回集**的超集——v1.87 消融后覆盖面收窄为「两 trgm 腿
 *     都在阈值下的子集 + trgm-only」⇒ 合成分 < 0.055 < 0.08，余量 0.025）含
 *     `ts_rank_cd × W1` 项，W1 只许
 *     ≥ 现值的方向调（降 W1 不击穿三角，升 W1 也不击穿——三角上界由 trgm 两腿给出；
 *     但 W1 改变会改变 cd 尺度与 hint 强命中线 0.3 的对应关系，调后必须重跑评估集）。
 *   - **`SEARCH_DF_DEGRADE_THRESHOLD` 是 union-count 口径**（裁决 #3）：`sv @@ :compiledQ`
 *     的候选集行数上限——超过即走降级路径（常数分 + 位置序）。终值 20000 = 批次 1-c
 *     四档扫描裁决（8069~26224 平台段内，与推导刻度"p95 300ms 预算 ≈ 2 万行"同源）；
 *     **其覆盖面局限已在常量 doc 登记**（trgm 位图 recheck 不受 df 管辖）。
 *
 * [关联代码]
 *   - modules/docspace/doc-search.service.ts — 三旋钮主消费方（W1 打分 / K 覆盖 /
 *     df 预检降级）
 *   - modules/experience/experience.service.ts — K 覆盖消费方（其自有权重/地板不动）
 *   - common/utils/search/tsquery-compiler.ts — `chooseKGateK`（override 的唯一入口）
 *   - modules/docspace/doc-search-constants.spec.ts — 地板三角警报器（读本文件活旋钮）
 *   - search-tuning.spec.ts — 解析防御契约单测（process.env 操控先例：
 *     downloads.controller.spec.ts）
 *
 * [铁律关联] #11(注释强制) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增旋钮必须带解析防御 + spec 用例 + .env.example 登记
 * =============================================================================
 */

import { DOC_SEARCH_STRONG_HIT_SCORE } from '@agent-chamber/shared';

/**
 * 解析正有限浮点旋钮（缺省/空串/非法值一律回落 fallback）。
 * 空串视同"未配置"（compose `${VAR:-}` 注空串先例，judgment.config.ts 同款）。
 */
function parsePositiveFloatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 解析正整数旋钮（非整数/非正数回落 fallback；1.5 这类浮点配置视为写错） */
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * ts 腿权重 W1（`ts_rank_cd(sv, :compiledQ) × W1`，flag 0）。
 * 默认 3.0 = **批次 1-d1 排序扫描终值**（2026-09-26 演练库四格扫描
 * W1∈{2,3} × SEARCH_TRGM_HEADING_W∈{0.8,0.5}，修正分母 49：召回单调随 W1↑ 上升
 * ——57.1%（2/0.8）→ 61.2%（3/0.5），top3 49.0%→53.1%、MRR 0.455→0.473；
 * 域外探索 W1=4 与 HW=0.3 复核为**平台期**（同为 61.2%），故 3.0 即扫描域内最优）。
 * 背景：批次 1-c 实证 cd 单次命中恒 0.1（长度无关），而无关行靠
 * `similarity(heading_path,q)×0.8` 可达 0.22~0.29 ⇒ 真节被压出 top-5；
 * 提高 W1 = 让 ts 腿在与 heading trgm 噪声竞争时更占优。
 *
 * ⚠️ **刻度耦合已由 `DOC_SEARCH_WEAK_HIT_SCORE` 现构承接**（批次 1-d1 登记 → 1-d2 落地，
 * 主脑裁决 R4）：`DOC_SEARCH_STRONG_HIT_SCORE`(0.3) 是"cd 单点 0.1 × W1=1.0"的**基准刻度**，
 * W1=3 时 `0.1×3=0.3` 恰好触线（弱命中 hint 分支失效，1-d1 实测 3~4 条 → 0 条）。
 * 故 doc-search 侧一律读下面派生的活阈值，**不得直接读基准常量**；task q= 侧 rank 未乘
 * W1，读 shared `TASK_SEARCH_WEAK_HIT_SCORE`（同值不换算）。
 */
export const SEARCH_TS_W1 = parsePositiveFloatEnv(process.env.SEARCH_TS_W1, 3.0);

/**
 * heading trgm 项权重（`similarity(heading_path, q) × W`，**仅 doc-search 融合公式**；
 * experience 侧 EXPERIENCE_RANK_WEIGHTS 一字不动）。默认 0.5 = **批次 1-d1 排序扫描
 * 终值**（四格扫描中 0.5 全面不劣于 0.8：召回 59.2%→61.2%、p95 1082/1169ms、
 * en-identifier 的 `X-API-Key` 名次 5→4；域外 HW=0.3 复核为平台期）。
 *
 * rationale（批次 1-d1 旋钮化，2026-09-26）：批次 1-c 标定实证 heading trgm 是排序噪声
 * 主来源——`ts_rank_cd` 单词项命中恒 0.1（×W1=2 得 0.2），而无关行靠
 * `similarity(heading_path, q) × 0.8` 可达 0.22~0.29，真节被压出 top-5。故把它从
 * 硬编码常量升为旋钮，交评估集四格扫描裁决。
 *
 * ⚠️ 合法域 = **(0, 1) 开区间**——上界不是审美而是**不变量**：零召回损失三角
 * `(TRGM_CONTENT + W) × PG_TRGM_SIMILARITY_THRESHOLD < SCORE_FLOOR` ⇒ W < 1.0
 * （(content 0.6 + W) × 阈值 0.05 = 0.055（W=0.5 时）< 地板 0.08，余量 0.025；三角覆盖面
 * v1.87 已收窄为「两 trgm 腿都在阈值下的子集 + trgm-only」，见 doc-search-constants.spec.ts）。
 * 越界会让预过滤不再"最终召回集超集"= 静默丢召回，故 ≥1 一律视同写错 → **回落本旋钮的
 * 默认值 0.5**（与 `:114` 的解析分支同源；旧文字写"回落 0.8"是 1-d1 旋钮化前的残留）。
 */
export const SEARCH_TRGM_HEADING_W = (() => {
  const raw = process.env.SEARCH_TRGM_HEADING_W;
  if (raw === undefined || raw.trim() === '') return 0.5;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.5;
})();

/**
 * K-gate K 覆盖值（标定矩阵 W1×K 评估用；`undefined` = 不覆盖，按 CJK 字数取起始值
 * ≤4 字 K=1 / 更长 K=2）。正整数以外一律视为未配置。消费入口唯一 =
 * `buildSearchSql` 的 `kOverride` 形参（最终仍经 `chooseKGateK` 的 K ≤ armCount 钳制）。
 */
export const SEARCH_KGATE_K_OVERRIDE: number | undefined = (() => {
  const raw = process.env.SEARCH_KGATE_K_OVERRIDE;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
})();

/**
 * df 预检降级阈值（union-count 口径，`sv @@ :compiledQ` 的候选集行数）：超过即走
 * 单字同杠杆降级（ts 过滤 + 常数分 + 绕开逐行打分 + `section_position ASC, doc_id ASC`
 * + 不跑 boost 融合 + rerank 短路，计划 §2.5）。**默认 20000 = 批次 1-c 标定终值**
 * （2026-09-26 演练库 4 档扫描 20000/10000/5000/2000：20000 与 10000 同处
 * 8069~26224 平台段，触发集恒为 df 最大的两条长查询（df 26224/29981），
 * p95 2283ms→1017ms、最坏 12100ms→2699ms；再往下调只增触发面却不再降 p95，
 * 反而多丢召回（5000 档 52%）。取值 20000 与计划推导刻度"p95 300ms 预算 ≈
 * 2 万行量级"一致）。
 * ⚠️ 已知局限（批次 1-c 实测登记；**v1.87 已部分消解**）：df 只计 ts 候选，**不覆盖成本主因**
 * ——`pg_trgm.similarity_threshold=0.05` 下 `content % q` 的 trgm GIN 位图 recheck
 * （如 df=25 的 `ECONNREFUSED` 位图命中 26507 行、耗时 1.9s）。**v1.87 REV-1 再定性**：
 * 非位图 lossy（EXPLAIN 全 exact），而是 trgm GIN **结构性不能精确判 `%`** ⇒ 26,507 索引条目
 * 逐行回表 detoast + similarity 重算；**REV-2 消融**（normal 模式按 arms 删 `%` 腿）已把
 * 该成本从 normal 模式移除——本 df 阈值仍是长 CJK 查询的候选集闸门，二者正交互补。
 */
export const SEARCH_DF_DEGRADE_THRESHOLD = parsePositiveIntEnv(
  process.env.SEARCH_DF_DEGRADE_THRESHOLD,
  20000,
);

// ═══════════════════════════════════════════════════════════════════════════
// 派生阈值（非 env 旋钮——由上面的旋钮现构，避免"旋钮改了、阈值没跟"的刻度漂移）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * doc-search 弱命中线（现构）= `DOC_SEARCH_STRONG_HIT_SCORE × SEARCH_TS_W1`。
 *
 * 语义：normal/trgm-only 模式本页最高分低于本线 ⇒ 附带 `DOC_SEARCH_ZERO_HIT_HINT`
 * （弱命中家族，与零命中同一触发）。
 *
 * rationale（计划 v1.5 §2.6 + 主脑裁决 R4，批次 1-d2 落地）：基准线 0.3 是
 * "cd 单点 0.1 × W1=1.0" 尺度下定的**刻度**；doc-search 的合成分含
 * `ts_rank_cd × SEARCH_TS_W1` 项 ⇒ 尺度随 W1 整体放大，而基准线不放大 = 刻度漂移。
 * W1=3.0 时 cd 单点恰为 `0.1×3=0.3`，直接读基准线会让弱命中分支**整体失效**
 * （1-d1 实测：W1=2 有 3~4 条弱命中 hint，W1=3 归零）。故取现构。
 *
 * ⚠️ 两侧分家（同裁决）：task q= 的 rank 通道是裸 `ts_rank_cd`（未乘 W1），仍用
 * shared `TASK_SEARCH_WEAK_HIT_SCORE`（= 基准值 0.3，不换算）——不要把本常量搬过去。
 *
 * ⚠️ 只读本文件的旋钮，**不读 env**（与上面四个旋钮同款模块加载期求值纪律）。
 */
export const DOC_SEARCH_WEAK_HIT_SCORE = DOC_SEARCH_STRONG_HIT_SCORE * SEARCH_TS_W1;
