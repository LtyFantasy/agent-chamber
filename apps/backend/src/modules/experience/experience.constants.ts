/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库（Experience Base）写侧与检索侧的策略常量（阈值 / 上限 / 闸门模式）
 *
 * [代码职责]
 *   - 本模块全部**策略常量**的单一事实源：录入限流、疑似重复阈值、检索打分权重与
 *     分数下限、数组/分页上限、密钥闸门模式、幂等 entityType 标记
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base.md §2（匹配契约）/§3（API 契约）/§8（观测）
 *     （对外文档 docs/experience-base.md 与 docs/api-definition.md 的经验库章随后续
 *     批次上线；两者落地后以线上文档为权威副本）
 *   - 补充: 线上 DocSpace `docs/spec.md` — 枚举词表与错误码（值域单源在 shared）
 *
 * [关键不变量]
 *   - **值域类常量不在此文件**：intent/quality/outcome 词表在 shared `enums/index.ts`，
 *     列宽常量与 env 键白名单在 shared `dto/experience.dto.ts`（entity + DTO 共用）。
 *     本文件只承载 shared 不该知道的**策略**（阈值/限流/闸门），避免第二事实源
 *   - `EXPERIENCE_SCORE_FLOOR` 必须与 `EXPERIENCE_RANK_WEIGHTS` 一起改：floor 是
 *     融合分上的显式过滤（q 是过滤+排序，不是只排序），调权重不动 floor 会让召回面
 *     静默漂移
 *   - `EXPERIENCE_DUPLICATE_*` 是**软提示**阈值：只影响 `possibleDuplicates` 候选，
 *     永不拒绝写入（写入面无重复拒绝通道）
 *   - 限流窗口是**进程内内存**（重启清零）：单实例前提写在 `EXPERIENCE_CREATE_RATE_*`
 *     注释里，多实例部署必须换成共享存储（Redis/DB）——本批明文接受该局限
 *
 * [关联代码]
 *   - experience.service.ts — 全部常量的消费方（归一化/打分/限流/闸门/幂等）
 *   - experience.controller.ts — 无消费（策略不经 controller，防止两处判断）
 *   - dto/query-experience.dto.ts — 分页与 q 长度上限的校验引用
 *   - packages/shared/src/dto/experience.dto.ts — 列宽常量 + env 键白名单（另一处单源）
 *
 * [持久踩坑]
 *   EXPERIENCE-RATELIMIT-INPROC(限流内存窗口): 计数器在进程内存里，**重启清零**且不跨
 *     实例共享。安全方向: 单实例部署期内可接受（限流是滥用缓解而非配额）；一旦多实例，
 *     必须先换共享存储再谈阈值，否则等于把 30/h 放大成 30/h×实例数。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 阈值调整必须同步 e2e 阈值断言（软提示/分数下限/限流窗口三条各有 e2e 钉住）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
// ─── 录入限流（POST /experiences）────────────────────────────────────────────

/**
 * 录入限流窗口内允许的次数（按 actor 计数）。
 *
 * rationale（plan §3 写入面威胁模型）：写入面是**全认证可写**（任何有效 API Key /
 * 人类 JWT 都能录），量化上限 + 限流是"垃圾注入"的第一道缓解。30 次/小时 =
 * 正常情况下远用不满、脚本刷库立刻撞墙的档位。
 *
 * `EXPERIENCE_CREATE_RATE_LIMIT` env 可覆盖（运维调参 + e2e 抬高；`resolveCreateRateLimit`
 * 在**服务构造期**读取 ⇒ 必须在 app 引导前设置才生效，照 `USAGE_FLUSH_INTERVAL_MS` 先例）。
 * 为什么不走 `isTestEnv` 自动放宽（attachment/auth 的 throttle 先例）：限流窗口的**单测
 * 需要真实阈值 30** 才能验证"第 31 次 429"，自动放宽会让那条单测失去意义。
 */
export const EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW = 30;

/** 录入限流阈值的 env 覆盖键名（单源；见上方 rationale） */
export const EXPERIENCE_CREATE_RATE_LIMIT_ENV = 'EXPERIENCE_CREATE_RATE_LIMIT';

/**
 * 解析实际生效的录入限流阈值（env 覆盖 + 合法性兜底）。
 *
 * 非法值（非数字 / ≤0）一律回落到缺省 30：限流是安全缓解，"配置写错就静默关闭限流"
 * 是最糟的失败模式。缺省值写死在此处而不是 `?? 30` 分散在调用点——单源。
 */
export function resolveCreateRateLimit(): number {
  const raw = process.env[EXPERIENCE_CREATE_RATE_LIMIT_ENV];
  if (!raw) return EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return EXPERIENCE_CREATE_RATE_LIMIT_PER_WINDOW;
  return parsed;
}

/**
 * 录入限流窗口长度（1 小时）。
 *
 * ⚠️ 计数器是**进程内内存**窗口（`Map<actorKey, number[]>`，惰性清理过期时间戳）：
 * 进程重启即清零，且**不跨实例共享**——本批单实例部署前提下的明文取舍（换共享存储
 * 见文件头 EXPERIENCE-RATELIMIT-INPROC）。
 */
export const EXPERIENCE_CREATE_RATE_WINDOW_MS = 60 * 60 * 1000;

// ─── 疑似重复软提示（POST /experiences 的 possibleDuplicates）──────────────

/**
 * 疑似重复的 signals 交集下界（overlap ≥ 1 即候选）。
 *
 * rationale：signals 是"至少共享一个症状"的 ANY-overlap 语义（plan §2），同一症状
 * 通常已足以提示"这条可能有人踩过"，故下界取 1 而不是 2——宁可多提示（软提示不阻断），
 * 也不要漏掉真正的重复录入。
 */
export const EXPERIENCE_DUPLICATE_MIN_SIGNAL_OVERLAP = 1;

/**
 * 疑似重复的标题 trgm 相似度阈值（similarity > 0.5 即候选）。
 *
 * rationale：0.5 是 pg_trgm 语义下"词序不同但主体词重合"的档位（标题短，误报代价
 * 低于漏报）；该路径**不走索引**（similarity 函数打分，plan §1.3 明写），故只在
 * 录入这一条低频写路径上做全表打分，代价可接受。
 */
export const EXPERIENCE_DUPLICATE_TITLE_SIMILARITY = 0.5;

/** 疑似重复候选返回条数上限（软提示，取最相似的若干条即可） */
export const EXPERIENCE_DUPLICATE_CANDIDATE_LIMIT = 5;

// ─── 检索融合打分（GET /experiences 带 q）─────────────────────────────────

/**
 * 三路融合打分权重（照 `doc-search.service.ts` 的 RANK_WEIGHTS 先例，plan §2 钉死）：
 * - ts_rank(search_vector, plainto_tsquery('simple', q)) × 1.0 —— 英文/标识符精确通道
 *   （'simple' 配置不做事后词干化，`ECONNREFUSED` 这类 token 保持原样）
 * - similarity(content, q) × 0.6 —— 中文/异词汇模糊通道（pg_trgm 滑窗）
 * - similarity(title, q) × 0.8 —— 标题权重高于正文：标题是提炼结论，命中更值钱
 */
export const EXPERIENCE_RANK_WEIGHTS = {
  /** ts_rank 权重 — 英文/标识符精确匹配 */
  TS_RANK: 1.0,
  /** pg_trgm similarity(content) 权重 — 正文模糊匹配（中文主通道） */
  TRGM_CONTENT: 0.6,
  /** pg_trgm similarity(title) 权重 — 标题命中权重略高于正文 */
  TRGM_TITLE: 0.8,
} as const;

/**
 * 融合分下限（低于此分不算命中）。
 *
 * rationale（plan §2）：q 是**过滤 + 排序**，不是只排序——不设下限则"传了 q 却几乎
 * 什么都不搭边"的条目照样返回，零命中语义（本模块最关键的冷启动引导）就永远不触发。
 * 0.08 低于 pg_trgm 默认阈值 0.3（`%` 操作符的阈值），这正是**刻意不加 `%` 预过滤**的
 * 原因：收紧召回面与"异词汇召回"契约相反（plan §1.3 取舍 1）。
 */
export const EXPERIENCE_SCORE_FLOOR = 0.08;

/** 全文查询串长度上限（DTO `@MaxLength` 引用；只用 plainto_tsquery + 绑定参数） */
export const EXPERIENCE_QUERY_MAX_LENGTH = 200;

// ─── 数组 / 分页 / 归一化上限 ──────────────────────────────────────────────

/** signals 数组元素数上限（plan §7「数组上限 20×50」= ≤20 个元素、每元素 ≤50 字符） */
export const EXPERIENCE_MAX_SIGNALS = 20;

/** domains 数组元素数上限（同 signals） */
export const EXPERIENCE_MAX_DOMAINS = 20;

/**
 * signal/domain 单元素长度上限（归一化**之后**的字符数，plan §2）。
 *
 * rationale：元素语义是"提炼出的关键词 token"（`ECONNREFUSED`、`ereresolve`），
 * 不是整句报错——50 字符足以容纳最长标识符，超出说明调用方没提炼。
 */
export const EXPERIENCE_ELEMENT_MAX_LENGTH = 50;

/** env 值长度上限（键白名单受控、值开放但要有界，plan §1.1「值长≤100」） */
export const EXPERIENCE_ENV_VALUE_MAX_LENGTH = 100;

/** sourceProject 长度上限（列宽 varchar(128)） */
export const EXPERIENCE_SOURCE_PROJECT_MAX_LENGTH = 128;

/**
 * 摘要列宽（`experience_entries.summary` varchar(500)）—— **转出口**，单源在 shared。
 *
 * 与 `EXPERIENCE_TITLE_MAX_LENGTH` / `EXPERIENCE_CONTENT_MAX_LENGTH` 同处
 * `@agent-chamber/shared` 的 `dto/experience.dto.ts`（列宽单源 = 该文件，entity 列长装饰器
 * + DTO `@MaxLength` 共用一处）。此处 re-export 只为让**后端 import 点不动**
 * （DTO/其它消费方照旧 `from '../experience.constants'`）；**禁在本文件写第二份字面量**。
 */
export { EXPERIENCE_SUMMARY_MAX_LENGTH } from '@agent-chamber/shared';

/** 分页缺省每页条数 */
export const EXPERIENCE_DEFAULT_PAGE_SIZE = 20;

/** 分页每页条数上限（DTO `@Max` 引用；防止单请求拉全表） */
export const EXPERIENCE_MAX_PAGE_SIZE = 100;

/**
 * `availableDomains` 词表回显条数上限（按出现频次降序）。
 *
 * rationale：词表是"写入者枚举开放词表的唯一通道"，需要足够宽才有用（开放词表会长尾），
 * 但响应体积要有界——50 条 covers 冷启动期全部真实词表，量产后由 usage stats 复查
 * （若单次响应被截断频繁，再考虑分页而不是直接调大上限）。
 */
export const EXPERIENCE_AVAILABLE_DOMAINS_LIMIT = 50;

/**
 * `facets.byCreator` 的录入者分面条数上限（按 count DESC 取 top-N）。
 *
 * rationale（与 `byIntent`/`byQuality` 的口径差异是刻意的，见 service `groupByCreator`）：
 * 类型/质量是**受控词表**，键全量零填充是契约；录入者是**开放维度**（actor 集合无上界，
 * 每个新 actor 就是一个新键），键全量既不可能也无意义。20 条 = 单空间常见的"活跃录入者"
 * 量级（平台以 Agent 为用户，实际写入者远少于条目数）；超出部分用 `byCreatorTruncated`
 * 标记告诉调用方"还有更多"，而不是静默截断。
 *
 * ⚠️ 调大本常量必须同步复核：① 前端筛选下拉的可读性（20 条已是长列表）；
 * ② `groupByCreator` 的批量名字解析行数（它随本值线性增长）。
 * 尾部录入者（>20）的搜索式选择器是**另案**（本批只做截断标记 + 前端强制并入已选值）。
 */
export const EXPERIENCE_BY_CREATOR_LIMIT = 20;

// ─── 判断日志与判别服务（第二期批 3）────────────────────────────────────

/**
 * 判断日志分页缺省每页条数。
 *
 * 与条目的 `EXPERIENCE_DEFAULT_PAGE_SIZE` 分开：日志单行可能达 16KB×2（request+response），
 * 缺省页大小直接决定导出路径的单次响应量级。
 */
export const EXPERIENCE_JUDGMENT_DEFAULT_PAGE_SIZE = 20;

/**
 * 判断日志分页上限（plan §2.2 钉死 ≤50）。
 *
 * rationale：单页体量上限 ≈ 50×(16KB request + 16KB response) ≈ **1.6MB**——上界既是
 * "客户端超时/流式处理"的量级契约，也是防止一次拉全表的手段。调大前必须先量后端响应时间。
 */
export const EXPERIENCE_JUDGMENT_MAX_PAGE_SIZE = 50;

/**
 * 判定限流窗口长度（1 小时；与录入限流**同窗口长度但独立配额**——判定不是录入）。
 *
 * 计数器同样是**进程内内存**窗口（`Map<actorKey, number[]>`，惰性清理）：单实例部署前提下的
 * 明文取舍，重启清零、不跨实例共享（与 `EXPERIENCE_CREATE_RATE_WINDOW_MS` 同规）。
 */
export const EXPERIENCE_JUDGMENT_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 判断日志载荷序列化硬顶（字节；plan §1.2：request / response 各 16KB）。
 *
 * rationale：日志表是**正文第二副本**，无上限会让单行撑爆 jsonb 并让导出路径失控。
 * 超限行为 = 截断 + `truncated:true` 标记，**绝不静默**。
 */
export const EXPERIENCE_JUDGMENT_LOG_PAYLOAD_MAX_BYTES = 16 * 1024;

/** 判定失败 `{error}` 文案上限（plan §1.2：≤2000 字符） */
export const EXPERIENCE_JUDGMENT_ERROR_MAX_LENGTH = 2000;

/** `status='skipped'` 行的 request 占位 reason（限流跳过；保住 request NOT NULL 不变量） */
export const EXPERIENCE_JUDGMENT_SKIPPED_REASON = 'judgment_rate_limited';

// ─── 密钥闸门（POST /experiences 内容体检）────────────────────────────────

/**
 * 密钥/凭据模式（命中即 400 拒绝写入，plan v1.2 §7 写入面闸门）。
 *
 * rationale（security B1 密钥外溢链）：经验正文常常是排障笔记——最典型的泄漏形态是
 * 把带 `password=...` 的连接串或 `ask_`/`sk-` 前缀的 API Key 原文粘进来，而经验库是
 * **全认证可读**的跨项目共享面，一旦录入即等于对全部 agent 公开。
 *
 * ── 第 3 条（私钥 PEM 头）为什么是**大写锚定闭类式**而不是 `/begin private key/i` ──
 * 旧写法只认 `BEGIN PRIVATE KEY` 字面量，实测漏掉全部带算法前缀的标准 PEM 头
 * （任务 `02f47bc1`：RSA/EC/OPENSSH/ENCRYPTED 等变体全部放行）。v1.1 曾改用
 * `/begin\s+(\w+\s+)*private key/i` 这类**大小写不敏感闭类**写法，实测**误伤英文散文**
 * （"begin by generating a private key pair" 会被拦），把正常排障笔记打成 400。
 * 定稿 = **去掉 `/i` 并把锚点钉在大写 `BEGIN ... PRIVATE KEY`**：PEM 头在标准形态下
 * 恒为大写，散文里的 "begin ... private key" 恒为小写 → 闭类覆盖与误伤消除同时达成。
 *
 * 正例矩阵（必须命中；`(?:-{2,5}\s*)?` 覆盖 `-----BEGIN` / `--BEGIN` / 无破折号形态）：
 *   BEGIN PRIVATE KEY / BEGIN RSA PRIVATE KEY / BEGIN EC PRIVATE KEY /
 *   BEGIN DSA PRIVATE KEY / BEGIN ECDSA PRIVATE KEY / BEGIN OPENSSH PRIVATE KEY /
 *   BEGIN ENCRYPTED PRIVATE KEY / BEGIN SSH2 ENCRYPTED PRIVATE KEY /
 *   BEGIN PGP PRIVATE KEY BLOCK / BEGIN ML-DSA-87 PRIVATE KEY（PQC 命名）
 *   以及上述任意一条带 `-----` 前缀的形态（真实 PEM 文件的写法）
 * 负例矩阵（必须放行；写进单测防回退）：
 *   `-----BEGIN PUBLIC KEY-----`（公钥不是秘密）、
 *   "begin by generating a private key pair" / "begin the private key rotation" /
 *   "begin with a private key file"（英文排障散文——v1.1 的 `/i` 写法实测在此误伤）
 *
 * ── 已知残余盲区（plan §13 明文登记，不做）──
 * 小写/非标准 PEM 头（`-----begin private key-----`）与**裸 base64 私钥体**（无任何标记）
 * 无法在不误伤正常文本的前提下机检；真正的兜底是"经验库全认证可读"这一认知本身
 * （写入者教育与 review 动线）。
 *
 * 其余各条（逐条对应 plan §3 + 任务 `02f47bc1`）：`ask_`（本平台 API Key 前缀）/
 * `sk-`（OpenAI 族）/ `password=`（连接串口令）/ `age-secret-key-`（age 加密工具私钥文件）/
 * `putty-user-key-file`（PuTTY 私钥文件头）/ `apikey_`（TypeSafe 官方云 key 前缀）。
 * `password=` / `age-secret-key-` / `putty-user-key-file` 走大小写不敏感（`PASSWORD=` 与
 * `Age-Secret-Key-` 同样危险）；`ask_` / `sk-` / `apikey_` 是**小写锚定**（前缀形态如此
 * 定义），且它们都不是散文常见词，误伤风险可忽略。
 *
 * ⚠️ **本表是"前缀命中"语义，与 redaction 表（`JUDGMENT_REDACTION_PATTERNS`）刻意分开**：
 * 本表只判"有没有密钥"（命中即 400 拒绝），redaction 表要"吃掉整个值"。两个表里同名族的
 * 两条**不是冗余**，勿当重复删（详见 `experience-judgment.service.ts` 的 redaction 注释）。
 */
export const EXPERIENCE_SECRET_PATTERNS: readonly RegExp[] = [
  /ask_[A-Za-z0-9]/,
  /sk-[A-Za-z0-9]/,
  // 私钥 PEM 头（闭类；**无 /i**，见上方 rationale 与正负例矩阵）
  /(?:-{2,5}\s*)?BEGIN(?:\s+[A-Z0-9-]+){0,3}\s+PRIVATE KEY/,
  /password\s*=/i,
  // age 私钥文件（`age-secret-key-XXXX...` 单行文本形态）
  /age-secret-key-/i,
  // PuTTY 私钥文件头（`PuTTY-User-Key-File-3: ssh-rsa ...`）
  /putty-user-key-file/i,
  // TypeSafe 官方云 key（`apikey_...`）。**追加在数组末尾**：400 文案带
  // `matched pattern #N`（experience.service.ts），位置敏感——插在中间会让既有编号漂移。
  /apikey_[A-Za-z0-9]/,
];

// ─── 「验证方式」节提示（不阻断）──────────────────────────────────────────

/**
 * 正文里「验证方式」节的识别标记（缺节 → 响应带 `warnings`，**不拒绝写入**）。
 *
 * rationale（plan §3）：验证方式是经验可信度的唯一自证材料，但**强制**会让录入摩擦
 * 过高（冷启动期最怕的就是录不进来）；故只提示。匹配同时覆盖英文模板节名
 * `How verified` 与中文「验证」二字——正文模板是 markdown 四节（Symptom / Root cause /
 * Fix / How verified），中文录入者通常写「验证方式」。
 */
export const EXPERIENCE_VERIFICATION_SECTION_PATTERN = /(how\s+verified|verification|验证)/i;

/** 缺「验证方式」节时的告警原文（响应 `warnings[0]`，非阻断） */
export const EXPERIENCE_MISSING_VERIFICATION_WARNING =
  'content does not appear to contain a "How verified" section — recording an experience ' +
  'without how you verified the fix makes it much harder for others to trust it. ' +
  'The entry was saved; consider editing it to add that section.';

// ─── 幂等 ────────────────────────────────────────────────────────────────

/**
 * 录入幂等的 entityType 标记（`idempotency_records.entity_type`）。
 *
 * 语义：`uq_idempotency_actor_key (actor_id, client_request_id)` 是**全平台共享**的
 * 唯一键 ⇒ entityType 是模块身份标记，同键跨模块互撞时据此判定"键被别的模块占用"
 * （见 `common/services/idempotency.helper.ts`）。
 *
 * ⚠️ **反馈端点刻意不用本标记**：反馈的幂等与去重由 `experience_feedback` 自己的双唯一
 * 约束承担（同 key 同 payload → 重放、同 key 不同 payload → 409/9002），不写
 * idempotency_records——反馈是"更新语义"的状态迁移，行本身就是幂等载体（plan §1.2）。
 */
export const EXPERIENCE_IDEMPOTENCY_ENTITY_TYPE = 'experience';

// ─── 零命中埋点轻表 ──────────────────────────────────────────────────────

/** 零命中埋点表名（migration 裸 SQL 与 service 写入共用一处，防两处拼错） */
export const EXPERIENCE_SEARCH_EVENTS_TABLE = 'experience_search_events';

/** 单次搜索埋点里 query_hash 的算法标识（sha256 hex；与幂等 helper 同族） */
export const EXPERIENCE_SEARCH_HASH_ALGORITHM = 'sha256';
