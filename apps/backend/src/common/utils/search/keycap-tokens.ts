/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - keycap 组合键帽（`1️⃣` / `2️⃣` / `#️⃣` / `*️⃣`）的**查询侧词元提取与 LIKE 模式构造**
 *     —— messages 面 keycap 加分（G3 `1️⃣` 真回归修复）的唯一来源
 *
 * [代码职责]
 *   - `extractKeycapTokens(q)`：从**原始查询串**提取 keycap 序列并产出可直接喂
 *     `content LIKE ALL(:param)` 的 LIKE 模式串；`escapeLikeMeta` 为转义护栏（导出仅供单测）
 *
 * [权威文档]
 *   - 主文档: scripts/search-eval/README.md §7 发现⑩（`1️⃣` 真回归的原始记录）/ 发现⑬
 *     （boost 标定、实测名次与已知局限）
 *   - 补充: src/modules/search/search.service.ts 文件头 [详细踩坑] KEYCAP-LIKE-G3
 *
 * [关键不变量]
 *   - **必须在 `normalizeQuery` 之前的原始 q 上调用**：归一化（零宽/变体剥离表，与 DB 函数
 *     同表）会剥掉 U+20E3 ⇒ 在归一化查询/编译产物上调用恒返回空数组（静默失效）。
 *   - **返回值即 LIKE 模式串**（两端 `%` 包裹 + 已转义）——SQL 侧**不要**再拼 `%` 或再转义。
 *   - **多 keycap = `LIKE ALL`（须全中）**，不得降级为 `LIKE ANY`；**空数组调用方不得挂
 *     子句**（PG 中 `LIKE ALL('{}')` 恒真 ⇒ 挂了等于给所有行加分）。
 *   - `%` / `_` / `\` 强制转义是**契约护栏**（当前正则产不出元字符，转义为恒等变换），
 *     防"未来放宽正则即成注入面"；`\` 必须先转义（顺序承重）。
 *
 * [关联代码]
 *   - src/common/utils/search/tsquery-compiler.ts — `ZERO_WIDTH_STRIP_CHARS`（剥离表另侧）
 *   - src/modules/search/search.service.ts — 唯一消费方（messages 面 rank 表达式）
 *   - src/common/utils/search/keycap-tokens.spec.ts — 契约单测（8 例）
 *   - test/search-invariants.e2e-spec.ts ⑭ — 表达式在真库可执行（PG 类型推断契约）
 *
 * [持久踩坑]
 *   - KEYCAP-TYPEINFER(PG 类型推断): rank 表达式 `CASE WHEN … THEN :boost ELSE 0` 的整数分支
 *     会把绑定参数推成 **integer**，小数 boost 报 `invalid input syntax for type integer`
 *     （messages 面整体 500，v1.87 实测）。安全方向: 两侧显式 `::float8`；mock 单测测不出
 *     PG 类型推断，真库契约在 search-invariants ⑭。
 *   - KEYCAP-RAW-Q(调用时机): 见 [关键不变量] 第一条——错位即静默失效（返回空数组不报错）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK 与 search.service 的
 *     [详细踩坑] KEYCAP-LIKE-G3
 *   □ 改正则/转义后跑 keycap-tokens.spec 与 search-invariants ⑭（含反向断言）
 * =============================================================================
 */

/**
 * keycap 序列识别正则（单个键帽 = `[0-9#*]` + 可选变体选择符 U+FE0F + 组合包围键 U+20E3）。
 *
 * 可选 U+FE0F：真实语料两种形态并存（带/不带变体选择符），缺省组让**正则**认得两种
 * 形态——但产出的 LIKE 模式串仍是**形态字面量**（不做归一）：查询用无 FE0F 形态时，
 * 对含 FE0F 的语料不命中（boost 静默不生效；真库实测带/不带 FE0F 模式 = 19 行 vs 0 行，
 * 双侧规约修复已登记 Board 后续任务）。
 * ⚠️ 模块级正则带 `g` 标志——只经 `String#match`（其内部按规范先重置 lastIndex）使用，
 * 禁止改用 `regex.exec()` 循环（跨调用共享 lastIndex 会漏匹配）。
 */
export const KEYCAP_TOKEN_REGEX = /[0-9#*](?:\uFE0F)?\u20E3/g;

/**
 * LIKE 元字符转义（`\` 是 PG `LIKE` 的默认转义符）。
 *
 * 顺序承重：`\` 必须**先**转义，否则后续插入的 `\%` / `\_` 会被自己再转义一次
 * （`\%` → `\\%` = 匹配字面反斜杠 + 通配符，模式语义反转）。
 *
 * ⚠️ 导出仅为契约单测（`keycap-tokens.spec.ts`）直接钉住转义三字符——当前正则产不出
 * 元字符，转义是**护栏而非功能**，护栏必须可测（同仓惯例：供 spec 断言的工具常量导出）。
 *
 * @param raw 任意文本（当前调用面只喂 keycap 序列）
 * @returns 可直接嵌入 LIKE 模式串的文本
 */
export function escapeLikeMeta(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * 从**原始查询串**提取 keycap 序列并产出 LIKE 模式串。
 *
 * @param q 用户原始查询（**不得**传归一化后的串，见文件头契约第一条）
 * @returns LIKE 模式串数组（出现序去重；空数组 = 查询不含 keycap）
 *
 * @example
 * extractKeycapTokens('1️⃣')        // ['%\u{FE0F}\u{20E3}%' 形态，即 '%1️⃣%']
 * extractKeycapTokens('1️⃣ 2️⃣')      // 两条模式（LIKE ALL ⇒ 须全中）
 * extractKeycapTokens('1 2')        // []
 */
export function extractKeycapTokens(q: string): string[] {
  const matched = q.match(KEYCAP_TOKEN_REGEX);
  if (matched === null) return [];
  // 出现序去重：重复键帽的 LIKE ALL 与单次等价，去重只缩小绑定数组（顺序保持稳定）
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const token of matched) {
    const pattern = `%${escapeLikeMeta(token)}%`;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}
