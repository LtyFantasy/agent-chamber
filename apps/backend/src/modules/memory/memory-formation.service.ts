/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory **提名与形成账本**：把一条主张提交给引擎、把 §7 信号收敛成账本当前态、
 *     并在失败/中断时提供**恢复三通道**（启动扫描 / `POST recover` / `POST retry`）
 *
 * [代码职责]
 *   - 提名链路：幂等键预检 → 装配冻结 → 落账本行 → 提交引擎 → §7 映射 → 回写账本 + 遥测
 *   - 恢复三通道：`recover`（项目级未收敛扫描 ≤10 行/次）/ `retry`（单行显式续跑）/
 *     `onApplicationBootstrap` 的异步启动扫描（**非阻塞**）
 *   - 读面：账本列表（逐行降级投影 + 门控正文取用）与详情（含 `select:false` 的正文/理由）；
 *     提名者归属名**批量**解析（`resolveNominatorLabels`）
 *   - 更正链路的**续跑**（`completeCorrectionLink`）：由 correction 服务调用，单向依赖；
 *     `createLedgerRow` 顺手接收 `correctionTargetMemoryId` 落库（续跑同参的锚点）
 *
 * [权威文档]
 *   - 线上 DocSpace docs/api-definition.md §19 — 形成、更正、重试与项目冲突合同
 *   - docs/architecture.md §3.2.14 / docs/spec.md §3.2.32 — 数据身份短锁协议与状态不变量
 *
 * [关键不变量]
 *   - 首次建账与所有 PATCH 共用项目行 FOR UPDATE、显式 READ COMMITTED；
 *     required projectSnapshot 在锁内核对，Provider/来源冻结/权限 IO 均不持锁。
 *   - 非空恢复候选选出后再读 fresh 项目；首条耐久账本固定 engine/workspace/actor。
 *   - **重放永不重装配**（§3）：`retry`/`recover`/启动扫描一律经 `MemoryLedgerRepository.findForReplay`
 *     取**冻结原文**（`content`/`rationale` 是 `select:false`，裸 findOne 会静默拿到空串）。
 *   - **HTTP 状态由账本态驱动**（§6）：committed→201 / no_memory→200 / submitted|deferred|unknown→202 /
 *     failed→503 / conflict|rejected→409。**hint 由 `recovery_path`+`engineCode` 驱动**，
 *     不由 HTTP 状态一刀切（同样 202，"同 key 重发"与"无回执"的下一步不同）。
 *   - **`withdrawn ⇒ engine_memory_ids 为空`**：撤回/释放唯一位时**必须清 ids**，否则
 *     "已撤回"的行仍会被召回映射认作 canonical 行（映射按 ids 认人）。
 *   - **系统态写入不顶 `updated_at`**（§7）：收敛/续跑/映射回填一律走**裸 SQL UPDATE**，
 *     不碰 `updated_at`（否则"最近人工动作"信号被后台扫描淹没）。**只有用户动作**（新建行、
 *     更正双写）走 ORM save/update。
 *   - **alias 镜像 canonical 行**（§7 第 12 行）：映射器返回 `formationState:null` +
 *     `mirrorCanonicalNominationId` 时，由本层在**本项目**内按 canonical 提名 id 查行并镜像其
 *     **当前** `formation_state`（含非终态，故 alias 行也会进后续扫描集）；**无 canonical
 *     线索 / 查不到 ⇒ `conflict`**（fail-safe，绝不落 committed）。
 *   - **遥测每尝试一行**：账本 = 当前态，遥测 = 尝试历史。`outcome` 记**引擎原始信号**
 *     （不是归一化后的 `formation_state`）；`unknown` 行 `input/output_tokens` 置 NULL
 *     （无回执即无用量事实，禁写 0）。
 *   - **列表的正文列按 `metadataOnly` 门控取用**（二期 D1② 起，**有意放宽**）：`!metadataOnly`
 *     才 `addSelect('nomination.content')`（为算 `contentExcerpt`），**永不**带 `rationale`；
 *     正文仍只从**详情**端点透出。治理观察者（`metadataOnly`）一行正文都不取。
 *     放弃"列表恒定零正文 IO"换来卡片摘要，取数上界相对改动前约 **2×**（上界 = 该项目
 *     **全部**账本行 ×（来源摘录 ≈8KB ＋ content ≤8KB）；`getMany` 无 LIMIT、`pageSize`
 *     只裁响应，是既有行为——`total` 仍是裁剪前全量行数，故不动分页）；
 *     漏门控 = 治理视角也把全量正文搬进内存。
 *   - **`contentExcerpt` 只在 `full` 档出现，且与 `contentTruncated` 无关**：它由
 *     `extractContentExcerpt` 从冻结正文反抽（剥 locator / 280 码点封顶），是**展示**行为；
 *     `contentTruncated` 是"形成时摘录区被字节闸门截了"的落库事实，两者不共用一个信号。
 *   - **提名者归属名批量解析、且不自己查 agents/users**：软删 actor 的
 *     `withDeleted + addSelect(deletedAt)` 与 agent 名回退链收口在 `ActorProfileService`
 *     （R1/R9/R12）；`nominatorType=system` 与真孤儿一律空值对（消费方退 id 前 8 位）。
 *   - **`recovery_path` 不在账本表上**（它在 `memory_formation_events`），故账本投影的
 *     `recoveryPath` 由 `latestRecoveryPaths` **一次批量查**得出（禁止逐行查 = N+1）。
 *   - **启动扫描 = fire-and-forget**：`onApplicationBootstrap` 里 `void ...catch()`，
 *     **绝不允许**扫描失败阻断应用启动（memory 是可选增强）；GET 路径**零副作用**。
 *   - **更正目标三优先级回退链**（`completeCorrectionLink`）：调用方直传 > 新行落库
 *     `correction_target_memory_id` > 旧行主记忆。中间一级是"中断续跑同参"的**唯一**来源
 *     ——删掉它，非主记忆目标的更正会在续跑时静默 supersede 错误的记忆；末级留给列后加的旧行。
 *   - **链接失败必须响亮呈现**：`correct` 未达成时 `completeCorrectionLink` 回填
 *     `linkFailure`（来自引擎失败面），`toHttpResult` 在 committed ∧ `oldClaimStatus='still_current'`
 *     时给响应挂 `correctionLinkFailure` + `hintCode='correction_link_pending'`。
 *     **禁止静默 `still_current`**——只打 warn 日志会让响应变成 201 + "Nothing further to do"，
 *     而 retry 本行实际会重试链接步（卡 61688768 生产误导演示）。
 *
 * [关联代码]
 *   - ../memory-access.service.ts — 项目三档闸门与来源可见性（本文件不自己判权限）
 *   - ../memory-content.assembler.ts — 装配 + 截断不变式 + locator + `extractContentExcerpt`
 *   - ../../common/services/actor-profile.service.ts — 提名者归属名/删除标记的批量解析
 *     （软删 actor 的 `withDeleted + addSelect` 与 agent 名回退链的唯一收口点）
 *   - ../engines/formation-state.mapper.ts — §7 映射表与**扫描排除集**单源
 *   - ../ledger.repository.ts — 重放冻结原文（**唯一**入口）
 *   - ../memory-correction.service.ts — 更正编排（调用本文件的 `completeCorrectionLink`）
 *   - ../memory-recall.service.ts — 召回（复用本文件的账本映射读取）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  ErrorCode,
  ActorType,
  MEMORY_FORMATION_OUTCOME,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_PROJECT_STATUS,
  MEMORY_SOURCE_REF_TYPE,
  MEMORY_UNAVAILABLE_REASON,
  type MemoryFormationOutcome,
  type MemoryFormationState,
  type MemoryUnavailableReason,
} from '@agent-chamber/shared';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import {
  MemoryNomination,
  type MemorySourceRef,
} from '../../database/entities/memory-nomination.entity';
import {
  MemoryFormationEvent,
  type MemoryFormationDiagnostics,
} from '../../database/entities/memory-formation-event.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import { ActorProfileService } from '../../common/services/actor-profile.service';
import {
  MEMORY_ENGINE as MEMORY_ENGINE_TOKEN,
  type MemoryEngine as MemoryEnginePort,
  type MemoryEngineFailure,
  type MemoryEngineTarget,
  type MemoryNominationResult,
} from './engines/memory-engine.interface';
import {
  mapFormationState,
  MEMORY_UNRESUMABLE_RECOVERY_PATHS,
  type FormationMapping,
  type FormationSignal,
  type MemoryRecoveryPath,
} from './engines/formation-state.mapper';
import { MemoryLedgerRepository } from './ledger.repository';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService, sameMemoryProjectBindings } from './memory-project.service';
import {
  assembleFormationContent,
  applyContentOverride,
  buildSourceLocator,
  extractContentExcerpt,
  truncateUtf8Bytes,
  utf8ByteLength,
} from './memory-content.assembler';
import {
  buildFormationHint,
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_DEFAULT_PAGE_SIZE,
  MEMORY_MAX_PAGE_SIZE,
  MEMORY_RATIONALE_MAX_BYTES,
  MEMORY_RECOVERY_SCAN_LIMIT,
  MEMORY_SOURCE_REFS_MAX,
  memoryNominationConflict,
  memoryNominationNotFound,
  memoryProjectConflict,
  memoryProjectNotFound,
  memorySourceRefForbidden,
  memoryUnavailable,
} from './memory.constants';
import type {
  MemoryCorrectionLinkFailure,
  MemoryEngineDiagnostics,
  MemoryNominationActionResponse,
  MemoryNominationDto,
  MemoryNominationListResponse,
  MemoryRecallSource,
  MemoryRecoverResponse,
  MemorySourceReadWith,
} from './dto/memory-contract';
import type {
  MemorySourceRefDto,
  NominateMemoryDto,
  QueryNominationsDto,
} from './dto/nomination.dto';

const logger = new Logger('MemoryFormation');

/**
 * 自动重扫的**状态集合**（方案 §7 末段：**非终态** ∧ `recovery_path ∉ 排除集`）。
 *
 * 判据是"这一行还能不能被平台用账本行幂等键续跑（retry）推进"，不是"引擎侧怎么称呼它"：
 * - `submitted`：引擎在途（pending / claimed / provider_inflight / proposed / committing /
 *   no_material），`inspect` 只读不推进 job ⇒ `POST /memory/nominations/:id/retry` 是**唯一**收敛方式
 * - `failed`：请求未到达（连接拒绝 / durable=false 的 500）或引擎回了可重试错误 ⇒
 *   平台可用账本行幂等键续跑本行
 * - `unknown`：**客户端超时**（无回执）——Chamber 侧不可恢复，但行仍是**非终态**：
 *   平台续跑时用账本行幂等键让引擎侧 replay 把回执补出来（mapper 早已假设"启动扫描会带上它"）。
 *   ⚠️ `provider_outcome_unknown` 这类 unknown 行**不会**因此误烧配额：映射器给它
 *   `hub_manual_required`，被下面的排除集子查询挡住；`rejected` 同理（`hub_manual_required`）
 * - `conflict`：409（**逐因不再同形**：quota / exact_content / prefix_unresolved /
 *   idempotency_conflict & co）。扫描会把它们重发——**刻意保留**，且无害：
 *   quota / exact_content / 幂等冲突的重发**不消耗配额**；而 `prefix_unresolved` 的
 *   "在途 blocker"分支重发正是自愈通道（等一轮后通常自愈）。
 *   ⚠️ **fence 的另一个分支不能自愈**：早先提名**终拒/unknown 未结算**时，只有引擎运营侧
 *   能结算（`POST recover` 重发同一行只会再拿一次 409）。别把这里的"重发"读成通用修复法
 *   ——排障看 `engineDiagnostics.admissionCause` 分辨两分支。
 */
const MEMORY_SCAN_FORMATION_STATES: readonly MemoryFormationState[] = [
  MEMORY_FORMATION_STATE.SUBMITTED,
  MEMORY_FORMATION_STATE.FAILED,
  MEMORY_FORMATION_STATE.UNKNOWN,
  MEMORY_FORMATION_STATE.CONFLICT,
];

/** 单条来源摘录的字节上限（防把整篇文档拽进内存；总预算仍由装配器把关） */
const MEMORY_EXCERPT_MAX_BYTES = 2048;

/**
 * 提名者归属投影（`nominatorName` / `nominatorDeletedAt` 的**成对**载体）。
 *
 * 形状对齐全站 actor 呈现范式（先例 `experienceActorLabel`）：软删 actor **保留真名** +
 * `deletedAt` 非空给"已删除"标记；真没名字（真孤儿 / system 哨兵）才双双为 null，
 * 由消费方退 id 前 8 位。**分开给两个字段而不是拼一个 label 串**：语言与"已删除"措辞
 * 属于前端 i18n，后端拼进去就把语言钉死在这里了。
 */
export interface MemoryNominatorLabel {
  name: string | null;
  deletedAt: string | null;
}

/**
 * 归属缺失的落点（**唯一的**空值对）。
 *
 * 两种情况共用：① `nominatorType = system`（哨兵 actor 无 agents/users 行，且显示名要按语言
 * 渲染）② 真孤儿（actors 表都查不到，ActorProfileService R12）。**不发明** 'Unknown' 兜底名——
 * 发明了，消费方就再也分不出"真没名字"与"名字恰好叫 Unknown"。
 */
const NO_NOMINATOR_LABEL: MemoryNominatorLabel = Object.freeze({
  name: null,
  deletedAt: null,
});

/** 一次形成尝试的产物（`correction` 服务复用） */
export interface FormationAttemptOutcome {
  formationState: MemoryFormationState;
  recoveryPath: MemoryRecoveryPath | null;
  /** 采纳的引擎记忆 id（仅 committed 非空） */
  memoryIds: string[];
  deferred: boolean;
  engineNominationId: string | null;
  engineCanonicalNominationId: string | null;
  engineCode?: string;
  /**
   * 本次尝试的**引擎自报诊断**（b4d41314；全空时**不产对象**，遥测落 NULL）。
   *
   * 两个失败面各自能填的字段不同：
   * - 失败面（HTTP 错误体）只有 `admissionCause` + `requestId`
   * - 成功面（200 回执）只有在 `outcome ∈ {rejected, unknown}` 才有
   *   `engineReasonCode` / `errorDetail` / `failureClass`
   */
  engineDiagnostics?: MemoryEngineDiagnostics;
  /** 失败时映射成 503 的 `reason`（见 `reasonForFailure`） */
  unavailableReason?: MemoryUnavailableReason;
  /** 归一化信号的原始形态（遥测用） */
  signal: FormationSignal;
  /** 本次调用耗时（毫秒） */
  latencyMs: number;
}

/** 冻结后的提名载荷（装配产物；重放时**不重装配**，用账本冻结列） */
export interface FrozenClaimPayload {
  content: string;
  contentTruncated: boolean;
  sourceRefs: MemorySourceRef[];
  sourceLocators: string[];
}

/** 提名/重试的统一返回（`httpStatus` 由账本态驱动，见文件头不变量） */
export interface FormationHttpResult {
  httpStatus: number;
  body: MemoryNominationActionResponse;
}

@Injectable()
export class MemoryFormationService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(MemoryProject) private readonly projects: Repository<MemoryProject>,
    @InjectRepository(MemoryNomination) private readonly nominations: Repository<MemoryNomination>,
    @InjectRepository(MemoryFormationEvent)
    private readonly formationEvents: Repository<MemoryFormationEvent>,
    @InjectRepository(Doc) private readonly docs: Repository<Doc>,
    @InjectRepository(DocSection) private readonly sections: Repository<DocSection>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskComment) private readonly comments: Repository<TaskComment>,
    private readonly access: MemoryAccessService,
    private readonly projectService: MemoryProjectService,
    private readonly ledgerRepository: MemoryLedgerRepository,
    // 提名者归属名的批量解析（**不**自己查 agents/users：软删 actors 的 withDeleted+addSelect
    // 与 agent 名回退链都收口在 ActorProfileService，见 resolveNominatorLabels）
    private readonly actorProfiles: ActorProfileService,
    @Inject(MEMORY_ENGINE_TOKEN) private readonly engine: MemoryEnginePort | null,
  ) {}

  /**
   * 启动后的**异步**一轮恢复扫描（方案 §7；非阻塞，见文件头不变量）。
   *
   * 失败只打 warn：memory 是可选增强，扫描失败不得影响应用启动。
   */
  onApplicationBootstrap(): void {
    if (this.engine === null) return;
    void this.runStartupScan()
      .then((summary) => {
        if (summary.scanned > 0) {
          logger.log(
            `startup memory recovery scan: scanned=${summary.scanned} resumed=${summary.resumed}`,
          );
        }
      })
      .catch((error: Error) => {
        logger.warn(`startup memory recovery scan failed (non-fatal): ${error.message}`);
      });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 写面：提名 / 重试 / 恢复
  // ══════════════════════════════════════════════════════════════════════

  /** 提名新主张（`POST /memory/projects/:id/nominations`） */
  async nominate(
    actor: UnifiedActor,
    projectId: string,
    dto: NominateMemoryDto,
  ): Promise<FormationHttpResult> {
    const project = await this.projectService.findProjectOrThrow(projectId);
    if (project.status !== MEMORY_PROJECT_STATUS.ACTIVE) {
      throw memoryProjectConflict(
        `Memory project '${projectId}' is archived: nominations are closed. Reads (ledger, detail, ` +
          'recall) stay open. Re-activate it (PATCH /memory/projects/:id {status:"active"}) if you ' +
          'really need to nominate. 归档项目不接受提名',
      );
    }
    await this.access.assertProjectWrite(actor, project);
    this.assertEngineReady(project);

    // 幂等键：同 actor 同 key 命中既有行 ⇒ 返回首次结果（**不二次形成**）
    if (dto.clientRequestId) {
      const existing = await this.nominations.findOne({
        // ⚠️ **必须带 `projectId`**：唯一索引 `uq_memory_nominations_client_key` 是
        // `(nominator_id, client_request_id)` 的**全局**唯一——只按 nominator + key 查会让
        // 同一 actor 在**另一个项目**用过的 key 命中"别的项目的行"，并把那行的投影
        // （含别项目的 ledgerId）当成"本项目的首次结果"返回给调用方。
        // 跨项目复用同 key 的正确结局 = 插入时 23505 → 409（`createLedgerRow` 的冲突分支），
        // 该分支文案对"跨项目复用"同样成立（"先读那行、别改 key 绕过"）。
        where: {
          projectId: project.id,
          nominatorId: actor.id,
          clientRequestId: dto.clientRequestId,
          deletedAt: IsNull(),
        },
      });
      if (existing) {
        // 最近一次尝试的 {recoveryPath, diagnostics} 一次取回（同源同档）
        const attempt = (await this.latestRecoveryPaths([existing.id])).get(existing.id);
        return this.toHttpResult(project, existing, {
          replay: true,
          recoveryPath: attempt?.recoveryPath ?? null,
          // ⚠️ replay 必须与首次响应同形：`data.engineDiagnostics` 取自同一次尝试的记录，
          //    否则"同 key 重发"的 409 会凭空少掉首次就有的诊断（消费方会误读成旧行）
          engineDiagnostics: attempt?.diagnostics ?? null,
        });
      }
    }

    const prepared = await this.prepareClaim(actor, dto);
    const row = await this.createLedgerRow({
      projectId: project.id,
      projectSnapshot: project,
      actor,
      dto,
      prepared,
    });
    const outcome = await this.submitAttempt(project, row, {
      content: prepared.content,
      rationale: dto.rationale,
      sourceLocators: prepared.sourceLocators,
    });
    await this.applyAttempt(project, row, outcome, 0);
    return this.toHttpResult(project, row, {
      replay: false,
      recoveryPath: outcome.recoveryPath,
      engineCode: outcome.engineCode,
      unavailableReason: outcome.unavailableReason,
      engineDiagnostics: outcome.engineDiagnostics ?? null,
    });
  }

  /** 单行显式续跑（`POST /memory/nominations/:id/retry`） */
  async retry(actor: UnifiedActor, ledgerId: string): Promise<FormationHttpResult> {
    const row = await this.findLedgerOrThrow(ledgerId);
    const project = await this.projectService.findProjectOrThrow(row.projectId);
    if (project.status !== MEMORY_PROJECT_STATUS.ACTIVE) {
      throw memoryProjectConflict(
        `Memory project '${project.id}' is archived: retry is closed. 归档项目不接受续跑`,
      );
    }
    await this.access.assertProjectWrite(actor, project);
    this.assertEngineReady(project);

    // 账本态闸门：**只有 active 行能续跑**，且必须在"更正续跑"分支之前。
    // ⚠️ 缺了它会击穿 `withdrawn ⇒ engine_memory_ids 为空` 不变量：撤回行被重发成 committed 后
    // `applyAttempt` 会把 ids 写回去，"已撤回"的记忆重新被召回映射认作 canonical；
    // superseded 行同理（它的更正在别的行上，重发旧行会把它又推回当前主张）。
    if (row.status !== MEMORY_NOMINATION_STATUS.ACTIVE) {
      throw memoryNominationConflict(
        `Ledger row '${ledgerId}' is '${row.status}', not active — ` +
          (row.status === MEMORY_NOMINATION_STATUS.WITHDRAWN
            ? 'a withdrawn claim was retracted, so there is nothing to resume; nominate a fresh claim instead'
            : 'a superseded claim was already replaced; resume ITS correction, or read the current claim') +
          `. Read it first: GET /memory/nominations/${ledgerId}. 撤回/被取代的行不可续跑`,
        { ledgerId, formationState: row.formationState },
      );
    }

    // 中断的更正：新行已 committed 但 correct 未落地 ⇒ 续跑的其实是 correct（§6"中断同参续跑"）。
    // ⚠️ 这里**不直传** oldMemoryId（续跑拿不到首跑的 DTO）：目标取自新行落库的
    // `correction_target_memory_id`（由 `completeCorrectionLink` 的回退链消费），
    // 故续跑与首跑同参——缺了这一环，非主记忆目标的更正会静默 supersede 错误的记忆。
    if (
      row.correctionOf &&
      row.formationState === MEMORY_FORMATION_STATE.COMMITTED &&
      (row.engineMemoryIds?.length ?? 0) > 0 &&
      !row.engineCorrectionId
    ) {
      const link = await this.completeCorrectionLink(ledgerId, project);
      const fresh = await this.findLedgerOrThrow(ledgerId);
      return this.toHttpResult(project, fresh, {
        replay: link.replay,
        recoveryPath: null,
        oldClaimStatus: link.oldClaimStatus,
        // 链接又失败 ⇒ 仍要响亮呈现（否则续跑也会回 "Nothing further to do"）；
        // 判别联合收窄：superseded 无 `linkFailure` 键
        ...(link.oldClaimStatus === 'still_current' ? { linkFailure: link.linkFailure } : {}),
      });
    }

    const replayRow = await this.ledgerRepository.findForReplay(ledgerId);
    if (!replayRow) throw memoryNominationNotFound(ledgerId);
    const retryCount = await this.countAttempts(ledgerId);
    const outcome = await this.submitAttempt(project, row, {
      content: replayRow.content,
      rationale: replayRow.rationale,
      sourceLocators: this.locatorsOf(row),
    });
    await this.applyAttempt(project, row, outcome, retryCount);
    return this.toHttpResult(project, row, {
      replay: false,
      recoveryPath: outcome.recoveryPath,
      engineCode: outcome.engineCode,
      unavailableReason: outcome.unavailableReason,
      engineDiagnostics: outcome.engineDiagnostics ?? null,
    });
  }

  /** 项目级恢复扫描（`POST /memory/projects/:id/recover`） */
  async recover(actor: UnifiedActor, projectId: string): Promise<MemoryRecoverResponse> {
    const project = await this.projectService.findProjectOrThrow(projectId);
    if (project.status !== MEMORY_PROJECT_STATUS.ACTIVE) {
      throw memoryProjectConflict(
        `Memory project '${projectId}' is archived: recover is closed. 归档项目不接受恢复扫描`,
      );
    }
    await this.access.assertProjectWrite(actor, project);
    this.assertEngineReady(project);
    return this.resumeProject(project, MEMORY_RECOVERY_SCAN_LIMIT);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 读面：账本列表 / 详情
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 账本列表（`GET /memory/projects/:id/nominations`）。
   *
   * 逐行降级投影（三处同源约束②）：**全源可见** ⇒ 完整投影；否则 ⇒ 治理白名单元数据投影。
   *
   * ⚠️ 二期（D1②）起，列表的完整投影**会带 `contentExcerpt`**（卡片摘要），故正文列按
   * `metadataOnly` **门控**取用——见 qb 处的注释与代价说明。
   */
  async listNominations(
    actor: UnifiedActor | null,
    projectId: string,
    query: QueryNominationsDto,
  ): Promise<MemoryNominationListResponse> {
    const project = await this.projectService.findProjectOrThrow(projectId);
    const access = await this.access.assertProjectRead(actor, project);

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? MEMORY_DEFAULT_PAGE_SIZE, MEMORY_MAX_PAGE_SIZE);

    // 整项目级降级闸门（与逐行 `full` 正交）：它决定**取哪些列**，必须先于 qb 定下来
    const metadataOnly = !access.readable;

    const qb = this.nominations
      .createQueryBuilder('nomination')
      .where('nomination.project_id = :projectId', { projectId })
      .andWhere('nomination.deleted_at IS NULL')
      .orderBy('nomination.created_at', 'DESC')
      .addOrderBy('nomination.id', 'ASC');

    // ⚠️ **门控 addSelect `content`（二期 D1② 起，有意放宽）**：
    // 旧不变量是"列表绝不带正文"（正文只在详情给）。二期要列表给卡片摘要 `contentExcerpt`，
    // 而摘要是从 `content` 抽的 ⇒ 至少 `!metadataOnly` 的行必须把正文捞上来。
    // **放弃了什么**：不再"列表恒定零正文 IO"。
    // **代价（真实量级）**：单次请求的取数上界 = **该项目全部账本行**（`getMany` 无 LIMIT、
    // 分页在内存里 slice，是既有行为；`pageSize` 只裁响应、**不构成取数上界**）×
    // （既有 `sourceRefs` 每行 ≤4 条 × 每条摘录 ≤2048 字节 ≈ 8KB ＋ 新增 `content` ≤8192 字节）
    // ⇒ 相对改动前约 **2×**。注意 `total` 仍是**裁剪前全量行数**（前端 tab 计数依赖它），
    // 故这里**不动分页**——真要降低上界得改成 SQL 分页，那是另一件事、不在本批。
    // **收敛**：① 只 addSelect `content`，**不带 `rationale`**（详情才需要它）；
    //   ② 门控在 `metadataOnly`：治理观察者（无项目内容读权限）一行正文都不取，
    //      他们的 `projection` 恒 `metadata`、也恒不会有 `contentExcerpt`；
    //   ③ 正文仍然**不进响应**——`content` 只在详情端点透出，列表拿它只为算 280 码点摘要
    //      （见 toNominationDto 的 `full` 分支：`contentExcerpt` 有、`content` 无）。
    // 漏掉门控 = 治理观察者也能把全量正文搬进进程内存（IO 白付 + 内容面越界的起点）。
    if (!metadataOnly) qb.addSelect(['nomination.content']);

    if (query.category)
      qb.andWhere('nomination.category = :category', { category: query.category });
    if (query.status) qb.andWhere('nomination.status = :status', { status: query.status });
    if (query.formationState) {
      qb.andWhere('nomination.formation_state = :formationState', {
        formationState: query.formationState,
      });
    }
    if (query.reviewBefore) {
      qb.andWhere('nomination.review_at IS NOT NULL AND nomination.review_at <= :reviewBefore', {
        reviewBefore: new Date(query.reviewBefore),
      });
    }

    const rows = await qb.getMany();

    // 批式来源判定：**一次喂全部行**（见 memory-access 文件头不变量）后按切片还原
    const verdicts = await this.access.evaluateSourceRefs(
      actor,
      rows.flatMap((row) => row.sourceRefs ?? []),
    );
    const recoveryPaths = await this.latestRecoveryPaths(rows.map((row) => row.id));
    // 提名者归属**一次批量解析**（禁逐行查 = N+1；两档投影都给，见 resolveNominatorLabels）
    const nominatorLabels = await this.resolveNominatorLabels(rows);

    let cursor = 0;
    const items = rows.map((row) => {
      const refCount = (row.sourceRefs ?? []).length;
      const slice = verdicts.slice(cursor, cursor + refCount);
      cursor += refCount;
      const full = !metadataOnly && slice.every((verdict) => verdict.visible);
      // `latestRecoveryPaths` 现在返回 `{recoveryPath, diagnostics}` 记录——**不能**再把整个
      // 对象当真值传下去（那样 `recoveryPath` 会变成对象，hint 与响应静默错档）
      const attempt = recoveryPaths.get(row.id);
      return this.toNominationDto(row, {
        full,
        includeContent: false,
        recoveryPath: attempt?.recoveryPath ?? null,
        engineDiagnostics: attempt?.diagnostics ?? null,
        nominator: nominatorLabels.get(row.nominatorId) ?? NO_NOMINATOR_LABEL,
      });
    });

    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize),
      total: items.length,
      page,
      pageSize,
      engineAvailability: this.projectService.engineAvailability(project),
    };
  }

  /** 账本详情（`GET /memory/nominations/:id`；**纯读、零副作用**） */
  async getNomination(actor: UnifiedActor | null, ledgerId: string): Promise<MemoryNominationDto> {
    const row = await this.findLedgerOrThrow(ledgerId);
    const project = await this.projectService.findProjectOrThrow(row.projectId);
    const access = await this.access.assertProjectRead(actor, project);

    const refs = row.sourceRefs ?? [];
    const verdicts = await this.access.evaluateSourceRefs(actor, refs);
    const full = access.readable && verdicts.every((verdict) => verdict.visible);
    const recoveryPaths = await this.latestRecoveryPaths([ledgerId]);

    // 详情允许带正文/理由（**只有详情**带 `content`；列表只拿它算 `contentExcerpt`，见
    // listNominations 的门控注释）——需要显式 addSelect
    const withContent = full
      ? ((await this.nominations
          .createQueryBuilder('nomination')
          .addSelect(['nomination.content', 'nomination.rationale'])
          .where('nomination.id = :id', { id: ledgerId })
          .getOne()) ?? row)
      : row;

    const nominatorLabels = await this.resolveNominatorLabels([row]);
    const attempt = recoveryPaths.get(ledgerId);

    return this.toNominationDto(withContent, {
      full,
      includeContent: true,
      recoveryPath: attempt?.recoveryPath ?? null,
      engineDiagnostics: attempt?.diagnostics ?? null,
      nominator: nominatorLabels.get(row.nominatorId) ?? NO_NOMINATOR_LABEL,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 供 correction 服务复用的低层原语（单向依赖：correction → formation）
  // ══════════════════════════════════════════════════════════════════════

  /** 取账本行（软删视为不存在 → 404） */
  async findLedgerOrThrow(ledgerId: string): Promise<MemoryNomination> {
    const row = await this.nominations.findOne({ where: { id: ledgerId } });
    if (!row) throw memoryNominationNotFound(ledgerId);
    return row;
  }

  /**
   * 装配并**冻结**来源（方案 §4）：服务端用**提名者权限**回取来源，无权/不存在 → 403 下标级指认。
   *
   * @param actor 提名者
   * @param dto 提名载荷（含 `contentOverride` 与 `sourceRefs`）
   * @returns 冻结后的正文与来源（`sourceLocators` 供引擎请求体）
   */
  async prepareClaim(actor: UnifiedActor, dto: NominateMemoryDto): Promise<FrozenClaimPayload> {
    const requested = (dto.sourceRefs ?? []).slice(0, MEMORY_SOURCE_REFS_MAX);
    const sourceRefs = await this.freezeSourceRefs(actor, requested);

    // 理由字节闸门（DTO 只数字符；中文一字 3 字节，见 memory.constants 文件头）
    if (utf8ByteLength(dto.rationale) > MEMORY_RATIONALE_MAX_BYTES) {
      throw new BadRequestException({
        message:
          `rationale is ${utf8ByteLength(dto.rationale)} UTF-8 bytes, over the ` +
          `${MEMORY_RATIONALE_MAX_BYTES} byte limit (the limit is BYTES, not characters — CJK is ` +
          '3 bytes per char). It is part of the formation content and is never truncated, so an ' +
          'oversized one must be rejected here. 理由超字节上限',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }

    const sourceLocators = sourceRefs.map(buildSourceLocator);

    if (dto.contentOverride !== undefined) {
      const overridden = applyContentOverride(dto.contentOverride);
      return {
        content: overridden.content,
        contentTruncated: overridden.truncated,
        sourceRefs,
        sourceLocators,
      };
    }

    const assembled = assembleFormationContent({
      category: dto.category,
      subject: dto.subject,
      scope: dto.scope,
      effectiveNote: dto.effectiveNote ?? null,
      rationale: dto.rationale,
      sourceRefs,
    });
    if (assembled.overflow) {
      // 固定区（三要素+理由）自身超限：**不截主张**，直接 400（见装配器文件头不变量）
      throw new BadRequestException({
        message:
          `The fixed part of the formation content (category + subject + scope + rationale) exceeds ` +
          `${MEMORY_CONTENT_MAX_BYTES} UTF-8 bytes on its own. Shorten subject/scope/rationale — the ` +
          'claim itself is never truncated (only the excerpt area is). 主张三要素与理由不可截断，请缩短',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    return {
      content: assembled.content,
      contentTruncated: assembled.truncated,
      sourceRefs,
      sourceLocators,
    };
  }

  /** 落一条账本行（**用户动作** ⇒ 走 ORM save，`updated_at` 正常推进） */
  async createLedgerRow(params: {
    projectId: string;
    /** 权限/来源准备时的项目快照；required，禁止生产调用绕过 freshness 检查。 */
    projectSnapshot: MemoryProject;
    actor: UnifiedActor;
    dto: NominateMemoryDto;
    prepared: FrozenClaimPayload;
    correctionOf?: string | null;
    /**
     * 更正要取代的引擎记忆 id（**解析后**的有效目标，仅更正行传）。
     *
     * 缺省（普通提名）= null。落库是为了让**中断续跑**与首跑逐字节同参
     * （`retry` 的更正续跑分支拿不到首跑的 DTO）——详见实体 `correctionTargetMemoryId`。
     */
    correctionTargetMemoryId?: string | null;
  }): Promise<MemoryNomination> {
    try {
      return await this.nominations.manager.transaction('READ COMMITTED', async (manager) => {
        // 与全部 PATCH 共用项目行锁；所有连接内操作用同一 manager，Provider/来源 IO 均在外面。
        const project = await manager.getRepository(MemoryProject).findOne({
          where: { id: params.projectId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!project) throw memoryProjectNotFound(params.projectId);
        if (project.status !== MEMORY_PROJECT_STATUS.ACTIVE) {
          throw memoryProjectConflict(
            'The project is archived; no ledger row or engine request was created. 归档项目不接受提名',
          );
        }
        const snapshot = params.projectSnapshot;
        if (
          snapshot.id !== project.id ||
          snapshot.engine !== project.engine ||
          snapshot.engineWorkspaceId !== project.engineWorkspaceId ||
          snapshot.engineActorId !== project.engineActorId ||
          snapshot.engineCredentialRef !== project.engineCredentialRef ||
          !sameMemoryProjectBindings(snapshot.bindings, project.bindings)
        ) {
          throw memoryProjectConflict(
            'The prepared project configuration or bindings changed. No ledger row was created and no engine ' +
              'request was sent. Re-read the project and permissions, then retry with the SAME clientRequestId. ' +
              '准备快照已过期，本次未建账、未发引擎；重读后可用原幂等键重试',
          );
        }
        const repository = manager.getRepository(MemoryNomination);
        const entity = repository.create({
          projectId: params.projectId,
          nominatorId: params.actor.id,
          nominatorType: params.actor.type,
          category: params.dto.category,
          subject: params.dto.subject,
          scope: params.dto.scope,
          effectiveNote: params.dto.effectiveNote ?? null,
          content: params.prepared.content,
          contentTruncated: params.prepared.contentTruncated,
          rationale: params.dto.rationale,
          sourceRefs: params.prepared.sourceRefs,
          engineMemoryIds: null,
          formationState: MEMORY_FORMATION_STATE.SUBMITTED,
          deferred: false,
          status: MEMORY_NOMINATION_STATUS.ACTIVE,
          correctionOf: params.correctionOf ?? null,
          // 普通提名恒 null（只有更正分支传值）——见列不变量
          correctionTargetMemoryId: params.correctionTargetMemoryId ?? null,
          reviewAt: params.dto.reviewAt ? new Date(params.dto.reviewAt) : null,
          clientRequestId: params.dto.clientRequestId ?? null,
        });
        return repository.save(entity);
      });
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      if (pg?.code === '23505' && pg?.constraint === 'uq_memory_nominations_client_key') {
        // ⚠️ 本分支**刻意不带 `hintCode`**（平台预检类 409，没有引擎 409 可归因）：
        // 消费方按"读既有行"处置，不要把它读成引擎冲突（也不要换 key 绕过）。
        throw memoryNominationConflict(
          `clientRequestId '${params.dto.clientRequestId}' was already used by this nominator. ` +
            'Same content + same key means REPLAY of the existing row — read it first ' +
            '(GET /memory/projects/:id/nominations). Only a genuinely NEW nomination should use a ' +
            'NEW clientRequestId. 幂等键已用过（同内容同 key 应重放既有行，确属新提名才换新 key）',
        );
      }
      if (pg?.code === '23505' && pg?.constraint === 'uq_memory_nominations_correction_of') {
        throw memoryNominationConflict(
          `Another ACTIVE correction of '${params.correctionOf}' already exists. Wait for it, or ` +
            'read the old claim first (GET /memory/nominations/:id). 同一 old 已有有效更正行',
        );
      }
      throw error;
    }
  }

  /**
   * 提交一次形成尝试并做 §7 映射（**不写库**——写库在 `applyAttempt`）。
   *
   * @param project 项目（提供引擎目标）
   * @param row 账本行（提供既有引擎 id）
   * @param payload 载荷（首发 = 装配产物；重放 = **账本冻结原文**）
   */
  async submitAttempt(
    project: MemoryProject,
    row: MemoryNomination,
    payload: { content: string; rationale: string; sourceLocators: string[] },
  ): Promise<FormationAttemptOutcome> {
    const target = this.engineTarget(project);
    const startedAt = Date.now();
    const result = await this.engine!.nominate(target, {
      ledgerId: row.id,
      category: row.category,
      content: payload.content,
      rationale: payload.rationale,
      sourceLocators: payload.sourceLocators,
    });
    const latencyMs = Date.now() - startedAt;

    if (result.ok) {
      const value: MemoryNominationResult = result.value;
      const signal: FormationSignal = {
        duplicate: value.duplicate,
        deferred: value.deferred,
        engineNominationId: value.engineNominationId,
        canonicalNominationId: value.canonicalNominationId,
        jobState: value.jobState,
        outcome: value.outcome,
        reasonCode: value.reasonCode,
        memoryIds: value.memoryIds,
        retryable: value.retryable,
        engineCode: value.engineCode,
        requestId: value.requestId,
        durable: value.durable,
      };
      const mapping = mapFormationState(signal);
      const resolved = await this.resolveAliasMirror(project, mapping);
      // 终拒 / unknown 的引擎证据（`diagnostics.failure` 只在这两个 outcome 下出现）
      const engineDiagnostics =
        value.outcome === 'rejected' || value.outcome === 'unknown'
          ? buildEngineDiagnostics({
              engineReasonCode: value.reasonCode,
              errorDetail: value.errorDetail,
              failureClass: value.failureClass,
              requestId: value.requestId,
            })
          : undefined;
      return {
        formationState: resolved.formationState,
        recoveryPath: resolved.recoveryPath,
        memoryIds: mapping.memoryIds,
        deferred: value.deferred,
        engineNominationId: value.engineNominationId,
        engineCanonicalNominationId: value.canonicalNominationId ?? null,
        engineCode: value.engineCode,
        ...(engineDiagnostics ? { engineDiagnostics } : {}),
        signal,
        latencyMs,
      };
    }

    const failure = result.failure;
    const signal: FormationSignal = {
      duplicate: false,
      deferred: false,
      failureKind: failure.kind,
      httpStatus: failure.httpStatus,
      engineCode: failure.engineCode,
      retryable: failure.retryable,
      requestId: failure.requestId,
    };
    const mapping = mapFormationState(signal);
    // 失败面（HTTP 错误体）只有 `admissionCause` + `requestId`；其余三个键不存在
    const engineDiagnostics = buildEngineDiagnostics({
      admissionCause: failure.admissionCause,
      requestId: failure.requestId,
    });
    return {
      formationState: mapping.formationState ?? MEMORY_FORMATION_STATE.UNKNOWN,
      recoveryPath: mapping.recoveryPath,
      memoryIds: [],
      deferred: false,
      engineNominationId: row.engineNominationId,
      engineCanonicalNominationId: row.engineCanonicalNominationId,
      engineCode: failure.engineCode,
      ...(engineDiagnostics ? { engineDiagnostics } : {}),
      unavailableReason: this.reasonForFailure(failure),
      signal,
      latencyMs: failure.latencyMs || latencyMs,
    };
  }

  /**
   * 把映射结果写回账本（**裸 SQL，不顶 `updated_at`**）并落一行形成遥测。
   *
   * @param project 项目（遥测的 `project_id`）
   * @param row 目标行（内存态同步，响应直接用）
   * @param outcome `submitAttempt` 的产物
   * @param retryCount 第几次尝试
   */
  async applyAttempt(
    project: MemoryProject,
    row: MemoryNomination,
    outcome: FormationAttemptOutcome,
    retryCount: number,
  ): Promise<void> {
    // 不变量：**非 committed 一律不写 ids**（含 alias / no_memory / committing / 失败面）
    const acceptedIds =
      outcome.formationState === MEMORY_FORMATION_STATE.COMMITTED ? outcome.memoryIds : [];

    await this.nominations.query(
      `UPDATE memory_nominations
          SET formation_state = $2,
              deferred = $3,
              engine_nomination_id = COALESCE($4, engine_nomination_id),
              engine_canonical_nomination_id = COALESCE($5, engine_canonical_nomination_id),
              engine_memory_ids = CASE WHEN $6::boolean THEN $7::jsonb ELSE engine_memory_ids END
        WHERE id = $1`,
      [
        row.id,
        outcome.formationState,
        outcome.deferred,
        outcome.engineNominationId,
        outcome.engineCanonicalNominationId,
        acceptedIds.length > 0,
        acceptedIds.length > 0 ? JSON.stringify(acceptedIds) : null,
      ],
    );

    // 内存态同步（响应直接用，省一次读；`updated_at` 由上面的裸 SQL 保持不动）
    row.formationState = outcome.formationState;
    row.deferred = outcome.deferred;
    if (outcome.engineNominationId) row.engineNominationId = outcome.engineNominationId;
    if (outcome.engineCanonicalNominationId) {
      row.engineCanonicalNominationId = outcome.engineCanonicalNominationId;
    }
    if (acceptedIds.length > 0) row.engineMemoryIds = acceptedIds;

    await this.formationEvents.save(
      this.formationEvents.create({
        projectId: project.id,
        ledgerId: row.id,
        category: row.category,
        outcome: toTelemetryOutcome(outcome.signal),
        reasonCode: outcome.engineCode ?? null,
        latencyMs: outcome.latencyMs,
        // 与配额语义**同口径**（`MemoryEngineFailureKind` 值域 = timeout|unreachable|http|invalid_response）：
        // "消耗了一次配额尝试" ⇔ 引擎**答了回执**——`timeout`（无回执）与 `unreachable`（请求没到）
        // 一律 false；`http`（含 409）与 `invalid_response`（2xx 但体不可解析）都算答了，照实 true。
        quotaConsumed:
          outcome.signal.failureKind !== 'timeout' && outcome.signal.failureKind !== 'unreachable',
        // 一期引擎未回传用量，且"无回执即无用量事实"——一律 NULL，禁写 0
        inputTokens: null,
        outputTokens: null,
        retryCount,
        recoveryPath: outcome.recoveryPath,
        // append-only：每行只携带**本次尝试**的诊断；没有就落 NULL（不回填、不 UPDATE）
        diagnostics: outcome.engineDiagnostics ?? null,
      }),
    );
  }

  /**
   * 完成更正链路的**引擎侧**动作（先 `inspectCorrection` 只读判态，需要则 `correct`），并双写。
   *
   * 供 `POST .../corrections`（首跑）与 `POST .../nominations/:id/retry`（中断续跑）共用。
   *
   * @param ledgerId 新账本行 id（幂等键 `chamber-correct-<id>` 的来源）
   * @param project 项目（引擎目标）
   * @param oldMemoryId 被更正的引擎记忆 id（**必须属于旧行**，由调用方预检）。
   *   三优先级回退链：**调用方直传 > 账本落库 `correction_target_memory_id` > 旧行主记忆**。
   *   落库值让**中断续跑**（retry）与首跑逐字节同参（续跑拿不到首跑的 DTO）；
   *   末级兜底留给列后加之前的旧行（PoC 期不回填，NULL 是合法态）。
   * @returns `replay` = 引擎回执是幂等回放（"早已落库"）；`oldClaimStatus` = 旧行最终态；
   *   `linkFailure` = 仅**链接未达成**时在场（`correct` 失败面三件套：kind/engineCode/httpStatus），
   *   调用方必须透传进 `toHttpResult`（否则又退回"静默 still_current"）
   */
  async completeCorrectionLink(
    ledgerId: string,
    project: MemoryProject,
    oldMemoryId?: string,
  ): Promise<
    // **判别联合**（评审 M3）：`still_current` 必带 `linkFailure`——hint 文案指向
    // `correctionLinkFailure`，编译器兜住"hint 与字段的配对"， superseded 无此键
    | { replay: boolean; oldClaimStatus: 'superseded' }
    | { replay: boolean; oldClaimStatus: 'still_current'; linkFailure: MemoryCorrectionLinkFailure }
  > {
    const row = await this.findLedgerOrThrow(ledgerId);
    if (!row.correctionOf) {
      throw memoryNominationConflict(
        `Ledger row '${ledgerId}' is not a correction (correction_of is null). 不是更正行`,
      );
    }
    const oldRow = await this.findLedgerOrThrow(row.correctionOf);
    const newMemoryId = row.engineMemoryIds?.[0];
    if (!newMemoryId) {
      throw memoryNominationConflict(
        `Correction row '${ledgerId}' has no engine memory id yet — the new claim must be COMMITTED ` +
          'before the correction is linked (engine constraint: correct() only links two ' +
          'already-formed memories). 更正前新主张必须先形成',
      );
    }
    // 三优先级：直传（首跑）> 落库（续跑同参）> 旧行主记忆（列后加的旧行兜底）。
    // ⚠️ 中间一级不可省：缺了它，非主记忆目标的更正在中断续跑时会**静默打错目标**。
    const targetOldMemoryId =
      oldMemoryId ?? row.correctionTargetMemoryId ?? oldRow.engineMemoryIds?.[0];
    if (!targetOldMemoryId) {
      throw memoryNominationConflict(
        `Old claim '${oldRow.id}' has no engine memory id — it was never formed, so there is ` +
          'nothing to correct. 旧主张未形成，无可更正对象',
      );
    }

    const replayRow = await this.ledgerRepository.findForReplay(ledgerId);
    if (!replayRow) throw memoryNominationNotFound(ledgerId);
    const target = this.engineTarget(project);
    const idempotencyKey = `chamber-correct-${ledgerId}`;

    // 先 inspect（**只读**）区分"已达成 vs 刚达成"——中断续跑不能凭猜
    let replay = false;
    let correctionId: string | null = null;
    const inspected = await this.engine!.inspectCorrection(target, { idempotencyKey });
    if (inspected.ok) {
      correctionId = inspected.value.engineCorrectionId;
      replay = true;
    } else {
      const corrected = await this.engine!.correct(target, {
        newLedgerId: ledgerId,
        oldMemoryId: targetOldMemoryId,
        newMemoryId,
        rationale: replayRow.rationale,
      });
      if (!corrected.ok) {
        // 更正未达成：新行**保持 committed**（记忆确实形成了），只回报"旧主张仍有效"。
        // ⚠️ 失败证据必须**随返回值上行**（rather than 只留在这条 warn 里）：调用方把它透传进
        // `toHttpResult`，响应才有 `correctionLinkFailure` + `correction_link_pending`。
        logger.warn(
          `memory correction link failed ledger=${ledgerId} kind=${corrected.failure.kind}` +
            `${corrected.failure.engineCode ? ` code=${corrected.failure.engineCode}` : ''}`,
        );
        return {
          replay: false,
          oldClaimStatus: 'still_current',
          linkFailure: {
            kind: corrected.failure.kind,
            ...(corrected.failure.engineCode ? { engineCode: corrected.failure.engineCode } : {}),
            ...(corrected.failure.httpStatus !== undefined
              ? { httpStatus: corrected.failure.httpStatus }
              : {}),
          },
        };
      }
      correctionId = corrected.value.engineCorrectionId;
      replay = corrected.value.replay === true;
    }

    // 双写事务：新行记 correction id + 旧行转 superseded（**用户动作** ⇒ 走 ORM update）
    await this.nominations.manager.transaction(async (manager) => {
      if (correctionId) {
        await manager.update(
          MemoryNomination,
          { id: ledgerId },
          { engineCorrectionId: correctionId },
        );
      }
      await manager.update(
        MemoryNomination,
        { id: oldRow.id },
        { status: MEMORY_NOMINATION_STATUS.SUPERSEDED },
      );
    });
    return { replay, oldClaimStatus: 'superseded' };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 恢复三通道的共用实现
  // ══════════════════════════════════════════════════════════════════════

  /** 启动扫描：逐项目跑一轮 `resumeProject`（各 ≤10 行；失败不抛出，见文件头不变量） */
  async runStartupScan(): Promise<{ scanned: number; resumed: number }> {
    if (this.engine === null) return { scanned: 0, resumed: 0 };
    const projects = await this.projects.find({ where: { status: MEMORY_PROJECT_STATUS.ACTIVE } });
    let scanned = 0;
    let resumed = 0;
    for (const project of projects) {
      if (!this.projectService.engineAvailability(project).available) continue;
      const summary = await this.resumeProject(project, MEMORY_RECOVERY_SCAN_LIMIT);
      scanned += summary.scanned;
      resumed += summary.resumed;
    }
    return { scanned, resumed };
  }

  /**
   * 项目级未收敛扫描（`POST recover` 与启动扫描共用；**≤limit 行**）。
   *
   * 扫描集合 = 非终态（`MEMORY_SCAN_FORMATION_STATES`）∧ `recovery_path` ∉ 排除集 ∧
   * `status=active`（撤回/被取代的行不该重发）。
   */
  async resumeProject(project: MemoryProject, limit: number): Promise<MemoryRecoverResponse> {
    const candidates = await this.nominations
      .createQueryBuilder('nomination')
      .where('nomination.project_id = :projectId', { projectId: project.id })
      .andWhere('nomination.deleted_at IS NULL')
      .andWhere('nomination.status = :status', { status: MEMORY_NOMINATION_STATUS.ACTIVE })
      .andWhere('nomination.formation_state IN (:...states)', {
        states: [...MEMORY_SCAN_FORMATION_STATES],
      })
      // ⚠️ `recovery_path` **不在账本表上**（它在 memory_formation_events，一行每次尝试）：
      // 排除集必须按"每行的**最近一次**尝试"判，故走相关子查询（DISTINCT ON），
      // 且**在 LIMIT 之前**过滤——否则恒错行会占满 10 个槽位（配额反复烧，正是排除集要防的）。
      // ⚠️ 排序元组必须与 `latestRecoveryPaths` **逐字同序**（created_at DESC, retry_count
      // DESC, id DESC）：两处指向不同行 = 排除判定与读面诊断来自两次不同尝试（静默错档）。
      .andWhere(
        `NOT EXISTS (
           SELECT 1 FROM (
             SELECT DISTINCT ON (ev.ledger_id) ev.ledger_id, ev.recovery_path
               FROM memory_formation_events ev
              WHERE ev.ledger_id = nomination.id
              ORDER BY ev.ledger_id, ev.created_at DESC, ev.retry_count DESC, ev.id DESC
           ) latest
           WHERE latest.recovery_path = ANY(:excludedPaths)
         )`,
        { excludedPaths: [...MEMORY_UNRESUMABLE_RECOVERY_PATHS] },
      )
      .orderBy('nomination.created_at', 'ASC')
      .limit(limit)
      .getMany();

    // candidates 已耐久：此后 PATCH 不能更换数据身份。必须在选出非空集合后重读，
    // 因为扫描最初读取的空项目可能已改绑，再落了新空间首条账本。
    const freshProject =
      candidates.length > 0 ? await this.projectService.findProjectOrThrow(project.id) : project;
    if (candidates.length > 0) {
      if (freshProject.status !== MEMORY_PROJECT_STATUS.ACTIVE) {
        throw memoryProjectConflict(
          'The project was archived before recovery; no engine request was sent. 归档项目不接受恢复',
        );
      }
      this.assertEngineReady(freshProject);
    }

    const items: MemoryRecoverResponse['items'] = [];
    let resumed = 0;

    for (const candidate of candidates) {
      const replayRow = await this.ledgerRepository.findForReplay(candidate.id);
      if (!replayRow) {
        items.push({
          ledgerId: candidate.id,
          formationState: candidate.formationState,
          recoveryPath: null,
          action: 'skipped',
        });
        continue;
      }
      const retryCount = await this.countAttempts(candidate.id);
      const outcome = await this.submitAttempt(freshProject, candidate, {
        content: replayRow.content,
        rationale: replayRow.rationale,
        sourceLocators: this.locatorsOf(candidate),
      });
      await this.applyAttempt(freshProject, candidate, outcome, retryCount);
      resumed += 1;
      items.push({
        ledgerId: candidate.id,
        formationState: outcome.formationState,
        recoveryPath: outcome.recoveryPath,
        // `resent` ≠ 有进展：这里如实带出本次尝试的 409 因（缺席 = 本次没有该诊断）
        ...(outcome.engineDiagnostics?.admissionCause
          ? { admissionCause: outcome.engineDiagnostics.admissionCause }
          : {}),
        action: 'resent',
      });
    }

    return { scanned: candidates.length, resumed, skipped: candidates.length - resumed, items };
  }

  /** 已尝试次数（遥测行数；`retry_count` = 第几次尝试） */
  async countAttempts(ledgerId: string): Promise<number> {
    return this.formationEvents.count({ where: { ledgerId } });
  }

  /**
   * 批量取每行的**最近一次**尝试的 `{recoveryPath, diagnostics}`（一次 SQL；禁止逐行查 = N+1）。
   *
   * rationale：这两列都不在账本表上（在 `memory_formation_events`），而账本投影需要它们
   * （`hint` 由 `recovery_path` 驱动；`engineDiagnostics` 只进 full 档）。
   *
   * **查询形态 = 窄 CTE + 主键回取**（b4d41314）：`DISTINCT ON` **只输出** `ledger_id`/`id`，
   * 让 jsonb **不参与排序键、也不进排序元组**（v2 把 `diagnostics` 放进 DISTINCT ON 输出列，
   * 真实 EXPLAIN 证伪：排序宽度 44→96）；随后按 PK join 回取 payload，无扇出。
   * ⚠️ 排序元组必须与 `resumeProject` 的排除集子查询**逐字同序**——两处指向不同行 =
   * 排除判定与读面诊断来自两次不同尝试（静默错档）。
   */
  async latestRecoveryPaths(
    ledgerIds: string[],
  ): Promise<
    Map<
      string,
      { recoveryPath: MemoryRecoveryPath | null; diagnostics: MemoryFormationDiagnostics | null }
    >
  > {
    if (ledgerIds.length === 0) return new Map();
    const rows = (await this.formationEvents.query(
      `WITH latest AS (
         SELECT DISTINCT ON (ev.ledger_id) ev.ledger_id, ev.id
           FROM memory_formation_events ev
          WHERE ev.ledger_id = ANY($1::uuid[])
          ORDER BY ev.ledger_id, ev.created_at DESC, ev.retry_count DESC, ev.id DESC
       )
       SELECT l.ledger_id, ev.recovery_path, ev.diagnostics
         FROM latest l
         JOIN memory_formation_events ev ON ev.id = l.id`,
      [ledgerIds],
    )) as Array<{
      ledger_id: string;
      recovery_path: MemoryRecoveryPath | null;
      diagnostics: MemoryFormationDiagnostics | null;
    }>;
    return new Map(
      rows.map((row) => [
        row.ledger_id,
        { recoveryPath: row.recovery_path, diagnostics: row.diagnostics ?? null },
      ]),
    );
  }

  /** 账本行的 locator 列表（重放时用**冻结的** sourceRefs，不重装配） */
  private locatorsOf(row: MemoryNomination): string[] {
    return (row.sourceRefs ?? []).map(buildSourceLocator);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部：引擎目标 / 闸门 / alias 镜像 / 来源冻结 / 投影
  // ══════════════════════════════════════════════════════════════════════

  /** 引擎不可用即 503（**两态区分**：全局未配 vs 本项目未绑） */
  private assertEngineReady(project: MemoryProject): void {
    const availability = this.projectService.engineAvailability(project);
    if (!availability.available) {
      throw memoryUnavailable(
        availability.reason ?? MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
      );
    }
  }

  /** 引擎调用目标（全部来自注册表；见引擎端口文件头不变量） */
  engineTarget(project: MemoryProject): MemoryEngineTarget {
    if (!project.engineWorkspaceId || !project.engineActorId || !project.engineCredentialRef) {
      throw memoryUnavailable(MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND);
    }
    return {
      workspaceId: project.engineWorkspaceId,
      actorId: project.engineActorId,
      credentialRef: project.engineCredentialRef,
    };
  }

  /** 失败分类 → 503 的 `reason`（`engine_error` 携带 engineCode） */
  private reasonForFailure(failure: MemoryEngineFailure): MemoryUnavailableReason {
    switch (failure.kind) {
      case 'timeout':
        return MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT;
      case 'unreachable':
        return MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE;
      default:
        return MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR;
    }
  }

  /**
   * alias 镜像（§7 第 12 行）：把"镜像 canonical 行当前态"落在 DB 事实上。
   *
   * @returns 已解析的 `{formationState, recoveryPath}`；无 canonical 线索 ⇒ `conflict`
   */
  private async resolveAliasMirror(
    project: MemoryProject,
    mapping: FormationMapping,
  ): Promise<{ formationState: MemoryFormationState; recoveryPath: MemoryRecoveryPath | null }> {
    if (mapping.formationState !== null) {
      return { formationState: mapping.formationState, recoveryPath: mapping.recoveryPath };
    }
    const canonicalId = mapping.mirrorCanonicalNominationId;
    if (!canonicalId) {
      logger.warn(
        `memory alias without canonical id — falling back to conflict (project=${project.id})`,
      );
      return { formationState: MEMORY_FORMATION_STATE.CONFLICT, recoveryPath: null };
    }
    const canonical = await this.nominations.findOne({
      where: { projectId: project.id, engineNominationId: canonicalId, deletedAt: IsNull() },
    });
    if (!canonical) {
      // canonical 不在本项目 ⇒ conflict（§7）；不猜、不建影子行
      logger.warn(
        `memory alias canonical ${canonicalId} is not in project ${project.id} — falling back to conflict`,
      );
      return { formationState: MEMORY_FORMATION_STATE.CONFLICT, recoveryPath: null };
    }
    // 镜像**当前**态（含非终态：canonical 还在途时 alias 也随其进扫描集）
    return { formationState: canonical.formationState, recoveryPath: null };
  }

  /**
   * 回取并**冻结**来源（方案 §4）。
   *
   * 权限用 `MemoryAccessService.evaluateSourceRefs`（与读侧**同源判据**）；摘录正文在**本层**取
   * ——读侧只需要"可见/不可见"，写侧才需要正文：两件事分开，权限内核不搬运内容。
   */
  private async freezeSourceRefs(
    actor: UnifiedActor,
    requested: MemorySourceRefDto[],
  ): Promise<MemorySourceRef[]> {
    if (requested.length === 0) return [];

    const verdicts = await this.access.evaluateSourceRefs(
      actor,
      requested.map((ref) => ({ type: ref.type, id: ref.id })),
    );
    const deniedIndex = verdicts.findIndex((verdict) => !verdict.visible);
    if (deniedIndex >= 0) {
      throw memorySourceRefForbidden(deniedIndex, requested[deniedIndex].id);
    }

    const frozen: MemorySourceRef[] = [];
    for (let index = 0; index < requested.length; index += 1) {
      frozen.push(
        await this.freezeOneSourceRef(requested[index], verdicts[index].currentVersionHash),
      );
    }
    return frozen;
  }

  /** 单条来源的冻结（父链 + 版本锚 + 摘录） */
  private async freezeOneSourceRef(
    input: MemorySourceRefDto,
    currentVersionHash: string | null,
  ): Promise<MemorySourceRef> {
    const ref: MemorySourceRef = { type: input.type, id: input.id };

    if (input.type === MEMORY_SOURCE_REF_TYPE.DOC) {
      const doc = await this.docs.findOne({ where: { id: input.id } });
      if (!doc) return ref;
      ref.parent = { type: 'docSpace', id: doc.spaceId };
      ref.parentId = doc.spaceId;
      // 冻结版本锚 = 回取当下的 contentHash（`moved` 判据的另一半）
      if (currentVersionHash) ref.versionHash = currentVersionHash;
      const section = await this.pickDocSection(doc.id, input);
      if (section) {
        if (section.headingPath) ref.headingPath = section.headingPath;
        ref.excerpt = truncateUtf8Bytes(section.content, MEMORY_EXCERPT_MAX_BYTES).trim();
      }
      return ref;
    }

    if (input.type === MEMORY_SOURCE_REF_TYPE.MESSAGE) {
      const message = await this.messages.findOne({ where: { id: input.id } });
      if (!message) return ref;
      ref.parent = { type: 'topic', id: message.topicId };
      ref.parentId = message.topicId;
      ref.excerpt = truncateUtf8Bytes(message.content, MEMORY_EXCERPT_MAX_BYTES).trim();
      return ref;
    }

    if (input.type === MEMORY_SOURCE_REF_TYPE.TASK) {
      const task = await this.tasks.findOne({ where: { id: input.id } });
      if (!task) return ref;
      ref.parent = { type: 'list', id: task.listId };
      ref.parentId = task.listId;
      ref.excerpt = truncateUtf8Bytes(task.description ?? '', MEMORY_EXCERPT_MAX_BYTES).trim();
      return ref;
    }

    const comment = await this.comments.findOne({ where: { id: input.id } });
    if (!comment) return ref;
    ref.parent = { type: 'task', id: comment.taskId };
    ref.parentId = comment.taskId;
    ref.excerpt = truncateUtf8Bytes(comment.content, MEMORY_EXCERPT_MAX_BYTES).trim();
    return ref;
  }

  /**
   * 选文档节当摘录：`position` 优先 → `headingPath` 次之 → **首节**（缺省口径）。
   *
   * 为什么允许缺省取首节：摘录只是**佐证**，而"不给摘录"会让 §4 模板的关键依据区只剩
   * locator（消费方看不出依据是什么）。首节是文档开篇，最接近"这段主张的依据"；
   * 要精确指认就传 `position` / `headingPath`。
   */
  private async pickDocSection(
    docId: string,
    input: MemorySourceRefDto,
  ): Promise<DocSection | null> {
    const sections = await this.sections.find({ where: { docId }, order: { position: 'ASC' } });
    if (sections.length === 0) return null;
    if (input.position !== undefined) {
      return sections.find((section) => section.position === input.position) ?? sections[0];
    }
    if (input.headingPath !== undefined) {
      return sections.find((section) => section.headingPath === input.headingPath) ?? sections[0];
    }
    return sections[0];
  }

  // ══════════════════════════════════════════════════════════════════════
  // 投影：账本行 → DTO / HTTP 语义
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 批量解析提名者归属（`nominatorName` / `nominatorDeletedAt` 的**唯一**产出点）。
   *
   * 三条约束都不是"顺手"写出来的：
   * 1. **批量、绝不逐行查**（列表一次可能上百行，逐行 = N+1，本仓明令禁止）：收口到
   *    `ActorProfileService.resolveProfiles` —— 它内部就是"actors 主查 + agents/users 补查"
   *    的批次 IN 查询，而软删 `deletedAt` 的**唯一**正确写法（`withDeleted` + `addSelect`
   *    `select:false` 列）与 agent 名回退链（`agents.name` 优先）也都收口在那里
   *    （见该服务 R1 / R9）。自己写这两个查询 = 复制一份踩坑概率。
   * 2. **`nominatorType = system` 直接给空值对**：system 是哨兵 actor（无 agents/users 行），
   *    且它的显示名要**按语言**渲染——后端给中文或英文都等于把语言钉死在这里。故不查表，
   *    由前端静态文案 / i18n 兜底（空值对 = 契约里的"没有名字"）。
   * 3. **真孤儿（actors 表查不到）也给空值对**（ActorProfileService R12）：名字缺失由消费方
   *    退 id 前 8 位，本层**不发明** 'Unknown' 之类的兜底名。
   *
   * @param rows 待解析的账本行（只读其 `nominatorId` / `nominatorType`）
   * @returns `nominatorId → {name, deletedAt}`；**入参出现过的每个 id 都有键**（查不到落空值对）
   */
  private async resolveNominatorLabels(
    rows: readonly MemoryNomination[],
  ): Promise<Map<string, MemoryNominatorLabel>> {
    const lookupIds = new Set<string>();
    for (const row of rows) {
      if (row.nominatorType !== ActorType.SYSTEM) lookupIds.add(row.nominatorId);
    }
    const profiles: ReadonlyMap<string, { name: string; deletedAt: Date | null }> =
      lookupIds.size > 0
        ? await this.actorProfiles.resolveProfiles([...lookupIds])
        : new Map<string, { name: string; deletedAt: Date | null }>();

    const labels = new Map<string, MemoryNominatorLabel>();
    for (const row of rows) {
      if (labels.has(row.nominatorId)) continue;
      if (row.nominatorType === ActorType.SYSTEM) {
        labels.set(row.nominatorId, NO_NOMINATOR_LABEL);
        continue;
      }
      const profile = profiles.get(row.nominatorId);
      labels.set(row.nominatorId, {
        name: profile?.name ?? null,
        // 软删**保留真名** + 给删除标记（全站 actor 呈现范式；前端据此渲染"已删除"小字）
        deletedAt: profile?.deletedAt ? profile.deletedAt.toISOString() : null,
      });
    }
    return labels;
  }

  /**
   * 账本行 → DTO（**降级投影**见 memory-access 的三处同源约束）。
   *
   * @param row 行（`full` 且 `includeContent` 时须已 `addSelect` 正文/理由；
   *   `full` 时 `content` 也用于抽 `contentExcerpt`，故列表在 `!metadataOnly` 时门控 addSelect）
   * @param options `full` = 全源可见；`includeContent` = 是否带正文（仅详情）
   * @param options.recoveryPath 最近一次尝试的恢复路径（由 `latestRecoveryPaths` 提供）
   * @param options.engineDiagnostics 最近一次尝试的引擎诊断（**只进 full 档**）
   * @param options.nominator 提名者归属（由 `resolveNominatorLabels` **批量**解析后传入）
   */
  toNominationDto(
    row: MemoryNomination,
    options: {
      full: boolean;
      includeContent: boolean;
      recoveryPath: MemoryRecoveryPath | null;
      engineDiagnostics?: MemoryEngineDiagnostics | null;
      nominator: MemoryNominatorLabel;
    },
  ): MemoryNominationDto {
    const base: MemoryNominationDto = {
      projection: options.full ? 'full' : 'metadata',
      id: row.id,
      category: row.category,
      formationState: row.formationState,
      status: row.status,
      nominatorId: row.nominatorId,
      nominatorType: row.nominatorType,
      // 归属名 + 删除标记**成对**透出（两档都给，二期 D1b）：治理观察者也要能回答
      // "这行是谁提的、那人还在不在"——两者都是元数据，不在内容面禁区里
      nominatorName: options.nominator.name,
      nominatorDeletedAt: options.nominator.deletedAt,
      // 所属项目与更正边**提升到 base**（二期 D1c，**有意放宽**）：治理观察者要能把这些行
      // 归到项目上、并画出取代关系边（谁是现行版本）。二者都不泄露正文/理由/来源摘录
      // ——勿当越权回归"修回去"；文案同源于 memory.controller 的 Swagger 白名单。
      projectId: row.projectId,
      correctionOf: row.correctionOf,
      reviewAt: row.reviewAt ? row.reviewAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    if (!options.full) return base;

    const dto: MemoryNominationDto = {
      ...base,
      subject: row.subject,
      scope: row.scope,
      effectiveNote: row.effectiveNote,
      contentTruncated: row.contentTruncated,
      sourceRefs: (row.sourceRefs ?? []).map((ref) => ({ ...ref })),
      // 同形的可消费投影（与召回 `sources[]` **一模一样**的形状）：账本读面同时给
      // "冻结事实"（sourceRefs）与"能直接用的投影"（sources），消费方不必自己拼 locator
      sources: (row.sourceRefs ?? []).map((ref) => this.toSourceRefProjection(ref)),
      engineNominationId: row.engineNominationId,
      engineCanonicalNominationId: row.engineCanonicalNominationId,
      engineJobId: row.engineJobId,
      engineMemoryIds: row.engineMemoryIds ?? [],
      engineCorrectionId: row.engineCorrectionId,
      // 更正目标（仅更正行非 null）——与 engineNominationId 等引擎 id 同档：**只进 full**，
      // 不进 metadata 降级白名单（降级面是治理视角，看不到"取代了哪条记忆"这类执行细节）
      correctionTargetMemoryId: row.correctionTargetMemoryId,
      clientRequestId: row.clientRequestId,
      recoveryPath: options.recoveryPath,
      // 引擎诊断与 `recoveryPath` **同源同档**（都来自最近一次尝试；都只进 full）。
      // 缺席 = 无引擎证据（旧行 / 引擎未提供 / 无回执），**不是**"没有冲突"——动作看 hintCode。
      // metadata（治理）档不透：与 recoveryPath 同档纪律（`errorDetail` 是闭集枚举，
      // 仍属执行细节，不属于治理观察者的可见面）。
      ...(options.engineDiagnostics ? { engineDiagnostics: options.engineDiagnostics } : {}),
      deferred: row.deferred,
      // 卡片摘要（二期 D1④）：从冻结正文里抽锚点后的摘录、剥掉 locator、280 字符封顶。
      // ⚠️ 与 `content`（只有详情给）分流：列表给摘要不给正文，故它挂在 `full` 档而不是
      // `includeContent` 档。`?? ''` 是防御：`full` 而漏 addSelect 时退化成空摘要而不是崩。
      contentExcerpt: extractContentExcerpt(row.content ?? ''),
    };
    // 正文只在详情给（列表的完整投影 = 元数据 + 主张三要素 + 来源 + 摘要，**不含正文**——
    // 列表带正文 = 每次翻页搬运全量正文，而 `content` 是 select:false 的理由正在此）
    if (options.includeContent) dto.content = row.content;
    return dto;
  }

  /**
   * 来源引用投影（与召回端点**同一形状**）。
   *
   * ⚠️ `moved` 在账本读面恒 false：账本读的是**冻结快照**，判"来源是否已改"要拿当前
   * contentHash 对比（`memory-recall.service` 在召回路径做，因为那里本来就要批载 doc）。
   * 账本投影里给 `moved: false` 而不是省略该字段，是为了消费方能统一按形状解析。
   */
  toSourceRefProjection(ref: MemorySourceRef): MemoryRecallSource {
    return {
      type: ref.type,
      id: ref.id,
      parent: ref.parent ?? null,
      versionHash: ref.versionHash ?? null,
      headingPath: ref.headingPath ?? null,
      locator: buildSourceLocator(ref),
      moved: false,
      readWith: readWithFor(ref),
    };
  }

  /**
   * 账本态 → HTTP 结果（**逐态语义**见文件头不变量；failed/conflict/rejected 抛错带 `data`）。
   *
   * @param options.flow 文案作用域（默认 `nomination`；correct 路径传 `correction`）。
   *   ⚠️ flow **只影响 conflict / rejected 分支**：非终态分支的行没有被撤回，文案不得出现
   *   WITHDRAWN / "NEW clientRequestId"。
   * @param options.engineDiagnostics 本次尝试的引擎诊断（**嵌套槽** `engineDiagnostics`；
   *   扁平槽只保留既有键 `engineCode`/`ledgerId`/`hint`/`hintCode`/`formationState`）
   * @param options.oldClaimStatus 更正链的旧主张终态（**只影响 committed 分支的 hint**：
   *   `still_current` ⇒ `correction_link_pending`）
   * @param options.linkFailure 更正链接失败的引擎证据。**只在 committed ∧ still_current 时
   *   挂到响应体** `correctionLinkFailure`（缺席 ≠ 链接成功断言，见 DTO 注释）
   */
  toHttpResult(
    project: MemoryProject,
    row: MemoryNomination,
    options: {
      replay: boolean;
      recoveryPath: MemoryRecoveryPath | null;
      oldClaimStatus?: 'superseded' | 'still_current';
      engineCode?: string;
      unavailableReason?: MemoryUnavailableReason;
      engineDiagnostics?: MemoryEngineDiagnostics | null;
      flow?: 'nomination' | 'correction';
      linkFailure?: MemoryCorrectionLinkFailure;
    },
  ): FormationHttpResult {
    const flow = options.flow ?? 'nomination';
    const diagnostics = options.engineDiagnostics ?? null;
    const hint = buildFormationHint({
      formationState: row.formationState,
      recoveryPath: options.recoveryPath,
      engineCode: options.engineCode,
      ledgerId: row.id,
      engineDiagnostics: diagnostics,
      flow,
      oldClaimStatus: options.oldClaimStatus,
    });
    // 链接失败只在"新主张 truly 形成了、但链接没建立"这一态成立——其余态即便传了
    // linkFailure 也不挂（避免消费方在 no_memory/withdrawn 等态读到误导性证据）
    const linkFailure =
      options.linkFailure &&
      row.formationState === MEMORY_FORMATION_STATE.COMMITTED &&
      options.oldClaimStatus === 'still_current'
        ? options.linkFailure
        : undefined;

    const body: MemoryNominationActionResponse = {
      ledgerId: row.id,
      projectId: row.projectId,
      formationState: row.formationState,
      status: row.status,
      deferred: row.deferred,
      engineNominationId: row.engineNominationId,
      engineCanonicalNominationId: row.engineCanonicalNominationId,
      engineJobId: row.engineJobId,
      engineMemoryIds: row.engineMemoryIds ?? [],
      contentTruncated: row.contentTruncated,
      engineAvailability: this.projectService.engineAvailability(project),
      hint: hint.hint,
      hintCode: hint.hintCode,
      ...(diagnostics ? { engineDiagnostics: diagnostics } : {}),
      replay: options.replay,
      ...(options.oldClaimStatus ? { oldClaimStatus: options.oldClaimStatus } : {}),
      ...(linkFailure ? { correctionLinkFailure: linkFailure } : {}),
    };

    // 409 的 message 保持**通用**（日志/审计面），逐因处置全在 hint（动作面）——
    // 两套话逐因重复 = 双份漂移。也**不得**预判来源：平台侧 alias 镜像回落产生的 conflict
    // 根本没有引擎 409（引擎答的是 200 duplicate）。
    const conflictMessage =
      'The nomination is in a CONFLICT state (409). Read hint/hintCode for the next step; ' +
      "data.engineDiagnostics carries the engine's own evidence (when present)." +
      (flow === 'correction'
        ? ' The correction row was withdrawn and the old claim is still current.'
        : '');
    const rejectedMessage =
      'The nomination is in a REJECTED state (409). Read hint/hintCode for the next step; ' +
      "data.engineDiagnostics carries the engine's own evidence (when present)." +
      (flow === 'correction'
        ? ' The correction row was withdrawn and the old claim is still current.'
        : '');

    switch (row.formationState) {
      case MEMORY_FORMATION_STATE.COMMITTED:
        return { httpStatus: 201, body };
      case MEMORY_FORMATION_STATE.NO_MEMORY:
        return { httpStatus: 200, body };
      case MEMORY_FORMATION_STATE.SUBMITTED:
      case MEMORY_FORMATION_STATE.UNKNOWN:
        return { httpStatus: 202, body };
      case MEMORY_FORMATION_STATE.FAILED:
        // 503：**带账本 id**（"可能已提交，查账本详情或 retry"）。
        // ⚠️ HTTP 错误体只有 `admissionCause` + `requestId` ⇒ 503 的 `data.engineDiagnostics`
        //    只会含 `{requestId}`（另外三个键只存在于 200 回执）。
        throw memoryUnavailable(
          options.unavailableReason ?? MEMORY_UNAVAILABLE_REASON.ENGINE_ERROR,
          {
            engineCode: options.engineCode,
            ledgerId: row.id,
            hint: hint.hint,
            hintCode: hint.hintCode,
            formationState: row.formationState,
            ...(diagnostics ? { engineDiagnostics: diagnostics } : {}),
          },
        );
      case MEMORY_FORMATION_STATE.REJECTED:
        throw memoryNominationConflict(rejectedMessage, {
          ledgerId: row.id,
          hint: hint.hint,
          hintCode: hint.hintCode,
          formationState: row.formationState,
          ...(diagnostics ? { engineDiagnostics: diagnostics } : {}),
        });
      default:
        // conflict：409 + 逐因 hint（`hintCode` 是唯一动作权威）
        throw memoryNominationConflict(conflictMessage, {
          ledgerId: row.id,
          hint: hint.hint,
          hintCode: hint.hintCode,
          formationState: row.formationState,
          ...(diagnostics ? { engineDiagnostics: diagnostics } : {}),
        });
    }
  }
}

/**
 * 引擎诊断对象组装（**全空 ⇒ 不产对象**）。
 *
 * 五字段全空时返回 `undefined`：这样遥测落 NULL、响应**不带** `engineDiagnostics` 键——
 * "没有诊断"与"诊断全为空值"必须是同一件事，否则消费方要区分两种空（前者是事实，
 * 后者是实现噪音）。
 *
 * ⚠️ 值已由引擎层五道门过滤；本函数只做**在场裁剪**，不做二次校验。
 */
function buildEngineDiagnostics(input: {
  admissionCause?: string;
  engineReasonCode?: string;
  errorDetail?: string;
  failureClass?: string;
  requestId?: string;
}): MemoryEngineDiagnostics | undefined {
  const diagnostics: MemoryEngineDiagnostics = {};
  if (input.admissionCause !== undefined) diagnostics.admissionCause = input.admissionCause;
  if (input.engineReasonCode !== undefined) {
    diagnostics.engineReasonCode = input.engineReasonCode;
  }
  if (input.errorDetail !== undefined) diagnostics.errorDetail = input.errorDetail;
  if (input.failureClass !== undefined) diagnostics.failureClass = input.failureClass;
  if (input.requestId !== undefined) diagnostics.requestId = input.requestId;
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

/** 遥测 `outcome`：**引擎原始信号**（不是归一化后的 `formation_state`） */
function toTelemetryOutcome(signal: FormationSignal): MemoryFormationOutcome {
  const known: readonly string[] = [
    MEMORY_FORMATION_OUTCOME.MEMORY_COMMITTED,
    MEMORY_FORMATION_OUTCOME.NO_MEMORY,
    MEMORY_FORMATION_OUTCOME.NO_CHANGE_VALIDATED,
    MEMORY_FORMATION_OUTCOME.REJECTED,
    MEMORY_FORMATION_OUTCOME.UNKNOWN,
    MEMORY_FORMATION_OUTCOME.DEFERRED,
  ];
  if (signal.outcome && known.includes(signal.outcome)) {
    return signal.outcome as MemoryFormationOutcome;
  }
  if (signal.reasonCode === 'no_change_validated') {
    return MEMORY_FORMATION_OUTCOME.NO_CHANGE_VALIDATED;
  }
  if (signal.jobState === 'committed' && (signal.memoryIds?.length ?? 0) > 0) {
    return MEMORY_FORMATION_OUTCOME.MEMORY_COMMITTED;
  }
  if (signal.duplicate) return MEMORY_FORMATION_OUTCOME.NO_CHANGE_VALIDATED;
  // 无成功回执（超时 / 不可达 / 409 / 未枚举错误码）一律如实记 unknown——禁把"没收到"记成"形成了"
  return MEMORY_FORMATION_OUTCOME.UNKNOWN;
}

/** 来源类型 → 平台侧回查入口（信任框信封的一部分；工具名单源 = shared `MEMORY_SOURCE_READ_TOOLS`） */
function readWithFor(ref: MemorySourceRef): MemorySourceReadWith {
  switch (ref.type) {
    case 'doc':
      return { tool: 'read_doc', params: { docId: ref.id } };
    case 'message':
      // params 必须是**原样可调**的合法参数：markRead=false 防"回读"副作用推进已读游标，
      // maxContentLength=0 取全文（回读就是要看当前版本全文）；具体消息定位走同级的 locator
      return {
        tool: 'get_topic_digest',
        params: { topicId: ref.parent?.id ?? '', markRead: false, maxContentLength: 0 },
      };
    case 'task':
      return { tool: 'follow_up_task', params: { taskId: ref.id } };
    default:
      // ⚠️ `task_controller_get_comments` 的路径参数名是 **`id`**（`@Get(':id/comments')`，见
      // task.controller.ts），**不是** `taskId`——写成 taskId 的回查入口是"看着能用、调起来 400"。
      // 具体是哪条评论仍靠同级的 locator 定位（工具只按任务取全量评论）。
      return { tool: 'task_controller_get_comments', params: { id: ref.parent?.id ?? '' } };
  }
}
