/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台**敏感凭证检测器**（v1.94.0-dev，卡 349d337e）：扫描**用户写入的文本**
 *     （doc 正文 / 任务描述 / 评论 / 话题消息），回答一个问题——「这段文本里有没有
 *     **疑似真实凭证**的形态」。
 *   - 它是**检测器**（前缀命中 + **不脱敏**），与仓库里另外两张表**语义不同、不冗余**：
 *     ① `common/utils/redaction-patterns.ts` 的 `JUDGMENT_REDACTION_PATTERNS` =
 *        「**消费整个值**」（掩码吃值，供判别载荷/日志脱敏）；
 *     ② `modules/experience/experience.constants.ts` 的 `EXPERIENCE_SECRET_PATTERNS` =
 *        「**命中即 400**」（写入闸门，只需前缀形态）。
 *     本表两者都不是：它只**报告命中**（不脱敏、不拒写），供 hint + 告警埋点使用。
 *     **三表并存不是冗余——勿以「重复」为由合并**（合并会把脱敏/闸门语义带进来）。
 *
 * [代码职责]
 *   - `SENSITIVE_PATTERNS`：首发 9 条的登记表（`{ id, label, pattern }`；label 是给
 *     用户看的短名，进 hint 的 `{labels}` 占位符）。
 *   - `scanSensitiveContent(text, patterns?)`：**纯函数**——零 IO、零 env、零依赖、
 *     永不抛；返回命中的 patternId 串（逗号拼接）与截断标记。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/modules/hint-system.md §4.6 / §5（凭证扫描的触发面、告警埋点、FP 观测口径）
 *   - 补充: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关键不变量]
 *   - **量词与字符类必须有界**：本表的每个量词都写了上界（`{20,200}` 之类），
 *     全表扫描必须对**长文本线性**（守卫 = `sensitive-patterns.spec.ts` 的四负载耗时上界）。
 *     唯一的**登记例外** = `private_key_block` 的 PEM 闭类式（含无上界 `+`，理由见该条注释：
 *     对抗载荷实测线性，且 256KB 输入上限下最坏耗时 <10ms）——**改动该形态必须重跑耗时守卫**。
 *   - **禁 `(?i)` 内联分组**：大小写不敏感一律用 `/i` 旗标（内联标志在部分目标引擎上不受支持，
 *     且会让「哪些模式大小写不敏感」从代码表面消失）。
 *   - **禁 `g` / `y` 旗标**：带 `lastIndex` 状态的正则在**跨调用复用**时会从上次位置继续，
 *     导致同一文本半数漏报（实测踩坑）。`RegExp.test` 在无 `g` 时无状态——本表的模式必须
 *     保持无状态（守卫断言 `global === false && sticky === false`）。
 *   - **每条模式各自 try/catch、整体永不抛**：正则异常 / 畸形输入不得打断扫描（调用点都在
 *     业务写路径上，抛 = 把成功写入打成 500）。
 *   - **patternId 词表恒不含逗号**（守卫断言）：`ids` 是逗号拼接的单字符串，含逗号的 id
 *     会破坏 join/split 往返（消费方按 split(',') 还原）。
 *   - **只扫前 `SENSITIVE_SCAN_MAX_CHARS`**：超长正文的**尾部不扫**（不覆盖清单已登记，
 *     见 docs/modules/hint-system.md §7）；`truncated` 让这件事在告警行里可观测。
 *   - **不做归一化 / 不做解码**：拆写、URL 编码、零宽符绕过一律不处理（登记为不覆盖——
 *     检测器是「提醒」不是「闸门」，追求零漏报会牺牲全部精度）。
 *
 * [关联代码]
 *   - modules/hints/credential-scan.ts — 唯一生产调用方（emit helper；告警 + 事实）
 *   - modules/hints/security-hint.provider.ts — 事实 → hint 候选（label 解析处）
 *   - common/utils/redaction-patterns.ts — 脱敏族（**消费整个值**，语义不同）
 *   - modules/experience/experience.constants.ts — 录入闸门族（**命中即 400**，语义不同）
 *   - sensitive-patterns.spec.ts — TP / TN / known-FP 三表 + 耗时上界 + 截断行为
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #20(契约即设计)
 * =============================================================================
 */

/**
 * 一条敏感凭证模式。
 *
 * `id` 是**稳定标识**（进事实载荷的 `matchedPatterns` 与告警行，观测按它聚合——改名 =
 * 历史数据断裂）；`label` 是给用户看的短名（进 hint 文案的 `{labels}`）。
 */
export interface SensitivePattern {
  /** 模式 ID（稳定标识；**禁含逗号**——`ids` 是逗号拼接的单字符串） */
  id: string;
  /** 人类可读短名（进 hint 文案；禁含逗号） */
  label: string;
  /** 检测正则（**必须无 `g`/`y` 旗标且量词有界**，见文件头不变量） */
  pattern: RegExp;
}

/**
 * 单次扫描的正文长度上限（**256K 字符** ≈ 中文 768KB / ASCII 256KB 字节）。
 *
 * 口径按 `String.length`（UTF-16 code unit）计——不是字节数：中文正文每个汉字算 1 字符
 * 但占 3 字节，故中文场景的实际字节上限约为 3×。
 *
 * rationale：超长文本里越靠后的内容越不像「手滑粘贴的凭证」（而更像正常长文），
 * 且扫描成本随长度线性上升。上限的意义是给**成本**兜底，不是「尾部没有密钥」——
 * 尾部未扫这件事由 `truncated` 在告警行里可观测（不覆盖清单已登记）。
 */
export const SENSITIVE_SCAN_MAX_CHARS = 256 * 1024;

/**
 * 首发 9 条模式（**全部有界量词、全部左边界、无内联标志、无 `g` 旗标**）。
 *
 * ── 逐条的形态依据与已知误报 ──
 * 1. `platform_agent_key`：本平台 API Key = `ask_` + 32 位 base64url
 *    （`agent.service.ts` 的三处生成点）；下界取 20 而非 32 是为了覆盖历史/未来的长度调整，
 *    上界 64 防「前缀命中后吃掉整段」。**为什么必须有**：这是**自家**凭证，漏报代价最高。
 * 2. `sk_key`：OpenAI / TypeSafe 族通用 `sk-` 前缀（形态参
 *    `redaction-patterns.ts`，但**不照抄它的 `/g` 与无上界 `+`**）。
 *    **已知 FP**：行首 / `=` 后的长 slug（如 `sk-some-long-slug-name-here-2026`）会命中——
 *    已登记接受，运营侧走 `HINT_CREDENTIAL_PATTERNS_DISABLED=sk_key` 收敛。
 * 3. `typesafe_key`：TypeSafe 官方云 key 前缀 `apikey_`（同 2 的 FP 性质）。
 * 4. `github_token`：`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`（经典 PAT 家族）+ `github_pat_`
 *    （fine-grained PAT）。**必须是分组**：写成 `ghp_...|github_pat_...` 会让左边界
 *    lookbehind 只罩住第一支（实测 bug），`github_pat_` 会在复合词里被误命中。
 *    ⚠️ 也正因左边界含 `_`，`task_github_pat_...` 这类复合词**刻意不命中**（见 TN 表）。
 * 5. `aws_access_key`：`AKIA`/`ASIA` + 16 位大写字母数字（AWS 官方形态）。
 *    **known-FP**：AWS 官方文档示例 `AKIAIOSFODNN7EXAMPLE` 会命中——**钉死现状**：
 *    它确实是「疑似凭证」的形态，检测器不猜「这是不是官方示例」。
 * 6. `age_secret_key`：age 加密工具私钥文件（`AGE-SECRET-KEY-1...`，大写锚定）。
 * 7. `private_key_block`：PEM 私钥头闭类式（复用经验库闸门的定义，
 *    正例矩阵 9/9 在守卫 spec）。**登记例外**：含无上界 `+`，但对抗载荷实测**线性**
 *    （10MB ≤ 205ms；256KB 上限下最坏 < 10ms）——**改动该形态必须重跑耗时守卫**。
 * 8. `connection_string`：**有界通用 scheme** + `://user:pass@` 三段式。
 *    为什么是通用 scheme 而非 DB scheme 白名单：真泄漏以 DB/broker DSN 为主，白名单会
 *    漏掉 `postgresql+psycopg2://` 这类带驱动后缀的形态；O(n²) 的根因是**无界量词**，
 *    不是 scheme 的通用性（故这里所有量词都有界）。
 *    **http/https 显式排除**（负向前瞻）：教程 / 文档里的 `https://user:pass@host` 是最大
 *    的误报源，而真实泄漏几乎不会是 http(s) 形态的 userinfo。
 *    **known-FP**：占位 DSN（`<scheme>://user:password@host` 形态）会命中——钉死现状，
 *    文案自带「若是文档示例/占位符请忽略」的出口兜底。
 * 9. `slack_token`：`xox[baprs]-` 家族（bot/user/workspace 等 token 形态）。
 *
 * ── 刻意**不收编**的模式（复活条件写清，避免反复讨论） ──
 * - `password_assignment`（`password=`）：教程与配置示例里高发，且经验库闸门已覆盖录入面；
 *   复活条件 = 出现「`password=` 型真实泄漏」的事故记录 + 模式级 kill switch 反向数据。
 * - `bearer_jwt`（`Bearer eyJ...`）：文档教程与示例请求头高发（同款复活条件）。
 */
export const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  {
    id: 'platform_agent_key',
    label: '平台 agent key（ask_ 前缀）',
    pattern: /(?<![A-Za-z0-9_-])ask_[A-Za-z0-9_-]{20,64}/,
  },
  {
    id: 'sk_key',
    label: 'sk- 前缀 key',
    pattern: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,200}/,
  },
  {
    id: 'typesafe_key',
    label: 'apikey_ 前缀 key',
    pattern: /(?<![A-Za-z0-9_-])apikey_[A-Za-z0-9_-]{20,200}/,
  },
  {
    id: 'github_token',
    label: 'GitHub token',
    // 分组是必须的（见上方第 4 条）：左边界要罩住**两支**
    pattern:
      /(?<![A-Za-z0-9_-])(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,200}|github_pat_[A-Za-z0-9_-]{22,200})/,
  },
  {
    id: 'aws_access_key',
    label: 'AWS access key',
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/,
  },
  {
    id: 'age_secret_key',
    label: 'age 私钥',
    pattern: /(?<![A-Za-z0-9_-])AGE-SECRET-KEY-1[A-Z0-9]{20,200}/,
  },
  {
    id: 'private_key_block',
    label: 'PEM 私钥块',
    // 登记例外（见上方第 7 条）：含无上界 `+`，改动需重跑耗时守卫
    pattern: /(?:-{2,5}\s*)?BEGIN(?:\s+[A-Z0-9-]+){0,3}\s+PRIVATE KEY/,
  },
  {
    id: 'connection_string',
    label: '带口令的连接串',
    // `/i` 而非内联 (?i)；http/https 显式排除（见上方第 8 条）；量词全有界
    pattern:
      /(?<![A-Za-z0-9+.-])(?!(?:https?):\/\/)[a-z][a-z0-9+.-]{0,20}:\/\/[^/\s:@]{1,128}:[^/\s@]{1,128}@/i,
  },
  {
    id: 'slack_token',
    label: 'Slack token',
    pattern: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,200}/,
  },
];

/** `scanSensitiveContent` 的返回值 */
export interface SensitiveScanResult {
  /** 命中的 patternId（**逗号拼接**；无命中 = 空串） */
  ids: string;
  /** 输入是否超过 {@link SENSITIVE_SCAN_MAX_CHARS} 被截断（只影响告警行，**不进事实载荷**） */
  truncated: boolean;
}

/**
 * 扫描文本里的疑似凭证（**纯函数、永不抛**，见文件头不变量）。
 *
 * @param text 待扫描文本（非串 / 空串 → 无命中）
 * @param patterns 生效模式表（缺省 = 全表；调用方按**模式级 kill switch** 过滤后传入）
 * @returns `{ ids, truncated }`——`ids` 为逗号拼接的 patternId（无命中 = 空串）
 */
export function scanSensitiveContent(
  text: string,
  patterns: readonly SensitivePattern[] = SENSITIVE_PATTERNS,
): SensitiveScanResult {
  if (typeof text !== 'string' || text.length === 0) return { ids: '', truncated: false };
  const truncated = text.length > SENSITIVE_SCAN_MAX_CHARS;
  const target = truncated ? text.slice(0, SENSITIVE_SCAN_MAX_CHARS) : text;

  const hits: string[] = [];
  for (const entry of patterns) {
    try {
      // 防御性重置：本表的模式本应无状态（无 g/y），但**跨调用复用同一个 RegExp 对象**时，
      // 任何带 lastIndex 的模式都会从上一次位置继续 ⇒ 半数漏报（实测踩坑）。置 0 无副作用。
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(target)) hits.push(entry.id);
    } catch {
      // 单条模式失败不影响其余模式（fail-open：检测器是提醒，不是闸门）
    }
  }
  return { ids: hits.join(','), truncated };
}

/** 按 id 查模式（未登记 → undefined）；供 provider 把 patternId 解析成 label */
export function findSensitivePattern(id: string): SensitivePattern | undefined {
  return SENSITIVE_PATTERNS.find((entry) => entry.id === id);
}
