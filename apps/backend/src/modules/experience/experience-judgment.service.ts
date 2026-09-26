/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别服务的**接线与落库**：录入/内容改写后的判定调用、判断日志、
 *     条目快照写入、判断日志查询端点
 *
 * [代码职责]
 *   - `evaluateAndPersist`：**三级成本闸**（全局 → 能力 → actor，实现在内核
 *     `JudgmentQuotaService`）→ provider 调用 → 体积/redaction 纪律 → **单事务**
 *     {INSERT 判断日志行；版本守卫 UPDATE 条目快照}
 *   - `listJudgments`：`GET /experiences/judgments` 的判权 + 过滤 + 全序分页
 *   - 日志载荷纪律：正文节选、16KB 硬顶、密钥 redaction、错误文案不夹上游错误体
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §0（威胁模型：日志 = 正文第二副本）/
 *     §3.5（调用点与写入纪律，四家复核共振项）/§4（消费面：导出姿势、翻案率配对）
 *   - 补充: 线上 DocSpace `docs/experience-base.md` — 判断日志/训练语料章
 *
 * [关键不变量]（改动前逐条想清楚在防什么）
 *   - **日志是事实、快照是缓存**：每次判定（含失败与限流跳过）都写日志行；条目上的
 *     `judgment` 列只描述"最近一次成功判定"，失败时必须**置 NULL**（旧快照描述旧内容）。
 *     "未判 vs 判失败"的区分只能查日志表的 status。
 *   - **快照写入 = 裸 SQL 定向 UPDATE**：只 SET `judgment`，**永不触碰 `updated_at`**
 *     （它是乐观锁 token，后台判定不得改它），且带**版本守卫** `WHERE id=$1 AND updated_at=$2`
 *     （$2 = 本次写事务的 updatedAt）——判定在途期间条目被再改 ⇒ `rowCount=0` ⇒
 *     **丢弃快照只留日志**（响应也报 null，与库内保持一致）。
 *   - **日志行 + 快照写同一事务**：拆开会出现"快照写了日志没写"（语料永久丢，database
 *     评审 B1 的原话）。日志表是 append-only 事实源，绝不允许与快照分家。
 *     ⚠️ 这正是不复用内核 `JudgmentRunnerService` 的原因（通用形状无 entryId、无快照），
 *     本 service 只复用内核的**闸门实现**（配额）与**纯函数**（redaction / 体积 / 计数）。
 *   - **限流 skipped 与 error/timeout 语义同构**（P2-1 裁决：本次"无结论"）：`request` 写占位
 *     `{skipped:true, reason}`、`response` 为 null、**update 模式同样清快照**（旧快照描述编辑前
 *     内容）；`provider=none` 则是**短路**（不调用、不写日志、不占额度）——两种状态必须区分。
 *   - **三级成本闸（v1.85.0 批 1；批 2 上移内核）**：执行序 = `provider.enabled` → **全局总闸 →
 *     能力子额度 → actor 额度** → provider 调用（先严后宽：任一级超限即**不再**消耗更内侧的额度）。
 *     实现在内核 `JudgmentQuotaService`（跨能力共享单例——全局桶必须跨能力可见）：
 *     共享桶只计放行、actor 桶连被拒一起计，语义细节见该文件文件头。
 *     任一级超限 = **skipped 语义同构**，`reason` 标明撞的是哪一级（值域单源 = shared
 *     `EXPERIENCE_JUDGMENT_SKIPPED_REASONS`）。
 *   - **skipped 行写入有界**：**每个"闸级别 + 能力 + actor"组合每窗口至多一条**占位行
 *     （行有界上界 = 派生式 `(级别数 + 1) × 能力数`，见内核配额服务的 `judgmentSkipRowBound`），
 *     否则行数正比请求数、update 路径可被刷爆日志表；额度计数逻辑不变。无 actor 的调用走兜底桶
 *     `system:unknown`（不静默不限流）。
 *   - **体积纪律**：`state.content` 节选 ≤2000 字符（带 `contentTruncated`/`contentLength`）；
 *     request/response 序列化各硬顶 16KB（超限截断 + `truncated:true`）；失败 `{error}`
 *     ≤2000 字符且**不含 key、不含上游错误体**（401 的裸 JSON body 只用于内部分类）。
 *   - **落库前 redaction**（密钥闸门的纵深防御）：命中 ⇒ 掩码 + `stateRedacted:true`
 *     标记（训练脚本据此跳过或单独标记该行——其存储输入 ≠ 模型实际输入）。
 *     ⚠️ **`stateRedacted` 这个名字不可改**：既有训练/导出纪律按它读行，改名 = 静默把
 *     "已脱敏行"读成"未脱敏行"（内核通用路径用的是 `logRedacted`，两者同义不同键名）。
 *   - **fail-open**：provider 任何失败都只影响判别结果，录入/编辑主流程照常 200。
 *   - **额度按 `(level, capability, actor)` 记账**（create 与 update 判定共用同一窗口）；
 *     全局与能力两桶与 actor 无关，各桶同窗口长度（1h）。
 *
 * [关联代码]
 *   - modules/judgment/judgment-quota.service.ts — 三级闸实现（跨能力共享单例）
 *   - modules/judgment/judgment-payload.ts — redaction 基线 / 16KB 硬顶 / 桶键 / 异常标签
 *   - modules/judgment/typesafe.judgment-provider.ts — 实际发包方（失败分类与永不 throw 契约）
 *   - modules/experience/judgment/judgment-rubric.ts — 本能力的 rubric 与白名单归一化
 *   - experience.service.ts — 两个调用点（create 事务后 / update 事务后）+ 详情 suppression
 *   - database/entities/experience-judgment-record.entity.ts — 日志表契约
 *   - experience-member.service.ts — 判权复用（admin ∪ 空间成员）与 13004 message 单源
 *
 * [持久踩坑]
 *   JUDGMENT-SNAPSHOT-VERSION(版本守卫): 不带 `updated_at` 守卫的快照写会**覆盖**并发编辑
 *     后的新内容结论（8s 判定窗口足够发生一次编辑）。安全方向: 守卫 + rowCount=0 ⇒ 丢弃。
 *   JUDGMENT-ROWCOUNT-SHAPE(raw 形状): `manager.query()` 对 UPDATE 返回 `[rows, affected]`
 *     而这形状随驱动/语句变化（experience.service 文件头三条实证）。安全方向: 统一用
 *     `RETURNING id` + 数返回行数（两种形状都能数），不依赖 `affected` 的落位。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改写入纪律前先确认四条不变量仍成立（日志=事实/版本守卫/单事务/skipped 计入）
 *   □ 改日志载荷必须同步复核"训练语料"文档纪律（stateRedacted 行、节选标记）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Repository } from 'typeorm';
import {
  EXPERIENCE_JUDGMENT_STATUS,
  EXPERIENCE_JUDGMENT_STATUSES,
  type ExperienceJudgment,
  type ExperienceJudgmentLog,
  type ExperienceJudgmentSkippedReason,
  type ExperienceJudgmentStatus,
  type ExperienceJudgmentsResponse,
} from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import { EXPERIENCE_JUDGMENT_DEFAULT_PAGE_SIZE } from './experience.constants';
import { isAdmin } from './experience-actor';
import { ExperienceMemberService, reviewForbidden } from './experience-member.service';
import {
  JUDGMENT_PROVIDER,
  type JudgmentProvider,
} from '../judgment/judgment-capability.interface';
import { JudgmentQuotaService, type JudgmentLimitLevel } from '../judgment/judgment-quota.service';
import {
  capJsonbPayload,
  countReturnedRows,
  judgmentActorKey,
  redactJudgmentPayload,
  safeErrorTag,
} from '../judgment/judgment-payload';
import { experienceRecordCheckCapability } from './judgment/judgment-rubric';
import type { QueryJudgmentDto } from './dto';

/** 判定模式（决定失败时是否要清快照：create 天然 NULL，update 必须显式置 NULL） */
export type JudgmentMode = 'create' | 'update';

/**
 * 本 capability 的输入契约（定义在 rubric 文件里，随能力走）。
 *
 * 这里只做类型转发，让调用点（`experience.service.ts`）与入参注释不必 import 到 rubric 深处。
 */
export type { ExperienceCheckInput } from './judgment/judgment-rubric';

/** `evaluateAndPersist` 入参 */
export interface EvaluateAndPersistParams {
  /** 条目 id（日志 experienceId；快照 UPDATE 的 WHERE） */
  entryId: string;
  /** 判定模式的语义见 JudgmentMode */
  mode: JudgmentMode;
  /** 当前统一身份（额度归属 + 日志 actor 列；null 时按"无 actor"记，走兜底桶） */
  actor: UnifiedActor | null;
  /** 条目内容 + 当次词表快照 */
  input: import('./judgment/judgment-rubric').ExperienceCheckInput;
  /**
   * 版本守卫基准：本次写事务产出的 `updated_at` 的**库内原文**（PG text form，微秒精度）。
   *
   * ⚠️ **不要传 JS Date**（2026-09-22 e2e 实证的真缺陷）：PG 的 `timestamptz` 存到微秒
   * （`now()` = `…09:39:46.247612+00`），而 JS `Date`/`toISOString()` 只有毫秒精度——
   * `WHERE updated_at = '…247Z'` 与库内 `…247612+00` **永不相等**，快照写会 100% 被守卫
   * 挡回（表现为"详情永远没有 judgment"）。故调用方必须在写事务内用
   * `SELECT updated_at::text` 取库内原文传进来（PG 能精确重解析自己的文本格式）。
   */
  expectedUpdatedAtText: string;
}

/**
 * 经验库判别服务（判定接线 + 判断日志）。
 *
 * 调用点只有两处（`experience.service.ts` 的 create / update），且都**在写事务提交之后**
 * ——判定涉及 8s 网络等待，绝不能持有行锁（plan §3.5 的"行锁内绝不 await 网络调用"）。
 *
 * 与内核的分工：闸门（`JudgmentQuotaService`）与纯函数（redaction / 体积 / 计数）复用内核；
 * **事务内"日志行 + 快照"的编排留在本类**（通用 runner 没有 entryId / 快照语义，见文件头不变量）。
 */
@Injectable()
export class ExperienceJudgmentService {
  private readonly logger = new Logger(ExperienceJudgmentService.name);

  constructor(
    @InjectRepository(ExperienceJudgmentRecord)
    private readonly logRepo: Repository<ExperienceJudgmentRecord>,
    private readonly dataSource: DataSource,
    @Inject(JUDGMENT_PROVIDER) private readonly provider: JudgmentProvider,
    /**
     * 三级成本闸（内核单例）：**必须注入而非自建**——全局/能力两级桶是跨能力共享的
     * "实例级出境量上限"，各调用点各持一份会让闸值被静默放大成 N 倍。
     */
    private readonly quota: JudgmentQuotaService,
    /**
     * 判权（`GET /experiences/judgments`）：复用成员服务的角色解析——admin 或空间成员可读，
     * 越权 403/13004（message 单源在成员服务，避免同一码的文案两处漂移）。
     */
    private readonly members: ExperienceMemberService,
    /**
     * 写入者**名字解析**（v1.81.0）：日志页的 `actorName` 由它批量补全——与条目投影
     * 共用同一条 N+1 防线（页内去重一次）。
     */
    private readonly actorProfiles: ActorProfileService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // 判定接线（create / update 共用）
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 执行一次判定并把结果落库（**永不抛错**：判别失败只影响判别结果）。
   *
   * 执行序（顺序有语义，勿调换）：
   * ① provider 未启用 → 短路返回 null（不调用/不写日志/不占额度）；
   * ② 三级成本闸（**全局 → 能力 → actor**）：任一级超限 → 按被撞**级别**写 `skipped` 占位行
   *    （reason 标明是全局 / 能力 / actor）并返回 null；
   * ③ 调 provider（8s 硬顶；任何失败都转成结果对象）；
   * ④ 体积/redaction 纪律（截断 + 掩码标记）；
   * ⑤ **单事务** {INSERT 日志行；ok → 版本守卫写快照 / 失败且 update 模式 → 版本守卫置 NULL}；
   * ⑥ 返回快照值（快照被丢弃或失败 ⇒ null，与库内保持一致）。
   *
   * **fail-open 闭合（P2-3）**：整个主体包在 try/catch 里——判别链上任何**未预期**异常
   * （连接池耗尽、编码错误、第三方库抛错）都只 warn 一行并返回 null，绝不冒泡到录入/编辑
   * 主流程。warn **只带异常类名与可选错误码，不带异常 message**（message 可能夹 SQL/取值/
   * 上游原文——与 P2-2 同一条"错误原文不进日志"纪律）。
   *
   * @param params 条目 id / 模式 / 身份 / 判定输入 / 版本守卫基准
   * @returns 落库成功的判定快照，或 null（未启用 / 被限流 / 判定失败 / 快照被丢弃）
   */
  async evaluateAndPersist(params: EvaluateAndPersistParams): Promise<ExperienceJudgment | null> {
    try {
      return await this.runJudgmentPipeline(params);
    } catch (err: unknown) {
      this.logger.warn(
        `judgment pipeline failed (fail-open, entry ${params.entryId}): ${safeErrorTag(err)}`,
      );
      return null;
    }
  }

  /**
   * 判定流水线本体（异常一律由调用方 `evaluateAndPersist` 兜住，见其 JSDoc）。
   *
   * @param params 同 `evaluateAndPersist`
   */
  private async runJudgmentPipeline(
    params: EvaluateAndPersistParams,
  ): Promise<ExperienceJudgment | null> {
    const { entryId, mode, actor, input, expectedUpdatedAtText } = params;

    // ① provider=none：完全短路（与"被限流跳过"是两种状态，见文件头不变量）
    if (!this.provider.enabled) return null;

    // ② 三级成本闸（**全局 → 能力 → actor**，先严后宽；create 与 update 共用）：任一级超限即跳过
    //    （闸实现在内核 `JudgmentQuotaService`；键含能力名 ⇒ 重排刷额度不会饿死录入判定）
    const actorKey = judgmentActorKey(actor);
    const blocked = this.quota.consume(experienceRecordCheckCapability.name, actorKey);
    if (blocked) {
      // 超限 = 本次"无结论"，**与 error/timeout 语义同构**（P2-1 裁决）：
      // 日志行（每**闸级别 + 能力 + actor** 至多一条）+ update 模式清快照（旧快照描述编辑前内容）。
      // `reason` 标明撞的是哪一级（actor / 全局 / 能力）——跳过分布统计按它分组。
      await this.persistSkipped({
        entryId,
        actor,
        actorKey,
        mode,
        expectedUpdatedAtText,
        level: blocked.level,
        reason: blocked.reason,
      });
      return null;
    }

    // ③ 判定（provider 契约：永不 throw；超时单独归类）
    const outcome = await this.provider.run(experienceRecordCheckCapability, input);

    // ④ 日志载荷纪律（截断 + redaction 标记）
    const request = this.prepareRequestPayload(outcome.request);
    const response = capJsonbPayload(outcome.response);

    // ⑤ 单事务：日志行 + 快照写（日志是事实，快照是缓存）
    //    快照 = 观测元数据（provider/model/judgedAt/rubricVersion）+ 七维产物（与改前逐字段同形）
    const judgment: ExperienceJudgment | null =
      outcome.status === 'ok' ? { ...outcome.meta, ...outcome.value } : null;
    const snapshotWritten = await this.dataSource.transaction(async (manager) => {
      // save()（而非 insert()）：jsonb 载荷走 `_QueryDeepPartialEntity` 的 insert 类型在
      // `Record<string, unknown>` 下不可赋值（照 idempotency.helper 的 jsonb 先例用 save）。
      // 日志行主键是生成的 uuid（未设值）⇒ save 直接 INSERT，不做存在性探测。
      await manager.getRepository(ExperienceJudgmentRecord).save({
        experienceId: entryId,
        operation: experienceRecordCheckCapability.name,
        provider: this.provider.name,
        model: judgment?.model ?? null,
        status: outcome.status,
        actorType: actor?.type ?? null,
        actorId: actor?.id ?? null,
        request,
        response,
        latencyMs: outcome.latencyMs,
      });

      // 快照：成功 → 写本次结论；失败且 update 模式 → 置 NULL（旧快照描述旧内容）
      if (judgment) {
        return this.writeSnapshot(manager, entryId, expectedUpdatedAtText, judgment);
      }
      if (outcome.status !== 'ok' && mode === 'update') {
        await this.clearSnapshot(manager, entryId, expectedUpdatedAtText);
      }
      return false;
    });

    if (judgment && !snapshotWritten) {
      // 版本守卫拦截：条目在判定在途期间被再改 ⇒ 丢弃快照（日志已留事实）
      this.logger.log(
        `judgment snapshot discarded for entry ${entryId}: the entry was modified while the check ` +
          'was in flight (version guard mismatch); the log row is kept as the source of truth',
      );
      return null;
    }
    return judgment;
  }

  /**
   * 版本守卫写快照（**裸 SQL 定向 UPDATE**：只 SET judgment，不触碰 updated_at）。
   *
   * @param manager 事务管理器（与日志行同事务）
   * @param entryId 条目 id
   * @param expectedUpdatedAtText 版本守卫基准（库内 `updated_at::text` 原文，微秒精度）
   * @param judgment 归一化后的判定结论
   * @returns true = 写入成功；false = 守卫不匹配（条目已被并发修改）
   */
  private async writeSnapshot(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    entryId: string,
    expectedUpdatedAtText: string,
    judgment: ExperienceJudgment,
  ): Promise<boolean> {
    const raw = await manager.query(
      `UPDATE experience_entries SET judgment = $1::jsonb
        WHERE id = $2::uuid AND updated_at = $3::timestamptz
        RETURNING id`,
      [JSON.stringify(judgment), entryId, expectedUpdatedAtText],
    );
    return countReturnedRows(raw) > 0;
  }

  /** 失败分支清快照（同版本守卫：并发编辑后的新快照不得被这次失败清掉） */
  private async clearSnapshot(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    entryId: string,
    expectedUpdatedAtText: string,
  ): Promise<void> {
    await manager.query(
      `UPDATE experience_entries SET judgment = NULL
        WHERE id = $1::uuid AND updated_at = $2::timestamptz AND judgment IS NOT NULL`,
      [entryId, expectedUpdatedAtText],
    );
  }

  /**
   * 限流跳过落库（**每"闸级别 + 能力 + actor"至多一条占位行**）+ 快照同构清理（P2-1 裁决）。
   *
   * 为什么至多一条/级别：skipped 行正比请求数会让"行写入有界"这条不变量失效（update 路径没有
   * 录入限流兜着，被审人可以靠反复编辑刷满日志表）。首次撞某级写一行（它是"这个 actor 在本
   * 窗口撞过这一级闸"的记账凭证），窗口内后续同类超限只 warn。
   * 为什么键含 level **与能力**：三级闸是三种不同原因——只记一条会把"全局闸被撞"与"某 actor
   * 被限流"混成一行；键再含能力，则重排撞闸的凭证不会挤掉录入判定的凭证。
   * 行有界上界是**派生式** `(级别数 + 1) × 能力数`（见内核配额服务的 `judgmentSkipRowBound`）。
   * 为什么仍然清快照：skipped 与 error/timeout **语义同构**（本次无结论）——留着旧快照就是
   * 让详情继续展示"编辑前内容的结论"（update 模式）。create 模式快照天然 NULL，不做多余写。
   *
   * fail-open：任何失败只 warn（**不带异常 message**，见文件头纪律）。
   */
  private async persistSkipped(params: {
    entryId: string;
    actor: UnifiedActor | null;
    actorKey: string;
    mode: JudgmentMode;
    expectedUpdatedAtText: string;
    /** 撞上的闸级别（决定 skipped 行的写入有界键 + 告警文案） */
    level: JudgmentLimitLevel;
    /** 落库 reason（**契约值**，单源 = shared 枚举；下游按它统计"跳过分布"） */
    reason: ExperienceJudgmentSkippedReason;
  }): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        if (
          this.quota.allowSkipRow(
            params.level,
            experienceRecordCheckCapability.name,
            params.actorKey,
          )
        ) {
          await manager.getRepository(ExperienceJudgmentRecord).save({
            experienceId: params.entryId,
            operation: experienceRecordCheckCapability.name,
            provider: this.provider.name,
            status: EXPERIENCE_JUDGMENT_STATUS.SKIPPED,
            actorType: params.actor?.type ?? null,
            actorId: params.actor?.id ?? null,
            // 占位对象而非 null：`request` 列是 NOT NULL，skipped 不能破这条不变量（23502 会
            // 连带把录入主流程打成 500）
            request: { skipped: true, reason: params.reason },
            response: null,
            latencyMs: null,
          });
        } else {
          // 本级别本窗口（本能力）已经记过一行：只留 warn（不落行——行写入有界）
          this.logger.warn(
            `judgment ${params.level} rate limit exceeded for ${params.actorKey} ` +
              `(reason=${params.reason}); skipped row already recorded in this window ` +
              '(not writing another row)',
          );
        }

        if (params.mode === 'update') {
          await this.clearSnapshot(manager, params.entryId, params.expectedUpdatedAtText);
        }
      });
    } catch (err: unknown) {
      // "先记后写"的补偿（终审 F6）：事务失败 ⇒ **交还**本组合的这一条配额，否则一次瞬时故障
      // （连接池抖动）会让本窗口再也写不出记账凭证（跳过本身照旧拒绝，但"跳过原因"失去凭证）。
      this.quota.releaseSkipRow(
        params.level,
        experienceRecordCheckCapability.name,
        params.actorKey,
      );
      this.logger.warn(`failed to persist skipped judgment state: ${safeErrorTag(err)}`);
    }
  }

  /** 日志用 request：状态字段 redaction 后再过体积硬顶 */
  private prepareRequestPayload(request: Record<string, unknown>): Record<string, unknown> {
    return capJsonbPayload(redactRequestState(request));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 读：判断日志（GET /experiences/judgments）
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 判断日志查询（plan §4）。
   *
   * 判权：人类 admin 或空间成员（owner/reviewer 任一），否则 403/13004——日志含正文节选，
   * 与"判断日志是正文第二副本"的威胁面同源，只对治理角色开放。
   *
   * 排序 **`created_at DESC, id DESC`**（全序；同刻多行也不会在翻页时漏行/重复）。
   * 导出姿势（写进文档与 message）：按 `from`/`to` 时间窗切片翻页 + 用 `total` 自检，
   * **不要 `page++` 裸翻**（翻页途中新写入会插进已翻过的区间）。
   *
   * @param query 过滤（operation/status/experienceId/from/to）+ 分页
   * @param actor 当前统一身份
   * @returns `{items, total, page, pageSize}`
   * @throws ForbiddenException 403/13004（无治理角色）
   */
  async listJudgments(
    query: QueryJudgmentDto,
    actor: UnifiedActor | null,
  ): Promise<ExperienceJudgmentsResponse> {
    if (!actor?.id) throw reviewForbidden('read judgment logs');
    const hasRole = isAdmin(actor) || (await this.members.resolveMemberRole(actor.id)) !== null;
    if (!hasRole) throw reviewForbidden('read judgment logs');

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? EXPERIENCE_JUDGMENT_DEFAULT_PAGE_SIZE;

    const build = (): SelectQueryBuilder<ExperienceJudgmentRecord> => {
      const qb = this.logRepo.createQueryBuilder('j');
      if (query.operation !== undefined) {
        qb.andWhere('j.operation = :operation', { operation: query.operation });
      }
      if (query.status !== undefined) {
        qb.andWhere('j.status = :status', { status: query.status });
      }
      if (query.experienceId !== undefined) {
        qb.andWhere('j.experience_id = :experienceId', { experienceId: query.experienceId });
      }
      if (query.from !== undefined) {
        qb.andWhere('j.created_at >= :from', { from: new Date(query.from) });
      }
      if (query.to !== undefined) {
        qb.andWhere('j.created_at <= :to', { to: new Date(query.to) });
      }
      return qb;
    };

    const total = await build().getCount();
    const rows = await build()
      // 全序：同刻多行也必须有确定顺序（否则翻页漏行/重复）
      .orderBy('j.created_at', 'DESC')
      .addOrderBy('j.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    // 写入者名字（v1.81.0）：本页 actorId 去重后**一次**批量解析（N+1 防线，与条目投影同规）。
    // `actorId` 为 null 的行**不进解析集合**——无 actor 的调用走的是额度兜底键
    // `system:unknown`（见 judgmentActorKey），它不是 actors 表里的行，拿去查只会白付一次往返。
    const actorIds = [
      ...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id))),
    ];
    const profiles = await this.actorProfiles.resolveProfiles(actorIds);

    return {
      items: rows.map((row) => {
        // toJudgmentLogItem 保持**纯函数**（无依赖、可单测）：补名在调用点做
        const item = toJudgmentLogItem(row);
        return {
          ...item,
          actorName: row.actorId ? (profiles.get(row.actorId)?.name ?? null) : null,
        };
      }),
      total,
      page,
      pageSize,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 模块级纯函数（本文件只剩"经验库专属"的两个；通用纯函数已上移内核）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 落库前 redaction 的**经验库标记包装**（通用 redaction 在内核 `judgment-payload.ts`）。
 *
 * 为什么本文件还留这一层：**标记名是按能力域分叉的契约**——经验库行必须标 `stateRedacted`
 * （既有训练/导出纪律按它读行），通用路径标 `logRedacted`。内核基线只负责掩码、不替调用方
 * 决定标记名（见内核 payload 文件头不变量），故这层包装就是"经验库的标记决定"。
 *
 * @param payload 日志 request（`{questions, state}` 或任意嵌套对象）——经验库唯一例外：
 *   载荷 = 实际发包体（`capability.toLogPayload` 显式返回它）
 * @returns 掩码后的新对象（原对象不被修改）+ 命中时在根上标 `stateRedacted: true`
 */
export function redactRequestState(payload: Record<string, unknown>): Record<string, unknown> {
  const result = redactJudgmentPayload(payload);
  return result.redacted ? { ...result.payload, stateRedacted: true } : result.payload;
}

/**
 * 日志行 → 响应投影（`ExperienceJudgmentLog`）。
 *
 * `request`/`response` 原样透出（jsonb 直读）：它们是语料本体，导出路径的消费方
 * （训练脚本/复核工具）按 §4 的纪律自行跳过 `stateRedacted` 行。
 */
export function toJudgmentLogItem(row: ExperienceJudgmentRecord): ExperienceJudgmentLog {
  return {
    id: row.id,
    experienceId: row.experienceId,
    operation: row.operation,
    provider: row.provider,
    model: row.model,
    status: row.status,
    actorType: row.actorType,
    actorId: row.actorId,
    latencyMs: row.latencyMs,
    request: row.request,
    response: row.response,
    createdAt: row.createdAt,
  };
}

/** 断言 status 值域（供单测/未来调用方复用；DTO 层已 `@IsIn`） */
export function isJudgmentStatus(value: unknown): value is ExperienceJudgmentStatus {
  return (
    typeof value === 'string' && (EXPERIENCE_JUDGMENT_STATUSES as readonly string[]).includes(value)
  );
}
