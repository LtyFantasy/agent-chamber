/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）· 使用反馈与去重仲裁
 *
 * [代码职责]
 *   - `experience_feedback` 表逐列定义（(entry, actor) 一行的去重模型 + 幂等键）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §1.2 — 逐列可空性 + 双唯一约束仲裁语义
 *     （对外文档 docs/experience-base.md 与 docs/database.md 的 experience_feedback
 *      表节随后续批次上线；两者落地后以线上文档为权威副本）
 *   - 补充: 线上 DocSpace `docs/database.md` — 表结构权威说明
 *
 * [关键不变量]
 *   - 双唯一约束**都在 migration 裸 SQL 里**（本类刻意不声明 `@Index`）：
 *     ① `uq_experience_feedback_experience_actor` (experience_id, actor_type, actor_id)
 *        = **去重仲裁者**：`ON CONFLICT` 指定它，重复反馈走 upsert 改判 outcome
 *     ② `uq_experience_feedback_actor_key` (actor_type, actor_id, client_request_id)
 *        = **幂等重放**：同 key 同 payload → idempotentReplay；同 key 不同 payload
 *        → 409 / 9002 IDEMPOTENCY_KEY_CONFLICT（复用现成分码）
 *     ⚠️ 仲裁者只有一个：`ON CONFLICT (experience_id, actor_type, actor_id)` 是**必须**
 *     指定的目标，写错成 ② 会让"同一人重复反馈"变成插两行（计数随之重复累加）
 *   - `outcome` 语义是「**应用后**是否有效」，**不是**「搜索结果是否命中」
 *   - `outcome` 改判必须与 `experience_entries` 的计数三列**同事务 ±1 联动**
 *     （helped_count / not_helpful_count / distinct_helped_count；plan §1.2 不变量，
 *      铁律 #18 断言：三列联动 / 非负 / 重复改判幂等 / 并发不漂移）
 *   - 无 `updated_at`：本表只有「首次反馈」与「改判」两态，时间语义由 created_at
 *     单一承载（改判不刷新时间戳，避免"最近反馈"读成"最近改判"）
 *
 * [关联代码]
 *   - database/migrations/1790000000000-AddExperienceEntries.ts — 建表 + 双唯一约束 + FK（裸 SQL）
 *   - database/entities/experience-entry.entity.ts — 计数三列的宿主表（改判联动方）
 *   - packages/shared/src/enums/index.ts — EXPERIENCE_FEEDBACK_OUTCOME 值域单源
 *   - common/services/idempotency.helper.ts — 幂等键（clientRequestId）通用处理
 *
 * [持久踩坑]
 *   EXPERIENCE-FEEDBACK-CONFLICT-TARGET(仲裁者): `ON CONFLICT` 目标写成幂等键而非
 *     (experience_id, actor_type, actor_id) → 同人重复反馈插两行、计数重复累加，
 *     且**无报错**（表无 CHECK 拦得住）。安全方向: 改判路径恒以 ① 为冲突目标，
 *     幂等重放路径读记录后比对 request_hash。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActorType, type ExperienceFeedbackOutcome } from '@agent-chamber/shared';

/**
 * 经验使用反馈（(entry, actor) 去重 + 埋点）。
 *
 * 为什么需要独立的反馈表而不是条目上的两个计数器：**去重仲裁需要行**。
 * `distinct_helped_count`（most_used 排序权重）必须能回答"有几个**不同** actor
 * 确认有效"，计数器做不到；同时本表承担埋点（谁在什么时候因为什么条目受益），
 * 4 周复查判据的 helped:not_helpful 比即出自本表。
 *
 * 约束语义（双唯一，均在 migration 裸 SQL）：见文件头 [关键不变量]。
 */
@Entity('experience_feedback')
export class ExperienceFeedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 被反馈的经验条目 ID（FK→experience_entries ON DELETE CASCADE）
   *
   * 声明 CASCADE 仅为**硬删完整性**：正常路径是软删（deleted_at），CASCADE 永不触发
   * （plan §1.2）。实体侧保持裸 uuid 不建关系对象（doc-space/attachment 先例，
   * 避免 entities 层产生新环）。
   */
  @Column({ type: 'uuid', nullable: false, name: 'experience_id' })
  experienceId: string;

  /** 反馈者类型（复用 ActorType：agent / human / system） */
  @Column({ type: 'varchar', length: 16, nullable: false, name: 'actor_type' })
  actorType: ActorType;

  /** 反馈者 ID（**无 FK**：actor 硬删后既有反馈行须存活，去重计数不倒退） */
  @Column({ type: 'uuid', nullable: false, name: 'actor_id' })
  actorId: string;

  /**
   * 反馈结果（helped / not_helpful）
   *
   * ⚠️ 语义 = **应用后**是否有效，不是搜索是否命中（值域单源
   * shared `EXPERIENCE_FEEDBACK_OUTCOMES`；该语义必须写进 MCP schema description）。
   */
  @Column({ type: 'varchar', length: 16, nullable: false })
  outcome: ExperienceFeedbackOutcome;

  /** 幂等键（1~64 字符，DTO 层校验；与 actor 组成 `uq_experience_feedback_actor_key`） */
  @Column({ type: 'varchar', length: 64, nullable: false, name: 'client_request_id' })
  clientRequestId: string;

  /** 首次反馈时间（改判不刷新：本列语义是"这条反馈何时建立"） */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
