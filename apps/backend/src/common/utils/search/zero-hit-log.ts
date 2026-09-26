/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 四路检索（doc / task / experience / message）**零命中可观测**的结构化日志
 *     单源：截断 + 控制符剥离 + 密钥脱敏 + JSONL 落行（检索中文根治计划 v1.5 §2.6）
 *
 * [代码职责]
 *   - `truncateForLog`：q 截 50 码点 + 剥 `\r\n` / U+0000 / U+2028 / U+2029 / U+0085
 *     （JSONL 单行纪律：行分隔符与控制符会把一条日志劈成多行或击穿日志管道）
 *   - `redactForLog`：`JUDGMENT_REDACTION_PATTERNS`（吃整个值族）掩码——q 是用户
 *     输入，可能粘着 API key；落盘前必须过脱敏
 *   - `buildZeroHitLogLine` / `logSearchZeroHit`：结构化对象一律经 `JSON.stringify`
 *     生成（**禁模板拼接**——拼接会让 q 里的引号/换行击穿 JSON 结构）
 *
 * [权威文档]
 *   - 主文档: 检索中文根治计划终稿 v1.5 §2.6（零命中引导与可观测）
 *   - 补充: 线上 DocSpace `docs/experience-base.md` — 脱敏纪律（同一脱敏族）
 *
 * [关键不变量]
 *   - **日志行只允许一个 JSON 对象**：`buildZeroHitLogLine` 是唯一产线函数，消费方
 *     不得自行拼串；新增字段加进 `ZeroHitLogInput`（标量），**绝不内嵌 q 原文**
 *     （q 只经 truncateForLog + redactForLog 通道出现一次）。
 *   - **脱敏族 = `JUDGMENT_REDACTION_PATTERNS`**（common/utils/redaction-patterns.ts，
 *     吃整个值语义）；`EXPERIENCE_SECRET_PATTERNS` 是"命中即 400"的闸门表，不可混用。
 *   - **jest spy 断言点 = `logSearchZeroHit`**：四消费方零命中分支各调一次；单测
 *     spy 本函数（或 Logger.warn）断言落行，不得在消费方各写一份格式断言。
 *   - **fail-open**：日志失败不得阻断检索（本函数不抛——truncate/redact/stringify
 *     对任意 string 输入全定义；消费方不得在调用点再加 try/catch 包装）。
 *
 * [关联代码]
 *   - common/utils/redaction-patterns.ts — 脱敏族单源
 *   - modules/docspace/doc-search.service.ts / modules/task/task.service.ts /
 *     modules/experience/experience.service.ts / modules/search/search.service.ts
 *     — 四路零命中分支消费方
 *   - zero-hit-log.spec.ts — 截断/剥离/脱敏/JSONL 形态契约单测
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 新增日志字段必须是标量且不含用户输入原文（q 走唯一通道）
 * =============================================================================
 */
import type { Logger } from '@nestjs/common';
import { JUDGMENT_REDACTION_PATTERNS } from '../redaction-patterns';

/** 日志检索锚点 tag（告警/聚合规则按此值过滤；改名 = 观测契约变更） */
export const ZERO_HIT_LOG_TAG = 'SEARCH_ZERO_HIT';

/**
 * q 落盘前的长度上限（码点数）。rationale：50 码点足够辨认查询意图，又不让
 * 日志行被 200 字上限查询撑爆；与编译器 200 硬截断是两层不同预算（检索语义 vs
 * 日志体积）。
 */
export const ZERO_HIT_QUERY_MAX_CHARS = 50;

/**
 * JSONL 单行纪律剥离表：`\r` `\n`（行分隔）、U+0000（PG text 禁存 NUL，日志管道
 * 同样不友好）、U+2028/U+2029（JS 字符串合法行分隔，JSON 里会原样落盘劈行）、
 * U+0085 NEL（C1 行分隔）。计划 §2.6 显式枚举。
 */
const LOG_STRIP_REGEX = /[\r\n\x00\u2028\u2029\u0085]/g;

/**
 * q 的日志形态第一步：剥行分隔/控制符 → 按码点截 50（不拆代理对）。
 * @param rawQuery 原始查询串（任意用户输入，全定义）
 */
export function truncateForLog(rawQuery: string): string {
  const stripped = rawQuery.replace(LOG_STRIP_REGEX, '');
  return [...stripped].slice(0, ZERO_HIT_QUERY_MAX_CHARS).join('');
}

/**
 * q 的日志形态第二步：密钥脱敏（吃整个值族；统一重建全局正则防 lastIndex 状态，
 * judgment-payload.ts 同款先例）。
 * @param text 已截断文本
 * @returns 掩码后文本（命中处替换为 `[redacted]`）
 */
export function redactForLog(text: string): string {
  let out = text;
  for (const pattern of JUDGMENT_REDACTION_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
    out = out.replace(global, '[redacted]');
  }
  return out;
}

/** 四路检索面标识（日志 surface 字段值域） */
export type ZeroHitSurface = 'doc' | 'task' | 'experience' | 'message';

/**
 * 零命中日志输入。`queryTruncated` / `armTruncatedCount` 来自编译产物元数据
 * （200 硬截断 / 64 arm cap 截断计数——超长查询的「检索语义只覆盖前 64 bigram」
 * 必须在零命中分析时可辨认，计划 §1 查询长度上限登记）。
 */
export interface ZeroHitLogInput {
  /** 检索面（doc/task/experience/message） */
  surface: ZeroHitSurface;
  /** 原始查询串（函数内走 truncate+redact 唯一通道） */
  query: string;
  /** 编译期 200 码点硬截断是否发生（可选元数据） */
  queryTruncated?: boolean;
  /** 64 arm cap 截掉的 distinct arm 数（可选元数据，>0 才落行） */
  armTruncatedCount?: number;
}

/**
 * 生成单行 JSONL（**唯一产线函数**）：`JSON.stringify(对象)`，禁模板拼接。
 * @returns 单行 JSON 字符串（不含换行）
 */
export function buildZeroHitLogLine(input: ZeroHitLogInput): string {
  return JSON.stringify({
    tag: ZERO_HIT_LOG_TAG,
    surface: input.surface,
    q: redactForLog(truncateForLog(input.query)),
    ...(input.queryTruncated ? { queryTruncated: true } : {}),
    ...(input.armTruncatedCount ? { armTruncatedCount: input.armTruncatedCount } : {}),
  });
}

/**
 * 零命中落行（warn 级：零命中是可观测信号不是错误，但需要在噪声中可被聚合捞出；
 * jest spy 断言锚点）。四消费方零命中分支各调一次。
 */
export function logSearchZeroHit(logger: Logger, input: ZeroHitLogInput): void {
  logger.warn(buildZeroHitLogLine(input));
}
