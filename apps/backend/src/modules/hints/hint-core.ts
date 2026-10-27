/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 **hint 通用内核**（v1.92.0-dev 2 期抽核，阶段一）：把「候选池 → 排序 →
 *     去重过滤 → ≤N 截尾 → 存活项回调 → 信封条目」这段**决策编排**从 docspace
 *     领域文件里抽出来，做成**不认识任何 code 语义**的纯函数群。
 *
 * [代码职责]
 *   - `HintCandidate<TCode>`：候选的最小形状（code 泛型；`resourceKey` 是去重窗口
 *     的资源标识，**不进响应体**）。
 *   - `makeHintCandidate`：候选构造（空 data 不落键——信封形状纪律）。
 *   - `finalizeHints(candidates, spec)`：**唯一编排点**（排序 → 去重过滤 → 截尾 →
 *     对存活项回调 → 映射为信封条目）；空则 `undefined`（**禁空数组**）。
 *   - `HINT_MAX_PER_RESPONSE`：单响应上限的**缺省预算**（`spec.maxHints` 缺省取它）。
 *     截尾**不再静默**：`onSlotTruncated` 一旦接线，未获槽位的候选就落 debug 埋点
 *     （reason=slot_truncated）。**接线现状**：`emitHints`（接线层）**无条件**接
 *     `onSlotTruncated`（见 hint-emit.ts 的 onSlotTruncated 分支）⇒ 所有经 emitHints 的
 *     调用方（含五个 docspace in-service 消费方）都享受该埋点；**只有直接调 `finalizeHints`
 *     的调用方**（当前仅单测）不接回调 ⇒ 那一路仍是静默截尾（与阶段一逐字等价）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」—
 *     挂点表、≤3 截尾、去重窗口与豁免的消费者契约
 *   - 补充: 线上 docs/spec.md §4.1a「hints 信封类型」— DocHint 类型契约
 *
 * [关键不变量]
 *   - **本文件零 IO、永不抛**（与 doc-hints.helper / doc-vocabulary.helper 同款纪律）：
 *     任何 `await` / Repository / Logger 出现即越界——抛 = 把成功写入的响应打成 500。
 *   - **内核不认识任何 code**：排序优先级（`spec.priority`）与文案（`spec.resolveMessage`）
 *     一律由领域侧注入——本文件不 import 任何领域常量，出现 `DOC_HINT_*` 即越界。
 *   - **顺序不可换**：先按优先级排序 → 再去重过滤 → 最后截尾；**只有存活项被标记**
 *     （未送达/被截断的不占用去重窗口）。
 *   - **同响应同键只取首条**（`code + resourceKey`，P2-2）：去重窗口的 `mark` 发生在循环
 *     之后（`onEmit`），`isSuppressed` 又是纯读 ⇒ 没有这道闸门时同一响应里的同键多候选会
 *     **全部送达**（同一件事说三遍）。HTTP 层当前不可达（provider 已按资源自合并），
 *     但这是内核级形状不变量，不依赖调用方自觉。
 *   - **两条豁免**（由调用方在 isSuppressed 里体现，内核只保留 status 分支）：
 *     `status === 'normalized'`（每次请求的事实回显）不参与去重；`noDedup === true`
 *     （旧搜索三态双写）由 hint-emit 的窗口豁免负责——内核不感知后者。
 *   - **空结果 = undefined**：调用方一律 `...(hints ? { hints } : {})` 挂载，
 *     绝不产出 `hints: []`。
 *
 * [关联代码]
 *   - modules/hints/hint-emit.ts — 接线层（dedup + 埋点 + 三类窗口豁免）
 *   - modules/hints/hint-dedup.service.ts — 去重窗口（spec.isSuppressed 的实现来源）
 *   - modules/hints/hint-registry.ts — code 元数据目录（阶段二经此装配 profile）
 *   - modules/docspace/doc-hints.helper.ts — docspace 领域构造器群 + `DOC_HINT_PROFILE`
 *     （本内核的 docspace 侧配置单源）
 *   - hint-core.spec.ts — 排序 / 截尾 / 去重顺序 / normalized 穿透 / 空数组禁令
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增「内核该知道」的 code 语义前先自问：为什么不能由 spec 注入？
 * =============================================================================
 */
import type { DocHintStatus } from '@agent-chamber/shared';

/**
 * hint 四态语义（`suggestion` / `normalized` / `check_skipped` / `check_failed`）。
 *
 * 别名而非重定义：四态词表的单源 = shared `DOC_HINT_STATUSES`（docspace 契约），
 * 重复一份字面量必然漂移。内核只是**原样透传**，不解释任何一态的含义。
 */
export type HintStatus = DocHintStatus;

/**
 * 单响应 hints 上限的**缺省预算**（`spec.maxHints` 缺省取本值）。
 *
 * ⚠️ 本常量**不是**「唯一的单响应上限」：阶段三（⑦ merge 槽位预算）起，拦截器路径会传
 * **显式预算** `3 − 域侧已挂 hints 数`（域侧占的槽位不再发给 provider）。语义分工写清：
 * 「常量 = 缺省预算；只有拦截器路径传显式预算」——否则两处各写一个 3 必然漂移。
 */
export const HINT_MAX_PER_RESPONSE = 3;

/**
 * hint 候选（领域侧构造 → `finalizeHints` 编排 → 信封条目）
 *
 * 与信封条目的唯一差异 = `resourceKey`：去重窗口的资源标识（**不进响应体**，
 * 是内部字段）。`message` 缺省由调用方的 `resolveMessage` 决定。
 *
 * @typeParam TCode code 联合（docspace = `DocHintCode`；新挂面自定义）
 */
export interface HintCandidate<TCode extends string = string> {
  /** hint 机器码 */
  code: TCode;
  /** 四态语义 */
  status: HintStatus;
  /** 去重窗口资源键（写侧 = docId/routeId/categoryId；读侧 = spaceId+签名哈希 / path） */
  resourceKey: string;
  /** 结构化建议值（空则响应里不出现该键） */
  data?: Record<string, unknown>;
  /** 文案覆盖（缺省 = `spec.resolveMessage` 的结果，如 DOC_HINT_MESSAGES[code]） */
  message?: string;
  /**
   * **豁免去重窗口**（不压制、不标记；窗口规则见 hint-emit.emitHints）。
   *
   * 唯一用途 = **旧搜索三态双写**（zero_hit / weak_hit / positional_order）：旧
   * `hint`/`hintCode` 字段是**逐响应**引导（不去重），双写若参与去重就会出现
   * 「旧字段有、新字段无」的语义倒挂，破坏迁移期的严格等价承诺。
   */
  noDedup?: boolean;
}

/**
 * 信封条目（`finalizeHints` 的输出形状）
 *
 * 与 shared `DocHint` **逐字段同构**（code/status/message/data）——docspace 消费方
 * 直接吃 `DocHint[]` 无需转换；本内核之所以自带一份，是因为 `DocHint.code` 被收窄到
 * `DocHintCode`，而内核必须对 code 泛型（新挂面不复用 docspace 的 code 联合）。
 */
export interface HintEnvelopeItem<TCode extends string = string> {
  /** hint 机器码 */
  code: TCode;
  /** 四态语义 */
  status: HintStatus;
  /** 可执行下一步指引（人/Agent 可读面；文案单源由 `resolveMessage` 注入） */
  message: string;
  /** 结构化建议值（消费方读这里而不是解析 message） */
  data?: Record<string, unknown>;
}

/**
 * 构造候选（message 单源由调用方在 `resolveMessage` 里兜底；resourceKey 必填）。
 *
 * 空 `data` 对象**不落键**（信封形状纪律：`get_docs_overview` 消费方按「键存在性」
 * 判断是否有结构化补充信息）。
 *
 * @param code hint 机器码
 * @param status 四态语义
 * @param resourceKey 去重资源键
 * @param data 结构化建议值（空对象 = 不落键）
 * @param message 文案覆盖（仅 check_skipped 变体需要）
 */
export function makeHintCandidate<TCode extends string>(
  code: TCode,
  status: HintStatus,
  resourceKey: string,
  data?: Record<string, unknown>,
  message?: string,
): HintCandidate<TCode> {
  return {
    code,
    status,
    resourceKey,
    ...(data && Object.keys(data).length > 0 ? { data } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * `finalizeHints` 的调用配置（**领域侧注入**，见文件头「内核不认识任何 code」）。
 */
export interface FinalizeHintsSpec<TCode extends string = string> {
  /**
   * code 固定优先级序（排在前面的先占 ≤N 名额）。
   * 缺省 → 保持候选传入序（`Array.prototype.sort` 稳定）。
   */
  priority?: readonly TCode[];
  /**
   * 本次响应的**显式预算**（≤N 的 N）。缺省 = {@link HINT_MAX_PER_RESPONSE}。
   *
   * 用途（阶段三 ⑦ merge 槽位预算）：域侧已往载荷挂了 k 条 hints 时，调用方传
   * `3 − k`——域侧占的槽位不再发给 provider。**`0` 是合法预算**（仍会完成求值与
   * 截尾观测，只是全部候选落 `onSlotTruncated`）。
   */
  maxHints?: number;
  /** 去重窗口判定（`status === 'normalized'` 时内核不调用） */
  isSuppressed(candidate: HintCandidate<TCode>): boolean;
  /**
   * 存活项回调（送达埋点 + 去重窗口标记；**仅存活项**——未送达/被截断的既不埋点
   * 也不占窗口）。窗口标记是否发生由接线层按 status/noDedup/dryRun 决定。
   */
  onEmit(candidate: HintCandidate<TCode>): void;
  /**
   * **未获槽位**的候选回调（可选；缺省 = 静默截尾，行为与阶段一逐字等价）。
   *
   * 只对「没被去重窗口压制、但预算已满」的候选回调——被压制的是 `isSuppressed`
   * 的职责（reason 缺省 null），两者的观测语义不同（窗口压制 vs 槽位挤占）。
   */
  onSlotTruncated?(candidate: HintCandidate<TCode>): void;
  /** 候选 → 文案（单源解析；内核不内置任何文案） */
  resolveMessage(candidate: HintCandidate<TCode>): string;
}

/**
 * hint 编排（**唯一**排序/去重/截尾点，不变量见文件头）。
 *
 * @param candidates 本次请求全部候选（领域侧在族闸门内构造）
 * @param spec 优先级序 / 预算 / 去重判定 / 存活回调 / 槽位截尾回调 / 文案解析
 *   （见 `FinalizeHintsSpec`）
 * @returns 按优先级排序的 ≤`spec.maxHints`（缺省 {@link HINT_MAX_PER_RESPONSE}）条
 *   信封条目；无存活项 → `undefined`（**禁空数组**）
 */
export function finalizeHints<TCode extends string>(
  candidates: HintCandidate<TCode>[],
  spec: FinalizeHintsSpec<TCode>,
): HintEnvelopeItem<TCode>[] | undefined {
  const priorityIndex = new Map<TCode, number>(
    (spec.priority ?? []).map((code, index) => [code, index]),
  );
  const ordered = [...candidates].sort(
    (a, b) =>
      (priorityIndex.get(a.code) ?? Number.MAX_SAFE_INTEGER) -
      (priorityIndex.get(b.code) ?? Number.MAX_SAFE_INTEGER),
  );

  const maxHints = spec.maxHints ?? HINT_MAX_PER_RESPONSE;
  const kept: HintCandidate<TCode>[] = [];
  /**
   * 本响应已处理过的 `(code, resourceKey)`（**同响应同键只取首条**——见文件头不变量）。
   *
   * 为什么必要：`isSuppressed` 是**纯读**（不落窗口），窗口标记发生在循环之后的 `onEmit`
   * ⇒ 同一响应内的同键多候选会**全部送达**（同一件事说三遍）。HTTP 层当前不可达
   * （每个 provider 自己已按资源合并），但这是内核级别的形状不变量，不该依赖调用方自觉。
   */
  const seenKeys = new Set<string>();
  for (const candidate of ordered) {
    const key = `${candidate.code}\u0000${candidate.resourceKey}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    // 预算已满 → 未获槽位：**不查窗口**（窗口是「已送达」的语义），只报槽位截尾。
    // 预算判定刻意排在 isSuppressed **之前**：未获槽位的候选不该被误记成「窗口压制」
    // （两种 reason 的观测语义不同），且未接 onSlotTruncated 的调用方与阶段一逐字等价
    // （阶段一是 break —— 等价于「什么都不做」，只是多了无副作用的空转）。
    if (kept.length >= maxHints) {
      spec.onSlotTruncated?.(candidate);
      continue;
    }
    // normalized 态是每次请求的事实回显 → 不去重、不占窗口
    if (candidate.status !== 'normalized' && spec.isSuppressed(candidate)) continue;
    kept.push(candidate);
  }

  if (kept.length === 0) return undefined;
  // onEmit 对**全部存活项**回调（送达即埋点）；**去重窗口的标记**由接线层按 status 决定
  for (const candidate of kept) spec.onEmit(candidate);
  return kept.map((candidate) => ({
    code: candidate.code,
    status: candidate.status,
    message: candidate.message ?? spec.resolveMessage(candidate),
    ...(candidate.data ? { data: candidate.data } : {}),
  }));
}
