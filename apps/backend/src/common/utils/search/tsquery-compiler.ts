/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 检索中文根治（路线 A / CJK 单字化）应用侧**查询编译器**：用户查询 → 参数化
 *     tsquery 文本 + K-gate arm 集合 + 编译元数据（批次 0 第 5 项交付，零接线、
 *     零行为变更；批次 1 才由四个消费方接线）
 *   - 与 DB 侧 `cjk_unigram_text()` 共用同一套**三元脚本分类单源**——字符类是
 *     schema 级不变量（改类 = 全表数据迁移 + 打分尺度变更须重跑评估集）
 *
 * [代码职责]
 *   - `normalizeQuery`：剥离（U+0000 / C0·C1 控制符 / U+2028·2029 / 零宽变体族
 *     6 字符）→ 200 字符硬截断；幂等
 *   - `compileQuery`：三元脚本分类切 run → CJK run bigram 滑窗（**按解析后 tsquery
 *     规范形态去重** + **64 cap 同施 compiledQ 与 kGate**）→ 一切词项单引号词位
 *     发射 → ` | ` 连接；单趟线性；失败降级可观测（固定 tag 计数、不带 q 内容）
 *   - `chooseKGateK`：K 起始值选择（≤4 CJK 字 K=1，更长 K=2；可覆盖供标定矩阵）
 *
 * [权威文档]
 *   - 主文档: docs/architecture.md §3.2（DocSpace 检索；批次 1 接线后同步本设计落线上）
 *   - 补充: scripts/search-eval/census/REPORT.md — §5 ASCII 白名单接受面 / §4.3 R-1
 *     类清单收窄 / §7.1 去重口径证据（本仓内普查证据档案）
 *   - 设计定稿: 检索中文根治计划终稿 v1.5 §2.1/§2.2/§2.3（批次 2 §2.7 收口落线上文档）
 *
 * [关键不变量]
 *   - **白名单是词元 run 的唯一边界（承重）**：59 ASCII 字符（23 标点 + a–z + 0–9）
 *     + A–Z（simple 小写化遮蔽，普查侧不可见但必须收）。`api/v1/docs`、
 *     `race.service.ts:92` 必须是一个 run——拆开即丢 lexeme。改白名单 = 普查重跑 +
 *     守卫单测同步（census REPORT §5.2 是事实源）。
 *   - **一切词项单引号词位发射**：PG tsquery 的引号字符是**单引号**（双引号发射已被
 *     证伪——与裸拼逐例等价）；词项内单引号**双写**。`"`/`\` 不在白名单 = 分隔符，
 *     词项结构上不可能含之。
 *   - **去重键 = 解析后 tsquery 规范形态**：本编译器发射形态即规范形态（单源一种
 *     形态 `('出'<->'境')`，PG 实测三种写法解析全等），故「按发射文本去重」≡「按
 *     解析形态去重」；R-1 收窄后 arm 内结构上不可能出现分隔符，跨标点退化类已关闭。
 *   - **64 cap 同施 `:compiledQ` 与 kGateExpr**：预过滤与门使用同一 arm 集合——
 *     门集合 ⊊ 预过滤集合时「过了预过滤却被门踢掉」= 静默丢召回（architect R1 复核
 *     实测：71 字查询真命中 kcount 6→1 被 K=2 拒）。
 *   - **绝不输出空 tsquery**：词项表空 → `isEmpty=true` 且 `tsquery=null`，消费方
 *     按面枚举（doc-search/experience → trgm-only；search/task q= → 短路返回空）。
 *     **`isEmpty` 语义 = 编译期词项表空**——纯 ASCII 标点 run（`!!!`/`...`/`---` 等：
 *     23 个白名单标点任意组合 PG 解析 0 nodes，实测 23/23）编译期直接丢弃（F2），
 *     纯标点查询归入 isEmpty 按面枚举生效。
 *   - **元语法 ASCII 词项的语义收窄（已知，登记 F5）**：run 内含 `& ! ( ) : *` 的
 *     ASCII 词项——现网 `plainto_tsquery` 是 AND 语义，编译产物是**短语**语义
 *     （`'a&b'` → `'a' <-> 'b'` 实测）：非相邻命中行会掉出 top5；方向 = 精度增益、
 *     召回可能收窄（批次 1 A/B 专项判据：after top5 行集合不得少于 baseline 或
 *     逐行人工复核，计划 §2.4）。
 *   - **绝不把查询内容拼进 SQL**：编译产物只经 `:compiledQ` / `:arm1..N` / `:kGateK`
 *     绑定参数下发（无插值断言的对象 = 一切编译产物字面量，不止 `:q`）；且 SQL 侧
 *     消费点必须 `to_tsquery('simple', :param)` 包裹——裸绑定/cast 走 tsqueryin 原子
 *     语义（保大小写不拆元语法），与编译器 parser 语义错位（2026-09-26 1-b 实证）。
 *
 * [关联代码]
 *   - src/common/utils/search/search-sql.ts — 共享 SQL 导出组（编译产物的唯一消费方）
 *   - src/common/utils/search/tsquery-compiler.spec.ts — 契约单测（白名单守卫/形态/去重）
 *   - test/pending/*.pending.ts — 钉子用例（批次 1 真库激活）
 *   - 批次 1 消费方（本批零接线）: doc-search.service.ts / search.service.ts /
 *     task.service.ts / experience.service.ts
 *
 * [持久踩坑]
 *   - TSQUERY-DEDUP-PARSED(去重口径): 「重复同一 bigram 只计 1」不是 K-gate 表达式
 *     保证的——database 实测重复 arm 计 2。安全方向: 编译期按解析规范形态去重（单测
 *     钉死 `'测试测试'` → 2 arm）；缺则 K=2 门禁退化（census §7.1(b)）。
 *   - TSQUERY-QUOTE-EMIT(发射形态): 双引号发射被证伪（B-1，34 例矩阵）——PG tsquery
 *     的引号字符是单引号；裸拼 7 元语法字符 = 42601 或静默变 AND/带权重项。安全方向:
 *     一切词项 `'…'` 发射 + 词项内 `'` 双写，7 字符矩阵 + 真实 lexeme 样本单测钉死。
 *   - TSQUERY-RANGE-ENDPOINT(区间端点，F3): Unicode 散文区间的端点可能是 parser
 *     未赋值码点（= 分隔符）——留在 ① 内 ⇒ arm 退化为单字项（`('鿿'<->'出')` 与
 *     `('出'<->'鿿')` 同解析 `'出'`），K-gate 重复计数泄漏在端点重开（伪造链实测
 *     `鿿出鿿` kcount=2 被 1 个 `出` 伪造）。安全方向: 类区间端点以「最后词字」收窄
 *     （① = U+4E00–9FEF / U+3400–4DB5），改区间先跑 PG parser 端点探针。
 *   - TRANSLATE-NO-RANGE(剥离族写法): PG `translate` 与正则字符类都无「散文区间」
 *     语法——`U+200B–200D` 记号会把 `–`/`U`/`+`/字母数字全当删除集（实测
 *     `translate('A1B','U+200B–200D','')='A1'` 静默毁数据）。安全方向: 查询侧
 *     （本文件 ZERO_WIDTH_STRIP_CHARS）与 DB 函数输入侧都只写 **6 个字面字符**，
 *     黄金值/守卫单测专防。
 *
 * [铁律关联] #7(编译优先) #11(注释强制) #17(测试契约) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 *   □ 字符类/白名单/剥离族变更 = schema 级不变量变更：同步 DB 函数 + 普查重跑 + 评估集
 * =============================================================================
 */
import { Logger } from '@nestjs/common';

// ═══════════════════════════════════════════════════════════════════════════
// 常量单源（改动任一 = 契约变更，须同步守卫单测与普查）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 查询长度硬上限（字符 = Unicode 码点，截断不拆代理对）。
 *
 * rationale：与四消费方 DTO `@MaxLength(200)` 对齐——DTO 是闸门，编译器截断是
 * 闸门被绕过时的兜底；超出部分不检索（截断计数进零命中日志与 hint，计划 §1）。
 */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * K-gate arm 上限 = CJK 检索语义上限「前 64 个 bigram（≈65 CJK 字）」。
 *
 * rationale（计划 §2.3，architect R1 复核）：cap **同施** `:compiledQ` 与 kGateExpr，
 * 预过滤与门永远是同一 arm 集合；超出 64 的部分是有意的查询长度上限（截断计数、
 * 评估集长句类目覆盖），无静默错位。
 */
export const K_GATE_ARM_CAP = 64;

/**
 * 短查询 K 选择的 CJK 字数分界：≤4 CJK 字 → K=1；更长 → K=2（起始值，
 * 标定矩阵 W1×K 交评估集裁决，可用 override 覆盖；计划 §2.3）。
 */
export const K_GATE_SHORT_QUERY_MAX_CJK_CHARS = 4;

/**
 * 词元字符白名单中的 23 个 ASCII 标点（契约①，普查产出接受面，census REPORT §5.2；
 * 字符序保持普查表序便于人工对照）。**白名单是词元 run 的唯一边界（承重）**。
 */
export const ASCII_WORD_PUNCT_WHITELIST = "!#$%&'()*+,-./:;=?@[]_~";

/**
 * 完整词元字符白名单（85 字符 = 23 标点 + 0–9 + A–Z + a–z）。
 *
 * A–Z 注记（census §5.2 ⚠️ 口径）：lexeme 面里看不到大写字母，因为 `simple` 配置
 * 小写化；白名单必须**另行包含 A–Z**——它只是不体现为「lexeme 内字符」，不是「不需要」。
 */
export const ASCII_WORD_CHAR_WHITELIST: ReadonlySet<string> = (() => {
  const set = new Set<string>([...ASCII_WORD_PUNCT_WHITELIST]);
  for (let cp = 0x30; cp <= 0x39; cp++) set.add(String.fromCharCode(cp)); // 0-9
  for (let cp = 0x41; cp <= 0x5a; cp++) set.add(String.fromCharCode(cp)); // A-Z
  for (let cp = 0x61; cp <= 0x7a; cp++) set.add(String.fromCharCode(cp)); // a-z
  return set;
})();

/**
 * 零宽/变体族剥离表（R-3，与 DB 侧 `cjk_unigram_text()` 输入侧 `translate` 同表）。
 *
 * ⚠️ **必须恰好 6 个字面字符**（TRANSLATE-NO-RANGE 踩坑）：U+200B ZWSP /
 * U+200C ZWNJ / U+200D ZWJ / U+FE0E VS15 / U+FE0F VS16 / U+20E3 组合包围键帽。
 * 归一效果：`1️⃣`（1 + VS16 + 键帽）→ `1`。查询侧剥离 = 卫生动作；生效层位 =
 * 函数/触发器输入侧——双侧同表，批次 1 向量全量重建时天然一致。
 *
 * 实现注记：源码以 `\uXXXX` 转义写法落「字面单字符」——与 SQL 侧手写 6 个字面
 * 字符等价（无区间散文记号），且避免不可见字形被编辑器/工具链静默改写或丢失。
 */
export const ZERO_WIDTH_STRIP_CHARS = [
  '\u200B',
  '\u200C',
  '\u200D',
  '\uFE0E',
  '\uFE0F',
  '\u20E3',
] as const;

/**
 * normalizeQuery 剥离正则（R-3 + 计划 §2.2 剥离清单）：
 * - `\u0000-\u0008`：U+0000（PG text 禁存 NUL）+ C0 控制符 U+0001–0008
 * - `\u000B\u000C` + `\u000E-\u001F`：C0 其余（**保留 \t\n\r**——用户原生空白是合法分隔符）
 * - `\u007F-\u009F`：DEL + C1 控制符（含计划显式枚举的 U+0085 NEL，本区间天然覆盖）
 * - `\u2028\u2029`：U+2028 / U+2029（JSONL 日志单行纪律）
 * - 零宽/变体族：由 ZERO_WIDTH_STRIP_CHARS 单源展开（恰好 6 字面字符）
 */
const STRIP_REGEX = new RegExp(
  `[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u2028\\u2029${ZERO_WIDTH_STRIP_CHARS.join('')}]`,
  'g',
);

// ═══════════════════════════════════════════════════════════════════════════
// 三元脚本分类（计划 §2.1 定稿单源，逐字码点注释；与 DB 函数同一清单）
// ═══════════════════════════════════════════════════════════════════════════

/** run 的脚本类别：word = 整词 run（一 run 一 term）；cjk = 可分字 run（bigram 滑窗）；separator = 边界 */
type ScriptClass = 'word' | 'cjk' | 'separator';

/**
 * ① 可分字脚本（类内，逐字切分走 bigram）。
 *
 * 定稿清单（计划 §2.1 + 普查 R-1 收窄 + code review F3 区间端点收窄）：CJK 基本区
 * + 扩展 A（**上界收窄 = 最后词字**——U+9FF0–9FFF 共 16 个、U+4DB6–4DBF 共 10 个
 * 未赋值码点被 PG16 parser 判分隔符，PG16.14 全区间逐码点探针实证；分隔符码点留在
 * ① 内会让编译器 arm 退化为单字项，K-gate 重复计数泄漏在区间端点重开——伪造链
 * 实测 `鿿出鿿` kcount=2 被 1 个 `出` lexeme 伪造通过）+ **词字枚举**
 * （U+3003–303F 区间其余 = 「」【】《》等括号标点，parser 全判分隔符，整区间划入
 * 会让编译器产出含标点 arm ⇒ arm 退化 + K-gate 重复计数泄漏，R-1 已关闭）+
 * 假名 + `ー` U+30FC（长音符，`コーヒー` 类日文词不再断裂；⚠️ U+30FB `・` 是
 * 分隔符语义，扩区间时不得把它卷进来）。
 */
function isCjkUnigramChar(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fef) || // CJK 基本区（上界收窄 U+9FEF = 最后词字；U+9FF0–9FFF 归分隔符，F3）
    (cp >= 0x3400 && cp <= 0x4db5) || // CJK 扩展 A（上界收窄 U+4DB5；U+4DB6–4DBF 归分隔符，F3）
    cp === 0x3005 || // 々（迭代号，Lm 词字）
    cp === 0x3006 || // 〆（Lm 词字；⚠️ 码点是 U+3006，非 U+3030=〰——architect 勘正）
    cp === 0x3007 || // 〇（锚点：必须为词字，census §3.3 实测成立）
    (cp >= 0x3031 && cp <= 0x3035) || // 〱-〵（竖排迭代号）
    cp === 0x303b || // 〻
    (cp >= 0x3041 && cp <= 0x3096) || // 平假名 ぁ-ゖ
    (cp >= 0x30a1 && cp <= 0x30fa) || // 片假名 ァ-ヺ
    cp === 0x30fc // ー 长音符（R-3 增补的唯一真实语言字符缺口）
  );
}

/**
 * ② 整词脚本（类内，整 run 一 term 不切分）。
 *
 * Hangul / 扩展 B–G / 兼容表意区 U+F900 显式归②（architect 探针：`한글검색` 单
 * token）。拉丁段**显式排除** `×` U+00D7 / `÷` U+00F7（parser 判分隔符，R-2）。
 * 半角片假名 U+FF61–FF9F **不在**本清单（现网零出现，R-3「不扩类」裁决同类；
 * 批次 1 差分样本表覆盖该形状——双侧一致归分隔符）。
 */
function isWholeWordScriptChar(cp: number): boolean {
  return (
    (cp >= 0x00c0 && cp <= 0x00ff && cp !== 0x00d7 && cp !== 0x00f7) || // 拉丁-1 字母（×÷ 归分隔符）
    (cp >= 0x0100 && cp <= 0x024f) || // 拉丁扩展 A/B
    (cp >= 0x0370 && cp <= 0x03ff) || // 希腊
    (cp >= 0x0400 && cp <= 0x04ff) || // 西里尔
    (cp >= 0x1100 && cp <= 0x11ff) || // 谚文 Jamo
    (cp >= 0x3130 && cp <= 0x318f) || // 谚文兼容 Jamo
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xff10 && cp <= 0xff19) || // 全角数字 ０-９
    (cp >= 0xff21 && cp <= 0xff3a) || // 全角大写 Ａ-Ｚ
    (cp >= 0xff41 && cp <= 0xff5a) || // 全角小写 ａ-ｚ
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意（显式归②不切分）
    (cp >= 0x20000 && cp <= 0x2fa1f) // CJK 扩展 B–G（显式归②不切分）
  );
}

/**
 * 单码点三元分类。ASCII（U+0000–007F）不由脚本段裁决，交词元白名单（契约①：
 * 白名单是词元 run 的唯一边界）；其余 = ③ 分隔符（含 emoji 与 CJK 括号标点）。
 */
function classifyCodePoint(cp: number): ScriptClass {
  if (cp <= 0x7f)
    return ASCII_WORD_CHAR_WHITELIST.has(String.fromCharCode(cp)) ? 'word' : 'separator';
  if (isCjkUnigramChar(cp)) return 'cjk';
  if (isWholeWordScriptChar(cp)) return 'word';
  return 'separator';
}

// ═══════════════════════════════════════════════════════════════════════════
// 编译产物类型
// ═══════════════════════════════════════════════════════════════════════════

/** 词元 run（tokenizer 输出；`chars` 按码点切分，代理对不拆） */
interface ScriptRun {
  kind: 'word' | 'cjk';
  chars: string[];
}

/**
 * 编译产物（批次 1 四消费方 + search-sql 导出组的唯一输入）。
 *
 * 纪律：`tsquery` 文本只经 `:compiledQ` 绑定下发；`arms` 只经 `:arm1..N` 绑定下发；
 * 任何字段不得被插值进 SQL 字符串（无插值断言覆盖一切编译产物字面量）。
 */
export interface CompiledQuery {
  /**
   * 空查询标志：词项表为空（纯分隔符/纯标点/内容被全剥离）。
   * 消费方按面枚举处置（计划 §2.2 契约③）：doc-search/experience → trgm-only；
   * search.service/task q= → 短路返回空。**编译器绝不输出 `''` 形态的空 tsquery**。
   */
  isEmpty: boolean;
  /**
   * 编译后 tsquery 文本（词项 ` | ` 连接；一切词项单引号词位发射）。
   * `isEmpty=true` 时恒为 `null`（用 null 表达「无」，不用空串）。
   */
  tsquery: string | null;
  /**
   * K-gate arm 集合：去重后 bigram 规范形态 `('出'<->'境')`，≤64 个。
   * **与 `tsquery` 内的 arm 是同一集合**（64 cap 同施两消费串，计划 §2.3）。
   */
  arms: string[];
  /**
   * 单 CJK 字查询标志：整个查询恰好编译为一个单 CJK 字词项时为该字，否则 null。
   * 批次 1 单字常数分路径用（ts-only 候选 + 常数分 0.1 + 绕开逐行打分，计划 §2.5）。
   */
  singleCjkChar: string | null;
  /** CJK 字总数（全部 CJK run 合计；K 起始值选择依据：≤4 → K=1，否则 K=2） */
  cjkCharCount: number;
  /** 去重后 bigram 总数（**64 cap 前**；armTruncatedCount = distinctBigramCount − arms.length） */
  distinctBigramCount: number;
  /** 200 字符硬截断是否发生（截断计数进零命中日志与 hint） */
  queryTruncated: boolean;
  /** 64 arm cap 截掉的 distinct arm 数（0 = 未截断；>64 bigram 查询的截断量） */
  armTruncatedCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// normalizeQuery（契约④ 单趟线性；⑤ 幂等）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 归一化 + 截断元信息（compileQuery 内部用；公开面 `normalizeQuery` 只返回字符串）。
 *
 * 顺序钉死：**先剥离再截断**——长度上限计的是用户可见字符，零宽/控制符不占预算。
 */
function normalizeWithMeta(rawQuery: string): { normalized: string; truncated: boolean } {
  const stripped = rawQuery.replace(STRIP_REGEX, '');
  // 按码点截断（for..of/展开均按码点迭代）：200 上限不拆 Ext B–G 的代理对
  const chars = [...stripped];
  if (chars.length <= SEARCH_QUERY_MAX_LENGTH) return { normalized: stripped, truncated: false };
  return { normalized: chars.slice(0, SEARCH_QUERY_MAX_LENGTH).join(''), truncated: true };
}

/**
 * 查询归一化：剥离控制/零宽/变体族 → 200 码点硬截断。
 *
 * @param rawQuery 原始查询（DTO 层已保证 string；剥离清单见 STRIP_REGEX 头注）
 * @returns 归一化后字符串；**幂等**（`normalizeQuery(normalizeQuery(q)) === normalizeQuery(q)`）
 */
export function normalizeQuery(rawQuery: string): string {
  return normalizeWithMeta(rawQuery).normalized;
}

// ═══════════════════════════════════════════════════════════════════════════
// 词项发射（契约①：一切词项单引号词位形态，词项内单引号双写）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 单引号词位发射：`'…'`，词项内 `'` 双写（`it's` → `'it''s'`）。
 *
 * 为什么单引号（TSQUERY-QUOTE-EMIT）：PG tsquery 的引号字符是**单引号**——双引号
 * 只是普通标点（与裸拼逐例等价，34 例矩阵证伪）。单引号词位的实测语义（PG16
 * 演练库逐例验证）：词位使 7 元语法字符**失去 tsquery 语法作用**（裸拼时代的
 * 42601 / 静默 AND / 带权重项全部消失），词位内容按**文档同款 tokenizer 再分词**
 * ——`'a&b'`/`'a!b'`/`'a(b'`/`'a:b'`/`'a*b'` 均解析为 `'a' <-> 'b'` 短语链（与文档
 * 侧 `'a':1 'b':2` 同源对齐，`host:port`/`file:line`/`a-b` 复合/URL 形白拿）；
 * 只有 `'` 自身起引号/分隔作用（故词项内 `'` 必须双写）。
 * `:compiledQ`/`:armN` 走绑定参数下发，故只有 tsquery 语法这一层双写，无 SQL 字面量层。
 */
function emitQuotedLexeme(term: string): string {
  return `'${term.replace(/'/g, "''")}'`;
}

/**
 * bigram arm 规范形态：`('出'<->'境')`（**单源一种形态**——`('出'<->'境')` /
 * `("出"<->"境")` / `(出<->境)` 三者解析全等（PG 实测 `= t`），但去重键是文本，
 * 必须钉死一种；本形态即「解析后规范形态」的去重键载体）。
 */
function emitBigramArm(a: string, b: string): string {
  return `(${emitQuotedLexeme(a)}<->${emitQuotedLexeme(b)})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 失败降级可观测（契约⑥）
// ═══════════════════════════════════════════════════════════════════════════

const logger = new Logger('TsqueryCompiler');

/** 降级固定 tag（日志检索锚点；告警规则按此 tag 聚合） */
const COMPILE_FALLBACK_TAG = 'TSQUERY_COMPILE_FALLBACK';

/**
 * 降级标量计数（进程级单调递增）。设计定位 = 「实际不可达」的保险丝：
 * 契约单测证明白名单内任意组合不抛（ ⇒ 降级不可达）；若计数 > 0 说明出现了
 * 契约外输入或实现缺陷，必须当 bug 处理而不是当常态路径。
 */
let compileFallbackCount = 0;

/**
 * 读取降级计数（批次 1 可接指标暴露；单测断言「白名单电池跑完后计数不变」）。
 * 只暴露读口——写口刻意不提供，计数单调递增才可作告警源。
 */
export function getTsqueryCompileFallbackCount(): number {
  return compileFallbackCount;
}

/** 构造空编译产物（纯分隔符/纯标点/全剥离输入，以及失败降级的统一形态） */
function emptyCompiledQuery(queryTruncated: boolean): CompiledQuery {
  return {
    isEmpty: true,
    tsquery: null,
    arms: [],
    singleCjkChar: null,
    cjkCharCount: 0,
    distinctBigramCount: 0,
    queryTruncated,
    armTruncatedCount: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 编译主流程
// ═══════════════════════════════════════════════════════════════════════════

/**
 * tokenizer：归一化串 → 词元 run 序列（单趟线性；码点迭代不拆代理对）。
 * 类间边界即 run 边界（`API接口` = word run + cjk run，无需分隔符介入）；
 * 类内同脚本相邻字符合并为一个 run。
 */
function tokenizeRuns(normalized: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let current: ScriptRun | null = null;
  for (const ch of normalized) {
    const cls = classifyCodePoint(ch.codePointAt(0) as number);
    if (cls === 'separator') {
      current = null;
      continue;
    }
    if (current !== null && current.kind === cls) {
      current.chars.push(ch);
    } else {
      current = { kind: cls, chars: [ch] };
      runs.push(current);
    }
  }
  return runs;
}

/**
 * 编译主流程（`compileQuery` 的去降级包装版本；契约单测直测本函数以证明「不抛」）。
 *
 * 流程：run 序列 → word run 整词一 term / 单字 CJK 裸单字 / 多字 CJK run bigram
 * 滑窗 → arm 按解析规范形态去重（`'测试测试'` → 2 arm——K-gate「重复同一 bigram
 * 只计 1」性质全赖此步，表达式本身不保证，实测重复 arm 计 2）→ **64 cap 同施**
 * （去重后前 64 个 arm 同时进 `tsquery` 与 `arms`，两消费串永不错位）→ ` | ` 连接。
 *
 * @param normalized 已归一化查询串
 * @param queryTruncated 归一化阶段是否发生了 200 截断（元数据透传）
 */
function compileNormalized(normalized: string, queryTruncated: boolean): CompiledQuery {
  const terms: string[] = [];
  const armsSeen = new Set<string>();
  const arms: string[] = [];
  let cjkCharCount = 0;
  let distinctBigramCount = 0;
  let singleCjkTermCount = 0;

  for (const run of tokenizeRuns(normalized)) {
    if (run.kind === 'word') {
      // 契约③（code review F2）：**纯标点 run 编译期丢弃**——23 个白名单标点任意
      // 组合在 PG 侧解析为 0 nodes（实测 23/23：`!!!`/`...`/`---`/`&!():*'` 全空），
      // 发射出去只会静默零召回（`@@` 恒 false 且无报错）；丢弃后纯标点查询归入
      // isEmpty，按面枚举（doc-search/experience → trgm-only；search/task → 短路）
      // 生效。含任一字母数字（含 ② 脚本字）的 run 照常保留（如 `a&b`、`it's`）。
      if (run.chars.every((ch) => ASCII_WORD_PUNCT_WHITELIST.includes(ch))) continue;
      const term = emitQuotedLexeme(run.chars.join(''));
      // 契约②：过滤空词项（结构上 run 非空 ⇒ 不会产 `''`；防御性断言式过滤）
      if (term !== "''") terms.push(term);
      continue;
    }
    // CJK run
    cjkCharCount += run.chars.length;
    if (run.chars.length === 1) {
      const term = emitQuotedLexeme(run.chars[0]);
      if (term !== "''") {
        terms.push(term);
        singleCjkTermCount++;
      }
      continue;
    }
    for (let i = 0; i + 1 < run.chars.length; i++) {
      const arm = emitBigramArm(run.chars[i], run.chars[i + 1]);
      if (armsSeen.has(arm)) continue; // 解析规范形态去重（TSQUERY-DEDUP-PARSED）
      armsSeen.add(arm);
      distinctBigramCount++;
      if (arms.length < K_GATE_ARM_CAP) {
        // 64 cap 同施：进 arms 的才进 tsquery——预过滤与门同一集合（architect R1 复核）
        arms.push(arm);
        terms.push(arm);
      }
    }
  }

  if (terms.length === 0) return emptyCompiledQuery(queryTruncated);

  return {
    isEmpty: false,
    tsquery: terms.join(' | '),
    arms,
    // 单 CJK 字查询 = 全部编译产物恰好一个单字 CJK 词项（无整词 run、无 bigram）
    singleCjkChar:
      cjkCharCount === 1 && singleCjkTermCount === 1 && terms.length === 1
        ? terms[0].slice(1, -1)
        : null,
    cjkCharCount,
    distinctBigramCount,
    queryTruncated,
    armTruncatedCount: distinctBigramCount - arms.length,
  };
}

/**
 * 查询编译入口（四消费方唯一入口；本批零接线）。
 *
 * 失败降级（契约⑥）：任何意外异常 → 降级为空编译产物（isEmpty=true，消费方退回
 * trgm-only / 短路空结果），固定 tag 计数 +1。**日志只带 tag 与计数，不带 q 内容**
 * （q 是用户输入，零命中日志另有 truncateForLog + 脱敏族通道，计划 §2.6）。
 *
 * @param rawQuery 原始查询字符串
 * @returns 编译产物（永不抛异常）
 */
export function compileQuery(rawQuery: string): CompiledQuery {
  try {
    const { normalized, truncated } = normalizeWithMeta(rawQuery);
    return compileNormalized(normalized, truncated);
  } catch {
    compileFallbackCount++;
    logger.warn(
      `[${COMPILE_FALLBACK_TAG}] compileQuery degraded to empty result (total=${compileFallbackCount})`,
    );
    return emptyCompiledQuery(false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// K-gate K 选择（计划 §2.3：起始值 + 标定矩阵可覆盖）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * K-gate 门限 K 选择：≤4 CJK 字 → K=1；更长 CJK 查询 → K=2（**起始值**，W1×K
 * 标定矩阵交评估集裁决终值，可用 `override` 覆盖供矩阵评估）。
 *
 * 防御钳制（数学必然，非设计发挥）：K 永不超过 arm 数——`K > armCount` 的门恒假
 * = 静默零召回（如 `出出出出出` 5 字去重后仅 1 arm）；无 arm（纯 ASCII / 单字
 * CJK 查询）→ 返回 `null`，消费方不挂门。
 *
 * @param cjkCharCount 编译产物 CJK 字总数
 * @param armCount 编译产物 arm 数（64 cap 后，即 kGate 实际 arm 集合大小）
 * @param override 标定矩阵覆盖值（省略时按 CJK 字数取起始值）
 * @returns K 值；无 arm 时为 `null`
 */
export function chooseKGateK(
  cjkCharCount: number,
  armCount: number,
  override?: number,
): number | null {
  if (armCount <= 0) return null;
  const base = override ?? (cjkCharCount <= K_GATE_SHORT_QUERY_MAX_CJK_CHARS ? 1 : 2);
  return Math.min(Math.max(1, Math.floor(base)), armCount);
}
