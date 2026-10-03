/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace 文档检索（检索中文根治路线 A 接线后）：**每次搜索先 compileQuery**，
 *     按编译产物落四模式之一——① isEmpty → trgm-only；② singleCjkChar → 单字路径；
 *     ③ df 预检（union-count）超阈 → df-degraded（同单字杠杆）；④ normal →
 *     `ts_rank_cd(sv, :compiledQ) × W1` + trgm 双路打分 + `sv @@ :compiledQ` 预过滤 +
 *     K-gate 结构门 → 合成分地板过滤 → 意图融合 boost 重排（含时间序接管分支）
 *   - 索引化预过滤：把「全表逐行算合成分」压成 BitmapOr 候选集（生产实证 2128ms → 28ms）
 *
 * [代码职责]
 *   - 模式裁决（`resolveMode` + df 预检 `isDfOverThreshold`）、检索主查询（内层子查询
 *     打分 + 外层地板/排序/分页）、snippet 生成（ts_headline 作用于**单字化文本**优先、
 *     trgm 窗口兜底）、路由 / 任务链接两路 boost 融合、零命中日志 + hint 信封组装；
 *     时间序分支与相关度分支共享同一内层子查询
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: 检索中文根治计划终稿 v1.5 §2.2（四消费方）/§2.3（flag 0 + K-gate）/
 *     §2.5（单字与高频降级）/§2.6（hint + 零命中日志）；批次 1-b 侦察报告
 *     `.kimi/b1b-recon-handoff.md` §6（主脑裁决 9 条）
 *
 * [关键不变量]
 *   - **预过滤谓词必须是「最终召回集」的超集**（违反 = 静默丢召回、无任何报错）。
 *     v1.87 起按 `compiled.arms.length` 分两态（REV-2 `%` 腿消融，落点见 `buildScoredQuery`）：
 *     ① **arms≥1（CJK）**：候选 = `s.search_vector @@ :compiledQ`（两 `%` 腿已删）。该态的
 *        召回保全由 **K-gate 结构性承接**（证明级）：arms ⊆ compiledQ 词项 ⇒ compiledQ 假
 *        ⇒ 每 arm 假 ⇒ 门计数 0 < K ⇒ `%-only` 行本就不可能出现在最终集里，删腿零损失
 *        （全库实测「出境」19 条 `%-only` 行过闸 0 条；30/30 现命中名次零变化）。
 *     ② **arms=0（纯 ASCII/全角）**：候选 = `s.search_vector @@ :compiledQ OR heading_path % :q`
 *        ——**content `%` 腿同样删**（成本本体：Q1 `ECONNREFUSED` 实测 1435ms/189 行、精度
 *        0.71%），**heading `%` 腿保留**（~70ms 便宜 + 承载 v1.84 heading 召回通道）。
 *        语义代价（REV-2 明记，勿再当 bug 修）：**content 级 typo 模糊容忍已下线**——
 *        「ts 不中、heading 相似度 < 阈值、仅 content 相似」的行不再进候选集。
 *     两态共同的下界（triad 残余作用 + trgm-only 模式的完整证明）：被排除且**两条 trgm
 *     腿都在阈值下** ⇒ 合成分 < (0.6 + 活 headingW 0.5) × 0.05 = 0.055 < SCORE_FLOOR(0.08)，
 *     余量 0.025 —— 阈值 / trgm 权重 / 地板任一上调都可能击穿（doc-search-constants.spec.ts 钉住）。
 *   - **四模式判别顺序钉死**：isEmpty（trgm-only，去 ts select/预过滤 ts 分支/K-gate）
 *     → singleCjkChar（单字路径）→ df 预检超阈（df-degraded）→ normal。**单字与
 *     df-degraded 同杠杆**：候选 = ts-only（两 `%` 腿明文不查）+ 常数分
 *     SINGLE_CHAR_CONST_SCORE(0.1 > floor 天然过线) + 绕开逐行打分与 K-gate +
 *     不跑 boost 融合（boost 会打破位置序）+ **rerank 短路点在 rerankActive 计算之前**
 *     （常数分池喂重排无意义且违反双键排序不变量）。
 *   - **降级路径排序 = `section_position ASC, doc_id ASC`**（doc_id 末位平局键——常数分
 *     下 position 平局大量存在，缺则分页/结果不可复现）；**时间序接管 ORDER BY 优先于
 *     模式位置序**（v1.55 sort 契约：时间序的业务意图是按时间穷尽遍历）。
 *   - **K-gate 只挂 normal 模式**（doc-search 与 experience 两家；messages/tasks 不挂
 *     ——主脑裁决 #2，召回语义变更未授权不做）。
 *   - **`:compiledQ` / `:armN` / `:kGateK` 只经 QueryBuilder setParameters 下发**
 *     （F1 硬约束）：`dataSource.query()` 裸路径不做命名参数替换（实测 42601）；
 *     且 SQL 侧一律 `to_tsquery('simple', :param)` 包裹——裸绑定/cast 走 tsqueryin
 *     原子语义（保大小写不拆元语法），与编译器 parser 语义错位（2026-09-26 1-b
 *     实证；导出组 search-sql.ts 已统一包裹，df 预检同规）。
 *   - `%` 的阈值只允许**连接级**下发（src/database/pg-session-defaults.ts）：事后 `SET` /
 *     `set_limit()` 随连接归还污染池；无事务 `SET LOCAL` 只 WARNING 不生效（静默收窄）。
 *   - 预过滤里 heading_path 用**裸列**（NULL % q = NULL 不进 true，与 COALESCE 语义一致；
 *     COALESCE 会破坏 GIN 索引匹配）。
 *   - 地板过滤、排序、boost 融合语义**不因预过滤改变**：预过滤只缩小候选集，不改分数、
 *     不引入新结果；boost 永不进 SQL 打分式。
 *
 * [关联代码]
 *   - src/common/utils/search/tsquery-compiler.ts — 查询编译器（CompiledQuery 唯一来源）
 *   - src/common/utils/search/search-sql.ts — 共享 SQL 导出组（score/prefilter/headline/
 *     kGate 四段表达式的唯一构造）
 *   - src/common/utils/search/search-tuning.ts — SEARCH_TS_W1 / K 覆盖 / df 阈值三旋钮
 *   - src/common/utils/search/zero-hit-log.ts — 零命中结构化日志（四路共用）
 *   - src/common/utils/search/snippet-cleanup.ts — headline 单字化空格/标记清理
 *   - src/database/pg-session-defaults.ts — pg_trgm 阈值单源（两个 DataSource 装配点共用）
 *   - src/modules/search/search.service.ts — 全局检索复用本 service（自动继承四模式）
 *   - test/doc-search-prefilter.e2e-spec.ts — 真库召回超集判决（批次 1-d 三臂重定义）
 *   - test/single-cjk-char-path.e2e-spec.ts / snippet-cleanup.e2e-spec.ts — 降级与
 *     snippet 契约的真库钉子
 *   - src/modules/docspace/doc-search-constants.spec.ts — 阈值-权重-地板三角耦合常量不变量
 *
 * [持久踩坑]
 *   - DOCSEARCH-FLOOR-TRIAD(三角耦合): SCORE_FLOOR / trgm 权重 / pg_trgm 阈值三者构成
 *     零召回损失证明的三角，余量 0.025（(0.6+活 headingW 0.5)×0.05 = 0.055 vs 0.08；
 *     v1.87 `%` 腿消融后该证明的覆盖面收窄，见文件头 [关键不变量] 与 SCORE_FLOOR 注释）。
 *     安全方向: 改任一先去 doc-search-constants.spec.ts 看不等式是否仍成立；阈值改连接级下发，
 *     勿改查询级。
 *   - 9082464c(ts_headline options): options 串 `'...,StartSel=,StopSel='` 无空格无引号 →
 *     `,StopSel=` 字面量残渣污染 snippet；空值必须写成 `StartSel="", StopSel=""`
 *     （本服务经 buildSearchSql 恒产双引号包裹形态，builder 构造期校验标记禁含引号）。
 *   - DOCSEARCH-DEGRADED-CONST-SCORE(常数分契约): 单字/df 降级路径的常数分必须
 *     > SCORE_FLOOR 且全行同分——重新引入逐行 cd/similarity = 557ms 病理回归
 *     （计划 §2.5 实测：逐行 similarity 打在全表候选上）。守卫:
 *     test/single-cjk-char-path.e2e-spec.ts（真 SCORE_FLOOR 锚）。
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #4(文档优先) #11(注释) #21(双层校验) #23(jsonb/真库覆盖)
 *
 * [修改检查]
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复 bug，先执行完整的根因分析流程（影响面评估 → 测试覆盖 → 验证）
 *   □ 改四模式分支前，先确认 rerank 短路点仍在 rerankActive 计算之前、降级路径不跑 boost
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocRoute } from '../../database/entities/doc-route.entity';
import { TaskDocLink } from '../../database/entities/task-doc-link.entity';
import type {
  DocSearchHit,
  DocSearchSort,
  DocSearchResponse,
  DocSearchHintCode,
} from '@agent-chamber/shared';
import {
  DOC_SEARCH_POSITIONAL_ORDER_HINT,
  DOC_SEARCH_WEAK_HIT_HINT,
  DOC_SEARCH_ZERO_HIT_HINT,
} from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { JudgmentRunnerService } from '../judgment/judgment-runner.service';
import { compileQuery, type CompiledQuery } from '../../common/utils/search/tsquery-compiler';
import {
  buildSearchSql,
  COMPILED_Q_PARAM,
  type SearchSqlGroup,
} from '../../common/utils/search/search-sql';
import {
  DOC_SEARCH_WEAK_HIT_SCORE,
  SEARCH_DF_DEGRADE_THRESHOLD,
  SEARCH_KGATE_K_OVERRIDE,
  SEARCH_TRGM_HEADING_W,
  SEARCH_TS_W1,
} from '../../common/utils/search/search-tuning';
import { logSearchWeakHit, logSearchZeroHit } from '../../common/utils/search/zero-hit-log';
import { cleanupHeadlineSnippet } from '../../common/utils/search/snippet-cleanup';
import {
  docSearchRerankCapability,
  isRerankEligible,
  planRerankCandidates,
  solveDocRerank,
  type DocRerankDecision,
  type DocRerankInput,
  type DocRerankValue,
  type RerankCandidate,
  RERANK_MAX_POOL_SIZE,
  RERANK_POOL_DEPTH,
} from './rerank/doc-search-rerank';

/**
 * 双路打分权重常量（**活成员只剩 TRGM_CONTENT**）
 *
 * rationale：
 * - ts 腿（ts_rank_cd flag 0）对英文/标识符精确匹配贡献最大（活权重 = SEARCH_TS_W1，
 *   `common/utils/search/search-tuning.ts` 单源——不在本组内，防第二事实源）
 * - similarity(content) × 0.6 提供中文模糊匹配（pg_trgm 滑窗）——**本组唯一活成员**
 * - similarity(headingPath) 的活值 = `SEARCH_TRGM_HEADING_W`（同文件单源，默认 0.5，
 *   排序扫描旋钮，合法域 (0,1)）——同样不在本组内
 *
 * ⚠️ 本组只导出为常量不变量单测（doc-search-constants.spec.ts）读取；三角
 * `(TRGM_CONTENT + 活 headingW) × 阈值 < SCORE_FLOOR` 的余量随 heading 旋钮取 0.5
 * 而为 0.025（旧文字写 0.01 = 静态 0.8 时代的残留）。
 *
 * ⚠️ **历史成员 TS_RANK(1.0) / TRGM_HEADING(0.8) 已于 v1.87 删除**（工单 `f4658c70`）：
 * 二者自 v1.86 / 批次 1-d1 起先后被 `SEARCH_TS_W1` / `SEARCH_TRGM_HEADING_W` 取代，
 * 保留期已无任何代码或测试的**属性访问**（全仓扫描确认；常量成员访问不产生 gitnexus
 * 边，故扫描对象是文本而非图）。不要再把它们加回来——活旋钮单源在 search-tuning.ts。
 */
export const RANK_WEIGHTS = {
  /** pg_trgm similarity(content) 权重 — 中文模糊匹配（活权重，本组唯一成员） */
  TRGM_CONTENT: 0.6,
} as const;

/**
 * 三路融合检索加权常量（plan §4-C3 意图融合检索）
 *
 * 语义：SQL SCORE_FLOOR 过滤**之后**，对命中 doc 叠加「策展路由命中」与「任务链接数」
 * 两路乘数加权重排——只重排、不引入新结果（plan §4 明文边界）。
 *
 * rationale：
 * - ROUTE_PRIMARY_BOOST 1.5 > ROUTE_SECONDARY_BOOST 1.2：路由的「先看」文档比「再看」
 *   文档更贴近用户意图，加权更高；同一 doc 被多条路由命中时**取最大倍率不叠加连乘**
 *   （避免策展重复导致分数虚高）；
 * - 阈值语义（≥ 判定）：intent 相似度 ≥0.15 或 category 相似度 ≥0.3 即视为路由命中。
 *   intent 是自由文本（"我要…"），trgm 相似度普遍偏低，故阈值低于 category
 *   （短 slug 词如 "architecture"，命中通常更强）；
 * - TASK_LINK_STEP 0.05 × min(count, TASK_LINK_CAP=5)：被 ≥1 个任务引用的文档带
 *   「被使用」信号加分，封顶 ×1.25 防止高频引用文档（如 README/INDEX 常客）垄断排序；
 * - 所有常量集中一处，后续调参只需改这里。
 */
const ROUTE_PRIMARY_BOOST = 1.5;
const ROUTE_SECONDARY_BOOST = 1.2;
/** 路由 intent 相似度阈值（≥ 命中） */
const ROUTE_INTENT_FLOOR = 0.15;
/** 路由 category 相似度阈值（≥ 命中） */
const ROUTE_CATEGORY_FLOOR = 0.3;
/** 任务链接阶梯步长：每个任务 +5% 权重 */
const TASK_LINK_STEP = 0.05;
/** 任务链接计数封顶（超出不再累加，乘数上限 ×1.25） */
const TASK_LINK_CAP = 5;

/**
 * 合成分数下限阈值
 *
 * rationale：
 * - `similarity()` 函数打分不走 `%` 操作符，不受 `pg_trgm.similarity_threshold` 约束
 * - 必须应用层加合成分数下限，防止零相关文档混入 top-k
 * - 0.08 为初始经验值：单一 trgm 命中约 0.05~0.15，ts_rank 命中 > 0.1
 *   取 0.08 留足余量同时截断纯噪音
 *
 * ⚠️ 与「索引化预过滤」的三角耦合（见文件头 [关键不变量]）：v1.87 `%` 腿消融后，三角
 *   的完整证明力只剩两个场景——**trgm-only 模式**（候选 = 两 `%` 腿，被排除 ⇒ 两相似度
 *   都 < 阈值）与两态预过滤下**两条 trgm 腿都在阈值下**的子集：
 *   ⇒ 合成分 < (0.6 + 活 headingW 0.5) × 0.05 = 0.055 < 0.08，余量 0.025。
 *   normal 模式 arms=0 的「content 相似但 heading 不相似」行已不再被该证明覆盖（content
 *   `%` 腿删除 = 接受的语义代价，REV-2）⇒ 三者仍不可独立调整，但调大 heading 权重/阈值
 *   的后果比旧文字描述的更局部。
 */
export const SCORE_FLOOR = 0.08;

/**
 * 单 CJK 字 / df 降级路径的常数分（计划 §2.5 / database N-⑥）：> SCORE_FLOOR(0.08)
 * 天然过线，score 可读刻度 = 「单点命中」档。全行同分（无逐行打分——重新引入 =
 * 557ms 病理回归，见文件头 DOCSEARCH-DEGRADED-CONST-SCORE）。
 * 守卫：test/single-cjk-char-path.e2e-spec.ts（以真 SCORE_FLOOR 为锚，地板漂移即红）。
 */
export const SINGLE_CHAR_CONST_SCORE = 0.1;

/**
 * 检索四模式（每次搜索先 compileQuery，按编译产物裁决；计划 §2.2/§2.5 + 主脑裁决 #7）：
 * - `trgm-only`：isEmpty（纯标点/全剥离查询）——去 ts select、预过滤 ts 分支与 K-gate；
 * - `single-char`：singleCjkChar——ts-only 候选 + 常数分 + 位置序 + 不跑 boost/rerank；
 * - `df-degraded`：df 预检（union-count `sv @@ :compiledQ` GIN count）超
 *   SEARCH_DF_DEGRADE_THRESHOLD——同 single-char 杠杆（高频 bigram 同病灶，§2.5）；
 * - `normal`：`ts_rank_cd × SEARCH_TS_W1` + 编译预过滤 + K-gate 结构门。
 */
type DocSearchMode = 'trgm-only' | 'single-char' | 'df-degraded' | 'normal';

/** Snippet 最大字符数 */
const SNIPPET_MAX_CHARS = 300;

/** 纯 trgm 命中时，匹配子串前后各取字符数 */
const SNIPPET_CONTEXT_CHARS = 150;

/** 默认返回条数 */
const DEFAULT_LIMIT = 5;
/** 最大返回条数 */
const MAX_LIMIT = 20;

interface SearchRow {
  doc_id: string;
  doc_path: string;
  doc_title: string;
  /** 文档创建时间（v1.55 时间序排序 + 时间窗过滤的 ORDER BY/WHERE 载体） */
  doc_created_at: string;
  section_position: number;
  heading_path: string | null;
  section_content: string;
  ts_rank_score: number;
  trgm_content_score: number;
  trgm_heading_score: number;
  /**
   * 候选所在空间的可见性（**仅重排池查询投影**：`COALESCE(ds.settings->>'visibility','open')`）。
   *
   * 原路径不投影该列（保持 SQL 与查询计划逐字节不变）；重排池需要它做可见性闸。
   */
  space_visibility?: string | null;
}

/** doc_routes 相似度查询行（raw row：PG 数值列经驱动返回 string） */
interface RouteSimilarityRow {
  id: string;
  primary_doc_id: string;
  secondary_doc_id: string | null;
  intent_similarity: string;
  category_similarity: string;
}

/** 单 doc 的路由加权结果：乘数 + 用于 boosts 透出的角色标签 */
interface RouteBoost {
  multiplier: number;
  label: 'primary' | 'secondary';
}

@Injectable()
export class DocSearchService {
  private readonly logger = new Logger(DocSearchService.name);

  constructor(
    @InjectRepository(DocSection)
    private readonly sectionRepo: Repository<DocSection>,
    @InjectRepository(Doc)
    private readonly docRepo: Repository<Doc>,
    @InjectRepository(DocRoute)
    private readonly routeRepo: Repository<DocRoute>,
    @InjectRepository(TaskDocLink)
    private readonly taskLinkRepo: Repository<TaskDocLink>,
    /**
     * 判别内核的通用编排（v1.85.0 批次 3）：重排是**可选增强**——`isEnabled('rerank')` 为假时
     * 本 service 走原路径，完全不碰内核（不调用、不写日志、不占额度）。闸门/落行纪律都在内核。
     */
    private readonly judgment: JudgmentRunnerService,
  ) {}

  /**
   * Search documents within accessible spaces using dual scoring + intent fusion.
   *
   * Scoring:
   *   composite = ts_rank_cd(search_vector, :compiledQ) × SEARCH_TS_W1
   *             + similarity(content, query) × TRGM_CONTENT(0.6)
   *             + similarity(heading_path, query) × SEARCH_TRGM_HEADING_W(0.5)
   *   → SQL SCORE_FLOOR 过滤后，命中 doc 再叠加两路乘数（plan §4-C3 三路融合）：
   *     ① 策展路由命中：命中路由的 primaryDoc ×1.5 / secondaryDoc ×1.2（取最大不叠加）
   *     ② 任务链接数：×(1 + min(count, 5) × 0.05)，封顶 ×1.25
   *
   * Filtering:
   *   - Only spaces in accessibleSpaceIds
   *   - docs.deleted_at IS NULL
   *   - Optional type / tag / category filters
   *   - 索引化预过滤（v1.84.0-dev 引入；v1.87 起按 `compiled.arms.length` 分两态）：
   *     arms≥1 = `search_vector @@ <词项 OR>`（两 `%` 腿已删）；arms=0 = 追加
   *     `OR heading_path % q`——不改分数、不引入新结果，纯粹把「逐行算合成分」
   *     压成 BitmapOr 候选集；必须是**最终召回集**的超集（两态证明与守卫见文件头
   *     [关键不变量]）
   *
   * Score floor: composite > SCORE_FLOOR (0.08) —
   *   filters zero-relevance noise that pg_trgm would otherwise pass through.
   *   ⚠️ 边界（plan §4 明文）：boost 在 floor 之后执行——只重排、不引入新结果；
   *   query 与 doc 内容零重叠但仅与路由 intent 重叠的 doc 不会召回，留待未来版本。
   *
   * Snippet:
   *   - ts_headline when ts_rank > 0
   *   - Fallback: matched substring ±150 chars, ≤300 chars total
   *
   * Sorting（v1.55 sort 接管语义）:
   *   - sort='relevance'（缺省，现有行为不变）：SQL ORDER BY score DESC, position ASC；
   *     boost 融合在 Node 侧应用并重排（页内重排——翻页时 boost 只重排当前页，
   *     不跨页搬移命中，与「boost 只重排、不引入新结果」边界一致）。
   *   - sort='createdAt_desc'/'createdAt_asc'：时间序**接管 ORDER BY**（docs.created_at
   *     + section_position ASC 平局兜底），双评分仅保留 SCORE_FLOOR 噪音过滤——
   *     boost 融合**仅适用相关度排序**，时间序下完全跳过（不查询、不应用、不透出
   *     boosts，score 保留 SQL 原始合成分）。理由：时间序的业务意图是「按时间穷尽
   *     遍历」（如读最近 N 天日记），策展/任务链接加权会破坏时间连续性且无意义。
   *
   * Time window（v1.55 createdAfter/createdBefore）: 过滤 docs.created_at，
   * 双侧**含边界**（>= / <=）——「最近 7 天」按 now-7d 取 createdAfter 时边界文档不丢。
   *
   * Pagination（v1.55 offset）: SQL OFFSET，与 limit 配对穷尽翻页；缺省 0。
   *
   * 可解释性：命中携带 boosts（route/taskLinks）透出加权来源；无 boost 省略该键
   * （时间序下恒省略）。
   *
   * @param accessibleSpaceIds - Whitelist from AccessQueryService (null = admin, all spaces)
   * @param query - Search parameters (q, type, tag, category, limit, offset, sort,
   *   createdAfter, createdBefore)
   * @returns Ranked search hits
   */
  async search(
    accessibleSpaceIds: string[] | null,
    query: {
      q: string;
      type?: string;
      tag?: string;
      category?: string;
      limit?: number;
      offset?: number;
      sort?: DocSearchSort;
      createdAfter?: string;
      createdBefore?: string;
    },
    options: {
      /** 当前统一身份（判别重排的身份闸：仅 agent 启用；人类/web 不受影响） */
      actor?: UnifiedActor | null;
      /** 本次请求 id（`@RequestId()` 经 middleware 归一化后传入；仅作日志线索） */
      traceId?: string | null;
    } = {},
  ): Promise<DocSearchResponse> {
    const {
      q,
      type,
      tag,
      category,
      limit = DEFAULT_LIMIT,
      offset = 0,
      sort = 'relevance',
      createdAfter,
      createdBefore,
    } = query;
    const effectiveLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    // offset 防御性下钳 0（controller/DTO 层已拦格式，此处兜底 Service 直调）
    const effectiveOffset = Math.max(offset, 0);
    const filters = { q, type, tag, category, createdAfter, createdBefore };
    const sortByTime = sort === 'createdAt_desc' || sort === 'createdAt_asc';

    // 空查询短路：`?q=`（空串/纯空白）是**合法请求形态**，语义与改动前一致（空 q 下
    // 打分恒 0 ⇒ 全被地板滤掉）——不是「检索未命中」，**不落零命中日志、不带 hint**。
    // ⚠️ 与契约③ `compiled.isEmpty → trgm-only` 是**两条路径**（纯标点等走 trgm-only
    // 真检索，不是返回空），别合并（recon §4-4）。
    if (q.trim().length === 0) {
      return { hits: [] };
    }
    // Empty whitelist short-circuit (non-admin with zero accessible spaces)
    if (accessibleSpaceIds !== null && accessibleSpaceIds.length === 0) {
      return { hits: [] };
    }

    // ── 四模式裁决（每次搜索先 compileQuery，主脑裁决 #7）────────────────────
    const compiled = compileQuery(q);
    const mode = await this.resolveMode(compiled);
    const degraded = mode === 'single-char' || mode === 'df-degraded';

    // ── 重排触发（v1.85.0 批次 3）─────────────────────────────────────────────
    // 五个条件缺一不可（plan 终裁）：能力已启用（provider 可用 + 白名单）→ 身份是 agent →
    // 相关度排序 → offset 落在窗口（limit 的整数倍且 offset+limit ≤ poolSize）→ 身份/排序
    // 之外还需"池里确实有候选"（由下面的空池早退承担）。
    // ⚠️ 任一条件不满足都走**原路径**（`searchBySqlOrder`），逐字节与未接入判别前一致。
    // ⚠️ **降级模式（单字/df）在 rerankActive 计算前短路**（主脑裁决 #6）：常数分池喂
    // 重排无意义且违反 `section_position, doc_id` 双键排序不变量。
    const poolSize = Math.min(effectiveLimit + RERANK_POOL_DEPTH, RERANK_MAX_POOL_SIZE);
    const rerankActive =
      !degraded &&
      this.judgment.isEnabled(docSearchRerankCapability.name) &&
      isRerankEligible(options.actor ?? null) &&
      sort === 'relevance' &&
      effectiveOffset % effectiveLimit === 0 &&
      effectiveOffset + effectiveLimit <= poolSize;

    let hits: DocSearchHit[];
    if (!rerankActive) {
      hits = await this.searchBySqlOrder(
        accessibleSpaceIds,
        filters,
        effectiveLimit,
        effectiveOffset,
        sort,
        mode,
        compiled,
      );
      return this.finalizeResponse(hits, q, compiled, mode, sortByTime);
    }

    const pool = await this.fetchRerankPool(accessibleSpaceIds, filters, poolSize, mode, compiled);
    // 空候选**不发起付费调用**（与既有 `rows.length === 0` 早退同语义、同结果）
    if (pool.length === 0) {
      return this.finalizeResponse([], q, compiled, mode, sortByTime);
    }

    // 可见性闸：池内任一候选属非 open 空间 ⇒ 放弃本次重排（落标量行，**不带 candidateDocIds**
    // ——把"哪些文档被挡下"写进日志等于反向泄露"某私有空间存在这些文档"）。
    // 回落到原路径（**不是**池切片）：非 active 结局一律与原路径逐字节一致，避免"私有空间在池里"
    // 时出现与未启用判别时不同的排序（池 SQL 的 ORDER BY 比原路径多一个 doc_id 平局键）。
    if (pool.some((row) => (row.space_visibility ?? 'open') !== 'open')) {
      await this.judgment.recordSkip(
        docSearchRerankCapability.name,
        options.actor ?? null,
        'visibility_blocked',
      );
      hits = await this.searchBySqlOrder(
        accessibleSpaceIds,
        filters,
        effectiveLimit,
        effectiveOffset,
        sort,
        mode,
        compiled,
      );
      return this.finalizeResponse(hits, q, compiled, mode, sortByTime);
    }

    hits = await this.searchWithRerank(
      accessibleSpaceIds,
      filters,
      pool,
      effectiveLimit,
      effectiveOffset,
      options.actor ?? null,
      options.traceId ?? null,
      mode,
      compiled,
    );
    return this.finalizeResponse(hits, q, compiled, mode, sortByTime);
  }

  /**
   * @internal 四模式裁决（判别顺序钉死，见文件头 [关键不变量]）：
   * isEmpty → trgm-only；singleCjkChar → 单字路径；否则 df 预检（union-count 口径，
   * 主脑裁决 #3）超 SEARCH_DF_DEGRADE_THRESHOLD → df-degraded；其余 normal。
   */
  private async resolveMode(compiled: CompiledQuery): Promise<DocSearchMode> {
    if (compiled.isEmpty) return 'trgm-only';
    if (compiled.singleCjkChar !== null) return 'single-char';
    if (await this.isDfOverThreshold(compiled)) return 'df-degraded';
    return 'normal';
  }

  /**
   * @internal df 预检（union-count 口径，主脑裁决 #3）：`sv @@ :compiledQ` 的 GIN count
   * = 候选集大小 = 逐行 cd 打分成本的直接量度（计划字面"按词项 df"→ 裁决为 union 口径）。
   * 高频多字 bigram 与单字同病灶（K=1 短查询无结构过滤 ⇒ 候选集可达整表 ⇒ 逐行打分，
   * 60k 候选实测 830-941ms/本地）——超阈即走降级（杠杆在候选集，不在打分）。
   *
   * 走 typed QueryBuilder（F1 硬约束：`:compiledQ` 只经 setParameter 下发）；
   * SQL 侧 `to_tsquery('simple', …)` 包裹（硬契约——tsqueryin 原子语义与编译器
   * parser 语义错位，2026-09-26 批次 1-b 实证；包裹后实参类型已确定为 tsquery，
   * 不再需要显式 cast）。
   */
  private async isDfOverThreshold(compiled: CompiledQuery): Promise<boolean> {
    const row = await this.sectionRepo
      .createQueryBuilder('s')
      .select('count(*)', 'c')
      // to_tsquery 包裹（硬契约，同 search-sql.ts：tsqueryin 原子语义与编译器 parser
      // 语义错位）；参数表达式 initplan 求值一次，非 per-row
      .where(`s.search_vector @@ to_tsquery('simple', :${COMPILED_Q_PARAM})`)
      .setParameter(COMPILED_Q_PARAM, compiled.tsquery)
      .getRawOne<{ c: string }>();
    return Number(row?.c ?? 0) > SEARCH_DF_DEGRADE_THRESHOLD;
  }

  /**
   * @internal 信封组装（主脑裁决 #1：裸数组 → `{ hits, hint?, hintCode? }`，hint 缺省
   * 不出现）+ 零命中/弱命中结构化日志（计划 §2.6：四路搜索零命中分支各调一次）。
   *
   * hint 三态触发规则（`hintCode` 与 hint 一一对应；v1.89.0-dev 批次 A 起弱命中独立文案）：
   * - **零命中** ⇒ `logSearchZeroHit` + `DOC_SEARCH_ZERO_HIT_HINT` / `'zero_hit'`
   *   （无论模式——降级查询零命中时「换词」比「位置序声明」更可操作）；
   * - **降级路径**（单字/df）且相关度排序 ⇒ `DOC_SEARCH_POSITIONAL_ORDER_HINT` /
   *   `'positional_order'`（注明未按相关度排序；时间序是用户显式选择的遍历语义，不附加）；
   * - **弱命中**（normal/trgm-only，**有结果**但最高分 < **`DOC_SEARCH_WEAK_HIT_SCORE`**
   *   = 基准 0.3 × `SEARCH_TS_W1` 现构**）** ⇒ `logSearchWeakHit` +
   *   `DOC_SEARCH_WEAK_HIT_HINT` / `'weak_hit'`（结果已返回、可能正是答案，第一动作是
   *   "先用"；**不再复用零命中文案**——复用会让消费方丢掉已召回的结果）。
   *   降级路径常数分 0.1 恒 < 本线，已在上一分支拦截不参与本判定。
   *
   * ⚠️ 弱命中线必须读**现构**（主脑裁决 R4，批次 1-d2）：基准 0.3 是"cd 单点 0.1 ×
   * W1=1.0"尺度下的刻度，而本模式的合成分含 `ts_rank_cd × SEARCH_TS_W1` 项 ⇒ 尺度随
   * W1 整体放大；直读基准线在 W1=3.0 时被单点命中（0.1×3=0.3）恰好触线，弱命中分支
   * 整体失效（1-d1 实测 3~4 条 → 0 条）。task q= 侧 rank 未乘 W1，故仍用基准值
   * （`TASK_SEARCH_WEAK_HIT_SCORE`）——两侧分家是裁决的一部分，别把两边改成同一个。
   * ⚠️ trgm-only（isEmpty）与 normal **共用本线**（按 R4 字面：doc-search 侧统一取现构）。
   * trgm-only 无 ts 项 ⇒ 其尺度其实未随 W1 变化，理论上更贴近基准线；判据是"纯标点查询
   * 本就不该有强命中"，故统一线的实际语义更保守（更愿意给引导）而非漏给。若将来实测
   * trgm-only 的 hint 频率失真，**本条就是拆线的落点**（拆法同 task：给 trgm-only 一份基准值）。
   *
   * ⚠️ `hintCode` 只在 hint 存在时出现（**禁 null**——消费方 jest `toEqual` 严格相等断言在册）。
   */
  private finalizeResponse(
    hits: DocSearchHit[],
    q: string,
    compiled: CompiledQuery,
    mode: DocSearchMode,
    sortByTime: boolean,
  ): DocSearchResponse {
    let hint: string | undefined;
    let hintCode: DocSearchHintCode | undefined;
    if (hits.length === 0) {
      logSearchZeroHit(this.logger, {
        surface: 'doc',
        query: q,
        queryTruncated: compiled.queryTruncated,
        armTruncatedCount: compiled.armTruncatedCount,
      });
      hint = DOC_SEARCH_ZERO_HIT_HINT;
      hintCode = 'zero_hit';
    } else if (mode === 'single-char' || mode === 'df-degraded') {
      if (!sortByTime) {
        hint = DOC_SEARCH_POSITIONAL_ORDER_HINT;
        hintCode = 'positional_order';
      }
    } else {
      const topScore = Math.max(...hits.map((hit) => hit.score));
      if (topScore < DOC_SEARCH_WEAK_HIT_SCORE) {
        // 弱命中观测：安全相关（阈值漂移靠日志发现），且测试兜不住线上量级——独立 tag + debug
        logSearchWeakHit(this.logger, { query: q, topScore });
        hint = DOC_SEARCH_WEAK_HIT_HINT;
        hintCode = 'weak_hit';
      }
    }
    return hint === undefined ? { hits } : { hits, hint, hintCode };
  }

  /**
   * 原路径（**重排未启用 / 被闸跳过 / 降级模式时的唯一出口**）：SQL LIMIT/OFFSET →
   * （非降级且相关度排序时）boost 融合 → 命中构建。
   *
   * 模式分支（四模式，见文件头 [关键不变量]）：
   * - 降级（单字/df）：排序 = `section_position ASC, doc_id ASC`（doc_id 末位平局键），
   *   **不跑 boost 融合**（boost 会打破位置序）；
   * - 时间序接管 ORDER BY 优先于模式位置序（v1.55 sort 契约：按时间穷尽遍历）；
   * - normal/trgm-only + 相关度：既有 `score DESC, position ASC` + boost 融合不变。
   *
   * @param accessibleSpaceIds 可访问空间白名单（null = admin 全量）
   * @param filters 过滤条件（q / type / tag / category / 时间窗）
   * @param effectiveLimit 已下钳的 limit
   * @param effectiveOffset 已下钳的 offset
   * @param sort 排序模式（时间序接管 ORDER BY 且跳过 boost 融合）
   * @param mode 检索四模式（`resolveMode` 裁决）
   * @param compiled 查询编译产物（打分/预过滤/K-gate/snippet 共用）
   * @returns 命中列表（≤ limit）
   */
  private async searchBySqlOrder(
    accessibleSpaceIds: string[] | null,
    filters: {
      q: string;
      type?: string;
      tag?: string;
      category?: string;
      createdAfter?: string;
      createdBefore?: string;
    },
    effectiveLimit: number,
    effectiveOffset: number,
    sort: DocSearchSort,
    mode: DocSearchMode,
    compiled: CompiledQuery,
  ): Promise<DocSearchHit[]> {
    const { q } = filters;
    // 时间序接管 ORDER BY：boost 融合仅适用相关度排序（见方法注释）
    const sortByTime = sort === 'createdAt_desc' || sort === 'createdAt_asc';
    const degraded = mode === 'single-char' || mode === 'df-degraded';

    const mainQb = this.buildScoredQuery(accessibleSpaceIds, filters, false, mode, compiled);
    if (degraded && !sortByTime) {
      // 降级路径（相关度）：常数分下 position 平局大量存在 ⇒ doc_id 末位平局键必需
      // （对齐 fetchRerankPool 既有池序不变量；缺则分页/结果不可复现，architect N-a）
      mainQb
        .orderBy('sub.section_position', 'ASC')
        .addOrderBy('sub.doc_id', 'ASC')
        .limit(effectiveLimit);
    } else {
      // 排序接管（v1.55 sort）：时间序按 docs.created_at（section_position ASC 平局兜底）；
      // 相关度（缺省）保持既有 score DESC, position ASC——boost 重排语义见方法注释
      mainQb
        .orderBy(
          sortByTime ? 'sub.doc_created_at' : 'score',
          sortByTime ? (sort === 'createdAt_desc' ? 'DESC' : 'ASC') : 'DESC',
        )
        .addOrderBy('sub.section_position', 'ASC')
        .limit(effectiveLimit);
    }
    // 翻页（v1.55 offset）：仅在 >0 时附加，保持缺省查询计划与既有行为一致
    if (effectiveOffset > 0) {
      mainQb.offset(effectiveOffset);
    }
    const rows = await mainQb.getRawMany<SearchRow & { score: number }>();

    // 无命中直接短路，跳过两路 boost 查询。
    if (rows.length === 0) {
      return [];
    }

    // ── 时间序分支（v1.55）：ORDER BY 已由 SQL 按 created_at 接管，boost 融合
    //    仅适用相关度排序——时间序下跳过两路 boost 查询与 Node 侧重排，SQL 顺序
    //    即最终顺序（score 保留原始合成分，不透出 boosts）。
    // ── 降级分支（计划 §2.5 + 主脑裁决 #6）：常数分 + 位置序 ⇒ boost 融合同样跳过
    //    （boost 会打破 `section_position, doc_id` 双键序），SQL 顺序即最终顺序。
    if (sortByTime || degraded) {
      // snippet 通道判据：降级路径候选 = ts-only ⇒ 每行 ts 必中；normal/trgm-only 按行内
      // ts 分是否 >0 判定（trgm-only 模式 ts 项恒 0 ⇒ 恒走 trgm 窗口 snippet）
      return Promise.all(
        rows.map((row) =>
          this.buildHit(row, q, compiled, degraded ? true : Number(row.ts_rank_score) > 0),
        ),
      );
    }

    // ① 策展路由命中：命中路由的 primaryDocId ×1.5 / secondaryDocId ×1.2
    const routeBoosts = await this.computeRouteBoosts(accessibleSpaceIds, q);
    // ② 任务链接加权：×(1 + min(count, 5) × 0.05)，封顶 ×1.25（docId 去重防重复计数）
    const taskLinkCounts = await this.countTaskLinksByDoc([
      ...new Set(rows.map((row) => row.doc_id)),
    ]);

    // Build hits
    const hits: DocSearchHit[] = [];
    for (const row of rows) {
      const hit = await this.buildHit(row, q, compiled, Number(row.ts_rank_score) > 0);

      // ③ 应用两路乘数并透出 boosts（可解释性：调用方知道结果为何排前）
      // 算式**单源**在 `applyBoosts`（重排池共用同一条）：两处各写一份乘数迟早漂移。
      // 无任何 boost 的命中分数不变、boosts 键省略（taskLinks=0 视为无 boost——GROUP BY
      // 实际不会产出 0 行，此处为防御性语义）。
      this.applyBoosts(hit, row.doc_id, routeBoosts, taskLinkCounts);

      hits.push(hit);
    }

    // ④ 重排：boost 后按 score DESC、position ASC 重新排序（对齐既有 ORDER BY 语义；
    //    无 boost 时分数不变，JS sort 稳定 + position 平局兜底，顺序与 SQL 结果一致）
    hits.sort((a, b) => b.score - a.score || a.position - b.position);

    return hits;
  }

  /**
   * @internal 共用的**打分查询构造**（原路径与重排池必须同一条 SQL）。
   *
   * 为什么必须共用：重排的整个承诺是"只在**同一候选集**内重排"——两处各写一份打分/预过滤
   * 迟早漂移（预过滤是"召回超集"的证明、SCORE_FLOOR 是噪音闸，都靠这一份代码成立）。
   *
   * 四模式 SQL 形态（计划 §2.2/§2.5；`:compiledQ`/`:armN`/`:kGateK` 全经 setParameter
   * 下发 + SQL 侧 `to_tsquery('simple', …)` 包裹，F1 硬约束）：
   * - normal：内层 `COALESCE(ts_rank_cd(s.search_vector, to_tsquery('simple', :compiledQ)), 0)`
   *   + 两个 similarity
   *   腿（raw `:q`，v1.87 起**打分腿全保留**——ASCII 半分来源 + CJK 平局破除键，
   *   消融实测删了 4 条命中翻 miss）+ 预过滤（v1.87 REV-2 按 arms 分两态）：
   *   · arms≥1 ⇒ `sv @@ to_tsquery('simple', :compiledQ)`（两 `%` 腿消融）
   *   · arms=0 ⇒ 上式 `OR heading_path % :q`（content `%` 腿消融）
   *   + **K-gate 结构门**（逐 arm 绑定 + to_tsquery 包裹，arms 非空时）；
   *   外层合成分 = cd × SEARCH_TS_W1 + trgm 两腿加权 > SCORE_FLOOR。
   * - trgm-only（isEmpty）：去 ts select（ts 项恒 0）、预过滤 ts 分支与 K-gate——纯标点
   *   查询没有可编译词项，ts 腿结构上不可能命中（契约③按面枚举），`%` 两腿是召回本体。
   * - 降级（单字/df）：候选 = **ts-only**（两 `%` 腿明文不查——单字 trgm 噪声大，排除是
   *   精度增益）+ ts 命中标记恒 1 + trgm 腿恒 0（绕开逐行打分）+ 外层合成分 = 常数
   *   SINGLE_CHAR_CONST_SCORE（> floor 天然过线）。
   *
   * 预过滤召回保全（v1.87 REV-2 后的准确表述，逐态见文件头 [关键不变量]）：
   * - arms≥1：被排除 ⇒ `sv @@ :compiledQ` 假 ⇒ **K-gate 计数 0 < K** ⇒ 该行本就不在最终集
   *   （结构证明，与相似度无关）；故 ts-only 候选不丢任何最终结果。
   * - arms=0：被排除 ⇒ cd = 0 且 heading 相似度 < 0.05；若 content 相似度也 < 0.05 则
   *   合成分 < (0.6 + 活 headingW 0.5) × 0.05 = 0.055 < 0.08 ✓ **安全**；若 content
   *   相似度 ≥ 0.05（旧 content `%` 腿会救回的行）⇒ **接受的语义代价**：content 级 typo
   *   模糊容忍下线（REV-2 实测该腿精度 0.71%）。
   *
   * @param accessibleSpaceIds 可访问空间白名单（null = admin 全量）
   * @param filters 过滤条件（q / type / tag / category / 时间窗）
   * @param withVisibilityProjection 是否投影候选所在空间的可见性（**仅重排池需要**）：
   *   多一个 `leftJoin doc_spaces` + `COALESCE(ds.settings->>'visibility','open')`。
   *   ⚠️ 必须 `leftJoin`（innerJoin 在空间行缺失时会静默丢召回）；⚠️ **不要**顺手加
   *   `ds.deleted_at IS NULL`——召回面今天由 `accessibleSpaceIds` 白名单承载，别在查询层
   *   引入第二处过滤（真库 EXPLAIN 已钉 BitmapOr 不回退，见 doc-search-rerank e2e）。
   * @param mode 检索四模式
   * @param compiled 查询编译产物
   */
  private buildScoredQuery(
    accessibleSpaceIds: string[] | null,
    filters: {
      q: string;
      type?: string;
      tag?: string;
      category?: string;
      createdAfter?: string;
      createdBefore?: string;
    },
    withVisibilityProjection: boolean,
    mode: DocSearchMode,
    compiled: CompiledQuery,
  ) {
    const { q, type, tag, category, createdAfter, createdBefore } = filters;
    const degraded = mode === 'single-char' || mode === 'df-degraded';
    // 共享 SQL 导出组（**导出即组整体取用**：score/prefilter/headline/kGate 四段同源）；
    // trgm-only（isEmpty）时 builder 返回 null——该模式本就不用任何 ts 段
    const group: SearchSqlGroup | null =
      degraded || mode === 'normal'
        ? buildSearchSql(
            { vector: 's.search_vector', text: 's.content' },
            compiled,
            { startSel: '', stopSel: '' },
            SEARCH_KGATE_K_OVERRIDE,
          )
        : null;

    // 合成分表达式（模式分支；外层 SELECT 与 WHERE floor 共用同一串——两处各写一份迟早漂移）
    const compositeExpr = degraded
      ? `(${SINGLE_CHAR_CONST_SCORE})`
      : mode === 'trgm-only'
        ? `(sub.trgm_content_score * ${RANK_WEIGHTS.TRGM_CONTENT} + sub.trgm_heading_score * ${SEARCH_TRGM_HEADING_W})`
        : `(sub.ts_rank_score * ${SEARCH_TS_W1} + sub.trgm_content_score * ${RANK_WEIGHTS.TRGM_CONTENT} + sub.trgm_heading_score * ${SEARCH_TRGM_HEADING_W})`;

    const mainQb = this.sectionRepo.manager
      .createQueryBuilder()
      .select('sub.*')
      .addSelect(compositeExpr, 'score')
      .from((subQuery) => {
        const sqb = subQuery
          .select('d.id', 'doc_id')
          .addSelect('d.path', 'doc_path')
          .addSelect('d.title', 'doc_title')
          .addSelect('d.created_at', 'doc_created_at')
          .addSelect('s.position', 'section_position')
          .addSelect('s.heading_path', 'heading_path')
          .addSelect('s.content', 'section_content')
          .from('doc_sections', 's')
          .innerJoin('docs', 'd', 'd.id = s.doc_id')
          .leftJoin('doc_categories', 'dc', 'dc.id = d.category_id')
          .where('d.deleted_at IS NULL')
          .setParameter('q', q);

        // ── 打分三列（模式分支）───────────────────────────────────────────
        if (degraded) {
          // 降级：ts 命中标记恒 1（候选 = ts-only ⇒ 每行 ts 必中；snippet 通道判据），
          // trgm 两腿恒 0（绕开逐行 similarity——557ms 病理防线，计划 §2.5）
          sqb
            .addSelect('1', 'ts_rank_score')
            .addSelect('0', 'trgm_content_score')
            .addSelect('0', 'trgm_heading_score');
        } else if (mode === 'trgm-only') {
          // trgm-only：ts 项恒 0（编译产物无词项，ts 腿结构上不可能命中）
          sqb
            .addSelect('0', 'ts_rank_score')
            .addSelect('similarity(s.content, :q)', 'trgm_content_score')
            .addSelect("similarity(COALESCE(s.heading_path, ''), :q)", 'trgm_heading_score');
        } else {
          // normal：cd flag 0（长度无关；精度交给 K-gate 结构门而非浮点地板，计划 §2.3）
          sqb
            .addSelect(`COALESCE(${(group as SearchSqlGroup).scoreExpr}, 0)`, 'ts_rank_score')
            .addSelect('similarity(s.content, :q)', 'trgm_content_score')
            .addSelect("similarity(COALESCE(s.heading_path, ''), :q)", 'trgm_heading_score');
        }

        // ── 索引化预过滤（模式分支；超集证明见方法注释与文件头 [关键不变量]）────────
        // ② `%` 腿的**消融规则**（v1.87 REV-2，本批唯一行为变更）：`%` ⇔
        //    similarity >= pg_trgm.similarity_threshold，阈值由**连接级**下发为 0.05
        //    （src/database/pg-session-defaults.ts）——PG 默认 0.3 会漏掉 0.05~0.3 的候选。
        //    content `%` 腿是耗时本体（trgm GIN 结构性不能精确判 `%` ⇒ 逐行回表 detoast +
        //    similarity 重算；Q1 `ECONNREFUSED` 实测 189 行 / 1.4s、精度 0.71%）；
        //    heading `%` 腿仅 ~70ms 且承载 v1.84 heading 召回通道 ⇒ 按 arms 分臂处置：
        //    · arms≥1（含 CJK bigram）：**两腿皆删**——`%-only` 行被 K-gate 结构性吃掉
        //      （见下方门的注释），删腿零损失（全库「出境」19 条 `%-only` 行过闸 0 条）。
        //    · arms=0（纯 ASCII/全角）：**删 content、留 heading**（唯一保留的 `%` 腿）。
        //    语义代价（REV-2 明记，勿当 bug 修）：content 级 typo 模糊容忍已下线。
        // ③ heading_path 腿用**裸列**：NULL % q = NULL（不真，与 COALESCE(...,'') 语义
        //    一致），而 COALESCE 会破坏 GIN 索引匹配（索引建在裸列上）。
        if (degraded) {
          // 降级：ts-only 候选（两 `%` 腿明文不查）
          sqb.andWhere((group as SearchSqlGroup).prefilterExpr);
        } else if (mode === 'trgm-only') {
          // trgm-only：`%` 是召回本体（编译产物无词项可查），两腿原样保留
          sqb.andWhere('(s.content % :q OR s.heading_path % :q)');
        } else if (compiled.arms.length > 0) {
          // normal + arms≥1：ts-only 候选（`%` 两腿消融，见上方分臂处置）
          sqb.andWhere((group as SearchSqlGroup).prefilterExpr);
        } else {
          // normal + arms=0：ts 腿 + 仅 heading `%` 腿（content `%` 消融）
          sqb.andWhere(`(${(group as SearchSqlGroup).prefilterExpr} OR s.heading_path % :q)`);
        }

        // ── K-gate 结构门（**只挂 normal 模式**，主脑裁决 #2）：命中不同 bigram 计数
        //    ≥ K；逐 arm 绑定参数 + `to_tsquery('simple', …)` 包裹（导出组单源），arms 与
        //    compiledQ 同一 64 cap 集合
        //    （门集合 ⊊ 预过滤集合 = 静默丢召回，architect R1 复核）。无 arm（纯 ASCII /
        //    单字查询）时 kGateExpr 为 null 不挂门。
        if (mode === 'normal' && (group as SearchSqlGroup).kGateExpr !== null) {
          sqb.andWhere((group as SearchSqlGroup).kGateExpr as string);
        }
        if (group !== null) {
          sqb.setParameter(COMPILED_Q_PARAM, compiled.tsquery);
          sqb.setParameters(group.kGateParams);
        }

        if (accessibleSpaceIds !== null) {
          if (accessibleSpaceIds.length === 0) {
            return sqb.where('1 = 0');
          }
          sqb.andWhere('d.space_id IN (:...spaceIds)', { spaceIds: accessibleSpaceIds });
        }
        if (type) {
          sqb.andWhere('d.doc_type = :docType', { docType: type });
        }
        if (tag) {
          sqb.andWhere(':tagVal = ANY(d.tags)', { tagVal: tag });
        }
        if (category) {
          sqb.andWhere('dc.slug = :catSlug', { catSlug: category });
        }
        // 时间窗过滤（v1.55）：双侧含边界（>= / <=）——参数为 ISO 8601 字符串，
        // PG timestamptz 列与 ISO 文本比较安全（DTO @IsISO8601 已拦格式，层 1）
        if (createdAfter) {
          sqb.andWhere('d.created_at >= :createdAfter', { createdAfter });
        }
        if (createdBefore) {
          sqb.andWhere('d.created_at <= :createdBefore', { createdBefore });
        }

        // 可见性投影（**仅重排池**）：缺省 open ⇒ `COALESCE(ds.settings->>'visibility','open')`。
        // 裸判 `ds.settings->>'visibility' = 'open'` 会把"settings 无该键的空间"判成非 open
        // ⇒ 重排永远不激活（静默失效，正是本仓最常见的失败形态）。
        // ⚠️ 必须 `leftJoin`（innerJoin 在空间行缺失时静默丢召回）；⚠️ **不要**顺手加
        // `ds.deleted_at IS NULL`——召回面今天由 `accessibleSpaceIds` 白名单承载。
        if (withVisibilityProjection) {
          sqb
            .leftJoin('doc_spaces', 'ds', 'ds.id = d.space_id')
            .addSelect("COALESCE(ds.settings->>'visibility','open')", 'space_visibility');
        }

        return sqb;
      }, 'sub')
      .where(`${compositeExpr} > :scoreFloor`, { scoreFloor: SCORE_FLOOR });
    return mainQb;
  }

  /**
   * @internal 取重排池（`LIMIT poolSize OFFSET 0`，**同一打分查询** + 可见性投影）。
   *
   * 池 SQL 全序 = `score DESC, section_position ASC, doc_id ASC`：**doc_id 是必需的末位平局键**
   * ——原路径只有前两键（可平，PG 可任选），而"池内下标即 SQL 池名次"要求池顺序可复现。
   *
   * @param accessibleSpaceIds 可访问空间白名单
   * @param filters 过滤条件
   * @param poolSize 池深度（`min(limit + RERANK_POOL_DEPTH, RERANK_MAX_POOL_SIZE)`）
   * @returns 池行（含 `space_visibility`）
   */
  private async fetchRerankPool(
    accessibleSpaceIds: string[] | null,
    filters: {
      q: string;
      type?: string;
      tag?: string;
      category?: string;
      createdAfter?: string;
      createdBefore?: string;
    },
    poolSize: number,
    mode: DocSearchMode,
    compiled: CompiledQuery,
  ): Promise<Array<SearchRow & { score: number }>> {
    return this.buildScoredQuery(accessibleSpaceIds, filters, true, mode, compiled)
      .orderBy('score', 'DESC')
      .addOrderBy('sub.section_position', 'ASC')
      .addOrderBy('sub.doc_id', 'ASC')
      .limit(poolSize)
      .getRawMany<SearchRow & { score: number }>();
  }

  /**
   * @internal 重排路径（能力已启用 + 身份/排序/窗口全满足 + 池非空 + 可见性全 open）。
   *
   * 流程：池内 boost 两路 → 出境计划（节选 + 预算裁剪）→ 基线序 → 决策闭包 → 内核调用 →
   * **按最终序切片** → 命中构建（boost 透出）。
   *
   * **统一不变量（终审 MAJOR-3）**：只要**不是"active 且求解成功"**，返回值一律来自
   * `searchBySqlOrder`（与未启用重排**逐字节一致**）——包括闸门跳过（额度/出境）、provider
   * 失败（error/timeout）、可见性闸，以及求解失败（`solverFailed`，防御保险丝）。
   * 代价是这类结局多一次 SQL 查询（少数路径，**正确性优先**）：池切片与原路径在 boost 跨页与
   * (score, position) 平局样本上**不保证同集合/同序**，而"启用判别不该改变未成功时的结果"
   * 是比"省一次查询"更硬的承诺。
   *
   * 条数不变量：active 成功时最终序是池的**排列**（求解器保证双射），故
   * `slice(offset, offset+limit)` 的条数与未启用重排时**恒等**；非成功结局则由同一条原路径
   * 保证（同一 SQL、同一分页参数）。
   *
   * 指标口径（终审 MAJOR-2）：`sqlTop1Key` / `finalTop1Key` 都取自**同一路径的池序**
   * （`baselineKeys` = 池的"含 boost"序），故 `reordered@1` 只在**模型真的改变页首**时为真；
   * 非成功结局由决策闭包把两者设为同值 ⇒ `reordered@1 = false`、页级变动率 = 0，
   * 不会被"boost 是否改变页首"这类无关因素污染。
   */
  private async searchWithRerank(
    accessibleSpaceIds: string[] | null,
    // 类型与 `searchBySqlOrder` / `fetchRerankPool` 的形参**逐字同形**（含时间窗）：它会被原样
    // 转发给两者，窄类型会让"带时间窗的重排请求"在编译期看起来不可达（复审 NEW-4）
    filters: {
      q: string;
      type?: string;
      tag?: string;
      category?: string;
      createdAfter?: string;
      createdBefore?: string;
    },
    pool: Array<SearchRow & { score: number }>,
    limit: number,
    offset: number,
    actor: UnifiedActor | null,
    traceId: string | null,
    mode: DocSearchMode,
    compiled: CompiledQuery,
  ): Promise<DocSearchHit[]> {
    const q = filters.q;
    // ① 两路 boost（与原路径同款，作用域扩到池的 docId 集合；逐 doc 的乘法值不变）
    const routeBoosts = await this.computeRouteBoosts(accessibleSpaceIds, q);
    const taskLinkCounts = await this.countTaskLinksByDoc([
      ...new Set(pool.map((row) => row.doc_id)),
    ]);

    // ② 候选（**键 = 池内 0-based 序号**；score = boost 后合成分 = 最终序的第二键）
    const candidates: RerankCandidate[] = pool.map((row, index) => ({
      key: `c${index}`,
      index,
      docId: row.doc_id,
      position: Number(row.section_position),
      title: row.doc_title,
      content: row.section_content,
      score: this.boostedScoreOf(row.doc_id, row.score, routeBoosts, taskLinkCounts),
    }));

    // ③ 出境计划：节选 ≤240 字节 + q+state+questions ≤16KB 的池尾裁剪
    const plan = planRerankCandidates(q, candidates);

    // ④ 基线序 = **SQL 含 boost 顺序**（未启用重排时今天会返回的顺序；doc_id 末位平局键使其全序）
    const baselineKeys = [...candidates]
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.position - b.position ||
          (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0),
      )
      .map((candidate) => candidate.key);

    // ⑤ 决策闭包（**带记忆**）：日志载荷（`toLogPayload`）与返回排序读**同一次**求解结果，
    //    避免"日志说一套、返回另一套"这种最难查的偏差
    let decision: DocRerankDecision | null = null;
    const decide = (value: DocRerankValue | null): DocRerankDecision => {
      if (decision) return decision;
      const tiers: (number | null)[] = new Array(candidates.length).fill(null);
      if (value) {
        // 档位按"入包候选序"给，映射回池下标（未送模型的池尾候选保持 null ⇒ 求解时按 0）
        plan.candidates.forEach((candidate, position) => {
          tiers[candidate.index] = value.tiers[position] ?? null;
        });
      }
      const orderKeys = value ? solveDocRerank(candidates, tiers, offset, limit) : null;
      decision = {
        tiers,
        finalOrderKeys: orderKeys,
        // 求解失败 = 模型给了档位但位置带无解（严格区别于"没跑成"：那时 value 为 null）
        solverFailed: value !== null && orderKeys === null,
        sqlTop1Key: baselineKeys[offset] ?? null,
        finalTop1Key: (orderKeys ?? baselineKeys)[offset] ?? null,
      };
      return decision;
    };

    const input: DocRerankInput = {
      query: q,
      plan,
      poolSize: candidates.length,
      eligibleForPromotion: Math.max(0, candidates.length - (offset + limit)),
      traceId,
      decide,
    };

    // ⑥ 内核编排：出境闸 → 配额 → provider → 日志行（标量 + id，不落原文）
    const result = await this.judgment.run(docSearchRerankCapability, input, actor);

    if (result.status !== 'ok') {
      // 非成功结局（闸门跳过 / error / timeout）→ **原路径**（统一不变量，见方法 JSDoc）。
      // 日志行已由内核写好（skipped 标量行 / 失败行），且决策闭包在 `toLogPayload` 里已按
      // `value = null` 记下 `finalOrderKeys: null`（指标上等价于"本次未重排"）。
      return this.searchBySqlOrder(
        accessibleSpaceIds,
        filters,
        limit,
        offset,
        'relevance',
        mode,
        compiled,
      );
    }

    const resolved = decide(result.value);

    if (resolved.solverFailed) {
      // fail-open（**放宽下界是被禁止的**，只能整段弃用模型序）：warn + 回原路径。
      // 日志行 `status` 保持 ok（provider 确实成功；把求解失败记成 provider error 会污染
      // "失败率"分母），fail-open 由 `finalOrderKeys: null` 留痕。
      this.logger.warn(
        `rerank placement failed (fail-open, ${candidates.length} candidates, ` +
          `offset=${offset} limit=${limit}): falling back to the SQL order`,
      );
      return this.searchBySqlOrder(
        accessibleSpaceIds,
        filters,
        limit,
        offset,
        'relevance',
        mode,
        compiled,
      );
    }

    // ⑦ 最终序切片 → 命中（**先切片再 buildHit**：只对返回页生成 snippet，页外候选不付 snippet 成本）
    const orderKeys = resolved.finalOrderKeys as string[];
    const hits: DocSearchHit[] = [];
    for (const key of orderKeys.slice(offset, offset + limit)) {
      const candidate = candidates[Number(key.slice(1))];
      if (!candidate) continue; // 防御性：键形恒为 c{index}
      const row = pool[candidate.index];
      const hit = await this.buildHit(row, q, compiled, Number(row.ts_rank_score) > 0);
      this.applyBoosts(hit, row.doc_id, routeBoosts, taskLinkCounts);
      // 走到这里 = **active 且求解成功** ⇒ 恒定标记 `reranked`（非成功结局已在上面回原路径，
      // 不会经过本循环）——调用方据此判断"本条命中的页内位置由模型排序决定"
      hit.reranked = true;
      hits.push(hit);
    }
    return hits;
  }

  /**
   * @internal 应用两路 boost（**原路径与重排池共用同一算式**：两处各写一份乘数迟早漂移，而
   * "重排分数/boosts 语义不变"的承诺建立在这份唯一性上）。
   *
   * @returns 应用后的分数（重排路径据此取排序平局键；原路径忽略返回值）
   */
  private applyBoosts(
    hit: DocSearchHit,
    docId: string,
    routeBoosts: Map<string, RouteBoost>,
    taskLinkCounts: Map<string, number>,
  ): number {
    const route = routeBoosts.get(docId);
    const taskLinks = taskLinkCounts.get(docId);
    const hasRoute = route !== undefined;
    const hasTaskLinks = taskLinks !== undefined && taskLinks > 0;
    if (hasRoute || hasTaskLinks) {
      if (hasRoute) {
        hit.score *= route.multiplier;
      }
      if (hasTaskLinks) {
        hit.score *= 1 + Math.min(taskLinks, TASK_LINK_CAP) * TASK_LINK_STEP;
      }
      hit.boosts = {};
      if (hasRoute) {
        hit.boosts.route = route.label;
      }
      if (hasTaskLinks) {
        hit.boosts.taskLinks = taskLinks;
      }
    }
    return hit.score;
  }

  /** @internal 纯计算版 boost（不改命中对象；重排候选的排序平局键用它） */
  private boostedScoreOf(
    docId: string,
    baseScore: number,
    routeBoosts: Map<string, RouteBoost>,
    taskLinkCounts: Map<string, number>,
  ): number {
    const route = routeBoosts.get(docId);
    const taskLinks = taskLinkCounts.get(docId);
    let score = baseScore;
    if (route !== undefined) score *= route.multiplier;
    if (taskLinks !== undefined && taskLinks > 0) {
      score *= 1 + Math.min(taskLinks, TASK_LINK_CAP) * TASK_LINK_STEP;
    }
    return score;
  }

  /**
   * 由单条 SQL 行构建命中项（snippet 生成 + 字段投影，不含 boost）
   *
   * 相关度排序与时间序排序共用的命中构建管线：ts 命中走 ts_headline（额外一次 SQL，
   * 作用于**单字化文本**），否则 trgm 子串窗口。boost 乘数仅由相关度分支在此结果上叠加。
   *
   * @param row - 双评分子查询原始行（含合成分 score）
   * @param q - 检索词（trgm snippet 窗口匹配用）
   * @param compiled - 查询编译产物（ts_headline 的 `:compiledQ` 绑定来源）
   * @param tsMatched - snippet 通道判据（由调用方按模式裁决：降级路径恒 true；
   *   normal/trgm-only 按行内 ts 分 >0）
   */
  private async buildHit(
    row: SearchRow & { score: number },
    q: string,
    compiled: CompiledQuery,
    tsMatched: boolean,
  ): Promise<DocSearchHit> {
    const snippet = tsMatched
      ? await this.buildTsHeadlineSnippet(row.doc_id, row.section_position, compiled, q)
      : this.buildTrgmSnippet(row.section_content, q);

    return {
      docId: row.doc_id,
      docPath: row.doc_path,
      docTitle: row.doc_title,
      position: Number(row.section_position),
      headingPath: row.heading_path ?? null,
      snippet: snippet.text,
      contentTruncated: snippet.truncated,
      score: Number(row.score),
    };
  }

  /**
   * 策展路由命中加权（plan §4-C3 三路融合之一）
   *
   * 一次 SQL 拉取查询空间全部路由及 PG `similarity()` 预计算分数——与正文检索同款函数，
   * 保证语义一致（单空间 ≤16 条规模，无索引压力），Node 侧按阈值过滤：
   * intent ≥ ROUTE_INTENT_FLOOR（0.15）或 category ≥ ROUTE_CATEGORY_FLOOR（0.3）即视为命中。
   * 命中路由的 primaryDocId → ×ROUTE_PRIMARY_BOOST（1.5）、secondaryDocId → ×ROUTE_SECONDARY_BOOST
   * （1.2）；同一 doc 同时被多条路由命中时取最大倍率（不叠加连乘，见 applyRouteBoost）。
   *
   * @param accessibleSpaceIds - 可访问空间白名单（null = admin，全量空间不过滤）
   * @param q - 检索词（与正文检索同参数，保证 similarity 打分一致）
   * @returns docId → { multiplier, label } 映射；未命中任何路由的 doc 不在映射中
   */
  private async computeRouteBoosts(
    accessibleSpaceIds: string[] | null,
    q: string,
  ): Promise<Map<string, RouteBoost>> {
    const boosts = new Map<string, RouteBoost>();

    const qb = this.routeRepo
      .createQueryBuilder('r')
      .select('r.id', 'id')
      .addSelect('r.primaryDocId', 'primary_doc_id')
      .addSelect('r.secondaryDocId', 'secondary_doc_id')
      .addSelect('similarity(r.intent, :q)', 'intent_similarity')
      .addSelect("similarity(COALESCE(r.category, ''), :q)", 'category_similarity')
      .setParameter('q', q);
    if (accessibleSpaceIds !== null) {
      qb.where('r.spaceId IN (:...spaceIds)', { spaceIds: accessibleSpaceIds });
    }
    const rows = await qb.getRawMany<RouteSimilarityRow>();

    for (const row of rows) {
      // 阈值过滤（≥ 判定，0.15/0.3 为边界值）：intent/category 任一达标即路由命中
      const intentSim = Number(row.intent_similarity);
      const categorySim = Number(row.category_similarity);
      if (intentSim < ROUTE_INTENT_FLOOR && categorySim < ROUTE_CATEGORY_FLOOR) {
        continue;
      }
      this.applyRouteBoost(boosts, row.primary_doc_id, ROUTE_PRIMARY_BOOST, 'primary');
      if (row.secondary_doc_id) {
        this.applyRouteBoost(boosts, row.secondary_doc_id, ROUTE_SECONDARY_BOOST, 'secondary');
      }
    }

    return boosts;
  }

  /**
   * 写入/覆盖单 doc 的路由加权（取最大倍率语义）
   *
   * 同一 doc 可能同时是路由 A 的 primary 与路由 B 的 secondary：若直接连乘，
   * 策展重复会虚高分数（1.5×1.2=1.8），故仅当新倍率更高时覆盖——plan §4-C3 明文。
   * label 与倍率一一对应（primary 1.5 > secondary 1.2，存谁 label 就是谁）。
   */
  private applyRouteBoost(
    boosts: Map<string, RouteBoost>,
    docId: string,
    multiplier: number,
    label: 'primary' | 'secondary',
  ): void {
    const current = boosts.get(docId);
    if (!current || multiplier > current.multiplier) {
      boosts.set(docId, { multiplier, label });
    }
  }

  /**
   * 任务链接加权（plan §4-C3 三路融合之二）
   *
   * 一把聚合查询：对 hits 涉及的 docId 集合按 doc 分组 COUNT(DISTINCT task_id)
   * （task_doc_links 裸 uuid 无 FK，按 docId 直接计数即可——docspace.service.countLinkedTasks
   * 同款先例）。乘数 = ×(1 + min(count, TASK_LINK_CAP) × TASK_LINK_STEP)，封顶 ×1.25。
   *
   * @param docIds - hits 涉及的 docId 集合（已去重，≤20 条）
   * @returns docId → 实际关联任务数（原始 COUNT 未封顶；无链接的 doc 不在映射中）
   */
  private async countTaskLinksByDoc(docIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (docIds.length === 0) {
      return counts;
    }
    const rows = await this.taskLinkRepo
      .createQueryBuilder('tdl')
      .select('tdl.docId', 'doc_id')
      .addSelect('COUNT(DISTINCT tdl.taskId)', 'c')
      .where('tdl.docId IN (:...docIds)', { docIds })
      .groupBy('tdl.docId')
      .getRawMany<{ doc_id: string; c: string }>();
    for (const row of rows) {
      counts.set(row.doc_id, Number(row.c));
    }
    return counts;
  }

  /**
   * Build ts_headline snippet for a specific section（作用于**单字化文本**，计划 §2.2：
   * 原文 CJK 巨 token 零高亮——`ts_headline('simple', cjk_unigram_text(s.content),
   * :compiledQ, …)`）。Falls back to trgm snippet if ts_headline returns empty.
   *
   * 表达式由 `buildSearchSql` 导出组单源构造（headlineExpr），纪律随 builder：
   * - options 串恒产双引号包裹形态（9082464c：options 按**空白**拆分——`'StartSel=,StopSel='`
   *   会被整体吞为 StartSel 的值，`,StopSel=` 字面量混进 snippet；裸空值报 invalid
   *   parameter list format）；
   * - doc-search 通道 `StartSel=""` 空标记是**刻意设计**（snippet 只取文本不要标记，
   *   高亮标记验收仅适用 search.service 的 `<<<>>>` 通道）；
   * - MaxWords 缺省 = HEADLINE_DEFAULT_MAX_WORDS(150)——单字化把 CJK token 数放大
   *   10–100 倍，旧值 50 在单字化文本上只够覆盖几个汉字（起点 150，评估集实测重定）。
   *
   * 清理契约（snippet-cleanup.ts 单源）：先 `cleanupHeadlineSnippet`（无 `>>> <<<`
   * 残留/无连续空格/首尾无空格），**再比长度/截断**——截断在清理产物上进行。
   */
  private async buildTsHeadlineSnippet(
    docId: string,
    position: number,
    compiled: CompiledQuery,
    q: string,
  ): Promise<{ text: string; truncated: boolean }> {
    // 导出组按本消费点重建（纯函数）：与打分查询的 headline 段同一 builder ⇒ 零漂移
    const group = buildSearchSql({ vector: 's.search_vector', text: 's.content' }, compiled, {
      startSel: '',
      stopSel: '',
    });
    // 调用方已保证非 isEmpty（trgm-only 模式 tsMatched 恒 false 不进本路径）
    const headlineExpr = (group as SearchSqlGroup).headlineExpr;
    const row = await this.sectionRepo.manager
      .createQueryBuilder()
      .select(headlineExpr, 'headline')
      .from('doc_sections', 's')
      .where('s.doc_id = :docId', { docId })
      .andWhere('s.position = :position', { position })
      .setParameter(COMPILED_Q_PARAM, compiled.tsquery)
      .getRawOne<{ headline: string }>();

    if (row?.headline) {
      // 先剥空格/并标记再比长度截断（契约：清理产物上计 SNIPPET_MAX_CHARS）
      const cleaned = cleanupHeadlineSnippet(row.headline);
      const truncated = cleaned.length > SNIPPET_MAX_CHARS;
      return {
        text: truncated ? cleaned.slice(0, SNIPPET_MAX_CHARS) : cleaned,
        truncated,
      };
    }

    // Fallback: get content and build trgm snippet
    const section = await this.sectionRepo.findOne({
      where: { docId, position },
      select: ['content'],
    });
    if (section) {
      return this.buildTrgmSnippetRefined(section.content, q);
    }

    return { text: '', truncated: false };
  }

  /**
   * Build snippet from content when no tsvector match (pure trgm).
   * Finds the first matching substring and returns ±150 chars context, ≤300 chars.
   */
  private buildTrgmSnippet(content: string, q: string): { text: string; truncated: boolean } {
    return this.buildTrgmSnippetRefined(content, q);
  }

  /**
   * Core trgm snippet logic: find first match, extract context window.
   */
  private buildTrgmSnippetRefined(
    content: string,
    q: string,
  ): { text: string; truncated: boolean } {
    // Find first occurrence of any query word (case-insensitive)
    const queryWords = q.split(/\s+/).filter(Boolean);
    let matchIndex = -1;
    let matchLen = 0;

    for (const word of queryWords) {
      const idx = content.toLowerCase().indexOf(word.toLowerCase());
      if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
        matchIndex = idx;
        matchLen = word.length;
      }
    }

    // Also try trigram fuzzy: find 3-char substrings
    if (matchIndex === -1 && q.length >= 3) {
      for (let i = 0; i <= q.length - 3; i++) {
        const trigram = q.slice(i, i + 3).toLowerCase();
        const idx = content.toLowerCase().indexOf(trigram);
        if (idx !== -1) {
          matchIndex = idx;
          matchLen = 3;
          break;
        }
      }
    }

    if (matchIndex === -1) {
      // No match found, return beginning of content
      const truncated = content.length > SNIPPET_MAX_CHARS;
      return {
        text: truncated ? content.slice(0, SNIPPET_MAX_CHARS) : content,
        truncated,
      };
    }

    const matchCenter = matchIndex + Math.floor(matchLen / 2);
    const start = Math.max(0, matchCenter - SNIPPET_CONTEXT_CHARS);
    const end = Math.min(content.length, matchCenter + SNIPPET_CONTEXT_CHARS);

    let snippet = content.slice(start, end);
    const wasTruncatedLeft = start > 0;
    const wasTruncatedRight = end < content.length;

    // Add ellipsis markers
    if (wasTruncatedLeft) snippet = '…' + snippet;
    if (wasTruncatedRight) snippet = snippet + '…';

    const truncated = snippet.length > SNIPPET_MAX_CHARS;
    if (truncated) {
      snippet = snippet.slice(0, SNIPPET_MAX_CHARS);
    }

    return { text: snippet, truncated };
  }
}
