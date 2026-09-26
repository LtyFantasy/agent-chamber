/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 检索中文根治（路线 A）的**共享 SQL 导出组**：把编译产物（CompiledQuery）映射为
 *     四消费方共用的打分/预过滤/高亮/K-gate 四段 SQL 表达式 + 绑定参数集
 *     （批次 0 第 5 项交付，零接线、零行为变更；批次 1 四消费方统一接线）
 *
 * [代码职责]
 *   - `buildSearchSql`：产出 `{ scoreExpr, prefilterExpr, headlineExpr, kGateExpr,
 *     kGateParams }` 五元组——**导出即组，禁止单独取用**（先例
 *     experience.service.ts SCORE_EXPRESSION 三处共用同一字符串）
 *   - 参数名纪律：score/prefilter/headline 三消费点共用同一绑定 `:compiledQ`；
 *     K-gate 逐 arm 绑定 `:arm1..armN`（N≤64）+ `:kGateK`
 *   - **SQL 侧一律 `to_tsquery('simple', :param)` 包裹**（2026-09-26 批次 1-b 实证）：
 *     裸绑定/`::tsquery` cast 走 tsqueryin = 原子词位语义（保大小写、不拆元语法），
 *     与编译器的 parser 语义错位（'Hello'/'judgment:1'/'a&b'/'ＡＢＣ' 零命中回归）；
 *     to_tsquery 把原子引号词位重新过 parser，编译产物操作符结构完整保持
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2（DocSpace 检索；批次 1 接线后同步落线上）
 *   - 补充: src/common/utils/search/tsquery-compiler.ts — 编译产物契约（本文件的唯一输入）
 *   - 设计定稿: 检索中文根治计划终稿 v1.5 §2.2（导出组契约）/§2.3（K-gate 全绑定形态）
 *
 * [关键不变量]
 *   - **零字面量插值**：一切用户派生内容只经绑定参数下发（`:compiledQ`/`:arm1..N`/
 *     `:kGateK`）；生成串里**禁止出现查询内容字面量**（无插值负面断言的对象 = 一切
 *     编译产物，不止 `:q`；单测钉死）。
 *   - **生成串禁相关子查询**：per-row 构造是 4× 自伤写法（实测 4 arm 5.4s /
 *     16 arm 20.3s）；arm 文本走绑定 + `to_tsquery('simple', :param)` 包裹——**参数
 *     表达式是 initplan 每查询求值一次、非 per-row**（与编译产物文本语义等价），
 *     靠近内联字面量档（全表 57,834 行×4 arm 实测 12ms 级）。
 *   - **to_tsquery 空串保护依赖 isEmpty 短路**：`to_tsquery('simple', '')` 报错；
 *     编译产物永不空（isEmpty ⇒ 本 builder 返回 null，消费方按面枚举先行短路），
 *     包裹点位因此不会收到空 tsquery 文本。
 *   - **保留参数名**：arm 固定命名 `arm1..armN`（1 起）、门限固定 `kGateK`——**PG
 *     类型名（tsquery/tsvector/regconfig/text…）禁作参数名**：TypeORM 0.3.30 替换
 *     正则会扫出 `::tsquery` 假参数，未注册名原样保留故安全（PostgresDriver.js
 *     :648-654 源码级验证），真注册同名参数则 cast 被静默替换。
 *   - **K-gate arm 集合 ≡ compiledQ 内 arm 集合**（64 cap 同施，编译器保证）——
 *     本文件不得对 arms 再做增删，直接 1:1 落参数。
 *   - **`cjk_unigram_text` 是 DB 函数**：headlineExpr 引用它，批次 1 migration 建函数
 *     后本表达式才可在真库执行（本批零接线 ⇒ 零引用）。
 *
 * [关联代码]
 *   - src/common/utils/search/tsquery-compiler.ts — 编译器（CompiledQuery 来源）
 *   - src/common/utils/search/search-sql.spec.ts — 形态/参数完整性/无插值契约单测
 *   - test/pending/*.pending.ts — 钉子用例（批次 1 真库激活）
 *   - 批次 1 消费方（本批零接线）: doc-search.service.ts / search.service.ts /
 *     task.service.ts / experience.service.ts
 *
 * [持久踩坑]
 *   - 9082464c(ts_headline options): options 串按**空白**拆分选项——裸空值
 *     `StartSel=,StopSel=` 会被整体吞为 StartSel 的值、`,StopSel=` 字面量残渣污染
 *     snippet。安全方向: 本 builder 恒产**双引号包裹**形态 `StartSel="", StopSel=""`，
 *     且标记值禁含 `'`/`"`（builder 校验，throw 于构造期）。
 *   - KGATE-INLINE-LITERAL(R1): K-gate 曾设计为内联字面量 `(sv @@ '(出<->境)')`——
 *     与「全参数绑定/无插值断言」契约互斥，且裸字面量绕开 to_tsquery 归一化。
 *     安全方向: 逐 arm 绑定 `:armN` + `to_tsquery('simple', :armN)` 包裹。
 *   - TSQUERYIN-ATOMIC(2026-09-26 批次 1-b 实证): 绑定参数/`::tsquery` cast 走类型
 *     输入函数 tsqueryin = **原子词位语义**（保大小写、不拆元语法、不过 parser）——
 *     `'a&b'`/`'Hello'`/`'judgment:1'`/`'ＡＢＣ'` 对文档侧 parser 分词零命中（PG15.18
 *     与 PG16.14 同行为，已排除版本差；批次 0 预验证走的是 to_tsquery 路径）。
 *     安全方向: 一切编译产物参数的 SQL 消费点 `to_tsquery('simple', …)` 包裹
 *     （原子引号词位重过 parser，编译产物操作符结构完整保持；initplan 求值一次）。
 *
 * [铁律关联] #7(编译优先) #11(注释强制) #17(测试契约) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 *   □ 新增/改名任何绑定参数后，跑 search-sql.spec.ts 的参数完整性与保留参数名断言
 * =============================================================================
 */
import { chooseKGateK, type CompiledQuery } from './tsquery-compiler';

// ═══════════════════════════════════════════════════════════════════════════
// 绑定参数名单源（保留参数名——改名 = 契约变更，spec 有断言）
// ═══════════════════════════════════════════════════════════════════════════

/** 编译 tsquery 文本的绑定参数名（score/prefilter/headline 三消费点共用同一绑定） */
export const COMPILED_Q_PARAM = 'compiledQ';

/** K-gate 门限 K 的绑定参数名 */
export const K_GATE_K_PARAM = 'kGateK';

/** K-gate 逐 arm 绑定参数名前缀（`arm1..armN`，**1 起编号**——计划 §2.2 钉死） */
export const K_GATE_ARM_PARAM_PREFIX = 'arm';

/**
 * ts_headline MaxWords 缺省起点（计划 §2.2：起点 150，评估集实测重定）。
 * 注意这是**单字化文本**上的词数——单字化把 CJK token 数放大 10–100 倍，
 * 旧值（doc-search 的 50）在单字化文本上只够覆盖几个汉字。
 */
export const HEADLINE_DEFAULT_MAX_WORDS = 150;

// ═══════════════════════════════════════════════════════════════════════════
// 导出组类型
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 列名参数（四消费方表别名不同：`s.search_vector` / `m.search_vector` /
 * `task.search_vector` / `e.search_vector`），由 builder 参数化适配。
 */
export interface SearchSqlColumns {
  /** search_vector 列（含表别名），如 `s.search_vector` */
  vector: string;
  /**
   * 原文文本列（含表别名），headline 用，如 `s.content`——导出表达式内会套
   * `cjk_unigram_text(...)`（ts_headline 必须作用于单字化文本，原文 CJK 巨 token
   * 零高亮，计划 §1 关键实验结论）。
   */
  text: string;
}

/** headline 标记与窗口参数（`<<<>>>` 通道与 doc-search 空标记通道共用本 builder） */
export interface HeadlineParams {
  /**
   * 起止标记。search.service 通道传 `<<<`/`>>>`；doc-search 通道传 `''`（空标记是
   * 刻意设计——snippet 只取文本不要标记，高亮标记验收仅适用 `<<<>>>` 通道）。
   */
  startSel: string;
  stopSel: string;
  /** MaxWords（缺省 HEADLINE_DEFAULT_MAX_WORDS=150 起点，评估集重定） */
  maxWords?: number;
}

/**
 * 共享 SQL 导出组（**导出即组，禁止单独取用**）。
 *
 * 消费纪律：四消费方整体取组后按需摆放——score 进 SELECT/ORDER BY，prefilter 进
 * WHERE，headline 进 snippet 子查询，kGate 进 WHERE（arms 非空时）；参数必须整体
 * 下发（`:compiledQ` 由消费方绑定 `compiled.tsquery`，`kGateParams` 展开 setParameters）。
 */
export interface SearchSqlGroup {
  /** 打分表达式 `ts_rank_cd(<vector>, to_tsquery('simple', :compiledQ))`（flag 0；W1 权重由消费方外乘） */
  scoreExpr: string;
  /** 预过滤 ts 分支 `(<vector> @@ to_tsquery('simple', :compiledQ))`（词项 OR——编译器产出的就是 OR 链） */
  prefilterExpr: string;
  /** 高亮表达式 `ts_headline('simple', cjk_unigram_text(<text>), to_tsquery('simple', :compiledQ), '<options>')` */
  headlineExpr: string;
  /**
   * K-gate 结构门 `((<vector> @@ to_tsquery('simple', :arm1))::int + … >= :kGateK)`；
   * 无 arm（纯 ASCII / 单字 CJK 查询）时为 `null`——消费方不挂门。
   */
  kGateExpr: string | null;
  /** K-gate 绑定参数集 `{ arm1..armN: string, kGateK: number }`（无 arm 时为空对象） */
  kGateParams: Record<string, string | number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * headline 标记校验（9082464c 家族防线）：标记是 builder 常量（开发者提供，非用户
 * 输入），但含 `'` 会击穿 SQL 字面量、含 `"` 会击穿 options deflist——构造期直接
 * throw（开发期契约错误，不应进入运行期）。
 */
function assertHeadlineMark(mark: string, name: string): void {
  if (mark.includes("'") || mark.includes('"')) {
    throw new Error(`buildSearchSql: ${name} must not contain quote characters`);
  }
}

/**
 * 构建共享 SQL 导出组。
 *
 * @param columns 列名参数（vector/text，含表别名）
 * @param compiled 编译产物（空查询 ⇒ 返回 `null`——消费方按面枚举先行短路，
 *   doc-search/experience → trgm-only；search/task q= → 短路返回空）
 * @param headline 高亮标记与窗口参数
 * @param kOverride K 覆盖值（标定矩阵 W1×K 评估用；省略时按 CJK 字数取起始值）
 * @returns 导出组；`compiled.isEmpty` 时为 `null`
 */
export function buildSearchSql(
  columns: SearchSqlColumns,
  compiled: CompiledQuery,
  headline: HeadlineParams,
  kOverride?: number,
): SearchSqlGroup | null {
  if (compiled.isEmpty || compiled.tsquery === null) return null;

  assertHeadlineMark(headline.startSel, 'startSel');
  assertHeadlineMark(headline.stopSel, 'stopSel');
  const maxWords = headline.maxWords ?? HEADLINE_DEFAULT_MAX_WORDS;
  if (!Number.isInteger(maxWords) || maxWords <= 0) {
    throw new Error('buildSearchSql: maxWords must be a positive integer');
  }
  // kOverride 同为开发者契约（标定矩阵入口）：非有限整数属开发期错误——
  // 不校验则 chooseKGateK 内部 Math.floor 会静默吞掉 1.5/NaN/Infinity（m7）
  if (kOverride !== undefined && (!Number.isFinite(kOverride) || !Number.isInteger(kOverride))) {
    throw new Error('buildSearchSql: kOverride must be a finite integer');
  }
  // options 串恒产双引号包裹形态（9082464c：裸空值会被空白拆分规则吞掉下一个键）
  const headlineOptions = `StartSel="${headline.startSel}", StopSel="${headline.stopSel}", MaxWords=${maxWords}`;

  const { vector, text } = columns;
  // **to_tsquery('simple', …) 包裹是硬契约**（2026-09-26 批次 1-b 实证）：裸绑定/cast
  // 走 tsqueryin = 原子词位语义（保大小写、不拆元语法），与编译器的 parser 语义错位
  // （'Hello'/'judgment:1'/'a&b'/'ＡＢＣ' 零命中回归）；to_tsquery 会把原子引号词位重新
  // 过 parser（小写化 + 按 parser 分词成短语链），编译产物的操作符结构（| & <->）完整
  // 保持。成本安全：参数表达式（非列引用）⇒ initplan 每查询求值一次，**非 per-row**
  // （文件头「禁 per-row to_tsquery」针对的是子查询形态，与此不冲突），GIN 索引可用。
  const scoreExpr = `ts_rank_cd(${vector}, to_tsquery('simple', :${COMPILED_Q_PARAM}))`;
  const prefilterExpr = `(${vector} @@ to_tsquery('simple', :${COMPILED_Q_PARAM}))`;
  const headlineExpr = `ts_headline('simple', cjk_unigram_text(${text}), to_tsquery('simple', :${COMPILED_Q_PARAM}), '${headlineOptions}')`;

  // K-gate：arms 与 compiledQ 内 arm 同一集合（编译器 64 cap 同施），本处 1:1 落参数，
  // 逐 arm 同样 to_tsquery 包裹（返回 tsquery，不再需要显式 ::tsquery cast——cast 本是
  // 为裸 @@ 的 operator 解析，包裹后实参类型已确定）
  let kGateExpr: string | null = null;
  const kGateParams: Record<string, string | number> = {};
  if (compiled.arms.length > 0) {
    const k = chooseKGateK(compiled.cjkCharCount, compiled.arms.length, kOverride);
    // arms 非空 ⇒ chooseKGateK 必返回 ≥1（内部钳制 K ≤ armCount，门恒可达）
    const armCountExpr = compiled.arms
      .map((arm, i) => {
        const paramName = `${K_GATE_ARM_PARAM_PREFIX}${i + 1}`;
        kGateParams[paramName] = arm;
        return `(${vector} @@ to_tsquery('simple', :${paramName}))::int`;
      })
      .join(' + ');
    kGateExpr = `(${armCountExpr} >= :${K_GATE_K_PARAM})`;
    kGateParams[K_GATE_K_PARAM] = k as number;
  }

  return { scoreExpr, prefilterExpr, headlineExpr, kGateExpr, kGateParams };
}
