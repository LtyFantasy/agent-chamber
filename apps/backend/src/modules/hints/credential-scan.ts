/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - **凭证粘贴扫描的 emit helper**（v1.94.0-dev，卡 349d337e）：域侧写路径在**真实写入
 *     成功后**调一行 `emitCredentialScanFactIfHit(正文, { resourceKind, resourceId, actorId })`，
 *     本文件负责「扫描 →（命中）落 **告警埋点** + 写 **领域事实**」这一步。
 *   - **告警与送达彻底解耦**（设计决定）：告警行在本文件就地落（不走 provider、不走响应
 *     管线、不受 ≤3 预算 / 去重窗口 / provider kill switch 影响）；hint 送达则是事实袋 →
 *     拦截器 provider（`SecurityHintProvider`）的独立链路。二者**各自可单独失效**。
 *
 * [代码职责]
 *   - `emitCredentialScanFactIfHit(text, meta)`：
 *     ① kill switch 检查（`HINT_CREDENTIAL_SCAN_DISABLED==='true'` ⇒ 直接返回）；
 *     ② 模式级过滤（`HINT_CREDENTIAL_PATTERNS_DISABLED` 是逗号分隔的 patternId 黑名单）
 *        → 调 `scanSensitiveContent` 纯扫描器；
 *     ③ 命中 ⇒ 落**告警行**（单 JSON 对象）+ `emitFact('security.credential_suspected', …)`；
 *     ④ 未命中但正文被截断 ⇒ 落一条 debug 行（`truncated` 可观测）。
 *   - **本文件是唯一调用扫描器的地方**：域侧挂点不得直接 import 扫描器（那会让「告警 +
 *     事实」这对动作被拆散，出现「有告警没事实」或反过来的静默缺口）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §5（观察期仪器：告警埋点字段与消费方）与
 *     §7（扫描面的**不覆盖清单**）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关键不变量]
 *   - **正文永不进事实袋 / 日志 / 告警行 / hint data**：告警行只有 resourceKind /
 *     resourceId / actorId / patternIds / truncated 五个标量键；事实载荷只有
 *     `{ resourceKind, resourceId, matchedPatterns }`。**任何一处出现正文 = 越界**（正文是
 *     用户数据，告警行会进 stdout 采集链）。
 *   - **告警行 = 单 JSON 对象 + `JSON.stringify`**（字段钉死、**禁模板拼接**——拼接会让值里的
 *     引号/换行击穿 JSON 结构；与 `hint-log` 的落行纪律同款）。
 *   - **`truncated` 只进告警行，禁进事实载荷**：它是「扫描覆盖度」的观测信号，不是提示内容；
 *     进事实会被 provider 当成结构化输出外流（且语义上它是「我们没看完」，与「命中什么」无关）。
 *   - **两个 kill switch 在模块加载时读取（重启生效）**：与 `HINT_PROVIDERS_DISABLED` 的
 *     boot 语义对齐——运维用 env 关停时，读一次还是读每次的差异会让「关停」在上线后表现得
 *     不一致（且每次调用读 env 会把 env 读取扩散到热路径）。单测经模块重载覆盖。
 *   - **永不抛**：调用点全在业务写路径（doc/task/topic 的真实写入之后）——抛 = 把成功写入
 *     打成 500。扫描器本身也不抛（见其文件头），此处的 try/catch 是**兜住本函数自身**。
 *   - **只在真实写入成功后调用**（调用方职责，逐点登记）：幂等 replay / unchanged /
 *     rechunked / failed 一律**不调**——否则同一份内容被重复计入告警与提示分母。
 *
 * [关联代码]
 *   - common/utils/sensitive-patterns.ts — 检测器（本文件的唯一上游）
 *   - modules/hints/security-hint.constants.ts — 码 / 文案 / 产出面（提示侧单源）
 *   - modules/hints/security-hint.provider.ts — 事实 → hint 候选
 *   - modules/hints/hint-facts.ts — 事实袋（`emitFact` 的唯一实现）
 *   - credential-scan.spec.ts — 双 kill switch / 告警行字段封闭 / 载荷扁平 / 零副作用
 *   - **挂点（11 处，本批分母）**：doc.controller（upsert / patchSection / patchContent /
 *     appendDoc）、doc.service（batchUpsert 逐条状态机）、task.service（create 双返回路径 /
 *     update / patchDescription / addComment）、topic.service（幂等路径 + 无幂等路径）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 * =============================================================================
 */
import { Logger } from '@nestjs/common';
import {
  SENSITIVE_PATTERNS,
  scanSensitiveContent,
  type SensitivePattern,
} from '../../common/utils/sensitive-patterns';
import { emitFact } from './hint-facts';

/** 总开关 env 键（`'true'` ⇒ 停止扫描与告警；**模块加载时读取，重启生效**） */
export const HINT_CREDENTIAL_SCAN_DISABLED_ENV = 'HINT_CREDENTIAL_SCAN_DISABLED';

/** 模式级收敛 env 键（逗号分隔的 patternId 黑名单；**模块加载时读取，重启生效**） */
export const HINT_CREDENTIAL_PATTERNS_DISABLED_ENV = 'HINT_CREDENTIAL_PATTERNS_DISABLED';

/** 告警行 tag（**观测契约**：运维按它 grep stdout 起步；改名 = 采集规则静默失效） */
export const SECURITY_CREDENTIAL_SUSPECTED_TAG = 'SECURITY_CREDENTIAL_SUSPECTED';

/**
 * 截断（未命中但正文超长）的 debug 行 tag。
 *
 * **刻意与告警 tag 不同**：告警行的聚合口径是「命中数」，把「没看完」混进同一个 tag 会让
 * 命中统计虚高（且两者的处置完全不同——前者要看正文，后者只是覆盖度信号）。
 */
export const SECURITY_CREDENTIAL_SCAN_TRUNCATED_TAG = 'SECURITY_CREDENTIAL_SCAN_TRUNCATED';

/** 事实名（本文件 `emitFact` 与 `SecurityHintProvider.factNames` 的同一批字面量） */
export const FACT_SECURITY_CREDENTIAL_SUSPECTED = 'security.credential_suspected';

/**
 * 总开关（**模块加载时读取一次**，重启生效——见文件头不变量）。
 *
 * 为什么不用「每次调用读 env」：① 与 `HINT_PROVIDERS_DISABLED` 的 boot 语义对齐，
 * 运维心智只有一套；② 热路径上不做 env 读取。
 */
const SCAN_DISABLED = process.env[HINT_CREDENTIAL_SCAN_DISABLED_ENV] === 'true';

/** 模式级黑名单（模块加载时解析一次；空集 = 不收敛） */
const DISABLED_PATTERN_IDS: ReadonlySet<string> = parseDisabledPatternIds(
  process.env[HINT_CREDENTIAL_PATTERNS_DISABLED_ENV],
);

/** 本模块的日志源（告警行归属它，与业务 service 的日志源区分） */
const logger = new Logger('CredentialScan');

/**
 * 解析模式级黑名单（**纯函数**，导出以便单测直接覆盖解析语义，无需重载模块）。
 *
 * 语义边界：空串 / 全空白 / 拼错的 id 一律**不影响**扫描（未知 token 忽略——
 * 与 `resolveHintProviderChain` 的 fail-open 同款：多写一个词不该把检测器关掉）。
 *
 * @param env env 原值（`HINT_CREDENTIAL_PATTERNS_DISABLED`）
 */
export function parseDisabledPatternIds(env?: string): ReadonlySet<string> {
  if (!env) return new Set<string>();
  return new Set(
    env
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

/**
 * 生效模式表（模块加载快照 + 模式级黑名单过滤）。
 *
 * 快照在模块加载时算一次：黑名单是 boot 级配置，热路径上重复求和无意义。
 */
const ACTIVE_PATTERNS: readonly SensitivePattern[] =
  DISABLED_PATTERN_IDS.size === 0
    ? SENSITIVE_PATTERNS
    : SENSITIVE_PATTERNS.filter((entry) => !DISABLED_PATTERN_IDS.has(entry.id));

/**
 * 本模块的 kill switch 快照（单测断言用；**生产代码不应依赖它**——业务码只看行为）。
 */
export function credentialScanDisabled(): boolean {
  return SCAN_DISABLED;
}

/** 挂点的资源定位（**只有标量 + 机器 id，禁正文**） */
export interface CredentialScanMeta {
  /** 资源类型（`doc` / `task_description` / `task_comment` / `topic_message`） */
  resourceKind: string;
  /** 资源机器 id（docId / taskId / topicId） */
  resourceId: string;
  /** 触发者 actor id（未认证 / 未知 → 缺省 `null`） */
  actorId?: string | null;
}

/**
 * 扫描写入正文；命中则落告警行 + 写领域事实（见文件头不变量）。
 *
 * @param text 本次**写入的新文本**（`patch content` / `patchDescription` 场景必须传
 *   **`newString`**——删除凭证片段不该报警）。`null`/`undefined`/空串 → 直接返回
 *   （调用点无需判空：`dto.description` 这类可选字段可直接透传）
 * @param meta 资源定位（标量 + 机器 id）
 * @returns 无（**永不抛**；调用方不检查返回值——本函数是旁路观测）
 */
export function emitCredentialScanFactIfHit(
  text: string | null | undefined,
  meta: CredentialScanMeta,
): void {
  if (SCAN_DISABLED) return;
  try {
    const { ids, truncated } = scanSensitiveContent(text ?? '', ACTIVE_PATTERNS);

    if (ids.length > 0) {
      // ① 告警行：**单 JSON 对象**、字段钉死、**禁正文**（见文件头不变量）
      logger.warn(
        JSON.stringify({
          tag: SECURITY_CREDENTIAL_SUSPECTED_TAG,
          ts: new Date().toISOString(),
          resourceKind: meta.resourceKind,
          resourceId: meta.resourceId,
          actorId: meta.actorId ?? null,
          patternIds: ids,
          truncated,
        }),
      );
      // ② 领域事实：载荷**恒三键**（扁平标量；`matchedPatterns` 是逗号拼接的单字符串——
      // 事实袋载荷约定扁平，数组会变成共享引用，见 hint-facts 的 HintFact 注释）
      emitFact(FACT_SECURITY_CREDENTIAL_SUSPECTED, {
        resourceKind: meta.resourceKind,
        resourceId: meta.resourceId,
        matchedPatterns: ids,
      });
      return;
    }

    if (truncated) {
      // 未命中但没看完 → 覆盖度信号（**独立 tag**，见其注释；同样**无正文**）
      logger.debug(
        JSON.stringify({
          tag: SECURITY_CREDENTIAL_SCAN_TRUNCATED_TAG,
          ts: new Date().toISOString(),
          resourceKind: meta.resourceKind,
          resourceId: meta.resourceId,
          actorId: meta.actorId ?? null,
          contentLength: text?.length ?? 0,
        }),
      );
    }
  } catch (error) {
    // 旁路观测**绝不打断业务写入**：这里只兜本函数自身的意外（扫描器与 emitFact 各自不抛）。
    // 日志只落错误摘要（**禁正文**）。
    logger.debug(
      `[CREDENTIAL_SCAN_FAILED] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
