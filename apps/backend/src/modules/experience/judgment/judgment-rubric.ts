/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别的**固定代码侧 rubric**与**逐字段白名单归一化**（防注入面的收口点）
 *
 * [代码职责]
 *   - **七维**问题集（instructions 英文常量 + 词表）与 `state` 组装（正文节选 ≤2000 字符）
 *   - jev 原始 answers → `ExperienceJudgment` 七维的**白名单校验 + clamp**（§0 威胁面缓解）
 *   - rubric 代际标记 `EXPERIENCE_JUDGMENT_RUBRIC_VERSION`（provider 写入快照 `rubricVersion`）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` §12（rubric 表：七维 + rubricVersion 说明，
 *     含"未来形态 = 硬门槛"注记）/§9（翻案率配对 = 校准数据源）
 *   - 历史: .kimi/plans/plan-experience-base-p2.md §3.3（原始六维问题集表——plan 标题记"五维"，
 *     落地后含 domainSuggestion 共六维）/§3.4（快照形状）/
 *     §0（"judgment 键是平台自产字段的注入面"→ 逐字段白名单）
 *
 * [关键不变量]
 *   - **条目内容只进 `state`（数据位）**，问题与评分规则**固定写在代码侧**（`instructions`
 *     常量）：这是 prompt 注入的第一道结构防线（内容无法改写"该判什么、怎么判"）。
 *   - **逐字段白名单，非法维度置 null**（不猜测、不放过）：档位必须命中词表；confidence 必须
 *     `Number.isFinite` 且 clamp(0,1)；`suggestedIntent ∈ EXPERIENCE_INTENTS`；
 *     `suggestedDomain ∈ 当次 availableDomains 快照`。任一不合法 ⇒ **该维度 null**。
 *   - **整体形状破损 ⇒ 返回 null**（调用点按 status=error 落日志且不落快照）：answers 不是对象、
 *     **全部维度全 null**（jev 换了协议/被网关改写）都属于这一类——**宁可不落快照，也不落半真快照**
 *     （快照会被 reviewer 当 ground truth 对照）。
 *   - **observe-only（用户 2026-09-24 拍板）**：新增的 `admissionSuggestion` 与既有各维一样
 *     只是**建议文本**——本文件与调用链上**没有任何**"据此拒绝录入 / 自动改写条目 / 自动升降
 *     quality"的代码路径。未来形态（准入判定为 reject 则拒收）是独立批次，前置条件 =
 *     `docs/experience-base.md` §9 的翻案率配对数据量达标。
 *   - **rubric 代际可辨**：`EXPERIENCE_JUDGMENT_RUBRIC_VERSION` 由 provider 写进快照
 *     `rubricVersion`——训练/校准数据据此区分"这条评语出自哪一代问题集"；旧快照无该字段 = v1。
 *   - **既有六维的 instructions 与词表不可改**（v1.82.0 明令）：改动即切断校准数据的纵向
 *     可比性——增维可以，改维不行。
 *   - score 类维度的档位**必须从 `legend[argmax(probabilities)]` 反查**，不能用 `round(score)`
 *     ：实测 jev 返回 `{score: 1.85, legend:{0:'missing',1:'thin',2:'partial',3:'complete'},
 *     probabilities:{...}}`，legend 才是权威映射；也**不落 probabilities 全量**（快照只留结论）。
 *   - 字符串限长：`model` 截到 64（列宽）、其余字符串值均来自白名单（天然短）。
 *
 * [关联代码]
 *   - typesafe.judgment-provider.ts — 唯一调用方（发问 + 收 answers + 调本文件的归一化）
 *   - judgment-provider.interface.ts — `ExperienceCheckInput` / `JudgmentOutcome`
 *   - packages/shared/src/dto/experience-response.dto.ts — `ExperienceJudgment`（快照形状单源）
 *
 * [持久踩坑]
 *   JUDGMENT-SCORE-LEGEND(档位反查): 把 score 四舍五入当档位在"概率接近均分"时会给错档
 *     （实测 signalQuality score=1.43 而概率 0.55/0.44 几乎均分，四舍五入得 'weak' 但
 *     argmax 也是 'weak' 属巧合，换个样本就不一定）。安全方向: 只信 legend+probabilities。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改问题集/词表必须同步 plan §3.3 的表与 shared 的快照类型（三处同源）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  EXPERIENCE_INTENTS,
  type ExperienceIntent,
  type ExperienceJudgment,
} from '@agent-chamber/shared';
import type { ExperienceCheckInput } from './judgment-provider.interface';

/** 快照的七维部分（provider/model/judgedAt/rubricVersion 由 provider 客户端补，见文件头） */
export type ExperienceJudgmentDims = Omit<
  ExperienceJudgment,
  'provider' | 'model' | 'judgedAt' | 'rubricVersion'
>;

/**
 * 送进模型的正文节选上限（字符数，plan §1.2 钉死 2000）。
 *
 * rationale：判断日志是**正文的第二副本**（全认证可读面外的又一处落库），全量正文入库会让
 * 日志表成为无限增长的内容副本；2000 字符足以判断"可复现性/信号质量"，且配
 * `contentTruncated`/`contentLength` 标记让训练脚本知道这不是全文。
 */
export const JUDGMENT_CONTENT_EXCERPT_LIMIT = 2000;

/** 各维度档位词表（**单一事实源**：问题集与归一化共用，防止"问的选项"与"认的选项"漂移） */
export const JUDGMENT_LEVELS = {
  completeness: ['missing', 'thin', 'partial', 'complete'],
  reusability: ['one_off', 'narrow', 'broad'],
  signalQuality: ['noise', 'weak', 'distinctive'],
  duplicate: ['distinct', 'possible_duplicate', 'likely_duplicate'],
} as const;

/** intentSuggestion 的可接受 choice（`keep` + 受控五值；其余一律视为非法维度） */
const INTENT_CHOICES: readonly string[] = ['keep', ...EXPERIENCE_INTENTS];

/** domainSuggestion 的两个"无建议值"档位（其余值必须在 availableDomains 快照内） */
const DOMAIN_NON_VALUE_CHOICES = ['keep', 'none_fits'] as const;

/**
 * 第 7 维 `admissionSuggestion` 的档位词表（**单一事实源**：问题集 criteria 与归一化共用，
 * 防"问的选项"与"认的选项"漂移）。
 *
 * rationale（为什么独立成维、不复用 reusability）：上午实证 `a7a3c2b0` 被"一般化教训"
 * 段落带偏判 broad——**reusability 评"这条经验本身多通用"，准入评"它对跨项目经验库有没有
 * 价值"**，二者不是同一个问题。项目专属的操作细节（部署脚本、repo 政策、团队约定）即使
 * 写得很通用也应当是 reject。判据出处 = 用户 2026-09-24 拍板（"准入 = 换个项目还成立吗"）。
 *
 * ⚠️ observe-only：本维只产出建议文本（见文件头不变量），阈值/门槛是后续独立批次。
 */
export const ADMISSION_CHOICES = ['admit', 'needs_human', 'reject'] as const;

/** `admissionSuggestion` 的 criteria 文案（键取自词表，防漏档/多档） */
const ADMISSION_CRITERIA: Record<(typeof ADMISSION_CHOICES)[number], string> = {
  admit: 'the lesson transfers beyond the project it was written in and has reproduction value',
  needs_human:
    'borderline — a reviewer should decide (thin evidence, project-specific policy, unclear transferability)',
  reject:
    'low-value for a cross-project base: project-specific operational detail, one-off environment fix, unverifiable claim, or a note with no actionable content',
};

/**
 * 判别 rubric 的代际标记（落快照 `rubricVersion`；**训练/校准数据据此分代**）。
 *
 * - `'v2'`（本版）= 七维：原六维 + `admissionSuggestion`；
 * - **旧快照无该字段 = v1**（2026-09-24 之前的六维快照），消费方按缺省处理。
 *
 * 增维才 bump：**改既有维度的 instructions 或词表不 bump**——那是校准数据纵向可比性的
 * 破坏（见文件头不变量），不允许发生。
 */
export const EXPERIENCE_JUDGMENT_RUBRIC_VERSION = 'v2';

/**
 * 组装正文节选（≤2000 字符 + 截断标记）。
 *
 * @param content 正文全文
 * @returns 节选 + `contentTruncated`（是否被截）+ `contentLength`（原始长度）
 */
export function buildContentExcerpt(content: string): {
  content: string;
  contentTruncated: boolean;
  contentLength: number;
} {
  const contentLength = content.length;
  if (contentLength <= JUDGMENT_CONTENT_EXCERPT_LIMIT) {
    return { content, contentTruncated: false, contentLength };
  }
  return {
    content: content.slice(0, JUDGMENT_CONTENT_EXCERPT_LIMIT),
    contentTruncated: true,
    contentLength,
  };
}

/**
 * 组装固定问题集（英文 instructions 常量；条目内容**不参与**这里）。
 *
 * 题型映射（plan §3.3）：完整度/可复用性/信号质量 = score 三档标尺；重复度/类型归类 =
 * choice；领域归类 = choice，且**仅当词表非空时**才挂载具体候选（否则只留 keep / none_fits，
 * 避免给模型一个空候选集而它仍然"编"出一个领域名）。
 *
 * @param availableDomains 当次可用领域词表快照（domainSuggestion 的候选值域）
 * @returns jev_ask 的 `questions` 参数
 */
export function buildRubricQuestions(
  availableDomains: string[],
): Record<string, Record<string, unknown>> {
  return {
    completeness: {
      type: 'score',
      instructions:
        'How complete is this troubleshooting note for a DIFFERENT engineer to reproduce the ' +
        'outcome? Score by whether the symptom, root cause, fix steps and verification are all ' +
        'present and actionable.',
      criteria: [...JUDGMENT_LEVELS.completeness],
    },
    reusability: {
      type: 'score',
      instructions:
        'How reusable is this note beyond the exact environment it was written in? Score one_off ' +
        'for a one-time environment-bound action, narrow for a specific stack/version, broad when ' +
        'the lesson transfers to many setups.',
      criteria: [...JUDGMENT_LEVELS.reusability],
    },
    signalQuality: {
      type: 'score',
      instructions:
        'How distinctive are the provided symptom signals for retrieval? Score noise for generic ' +
        'phrases, weak for vague-but-real symptoms, distinctive for error codes / identifiers that ' +
        'uniquely locate this problem.',
      criteria: [...JUDGMENT_LEVELS.signalQuality],
    },
    duplicate: {
      type: 'choice',
      instructions:
        'Does this entry look like a duplicate of the candidate entries listed in ' +
        'state.possibleDuplicates? Choose distinct when there is no meaningful overlap, ' +
        'possible_duplicate when it may overlap, likely_duplicate when it clearly describes the ' +
        'same issue as a candidate.',
      criteria: {
        distinct: 'no candidate overlaps this entry',
        possible_duplicate: 'may overlap a candidate — worth checking before trusting it',
        likely_duplicate: 'clearly the same issue as one of the candidates',
      },
    },
    intentSuggestion: {
      type: 'choice',
      instructions:
        'Which intent label fits this entry best? Choose keep when the CURRENT intent is already ' +
        'right; otherwise choose the intent that fits better (pitfall = warns about a wrong ' +
        'approach, repair = a symptom to fix, howto = a correct procedure, optimize = an ' +
        'improvement on something working, decision = a recorded trade-off).',
      criteria: {
        keep: 'current intent is fine',
        pitfall: 'warns about a wrong approach',
        repair: 'a symptom to fix',
        howto: 'a correct procedure',
        optimize: 'an improvement on something working',
        decision: 'a recorded trade-off',
      },
    },
    domainSuggestion: {
      type: 'choice',
      instructions:
        'Which domain tag fits this entry best? Choose keep when the CURRENT domains are already ' +
        'right, none_fits when no existing tag applies (this is actionable for vocabulary ' +
        'maintenance), otherwise choose one of the existing tags.',
      criteria: {
        keep: 'current domain tags are fine',
        none_fits: 'no existing tag applies to this entry',
        ...Object.fromEntries(availableDomains.map((d) => [d, `existing tag: ${d}`])),
      },
    },
    // 第 7 维（v1.82.0 / rubric v2）：**准入导向**——"换个项目还成立吗"。
    // 挂在末尾而非插进中段：既有六维在 prompt 里的相对顺序与文本保持逐字不变，
    // 校准数据的纵向可比性因此不受影响（增维可以，改维不行，见文件头不变量）。
    // ⚠️ observe-only：本维只产建议文本，不触发任何拒绝/改写（文件头不变量）。
    admissionSuggestion: {
      type: 'choice',
      instructions:
        'Should this entry be admitted to a CROSS-PROJECT experience base? Judge by one ' +
        'criterion: would this note still help someone working in a DIFFERENT project? Choose ' +
        'reject for low-value notes: project-specific operational details (deploy scripts, repo ' +
        'policies, team conventions), one-off environment fixes tied to a single machine, ' +
        'unverifiable claims, or notes with no actionable content. Choose needs_human when ' +
        'borderline (thin evidence, unclear transferability). Choose admit when the lesson ' +
        'clearly transfers.',
      criteria: { ...ADMISSION_CRITERIA },
    },
  };
}

/**
 * 组装 `state`（判定输入的数据位；注入面防护见文件头不变量）。
 *
 * @param input 条目内容 + 当次词表快照
 * @returns state 对象（含节选与截断标记）
 */
export function buildJudgmentState(input: ExperienceCheckInput): Record<string, unknown> {
  const excerpt = buildContentExcerpt(input.content);
  return {
    title: input.title,
    summary: input.summary,
    content: excerpt.content,
    /** 训练脚本据此知道 content 不是全文（见 §4 语料纪律） */
    contentTruncated: excerpt.contentTruncated,
    contentLength: excerpt.contentLength,
    signals: input.signals,
    domains: input.domains,
    env: input.env,
    intent: input.intent,
    // state 的键名与 rubric 的 instructions 对齐（instructions 里写的是 state.possibleDuplicates）
    possibleDuplicates: input.duplicateCandidates.slice(0, 3),
    availableDomains: input.availableDomains,
  };
}

/** `Number.isFinite` 校验 + clamp 到 [0,1]；非法 → null（该维度判为非法） */
function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * score 类维度取档位：**legend[argmax(probabilities)]**（见文件头踩坑）。
 *
 * @param entry jev 答案对象
 * @param whitelist 该维度的档位白名单
 * @returns 合法档位或 null（概率缺失/legend 缺失/档位不在白名单）
 */
function pickScoreLevel(
  entry: Record<string, unknown>,
  whitelist: readonly string[],
): string | null {
  const legend = entry.legend;
  const probabilities = entry.probabilities;
  if (typeof legend !== 'object' || legend === null) return null;
  if (typeof probabilities !== 'object' || probabilities === null) return null;

  let bestKey: string | null = null;
  let bestValue = -Infinity;
  for (const [key, raw] of Object.entries(probabilities as Record<string, unknown>)) {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : -Infinity;
    if (value > bestValue) {
      bestValue = value;
      bestKey = key;
    }
  }
  if (bestKey === null) return null;

  const label = (legend as Record<string, unknown>)[bestKey];
  return typeof label === 'string' && whitelist.includes(label) ? label : null;
}

/** 归一化一个 score 维度（档位 + confidence 都合法才产出，否则 null） */
function normalizeScoreDim(
  raw: unknown,
  whitelist: readonly string[],
): { level: string; confidence: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const level = pickScoreLevel(entry, whitelist);
  const confidence = clampConfidence(entry.confidence);
  if (level === null || confidence === null) return null;
  return { level, confidence };
}

/**
 * jev answers → 七维归一化（逐字段白名单；见文件头不变量）。
 *
 * @param answers jev 返回的 `answers` 字段（未知形状）
 * @param availableDomains 当次词表快照（domainSuggestion 的白名单来源）
 * @returns 七维结果；**整体形状破损返回 null**（调用点据此走 status=error 且不落快照）
 */
export function normalizeJevAnswers(
  answers: unknown,
  availableDomains: string[],
): ExperienceJudgmentDims | null {
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
  const a = answers as Record<string, unknown>;

  const completeness = normalizeScoreDim(a.completeness, JUDGMENT_LEVELS.completeness);
  const reusability = normalizeScoreDim(a.reusability, JUDGMENT_LEVELS.reusability);
  const signalQuality = normalizeScoreDim(a.signalQuality, JUDGMENT_LEVELS.signalQuality);

  const duplicate = ((): ExperienceJudgmentDims['duplicate'] => {
    const raw = a.duplicate;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const choice = entry.choice;
    const confidence = clampConfidence(entry.confidence);
    if (typeof choice !== 'string' || !JUDGMENT_LEVELS.duplicate.includes(choice as never))
      return null;
    if (confidence === null) return null;
    return {
      verdict: choice as 'distinct' | 'possible_duplicate' | 'likely_duplicate',
      confidence,
    };
  })();

  const intentSuggestion = ((): ExperienceJudgmentDims['intentSuggestion'] => {
    const raw = a.intentSuggestion;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const choice = entry.choice;
    const confidence = clampConfidence(entry.confidence);
    if (typeof choice !== 'string' || !INTENT_CHOICES.includes(choice)) return null;
    if (confidence === null) return null;
    return choice === 'keep'
      ? { verdict: 'keep', value: null, confidence }
      : { verdict: 'suggested', value: choice as ExperienceIntent, confidence };
  })();

  const domainSuggestion = ((): ExperienceJudgmentDims['domainSuggestion'] => {
    const raw = a.domainSuggestion;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const choice = entry.choice;
    const confidence = clampConfidence(entry.confidence);
    if (typeof choice !== 'string' || confidence === null) return null;
    if ((DOMAIN_NON_VALUE_CHOICES as readonly string[]).includes(choice)) {
      return choice === 'keep'
        ? { verdict: 'keep', value: null, confidence }
        : { verdict: 'none_fits', value: null, confidence };
    }
    // 其余取值必须在**当次词表快照**内（否则模型编了一个不存在的领域 → 该维度非法）
    if (!availableDomains.includes(choice)) return null;
    return { verdict: 'suggested', value: choice, confidence };
  })();

  // 第 7 维（准入建议）：与 duplicate 同构的 choice 白名单 + confidence clamp。
  // 词表外取值（模型自造结论）或 confidence 非法 ⇒ 本维 null，**不猜、不放过**。
  const admissionSuggestion = ((): ExperienceJudgmentDims['admissionSuggestion'] => {
    const raw = a.admissionSuggestion;
    if (typeof raw !== 'object' || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const choice = entry.choice;
    const confidence = clampConfidence(entry.confidence);
    if (typeof choice !== 'string' || confidence === null) return null;
    if (!(ADMISSION_CHOICES as readonly string[]).includes(choice)) return null;
    return { verdict: choice as (typeof ADMISSION_CHOICES)[number], confidence };
  })();

  const dims: ExperienceJudgmentDims = {
    completeness: completeness as ExperienceJudgmentDims['completeness'],
    reusability: reusability as ExperienceJudgmentDims['reusability'],
    signalQuality: signalQuality as ExperienceJudgmentDims['signalQuality'],
    duplicate,
    intentSuggestion,
    domainSuggestion,
    admissionSuggestion,
  };

  // **全部维度**全空 ⇒ 视为整体形状破损（jev 换了协议/响应被改写），宁可不落快照
  // （`Object.values` 天然覆盖新增维度——增维时此处无需改动，勿改成逐维枚举）
  const allNull = Object.values(dims).every((dim) => dim === null);
  return allNull ? null : dims;
}

/** 模型标识限长（`experience_judgments.model` 列宽 varchar(64)） */
export const JUDGMENT_MODEL_MAX_LENGTH = 64;

/**
 * 从 jev 内层响应取模型标识（自报值；非字符串或空 → `'unknown'`；限长 64）。
 *
 * rationale：`model` 是**观测字段**（"这批评语是哪个模型打的"），不是判定输入——即使它
 * 被上游改写也不该让整次判定失败，故做保守兜底而不是报错。
 */
export function extractJudgmentModel(inner: Record<string, unknown>): string {
  const raw = inner.model;
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown';
  return raw.trim().slice(0, JUDGMENT_MODEL_MAX_LENGTH);
}
