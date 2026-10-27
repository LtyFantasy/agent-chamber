/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **更正编排**：把"用新主张取代旧主张"编排成"预检 → 提名新主张 → 形成 → correct →
 *     双写"，并在任何一个环节失败时**释放唯一占位**，使同一条旧主张可以再更正
 *
 * [代码职责]
 *   - 预检（**引擎三约束先于 DB 拦截**）：旧行 active + 已形成 + `oldMemoryId` 属于旧行 +
 *     同一 old 无其它有效更正行
 *   - 新主张的提名/形成（完全复用 formation 服务的原语，逐态语义与普通提名一致）
 *   - 更正目标落库：`resolveOldMemoryId` 的**解析结果**写新行 `correction_target_memory_id`
 *     （显式值或缺省主记忆）⇒ 中断续跑与首跑逐字节同参
 *   - 达成 ⇒ `completeCorrectionLink`（双写：新行记 correction id + 旧行 superseded）；
 *     引擎侧链接失败时把 `linkFailure` 透传进 `toHttpResult`（响应给
 *     `correctionLinkFailure` + `correction_link_pending`，**不静默 still_current**）
 *   - **未达成 ⇒ 新行 withdrawn + 清 ids**（释放 `correction_of` 部分唯一位）
 *
 * [权威文档]
 *   - 线上 DocSpace docs/api-definition.md §19 — 形成、更正、重试与项目冲突合同
 *   - docs/architecture.md §3.2.14 / docs/spec.md §3.2.32 — 数据身份短锁协议与状态不变量
 *
 * [关键不变量]
 *   - 新更正行的 createLedgerRow 必须传准备时 projectSnapshot，复用首次建账短锁协议；
 *     引擎形成/更正链接均在锁外，旧账本已固定数据 namespace。
 *   - **未达成必须 `withdrawn` + 清 ids**：`uq_memory_nominations_correction_of` 的部分唯一位
 *     谓词是 `WHERE correction_of IS NOT NULL AND deleted_at IS NULL AND status <> 'withdrawn'`
 *     ——不释放的话，同一条旧主张**永远无法再更正**（表现为 409，而排障会误判成引擎问题）。
 *     清 ids 是同一条不变量：`withdrawn ⇒ engine_memory_ids 为空`，否则"已撤回"的行仍会被
 *     召回映射认作 canonical 行。
 *   - **哪些终态算"未达成"**：`no_memory` / `rejected` / `conflict` 三条（§6 明文）。
 *     `failed` / `unknown` / `submitted` **不算**——它们是非终态，行保持 active 以便
 *     `retry` 续跑（若也释放唯一位，续跑就会撞上"同一 old 已有另一行"的仲裁）。
 *   - **`oldClaimStatus` 的两值语义**：`superseded` = 引擎已接受更正（旧记忆被取代）；
 *     `still_current` = 更正**未达成**（新主张可能已形成，但旧主张仍是当前有效主张）
 *     ——消费方据此决定"要不要再试"，不是装饰字段。
 *   - **预检必须在"引擎三约束"之前**（§6）：`correct()` 只链接两个**已形成且 active** 的
 *     记忆；让引擎去拒绝是浪费一次配额且错误码更含糊（引擎侧只看得到"某个 id 不合法"）。
 *   - **旧行必须属于本项目**：跨项目传 `correctionOf` 一律按"本项目无此账本行"处理（404），
 *     不泄露其它项目是否存在该行。
 *   - **更正目标必须落库**（`correction_target_memory_id` = `resolveOldMemoryId` 的解析结果）：
 *     续跑（retry 的更正续跑分支）拿不到首跑的 DTO，只能从账本读目标——不落库则非主记忆
 *     目标的更正在中断后会**静默 supersede 错误的记忆**（且不报错，表现为"更正没生效"）。
 *
 * [关联代码]
 *   - ../memory-formation.service.ts — 复用 `prepareClaim` / `createLedgerRow` / `submitAttempt` /
 *     `applyAttempt` / `completeCorrectionLink`（**单向依赖**：correction → formation）
 *   - ../memory-access.service.ts — 写闸门
 *   - database/entities/memory-nomination.entity.ts — 部分唯一索引谓词（唯一位的仲裁者）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import {
  ErrorCode,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  MEMORY_PROJECT_STATUS,
  MEMORY_UNAVAILABLE_REASON,
} from '@agent-chamber/shared';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import {
  MEMORY_ENGINE as MEMORY_ENGINE_TOKEN,
  type MemoryEngine as MemoryEnginePort,
} from './engines/memory-engine.interface';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService, type FormationHttpResult } from './memory-formation.service';
import {
  memoryNominationConflict,
  memoryNominationNotFound,
  memoryProjectConflict,
  memoryUnavailable,
} from './memory.constants';
import { CorrectMemoryDto } from './dto/nomination.dto';

const logger = new Logger('MemoryCorrection');

/**
 * "更正未达成"的终态集合（§6 明文三值）。
 *
 * ⚠️ 刻意**不含** `failed` / `unknown` / `submitted`：那些是非终态，行保持 `active` 以便
 * `retry` 续跑（见文件头不变量）。
 */
const MEMORY_UNFULFILLED_CORRECTION_STATES: readonly string[] = [
  MEMORY_FORMATION_STATE.NO_MEMORY,
  MEMORY_FORMATION_STATE.REJECTED,
  MEMORY_FORMATION_STATE.CONFLICT,
];

@Injectable()
export class MemoryCorrectionService {
  constructor(
    @InjectRepository(MemoryNomination) private readonly nominations: Repository<MemoryNomination>,
    private readonly projectService: MemoryProjectService,
    private readonly access: MemoryAccessService,
    private readonly formation: MemoryFormationService,
    @Inject(MEMORY_ENGINE_TOKEN) private readonly engine: MemoryEnginePort | null,
  ) {}

  /**
   * 发起更正（`POST /memory/projects/:id/corrections`）。
   *
   * @param actor 更正者（授权同 nominate：项目 active + ≥1 绑定 write）
   * @param projectId 项目
   * @param dto 新主张 + `correctionOf` + 可选 `oldMemoryId`
   * @returns 与提名同形的结果（另带 `oldClaimStatus`）
   */
  async correct(
    actor: UnifiedActor,
    projectId: string,
    dto: CorrectMemoryDto,
  ): Promise<FormationHttpResult> {
    const project = await this.projectService.findProjectOrThrow(projectId);
    if (project.status !== MEMORY_PROJECT_STATUS.ACTIVE) {
      throw memoryProjectConflict(
        `Memory project '${projectId}' is archived: corrections are closed. 归档项目不接受更正`,
      );
    }
    await this.access.assertProjectWrite(actor, project);
    const availability = this.projectService.engineAvailability(project);
    if (!availability.available || this.engine === null) {
      throw memoryUnavailable(
        availability.reason ?? MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
      );
    }

    // ── ① 预检（引擎三约束先于 DB 拦截，见文件头不变量） ──
    const oldRow = await this.loadOldClaim(projectId, dto.correctionOf);
    const oldMemoryId = this.resolveOldMemoryId(oldRow, dto.oldMemoryId);
    await this.assertNoActiveCorrection(oldRow.id);

    // ── ② 新主张：装配 + 落行（`correction_of` = 旧行 ⇒ 部分唯一索引在此仲裁并发） ──
    // `correctionTargetMemoryId` 落**解析后**的目标：中断续跑（retry）拿不到本次 DTO，
    // 只能从账本读它，否则会静默回退到旧行主记忆（非主记忆目标 ⇒ supersede 打错。
    // 见实体 `correctionTargetMemoryId` 与 `completeCorrectionLink` 的回退链）
    const prepared = await this.formation.prepareClaim(actor, dto);
    const newRow = await this.formation.createLedgerRow({
      projectId,
      projectSnapshot: project,
      actor,
      dto,
      prepared,
      correctionOf: oldRow.id,
      correctionTargetMemoryId: oldMemoryId,
    });

    // ── ③ 形成（逐态语义同提名） ──
    const outcome = await this.formation.submitAttempt(project, newRow, {
      content: prepared.content,
      rationale: dto.rationale,
      sourceLocators: prepared.sourceLocators,
    });
    await this.formation.applyAttempt(project, newRow, outcome, 0);

    // ── ④ 未达成 ⇒ 释放唯一位（新行 withdrawn + 清 ids）并如实回报 ──
    if (MEMORY_UNFULFILLED_CORRECTION_STATES.includes(outcome.formationState)) {
      await this.withdrawUnfulfilledCorrection(newRow.id);
      newRow.status = MEMORY_NOMINATION_STATUS.WITHDRAWN;
      newRow.engineMemoryIds = null;
      logger.log(
        `memory correction not fulfilled ledger=${newRow.id} state=${outcome.formationState} ` +
          `— released the correction_of unique slot on ${oldRow.id}`,
      );
      return this.formation.toHttpResult(project, newRow, {
        replay: false,
        recoveryPath: outcome.recoveryPath,
        oldClaimStatus: 'still_current',
        // 终态未达成（no_memory / rejected / conflict）：**只有这一处**会产出
        // conflict/rejected 文案 ⇒ 必须传 `correction`（文案要含"已撤回"语义）
        flow: 'correction',
        engineDiagnostics: outcome.engineDiagnostics ?? null,
      });
    }

    // 非终态（failed/unknown/submitted）：行保持 active 以便 retry 续跑，按 §6 抛 503 / 返回 202
    if (outcome.formationState !== MEMORY_FORMATION_STATE.COMMITTED) {
      return this.formation.toHttpResult(project, newRow, {
        replay: false,
        recoveryPath: outcome.recoveryPath,
        oldClaimStatus: 'still_current',
        engineCode: outcome.engineCode,
        unavailableReason: outcome.unavailableReason,
        // ⚠️ 这里虽然传了 `correction`，但 state ∈ {failed, unknown, submitted} 走的是
        // 非终态分支 ⇒ 文案**不会**出现 WITHDRAWN / "NEW clientRequestId"（flow 只作用于
        // conflict/rejected；非终态行没有被撤回，仍可 retry 续跑）
        flow: 'correction',
        engineDiagnostics: outcome.engineDiagnostics ?? null,
      });
    }

    // ── ⑤ 达成 ⇒ 引擎侧 correct + 双写（oldMemoryId 必须透传——它可能不是旧行主记忆） ──
    // ⚠️ `linkFailure` 必须一并透传：链接失败时响应要给 `correctionLinkFailure` +
    // `correction_link_pending` hint（只打日志 = 静默 still_current，卡 61688768）。
    const link = await this.formation.completeCorrectionLink(newRow.id, project, oldMemoryId);
    const fresh = await this.formation.findLedgerOrThrow(newRow.id);
    return this.formation.toHttpResult(project, fresh, {
      replay: link.replay,
      recoveryPath: null,
      oldClaimStatus: link.oldClaimStatus,
      flow: 'correction',
      engineDiagnostics: outcome.engineDiagnostics ?? null,
      // 判别联合收窄：superseded 无 `linkFailure` 键（缺席语义见 DTO 注释）
      ...(link.oldClaimStatus === 'still_current' ? { linkFailure: link.linkFailure } : {}),
    });
  }

  /**
   * 释放未达成更正的唯一位（**清 ids 是不变量的一半**，见文件头）。
   *
   * @param ledgerId 新账本行 id
   */
  async withdrawUnfulfilledCorrection(ledgerId: string): Promise<void> {
    await this.nominations.query(
      `UPDATE memory_nominations
          SET status = $2,
              engine_memory_ids = NULL
        WHERE id = $1`,
      [ledgerId, MEMORY_NOMINATION_STATUS.WITHDRAWN],
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // 预检
  // ══════════════════════════════════════════════════════════════════════

  /** 取旧主张（**必须属于本项目**；跨项目按"本项目无此账本行"处理，不泄露存在性） */
  private async loadOldClaim(projectId: string, correctionOf: string): Promise<MemoryNomination> {
    const oldRow = await this.nominations.findOne({ where: { id: correctionOf } });
    if (!oldRow || oldRow.projectId !== projectId) {
      throw memoryNominationNotFound(correctionOf, 'Old claim');
    }
    if (oldRow.status !== MEMORY_NOMINATION_STATUS.ACTIVE) {
      throw memoryNominationConflict(
        `Old claim '${oldRow.id}' is '${oldRow.status}' — only an ACTIVE claim can be corrected ` +
          '(a superseded claim was already replaced; a withdrawn one was retracted). Read it first: ' +
          `GET /memory/nominations/${oldRow.id}. 旧行非 active`,
      );
    }
    if (
      oldRow.formationState !== MEMORY_FORMATION_STATE.COMMITTED ||
      (oldRow.engineMemoryIds?.length ?? 0) === 0
    ) {
      throw memoryNominationConflict(
        `Old claim '${oldRow.id}' has no formed memory (formation_state=${oldRow.formationState}) — ` +
          'the engine can only correct two ALREADY-FORMED memories. Wait for it to converge ' +
          `(POST /memory/nominations/${oldRow.id}/retry), or just nominate the new claim instead. ` +
          '旧主张未形成，无可更正对象',
      );
    }
    return oldRow;
  }

  /** 解析被更正的引擎记忆 id（缺省 = 旧行主记忆；给了就必须属于旧行） */
  private resolveOldMemoryId(oldRow: MemoryNomination, requested?: string): string {
    const formed = oldRow.engineMemoryIds ?? [];
    if (!requested) return formed[0];
    if (!formed.includes(requested)) {
      throw new BadRequestException({
        message:
          `oldMemoryId '${requested}' is not one of the memories formed by the old claim ` +
          `'${oldRow.id}' (${formed.join(', ')}). Correcting an arbitrary memory id would be an ` +
          'unauthorized write path. oldMemoryId 必须属于旧行',
        code: ErrorCode.VALIDATION_ERROR,
        data: { field: 'oldMemoryId' },
      });
    }
    return requested;
  }

  /** 同一 old 已有有效更正行 ⇒ 409（部分唯一索引是最终仲裁者，这里是友好前置） */
  private async assertNoActiveCorrection(oldLedgerId: string): Promise<void> {
    const existing = await this.nominations.findOne({
      where: {
        correctionOf: oldLedgerId,
        status: Not(MEMORY_NOMINATION_STATUS.WITHDRAWN),
        deletedAt: IsNull(),
      },
    });
    if (existing) {
      throw memoryNominationConflict(
        `Old claim '${oldLedgerId}' already has an ACTIVE correction (${existing.id}, ` +
          `state=${existing.formationState}). Only ONE active correction per claim is allowed ` +
          '(partial unique index). Wait for it to converge, or read it first: ' +
          `GET /memory/nominations/${existing.id}. 同一 old 已有有效更正行`,
      );
    }
  }
}
