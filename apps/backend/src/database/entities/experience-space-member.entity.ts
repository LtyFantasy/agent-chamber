/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）· 空间成员角色（终审权委托：owner / reviewer）
 *
 * [代码职责]
 *   - `experience_space_members` 表逐列定义（可空性 / 列宽 / 空默认值即 schema 契约）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §0（角色语义与演进叙事）/§1.1（逐列）/§2（闸门）
 *   - 补充: 线上 DocSpace `docs/database.md` — experience_space_members 表节
 *     （第二期章节随批 6 文档收口上线；落地后以线上文档为权威副本）
 *
 * [关键不变量]
 *   - **单空间隐式单例：刻意无 space_id 列**（经验库是全局唯一空间，不建 space 表）。
 *     ⚠️ 未来若真要多空间，演进 = **重建 PK + 加 UNIQUE(space_id, actor_id)**，
 *     **不是**免费加一列——不许把本表写成"加列即可演进"（plan §0 订正叙事）。
 *   - **role 无 DB 默认值**（有意为之）：owner/reviewer 两值皆特权，默认值 = 默认授权，
 *     违反本项目"授权必须显式"的最小权限先例；service 层显式必填 + DTO `@IsIn`。
 *   - `actor_id` 是 **PK 且无 actor_type 列**（照 doc_space_members 先例）：响应期的
 *     name/type/avatarUrl/deletedAt 一律走 `ActorProfileService.resolveProfiles` 解析——
 *     成员行不存名，避免 actor 改名后成员清单显示漂移。
 *   - **无 FK、无 updated_at**：actor 硬删后授权行仍须可读（usage-stats/audit_logs 先例）；
 *     角色变更走 PATCH 覆盖 role，授权历史查 `audit_logs`（不另存时间列）。
 *   - DELETE = **物理删**（夺权即时生效）；权限判定**禁止缓存**本表结果
 *     （缓存会让吊销滞后生效）。
 *   - **本类不声明任何 `@Index`**：本表索引只有 PK（约束支撑索引不进漂移 diff），
 *     实体侧补装饰器会造出第二条索引事实源。
 *
 * [关联代码]
 *   - database/migrations/1790200000000-AddExperiencePhase2.ts — 建表（裸 SQL）
 *   - packages/shared/src/enums/index.ts — EXPERIENCE_MEMBER_ROLES 值域单源
 *   - packages/shared/src/dto/experience-response.dto.ts — ExperienceMemberDto（读侧投影）
 *   - common/services/owner-proxy.service.ts — 「平台既有 owner」= agent 的人类主人
 *     （与本表 owner 角色**术语撞车**，语义无关，勿混用命名空间）
 *
 * [持久踩坑]
 *   EXPERIENCE-ROLE-AUTOGrant(默认值=授权): 给 role 加 DB 默认值的诱惑（"省得插入时写"）
 *     等于让所有"忘记传 role"的写入路径静默获得特权。安全方向: 列保持无默认值，
 *     缺值插入直接 23502 失败（宁可报错也不静默授权）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { ExperienceMemberRole } from '@agent-chamber/shared';

/**
 * 经验空间成员（授权态：谁可以终审本空间的条目）。
 *
 * 授权模型（plan §0）：
 * - `owner`（中文标签 = **空间管理员**）：终审权 + 管理 reviewer（仅对 reviewer 行、
 *   仅可授 reviewer 值——双约束防 owner 自造 owner）
 * - `reviewer`（中文标签 = **终审人**）：终审权
 * - 人类 admin **不入表**（全局兜底，一切成员操作全权）
 *
 * 零成员 = 无任何条目可终审（明文接受的退化态，详见 plan §9 观测项）。
 */
@Entity('experience_space_members')
export class ExperienceSpaceMember {
  /**
   * 成员 Actor ID（**PK**，human 或 agent 的 actors.id）
   *
   * 无 actor_type 列：类型由 actors 行解析（先例 doc_space_members.actor_id）。
   */
  @PrimaryColumn({ type: 'uuid', name: 'actor_id' })
  actorId: string;

  /**
   * 成员角色（`owner` / `reviewer`；值域单源 = shared `EXPERIENCE_MEMBER_ROLES`）
   *
   * 裸 varchar(20) 而非 PG enum（新增取值无需 migration，先例 topics.kind）；
   * **刻意无 default**（见文件头不变量）。落库值域由 DTO `@IsIn` + service 闸门承担。
   */
  @Column({ type: 'varchar', length: 20, nullable: false })
  role: ExperienceMemberRole;

  /** 授权人 actorId（授权留痕；admin 直接授权时也落 admin 的 actorId；可空） */
  @Column({ type: 'uuid', nullable: true, name: 'invited_by' })
  invitedBy: string | null;

  /**
   * 成为成员的时间
   *
   * `@CreateDateColumn` 与 migration 的 `DEFAULT now()` **必须同写**：实体侧缺省
   * （或两侧默认值不一致）会让漂移门禁报列级差异，插入侧则可能撞 23502。
   */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
