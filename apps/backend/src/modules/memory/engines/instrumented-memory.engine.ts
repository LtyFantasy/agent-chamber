/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎的**观测层**（`MEMORY_ENGINE` token 的值）：裸引擎的透明装饰器，
 *     把每一次**业务**调用的成败上报给 `EngineHealthTracker`（卡 26c43f52「引擎长时间
 *     不可用无近实时告警」的检测点就在这一层）
 *
 * [代码职责]
 *   - **十三个业务动词全量委托**（零改写：入参、返回、异常面逐字透传）+ 逐次上报
 *     `tracker.noteCallOutcome(result, { workspaceId: target.workspaceId })`
 *   - `healthCheck()` **直接透传、不上报**（防双计：探针结果有独立的 probe 路）
 *   - `name` 透传（`hument` / `fake`；配置值域一致性靠它）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/architecture.md` — memory 小节「引擎运行时健康观测
 *     （双臂状态机 + ready 探针 + Topic 告警 + 单实例假设 + 重启语义）」
 *     ⚠️ **闭环缺口（已知）**：文档联动由主脑在卡收尾时落线上（本批不含文档提交）。
 *   - 补充: `apps/backend/src/modules/memory/engines/memory-engine.interface.ts` 文件头
 *     「双 token 的分工不可合并」「healthCheck 不是第十二个业务动词」
 *
 * [关键不变量]
 *   - **为什么检测点在这一层**：引擎 503 的翻车路径各不相同（只读面 → 平台 502、提名面 →
 *     可变 202），在服务层逐端点插桩 = 迟早漏一个端点（而漏的那个恰好是没人用的）。
 *     端口层是**所有引擎调用唯一的必经之路**。
 *   - **上报是同步的、不可 await 出错**：`noteCallOutcome` 只做内存态计数（投递是 fire-and-forget），
 *     它抛错 = 让一次好调用变成 500。调用点因此**不 try/catch**，由 tracker 自己保证不抛
 *     （见 tracker 文件头）。
 *   - **禁传 `credentialRef`**：上报面只需要 `workspaceId`（非机密、告警文案要它定位项目）。
 *     凭据引用是绑定凭据的引用，**任何日志/遥测/消息都不带**（见 MemoryEngineTarget 注释）。
 *   - **`healthCheck` 必须透传而不上报**：探针每 120s 一次，若它进业务计数，
 *     `callOk` 会在零业务流量时每 2 分钟清空 A 臂的连续失败计数（"引擎坏了但没人调用"这个
 *     最该告警的形态会被自己抹平）——那正是本卡要覆盖的 burst-then-silence 形态。
 *   - **零状态、零缓存**：本层不重排、不重试、不吞异常（引擎 never-throw 的契约原样保留）。
 *
 * [关联代码]
 *   - memory-engine.interface.ts — 端口契约 + 双 token（`MEMORY_ENGINE_RAW` / `MEMORY_ENGINE`）
 *   - ../engine-health-tracker.service.ts — 上报的唯一消费方（双臂状态机）
 *   - memory-engine.factory.ts — 本类的装配点（`createInstrumentedMemoryEngine`）
 *   - ../memory-{project,formation,recall,correction,views}.service.ts — 服务层（注入包装层）
 *
 * [持久踩坑]
 *   MEMORY-DOUBLE-COUNT-PROBE(探针进业务计数): 让 `healthCheck` 也 `noteCallOutcome` ⇒
 *     零流量时探针的成功/失败同时喂两个臂，A 臂的 callCons 被 probeOk 反复清零、
 *     探针失败又被计成业务失败。安全方向: 探针只有 `noteProbeOutcome` 一条路（本类透传）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增业务动词必须同时补委托 + 上报（漏上报 = 该端点永远不触发告警，且测试不会红）
 *   □ 上报**只传 workspaceId**（加任何绑定字段 = 可能把凭据引用带进日志）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type {
  CorrectMemoryInput,
  HumentMemoryGraphView,
  HumentMemoryGraphViewQuery,
  HumentMemoryRelations,
  HumentMemoryViewDetail,
  HumentMemoryViewHistory,
  HumentMemoryViewHistoryQuery,
  HumentMemoryViewRelationsQuery,
  HumentMemoryViewRepresentation,
  HumentUsageSummary,
  HumentUsageSummaryQuery,
  HumentUsageTrace,
  HumentUsageTraceQuery,
  InspectCorrectionInput,
  InspectNominationInput,
  MemoryCorrectionResult,
  MemoryEngine,
  MemoryEngineResult,
  MemoryEngineTarget,
  MemoryNominationResult,
  MemoryReadResult,
  MemoryRecallResult,
  NominateMemoryInput,
  RecallMemoryInput,
} from './memory-engine.interface';
import type { MemoryEngineName } from '../../../config/memory.config';
import type { EngineHealthTracker } from '../engine-health-tracker.service';

/**
 * 裸引擎的**透明观测装饰器**（见文件头）。
 *
 * 写法上刻意"一个动词一段"而不是泛型反射代理：反射（Proxy / 动态方法名）会让"新增动词忘了
 * 上报"变成静默缺陷，而逐个方法 = 编译期 `implements` 强制补全（漏一个整包红）。
 */
export class InstrumentedMemoryEngine implements MemoryEngine {
  constructor(
    /** 被包装的裸引擎（`MEMORY_ENGINE_RAW`；恒非 null——null 形态由工厂直接返回 null） */
    private readonly inner: MemoryEngine,
    /** 健康状态机（app-scoped 单例；本类只调 `noteCallOutcome`） */
    private readonly tracker: EngineHealthTracker,
  ) {}

  /** 引擎名透传（`hument` / `fake`；配置值域一致性靠它） */
  get name(): MemoryEngineName {
    return this.inner.name;
  }

  /** 提交提名（委托 + 上报） */
  async nominate(
    target: MemoryEngineTarget,
    input: NominateMemoryInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    return this.observe(target, await this.inner.nominate(target, input));
  }

  /** 提名 inspect（委托 + 上报） */
  async inspectNomination(
    target: MemoryEngineTarget,
    input: InspectNominationInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    return this.observe(target, await this.inner.inspectNomination(target, input));
  }

  /** 召回（委托 + 上报） */
  async recall(
    target: MemoryEngineTarget,
    input: RecallMemoryInput,
  ): Promise<MemoryEngineResult<MemoryRecallResult>> {
    return this.observe(target, await this.inner.recall(target, input));
  }

  /** 更正（委托 + 上报） */
  async correct(
    target: MemoryEngineTarget,
    input: CorrectMemoryInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    return this.observe(target, await this.inner.correct(target, input));
  }

  /** 更正 inspect（委托 + 上报） */
  async inspectCorrection(
    target: MemoryEngineTarget,
    input: InspectCorrectionInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    return this.observe(target, await this.inner.inspectCorrection(target, input));
  }

  /** 按 memory_id 读一条记忆（委托 + 上报） */
  async readMemory(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<MemoryReadResult>> {
    return this.observe(target, await this.inner.readMemory(target, memoryId));
  }

  /** 记忆关系图投影（委托 + 上报） */
  async getGraphView(
    target: MemoryEngineTarget,
    query: HumentMemoryGraphViewQuery,
  ): Promise<MemoryEngineResult<HumentMemoryGraphView>> {
    return this.observe(target, await this.inner.getGraphView(target, query));
  }

  /** 单条记忆的分节详情 + 五档分辨率阶梯（委托 + 上报） */
  async getMemoryView(
    target: MemoryEngineTarget,
    memoryId: string,
    query: HumentMemoryViewRelationsQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewDetail>> {
    return this.observe(target, await this.inner.getMemoryView(target, memoryId, query));
  }

  /** 某一分辨率的旧版本列表（委托 + 上报） */
  async getMemoryViewHistory(
    target: MemoryEngineTarget,
    memoryId: string,
    resolution: string,
    query: HumentMemoryViewHistoryQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewHistory>> {
    return this.observe(
      target,
      await this.inner.getMemoryViewHistory(target, memoryId, resolution, query),
    );
  }

  /** 单份表示正文（委托 + 上报） */
  async getMemoryViewRepresentation(
    target: MemoryEngineTarget,
    memoryId: string,
    representationId: string,
  ): Promise<MemoryEngineResult<HumentMemoryViewRepresentation>> {
    return this.observe(
      target,
      await this.inner.getMemoryViewRepresentation(target, memoryId, representationId),
    );
  }

  /** 一条记忆的关系建议（委托 + 上报） */
  async getMemoryRelations(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<HumentMemoryRelations>> {
    return this.observe(target, await this.inner.getMemoryRelations(target, memoryId));
  }

  /** 已记录用量汇总（委托 + 上报；只传 workspaceId） */
  async getUsageSummary(
    target: MemoryEngineTarget,
    query: HumentUsageSummaryQuery,
  ): Promise<MemoryEngineResult<HumentUsageSummary>> {
    return this.observe(target, await this.inner.getUsageSummary(target, query));
  }

  /** 已记录用量明细（委托 + 上报；只传 workspaceId） */
  async getUsageTrace(
    target: MemoryEngineTarget,
    query: HumentUsageTraceQuery,
  ): Promise<MemoryEngineResult<HumentUsageTrace>> {
    return this.observe(target, await this.inner.getUsageTrace(target, query));
  }

  /**
   * 就绪探测：**直接透传，不上报**（见文件头「healthCheck 必须透传而不上报」）。
   *
   * 探针结果的唯一去处是 `EngineHealthTracker.noteProbeOutcome`（由探针服务调用）——
   * 本类若也上报，业务 A 臂会每 120s 被探针的清零/计数污染。
   */
  async healthCheck(): Promise<MemoryEngineResult<void>> {
    return this.inner.healthCheck();
  }

  /**
   * 上报一次业务调用结果并原样返回。
   *
   * @param target 调用目标（**只取 workspaceId**：非机密；凭据引用绝不外传）
   * @param result 引擎结果（判别式联合；原样返回，零改写）
   * @returns 同一个 `result` 引用（调用方无感）
   */
  private observe<T>(
    target: MemoryEngineTarget,
    result: MemoryEngineResult<T>,
  ): MemoryEngineResult<T> {
    this.tracker.noteCallOutcome(result, { workspaceId: target.workspaceId });
    return result;
  }
}
