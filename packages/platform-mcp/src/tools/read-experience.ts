/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）详情工具 `read_experience` —— 全文出口
 *
 * [代码职责]
 *   - `GET /experiences/:id` → 原样透传详情（含 `content` 全文 + `expired`/`quality` 标记）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §3（详情端点契约：按 id 只过滤软删，
 *     suspect/过期条目照常可见并带标记）/§4（工具契约：expired/quality 必须透传）
 *   - 补充: packages/shared/src/dto/experience-response.dto.ts — ExperienceDetail 形状单源
 *   - ⚠️ 批 5 上线线上 `docs/experience-base.md` 后，权威文档指针改为该线上文档
 *
 * [关键不变量]
 *   - **详情与列表的过滤口径刻意不同**：列表默认排除 suspect/过期，详情**只过滤软删**——
 *     复核/申诉动线要求 suspect 与过期条目能被读出来（带 `quality`/`expired` 标记），
 *     所以本工具**不得**在上层重做过滤（那会让"看得到才能改回来"的出口消失）
 *   - **响应原样透传，不做字段裁剪**：详情全文是消费方唯一需要全文的地方；
 *     任何"顺手精简"都可能删掉消费者据以判断的信息（quality/expired/signals 必须原样在）
 *   - **13000 的正确动作是"回 search"，不是重试同 id**（id 可能来自过期缓存或他人转述）
 *
 * [关联代码]
 *   - tools/search-experiences.ts — 产出待读 id 的上游（含 signalsMatched 命中原因）
 *   - tools/report-experience-feedback.ts — 读完并应用后的反馈入口（编排链最后一环）
 *   - apps/backend/src/modules/experience/experience.service.ts — findOne（软删过滤的唯一判定点）
 *
 * [持久踩坑]
 *   EXPERIENCE-DETAIL-SUSPECT-VISIBLE(详情不过滤 suspect): 若上层照列表口径过滤 suspect/
 *     过期，条目会"看不见但也改不回来"——复核出口被打断。安全方向: 详情只信后端软删判定，
 *     suspect/过期一律带标记透传。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import {
  EXPERIENCE_CONSUMPTION_DISCIPLINE,
  EXPERIENCE_ERROR_RETRY_DISCIPLINE,
  checkStringArg,
} from './experience-shared';

/**
 * read_experience — 读取一条经验的完整正文
 *
 * 与列表的关系：列表只给"值不值得点进去"的判断依据（title/summary/quality/使用计数），
 * 全文只有本工具能拿到。
 */
export const readExperienceTool: CustomTool = {
  tool: {
    name: 'read_experience',
    description:
      'Read one experience entry in full: the complete markdown `content` plus the provenance and ' +
      'trust fields (quality, expired, signals, env, helped counts, creator + verifier WITH NAMES, ' +
      'not bare UUIDs). Get the id from search_experiences. ' +
      'IMPORTANT: unlike the list, this endpoint only filters soft-deleted rows — `suspect` and ' +
      '`expired` entries ARE returned here, marked with `quality` and `expired`. That is deliberate: ' +
      'a suspect or expired entry must stay readable so it can be reviewed, appealed or fixed. ' +
      'So an entry marked `quality:"suspect"` is EXCLUDED FROM DEFAULT SEARCH but readable on ' +
      'purpose — do not treat its presence here as an endorsement; and an entry with ' +
      '`expired:true` may describe a version-specific symptom that no longer applies. ' +
      'REVIEW CONTEXT (server-side authority — never recompute it yourself): `viewerCanReview` ' +
      'tells whether YOU hold the review role (human admin, or a space owner/reviewer). Since the ' +
      'self-review rule was REMOVED (2026-09-24), it is a PURE ROLE FLAG — it no longer depends on ' +
      'who recorded the entry, and a space member CAN review an entry they recorded themselves. ' +
      'REMOVED FIELD: `viewerReviewBlockReason` is no longer returned; its absence does NOT mean you ' +
      'cannot review this entry — if `viewerCanReview` is true you may verdict it, whoever the ' +
      'creator was. Use it to find work: search_experiences quality=unverified gives the review ' +
      'queue (do NOT pre-filter the queue by creator — you can review your own entries), then ' +
      'verdict via review_experience_quality. ' +
      'ANTI-ANCHORING: while viewerCanReview is true and quality is not yet verified, the machine ' +
      'pre-check is HIDDEN — `judgment: null` with `judgmentSuppressed: true`. That is intentional ' +
      '(so it cannot anchor your own verdict); it becomes visible again once the entry is verified. ' +
      '`judgment` (when present) is an observe-era HINT, not a verdict: it only annotates and never ' +
      'changes quality. It carries an `admissionSuggestion` (the cross-project admission read: ' +
      'admit / needs_human / reject), the intent/domain suggestions, and a `rubricVersion` marker — ' +
      'intended for the AUTHOR (self-reflect: rewrite or drop a low-value entry) and for the human ' +
      'reviewer to consult; nothing in it is ever applied automatically. ' +
      'Errors: 404/13000 means the id never existed or was deleted — do NOT retry the same id ' +
      '(it may have come from a stale cache or a paraphrase), go back to search_experiences. ' +
      'After you actually apply what the entry says, close the loop with ' +
      "report_experience_feedback (helped / not_helpful) — that is what makes the next reader's " +
      'ranking meaningful. ' +
      EXPERIENCE_ERROR_RETRY_DISCIPLINE +
      ' ' +
      EXPERIENCE_CONSUMPTION_DISCIPLINE,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Experience UUID, as returned by search_experiences (field `id`). Not a title, not an ' +
            'index — a malformed value is rejected with 400 before reaching the service.',
        },
      },
      required: ['id'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const failedStep = 'read_experience';

    // 本地快速失败：id 必填且非空（UUID 形态由后端 ParseUUIDPipe 判定，MCP 侧不另立一份）
    const idFailure = checkStringArg(args.id, { argName: 'id', failedStep, required: true });
    if (idFailure) return idFailure;

    const id = args.id as string;
    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);
    try {
      const detail = await client.request<Record<string, unknown>>(
        'GET',
        `/experiences/${encodeURIComponent(id)}`,
      );
      return { content: [{ type: 'text', text: JSON.stringify(detail) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, failedStep);
    }
  },
};
