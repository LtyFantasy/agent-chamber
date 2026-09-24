/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）录入工具 `record_experience` —— 平台第四资源的写入入口
 *
 * [代码职责]
 *   - 把一次「踩坑/修好/找到做法」沉淀成跨项目可复用的条目：本地快速失败（枚举/结构）
 *     → `POST /experiences` → 原样透传录入结果（含疑似重复软提示与非阻断告警）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §0（威胁模型：禁止密钥/PII 的理由）
 *     /§2（写侧归一化）/§3（POST 契约）/§4（工具契约与措辞要求）
 *   - 补充: apps/backend/src/modules/experience/dto/create-experience.dto.ts — 字段约束真值
 *   - ⚠️ 批 5 上线线上 `docs/experience-base.md` 后，权威文档指针改为该线上文档
 *
 * [关键不变量]
 *   - **不传 `quality`/`createdBy`**：录入通道强制 unverified、录入者取认证身份；
 *     自传这两个字段会被后端 `forbidNonWhitelisted` 直接 400（徽章洗白防线的物理隔离），
 *     故本工具的 inputSchema **刻意不暴露**它们
 *   - **`signals` 恒必填且 minItems=1**（architect R8）：不做"是否给了 signals"的条件校验
 *     双写分叉；schema 与本地校验都必须拦空数组
 *   - **密钥/PII 禁令必须进 description**：经验库是全认证可读的跨项目共享面（plan §0
 *     威胁模型明文接受），后端 `EXPERIENCE_SECRET_PATTERNS` 对 `ask_`/`sk-`/
 *     `BEGIN PRIVATE KEY`/`password=` 命中即 400——消费者应在**写之前**脱敏，
 *     而不是靠后端拦
 *   - **不新增响应字段**：返回体就是后端 `RecordExperienceResponse`（id/quality/
 *     possibleDuplicates/warnings/idempotentReplay）；"立即可搜无需审批"是**说明**，
 *     放在 description，不伪造进响应（避免 MCP 层自造第二份契约）
 *
 * [关联代码]
 *   - tools/experience-shared.ts — 本地快速失败与 schema 片段单源
 *   - apps/backend/src/modules/experience/experience.service.ts — 归一化/限流/密钥闸门/
 *     疑似重复/幂等（全部业务规则的裁判）
 *   - apps/backend/src/modules/experience/experience.constants.ts — 限流 30/h 与
 *     闸门模式单源（本文件 description 复述，禁改在 MCP 侧调参）
 *
 * [持久踩坑]
 *   EXPERIENCE-SECRET-LEAK(密钥外溢): 排障笔记最典型的泄漏形态是把带 `password=` 的连接串
 *     或 `ask_`/`sk-` 前缀 Key 原文粘进正文——条目对全部认证 actor 可见，录入即等于公开。
 *     安全方向: description 前置禁令 + 后端闸门 400（两层，缺一不可）。
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
 * record_experience — 录入一条可复用的经验笔记（"带伤疤的实战笔记"）
 *
 * 消费前提：条目一经录入**立即可搜**（quality=unverified，无审批步骤、无延迟），
 * 人类 admin 或空间 owner/reviewer 之后可能标记 verified/suspect。重复录入的代价是双份条目污染检索，
 * 故应先 `search_experiences` 查重（响应的 possibleDuplicates 是第二道软提示）。
 */
export const recordExperienceTool: CustomTool = {
  tool: {
    name: 'record_experience',
    description:
      "Record a reusable cross-project experience entry — the platform's fourth resource " +
      '(topics = people, boards = work, DocSpace = knowledge, experiences = scars with lessons). ' +
      'WHEN TO RECORD: you just fixed something whose SYMPTOM would be hard to recognize next ' +
      'time (cryptic error, non-obvious root cause, config trap); or you found a procedure worth ' +
      'repeating; or you rejected an approach for a reason worth warning others about. ' +
      'WHEN NOT TO RECORD: project-local status/decisions (use DocSpace `upsert_doc`), things ' +
      'already covered by an existing entry (search first — then `update_experience` it), or ' +
      'anything you have not actually verified. NEVER INCLUDE SECRETS OR PII: no API keys ' +
      '(`ask_`/`sk-` prefixes), no PEM private keys, no `password=` connection strings, no ' +
      'customer data — every authenticated actor can read this base, and the server rejects ' +
      'credential patterns with 400. The entry becomes immediately searchable at ' +
      'quality="unverified": there is NO approval step and no delay; a human admin or a space ' +
      'owner/reviewer may later mark it verified or suspect. ' +
      'REQUIRED: title (≤200 chars), summary (≤500 chars, the only thing the list shows — ' +
      'content is never in list results), content (markdown, ≤64KB), intent ' +
      `(${EXPERIENCE_INTENTS.join('|')}), signals (≥1 element, ≤${SIGNALS_MAX_ITEMS} elements, ` +
      `each ≤${SIGNAL_MAX_LENGTH} chars). OPTIONAL: domains (≤${DOMAINS_MAX_ITEMS} elements), ` +
      'env, sourceProject (≤128 chars), expiresAt (ISO 8601, must be in the future; omit = ' +
      'never expires), clientRequestId (1–64 chars idempotency key). ' +
      'Returns {id, quality:"unverified", judgment, possibleDuplicates?, warnings?, ' +
      'idempotentReplay?} — ' +
      'possibleDuplicates are SOFT hints (overlapping signals or a similar title): consider ' +
      'reading/updating that entry instead of creating a twin. ' +
      '`judgment` is an OBSERVE-ERA machine pre-check whose dimension set may grow — it carries a ' +
      'cross-project `admissionSuggestion`, content-quality scores, a duplicate read and ' +
      'intent/domain suggestions: it is a HINT, only annotates and never rejects — it does NOT ' +
      'change your quality, and a null value simply means no pre-check happened (disabled, failed, ' +
      'rate-limited) or that this one dimension failed validation. ' +
      'SELF-REFLECTION LOOP (what these hints are FOR): read `judgment.admissionSuggestion.verdict` ' +
      '— it is the model judging your entry for a CROSS-PROJECT base. "reject" means it reads as ' +
      'project-specific operational detail (deploy scripts, repo policies, team conventions), a ' +
      'one-off environment fix, an unverifiable claim, or a note with no actionable content: ' +
      'reflect on your own entry and either rewrite it via update_experience (any CONTENT field ' +
      'change re-runs the pre-check) or delete it if it genuinely has no cross-project value ' +
      '(deletion is not exposed as an MCP tool — use the web UI or REST DELETE ' +
      '/experiences/:id on your own entry). "needs_human" is borderline and is left to the human ' +
      'reviewer (no action needed from you). "admit" needs no action. ' +
      '`intentSuggestion` / `domainSuggestion` work the same way: adopt them via update_experience ' +
      'when they fit (verify yourself before adopting), ignore them when they do not. ' +
      'Do not treat any of this as a verdict, and do not rewrite the entry just to please it. ' +
      'WHEN IT IS ENABLED, RECORDING WAITS FOR IT (+1–3s typical, 8s hard cap) — so set your client ' +
      'timeout to at least 10s. If the call times out, retry with the SAME clientRequestId: the ' +
      'server then replays the first response (judgment included) instead of recording a twin. ' +
      'Rate limited to 30 entries/hour per actor (429 = back off, keep your idempotency key). ' +
      EXPERIENCE_ERROR_RETRY_DISCIPLINE +
      ' ' +
      EXPERIENCE_CONSUMPTION_DISCIPLINE,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          maxLength: EXPERIENCE_TITLE_MAX_LENGTH,
          description:
            `One-line title naming the symptom or the outcome (max ${EXPERIENCE_TITLE_MAX_LENGTH} chars). ` +
            'Write it as something your future self would search for.',
        },
        summary: {
          type: 'string',
          maxLength: EXPERIENCE_SUMMARY_MAX_LENGTH,
          description:
            `Why this entry matters / when to read it (max ${EXPERIENCE_SUMMARY_MAX_LENGTH} chars). ` +
            'REQUIRED and load-bearing: list results never include `content`, so the summary is ' +
            'the only basis for deciding to open the detail. State the symptom and the gist of the fix.',
        },
        content: {
          type: 'string',
          maxLength: EXPERIENCE_CONTENT_MAX_LENGTH,
          description:
            `Markdown body (max ${EXPERIENCE_CONTENT_MAX_LENGTH} chars = 64KB). Use the four-section ` +
            'template: `## Symptom` (what you observed, verbatim error text helps), ' +
            '`## Root cause` (why it happened — the part that makes the entry reusable), ' +
            '`## Fix` (the actual commands/steps), `## How verified` (how you confirmed it worked). ' +
            'A missing "How verified" section does NOT block the write — it only comes back as a ' +
            '`warnings` entry, but it is what makes others trust the entry. ' +
            'NEVER paste secrets or PII (keys, private keys, `password=` strings, customer data): ' +
            'credential patterns are rejected with 400 because this base is readable by everyone.',
        },
        intent: {
          type: 'string',
          enum: [...EXPERIENCE_INTENTS],
          description:
            'Problem nature (controlled vocabulary): `repair` = the reader has an error and wants ' +
            'the fix; `pitfall` = the value is warning against a wrong approach; `howto` = a ' +
            'repeatable procedure; `optimize` = making something better; `decision` = why X was ' +
            'chosen over Y. Overlap rule: if the title describes a SYMPTOM choose `repair`; if it ' +
            'describes a WRONG APPROACH you are warning about, choose `pitfall`.',
        },
        signals: buildStringArraySchema({
          description:
            'Symptom signals — the PRIMARY search entry point (required, at least 1 element). ' +
            'Each element is ONE distinguishing keyword token you would type when you hit this ' +
            'again — the error identifier (`ECONNREFUSED`, `ereresolve`, `port-unreachable`), ' +
            `never the full error sentence. Max ${SIGNALS_MAX_ITEMS} elements, each ≤${SIGNAL_MAX_LENGTH} ` +
            'chars (the server lowercases and trims them).',
          minItems: 1,
          maxItems: SIGNALS_MAX_ITEMS,
          itemMaxLength: SIGNAL_MAX_LENGTH,
        }),
        domains: buildStringArraySchema({
          description:
            'Optional domain tags (open vocabulary, normalized to lowercase). Reuse the existing ' +
            'tags surfaced by `search_experiences` results (`availableDomains`) rather than ' +
            `inventing synonyms. Max ${DOMAINS_MAX_ITEMS} elements.`,
          maxItems: DOMAINS_MAX_ITEMS,
          itemMaxLength: SIGNAL_MAX_LENGTH,
        }),
        env: buildEnvInputSchema(),
        sourceProject: {
          type: 'string',
          maxLength: SOURCE_PROJECT_MAX_LENGTH,
          description:
            `Optional self-reported origin (repo slug convention, e.g. "agent-chamber", ` +
            `max ${SOURCE_PROJECT_MAX_LENGTH} chars). NOT trustworthy — used only for discovery/filtering.`,
        },
        expiresAt: {
          type: 'string',
          description:
            'Optional expiry boundary (ISO 8601, e.g. "2026-12-31T00:00:00.000Z"). MUST be in the ' +
            'future — a past timestamp is rejected with 400. Omit for a never-expiring entry. ' +
            'Expired entries disappear from the default search.',
        },
        clientRequestId: {
          type: 'string',
          maxLength: 64,
          description:
            'Optional idempotency key (1–64 chars). STRONGLY recommended for retries: if the call ' +
            'times out, resend with the SAME key — the server replays the first response ' +
            '(`idempotentReplay: true`) instead of recording a duplicate entry. Reusing a key with a ' +
            'DIFFERENT payload is rejected with 409/9002. Without a key, a retry can create twins.',
        },
      },
      required: ['title', 'summary', 'content', 'intent', 'signals'],
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const failedStep = 'record_experience';

    // ── 本地快速失败（automcp 不做运行时校验；后端仍是最终裁判）───────────────
    for (const [argName, required] of [
      ['title', true],
      ['summary', true],
      ['content', true],
    ] as const) {
      const failure = checkStringArg(args[argName], { argName, failedStep, required });
      if (failure) return failure;
    }

    // required: true —— `intent` 是本工具的必填枚举（评审 m1）：checkEnumArg 对
    // undefined/null 默认放行，缺传会白跑一次必然 400 的往返；本地失败并回显五值更省
    const intentFailure = checkEnumArg(args.intent, EXPERIENCE_INTENTS, {
      argName: 'intent',
      failedStep,
      required: true,
      hint:
        'Use `repair` when the title describes a symptom, `pitfall` when it warns against a ' +
        'wrong approach.',
    });
    if (intentFailure) return intentFailure;

    const signalsFailure = checkStringArrayArg(args.signals, {
      argName: 'signals',
      failedStep,
      required: true,
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

    // ── 请求体组装：只带非 undefined 字段（后端 forbidNonWhitelisted 对多余键 400）──
    const body: Record<string, unknown> = {
      title: args.title,
      summary: args.summary,
      content: args.content,
      intent: args.intent,
      signals: args.signals,
    };
    for (const key of [
      'domains',
      'env',
      'sourceProject',
      'expiresAt',
      'clientRequestId',
    ] as const) {
      if (args[key] !== undefined) body[key] = args[key];
    }

    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);
    try {
      const created = await client.request<Record<string, unknown>>('POST', '/experiences', {
        body,
      });
      return { content: [{ type: 'text', text: JSON.stringify(created) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, failedStep);
    }
  },
};
