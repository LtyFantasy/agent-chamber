/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别内核的**三级成本总闸**（跨能力共用）：全局 → 能力子额度 → actor，
 *     外加 skip 占位行的"写入有界"记账
 *
 * [代码职责]
 *   - `consume`：三级窗口消费（顺序有语义：先严后宽；共享桶只计放行 / actor 桶连被拒一起计）
 *   - `allowSkipRow` / `releaseSkipRow`：skip 占位行的有界写（键 = `槽位:能力:actorKey`
 *     + 事务失败时的配额**交还**）
 *   - `judgmentSkipRowBound`：行有界上界（**派生式** `(级别数 + 1) × 能力数`）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（三级闸与取值）
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（配额三窗口上移内核 +
 *     skip 五态 taxonomy + 派生上界，arch M4）
 *   - 补充: `.env.example` 判别块（三个额度键的语义与"软闸非账单承诺"）
 *
 * [关键不变量]
 *   - **执行序 = 全局 → 能力 → actor（先严后宽）**：任一级超限即**不再**消耗更内侧的额度
 *     ——全局超限不吃 actor/能力（实例已经满了，继续吃用户侧额度无意义）；能力超限不吃 actor。
 *   - **共享桶只计放行**（global / capability 传 `countRejected: false`，终审 F1）：被拒尝试
 *     不入账 ⇒ 桶内条目恒 ≤ limit、随窗口自然排空，**单 actor 无法靠连续刷把共享额度永久
 *     钉满**（旧语义下"刷停"会把桶一直顶住，让所有人生生等满整个窗口才恢复）。
 *     **actor 桶相反**（`true`）：单人桶，被拒尝试照旧入账 = 不许当免费通道。
 *   - **skip 行写入有界**：键 = `(槽位, 能力, actorKey)`，每组合每窗口至多一条；上界 =
 *     **派生式** `(级别数 + 1) × 能力数`（`级别数` 取 `JUDGMENT_LIMIT_LEVELS` 值域长度）。
 *     那 `+1` = **非额度闸共用槽**（出境闸 / 可见性闸）——它们是"闸"，但没有对应的三级额度
 *     计数器，故共用一个额外槽位；同一能力同一 actor 在同一窗口内先撞哪个就记哪个
 *     （第二个只 warn）。**禁止把上界写成手写常量**：能力数或级别数一变，手写值立刻失真
 *     且没人会想起来改。
 *   - **三级都是进程内内存软闸**：每实例每滑动小时、**重启清零**、多副本上界 ×N
 *     （无共享存储）。挡的是异常风暴（脚本 bug / 重放 / 单 actor 刷量），不是精确计费。
 *   - **无 actor 的调用走兜底桶** `system:unknown`（由调用点经 `judgmentActorKey` 生成），
 *     不静默不限流。
 *
 * [关联代码]
 *   - judgment-payload.ts — `judgmentActorKey`（桶键单源）
 *   - judgment-runner.service.ts — 通用调用点（闸门 → 调用 → 独立日志行）
 *   - modules/experience/experience-judgment.service.ts — 经验库调用点（事务内日志行 + 快照）
 *   - shared enums — `EXPERIENCE_JUDGMENT_SKIPPED_REASONS`（落库 reason 值域单源）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增闸级别 / 新能力 → 上界自动跟着变（派生式）；**不要**引入手写上界常量
 *   □ 改"被拒尝试是否入账"前先想清楚"共享桶被单 actor 钉满"的饿死场景
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  EXPERIENCE_JUDGMENT_SKIPPED_REASON,
  type ExperienceJudgmentSkippedReason,
} from '@agent-chamber/shared';
import { EXPERIENCE_JUDGMENT_RATE_WINDOW_MS } from '../experience/experience.constants';
import { JUDGMENT_CONFIG } from './judgment-provider.factory';
import type { JudgmentConfig } from '../../config/judgment.config';

/**
 * 撞上的成本闸级别（三级）。
 *
 * 与 `EXPERIENCE_JUDGMENT_SKIPPED_REASON` **刻意分开**：level 是**内部诊断维度**（告警文案 +
 * skip 行的写入有界键），reason 是**落库契约值**（shared 枚举，下游按它分组统计"跳过分布"）。
 * 两者一一对应但生命周期不同——将来加闸级别时 reason 值域要动（契约），level 只是内部词。
 */
export type JudgmentLimitLevel = 'global' | 'capability' | 'actor';

/**
 * 三级闸的值域（**上界派生式的唯一输入**，见文件头不变量）。
 *
 * 顺序 = 消费顺序（全局 → 能力 → actor）：`consume` 按它遍历，消费序与数组序同源。
 */
export const JUDGMENT_LIMIT_LEVELS: readonly JudgmentLimitLevel[] = [
  'global',
  'capability',
  'actor',
];

/**
 * **非额度闸共用槽**（skip 行写入有界的第 4 个槽位）。
 *
 * 出境闸（`egress_blocked`）与可见性闸（`visibility_blocked`）都是"跳过"，但没有对应的三级
 * 额度计数器 ⇒ 共用一个额外槽位（见文件头不变量）。
 */
export const NON_QUOTA_SKIP_SLOT = 'gate';

/** skip 行写入有界的槽位值域 = 三级额度 + 1 个非额度共用槽（顺序有语义） */
export const JUDGMENT_SKIP_SLOTS: readonly string[] = [
  ...JUDGMENT_LIMIT_LEVELS,
  NON_QUOTA_SKIP_SLOT,
];

/**
 * skip 占位行的**每 actor 每窗口**有界上界：`(级别数 + 1) × 能力数`（派生式）。
 *
 * @param capabilityCount 已注册能力数（单源 = `JUDGMENT_CAPABILITY_REGISTRY.length`）
 * @returns 上界行数（同一 actor 在同一窗口内、覆盖全部能力与全部跳过原因的最坏行数）
 */
export function judgmentSkipRowBound(capabilityCount: number): number {
  return (JUDGMENT_LIMIT_LEVELS.length + 1) * capabilityCount;
}

/** `consume` 的返回：null = 三级全放行；否则给出撞上的级别与落库 reason */
export interface JudgmentQuotaBlock {
  level: JudgmentLimitLevel;
  reason: ExperienceJudgmentSkippedReason;
}

/** 全局总闸桶键（全局只有一个桶；用 Map 是为了与 `consumeWindowedQuota` 同形状） */
const GLOBAL_QUOTA_KEY = 'global';

/**
 * 三级成本总闸 + skip 行有界记账（进程内内存；跨能力**共享同一个实例**）。
 *
 * 共享实例是语义要求而非实现便利：全局桶必须跨能力可见（"实例级出境量上限"），
 * 若每个调用点各持一份，全局闸就退化成"每调用点各一份"，闸值被静默放大。
 */
@Injectable()
export class JudgmentQuotaService {
  /**
   * **actor 级**限流窗口：`能力:actorKey` → 事件时刻（epoch ms）数组。
   *
   * 能力维度进桶键：额度键是 `(level, capability, actorKey)`（plan 批次 2），
   * 否则"重排刷满额度"会连带把经验库录入判定饿死。
   */
  private readonly actorQuota = new Map<string, number[]>();

  /** **全局总闸**窗口（单桶；每实例每滑动小时的判别总数，跨 actor 跨能力） */
  private readonly globalQuota = new Map<string, number[]>();

  /** **能力子额度**窗口：能力名 → 事件时刻数组（隔离位：单一能力吃不满全局预算） */
  private readonly capabilityQuota = new Map<string, number[]>();

  /**
   * "上次为某**槽位 + 能力 + actor** 写 skip 占位行"的时刻（epoch ms；行写入有界的依据）。
   */
  private readonly skipRowAt = new Map<string, number>();

  constructor(@Inject(JUDGMENT_CONFIG) private readonly config: JudgmentConfig) {}

  /**
   * 三级成本闸消费（**顺序有语义：全局 → 能力 → actor，先严后宽**）。
   *
   * @param capability 能力名（能力子额度桶键 + actor 桶键的能力维度）
   * @param actorKey `${type}:${id}`（无 actor 时为兜底桶 `system:unknown`）
   * @returns null = 三级全放行；否则给出撞上的**级别 + 落库 reason**（调用点据此写 skip 行）
   */
  consume(capability: string, actorKey: string): JudgmentQuotaBlock | null {
    if (
      !this.consumeWindowedQuota(
        this.globalQuota,
        GLOBAL_QUOTA_KEY,
        this.config.globalRateLimitPerHour,
        false,
      )
    ) {
      return {
        level: 'global',
        reason: EXPERIENCE_JUDGMENT_SKIPPED_REASON.GLOBAL_RATE_LIMITED,
      };
    }
    if (
      !this.consumeWindowedQuota(
        this.capabilityQuota,
        capability,
        this.config.capabilityRateLimitPerHour,
        false,
      )
    ) {
      return {
        level: 'capability',
        reason: EXPERIENCE_JUDGMENT_SKIPPED_REASON.CAPABILITY_RATE_LIMITED,
      };
    }
    if (
      !this.consumeWindowedQuota(
        this.actorQuota,
        actorBucketKey(capability, actorKey),
        this.config.rateLimitPerHour,
        true,
      )
    ) {
      return {
        level: 'actor',
        reason: EXPERIENCE_JUDGMENT_SKIPPED_REASON.ACTOR_RATE_LIMITED,
      };
    }
    return null;
  }

  /**
   * 本窗口是否还允许写 skip 占位行（**每"槽位 + 能力 + actor"组合每窗口一条**）。
   *
   * 键含槽位：三级闸与非额度闸各留一条凭证 ⇒ 每窗口每 actor 至多 `(级别数+1) × 能力数` 条
   * （派生上界见 `judgmentSkipRowBound`）。退回"只按 actor"的键会让"撞全局闸"与"撞 actor 闸"
   * 互相挤掉对方的行，跳过分布统计随之失真。
   *
   * @param slot 槽位（三级级别 / `NON_QUOTA_SKIP_SLOT`）
   * @param capability 能力名
   * @param actorKey 额度桶键（含 null actor 的兜底桶）
   * @returns true = 允许写这一行
   */
  allowSkipRow(slot: string, capability: string, actorKey: string): boolean {
    const key = skipRowKey(slot, capability, actorKey);
    const now = Date.now();
    const last = this.skipRowAt.get(key);
    if (last !== undefined && now - last < EXPERIENCE_JUDGMENT_RATE_WINDOW_MS) return false;
    this.skipRowAt.set(key, now);
    return true;
  }

  /**
   * **交还**某组合的 skip 行配额（"先记账后写库"的补偿）。
   *
   * 不交还的后果：一次瞬时故障（连接池抖动）会让本窗口再也写不出该组合的记账凭证
   * ——跳过本身照旧拒绝，但"跳过原因"失去凭证（终审 F6）。
   */
  releaseSkipRow(slot: string, capability: string, actorKey: string): void {
    this.skipRowAt.delete(skipRowKey(slot, capability, actorKey));
  }

  /**
   * 窗口计数消费（滑动窗口）。
   *
   * 三个闸共用同一实现（actor / 全局 / 能力），差别在桶、上限与**被拒尝试是否入账**——一处实现，
   * 避免"某个闸忘了记账"这类静默（限额失守最典型的成因）。
   *
   * @param store 窗口存储（三个桶各一份）
   * @param key 桶键（能力名 / `GLOBAL_QUOTA_KEY` / 能力+actor 复合键）
   * @param limit 该窗口每小时上限（来自 config 的对应键）
   * @param countRejected 被拒尝试是否也入账。**共享桶（全局 / 能力）传 `false`**；**actor 桶传
   *   `true`**（不许当免费通道）——见文件头不变量。
   * @returns true = 允许本次调用；false = 已超限（调用点写 skip 行）
   */
  private consumeWindowedQuota(
    store: Map<string, number[]>,
    key: string,
    limit: number,
    countRejected: boolean,
  ): boolean {
    const now = Date.now();
    const hits = (store.get(key) ?? []).filter((t) => now - t < EXPERIENCE_JUDGMENT_RATE_WINDOW_MS);
    const allowed = hits.length < limit;
    // 共享桶只记放行 ⇒ 数组长度恒 ≤ limit；actor 桶连被拒尝试一起记（不许当免费通道）。
    if (allowed || countRejected) hits.push(now);
    store.set(key, hits);
    return allowed;
  }
}

/**
 * actor 额度桶键 = **能力 + actor**（额度键 `(level, capability, actorKey)` 的 actor 维实现）。
 *
 * @param capability 能力名
 * @param actorKey `type:id`（或兜底桶）
 */
function actorBucketKey(capability: string, actorKey: string): string {
  return `${capability}:${actorKey}`;
}

/**
 * skip 行的"写入有界"键 = **槽位 + 能力 + actor** 复合键。
 *
 * 单源在此：`allowSkipRow` 用它记账、`releaseSkipRow` 用它交还配额——两处各拼一次字符串，
 * 会在改动键形时出现"删错键 ⇒ 该组合白吃一次配额"的静默。
 */
function skipRowKey(slot: string, capability: string, actorKey: string): string {
  return `${slot}:${capability}:${actorKey}`;
}
