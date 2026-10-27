/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块召回遥测：**每次召回一行（失败也落）**——引擎可用性与召回质量的分母
 *
 * [代码职责]
 *   - `memory_recall_events` 表逐列定义（append-only，无 updated_at / 无 deleted_at）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §2 `memory_recall_events` 逐列契约 /
 *     §5 召回来源过滤（`filtered_count` / `unmapped_count` 的语义出处）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: 线上 DocSpace `docs/integrations/hument-integration-research.md` — 合同事实与门禁
 *
 * [关键不变量]
 *   - **本表无 FK（刻意）**：日志不随主体删除（同 `experience_judgments` 先例）；
 *     也**无 actor FK**：actor 硬删后召回历史仍须留存（谁在何时查过什么 → query_hash）
 *   - **失败也落行**：`outcome` ∈ ok / unavailable / timeout（值域单源 = shared
 *     `MEMORY_RECALL_OUTCOMES`）——只记成功会让"引擎不可用率"失去分母。
 *     `ok` 含**零结果**（零结果是合法成功，与 `unavailable` 语义不同）
 *   - `query_hash` 是 **sha256（64 hex）**：摘要列，**恒落**（原文列缺失时它仍是唯一的
 *     对账线索——摘要不因留存开关而消失）
 *   - `query_text` 是**原文列，默认留存**（Owner 拍板 2026-10-09：内部项目排障刚需——
 *     agent 会话压缩后拿不到原始 query，只有摘要会让召回排障断链）。两个边界缺一不可：
 *     ① 受项目开关 `memory_projects.retain_query_text` 支配（false ⇒ 本列恒 NULL）；
 *     ② 本列 `select: false` 且**刻意零 API 读取面**（运维 SQL 显式 select 才读；
 *     遥测表长期保留、进备份，开放 HTTP 读取面等于把敏感语料仓暴露出去）
 *   - `filtered_by permission` / `unmapped` 两计数**只在本表**，**不进响应体**：
 *     响应只给 `filteredByPermission` 布尔（防通过计数反推不可见资源的存在性）
 *   - 本类**零 `@Index`**：`idx_memory_recall_events_project_created` 是 migration
 *     裸 SQL 产物
 *
 * [关联代码]
 *   - database/migrations/1791700000000-AddMemoryModule.ts — 建表 + 索引（裸 SQL，无 FK）
 *   - database/entities/memory-nomination.entity.ts — 映射来源（召回过滤的第一环）
 *   - packages/shared/src/enums/index.ts — MEMORY_RECALL_OUTCOMES 值域单源
 *   - test/memory-schema.e2e-spec.ts — 逐列对齐 + 无 FK / indexdef 断言守卫
 *
 * [持久踩坑]
 *   MEMORY-QUERY-TEXT-RETENTION(原文留存边界): 本表**故意**存 query 原文（默认开）——
 *     这是"内部项目排障刚需"与"隐私"之间的既有裁决，不是疏忽，**别把它当 bug 顺手删**。
 *     但它有两条不可松动的边界：① 项目开关 `retain_query_text=false` 时必须落 NULL；
 *     ② **不加 API 读取面**（`select:false` + 运维 SQL）。松掉任一条，遥测表（长期保留、
 *     进备份）就变成可经 HTTP 拉取的敏感语料仓。
 *     开源口径（2026-10-09 Owner 二判）：自部署场景数据不出部署方边界，**无需摘除**——
 *     外部部署方文档知情 + 可按项目关闭即可。
 *   （已退役）MEMORY-QUERY-HASH(禁落原文): 老纪律"只落 sha256"于 2026-10-09 被 Owner
 *     拍板推翻（会话压缩后召回排障断链）；摘要列 `query_hash` 仍恒落，作为开关关闭后
 *     唯一的对账线索。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { MemoryRecallOutcome } from '@agent-chamber/shared';

/**
 * 召回遥测行（append-only）。
 *
 * ⚠️ **无外键**（项目/actor 均不建 FK）；**无 updated_at / deleted_at**——只追加。
 */
@Entity('memory_recall_events')
export class MemoryRecallEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 所属项目（**无 FK**，见 [关键不变量]） */
  @Column({ type: 'uuid', nullable: false, name: 'project_id' })
  projectId: string;

  /** 召回发起者 actor（**无 FK**；软删/硬删后历史留存） */
  @Column({ type: 'uuid', nullable: false, name: 'actor_id' })
  actorId: string;

  /** 查询词 sha256（64 hex）——**恒落**（原文列被开关关闭后，它是唯一的对账线索） */
  @Column({ type: 'varchar', length: 64, nullable: false, name: 'query_hash' })
  queryHash: string;

  /**
   * 召回查询词**原文**（可空；边界见 [关键不变量] 与 [持久踩坑]）。
   *
   * 写路径：`memory-recall.service.ts` 落遥测行时，若所属项目 `retain_query_text=true`
   * 则写 `dto.query` 原文，否则恒 NULL（开关默认 true）。
   *
   * ⚠️ `select: false`：默认查询**不带出**（同 `memory_nominations.content` / `rationale`
   * 的冻结列先例）——读取只走运维 SQL 显式 select，**刻意不提供任何 API 读取面**。
   * 开源无需摘除：自部署数据不出部署方边界；外部部署方可按项目 `retain_query_text=false`。
   */
  @Column({ type: 'text', nullable: true, select: false, name: 'query_text' })
  queryText: string | null;

  /**
   * 召回视图（裸 varchar(8)）。
   *
   * ⚠️ **值域刻意未在数据层枚举**：方案 §2 只钉了列宽，端点契约（合法的 view 取值集）
   * 属 coder C 批次（`POST /memory/projects/:id/recalls` 的入参校验）。本列先按原值落库，
   * 待端点契约定稿后由**服务层**按同一单源枚举校验（不要在这里补一份会漂移的字面量数组）。
   */
  @Column({ type: 'varchar', length: 8, nullable: false })
  view: string;

  /**
   * 召回结果（值域单源 = shared `MEMORY_RECALL_OUTCOMES`：ok | unavailable | timeout）。
   * 无默认值——每次召回必须显式写出结果（缺省会让"未写"与"ok"混淆）。
   */
  @Column({ type: 'varchar', length: 16, nullable: false })
  outcome: MemoryRecallOutcome;

  /** 引擎返回的 item 数（**过滤前**的原始条数；outcome≠ok 时为 0） */
  @Column({ type: 'int', nullable: false, default: 0, name: 'item_count' })
  itemCount: number;

  /** 因**来源权限**被过滤掉的 item 数（**只落遥测，不进响应体**，见 [关键不变量]） */
  @Column({ type: 'int', nullable: false, default: 0, name: 'filtered_count' })
  filteredCount: number;

  /** 引擎返回但**在本项目映射不到 canonical 账本行**的 item 数（>0 且存在 committed
   * 行时 → `engineDataSuspect` 告警；在途行不计入，方案 §5） */
  @Column({ type: 'int', nullable: false, default: 0, name: 'unmapped_count' })
  unmappedCount: number;

  /** 引擎侧 recall ID（对账用；不可达时为 null） */
  @Column({ type: 'varchar', length: 128, nullable: true, name: 'engine_recall_id' })
  engineRecallId: string | null;

  /** 引擎侧 request ID（错误体解析不丢；排障时与 Hub 日志对账的唯一线索） */
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'request_id' })
  requestId: string | null;

  /** 落库时刻（本表**只有** created_at：append-only 无更新语义） */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
