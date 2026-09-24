/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）编辑工具 `update_experience` —— Agent 的自修正通道
 *
 * [代码职责]
 *   - `PATCH /experiences/:id`（可改字段 + 必填乐观锁 `expectedUpdatedAt`）→ 透传更新后的详情
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §3（PATCH 契约：作者判定 / 乐观锁 /
 *     内容改写回落 unverified）/§4（工具契约：13001 指引 admin 终审路径）
 *   - 补充: apps/backend/src/modules/experience/dto/update-experience.dto.ts — 可改字段与
 *     清空语义（显式 null）真值
 *   - ⚠️ 批 5 上线线上 `docs/experience-base.md` 后，权威文档指针改为该线上文档
 *
 * [关键不变量]
 *   - **`expectedUpdatedAt` 必填**：乐观锁是可选项就没有意义（省略即绕过的锁 = 没有锁）。
 *     409 的正确动作是**重读（read_experience）后用新的 `updatedAt` 重试**，不是退避重试、
 *     更不是原样重发——同一个旧 token 会一直失败
 *   - **改 content/title/summary/signals 任一 → quality 回落 unverified 且清 verified 痕迹**
 *     （徽章洗白防线，判定在后端 service）：这不是 bug 而是设计——description 必须写明，
 *     否则调用方会以为"编辑把 verified 弄丢了"
 *   - **`quality` 不在此工具的 inputSchema**（质量只能走终审端点：人类 admin 或空间 owner/reviewer，
 *     工具面 = review_experience_quality）：暴露它
 *     等于把 agent 引到一个 400 上，也给"自助洗徽章"留了误读空间
 *   - **显式 null 是清空语义**（`sourceProject`/`expiresAt`）：本工具只在**参数出现时**才写进
 *     请求体，避免"没传 = 清空"的误伤（缺席 = 不改）
 *
 * [关联代码]
 *   - tools/read-experience.ts — 乐观锁 token 的来源（`updatedAt`）
 *   - tools/experience-shared.ts — 本地快速失败与 schema 片段单源
 *   - apps/backend/src/modules/experience/experience.service.ts — 作者判定（creator / owner 代理 /
 *     admin）、乐观锁比较、quality 回落、audit 插桩
 *
 * [持久踩坑]
 *   EXPERIENCE-OPTIMISTIC-LOCK-BLIND-RETRY(乐观锁盲重试): 409 后原样重发是最自然的错误动作，
 *     但它恒失败（token 已陈旧）且会掩盖"是不是别人在同时改这条"。安全方向: description 写死
 *     "re-read then retry with the fresh updatedAt"，并把 13000/13001 的动作分开写清。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import type { CustomTool, CustomToolContext, ToolCallResult } from '@agent-chamber/automcp';
import {
  EXPERIENCE_CONTENT_MAX_LENGTH,
  EXPERIENCE_INTENTS,
  EXPERIENCE_SUMMARY_MAX_LENGTH,
  EXPERIENCE_TITLE_MAX_LENGTH,
} from '@agent-chamber/shared';
import { PlatformApiClient } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import {
  EXPERIENCE_CONSUMPTION_DISCIPLINE,
  EXPERIENCE_ERROR_RETRY_DISCIPLINE,
  buildEnvInputSchema,
  buildStringArraySchema,
  checkEnvArg,
  checkEnumArg,
  checkStringArg,
  checkStringArrayArg,
  localFailure,
} from './experience-shared';

/**
 * signals 元素长度上限（单源 = 后端 `EXPERIENCE_ELEMENT_MAX_LENGTH`；platform-mcp 不依赖
 * 后端模块，故此处复述数值——后端仍是最终裁判，见 experience-shared.ts 文件头）
 */
const SIGNAL_MAX_LENGTH = 50;

/** signals / domains 元素数上限（单源 = 后端 `EXPERIENCE_MAX_SIGNALS` / `EXPERIENCE_MAX_DOMAINS`） */
const SIGNALS_MAX_ITEMS = 20;
const DOMAINS_MAX_ITEMS = 20;

/** sourceProject 长度上限（单源 = 后端 `EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH`） */
const SOURCE_PROJECT_MAX_LENGTH = 128;

/**
 * update_experience — 修订自己录的经验条目（agent 的自修正通道）
 *
 * 与 `record_experience` 的分工：录错/录漏时**改这一条**，而不是再录一条重复的
 * （重复条目会污染检索；录入响应的 possibleDuplicates 就是在提示这件事）。
 */
export const updateExperienceTool: CustomTool = {
  tool: {
    name: 'update_experience',
    description:
      "Update an experience entry you are allowed to edit (the creator, the creator agent's human " +
      'owner, or an admin). Use it to fix a wrong fix, add the missing "How verified" section, or ' +
      'add signals you later discovered — instead of recording a near-duplicate entry. ' +
      'OPTIMISTIC LOCK: `expectedUpdatedAt` is REQUIRED — pass the `updatedAt` you last read ' +
      '(from search_experiences or read_experience). On mismatch you get 409: RE-READ the entry ' +
      'and retry with the FRESH updatedAt. Blind-retrying the same value will keep failing, and ' +
      'that failure means someone else changed the entry — re-read before overwriting. ' +
      'QUALITY RESET: changing any CONTENT field — title, summary, content or signals — resets ' +
      'quality back to `unverified` and clears the verification trail. That is intentional (a ' +
      'verified badge must not survive a content rewrite); it is not an error, and you cannot ' +
      'set quality yourself — verdicts (verified/suspect) go through review_experience_quality ' +
      '(a human admin or a space owner/reviewer does that; note a `suspect` verdict is NOT cleared ' +
      'by editing content — only another verdict lifts it). Sending `quality` here is rejected ' +
      'with 400. ' +
      'FIELDS: all optional except expectedUpdatedAt — title, summary, content, intent, signals, ' +
      'domains, env, sourceProject, expiresAt. Passing an explicit `null` for sourceProject or ' +
      'expiresAt CLEARS it (expiresAt null = never expires); omitting a field leaves it unchanged. ' +
      'env keys remain a controlled whitelist (os/tool/version/runtime); arrays are REPLACED whole. ' +
      'PRE-CHECK ON REWRITE: changing any CONTENT field (title, summary, content, signals) re-runs ' +
      'the machine pre-check, and the response carries its result under `judgment` (observe-era ' +
      'HINT, may be null when disabled/failed; individual dimensions may be null when they failed ' +
      'validation). Read `judgment.admissionSuggestion.verdict` — the model judging your entry for a ' +
      'CROSS-PROJECT base. "reject" means it reads as project-specific operational detail (deploy ' +
      'scripts, repo policies, team conventions), a one-off environment fix, an unverifiable claim, ' +
      'or a note with no actionable content: that is your cue to rewrite the entry so the reusable ' +
      'lesson is what remains. "needs_human" is borderline and is left to the human reviewer. ' +
      '"admit" needs no action. `intentSuggestion` / `domainSuggestion` are suggestions too: adopt ' +
      'them when they fit (verify yourself before adopting), ignore them when they do not. None of ' +
      'this is a verdict or a gate — it never changes your quality and never blocks the write. ' +
      'ERRORS: 409 with 9001 = optimistic-lock mismatch (re-read, then retry); 13000 = the entry ' +
      'does not exist or was deleted (go back to search_experiences — do NOT retry); 13001 = the ' +
      'entry is not yours to edit (do NOT retry: an agent has no self-service path to edit another ' +
      "actor's entry — an admin or space owner/reviewer handles it through review_experience_quality). " +
      EXPERIENCE_ERROR_RETRY_DISCIPLINE +
      ' ' +
      EXPERIENCE_CONSUMPTION_DISCIPLINE,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Experience UUID to update (from search_experiences / read_experience).',
        },
        expectedUpdatedAt: {
          type: 'string',
          description:
            'REQUIRED optimistic-lock token: the `updatedAt` value you last read for this entry ' +
            '(ISO 8601). On mismatch the server returns 409 — re-read the entry and retry with the ' +
            'fresh value. Do NOT blind-retry with the same token.',
        },
        title: {
          type: 'string',
          maxLength: EXPERIENCE_TITLE_MAX_LENGTH,
          description:
            `New title (max ${EXPERIENCE_TITLE_MAX_LENGTH} chars). CONTENT field — changing it ` +
            'resets quality to `unverified`.',
        },
        summary: {
          type: 'string',
          maxLength: EXPERIENCE_SUMMARY_MAX_LENGTH,
          description:
            `New summary (max ${EXPERIENCE_SUMMARY_MAX_LENGTH} chars). CONTENT field — changing it ` +
            'resets quality to `unverified`. This is the only text shown in list results.',
        },
        content: {
          type: 'string',
          maxLength: EXPERIENCE_CONTENT_MAX_LENGTH,
          description:
            `New markdown body (max ${EXPERIENCE_CONTENT_MAX_LENGTH} chars = 64KB). CONTENT field — ` +
            'changing it resets quality to `unverified` and clears the verification trail. ' +
            'Keep the four-section shape: ## Symptom / ## Root cause / ## Fix / ## How verified. ' +
            'NEVER paste secrets or PII (credential patterns are rejected with 400).',
        },
        intent: {
          type: 'string',
          enum: [...EXPERIENCE_INTENTS],
          description:
            'New intent (NOT a content field — changing it does NOT reset quality). repair = ' +
            'reader has an error and wants the fix; pitfall = warns against a wrong approach; ' +
            'howto = procedure; optimize = make it better; decision = why X over Y. ' +
            'WHEN repair AND pitfall OVERLAP: if the title describes the SYMPTOM, pick repair; ' +
            'if it describes the WRONG APPROACH to avoid, pick pitfall.',
        },
        signals: buildStringArraySchema({
          description:
            'Replace the WHOLE signals array (not a merge). CONTENT field — changing it resets ' +
            'quality to `unverified`, because signals decide what this entry claims to cover. ' +
            'One distinguishing keyword per element (e.g. `ECONNREFUSED`), no commas, no full ' +
            `error sentences; max ${SIGNALS_MAX_ITEMS} elements, each ≤${SIGNAL_MAX_LENGTH} chars.`,
          minItems: 1,
          maxItems: SIGNALS_MAX_ITEMS,
          itemMaxLength: SIGNAL_MAX_LENGTH,
        }),
        domains: buildStringArraySchema({
          description:
            'Replace the WHOLE domains array (open vocabulary, lowercased by the server). ' +
            `Max ${DOMAINS_MAX_ITEMS} elements.`,
          maxItems: DOMAINS_MAX_ITEMS,
          itemMaxLength: SIGNAL_MAX_LENGTH,
        }),
        env: buildEnvInputSchema(),
        sourceProject: {
          type: ['string', 'null'],
          maxLength: SOURCE_PROJECT_MAX_LENGTH,
          description:
            `New self-reported source project (≤${SOURCE_PROJECT_MAX_LENGTH} chars), or explicit ` +
            '`null` to clear it. Omitting the field leaves it unchanged.',
        },
        expiresAt: {
          type: ['string', 'null'],
          description:
            'New expiry boundary (ISO 8601, must be in the FUTURE — a past timestamp is rejected ' +
            'with 400), or explicit `null` to make the entry never expire. Omitting the field ' +
            'leaves it unchanged.',
        },
      },
      required: ['id', 'expectedUpdatedAt'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const failedStep = 'update_experience';

    // ── 本地快速失败 ─────────────────────────────────────────────────────
    const idFailure = checkStringArg(args.id, { argName: 'id', failedStep, required: true });
    if (idFailure) return idFailure;

    const lockFailure = checkStringArg(args.expectedUpdatedAt, {
      argName: 'expectedUpdatedAt',
      failedStep,
      required: true,
    });
    if (lockFailure) return lockFailure;

    for (const [argName, maxLength] of [
      ['title', EXPERIENCE_TITLE_MAX_LENGTH],
      ['summary', EXPERIENCE_SUMMARY_MAX_LENGTH],
      ['content', EXPERIENCE_CONTENT_MAX_LENGTH],
    ] as const) {
      const failure = checkStringArg(args[argName], { argName, failedStep, required: false });
      if (failure) return failure;
      // 长度上限以服务端为最终口径（单源在后端 shared 常量）；此处只在明显超限时提前失败
      if (typeof args[argName] === 'string' && (args[argName] as string).length > maxLength) {
        return localFailure(
          failedStep,
          `\`${argName}\` exceeds the ${maxLength}-character limit — the entry was NOT updated.`,
        );
      }
    }

    const intentFailure = checkEnumArg(args.intent, EXPERIENCE_INTENTS, {
      argName: 'intent',
      failedStep,
    });
    if (intentFailure) return intentFailure;

    const signalsFailure = checkStringArrayArg(args.signals, {
      argName: 'signals',
      failedStep,
      required: false,
      minItems: 1,
      maxItems: SIGNALS_MAX_ITEMS,
    });
    if (signalsFailure) return signalsFailure;

    const domainsFailure = checkStringArrayArg(args.domains, {
      argName: 'domains',
      failedStep,
      required: false,
      maxItems: DOMAINS_MAX_ITEMS,
    });
    if (domainsFailure) return domainsFailure;

    const envFailure = checkEnvArg(args.env, failedStep);
    if (envFailure) return envFailure;

    // ── 显式 null 守卫（评审 B1）─────────────────────────────────────────
    // 只有 sourceProject/expiresAt 接受 null 清空；其余七个字段传 null 必须**本地失败**：
    // `checkStringArg`/`checkStringArrayArg`/`checkEnvArg`/`checkEnumArg` 都把 null 当
    // "未提供"放行，若再写进 body，后端会以 TypeError/NOT NULL 的表现炸 500
    // （`env: null` 更会静默清空）——文案必须给出"省略该键"的正确动作。
    const NULL_REJECTED_FIELDS = [
      'title',
      'summary',
      'content',
      'intent',
      'signals',
      'domains',
      'env',
    ] as const;
    const nullFields = NULL_REJECTED_FIELDS.filter((key) => args[key] === null);
    if (nullFields.length > 0) {
      return localFailure(
        failedStep,
        `Field(s) ${nullFields.join(', ')} do not accept an explicit null. Only \`sourceProject\` ` +
          'and \`expiresAt\` are nullable (null = clear); to leave any other field unchanged, OMIT ' +
          'the key entirely. This check is local (MCP layer) so the call never left the client.',
        { nullRejectedFields: [...nullFields] },
      );
    }

    // ── 请求体组装：只在参数**出现**时才写入（缺席 = 不改；显式 null = 清空）──────
    const body: Record<string, unknown> = { expectedUpdatedAt: args.expectedUpdatedAt };
    for (const key of [
      'title',
      'summary',
      'content',
      'intent',
      'signals',
      'domains',
      'env',
      'sourceProject',
      'expiresAt',
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }

    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);
    try {
      const updated = await client.request<Record<string, unknown>>(
        'PATCH',
        `/experiences/${encodeURIComponent(args.id as string)}`,
        { body },
      );
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, failedStep);
    }
  },
};
