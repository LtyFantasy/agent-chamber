/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块（Hument 集成一期）：**项目注册表**——"记忆跟项目走，不跟 agent 走"
 *     （记忆的归属、权限、引擎绑定都以本项目行为锚点）
 *
 * [代码职责]
 *   - `memory_projects` 表逐列定义（可空性 / 列宽 / 默认值即 schema 契约）
 *   - `bindings` 的 jsonb 形状 `MemoryBinding[]`（绑定列表化，不固化单 trio）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md`（memory 分支 PoC 实现方案 v4.1）§2
 *     `memory_projects` 逐列契约 / §5 权限模型
 *     ⚠️ **闭环缺口（已知）**：该方案当前只存在于会话计划目录、尚未落 DocSpace；coder D
 *     批次须把它落线上 `docs/spec.md` + `docs/architecture.md`，落点后本定位符改为线上文档。
 *   - 补充: 线上 DocSpace `docs/integrations/hument-integration-research.md` — 集成形态与可用性 Gate
 *
 * [关键不变量]
 *   - 本类**不声明任何 `@Index`、不声明 `@ManyToOne`**：`uq_memory_projects_slug`
 *     （部分唯一索引 `WHERE deleted_at IS NULL`）等全部索引与 2 条 FK 都是 migration
 *     裸 SQL 产物。实体侧补装饰器 = 造出第二条索引事实源（漂移门禁的 [A] 命名差噪声，
 *     同形先例 experience-entry.entity.ts / 1790200000000 的两条 judgments 索引）
 *   - `id` 必须是 uuid PK **且带 `DEFAULT gen_random_uuid()`**（TypeORM
 *     `@PrimaryGeneratedColumn('uuid')` 的迁移侧对应写法）：漏写 DEFAULT 会被漂移门禁
 *     判成列级漂移（方案 §2 约定；集成测试逐列核对 PK 默认值是守卫）
 *   - `slug` 仅作**展示/过滤辅助**：所有路径参数只认 uuid（slug 可改，不做定位键）
 *   - `bindings` 创建时**必须 ≥1**（校验在服务层，非 DB）；PATCH 清空成 `[]` 落入
 *     "全部绑定不可读"治理路径（fail-closed，无泄露风险）
 *   - `engine_workspace_id` / `engine_actor_id` / `engine_credential_ref` **可空**：
 *     memory 是**可选增强**——未绑定引擎时 Chamber 完全可用（铁约束）；
 *     `engine_credential_ref` 非机密（引用名）方可落库，写入前走 KEY_SHAPED 校验
 *   - `engine` 的值域里**没有 `fake`**：FakeEngine 仅在测试进程内注入，production
 *     `MEMORY_ENGINE=fake` fail-fast（见 shared `MEMORY_ENGINES` 注释）
 *   - `deleted_at` 是 `select: false`（软删=内部状态，出口一律 404 不泄露存在性；
 *     先例 experience-entry.entity.ts）——但它仍参与部分唯一索引谓词，**不可移除**
 *   - `retain_query_text` **NOT NULL DEFAULT true**（Owner 拍板 2026-10-09）：内部项目
 *     召回排障刚需（`memory_recall_events.query_text` 存原文）。它只支配**之后新落**的
 *     遥测行，不回改历史；PATCH 的 `retainQueryText` 是唯一翻转面，**无 null 清空语义**
 *     （不引入"未设置"第三态）。开源发布时本列与原文列一同摘除。
 *
 * [关联代码]
 *   - database/migrations/1791700000000-AddMemoryModule.ts — 建 4 表 + 7 索引 + 2 FK（裸 SQL）
 *   - database/migrations/1791900000000-MemoryRecallQueryTextRetention.ts — 补
 *     `retain_query_text` + `memory_recall_events.query_text`（召回原文留存，默认开）
 *   - database/entities/memory-nomination.entity.ts — 账本表（本表的下游：project_id FK）
 *   - database/entities/memory-formation-event.entity.ts — 形成遥测（**无 FK**）
 *   - database/entities/memory-recall-event.entity.ts — 召回遥测（**无 FK**）
 *   - packages/shared/src/enums/index.ts — MEMORY_ENGINE / MEMORY_PROJECT_STATUS /
 *     MEMORY_BINDING_TYPE 值域单源
 *   - test/memory-schema.e2e-spec.ts — 逐列对齐 / PK 默认值 / 部分唯一索引谓词守卫
 *
 * [持久踩坑]
 *   MEMORY-PROJECT-SLUG-PARTIAL-UNIQUE(部分索引): `uq_memory_projects_slug` 带谓词
 *     `WHERE deleted_at IS NULL` —— 若"顺手"把它改成普通唯一索引，软删项目会永久占位
 *     slug，重建同名项目必 23505。安全方向: 谓词随索引一起写，两者不可分离。
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
  MEMORY_ENGINE,
  MEMORY_PROJECT_STATUS,
  type MemoryBindingType,
  type MemoryEngine,
  type MemoryProjectStatus,
} from '@agent-chamber/shared';

/**
 * 项目绑定条目（`memory_projects.bindings` 的元素形状）。
 *
 * 方案 §1/§5 的"绑定列表化"：一个项目可绑多个资源，权限判定按"任一绑定可读/可写"，
 * 任一绑定解析失败一律 fail-closed。`id` 是资源侧 UUID（topic/board/docSpace 各自命名空间）。
 *
 * ⚠️ 本形状是**DB 层契约**（jsonb 元素结构）；对外 DTO 契约由 coder C 批次在
 * `packages/shared/src/dto/` 钉死时**以本类型为单源引用**（禁止再抄一份）。
 */
export interface MemoryBinding {
  /** 绑定资源类型（值域单源 = shared `MEMORY_BINDING_TYPES`） */
  type: MemoryBindingType;
  /** 绑定资源 ID（topic / board / doc_space 的 UUID） */
  id: string;
}

/**
 * 记忆项目（memory 模块的权限与引擎绑定锚点）。
 *
 * 事实源边界：本表 = 项目注册表（谁把记忆挂在哪个项目、用哪个引擎）；
 * 账本表 `memory_nominations` = 记忆当前态；两张遥测表 = 尝试/召回历史。
 */
@Entity('memory_projects')
export class MemoryProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 展示用 slug（独立部分唯一索引 `uq_memory_projects_slug WHERE deleted_at IS NULL`）。
   *
   * ⚠️ **仅展示/过滤辅助**：路径参数只认 uuid——slug 可被改名，做定位键会让 URL 失效。
   * 谓词 `deleted_at IS NULL` 让软删项目释放 slug（重建同名项目不被 23505 挡）。
   */
  @Column({ type: 'varchar', length: 64, nullable: false })
  slug: string;

  /** 项目显示名（无唯一约束——重名由使用方/治理面容忍，slug 才是定位辅助） */
  @Column({ type: 'varchar', length: 128, nullable: false })
  name: string;

  /**
   * 绑定列表（jsonb 数组，元素形状 = `MemoryBinding`）。
   *
   * 创建时 ≥1（服务层校验）；`[]` 是**合法的存量态**（PATCH 清空）——此时项目落入
   * "全部绑定不可读"治理路径：只放行项目元数据 + 账本元数据投影，内容端点关闭。
   */
  @Column({ type: 'jsonb', nullable: false, default: [] })
  bindings: MemoryBinding[];

  /**
   * 引擎（值域单源 = shared `MEMORY_ENGINES`：none | hument）。
   *
   * 缺省 `none` = 未接引擎（Chamber 完全可用；引擎动词端点 503，本地数据端点照常）。
   * 裸 varchar(16) 而非 PG enum：新增引擎无需 migration。
   */
  @Column({ type: 'varchar', length: 16, nullable: false, default: MEMORY_ENGINE.NONE })
  engine: MemoryEngine;

  /**
   * 引擎侧 workspace（可空 = 未绑定引擎）。
   *
   * ⚠️ 已有 committed 账本行的项目**禁换 workspace**（服务层 409）——换绑会让既有
   * `engine_memory_ids` 指向另一 workspace 的记忆 ID，映射语义破裂。
   */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_workspace_id' })
  engineWorkspaceId: string | null;

  /** 引擎侧 actor（可空；多 agent 身份映射语义待 Hument 侧挂号澄清） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_actor_id' })
  engineActorId: string | null;

  /**
   * 引擎凭据引用（可空；**非机密**——存的是引用名，真凭据在引擎侧/环境）。
   * 写入前必须过 KEY_SHAPED 校验（防把真 key 当引用名落库）。
   */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_credential_ref' })
  engineCredentialRef: string | null;

  /**
   * 项目状态（值域单源 = shared `MEMORY_PROJECT_STATUSES`：active | archived）。
   *
   * 写路径（nominate/correct/retry/recover）要求 `active`；`archived` 仍放行
   * recall / 账本 / 详情（**归档 ≠ 不可读**）。
   */
  @Column({ type: 'varchar', length: 16, nullable: false, default: MEMORY_PROJECT_STATUS.ACTIVE })
  status: MemoryProjectStatus;

  /**
   * 召回查询**原文留存开关**（NOT NULL，默认 `true`；Owner 拍板 2026-10-09）。
   *
   * 为什么默认开：内部项目排障刚需——agent 会话压缩后拿不到原始 query，只落 sha256
   * 摘要会让召回排障断链。开源发布时连同 `memory_recall_events.query_text` 一并摘除
   * （另有锚点登记）。
   *
   * 消费点**唯一**：`memory-recall.service.ts` 写遥测行时决定 `query_text` 落原文还是 NULL
   * （`false` 只影响**之后**新落的行，不回改历史）。`PATCH /memory/projects/:id` 的
   * `retainQueryText` 可翻转。
   * ⚠️ NOT NULL 且无"清空"语义（DTO 只收布尔）：刻意不引入"未设置"第三态。
   */
  @Column({ type: 'boolean', nullable: false, default: true, name: 'retain_query_text' })
  retainQueryText: boolean;

  /** 创建者 actor ID（**无 FK**：actor 硬删后项目须存活，usage-stats 先例） */
  @Column({ type: 'uuid', nullable: false, name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  /**
   * 软删时间（`select: false`：软删是内部状态，出口一律 404 不泄露存在性）。
   *
   * ⚠️ 本列同时是 `uq_memory_projects_slug` 的**索引谓词成员**——移除本列会让
   * 部分唯一索引失效（见 [持久踩坑]）。
   */
  @DeleteDateColumn({ type: 'timestamptz', nullable: true, select: false, name: 'deleted_at' })
  deletedAt: Date | null;
}
