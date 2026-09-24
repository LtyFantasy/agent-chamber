/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）空间成员管理请求体（第二期 plan §2.2）
 *
 * [代码职责]
 *   - 授权/改角色两请求体的**格式校验**（UUID / 角色词表）——业务闸门（admin/owner 权限）
 *     一律在 service（铁律 #21：DTO 管格式，service 管存在性与策略）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` §6/§11（角色语义与治理决策记录；
 *     原 .kimi/plans/plan-experience-base-p2.md §0/§2.2 为历史 plan，四态已随 v1.81.0 退役）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章 members 端点契约
 *
 * [关键不变量]
 *   - **role 必填、无默认值**：两值（owner/reviewer）皆是特权，缺省 = 默认授权
 *     （与 `experience_space_members.role` 列刻意无 DB 默认值同一条决定）；词表单源 =
 *     shared `EXPERIENCE_MEMBER_ROLES`（DTO `@IsIn` 与 service 判定不得各写一份）
 *   - **PATCH 的 body 只有 role**（不接 actorId——目标 actor 在 path 上；接 body 会让
 *     "改谁"有两个真相源）
 *   - 本 DTO **不做存在性校验**：`actorId` 是否是真实且未软删的 actor 由
 *     `ActorProfileService.assertActorUsable` 判定（404 / AGENT_NOT_FOUND，铁律 #22）
 *
 * [关联代码]
 *   - experience-member.service.ts — 闸门与写路径（addMember/updateMemberRole）
 *   - packages/shared/src/enums/index.ts — EXPERIENCE_MEMBER_ROLES 值域单源
 *   - packages/shared/src/dto/experience-response.dto.ts — ExperienceMemberDto（读侧投影）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增字段必须与 service 闸门/`assertActorUsable` 契约同步（禁绕过双层校验）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { IsIn, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EXPERIENCE_MEMBER_ROLES, type ExperienceMemberRole } from '@agent-chamber/shared';

/**
 * 授权请求体（`POST /experiences/members`）。
 *
 * 闸门（service）：admin 全权；owner **仅可授 `reviewer` 值**（授 owner 是 admin 专属，
 * 否则 owner 可自造同级 owner）。
 */
export class AddExperienceMemberDto {
  @IsUUID()
  @ApiProperty({
    description:
      'Actor id to authorize (human user id or agent id). Must exist and not be soft-deleted, ' +
      'otherwise 404 / AGENT_NOT_FOUND. The actor does NOT need to be the caller.',
    example: 'a1b2c3d4-1111-4222-8333-444455556666',
  })
  actorId!: string;

  /** 角色（`owner` = 空间管理员 / `reviewer` = 终审人；词表见 shared 单源） */
  @IsIn([...EXPERIENCE_MEMBER_ROLES])
  @ApiProperty({
    description:
      '`owner` (space admin: review + manage reviewers) or `reviewer` (can review). No default — ' +
      'both values are privileges, so the field is required (a default would be implicit granting).',
    enum: EXPERIENCE_MEMBER_ROLES,
    example: 'reviewer',
  })
  role!: ExperienceMemberRole;
}

/**
 * 改角色请求体（`PATCH /experiences/members/:actorId`）。
 *
 * 语义 = **原子改角色**（不是"加/删"）：同角色 PATCH 是幂等 no-op（200），角色变更走
 * UPDATE（授权历史留在 audit_logs，表上不存时间线）。
 */
export class UpdateExperienceMemberRoleDto {
  @IsIn([...EXPERIENCE_MEMBER_ROLES])
  @ApiProperty({
    description:
      'New role. Owner callers are constrained: both the target row and this value must be ' +
      '`reviewer` (promoting anyone to `owner` is admin-only), otherwise 403 / 13004.',
    enum: EXPERIENCE_MEMBER_ROLES,
    example: 'reviewer',
  })
  role!: ExperienceMemberRole;
}
