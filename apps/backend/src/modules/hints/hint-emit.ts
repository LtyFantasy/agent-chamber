/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 hint 信封的**接线层**（v1.92.0-dev 2 期抽核，阶段一）：把
 *     `hint-core.finalizeHints`（纯函数：排序/去重过滤/≤3 截尾）与
 *     `HintDedupService`（去重窗口）+ `hint-log`（埋点）接在一起——**全平台唯一一份**，
 *     避免各挂面各写一遍接线（迟早漂移）。
 *
 * [代码职责]
 *   - `emitHints(logger, dedup, candidates, context, options)`：
 *     ① 候选按 `profile.priority` 排序 → ② 去重窗口过滤（窗口长度 =
 *     `profile.ttlOf?.(code)`，缺省 = dedup 的 6h）→ ③ ≤`options.maxHints`（缺省
 *     {@link HINT_MAX_PER_RESPONSE}）截尾 → ④ 对**存活项** `dedup.mark` +
 *     `logHintEmitted`（warn）；被压制项 `logHintSuppressed`（debug，`reason=null`），
 *     **未获槽位项**同样 `logHintSuppressed` 但 `reason=slot_truncated`。
 *   - **三条窗口豁免规则集中在此**（勿散落消费方）：`status==='normalized'`（事实回显）、
 *     `candidate.noDedup===true`（旧搜索三态双写，与不去重的 `hint`/`hintCode` 逐响应
 *     等价）、`options.markWindow===false`（dryRun 预演——不占窗口，避免吞掉紧随其后的
 *     正式请求）。
 *   - **`ttlOf` 缺省 ≠ 豁免去重**（口径订正，2026-10-12）：`HintDefinition.ttlMs` /
 *     `profile.ttlOf` 的缺省只表示「用去重的缺省窗口长度（6h）」，**不是**「该 code 不去重」；
 *     真正的窗口豁免只有本文件 `isWindowExempt` 的两条（`normalized` / `noDedup`）。
 *   - **领域配置一律由 `options.profile` 注入**（优先级序 / 文案单源 / 族归属 / 窗口长度）：
 *     本文件不认识任何一个 code——`hints/` 不得反向 import 领域模块（依赖方向纪律）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」小节
 *   - 补充: 线上 docs/spec.md §4.1a「hints 信封类型」（DocHint 类型契约）
 *
 * [关键不变量]
 *   - **只有存活项被标记**（未送达/被截断的不占用去重窗口）——顺序必须是
 *     「排序 → 过滤 → 截尾 → 标记」，标记发生在最后。
 *   - **豁免项（normalized / noDedup）与 dryRun 预演不标记窗口，但一律落 emitted 行**
 *     ——「送达即观测」与「占窗口」是两件事。
 *   - 空候选 → `undefined`（**禁空数组**：信封不变量）；调用方用 `...(hints ? {hints} : {})`
 *     挂载，绝不产出 `hints: []`。
 *   - 埋点失败/去重异常不得影响业务响应（本函数不抛——纯内存操作）。
 *   - `profile` **必填**：内核不内置优先级与文案，缺省化会静默退化成「候选传入序」。
 *
 * [关联代码]
 *   - modules/hints/hint-core.ts — finalizeHints（排序/过滤/截尾纯函数）
 *   - modules/hints/hint-dedup.service.ts — 去重窗口（isSuppressed / mark）
 *   - modules/hints/hint-log.ts — 埋点（emitted warn / emittedLegacy debug / suppressed debug）
 *   - modules/docspace/doc-hints.helper.ts — `DOC_HINT_PROFILE`（docspace 侧 profile 单源）
 *   - 五个消费方：doc.service / doc-move.service / doc-search.service /
 *     doc-route.service / docspace.service
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { Logger } from '@nestjs/common';
import { finalizeHints, type HintCandidate, type HintEnvelopeItem } from './hint-core';
import type { HintDedupService } from './hint-dedup.service';
import {
  logHintEmitted,
  logHintEmittedLegacy,
  logHintSuppressed,
  HINT_SUPPRESS_REASON,
  type HintSurface,
} from './hint-log';

/** 埋点上下文（面标识 + 空间 + actor；三者都不进响应体，只进日志） */
export interface HintEmitContext {
  /** 产出面（写侧挂点 / 读侧 search / 拦截器 provider 面） */
  surface: HintSurface;
  /** 目标空间 ID（**null = 全局检索面**——跨空间，无单一空间归属） */
  spaceId: string | null;
  /** 触发者 actor ID（未认证写归 'system'） */
  actorId: string;
  /**
   * **逐候选**产出面覆盖（可选；缺省 = 用 `surface`）。
   *
   * 用途 = 多 provider 合并求值（阶段三，决策 6）：一次 `emitHints` 收下多条来自
   * **不同 provider** 的候选时，埋点 `surface` 必须逐候选解析，否则全部记成同一个面。
   * 单 provider 调用方不必传本钩子（行为逐字不变）。
   */
  surfaceOf?(candidate: HintCandidate<string>): string;
  /**
   * **逐候选**空间归属覆盖（可选；缺省 = 用 `spaceId`）。
   *
   * 用途同 `surfaceOf`：合并求值时不同候选可能属于不同空间（如 board 纪律码的
   * spaceId 恒 null，而 docspace 码有空间）。注意**显式返回 `null` 与缺省不同**——
   * 本钩子一旦传入，其返回值（含 null）即最终值。
   */
  spaceIdOf?(candidate: HintCandidate<string>): string | null;
}

/**
 * **领域侧 hint 配置**（内核不认识任何 code 的代价：排序 / 文案 / 族归属由领域注入）。
 *
 * @typeParam TCode code 联合（docspace = `DocHintCode`）
 */
export interface HintEmitProfile<TCode extends string = string> {
  /** code 固定优先级序（排前者先占 ≤3 名额）；缺省 = 保持候选传入序 */
  priority?: readonly TCode[];
  /** 候选 → 文案（单源解析；如 `candidate.message ?? DOC_HINT_MESSAGES[candidate.code]`） */
  resolveMessage(candidate: HintCandidate<TCode>): string;
  /** code → 日志族归属（缺省 = null；只影响埋点 family 字段） */
  familyOf?(code: TCode): string | null;
  /**
   * code → **去重窗口长度覆盖**（ms）。缺省 / 返回 `undefined` ⇒ 走
   * {@link HintDedupService} 的缺省窗口（{@link HINT_DEDUP_TTL_MS} = 6h）。
   *
   * ⚠️ **缺省 ≠ 豁免去重**（曾漂移的一处口径）：窗口豁免只有两条实现路径——候选
   * `status === 'normalized'`（事实回显）与 `candidate.noDedup === true`（旧三态双写），
   * 都在本文件的 `isWindowExempt` 里；`ttlOf` 缺省与「有没有窗口」无关，只是用缺省长度。
   *
   * 单源 = `hint-registry` 的 `HintDefinition.ttlMs`（stage-2 provider 经
   * `HintRegistry.ttlOf` 委托注入；docspace 侧 profile 不挂本钩子 ⇒ 行为逐字不变）。
   */
  ttlOf?(code: TCode): number | undefined;
}

/** `emitHints` 选项 */
export interface HintEmitOptions<TCode extends string = string> {
  /**
   * 是否把存活项标记进去重窗口（默认 `true`）。
   *
   * **dryRun 预演必须传 `false`**：预演不是真实送达——若占窗口，紧随其后的正式
   * 请求会被自己的预演吞掉（先 dryRun 再 move ⇒ 正式响应零 hints，与「预演视图与
   * 实际一致」的承诺直接矛盾）。抑制判定照常（若近期真的送达过，预演也应被压制）。
   */
  markWindow?: boolean;
  /**
   * 本次响应的显式预算（≤N 的 N）；缺省 = {@link HINT_MAX_PER_RESPONSE}。
   *
   * 唯一用途 = ⑦ merge 槽位预算（阶段三，决策 5）：域侧已挂 k 条 hints 时传 `3 − k`。
   * **`0` 合法**（仍完成求值与「槽位截尾」观测，只是不产任何 provider 候选）。
   */
  maxHints?: number;
  /** 领域侧 hint 配置（**必填**，见 `HintEmitProfile`） */
  profile: HintEmitProfile<TCode>;
}

/**
 * 候选 → 信封（唯一接线实现，见文件头不变量）。
 *
 * 去重窗口的三条豁免规则（集中在此，勿散落消费方）：
 * - `status === 'normalized'`：事实回显，每次请求都发；
 * - `candidate.noDedup === true`：**旧搜索三态双写**（与不去重的 `hint`/`hintCode`
 *   旧字段逐响应等价，迁移期硬约束）；
 * - `markWindow === false`：dryRun 预演——照常组装+埋点，但不占窗口。
 *
 * @param logger 调用方的 Nest Logger（落行归属该 service 的日志源）
 * @param dedup 去重窗口（Nest provider 单例，跨 service 共享同一份窗口）
 * @param candidates 本次请求全部候选（族闸门内构造）
 * @param context 埋点上下文
 * @param options 窗口标记策略 + 领域 profile（见 `HintEmitOptions`）
 * @returns ≤3 条信封条目（与 shared `DocHint` 逐字段同构）；无存活候选 → `undefined`
 *   （**禁空数组**）
 */
export function emitHints<TCode extends string>(
  logger: Logger,
  dedup: HintDedupService,
  candidates: HintCandidate<TCode>[],
  context: HintEmitContext,
  options: HintEmitOptions<TCode>,
): HintEnvelopeItem<TCode>[] | undefined {
  if (candidates.length === 0) return undefined;
  const markWindow = options.markWindow !== false;
  const profile = options.profile;
  /** 窗口豁免（不压制、不标记）：事实回显 + 旧三态双写 */
  const isWindowExempt = (candidate: HintCandidate<TCode>): boolean =>
    candidate.status === 'normalized' || candidate.noDedup === true;
  /** 逐候选产出面（多 provider 合并求值时按候选解析；缺省 = 单一 surface） */
  const surfaceOf = (candidate: HintCandidate<TCode>): string =>
    context.surfaceOf ? context.surfaceOf(candidate) : context.surface;
  /** 逐候选空间归属（同上；**钩子返回 null 即取 null**，不回落到 context.spaceId） */
  const spaceIdOf = (candidate: HintCandidate<TCode>): string | null =>
    context.spaceIdOf ? context.spaceIdOf(candidate) : context.spaceId;

  return finalizeHints(candidates, {
    priority: profile.priority,
    // 显式预算透传（缺省 undefined ⇒ 内核落 HINT_MAX_PER_RESPONSE）；0 是合法预算
    maxHints: options.maxHints,
    isSuppressed: (candidate) => {
      if (isWindowExempt(candidate)) return false;
      // 窗口长度覆盖：`profile.ttlOf` 缺省 / 返回 undefined ⇒ 传 undefined ⇒ dedup 落缺省 6h
      // （与阶段一逐字等价；缺省**不是**豁免，见 HintEmitProfile.ttlOf 注释）
      const suppressed = dedup.isSuppressed(
        context.actorId,
        candidate.code,
        candidate.resourceKey,
        profile.ttlOf?.(candidate.code),
      );
      if (suppressed) {
        logHintSuppressed(logger, {
          code: candidate.code,
          status: candidate.status,
          family: profile.familyOf?.(candidate.code) ?? null,
          surface: surfaceOf(candidate),
          spaceId: spaceIdOf(candidate),
          actorId: context.actorId,
          resourceKey: candidate.resourceKey,
          // reason 缺省 null = 窗口压制（§5 反事实对照组只认这一档）
        });
      }
      return suppressed;
    },
    onEmit: (candidate) => {
      // 豁免项（normalized / 旧三态）与 dryRun 预演都不占窗口，但同样埋点（送达即观测）
      if (markWindow && !isWindowExempt(candidate)) {
        // 窗口长度覆盖与 isSuppressed 同源同值（缺省 ⇒ undefined ⇒ dedup 的 6h）
        dedup.mark(
          context.actorId,
          candidate.code,
          candidate.resourceKey,
          profile.ttlOf?.(candidate.code),
        );
      }
      const logInput = {
        code: candidate.code,
        status: candidate.status,
        family: profile.familyOf?.(candidate.code) ?? null,
        surface: surfaceOf(candidate),
        spaceId: spaceIdOf(candidate),
        actorId: context.actorId,
        resourceKey: candidate.resourceKey,
      };
      // 级别按**量级**分家（N1）：旧三态豁免窗口 ⇒ 每次都送达（weak_hit 常态触发、
      // zero_hit 与 logSearchZeroHit 同一触发、positional_order 高频）⇒ debug，
      // 否则 warn 会淹没有效信号（zero-hit-log 对弱命中同款处置）。
      // normalized 是写侧动作回显，低频且是修正率正面信号 ⇒ 保持 warn。
      if (candidate.noDedup === true) {
        logHintEmittedLegacy(logger, logInput);
      } else {
        logHintEmitted(logger, logInput);
      }
    },
    // 未获槽位（预算已满但窗口判定已通过）⇒ 埋点 reason=slot_truncated。
    // 「域侧挤占」与「候选过多」都收敛到这一条 debug 行——不占窗口、不改响应。
    onSlotTruncated: (candidate) => {
      logHintSuppressed(logger, {
        code: candidate.code,
        status: candidate.status,
        family: profile.familyOf?.(candidate.code) ?? null,
        surface: surfaceOf(candidate),
        spaceId: spaceIdOf(candidate),
        actorId: context.actorId,
        resourceKey: candidate.resourceKey,
        reason: HINT_SUPPRESS_REASON.slotTruncated,
      });
    },
    resolveMessage: (candidate) => profile.resolveMessage(candidate),
  });
}
