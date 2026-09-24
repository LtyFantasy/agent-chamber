/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）读写面：录入 / 检索三路融合 / 分面 / 详情 / 反馈计数联动 /
 *     编辑（乐观锁 + 回落）/ 质量终审 / 软删 / 零命中埋点
 *
 * [代码职责]
 *   - 全部业务规则的执行点：归一化 → 闸门 → 限流 → 幂等 → 持久化 → 计数联动 → 审计
 *   - `baseQuery()` 是**列表/分面/词表三处查询口径的唯一收口**（软删 + 过期 + suspect）
 *   - 反馈计数三列与反馈行的**同事务原子迁移**（铁律 #18 不变量的守门人）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §1.2（反馈不变量）/§2（匹配契约）/
 *     §3（API 契约）/§6（治理与审计）/§8（观测）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（错误码→消费者动作表）
 *
 * [关键不变量]
 *   1. **匹配语义**：signals/domains 是 `&&` ANY-overlap（**禁 `= ANY`**，实测 Seq Scan
 *      用不上 GIN）；env 四键是 `->>` 精确相等；参数之间 AND
 *   2. **q 是过滤 + 排序**：融合分低于 `EXPERIENCE_SCORE_FLOOR` 直接不进结果集——
 *      否则零命中语义（冷启动引导）永不触发
 *   3. **归一化只在写读两侧各做一次**：写侧 trim+lowercase 落库，读侧对查询值做同样
 *      归一化（`?signals=ECONNREFUSED` 必须能命中库里的小写值）
 *   4. **录入恒 unverified**：录入者取 `@CurrentActor()`，DTO 不收 quality/createdBy
 *      （徽章洗白防线的第一道物理隔离）
 *   5. **内容改写 → quality 回落 unverified + 清 verified_by/at**：只有
 *      title/summary/content/signals 四个内容类字段触发；intent/domains/env/expiresAt
 *      改元数据不触发（plan §3 逐字段列明）
 *   6. **反馈计数三列与反馈行同事务**：单语句原子 UPDATE（**禁
 *      `repository.increment()`**——那会顶 `updated_at`，让"反馈"变成"内容更新"）、
 *      手写 `deleted_at IS NULL`、RETURNING 取终值；rowCount=0 → 13000
 *   7. **反馈不顶 `updated_at`**：反馈不是内容编辑，顶了会让 `sort=recent` 被反馈刷屏
 *      （该列刻意不进任何索引亦同源）
 *   8. **异常与日志不回显正文**：错误 message/审计载荷只出现 id、标题、字段名与计数，
 *      **永不出现 content 正文**（含密钥闸门命中处）
 *   9. **零命中埋点 fail-open**：埋点写失败只记日志，绝不阻断检索
 *   10. **本批不进全局 /search、不发 events/SSE、不扩 ResourceType/EventType**（plan §3
 *       末段明文决策）——代码里零接线，故本服务不注入 EventEmitter/SseService
 *
 * [关联代码]
 *   - experience.controller.ts — 8 端点的守卫布局与原始查询串形态守卫
 *   - experience.constants.ts — 全部阈值/上限/闸门模式的单源
 *   - dto/*.dto.ts — 格式校验（本服务的所有入参都已过层 1）
 *   - common/services/idempotency.helper.ts — 录入幂等（**复用，禁内联分叉**）
 *   - common/services/owner-proxy.service.ts — 编辑/删除的作者判定（owner 代理）
 *   - modules/audit/audit.service.ts — 三处插桩（终审 / 软删 / 越权尝试），fail-open
 *   - database/entities/{experience-entry,experience-feedback,experience-search-event}.entity.ts
 *
 * [持久踩坑]
 *   EXPERIENCE-FEEDBACK-CONFLICT-TARGET(仲裁者): 改判路径的冲突目标必须是
 *     `(experience_id, actor_type, actor_id)`；写成幂等键会让同一人重复反馈插两行、
 *     计数重复累加且**零报错**。安全方向: 先 `SELECT ... FOR UPDATE` 锁条目行串行化并发，
 *     再按去重键读写单行。
 *   EXPERIENCE-DTO-PRESENCE(缺省键判定): TS target ES2022（useDefineForClassFields 默认
 *     true）下，class-transformer 产出的 DTO 实例**所有声明字段都是 own 属性**（缺省即
 *     `undefined`）⇒ `'field' in dto` 恒为 true，"是否显式传了该字段"必须用
 *     `dto.field !== undefined` 判定（显式 null 与缺省因此可区分，清空语义才成立）。
 *   EXPERIENCE-COUNT-UPDATE-ATOMIC(计数原子性): 三列联动若拆成多条 UPDATE，并发改判会
 *     丢更新且**无报错**。安全方向: 单语句 + RETURNING，行锁保证串行化。
 *   EXPERIENCE-RAW-KEY-SHAPE(raw 键形状): TypeORM 的 `getRawMany()`/`manager.query()` 返回
 *     **形状必须真库验证**，三处实证坑：① `.select(['e.id'])`（数组形态无别名）的 raw key 是
 *     `e_id`（别名_蛇形列名），照 `row.id` 读**静默 undefined**；② 子查询里实体列名是
 *     `e_<col>`，`unnest(base.domains)` 直接报 42703；③ `manager.query()` 对 UPDATE/DELETE
 *     返回 `[rows, affected]` 而 INSERT 返回纯 rows。安全方向: 每个 raw 列显式取别名
 *     （`.select('e.id','id')`）、子查询列显式别名、UPDATE 返回值经 normalizeUpdateReturning
 *     解包；新增任何 raw 通道必须配真库断言（单测 mock 的形状由实现者自证 = 测不出这三坑）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量]：新增查询路径必须走 baseQuery（否则口径分叉）
 *   □ 反馈/计数相关的断言变松 = 铁律 #18 护栏失效（e2e 有六条不变量钉住）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder, Repository } from 'typeorm';
import { createHash } from 'crypto';
import {
  EXPERIENCE_ENV_KEYS,
  EXPERIENCE_FEEDBACK_OUTCOME,
  EXPERIENCE_INTENTS,
  EXPERIENCE_QUALITIES,
  EXPERIENCE_QUALITY,
  EXPERIENCE_ZERO_HIT_HINT,
  ErrorCode,
  type ExperienceAppliedFilters,
  type ExperienceCreatorFacet,
  type ExperienceDetail,
  type ExperienceDuplicateCandidate,
  type ExperienceEnv,
  type ExperienceFacetsResponse,
  type ExperienceFeedbackOutcome,
  type ExperienceFeedbackResponse,
  type ExperienceListResponse,
  type ExperienceQualityReviewResponse,
  type ExperienceSummary,
  type ExperienceIntent,
  type ExperienceJudgment,
  type ExperienceMemberRole,
  type ExperienceQuality,
  type ExperienceSort,
  type RecordExperienceResponse,
} from '@agent-chamber/shared';
import { AuditAction } from '@agent-chamber/shared';
import type { UnifiedActor } from '../../common/types/actor.types';
import {
  buildIdempotencyContext,
  insertIdempotencyInTx,
  tryIdempotentReplay,
} from '../../common/services/idempotency.helper';
import { OwnerProxyService } from '../../common/services/owner-proxy.service';
// 录入者/终审者**名字解析**（v1.81.0）：裸 UUID 不再上屏，投影层按 actorId 批量换名
// （@Global CommonModule 导出，experience-member.service 早已同款注入，无环）
import { ActorProfileService } from '../../common/services/actor-profile.service';
import type { ActorProfile } from '../../common/services/actor-profile.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ENTITY_TYPE } from '../audit/audit-constants';
import { ExperienceEntry } from '../../database/entities/experience-entry.entity';
import { ExperienceFeedback } from '../../database/entities/experience-feedback.entity';
import { ExperienceSearchEvent } from '../../database/entities/experience-search-event.entity';
import { IdempotencyRecord } from '../../database/entities/idempotency-record.entity';
import {
  EXPERIENCE_AVAILABLE_DOMAINS_LIMIT,
  EXPERIENCE_BY_CREATOR_LIMIT,
  EXPERIENCE_CREATE_RATE_WINDOW_MS,
  EXPERIENCE_DEFAULT_PAGE_SIZE,
  EXPERIENCE_DUPLICATE_CANDIDATE_LIMIT,
  EXPERIENCE_DUPLICATE_TITLE_SIMILARITY,
  EXPERIENCE_IDEMPOTENCY_ENTITY_TYPE,
  EXPERIENCE_MISSING_VERIFICATION_WARNING,
  EXPERIENCE_RANK_WEIGHTS,
  resolveCreateRateLimit,
  EXPERIENCE_SCORE_FLOOR,
  EXPERIENCE_SECRET_PATTERNS,
  EXPERIENCE_VERIFICATION_SECTION_PATTERN,
} from './experience.constants';
// isAdmin 自 2026-09-22（第二期批 2）移到叶子模块 `experience-actor.ts`：成员服务
// （experience-member.service.ts）也要用它，放在本文件会形成 service ↔ service 循环 import。
// 此处 re-export 保持本文件既有对外 API 面（`svc.isAdmin` 等引用点不动）。
import { isAdmin } from './experience-actor';
import { ExperienceMemberService } from './experience-member.service';
import type { ViewerReviewState } from './experience-member.service';
import { ExperienceJudgmentService } from './experience-judgment.service';
import type { ExperienceCheckInput } from './judgment/judgment-provider.interface';
import type {
  CreateExperienceDto,
  QueryExperienceDto,
  ReportExperienceFeedbackDto,
  ReviewExperienceQualityDto,
  UpdateExperienceDto,
} from './dto';

export { isAdmin };

/**
 * 归一化后的查询意图（service 内部形态；appliedFilters 与谓词构造共用一份）。
 *
 * 导出为**必需**（tsconfig `declaration: true`）：exported 函数的签名里出现非导出类型
 * 会直接编译失败。
 */
export interface NormalizedQuery {
  q?: string;
  signals?: string[];
  domains?: string[];
  envOs?: string;
  envTool?: string;
  envVersion?: string;
  envRuntime?: string;
  intent?: ExperienceIntent;
  quality?: ExperienceQuality;
  sourceProject?: string;
  /**
   * 录入者过滤（v1.81.0）：actor UUID 的**精确相等**。
   *
   * 语义要点：取值必须来自某条结果的 `createdById`（**不是名字**）——名字是运行时档案
   * 投影，改名/软删都会漂移，且不同 actor 可同名；DTO 的 `@IsUUID()` 拦格式错误。
   */
  createdById?: string;
  includeExpired: boolean;
  includeSuspect: boolean;
  sort?: ExperienceSort;
}

/**
 * 反馈改判的计数增量（三列 + last_helped_at 的显式状态迁移结果）。
 *
 * 导出为**必需**（tsconfig `declaration: true`）：它是导出函数 `feedbackDelta` 的返回类型。
 */
export interface FeedbackDelta {
  helped: number;
  notHelpful: number;
  distinctHelped: number;
  touchLastHelpedAt: boolean;
}

/**
 * 疑似重复候选的原始行形状（trgm 分数在 raw 列里，实体上没有该字段）。
 *
 * 键名 = `findDuplicateCandidates` 里**显式取的别名**（`id`/`title`/`quality`/`signals`）——
 * 若改回数组形态 `.select(['e.id'])`，raw key 会变成 `e_id` 而此处全部读到 undefined
 * （见文件头 EXPERIENCE-RAW-KEY-SHAPE）。
 */
interface DuplicateCandidateRow {
  id: string;
  title: string;
  quality: ExperienceQuality;
  signals: string[] | null;
  title_similarity: string | number | null;
}

/** Postgres 唯一约束冲突的形状（23505 + 约束名） */
interface PgUniqueViolation {
  code?: string;
  constraint?: string;
}

/**
 * 经验库服务。
 *
 * 分层（铁律 #21）：DTO 管**格式正确性**（类型/长度/词表/数组元素形状）；本服务管
 * **业务存在性与策略**（资源存在、作者判定、限流、密钥闸门、过期边界、归一化、计数）。
 */
@Injectable()
export class ExperienceService {
  private readonly logger = new Logger(ExperienceService.name);

  /**
   * 录入限流窗口：actorKey → 命中时刻（epoch ms）数组。
   *
   * ⚠️ 进程内内存（重启清零、不跨实例共享）：单实例部署前提下的明文取舍，见常量
   * `EXPERIENCE_CREATE_RATE_WINDOW_MS` 的 rationale。惰性清理：每次消费时先剔除
   * 窗口外时间戳，避免 Map 无界增长。
   */
  private readonly createQuota = new Map<string, number[]>();

  /**
   * 实际生效的录入限流阈值（构造期快照：env 覆盖 → 见 `resolveCreateRateLimit`）。
   *
   * 构造期读取（而非每次请求读 env）让"运行中改 env"不会静默改变配额语义；e2e 抬高
   * 阈值的写法因此必须在 app 引导前设置 env（照 USAGE_FLUSH_INTERVAL_MS 先例）。
   */
  private readonly createRateLimit: number = resolveCreateRateLimit();

  constructor(
    @InjectRepository(ExperienceEntry)
    private readonly entryRepo: Repository<ExperienceEntry>,
    @InjectRepository(ExperienceFeedback)
    private readonly feedbackRepo: Repository<ExperienceFeedback>,
    @InjectRepository(ExperienceSearchEvent)
    private readonly searchEventRepo: Repository<ExperienceSearchEvent>,
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly ownerProxy: OwnerProxyService,
    /**
     * 空间成员与终审资格（第二期批 2）：includeSuspect 放宽、详情 viewer 字段、终审端点
     * 三处共用它一份实现（服务端单源——三处各写一份判定就是三条漂移路径）。
     */
    private readonly members: ExperienceMemberService,
    /**
     * 录入者/终审者**名字解析**（v1.81.0）。
     *
     * 消费纪律（**N+1 防线**）：只在"需要投影名字"的三个方法里调用，且每次调用
     * 都先按 actorId 去重、**每页只调一次**（`search` 页内去重一次、
     * `findOne`/`update` 各一次解析 creator+verifiedBy 的并集）——逐条解析会让
     * 一页 50 条变成 50×(1~3) 次查询。
     */
    private readonly actorProfiles: ActorProfileService,
    /**
     * 判别服务（第二期批 3）：录入/内容改写后的判定调用与快照写。
     *
     * ⚠️ 调用点必须**在写事务提交之后**（判定含 8s 网络等待，持锁 await 网络调用会把慢
     * 判定放大成锁等待）。
     */
    private readonly judgments: ExperienceJudgmentService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // 写：录入
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 录入经验条目（POST /experiences）。
   *
   * 执行序（顺序有语义，勿随意调整）：
   * ① 归一化 → ② 密钥闸门/过期边界（400）→ ③ 幂等重放（命中即返回首次快照，不再消费
   * 配额、不再走闸门后的写路径）→ ④ 限流（429）→ ⑤ 疑似重复软提示 → ⑥ 事务写入
   * （条目 + 幂等记录同事务）→ ⑦ 缺「验证方式」节的软告警
   *
   * 为什么重放检查在限流之前：网络重试不该消耗配额（否则一次抖动就打掉窗口额度）。
   *
   * @param dto 已过 DTO 层格式校验的录入请求
   * @param actor 当前统一身份（guard 保证非 null；录入者恒取此处，不接受客户端自传）
   * @returns 新条目 id + 恒定 unverified + 软提示（possibleDuplicates/warnings）
   */
  async create(dto: CreateExperienceDto, actor: UnifiedActor): Promise<RecordExperienceResponse> {
    // 标题/摘要 trim 后判空（DTO 的 @Length(1,N) 拦不住纯空白串；见 assertNonBlank）
    const title = assertNonBlank(dto.title, 'title');
    const summary = assertNonBlank(dto.summary, 'summary');
    const signals = normalizeElements(dto.signals);
    const domains = normalizeElements(dto.domains ?? []);
    const env = normalizeEnv(dto.env);
    const sourceProject = dto.sourceProject?.trim() ? dto.sourceProject.trim() : null;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    // ② 写入面闸门（plan §3 威胁模型缓解）
    assertNoSecretPatterns(dto);
    assertExpiresAtInFuture(expiresAt);

    // ③ 幂等：payload 以**归一化后**的字面量对象构造（key 顺序 = 代码书写顺序 = 指纹稳定）
    const ctx = buildIdempotencyContext(
      EXPERIENCE_IDEMPOTENCY_ENTITY_TYPE,
      actor,
      dto.clientRequestId,
      {
        title,
        summary,
        content: dto.content,
        intent: dto.intent,
        signals,
        domains,
        env,
        sourceProject,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    );
    if (ctx) {
      const replay = await tryIdempotentReplay<RecordExperienceResponse>(this.idempotencyRepo, ctx);
      // 重放路径从快照列回填 judgment（不重判；见 replayWithJudgment 注释）
      if (replay) return this.replayWithJudgment(replay);
    }

    // ④ 按 actor 限流
    this.consumeCreateQuota(actor);

    // ⑤ 疑似重复软提示（不拒绝写入）
    const possibleDuplicates = await this.findDuplicateCandidates(title, signals);

    const payload: RecordExperienceResponse = {
      id: '',
      quality: EXPERIENCE_QUALITY.UNVERIFIED,
      ...(possibleDuplicates.length > 0 ? { possibleDuplicates } : {}),
      // ⑦ 只提示不拒绝（plan §3）
      ...(EXPERIENCE_VERIFICATION_SECTION_PATTERN.test(dto.content)
        ? {}
        : { warnings: [EXPERIENCE_MISSING_VERIFICATION_WARNING] }),
    };

    let entryId: string;
    let entryUpdatedAtText: string;
    try {
      const inserted = await this.dataSource.transaction(async (manager) => {
        const entry = manager.create(ExperienceEntry, {
          title,
          summary,
          content: dto.content,
          intent: dto.intent,
          signals,
          domains,
          env,
          sourceProject,
          expiresAt,
          // 录入恒 unverified（徽章洗白防线；客户端无从指定）
          quality: EXPERIENCE_QUALITY.UNVERIFIED,
          createdByType: actor.type,
          createdById: actor.id,
        });
        const saved = await manager.save(entry);
        if (ctx) {
          // 与业务写同事务：业务回滚则幂等记录消失（见 idempotency.helper 文件头）
          await insertIdempotencyInTx(manager, ctx, saved.id, { ...payload, id: saved.id });
        }
        // 版本守卫基准必须取**库内原文**（微秒精度）：JS Date 只有毫秒，SQL 等值比较永不命中
        // （e2e 实证：用 saved.updatedAt 会让快照写 100% 被守卫挡回）
        const [{ updated_at: updatedAtText }] = (await manager.query(
          'SELECT updated_at::text AS updated_at FROM experience_entries WHERE id = $1::uuid',
          [saved.id],
        )) as Array<{ updated_at: string }>;
        return { id: saved.id, updatedAtText };
      });
      entryId = inserted.id;
      entryUpdatedAtText = inserted.updatedAtText;
    } catch (err: unknown) {
      // 并发同 key 抢先（23505 uq_idempotency_actor_key）→ 事务已回滚 → 转重放语义
      if (ctx && isUniqueViolation(err, 'uq_idempotency_actor_key')) {
        const replay = await tryIdempotentReplay<RecordExperienceResponse>(
          this.idempotencyRepo,
          ctx,
        );
        if (replay) return this.replayWithJudgment(replay);
      }
      throw err;
    }

    // ⑧ 判别（plan §3.5）：**事务外**、响应之前完成——judgment 是录入响应的一个键。
    //    判定失败/被限流/provider 未启用都只是让这个键为 null，**绝不影响录入成功**。
    //    幂等重放刻意走不到这里（上面已 return）：重放从快照列回填，不重判。
    const judgment = await this.judgments.evaluateAndPersist({
      mode: 'create',
      entryId,
      actor,
      input: await this.buildJudgmentInput({
        title,
        summary,
        content: dto.content,
        signals,
        domains,
        env,
        intent: dto.intent,
        duplicateCandidates: possibleDuplicates.slice(0, EXPERIENCE_DUPLICATE_CANDIDATE_LIMIT),
      }),
      expectedUpdatedAtText: entryUpdatedAtText,
    });

    return { ...payload, id: entryId, judgment };
  }

  /**
   * 幂等重放的 judgment 回填（plan §3.5："同一逻辑请求两种响应形状消除"）。
   *
   * 重放**不重判**（否则同一 clientRequestId 的两次响应可能不一致，且白白多打一次模型）；
   * 改从快照列（`experience_entries.judgment`，`select: false` 列需显式 addSelect）读回来。
   *
   * @param replay 首次响应的快照（来自 idempotency_records.response_snapshot）
   * @returns 重放响应（带 idempotentReplay 标记 + 当前快照值）
   */
  private async replayWithJudgment(
    replay: RecordExperienceResponse,
  ): Promise<RecordExperienceResponse> {
    if (!replay.id) return { ...replay, idempotentReplay: true };
    const row = await this.entryRepo
      .createQueryBuilder('e')
      .addSelect('e.judgment')
      .where('e.id = :id', { id: replay.id })
      .getOne();
    return { ...replay, judgment: row?.judgment ?? null, idempotentReplay: true };
  }

  /**
   * 组装判定输入（service → provider 的**唯一**装配点）。
   *
   * `availableDomains` 走**当次查询口径**的开放词表（`fetchAvailableDomains` 同一实现）：
   * domainSuggestion 的建议值必须落在这个快照里，否则建议值在检索里根本命中不了
   * （白名单校验也会把它判成非法维度）。
   *
   * @param params 归一化后的条目字段 + 疑似重复候选
   * @returns `ExperienceCheckInput`
   */
  private async buildJudgmentInput(params: {
    title: string;
    summary: string;
    content: string;
    signals: string[];
    domains: string[];
    env: ExperienceEnv;
    intent: ExperienceIntent;
    duplicateCandidates: ExperienceDuplicateCandidate[];
  }): Promise<ExperienceCheckInput> {
    return {
      title: params.title,
      summary: params.summary,
      content: params.content,
      signals: params.signals,
      domains: params.domains,
      // env 是 jsonb（值开放），判定输入按字符串投影（provider 只把它当上下文文本）
      env: Object.fromEntries(Object.entries(params.env ?? {}).map(([k, v]) => [k, String(v)])),
      intent: params.intent,
      duplicateCandidates: params.duplicateCandidates.map((c) => ({
        id: c.id,
        title: c.title,
        quality: c.quality,
      })),
      availableDomains: await this.fetchAvailableDomains({
        includeExpired: false,
        includeSuspect: false,
      }),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 读：列表 / 检索
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 列表 + 检索合一（GET /experiences）。
   *
   * 无 q：`sort=recent`（updated_at DESC）或 `sort=most_used`（verified 层 →
   * distinct_helped_count → 新鲜度 → id）。有 q：融合打分排序（plan §3 明文：q 存在时
   * 排序由融合分接管）。
   *
   * 零命中是**成功态**（items 空 + hint + appliedFilters），不是错误——冷启动期零命中
   * 是常态，消费方应继续自己解决并把解法录进来。
   *
   * **名字解析（N+1 防线）**：页内 createdById ∪ verifiedBy 去重后**一次** `resolveProfiles`
   * （走 `resolveEntryProfiles`，与 findOne/update 同一个收口），再把 Map 传进投影——
   * 逐条解析会把一页 50 条放大成上百次查询。
   *
   * @param query 查询参数（DTO 已过层 1；includeSuspect 的 admin 判权在层 2 此处）
   * @param actor 当前统一身份（用于 includeSuspect 判权；不参与过滤）
   */
  async search(
    query: QueryExperienceDto,
    actor: UnifiedActor | null,
  ): Promise<ExperienceListResponse> {
    const filters = this.normalizeQuery(query);
    // 成员角色**仅**在需要判权时解析（plan §2.3 短路纪律：普通列表查询零额外查询）
    const memberRole = await this.resolveMemberRoleIfNeeded(filters, actor);
    assertSuspectAccessAllowed(filters, actor, memberRole);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? EXPERIENCE_DEFAULT_PAGE_SIZE;

    const qb = this.baseQuery('e', filters);
    this.applyFilters(qb, filters);
    this.applyOrder(qb, filters);

    const total = await countOf(qb);
    const { items, rawScores } = await this.fetchPage(qb, page, pageSize, Boolean(filters.q));

    // 零命中埋点（服务侧自落，fail-open；只记「真检索」，见 recordSearchEvent 注释）
    await this.recordSearchEvent(filters, total > 0, page);

    const availableDomains = await this.fetchAvailableDomains(filters);
    // 本页一次批量解析（N+1 防线；空页 → 空 Map，不发查询）
    const profiles = await this.resolveEntryProfiles(items);

    return {
      items: items.map((entry, index) =>
        this.toSummary(entry, filters, rawScores[index], profiles),
      ),
      total,
      page,
      pageSize,
      ...(total === 0 ? { hint: EXPERIENCE_ZERO_HIT_HINT } : {}),
      appliedFilters: buildAppliedFilters(filters),
      availableDomains,
    };
  }

  /**
   * 分面聚合（GET /experiences/facets）。
   *
   * 口径与列表**完全一致**（同一 baseQuery + 同一过滤谓词，只是不分页）——分面数字与
   * 列表 total 对不上是分面 UI 最常见的翻车点（shared DTO 的注释亦明文要求"与列表口径
   * 一致"）。
   *
   * `byIntent`/`byQuality` **键全量零填充**（未命中的取值计数 0）：分面是 web 固定面片
   * 的渲染源，缺键会让各页面自行兜底默认值、口径分裂（shared DTO 定型 Record 全键）。
   *
   * `byCreator`（v1.81.0）**刻意与上两者不同口径**：它是**开放维度 + 截断**——录入者集合
   * 无上界（每个新 actor 就是一个新键），键全量填充既不可能也无意义，故取 count DESC 的
   * top `EXPERIENCE_BY_CREATOR_LIMIT` 条 + `byCreatorTruncated` 截断信号。**服务端口径 =
   * 照常应用一切列表过滤**（facets 从来不是"不带过滤"：web 无参调用是客户端自律，
   * 不是服务端契约）——同参数的 byCreator 计数与列表 total 因此口径一致。
   *
   * @param query 同列表查询参数（includeSuspect 仍受 admin 判权约束）
   * @param actor 当前统一身份；**admin 才透出 suspectCount**（复核队列规模）
   */
  async facets(
    query: QueryExperienceDto,
    actor: UnifiedActor | null,
  ): Promise<ExperienceFacetsResponse> {
    const filters = this.normalizeQuery(query);
    // facets 例外（plan §2.3）：viewerIsReviewer 与 suspectCount 两个门都需要角色，
    // 故**每次必解析一次**（PK 单查成本可忽略；与 search 的短路纪律刻意不同，两条规则分写）
    const memberRole = await this.members.resolveMemberRole(actor?.id);
    const viewerIsReviewer = isAdmin(actor) || memberRole !== null;
    assertSuspectAccessAllowed(filters, actor, memberRole);

    const intentRows = await this.groupCount(filters, 'intent');
    const qualityRows = await this.groupCount(filters, 'quality');
    // byCreator：开放维度（top-N + 截断标记）；名字在方法内一次批量解析
    const creatorRows = await this.groupByCreator(filters);

    // 键全量零填充（词表单源 = shared）
    const byIntent = Object.fromEntries(
      EXPERIENCE_INTENTS.map((v) => [v, intentRows.get(v) ?? 0]),
    ) as Record<ExperienceIntent, number>;
    const byQuality = Object.fromEntries(
      EXPERIENCE_QUALITIES.map((v) => [v, qualityRows.get(v) ?? 0]),
    ) as Record<ExperienceQuality, number>;

    const total = [...intentRows.values()].reduce((sum, n) => sum + n, 0);
    const availableDomains = await this.fetchAvailableDomains(filters);

    const response: ExperienceFacetsResponse = {
      total,
      byIntent,
      byQuality,
      availableDomains,
      // 恒透出（无数据 = 空数组）：消费方不必区分"字段缺席"与"没有录入者"两种情况
      byCreator: creatorRows.items,
      byCreatorTruncated: creatorRows.truncated,
      // 角色级总览门（web sidebar 积压角标的渲染门；admin 天然 true）。
      // 与条目级 viewerCanReview 的粒度差异见 shared DTO 注释——勿互换。
      viewerIsReviewer,
    };

    // suspectCount：仅在**放开 suspect 排除**的口径上可数（默认查询里 suspect 被排除，
    // 直接数会恒为 0）；透出门 = admin ∪ space owner/reviewer（第二期放宽）。
    // 角标语义 = 全局 unverified 积压量（含我可审之外的），故它与 viewerIsReviewer 共门。
    if (viewerIsReviewer) {
      response.suspectCount = await this.countSuspects(filters);
    }
    return response;
  }

  /**
   * 条目详情（GET /experiences/:id）。
   *
   * **按 id 只过滤软删**：suspect 与已过期条目照常可见并带标记（复核/申诉动线，
   * plan §3 PM R1）——与列表的默认排除口径刻意不同，故此处不用 baseQuery。
   *
   * 第二期（plan §0/§2.2）：
   * - **viewer 字段**（`viewerCanReview`）由成员服务判定（服务端单源，web 不做任何
   *   成员计算）。自 v1.81.0 起它是**纯角色判定**（admin ∪ 空间 owner/reviewer）：
   *   禁自审四态退役，`viewerReviewBlockReason` 随之**停发**（消费方收 `undefined`）；
   * - **防锚定 suppression**：`viewerCanReview === true && quality !== 'verified'` ⇒
   *   `judgment = null` + `judgmentSuppressed = true`（reviewer 是 observe 期的 ground truth
   *   来源，终审前看到机器结论会污染翻案率）。终审后（quality=verified）恢复可见。
   *   ⚠️ 这是**服务端单点**：REST 详情与 MCP read 走同一路径，双通道自动一致。
   *   ⚠️ v1.81.0 的必然副作用（已写进线上文档）：四态退役后**作者本人也
   *   `viewerCanReview = true`**，故作者读自己未 verified 的条目时 judgment 同样被隐藏
   *   ——"作者如今也是潜在终审人"是同一规则的结果，不是 bug。
   *
   * `judgment` 列是 `select: false`（jsonb 大列，列表 getMany 不白 detoast）⇒ 本路径显式
   * `addSelect`。
   *
   * **名字解析**：单条也走 `resolveEntryProfiles`（creator ∪ verifiedBy 一次批量）——
   * 详情是高频路径，两个字段各查一次就是白多一次往返。
   *
   * @param id 条目 UUID（controller 已 ParseUUIDPipe）
   * @param actor 当前统一身份（可为 null：匿名/未知身份 → viewer 字段 false，不涉判权）
   * @throws NotFoundException 404/13000——message 指引"勿重试同 id，回 search"
   */
  async findOne(id: string, actor: UnifiedActor | null): Promise<ExperienceDetail> {
    const entry = await this.entryRepo
      .createQueryBuilder('e')
      .addSelect('e.judgment')
      .where('e.id = :id', { id })
      .getOne();
    if (!entry) throw experienceNotFound(id);

    const viewer = await this.members.evaluateReviewPermission(entry, actor);
    const profiles = await this.resolveEntryProfiles([entry]);
    return this.toDetail(entry, viewer, profiles);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 写：反馈（计数三列联动）
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 提交使用反馈（POST /experiences/:id/feedback）。
   *
   * 事务内流程（plan §1.2 不变量的执行点）：
   * ① `SELECT ... FOR UPDATE` 锁条目行 → 404（不存在/已软删）/ 409（已过期，反馈对
   *    过期条目没有意义）——行锁同时**串行化同一 entry 的并发反馈**，这是计数不丢的前提；
   * ② 幂等键预检（同 actor 同 key）：同 entry 同 outcome → 重放（零写入）；同 key 不同
   *    payload → 409/9002；
   * ③ 去重仲裁行查既有反馈 → 计算显式状态迁移增量；
   * ④ 单语句原子 UPDATE（三列 + last_helped_at）+ RETURNING → rowCount=0 即 13000；
   * ⑤ 写反馈行（新建 insert / 改判 update outcome）——与④同事务。
   *
   * @param id 条目 UUID
   * @param dto outcome + 必填幂等键
   * @param actor 反馈者（复用 ActorType；行唯一约束按 actor 去重）
   * @throws NotFoundException 404/13000 / ConflictException 409（过期或幂等冲突）
   */
  async recordFeedback(
    id: string,
    dto: ReportExperienceFeedbackDto,
    actor: UnifiedActor,
  ): Promise<ExperienceFeedbackResponse> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // ① 行锁 + 过期判定（raw SQL：需要 FOR UPDATE 与手写 deleted_at 谓词）
        const locked = (await manager.query(
          `SELECT id, expires_at, helped_count, not_helpful_count, distinct_helped_count
             FROM experience_entries
            WHERE id = $1 AND deleted_at IS NULL
              FOR UPDATE`,
          [id],
        )) as {
          id: string;
          expires_at: Date | null;
          helped_count: number;
          not_helpful_count: number;
          distinct_helped_count: number;
        }[];
        const entry = locked[0];
        if (!entry) throw experienceNotFound(id);
        if (entry.expires_at && new Date(entry.expires_at).getTime() <= Date.now()) {
          throw new ConflictException({
            message:
              `Experience entry '${id}' expired at ${new Date(entry.expires_at).toISOString()} — ` +
              'feedback on an expired entry is rejected (409). Do NOT retry: the entry is no longer ' +
              'current, so a verdict on it would mislead future readers. Search for a newer entry instead.',
            code: ErrorCode.RESOURCE_CONFLICT,
          });
        }

        const feedbackRepo = manager.getRepository(ExperienceFeedback);

        // ② 幂等键预检（uq_experience_feedback_actor_key）
        const sameKey = await feedbackRepo.findOne({
          where: { actorType: actor.type, actorId: actor.id, clientRequestId: dto.clientRequestId },
        });
        if (sameKey) {
          if (sameKey.experienceId !== id || sameKey.outcome !== dto.outcome) {
            throw idempotencyKeyConflict(dto.clientRequestId, actor.id);
          }
          // 同 key 同 payload → 重放（计数无变化，返回当前终值）
          return {
            experienceId: id,
            outcome: dto.outcome,
            helpedCount: Number(entry.helped_count),
            notHelpfulCount: Number(entry.not_helpful_count),
            distinctHelpedCount: Number(entry.distinct_helped_count),
            alreadyRecorded: true,
            idempotentReplay: true,
          } satisfies ExperienceFeedbackResponse;
        }

        // ③ 去重仲裁行（uq_experience_feedback_experience_actor）
        const existing = await feedbackRepo.findOne({
          where: { experienceId: id, actorType: actor.type, actorId: actor.id },
        });
        const delta = feedbackDelta(existing?.outcome, dto.outcome);

        // ④ 单语句原子 UPDATE（禁 repository.increment：会顶 updated_at）+ RETURNING。
        //    刻意**不更新 updated_at**：反馈不是内容编辑，顶了会让 sort=recent 被反馈
        //    刷屏（该列不进索引同源取舍）。
        //    ⚠️ UPDATE 的返回形状是 `[rows, affected]`（不是 INSERT 的纯 rows）——
        //    必须经 normalizeUpdateReturning 解包，否则计数全成 undefined→NaN→null
        //    （见该函数注释的实证踩坑）。
        const updated = normalizeUpdateReturning<{
          helped_count: number;
          not_helpful_count: number;
          distinct_helped_count: number;
        }>(
          await manager.query(
            `UPDATE experience_entries
                SET helped_count = helped_count + $2,
                    not_helpful_count = not_helpful_count + $3,
                    distinct_helped_count = distinct_helped_count + $4,
                    last_helped_at = CASE WHEN $5 THEN now() ELSE last_helped_at END
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING helped_count, not_helpful_count, distinct_helped_count`,
            [id, delta.helped, delta.notHelpful, delta.distinctHelped, delta.touchLastHelpedAt],
          ),
        );
        // rowCount=0（条目在锁定后被软删/硬删）→ 13000，绝不静默返回成功
        if (updated.length === 0) throw experienceNotFound(id);

        // ⑤ 反馈行（新建 / 改判）
        if (existing) {
          // **outcome 与 clientRequestId 一起更新**（M1 评审修订）：(entry, actor) 只有一个
          // 槽位，key 随**最新判决**走——若只改 outcome，新 key 永不落库，则该 key 的重放
          // 拿不到 `idempotentReplay`、换 outcome 再发不会 409（静默二次改判）、且同一 key
          // 还能被用到别的条目上（键空间失守）。双唯一的幂等分工因此只在首次判决成立。
          //
          // 旧 key 之后的重放语义（明文接受）：表里已无该 key → 落入"找不到 key → 去重仲裁
          // 行（同 entry+actor）"路径 → outcome 相同即零增量幂等（alreadyRecorded=true），
          // 不同则是**再次改判**（这是正确语义：旧 key 的请求方确实在表达一个新判决）。
          await feedbackRepo.update(
            { id: existing.id },
            { outcome: dto.outcome, clientRequestId: dto.clientRequestId },
          );
        } else {
          await feedbackRepo.insert({
            experienceId: id,
            actorType: actor.type,
            actorId: actor.id,
            outcome: dto.outcome,
            clientRequestId: dto.clientRequestId,
          });
        }

        const row = updated[0];
        return {
          experienceId: id,
          outcome: dto.outcome,
          helpedCount: Number(row.helped_count),
          notHelpfulCount: Number(row.not_helpful_count),
          distinctHelpedCount: Number(row.distinct_helped_count),
          ...(existing ? { alreadyRecorded: true } : {}),
        } satisfies ExperienceFeedbackResponse;
      });
    } catch (err: unknown) {
      // 同 actor 用同一 key 打**不同条目**的并发竞态（行锁分属不同条目，锁不住）→ 23505
      if (isUniqueViolation(err, 'uq_experience_feedback_actor_key')) {
        throw idempotencyKeyConflict(dto.clientRequestId, actor.id);
      }
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 写：编辑 / 终审 / 软删
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 编辑条目（PATCH /experiences/:id）。
   *
   * 四重语义（plan §3 + 评审修订）：
   * ① 作者判定 = admin ｜ creator ｜ owner 代理（OwnerProxyService）→ 否则 403/13001
   *    + 越权尝试审计插桩；
   * ② 乐观锁 `expectedUpdatedAt` 冲突 → 409（正确动作：**重读后**用新值重试）；
   * ③ **内容类字段（title/summary/content/signals）任一变化 → quality 回落 unverified
   *    并清 verified_by/at**（徽章洗白防线）；
   * ④ **密钥闸门与 create 同口径**（评审 M2）：否则"先录干净内容，再 PATCH 进凭据"就是
   *    写入面闸门的旁路。
   *
   * ⚠️ **乐观锁必须原子**（评审 M3）：`findOne` 比 token + 之后 `save` 是 TOCTOU 窗口——
   * 并发双写用同一 token 会**双双通过**、后写覆盖前写。故全程在**一个事务 + 行锁**
   * （`SELECT ... FOR UPDATE`）内完成：锁内复核 token（不符 409）→ 改值 → 写回。
   * 先例：doc-move.service 的事务内 pessimistic_write + 复核。
   *
   * @param id 条目 UUID
   * @param dto 可改字段 + 必填乐观锁基准
   * @param actor 当前统一身份
   */
  async update(
    id: string,
    dto: UpdateExperienceDto,
    actor: UnifiedActor,
  ): Promise<ExperienceDetail> {
    // 显式 null 守卫（评审 B1）：七个非清空字段传 null 一律 400——否则 null 会直通
    // service（`assertNonBlank(null)` TypeError / `normalizeElements(null)` not iterable /
    // content·intent 撞 NOT NULL）表现成 **500**，`env: null` 更会**静默清空**。
    // DTO 的 @ValidateIf 已拦同一空洞；此处是"任何调用方都拿到 4xx"的最终保险。
    assertNoNullNonNullableFields(dto as unknown as Record<string, unknown>);

    const { saved, before, contentChanged, updatedAtText } = await this.dataSource.transaction(
      async (manager) => {
        // ① 行锁 + 存在性：锁内读到的 updatedAt 就是本次写入的判定基准（无 TOCTOU）
        //    显式 addSelect `judgment`（select:false 的缓存列）：响应要原样带回快照，
        //    且批 3 的"判定后构造响应"以它为回填源
        const entry = await manager
          .getRepository(ExperienceEntry)
          .createQueryBuilder('e')
          .addSelect('e.judgment')
          .setLock('pessimistic_write')
          .where('e.id = :id', { id })
          .getOne();
        if (!entry) throw experienceNotFound(id);
        await this.assertCanWrite(entry, actor, 'update');

        // ② 乐观锁：必须与最近一次读到的 updatedAt 完全一致（**锁内**复核）
        const expected = new Date(dto.expectedUpdatedAt).getTime();
        const actual = new Date(entry.updatedAt).getTime();
        if (!Number.isFinite(expected) || expected !== actual) {
          throw new ConflictException({
            message:
              `Experience entry '${id}' was modified by someone else (expectedUpdatedAt mismatch). ` +
              'Re-read it (GET /experiences/:id) and retry with the fresh `updatedAt` — do NOT retry ' +
              'with the same token, it will keep failing. If you and another writer keep colliding, ' +
              'merge your edits into one request.',
            code: ErrorCode.RESOURCE_CONFLICT,
          });
        }

        const before_ = {
          title: entry.title,
          summary: entry.summary,
          content: entry.content,
          signals: entry.signals,
          quality: entry.quality,
          expiresAt: entry.expiresAt,
          sourceProject: entry.sourceProject,
        };

        // 内容类字段的变更判定在**归一化之后**做（否则 ['A'] → ['a'] 会被误判为"改了内容"，
        // 而它其实只是写法差异）
        let changed = false;
        if (dto.title !== undefined) {
          const title = assertNonBlank(dto.title, 'title');
          if (title !== entry.title) {
            entry.title = title;
            changed = true;
          }
        }
        if (dto.summary !== undefined) {
          const summary = assertNonBlank(dto.summary, 'summary');
          if (summary !== entry.summary) {
            entry.summary = summary;
            changed = true;
          }
        }
        if (dto.content !== undefined && dto.content !== entry.content) {
          entry.content = dto.content;
          changed = true;
        }
        if (dto.signals !== undefined) {
          const signals = normalizeElements(dto.signals);
          if (JSON.stringify(signals) !== JSON.stringify(entry.signals)) {
            entry.signals = signals;
            changed = true;
          }
        }
        // 元数据类字段（不触发 quality 回落，plan §3 逐字段列明）
        if (dto.intent !== undefined) entry.intent = dto.intent;
        if (dto.domains !== undefined) entry.domains = normalizeElements(dto.domains);
        if (dto.env !== undefined) entry.env = normalizeEnv(dto.env);
        if (dto.sourceProject !== undefined) {
          entry.sourceProject = dto.sourceProject?.trim() ? dto.sourceProject.trim() : null;
        }
        if (dto.expiresAt !== undefined) {
          const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
          assertExpiresAtInFuture(expiresAt);
          entry.expiresAt = expiresAt;
        }

        // ④ 密钥闸门（与 create 同口径）：对**合并后的新值**扫描——只在"本次请求触碰了
        //    受闸字段"时跑（纯元数据编辑不因历史遗留文本被拦），覆盖 title/summary/content/
        //    signals/domains/env/sourceProject 七个可写文本面
        assertNoSecretPatternsMerged(dto, entry);

        // ③ 内容改写 → 徽章回落（**suspect 粘性**，第二期 plan §0 治理修订）：
        //    - verified → unverified（并清 verified_by/at：徽章洗白防线不变）
        //    - **suspect 保持不变**：suspect 是终审人的治理动作（"这条可疑，待复核"），
        //      被审人不得通过编辑内容单方面撤销——只能由终审人走双向门改 verified。
        //      故回落条件从 "changed" 收窄为 "changed && quality === verified"。
        if (changed && entry.quality === EXPERIENCE_QUALITY.VERIFIED) {
          entry.quality = EXPERIENCE_QUALITY.UNVERIFIED;
          entry.verifiedBy = null;
          entry.verifiedAt = null;
        }

        const savedEntry = await manager.save(entry);
        // 版本守卫基准取库内原文（同上 create 的理由：JS 毫秒 vs PG 微秒）
        const [{ updated_at: updatedAtText }] = (await manager.query(
          'SELECT updated_at::text AS updated_at FROM experience_entries WHERE id = $1::uuid',
          [savedEntry.id],
        )) as Array<{ updated_at: string }>;
        return { saved: savedEntry, before: before_, contentChanged: changed, updatedAtText };
      },
    );

    // 审计在事务**成功之后**写：冲突（409）不该留下"已更新"的痕迹
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE,
      entityId: saved.id,
      actorId: actor.id,
      // 审计载荷只带字段名/质量变化，**永不带 content 正文**（不变量 #8）
      oldData: {
        quality: before.quality,
        expiresAt: before.expiresAt,
        sourceProject: before.sourceProject,
      },
      newData: {
        quality: saved.quality,
        expiresAt: saved.expiresAt,
        sourceProject: saved.sourceProject,
        contentRewritten: contentChanged,
        titleChanged: before.title !== saved.title,
        summaryChanged: before.summary !== saved.summary,
        contentChanged: before.content !== saved.content,
        signalsChanged: JSON.stringify(before.signals) !== JSON.stringify(saved.signals),
      },
      source: 'api',
    });

    // ⑧ 内容四字段变更才重判（plan §3.5）：纯元数据编辑（intent/domains/env/expiresAt/
    //    sourceProject）不重判——判定看的是"可复现性/信号质量"，元数据不改变这些结论。
    //    ⚠️ 在 update 事务**提交、行锁释放之后**执行（行锁内绝不 await 网络调用）；
    //    **响应等待判定完成**（PATCH 延迟 +1~3s 典型、8s 硬顶，写进 api-definition）：
    //    响应里的 judgment 与 updatedAt 必须与库内一致，客户端才敢立刻用新 token 再 PATCH。
    let judgment: ExperienceJudgment | null = saved.judgment ?? null;
    if (contentChanged) {
      judgment = await this.judgments.evaluateAndPersist({
        mode: 'update',
        entryId: saved.id,
        actor,
        input: await this.buildJudgmentInput({
          title: saved.title,
          summary: saved.summary,
          content: saved.content,
          signals: saved.signals,
          domains: saved.domains,
          env: saved.env,
          intent: saved.intent,
          duplicateCandidates: await this.findDuplicateCandidates(saved.title, saved.signals),
        }),
        // 版本守卫基准 = 本次 update 事务产出的 updatedAt 库内原文（快照写不触碰它，故与响应一致）
        expectedUpdatedAtText: updatedAtText,
      });
    }

    // 第二期：PATCH 响应与详情同形（viewer 字段含在内）——服务端单源判定，web 不做计算。
    // ⚠️ 判定在事务外做（成员/owner 查询不该占着行锁；行锁已在上面 release）。
    const viewer = await this.members.evaluateReviewPermission(saved, actor);
    // 名字解析同样在事务外：响应与详情同形的不变量包含 createdByName/verifiedByName
    // （漏掉就会让 PATCH 返回裸 UUID 而 GET 返回名字 —— 同形不变量当场破裂）
    const profiles = await this.resolveEntryProfiles([saved]);
    return this.toDetail(saved, viewer, profiles, judgment);
  }

  /**
   * 质量终审（PATCH /experiences/:id/quality）。
   *
   * 权限（第二期改造，plan §2.2）：端点守卫降为 `JwtOrApiKeyGuard` + **本方法内判定**
   * （admin 或空间 owner/reviewer），旧三元组已拆除——它对 agent 硬抛 1009，且"人类 admin
   * 专属"的语义已不成立。判定收口在 `ExperienceMemberService.assertCanReview`，自 v1.81.0
   * 起**只有一条拒绝路径**：无终审角色 → 403/13004（越权审计）。
   * 禁自审四态（旧 403/13002）已于 2026-09-24 整体退役——**持角色者可终审任意条目，
   * 含本人所录**；可疑内容走双向门打 `suspect`。
   *
   * 双向门：verified ↔ suspect 可互改；suspect 判定同样写 verified_by/at
   * （两列语义是"最近一次终审"而非"通过时刻"）。
   *
   * ⚠️ 首行身份守卫（防 `findOne({ id: undefined })` 认证绕过同族坑）：actor 缺失时
   * **连条目都不查**（单测钉住成员仓储零调用）。
   *
   * @param id 条目 UUID
   * @param dto verified/suspect + 必填理由
   * @param actor 终审人（人类 admin 或空间 owner/reviewer）
   */
  async reviewQuality(
    id: string,
    dto: ReviewExperienceQualityDto,
    actor: UnifiedActor,
  ): Promise<ExperienceQualityReviewResponse> {
    // 首行即拒（身份缺失时任何查询都无意义，也不该让 404/403 的差异成为存在性探针）
    this.members.assertReviewIdentity(actor);

    const entry = await this.entryRepo.findOne({ where: { id } });
    if (!entry) throw experienceNotFound(id);

    // 权威判定（纯角色判定）：无角色 → 13004 并写 denied 审计
    await this.members.assertCanReview(entry, actor);

    const oldQuality = entry.quality;
    entry.quality = dto.quality;
    entry.verifiedBy = actor.id;
    entry.verifiedAt = new Date();
    const saved = await this.entryRepo.save(entry);

    // audit 插桩：old→new + reason（plan §6）
    await this.auditService.log({
      action: AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE,
      entityId: saved.id,
      actorId: actor.id,
      oldData: { quality: oldQuality },
      newData: { quality: saved.quality, reason: dto.reason },
      source: 'api',
    });

    // 终审人名字（v1.81.0）：本响应的消费方是 MCP review_experience_quality——回显"谁盖的章"
    // 不该再让调用方补发一次详情请求。终审人恒 = 本次调用者（上一行刚写入 verifiedBy），
    // 故只解析一个 id；名字口径仍走同一份 ActorProfileService（agents.name 优先，与列表/详情一致）。
    const reviewerProfiles = await this.actorProfiles.resolveProfiles([actor.id]);

    return {
      id: saved.id,
      quality: saved.quality,
      verifiedBy: saved.verifiedBy,
      verifiedByName: reviewerProfiles.get(actor.id)?.name ?? null,
      verifiedAt: saved.verifiedAt,
    };
  }

  /**
   * 软删条目（DELETE /experiences/:id）。
   *
   * 软删对读写一律表现为 404（`deleted_at` 是 `select: false` 的内部状态，出口不泄露
   * 存在性）；恢复**刻意不设应用层 API**（admin 走 DB 人工窗口，attachment-gc 同款哲学）。
   *
   * @param id 条目 UUID
   * @param actor 当前统一身份（作者判定同 PATCH）
   */
  async remove(id: string, actor: UnifiedActor): Promise<void> {
    const entry = await this.entryRepo.findOne({ where: { id } });
    if (!entry) throw experienceNotFound(id);
    await this.assertCanWrite(entry, actor, 'delete');

    await this.entryRepo.softDelete(id);

    await this.auditService.log({
      action: AuditAction.DELETE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE,
      entityId: id,
      actorId: actor.id,
      // 只留可追溯的最小快照（标题是索引而非内容的依据；正文不入审计载荷）
      newData: { title: entry.title, quality: entry.quality, softDeleted: true },
      source: 'api',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 查询构造（收口点）
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 统一查询基底：**软删 + 过期 + suspect 排除**（plan §3）。
   *
   * 三处消费者（列表 / 分面 / availableDomains 词表）共用本方法——口径分叉（某处忘了
   * 排除 suspect）是这类模块最隐蔽的 bug。
   *
   * 豁免规则（**故意写成显式判断**）：
   * - `filters.quality === 'suspect'`：显式索要 suspect 时放开排除（复核/申诉动线，
   *   任何调用方可用——suspect 不是秘密，只是默认不进检索）；
   * - `filters.includeSuspect`：`admin ∪ 空间 owner/reviewer` 的总开关（判权在 search/facets
   *   入口完成，角色由 experience-member.service 解析）；
   * - `filters.includeExpired`：放开过期排除（普通读参数）。
   *
   * @param alias 查询别名（恒为 'e'，保留参数以支持组合查询）
   * @param filters 归一化后的查询意图
   */
  private baseQuery(alias: string, filters: NormalizedQuery): SelectQueryBuilder<ExperienceEntry> {
    const qb = this.entryRepo.createQueryBuilder(alias);
    // 软删排除：queryBuilder 不走 TypeORM 的 @DeleteDateColumn 自动过滤，必须手写
    qb.where(`${alias}.deleted_at IS NULL`);
    if (!filters.includeExpired) {
      qb.andWhere(`(${alias}.expires_at IS NULL OR ${alias}.expires_at > now())`);
    }
    const suspectAllowed = filters.includeSuspect || filters.quality === EXPERIENCE_QUALITY.SUSPECT;
    if (!suspectAllowed) {
      qb.andWhere(`${alias}.quality <> :suspectQuality`, {
        suspectQuality: EXPERIENCE_QUALITY.SUSPECT,
      });
    }
    return qb;
  }

  /**
   * 过滤谓词（全部 AND；数组参数内部是 ANY-overlap）。
   *
   * 查询形态钉死（plan §1.3）：数组用 `&&` overlap —— **禁 `= ANY`**（实测 Seq Scan，
   * GIN 完全用不上）；env 用 `->>` 精确相等（四条表达式 btree 各自的形态）；q 用
   * plainto_tsquery + 绑定参数（**禁字符串拼接**，ORDER BY 亦不拼接用户输入）。
   */
  private applyFilters(qb: SelectQueryBuilder<ExperienceEntry>, filters: NormalizedQuery): void {
    const p = (key: string, value: unknown) => qb.setParameter(key, value);

    if (filters.signals?.length) {
      qb.andWhere('e.signals && :signals');
      p('signals', filters.signals);
    }
    if (filters.domains?.length) {
      qb.andWhere('e.domains && :domains');
      p('domains', filters.domains);
    }
    if (filters.envOs !== undefined) {
      qb.andWhere("e.env->>'os' = :envOs");
      p('envOs', filters.envOs);
    }
    if (filters.envTool !== undefined) {
      qb.andWhere("e.env->>'tool' = :envTool");
      p('envTool', filters.envTool);
    }
    if (filters.envVersion !== undefined) {
      qb.andWhere("e.env->>'version' = :envVersion");
      p('envVersion', filters.envVersion);
    }
    if (filters.envRuntime !== undefined) {
      qb.andWhere("e.env->>'runtime' = :envRuntime");
      p('envRuntime', filters.envRuntime);
    }
    if (filters.intent !== undefined) {
      qb.andWhere('e.intent = :intent');
      p('intent', filters.intent);
    }
    if (filters.quality !== undefined) {
      qb.andWhere('e.quality = :quality');
      p('quality', filters.quality);
    }
    if (filters.sourceProject !== undefined) {
      qb.andWhere('e.source_project = :sourceProject');
      p('sourceProject', filters.sourceProject);
    }
    if (filters.createdById !== undefined) {
      // 录入者过滤：**精确相等**（列无索引 = 模块明文惯例，小表 seq scan 正确；
      // 与 sourceProject 同族，勿"顺手补索引"）
      qb.andWhere('e.created_by_id = :createdById');
      p('createdById', filters.createdById);
    }
    if (filters.q) {
      // q 是**过滤 + 排序**（plan §2）：低于分数下限的条目直接不进结果集
      qb.andWhere(`${SCORE_EXPRESSION} >= :scoreFloor`);
      p('q', filters.q);
      p('scoreFloor', EXPERIENCE_SCORE_FLOOR);
    }
  }

  /**
   * 排序（**ORDER BY 禁拼接用户输入**：排序键是白名单化的 SQL 片段）。
   *
   * - 有 q：融合分接管排序 —— verified 层 → 融合分 → distinct_helped_count → 新鲜度 → id
   *   （与迁移里的排序表达式索引同形，plan §1.3）；
   * - 无 q + most_used：verified 层 → distinct_helped_count → …；
   * - 无 q + recent（缺省）：updated_at DESC → id（**无索引 = 有意取舍**，plan §1.3；
   *   小表 seq scan 正确，勿"顺手补索引"）。
   *
   * 所有路径都以 `id ASC` 兜底：分页稳定性要求排序**全序**（否则同分条目在页间漂移）。
   */
  private applyOrder(qb: SelectQueryBuilder<ExperienceEntry>, filters: NormalizedQuery): void {
    if (filters.q) {
      // 融合分需要在 SELECT 里出现吗？不需要——PG 的 ORDER BY 可直接用表达式；
      // 但为了让响应能透出 score，fetchPage 会在有 q 时额外 select 该表达式。
      qb.orderBy(`(e.quality = 'verified')`, 'DESC')
        .addOrderBy(SCORE_EXPRESSION, 'DESC')
        .addOrderBy('e.distinct_helped_count', 'DESC')
        .addOrderBy('e.updated_at', 'DESC')
        .addOrderBy('e.id', 'ASC');
      return;
    }
    if (filters.sort === 'most_used') {
      qb.orderBy(`(e.quality = 'verified')`, 'DESC')
        .addOrderBy('e.distinct_helped_count', 'DESC')
        .addOrderBy('e.updated_at', 'DESC')
        .addOrderBy('e.id', 'ASC');
      return;
    }
    qb.orderBy('e.updated_at', 'DESC').addOrderBy('e.id', 'ASC');
  }

  /**
   * 取一页数据（有 q 时同时取原始融合分，供响应透出 `score`）。
   *
   * `getRawAndEntities` 的 raw 行与 entities 按索引一一对应（无 join，不存在笛卡尔放大）。
   */
  private async fetchPage(
    qb: SelectQueryBuilder<ExperienceEntry>,
    page: number,
    pageSize: number,
    withScore: boolean,
  ): Promise<{ items: ExperienceEntry[]; rawScores: (number | undefined)[] }> {
    qb.skip((page - 1) * pageSize).take(pageSize);
    if (!withScore) {
      const items = await qb.getMany();
      return { items, rawScores: items.map(() => undefined) };
    }
    qb.addSelect(SCORE_EXPRESSION, 'experience_score');
    const { entities, raw } = await qb.getRawAndEntities();
    const rawScores = (raw as Record<string, unknown>[]).map((row) =>
      row.experience_score === undefined || row.experience_score === null
        ? undefined
        : Number(row.experience_score),
    );
    return { items: entities, rawScores };
  }

  /** 按维度分组计数（分面用；同一 baseQuery + 同一过滤谓词，保证与列表口径一致） */
  private async groupCount(
    filters: NormalizedQuery,
    dimension: 'intent' | 'quality',
  ): Promise<Map<string, number>> {
    const qb = this.baseQuery('e', filters);
    this.applyFilters(qb, filters);
    const rows = (await qb
      .select(`e.${dimension}`, 'key')
      .addSelect('count(*)', 'count')
      .groupBy(`e.${dimension}`)
      .getRawMany()) as { key: string; count: string }[];
    return new Map(rows.map((row) => [row.key, Number(row.count)]));
  }

  /**
   * 按**录入者**分组计数（facets.byCreator，v1.81.0）。
   *
   * 与 `groupCount` 的口径差异是**刻意**的，勿"统一"：
   * - `intent`/`quality` 是**受控词表**（键全量零填充、无截断，消费方是固定面片）；
   * - 录入者是**开放维度**（actor 集合无上界）：键全量既不可能也无意义，故 top-N + 截断标记。
   *
   * 分组键 = `(created_by_id, created_by_type)`：`created_by_id` 无 FK 且可能指向已硬删的
   * actor（条目仍存活，usage-stats 先例）；带上 type 让响应元素自解释，消费方渲染类型
   * 小字时不必再查 actor。
   *
   * 排序 `count DESC, created_by_id ASC`：**必须全序**——同计数时若不兜底，top-N 的边界
   * 会随 PG 的执行计划漂移，同一份数据两次调用可能给出不同的 20 条（分面 UI 的"下拉
   * 选项跳变"就是这么来的）。
   *
   * 截断探针取 `LIMIT N+1`：多取一行即知"还有更多"，比再发一次 `count(DISTINCT ...)` 便宜。
   * raw 列**显式取别名**（raw key 形状踩坑见文件头 EXPERIENCE-RAW-KEY-SHAPE）。
   *
   * @param filters 归一化查询（与列表同一 baseQuery + 同一过滤谓词 ⇒ 口径一致）
   * @returns `{items, truncated}`；`truncated = true` 表示真实录入者数 > 上限
   */
  private async groupByCreator(
    filters: NormalizedQuery,
  ): Promise<{ items: ExperienceCreatorFacet[]; truncated: boolean }> {
    const qb = this.baseQuery('e', filters);
    this.applyFilters(qb, filters);
    const rows = (await qb
      .select('e.created_by_id', 'createdById')
      .addSelect('e.created_by_type', 'createdByType')
      .addSelect('count(*)', 'count')
      .groupBy('e.created_by_id')
      .addGroupBy('e.created_by_type')
      .orderBy('count', 'DESC')
      .addOrderBy('e.created_by_id', 'ASC')
      // 多取一条当"还有更多"的探针（只多一行，代价可忽略）
      .limit(EXPERIENCE_BY_CREATOR_LIMIT + 1)
      .getRawMany()) as {
      createdById: string;
      createdByType: ExperienceCreatorFacet['createdByType'];
      count: string;
    }[];

    const truncated = rows.length > EXPERIENCE_BY_CREATOR_LIMIT;
    const kept = truncated ? rows.slice(0, EXPERIENCE_BY_CREATOR_LIMIT) : rows;
    // 名字解析：top-N 内一次批量（禁 N+1；真孤儿不在 map 里 → null，不造兜底词）
    const profiles = await this.actorProfiles.resolveProfiles(kept.map((row) => row.createdById));

    return {
      truncated,
      items: kept.map((row) => {
        const profile = profiles.get(row.createdById);
        return {
          createdById: row.createdById,
          createdByType: row.createdByType,
          createdByName: profile?.name ?? null,
          createdByDeletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
          count: Number(row.count),
        };
      }),
    };
  }

  /**
   * suspect 计数（admin 复核队列规模）。
   *
   * 必须在**放开 suspect 排除**的口径上数：默认 baseQuery 已把 suspect 排除掉，直接数
   * 恒为 0（这正是"待终审积压量看 byQuality.unverified、suspect 队列看本字段"的分工）。
   */
  private async countSuspects(filters: NormalizedQuery): Promise<number> {
    const qb = this.baseQuery('e', { ...filters, includeSuspect: true });
    this.applyFilters(qb, { ...filters, includeSuspect: true });
    qb.andWhere('e.quality = :suspectQuality', { suspectQuality: EXPERIENCE_QUALITY.SUSPECT });
    return countOf(qb);
  }

  /**
   * 开放词表回显（`availableDomains`，按出现频次降序）。
   *
   * 语义：写入者枚举"已有领域标签"的**唯一通道**——开放词表的可用性取决于能不能看到
   * 别人用过什么（否则同一领域会裂成 devops / DevOps / 运维 三种写法）。走同一 baseQuery
   * + 同一过滤谓词，故它与当前结果集是同一口径。
   *
   * 实现要点（勿改成"另写一份 WHERE"）：谓词复用 `baseQuery()+applyFilters()` 生成的
   * SQL 片段作为**子查询**，再用 `unnest()` 展开数组列做 GROUP BY——过滤逻辑因此只有
   * 一处事实源（口径分叉是这类模块最隐蔽的 bug）；`LATERAL`/SRF 直接写在 FROM 里
   * TypeORM 的 queryBuilder 表达不了，故此处用 `getQueryAndParameters()` 取片段 +
   * `dataSource.query()` 外包一层（参数编号承接子查询的 $n）。
   */
  private async fetchAvailableDomains(filters: NormalizedQuery): Promise<string[]> {
    const base = this.baseQuery('e', filters);
    this.applyFilters(base, filters);
    // 收窄投影到 domains 单列：TypeORM 默认把实体列别名成 `e_<column>`，直接 unnest
    // `base.domains` 会撞 "column base.domains does not exist"（e2e 实证）；显式取别名
    // 后子查询列名恒为 `domains`，与外层 unnest 契约稳定
    base.select('e.domains', 'domains');
    const [sql, params] = base.getQueryAndParameters();
    const limitParam = `$${params.length + 1}`;
    const rows = (await this.dataSource.query(
      `SELECT d AS domain, count(*)::int AS count
         FROM (${sql}) AS base
         CROSS JOIN LATERAL unnest(base.domains) AS d
        GROUP BY d
        ORDER BY count DESC, d ASC
        LIMIT ${limitParam}`,
      [...params, EXPERIENCE_AVAILABLE_DOMAINS_LIMIT],
    )) as { domain: string; count: number }[];
    return rows.map((row) => row.domain);
  }

  /**
   * 疑似重复候选（**软提示，不拒绝写入**）。
   *
   * 命中条件（plan §3）：signals 交集 ≥1 **或** title 的 trgm 相似度 > 阈值。两条路径
   * 都返回 `signalsMatched` / `titleSimilarity`，让调用方自己判断该不该改走 read/update
   * （可解释性照 doc 搜索 boosts 先例）。
   *
   * 该查询在**写路径**上跑全表 trgm 打分：录入是低频写操作，代价可接受（plan §1.3 已
   * 论证 similarity() 不走索引且不该为此加 `%` 预过滤）。
   *
   * ⚠️ **每个实体列必须显式取别名**（`.select('e.id', 'id')` 而非 `.select(['e.id'])`）：
   * 数组形态的选择列表下 TypeORM 生成的 raw key 是 `<别名>_<蛇形列名>`（实测 `e_id`/
   * `e_title`/`e_quality`/`e_signals`），照 `row.id` 读会**静默拿到 undefined** →
   * 响应退化成 `[{}]`（与本批已修的 `base.domains` 子查询、UPDATE RETURNING 解包同根因，
   * 均为"raw/返回形状必须真库验证"）。见文件头 [持久踩坑]。
   */
  private async findDuplicateCandidates(
    title: string,
    signals: string[],
  ): Promise<ExperienceDuplicateCandidate[]> {
    const rows = (await this.entryRepo
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .addSelect('e.title', 'title')
      .addSelect('e.quality', 'quality')
      .addSelect('e.signals', 'signals')
      .addSelect('similarity(e.title, :title)', 'title_similarity')
      .where('e.deleted_at IS NULL')
      .andWhere('(e.signals && :signals OR similarity(e.title, :title) > :threshold)')
      .setParameters({
        title,
        signals,
        threshold: EXPERIENCE_DUPLICATE_TITLE_SIMILARITY,
      })
      .orderBy('title_similarity', 'DESC')
      .addOrderBy('e.updated_at', 'DESC')
      .limit(EXPERIENCE_DUPLICATE_CANDIDATE_LIMIT)
      .getRawMany()) as DuplicateCandidateRow[];

    return rows.map((row) => {
      const stored = row.signals ?? [];
      const matched = stored.filter((signal) => signals.includes(signal));
      const similarity = row.title_similarity === null ? 0 : Number(row.title_similarity);
      return {
        id: row.id,
        title: row.title,
        quality: row.quality,
        ...(matched.length > 0 ? { signalsMatched: matched } : {}),
        ...(similarity > EXPERIENCE_DUPLICATE_TITLE_SIMILARITY
          ? { titleSimilarity: similarity }
          : {}),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 零命中埋点 / 限流 / 作者判定
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 零命中埋点（`experience_search_events`，fail-open）。
   *
   * **记什么**：只记"真检索"——带 q 或至少一个过滤条件（`had_results` 两种口径都落，
   * 否则 4 周复查的零命中率 = 零结果行数/总行数 会退化成恒等于 1）；**且只在第 1 页记**
   * （同一检索翻页不该重复计数，否则分页会把分母灌水）。
   * 裸浏览（无 q 无过滤）不是检索，不记。
   *
   * `query_hash` 是**过滤指纹**而不是原查询串：q 可能含用户输入（甚至误贴的凭据片段），
   * 观测表不该成为第二个内容泄漏面。
   *
   * 失败只记日志（埋点是观测，绝不阻断检索）。
   */
  private async recordSearchEvent(
    filters: NormalizedQuery,
    hadResults: boolean,
    page: number,
  ): Promise<void> {
    if (page !== 1) return;
    if (!isActualSearch(filters)) return;
    try {
      await this.searchEventRepo.insert({
        queryHash: fingerprintFilters(filters),
        hadResults,
      });
    } catch (err) {
      this.logger.error(
        `Experience search-event write failed (fail-open, search unaffected): ${(err as Error).message}`,
      );
    }
  }

  /**
   * 消费一次录入配额（超限 → 429，文案带重试指引）。
   *
   * 窗口 = 进程内内存滑动窗口（惰性剔除过期时间戳）；见 `createQuota` 字段注释。
   *
   * @throws HttpException 429/`ErrorCode.RATE_LIMITED`——重试等待时长写进 message
   * （客户端据此退避；全局异常过滤器把 429 映射为同一分码）
   */
  private consumeCreateQuota(actor: UnifiedActor): void {
    const key = `${actor.type}:${actor.id}`;
    const now = Date.now();
    const windowStart = now - EXPERIENCE_CREATE_RATE_WINDOW_MS;
    const hits = (this.createQuota.get(key) ?? []).filter((t) => t > windowStart);
    if (hits.length >= this.createRateLimit) {
      const retryAfterMs = hits[0] + EXPERIENCE_CREATE_RATE_WINDOW_MS - now;
      this.createQuota.set(key, hits);
      throw new HttpException(
        {
          message:
            `Recording rate limit exceeded (${this.createRateLimit} entries per ` +
            `hour per actor). Retry in about ${Math.max(1, Math.ceil(retryAfterMs / 60000))} ` +
            'minute(s). Do NOT retry immediately — the window is rolling, and the limit exists to ' +
            'keep the shared experience base free of bulk noise.',
          code: ErrorCode.RATE_LIMITED,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    hits.push(now);
    this.createQuota.set(key, hits);
  }

  /**
   * 作者判定（PATCH/DELETE 共用）：admin ｜ creator ｜ owner 代理 → 通过；否则
   * 越权尝试审计插桩 + 403/13001。
   *
   * 判定顺序照 OwnerProxyService 的**性能短路纪律**：admin 与直接 creator 先短路，
   * 只有都是 false 且 actor 是 human 时才允许触发 agents 表查询（服务内部同样自带短路）。
   */
  private async assertCanWrite(
    entry: ExperienceEntry,
    actor: UnifiedActor,
    attempt: 'update' | 'delete',
  ): Promise<void> {
    if (isAdmin(actor)) return;
    if (entry.createdById === actor.id) return;
    if (await this.ownerProxy.isOwnerProxy(entry.createdById, actor)) return;

    // 越权尝试留痕（fail-open；plan §6 三插桩点之一）
    await this.auditService.log({
      action: attempt === 'delete' ? AuditAction.DELETE : AuditAction.UPDATE,
      entityType: AUDIT_ENTITY_TYPE.EXPERIENCE,
      entityId: entry.id,
      actorId: actor.id,
      newData: { denied: true, attempt, creatorId: entry.createdById },
      source: 'api',
    });

    throw new ForbiddenException({
      message:
        `Experience entry '${entry.id}' belongs to another creator — you may only edit or delete ` +
        "your own entries (admin and the creator's human owner are also allowed). Do NOT retry; " +
        'if the entry needs fixing, record your own version or ask an admin to review it ' +
        '(PATCH /experiences/:id/quality). 禁止重试：请走 admin 终审或录自己的条目',
      code: ErrorCode.EXPERIENCE_FORBIDDEN,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 投影
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 查询参数归一化（读侧对称于写侧）。
   *
   * 归一化点（plan §2）：signals/domains 元素 trim+lowercase（并去重）；env 值 trim+
   * lowercase；q trim（**纯空白视为未传**——否则会给 plainto_tsquery 一个空 tsquery，
   * 打分恒 0 而"零命中"看起来像 bug）。
   *
   * `createdById` 是 **UUID 精确相等**（不 lowercase、不造花样）：它是"按录入者筛选"的
   * 查询维度，取值必须来自某条结果的 `createdById`（**不是名字**——名字是运行时档案投影，
   * 改名/软删都会漂移，且不同 actor 可同名）。trim 只是防御查询串里的空白（`?createdById=%20<uuid>`），
   * 格式正确性由 DTO 的 `@IsUUID()` 兜住（铁律 #21 双层校验）。
   */
  private normalizeQuery(query: QueryExperienceDto): NormalizedQuery {
    const q = query.q?.trim();
    return {
      ...(q ? { q } : {}),
      ...(query.signals?.length ? { signals: normalizeElements(query.signals) } : {}),
      ...(query.domains?.length ? { domains: normalizeElements(query.domains) } : {}),
      ...(query.envOs?.trim() ? { envOs: query.envOs.trim().toLowerCase() } : {}),
      ...(query.envTool?.trim() ? { envTool: query.envTool.trim().toLowerCase() } : {}),
      ...(query.envVersion?.trim() ? { envVersion: query.envVersion.trim().toLowerCase() } : {}),
      ...(query.envRuntime?.trim() ? { envRuntime: query.envRuntime.trim().toLowerCase() } : {}),
      ...(query.intent !== undefined ? { intent: query.intent } : {}),
      ...(query.quality !== undefined ? { quality: query.quality } : {}),
      ...(query.sourceProject?.trim() ? { sourceProject: query.sourceProject.trim() } : {}),
      ...(query.createdById?.trim() ? { createdById: query.createdById.trim() } : {}),
      includeExpired: query.includeExpired === true,
      includeSuspect: query.includeSuspect === true,
      ...(query.sort !== undefined ? { sort: query.sort } : {}),
    };
  }

  /**
   * 一批条目的**归属人档案**解析（录入者 ∪ 终审者，去重后**一次**批量查询）。
   *
   * 为什么要一个收口方法：列表/详情/更新三条路径都要"creator + verifier"两族名字，
   * 各自拼 id 数组等于把同一道 N+1 防线写三遍（漏一处就是一次线上慢查询，且只在大页
   * 数据时才显形）。`resolveProfiles` 内部也去重，这里的 Set 价值在于空集合直接返回空 Map
   * ——**不发查询**（无录入者信息的路径零成本）。
   *
   * 真孤儿（actors 表查不到行）**不写进返回 Map**（ActorProfileService R12）：调用方一律
   * `?? null`，**不造 'Unknown' 兜底词**——兜底词会让"名字缺失"与"名字恰好叫这个"混淆，
   * 前端三态渲染（活/软删/孤儿）也无法区分。
   *
   * @param entries 本次响应要投影的条目（0~pageSize 条）
   * @returns actorId → ActorProfile（缺失 = 真孤儿）
   */
  private async resolveEntryProfiles(
    entries: readonly ExperienceEntry[],
  ): Promise<Map<string, ActorProfile>> {
    const ids = new Set<string>();
    for (const entry of entries) {
      ids.add(entry.createdById);
      // verifiedBy === null = 未终审：不进解析集合（避免把 null 塞进 IN 列表）
      if (entry.verifiedBy) ids.add(entry.verifiedBy);
    }
    return this.actorProfiles.resolveProfiles([...ids]);
  }

  /**
   * 列表投影（**不含 content 全文**）+ 命中可解释性（score / signalsMatched）
   * + 归属人**名字**（v1.81.0：裸 UUID 不再上屏）
   *
   * @param entry 条目实体
   * @param filters 归一化查询（用于 signalsMatched）
   * @param score 融合分（无 q 的列表排序不含此字段）
   * @param profiles 页内一次批量解析的 actor 档案——**必须由调用方经 `resolveEntryProfiles`
   *   取得**：本方法是纯投影，绝不自己查库（一页 50 条各自查就是 50 次查询）
   */
  private toSummary(
    entry: ExperienceEntry,
    filters: NormalizedQuery,
    score: number | undefined,
    profiles: Map<string, ActorProfile>,
  ): ExperienceSummary {
    const matched = filters.signals?.length
      ? entry.signals.filter((signal) => filters.signals!.includes(signal))
      : [];
    const creator = profiles.get(entry.createdById);
    const verifier = entry.verifiedBy ? profiles.get(entry.verifiedBy) : undefined;
    return {
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      intent: entry.intent,
      quality: entry.quality,
      signals: entry.signals,
      domains: entry.domains,
      env: entry.env,
      helpedCount: entry.helpedCount,
      notHelpfulCount: entry.notHelpfulCount,
      distinctHelpedCount: entry.distinctHelpedCount,
      lastHelpedAt: entry.lastHelpedAt,
      sourceProject: entry.sourceProject,
      expiresAt: entry.expiresAt,
      // 派生标记：默认查询已排除过期条目，故为 true 只可能是 includeExpired=true 的结果
      expired: isExpired(entry),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      // 录入者归属（v1.81.0 补名）：createdById/createdByType 是**查询维度**（按录入者
      // 筛选要传 UUID），三件套才是**展示维度**。
      // name 为 null 的语义 = actor 行已硬删；`createdByDeletedAt` 非 null 而 name 有值
      // = 软删但真名仍在 → 永远渲染名字，**不回退裸 UUID**（照统一批 deleted-actor 呈现契约）
      createdById: entry.createdById,
      createdByType: entry.createdByType,
      createdByName: creator?.name ?? null,
      createdByAvatarUrl: creator?.avatarUrl ?? null,
      createdByDeletedAt: creator?.deletedAt ? creator.deletedAt.toISOString() : null,
      // 终审人名字列表也透出：翻案复核时"谁盖的章"要能直接看见，不必先点进详情
      verifiedByName: verifier?.name ?? null,
      ...(score !== undefined ? { score } : {}),
      ...(matched.length > 0 ? { signalsMatched: matched } : {}),
    };
  }

  /**
   * 详情投影（列表投影 + 正文 + 溯源字段 + 第二期 viewer/判别字段）。
   *
   * 防锚定 suppression（plan §0，**服务端单点**）：`viewerCanReview === true` 且
   * `quality !== 'verified'`（含 suspect 复核场景）时把 `judgment` 置 null 并置
   * `judgmentSuppressed = true` —— reviewer 是 observe 期的 ground truth 来源，
   * 终审前看到机器初评结论会污染翻案率度量；终审后（quality=verified）恢复可见供对照。
   *
   * judgment 取值：`entry.judgment` 仅在调用方 `addSelect('e.judgment')` 时才存在
   * （`select: false` 列）；未 select（undefined）与"无快照"（null）在本投影里同义
   * ——两者都表示"没有可展示的判别结果"，消费方按 null 处理。
   *
   * ⚠️ **`viewerReviewBlockReason` 已停发**（v1.81.0 四态退役，见方法尾注释）：刻意不补
   * 一个恒 null 的兼容字段——消费方会继续按旧语义分支，渲染出已不存在的禁用态。
   *
   * @param entry 条目实体（判权所需字段：quality；suppression 用）
   * @param viewer 成员服务给出的终审资格结论（服务端单源）
   * @param profiles 归属人档案（同 toSummary 的 N+1 纪律，由调用方一次解析后传入）
   * @param judgmentOverride 显式指定的判定快照（**PATCH 路径**用：本次判定的新值，或失败时的
   *   null）。缺省（详情读路径）走 `entry.judgment`——该列 `select: false`，调用方必须已
   *   `addSelect('e.judgment')`，否则读到 undefined（与"无快照"同义，见下方注释）。
   */
  private toDetail(
    entry: ExperienceEntry,
    viewer: ViewerReviewState,
    profiles: Map<string, ActorProfile>,
    judgmentOverride?: ExperienceJudgment | null,
  ): ExperienceDetail {
    const suppressed = viewer.canReview && entry.quality !== EXPERIENCE_QUALITY.VERIFIED;
    const judgment = judgmentOverride === undefined ? (entry.judgment ?? null) : judgmentOverride;
    const verifier = entry.verifiedBy ? profiles.get(entry.verifiedBy) : undefined;
    return {
      ...this.toSummary(entry, { includeExpired: true, includeSuspect: true }, undefined, profiles),
      content: entry.content,
      createdByType: entry.createdByType,
      createdById: entry.createdById,
      verifiedBy: entry.verifiedBy,
      // name + deletedAt **成对**透出（照 audit/task 先例）：徽章溯源要能回答
      // "谁在什么时候盖的章"，而软删的终审人仍需可归因
      verifiedByName: verifier?.name ?? null,
      verifiedByDeletedAt: verifier?.deletedAt ? verifier.deletedAt.toISOString() : null,
      verifiedAt: entry.verifiedAt,
      // 被 suppression 时恒 null（防锚定主防线）；否则原样透出快照（可空）
      judgment: suppressed ? null : judgment,
      judgmentSuppressed: suppressed,
      viewerCanReview: viewer.canReview,
    };
  }

  /**
   * 按调用场景解析成员角色（plan §2.3 的**短路纪律**，供 list/search 路径）。
   *
   * 只在"确实要判 includeSuspect"且调用者不是 admin 时查一次成员表；其余情况零查询
   * （普通列表/检索是高频路径，不该为每次请求多付一次 PK 查询）。facets 不走本方法
   * ——它需要 viewerIsReviewer，每次必解析（两条规则刻意分写）。
   *
   * @param filters 归一化查询（只看 includeSuspect）
   * @param actor 当前身份（null/未认证 → null）
   * @returns 成员角色或 null（未解析时为 null）
   */
  private async resolveMemberRoleIfNeeded(
    filters: NormalizedQuery,
    actor: UnifiedActor | null,
  ): Promise<ExperienceMemberRole | null> {
    if (!filters.includeSuspect || isAdmin(actor)) return null;
    return this.members.resolveMemberRole(actor?.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 模块级纯函数（无依赖，便于单测直接覆盖）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 融合打分 SQL 表达式（**ORDER BY / WHERE / SELECT 三处共用同一字符串**）。
 *
 * 权重来自常量单源（`EXPERIENCE_RANK_WEIGHTS`）；`q` 恒以绑定参数传入
 * （`:q`）——**禁把用户输入拼进 SQL**。表达式与迁移里的排序索引同形，便于 PG 复用。
 */
const SCORE_EXPRESSION =
  `(ts_rank(e.search_vector, plainto_tsquery('simple', :q)) * ${EXPERIENCE_RANK_WEIGHTS.TS_RANK}` +
  ` + similarity(e.content, :q) * ${EXPERIENCE_RANK_WEIGHTS.TRGM_CONTENT}` +
  ` + similarity(e.title, :q) * ${EXPERIENCE_RANK_WEIGHTS.TRGM_TITLE})`;

/**
 * 数组归一化：trim + lowercase + 去重（保持首次出现顺序）。
 *
 * 去重 rationale：`['ECONNREFUSED','econnrefused']` 归一后是同一个信号，存两遍会让
 * ANY-overlap 语义与"signal 数"统计都被虚增；顺序保留让响应可读且稳定。
 */
export function normalizeElements(elements: readonly string[] | null | undefined): string[] {
  // 防御：非数组输入返回空数组而不是抛 TypeError（评审 B1 的 double 保险——真正的
  // 闸门是 DTO 的 @ValidateIf 与 update() 的 assertNoNullNonNullableFields）
  if (!Array.isArray(elements)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const element of elements) {
    const normalized = element.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * env 归一化：只保留白名单键（键受控）、值 trim+lowercase、丢弃空值。
 *
 * 键按 `EXPERIENCE_ENV_KEYS` 声明序输出（对象键序稳定 → 幂等指纹稳定）。
 */
export function normalizeEnv(env: ExperienceEnv | undefined): ExperienceEnv {
  const out: ExperienceEnv = {};
  if (!env) return out;
  for (const key of EXPERIENCE_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== 'string') continue;
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 密钥闸门的**扫描集合**（create 与 PATCH 共用一处，防两处漏字段）。
 *
 * 覆盖全部可写文本面：title / summary / content / signals 元素 / domains 元素 /
 * sourceProject / env 值。
 */
function scanTextForSecrets(texts: readonly (string | null | undefined)[]): void {
  const haystack = texts.filter((t): t is string => typeof t === 'string').join('\n');
  const hitIndex = EXPERIENCE_SECRET_PATTERNS.findIndex((pattern) => pattern.test(haystack));
  if (hitIndex === -1) return;
  throw new BadRequestException({
    message:
      `The entry looks like it contains a credential (matched pattern #${hitIndex + 1} of ` +
      `${EXPERIENCE_SECRET_PATTERNS.length}: API key / private key / password assignment). ` +
      'The experience base is readable by EVERY authenticated actor across projects, so secrets ' +
      'must never be recorded here. Redact the value (e.g. `password=<redacted>`) and resend. ' +
      '禁止录入密钥或 PII——请脱敏后重发',
    code: ErrorCode.VALIDATION_ERROR,
  });
}

/**
 * 密钥闸门（plan §3，**录入通道**）：命中任一模式即 400 拒绝写入。
 *
 * ⚠️ message **不回显命中位置的内容**（不变量 #8）——只说命中了哪一类模式，否则 400
 * 响应本身就成了密钥回显通道（比日志泄漏更糟：它会被客户端记录）。
 */
export function assertNoSecretPatterns(dto: {
  title: string;
  summary: string;
  content: string;
  signals: string[];
  domains?: string[];
  sourceProject?: string;
  env?: ExperienceEnv;
}): void {
  scanTextForSecrets([
    dto.title,
    dto.summary,
    dto.content,
    ...dto.signals,
    ...(dto.domains ?? []),
    dto.sourceProject ?? '',
    ...Object.values(dto.env ?? {}),
  ]);
}

/** PATCH 的受闸字段判定（这些字段任一出现在请求体里 ⇒ 需要跑密钥闸门） */
function touchesSecretGatedField(dto: {
  title?: unknown;
  summary?: unknown;
  content?: unknown;
  signals?: unknown;
  domains?: unknown;
  env?: unknown;
  sourceProject?: unknown;
}): boolean {
  return (
    dto.title !== undefined ||
    dto.summary !== undefined ||
    dto.content !== undefined ||
    dto.signals !== undefined ||
    dto.domains !== undefined ||
    dto.env !== undefined ||
    dto.sourceProject !== undefined
  );
}

/**
 * 密钥闸门（**编辑通道**，评审 M2）：对**合并后的新值**扫描。
 *
 * 为什么必须有：没有它，"先录干净内容 → 再 PATCH 塞进凭据"就是写入面闸门的完整旁路
 * （create 拦得住、update 拦不住 = 闸门形同虚设）。
 *
 * 何时跑：仅当请求体触碰了任一受闸字段（title/summary/content/signals/domains/env/
 * sourceProject）——纯元数据编辑（intent/expiresAt）不因历史遗留文本被拦。
 *
 * ⚠️ 调用点必须**在字段合并之后**（此时入参就是最终落库值），不要传 DTO 原值——
 * 只改了一部分字段时，未改字段的旧值同样要参与扫描。
 */
export function assertNoSecretPatternsMerged(
  dto: Parameters<typeof touchesSecretGatedField>[0],
  merged: {
    title: string;
    summary: string;
    content: string;
    signals: string[];
    domains: string[];
    sourceProject: string | null;
    env: ExperienceEnv;
  },
): void {
  if (!touchesSecretGatedField(dto)) return;
  scanTextForSecrets([
    merged.title,
    merged.summary,
    merged.content,
    ...merged.signals,
    ...merged.domains,
    merged.sourceProject ?? '',
    ...Object.values(merged.env ?? {}),
  ]);
}

/** update 通道的**非清空**字段：显式 null 一律拒绝（只有 sourceProject/expiresAt 可 null 清空） */
const UPDATE_NON_NULLABLE_FIELDS = [
  'title',
  'summary',
  'content',
  'intent',
  'signals',
  'domains',
  'env',
] as const;

/**
 * 显式 null 守卫（评审 B1）——update 通道的七个非清空字段。
 *
 * 为什么必须有：`null` 在 JSON 里是合法值，任何消费者（MCP 工具、web、脚本）都可能
 * 顺手传 null；放行它会让 service 内部以 TypeError / NOT NULL 违约的形式炸成 **500**，
 * 而 `env: null` 则被 `normalizeEnv` 静默当"空对象"**清空**（与"只有 sourceProject/
 * expiresAt 支持 null 清空"的口径矛盾）。正确语义是 400 + 指引"省略该键"。
 *
 * 与 DTO `@ValidateIf((_, v) => v !== undefined)` 是同一空洞的两层防御（铁律 #21）。
 */
export function assertNoNullNonNullableFields(dto: Record<string, unknown>): void {
  const offenders = UPDATE_NON_NULLABLE_FIELDS.filter((field) => dto[field] === null);
  if (offenders.length === 0) return;
  throw new BadRequestException({
    message:
      `Field(s) ${offenders.join(', ')} do not accept an explicit null. Only ` +
      '`sourceProject` and `expiresAt` are nullable (null = clear the value); to leave any other ' +
      'field unchanged, OMIT the key entirely. Sending null here would either fail validation or ' +
      'silently wipe the field. 仅 sourceProject/expiresAt 支持 null 清空，其余字段请省略该键',
    code: ErrorCode.VALIDATION_ERROR,
  });
}

/**
 * 非空白断言（title/summary 用；评审 m3）。
 *
 * 为什么需要：DTO 的 `@Length(1, N)` 只保证"至少 1 个字符"，纯空白串（`'   '`）能过校验，
 * 但 service 会把它 `trim()` 成空串**落库**——库里出现空标题/空摘要，而列表投影恰恰
 * 以摘要为唯一依据（空摘要 = 列表里一行无法判断内容的记录）。口径与 signals 元素一致：
 * trim 后必须有内容。返回 trim 后的值（调用方直接使用，避免二次 trim）。
 */
export function assertNonBlank(value: unknown, field: string): string {
  // 非字符串（含显式 null）→ 400 而不是 `null.trim()` 的 TypeError→500（评审 B1 的
  // double 保险；DTO 层已用 @ValidateIf 拦同一空洞，此处保证任何调用方都拿到 4xx）
  if (typeof value !== 'string') {
    throw new BadRequestException({
      message:
        `${field} must be a string (received ${value === null ? 'null' : typeof value}). ` +
        'Omit the key to leave the field unchanged.',
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException({
      message:
        `${field} must not be blank: a whitespace-only value passes length validation but would be ` +
        'stored as an empty string, leaving the entry unidentifiable in list views. Send real text ' +
        `(the ${field} is trimmed before storing). ${field} 不允许纯空白`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  return trimmed;
}

/** 过期边界校验：写了 expiresAt 就必须在**未来**（过去时间等于录进来即失效） */
export function assertExpiresAtInFuture(expiresAt: Date | null): void {
  if (!expiresAt) return;
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new BadRequestException({
      message:
        'expiresAt must be in the future (a past timestamp would make the entry expire the moment ' +
        'it is recorded). Pass a future ISO 8601 timestamp, or omit the field for a never-expiring entry.',
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
}

/**
 * includeSuspect 的终审角色判权（第二期放宽：admin ∪ 空间 owner/reviewer）。
 *
 * 调用方纪律（plan §2.3）：
 * - **list/search 路径**：仅在 `filters.includeSuspect` 为真时才解析成员角色（短路——普通
 *   列表查询不该为每次请求多付一次 PK 查询）；
 * - **facets 路径例外**：facets 需要 `viewerIsReviewer` 与 suspectCount 两个门，memberRole
 *   每次必解析一次（措辞分写，两条规则不矛盾）。
 *
 * 非授权 → 403/**13004**（不静默忽略该参数：静默忽略会让调用方把过滤后的结果当成全量）。
 * 1009 在经验模块的 includeSuspect / 终审两处已下线（见 shared ErrorCode 注释）。
 *
 * @param filters 归一化查询（只看 includeSuspect）
 * @param actor 当前身份
 * @param memberRole 调用者的空间成员角色（由调用方按上述纪律解析后传入；admin 可传 null）
 */
export function assertSuspectAccessAllowed(
  filters: NormalizedQuery,
  actor: UnifiedActor | null,
  memberRole: ExperienceMemberRole | null,
): void {
  if (!filters.includeSuspect) return;
  if (isAdmin(actor) || memberRole !== null) return;
  throw new ForbiddenException({
    message:
      'includeSuspect requires a human admin or an experience space owner/reviewer role (it ' +
      'exposes the moderation queue). It is rejected rather than silently ignored so callers never ' +
      'mistake a filtered result for a complete one. Check GET /experiences/members to see who ' +
      'can, or ask an admin to grant you the role. Anyone can still reach a specific suspect entry ' +
      'by asking for it explicitly (`quality=suspect`) or by reading its detail. ' +
      '需要 admin 或空间 owner/reviewer；成员清单见 GET /experiences/members',
    code: ErrorCode.EXPERIENCE_REVIEW_FORBIDDEN,
  });
}

/**
 * 反馈改判的显式状态迁移（三列增量 + last_helped_at 是否推进）。
 *
 * 状态机（plan §1.2 不变量）：
 * - 无既有反馈：helped → helped+1 & distinct+1；not_helpful → not_helpful+1；
 * - 同 outcome：零增量（幂等，**不重复累加**）；
 * - helped → not_helpful：helped−1 & not_helpful+1 & distinct−1；
 * - not_helpful → helped：helped+1 & not_helpful−1 & distinct+1。
 *
 * 非负性由状态机保证（distinct 只在"新增 helped"与"helped 被改判掉"两处动 ±1）。
 */
export function feedbackDelta(
  previous: ExperienceFeedbackOutcome | undefined,
  next: ExperienceFeedbackOutcome,
): FeedbackDelta {
  const helped = EXPERIENCE_FEEDBACK_OUTCOME.HELPED;
  if (previous === undefined) {
    return next === helped
      ? { helped: 1, notHelpful: 0, distinctHelped: 1, touchLastHelpedAt: true }
      : { helped: 0, notHelpful: 1, distinctHelped: 0, touchLastHelpedAt: false };
  }
  if (previous === next) {
    return { helped: 0, notHelpful: 0, distinctHelped: 0, touchLastHelpedAt: false };
  }
  return next === helped
    ? { helped: 1, notHelpful: -1, distinctHelped: 1, touchLastHelpedAt: true }
    : { helped: -1, notHelpful: 1, distinctHelped: -1, touchLastHelpedAt: false };
}

/** 404/13000（message 指引"勿重试同 id，回 search"） */
export function experienceNotFound(id: string): NotFoundException {
  return new NotFoundException({
    message:
      `Experience entry '${id}' not found. It may never have existed, or it may have been ` +
      'soft-deleted — either way the response is identical by design. Do NOT retry the same id ' +
      '(it will keep failing); go back to search (GET /experiences or MCP search_experiences) ' +
      'and pick a fresh id. 勿重试同 id，请回 search',
    code: ErrorCode.EXPERIENCE_NOT_FOUND,
  });
}

/** 409/9002（复用现成分码：同幂等键不同 payload） */
export function idempotencyKeyConflict(
  clientRequestId: string,
  actorId: string,
): ConflictException {
  return new ConflictException({
    message:
      `clientRequestId '${clientRequestId}' was already used by a different feedback request from ` +
      `actor '${actorId}' (entityType=experience_feedback, requestHash mismatch). Do NOT retry — ` +
      'the first request already took effect. To change your verdict, send a NEW key with the new ' +
      'outcome (that is a re-judgement, 改判).',
    code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
  });
}

/** 唯一约束冲突判定（Postgres 23505 + 约束名） */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgErr = err as PgUniqueViolation;
  return pgErr?.code === '23505' && pgErr?.constraint === constraint;
}

/**
 * 归一 TypeORM 对 `UPDATE ... RETURNING` 的返回形状。
 *
 * ⚠️ **实证踩坑**（经验库 e2e 抓到，TypeORM 0.3.30 实测）：`manager.query()` 对 INSERT 返回
 * 纯 rows，但对 **UPDATE/DELETE** 返回 `[rows, affectedCount]`——即 `result[0]` 是**行数组**、
 * `result[1]` 是影响行数。照 INSERT 的习惯写 `rows[0].helped_count` 会**静默**拿到
 * `undefined`（`Number(undefined)` → NaN → JSON `null`）：库里的三列其实是对的，返回给
 * 消费者的却是 null，而 `rowCount=0 → 13000` 的判定也会失效（`[[], 0].length === 2` 恒非 0）。
 *
 * 两种形状都归一到行数组：`[[rows], n]` → rows；`[rows]` → rows。
 */
export function normalizeUpdateReturning<T>(raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > 0 && Array.isArray(raw[0])) return raw[0] as unknown as T[];
  return raw as T[];
}

/** 过期判定（派生标记；`expiresAt` 为 null 恒未过期） */
export function isExpired(entry: { expiresAt: Date | null }): boolean {
  return !!entry.expiresAt && new Date(entry.expiresAt).getTime() <= Date.now();
}

/** 是否属于"真检索"（埋点门槛：带 q 或至少一个过滤条件；裸浏览不记） */
export function isActualSearch(filters: NormalizedQuery): boolean {
  return Boolean(
    filters.q ||
    filters.signals?.length ||
    filters.domains?.length ||
    filters.envOs !== undefined ||
    filters.envTool !== undefined ||
    filters.envVersion !== undefined ||
    filters.envRuntime !== undefined ||
    filters.intent !== undefined ||
    filters.quality !== undefined ||
    filters.sourceProject !== undefined ||
    // createdById 是**真过滤条件**（v1.81.0）：按录入者切片属于检索行为，
    // 必须计入埋点门槛——漏计会让"按录入者检索"的零命中率永远不进观测
    filters.createdById !== undefined,
  );
}

/**
 * 过滤指纹（sha256 hex，64 字符）：键序固定 → 同一组过滤条件恒得同一指纹。
 *
 * 只含**生效的过滤条件**（不含分页/排序：同一检索翻页属同一次检索；排序不影响
 * "有没有结果"这一事实）。
 *
 * ⚠️ **新增过滤维度必须同时改本函数与 `isActualSearch`**（两者是"哪些参数算过滤"的
 * 同一份清单的两处投影）：漏改 = 埋点要么漏记新维度、要么把不同检索算成同一指纹。
 * 键序只在**同一版本内**保证同一组过滤恒得同一指纹——新增维度（无论插在哪）必然改变
 * 全部历史指纹，零命中分组口径会在部署点切分一次，这是已知且可接受的（4 周复查看趋势不看绝对值）。
 */
export function fingerprintFilters(filters: NormalizedQuery): string {
  const canonical = {
    q: filters.q ?? null,
    signals: filters.signals ?? null,
    domains: filters.domains ?? null,
    envOs: filters.envOs ?? null,
    envTool: filters.envTool ?? null,
    envVersion: filters.envVersion ?? null,
    envRuntime: filters.envRuntime ?? null,
    intent: filters.intent ?? null,
    quality: filters.quality ?? null,
    sourceProject: filters.sourceProject ?? null,
    includeExpired: filters.includeExpired,
    // v1.81.0 追加在末尾（见上方"键序即契约"）
    createdById: filters.createdById ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** 生效过滤回显（多层过滤叠加下让调用方确认服务端实际采纳了什么） */
export function buildAppliedFilters(filters: NormalizedQuery): ExperienceAppliedFilters {
  const out: ExperienceAppliedFilters = { includeExpired: filters.includeExpired };
  if (filters.q) out.q = filters.q;
  if (filters.signals?.length) out.signals = filters.signals;
  if (filters.domains?.length) out.domains = filters.domains;
  if (filters.envOs !== undefined) out.envOs = filters.envOs;
  if (filters.envTool !== undefined) out.envTool = filters.envTool;
  if (filters.envVersion !== undefined) out.envVersion = filters.envVersion;
  if (filters.envRuntime !== undefined) out.envRuntime = filters.envRuntime;
  if (filters.intent !== undefined) out.intent = filters.intent;
  if (filters.quality !== undefined) out.quality = filters.quality;
  if (filters.sourceProject !== undefined) out.sourceProject = filters.sourceProject;
  // 录入者回显（v1.81.0）：调用方据此确认"按录入者筛选真的生效了"
  if (filters.createdById !== undefined) out.createdById = filters.createdById;
  // sort 只在"它真的生效"时回显：有 q 时排序由融合分接管（shared 的 ExperienceSort
  // 值域无法表达 relevance，故省略而不是回显一个未生效的值）
  if (!filters.q && filters.sort !== undefined) out.sort = filters.sort;
  return out;
}

/** 计数（克隆后清掉分页参数：count 不该受 LIMIT/OFFSET 影响） */
async function countOf(qb: SelectQueryBuilder<ExperienceEntry>): Promise<number> {
  const counter = qb.clone();
  counter.skip(undefined).take(undefined);
  return counter.getCount();
}
