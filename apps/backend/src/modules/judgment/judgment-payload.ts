/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别日志载荷的**体积与脱敏纪律**（内核级，所有能力共用）：落库前一律
 *     "先 redaction、再体积硬顶"，且两者都**不静默**（超限带 `truncated` 标记、
 *     命中带 redacted 标记）
 *
 * [代码职责]
 *   - `redactJudgmentPayload`：内核 redaction 基线（两表并集：长形态在前 + 前缀兜底）
 *   - `capJsonbPayload` / `truncateUtf8`：16KB 硬顶 + **字节安全**截断（CJK 场景必须）
 *   - `countReturnedRows` / `safeErrorTag` / `judgmentActorKey`：落库与告警的分类原语
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判断日志/训练语料章
 *     （`stateRedacted` 行纪律、节选标记、"日志是正文第二副本"威胁面）
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（redaction 基线 =
 *     两表并集，顺序照经验库现状；新标记名 `logRedacted`，经验库 `stateRedacted` 不动）
 *
 * [关键不变量]
 *   - **redaction 基线 = 两表并集且顺序有语义**：`JUDGMENT_REDACTION_PATTERNS`（长形态，
 *     **消费整个值**）在前，`EXPERIENCE_SECRET_PATTERNS`（**前缀命中**语义，只吃两字符就够）
 *     兜底。颠倒或不跑基线 ⇒ 半掩码（实测 `/ask_[A-Za-z0-9]/` 作用在 `ask_deadbeef` 上
 *     得到 `[redacted]eadbeef`，9 字符密钥留了 7 个）。
 *   - **基线不可被清空**：能力的 `redactionPatterns` 只做**追加**（内核基线恒跑）。
 *   - **标记名按能力域分叉**：内核通用路径标 `logRedacted`；经验库沿用 `stateRedacted`
 *     （既有训练/导出纪律按该键读行，改名 = 静默把"已脱敏行"读成"未脱敏行"）。
 *     同一含义两个名字是**刻意的**，文档并排写明差异。
 *   - **超限截断标记不可被截断吞掉**：标记原本在 payload 根上，会被 `json` 片段替换掉，
 *     故显式搬进信封（`capJsonbPayload` 内实现）。
 *   - **截断必须按字节**：`String.prototype.slice` 按**字符**计数，CJK 载荷 3 字节/字符——
 *     24056B 的载荷 `slice(0, 16384)` 仍留下 ~49KB，上限形同虚设（实测）。
 *   - **`countReturnedRows` 不依赖 `affected` 落位**：`manager.query()` 对 UPDATE 返回
 *     `[rows, affected]` 而形状随驱动/语句变化 ⇒ 统一用 `RETURNING id` + 数返回行数。
 *   - **`safeErrorTag` 只出类名 + 可选错误码，绝不出 message**：message 可能夹 SQL 片段、
 *     参数取值或上游错误体原文。
 *
 * [关联代码]
 *   - ../../common/utils/redaction-patterns.ts — `JUDGMENT_REDACTION_PATTERNS` 常量单源
 *     （2026-09-26 批次 1-b 自本文件上移；本文件 import 后再导出，调用面零破坏）
 *   - ../../modules/experience/experience.constants.ts — `EXPERIENCE_SECRET_PATTERNS`
 *     （兜底表；它是录入闸门 400 文案的 `matched pattern #N` 单源，**位置敏感，勿搬**）
 *   - modules/experience/experience-judgment.service.ts — 经验库侧消费（`stateRedacted` 标记）
 *   - judgment-runner.service.ts — 通用侧消费（`logRedacted` 标记）
 *   - database/entities/experience-judgment-record.entity.ts — 载荷列契约（16KB / NOT NULL）
 *
 * [持久踩坑]
 *   JUDGMENT-ROWCOUNT-SHAPE(raw 形状): `manager.query()` 的 UPDATE 返回形状随驱动/语句变化
 *     （经验库 service 文件头三条实证）。安全方向: `RETURNING id` + 数返回行数。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改 redaction 表前先确认"长形态在前 + 前缀兜底"的顺序仍成立（有单测钉半掩码）
 *   □ 改体积硬顶必须同步 entity 注释与 `EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES`
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { EXPERIENCE_SECRET_PATTERNS } from '../experience/experience.constants';
import { EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES } from '../experience/experience.constants';
import type { UnifiedActor } from '../../common/types/actor.types';
import { JUDGMENT_REDACTION_PATTERNS } from '../../common/utils/redaction-patterns';

/**
 * 再导出（2026-09-26 批次 1-b 脱敏族上移）：常量单源已物理迁至
 * `common/utils/redaction-patterns.ts`（零命中检索日志也需要同一份脱敏族），
 * 本文件保持既有调用面（spec 与基线组合处）零改动。注释单源随常量一并迁走。
 */
export { JUDGMENT_REDACTION_PATTERNS };

/**
 * redaction 基线（两表并集；**顺序即语义**，见文件头不变量）。
 *
 * 导出为只读数组：调用点（经验库 / 通用 runner）与单测共用**同一个**基线，
 * 禁止在两处各拼一次（拼错的症状是半掩码，且只在真实 key 上才看得出来）。
 */
export const JUDGMENT_REDACTION_BASELINE: readonly RegExp[] = [
  ...JUDGMENT_REDACTION_PATTERNS,
  ...EXPERIENCE_SECRET_PATTERNS,
];

/** redaction 结果：掩码后的对象 + 是否命中（标记名由调用方按能力域决定，见文件头不变量） */
export interface JudgmentRedactionResult {
  payload: Record<string, unknown>;
  /** true = 至少命中一处（调用方据此写 `logRedacted` / `stateRedacted`） */
  redacted: boolean;
}

/**
 * 落库前 redaction（密钥闸门的**纵深防御**）。
 *
 * 扫描对象里所有字符串（含数组元素与 env 值）：先用"消费整个值"的
 * `JUDGMENT_REDACTION_PATTERNS` 掩码，再用闸门正则兜一遍（防"只有标记没有值"的形态）。
 *
 * ⚠️ **不在本函数里打标记**：标记名是能力域的契约（内核 `logRedacted` / 经验库
 * `stateRedacted`），内核不替调用方决定（见文件头不变量）。
 *
 * @param payload 日志载荷（任意嵌套对象）
 * @param extraPatterns 能力追加的模式（可空；**只追加，基线恒跑**）
 * @returns 掩码后的新对象（原对象不被修改）+ 命中标记
 */
export function redactJudgmentPayload(
  payload: Record<string, unknown>,
  extraPatterns: readonly RegExp[] = [],
): JudgmentRedactionResult {
  let hit = false;
  const patterns = [...JUDGMENT_REDACTION_BASELINE, ...extraPatterns];

  const redactString = (value: string): string => {
    let out = value;
    // 先消费整值的掩码模式，再用闸门正则兜底（顺序有语义：前者吃得多；**长形态勿当冗余删**）
    for (const pattern of patterns) {
      // 统一走全局 replace（不用 test：带 g 的正则有 lastIndex 状态，test 会吃字符）
      const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
      const before = out;
      out = out.replace(global, '[redacted]');
      if (out !== before) hit = true;
    }
    return out;
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  return { payload: walk(payload) as Record<string, unknown>, redacted: hit };
}

/**
 * jsonb 载荷体积硬顶（超限 ⇒ 截断 + `truncated:true`，**不静默**）。
 *
 * @param payload 待落库对象
 * @param maxBytes 上限（字节；按 JSON 字符串的 UTF-8 长度计）
 * @returns 原对象（未超限）或 `{truncated:true, json:<片段>}`（超限）
 */
export function capJsonbPayload(
  payload: Record<string, unknown>,
  maxBytes: number = EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES,
): Record<string, unknown> {
  const serialized = JSON.stringify(payload ?? {});
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) return payload;

  const logRedacted = payload?.logRedacted === true;
  const stateRedacted = payload?.stateRedacted === true;
  const build = (json: string): Record<string, unknown> => ({
    truncated: true,
    originalBytes: bytes,
    json,
    // ⚠️ 标记**不能被截断吞掉**：训练/导出纪律要求"redacted 行必须可被识别"，
    // 而它原本在 payload 根上、会被 json 片段替换掉 ⇒ 这里显式搬进信封
    ...(logRedacted ? { logRedacted: true } : {}),
    ...(stateRedacted ? { stateRedacted: true } : {}),
  });

  // 先按"空 json 字段"量出信封开销，再按预算切载荷；随后用实际序列化长度**收敛**
  // （JSON 对 `"`/`\` 的转义会让字段贡献大于裸串字节数），最多 8 轮、每轮降 10%。
  const overhead = Buffer.byteLength(JSON.stringify(build('')), 'utf8');
  let budget = Math.max(0, maxBytes - overhead);
  let envelope = build(truncateUtf8(serialized, budget));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= maxBytes) break;
    budget = Math.floor(budget * 0.9);
    envelope = build(truncateUtf8(serialized, budget));
    if (budget === 0) break;
  }
  return envelope;
}

/**
 * 按**字节**安全截断（不切在多字节字符中间）。
 *
 * 为什么不能用 `String.prototype.slice`（实测）：`slice` 按**字符**计数，CJK 载荷
 * 3 字节/字符——24056B 的载荷 `slice(0, 16384)` 仍留下 ~49KB，上限形同虚设。
 *
 * @param text 原串
 * @param maxBytes 字节上限
 * @returns 截断后的合法 UTF-8 前缀（回退到字符边界，绝不产生替换字符）
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 续字节形如 10xxxxxx：向前回退到首字节
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 数 `RETURNING id` 的返回行数（**不依赖 `affected` 落位**，见文件头踩坑）。
 *
 * 兼容两种 driver 返回形状：`[[rows], affected]` 与 `rows`。
 */
export function countReturnedRows(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  const [first, second] = raw as [unknown, unknown];
  if (Array.isArray(first) && typeof second === 'number') return first.length;
  return raw.length;
}

/**
 * 额度桶键（`type:id`）；**无 actor 时用兜底桶 `system:unknown`**。
 *
 * 为什么不能返回 null 跳过限流：null actor 的调用（内部任务/系统触发）同样会打模型与写日志，
 * "不静默不限流"是这条兜底的全部意义（否则它成了绕过限流的免费通道）。
 */
export function judgmentActorKey(actor: UnifiedActor | null): string {
  return actor?.id ? `${actor.type}:${actor.id}` : 'system:unknown';
}

/**
 * 异常的分类标签（**只出类名 + 可选错误码，绝不出 message**）。
 *
 * message 可能含 SQL 片段、参数取值或上游错误体原文——与"错误原文不进日志"同一条纪律。
 */
export function safeErrorTag(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  const code = (err as { code?: unknown })?.code;
  const nameText = typeof name === 'string' && name ? name : 'Error';
  return typeof code === 'string' || typeof code === 'number' ? `${nameText}/${code}` : nameText;
}
