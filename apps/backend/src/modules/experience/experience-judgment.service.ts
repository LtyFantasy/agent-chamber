/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别服务的**接线与落库**：录入/内容改写后的判定调用、判断日志、
 *     条目快照写入、限流额度、判断日志查询端点
 *
 * [代码职责]
 *   - `evaluateAndPersist`：额度判定 → provider 调用 → 体积/redaction 纪律 →
 *     **单事务** {INSERT 判断日志行；版本守卫 UPDATE 条目快照}
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
 *   - **限流 skipped 与 error/timeout 语义同构**（P2-1 裁决：本次"无结论"）：`request` 写占位
 *     `{skipped:true, reason}`、`response` 为 null、**update 模式同样清快照**（旧快照描述编辑前
 *     内容）；`provider=none` 则是**短路**（不调用、不写日志、不占额度）——两种状态必须区分。
 *   - **skipped 行写入有界**（P2-5 裁决）：**每窗口每 actor 至多一条**占位行（首次超限写行、
 *     窗口内后续只 warn），否则行数正比请求数、update 路径可被刷爆日志表；额度计数逻辑不变
 *     （超限尝试照旧压入窗口数组）。无 actor 的调用走兜底桶 `system:unknown`（不静默不限流）。
 *   - **体积纪律**：`state.content` 节选 ≤2000 字符（带 `contentTruncated`/`contentLength`）；
 *     request/response 序列化各硬顶 16KB（超限截断 + `truncated:true`）；失败 `{error}`
 *     ≤2000 字符且**不含 key、不含上游错误体**（401 的裸 JSON body 只用于内部分类）。
 *   - **落库前 redaction**（密钥闸门同正则的纵深防御）：命中 ⇒ 掩码 + `stateRedacted:true`
 *     标记（训练脚本据此跳过或单独标记该行——其存储输入 ≠ 模型实际输入）。
 *     当前路径命中率恒零（闸门先于判定执行且同正则），故这是**防未来闸门回退**的第二道。
 *   - **fail-open**：provider 任何失败都只影响判别结果，录入/编辑主流程照常 200。
 *   - **额度按 actor 独立**（`type:id`），create 与 update 判定**共用**同一窗口。
 *
 * [关联代码]
 *   - judgment/typesafe.judgment-provider.ts — 实际发包方（失败分类与永不 throw 契约）
 *   - judgment/judgment-rubric.ts — 问题集与白名单归一化
 *   - judgment/judgment-provider.factory.ts — token 装配（e2e override 点）
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
  EXPERIENCE_JUDGMENT_OPERATION,
  EXPERIENCE_JUDGMENT_STATUS,
  EXPERIENCE_JUDGMENT_STATUSES,
  type ExperienceJudgment,
  type ExperienceJudgmentLog,
  type ExperienceJudgmentStatus,
  type ExperienceJudgmentsResponse,
} from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import { ExperienceJudgmentRecord } from '../../database/entities/experience-judgment-record.entity';
import {
  EXPERIENCE_JUDGMENT_DEFAULT_PAGE_SIZE,
  EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES,
  EXPERIENCE_JUDGMENT_RATE_WINDOW_MS,
  EXPERIENCE_JUDGMENT_SKIPPED_REASON,
  EXPERIENCE_SECRET_PATTERNS,
} from './experience.constants';
import { isAdmin } from './experience-actor';
import { ExperienceMemberService, reviewForbidden } from './experience-member.service';
import {
  JUDGMENT_PROVIDER,
  type ExperienceCheckInput,
} from './judgment/judgment-provider.interface';
import type { JudgmentProvider } from './judgment/judgment-provider.interface';
import { JUDGMENT_CONFIG } from './judgment/judgment-provider.factory';
import type { JudgmentConfig } from '../../config/judgment.config';
import type { QueryJudgmentDto } from './dto';

/** 判定模式（决定失败时是否要清快照：create 天然 NULL，update 必须显式置 NULL） */
export type JudgmentMode = 'create' | 'update';

/** `evaluateAndPersist` 入参 */
export interface EvaluateAndPersistParams {
  /** 条目 id（日志 experienceId；快照 UPDATE 的 WHERE） */
  entryId: string;
  /** 判定模式的语义见 JudgmentMode */
  mode: JudgmentMode;
  /** 当前统一身份（额度归属 + 日志 actor 列；null 时按"无 actor"记，不占任何人的额度） */
  actor: UnifiedActor | null;
  /** 条目内容 + 当次词表快照 */
  input: ExperienceCheckInput;
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
 */
@Injectable()
export class ExperienceJudgmentService {
  private readonly logger = new Logger(ExperienceJudgmentService.name);

  /**
   * 判定限流窗口：actorKey → 事件时刻（epoch ms）数组（**进程内内存**，照录入限流的
   * `createQuota` 形态与取舍：单实例部署前提、重启清零、不跨实例共享）。
   */
  private readonly quota = new Map<string, number[]>();

  /**
   * "上次为某 actor 写 skipped 占位行"的时刻（epoch ms；P2-5 的"每窗口至多一行"依据）。
   *
   * 与额度窗口同生命周期（进程内、重启清零）。
   */
  private readonly skippedRowAt = new Map<string, number>();

  constructor(
    @InjectRepository(ExperienceJudgmentRecord)
    private readonly logRepo: Repository<ExperienceJudgmentRecord>,
    private readonly dataSource: DataSource,
    @Inject(JUDGMENT_PROVIDER) private readonly provider: JudgmentProvider,
    @Inject(JUDGMENT_CONFIG) private readonly config: JudgmentConfig,
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
   * ② 额度判定：超限 → 写 `skipped` 占位行（**计入额度**）并返回 null；
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

    // ② 额度（create 与 update 共用；超限尝试也记账）
    const actorKey = judgmentActorKey(actor);
    if (!this.consumeQuota(actorKey)) {
      // 超限 = 本次"无结论"，**与 error/timeout 语义同构**（P2-1 裁决）：
      // 日志行（每窗口每 actor 至多一条，P2-5）+ update 模式清快照（旧快照描述编辑前内容）
      await this.persistSkipped({ entryId, actor, actorKey, mode, expectedUpdatedAtText });
      return null;
    }

    // ③ 判定（provider 契约：永不 throw；超时单独归类）
    const outcome = await this.provider.checkEntry(input);

    // ④ 日志载荷纪律（截断 + redaction 标记）
    const request = this.prepareRequestPayload(outcome.request);
    const response = capJsonbPayload(outcome.response);

    // ⑤ 单事务：日志行 + 快照写（日志是事实，快照是缓存）
    const judgment = outcome.status === 'ok' ? outcome.judgment : null;
    const snapshotWritten = await this.dataSource.transaction(async (manager) => {
      // save()（而非 insert()）：jsonb 载荷走 `_QueryDeepPartialEntity` 的 insert 类型在
      // `Record<string, unknown>` 下不可赋值（照 idempotency.helper 的 jsonb 先例用 save）。
      // 日志行主键是生成的 uuid（未设值）⇒ save 直接 INSERT，不做存在性探测。
      await manager.getRepository(ExperienceJudgmentRecord).save({
        experienceId: entryId,
        operation: EXPERIENCE_JUDGMENT_OPERATION.RECORD_CHECK,
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
   * 限流跳过落库（**每窗口每 actor 至多一条占位行**，P2-5 裁决）+ 快照同构清理（P2-1 裁决）。
   *
   * 为什么至多一条：skipped 行正比请求数会让"行写入有界 60/h/actor"这条不变量失效（update
   * 路径没有录入限流兜着，被审人可以靠反复编辑刷满日志表）。首次超限写一行（它是"这个 actor
   * 在本窗口被限流过"的记账凭证），窗口内后续超限只 warn。
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
  }): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        if (this.consumeSkipRowAllowance(params.actorKey)) {
          await manager.getRepository(ExperienceJudgmentRecord).save({
            experienceId: params.entryId,
            operation: EXPERIENCE_JUDGMENT_OPERATION.RECORD_CHECK,
            provider: this.provider.name,
            status: EXPERIENCE_JUDGMENT_STATUS.SKIPPED,
            actorType: params.actor?.type ?? null,
            actorId: params.actor?.id ?? null,
            // 占位对象而非 null：`request` 列是 NOT NULL，skipped 不能破这条不变量（23502 会
            // 连带把录入主流程打成 500）
            request: { skipped: true, reason: EXPERIENCE_JUDGMENT_SKIPPED_REASON },
            response: null,
            latencyMs: null,
          });
        } else {
          // 本窗口已经记过一行：只留 warn（不落行——行写入有界）
          this.logger.warn(
            `judgment rate limit exceeded for ${params.actorKey}; skipped row already recorded in ` +
              'this window (not writing another row)',
          );
        }

        if (params.mode === 'update') {
          await this.clearSnapshot(manager, params.entryId, params.expectedUpdatedAtText);
        }
      });
    } catch (err: unknown) {
      this.logger.warn(`failed to persist skipped judgment state: ${safeErrorTag(err)}`);
    }
  }

  /**
   * 额度消费（滑动窗口；**无论是否被限流都记账**）。
   *
   * @param actorKey `${type}:${id}`
   * @returns true = 允许本次调用；false = 已超限（调用点写 skipped 行）
   */
  private consumeQuota(actorKey: string): boolean {
    const now = Date.now();
    const hits = (this.quota.get(actorKey) ?? []).filter(
      (t) => now - t < EXPERIENCE_JUDGMENT_RATE_WINDOW_MS,
    );
    const allowed = hits.length < this.config.rateLimitPerHour;
    // 被限流的尝试同样入账（plan §3.5：skipped 计入额度——不许当免费通道）。行写入由
    // `consumeSkipRowAllowance` 兜住（每窗口每 actor 至多一行，P2-5）。
    hits.push(now);
    this.quota.set(actorKey, hits);
    return allowed;
  }

  /**
   * 本窗口是否还允许写 skipped 占位行（**每个 actorKey 每窗口一条**，P2-5）。
   *
   * 与额度计数器同样落在**进程内内存**（同一取舍：单实例部署、重启清零）：
   * 记录"上次为该 actor 写 skipped 行的时刻"，只要还在窗口内就不再写。
   *
   * @param actorKey 额度桶键（含 null actor 的兜底桶）
   * @returns true = 允许写这一行
   */
  private consumeSkipRowAllowance(actorKey: string): boolean {
    const now = Date.now();
    const last = this.skippedRowAt.get(actorKey);
    if (last !== undefined && now - last < EXPERIENCE_JUDGMENT_RATE_WINDOW_MS) return false;
    this.skippedRowAt.set(actorKey, now);
    return true;
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
// 模块级纯函数（日志载荷纪律 + 投影；便于单测直接覆盖）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 数 `RETURNING id` 的返回行数（**不依赖 `affected` 落位**，见文件头踩坑）。
 *
 * 兼容两种 driver 返回形状：`[[rows], affected]` 与 `rows`。
 */
export function countReturnedRows(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const [first, second] = raw as [unknown, unknown];
  if (Array.isArray(first) && typeof second === 'number') return first.length;
  return raw.length;
}

/**
 * jsonb 载荷体积硬顶（超限 ⇒ 截断 + `truncated:true`，**不静默**）。
 *
 * @param payload 待落库对象
 * @param maxBytes 上限（字节；按 JSON 字符串的 UTF-8 长度计）
 * @returns 原对象（未超限）或 `{truncated:true, json:<片段>}`（超限）
 */
export function capJsonbPayload(
  payload: Record<string, unknown>,
  maxBytes: number = EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES,
): Record<string, unknown> {
  const serialized = JSON.stringify(payload ?? {});
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return payload;

  const stateRedacted = payload?.stateRedacted === true;
  const build = (json: string): Record<string, unknown> => ({
    truncated: true,
    originalBytes: bytes,
    json,
    // ⚠️ 标记**不能被截断吞掉**（P2-4）：训练纪律要求"redacted 行必须可被识别"，
    // 而它原本在 payload 根上、会被 json 片段替换掉 ⇒ 这里显式搬进信封
    ...(stateRedacted ? { stateRedacted: true } : {}),
  });

  // 先按"空 json 字段"量出信封开销，再按预算切载荷；随后用实际序列化长度**收敛**
  // （JSON 对 `"`/`\` 的转义会让字段贡献大于裸串字节数），最多 8 轮、每轮降 10%。
  const overhead = Buffer.byteLength(JSON.stringify(build('')), 'utf8');
  let budget = Math.max(0, maxBytes - overhead);
  let envelope = build(truncateUtf8(serialized, budget));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= maxBytes) break;
    budget = Math.floor(budget * 0.9);
    envelope = build(truncateUtf8(serialized, budget));
    if (budget === 0) break;
  }
  return envelope;
}

/**
 * 按**字节**安全截断（不切在多字节字符中间）。
 *
 * 为什么不能用 `String.prototype.slice`（P2-4 实测）：`slice` 按**字符**计数，CJK 载荷
 * 3 字节/字符——24056B 的载荷 `slice(0, 16384)` 仍留下 ~49KB，上限形同虚设。
 *
 * @param text 原串
 * @param maxBytes 字节上限
 * @returns 截断后的合法 UTF-8 前缀（回退到字符边界，绝不产生替换字符）
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 续字节形如 10xxxxxx：向前回退到首字节
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 额度桶键（P2-5）：`type:id`；**无 actor 时用兜底桶 `system:unknown`**。
 *
 * 为什么不能返回 null 跳过限流：null actor 的调用（内部任务/系统触发）同样会打模型与写日志，
 * "不静默不限流"是这条兜底的全部意义（否则它成了绕过限流的免费通道）。
 */
export function judgmentActorKey(actor: UnifiedActor | null): string {
  return actor?.id ? `${actor.type}:${actor.id}` : 'system:unknown';
}

/**
 * 异常的分类标签（**只出类名 + 可选错误码，绝不出 message**）。
 *
 * message 可能含 SQL 片段、参数取值或上游错误体原文——与 P2-2 同一条纪律。
 */
export function safeErrorTag(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  const code = (err as { code?: unknown })?.code;
  const nameText = typeof name === 'string' && name ? name : 'Error';
  return typeof code === 'string' || typeof code === 'number' ? `${nameText}/${code}` : nameText;
}

/**
 * redaction 专用模式（**消费整个值**，与"判定命中"的闸门正则刻意分开）。
 *
 * 为什么要分开：闸门正则（`EXPERIENCE_SECRET_PATTERNS`）是**前缀命中**语义——它只需要
 * 判断"这段文本里有密钥"，命中即 400 拒绝，故 `/ask_[A-Za-z0-9]/` 只吃两个字符就够。
 * 但**掩码**必须吃掉整个值，否则会漏下大半：实测 `/ask_[A-Za-z0-9]/` 作用在
 * `ask_deadbeef` 上得到 `[redacted]eadbeef`（9 个字符的密钥留了 7 个），
 * `/password\s*=/` 作用在 `password=hunter2` 上留下 `hunter2`——掩码等于没掩。
 *
 * PEM 私钥块整块掩码（头到 `END ... PRIVATE KEY` 或串尾）：只掩头会留下 base64 私钥体。
 * 残余（裸 base64 无标记形态）与闸门残余同源，登记在 `experience.constants.ts` 的盲区条。
 *
 * ⚠️ **同一凭证族在两张表里各有一条不是冗余，勿当"重复"删**（如 `apikey_`）：本表是
 * "**消费整个值**"，闸门表（`EXPERIENCE_SECRET_PATTERNS`）是"**前缀命中**"。redaction 时
 * 两张表串联跑（本表在前、闸门表兜底，见 `redactRequestState`）——若删掉本表的长形态，
 * 兜底就只剩短形态，会留下 `[redacted]eadbeef` 式的半掩码（见上段实测）。
 */
export const JUDGMENT_REDACTION_PATTERNS: readonly RegExp[] = [
  /ask_[A-Za-z0-9_-]+/g,
  // TypeSafe 官方云 key 族（与 ask_ 同规：吃整个值，含官方 key 可能出现的 `-` 等字符）
  /apikey_[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /(?:-{2,5}\s*)?BEGIN(?:\s+[A-Z0-9-]+){0,3}\s+PRIVATE KEY[\s\S]*?(?:END(?:\s+[A-Z0-9-]+){0,3}\s+PRIVATE KEY[^\n]*|$)/g,
  /password\s*=\s*\S+/gi,
  /age-secret-key-\S+/gi,
  /putty-user-key-file:\s*\S+/gi,
];

/**
 * 落库前 redaction（密钥闸门的**纵深防御**；见文件头不变量）。
 *
 * 扫描对象里所有字符串（含数组元素与 env 值）：先用"消费整个值"的
 * `JUDGMENT_REDACTION_PATTERNS` 掩码，再用闸门正则兜一遍（防"只有标记没有值"的形态），
 * 任一命中即在根上标 `stateRedacted: true`（训练脚本据此跳过或单独标记该行）。
 *
 * @param payload 日志 request（`{questions, state}` 或任意嵌套对象）
 * @returns 掩码后的新对象（原对象不被修改；无命中时原样返回）
 */
export function redactRequestState(payload: Record<string, unknown>): Record<string, unknown> {
  let hit = false;

  const redactString = (value: string): string => {
    let out = value;
    // 先消费整值的掩码模式，再用闸门正则兜底（顺序有语义：前者吃得多；**长形态勿当冗余删**）
    for (const pattern of [...JUDGMENT_REDACTION_PATTERNS, ...EXPERIENCE_SECRET_PATTERNS]) {
      // 统一走全局 replace（不用 test：带 g 的正则有 lastIndex 状态，test 会吃字符）
      const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
      const before = out;
      out = out.replace(global, '[redacted]');
      if (out !== before) hit = true;
    }
    return out;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  const result = walk(payload) as Record<string, unknown>;
  return hit ? { ...result, stateRedacted: true } : result;
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
