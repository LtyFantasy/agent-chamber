/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）使用反馈工具 `report_experience_feedback` —— 排序权重的唯一来源
 *
 * [代码职责]
 *   - `POST /experiences/:id/feedback`（`{outcome, clientRequestId}`）→ 透传事务后的三列计数
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §1.2（反馈双唯一约束与计数联动不变量）
 *     /§3（反馈端点契约与 409 三分类动作表）/§4（工具契约：语义措辞与重复反馈语义）
 *   - 补充: apps/backend/src/modules/experience/dto/report-experience-feedback.dto.ts —
 *     outcome 语义与幂等键必填的真值来源
 *   - ⚠️ 批 5 上线线上 `docs/experience-base.md` 后，权威文档指针改为该线上文档
 *
 * [关键不变量]
 *   - **`outcome` 语义 = 「应用之后是否有效」**，**不是**「搜索是否命中」（plan §1.2）：
 *     这条语义必须逐字进 schema description，否则 agent 会把"搜到过"当成"帮到了"，
 *     直接污染 `distinctHelpedCount`（most_used 排序的权重列）——排序一坏，整个检索面失真
 *   - **`clientRequestId` 必填**：反馈是"更新语义"的写入口（改判会覆盖 outcome），
 *     没有幂等键就无法区分"重发"与"改判"；同 key 同 payload → `idempotentReplay`，
 *     同 key 不同 payload → 409/9002（不可重试）
 *   - **重复反馈不是错误**：同一 (entry, actor) 再次反馈走改判（改判会 ±1 联动三列计数），
 *     响应带 `alreadyRecorded: true`；改判是**新 outcome + 新 key**，不是幂等重试
 *   - 超时不代表失败：**必须用同一把 key 重发**（换 key = 可能记成第二次反馈/改判）
 *
 * [关联代码]
 *   - tools/experience-shared.ts — 本地快速失败单源
 *   - tools/read-experience.ts — 反馈的对象来源（读完、应用后才能诚实反馈）
 *   - apps/backend/src/modules/experience/experience.service.ts — upsert 去重 + 改判三列联动 +
 *     过期条目 409 + 同事务计数（全部不变量在后端，本工具只透传）
 *
 * [持久踩坑]
 *   EXPERIENCE-FEEDBACK-SEMANTICS(反馈语义): "搜到过"与"用后有效"混淆会污染排序权重列，
 *     且这种污染**不可回滚**（计数是累计值）。安全方向: schema description 写死
 *     「AFTER you applied it」，并在读工具 description 里同样提示闭环。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { EXPERIENCE_FEEDBACK_OUTCOMES } from '@agent-chamber/shared';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import {
  EXPERIENCE_CONSUMPTION_DISCIPLINE,
  EXPERIENCE_ERROR_RETRY_DISCIPLINE,
  checkEnumArg,
  checkStringArg,
} from './experience-shared';

/**
 * report_experience_feedback — 报告一条经验在**实际应用之后**是否有效
 *
 * 这是经验库唯一的质量回馈通道：`helped` 会推进 `distinctHelpedCount`（most_used 排序
 * 的权重列），所以语义必须是"我照它做了，有效/无效"，而不是"我搜到了它"。
 */
export const reportExperienceFeedbackTool: CustomTool = {
  tool: {
    name: 'report_experience_feedback',
    description:
      'Report whether an experience entry actually worked — did it help AFTER you applied it? ' +
      'This is NOT "did the search find it" and NOT "does it look plausible": the outcome feeds ' +
      'the ranking weight (how many distinct actors said an entry helped), so reporting `helped` ' +
      'for an entry you merely scrolled past corrupts the ranking for everyone and cannot be ' +
      'rolled back. Report only after you tried the fix: `helped` = it solved (or materially ' +
      'advanced) your problem; `not_helpful` = you applied it and it did not work (also valuable ' +
      '— it is how a stale entry gets demoted). ' +
      'ONE ROW PER (entry, actor): sending a different outcome later is a RE-JUDGEMENT (改判) — ' +
      'it moves the counters by ±1 in the same transaction, and the response carries ' +
      'alreadyRecorded: true. Changing your mind therefore means a NEW outcome with a NEW ' +
      'clientRequestId; it is not an idempotent retry. ' +
      'clientRequestId is REQUIRED (1–64 chars) and is your timeout safety net: if the call times ' +
      'out, do NOT blindly resend without it — resend with the SAME key and the server replays the ' +
      'first response (`idempotentReplay: true`) instead of double-counting. Same key with a ' +
      'DIFFERENT payload is rejected with 409/9002 (do not retry). ' +
      'Returns {experienceId, outcome, helpedCount, notHelpfulCount, distinctHelpedCount, ' +
      'alreadyRecorded?, idempotentReplay?} — the counts are the post-transaction values, so no ' +
      'second read is needed. ' +
      'ERRORS: 13000 = the entry does not exist or was deleted (go back to search — do NOT retry); ' +
      '409/9001 = the entry has EXPIRED, and expired entries refuse feedback (no retry — expired ' +
      'means the entry is out of the ranking pool, so a judgement on it is not comparable); ' +
      '409/9002 = the idempotency key was already used with a different payload (no retry). ' +
      EXPERIENCE_ERROR_RETRY_DISCIPLINE +
      ' ' +
      EXPERIENCE_CONSUMPTION_DISCIPLINE,
    inputSchema: {
      type: 'object',
      properties: {
        experienceId: {
          type: 'string',
          description: 'Experience UUID you applied (from search_experiences / read_experience).',
        },
        outcome: {
          type: 'string',
          enum: [...EXPERIENCE_FEEDBACK_OUTCOMES],
          description:
            'Did it help AFTER you applied it? `helped` = the fix/symptom-mapping actually worked; ' +
            '`not_helpful` = you applied it and it did not work. NOT "did the search find it".',
        },
        clientRequestId: {
          type: 'string',
          maxLength: 64,
          description:
            'REQUIRED idempotency key (1–64 chars). Reuse the SAME key only when retrying the SAME ' +
            'outcome (timeout safety). A different outcome is a new judgement and needs a NEW key. ' +
            'Same key + different payload → 409/9002 (do not retry).',
        },
      },
      required: ['experienceId', 'outcome', 'clientRequestId'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const failedStep = 'report_experience_feedback';

    // ── 本地快速失败（枚举 + 必填串；后端仍是最终裁判）───────────────────────
    const experienceIdFailure = checkStringArg(args.experienceId, {
      argName: 'experienceId',
      failedStep,
      required: true,
    });
    if (experienceIdFailure) return experienceIdFailure;

    const outcomeFailure = checkEnumArg(args.outcome, EXPERIENCE_FEEDBACK_OUTCOMES, {
      argName: 'outcome',
      failedStep,
      hint:
        'Report this only after applying the entry — `helped` feeds the ranking weight, so ' +
        '"the search found it" is not a valid reason to report `helped`.',
    });
    if (outcomeFailure) return outcomeFailure;

    const keyFailure = checkStringArg(args.clientRequestId, {
      argName: 'clientRequestId',
      failedStep,
      required: true,
    });
    if (keyFailure) return keyFailure;

    const experienceId = args.experienceId as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);
    try {
      const feedback = await client.request<Record<string, unknown>>(
        'POST',
        `/experiences/${encodeURIComponent(experienceId)}/feedback`,
        { body: { outcome: args.outcome, clientRequestId: args.clientRequestId } },
      );
      return { content: [{ type: 'text', text: JSON.stringify(feedback) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, failedStep);
    }
  },
};
