/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - security 族（**新族**，v1.94.0-dev）hint 的**文案与元数据单源**：单码
 *     `sensitive_credential_suspected`（域侧写路径的凭证扫描命中）的机器码、文案、
 *     族、产出面、内核 profile 全在这里；provider 只做映射与构造。
 *   - 形态 = 写响应载荷的**运行期附挂** hints（响应 DTO **不声明** hints 键，形状与
 *     `DocHint` 同构）——与 memory / task 两族同款先例。
 *
 * [代码职责]
 *   - `SECURITY_HINT` / `SECURITY_HINT_CODES` / `SecurityHintCode`：机器码（与
 *     `hint-registry.ts` 的 `SECURITY_HINT_DEFINITIONS` 同源，由本文件的守卫 spec 双向守卫
 *     ——注册表侧是**字面量内联**，因为它不能 import 领域模块；本文件是 `modules/hints/`
 *     内部文件，方向天然合规）。
 *   - `SECURITY_HINT_MESSAGES`：code → **模板**（含 `{labels}`；**禁在 provider 手写字面量**）。
 *   - `renderSecurityHintMessage`：**与模板同居**的渲染 helper（薄包装；安全语义单源 =
 *     `hint-template.ts` 的 `renderHintTemplate`）。
 *   - `SECURITY_HINT_SURFACE`：埋点 `surface` 值（新产出面 `credential_scan`）。
 *   - `SECURITY_HINT_PROFILE`：交给 `hint-emit.emitHints` 的领域侧配置（内核不认识任何 code）。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.6（凭证扫描挂点与判据）与 §5（告警埋点、
 *     消费方与 FP 观测口径）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关键不变量]
 *   - **文案只说「发现了什么 + 下一步做什么」**：不承诺结果、不描述内部实现；结构化信息走
 *     `data`，消费方**不解析 message**（与 docspace / task 同款形态纪律）。
 *   - **文案必须自带误报出口**（扫描器的 known-FP 已登记接受）：占位 DSN / 官方示例 key /
 *     长 slug 都会命中——文案里的「若是文档示例/占位符……忽略本提示即可」是**产品的一部分**，
 *     删掉它等于把已接受的误报变成纯噪音。
 *   - **`{labels}` 只能由 `renderSecurityHintMessage` 渲染**：缺键 → 空串兜底，**不泄
 *     `undefined` / 残留 `{`**（守卫 spec 双向断言）。
 *   - **禁正文入 data / 文案**：`data.resourceId` / `data.resourceKind` 是机器 id 与类型名，
 *     `matchedPatterns` 是模式 label——**用户正文永远不出现**（正文连告警行都不进，见
 *     `credential-scan.ts`）。
 *   - **改码名 = 观测断裂**：code 是稳定标识（日志按 code 聚合）；改名同步
 *     `hint-registry.ts` + 本文件 + 守卫 spec。
 *
 * [关联代码]
 *   - ./security-hint.provider.ts — 唯一生产消费者（事实 → 候选；label 解析）
 *   - ./credential-scan.ts — 事实的产生点（扫描 + 告警）
 *   - ../../common/utils/sensitive-patterns.ts — 模式表（label 的真源）
 *   - ./hint-registry.ts — `SECURITY_HINT_DEFINITIONS`（元数据登记，字面量内联）
 *   - ./hint-template.ts — 占位符渲染的安全语义单源
 *   - ../../config/app-hint-provider-chain.ts — provider 装配单源（kill switch 键 `security_scan`）
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计) #25(类型前置)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增/改码 ⇒ 本文件四件套（码表 / 模板 / 产出面 / profile）+ 注册表 + 守卫 spec 齐步
 *   □ 改模板占位符 ⇒ 同步 provider 的填充键与守卫 spec 的「占位符齐全」断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { HintCandidate } from './hint-core';
import type { HintEmitProfile } from './hint-emit';
import { hintTtlOf } from './hint-registry';
import { renderHintTemplate } from './hint-template';

/**
 * security 族机器码（命名 = 领域前缀 + snake_case；**稳定标识，禁改名**）。
 */
export const SECURITY_HINT = {
  /** 写入的文本里疑似含敏感凭证（扫描命中；告警与提示解耦，见 credential-scan.ts） */
  SENSITIVE_CREDENTIAL_SUSPECTED: 'sensitive_credential_suspected',
} as const;

/** 码值联合（派生——不手写第二份字面量） */
export type SecurityHintCode = (typeof SECURITY_HINT)[keyof typeof SECURITY_HINT];

/** 全部码（数组序 = 注册表同源守卫的比较基准） */
export const SECURITY_HINT_CODES: readonly SecurityHintCode[] = Object.values(SECURITY_HINT);

/** 埋点产出面（开放词表值；注册表 `ownerSurface` 同值） */
export const SECURITY_HINT_SURFACE = 'credential_scan';

/** 本族模板的占位符契约（守卫 spec 断言模板与 provider 填充键一致） */
export const SECURITY_HINT_PLACEHOLDERS = ['labels'] as const;

/**
 * code → 文案**模板**（单源，禁在 provider 里手写）。
 *
 * `{labels}` = 命中模式的短名（逗号拼接），由 provider 从 `sensitive-patterns.ts` 解析后
 * 经 {@link renderSecurityHintMessage} 渲染。
 */
export const SECURITY_HINT_MESSAGES: Record<SecurityHintCode, string> = {
  [SECURITY_HINT.SENSITIVE_CREDENTIAL_SUSPECTED]:
    '检测到疑似敏感凭证（{labels}）。若是误贴：请立即轮换该凭证并通知归属者/运维——' +
    '删除不等于消除泄露（doc 有版本历史/消息不可编辑），轮换才是根治；平台自有 agent key' +
    '（ask_ 前缀）由人类管理员经 POST /agents/:id/reset-key 轮换。若是文档示例/占位符而非' +
    '真实凭证，忽略本提示即可。',
};

/**
 * **与模板同居**的渲染 helper（安全语义单源 = `hint-template.ts`）。
 *
 * @param code 本族码（未登记的码在类型层不可能传入）
 * @param data 结构化取值（缺省 → 占位符全部落空串）
 * @returns 渲染后的文案（永不抛）
 */
export function renderSecurityHintMessage(
  code: SecurityHintCode,
  data?: Record<string, unknown>,
): string {
  return renderHintTemplate(SECURITY_HINT_MESSAGES[code], data);
}

/**
 * security 族给通用内核的**领域侧配置**（与 docspace `DOC_HINT_PROFILE` / task 同款角色）。
 *
 * `familyOf` 恒 `'security'`（注册表 `family` 同值，守卫钉）；`ttlOf` 委托注册表查表的
 * **纯函数入口**（`hintTtlOf` = `HintRegistry.ttlOf` 委托的同一份实现——窗口长度单源）。
 */
export const SECURITY_HINT_PROFILE: HintEmitProfile<SecurityHintCode> = {
  resolveMessage: (candidate: HintCandidate<SecurityHintCode>) =>
    candidate.message ?? renderSecurityHintMessage(candidate.code, candidate.data),
  familyOf: () => 'security',
  ttlOf: (code) => hintTtlOf(code),
};
