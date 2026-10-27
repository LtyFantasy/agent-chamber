/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - DocSpace **hint 领域构造器群 + 领域侧内核配置**（DocSpace 元数据治理 2 期，
 *     v1.92.0-dev）：把「已落库事实 + 已解析词表 + 候选池」变成候选的**纯函数群**——
 *     无 IO、无副作用、永不抛（与 doc-vocabulary.helper 同款纪律）。
 *   - **通用内核已抽到 `modules/hints/hint-core.ts`**（阶段一抽核）：排序 / 去重过滤 /
 *     ≤3 截尾 / 信封映射都不在本文件；本文件只保留**docspace 才认识的东西**（code 词表、
 *     领域判定、文案单源指针），并把它们装配成内核的 profile。
 *
 * [代码职责]
 *   - 逐 code 的候选构造器（`buildXxxHint`）：只做判定与 data 组装，**不查任何数据**
 *     ——候选池（空间 tag / category 清单）与路由引用由 service 层在族闸门内查好后
 *     传入。
 *   - `DOC_HINT_PRIORITY` / `hintFamilyOf`（`CODE_FAMILY`）：docspace 的 D6 优先级序与
 *     族归属——**排序执行与埋点族的单源**（`modules/hints/hint-registry.ts` 是元数据
 *     登记处，两处同序由 doc-hints.helper.spec.ts 的同源守卫钉住）。
 *   - `DOC_HINT_PROFILE`：本文件对通用内核的**领域侧配置单源**（优先级序 + 文案解析 +
 *     族归属组装一次，五个消费方共用）。
 *   - `shouldLoadTagPool`：tags 族**池加载闸门**（upsertCore / patchMetadata 两条
 *     路径共用的单源判定）——防止「写语义的 Partial 回退」再次被误用为「评估作用域
 *     闸门」（批 1 修掉的失效模式：未携带 tags 时对存量 tags 跑近义比对）。
 *   - `isEntityAnchorTag` / `ENTITY_ANCHOR_PATTERNS`：**实体锚点**（日期 / 版本号 /
 *     纯数字 / hex）抑制——逐值唯一标识不参与近义比对，池预过滤与输入过滤共用此单源。
 *   - `trigramSimilarity` / `findNearDuplicates`：**应用层** trigram Jaccard 近义
 *     判定（阈值 0.5、top3、排除 ci 精确命中）——确定性、可单测、零 PG 依赖，
 *     不新增 SQL `similarity()` 调用与索引。
 *   - `matchPathType`：pathTypes 前缀匹配（**最长前缀优先**）。
 *   - `isPathLikeQuery`：读侧路径形态判定（含 `/` 且全字符 ∈ `[\w\-./\u4e00-\u9fff]`
 *     且不以空白收尾）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §16（DocSpace 写侧/读侧 hints 挂点表）、
 *     §2.7（hints 信封通用规范）
 *   - 补充: 线上 docs/spec.md §4.1a（DocHint 类型契约）、
 *     docs/api-definition.md §16.4（hintToggles 六族）
 *
 * [关键不变量]
 *   - **本文件零 IO**：任何 `await` / Repository / Logger 出现即越界——IO 全在
 *     service 层且以族开关为闸门（族关 = 零额外查询）。
 *   - **永不抛**：输入可能来自脏 jsonb（直改库 / bundle 回导）与任意用户输入，
 *     抛 = 把成功写入的响应打成 500。
 *   - **≤3 条 + 去重顺序（执行在内核）**：先按优先级排序 → 再去重过滤 → 最后截尾；
 *     **只有存活项被标记**（未送达的不占用去重窗口）。**两条豁免**（见
 *     hints/hint-emit.ts）：normalized 态（每次请求的事实回显）与 `noDedup` 候选
 *     （旧三态双写，与不去重的 `hint`/`hintCode` 逐响应等价）。
 *   - **data 是结构化建议值**，message 一律取自 `DOC_HINT_MESSAGES` 单源
 *     （check_skipped 变体除外，见 `DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE`）——
 *     禁止在本文件手写 message 字面量；`DOC_HINT_PROFILE.resolveMessage` 是唯一解析口。
 *   - **近义判定只出候选不判同**：tag_near_dup / category_near_dup 绝不自动改写
 *     落库值（合法性不变原则）。
 *   - **比较型 hint 的评估作用域 = 本请求携带的数据**（批 1）：tag_near_dup 只在
 *     请求携带 tags 时评估（闸门 = `shouldLoadTagPool`，输入必须是**请求面** tags）；
 *     状态型 hint（metadata / pathType 族 advisory）不受此约束（unchanged 出口照发）。
 *   - **实体锚点单源**（批 1）：`isEntityAnchorTag` 是闸门预判与 `buildTagNearDupHints`
 *     输入过滤的共用判据；`ENTITY_ANCHOR_PATTERNS` 禁 `g`/`y` 旗标、必须带 `i`。
 *
 * [关联代码]
 *   - modules/hints/hint-core.ts — 通用内核（排序 / 去重过滤 / ≤3 截尾 / 信封映射）
 *   - modules/hints/hint-emit.ts — 接线层（emitHints 唯一实现；`HintEmitProfile` 的定义处）
 *   - modules/hints/hint-dedup.service.ts — 去重窗口（Nest provider 单例）
 *   - modules/hints/hint-log.ts — 埋点（emitted warn / suppressed debug）
 *   - modules/hints/hint-registry.ts — docspace 18 码的元数据登记（与本文件同序守卫）
 *   - modules/docspace/doc.service.ts — upsertCore / patchMetadata / batchUpsert /
 *     delete 挂点（族闸门内查 tag 池 / category 池 / route 引用后调用本文件）
 *   - modules/docspace/doc-move.service.ts — move 的 route_anchor_recheck
 *     （数据源 = 已算好的 impact.docRoutes，零额外查询）
 *   - modules/docspace/doc-search.service.ts — 读侧两条 + 旧三态双写
 *   - doc-hints.helper.spec.ts — 领域全函数矩阵 + 与注册表的同源守卫
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增 code 必须四处齐步：shared DOC_HINT_CODES + DOC_HINT_MESSAGES +
 *     本文件 DOC_HINT_PRIORITY + hints/hint-registry.ts 元数据表
 * =============================================================================
 */
import type {
  DocHintCode,
  DocHintFamily,
  DocSpaceCanonicalTag,
  DocSpaceHintToggles,
  DocSpacePathType,
} from '@agent-chamber/shared';
import { DOC_HINT_MESSAGES, DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE } from '@agent-chamber/shared';
// 通用内核（阶段一抽核到 modules/hints/）：排序 / 去重 / 截尾 / 候选构造都不在本文件——
// 本文件只保留 docspace 才认识的判定，并把领域语义装配成内核 profile（见 DOC_HINT_PROFILE）
import { makeHintCandidate, type HintCandidate as KernelHintCandidate } from '../hints/hint-core';
import type { HintEmitProfile } from '../hints/hint-emit';
// 去重窗口长度的单源 = 注册表（`HintDefinition.ttlMs`）——profile 只做委托，不写死数字
import { hintTtlOf } from '../hints/hint-registry';

// ─── 常量（单源，调参只改这里）────────────────────────────────────────────

/**
 * hint 固定优先级序（D6）：**先按本序排序，再截尾**——排在前面的先占 ≤3 的名额。
 *
 * rationale：破坏性/不可逆的信号优先（route_anchor_broken > path_type_mismatch），
 * 事实回显（tags_normalized）与知悉型提示（route_anchor_recheck）垫底；读侧两条
 * 排在写侧之后（一次请求不会同时产出两侧）。
 *
 * 阶段三插码的两个位置是**刻意**的（不是 append）：
 * - `search_experiences_suggested` 排在 `zero_hit` **之后**——旧三态双写的「逐响应等价」
 *   承诺依赖 zero_hit 恒占得到名额（见 `makeLegacySearchHintCandidate` 注释）；
 * - `docs_overview_truncated` / `docs_overview_routes_truncated` 排**末位**——两者都是
 *   overview 截断的「顺带告知」，不该挤占任何实质提示的名额（routes 版更靠后：它连
 *   catalog 这一层最便宜的下步都没有，只是抓全教学）。
 */
export const DOC_HINT_PRIORITY: readonly DocHintCode[] = [
  'route_anchor_broken',
  'path_type_mismatch',
  'route_target_excluded',
  'category_near_dup',
  'tag_near_dup',
  'missing_category',
  'empty_summary',
  'empty_tags',
  'route_anchor_recheck',
  'tags_normalized',
  'query_looks_like_path',
  'suggest_relaxing',
  'zero_hit',
  'search_experiences_suggested',
  'weak_hit',
  'positional_order',
  'docs_overview_truncated',
  'docs_overview_routes_truncated',
];

/**
 * trigram Jaccard 相似度阈值（宁高勿低：防误报优先）。
 * 0.5 为初始值——偏低会把「同前缀不同词」也当近义，误报成本高于漏报。
 */
export const HINT_TRIGRAM_THRESHOLD = 0.5;

/** 近义候选输出上限（只出候选不判同，候选过多即噪音） */
export const HINT_NEAR_DUP_TOP = 3;

/**
 * `route_anchor_broken` 的逐锚校验 cap（影响面超此值 → 改发 check_skipped）。
 *
 * rationale：锚校验是逐条比对（O(routes)），超量时响应噪音与语义价值比失衡；
 * check_skipped 是诚实的「没检查」（**绝不解释为健康**）。delete 的 docId 锚断是
 * 语义判定（无逐锚成本），**不受此 cap**。
 */
export const HINT_ROUTE_ANCHOR_CHECK_CAP = 20;

/** suggest_relaxing 认可的可筛参数（`sort`/`limit`/`offset`/`q` **不算筛选**） */
export const DOC_SEARCH_FILTER_PARAMS = [
  'type',
  'tag',
  'category',
  'createdAfter',
  'createdBefore',
] as const;

/** code → 所属族（`tags_normalized` 无族 = null；旧搜索三态归 read 族，仅日志维度用） */
const CODE_FAMILY: Record<DocHintCode, DocHintFamily | null> = {
  missing_category: 'metadata',
  empty_tags: 'metadata',
  empty_summary: 'metadata',
  path_type_mismatch: 'pathType',
  tag_near_dup: 'tags',
  category_near_dup: 'categories',
  route_target_excluded: 'routes',
  route_anchor_recheck: 'routes',
  route_anchor_broken: 'routes',
  tags_normalized: null,
  query_looks_like_path: 'read',
  suggest_relaxing: 'read',
  zero_hit: 'read',
  search_experiences_suggested: 'read',
  weak_hit: 'read',
  positional_order: 'read',
  docs_overview_truncated: 'read',
  docs_overview_routes_truncated: 'read',
};

/** 路径形态正则：含 `/` 且全字符 ∈ `[\w\-./\u4e00-\u9fff]`（无空白、无其他标点） */
const PATH_LIKE_REGEX = /^[\w\-./\u4e00-\u9fff]+$/;

/**
 * **实体锚点模式**（模块级字面量，批 1）：日期 / 版本号 / 纯序号 / 哈希形态的 tag
 * 是**逐值唯一的实体锚点**——字符层相似（trigram）但语义上永非同义合并候选，比对必误报。
 *
 * ⚠️ 纪律：① **禁 `g`/`y` 旗标**（`lastIndex` 残留会破坏本文件纯函数的确定性契约，
 * 见 `findNearDuplicates`）；② 禁 `new RegExp(用户输入)`（tag 是任意用户输入，注入即
 * ReDoS 面）；③ **必须带 `i`**——`resolveTags` 对未声明 tag 原样保大小写落库
 * （doc.service.ts resolveTags ③「未命中 → 原样落库」），无 `i` 则 `V1.2.3` vs `V1.2.4`
 * （实测 0.5556 过阈）漏判。
 *
 * 已知取舍（本批明写的代价，复活需观测数据支撑）：
 * ① 同格式**邻日漂移**（2026-10-05 vs 2026-10-06，实测 0.6923 真实可达）不再报——这是
 *    本批真实付出的代价：日期是实体锚点，逐值不同不等于同义漂移；
 * ② **复合形态**（release-2026-10-05 / 版本-2026-10-05，实测 0.8095 / 0.7500 可达）
 *    本批不治——模式膨胀需观测支撑，复活条件 = hint 观测或客户反馈复合形态实例；
 * ③ **全字母 hex ≥8**（`deadbeef` / `cafebabe`）**不抑制**——判别点是 `(?=.*\d)`，
 *    为防误伤合法英文词而付出的漏判代价；
 * ④ **7 位 short SHA 不覆盖**（`{8,}` 下界取舍，`a1b2c3d` vs `a1b2c3e` = 0.6000 可达）；
 * ⑤ **`[0-9a-f]` 外观的英文词 ≥8 位且含数字**（`face2face` / `facade12`）**被误抑制**——
 *    判别点 `(?=.*\d)` 只挡「全字母」词，挡不住这类「hex 外观 + 混入数字」的合法词；
 *    收紧需字母段/元音启发式，同样要观测支撑；
 * ⑥ **≥4 段版本号不覆盖**（正则只收 1~3 段，`V1.2.3.4` vs `V1.2.3.5` = 0.6364 过阈仍报）。
 */
export const ENTITY_ANCHOR_PATTERNS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}$/i, // ISO 日期
  /^\d{4}\/\d{2}\/\d{2}$/i, // 斜杠日期
  /^\d+$/i, // 纯数字（含紧凑日期 yyyyMMdd）
  /^v?\d+\.\d+(\.\d+)?$/i, // 版本号形态（含点分日期，已知并收）
  /^(?=.*\d)[0-9a-f]{8,}$/i, // hex/哈希 ≥8 位且含数字
];

/**
 * 判定 tag 是否**实体锚点形态**（逐值唯一标识，近义合并必然误报）。
 *
 * 单源约束：本谓词同时服务 ①`buildTagNearDupHints` 的池预过滤与输入过滤、
 * ②`shouldLoadTagPool` 的闸门预判。**禁止各处自行实现**——漂移后果见
 * `shouldLoadTagPool` 注释（闸门宽 = 白付池聚合；闸门窄 = 静默丢 hint 假阴性）。
 *
 * @param tag 归一后仍在词表外的 tag 原文（大小写保真）
 * @returns 命中任一 ENTITY_ANCHOR_PATTERNS
 */
export function isEntityAnchorTag(tag: string): boolean {
  return ENTITY_ANCHOR_PATTERNS.some((pattern) => pattern.test(tag));
}

// ─── 类型 ────────────────────────────────────────────────────────────────

/**
 * docspace hint 候选 = 内核候选泛型在 `DocHintCode` 上的收窄。
 *
 * 做成别名（而非新接口）的两个理由：① 五个消费方与各 builder 的既有签名
 * （`HintCandidate` / `HintCandidate[]`）**逐字不变**，抽核不产生连锁改动；
 * ② code 收窄保留在本文件，内核保持对 code 泛型（新挂面不复用 docspace 词表）。
 */
export type HintCandidate = KernelHintCandidate<DocHintCode>;

/** 候选池条目（空间 tag / category 聚合的最小形状） */
export interface HintPoolEntry {
  /** 池中取值（tag 原文 / category name） */
  value: string;
  /** 命中未删文档数（排序次键：同相似度时更常用的值优先） */
  count: number;
  /** 附加展示字段（category 池带 slug） */
  extra?: Record<string, unknown>;
}

// ─── 通用工具 ────────────────────────────────────────────────────────────

/** code → 所属族（日志维度；`tags_normalized` 返回 null） */
export function hintFamilyOf(code: DocHintCode): DocHintFamily | null {
  return CODE_FAMILY[code] ?? null;
}

/**
 * 旧搜索三态的**双写候选**（迁移期专用）：与旧 `hint`/`hintCode` 逐响应等价
 * ⇒ `noDedup: true` 豁免去重窗口（旧字段不去重，双写必须同款）。
 *
 * ⚠️ **严格等价的前提（新增读侧 code 时必须重估）**：等价依赖「旧三态恒占得到 ≤3 的
 * 名额」。阶段三加了第三条读侧码 `search_experiences_suggested`（rank 13）——它**刻意排在
 * `zero_hit`(12) 之后**，故零命中场景下 zero_hit 仍先占名额（严格等价保持）。若将来再插入
 * 排在旧三态之前的读侧 code，必须同步处理（提升 cap、或把旧三态移出 ≤3 名额池）。
 *
 * 构造用内核的 `makeHintCandidate`（通用形状），本函数只负责**领域语义**：旧三态
 * 恒为 `suggestion` + `noDedup`。
 *
 * @param code 旧三态码（zero_hit / weak_hit / positional_order）
 * @param resourceKey 去重资源键（本类不参与窗口，仅作埋点维度——须为哈希化值，禁 q 原文）
 * @param data 结构化触发信息（zero_hit={q} / weak_hit={topScore,threshold} / positional_order={mode}）
 */
export function makeLegacySearchHintCandidate(
  code: 'zero_hit' | 'weak_hit' | 'positional_order',
  resourceKey: string,
  data: Record<string, unknown>,
): HintCandidate {
  return { ...makeHintCandidate(code, 'suggestion', resourceKey, data), noDedup: true };
}

/**
 * **docspace 对通用内核（`hints/hint-core`）的领域侧配置单源**。
 *
 * 内核不认识任何 code（排序 / 文案 / 族归属一律注入）——本常量是 docspace 的唯一装配点：
 * - `priority`：D6 优先级序（`DOC_HINT_PRIORITY`，与 `hints/hint-registry` 的
 *   `priorityRank` 同序，由 spec 守卫）；
 * - `resolveMessage`：`candidate.message ?? DOC_HINT_MESSAGES[code]`——文案**唯一**
 *   解析口（check_skipped 变体靠候选自带的 message 覆盖）；
 * - `familyOf`：`CODE_FAMILY`（埋点维度；`tags_normalized` 无族）。
 *
 * ⚠️ 五个消费方一律传本常量，**禁止就地另拼 profile**（漂移后果 = 排序静默退化、
 * message 落空、或**去重窗口落缺省**）。
 *
 * ⚠️ **`ttlOf` 必须挂**（P1-1）：`hint-emit` 取 `profile.ttlOf?.(code)`，缺钩子 ⇒ 传
 * undefined ⇒ dedup 落 **6h 缺省** ⇒ 任何显式声明的窗口长度（如
 * `docs_overview_truncated` 的 24h 教学定位）静默失效。单源仍是注册表 `hintTtlOf`。
 */
export const DOC_HINT_PROFILE: HintEmitProfile<DocHintCode> = {
  priority: DOC_HINT_PRIORITY,
  resolveMessage: (candidate) => candidate.message ?? DOC_HINT_MESSAGES[candidate.code],
  familyOf: (code) => hintFamilyOf(code),
  // 去重窗口长度单源 = 注册表；缺本钩子 ⇒ 缺省 6h（对本 profile 下的 24h 码是错值）
  ttlOf: (code) => hintTtlOf(code),
};

// ─── trigram 近义（应用层纯函数，零 PG 依赖）─────────────────────────────

/**
 * 字符串的 trigram 集合（**双侧空格填充**，与 pg_trgm 同款填充约定）：
 * `"npc"` → `{"  n"," np","npc","pc "}`。
 */
function trigramSet(value: string): Set<string> {
  const padded = `  ${value.toLowerCase()} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

/**
 * trigram Jaccard 相似度（0–1）：`|A∩B| / |A∪B|`（集合口径，重复 gram 只计一次）。
 *
 * 与 PG `similarity()` 的数值**不保证相等**（PG 用 multiset 计数），本函数只服务
 * 提示判定，不做跨库数值对照——阈值语义自洽即可。
 *
 * @returns 完全相等 → 1；任一为空 → 0
 */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ga = trigramSet(a);
  const gb = trigramSet(b);
  if (ga.size === 0 || gb.size === 0) return 0;

  let intersection = 0;
  for (const gram of ga) {
    if (gb.has(gram)) intersection++;
  }
  const union = ga.size + gb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 在候选池中找近义值（阈值 + top-N + **排除 ci 精确命中**）。
 *
 * 为什么排除 ci 精确命中：ci 精确相等已被词表 alias 归一吸收（resolveTags），
 * 再报一次是重复噪音。
 *
 * 排序：相似度 DESC → count DESC → value ASC（全序，两次请求结果全等）。
 */
export function findNearDuplicates(
  value: string,
  pool: HintPoolEntry[],
  options: { threshold?: number; top?: number } = {},
): HintPoolEntry[] {
  const threshold = options.threshold ?? HINT_TRIGRAM_THRESHOLD;
  const top = options.top ?? HINT_NEAR_DUP_TOP;
  const lower = value.toLowerCase();

  return pool
    .filter((entry) => entry.value.toLowerCase() !== lower)
    .map((entry) => ({ entry, score: trigramSimilarity(value, entry.value) }))
    .filter(({ score }) => score >= threshold)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.count - a.entry.count ||
        a.entry.value.localeCompare(b.entry.value),
    )
    .slice(0, top)
    .map(({ entry }) => entry);
}

// ─── 写侧候选构造器 ──────────────────────────────────────────────────────

/**
 * metadata 族（missing_category / empty_tags / empty_summary）——**落库后**判定。
 *
 * 判据一律读**落库后**的 doc 值（经 tag 归一后），不是 caller 输入。
 *
 * @param state 落库后的三字段（categoryId / tags / summary）
 * @param resourceKey 去重资源键（docId）
 */
export function buildMetadataHints(
  state: { categoryId: string | null; tags: string[]; summary: string | null },
  resourceKey: string,
): HintCandidate[] {
  const out: HintCandidate[] = [];
  if (!state.categoryId) {
    out.push(makeHintCandidate('missing_category', 'suggestion', resourceKey));
  }
  if (!state.summary || state.summary.trim() === '') {
    out.push(makeHintCandidate('empty_summary', 'suggestion', resourceKey));
  }
  if (state.tags.length === 0) {
    out.push(makeHintCandidate('empty_tags', 'suggestion', resourceKey));
  }
  return out;
}

/**
 * pathType 族（path_type_mismatch）：path 命中某声明前缀且 docType ≠ 声明值。
 *
 * **最长前缀优先**（多个前缀同时命中时取最具体的声明）；docType 为空视为不一致
 * （声明了推荐值却没写 = 该提示的真实价值面）。advisory——**不落库纠偏**。
 *
 * @param path 落库后的文档 path
 * @param docType 落库后的 docType（可空）
 * @param pathTypes 空间声明的 pathTypes（null = 未声明，无判定依据）
 */
export function buildPathTypeMismatchHint(
  path: string,
  docType: string | null,
  pathTypes: DocSpacePathType[] | null,
  resourceKey: string,
): HintCandidate | null {
  const matched = matchPathType(path, pathTypes);
  if (!matched) return null;
  if (docType !== null && docType === matched.docType) return null;

  return makeHintCandidate('path_type_mismatch', 'check_failed', resourceKey, {
    pathPrefix: matched.pathPrefix,
    expected: matched.docType,
    actual: docType,
  });
}

/**
 * pathTypes 前缀匹配（**最长前缀优先**）。
 *
 * @returns 命中的声明；无命中 → null
 */
export function matchPathType(
  path: string,
  pathTypes: DocSpacePathType[] | null,
): DocSpacePathType | null {
  if (!pathTypes || pathTypes.length === 0) return null;

  let best: DocSpacePathType | null = null;
  for (const candidate of pathTypes) {
    if (!path.startsWith(candidate.pathPrefix)) continue;
    if (!best || candidate.pathPrefix.length > best.pathPrefix.length) best = candidate;
  }
  return best;
}

/**
 * 判定 tags 中是否存在**词表外**的取值（ci 未命中任何 canonical 或 alias）。
 *
 * ⚠️ **历史谓词——生产已零调用点，保留仅供单测回归**：tags 族的池查询闸门已收口于
 * `shouldLoadTagPool`（多一维「实体锚点」预判，本函数不覆盖）。**禁止**在新代码里拿它
 * 当闸门：锚点 tag 会被判为「值得查池」（`['2026-10-05']` → true，而正确闸门为 false），
 * 白付一次池聚合；反向的静默丢 hint 风险见 `shouldLoadTagPool` 注释。
 */
export function hasUndeclaredTag(
  tags: string[],
  vocabulary: DocSpaceCanonicalTag[] | null,
): boolean {
  if (tags.length === 0) return false;
  const declared = declaredTagKeys(vocabulary);
  return tags.some((tag) => !declared.has(tag.toLowerCase()));
}

/** 词表声明的 ci 键集合（canonical + aliases；null 词表 → 空集 = 全部词表外） */
function declaredTagKeys(vocabulary: DocSpaceCanonicalTag[] | null): Set<string> {
  const declared = new Set<string>();
  for (const entry of vocabulary ?? []) {
    declared.add(entry.value.toLowerCase());
    for (const alias of entry.aliases ?? []) declared.add(alias.toLowerCase());
  }
  return declared;
}

/**
 * **tags 族的 tag 池加载闸门**（批 1：upsertCore 与 patchMetadata 两条路径共用的单源）。
 *
 * 本批根治的失效模式 = 两条路径**手工镜像同一语义后漂移**（写侧 upsert 与
 * patch_metadata 各写一份 if 条件，后者把「写语义的 Partial 回退」误用为「评估作用域
 * 闸门」，导致未携带 tags 时对**全量既有 tags** 跑近义比对）。抽成纯函数后，闸门语义
 * 只有一处可改。
 *
 * 谓词 = **存在一个「词表外 ∧ 非实体锚点」的 tag**：
 * - 族关 → false（零额外查询）；
 * - 请求**未携带** tags（undefined）或空数组 → false——**比较型 hint 的评估作用域 =
 *   本请求携带的数据**，存量 tags 不构成评估理由；
 * - 全部 tag 已命中词表 → false（归一已吸收，近义判定必然无输出）；
 * - 只剩实体锚点 → false（`buildTagNearDupHints` 会过滤掉它们，池查询必然白付）。
 *
 * 最后一条与 `buildTagNearDupHints` 的输入过滤**共用 `isEntityAnchorTag` 单源**，
 * 禁止各自实现——漂移后果不对称：**闸门宽 = 白付一次全空间聚合；闸门窄 = 静默丢
 * hint 假阴性**（更危险，且没有观测面）。
 *
 * @param tags **请求面** tags（已归一；undefined = 未携带）——绝不可传落库后的
 *   `doc.tags`（那就是本批修掉的失效模式）
 * @param hintToggles 空间 hintToggles（null = 全关）
 * @param vocabulary 空间 canonicalTags 词表（null = 未声明 → 全部视为词表外）
 * @returns true = 调用方应执行 `loadTagPool`
 */
export function shouldLoadTagPool(
  tags: string[] | undefined,
  hintToggles: DocSpaceHintToggles | null | undefined,
  vocabulary: DocSpaceCanonicalTag[] | null,
): boolean {
  if (hintToggles?.tags !== true) return false;
  if (!tags || tags.length === 0) return false;
  const declared = declaredTagKeys(vocabulary);
  return tags.some((tag) => !declared.has(tag.toLowerCase()) && !isEntityAnchorTag(tag));
}

/**
 * tags 族（tag_near_dup）：归一后仍在词表外的 tag，与空间 tag 池有 trigram 近义。
 *
 * 候选池 = 全空间 DISTINCT tags（service 层查好传入）。**只出候选不判同**。
 *
 * **实体锚点抑制（批 1）**：池条目与输入 tag **两侧**都过 `isEntityAnchorTag` 过滤——
 * 锚点是逐值唯一标识，trigram 相似与语义同义无关（日期 0.5000 压线 / 版本号 0.5556 /
 * hex 0.6364 均真实可达）。**接入点定死在函数体内**：不动 `findNearDuplicates`——
 * 它与 `buildCategoryNearDupHint` 共用，改它会越界改 categories 族语义。
 * 池预过滤同时消灭「候选全被过滤 → push 空 candidates 假阳性」通道。
 *
 * @param tags 落库后的 tags（归一后）
 * @param vocabulary 空间 canonicalTags 词表（null = 未声明 → 全部视为词表外）
 * @param pool 空间 tag 池
 * @param resourceKey docId
 */
export function buildTagNearDupHints(
  tags: string[],
  vocabulary: DocSpaceCanonicalTag[] | null,
  pool: HintPoolEntry[],
  resourceKey: string,
): HintCandidate[] {
  if (tags.length === 0 || pool.length === 0) return [];

  // 词表外判定：ci 命中 canonical 或 alias 的都已被归一吸收 → 只对未命中的 tag 判近义
  const declared = declaredTagKeys(vocabulary);

  // 池预过滤：实体锚点条目永不作候选（**不是**空判后过滤——空 candidates 会变成假阳性）
  const comparablePool = pool.filter((entry) => !isEntityAnchorTag(entry.value));
  if (comparablePool.length === 0) return [];

  const out: HintCandidate[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (declared.has(key) || seen.has(key)) continue;
    // 输入过滤：锚点 tag 不参与比对（与闸门预判共用 isEntityAnchorTag 单源）
    if (isEntityAnchorTag(tag)) continue;
    seen.add(key);

    const candidates = findNearDuplicates(tag, comparablePool);
    if (candidates.length === 0) continue;
    out.push(
      makeHintCandidate('tag_near_dup', 'suggestion', resourceKey, {
        tag,
        candidates: candidates.map((entry) => ({ value: entry.value, count: entry.count })),
      }),
    );
  }
  return out;
}

/**
 * tags_normalized（**无族、不去重**）：本请求实际发生 tag 归一时的事实回显。
 *
 * 与 `tagNormalizations` 字段双通道并存（后者是 1 期契约，本项进统一信封）。
 */
export function buildTagsNormalizedHint(
  mappings: Array<{ from: string; to: string }>,
  resourceKey: string,
): HintCandidate | null {
  if (mappings.length === 0) return null;
  return makeHintCandidate('tags_normalized', 'normalized', resourceKey, {
    mappings: mappings.map((m) => ({ from: m.from, to: m.to })),
  });
}

/**
 * categories 族（category_near_dup）：新建/自动建的分类与既有分类 trigram 近义。
 *
 * @param created 新建分类名
 * @param pool 空间既有分类池（**不含**刚新建的这一条；带 slug 供消费方直接复用）
 * @param resourceKey categoryId（写侧资源键）
 */
export function buildCategoryNearDupHint(
  created: string,
  pool: HintPoolEntry[],
  resourceKey: string,
): HintCandidate | null {
  if (pool.length === 0) return null;

  const candidates = findNearDuplicates(created, pool);
  if (candidates.length === 0) return null;

  return makeHintCandidate('category_near_dup', 'suggestion', resourceKey, {
    created,
    candidates: candidates.map((entry) => ({
      name: entry.value,
      slug: (entry.extra?.slug as string | undefined) ?? null,
    })),
  });
}

/**
 * routes 族（route_target_excluded）：路由主文档被空间默认 overviewFilter 排除。
 *
 * 判据：primaryDoc 的 docType ∈ `overviewFilter.excludeTypes`，或其 category slug ∈
 * `overviewFilter.excludeCategories`——该文档不会出现在 overview 地图里（路由点了看不到）。
 *
 * @param routeId 路由 ID（去重资源键）
 * @param docPath primaryDoc 的 path（展示用）
 * @param docType primaryDoc 的 docType（可空）
 * @param categorySlug primaryDoc 的 category slug（可空）
 * @param overviewFilter 空间默认过滤（null/缺省 = 未配置 → 不触发）
 */
export function buildRouteTargetExcludedHint(
  routeId: string,
  docPath: string,
  docType: string | null,
  categorySlug: string | null,
  overviewFilter: { excludeTypes?: unknown; excludeCategories?: unknown } | null,
): HintCandidate | null {
  if (!overviewFilter) return null;

  const excludeTypes = Array.isArray(overviewFilter.excludeTypes)
    ? (overviewFilter.excludeTypes as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const excludeCategories = Array.isArray(overviewFilter.excludeCategories)
    ? (overviewFilter.excludeCategories as unknown[]).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];

  let matched: { kind: 'type' | 'category'; value: string } | null = null;
  if (docType !== null && excludeTypes.includes(docType)) {
    matched = { kind: 'type', value: docType };
  } else if (categorySlug !== null && excludeCategories.includes(categorySlug)) {
    matched = { kind: 'category', value: categorySlug };
  }
  if (!matched) return null;

  return makeHintCandidate('route_target_excluded', 'suggestion', routeId, {
    routeId,
    docPath,
    matchedExclusion: matched,
  });
}

/**
 * routes 族（route_anchor_recheck）：有路由指向本文档的**知悉型**提示。
 *
 * 用于 move——move 只改 path、不动 sections/headings，**锚必然不因 move 断**
 * （docId 引用连续），故文案诚实表述「供知悉核对」，不是问题上报。
 *
 * @param routeIds 指向该文档的路由 ID 清单（来自 impact.docRoutes，零额外查询）
 * @param resourceKey docId
 * @param options 影响面超 cap 时改发 check_skipped 变体（status + message + data）
 */
export function buildRouteAnchorRecheckHint(
  routeIds: string[],
  resourceKey: string,
  options: { skipped?: boolean; total?: number } = {},
): HintCandidate | null {
  if (routeIds.length === 0 && !options.skipped) return null;

  if (options.skipped) {
    return makeHintCandidate(
      'route_anchor_recheck',
      'check_skipped',
      resourceKey,
      { count: options.total ?? routeIds.length, reason: 'too_many_affected' },
      DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE,
    );
  }
  return makeHintCandidate('route_anchor_recheck', 'suggestion', resourceKey, { routeIds });
}

/**
 * routes 族（route_anchor_broken）：headingPath 锚在本次写入后不再命中。
 *
 * 两条数据源：
 * - upsert：事务内 in-memory `chunks` 的 headingPath 集合（A4——校验对象就是刚插入的
 *   同一份数据，零额外查询，且与幂等快照同事务）；
 * - delete：docId 锚断（语义判定，全部引用路由都失效，无逐锚成本）。
 *
 * @param routeIds 受影响路由 ID 清单
 * @param anchors 逐锚明细（delete 场景可传空数组——docId 锚断无锚点可比）
 * @param resourceKey docId
 */
export function buildRouteAnchorBrokenHint(
  routeIds: string[],
  anchors: Array<{ routeId: string; headingPath: string }>,
  resourceKey: string,
): HintCandidate | null {
  if (routeIds.length === 0) return null;
  return makeHintCandidate('route_anchor_broken', 'check_failed', resourceKey, {
    routeIds,
    anchors,
  });
}

// ─── 读侧候选构造器 ──────────────────────────────────────────────────────

/**
 * 读侧路径形态判定：含 `/` 且全字符 ∈ `[\w\-./\u4e00-\u9fff]`，且不以空白收尾。
 *
 * 为什么不判「以 .md 结尾」：平台 path 不强制扩展名（如 `docs/architecture`），
 * 形态闸门只做粗筛，精确性交给「本空间确实存在该 path」的存在性查询。
 */
export function isPathLikeQuery(q: string): boolean {
  if (q.length === 0 || /\s$/.test(q)) return false;
  if (!q.includes('/')) return false;
  return PATH_LIKE_REGEX.test(q);
}

/**
 * read 族（query_looks_like_path）：q 形似本空间路径且该 path 确实存在。
 *
 * 调用方（service）已保证：① 本空间存在该精确 path 的未软删 doc；② 零命中或
 * top hit 不是该 doc（否则提示无价值）。**族关时连存在性轻查都不做**。
 *
 * @param path 命中的文档 path
 * @param docId 命中文档 ID
 * @param resourceKey 去重资源键（= path，同一路径 6h 内一次）
 */
export function buildQueryLooksLikePathHint(
  path: string,
  docId: string,
  resourceKey: string,
): HintCandidate {
  return makeHintCandidate('query_looks_like_path', 'suggestion', resourceKey, { path, docId });
}

/**
 * read 族（suggest_relaxing）：零命中 ∧ 本次带了显式筛选。
 *
 * **只回显 caller 真实用过的参数**：`sort`/`limit`/`offset`/`q` 不算筛选；
 * `pathPrefix`/`applySpaceDefaults` 端点没有（不得提）。**不承诺去掉筛选必有结果**。
 *
 * @param appliedFilters 本次实际传的参数（key → value，仅实际传的）
 * @param resourceKey 去重资源键（spaceId + 筛选签名，由 service 构造）
 */
export function buildSuggestRelaxingHint(
  appliedFilters: Record<string, unknown>,
  resourceKey: string,
): HintCandidate | null {
  const removableParams = DOC_SEARCH_FILTER_PARAMS.filter(
    (param) => appliedFilters[param] !== undefined,
  );
  if (removableParams.length === 0) return null;

  return makeHintCandidate('suggest_relaxing', 'suggestion', resourceKey, {
    appliedFilters,
    removableParams,
    note: 'relaxing filters is not guaranteed to produce hits',
  });
}

/**
 * read 族（`docs_overview_truncated`，阶段三决策 9）：overview 的**文档条目**被
 * `maxTokens` 截断时的分页教学。
 *
 * **教学定位**（不是每次提醒）：触发判据在 service 层（截断 ∧ 调用方未显式传 maxTokens），
 * 本函数只负责「已判定为截断」后的候选构造——纯函数、零 IO、永不抛。
 *
 * `data` 四字段是消费方的结构化出口（**不要解析 message**）：
 * `{ section, returnedCount, totalCount, suggestedTool, suggestedParams }`。
 * `suggestedParams.catalog = true` 是**最便宜的下一步**：catalog 模式豁免 maxTokens 截断
 * （目录完整性是它自己的契约），一次请求就能拿到全目录。
 *
 * @param spaceId 空间 ID（**去重资源键** = spaceId：同一空间 24h 内提醒一次）
 * @param returnedCount 实际返回的文档条目数（`docsReturned`）
 * @param totalCount 过滤后文档全量条数（`docsTotal`）
 */
export function buildDocsOverviewTruncatedHint(
  spaceId: string,
  returnedCount: number,
  totalCount: number,
): HintCandidate {
  return makeHintCandidate('docs_overview_truncated', 'suggestion', spaceId, {
    section: 'docs',
    returnedCount,
    totalCount,
    suggestedTool: 'get_docs_overview',
    suggestedParams: { catalog: true },
  });
}

/**
 * read 族（`docs_overview_routes_truncated`）：overview 的**意图路由段**被
 * `OVERVIEW_ROUTES_LIMIT`（策展序前 50 条）截断时的抓全教学。
 *
 * 与 {@link buildDocsOverviewTruncatedHint} **触发条件完全独立**：docs 段截断由 `maxTokens`
 * 预算触发、catalog 投影豁免它；routes 段的 50 条上限是**响应防爆**闸（与投影/预算无关），
 * 故 catalog 模式下照常截断、照常触发本码（这是本码存在的唯一理由——catalog 补不齐 routes）。
 *
 * `data` 五字段是消费方的结构化出口（**不要解析 message**）：
 * `{ section, returnedCount, totalCount, suggestedTool, suggestedParams }`。
 * `suggestedParams.page/pageSize` 是**分页拉全**的起点（`list_doc_routes` 单页上限 100）；
 * 需要按意图/分组定位时再加 `q`/`category`。教学定位与兄弟码一致（24h 窗口，见注册表）。
 *
 * @param spaceId 空间 ID（**去重资源键** = spaceId：同一空间 24h 内提醒一次）
 * @param returnedCount 实际内嵌的路由条数（= `routes.length`，截断后恒为上限值）
 * @param totalCount 空间路由全量条数（`routesTotal`）
 */
export function buildDocsOverviewRoutesTruncatedHint(
  spaceId: string,
  returnedCount: number,
  totalCount: number,
): HintCandidate {
  return makeHintCandidate('docs_overview_routes_truncated', 'suggestion', spaceId, {
    section: 'routes',
    returnedCount,
    totalCount,
    suggestedTool: 'list_doc_routes',
    suggestedParams: { page: 1, pageSize: 100 },
  });
}
