/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）质量终审（PATCH /experiences/:id/quality；终审人 = 人类 admin
 *     或空间 owner/reviewer）
 *
 * [代码职责]
 *   - 终审取值（verified / suspect）与**必填理由**的格式校验
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` §7（终审纪律）/§11（威胁模型 + 退役决策记录）
 *     与 `docs/api-definition.md` — 经验库章（13004 动作表）
 *   - 历史: .kimi/plans/plan-experience-base-p2.md §2（成员与终审守卫）/§7（密钥/权限文案面）
 *     ——其中「禁自审四态」已于 2026-09-24 退役（v1.81.0）
 *   - 补充: .kimi/plans/plan-experience-base.md §3（第一期：方法级三元组守卫 + 双向门）
 *
 * [关键不变量]
 *   - **双向门**：verified ↔ suspect 可互改——suspect 不是终点，终审人复核后可以改回
 *     verified；故本 DTO 的值域是两个值而非单向流转
 *   - **`reason` 必填**：终审写 verified_by/verified_at 且进 audit 的 old→new+reason；
 *     没有理由的终审在事后无法复盘（谁因为什么把这条标记为可疑）
 *   - `reason` **不得含条目正文**（异常与日志不回显 content 正文的纪律同样适用于审计载荷）
 *   - **本 DTO 不承载任何"能不能审这一条"的信息**（v1.81.0）：终审资格 = 纯角色判定，
 *     与条目/作者无关，故这里没有、也不需要任何自审相关字段
 *
 * [关联代码]
 *   - experience.service.ts reviewQuality() — 写 verified_by/at + verifiedByName + audit old→new+reason
 *   - experience-member.service.ts assertCanReview() — 角色判定（唯一拒绝码 403/13004）
 *   - modules/audit/audit-constants.ts — AUDIT_ENTITY_TYPE.EXPERIENCE 插桩归属
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { IsIn, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EXPERIENCE_REVIEW_QUALITIES, type ExperienceReviewQuality } from '@agent-chamber/shared';

/**
 * 终审可写入的取值（`verified` / `suspect`）**单源在 shared**
 * （`@agent-chamber/shared` 的 `EXPERIENCE_REVIEW_QUALITIES`）。
 *
 * 为什么不再在此处定义：platform-mcp 需要同一值域做**本地枚举快速失败**，而它不可达
 * 后端模块——shared 是唯一双方可达的单源。此处 re-export 只为保持模块内既有 import 面
 * （`dto/index.ts` 的导出清单）不变；**禁止在此再造一份字面量数组**（两处漂移 =
 * MCP 侧放行后端拒绝的取值）。
 *
 * 值域刻意不含 `unverified`：终审是"给结论"，撤回结论走内容改写回落（见 entity 注释）。
 */
export { EXPERIENCE_REVIEW_QUALITIES };

/**
 * 质量终审请求体。
 *
 * 权限：端点守卫 `JwtOrApiKeyGuard`（任何认证身份可调），**角色判定在 service**
 * （`ExperienceMemberService.assertCanReview`）——人类 admin 或空间 owner/reviewer 可终审；
 * 缺角色 403/13004。**自 v1.81.0 起禁自审四态退役**：持角色者可终审任意条目（含本人所录），
 * 故本 DTO 与权限的耦合只剩"角色"这一个维度。
 */
export class ReviewExperienceQualityDto {
  @IsIn([...EXPERIENCE_REVIEW_QUALITIES])
  @ApiProperty({
    description:
      'verdict: `verified` (trusted, ranked first) or `suspect` (excluded from default search, ' +
      'still readable in detail). The gate is bidirectional — a suspect can be verified again ' +
      'and vice versa.',
    enum: EXPERIENCE_REVIEW_QUALITIES,
    example: 'verified',
  })
  quality!: ExperienceReviewQuality;

  @IsString()
  @Length(1, 500)
  @ApiProperty({
    description:
      'Why this verdict (1–500 chars). Recorded in the audit trail as old→new+reason. ' +
      'Do NOT paste the entry body here.',
    example: 'Reproduced on WSL2 + docker 24.0.7; the documented fix resolves the symptom.',
  })
  reason!: string;
}
