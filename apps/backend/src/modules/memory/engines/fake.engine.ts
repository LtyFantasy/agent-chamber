/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎端口的**进程内确定性实现**：**仅 test / e2e**（无网络、无状态丢失、结果可复现）
 *
 * [代码职责]
 *   - 六个写/读动词的内存实现（+ alpha.19 的 **usage 两读面**：summary/trace）：提名即 `committed`（确定性 memory id；**同 workspace+同正文的第二次
 *     提名判 alias**，见下）、按 content 子串召回、更正记录 supersession、按 id 读回存储内容
 *   - 五个**投影读面**的内存实现（alpha.5 的 graph / detail / history / representation +
 *     alpha.6 的 relations）+ **usage 两读面**：由同一份 `memories` 确定性派生（图 / 梯 / 史 / 正文 / 关系建议
 *     五者必须自洽）
 *   - `healthCheck()`：**恒 ok**（进程内替身没有"存储不可用"这一态；探针失败面由
 *     `ScriptedEngine` 与 tracker/probe 单测覆盖）
 *   - `reset()`：测试夹具（`beforeEach` 清空；**不对外暴露任何 HTTP 语义**）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3（"FakeEngine：进程内确定性，仅 test/e2e；
 *     production `MEMORY_ENGINE=fake` fail-fast"）+ §8 e2e 矩阵
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 合同事实源（只读）: Hument 仓 `contracts/schema/memory-view-*.schema.json` +
 *     `memory-relations-response.schema.json`（五读面的字段名/必填/上限）+
 *     `internal/domain/workbench_projection.go:6-13`（默认档）+
 *     `internal/domain/relation_advisory.go`（关系建议的域类型）
 *
 * [关键不变量]
 *   - **⚠️ 本类只在 test / e2e 注入**（e2e 经 `overrideProvider(MEMORY_ENGINE_RAW)` 装配，
 *     包装层 `InstrumentedMemoryEngine` 由工厂套上）。
 *     production 下 `MEMORY_ENGINE=fake` 由 **config 层 fail-fast 拒启动**（memory.config.ts），
 *     且 `fake` **不在落库值域**（shared `MEMORY_ENGINES` 只有 `none|hument`）——
 *     把 fake 接进生产 = 每次形成都伪装成 committed，Hub 里空无一物而账本记满 ids。
 *   - **确定性是唯一硬指标**：`memory_id = 'mem_' + sha256(workspaceId:content)[:16]`（同
 *     workspace + 同 content ⇒ 同 id，跨进程可复现）；所有 id 与**所有时间戳**全部由 sha256 派生
 *     （`fakeTimestamp`），**不用随机数、不用 `Date.now()`**（e2e 断言才能钉住）。
 *   - **幂等语义对齐 Hument**：nominate 按 `chamber-<账本id>` 记忆回执（同键重发返回同一回执，
 *     不二次形成）；correct 按 `chamber-correct-<新账本id>` 同理，第二次起的回执 `replay=true`。
 *   - **内容级去重 = alias 语义（对齐 Hument）**：nominate 派生出的 memory id **已在 `memories`
 *     表里** ⇔ 另一账本键曾以同 workspace + 同正文形成过这条记忆（同键重发已被幂等短路拦下）
 *     ⇒ 本次回执 `duplicate=true` + `canonicalNominationId` = 既有记录的提名 id、`memoryIds: []`，
 *     且**不覆盖**既有记录、不产生第二条记忆。判序：**幂等重放 → 去重 → 正常形成**。
 *     回执刻意带上 `jobState/outcome=committed` 形态（Hument 的 alias 就是这样叠的），
 *     好让 e2e 能钉住 mapper "duplicate 最先判"的判序（漏判则 alias 被记成 canonical 并写 ids）。
 *   - **更正记录 supersession**：`correct(old,new)` 把旧记忆标 `superseded` 并追加
 *     `supersession=[newId]`，且**召回在非 `history` 视图下不再返回它**——这是 §8 e2e
 *     "更正后 current 不命中旧主张"的判据来源（否则该用例只能靠真 Hub 跑）。
 *   - **投影读面：载荷必须过合同的 required 集自检**（"fake 通过 ⇏ 合同通过"的盲区在这里）：
 *     detail 的 `provenance` **7 键齐**（旧实现给 `{}`，不达标）、节点/梯的 `scope` = `actor_private`
 *     （与平台恒传一致；不用 `workspace_shared` 那种更宽的值——假件比真实现宽松 = 契约守卫失效）。
 *   - **投影读面：游标双通道语义是"真实的"**（不是模拟的失败面）：游标绑 `snapshot + query digest`，
 *     query 变 ⇒ `400 invalid_argument`、快照变 ⇒ `409 snapshot_stale`。两条都要能被 e2e 钉住，
 *     所以它们由本类实现而不是测试侧脚本（与下面那条"不模拟失败面"不冲突：这是**读路径语义**，
 *     不是引擎故障注入）。
 *   - **合成边是诚实的谎言**：只有 `supersedes` 来自真实 `correct`（方向逐字对齐 hument
 *     `memory_corrections.go:465`：`from=新记忆`、`to=旧记忆`）；`derived_from`/`supports`/
 *     `contradicts`/`part_of` 是**合成**的（规则见 `FAKE_SYNTHETIC_EDGE_TYPES` 注释），只为让
 *     前端五类线型/图例有确定性输入。**不要**据它推断真引擎的产边行为。
 *   - **不模拟 Hument 的失败面**（quota / 前缀未收敛 / provider 拒等）：那些分支由单测直击
 *     `formation-state.mapper.ts` 与 `hument.engine.ts`；e2e 若要注入引擎故障，
 *     应自行 `overrideProvider(MEMORY_ENGINE_RAW)` 换 stub（**别把故障注入开关塞进本类**——
 *     那会让"fake 通过"与"故障分支通过"两件事混在一个类里）。
 *
 * [关联代码]
 *   - memory-engine.interface.ts — 端口契约（本类必须逐字段对齐）
 *   - hument.engine.ts — 真实现（本类是它的可预测替身）
 *   - memory-engine.factory.ts — `MEMORY_ENGINE=fake` 分派点
 *   - ../memory-views.service.ts — 五个读面的消费方（本类的 `snapshot_digest` / 计数被它使用）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改端口契约（接口）必须同步本类——编译期会红，但**归一化字段的语义**需人工对齐
 *   □ 改读面的取值（默认档 / 游标语义 / 边方向）必须同步 `memory-views.service.spec` /
 *     `fake.engine.spec` / `test/memory.e2e-spec.ts` 三处断言——它们是同一份"引擎行为"的证据
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { createHash } from 'node:crypto';
import type { MemoryEngineName } from '../../../config/memory.config';
import type {
  CorrectMemoryInput,
  HumentGraphEdge,
  HumentGraphNode,
  HumentLadderSlot,
  HumentMemoryGraphView,
  HumentMemoryGraphViewQuery,
  HumentMemoryRelations,
  HumentMemoryRepresentation,
  HumentMemoryViewDetail,
  HumentMemoryViewHistory,
  HumentMemoryViewHistoryQuery,
  HumentMemoryViewRepresentation,
  HumentMemoryViewRelationsQuery,
  HumentMemoryViewTarget,
  HumentProjectionPage,
  HumentRecallItem,
  HumentRecallTrace,
  HumentRelationAdvisory,
  HumentRepresentationBody,
  HumentRepresentationHistoryItem,
  HumentViewMemoryDetail,
  HumentUsageCounts,
  HumentUsageCoverage,
  HumentUsageGroup,
  HumentUsageSummary,
  HumentUsageSummaryQuery,
  HumentUsageTotals,
  HumentUsageTrace,
  HumentUsageTraceQuery,
  HumentUsageTraceRow,
  InspectCorrectionInput,
  InspectNominationInput,
  MemoryCorrectionResult,
  MemoryEngine,
  MemoryEngineFailure,
  MemoryEngineResult,
  MemoryEngineTarget,
  MemoryNominationResult,
  MemoryReadResult,
  MemoryRecallResult,
  NominateMemoryInput,
  RecallMemoryInput,
} from './memory-engine.interface';

/**
 * fake 内部记忆状态（值域对齐 Hument `memory.status`：`active|superseded|archived`）。
 *
 * rationale：`'active'` 已在 eslint 的魔法字符串黑名单里（shared 多枚举同值）——用常量对象
 * 取值既过闸，也让"哪些地方依赖 current 语义"可 grep（`FAKE_MEMORY_STATUS.ACTIVE`）。
 */
const FAKE_MEMORY_STATUS = {
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  ARCHIVED: 'archived',
} as const;

/** fake 记忆状态 */
type FakeMemoryStatus = (typeof FAKE_MEMORY_STATUS)[keyof typeof FAKE_MEMORY_STATUS];

/** 存储的记忆（fake 内部模型；字段只为断言与召回装配服务） */
interface FakeMemoryRecord {
  /** 确定性 id（`mem_` + sha256(content)[:16]） */
  memoryId: string;
  /** 形成正文（readMemory 的 body 来源） */
  content: string;
  /** 记忆类别（提名时给出） */
  category: string;
  /** 记忆状态（correct 会把它置 `superseded`） */
  status: FakeMemoryStatus;
  /** 取代链（correct 追加新 memory id） */
  supersession: string[];
  /** 形成它的 workspace（跨 workspace 隔离） */
  workspaceId: string;
  /** 形成它的提名 id（inspect by memoryId 反查用） */
  nominationId: string;
  /** 形成时刻（**确定性派生**，不是真实时钟——graph 的 created_at 与时间过滤用它） */
  createdAt: string;
}

/** 提名的幂等回执（键 = `chamber-<账本id>`） */
interface FakeNominationRecord {
  nominationId: string;
  jobId: string;
  memoryId: string | null;
  result: MemoryNominationResult;
}

/** sha256 十六进制前 16 位（确定性 id 派生；**唯一 id 生成方式**） */
function sha256Hex16(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** fake 的"时钟"基准（确定性优先于真实性：固定纪元 + 由 seed 派生的秒级偏移） */
const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * 确定性时间戳（同一 seed 恒同值；不同记忆落在不同时刻，前端布局有稳定序可用）。
 *
 * ⚠️ 刻意**不用 `Date.now()`**：fake 的确定性是 e2e 断言成立的前提（同一份夹具跨进程/跨用例
 * 必须产出同一张图），引入真实时钟 = 断言时红时绿。
 */
function fakeTimestamp(seed: string): string {
  const offsetSeconds = Number.parseInt(sha256Hex16(seed).slice(0, 4), 16) % 3600;
  return new Date(FAKE_EPOCH_MS + offsetSeconds * 1000).toISOString();
}

/**
 * fake 的**合成关系边类型池**（除 `supersedes` 外）。
 *
 * ⚠️ 语义诚实声明：只有 `supersedes` 是**真实**的（来自 `correct` 调用）。其余四类是**合成**
 * 的——fake 没有引擎侧的关系推导能力（derived_from / supports / contradicts / part_of 需要真实的
 * 形成与关系判定）。合成规则 = "同一 workspace 内按 id 排序，除首个外各连一条到首个"，
 * 唯一目的是让前端五类线型 / 图例 / 抽屉 relations 有确定性输入。
 * **不要**把它读成"引擎会这样产边"——真引擎的边语义以 Hument 合同为准。
 */
const FAKE_SYNTHETIC_EDGE_TYPES = ['derived_from', 'supports', 'contradicts', 'part_of'] as const;

/** 全量 sha256（回执 digest 字段用） */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 字节长度（UTF-8；召回预算计算用） */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 固定失败的构造（fake 只产出 404 一种引擎失败：**找不到就是找不到**） */
function notFound(what: string, latencyMs = 0): MemoryEngineResult<never> {
  const failure: MemoryEngineFailure = {
    kind: 'http',
    message: `fake engine: ${what} not found`,
    httpStatus: 404,
    engineCode: 'resource_not_found',
    retryable: false,
    latencyMs,
  };
  return { ok: false, failure };
}

/**
 * 进程内确定性引擎（**仅 test/e2e**；见文件头不变量）。
 *
 * 状态按 workspace 隔离（同 workspace 内共享记忆）——对齐 Hument "每项目独立 workspace"的
 * 模型，让 e2e 的换绑/越界用例有真实语义。
 */
export class FakeEngine implements MemoryEngine {
  readonly name: MemoryEngineName = 'fake';

  /** 提名幂等表（键 = `chamber-<账本id>`） */
  private readonly nominations = new Map<string, FakeNominationRecord>();

  /** 记忆表（键 = memory_id） */
  private readonly memories = new Map<string, FakeMemoryRecord>();

  /** 更正幂等表（键 = `chamber-correct-<新账本id>`） */
  private readonly corrections = new Map<string, MemoryCorrectionResult>();

  /**
   * 清空全部内存状态（**测试夹具专用**）。
   *
   * rationale：e2e 每个用例都要一个干净引擎；重建实例也可，但"实例字段是私有 Map"时
   * 显式 reset 更省事，也避免用例忘建新实例时互相污染（污染表现为"第二个用例莫名 duplicate"）。
   */
  reset(): void {
    this.nominations.clear();
    this.memories.clear();
    this.corrections.clear();
  }

  /**
   * 提交提名：**即 committed**（memory id 由 workspace+content 派生）。
   *
   * 判序（三者不可换位，见文件头不变量）：
   * 1. 幂等重放（同 `chamber-<账本id>`）⇒ 原样返回首次回执；
   * 2. 内容级去重：同 workspace + 同正文已有记忆 ⇒ `duplicate=true` 的 **alias** 回执
   *    （指向既有记录的提名 id，自己**不形成**记忆、不覆盖既有记录）；
   * 3. 否则正常形成（`duplicate=false` + `memoryIds=[新 id]`）。
   */
  async nominate(
    target: MemoryEngineTarget,
    input: NominateMemoryInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    const key = `chamber-${input.ledgerId}`;
    const existing = this.nominations.get(key);
    // 幂等：同键重发返回**同一回执**（不二次形成）——对齐 Hument 的 replay 语义
    if (existing) return { ok: true, value: existing.result };

    // ⚠️ memory id **含 workspace 维度**：`每项目独立 workspace`（方案 §1）意味着
    // "同内容"在两个 workspace 里是**两条**记忆。若只按 content 派生 id，跨 workspace 的
    // 同内容会互相顶掉记录（`memories` 表以 id 为键）——换绑/越界用例的隔离语义随之失真。
    const memoryId = `mem_${sha256Hex16(`${target.workspaceId}:${input.content}`)}`;
    const nominationId = `nom_${sha256Hex16(input.ledgerId)}`;
    const jobId = `job_${sha256Hex16(key)}`;

    // ── 内容级去重（对齐 Hument）：同 workspace + 同正文 ⇒ 同 memory id，故"该 id 已在表里"
    //    ⇔ **另一账本键**曾形成过这条记忆（同键重发已在上面幂等短路）——本次提名是 **alias**。
    //    判定不看既有记录状态（superseded 也仍是同一 id、同一条记忆），只看 id 是否已在。──
    const canonical = this.memories.get(memoryId);
    if (canonical) {
      const alias: MemoryNominationResult = {
        // alias 自己仍有一条引擎提名记录（Hument 的 alias 回执同样带 nomination_id）
        engineNominationId: nominationId,
        // 镜像源：既有（canonical）记录的引擎提名 id——服务层据此查 canonical 行、镜像其当前态
        canonicalNominationId: canonical.nominationId,
        duplicate: true,
        // ⚠️ 刻意给"看起来已成功"的 job 字段：Hument 的 alias 回执正是 `duplicate=true` 叠在一个
        //    committed 形态的 job 上（mapper 文件头把这一组合列为"必须先判 duplicate"的理由）；
        //    给成缺席形态会让 e2e 失去对判序的守卫力（映射漏判则 alias 被记成 canonical）。
        jobState: 'committed',
        deferred: false,
        outcome: 'memory_committed',
        // 自造的**说明性** reason_code（**非 Hument 合同值**；映射只认 §7 的两个 reason_code，
        // 其余值不改变分派、也不落遥测的 reasonCode 列——那一列取的是 engineCode）
        reasonCode: 'exact_content_duplicate',
        // alias **不形成新记忆**：ids 恒空（mapper 另有硬约束；下面也不写 memories）
        memoryIds: [],
        durable: true,
      };
      // 幂等：alias 回执同样按 `chamber-<账本id>` 记忆（同键重发返回同一回执，不二次判定）
      this.nominations.set(key, { nominationId, jobId, memoryId, result: alias });
      return { ok: true, value: alias };
    }

    this.memories.set(memoryId, {
      memoryId,
      content: input.content,
      category: input.category,
      status: 'active',
      supersession: [],
      workspaceId: target.workspaceId,
      nominationId,
      // 确定性时间戳（**不是** Date.now()——见 fakeTimestamp 注释）
      createdAt: fakeTimestamp(memoryId),
    });

    const result: MemoryNominationResult = {
      engineNominationId: nominationId,
      duplicate: false,
      jobState: 'committed',
      deferred: false,
      outcome: 'memory_committed',
      reasonCode: 'memory_materialized',
      memoryIds: [memoryId],
      durable: true,
    };
    this.nominations.set(key, { nominationId, jobId, memoryId, result });
    return { ok: true, value: result };
  }

  /** 提名 inspect（只读；按 nominationId 或 memoryId 反查） */
  async inspectNomination(
    _target: MemoryEngineTarget,
    input: InspectNominationInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    if ('nominationId' in input && input.nominationId) {
      for (const record of this.nominations.values()) {
        if (record.nominationId === input.nominationId) return { ok: true, value: record.result };
      }
      return notFound('nomination');
    }
    const memoryId = 'memoryId' in input ? input.memoryId : undefined;
    if (!memoryId) return notFound('nomination');
    const memory = this.memories.get(memoryId);
    if (!memory) return notFound('memory');
    for (const record of this.nominations.values()) {
      if (record.nominationId === memory.nominationId) return { ok: true, value: record.result };
    }
    return notFound('nomination');
  }

  /** 召回：**content 子串匹配**（确定性排序 + 预算截断） */
  async recall(
    target: MemoryEngineTarget,
    input: RecallMemoryInput,
  ): Promise<MemoryEngineResult<MemoryRecallResult>> {
    // 命中集：同 workspace && content 含查询词（`view=history` 时保留已取代的记忆）
    const historyView = input.view === 'history';
    const matched = [...this.memories.values()]
      .filter((memory) => memory.workspaceId === target.workspaceId)
      .filter((memory) => memory.content.includes(input.query))
      .filter((memory) => historyView || memory.status === FAKE_MEMORY_STATUS.ACTIVE)
      .sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));

    const items: HumentRecallItem[] = [];
    let usedTokens = 0;
    let usedBytes = 0;
    for (const memory of matched) {
      const bodyBytes = utf8Bytes(memory.content);
      const bodyTokens = Math.ceil(bodyBytes / 4);
      // 预算截断（确定性：按 id 序逐个装填，装不下就停）——与响应里的 byte/token_estimate 同源
      if (input.maxItems !== undefined && items.length >= input.maxItems) break;
      if (input.maxTokens !== undefined && usedTokens + bodyTokens > input.maxTokens) break;
      if (input.maxBytes !== undefined && usedBytes + bodyBytes > input.maxBytes) break;
      usedTokens += bodyTokens;
      usedBytes += bodyBytes;
      items.push(buildRecallItem(memory, bodyBytes, bodyTokens));
    }

    const trace: HumentRecallTrace = {
      policy_version: 'fake.deterministic.v1',
      query_digest: sha256Hex(input.query),
      binding_id: `bind_${sha256Hex16(target.workspaceId)}`,
      presentation_event_id: `pres_${sha256Hex16(`${input.contextIdentity}:${input.contextEpoch}`)}`,
      source_scopes: [],
      home_cell_id: `cell_${sha256Hex16(target.workspaceId)}`,
      coordinator_scope: 'workspace_shared',
      watermarks: [],
      candidates: [],
      suppressed_item_ids: [],
      selected_item_ids: items.map((item) => item.memory_id),
      budget: {},
      provider_calls: 0,
      presentation_pending: false,
    };

    return {
      ok: true,
      value: {
        recallId: `rec_${sha256Hex16(`${target.workspaceId}:${input.contextIdentity}:${input.query}`)}`,
        presentationEventId: trace.presentation_event_id,
        items,
        trace,
      },
    };
  }

  /** 更正：记录 supersession（旧记忆转 `superseded`），幂等键 = `chamber-correct-<新账本id>` */
  async correct(
    _target: MemoryEngineTarget,
    input: CorrectMemoryInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    const key = `chamber-correct-${input.newLedgerId}`;
    const existing = this.corrections.get(key);
    // 幂等 replay：第二次起 replay=true（对齐 Hument 回执语义，中断续跑靠它判"已达成"）
    if (existing) return { ok: true, value: { ...existing, replay: true } };

    const oldMemory = this.memories.get(input.oldMemoryId);
    const newMemory = this.memories.get(input.newMemoryId);
    if (!oldMemory) return notFound('old memory');
    if (!newMemory) return notFound('new memory');

    oldMemory.status = 'superseded';
    if (!oldMemory.supersession.includes(input.newMemoryId)) {
      oldMemory.supersession.push(input.newMemoryId);
    }

    const result: MemoryCorrectionResult = {
      engineCorrectionId: `corr_${sha256Hex16(input.newLedgerId)}`,
      oldMemoryId: input.oldMemoryId,
      newMemoryId: input.newMemoryId,
      replay: false,
    };
    this.corrections.set(key, result);
    return { ok: true, value: result };
  }

  /** 更正 inspect（只读；按 correctionId 或幂等键） */
  async inspectCorrection(
    _target: MemoryEngineTarget,
    input: InspectCorrectionInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    if ('idempotencyKey' in input && input.idempotencyKey) {
      const found = this.corrections.get(input.idempotencyKey);
      return found ? { ok: true, value: found } : notFound('correction');
    }
    const correctionId = 'correctionId' in input ? input.correctionId : undefined;
    if (!correctionId) return notFound('correction');
    for (const record of this.corrections.values()) {
      if (record.engineCorrectionId === correctionId) return { ok: true, value: record };
    }
    return notFound('correction');
  }

  /** 按 memory_id 读记忆（返回**存储内容** + 取代链；表示固定一条 current） */
  async readMemory(
    _target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<MemoryReadResult>> {
    const memory = this.memories.get(memoryId);
    if (!memory) return notFound('memory');

    return {
      ok: true,
      value: {
        memory: {
          memory_id: memory.memoryId,
          namespace_id: `ns-${sha256Hex(memory.workspaceId)}`,
          kind: 'concept',
          workspace_id: memory.workspaceId,
          actor_id: 'fake-actor',
          scope: 'workspace_shared',
          available_resolution: 'R2',
          active_resolution: 'R2',
          status: memory.status,
          // ⚠️ provenance 是**合同 required**（memory-inspect 要求 10 键、views 要求 7 键）：
          // 旧的 `provenance: {}` 在"fake 通过 ⇏ 合同通过"的盲区里躺了很久（e2e 不逐字段断言
          // 引擎镜像），这里按合同补齐——fake 的载荷也要过合同的 required 集自检。
          provenance: buildProvenance(memory),
          confidence: null,
          evidence: [],
          contradiction: [],
          // supersession **在 memory 内部**（方案 §3：readMemory 响应拍平）
          supersession: [...memory.supersession],
          created_at: memory.createdAt,
        },
        // ⚠️ 这是 **memory-inspect（19.16）** 的表示形状（多 `namespace_id`/`memory_id`、
        // 无 `body_truncated`），与 views 读面的 `workbench-representation-body` **不同形**——
        // 故不能复用 `buildRepresentationBody`（那是 views 的形状）。
        representations: [buildInspectRepresentation(memory)],
        anchors: [],
        partial: false,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // alpha.5 投影读面（四读面）——纯读、确定性、整族逐字透传
  //
  // ⚠️ 与写动词的分工：四读面**只读内存状态**，不触发形成、不改 active resolution。
  // 图/梯/史/正文全部由同一份 `memories` 派生（同一份夹具 ⇒ 同一张图，跨进程可复现）。
  // ══════════════════════════════════════════════════════════════════════

  /** 记忆关系图投影（GET；只读；游标绑 snapshot + query digest） */
  async getGraphView(
    target: MemoryEngineTarget,
    query: HumentMemoryGraphViewQuery,
  ): Promise<MemoryEngineResult<HumentMemoryGraphView>> {
    const all = this.workspaceMemories(target.workspaceId);
    const snapshot = this.snapshotDigest(target.workspaceId);

    // ① 过滤器（值域外的取值一律不命中——`any`/未传 = 不过滤）
    const filtered = all.filter((memory) => {
      if (query.kind !== undefined && memory.category !== query.kind) return false;
      if (query.status !== undefined && memory.status !== query.status) return false;
      if (query.active_resolution !== undefined && query.active_resolution !== FAKE_RESOLUTION) {
        return false;
      }
      if (
        query.available_resolution !== undefined &&
        query.available_resolution !== FAKE_RESOLUTION
      ) {
        return false;
      }
      if (query.anchor_state !== undefined && query.anchor_state !== FAKE_ANCHOR_STATE)
        return false;
      // ⚠️ 时间比较必须走 `Date.parse`（**不是字符串字典序**）：合同里的 RFC3339 允许带偏移量
      //    （如 `2026-01-01T00:00:00+08:00`），而字典序只在"同一时区 + 同一格式"下才等价于时间序
      //    ——`'...T00:00:00+08:00' < '...T00:00:00Z'` 按字符串比是 true，按时间比是 false。
      //    fake 的 `createdAt` 恒以 `Z` 结尾，故只有右侧需要解析（两侧都解析也无害）。
      if (
        query.created_from !== undefined &&
        Date.parse(memory.createdAt) < Date.parse(query.created_from)
      ) {
        return false;
      }
      if (
        query.created_to !== undefined &&
        Date.parse(memory.createdAt) > Date.parse(query.created_to)
      ) {
        return false;
      }
      return true;
    });

    // ② 游标（先判 query digest，再判 snapshot——与 hument 的两通道语义同序）
    const queryDigest = digestOfQuery({ ...query, cursor: undefined });
    const cursor = this.resolveCursor(query.cursor, snapshot, queryDigest);
    if (!cursor.ok) return this.cursorFailure(cursor);

    const allEdges = this.buildEdges(all).filter(
      (edge) => query.relation_type === undefined || edge.type === query.relation_type,
    );

    const nodeLimit = query.node_limit ?? FAKE_DEFAULT_NODE_LIMIT;
    const edgeLimit = query.edge_limit ?? FAKE_DEFAULT_EDGE_LIMIT;
    const previewScalars = query.preview_scalars ?? FAKE_DEFAULT_PREVIEW_SCALARS;

    const pageNodes = filtered.slice(cursor.offset, cursor.offset + nodeLimit);
    const loadedIds = new Set(pageNodes.map((memory) => memory.memoryId));
    // browse 语义：**只取两端点都在本次节点页内**的边（跨页的边永远画不出来，见 omitted_edge_count）
    const incident = allEdges.filter(
      (edge) => loadedIds.has(edge.from_id) && loadedIds.has(edge.to_id),
    );
    const pageEdges = incident.slice(0, edgeLimit);

    const nextOffset = cursor.offset + pageNodes.length;
    const hasMore = nextOffset < filtered.length;
    const edgesTruncated = incident.length > pageEdges.length;

    return {
      ok: true,
      value: {
        schema_version: 'memory-view-memory-graph-v1',
        request_id: `req_${sha256Hex16(`${snapshot}:${queryDigest}:${cursor.offset}`)}`,
        auth_kind: 'binding_credential_ref',
        authority: 'inspect_read',
        target: this.viewTarget(target),
        snapshot_digest: snapshot,
        mode: query.mode ?? 'browse',
        center_memory_id: query.center_memory_id ?? '',
        filters: {
          kind: query.kind ?? FAKE_FILTER_ANY,
          status: query.status ?? FAKE_FILTER_ANY,
          active_resolution: query.active_resolution ?? FAKE_FILTER_ANY,
          available_resolution: query.available_resolution ?? FAKE_FILTER_ANY,
          anchor_state: query.anchor_state ?? FAKE_FILTER_ANY,
          created_from: query.created_from ?? null,
          created_to: query.created_to ?? null,
          relation_type: query.relation_type ?? FAKE_FILTER_ANY,
        },
        budget: {
          node_limit: nodeLimit,
          edge_limit: edgeLimit,
          neighborhood_limit: query.neighborhood_limit ?? FAKE_DEFAULT_NEIGHBORHOOD_LIMIT,
          preview_scalars: previewScalars,
          depth: 1,
        },
        node_page: {
          total: filtered.length,
          total_kind: 'exact',
          loaded: pageNodes.length,
          next_cursor: hasMore
            ? this.encodeCursor({ off: nextOffset, snapshot, query: queryDigest })
            : '',
          partial: false,
          truncated: hasMore,
          truncation_reason: hasMore ? 'node_limit' : '',
        },
        edge_page: {
          total: allEdges.length,
          total_kind: 'exact',
          loaded: pageEdges.length,
          next_cursor: '',
          partial: false,
          truncated: edgesTruncated,
          truncation_reason: edgesTruncated ? 'edge_limit' : '',
        },
        omitted_edge_count: incident.length - pageEdges.length,
        nodes: pageNodes.map((memory) => buildGraphNode(memory, allEdges, previewScalars)),
        edges: pageEdges,
        redaction: 'memory-projection-safe-v1',
      },
    };
  }

  /** 单条记忆的分节详情 + 五槽分辨率阶梯（GET；只读） */
  async getMemoryView(
    target: MemoryEngineTarget,
    memoryId: string,
    query: HumentMemoryViewRelationsQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewDetail>> {
    const memory = this.workspaceMemories(target.workspaceId).find(
      (candidate) => candidate.memoryId === memoryId,
    );
    if (!memory) return notFound('memory');

    const snapshot = this.snapshotDigest(target.workspaceId);
    // ⚠️ **游标自身不进 digest**（与 graph / history 两个兄弟调用点同款）：否则第 1 页
    //    （无游标 ⇒ `relation_cursor: undefined` 被 `digestOfQuery` 丢掉）写出的摘要，
    //    与第 2 页（带着游标 ⇒ 摘要里多一个键）重算的摘要**必然不等** ⇒ 第 2 页恒被自己的
    //    防重放闸门判成 `400 invalid_argument`（翻页功能整体失效，且症状看起来像"引擎拒绝"）。
    const queryDigest = digestOfQuery({ relation_limit: query.relation_limit });
    const cursor = this.resolveCursor(query.relation_cursor, snapshot, queryDigest);
    if (!cursor.ok) return this.cursorFailure(cursor);

    const relationLimit = query.relation_limit ?? FAKE_DEFAULT_RELATION_LIMIT;
    // ⚠️ **必须用整个 workspace 的边集**再筛"与本记忆相连"的：只喂 `[memory]` 会漏掉
    //    · 指向它的**合成**入边（合成边是"连到 workspace 首个记忆"的，根节点的入边全在别人身上）
    //    · 由它发出的 `supersedes`（该边记在**被取代的旧记忆**的 `supersession` 上，
    //      `buildEdges([memory])` 里看不到）
    //    两种漏法都表现为"relations 恒空"，而图页上明明有边。
    const allEdges = this.buildEdges(this.workspaceMemories(target.workspaceId));
    const relations = allEdges.filter(
      (edge) => edge.from_id === memoryId || edge.to_id === memoryId,
    );
    const pageRelations = relations.slice(cursor.offset, cursor.offset + relationLimit);

    const nextOffset = cursor.offset + pageRelations.length;
    const hasMore = nextOffset < relations.length;

    return {
      ok: true,
      value: {
        schema_version: 'memory-view-memory-detail-v1',
        request_id: `req_${sha256Hex16(`${snapshot}:${memoryId}:${cursor.offset}`)}`,
        auth_kind: 'binding_credential_ref',
        authority: 'inspect_read',
        target: this.viewTarget(target),
        snapshot_digest: snapshot,
        memory: buildViewMemoryDetail(memory),
        sections: {
          representations: {
            page: pageOf(FAKE_LADDER_RESOLUTIONS.length, FAKE_LADDER_RESOLUTIONS.length),
            ladder: buildLadder(memory),
          },
          anchors: { page: pageOf(0, 0), items: [] },
          relations: {
            page: {
              ...pageOf(relations.length, pageRelations.length),
              next_cursor: hasMore
                ? this.encodeCursor({ off: nextOffset, snapshot, query: queryDigest })
                : '',
              truncated: hasMore,
              truncation_reason: hasMore ? 'relation_limit' : '',
            },
            items: pageRelations,
          },
        },
        redaction: 'memory-projection-safe-v1',
      },
    };
  }

  /** 某一分辨率的**旧版本**列表（GET；只读；`current` 恒 false） */
  async getMemoryViewHistory(
    target: MemoryEngineTarget,
    memoryId: string,
    resolution: string,
    query: HumentMemoryViewHistoryQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewHistory>> {
    const memory = this.workspaceMemories(target.workspaceId).find(
      (candidate) => candidate.memoryId === memoryId,
    );
    if (!memory) return notFound('memory');

    const snapshot = this.snapshotDigest(target.workspaceId);
    const queryDigest = digestOfQuery({ ...query, cursor: undefined });
    const cursor = this.resolveCursor(query.cursor, snapshot, queryDigest);
    if (!cursor.ok) return this.cursorFailure(cursor);

    const historyLimit = query.history_limit ?? FAKE_DEFAULT_HISTORY_LIMIT;
    // ⚠️ 只有 R2 有旧版本（见 buildHistoricalRepresentation）：其余分辨率返回**合法的空页**
    //    （history 为空是常态，不是缺陷——正确语义见 shared 枚举注释）
    const all = resolution === FAKE_RESOLUTION ? [buildHistoryItem(memory)] : [];
    const items = all.slice(cursor.offset, cursor.offset + historyLimit);
    const nextOffset = cursor.offset + items.length;
    const hasMore = nextOffset < all.length;

    return {
      ok: true,
      value: {
        schema_version: 'memory-view-representation-history-v1',
        request_id: `req_${sha256Hex16(`${snapshot}:${memoryId}:${resolution}:${cursor.offset}`)}`,
        auth_kind: 'binding_credential_ref',
        authority: 'inspect_read',
        target: this.viewTarget(target),
        snapshot_digest: snapshot,
        memory_id: memory.memoryId,
        resolution,
        page: {
          ...pageOf(all.length, items.length),
          next_cursor: hasMore
            ? this.encodeCursor({ off: nextOffset, snapshot, query: queryDigest })
            : '',
          truncated: hasMore,
          truncation_reason: hasMore ? 'history_limit' : '',
        },
        items,
        redaction: 'memory-projection-safe-v1',
      },
    };
  }

  /** 单份表示正文（GET；只读；**不改 active resolution**） */
  async getMemoryViewRepresentation(
    target: MemoryEngineTarget,
    memoryId: string,
    representationId: string,
  ): Promise<MemoryEngineResult<HumentMemoryViewRepresentation>> {
    const memory = this.workspaceMemories(target.workspaceId).find(
      (candidate) => candidate.memoryId === memoryId,
    );
    if (!memory) return notFound('memory');

    const body =
      representationId === historicalRepresentationId(memory.memoryId)
        ? buildHistoricalRepresentation(memory)
        : FAKE_LADDER_RESOLUTIONS.map((resolution) =>
            buildRepresentationBody(memory, resolution),
          ).find((candidate) => candidate.representation_id === representationId);
    if (!body) return notFound('representation');

    return {
      ok: true,
      value: {
        schema_version: 'memory-view-representation-detail-v1',
        request_id: `req_${sha256Hex16(`${memory.memoryId}:${representationId}`)}`,
        auth_kind: 'binding_credential_ref',
        authority: 'inspect_read',
        target: this.viewTarget(target),
        snapshot_digest: this.snapshotDigest(target.workspaceId),
        memory_id: memory.memoryId,
        representation: body,
        redaction: 'memory-projection-safe-v1',
      },
    };
  }

  /**
   * 一条记忆的**关系建议**（GET；只读；作者自报）。
   *
   * ⚠️ **诚实声明（与合成边同款）**：真引擎的 `advisories` 来自**已落库的 JEV 判定作业**，
   * 而 fake 没有 JEV——这里按"同一 workspace 的**其他**记忆（id 升序，最多
   * `FAKE_RELATION_CASE_LIMIT` 条）"合成**两个方向**的块（见下）。唯一目的是让 e2e 能钉住
   * **平台的块级归因守卫 + 逐 case 另一侧来源过滤链**。**不要**据它推断真引擎的判定行为。
   *
   * ⚠️ **为什么要两个方向**：引擎读侧方向决定哪一侧是"另一条"
   * （`hument/internal/adapter/sqlite/relation_advisory.go`：new 侧读 ⇒ 另一条在 `old`；
   * **old 侧读 ⇒ 另一条在 `new`**），而真引擎**两种块都可能返回**。只产 new 侧一种的话，
   * e2e 就证不了"过滤键取另一侧"这件事（旧实现恒取 `old_memory_id` 也能全绿）。
   * 故本实现刻意各产一块：
   * - ① **new-side**：`new = 本记忆`，`cases[].old = 各候选`（本记忆是被判定的新侧）；
   * - ② **old-side**：`new = 第一个候选`（作业的 new 侧），`cases[].new = 该候选`、`old = 本记忆`
   *   （本记忆是**被比较的旧侧**）——这一块正是"另一条在 `new`"的形状。
   * 两块都满足 `matched_memory_id = 本记忆`（引擎按构造如此），故都该被平台的归因守卫放行。
   *
   * ⚠️ workspace 内**只有这一条记忆** ⇒ 返回**合法的空 `advisories`**（合同的常态：
   * 没有针对这条记忆的判定作业 ≠ 这条记忆没有关系——关系在 detail 的 `sections.relations`）。
   */
  async getMemoryRelations(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<HumentMemoryRelations>> {
    const all = this.workspaceMemories(target.workspaceId);
    const memory = all.find((candidate) => candidate.memoryId === memoryId);
    if (!memory) return notFound('memory');

    const candidates = all
      .filter((candidate) => candidate.memoryId !== memory.memoryId)
      .slice(0, FAKE_RELATION_CASE_LIMIT);

    if (candidates.length === 0) {
      return {
        ok: true,
        value: {
          schema_version: 'hument-memory-relations-v1',
          memory_id: memory.memoryId,
          truncated: false,
          advisories: [],
        },
      };
    }

    const newSideId = memory.memoryId;
    const oldSideNewId = candidates[0].memoryId;
    const advisories: HumentRelationAdvisory[] = [
      // ① new-side：本记忆是 new 侧 ⇒ 每条 case 的"另一条"在 `old_memory_id`
      {
        job_id: `job_${sha256Hex16(`${newSideId}:relations:new`)}`,
        matched_memory_id: memory.memoryId,
        new_memory_id: newSideId,
        // 合成作业恒 `complete`（不模拟作业状态机——那是真引擎/单测的事）
        state: 'complete',
        coverage: {
          new_memory_id: newSideId,
          status: 'complete',
          // **引擎侧口径**：未经平台来源过滤的候选数（与信封的 filteredCaseCount 不同量纲）
          candidate_count: candidates.length,
          orient_truncated: false,
          budget_incomplete: false,
        },
        cases: candidates.map((candidate, index) => ({
          case_id: `case_${sha256Hex16(`${newSideId}:${candidate.memoryId}:new`)}`,
          new_memory_id: newSideId,
          old_memory_id: candidate.memoryId,
          label: FAKE_RELATION_LABELS[index % FAKE_RELATION_LABELS.length],
          decision: 'advisory',
          reason: `fake engine: 合成关系建议（new=${newSideId} old=${candidate.memoryId}）`,
          confidence: relationConfidence(newSideId, candidate.memoryId),
          source_state: 'author_reported',
          advisory_only: true,
        })),
        model: 'fake-relation-advisor-v1',
        usage: { input_tokens: 0, output_tokens: 0, cost_micros: 0 },
        created_at: fakeTimestamp(`${memory.memoryId}:relations:new:${candidates.length}`),
        source_state: 'author_reported',
        advisory_only: true,
      },
      // ② old-side：本记忆是**被比较的旧侧**（作业的 new 侧是第一个候选）
      //    ⇒ "另一条"在 `new_memory_id`，`old_memory_id` 就是本记忆本身
      {
        job_id: `job_${sha256Hex16(`${newSideId}:relations:old`)}`,
        matched_memory_id: memory.memoryId,
        new_memory_id: oldSideNewId,
        state: 'complete',
        coverage: {
          new_memory_id: oldSideNewId,
          status: 'complete',
          candidate_count: 1,
          orient_truncated: false,
          budget_incomplete: false,
        },
        cases: [
          {
            case_id: `case_${sha256Hex16(`${oldSideNewId}:${memory.memoryId}:old`)}`,
            new_memory_id: oldSideNewId,
            old_memory_id: memory.memoryId,
            label: FAKE_RELATION_LABELS[candidates.length % FAKE_RELATION_LABELS.length],
            decision: 'advisory',
            reason: `fake engine: 合成关系建议（old=${memory.memoryId} 被 new=${oldSideNewId} 比较）`,
            confidence: relationConfidence(oldSideNewId, memory.memoryId),
            source_state: 'author_reported',
            advisory_only: true,
          },
        ],
        model: 'fake-relation-advisor-v1',
        usage: { input_tokens: 0, output_tokens: 0, cost_micros: 0 },
        created_at: fakeTimestamp(`${memory.memoryId}:relations:old:${candidates.length}`),
        source_state: 'author_reported',
        advisory_only: true,
      },
    ];

    return {
      ok: true,
      value: {
        schema_version: 'hument-memory-relations-v1',
        memory_id: memory.memoryId,
        // fake 的候选集恒有界（≤ FAKE_RELATION_CASE_LIMIT）⇒ 永不截断
        truncated: false,
        advisories,
      },
    };
  }

  /**
   * 已记录用量汇总（GET；只读；**无分页**）。
   *
   * 数据 = 本 workspace 的每条记忆派生一行确定性用量证据（`createdAt` 是行时间）。
   * `totals` 覆盖**完整匹配集**（与 trace 页大小无关），null/0/absent 三态逐字保留。
   * summary 不接受 limit/cursor（入参类型里也没有）。
   */
  async getUsageSummary(
    target: MemoryEngineTarget,
    query: HumentUsageSummaryQuery,
  ): Promise<MemoryEngineResult<HumentUsageSummary>> {
    const rows = usageRowsFor(this.workspaceMemories(target.workspaceId));
    const filtered = filterUsageRows(rows, query);
    return {
      ok: true,
      value: {
        schema_version: FAKE_USAGE_SCHEMA_VERSION,
        target: this.usageTarget(target),
        filter: usageFilterEcho(query),
        time_basis: FAKE_USAGE_TIME_BASIS,
        snapshot: this.usageSnapshot(target.workspaceId),
        as_of: fakeTimestamp(`${target.workspaceId}:usage:as_of`),
        totals: buildUsageTotals(filtered),
        groups: buildUsageGroups(filtered),
        coverage: fakeUsageCoverage(),
      },
    };
  }

  /**
   * 已记录用量明细（GET；只读；游标绑 snapshot + filter + limit）。
   *
   * 游标失效双通道（**真实语义，不是模拟失败面**，与 views 同款）：
   * - filter/limit 变 ⇒ `400 invalid_argument`（cursor 与查询摘要不符）
   * - 数据变（新记忆形成/更正）⇒ `409 conflict`（快照摘要变）
   * 两者在平台侧都落 502 + `hintCode=cursor_reset_required`。
   */
  async getUsageTrace(
    target: MemoryEngineTarget,
    query: HumentUsageTraceQuery,
  ): Promise<MemoryEngineResult<HumentUsageTrace>> {
    const rows = usageRowsFor(this.workspaceMemories(target.workspaceId));
    const filtered = filterUsageRows(rows, query);
    const limit = query.limit ?? FAKE_USAGE_DEFAULT_LIMIT;
    const snapshot = this.usageSnapshot(target.workspaceId);
    const digest = digestOfQuery({
      operation: query.operation,
      provider_operation: query.provider_operation,
      model: query.model,
      since: query.since,
      until: query.until,
      limit,
    });

    let offset = 0;
    if (query.cursor !== undefined) {
      const resolution = this.resolveUsageCursor(query.cursor, snapshot, digest);
      if (!resolution.ok) return resolution.failure;
      offset = resolution.offset;
    }

    // 0 = 无上限（合同语义）；平台侧拒绝 0，故只会出现在直连 fake 的单测里
    const page = limit === 0 ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
    const consumed = offset + page.length;
    const hasMore = consumed < filtered.length;
    const nextCursor = hasMore
      ? this.encodeCursor({ off: consumed, snapshot, query: digest })
      : undefined;

    return {
      ok: true,
      value: {
        schema_version: FAKE_USAGE_SCHEMA_VERSION,
        target: this.usageTarget(target),
        filter: usageFilterEcho(query),
        time_basis: FAKE_USAGE_TIME_BASIS,
        snapshot,
        as_of: fakeTimestamp(`${target.workspaceId}:usage:as_of`),
        rows: page,
        total_rows: filtered.length,
        limit,
        ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
        has_more: hasMore,
        // **全匹配集**的 totals（不是本页）
        totals: buildUsageTotals(filtered),
        coverage: fakeUsageCoverage(),
      },
    };
  }

  /**
   * 就绪探测：**恒 ok**（进程内替身没有"存储不可用"这一态）。
   *
   * rationale：fake 的用途是让 e2e 走"引擎可用"的确定性路径；探针的失败面由
   * `ScriptedEngine`（test/memory.e2e-spec.ts）与 tracker/probe 的单测覆盖——
   * **别**把故障开关塞进本类（同文件头「不模拟 Hument 的失败面」）。
   */
  async healthCheck(): Promise<MemoryEngineResult<void>> {
    return { ok: true, value: undefined };
  }

  // ── 读面内部（共享派生；全部确定性） ──

  /** 本 workspace 的记忆（按 id 升序——**唯一的"顺序"来源**，图与分页都靠它稳定） */
  private workspaceMemories(workspaceId: string): FakeMemoryRecord[] {
    return [...this.memories.values()]
      .filter((memory) => memory.workspaceId === workspaceId)
      .sort((a, b) => (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));
  }

  /**
   * snapshot 摘要（**游标失配检测的锚**）。
   *
   * 输入 = 该 workspace 记忆集的"身份指纹"（id + 状态 + 取代链）——任何一条记忆被形成/被更正
   * 都会改变它，从而让旧游标落到 `snapshot_stale`（对齐 hument：翻页途中快照变化 ⇒ 409）。
   */
  private snapshotDigest(workspaceId: string): string {
    return sha256Hex(
      this.workspaceMemories(workspaceId)
        .map((memory) => `${memory.memoryId}:${memory.status}:${memory.supersession.join(',')}`)
        .join('|'),
    );
  }

  /** usage 快照摘要（与视图同源：记忆集身份指纹；形成/更正都会改变它） */
  private usageSnapshot(workspaceId: string): string {
    return sha256Hex(`usage|${this.snapshotDigest(workspaceId)}`);
  }

  /** usage 身份回声（**必须与请求目标一致**，否则平台 normalizer 会判 target mismatch） */
  private usageTarget(target: MemoryEngineTarget): HumentUsageSummary['target'] {
    return {
      // fake 的 binding/namespace 由 workspace 确定性派生（不是真实 Hub 值）
      binding_id: `binding-fake-${sha256Hex16(target.workspaceId)}`,
      namespace_id: `ns-${sha256Hex(target.workspaceId)}`,
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      scope: 'actor_private',
    };
  }

  /**
   * usage 游标解析（与视图的 `resolveCursor` **失败码不同**）：
   * - query/limit 不符 ⇒ 400 `invalid_argument`
   * - 数据快照变 ⇒ **409 `conflict`**（usage 合同用语，不是视图的 `snapshot_stale`）
   */
  private resolveUsageCursor(
    cursor: string,
    snapshot: string,
    queryDigest: string,
  ): { ok: true; offset: number } | { ok: false; failure: MemoryEngineResult<never> } {
    const decoded = decodeFakeCursor(cursor);
    if (!decoded || decoded.query !== queryDigest) {
      return {
        ok: false,
        failure: this.cursorFailure({
          httpStatus: 400,
          engineCode: 'invalid_argument',
          message: 'fake engine: usage cursor does not match the current query',
        }),
      };
    }
    if (decoded.snapshot !== snapshot) {
      return {
        ok: false,
        failure: this.cursorFailure({
          httpStatus: 409,
          engineCode: 'conflict',
          message: 'fake engine: usage snapshot changed while paging',
        }),
      };
    }
    return { ok: true, offset: decoded.off };
  }

  /** 视图目标回声（引擎侧认定的调用上下文；`scope` 与请求侧恒定值一致） */
  private viewTarget(target: MemoryEngineTarget): HumentMemoryViewTarget {
    return {
      target_id: sha256Hex(`${target.workspaceId}:${target.actorId}`),
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      binding_id: `bind_${sha256Hex16(target.workspaceId)}`,
      scope: FAKE_VIEW_SCOPE,
    };
  }

  /**
   * 关系边集合：真实 `supersedes`（来自 correct）+ 合成的四类结构边。
   *
   * `supersedes` 的**方向**逐字对齐 hument（`memory_corrections.go:465`）：
   * `from_id = 新记忆`、`to_id = 被取代的旧记忆`（"谁取代了谁"，不是反过来）。
   */
  private buildEdges(memories: FakeMemoryRecord[]): HumentGraphEdge[] {
    const edges: HumentGraphEdge[] = [];
    const [root, ...rest] = memories;
    if (root) {
      rest.forEach((memory, index) => {
        edges.push(
          buildEdge(
            memory.memoryId,
            root.memoryId,
            FAKE_SYNTHETIC_EDGE_TYPES[index % FAKE_SYNTHETIC_EDGE_TYPES.length],
          ),
        );
      });
    }
    for (const memory of memories) {
      for (const superseded of memory.supersession) {
        // ⚠️ 方向：`memory.supersession` 记在**被取代的旧记忆**上（"我被谁取代了"），
        // 而 hument 的边是"谁取代了谁"（`from=新`、`to=旧`）——**必须反过来**，
        // 否则前端把箭头画反（取证见 buildEdges 的文档注释）。
        edges.push(buildEdge(superseded, memory.memoryId, FAKE_SUPERSEDES));
      }
    }
    return edges;
  }

  /** 游标编码（base64url 的 JSON；**不是** Hument 的编码，只保证"绑 snapshot + 绑 query"两条语义） */
  private encodeCursor(payload: FakeCursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  /**
   * 游标解析 + 双通道失效判定（**两形状可被 e2e 钉住**）。
   *
   * 判序（对齐 hument `decodeWorkbenchProjectionCursor`："任一 digest 不匹配 ⇒ invalid_argument"，
   * 而快照变化另走 409）：
   * 1. 不可解析 / query digest 不匹配 ⇒ `400 invalid_argument`（**过滤器元组或 limit 变了**）；
   * 2. snapshot 不匹配 ⇒ `409 snapshot_stale`（**数据变了**，与过滤器无关）。
   *
   * ⚠️ 两个形状都必须走 `failure.http` + `engineCode`（**不是** timeout/unreachable）：服务层据此
   * 落 502/14004 并把 engineCode 逐字透传给消费者（前端按 engineCode 分叉文案）。
   */
  private resolveCursor(
    cursor: string | undefined,
    snapshot: string,
    queryDigest: string,
  ):
    | { ok: true; offset: number }
    | { ok: false; httpStatus: number; engineCode: string; message: string } {
    if (cursor === undefined) return { ok: true, offset: 0 };
    const decoded = decodeFakeCursor(cursor);
    if (!decoded || decoded.query !== queryDigest) {
      return {
        ok: false,
        httpStatus: 400,
        engineCode: 'invalid_argument',
        message: 'fake engine: projection cursor does not match the current query',
      };
    }
    if (decoded.snapshot !== snapshot) {
      return {
        ok: false,
        httpStatus: 409,
        engineCode: 'snapshot_stale',
        message: 'fake engine: projection snapshot changed while paging',
      };
    }
    return { ok: true, offset: decoded.off };
  }

  /** 把游标失效的判定结果翻成该端点的判别式联合（泛型逐端点还原） */
  private cursorFailure<T>(resolution: {
    httpStatus: number;
    engineCode: string;
    message: string;
  }): MemoryEngineResult<T> {
    return {
      ok: false,
      failure: {
        kind: 'http',
        message: resolution.message,
        httpStatus: resolution.httpStatus,
        engineCode: resolution.engineCode,
        retryable: false,
        latencyMs: 0,
      },
    };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Usage 读面（alpha.19）的确定性派生
//
// 一行 = 一条记忆的一次形成证据（`started_at` = 记忆的确定性 `createdAt`）。
// 刻意在少量行上覆盖 null / 0 / 已知三态（服务层与 e2e 才有可判的夹具）：
// - input_tokens: null | 0 | 正数
// - output_tokens: null | 0 | 正数
// - actual_cost_micros 恒 null（**未知不是 0**）；estimated 部分 null
// - 开放字符串（operation/provider_operation/model_basis/source）不做词表收窄
// ══════════════════════════════════════════════════════════════════════

/** Usage 合同 const（与真实现同值；fake 的载荷也要过合同的 required 集） */
const FAKE_USAGE_SCHEMA_VERSION = 'hument-usage-v1';
const FAKE_USAGE_TIME_BASIS = 'physical_started_at';

/** trace 缺省页大小（合同 DefaultFile 100；平台服务层也会显式发 100） */
const FAKE_USAGE_DEFAULT_LIMIT = 100;

/** 由本 workspace 的记忆集派生确定性 usage 行（顺序 = memoryId 升序） */
function usageRowsFor(memories: FakeMemoryRecord[]): HumentUsageTraceRow[] {
  return memories.map((memory, index) => {
    const mod = index % 4;
    const inputTokens = mod === 0 ? null : mod === 1 ? 0 : mod * 10;
    const outputTokens = mod === 1 ? null : mod === 0 ? 0 : mod * 3;
    const totalTokens =
      inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
    const modelBasis = mod === 2 ? 'unknown' : mod === 3 ? 'requested' : 'resolved';
    const model = modelBasis === 'unknown' ? undefined : `fake-model-${index % 2}`;
    const elapsedMs = index % 3 === 0 ? null : 100 + index;
    const startedAt = memory.createdAt;
    const finishedAt =
      elapsedMs === null
        ? undefined
        : new Date(Date.parse(startedAt) + elapsedMs * 1000).toISOString();

    return {
      id: `use_${sha256Hex16(`${memory.memoryId}:usage`)}`,
      evidence_kind: 'physical_call',
      source: 'formation',
      operation: 'formation',
      provider_operation: index % 2 === 0 ? 'generation' : 'embedding',
      entity_id: memory.memoryId,
      logical_call_id: `lc_${sha256Hex16(`${memory.memoryId}:logical`)}`,
      generation_id: `gen_${sha256Hex16(`${memory.memoryId}:generation`)}`,
      generation_number: 0,
      call_id: `call_${sha256Hex16(`${memory.memoryId}:call`)}`,
      physical_ordinal: 0,
      provider: 'fake',
      profile_id: 'fake-profile',
      ...(modelBasis === 'requested' && model ? { requested_model: model } : {}),
      ...(modelBasis === 'resolved' && model ? { resolved_model: model } : {}),
      ...(model ? { model } : {}),
      model_basis: modelBasis,
      state: 'completed',
      started_at: startedAt,
      ...(finishedAt ? { finished_at: finishedAt } : {}),
      elapsed_ms: elapsedMs,
      time_source: 'physical_started_at',
      request_digest: sha256Hex(`${memory.memoryId}:request`),
      response_digest: sha256Hex(`${memory.memoryId}:response`),
      request_bytes: mod === 0 ? null : 100 + index,
      response_bytes: mod === 1 ? null : 200 + index,
      bytes_source: 'metered',
      response_complete: true,
      ...(index % 5 === 0 ? { http_status: 200 } : {}),
      quota_exhausted: false,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      usage_source: 'provider',
      token_basis: 'provider_reported',
      actual_cost_micros: null,
      estimated_cost_micros: mod === 2 ? null : index * 7,
      cost_status: mod === 2 ? 'unknown' : 'estimated',
      cost_source: 'rate_card',
      physical_calls_unknown: index % 2 === 0,
      cache_reuses: mod === 3 ? null : 0,
      adapter_elapsed_ms: mod === 0 ? null : 5,
    };
  });
}

/** 过滤器（summary/trace 同义；时间区间 `[since, until)`，按 `Date.parse` 比较） */
function filterUsageRows(
  rows: HumentUsageTraceRow[],
  query: HumentUsageSummaryQuery,
): HumentUsageTraceRow[] {
  const since = query.since === undefined ? null : Date.parse(query.since);
  const until = query.until === undefined ? null : Date.parse(query.until);
  return rows.filter((row) => {
    if (query.operation !== undefined && row.operation !== query.operation) return false;
    if (
      query.provider_operation !== undefined &&
      row.provider_operation !== query.provider_operation
    ) {
      return false;
    }
    if (query.model !== undefined) {
      // 合同：精确匹配 requested **或** resolved（一条记录只匹配一次）
      if (row.requested_model !== query.model && row.resolved_model !== query.model) return false;
    }
    if (since !== null || until !== null) {
      const at = row.started_at === undefined ? null : Date.parse(row.started_at);
      // 无物理开始时间 = 无法进入时间窗（引擎用 coverage.excluded_untimed_rows 报覆盖债）
      if (at === null || Number.isNaN(at)) return false;
      if (since !== null && at < since) return false;
      if (until !== null && at >= until) return false;
    }
    return true;
  });
}

/** 过滤器回声（只回声**已给**的键；值与请求逐字一致） */
function usageFilterEcho(query: HumentUsageSummaryQuery): HumentUsageSummary['filter'] {
  const filter: HumentUsageSummary['filter'] = {};
  if (query.operation !== undefined) filter.operation = query.operation;
  if (query.provider_operation !== undefined) filter.provider_operation = query.provider_operation;
  if (query.model !== undefined) filter.model = query.model;
  if (query.since !== undefined) filter.since = query.since;
  if (query.until !== undefined) filter.until = query.until;
  return filter;
}

/** 求和（null 不计入 known；返回 known + 是否有未知） */
function sumKnown(values: Array<number | null>): { known: number; unknown: number } {
  let known = 0;
  let unknown = 0;
  for (const value of values) {
    if (value === null) unknown += 1;
    else known += value;
  }
  return { known, unknown };
}

/** 全匹配集的 totals（**与页大小无关**；不从 rows 之外的地方补数） */
function buildUsageTotals(rows: HumentUsageTraceRow[]): HumentUsageTotals {
  const unknownPhysical = rows.filter((row) => row.physical_calls_unknown).length;
  const input = sumKnown(rows.map((row) => row.input_tokens));
  const output = sumKnown(rows.map((row) => row.output_tokens));
  const total = sumKnown(rows.map((row) => row.total_tokens));
  const estimated = sumKnown(rows.map((row) => row.estimated_cost_micros));
  const duration = sumKnown(rows.map((row) => row.elapsed_ms));
  const cacheReuses = sumKnown(rows.map((row) => row.cache_reuses));

  const counts: HumentUsageCounts = {
    evidence_rows: rows.length,
    entities: new Set(rows.map((row) => row.entity_id)).size,
    logical_calls: rows.length,
    generations: rows.filter((row) => row.provider_operation === 'generation').length,
    batches: 0,
    known_physical_calls: rows.length - unknownPhysical,
    physical_calls: unknownPhysical > 0 ? null : rows.length,
    unknown_physical_units: unknownPhysical,
    http_429: rows.filter((row) => row.http_status === 429).length,
    retries: 0,
    cache_reuses: cacheReuses.unknown > 0 ? null : cacheReuses.known,
    replay_count: 0,
  };

  return {
    counts,
    tokens: {
      known_input_tokens: input.known,
      input_tokens: input.unknown > 0 ? null : input.known,
      unknown_input_rows: input.unknown,
      known_output_tokens: output.known,
      output_tokens: output.unknown > 0 ? null : output.known,
      unknown_output_rows: output.unknown,
      known_total_tokens: total.known,
      total_tokens: total.unknown > 0 ? null : total.known,
      unknown_total_rows: total.unknown,
    },
    cost: {
      status: estimated.unknown > 0 ? 'unknown' : 'estimated',
      // actual 恒未知（fake 不编币种/金额）
      actual_micros: null,
      known_estimated_micros: estimated.known,
      estimated_micros: estimated.unknown > 0 ? null : estimated.known,
      unknown_estimated_rows: estimated.unknown,
    },
    duration: {
      known_physical_ms: duration.known,
      physical_ms: duration.unknown > 0 ? null : duration.known,
      unknown_physical_rows: duration.unknown,
    },
  };
}

/** 分组（确定性排序；`model` 只在已知时出现） */
function buildUsageGroups(rows: HumentUsageTraceRow[]): HumentUsageGroup[] {
  const buckets = new Map<string, HumentUsageTraceRow[]>();
  for (const row of rows) {
    const key = [row.operation, row.provider_operation, row.model ?? '', row.model_basis].join('|');
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, bucket]) => {
      const first = bucket[0];
      return {
        operation: first.operation,
        provider_operation: first.provider_operation,
        ...(first.model !== undefined ? { model: first.model } : {}),
        model_basis: first.model_basis,
        totals: buildUsageTotals(bucket),
      };
    });
}

/** 覆盖度块（fake 恒完整；excluded_untimed_rows = 0） */
function fakeUsageCoverage(): HumentUsageCoverage {
  return {
    status: 'complete',
    scope: 'actor_private',
    sources: [{ source: 'formation', status: 'complete', reasons: [] }],
    excluded_untimed_rows: 0,
  };
}

/** 召回条目装配（合同 required 字段全填；fake 的固定取值见字段注释） */
function buildRecallItem(
  memory: FakeMemoryRecord,
  bodyBytes: number,
  bodyTokens: number,
): HumentRecallItem {
  const digest = sha256Hex(memory.content);
  return {
    memory_id: memory.memoryId,
    namespace_id: `ns-${sha256Hex(memory.workspaceId)}`,
    representation_id: `repr_${sha256Hex16(memory.memoryId)}`,
    kind: 'concept',
    scope: 'workspace_shared',
    resolution: 'R2',
    available_resolution: 'R2',
    active_resolution: 'R2',
    body: memory.content,
    digest,
    // 子串命中 ⇒ 打分恒 1（确定性优先于"像不像检索"）
    score: 1,
    byte_estimate: bodyBytes,
    token_estimate: bodyTokens,
    anchor_state: 'none',
    current: memory.status === FAKE_MEMORY_STATUS.ACTIVE,
    memory_status: memory.status,
    currentness_digest: digest,
    anchor_projection_digest: sha256Hex(''),
    anchors: [],
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 投影读面的派生件（模块级纯函数；**全部确定性**——fake 的读面必须跨进程可复现）
// ══════════════════════════════════════════════════════════════════════════

/** fake 记忆的固定分辨率档（与 readMemory/buildRecallItem 的既有取值一致：R2） */
const FAKE_RESOLUTION = 'R2';

/** 分辨率阶梯的五个槽位（合同 `ladder` minItems/maxItems = 5，顺序即 R0..R4） */
const FAKE_LADDER_RESOLUTIONS = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;

/** fake 记忆的固定锚状态（fake 不建模来源锚的再校验） */
const FAKE_ANCHOR_STATE = 'none';

/**
 * 读面恒传的作用域（**与平台侧 `HUMENT_VIEW_SCOPE` 同值**）。
 *
 * ⚠️ 不用 `workspace_shared`：平台恒传 `actor_private`，fake 若回一个别的值，e2e 就证不了
 * "节点/梯的 scope 与请求一致"这件事（假件比真实现宽松 = 契约守卫失效）。
 */
const FAKE_VIEW_SCOPE = 'actor_private';

/** graph 响应 `filters` 回声里的"本维度未过滤"取值（**响应域专有**，请求域没有它） */
const FAKE_FILTER_ANY = 'any';

/** 取代关系边类型（唯一来自真实 `correct` 的一类） */
const FAKE_SUPERSEDES = 'supersedes';

/**
 * 引擎侧的默认档（**逐字取自 hument `internal/domain/workbench_projection.go:6-13`**）。
 *
 * fake 必须**复刻**这些默认值：平台不设自己的默认值（未传即不拼 query），所以"fake 的默认档"
 * 就是 e2e 里唯一能观察到的默认行为——它若与真引擎不同，e2e 会为一份不存在的合同背书。
 */
const FAKE_DEFAULT_NODE_LIMIT = 200;
const FAKE_DEFAULT_EDGE_LIMIT = 600;
const FAKE_DEFAULT_NEIGHBORHOOD_LIMIT = 100;
const FAKE_DEFAULT_PREVIEW_SCALARS = 160;
/** detail 的 `relation_limit` 合同上限（128）；引擎未传时按上限取 */
const FAKE_DEFAULT_RELATION_LIMIT = 128;
/** history 的 `history_limit` 合同上限（100）；引擎未传时按上限取 */
const FAKE_DEFAULT_HISTORY_LIMIT = 100;

/**
 * 合成关系建议的候选上限（fake 侧的有界性；只为让 e2e 的断言有稳定规模）。
 *
 * ⚠️ 与真引擎无关：真引擎的有界性是它自己的 `truncated` 语义（本端点**没有** limit/cursor 参数）。
 */
const FAKE_RELATION_CASE_LIMIT = 3;

/**
 * 合成关系建议的 label 池（**合成**，与 `FAKE_SYNTHETIC_EDGE_TYPES` 同为"诚实的谎言"）。
 *
 * ⚠️ 刻意**不含 `supersedes`**：那一类是真实 `correct` 才有的事实（见 `buildEdges`），
 * 在这里合成会让"取代关系"这条最有分量的结论变成一个假信号。
 */
const FAKE_RELATION_LABELS = ['duplicate', 'supplement', 'conflict', 'uncertain'] as const;

/**
 * 合成关系建议的自信度(确定性派生；0.00–0.99)。
 *
 * ⚠️ 它**不是**校准概率，只是"模型自报"——真引擎的 `confidence` 也只是自报值（合同的
 * `source_state: author_reported` 就是对这一点的显式声明）。fake 复刻"有自报值"这件事。
 */
function relationConfidence(seed: string, other: string): number {
  return (Number.parseInt(sha256Hex16(`${seed}:${other}:confidence`).slice(0, 4), 16) % 100) / 100;
}

/** 游标载荷（绑 snapshot + query digest + 偏移；**offset 是分页游标，另两者是失效判据**） */
interface FakeCursorPayload {
  off: number;
  snapshot: string;
  query: string;
}

/** 游标编码（base64url JSON；**不是** hument 的编码，只保证两条失效语义可被观测） */
function decodeFakeCursor(cursor: string): FakeCursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const payload = parsed as Partial<FakeCursorPayload>;
    if (typeof payload.off !== 'number' || !Number.isInteger(payload.off) || payload.off < 0) {
      return null;
    }
    if (typeof payload.snapshot !== 'string' || typeof payload.query !== 'string') return null;
    return { off: payload.off, snapshot: payload.snapshot, query: payload.query };
  } catch {
    return null;
  }
}

/**
 * 查询摘要（**游标与过滤器元组绑定的证据**）。
 *
 * 规范化：丢掉 `undefined`（未传 ≠ 传了 undefined）并按 key 排序——两边只要"同一组参数、
 * 同一批值"就得到同一摘要；`limit` 类参数**也在内**（对齐 hument：9 个过滤器 + limit 全进 digest）。
 *
 * ⚠️ 形参类型是 `object` 而不是 `Record<string, ...>`：TS 的 **interface 没有隐式索引签名**，
 * 传一个 interface 类型的查询对象给 `Record` 会报"Index signature is missing"——而这里恰恰
 * 要接的就是那些 interface（`HumentMemoryGraphViewQuery` 等）。
 */
function digestOfQuery(query: object): string {
  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256Hex(JSON.stringify(entries));
}

/** 分页块（合同 `workbench-projection-page`；本 helper 产出"无截断"的基线，调用方按需覆盖） */
function pageOf(total: number, loaded: number): HumentProjectionPage {
  return {
    total,
    total_kind: 'exact',
    loaded,
    next_cursor: '',
    partial: false,
    truncated: false,
    truncation_reason: '',
  };
}

/**
 * 来源全谱（**合同 required**：views 7 键 / memory-inspect 10 键；本对象同时满足两者）。
 *
 * 值全部由 memory id / 正文派生（确定性）+ 固定的 fake 署名——**不写真实 provider 名**，
 * 免得被读成"真跑过某个模型"。
 */
function buildProvenance(memory: FakeMemoryRecord): Record<string, unknown> {
  const h = sha256Hex16(memory.memoryId);
  return {
    source_type: 'chamber_nomination',
    source_ref: `chamber://memory/${memory.memoryId}`,
    source_revision: `rev_${h}`,
    provider: 'fake',
    provider_version: 'fake.deterministic.v1',
    model: 'fake',
    prompt_version: 'fake.deterministic.v1',
    receipt_digest: sha256Hex(memory.content),
    policy_version: 'fake.deterministic.v1',
    input_tokens: 0,
    output_tokens: 0,
    cost_micros: 0,
  };
}

/** 表示正文的分层切片（R0 标题级 / R1 摘要级 / R2+ 全文；**确定性**，无随机与时钟） */
function representationBodyFor(content: string, resolution: string): string {
  if (resolution === FAKE_LADDER_RESOLUTIONS[0]) return content.slice(0, 80);
  if (resolution === FAKE_LADDER_RESOLUTIONS[1]) return content.slice(0, 320);
  return content;
}

/** 表示 id / revision id / mutation id 的**唯一派生点**（三处 id 必须同源，否则端点之间对不上） */
function representationIds(
  memoryId: string,
  resolution: string,
): {
  representationId: string;
  revisionId: string;
  mutationId: string;
} {
  const h = sha256Hex16(memoryId);
  // R2 的 id **刻意不带档位后缀**：它与 readMemory / 召回条目里的 representation_id 是同一份
  // （三个端点对同一条当前表示必须给出同一个 id，否则前端拿一个 id 去取正文会 404）
  if (resolution === FAKE_RESOLUTION) {
    return { representationId: `repr_${h}`, revisionId: `rev_${h}`, mutationId: `mut_${h}` };
  }
  const suffix = resolution.toLowerCase();
  return {
    representationId: `repr_${suffix}_${h}`,
    revisionId: `rev_${suffix}_${h}`,
    mutationId: `mut_${suffix}_${h}`,
  };
}

/** 一份**当前**表示正文（ladder 槽的 `current` 与 representation 端点共用） */
function buildRepresentationBody(
  memory: FakeMemoryRecord,
  resolution: string,
): HumentRepresentationBody {
  const body = representationBodyFor(memory.content, resolution);
  const ids = representationIds(memory.memoryId, resolution);
  return {
    representation_id: ids.representationId,
    resolution,
    revision_id: ids.revisionId,
    mutation_id: ids.mutationId,
    source_ref: `chamber://memory/${memory.memoryId}`,
    current: true,
    body,
    digest: sha256Hex(body),
    original_bytes: utf8Bytes(body),
    body_truncated: false,
    created_at: fakeTimestamp(`${memory.memoryId}:${resolution}`),
  };
}

/**
 * memory-inspect（19.16）的**表示形状**（`HumentMemoryRepresentation`：多 `namespace_id` /
 * `memory_id`，无 `body_truncated`）。
 *
 * ⚠️ 与 views 读面的 `HumentRepresentationBody` **不是同一个形状**——两个合同各自的
 * `workbench-representation-body` / `memory-inspect-response.representations[]` 字段集不同，
 * 不要试图合并成一个 builder（合并 = 一边多字段一边缺字段，两边都静默出错）。
 */
function buildInspectRepresentation(memory: FakeMemoryRecord): HumentMemoryRepresentation {
  const body = representationBodyFor(memory.content, FAKE_RESOLUTION);
  const ids = representationIds(memory.memoryId, FAKE_RESOLUTION);
  return {
    representation_id: ids.representationId,
    namespace_id: `ns-${sha256Hex(memory.workspaceId)}`,
    memory_id: memory.memoryId,
    revision_id: ids.revisionId,
    mutation_id: ids.mutationId,
    source_ref: `chamber://memory/${memory.memoryId}`,
    current: true,
    resolution: FAKE_RESOLUTION,
    body,
    digest: sha256Hex(body),
    created_at: memory.createdAt,
  };
}

/** 旧版本表示的 id（history 列表与 representation 端点共用；**同源**） */
function historicalRepresentationId(memoryId: string): string {
  return `repr_r2hist_${sha256Hex16(memoryId)}`;
}

/**
 * 一条**历史**（`is_current = 0`）表示。
 *
 * ⚠️ 诚实声明：fake 的"旧版本"与当前版本**同文同 digest**——fake 不模拟内容的真实版本演化
 * （那需要真实的"同记忆重新形成"，而 fake 的 memory id 由正文派生，换正文就是换记忆）。
 * 它存在的唯一意义 = 让 history 分页与"current 槽带 historical_count"两条渲染路径有确定性输入，
 * 故 `current` 恒 `false`（**逐字复刻引擎行为**：该端点只查 `is_current = 0`）。
 */
function buildHistoricalRepresentation(memory: FakeMemoryRecord): HumentRepresentationBody {
  const h = sha256Hex16(memory.memoryId);
  return {
    representation_id: historicalRepresentationId(memory.memoryId),
    resolution: FAKE_RESOLUTION,
    revision_id: `rev_r2hist_${h}`,
    mutation_id: `mut_r2hist_${h}`,
    source_ref: `chamber://memory/${memory.memoryId}`,
    current: false,
    body: memory.content,
    digest: sha256Hex(memory.content),
    original_bytes: utf8Bytes(memory.content),
    body_truncated: false,
    created_at: fakeTimestamp(`${memory.memoryId}:r2hist`),
  };
}

/** 历史条目投影（history 端点的 `items[]`；`preview` 上限 4KiB，比 graph 节点宽一个量级） */
function buildHistoryItem(memory: FakeMemoryRecord): HumentRepresentationHistoryItem {
  const body = buildHistoricalRepresentation(memory);
  return {
    representation_id: body.representation_id,
    resolution: body.resolution,
    revision_id: body.revision_id,
    mutation_id: body.mutation_id,
    current: body.current,
    preview: body.body.slice(0, 4096),
    digest: body.digest,
    original_bytes: body.original_bytes,
    preview_truncated: utf8Bytes(body.body) > 4096,
    created_at: body.created_at,
  };
}

/**
 * 一条关系边（合同 `workbench-graph-edge`；五个必填字段齐）。
 *
 * `audit_locator`（合同 required 四键）填 `available` + 由边身份派生的三个 id——形状完整，
 * 但**不是真的审计定位**（fake 没有审计日志），消费方只需能渲染/透传。
 */
function buildEdge(fromId: string, toId: string, type: string): HumentGraphEdge {
  const seed = `${type}:${fromId}:${toId}`;
  const h = sha256Hex16(seed);
  return {
    relation_id: `rel_${h}`,
    from_id: fromId,
    to_id: toId,
    type,
    created_at: fakeTimestamp(seed),
    audit_locator: {
      status: 'available',
      journal_event_id: `jrn_${h}`,
      revision_id: `rev_${h}`,
      mutation_id: `mut_${h}`,
    },
  };
}

/** graph 节点（合同 `nodes[]`；16 个必填字段齐） */
function buildGraphNode(
  memory: FakeMemoryRecord,
  edges: HumentGraphEdge[],
  previewScalars: number,
): HumentGraphNode {
  const outgoing = edges.filter((edge) => edge.from_id === memory.memoryId);
  return {
    memory_id: memory.memoryId,
    kind: 'concept',
    scope: FAKE_VIEW_SCOPE,
    status: memory.status,
    active_resolution: FAKE_RESOLUTION,
    available_resolution: FAKE_RESOLUTION,
    // 契约上限 80；`slice` 按**码元**截（中文场景下与"字符"不完全等价，fake 不追求这一点）
    label: memory.content.slice(0, 80),
    preview: memory.content.slice(0, previewScalars),
    label_resolution: FAKE_RESOLUTION,
    // fake 的 confidence 恒 null（`confidence_present` 说的是"有没有这个值"）
    confidence_present: false,
    contradiction_count: outgoing.filter((edge) => edge.type === 'contradicts').length,
    supersession_count: outgoing.filter((edge) => edge.type === FAKE_SUPERSEDES).length,
    anchor_state: FAKE_ANCHOR_STATE,
    boundary: false,
    created_at: memory.createdAt,
    updated_at: memory.createdAt,
  };
}

/** detail 的 `memory` 对象（**与 readMemory 的 memory 不同形**：本形无 namespace/workspace/actor，多 updated_at/confidence_present） */
function buildViewMemoryDetail(memory: FakeMemoryRecord): HumentViewMemoryDetail {
  return {
    memory_id: memory.memoryId,
    kind: 'concept',
    scope: FAKE_VIEW_SCOPE,
    status: memory.status,
    available_resolution: FAKE_RESOLUTION,
    active_resolution: FAKE_RESOLUTION,
    provenance: buildProvenance(memory),
    confidence_present: false,
    confidence: null,
    evidence: [],
    contradiction: [],
    supersession: [...memory.supersession],
    created_at: memory.createdAt,
    updated_at: memory.createdAt,
  };
}

/**
 * 五槽分辨率阶梯（恒 5 项，R0..R4 顺序）。
 *
 * 模型：R0/R1/R2 各有一条当前表示（`current_materialized`），R2 另有 1 条旧版本
 * （故 `historical_count = 1`——这正是"重新形成后的常态"）；R3/R4 高于 `available_resolution`
 * ⇒ `beyond_available`。`active` 只标 R2（= `active_resolution`，与 `available` 不是一回事）。
 */
function buildLadder(memory: FakeMemoryRecord): HumentLadderSlot[] {
  const availableIndex = FAKE_LADDER_RESOLUTIONS.indexOf(FAKE_RESOLUTION);
  return FAKE_LADDER_RESOLUTIONS.map((resolution, index) => {
    if (index > availableIndex) {
      return {
        resolution,
        state: 'beyond_available',
        active: false,
        current: null,
        historical_count: 0,
      };
    }
    return {
      resolution,
      state: 'current_materialized',
      active: resolution === FAKE_RESOLUTION,
      current: buildRepresentationBody(memory, resolution),
      historical_count: resolution === FAKE_RESOLUTION ? 1 : 0,
    };
  });
}
