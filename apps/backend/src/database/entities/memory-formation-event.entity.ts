/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块形成遥测：**每次形成尝试一行**——"账本记当前态，本表记尝试历史"
 *
 * [代码职责]
 *   - `memory_formation_events` 表逐列定义（append-only，无 updated_at / 无 deleted_at）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §2 `memory_formation_events` 逐列契约 /
 *     §7 状态机映射表（本表落的是**映射前**的原始信号）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: 线上 DocSpace `docs/integrations/hument-integration-research.md` — 合同事实与门禁
 *
 * [关键不变量]
 *   - **本表无 FK（刻意）**：日志不随主体删除（同经验库族 `experience_judgments` /
 *     `usage-stats` / `audit_logs` 先例）。`ledger_id` 只是弱关联——账本行软删/硬删后
 *     尝试历史仍须留存（"为什么当初没形成"的排障证据不随条目生命周期终结）
 *   - **每次尝试一行**：`retry_count` = 第几次尝试（0 = 首发），同一 `ledger_id` 可有
 *     多行——**这不是重复数据**，收敛/重发/扫描各留一行
 *   - `outcome` 是 **Hument 原始信号**（值域单源 = shared `MEMORY_FORMATION_OUTCOMES`），
 *     不是归一化后的 `formation_state`——两者混用会让"引擎说了什么"不可考
 *   - `input_tokens` / `output_tokens` 在 `outcome='unknown'` 时**置 NULL**（无回执就没有
 *     用量事实，写 0 会被统计误读成"零消耗"）
 *   - `recovery_path` 是**扫描集合的排除键**：`hub_manual_required` / `config_invalid` /
 *     `param_invalid` 三类不参与自动重扫（否则恒错行反复重发烧配额，方案 §7）
 *   - **`diagnostics` 禁止参与任何 jsonb 谓词**（铁律 #23）：读面只按主键取行后读 payload；
 *     `config->>'k'` 这类查询一旦出现在本列上，就要先补打真实 PG 的集成用例
 *   - **`diagnostics` 每行携带的是"本次尝试"的诊断**，NULL = 本次无（旧行 / 引擎未提供 /
 *     无回执）。本表 append-only，**没有 UPDATE 路径**——不要为了"补全诊断"去改写历史行
 *   - **列语义对照（防同名异义读码陷阱）**：`reason_code` = hument **`error.code`**；
 *     `diagnostics.engineReasonCode` = hument **`diagnostics.reason_code`**。两列不同源
 *   - 本类**零 `@Index`**：`idx_memory_formation_events_project_created` 是 migration
 *     裸 SQL 产物
 *
 * [关联代码]
 *   - database/migrations/1791700000000-AddMemoryModule.ts — 建表 + 索引（裸 SQL，无 FK）
 *   - database/migrations/1792300000000-AddMemoryFormationDiagnostics.ts — 本列（手写迁移）
 *   - database/entities/memory-nomination.entity.ts — 账本（`ledger_id` 的指向方，弱关联）
 *   - packages/shared/src/enums/index.ts — MEMORY_FORMATION_OUTCOMES 值域单源
 *   - modules/memory/engines/hument.engine.ts — 五道安全门（投影值的来源）
 *   - test/memory-schema.e2e-spec.ts — 逐列对齐 + 无 FK 断言守卫
 *
 * [持久踩坑]
 *   MEMORY-TELEMETRY-FK(遥测加 FK 的诱惑): 给本表补 `project_id` FK"看起来更严谨"，但
 *     引擎侧已归档项目的遥测会随项目删除消失，而"某项目历史上失败过多少次"正是运维面
 *     需要的证据。安全方向: 遥测两表**不建 FK**（先例=日志表不随主体删除），
 *     删项目时由运维显式处置。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { MemoryFormationOutcome } from '@agent-chamber/shared';

/**
 * 形成尝试遥测行（append-only）。
 *
 * ⚠️ **无外键**（见 [关键不变量]）；**无 updated_at / deleted_at**——日志只追加，
 * 从不修改也从不软删。
 */
@Entity('memory_formation_events')
export class MemoryFormationEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属项目（**无 FK**，见 [关键不变量]） */
  @Column({ type: 'uuid', nullable: false, name: 'project_id' })
  projectId: string;

  /**
   * 关联账本行（**无 FK、不唯一**：每尝试一行，同一 ledger 可多行）。
   * 弱关联语义——账本行删除后本表行仍在（排障证据）。
   */
  @Column({ type: 'uuid', nullable: false, name: 'ledger_id' })
  ledgerId: string;

  /** 提交时的类别快照（账本 category 可被后续治理改写，遥测留当时值） */
  @Column({ type: 'varchar', length: 64, nullable: false })
  category: string;

  /**
   * 引擎原始信号（值域单源 = shared `MEMORY_FORMATION_OUTCOMES`；裸 varchar(24)）。
   * 无默认值——每次尝试必须显式写出收到的信号（缺省会让"未写"与"unknown"混淆）。
   */
  @Column({ type: 'varchar', length: 24, nullable: false })
  outcome: MemoryFormationOutcome;

  /** 引擎错误码原文（`error.code`；解析不丢，落遥测供归因，如 binding_not_found） */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'reason_code' })
  reasonCode: string | null;

  /** 单次调用耗时（ms；超时行记客户端硬顶，不是引擎侧真实耗时） */
  @Column({ type: 'int', nullable: true, name: 'latency_ms' })
  latencyMs: number | null;

  /** 本次尝试是否消耗了引擎配额（quota 409 = false；成功形成 = true） */
  @Column({ type: 'boolean', nullable: false, default: false, name: 'quota_consumed' })
  quotaConsumed: boolean;

  /** 输入 token（`outcome='unknown'` 时 **NULL**——无回执即无用量事实，禁写 0） */
  @Column({ type: 'int', nullable: true, name: 'input_tokens' })
  inputTokens: number | null;

  /** 输出 token（同 `inputTokens` 的 NULL 纪律） */
  @Column({ type: 'int', nullable: true, name: 'output_tokens' })
  outputTokens: number | null;

  /** 第几次尝试（0 = 首发；同 key 重发 / recover / retry 各 +1） */
  @Column({ type: 'int', nullable: false, default: 0, name: 'retry_count' })
  retryCount: number;

  /**
   * 恢复通道（可空；值域以方案 §7 为准：
   * `same_key_resend` / `inspect_backfill` / `hub_manual_required` / `config_invalid` /
   * `param_invalid`）。
   *
   * ⚠️ **扫描集合排除键**：`hub_manual_required` / `config_invalid` / `param_invalid`
   * 三类不参与启动扫描与 `POST recover`（否则恒错行反复重发烧配额）。
   * 本列刻意**不建词表常量**（方案未把它列为 shared 词表；写入点集中，先由服务层约束）。
   */
  @Column({ type: 'varchar', length: 32, nullable: true, name: 'recovery_path' })
  recoveryPath: string | null;

  /**
   * 本次尝试的**引擎诊断投影**（b4d41314；`null` = 本次无诊断，合法态）。
   *
   * ⚠️ **有意不采纳 `select:false`**：读面（账本列表 full 档 / 详情 full 档 / recover items）
   * 每条投影都要它；加了 `select:false` 就又多一处"忘了 addSelect 就静默丢字段"的漏取点。
   * ⚠️ 值全部由引擎层的五道门过滤后写入（见 `hument.engine.ts` 的 `MEMORY-DIAGNOSTIC-GATE`），
   * 本列**不做二次校验**（数据库不是校验层）。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'diagnostics' })
  diagnostics: MemoryFormationDiagnostics | null;

  /** 落库时刻（本表**只有** created_at：append-only 无更新语义） */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}

/**
 * 引擎诊断的平台投影（camelCase **子集**；不镜像 hument schema 版本）。
 *
 * 五个字段**全可选**：哪几个在场取决于失败面——
 * - HTTP 错误体（409/503）只有 `admissionCause` 与 `requestId`（503 **只会有 `requestId`**）
 * - 200 回执的终拒/unknown 才有 `engineReasonCode` / `errorDetail` / `failureClass`
 *
 * ⚠️ 字段类型在此写成 `string` 而不是引擎层的闭合联合：database 层**不 import 模块类型**
 * （依赖方向纪律），且值域门禁在引擎层已逐值过滤，本层只负责存。
 */
export interface MemoryFormationDiagnostics {
  /** 409 的 admission 失败因（`prefix_unresolved` / `quota_exceeded` / `exact_content`） */
  admissionCause?: string;
  /** hument `diagnostics.reason_code`（**注意**：与同表 `reason_code` 列不同源） */
  engineReasonCode?: string;
  /** hument `diagnostics.failure.error_detail`（闭集枚举，引擎层做形态门） */
  errorDetail?: string;
  /** hument `diagnostics.failure.failure_class`（证据而非动作依据） */
  failureClass?: string;
  /** 回执 `request_id` / 响应头 `X-Request-ID` */
  requestId?: string;
}
