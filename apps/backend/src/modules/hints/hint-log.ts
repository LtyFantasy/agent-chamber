/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 **hint 埋点**的结构化日志单源（v1.92.0-dev 2 期抽核，阶段一）：每条实际
 *     送达的 hint 落一行 JSONL，被去重窗口压制的不计触发率只落 debug 行。
 *
 * [代码职责]
 *   - `logHintEmitted`：warn 级落行——`{tag, ts, code, status, family, surface, spaceId,
 *     actorId, resourceKey}`，**只含标量**（禁用户输入原文：resourceKey 是
 *     docId/routeId/categoryId/spaceId/哈希值/path，不含自由文本）。
 *   - `logHintEmittedLegacy`：**debug 级**落行，**同一 builder / 同一 tag**——服务
 *     旧搜索三态（zero_hit / weak_hit / positional_order）。级别 rationale 见该函数。
 *   - `logHintSuppressed`：debug 级落行——同一 hint 在去重窗口内被压制，或**未获槽位**
 *     被预算截尾（`reason` 区分），或权限判定不可达（`reason=permission_filtered`）。
 *   - 两个 builder（`buildHintEmittedLogLine` / `buildHintSuppressedLogLine`）是仅有的
 *     产线函数：一律 `JSON.stringify`，**禁模板拼接**（拼接会让值里的引号/换行击穿
 *     JSON 结构，zero-hit-log 同款纪律）。
 *   - `ts`（ISO 时间戳）与 `reason`（压制成因）是**观察期仪器的两个标量附加字段**
 *     （阶段三）：`ts` 让 stdout 采集链捞出的行能直接进 SQL 时间窗 join（此前依赖采集
 *     侧补时间，口径不可靠）；`reason` 让「窗口压制」与「槽位挤占」「不可提名」三种
 *     未送达成因可分——§5 的反事实对照组必须按 `reason IS NULL` 过滤。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」（埋点
 *     维度与 KPI 口径）
 *   - 补充: 线上 docs/spec.md §4.1a「hints 信封类型」（DocHint 类型契约）
 *
 * [关键不变量]
 *   - **tag 值一字不动**（`DOC_HINT_EMITTED` / `DOC_HINT_SUPPRESSED`）：tag 是**观测
 *     契约**，改名 = 线上告警/聚合规则静默失效。
 *   - **日志行只允许一个 JSON 对象**（`JSON.stringify`，禁模板拼接）；
 *   - **tag 独立**：`HINT_LOG_TAG` / `HINT_SUPPRESSED_LOG_TAG` 不得复用
 *     `SEARCH_ZERO_HIT` / `SEARCH_WEAK_HIT`（后者是零命中挖掘任务的过滤键）；
 *   - **fail-open**：本模块不抛（对任意输入全定义），消费方不得再加 try/catch；
 *   - **字段类型平台级开放**（code / status / family / surface 一律 string）：新挂面
 *     的 code 词表由领域模块 / 注册表定义，本文件不做封闭词表校验——**只保证发出的
 *     是字符串**。字段**语义**不变（docspace 的取值照旧）。
 *   - **KPI 口径**：修正率 / 误报率 / 调用成本全部从本日志**离线聚合**，本期不建
 *     在线查询面。聚合按 **tag + level + code** 三键：同一 tag 在 warn（常规 hint）与
 *     debug（旧三态）两个级别都有行，**过滤靠 level/code 而非另开 tag**。
 *   - **`reason` 只出现在 suppressed 行**（emitted 行不带该键）：它的语义是「为什么这条
 *     没送达」，而 emitted 行就是送达本身。值域 = `null`（窗口压制）/ `slot_truncated`
 *     （预算槽位被占满）/ `permission_filtered`（权限判定不可达）——**键恒存在**（窗口
 *     压制时为 `null`），这样 §5 的 `WHERE reason IS NULL` 反事实过滤器口径唯一。
 *
 * [关联代码]
 *   - modules/hints/hint-core.ts — hint 候选构造与优先级截断（本模块的消费上游：
 *     只有实际送达的 hint 才落 emitted 行）
 *   - modules/hints/hint-dedup.service.ts — 去重窗口（压制判定来源）
 *   - modules/hints/hint-emit.ts — 接线层（本模块的唯一生产调用方）
 *   - modules/docspace/doc-hints.helper.ts — docspace 的 code 词表与族归属（family 取值来源）
 *   - common/utils/search/zero-hit-log.ts — 同族先例（结构化日志纪律与 tag 独立性）
 *   - hint-log.spec.ts — 落行形态与 spy 断言契约单测
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增字段必须是标量且不含用户输入原文；tag 值禁改
 * =============================================================================
 */
import type { Logger } from '@nestjs/common';

/** hint 实际送达日志锚点 tag（告警/聚合规则按此值过滤；改名 = 观测契约变更） */
export const HINT_LOG_TAG = 'DOC_HINT_EMITTED';

/** hint 被去重窗口压制日志锚点 tag（独立于 HINT_LOG_TAG，不得复用） */
export const HINT_SUPPRESSED_LOG_TAG = 'DOC_HINT_SUPPRESSED';

/**
 * 未送达成因（suppressed 行的 `reason` 值域，缺省 `null` = 去重窗口压制）。
 *
 * - `null`：窗口压制——本资源本 actor 在 TTL 内已送达过同 code（**唯一可作反事实对照
 *   的成因**：若没有窗口，它本会送达）；
 * - `slot_truncated`：候选已通过窗口判定，但 ≤N 预算的槽位被更高优先级的候选
 *   （或域侧已挂的 hints）占满——「域侧挤占」的观测面；
 * - `permission_filtered`：触发者对本资源没有 write 权限（或身份缺失 ⇒ fail-closed），
 *   候选根本不产出——**不是**候选被压制，是「不可提名」。
 */
export const HINT_SUPPRESS_REASON = {
  /** 预算槽位被占满（域侧 hints 或更高优先级候选挤占） */
  slotTruncated: 'slot_truncated',
  /** 权限判定不可达（无 write 权限 / 匿名 fail-closed） */
  permissionFiltered: 'permission_filtered',
} as const;

/** `HINT_SUPPRESS_REASON` 的元素联合（suppressed 行 `reason` 的非 null 取值） */
export type HintSuppressReason = (typeof HINT_SUPPRESS_REASON)[keyof typeof HINT_SUPPRESS_REASON];

/**
 * hint 产出面标识（`surface` 字段值，**开放词表**：新挂面直接用新值，无需改本文件）
 *
 * 当前已知取值（docspace 2 期）：upsert / batch_upsert / patch_metadata / move /
 * delete / route_write / category_write（写侧）+ search（读侧）；新增挂面（如阶段二的
 * 拦截器 provider 面、阶段三的 task_hygiene / board_digest / docspace_overview）
 * 直接追加，本文件不维护封闭词表。
 */
export type HintSurface = string;

/**
 * hint 埋点输入（emitted 与 suppressed 共用形状）
 *
 * 全部字段为**标量或 null**：`resourceKey` 是机器资源标识（docId / routeId /
 * categoryId / spaceId+筛选签名 / 解析到的 path），不是自由文本。
 */
export interface HintLogInput {
  /** hint 机器码（词表单源在领域侧 / 注册表） */
  code: string;
  /** 四态语义（docspace：suggestion / normalized / check_skipped / check_failed） */
  status: string;
  /** 所属 hint 族（无族 → null；取值来源见 [关联代码]） */
  family?: string | null;
  /** 产出面（写侧挂点 / 读侧 search / 拦截器 provider 面） */
  surface: HintSurface;
  /** 目标空间 ID（可空 = 未知上下文） */
  spaceId?: string | null;
  /** 触发者 actor ID（可空 = 未认证写） */
  actorId?: string | null;
  /** 去重窗口资源键（可空） */
  resourceKey?: string | null;
  /**
   * 落行时间戳（ISO 8601）。缺省 = 调用时刻（`new Date().toISOString()`）——
   * 显式传入只为单测可断言，生产路径不需要传。
   */
  ts?: string;
  /**
   * 未送达成因（**只有 suppressed 行消费**；见 {@link HINT_SUPPRESS_REASON}）。
   * 缺省 / `null` = 去重窗口压制。
   */
  reason?: HintSuppressReason | null;
}

/**
 * 生成 emitted 单行 JSONL（**唯一产线函数**，禁模板拼接）。
 * @returns 单行 JSON 字符串（不含换行）
 */
export function buildHintEmittedLogLine(input: HintLogInput): string {
  return JSON.stringify({
    tag: HINT_LOG_TAG,
    ts: input.ts ?? new Date().toISOString(),
    code: input.code,
    status: input.status,
    surface: input.surface,
    ...(input.family ? { family: input.family } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.resourceKey ? { resourceKey: input.resourceKey } : {}),
  });
}

/**
 * 生成 suppressed 单行 JSONL（**唯一产线函数**）。
 *
 * `reason` **恒存在**（窗口压制时为 `null`）：键的缺席与 `null` 在 SQL 侧虽等价，但
 * 「键恒在」让 jq 捞出的临时表列稳定、也让「这条行为什么进对照组」的读法唯一。
 *
 * @returns 单行 JSON 字符串（不含换行）
 */
export function buildHintSuppressedLogLine(input: HintLogInput): string {
  return JSON.stringify({
    tag: HINT_SUPPRESSED_LOG_TAG,
    ts: input.ts ?? new Date().toISOString(),
    code: input.code,
    status: input.status,
    surface: input.surface,
    reason: input.reason ?? null,
    ...(input.family ? { family: input.family } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.resourceKey ? { resourceKey: input.resourceKey } : {}),
  });
}

/**
 * hint 实际送达落行（warn 级：hint 触发率是 KPI 主体，需在噪声中可被聚合捞出；
 * jest spy 断言锚点——消费方不得各自写格式断言）。
 */
export function logHintEmitted(logger: Logger, input: HintLogInput): void {
  logger.warn(buildHintEmittedLogLine(input));
}

/**
 * hint 被去重窗口压制落行（debug 级）：压制量级远高于实际送达（窗口内同一资源同一
 * code 只送达一次），warn 级会淹没 emitted 信号——与弱命中降级同款 rationale。
 */
export function logHintSuppressed(logger: Logger, input: HintLogInput): void {
  logger.debug(buildHintSuppressedLogLine(input));
}

/**
 * **旧搜索三态**的送达落行（debug 级；与 `logHintEmitted` 同 builder / 同 tag）。
 *
 * 为什么降级（原 rationale 的例外面）：`logHintSuppressed` 的「压制量级远高于送达」
 * 前提对**豁免去重窗口**的旧三态**不成立**——旧三态（zero_hit / weak_hit /
 * positional_order）逐响应送达且不占窗口 ⇒ 每次都落 emitted 行：
 * - `weak_hit` 正常查询就会触发（与 `logSearchWeakHit` 同量级）；
 * - `zero_hit` 与 `logSearchZeroHit`（warn）**同一触发**，warn 级会**重复落两行**；
 * - `positional_order` 单字/高频查询每次都来。
 * 三者都是高频面，warn 会淹没有效信号 ⇒ 与 zero-hit-log 对弱命中的处置同款，降 debug。
 *
 * ⚠️ **`normalized` 豁免项不降级**：它是写侧「归一已发生」的动作回显，低频且是修正率
 * 的正面信号，保持 `logHintEmitted`（warn）。
 */
export function logHintEmittedLegacy(logger: Logger, input: HintLogInput): void {
  logger.debug(buildHintEmittedLogLine(input));
}
