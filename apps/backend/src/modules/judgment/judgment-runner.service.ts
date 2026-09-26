/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别内核的**通用编排器**：为非事务型调用点（搜索重排等）提供"闸门 → 调用 → 独立日志行"
 *     的一条龙，把 fail-open 与落库纪律收在一处
 *
 * [代码职责]
 *   - `run(capability, input, actor)`：能力启用判定 → 三级配额 → 出境闸 → provider 调用 →
 *     日志行（redaction + 体积硬顶）
 *   - `recordSkip(capability, actor, reason)`：**外部闸门**（如可见性闸）命中时落标量 skip 行
 *   - `isEnabled(capabilityName)`：调用点据此**在构造输入之前**决定要不要走判别路径
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（三级闸 / skip taxonomy /
 *     两个分母口径：失败率排除 skipped、fail-open 率含 skipped 全 reason）
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（内核抽取）/§批次 3（rerank 落行）
 *
 * [关键不变量]
 *   - **skip 五态 taxonomy**（plan 批次 2；值域单源 = shared `EXPERIENCE_JUDGMENT_SKIPPED_REASONS`）：
 *     ① provider=none / 能力未启用 → **短路无行**（`status: 'disabled'`，不调用不写日志不占额度）；
 *     ② 出境闸命中 → `egress_blocked`（**不落输入原文**，只落 reason；**闸在配额之前**——
 *        从未打算出境的请求不吃共享桶，见 `run()` 内注释与终审 MAJOR-5）；
 *     ③ 三级额度超限 → 标量行（`global_rate_limit` / `capability_rate_limit` /
 *        `judgment_rate_limited`，由配额服务给出 level + reason）；
 *     ④ 可见性闸命中 → `visibility_blocked`（由**调用点**检测后 `recordSkip`，**不带
 *        candidateDocIds**——防反向泄露"某私有空间有这些文档"）。
 *     ③④ 共用非额度 skip 槽（行写入有界，见 `judgment-quota.service.ts`）。
 *   - **本服务不认识"经验库"**：`experienceId` 恒 null（本表 `experience_id` 可空——通用日志行
 *     没有条目归属）、不写快照、不做版本守卫。经验库的"事务内日志 + 快照"由它自己的 service
 *     实现（`evaluateAndPersist`），**不复用本服务**——通用形状没有 entryId，硬套会让快照
 *     不变量（日志与快照同事务）分家。
 *   - **fail-open 是全局兜底**：本事任何未预期异常（连接池耗尽 / 编码错误）都只 warn 一行
 *     并返回结果对象，绝不冒泡到搜索主流程；warn **只带异常类名与可选错误码，不带 message**。
 *   - **日志载荷必须过 redaction + 体积硬顶**，且**先记账后写库**失败时**交还** skip 配额
 *     （否则一次瞬时故障会让本窗口再也写不出该组合的记账凭证，终审 F6 同源）。
 *   - **`logRedacted` 是本路径的标记名**（经验库走 `stateRedacted`，两者同一含义不同键名，
 *     见 `judgment-payload.ts` 文件头不变量）。
 *
 * [关联代码]
 *   - judgment-quota.service.ts — 三级配额与 skip 行有界记账
 *   - judgment-payload.ts — redaction 基线 / 体积硬顶 / 桶键 / 异常标签
 *   - judgment-capability.interface.ts — provider 与结果契约
 *   - modules/experience/experience-judgment.service.ts — 经验库路径（自带事务，不走本服务）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 skip 原因 → 同步 shared 枚举（尾部追加）与两处文档的 taxonomy 表
 *   □ 改落库形状 → 复核"日志是事实"与"行写入有界"两条不变量
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  EXPERIENCE_JUDGMENT_SKIPPED_REASON,
  EXPERIENCE_JUDGMENT_STATUS,
  type ExperienceJudgmentOperation,
  type ExperienceJudgmentSkippedReason,
  type ExperienceJudgmentStatus,
} from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import type { JudgmentConfig } from '../../config/judgment.config';
import { isJudgmentCapabilityEnabled } from '../../config/judgment.config';
import {
  JUDGMENT_PROVIDER,
  type JudgmentCapability,
  type JudgmentMeta,
  type JudgmentProvider,
} from './judgment-capability.interface';
import { JUDGMENT_CONFIG } from './judgment-provider.factory';
import {
  NON_QUOTA_SKIP_SLOT,
  JudgmentQuotaService,
  type JudgmentLimitLevel,
} from './judgment-quota.service';
import {
  capJsonbPayload,
  judgmentActorKey,
  redactJudgmentPayload,
  safeErrorTag,
} from './judgment-payload';

/**
 * 通用判别的结果（调用点据此决定 fail-open / 用模型序）。
 *
 * `disabled` 与 `skipped` **必须分开**：前者是"这个能力根本没开"（无日志行、无额度消耗），
 * 后者是"开了但本次没跑成"（有标量行、计额度）——指标口径（激活率 / fail-open 率）全靠它区分。
 */
export type JudgmentRunResult<O> =
  | { status: 'ok'; value: O; meta: JudgmentMeta }
  | { status: 'error' | 'timeout' }
  | { status: 'skipped'; reason: ExperienceJudgmentSkippedReason }
  | { status: 'disabled' };

/**
 * 通用判别编排（非事务型调用点）。
 *
 * 与经验库路径的分工见文件头不变量：本服务只做"闸门 + 调用 + 独立日志行"，
 * 不碰任何业务快照。
 */
@Injectable()
export class JudgmentRunnerService {
  private readonly logger = new Logger(JudgmentRunnerService.name);

  /**
   * 日志行写失败次数（进程内计数，终审 NIT-4）。
   *
   * 为什么需要它：日志行写失败不能吞掉一次成功的判别（否则"模型产物被丢掉"却只剩一行 warn），
   * 也不能完全静默（否则语料缺失无人知道）。故统一走 `tryWriteLogRow`：**catch + warn + 计数**，
   * 判定结果照常返回。
   *
   * ⚠️ **当前消费方只有 spec**（单元测试断言计数）——**健康检查 / 指标端点暴露是后续项**，
   * 本类不提供任何巡检接线（复审 NEW-5：删除"供指标/健康检查读取"的超前表述）。
   */
  private logWriteFailures = 0;

  /** 日志行写失败累计次数（**当前仅 spec 消费**；对外暴露为后续项） */
  get logWriteFailureCount(): number {
    return this.logWriteFailures;
  }

  constructor(
    private readonly quota: JudgmentQuotaService,
    @Inject(JUDGMENT_PROVIDER) private readonly provider: JudgmentProvider,
    @Inject(JUDGMENT_CONFIG) private readonly config: JudgmentConfig,
    @InjectRepository(ExperienceJudgmentRecord)
    private readonly logRepo: Repository<ExperienceJudgmentRecord>,
  ) {}

  /**
   * 能力当前是否可用（**同步、零副作用**：调用点在构造 payload / 查库之前先问它）。
   *
   * @param capabilityName 能力名
   * @returns true = provider 已启用 **且** 该能力被配置允许
   */
  isEnabled(capabilityName: string): boolean {
    return this.provider.enabled && isJudgmentCapabilityEnabled(this.config, capabilityName);
  }

  /**
   * 执行一次通用判别（**永不抛错**，见文件头 fail-open 不变量）。
   *
   * @param capability 能力
   * @param input 能力输入
   * @param actor 当前统一身份（额度归属 + 日志 actor 列；null 走兜底桶）
   * @returns ok（模型产物）/ error、timeout（调用失败）/ skipped（被闸住）/ disabled（未启用）
   */
  async run<I, O>(
    capability: JudgmentCapability<I, O>,
    input: I,
    actor: UnifiedActor | null,
  ): Promise<JudgmentRunResult<O>> {
    try {
      // ① 未启用（provider=none 或能力不在白名单）→ 短路：不调用、不写日志、不占额度
      if (!this.isEnabled(capability.name)) return { status: 'disabled' };

      const actorKey = judgmentActorKey(actor);

      // ② 出境闸（必填契约；命中不落输入原文）——**必须排在配额之前**（终审 MAJOR-5）：
      //    它是纯函数（无副作用、无成本），被它拒绝的请求**从未打算出境** ⇒ 不该吃共享桶。
      //    旧顺序（配额 → 出境）下，agent 连发含密钥形态的 query 就能零成本把全局 240/h 打满，
      //    把 record_check（不可再生语料）饿死整个窗口——违反 `judgment-quota.service.ts` 的
      //    "单 actor 无法靠连续刷把共享额度永久钉满"不变量。
      if (!capability.egressAllow(input)) {
        const reason = EXPERIENCE_JUDGMENT_SKIPPED_REASON.EGRESS_BLOCKED;
        await this.persistSkipRow(capability.name, actor, actorKey, reason, NON_QUOTA_SKIP_SLOT);
        return { status: 'skipped', reason };
      }

      // ③ 三级成本闸（全局 → 能力 → actor，先严后宽）——只对"真的要出境"的请求记账
      const blocked = this.quota.consume(capability.name, actorKey);
      if (blocked) {
        await this.persistSkipRow(capability.name, actor, actorKey, blocked.reason, blocked.level);
        return { status: 'skipped', reason: blocked.reason };
      }

      // ④ 调用（provider 契约永不 throw；此处 catch 是纵深防御，防实现漂移把主流程带崩）
      const outcome = await this.provider.run(capability, input);

      // ⑤ 日志行：先 redaction、再体积硬顶（标记名 = 本路径的 logRedacted）
      const redactedPayload = redactJudgmentPayload(
        capability.toLogPayload(input, outcome),
        capability.redactionPatterns,
      );
      const request = capJsonbPayload(
        redactedPayload.redacted
          ? { ...redactedPayload.payload, logRedacted: true }
          : redactedPayload.payload,
      );
      // 日志行写失败**不得吞掉这次成功判定**（NIT-4）：非抛出写 + 计数，判定结果照常返回
      await this.tryWriteLogRow({
        operation: capability.name,
        status: outcome.status,
        actor,
        model: outcome.status === 'ok' ? outcome.meta.model : null,
        request,
        response: capJsonbPayload(outcome.response),
        latencyMs: outcome.latencyMs,
      });

      return outcome.status === 'ok'
        ? { status: 'ok', value: outcome.value, meta: outcome.meta }
        : { status: outcome.status };
    } catch (err: unknown) {
      // fail-open：判别链上任何未预期异常都只 warn 一行（不带 message，见文件头不变量）
      this.logger.warn(
        `judgment run failed (fail-open, capability ${capability.name}): ${safeErrorTag(err)}`,
      );
      return { status: 'error' };
    }
  }

  /**
   * 外部闸门命中时落标量 skip 行（当前唯一使用方 = 搜索重排的**可见性闸**）。
   *
   * 语义与内部闸一致：**不调用 provider**、写一行 `{skipped:true, reason}`、计入 fail-open 率
   * 分母（行写入有界：每 `(槽, 能力, actor)` 每窗口至多一条）。
   *
   * @param capabilityName 能力名
   * @param actor 当前统一身份
   * @param reason 落库 reason（值域单源 = shared 枚举）
   * @returns true = 已写入（或短路）；false = 写入失败（已 warn，调用点无需处理）
   */
  async recordSkip(
    capabilityName: ExperienceJudgmentOperation,
    actor: UnifiedActor | null,
    reason: ExperienceJudgmentSkippedReason,
  ): Promise<boolean> {
    try {
      // 未启用 ⇒ 与 run 的短路一致：不落行（否则"没开的能力"会莫名其妙出现在日志里）
      if (!this.isEnabled(capabilityName)) return false;
      await this.persistSkipRow(
        capabilityName,
        actor,
        judgmentActorKey(actor),
        reason,
        NON_QUOTA_SKIP_SLOT,
      );
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `failed to persist skipped judgment state (capability ${capabilityName}): ${safeErrorTag(err)}`,
      );
      return false;
    }
  }

  /**
   * 写 skip 占位行（**行写入有界**：每 `(槽, 能力, actor)` 每窗口至多一条）。
   *
   * `request` 写占位对象而非 null：该列 NOT NULL，skip 不能破这条不变量（否则插入撞 23502，
   * 把主流程连带打成 500）。`response` 恒 null（本次无结论）；`latencyMs` null（未调用）。
   */
  private async persistSkipRow(
    capabilityName: ExperienceJudgmentOperation,
    actor: UnifiedActor | null,
    actorKey: string,
    reason: ExperienceJudgmentSkippedReason,
    slot: JudgmentLimitLevel | typeof NON_QUOTA_SKIP_SLOT,
  ): Promise<void> {
    if (!this.quota.allowSkipRow(slot, capabilityName, actorKey)) {
      // 本组合本窗口已经记过一行：只留 warn（不落行——行写入有界）
      this.logger.warn(
        `judgment ${slot} gate skipped for ${actorKey} (capability=${capabilityName}, ` +
          `reason=${reason}); skipped row already recorded in this window (not writing another row)`,
      );
      return;
    }
    try {
      await this.writeLogRow({
        operation: capabilityName,
        status: EXPERIENCE_JUDGMENT_STATUS.SKIPPED,
        actor,
        model: null,
        request: { skipped: true, reason },
        response: null,
        latencyMs: null,
      });
    } catch (err: unknown) {
      // "先记后写"的补偿：事务/写失败 ⇒ 交还本组合的这一条配额（否则一次瞬时故障会让本窗口
      // 再也写不出记账凭证——跳过本身照旧拒绝，但"跳过原因"失去凭证）
      this.logQuotaFailures();
      this.quota.releaseSkipRow(slot, capabilityName, actorKey);
      this.logger.warn(`failed to persist skipped judgment state: ${safeErrorTag(err)}`);
    }
  }

  /** skip 行写失败的计数（与主日志行共用同一"语料在丢"口径；见 `logWriteFailureCount`） */
  private logQuotaFailures(): void {
    this.logWriteFailures += 1;
  }

  /**
   * 非抛出写日志行（**NIT-4**）：失败只 warn + 计数，不冒泡——判别结果优先于语料完整性
   * （判别是主流程的增强；语料缺失是观测损失，不该把主流程的产物一起丢掉）。
   *
   * @returns true = 写入成功
   */
  private async tryWriteLogRow(
    row: Parameters<JudgmentRunnerService['writeLogRow']>[0],
  ): Promise<boolean> {
    try {
      await this.writeLogRow(row);
      return true;
    } catch (err: unknown) {
      this.logWriteFailures += 1;
      this.logger.warn(
        `failed to write judgment log row (operation=${row.operation}, attempts lost=` +
          `${this.logWriteFailures}): ${safeErrorTag(err)}`,
      );
      return false;
    }
  }

  /** 落一行判别日志（**append-only 事实源**；通用行的 `experienceId` 恒 null） */
  private async writeLogRow(row: {
    operation: ExperienceJudgmentOperation;
    status: ExperienceJudgmentStatus;
    actor: UnifiedActor | null;
    model: string | null;
    request: Record<string, unknown>;
    response: Record<string, unknown> | null;
    latencyMs: number | null;
  }): Promise<void> {
    // save()（而非 insert()）：jsonb 载荷走 `_QueryDeepPartialEntity` 的 insert 类型在
    // `Record<string, unknown>` 下不可赋值（照 idempotency.helper 的 jsonb 先例用 save）。
    await this.logRepo.save({
      experienceId: null,
      operation: row.operation,
      provider: this.provider.name,
      model: row.model,
      status: row.status,
      actorType: row.actor?.type ?? null,
      actorId: row.actor?.id ?? null,
      request: row.request,
      response: row.response,
      latencyMs: row.latencyMs,
    });
  }
}
