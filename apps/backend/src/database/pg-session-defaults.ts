/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - PostgreSQL 连接级**会话默认值**的唯一装配源（建连即下发的 GUC），供全部
 *     DataSource 装配点（运行时 / CLI / 真库测试克隆源）共用同一份定义
 *
 * [代码职责]
 *   - 定义 `pg_trgm.similarity_threshold` 取值 + node-postgres `extra.options` 串；
 *   - 被 src/database/data-source.ts（TypeORM CLI 与真库 e2e 的克隆源）与
 *     src/app.module.ts（生产运行时 TypeOrmModule.forRoot）同时引用。
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2 (DocSpace 模块)
 *   - 补充: src/modules/docspace/doc-search.service.ts — 消费方（检索预过滤 `%` 算子）
 *     与「阈值 / 权重 / 地板」三角耦合的完整推导与零召回损失证明
 *
 * [关键不变量]
 *   - **单源**：阈值数字只在本文件出现一次，`options` 串由常量插值生成。禁止在
 *     data-source.ts / app.module.ts 里另写字面量——两份字面量必然漂移。
 *   - **连接级下发（禁止事后 SET）**：`%` 算子读的是**会话**参数，而 TypeORM 连接池
 *     按需取用/归还连接。事后 `SET` 会随连接归还而残留（池化污染，别人拿到脏阈值）；
 *     `SET LOCAL` 无事务时只 WARNING 不生效（静默收窄召回，最坏的一种失败）；
 *     `set_limit()` 写的就是同一个会话参数，同样残留。唯一可靠形态 = 建连时经
 *     libpq `options` 下发（PG 对未加载扩展的 GUC 前缀先存占位值，扩展加载后自动生效）。
 *   - **两个装配点必须同时引用**（app.module.ts = 生产运行时事实源；data-source.ts =
 *     CLI/测试事实源）。只改其一 = 「测试绿、生产静默丢召回」——这是本文件存在的理由。
 *
 * [关联代码]
 *   - src/database/data-source.ts — TypeORM CLI / 真库 e2e 克隆的事实源
 *   - src/app.module.ts — 生产运行时 TypeOrmModule.forRoot
 *   - src/modules/docspace/doc-search.service.ts — 预过滤 `%` 的消费方
 *   - src/modules/docspace/doc-search-constants.spec.ts — 三角耦合不变量单测
 *
 * [持久踩坑]
 *   PGCONN-DUAL-ASSEMBLY(双装配点): 本仓有两个互不继承的 DataSource 装配点
 *     （data-source.ts 供 CLI/测试、app.module.ts 供运行时），config 里没有共享的
 *     连接选项对象。历史教训形态 = 「只给测试那条加了参数」→ 单测全绿而生产行为不同。
 *     安全方向: 任何连接级参数一律落本文件，两个装配点各自引用同一常量。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改阈值必须复核 `(TRGM_CONTENT + 活 headingW) × 阈值 < SCORE_FLOOR`（零召回损失
 *     证明的残余作用域——v1.87 `%` 腿消融后只覆盖「两 trgm 腿都在阈值下」的行与
 *     trgm-only 模式，见 doc-search.service.ts 文件头 [关键不变量]）并同步该文件
 *     [持久踩坑]
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */

/**
 * pg_trgm 相似度阈值（`%` 算子的判定线）——连接级会话默认值。
 *
 * rationale（2026-09-25 生产实证，勿凭直觉调大）：
 * - 本值只影响 `%` **算子**（`%` ⇔ `similarity(a,b) >= pg_trgm.similarity_threshold`），
 *   **不影响** `similarity()` **函数**打分——故检索打分公式与 SCORE_FLOOR 语义完全不变，
 *   本参数只放宽「候选集」，不改变任何分数。
 * - DocSpace 检索用 `%` 做索引化预过滤，候选集在**保留该腿的模式/分臂**下必须是
 *   「合成分 ≥ SCORE_FLOOR」的**超集**（trgm-only 模式两腿都在；normal 模式仅 arms=0
 *   的 heading 腿在——v1.87 REV-2 消融了 content 腿与 arms≥1 的两腿，覆盖面见
 *   doc-search.service.ts 文件头 [关键不变量]）。
 *   PG 默认 0.3 会让 `0.05 < similarity < 0.3` 的候选被静默剔除，而这类候选的合成分
 *   可达 0.6×0.2727 ≈ 0.16 > 0.08 ⇒ 默认阈值下预过滤会**丢召回**。
 * - 0.05 的正当性由零召回损失证明给出（三角耦合，见 doc-search.service.ts [持久踩坑]）：
 *   被排除且两 trgm 腿都在阈值下 ⇒ sv 无任一查询词项（ts_rank = 0）且 content/heading
 *   相似度 < 阈值 ⇒ 合成分 < (0.6 + 活 headingW 0.5) × 阈值 = 0.055 < SCORE_FLOOR(0.08)。
 *   余量 0.025 ⇒ 阈值、权重、地板三者中任何一个上调都可能击穿该证明（有单测钉住）。
 * - 为什么不是更低（如 0.01）：`%` 是**索引化**预过滤，越低则 BitmapOr 候选越多、
 *   回表打分的行数越多；0.05 是「证明成立的最高安全档」与「索引收益」的平衡。
 */
export const PG_TRGM_SIMILARITY_THRESHOLD = 0.05;

/**
 * node-postgres 连接附加参数：建连即把 pg_trgm 阈值降到 {@link PG_TRGM_SIMILARITY_THRESHOLD}。
 *
 * `options` 是 libpq 的启动参数（`-c key=value` 等价于建连后 SET），经 pg 驱动透传给
 * 每条**新建**连接——连接池因此天然一致，无池化残留风险（见文件头 [关键不变量]）。
 */
export const PG_CONNECTION_EXTRA: Readonly<Record<string, string>> = Object.freeze({
  options: `-c pg_trgm.similarity_threshold=${PG_TRGM_SIMILARITY_THRESHOLD}`,
});
