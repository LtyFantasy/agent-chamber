/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 **hint code 元数据目录**（v1.92.0-dev 阶段一基建 / 阶段二起被拦截器 provider
 *     消费）：把散落在各领域文件里的 hint 元数据（优先级序 / 族归属 / 去重窗口长度 /
 *     产出面 / 文案单源指针）收编成一张**声明式表**，供拦截器 provider 按 code 装配
 *     求值与节流。
 *
 * [代码职责]
 *   - `HintDefinition`：单条元数据记录（见字段注释，含阶段二预留钩子）。
 *   - 七张记录表：`DOC_HINT_DEFINITIONS`（docspace 18 码）、`MEMORY_HINT_DEFINITIONS`
 *     （memory formation 子态 13 码，由 {@link MEMORY_HINT_CODES} 派生）、
 *     `MEMORY_NOMINATION_DEFINITIONS`（memory_nomination_suggested 1 码，**独立显式条目**
 *     ——它不是 formation 子态，不进派生数组）、**`MEMORY_USAGE_DEFINITIONS`（cursor_reset_required
 *     1 码，独立 `memory_read` family）**、`TASK_HYGIENE_DEFINITIONS`（task 纪律族
 *     4 码）、`BOARD_DIGEST_DEFINITIONS`（board digest 截断 1 码）与
 *     `SECURITY_HINT_DEFINITIONS`（security 凭证扫描 1 码）——四张同款「独立显式数组」，
 *     因为它们都是**运行期附挂**（不在 docspace 契约的 `DocHintCode` 里）。
 *   - 查询 API（纯函数，模块级）：`getHintDefinition` / `listHintDefinitions` /
 *     `hintPriorityIndex`（code → 名次）/ `hintFamilyOf` / `hintTtlOf`。
 *   - `HintRegistry`：`@Injectable()` 薄门面（同一份静态表的 DI 形态；provider 经构造器
 *     注入，不直接 import 纯函数）——`MemoryNominationHintProvider` / `TaskHygieneHintProvider`
 *     / `SecurityHintProvider` 的 `familyOf` / `ttlOf` 即委托此处（去重窗口长度单源）。
 *   - `condition` / `buildContent` 仍是**预留钩子（无实现者）**：阶段二的 provider 自己
 *     实现判定与构造（它需要查库，签名与这两个同步钩子不同）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」— 18 个
 *     docspace code 的挂点与语义
 *   - 补充: 线上 docs/spec.md §4.1a「hints 信封类型」— DocHint / DocHintCode 契约
 *
 * [关键不变量]
 *   - **code 是稳定标识**：删码可以，**禁止改码名**（观测日志按 code 聚合，改名 =
 *     历史数据断裂）。新增码必须同时进 shared `DOC_HINT_CODES` + `DOC_HINT_MESSAGES`
 *     + 本表（+ 若参与排序，进 docspace `DOC_HINT_PRIORITY`）。
 *   - **priorityRank 必须与 docspace `DOC_HINT_PRIORITY` 同序**：本表是元数据登记，
 *     docspace 的常量表仍是排序**执行**的单源（阶段一）；两处一旦漂移，
 *     `doc-hints.helper.spec.ts` 的同源守卫会红。
 *   - **ttlMs 缺省 ≠ 豁免去重**（口径订正，2026-10-12）：缺省只表示「用去重的缺省窗口
 *     长度（{@link HINT_DEDUP_TTL_MS} = 6h）」；真正的窗口豁免只有两条实现路径——
 *     `status === 'normalized'` 与 `candidate.noDedup === true`（均在 `hint-emit.ts` 的
 *     `isWindowExempt`）。故 `tags_normalized` / `zero_hit` 等虽无 `ttlMs`，语义是
 *     「它们根本到不了去重判定」，不是「缺省值等于豁免」。
 *   - **本文件禁止 import 领域模块**（docspace / memory）：code 词表引 shared 常量，
 *     memory 侧码值内联（见 [持久踩坑]）。
 *
 * [关联代码]
 *   - modules/hints/hint-core.ts — 通用内核（排序 / 截尾 / 去重过滤）
 *   - modules/hints/hint-dedup.service.ts — `HINT_DEDUP_TTL_MS`（本表 ttlMs 的缺省值来源）
 *   - modules/hints/hint.interceptor.ts — 阶段二的求值入口（经 provider 消费本表）
 *   - modules/docspace/doc-hints.helper.ts — docspace 侧 code 词表 / 族归属 / 优先级
 *     常量（本表 docspace 段的同源守卫对象）
 *   - hint-registry.spec.ts — 查表 / 优先级索引 / ttl 覆盖 / 表完整性
 *
 * [持久踩坑]
 *   HINT-REG-1(memory 码内联): memory 侧的码值全部是**字面量内联**在本文件里的
 *     （依赖方向纪律禁止 `modules/hints` import `modules/memory`）——formation 13 码在
 *     {@link MEMORY_HINT_CODES}，拦截器通道 1 码在 {@link MEMORY_NOMINATION_DEFINITIONS}。
 *     改 `memory.constants.ts` 的 `MEMORY_HINT` 键值 / `MEMORY_NOMINATION_HINT_CODE` 时
 *     **必须同步本文件**，否则注册表查不到该码（provider 静默不产出）。
 *     守卫 = `modules/memory/memory.constants.spec.ts`（双向同源：每个真源码在表内 +
 *     `family='memory'` 条目无幽灵码、数量 = |MEMORY_HINT| + 1）。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增 code 时：shared 常量 + 本表 +（若参与排序）docspace 优先级表，三处齐步
 * =============================================================================
 */
import { Injectable } from '@nestjs/common';
import type { DocHintCode } from '@agent-chamber/shared';
import type { HintCandidate } from './hint-core';
import { HINT_DEDUP_TTL_MS } from './hint-dedup.service';
import type { HintFact } from './hint-facts';

/**
 * 单条 hint code 元数据。
 *
 * @typeParam TCode code 联合（docspace = `DocHintCode`；memory / 新挂面 = 各自的字面量联合）
 */
export interface HintDefinition<TCode extends string = string> {
  /** hint 机器码（稳定标识，禁改名） */
  code: TCode;
  /**
   * 所属族（日志与消费侧分族维度）。
   * docspace = `metadata` / `tags` / `categories` / `pathType` / `routes` / `read`；
   * `null` = 无族（如 `tags_normalized` 的事实回显）。memory 侧统一 `memory`。
   */
  family: string | null;
  /**
   * 固定优先级名次（**越小越先占 ≤3 名额**）；`null` = 不参与跨 code 排序
   * （memory 侧的 hint 是单值附挂，不存在同响应多码竞争）。
   */
  priorityRank: number | null;
  /**
   * 去重窗口长度（ms）。**缺省 ≠ 豁免去重**（口径订正，2026-10-12）：缺省只表示「用
   * 去重的缺省窗口长度（{@link HINT_DEDUP_TTL_MS} = 6h）」；真正的窗口豁免只有两条
   * 实现路径——`status === 'normalized'` 与 `candidate.noDedup === true`（均在
   * `hint-emit.ts` 的 `isWindowExempt`）。故 `tags_normalized` / `zero_hit` 等虽无
   * `ttlMs`，语义是「它们根本到不了去重判定」，不是「缺省值等于豁免」。
   */
  ttlMs?: number;
  /**
   * **主**产出面（归属登记，不是穷举——同一 code 可能有次要挂面，如
   * `route_anchor_broken` 兼出 upsert 与 delete）。取值即 `hint-log` 的 surface 词表。
   */
  ownerSurface: string;
  /**
   * 文案单源**指针**（人可读的可解析定位符，非 import）：文案本身仍在原处，
   * 本表只登记「去哪找」。禁在此写文案正文（会与真源双写漂移）。
   */
  messageSource: string;
  /**
   * **阶段二预留钩子（无生产消费方）**：触发判据——给定本次请求的事实袋与响应载荷，
   * 判定该 code 是否应产出。缺省 = 由 provider 自行判定。
   */
  condition?: (facts: readonly HintFact[], payload: unknown) => boolean;
  /**
   * **阶段二预留钩子（无生产消费方）**：候选构造（`null` = 本次不产出）。
   * 返回的候选仍需走 `hint-core.finalizeHints` 的排序/去重/截尾。
   */
  buildContent?: (facts: readonly HintFact[], payload: unknown) => HintCandidate<TCode> | null;
}

/** docspace 段：文案单源指针（shared 常量名；check_skipped 变体另有专用常量） */
const DOC_MESSAGE_SOURCE = '@agent-chamber/shared DOC_HINT_MESSAGES[code]';

/**
 * docspace 18 码（v1.92.0-dev 2 期 + 阶段三扩码 2 + overview routes 截断补 1）元数据。
 *
 * 名次与族归属必须与 `modules/docspace/doc-hints.helper.ts` 的 `DOC_HINT_PRIORITY` /
 * `CODE_FAMILY` 一致（守卫见文件头 [关键不变量]）。
 */
export const DOC_HINT_DEFINITIONS: readonly HintDefinition<DocHintCode>[] = [
  {
    code: 'route_anchor_broken',
    family: 'routes',
    priorityRank: 0,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'path_type_mismatch',
    family: 'pathType',
    priorityRank: 1,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'route_target_excluded',
    family: 'routes',
    priorityRank: 2,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'route_write',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'category_near_dup',
    family: 'categories',
    priorityRank: 3,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'category_write',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'tag_near_dup',
    family: 'tags',
    priorityRank: 4,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'missing_category',
    family: 'metadata',
    priorityRank: 5,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'empty_summary',
    family: 'metadata',
    priorityRank: 6,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'empty_tags',
    family: 'metadata',
    priorityRank: 7,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'route_anchor_recheck',
    family: 'routes',
    priorityRank: 8,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'move',
    // check_skipped 变体文案：DOC_HINT_ROUTE_RECHECK_SKIPPED_MESSAGE（同 shared 常量源）
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    // 事实回显：每次请求都发 → **无窗口**（status = normalized）
    code: 'tags_normalized',
    family: null,
    priorityRank: 9,
    ownerSurface: 'upsert',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'query_looks_like_path',
    family: 'read',
    priorityRank: 10,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'search',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'suggest_relaxing',
    family: 'read',
    priorityRank: 11,
    ttlMs: HINT_DEDUP_TTL_MS,
    ownerSurface: 'search',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    // 旧搜索三态双写：`noDedup` 豁免窗口 → **无 ttlMs**（与不去重的 hint/hintCode 等价）
    code: 'zero_hit',
    family: 'read',
    priorityRank: 12,
    ownerSurface: 'search',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    // 零命中引流码（阶段三，决策 9）：经验库单目的地。名次刻意排在 zero_hit **之后**
    // ——旧三态双写的「逐响应等价」承诺依赖「zero_hit 恒占得到名额」，排在它前面会
    // 在拥挤场景把它挤出 ≤3（等价性破裂）。
    code: 'search_experiences_suggested',
    family: 'read',
    // 6h：引流是低频引导，不是每次提醒（与 zero_hit 的逐响应不同）
    ttlMs: 6 * 60 * 60 * 1000,
    priorityRank: 13,
    ownerSurface: 'search',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'weak_hit',
    family: 'read',
    priorityRank: 14,
    ownerSurface: 'search',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    code: 'positional_order',
    family: 'read',
    priorityRank: 15,
    ownerSurface: 'search',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    // 截断续读码（阶段三，决策 9）：overview 文档条目被 maxTokens 截断时的分页教学。
    // 末位（16）：它是「顺带告知」，不该挤占任何实质提示的名额。
    // `ttlMs` = **24h**（教学定位：分页姿势学一次就够，不是每次提醒）——与 board 侧
    // `board_digest_truncated` 同窗口长度（两条截断码同为教学面）。
    code: 'docs_overview_truncated',
    family: 'read',
    ttlMs: 24 * 60 * 60 * 1000,
    priorityRank: 16,
    ownerSurface: 'docs_overview',
    messageSource: DOC_MESSAGE_SOURCE,
  },
  {
    // overview **routes 段**截断的教学码（与 docs 段截断独立触发：catalog 只豁免 docs 段）。
    // 名次 17 = 新的末位（让位款排在 docs 截断之后）：它连 catalog 这层最便宜下步都没有，
    // 只是「抓全走分页工具」的教学。`ttlMs` = 24h，与兄弟截断码同窗口（教学面）。
    code: 'docs_overview_routes_truncated',
    family: 'read',
    ttlMs: 24 * 60 * 60 * 1000,
    priorityRank: 17,
    ownerSurface: 'docs_overview',
    messageSource: DOC_MESSAGE_SOURCE,
  },
];

/** memory 段：文案单源指针（逐态文案 + 机器码同源，见 memory.constants.ts） */
const MEMORY_MESSAGE_SOURCE =
  'modules/memory/memory.constants.ts MEMORY_HINT + buildFormationHint()';

/**
 * memory 的 13 个 **formation 子态** hint 码（**字面量内联**，顺序对齐
 * `memory.constants.ts` 的 `MEMORY_HINT`）。
 *
 * ⚠️ 数组范围 = formation 子态码，**不是**「memory 侧全部码」——拦截器通道的
 * `memory_nomination_suggested` 是独立显式条目（见 {@link MEMORY_NOMINATION_DEFINITIONS}），
 * 禁止塞进本数组（那会让「子态派生」这条不变量变成谎话）。
 *
 * 为什么不用 `Object.values(MEMORY_HINT)`：依赖方向纪律禁止 `modules/hints` import
 * `modules/memory`——真源改码值时必须同步本数组（见 [持久踩坑] HINT-REG-1）。
 */
const MEMORY_HINT_CODES: readonly string[] = [
  'same_key_resend',
  'not_delivered_resend',
  'config_invalid',
  'param_invalid',
  'outcome_unknown',
  'rejected_hub_manual',
  'conflict_manual',
  // b4d41314：409 的 admission_cause 三值逐因码（未给/未知 cause 落 conflict_manual）
  'conflict_prefix_unresolved',
  'conflict_quota_exceeded',
  'conflict_exact_content',
  'committed',
  // 更正行 committed 但引擎侧链接未建立（旧主张仍 current）：retry 本行只重试链接步
  'correction_link_pending',
  'no_memory',
];

/**
 * memory **formation 子态** 13 码元数据（下一步指引）。
 *
 * memory 侧现有**两条 hint 通道**，本数组只管第一条：
 * ① formation 的 `hint` + `hintCode` **单值附挂**（不是 hints[] 数组、不参与 ≤3 截尾、
 *    无去重窗口）⇒ `priorityRank` 恒 `null`、`ttlMs` 恒缺省；13 条除 code 外元数据全同，
 *    故由码表派生（漂移面收敛到 {@link MEMORY_HINT_CODES} 一处）。
 * ② 拦截器 `hints[]` 信封通道（`memory_nomination_suggested`，见下一段）。
 */
export const MEMORY_HINT_DEFINITIONS: readonly HintDefinition<string>[] = MEMORY_HINT_CODES.map(
  (code) => ({
    code,
    family: 'memory',
    priorityRank: null,
    ownerSurface: 'memory_formation',
    messageSource: MEMORY_MESSAGE_SOURCE,
  }),
);

/**
 * memory **写路径拦截器通道**的元数据（阶段二首个 provider 挂面）。
 *
 * 与 formation 段的差别（决定了它为什么必须独立成条而不是并进派生数组）：
 * - 它是 `hints[]` **信封**里的一条（参与 ≤3 截尾与去重窗口），formation 的 13 码是
 *   `hint`/`hintCode` **单值**旁路；
 * - `ttlMs` = **10min**（阶段三决策 1：通用化后触发面远大于词表时代——「该提名了」是
 *   低频思考动作，10min 已足以防连打，24h 会把真实的多条裁决压成一次；是「注册表 ttlMs
 *   单源驱动去重窗口」的第一个真实覆盖点）；
 * - `priorityRank: null`：memory 侧不参与跨 code 排序（同响应只有它一条 memory 码）。
 *
 * `messageSource` 指向 `memory.constants.ts` 的文案常量（**指针不是副本**：文案本体仍
 * 在领域文件，本表只登记"去哪找"）。
 */
export const MEMORY_NOMINATION_DEFINITIONS: readonly HintDefinition<string>[] = [
  {
    code: 'memory_nomination_suggested',
    family: 'memory',
    priorityRank: null,
    // 10min 去重窗口（显式值，不取 HINT_DEDUP_TTL_MS 缺省）——理由见本段注释
    ttlMs: 10 * 60 * 1000,
    ownerSurface: 'memory_nomination',
    messageSource: 'modules/memory/memory.constants.ts MEMORY_NOMINATION_HINT_MESSAGE',
  },
];

/**
 * memory **Usage 读面**的动作码元数据（alpha.19；独立 `memory_read` family）。
 *
 * ⚠️ **不进** {@link MEMORY_HINT_DEFINITIONS}（那 13 条是 formation 子态，`family='memory'`
 * 的双向相等守卫见 `modules/memory/memory.constants.spec.ts`）。本码是**读路径**的动作码：
 * 携 cursor 的 409/400 在平台侧统一落 502 + `hintCode=cursor_reset_required`，消费动作
 * 只有一条——丢弃已累积页、按原 filter/limit 重拉首页一次。
 *
 * `shared_engine_binding`（409/14006）**刻意不登记**：它是错误动作码，不参与拦截器
 * hints[] 的排序/去重/窗口；登记它会让"registry = provider 元数据目录"的语义变宽。
 */
export const MEMORY_USAGE_DEFINITIONS: readonly HintDefinition<string>[] = [
  {
    code: 'cursor_reset_required',
    family: 'memory_read',
    priorityRank: null,
    ownerSurface: 'memory_usage',
    messageSource: 'modules/memory/memory.constants.ts MEMORY_USAGE_HINT',
  },
];

/** task 段：文案单源指针（`modules/task/task-hint.constants.ts` 的 messages 单源） */
const TASK_HINT_MESSAGE_SOURCE = 'modules/task/task-hint.constants.ts TASK_HINT_MESSAGES[code]';

/**
 * task 纪律族（阶段三决策 9 + v1.94.0-dev 依赖引导 + v1.95.0-dev 撞重提示）——
 * `task_done_without_report` + `task_dependents_pending` + `comment_on_done_task` +
 * `task_near_duplicate_suspected`。
 *
 * 与 `MEMORY_NOMINATION_DEFINITIONS` 同款「独立显式数组」先例（**不是**派生数组）：
 * 这四条是拦截器 provider（`TaskHygieneHintProvider`）的产出口，形态是 `hints[]` 信封里
 * 的运行期附挂（task 响应 DTO **不声明** hints 键），不是 docspace/formation 的既有通道。
 *
 * - `priorityRank: null`：平台级 code，不参与 docspace 的跨 code 排序；四条之间的相对
 *   顺序由 provider 自己的 `priority` 数组钉（同响应可能命中两条，见 provider 注释）。
 * - `ttlMs` = 6h（纪律提醒的中频窗口：同一任务 6h 内提醒一次足够）。
 *   ⚠️ 撞重码的 6h 窗口**在本码上近乎空转**：唯一可能的压制场景是幂等重放，而重放路径
 *   根本不 emit（`create` 的 23505 分支提前返回）——故它的防疲劳实际来自「检测器
 *   FP≈0 的确定性 + 任务创建本身低频」，窗口只是兜底（tradeoff 成文于 docs/modules/hint-system.md）。
 */
export const TASK_HYGIENE_DEFINITIONS: readonly HintDefinition<string>[] = [
  {
    code: 'task_done_without_report',
    family: 'board',
    priorityRank: null,
    ttlMs: 6 * 60 * 60 * 1000,
    ownerSurface: 'task_hygiene',
    messageSource: TASK_HINT_MESSAGE_SOURCE,
  },
  {
    // v1.94.0-dev：review/done 且有未完成的 blocks 下游依赖。模板文案（占位符渲染）
    code: 'task_dependents_pending',
    family: 'board',
    priorityRank: null,
    ttlMs: 6 * 60 * 60 * 1000,
    ownerSurface: 'task_hygiene',
    messageSource: TASK_HINT_MESSAGE_SOURCE,
  },
  {
    code: 'comment_on_done_task',
    family: 'board',
    priorityRank: null,
    ttlMs: 6 * 60 * 60 * 1000,
    ownerSurface: 'task_hygiene',
    messageSource: TASK_HINT_MESSAGE_SOURCE,
  },
  {
    // v1.95.0-dev：新建任务与同板 open 任务撞题（tier1 归一化等值 ∪ 白名单 tier2a）。
    // 模板文案（占位符渲染）；resourceKey = **新 taskId**（行为 join 可直接读，见 provider）
    code: 'task_near_duplicate_suspected',
    family: 'board',
    priorityRank: null,
    ttlMs: 6 * 60 * 60 * 1000,
    ownerSurface: 'task_hygiene',
    messageSource: TASK_HINT_MESSAGE_SOURCE,
  },
];

/** board 段：文案单源指针（`modules/board/board-hint.constants.ts`） */
const BOARD_HINT_MESSAGE_SOURCE = 'modules/board/board-hint.constants.ts BOARD_HINT_MESSAGES[code]';

/**
 * board digest 段（阶段三，决策 9）——`board_digest_truncated` 单码。
 *
 * 形态 = board digest 响应的**运行期附挂** hints（BoardDigest DTO 不声明该键），
 * 故它进不了 `DocHintCode`（那是 docspace 契约，见 `hint-core` 的类型分层），
 * 只能在这里登记元数据——与 `MEMORY_NOMINATION_DEFINITIONS` 同款先例。
 *
 * - `family: 'read'`：它是读侧「这段被截断了，怎么拿全」的引导（与 docspace 读侧同族）。
 * - `ttlMs` = 24h：教学定位（分页姿势学一次就够），不是每次提醒。
 */
export const BOARD_DIGEST_DEFINITIONS: readonly HintDefinition<string>[] = [
  {
    code: 'board_digest_truncated',
    family: 'read',
    priorityRank: null,
    ttlMs: 24 * 60 * 60 * 1000,
    ownerSurface: 'board_digest',
    messageSource: BOARD_HINT_MESSAGE_SOURCE,
  },
];

/** security 段：文案单源指针（`modules/hints/security-hint.constants.ts`） */
const SECURITY_HINT_MESSAGE_SOURCE =
  'modules/hints/security-hint.constants.ts SECURITY_HINT_MESSAGES[code]';

/**
 * security 段（v1.94.0-dev，凭证扫描）——`sensitive_credential_suspected` 单码。
 *
 * 形态 = **域侧写路径扫描命中后经事实袋**送到拦截器 provider 的 `hints[]` 附挂
 * （响应 DTO 不声明该键）；扫描与**告警**在域侧就地完成，与本表无关（本表只管
 * hint 送达侧的元数据）。
 *
 * - `family: 'security'`：**新族**（与 board / memory / docspace 各族的观测维度并列）。
 * - `ttlMs` = 6h（**显式**，不落缺省）：同一资源 6h 内提示一次足够。
 * - `ownerSurface: 'credential_scan'`：新产出面（扫描点所在的域侧写路径）。
 */
export const SECURITY_HINT_DEFINITIONS: readonly HintDefinition<string>[] = [
  {
    code: 'sensitive_credential_suspected',
    family: 'security',
    priorityRank: null,
    ttlMs: 6 * 60 * 60 * 1000,
    ownerSurface: 'credential_scan',
    messageSource: SECURITY_HINT_MESSAGE_SOURCE,
  },
];

/**
 * 全表（docspace 18 + memory formation 13 + memory nomination 1 + **memory usage 1**
 * + task hygiene 4 + board digest 1 + security 1 = 39；码值全局唯一）
 */
export const HINT_DEFINITIONS: readonly HintDefinition[] = [
  ...DOC_HINT_DEFINITIONS,
  ...MEMORY_HINT_DEFINITIONS,
  ...MEMORY_NOMINATION_DEFINITIONS,
  ...MEMORY_USAGE_DEFINITIONS,
  ...TASK_HYGIENE_DEFINITIONS,
  ...BOARD_DIGEST_DEFINITIONS,
  ...SECURITY_HINT_DEFINITIONS,
];

/** 按 code 查元数据（未登记 → undefined） */
export function getHintDefinition(code: string): HintDefinition | undefined {
  return HINT_DEFINITIONS.find((definition) => definition.code === code);
}

/**
 * 全表查询（可按 ownerSurface / family 过滤——阶段二的 provider 按面取自己的码）。
 *
 * @param filter 可选过滤条件（`ownerSurface` / `family` 精确匹配）
 */
export function listHintDefinitions(filter?: {
  ownerSurface?: string;
  family?: string;
}): readonly HintDefinition[] {
  if (!filter) return HINT_DEFINITIONS;
  return HINT_DEFINITIONS.filter(
    (definition) =>
      (filter.ownerSurface === undefined || definition.ownerSurface === filter.ownerSurface) &&
      (filter.family === undefined || definition.family === filter.family),
  );
}

/**
 * 优先级索引（code → 名次）——**只含声明了 `priorityRank` 的码**（memory 侧不入表）。
 *
 * 用途（阶段二）：provider 把名次表喂给 `hint-core.finalizeHints` 的 `spec.priority`，
 * 或按名次直接排序自己的候选。
 */
export function hintPriorityIndex(): Map<string, number> {
  const index = new Map<string, number>();
  for (const definition of HINT_DEFINITIONS) {
    if (definition.priorityRank !== null) index.set(definition.code, definition.priorityRank);
  }
  return index;
}

/** code → 族归属（未登记 → null） */
export function hintFamilyOf(code: string): string | null {
  return getHintDefinition(code)?.family ?? null;
}

/**
 * code → **声明的**去重窗口长度（ms）。
 *
 * ⚠️ 返回 `undefined` 有**两种**成因，调用方都**不可**读作「该 code 豁免去重」：
 * ①该 code 未登记；②登记了但未声明 `ttlMs`（如 `tags_normalized`）。两者在 dedup 侧一律
 * 落**缺省 6h**（{@link HINT_DEDUP_TTL_MS}）。真正的窗口豁免由候选的
 * `status === 'normalized'` / `noDedup === true` 决定（见 `hint-emit.ts` 的 `isWindowExempt`），
 * 与 `ttlMs` 无关——这正是本注释订正的那条漂移。
 */
export function hintTtlOf(code: string): number | undefined {
  return getHintDefinition(code)?.ttlMs;
}

/**
 * 注册表门面（Nest `@Injectable()`）：同一份静态表的 DI 形态。
 *
 * 为什么还要一个类：阶段二的 provider 要经构造器注入（可 mock / 可替换），
 * 而纯函数导出对 Nest 容器不可见。**本类不持有任何状态**——所有方法直接委托上面的
 * 模块级纯函数，两处不可能漂移。
 */
@Injectable()
export class HintRegistry {
  /** 按 code 查元数据（未登记 → undefined） */
  get(code: string): HintDefinition | undefined {
    return getHintDefinition(code);
  }

  /** 全表 / 过滤查询 */
  list(filter?: { ownerSurface?: string; family?: string }): readonly HintDefinition[] {
    return listHintDefinitions(filter);
  }

  /** 优先级索引（code → 名次） */
  priorityIndex(): Map<string, number> {
    return hintPriorityIndex();
  }

  /** code → 族归属 */
  familyOf(code: string): string | null {
    return hintFamilyOf(code);
  }

  /** code → 声明的去重窗口长度（undefined = 未声明 ⇒ dedup 落缺省 6h；**不是**豁免去重） */
  ttlOf(code: string): number | undefined {
    return hintTtlOf(code);
  }
}
