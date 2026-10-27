/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块账本：**提名**（nomination）——"某项目主张一条记忆"的耐久载体，
 *     也是引擎外的**唯一事实源**（引擎只持有它自己那份，Chamber 侧断链时靠本表复原）
 *
 * [代码职责]
 *   - `memory_nominations` 表逐列定义（可空性 / 列宽 / 默认值 / select:false 即 schema 契约）
 *   - `source_refs` 的 jsonb 形状 `MemorySourceRef[]`（来源引用 + 冻结快照）
 *   - `engine_memory_ids` 的映射列（**引擎 memory_id → 账本行**的唯一映射来源）
 *   - `correction_target_memory_id` 的**同参锚点**列（更正首跑解析出的有效目标 ⇒ 续跑逐字节同参）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §2 `memory_nominations` 逐列契约 /
 *     §4 Formation content 装配 / §7 状态机映射表
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: 线上 DocSpace `docs/integrations/hument-integration-research.md` — 合同事实与门禁
 *
 * [关键不变量]
 *   - 本类**零 `@Index`、零 `@ManyToOne`**：7 条索引与 2 条 FK（project_id /
 *     correction_of 自引用，全 `ON DELETE RESTRICT`）都是 migration 裸 SQL 产物
 *   - **`content` / `rationale` 是 `select: false`**：大文本列，列表 getMany 带出 =
 *     白付 IO；详情/重放路径必须显式 `addSelect`（重放 = 账本冻结列**原样重发**，
 *     经 `findForReplay` 的 addSelect，**永不重装配**）
 *   - **`withdrawn ⇒ engine_memory_ids 必为空`**（方案 §2 不变式，由服务层保证）：
 *     更正未达成时新行转 withdrawn 释放 `correction_of` 部分唯一位，同时必须清 ids
 *     ——否则"已撤回"的行仍被召回映射认作 canonical 行
 *   - **alias 行恒 `engine_memory_ids = NULL`**：引擎回 duplicate/alias 时不形成新记忆，
 *     映射只认 canonical 行（alias 正文与 canonical 逐字节相同 ⇒ 无泄露面）
 *   - `engine_memory_ids` **禁入任何 SQL 谓词**：它是 jsonb 数组，`findOne` 嵌套条件 =
 *     整列等值**永不命中**（铁律 #23 的 jsonb 查询陷阱）；映射在应用层内存做
 *   - `correction_of` 的**部分唯一索引** `WHERE correction_of IS NOT NULL AND
 *     deleted_at IS NULL AND status <> 'withdrawn'` 是并发仲裁者（同一 old 只能被更正
 *     一次）；应用层另需预检旧行 `status='active'`——引擎三约束先于 DB 拦截
 *   - **`correction_target_memory_id` 仅更正行有意义**（`correction_of` 非空）；存的是
 *     发起时**解析后**的有效目标，消费端的唯一判据 = "有值就用它"，末级兜底才是旧行主记忆
 *     `engine_memory_ids[0]`（列后加 ⇒ 旧行 NULL 是合法态，不回填）
 *   - `uq_memory_nominations_client_key (nominator_id, client_request_id)` **无谓词**：
 *     幂等键跨软删仍生效（软删行不得被新请求顶用同名 key 复用）
 *   - `formation_state` 是 **Chamber 归一化像**，不是引擎 `job_state` 原值；
 *     `diagnostics.outcome` 优先、`job_state` 回退（§7，含退化路径）
 *
 * [关联代码]
 *   - database/migrations/1791700000000-AddMemoryModule.ts — 建表 + 7 索引 + 2 FK（裸 SQL）
 *   - database/migrations/1791800000000-AddMemoryCorrectionTargetId.ts — 补
 *     `correction_target_memory_id`（更正目标落库，续跑同参）
 *   - database/entities/memory-project.entity.ts — 所属项目（`project_id` FK 指向方）
 *   - database/entities/memory-formation-event.entity.ts — 尝试历史遥测（`ledger_id` 关联，无 FK）
 *   - packages/shared/src/enums/index.ts — MEMORY_FORMATION_STATE / MEMORY_NOMINATION_STATUS /
 *     MEMORY_SOURCE_REF_TYPE 值域单源
 *   - test/memory-schema.e2e-spec.ts — 逐列对齐 / 部分唯一索引谓词 / select:false 守卫
 *
 * [持久踩坑]
 *   MEMORY-CORRECTION-UNIQUE-SLOT(部分唯一占位): 更正未达成（新行终态 no_memory /
 *     rejected / conflict）时若不把新行置 `withdrawn`，`correction_of` 唯一位被永久占用
 *     ⇒ 同一 old 再也无法发起更正（表现为 409 而非重试机会，排障时极易误判为引擎问题）。
 *     安全方向: 未达成即 withdrawn + 清 ids；`no_memory` 后同一 old 可再更正（用例守卫）。
 *   MEMORY-JSONB-PREDICATE(jsonb 谓词): 对 `engine_memory_ids`/`source_refs` 用 findOne
 *     嵌套条件 = 整列等值永不命中（静默零结果）。安全方向: 应用层内存映射 + 显式列投影。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  ActorType,
  MEMORY_FORMATION_STATE,
  MEMORY_NOMINATION_STATUS,
  type MemoryFormationState,
  type MemoryNominationStatus,
  type MemorySourceRefType,
} from '@agent-chamber/shared';

/**
 * 来源引用条目（`memory_nominations.source_refs` 的元素形状，≤4 条）。
 *
 * 方案 §4：提名时**用提名者权限**回取来源，并在同一步**冻结快照**
 * （contentHash / headingPath / excerpt / parentId）——冻结值就是形成 content 与
 * 召回时 `moved` 判定的依据（当前 contentHash ≠ 冻结 versionHash ⇒ `moved: true`）。
 *
 * locator 形态：`chamber://{doc|message|task|comment}/<id>[#h<contentHash12>]`。
 *
 * ⚠️ `type` **禁取 `memory`**（值域单源只有 doc/message/task/comment）：记忆不能作为
 * 记忆的来源——否则形成链自证，与"提名只接受原始来源"的虚假共识防护冲突。
 *
 * ⚠️ 本形状是 **DB 层契约**；对外 DTO 契约由 coder C 批次以本类型为单源引用。
 */
export interface MemorySourceRef {
  /** 来源类型（值域单源 = shared `MEMORY_SOURCE_REF_TYPES`） */
  type: MemorySourceRefType;
  /** 来源资源 UUID */
  id: string;
  /**
   * 父链一级（方案 §5 批式权限判定的预载键）：
   * doc→docSpace / message→topic / comment→task / task→list（board 在 task 行内不在此列）。
   */
  parent?: { type: string; id: string };
  /** 冻结版本哈希（doc 为 contentHash；message/task/comment 无版本列 ⇒ 缺省） */
  versionHash?: string;
  /** 冻结标题路径（doc 专属） */
  headingPath?: string;
  /** 冻结摘录（截断只截此区，见方案 §4 截断不变式） */
  excerpt?: string;
  /** 冻结父 ID（供 moved / 父链判定；缺失即视为不可判定 → 过滤） */
  parentId?: string;
}

/**
 * 提名账本行（Chamber 侧耐久载体）。
 *
 * 状态三轴（**正交，勿合并**）：
 * - `status`：账本生命周期（active / superseded / withdrawn）
 * - `formation_state`：引擎信号归一化像（§7 七态）
 * - `deferred`：引擎明示的延后标志（与 formation_state=submitted 并存）
 */
@Entity('memory_nominations')
export class MemoryNomination {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 所属项目（migration 裸 SQL 建 FK `ON DELETE RESTRICT`——本项目**不级联删账本**：
   * 记忆是资产，删项目前必须显式处置）。
   */
  @Column({ type: 'uuid', nullable: false, name: 'project_id' })
  projectId: string;

  /** 提名者 actor ID（**无 FK**：actor 硬删后账本行须存活） */
  @Column({ type: 'uuid', nullable: false, name: 'nominator_id' })
  nominatorId: string;

  /** 提名者类型（复用 shared `ActorType`：agent / human / system，与 actors.type 同词表） */
  @Column({ type: 'varchar', length: 16, nullable: false, name: 'nominator_type' })
  nominatorType: ActorType;

  /** 记忆类别（自由但受控的短标签；首个落点 = `ruling`，方案 §1/§7） */
  @Column({ type: 'varchar', length: 64, nullable: false })
  category: string;

  /** 主张主题（装配契约 `[{category}] {subject}` 的主语，**永不截断**） */
  @Column({ type: 'text', nullable: false })
  subject: string;

  /** 适用范围（装配契约 `范围: {scope}`，**永不截断**） */
  @Column({ type: 'text', nullable: false })
  scope: string;

  /** 生效/撤销说明（可空；装配契约 `生效/撤销: {effectiveNote}`，存在时**永不截断**） */
  @Column({ type: 'text', nullable: true, name: 'effective_note' })
  effectiveNote: string | null;

  /**
   * 形成正文（装配产物或 contentOverride；**≤8192 UTF-8 bytes**，DTO 层闸门）。
   *
   * `select: false`：大文本列（先例 experience_entries.judgment / search_vector）。
   * 详情与**重放**路径显式 addSelect——重放用的是本列冻结原文，绝不重装配。
   */
  @Column({ type: 'text', nullable: false, select: false })
  content: string;

  /**
   * 截断标记：截断只作用于**摘录区**并标 `[truncated]`——三要素（category/subject/scope）
   * 与 rationale **永不截**（方案 §4 截断不变式）。透出给消费方（P8）。
   */
  @Column({ type: 'boolean', nullable: false, default: false, name: 'content_truncated' })
  contentTruncated: boolean;

  /** 理由（**≤1024 bytes**；`select: false` 同 content——只在详情/重放按需带出） */
  @Column({ type: 'text', nullable: false, select: false })
  rationale: string;

  /**
   * 来源引用（jsonb 数组，元素形状 `MemorySourceRef`，**≤4**；空数组 = 纯著述）。
   *
   * ⚠️ **禁入 SQL 谓词**（jsonb 嵌套条件永不命中，铁律 #23）；权限过滤在应用层做。
   */
  @Column({ type: 'jsonb', nullable: false, default: [], name: 'source_refs' })
  sourceRefs: MemorySourceRef[];

  /** 引擎侧提名 ID（幂等键 `chamber-<账本id>` 的去向；null = 尚未到达引擎） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_nomination_id' })
  engineNominationId: string | null;

  /** 引擎侧 canonical 提名 ID（alias 行记它；canonical 行自身通常为 null 或等于本行） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_canonical_nomination_id' })
  engineCanonicalNominationId: string | null;

  /** 引擎侧 job ID（`inspectNomination` / `recover` 的入参；unknown 态的唯一线索） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_job_id' })
  engineJobId: string | null;

  /**
   * 引擎形成的记忆 ID 列表（string[]；**唯一映射来源**：memory_id → canonical 账本行）。
   *
   * 一次提名可形成多个 memory（`diagnostics.mutation.memory_ids` 恒含主 id）⇒ 数组化。
   * **alias 行恒 NULL**；**禁入 SQL 谓词**（应用层内存建映射，冲突则 fail-closed + warn）。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'engine_memory_ids' })
  engineMemoryIds: string[] | null;

  /**
   * 形成态（值域单源 = shared `MEMORY_FORMATION_STATES`；缺省 submitted = 已发出待收敛）。
   * ⚠️ 默认行兜底 = `unknown`（任何未映射信号绝不落 committed，§7 末行）。
   */
  @Column({
    type: 'varchar',
    length: 16,
    nullable: false,
    default: MEMORY_FORMATION_STATE.SUBMITTED,
    name: 'formation_state',
  })
  formationState: MemoryFormationState;

  /** 引擎明示延后（与 formation_state=submitted 并存；重发同 key 即可推进） */
  @Column({ type: 'boolean', nullable: false, default: false })
  deferred: boolean;

  /**
   * 账本状态（值域单源 = shared `MEMORY_NOMINATION_STATUSES`）。
   * ⚠️ `withdrawn ⇒ engineMemoryIds 为空`（见 [关键不变量]）。
   */
  @Column({
    type: 'varchar',
    length: 16,
    nullable: false,
    default: MEMORY_NOMINATION_STATUS.ACTIVE,
  })
  status: MemoryNominationStatus;

  /**
   * 被更正的旧账本行（自引用 FK `ON DELETE RESTRICT`）。
   *
   * 部分唯一索引 `uq_memory_nominations_correction_of` 保证**同一 old 至多一行有效更正**
   * （谓词含 `status <> 'withdrawn'` ⇒ 未达成的更正自动让位）。
   */
  @Column({ type: 'uuid', nullable: true, name: 'correction_of' })
  correctionOf: string | null;

  /** 引擎侧更正 ID（`correct` 回执；幂等键 `chamber-correct-<新账本id>`） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_correction_id' })
  engineCorrectionId: string | null;

  /**
   * 本次更正**要取代的引擎记忆 id**（correction/formation 共用的同参锚点）。
   *
   * **用途**：更正发起时解析后的**有效目标**（显式 `oldMemoryId`，或用户缺省时的旧行主记忆
   * `engine_memory_ids[0]`）。续跑（`retry` 的更正续跑分支）与首跑据此**逐字节同参**地调
   * `engine.correct`——没有它，中断续跑只能回退到旧行主记忆，非主记忆目标的更正会
   * **静默 supersede 错误的记忆**（欠账本体）。
   *
   * **不变量**：**仅 `correction_of` 非空的行有意义**（普通提名行恒 NULL——写路径只在更正
   * 分支赋值）；存的是**解析结果**而非"用户是否显式指定"，故消费端判据只有一条
   * "有值就用它"。旧行可能为 NULL（列后加、PoC 期不回填）⇒ 消费端必须保留
   * `oldRow.engineMemoryIds?.[0]` 末级兜底。
   */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'correction_target_memory_id' })
  correctionTargetMemoryId: string | null;

  /**
   * 复核提醒时间（可空）。
   * ⚠️ **仅提醒，不自动过期**（首个 category=ruling 的拍板）：到点只体现在
   * recall 项的 `reviewDue` 上，不改变可见性、不改状态。
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'review_at' })
  reviewAt: Date | null;

  /**
   * 幂等键（可空；部分唯一索引 `uq_memory_nominations_client_key
   * (nominator_id, client_request_id)` **无谓词**——软删行仍占位，防 key 复用）。
   */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'client_request_id' })
  clientRequestId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /**
   * ⚠️ **系统态写入（收敛/扫描/映射回填）不得顶本列**：收敛与扫描必须用裸 SQL 定向
   * UPDATE 且不触碰 updated_at，否则"最近人工动作"信号被后台噪声淹没（方案 §7）。
   */
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /**
   * 软删时间（`select: false`；同时是 `correction_of` 部分唯一索引的谓词成员）。
   * 一期**不做硬删**（purge 二期）。
   */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true, select: false, name: 'deleted_at' })
  deletedAt: Date | null;
}
