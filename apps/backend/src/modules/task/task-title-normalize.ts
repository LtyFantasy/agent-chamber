/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **撞重检测器**（`task_near_duplicate_suspected` 的判定核心，卡 c007f6c4）：把一张
 *     新任务卡与同板 open 任务做**标题级**重复判定，命中即产出「疑似撞题」提示。纯函数、
 *     零 IO、永不抛——provider 只负责取数、调用本模块、组装候选。
 *   - 两层判据（**刻意窄**）：
 *     ① **tier1 = 归一化等值**：NFKC + 小写 + 去全部空白/标点/符号后逐字相等。
 *     ② **tier2a = 白名单装饰剥离后的核心等值**：仅当标题**前导**括号段的内容（去空白后）
 *        命中 {@link TITLE_DECORATION_WHITELIST} 才剥掉它，再看剩余核心是否等值（核心
 *        ≥ {@link TIER2A_MIN_CORE_LENGTH} 字符）。
 *
 * [代码职责]
 *   - `normalizeTaskTitle(title)`：NFKC → 小写 → 去 `[\s\p{P}\p{S}]`。**只做归一化**。
 *   - `stripLeadingWhitelistedDecorations(title)`：循环剥前导 `「…」/【…】/[…] /（…）`
 *     （段长 ≤ {@link MAX_DECORATION_SEGMENT}）——**只剥白名单词**。
 *   - `findDuplicateTitles(title, candidates)`：逐候选返回 `{candidate, matchedBy}`
 *     （`'tier1'` | `'tier2a'`），**保序、不去重**（去重与截尾是调用方的职责）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.x「board 纪律族 · 撞重提示」（触发判据 / 白名单
 *     词表与开放词表评审纪律 / 标定数据与残差 / 巨板 fail-open 边界）
 *   - 补充: 线上 docs/api-definition.md §2.7（hints 信封：data 键集与 matchedBy 枚举）
 *
 * [关键不变量]
 *   - **剥离必须作用于「原始标题」，且发生在归一化之前**：`normalizeTaskTitle` 会把
 *     `「」【】（）[]` 全部抹掉（它们都属 `\p{P}`）——先归一化就等于销毁了「括号段」这个
 *     结构信号，剥离判据再也无从谈起（tier2a 会退化成「整串等值」，白名单形同虚设）。
 *   - **白名单是开放词表**：新增词 = **FP 面扩大**，必须评审论证「该词**永不**承载任务区分
 *     语义」（先例：`前端/后端` 这类词看似装饰，实则承载区分，故**不入表**；含数字/字母
 *     序号的形态一律不剥——`M6-TALENT` / `v0.4-A` / `V2:发布` 系列正是靠这一条才不误报）。
 *   - **纯函数、无状态、永不抛**：任意非字符串 / 畸形输入都返回定义值（'' 或 []）——本模块
 *     在 hint 求值热路径上，抛异常等于该提示永久静默（拦截器只兜底、不救场）。
 *   - **检测器刻意窄是产品选择**：模糊族（trgm / Jaccard / Levenshtein）在真库标定下
 *     **无可工作点**（系列编号的 FP 得分恒高于真重复对），语义模糊层归 v3 embedding；
 *     本层的价值 = 对「规范化后仍逐字相同」这类**确定性重复**零 FP 命中。禁止在此加阈值型
 *     模糊匹配。
 *
 * [关联代码]
 *   - ./task-hygiene-hint.provider.ts — 唯一生产消费者（取同板 open 候选 → 调本模块）
 *   - ./task-hint.constants.ts — 码 / 文案 / 占位符契约（本模块不产出文案）
 *   - task-title-normalize.spec.ts — 判定矩阵（含标定 FP 族与负例护栏，铁律 #19 活文档）
 *   - test/task-hygiene-hint.e2e-spec.ts — 真 PG 端到端（挂点 → 提示送达）
 *   - modules/hints/hint-registry.ts — `TASK_HYGIENE_DEFINITIONS`（6h 窗口元数据）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #19(测试即文档) #20(契约即设计)
 * =============================================================================
 */

/**
 * **白名单**装饰词表（**开放词表，新增需评审**——每加一词 = FP 面扩大）。
 *
 * 收录判据：① 全部取自本仓**真实**标题前缀（有生产语料依据，不是臆想词）；② 该词**不携带
 * 任务区分语义**（剥掉后不影响「这是不是同一件事」的判断）。
 *
 * **刻意不收**：`P0~P3` 之外的优先级/版本/序号形态、`前端` / `后端` / `主` / `子` 这类
 * 看似装饰、实则承载区分语义的词（标定实证：「前端」重构 vs「后端」重构 是真 FP 反例），
 * 以及任何含数字或字母序号的形态（`M6` / `v0.4` / `V2`：批量与系列任务全靠它们区分）。
 */
export const TITLE_DECORATION_WHITELIST: readonly string[] = [
  'bug',
  '缓行',
  '待决策',
  '机制',
  '候选',
  '观察',
  '补充',
  '讨论',
  '副本',
  '紧急',
  '临时',
  '待定',
  '复盘',
  'debt',
];

/** 前导括号段的最大长度（超长段落显然不是「装饰」，是正文——不剥） */
const MAX_DECORATION_SEGMENT = 30;

/** tier2a 的核心最小长度：太短的核心（如只剥剩 2 字）等值毫无信息量，宁可漏报不误报 */
const TIER2A_MIN_CORE_LENGTH = 4;

/** 可剥离的括号对（`「」【】[]（）` 全属 `\p{P}`，故剥离必须在归一化**之前**做） */
const DECORATION_PAIRS: readonly (readonly [string, string])[] = [
  ['「', '」'],
  ['【', '】'],
  ['[', ']'],
  ['（', '）'],
];

/**
 * 标题归一化：**NFKC → 小写 → 去全部空白 / 标点 / 符号**。
 *
 * 设计取舍：全角半角（NFKC）、大小写、空格、标点差异都是同一个人手打两遍的常见噪声，
 * 必须抹平；但**不做**同义词 / 词序 / 编辑距离处理（那是模糊层，标定证伪，归 v3 embedding）。
 *
 * @param title 原始标题（非字符串 → `''`，永不抛）
 * @returns 归一化后的比较键（可能为空串——调用方须把空串视为「不可比对」）
 */
export function normalizeTaskTitle(title: string): string {
  if (typeof title !== 'string') return '';
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 剥掉**前导**的白名单装饰括号段（循环，直到无可剥）。
 *
 * 语义细节（改前必读）：
 * - 只剥**前导**：`【P0】` 这种前缀是标注位；句中的括号往往是正文的一部分（`修复(临时)方案`）。
 * - 只剥**白名单内**的词（ci 比对，去空白后）：`【P0】X` / `[WIP] X` / `「前端」X` 一律不剥
 *   ——它们是**区分信号**，剥了会把「P0 冒烟」与「P1 冒烟」判成同一件事（标定实证 FP）。
 * - 段长 > {@link MAX_DECORATION_SEGMENT} 不剥（那不是装饰，是正文）。
 * - 输入非字符串 → `''`（永不抛）。
 *
 * @param title 原始标题（**必须是原始标题**：归一化后再剥已无括号信息，见文件头不变量）
 * @returns 剥离后的剩余标题（原样保留大小写/空白，由调用方自行归一化）
 */
export function stripLeadingWhitelistedDecorations(title: string): string {
  if (typeof title !== 'string') return '';
  let rest = title.trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const [open, close] of DECORATION_PAIRS) {
      if (!rest.startsWith(open)) continue;
      const end = rest.indexOf(close, open.length);
      if (end < 0) continue;
      const inner = rest.slice(open.length, end);
      if (inner.length === 0 || inner.length > MAX_DECORATION_SEGMENT) continue;
      // 去空白 + 小写后比对白名单（「 Bug 」= 「bug」）
      const key = inner.replace(/\s+/g, '').toLowerCase();
      if (!TITLE_DECORATION_WHITELIST.includes(key)) continue;
      rest = rest.slice(end + close.length).trim();
      stripped = true; // 可能还有第二段装饰（「Bug」「缓行」），继续剥
      break;
    }
  }
  return rest;
}

/** 一条命中（`candidate` 是调用方传入的原始对象，便于直接取 id/title/status） */
export interface TitleDuplicateMatch<TCandidate> {
  /** 与本次标题撞重的候选（**同一引用**，不是副本） */
  candidate: TCandidate;
  /** 命中的层级：`tier1` = 归一化等值；`tier2a` = 白名单装饰剥离后等值 */
  matchedBy: 'tier1' | 'tier2a';
}

/**
 * 找出与 `title` 撞重的候选（保序、逐候选判定、**不做去重/截尾**）。
 *
 * 判定顺序对每个候选独立执行：先 tier1（更强、更便宜），未命中再试 tier2a。
 * 同一个候选只会出现在结果里一次（`matchedBy` 取更强的那个）。
 *
 * @param title 本次（新写入的）标题
 * @param candidates 待比对候选（须已带 `title` 字段；典型 = 同板 open 任务行）
 * @returns 按 `candidates` 原序排列的命中列表（无命中 → 空数组）
 */
export function findDuplicateTitles<TCandidate extends { title: string }>(
  title: string,
  candidates: readonly TCandidate[],
): TitleDuplicateMatch<TCandidate>[] {
  const selfKey = normalizeTaskTitle(title);
  // 空键（标题全是标点/空白）不可比对：否则「任何同为空的候选」都会互相命中
  const selfHasKey = selfKey.length > 0;
  // 核心键：**先剥后归一化**（见文件头不变量）——归一化会把括号本身抹掉
  const selfCore = normalizeTaskTitle(stripLeadingWhitelistedDecorations(title));
  const selfHasCore = selfCore.length >= TIER2A_MIN_CORE_LENGTH;

  const matches: TitleDuplicateMatch<TCandidate>[] = [];
  for (const candidate of candidates) {
    if (selfHasKey && normalizeTaskTitle(candidate.title) === selfKey) {
      matches.push({ candidate, matchedBy: 'tier1' });
      continue;
    }
    if (!selfHasCore) continue;
    const candidateCore = normalizeTaskTitle(stripLeadingWhitelistedDecorations(candidate.title));
    if (candidateCore.length >= TIER2A_MIN_CORE_LENGTH && candidateCore === selfCore) {
      matches.push({ candidate, matchedBy: 'tier2a' });
    }
  }
  return matches;
}
