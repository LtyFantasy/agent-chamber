/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 「消费整个值」脱敏正则族（redaction 长形态表）的**共享单源**——原定义于
 *     modules/judgment/judgment-payload.ts，2026-09-26 检索中文根治批次 1-b 上移到
 *     common/utils，供判别载荷脱敏与零命中检索日志脱敏两处共用（计划 v1.5 §2.6
 *     security ④「脱敏族上移 common/utils」）
 *
 * [代码职责]
 *   - 导出 `JUDGMENT_REDACTION_PATTERNS`：吃**整个**密钥值的掩码正则表
 *     （与"前缀命中即 400"的闸门表 `EXPERIENCE_SECRET_PATTERNS` 刻意分开，勿混用）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判断日志/训练语料章（脱敏纪律）
 *   - 补充: 检索中文根治计划终稿 v1.5 §2.6（零命中日志脱敏族引用口径）
 *
 * [关键不变量]
 *   - **本表是"消费整个值"语义**：掩码必须吃掉整个密钥，否则留下半掩码
 *     （实测 `/ask_[A-Za-z0-9]/` 作用在 `ask_deadbeef` 上得到 `[redacted]eadbeef`，
 *     9 字符密钥留了 7 个）。前缀命中表（experience.constants.ts `EXPERIENCE_SECRET_PATTERNS`）
 *     是"命中即 400"的闸门语义，只吃两字符就够——**两表语义不同，不可混用、不可互删**
 *     （同一凭证族在两张表里各有一条不是冗余：本表长形态在前、闸门票据短形态兜底，
 *     删掉长形态兜底只剩短形态 = 半掩码回归）。
 *   - **PEM 私钥块整块掩码**（头到 `END ... PRIVATE KEY` 或串尾）：只掩头会留下
 *     base64 私钥体。
 *   - **正则不保证带 g 标志**：消费方统一重建全局正则再 replace（judgment-payload
 *     的 `new RegExp(source, flags + 'g')` 先例——带 g 的正则有 lastIndex 状态，
 *     直接复用会吃字符）。
 *
 * [关联代码]
 *   - modules/judgment/judgment-payload.ts — 判别载荷脱敏（import 本表并再导出，
 *     与 `EXPERIENCE_SECRET_PATTERNS` 组成两表并集基线，顺序有语义：长形态在前）
 *   - common/utils/search/zero-hit-log.ts — 零命中检索日志的 q 脱敏消费方
 *   - modules/experience/experience.constants.ts — `EXPERIENCE_SECRET_PATTERNS`
 *     （兜底表；录入闸门 400 文案的 `matched pattern #N` 单源，**位置敏感，勿搬**）
 *
 * [铁律关联] #11(注释强制) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 改本表前先确认「长形态在前 + 前缀兜底」的顺序仍成立（judgment-payload.spec
 *     有半掩码钉住单测）
 * =============================================================================
 */

/**
 * redaction 专用模式（**消费整个值**，与"闸门命中"的前缀正则刻意分开）。
 *
 * 为什么要分开：闸门正则（`EXPERIENCE_SECRET_PATTERNS`）是**前缀命中**语义——它只需要
 * 判断"这段文本里有密钥"，命中即 400 拒绝，故 `/ask_[A-Za-z0-9]/` 只吃两个字符就够。
 * 但**掩码**必须吃掉整个值，否则会漏下大半（见文件头 [关键不变量] 的半掩码实测）。
 *
 * PEM 私钥块整块掩码（头到 `END ... PRIVATE KEY` 或串尾）：只掩头会留下 base64 私钥体。
 *
 * ⚠️ **同一凭证族在两张表里各有一条不是冗余，勿当"重复"删**（如 `apikey_`）：本表是
 * "**消费整个值**"，闸门表是"**前缀命中**"。两张表串联跑（本表在前、闸门表兜底）——
 * 若删掉本表的长形态，兜底就只剩短形态，会留下 `[redacted]eadbeef` 式的半掩码。
 */
export const JUDGMENT_REDACTION_PATTERNS: readonly RegExp[] = [
  /ask_[A-Za-z0-9_-]+/g,
  // TypeSafe 官方云 key 族（与 ask_ 同规：吃整个值，含官方 key 可能出现的 `-` 等字符）
  /apikey_[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /(?:-{2,5}\s*)?BEGIN(?:\s+[A-Z0-9-]+){0,3}\s+PRIVATE KEY[\s\S]*?(?:END(?:\s+[A-Z0-9-]+){0,3}\s+PRIVATE KEY[^\n]*|$)/g,
  /password\s*=\s*\S+/gi,
  /age-secret-key-\S+/gi,
  /putty-user-key-file:\s*\S+/gi,
];
