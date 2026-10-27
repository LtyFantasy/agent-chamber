/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory **召回与记忆详情**：把引擎返回的条目映射回账本行、按来源权限**批式过滤**、
 *     组装带信任框信封的响应；并守卫"撤权后详情 404"
 *
 * [代码职责]
 *   - `recall`：引擎调用 → 映射 → 权限过滤 → 契约响应 + 遥测（**失败也落行**）
 *   - `getMemory`：本项目映射断言 + **任一来源不可见 ⇒ 404**（防撤权逃逸）
 *   - ⚠️ `loadMemoryIdMapping` **本文件不再实现**（已下沉 `memory-access.service.ts` ②-b 段）：
 *     投影读面（memory-views）是第二个消费方，两处各留一份必然漂移
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §5 权限模型（召回来源过滤四步 +
 *     同源约束三处 + `engineDataSuspect`）/ §6 端点面（recall 响应契约逐字段）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/api-definition.md`。
 *
 * [关键不变量]
 *   - **映射只认 canonical 行**：alias 行 `engine_memory_ids` 恒 NULL（实体不变量），
 *     故"按 ids 建映射"天然把 alias 排除在外；**同一 memory_id 出现在两行 ⇒ fail-closed
 *     + warn**（去掉该映射——宁可过滤，也不指向不确定的行）。
 *   - **召回 `body` 取账本冻结原文**，不取引擎条目的 `body`：Chamber 是事实源，引擎侧正文
 *     可能被外部改动（那正是信任框要消费方"关键使用前回查"的原因）。取法 = 对**已映射的
 *     行 id**做一次批量查询（`select:false` 的 content 必须显式取），**不是**把全项目正文
 *     拉进内存。
 *   - **`engineDataSuspect` 判据三件套**（§5）：`unmapped>0` ∧ 本项目**存在 committed 行**
 *     ∧ **无在途行**。在途行（`formation_state=submitted`）能解释"引擎有你映射不到的记忆"
 *     （刚形成还没收敛）；此时喊狼来了会让消费方怀疑整批数据。
 *   - **`emptyReason` 三值互斥**：有结果 `none` / 引擎零结果 `no_matches` /
 *     有结果但**全被过滤** `all_filtered`——后两者下一步动作不同（换问法 vs 申请来源权限）。
 *   - **`filtered_count` 只落遥测**（不进响应体）：精确条数会泄露"有多少条你看不到"，
 *     响应只给布尔 `filteredByPermission` + 提示文案。
 *   - **`moved` 只对 doc 有定义**：拿**当前** `docs.content_hash` 与冻结 `versionHash` 比；
 *     message/task/comment 无版本列 ⇒ 恒 false（给它们编 hash = "来源未改"永假）。
 *   - **`query` 的落库规则（两列并存，别只记一半）**：`query_hash`（sha256）**恒落**；
 *     `query_text`（**原文**）当且仅当所属项目 `retain_query_text=true` 时落 `dto.query`，
 *     否则写 NULL。开关来自 `recall()` 开头已加载的 `project`（**零额外查询**——
 *     不要为此再 `findOne` 一次 project，那会把单次召回多打一次库往返）。
 *     原文列是 `select:false` 且**刻意零 API 读取面**（运维 SQL 显式 select）；
 *     本文件**不得**给它加任何响应字段或查询入口。
 *   - **召回失败也落遥测行**（本表是引擎可用性的分母）：`unavailable` / `timeout` 各自如实写。
 *   - **记忆详情的 `sources` 与召回同形状**（消费方只学一套投影）。
 *   - **召回项的 `score` 是引擎原值透传（不是本层派生的排序键）**：它只是引擎的词面命中
 *     权重，本层**不得**归一化 / 排序 / 兜底造值——语义与"仅同次召回内可比"的钉法见
 *     `dto/memory-contract.ts`。改口径必须连带同步 controller 的 `@ApiOperation` 文案。
 *
 * [关联代码]
 *   - ../memory-access.service.ts — 项目内容读闸门 + 来源可见性（三处同源约束的统一实现）
 *   - ../memory-formation.service.ts — `toSourceRefProjection`（来源投影的唯一产出点）
 *   - ../engines/memory-engine.interface.ts — 召回/详情结果（**合同镜像**，透传不改名）
 *   - ../memory.constants.ts — 信任框三件套与 14000/14004 错误构造器
 *
 * [修改检查]
 *   □ 已读 [权威文档] §5/§6，改过滤逻辑必须同步三处同源 e2e（召回 / 账本 / 详情）
 *   □ 新增响应字段必须同步 controller 的 Swagger 文案与 e2e 的字段级断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MEMORY_RECALL_EMPTY_REASON,
  MEMORY_RECALL_OUTCOME,
  MEMORY_RECALL_VIEW,
  MEMORY_SOURCE_REF_TYPE,
  MEMORY_UNAVAILABLE_REASON,
  type MemoryRecallEmptyReason,
  type MemoryRecallOutcome,
} from '@agent-chamber/shared';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryRecallEvent } from '../../database/entities/memory-recall-event.entity';
import type { UnifiedActor } from '../../common/types/actor.types';
import {
  MEMORY_ENGINE as MEMORY_ENGINE_TOKEN,
  type MemoryEngine as MemoryEnginePort,
  type HumentRecallItem,
} from './engines/memory-engine.interface';
import {
  allSourcesVisible,
  MemoryAccessService,
  type MappedLedgerRow,
} from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService } from './memory-formation.service';
import { memoryEngineError, memoryNominationNotFound, memoryUnavailable } from './memory.constants';
import {
  MEMORY_DECISION_AUTHORITY,
  MEMORY_TRUST_LEVEL,
  MEMORY_USAGE_NOTE,
  type MemoryDetailResponse,
  type MemoryRecallItem,
  type MemoryRecallResponse,
} from './dto/memory-contract';
import type { RecallMemoryDto } from './dto/recall.dto';

const logger = new Logger('MemoryRecall');

/**
 * ⚠️ 本文件**不再自己维护映射表**：`loadMemoryIdMapping` 与它的两个 interface
 * （`MappedLedgerRow` / `MemoryIdMapping`）已下沉到 `memory-access.service.ts`（②-b 段）
 * ——投影读面（memory-views）是第二个消费方，两份实现必然漂移。
 */
@Injectable()
export class MemoryRecallService {
  constructor(
    @InjectRepository(MemoryNomination) private readonly nominations: Repository<MemoryNomination>,
    @InjectRepository(MemoryRecallEvent)
    private readonly recallEvents: Repository<MemoryRecallEvent>,
    private readonly access: MemoryAccessService,
    private readonly projectService: MemoryProjectService,
    private readonly formation: MemoryFormationService,
    @Inject(MEMORY_ENGINE_TOKEN) private readonly engine: MemoryEnginePort | null,
  ) {}

  /**
   * 召回（`POST /memory/projects/:id/recalls`；含零结果，失败也落遥测）。
   *
   * @param actor 调用者（决定来源过滤面）
   * @param projectId 项目
   * @param dto 召回入参（query/view/预算/上下文）
   * @returns 契约响应（信任框信封 + 空结果判据 + 可疑标记）
   */
  async recall(
    actor: UnifiedActor,
    projectId: string,
    dto: RecallMemoryDto,
  ): Promise<MemoryRecallResponse> {
    const project = await this.projectService.findProjectOrThrow(projectId);
    // 内容端点闸门（治理观察者**不**放行内容面，见 memory-access 文件头不变量）
    await this.access.assertProjectContentRead(actor, project);

    const availability = this.projectService.engineAvailability(project);
    if (!availability.available || this.engine === null) {
      await this.recordRecallEvent(
        null,
        projectId,
        project.retainQueryText,
        actor,
        dto,
        MEMORY_RECALL_OUTCOME.UNAVAILABLE,
        {
          itemCount: 0,
          filteredCount: 0,
          unmappedCount: 0,
        },
      );
      throw memoryUnavailable(
        availability.reason ?? MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
      );
    }

    const result = await this.engine.recall(this.formation.engineTarget(project), {
      query: dto.query,
      view: dto.view ?? MEMORY_RECALL_VIEW.CURRENT,
      maxItems: dto.maxItems,
      maxTokens: dto.maxTokens,
      maxBytes: dto.maxBytes,
      contextIdentity: dto.contextIdentity,
      contextEpoch: dto.contextEpoch,
    });

    if (!result.ok) {
      const outcome: MemoryRecallOutcome =
        result.failure.kind === 'timeout'
          ? MEMORY_RECALL_OUTCOME.TIMEOUT
          : MEMORY_RECALL_OUTCOME.UNAVAILABLE;
      await this.recordRecallEvent(null, projectId, project.retainQueryText, actor, dto, outcome, {
        itemCount: 0,
        filteredCount: 0,
        unmappedCount: 0,
        requestId: result.failure.requestId ?? null,
      });
      // 拿到错误体 ⇒ 502（引擎可达但报错，且本端点没有账本态可回报）；超时/不可达 ⇒ 503
      if (result.failure.kind === 'http' || result.failure.kind === 'invalid_response') {
        throw memoryEngineError(
          result.failure.engineCode,
          'The memory engine refused the recall' +
            `${result.failure.engineCode ? ` (${result.failure.engineCode})` : ''}. Nothing was ` +
            'read; retry later or check the project engine binding.',
        );
      }
      throw memoryUnavailable(
        result.failure.kind === 'timeout'
          ? MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT
          : MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE,
      );
    }

    const engineItems: HumentRecallItem[] = result.value.items;
    const mapping = await this.access.loadMemoryIdMapping(projectId);

    // ① 映射：无映射 ⇒ 过滤 + unmapped++（同时作为 engineDataSuspect 的输入）
    const mapped: Array<{ item: HumentRecallItem; row: MappedLedgerRow }> = [];
    let unmappedCount = 0;
    for (const item of engineItems) {
      const row = mapping.byMemoryId.get(item.memory_id);
      if (!row) {
        unmappedCount += 1;
        continue;
      }
      mapped.push({ item, row });
    }

    // ② 权限：**一次喂全部行**的 refs，再按切片还原（见 memory-access 文件头不变量）
    const verdicts = await this.access.evaluateSourceRefs(
      actor,
      mapped.flatMap((entry) => entry.row.sourceRefs ?? []),
    );

    // ③ 正文取**账本冻结原文**（只对已映射的行批量取；见文件头不变量）
    const bodies = await this.loadLedgerContents([...new Set(mapped.map((entry) => entry.row.id))]);

    let cursor = 0;
    const items: MemoryRecallItem[] = [];
    let filteredCount = 0;
    for (const entry of mapped) {
      const refs = entry.row.sourceRefs ?? [];
      const slice = verdicts.slice(cursor, cursor + refs.length);
      cursor += refs.length;
      if (!allSourcesVisible(slice)) {
        filteredCount += 1;
        continue;
      }
      items.push(this.toRecallItem(entry.item, entry.row, refs, slice, bodies.get(entry.row.id)));
    }

    const engineDataSuspect = unmappedCount > 0 && mapping.hasCommitted && !mapping.hasInFlight;
    if (engineDataSuspect) {
      logger.warn(
        `memory engine data suspect project=${projectId} unmapped=${unmappedCount} — the engine ` +
          'returned memories that map to no committed ledger row of this project',
      );
    }

    await this.recordRecallEvent(
      result.value.recallId,
      projectId,
      project.retainQueryText,
      actor,
      dto,
      MEMORY_RECALL_OUTCOME.OK,
      {
        itemCount: engineItems.length,
        filteredCount,
        unmappedCount,
      },
    );

    return {
      items,
      emptyReason: this.emptyReasonOf(engineItems.length, items.length),
      filteredByPermission: filteredCount > 0,
      engineDataSuspect,
      recallId: result.value.recallId,
      presentationEventId: result.value.presentationEventId ?? null,
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  /**
   * 记忆详情（`GET /memory/projects/:id/memories/:engineMemoryId`）。
   *
   * 两道 404：① 本项目无账本行映射该 memory id（不确认存在性）② **任一来源不可见**
   * （防撤权逃逸：授权过 → 撤权 → 仍能读到冻结正文）。
   */
  async getMemory(
    actor: UnifiedActor,
    projectId: string,
    engineMemoryId: string,
  ): Promise<MemoryDetailResponse> {
    const project = await this.projectService.findProjectOrThrow(projectId);
    await this.access.assertProjectContentRead(actor, project);

    const mapping = await this.access.loadMemoryIdMapping(projectId);
    const row = mapping.byMemoryId.get(engineMemoryId);
    if (!row) throw memoryNominationNotFound(engineMemoryId, 'Memory');

    const refs = row.sourceRefs ?? [];
    const verdicts = await this.access.evaluateSourceRefs(actor, refs);
    if (!allSourcesVisible(verdicts)) {
      // 三处同源约束③：来源不可见 = 整条记忆不可见（404 不确认存在性）
      throw memoryNominationNotFound(engineMemoryId, 'Memory');
    }

    const availability = this.projectService.engineAvailability(project);
    if (!availability.available || this.engine === null) {
      throw memoryUnavailable(
        availability.reason ?? MEMORY_UNAVAILABLE_REASON.PROJECT_ENGINE_UNBOUND,
      );
    }

    const result = await this.engine.readMemory(
      this.formation.engineTarget(project),
      engineMemoryId,
    );
    if (!result.ok) {
      if (result.failure.kind === 'http' || result.failure.kind === 'invalid_response') {
        throw memoryEngineError(
          result.failure.engineCode,
          `The memory engine could not read '${engineMemoryId}'` +
            `${result.failure.engineCode ? ` (${result.failure.engineCode})` : ''}.`,
        );
      }
      throw memoryUnavailable(
        result.failure.kind === 'timeout'
          ? MEMORY_UNAVAILABLE_REASON.ENGINE_TIMEOUT
          : MEMORY_UNAVAILABLE_REASON.ENGINE_UNREACHABLE,
      );
    }

    return {
      memoryId: engineMemoryId,
      ledgerId: row.id,
      category: row.category,
      subject: row.subject,
      scope: row.scope,
      reviewDue: row.reviewAt !== null && row.reviewAt.getTime() <= Date.now(),
      engine: {
        memory: result.value.memory,
        representations: result.value.representations,
        anchors: result.value.anchors,
        partial: result.value.partial,
      },
      sources: refs.map((ref) => this.formation.toSourceRefProjection(ref)),
      trustLevel: MEMORY_TRUST_LEVEL,
      decisionAuthority: MEMORY_DECISION_AUTHORITY,
      usageNote: MEMORY_USAGE_NOTE,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部
  // ══════════════════════════════════════════════════════════════════════

  // 映射表构建（`loadMemoryIdMapping`）**已下沉** `memory-access.service.ts`（②-b 段）：
  // 投影读面是第二个消费方，两份实现必然漂移。本文件的调用点一律走 `this.access.*`。

  /**
   * 批量取账本正文（`content` 是 `select:false`，必须显式取）。
   *
   * @param ledgerIds 已映射的行 id（**不是**全项目行——见文件头不变量）
   * @returns 行 id → 冻结正文
   */
  private async loadLedgerContents(ledgerIds: string[]): Promise<Map<string, string>> {
    if (ledgerIds.length === 0) return new Map();
    const rows = (await this.nominations.query(
      'SELECT id, content FROM memory_nominations WHERE id = ANY($1::uuid[])',
      [ledgerIds],
    )) as Array<{ id: string; content: string }>;
    return new Map(rows.map((row) => [row.id, row.content]));
  }

  /** 召回项装配（合同镜像字段 + 账本字段 + 来源投影） */
  private toRecallItem(
    item: HumentRecallItem,
    row: MappedLedgerRow,
    refs: MemoryNomination['sourceRefs'],
    verdicts: Array<{ visible: boolean; currentVersionHash: string | null }>,
    ledgerContent: string | undefined,
  ): MemoryRecallItem {
    return {
      memoryId: item.memory_id,
      ledgerId: row.id,
      category: row.category,
      subject: row.subject,
      scope: row.scope,
      // 正文 = **账本冻结原文**（取不到时才退回引擎条目 body；见文件头不变量）
      body: ledgerContent ?? item.body,
      kind: item.kind,
      resolution: item.resolution,
      status: item.memory_status,
      // 引擎词面命中排序权重：**原值透传**（不归一化、不兜底造值——语义见 dto/memory-contract.ts
      // 的 `score` 注释；旧后端/旧引擎漏字段由前端 `Number.isFinite` 守卫兜住）
      score: item.score,
      derivation: (refs ?? []).length > 0 ? 'sourced' : 'authorship',
      contentTruncated: row.contentTruncated,
      reviewDue: row.reviewAt !== null && row.reviewAt.getTime() <= Date.now(),
      sources: (refs ?? []).map((ref, index) => {
        const projection = this.formation.toSourceRefProjection(ref);
        const current = verdicts[index]?.currentVersionHash ?? null;
        return {
          ...projection,
          // `moved` **只对 doc 有定义**：当前 contentHash ≠ 冻结 versionHash ⇒ 来源已改
          moved:
            ref.type === MEMORY_SOURCE_REF_TYPE.DOC &&
            current !== null &&
            current !== projection.versionHash,
        };
      }),
    };
  }

  /** 空结果判据（三值互斥，见文件头不变量） */
  private emptyReasonOf(engineItemCount: number, returnedCount: number): MemoryRecallEmptyReason {
    if (returnedCount > 0) return MEMORY_RECALL_EMPTY_REASON.NONE;
    if (engineItemCount === 0) return MEMORY_RECALL_EMPTY_REASON.NO_MATCHES;
    return MEMORY_RECALL_EMPTY_REASON.ALL_FILTERED;
  }

  /**
   * 落一行召回遥测（**失败也落**；两列的规则见文件头 [关键不变量]）。
   *
   * @param engineRecallId 引擎侧召回 id（失败时为 null）
   * @param retainQueryText 所属项目的原文留存开关（来自 `recall()` 开头**已加载**的 project，
   *   本方法不再查库——单次召回不该为此多一次往返）
   * @param counts 计数（`itemCount` = **过滤前**的引擎条数）
   */
  private async recordRecallEvent(
    engineRecallId: string | null,
    projectId: string,
    retainQueryText: boolean,
    actor: UnifiedActor,
    dto: RecallMemoryDto,
    outcome: MemoryRecallOutcome,
    counts: {
      itemCount: number;
      filteredCount: number;
      unmappedCount: number;
      requestId?: string | null;
    },
  ): Promise<void> {
    await this.recallEvents.save(
      this.recallEvents.create({
        projectId,
        actorId: actor.id,
        // 摘要列**恒落**：关掉原文后它仍是唯一的对账线索（且它是稳定的关联键）
        queryHash: sha256Hex(dto.query),
        // 原文列：开关关 ⇒ NULL。**不写空串**——空串会被读成"查了一个空查询"，
        // 与"没留存"是两件事，运维 SQL 必须一眼分清
        queryText: retainQueryText ? dto.query : null,
        view: dto.view ?? MEMORY_RECALL_VIEW.CURRENT,
        outcome,
        itemCount: counts.itemCount,
        filteredCount: counts.filteredCount,
        unmappedCount: counts.unmappedCount,
        engineRecallId,
        requestId: counts.requestId ?? null,
      }),
    );
  }
}

/** sha256 十六进制（召回查询词的摘要；本文件唯一需要摘要的地方） */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
