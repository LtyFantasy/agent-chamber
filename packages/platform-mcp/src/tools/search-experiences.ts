/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）检索工具 `search_experiences` —— 经验库的**主入口**
 *
 * [代码职责]
 *   - 把过滤参数映射成 REST 的**重复 query 参数**形态（signals/domains 数组）→
 *     `GET /experiences` → 列表投影（白名单 + 截断）→ 零命中成功信封
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（匹配契约：ANY-overlap / 参数间 AND /
 *     q 是过滤+排序 / SCORE_FLOOR 0.08 / 传参协议）/§4（工具契约与措辞要求）
 *   - 补充: apps/backend/src/modules/experience/dto/query-experience.dto.ts — 参数约束真值
 *   - 补充: packages/shared/src/dto/experience-response.dto.ts — 信封与 EXPERIENCE_ZERO_HIT_HINT 单源
 *   - ⚠️ 批 5 上线线上 `docs/experience-base.md` 后，权威文档指针改为该线上文档
 *
 * [关键不变量]
 *   - **数组参数必须走 `serializeRepeatedParams`**（`?signals=a&signals=b`）：axios 默认的
 *     方括号形态 `signals[]=` 会被后端 query-form 守卫 400（不是静默忽略）——
 *     形态的真机实证见 `src/experience-params-serialization.spec.ts`（真 http server 捕获 req.url）
 *   - **零命中是成功态**：`items: []` + `total: 0` + `hint`，绝不抛错、绝不返回 404。
 *     hint 文本**引用 shared `EXPERIENCE_ZERO_HIT_HINT`**（禁手抄）：这段话是消费方的行为
 *     指令（"自己动手解决 → 然后录进来"，而不是"换个词再搜直到搜到"），必须逐字稳定
 *   - **列表投影不含 content**（走后端列表契约 + 本地白名单双保险）：全文只走
 *     `read_experience`
 *   - 本工具**刻意不暴露 `includeSuspect`**（admin ∪ 空间 owner/reviewer 版控面，plan §4 参数表不含它）——
 *     agent 侧不需要，暴露只会制造 403 噪音；`quality=suspect` 的豁免通道照常可用
 *
 * [关联代码]
 *   - tools/experience-shared.ts — 投影/本地快速失败/schema 片段单源
 *   - tools/read-experience.ts — 详情全文（本工具只给"值不值得点进去"的判断依据）
 *   - tools/report-experience-feedback.ts — 用后反馈（编排链最后一环）
 *   - src/platform-client.ts — `serializeRepeatedParams`
 *   - apps/backend/src/modules/experience/experience-query-form.ts — 括号形态 400 的后端判定点
 *
 * [持久踩坑]
 *   EXPERIENCE-MCP-ARRAY-SERIALIZATION(数组序列化): 走 REST 时数组参数一旦落回 axios 默认
 *     形态，后端守卫会 400；而 mock 单测**测不出**序列化（mock 掉的 axios 不序列化任何东西）。
 *     安全方向: handler 显式传 `serializeRepeatedParams` + 真 http server 形态断言双保险。
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
  EXPERIENCE_INTENTS,
  EXPERIENCE_QUALITIES,
  EXPERIENCE_SORT_VALUES,
  EXPERIENCE_ZERO_HIT_HINT,
} from '@agent-chamber/shared';
import { PlatformApiClient, serializeRepeatedParams } from '../platform-client';
import { handlePlatformError } from './get-my-briefing';
import {
  EXPERIENCE_CONSUMPTION_DISCIPLINE,
  EXPERIENCE_ERROR_RETRY_DISCIPLINE,
  buildStringArraySchema,
  checkEnumArg,
  checkStringArrayArg,
  projectExperienceSummaries,
} from './experience-shared';

/** limit 钳制边界（照 get_my_activity 惯例：1~50，缺省 10） */
const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
const LIMIT_DEFAULT = 10;

/** signals 元素长度上限（单源 = 后端 `EXPERIENCE_ELEMENT_MAX_LENGTH`；见 record 工具同款说明） */
const SIGNAL_MAX_LENGTH = 50;

/** signals / domains 元素数上限（单源 = 后端 `EXPERIENCE_MAX_SIGNALS` / `EXPERIENCE_MAX_DOMAINS`） */
const SIGNALS_MAX_ITEMS = 20;
const DOMAINS_MAX_ITEMS = 20;

/**
 * 数量参数钳制：非数字/非有限值回退缺省，其余钳到 [1, 50]。
 *
 * @param raw      - 调用方传入的原始值
 * @param fallback - 非法值回退的缺省（limit 缺省 10）
 */
function clampLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.floor(raw)));
}

/**
 * search_experiences — 按症状/领域/环境/全文检索经验
 *
 * 匹配契约（plan §2，与后端同源）：`signals`/`domains` 是 **ANY-overlap**（共享至少一个
 * 元素即命中 ⇒ **加更多 signal 是扩大而不是缩小结果集**，元素是归一化后的精确相等，
 * 不是子串包含）；四个 env 参数是精确相等；各参数**之间**是 AND；`q` 是**过滤 + 排序**
 * （融合分低于 0.08 的条目会被丢弃，所以"传了 q 却零命中"是有意义的信号，不是 bug）。
 */
export const searchExperiencesTool: CustomTool = {
  tool: {
    name: 'search_experiences',
    description:
      'Search the cross-project experience base for prior art on your current problem — ' +
      'call this BEFORE spending an hour rediscovering a known trap. ' +
      'MATCHING CONTRACT: `signals` and `domains` use ANY-OVERLAP on normalized (trimmed, ' +
      'lowercased) EXACT strings — sharing at least one element is a hit, so ADDING signals ' +
      'WIDENS the result set instead of narrowing it, and a substring does not match an element. ' +
      'The four env params (envOs/envTool/envVersion/envRuntime) match by EXACT equality. All ' +
      'parameters are ANDed with each other. `q` is both a FILTER and a ranking signal (fused ' +
      'ts_rank + pg_trgm similarity, floored at 0.08): unrelated entries are dropped, and when q ' +
      'is present it takes over ordering (quality tier → fused score → usage → freshness) while ' +
      '`sort` is ignored. Suspect entries are excluded unless you pass quality="suspect" ' +
      '(the review/appeal path); expired entries are excluded unless includeExpired=true. ' +
      'WORKFLOW: search_experiences → read_experience (full text of the promising ids) → apply ' +
      'the fix → report_experience_feedback with whether it actually worked. ' +
      'ZERO HITS IS A SUCCESS, not an error: you get ' +
      '{items: [], total: 0, hint, appliedFilters, availableDomains}. ' +
      `The hint says: "${EXPERIENCE_ZERO_HIT_HINT}" ` +
      'Each item carries `expiresAt`/`expired` and, when the query hit on signals, ' +
      '`signalsMatched` (why it matched). List items NEVER include the full `content` — open a ' +
      'detail with read_experience when one looks relevant. ' +
      'Each item also carries ATTRIBUTION: `createdById`/`createdByType` plus the display fields ' +
      '`createdByName`/`createdByAvatarUrl`/`createdByDeletedAt` (and `verifiedByName`). ' +
      '`createdByName === null` means the actor row was hard-deleted (show the first 8 chars of ' +
      '`createdById`); `createdByDeletedAt !== null` means the actor was soft-deleted but the real ' +
      'name is STILL in `createdByName` — always render the name, never fall back to a bare UUID. ' +
      'To filter by recorder, pass `createdById` with an ACTOR UUID taken from a previous result ' +
      '(names are NOT accepted: they drift on rename/soft-delete and two actors can share one). ' +
      'DO NOT pre-filter the review queue by creator: the self-review rule was removed ' +
      '(2026-09-24) — any admin or space owner/reviewer may verdict any entry, including their ' +
      'own — and `viewerCanReview` from read_experience is now a PURE ROLE FLAG (it no longer ' +
      'depends on the creator). Pre-filtering by creator would hide entries you CAN review. ' +
      'REVIEW QUEUE: quality=unverified lists entries waiting for a verdict (page through oldest ' +
      'first, then verdict each one with review_experience_quality); quality=suspect is the ' +
      're-check queue for entries someone flagged. ' +
      'EXAMPLE: search_experiences({ signals: ["econnrefused", "port-unreachable"], envTool: ' +
      '"docker", limit: 5 }). ' +
      `limit is 1–${LIMIT_MAX} (default ${LIMIT_DEFAULT}; out-of-range values are clamped, not rejected). ` +
      EXPERIENCE_ERROR_RETRY_DISCIPLINE +
      ' ' +
      EXPERIENCE_CONSUMPTION_DISCIPLINE,
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          maxLength: 200,
          description:
            'Optional full-text query (max 200 chars). Fused scoring: ts_rank(search_vector, ' +
            'plainto_tsquery) × 1.0 + similarity(content, q) × 0.6 + similarity(title, q) × 0.8, ' +
            'filtered at 0.08. This is the path that works for non-English text and for ' +
            'DIFFERENT WORDS meaning the same thing (e.g. entry recorded as "端口映射失效", search ' +
            '"端口不可达"). q is a filter as well as a ranking signal — prefer it over signals ' +
            'when you do not know the exact normalized token the author used.',
        },
        signals: buildStringArraySchema({
          description:
            'Optional symptom signals — ANY-overlap matching on normalized exact strings ' +
            '(sharing ≥1 signal = hit). Pass the distinguishing keyword tokens you would type ' +
            'when you hit this (`ECONNREFUSED`, `port-unreachable`), not the full error ' +
            `sentence. Max ${SIGNALS_MAX_ITEMS} elements, each ≤${SIGNAL_MAX_LENGTH} chars. ` +
            'Remember: more signals = MORE results (ANY-overlap), and each parameter is ANDed ' +
            'with the others — if you get zero hits, DROP signals rather than adding more.',
          maxItems: SIGNALS_MAX_ITEMS,
          itemMaxLength: SIGNAL_MAX_LENGTH,
        }),
        domains: buildStringArraySchema({
          description:
            'Optional domain tags — ANY-overlap matching (e.g. ["devops", "docker"]). The known ' +
            'vocabulary is echoed in each response as `availableDomains`; it is an OPEN list, so a ' +
            `missing domain is not an error. Max ${DOMAINS_MAX_ITEMS} elements.`,
          maxItems: DOMAINS_MAX_ITEMS,
          itemMaxLength: SIGNAL_MAX_LENGTH,
        }),
        envOs: {
          type: 'string',
          description: 'Optional environment filter · os (EXACT equality, e.g. "wsl2").',
        },
        envTool: {
          type: 'string',
          description: 'Optional environment filter · tool (EXACT equality, e.g. "docker").',
        },
        envVersion: {
          type: 'string',
          description: 'Optional environment filter · version (EXACT equality, e.g. "24.0.7").',
        },
        envRuntime: {
          type: 'string',
          description: 'Optional environment filter · runtime (EXACT equality, e.g. "node-20").',
        },
        intent: {
          type: 'string',
          enum: [...EXPERIENCE_INTENTS],
          description:
            'Optional filter by problem nature: repair (has an error, wants the fix) / pitfall ' +
            '(warns against a wrong approach) / howto (procedure) / optimize (make it better) / ' +
            'decision (why X over Y).',
        },
        quality: {
          type: 'string',
          enum: [...EXPERIENCE_QUALITIES],
          description:
            'Optional filter by trust level. NOTE: suspect entries are excluded by default; ' +
            'passing quality="suspect" explicitly lifts that exclusion (the review/appeal path). ' +
            'unverified entries are visible by default — a missing verified badge means "not ' +
            'reviewed yet", not "wrong".',
        },
        sourceProject: {
          type: 'string',
          description:
            'Optional filter by self-reported origin (repo slug, e.g. "agent-chamber"). ' +
            'Self-reported and NOT trustworthy; use it to find entries from a specific project.',
        },
        createdById: {
          type: 'string',
          description:
            'Optional filter by creator — an ACTOR UUID (EXACT equality). Take the value from the ' +
            '`createdById` of an item you already have; NAMES ARE NOT ACCEPTED (a name is a resolved ' +
            'display value that drifts on rename/soft-delete, and two actors can share one). ' +
            'Use this to slice by recorder — NOT to build a review queue: since the self-review rule ' +
            'was removed, space members can review their own entries, so pre-filtering the queue by ' +
            'creator would hide reviewable work.',
        },
        includeExpired: {
          type: 'boolean',
          default: false,
          description:
            'Optional. true = also return entries whose expiresAt has passed (default false). ' +
            'Expired entries may still explain an old symptom; check the `expired` flag on results.',
        },
        sort: {
          type: 'string',
          enum: [...EXPERIENCE_SORT_VALUES],
          default: 'recent',
          description:
            'Optional sort mode, applied ONLY when q is absent (q takes over ordering). ' +
            'recent (default) = most recently updated. most_used = quality tier then ' +
            'distinctHelpedCount (how many distinct actors said it helped) — these counts are ' +
            'SELF-REPORTED and gameable, so treat them as a hint, not a proof of quality.',
        },
        limit: {
          type: 'integer',
          default: LIMIT_DEFAULT,
          description: `Max items to return (1–${LIMIT_MAX}, default ${LIMIT_DEFAULT}). Values outside the range are clamped.`,
        },
      },
    },
  },

  async handler(args: Record<string, unknown>, ctx: CustomToolContext): Promise<ToolCallResult> {
    const failedStep = 'search_experiences';

    // ── 本地快速失败（枚举与数组结构；后端仍是最终裁判）─────────────────────
    const intentFailure = checkEnumArg(args.intent, EXPERIENCE_INTENTS, {
      argName: 'intent',
      failedStep,
    });
    if (intentFailure) return intentFailure;

    const qualityFailure = checkEnumArg(args.quality, EXPERIENCE_QUALITIES, {
      argName: 'quality',
      failedStep,
    });
    if (qualityFailure) return qualityFailure;

    const sortFailure = checkEnumArg(args.sort, EXPERIENCE_SORT_VALUES, {
      argName: 'sort',
      failedStep,
      hint: '`sort` only applies when `q` is absent.',
    });
    if (sortFailure) return sortFailure;

    const signalsFailure = checkStringArrayArg(args.signals, {
      argName: 'signals',
      failedStep,
      required: false,
      maxItems: SIGNALS_MAX_ITEMS,
      // 空数组在检索语义下不是过滤条件（序列化后不产出 query 键 → 被静默当"未过滤"）
      rejectEmpty: true,
    });
    if (signalsFailure) return signalsFailure;

    const domainsFailure = checkStringArrayArg(args.domains, {
      argName: 'domains',
      failedStep,
      required: false,
      maxItems: DOMAINS_MAX_ITEMS,
      rejectEmpty: true,
    });
    if (domainsFailure) return domainsFailure;

    // ── query 参数组装（仅非 undefined；数组保持数组，交给重复键序列化器）──────
    const params: Record<string, unknown> = { pageSize: clampLimit(args.limit, LIMIT_DEFAULT) };
    for (const key of [
      'q',
      'signals',
      'domains',
      'envOs',
      'envTool',
      'envVersion',
      'envRuntime',
      'intent',
      'quality',
      'sourceProject',
      // v1.81.0：**漏加这一项 = 静默丢参数**（inputSchema 里有、这里没列，参数会被无声丢弃，
      // 调用方按返回值以为"过滤生效了"）。spec 有"请求 params 含 createdById 键"的断言兜底。
      'createdById',
      'includeExpired',
    ] as const) {
      if (args[key] !== undefined) params[key] = args[key];
    }

    const client = new PlatformApiClient(ctx.baseUrl, ctx.auth);
    try {
      const envelope = await client.request<Record<string, unknown>>('GET', '/experiences', {
        params,
        // 数组参数必须是重复键形态（`signals=a&signals=b`）：缺省 axios 形态是
        // `signals[]=`，会被后端 query-form 守卫 400（真机实证见同目录序列化 spec）
        paramsSerializer: serializeRepeatedParams,
      });

      const rawItems = Array.isArray(envelope.items) ? envelope.items : [];
      const items = projectExperienceSummaries(rawItems);
      const total = typeof envelope.total === 'number' ? envelope.total : items.length;

      const response: Record<string, unknown> = {
        items,
        total,
        page: envelope.page,
        pageSize: envelope.pageSize,
      };
      // 零命中：hint 必须来自 shared 单源（后端正常会带回同一常量；此处兜底保证
      // 消费者拿到的引导语句在任何上游形状下都逐字稳定）
      const upstreamHint = typeof envelope.hint === 'string' ? envelope.hint : undefined;
      if (total === 0) {
        response.hint = upstreamHint ?? EXPERIENCE_ZERO_HIT_HINT;
      } else if (upstreamHint !== undefined) {
        response.hint = upstreamHint;
      }
      if (envelope.appliedFilters !== undefined) response.appliedFilters = envelope.appliedFilters;
      if (envelope.availableDomains !== undefined) {
        response.availableDomains = envelope.availableDomains;
      }

      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    } catch (err: unknown) {
      return handlePlatformError(err, failedStep);
    }
  },
};
