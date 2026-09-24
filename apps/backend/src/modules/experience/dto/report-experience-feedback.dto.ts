/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）使用反馈（POST /experiences/:id/feedback）
 *
 * [代码职责]
 *   - 反馈结果值域（helped / not_helpful）与**必填幂等键**的格式校验
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §1.2（反馈双唯一约束与计数联动不变量）
 *     /§3（反馈端点契约）
 *   - 补充: 线上 DocSpace `docs/api-definition.md` — 经验库章（409 三分类动作表）
 *
 * [关键不变量]
 *   - **`outcome` 语义 = 「应用后是否有效」，不是「搜索结果是否命中」**（plan §1.2）：
 *     这条语义必须逐字进 MCP schema description，否则 agent 会把"搜到过"当成"帮到了"，
 *     进而污染 distinct_helped_count（排序权重列）
 *   - **`clientRequestId` 必填**（表列 NOT NULL + `uq_experience_feedback_actor_key`）：
 *     反馈是"更新语义"写入口（改判会覆盖 outcome），没有幂等键就无法区分"重发"与"改判"
 *   - 反馈幂等**不用 idempotency_records**：由本表双唯一约束承担（plan §1.2）
 *
 * [关联代码]
 *   - experience.service.ts recordFeedback() — upsert 去重 + 改判三列联动 + 同事务计数
 *   - database/entities/experience-feedback.entity.ts — 双唯一约束宿主
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { IsIn, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  EXPERIENCE_FEEDBACK_OUTCOMES,
  type ExperienceFeedbackOutcome,
} from '@agent-chamber/shared';

/**
 * 提交使用反馈请求体。
 */
export class ReportExperienceFeedbackDto {
  @IsIn([...EXPERIENCE_FEEDBACK_OUTCOMES])
  @ApiProperty({
    description:
      'Did the experience actually help AFTER you applied it? `helped` / `not_helpful`. ' +
      'This is NOT "did the search return it" — feedback must reflect the outcome of applying the ' +
      'fix, otherwise the ranking weight (distinct_helped_count) becomes noise.',
    enum: EXPERIENCE_FEEDBACK_OUTCOMES,
    example: 'helped',
  })
  outcome!: ExperienceFeedbackOutcome;

  @IsString()
  @Length(1, 64)
  @ApiProperty({
    description:
      'Idempotency key (REQUIRED, 1–64 chars). Same key + same outcome → replayed with ' +
      '`idempotentReplay: true` and no counter change. Same key + different payload → 409 / 9002. ' +
      'Changing your mind is a NEW outcome for the same entry — that is a re-judgement (改判), ' +
      'not an idempotent retry.',
    example: 'fb-2026-09-21-a',
  })
  clientRequestId!: string;
}
