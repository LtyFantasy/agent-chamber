/**
 * 经验库（Experience Base）— 响应 DTO
 *
 * 定义列表/详情/分面/反馈等响应的对外 Shape（web 与后端共用同一份类型）。
 * 项目惯例：**列表投影不含 content 全文**（全文走详情端点），字段名与 REST 载荷
 * 逐字一致。
 *
 * 与 `experience.dto.ts` 的分工：本文件是**读侧**（服务端产出的投影），
 * 常量/值域/输入 Shape 在读侧文件外的 shared DTO。
 */
import type {
  ActorType,
  ExperienceFeedbackOutcome,
  ExperienceIntent,
  ExperienceJudgmentOperation,
  ExperienceJudgmentStatus,
  ExperienceMemberRole,
  ExperienceQuality,
} from '../enums';
import type { ExperienceEnv, ExperienceSort } from './experience.dto';

// ─── 条目投影 ────────────────────────────────────────────

/**
 * 疑似重复候选（录入响应 `possibleDuplicates` 数组元素；plan v1.3 §3）
 *
 * 触发条件（**软提示，不拒绝写入**）：与既有条目的 signals 交集 ≥1 个，
 * 或 title 的 pg_trgm similarity > 阈值。阈值常量落在 backend
 * `modules/experience/experience.constants.ts`（写侧策略，非对外契约）。
 */
export interface ExperienceDuplicateCandidate {
  /** 已存在条目 id（供调用方走 read/update 而非重复录入） */
  id: string;
  /** 已存在条目标题 */
  title: string;
  /** 已存在条目质量（重复候选也要透出，供判断是否已有 verified 版） */
  quality: ExperienceQuality;
  /** 命中的共同 signal 清单（signals overlap 路径命中时透出，可解释性） */
  signalsMatched?: string[];
  /** 标题 trgm 相似度原值（title similarity 路径命中时透出，0~1） */
  titleSimilarity?: number;
}

/**
 * 经验条目列表投影（**不含 content 全文**）
 *
 * 信任信号与新鲜度都在这一层透出：`quality`（可信度徽章）、`distinctHelpedCount`
 * （被多少人用后确认有效）、`expiresAt`/`expired`（时效边界）。消费方据此决定
 * 是否值得点进详情读全文。
 *
 * **归属人三态渲染契约（v1.81.0，web 与 MCP 共用）**——服务端只透出事实，不替消费方选文案：
 * - 活：`createdByName` 有值且 `createdByDeletedAt === null` → 头像 + 名字；
 * - 软删：`createdByName` 有值且 `createdByDeletedAt !== null` → **名字照常渲染** + 删除标记
 *   （名字是历史归因，软删不清名）；
 * - 真孤儿：`createdByName === null`（actor 行已硬删）→ 显示 id 前 8 位，**不加兜底词**
 *   （服务端刻意不返回 'Unknown' 之类的占位名：那会让"名字缺失"与"真名恰好叫这个"混淆）。
 */
export interface ExperienceSummary {
  /** 条目 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 摘要（列表投影的唯一依据；录入时必填，不从 content 派生） */
  summary: string;
  /** 类型（五值受控词表） */
  intent: ExperienceIntent;
  /** 质量（unverified 缺省 / verified 终审通过 / suspect 终审判可疑） */
  quality: ExperienceQuality;
  /** 症状信号（归一化后的小写 token；匹配是 ANY-overlap，见 plan §2） */
  signals: string[];
  /** 领域标签（开放词表，归一化后小写） */
  domains: string[];
  /** 环境指纹（键受控、值开放） */
  env: ExperienceEnv;
  /** 累计「帮到了」反馈数（含重复改判的净计数） */
  helpedCount: number;
  /** 累计「没帮到」反馈数 */
  notHelpfulCount: number;
  /** (entry,actor) 去重后的有效命中数——`most_used` 排序权重列 */
  distinctHelpedCount: number;
  /** 最近一次「帮到了」的时间（仅 outcome=helped 推进；无则 null） */
  lastHelpedAt: string | Date | null;
  /** 来源项目（自报、非可信；格式约定 repo slug） */
  sourceProject: string | null;
  /** 时效边界（null = 永不过期） */
  expiresAt: string | Date | null;
  /** 派生标记：expiresAt 非空且已过（默认查询已排除，includeExpired=true 时透出） */
  expired: boolean;
  /** 创建时间 */
  createdAt: string | Date;
  /** 更新时间 */
  updatedAt: string | Date;
  /** 检索命中分（仅带 q 的融合检索通道透出；无 q 的列表排序不含此字段） */
  score?: number;
  /**
   * 命中原因可解释性：本次查询实际命中的 signal 交集
   * （signals 过滤命中或 q 全文命中时透出；照 doc 搜索 boosts 先例）
   */
  signalsMatched?: string[];
  /**
   * 录入者 ID —— **按录入者筛选/检索的取值来源**（v1.81.0 改口径）。
   *
   * 它是**查询维度**：`?createdById=<此 UUID>` 做精确相等过滤（facets 的 `byCreator`
   * 元素里也带同一个键）；**不是**给人看的展示值——展示一律走 `createdByName`。
   *
   * ⚠️ 自 v1.81.0 起它**不再是"自筛队列第一态"**：禁自审四态已退役，任何 admin 或空间
   * owner/reviewer 都可终审任意条目（含本人所录），"把自己录的先摘出去"这条动线因此作废
   * ——照旧按 creator 预筛会把**可审**条目误判成不可审（表现为队列空转）。终审资格的
   * 权威判定仍是详情的 `viewerCanReview`（纯角色标记）。
   *
   * **optional**：消费方按缺省处理，勿把 undefined 读成"无录入者"。
   */
  createdById?: string;
  /** 录入者类型（与 createdById 同批透出；复用 ActorType：agent/human/system） */
  createdByType?: ActorType;
  /** 录入者显示名（真孤儿 → null；软删仍保留真名，见接口头三态契约） */
  createdByName?: string | null;
  /** 录入者头像 URL（档案解析字段；无则 null） */
  createdByAvatarUrl?: string | null;
  /** 录入者软删时间（非空 = actor 已删但**名字仍在** `createdByName`） */
  createdByDeletedAt?: string | null;
  /** 终审人显示名（未终审 → null；列表也透出，翻案复核无需点进详情即知"谁盖的章"） */
  verifiedByName?: string | null;
}

/**
 * 经验条目详情（列表投影 + 全文 + 溯源字段）
 *
 * 语义提醒（plan §3）：按 id 查询**只过滤软删**——suspect 与已过期条目在详情
 * **照常可见并带标记**（复核/申诉动线的必要条件），与列表的默认排除口径不同。
 *
 * 第二期新增字段（**全部 optional**）：判别结果 `judgment` + 防锚定标记
 * `judgmentSuppressed` + 服务端单源的终审资格 `viewerCanReview`。
 *
 * ⚠️ v1.81.0 **移除** `viewerReviewBlockReason`（禁自审四态退役，不再有"原因码"维度）：
 * 消费方会收到 `undefined`——**它的消失不等于你不能审**，终审资格只看 `viewerCanReview`。
 */
export interface ExperienceDetail extends ExperienceSummary {
  /** 正文全文（markdown 四节模板：Symptom / Root cause / Fix / How verified） */
  content: string;
  /** 录入者类型（复用 ActorType：agent/human/system） */
  createdByType: ActorType;
  /** 录入者 ID（无 FK：actor 硬删后条目仍存活，usage-stats 先例） */
  createdById: string;
  /** 终审人 ID（未终审为 null；第二期起 = 人类 admin 或空间 owner/reviewer） */
  verifiedBy: string | null;
  /** 终审人显示名（与 `verifiedBy` **成对**；未终审或真孤儿 → null） */
  verifiedByName?: string | null;
  /** 终审人软删时间（非空 = 已删但名字仍在 `verifiedByName`） */
  verifiedByDeletedAt?: string | null;
  /** 终审时间（未终审为 null） */
  verifiedAt: string | Date | null;
  /**
   * 最近一次 `record_check` 判别的**快照**（provider 未启用/未判/判失败 → null）。
   *
   * ⚠️ **防锚定（服务端单源 suppression）**：当 `viewerCanReview === true` 且
   * `quality !== 'verified'`（含 suspect 复核场景）时，服务端**恒置 null** 并同时置
   * `judgmentSuppressed: true`——reviewer 是 observe 期的 ground truth 来源，终审前
   * 看到机器结论会污染翻案率度量。终审提交后（quality 变 verified）恢复可见，
   * 供人机对照。REST 详情与 MCP `read_experience` 走同一规则（单点实现，双通道自动一致）。
   */
  judgment?: ExperienceJudgment | null;
  /** true = 本次响应**因防锚定隐藏了** judgment（与"本来就没有判别结果"区分） */
  judgmentSuppressed?: boolean;
  /**
   * 当前调用者**能否对这条**行使终审（服务端单源判定，web 只读布尔、**不做任何
   * 成员匹配计算**）。
   *
   * 判定 = **纯角色判定**：人类 admin 或经验空间成员（owner/reviewer 任一）。
   * 自 v1.81.0（禁自审四态退役）起它与"是哪一条"**无关**——同一调用者在所有条目上取值
   * 相同，持角色者可终审本人所录条目。
   * 缺省（字段缺失 = 迁移窗口/旧客户端）时 web 必须 **fail-closed**（不显示终审入口）。
   */
  viewerCanReview?: boolean;
}

// ─── 列表 / 搜索信封 ─────────────────────────────────────

/**
 * 生效过滤回显（响应内 `appliedFilters`）
 *
 * 目的：调用方在**多层过滤叠加**（signals/domains/env/intent/quality 各自独立）
 * 下能确认服务端实际采纳了什么，避免"传了没生效"的黑盒排查。
 */
export interface ExperienceAppliedFilters {
  /** 全文查询串（pg_trgm 融合打分通道） */
  q?: string;
  /** 症状信号（ANY-overlap 命中） */
  signals?: string[];
  /** 环境指纹·操作系统（精确相等） */
  envOs?: string;
  /** 环境指纹·工具（精确相等） */
  envTool?: string;
  /** 环境指纹·版本（精确相等） */
  envVersion?: string;
  /** 环境指纹·运行时（精确相等） */
  envRuntime?: string;
  /** 领域标签（ANY-overlap 命中） */
  domains?: string[];
  /** 类型过滤 */
  intent?: ExperienceIntent;
  /** 质量过滤（显式传 suspect 时放开 suspect 排除——admin 复核出口） */
  quality?: ExperienceQuality;
  /** 来源项目过滤 */
  sourceProject?: string;
  /**
   * 录入者过滤（v1.81.0）：actor UUID **精确相等**。
   *
   * 取值来自某条结果的 `createdById`（或 facets `byCreator` 元素的同名字段）——
   * **不接受显示名**：名字是运行时档案投影，改名/软删都会漂移，且两个 actor 可同名。
   */
  createdById?: string;
  /** 是否包含已过期条目（缺省 false = 排除） */
  includeExpired?: boolean;
  /** 排序模式（缺省 recent） */
  sort?: ExperienceSort;
}

/**
 * 列表 / 搜索响应（GET /experiences 与 MCP search_experiences 共用信封）
 *
 * **零命中是成功态而非错误**：`items` 空数组 + `total: 0` + `hint` 指引，
 * 不抛 404/空错误（plan §4——冷启动期零命中是常态，消费方应继续自己解决问题）。
 */
export interface ExperienceListResponse {
  /** 当前页条目（列表投影，不含 content 全文） */
  items: ExperienceSummary[];
  /** 满足过滤条件的总条目数（分页前） */
  total: number;
  /** 当前页码（1 起） */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 零命中指引原文（仅 total=0 时透出） */
  hint?: string;
  /** 服务端实际采纳的过滤条件回显 */
  appliedFilters?: ExperienceAppliedFilters;
  /** 已知领域词表回显（写入者枚举开放词表的唯一通道；plan §3 facets 同源） */
  availableDomains?: string[];
}

/**
 * 零命中指引原文（MCP `search_experiences` / REST 列表的 `hint` 字段单源）。
 *
 * rationale：这段话是**消费方 Agent 的行为指令**，必须逐字稳定——零命中时它要
 * 引导"自己动手解决 → 然后录进来"，而不是"换个词再搜直到搜到"。
 * 写进 shared 单源，供 service 响应与 MCP 工具 description 共用一份（防两处漂移）。
 */
export const EXPERIENCE_ZERO_HIT_HINT =
  'No prior experience matched. This is normal — proceed and fix it yourself, ' +
  'then record it with record_experience. Narrower filters reduce recall: ' +
  'signals match ANY overlap on exact normalized strings; try dropping ' +
  'envOs/domains/intent, or retry with q.';

// ─── 分面 ────────────────────────────────────────────────

/**
 * 分面聚合响应（GET /experiences/facets）
 *
 * `byIntent`/`byQuality` **键全量**（未命中的取值计数为 0）：分面是 web 侧固定
 * 面片的渲染源，缺键会让前端各页面自行兜底默认值，口径分裂。
 * 过统一 `baseQuery()`（软删 + 过期 + suspect 排除），故与列表口径一致。
 */
export interface ExperienceFacetsResponse {
  /** 满足统一过滤条件的条目总数 */
  total: number;
  /** 按类型聚合计数（键全量 = 五值） */
  byIntent: Record<ExperienceIntent, number>;
  /** 按质量聚合计数（键全量 = 三值） */
  byQuality: Record<ExperienceQuality, number>;
  /** 已知领域词表（按出现频次降序；写入者枚举开放词表的唯一通道） */
  availableDomains: string[];
  /**
   * 按录入者聚合计数（v1.81.0；供"按录入者筛选"下拉的选项源）。
   *
   * ⚠️ **刻意非键全量**（与 `byIntent`/`byQuality` 的口径区分）：录入者是**开放维度**
   * （actor 集合无上界），键全量既不可能也无意义——本数组只带 count DESC 的 top-N
   * （上限 = 服务端常量，当前 20），超出部分由 `byCreatorTruncated` 标记。
   *
   * 口径：**与列表同一 baseQuery + 同一过滤谓词**（facets 从来不是"不带过滤"——web 无参
   * 调用是客户端自律，不是服务端契约）；故它可能与"当前列表页的录入者集合"不同（分页
   * 不同），但与"同参数列表的 total 口径"一致。
   *
   * 名字语义见 `ExperienceCreatorFacet`（三态渲染契约与条目投影相同）。
   */
  byCreator?: ExperienceCreatorFacet[];
  /**
   * true = 真实录入者数**超过** `byCreator` 的 top-N 上限（被截断）。
   *
   * 消费方纪律：截断时不可把 `byCreator` 当成"全部录入者"；**已选中的录入者若不在这
   * 20 条里，前端必须把它强制并入选项**（否则受控 select 会渲染空值）。
   */
  byCreatorTruncated?: boolean;
  /**
   * suspect 计数（终审复核队列规模）。待终审积压量看 `byQuality.unverified`。
   *
   * 透出门（第二期扩列）：`isAdmin || 空间成员角色 !== null`——第二期批 2 落地前
   * 服务端行为仍是"仅 admin 透出"（本字段 optional，消费方按缺省处理）。
   */
  suspectCount?: number;
  /**
   * 当前调用者是否具备**角色级**总览门（第二期 plan §2.1/§2.3）：
   * `true` = 人类 admin 或经验空间成员（owner/reviewer 任一）。
   *
   * 与详情 `viewerCanReview` 的**粒度差异**（自 v1.81.0 起两者**实际等价**——四态退役后
   * `viewerCanReview` 也是纯角色判定，故同一调用者两处取值恒同；保留两个字段是为了
   * 语义分层与向后兼容，**勿据此删掉任一个**）：
   * - 本字段 = **角色级总览门**，用于 sidebar 积压角标等整页渲染门；
   * - `viewerCanReview` = **条目级字段**（历史上曾按条目扣除自审态，现同为角色判定）。
   *
   * 角标口径明文取舍 = **全局 unverified 积压量**（含我可审之外的部分），
   * 故角标渲染门 = `viewerIsReviewer === true && byQuality.unverified > 0`；
   * admin 天然为 true。optional：缺失（迁移窗口/旧客户端）时 web fail-closed。
   */
  viewerIsReviewer?: boolean;
}

/**
 * 分面「按录入者」元素（`facets.byCreator`，v1.81.0）。
 *
 * 字段命名与条目投影**同族**（`createdBy*` 前缀）：facets 元素刻意**不叫裸 `name`**
 * ——裸名会让消费方误以为它是通用显示名，而同族字段名让"这是归属信息"自解释。
 *
 * 三态渲染契约（与 `ExperienceSummary` 完全一致，勿在两处各写一套）：
 * - 活：`createdByName` 有值 + `createdByDeletedAt === null`；
 * - 软删：名字照常渲染 + 删除标记；
 * - 真孤儿（`createdByName === null`）：id 前 8 位，**不加兜底词**。
 *
 * `createdById` 是**唯一可回填查询的值**（`?createdById=` / 该元素本身即是选项 id）——
 * 名字只用于展示，不能当筛选值传给服务端。
 */
export interface ExperienceCreatorFacet {
  /** 录入者 actor UUID（筛选下拉的取值；`?createdById=<此值>` 精确相等） */
  createdById: string;
  /** 录入者类型（渲染类型小字用：human/agent/system） */
  createdByType: ActorType;
  /** 录入者显示名（真孤儿 → null；软删仍保留真名） */
  createdByName: string | null;
  /** 录入者软删时间（非空 = actor 已删但名字仍在 `createdByName`） */
  createdByDeletedAt: string | null;
  /** 该录入者名下满足当前过滤条件的条目数（分页前） */
  count: number;
}

// ─── 写入结果 ────────────────────────────────────────────

/**
 * 录入响应（POST /experiences / MCP record_experience）
 *
 * 强制 `quality='unverified'`——终审是终审人（人类 admin 或空间 owner/reviewer）专属动作，
 * 录入通道不接受客户端指定质量（徽章洗白防线）。
 */
export interface RecordExperienceResponse {
  /** 新建条目 ID */
  id: string;
  /** 恒为 unverified（录入不接受客户端指定质量） */
  quality: ExperienceQuality;
  /** 疑似重复候选（软提示；不阻止写入，命中时提示调用方走 read/update） */
  possibleDuplicates?: ExperienceDuplicateCandidate[];
  /** 非阻断告警（如缺「验证方式」节；只提示不拒绝） */
  warnings?: string[];
  /** true = 同幂等键重放，返回首次响应快照（无二次写入） */
  idempotentReplay?: boolean;
  /**
   * 本次录入判别的七维结果（第二期 plan §3.5；provider 未启用/判失败 → null）。
   *
   * **同一逻辑请求只有一种响应形状**：正常路径 = 本次判定结果；**幂等重放路径** =
   * 从快照列（`experience_entries.judgment`）**回填**（重放不重判，避免同一 clientRequestId
   * 的两次响应不一致）。客户端超时须 ≥10s（判定典型 +1~3s），重试必须复用同一
   * clientRequestId（否则会重复录入）。
   */
  judgment?: ExperienceJudgment | null;
}

/**
 * 反馈响应（POST /experiences/:id/feedback）
 *
 * 计数三列与反馈行**同事务**联动（plan §1.2 不变量）：`helpedCount` /
 * `notHelpfulCount` / `distinctHelpedCount` 返回值即事务提交后的真实值，
 * 调用方无需二次查询。
 */
export interface ExperienceFeedbackResponse {
  /** 被反馈的条目 ID */
  experienceId: string;
  /** 本次生效的结果（改判时为改判后的终值） */
  outcome: ExperienceFeedbackOutcome;
  /** 更新后的累计「帮到了」数 */
  helpedCount: number;
  /** 更新后的累计「没帮到」数 */
  notHelpfulCount: number;
  /** 更新后的去重有效命中数 */
  distinctHelpedCount: number;
  /** true = 同一 (entry,actor) 已有反馈，本次为改判或幂等重放 */
  alreadyRecorded?: boolean;
  /** true = 同幂等键重放（同 key 同 payload），无二次写入 */
  idempotentReplay?: boolean;
}

/**
 * 质量终审响应（PATCH /experiences/:id/quality；终审人 = 人类 admin 或空间 owner/reviewer）
 *
 * 自 v1.81.0 起带 `verifiedByName`：终审成功后调用方（MCP `review_experience_quality`）
 * 无需再发一次详情请求就能回显"谁盖的章"——名字解析与详情/列表同一份投影契约。
 */
export interface ExperienceQualityReviewResponse {
  /** 条目 ID */
  id: string;
  /** 终审后的质量取值 */
  quality: ExperienceQuality;
  /** 终审人 ID */
  verifiedBy: string | null;
  /** 终审人显示名（真孤儿 → null；软删仍保留真名） */
  verifiedByName?: string | null;
  /** 终审时间（suspect 判定同样落此列——它是"最近一次终审时刻"而非"通过时刻"） */
  verifiedAt: string | Date | null;
}

// ─── 判别（七维软判定，observe 期）────────────────────────

/**
 * 录入判别的七维快照（第二期 plan §3.4；v1.82.0 起加第 7 维 `admissionSuggestion`）。
 * **只标注不拒绝**：它是 observe 期的软提示，硬闸门（密钥/长度/词表）全部留在代码层，
 * 本结果不拦截、不改写、不自动升降 quality。
 *
 * 消费纪律（代码侧已无改写路径，此处是给消费方的纪律）：**只展示，禁止据此自动改写
 * 条目**（intent/domains 的建议值由人决定是否采纳；`admissionSuggestion` 连"建议"都只
 * 供作者自省与终审人参考——**消费方不得据此自动拒绝录入或改写条目**）。
 *
 * ⚠️ **每个维度都可能为 `null`**（2026-09-22 批 3 按 plan §0 落地）：jev 响应的维度
 * 是**逐字段白名单校验**的——档位不在词表、confidence 非有限数、建议值不在当次词表快照内
 * 等任一不合法 ⇒ **该维度置 null**（其余维度照常可用）；只有当整体形状破损（answers 缺失/
 * 不是对象）时才整次判定按 status=error 处理且**不落快照**。消费方必须容忍 null 维度
 * （渲染时按"该项无结论"处理），不得假定七维齐全。
 *
 * 形状约束：所有 `confidence` 为 0~1（服务端 `Number.isFinite` + clamp）。
 */
export interface ExperienceJudgment {
  /**
   * 判别服务提供方（**当前值域 `'typesafe'`**；历史行含已退役的 `'jev'` = v1.83.0 前的
   * 自托管 MCP 网关适配器）。
   *
   * 语义 = **适配器（端点 + 传输）**，**不表示厂商或云归属**；对照请连 `model` 一起看。
   */
  provider: string;
  /** 模型标识（provider 自报，如 `'jev-latest'`；仅展示用，不参与排序/判定；限长 64） */
  model: string;
  /** 判定时刻（ISO 8601） */
  judgedAt: string;
  /**
   * 完整度：条目是否具备"能被他人复现"的要素。
   * `missing` 缺关键要素（照做必失败）→ `thin` 要素单薄 → `partial` 基本可用 → `complete` 完整
   */
  completeness: { level: 'missing' | 'thin' | 'partial' | 'complete'; confidence: number } | null;
  /**
   * 可复用性：这条经验对**他人/他项目**的价值面。
   * `one_off` 一次性（环境强绑定）→ `narrow` 窄场景 → `broad` 广泛适用
   */
  reusability: { level: 'one_off' | 'narrow' | 'broad'; confidence: number } | null;
  /**
   * 信号质量：`signals` 是否足以成为检索入口（症状是否可辨识）。
   * `noise` 噪声（"报错了"）→ `weak` 弱信号（"启动失败"）→ `distinctive` 高辨识（"ECONNREFUSED 8743"）
   */
  signalQuality: { level: 'noise' | 'weak' | 'distinctive'; confidence: number } | null;
  /**
   * 重复度：与既有条目的重合判定（录入时服务端把 top-3 疑似候选送进 state）。
   * `distinct` 新条目 / `possible_duplicate` 可能重复（建议先 read 确认）/ `likely_duplicate` 很可能重复
   */
  duplicate: {
    verdict: 'distinct' | 'possible_duplicate' | 'likely_duplicate';
    confidence: number;
  } | null;
  /**
   * 类型归类建议（三分不折叠）：
   * `keep` = 当前 `intent` 合适；`suggested` = 建议值在 `value`。
   * 消费方采纳前必须自行确认（本结果只提示）。
   */
  intentSuggestion: {
    verdict: 'keep' | 'suggested';
    /** 建议的 intent（verdict='keep' 时为 null） */
    value: ExperienceIntent | null;
    confidence: number;
  } | null;
  /**
   * 领域归类建议（三分不折叠）：
   * `keep` = 当前 domains 合适；`none_fits` = **既有词表里没有合适的**（对词表维护者可行动——
   * 可能是该扩词表，也可能是条目领域确实新）；`suggested` = 建议值在 `value`（取自当次
   * `availableDomains` 快照，保证建议值可被检索命中）。
   */
  domainSuggestion: {
    verdict: 'keep' | 'none_fits' | 'suggested';
    /** 建议的 domain（verdict≠'suggested' 时为 null） */
    value: string | null;
    confidence: number;
  } | null;
  /**
   * **准入建议**（第 7 维，v1.82.0 / rubric v2）：这条经验"该不该进跨项目经验库"。
   * 判据只有一条——**换个项目还成立吗**（与 `reusability` 问的不是同一件事：reusability
   * 评"这条经验本身多通用"，准入评"它对跨项目库有没有价值"——项目专属操作细节即使写得很
   * 通用也应当是 `reject`）。
   *
   * - `admit` = 教训跨项目可迁移且有复现价值；
   * - `needs_human` = 边界情况（证据单薄 / 项目专属政策 / 可迁移性不清）→ 交终审人；
   * - `reject` = 对跨项目库价值低（项目专属操作细节、一次性环境修复、不可验证的断言、
   *   无可行动内容）。
   *
   * ⚠️ **observe-only：永不自动 gate**。消费方**不得**据此自动拒绝录入、自动改写条目或
   * 自动升降 quality——它只供作者自省（改内容/删除）与终审人参考。未来形态（录入时
   * `reject` 即拒收的硬门槛）是独立批次，前置条件 = 校准数据量（线上 `docs/experience-base.md`
   * §9 翻案率配对一致率）达标 + 阈值策略评审。
   */
  admissionSuggestion: {
    verdict: 'admit' | 'needs_human' | 'reject';
    confidence: number;
  } | null;
  /**
   * 判别 rubric 代际（v1.82.0 起写入）。
   *
   * 缺省/缺失 = **v1**（2026-09-24 之前的六维快照，无 `admissionSuggestion`）；
   * `'v2'` = 含 `admissionSuggestion` 的七维 rubric。消费方按缺省处理（不得假定字段存在），
   * 校准脚本据此分代统计（跨代混算会污染一致率口径）。
   */
  rubricVersion?: string;
}

// ─── 空间成员（第二期）──────────────────────────────────

/**
 * 经验空间成员（`GET /experiences/members` 列表项）。
 *
 * 词表 `EXPERIENCE_MEMBER_ROLES`：`owner`（空间管理员：终审权 + 管理 reviewer）/
 * `reviewer`（终审人：终审权）。**人类 admin 不入表**（全局兜底，随时可行使一切成员操作）。
 * 单空间隐式单例（无 spaceId 字段——经验库是全局唯一空间，不建 space 表）。
 *
 * 存在性口径：本行只存 actorId（无 actorType FK），`actorName`/`actorType`/`avatarUrl`/
 * `deletedAt` 由运行时档案解析（`ActorProfileService`）填充——**成员行不存名，避免改名漂移**。
 */
export interface ExperienceMemberDto {
  /** 成员 Actor ID（= 表主键） */
  actorId: string;
  /** 成员类型（human / agent；system 哨兵不入表） */
  actorType?: 'human' | 'agent';
  /** 成员显示名（解析失败/真孤儿 → null，调用方自行兜底展示） */
  actorName?: string | null;
  /** 成员头像 URL（档案解析字段；无则 null） */
  avatarUrl?: string | null;
  /** 软删时间；非空 = 该成员 actor 已删除（**成员行仍在**：授权态与 actor 存活无关） */
  deletedAt?: string | null;
  /** 角色（`owner` = 空间管理员 / `reviewer` = 终审人） */
  role: ExperienceMemberRole;
  /** 授权人 actorId（授权留痕；**仅 admin/owner 请求方可见**，其余身份恒 null） */
  invitedBy?: string | null;
  /** 成为成员的时间 */
  createdAt?: string | Date;
}

/**
 * 成员列表响应（`GET /experiences/members`；**任何认证身份可读**）。
 *
 * 明文接受：成员清单对全体认证身份可见（授权透明性优先于成员隐私——平台用户是 Agent，
 * 知道"该找谁终审"比藏住名单更重要）；仅 `invitedBy` 做 admin/owner 收窄。
 */
export interface ExperienceMembersResponse {
  /** 成员列表（无分页：单空间成员量级极小，全量返回更利于消费方自筛） */
  items: ExperienceMemberDto[];
}

// ─── 判断日志（训练语料 + observe 复核数据）──────────────

/**
 * 判断日志行（`GET /experiences/judgments` 列表项）。
 *
 * **append-only**：这是事实源，条目上的 `judgment` 快照列只是缓存。**失败与跳过都落库**
 * ——"未判"（无行）与"判失败"（status=error/timeout）必须可区分。
 *
 * ⚠️ 训练语料纪律：`request.state` 是**正文节选**（≤2000 字符，带
 * `contentTruncated`/`contentLength` 标记）而非全文；命中等宽密钥闸门的行带
 * `stateRedacted` 标记（落库前 redaction 的位置标记，**纵深防御**）——训练脚本必须
 * 跳过或单独标记这些行（其存储输入 ≠ 模型实际输入）。条目**软删 ≠ 本表清除**
 * （清理由 admin 走 DB 人工窗口）。
 */
export interface ExperienceJudgmentLog {
  /** 日志行 ID */
  id: string;
  /** 所属条目 ID（**无 FK**：条目软删/硬删后日志保留，语料不随条目消失） */
  experienceId: string | null;
  /** 操作（词表 `EXPERIENCE_JUDGMENT_OPERATIONS`；本阶段恒为 `record_check`） */
  operation: ExperienceJudgmentOperation;
  /** 判别服务提供方（**当前值域 `'typesafe'`**；历史行含已退役的 `'jev'` = v1.83.0 前的自托管 MCP 网关适配器） */
  provider: string;
  /** 模型标识（provider 自报；可为 null） */
  model: string | null;
  /** 结果状态（`ok` / `error` / `timeout` / `skipped`；失败率分母 = ok+error+timeout，排除 skipped） */
  status: ExperienceJudgmentStatus;
  /** 触发本次判断的写入者类型（滥用归因 + 复核抽样；可为 null） */
  actorType?: ActorType | null;
  /**
   * 触发本次判断的写入者 ID（单 actor 判断量 top-N 观测）
   *
   * ⚠️ `actorId` 为 null 时 `actorName` **恒为 null 且不发解析查询**（无 actor 的调用走
   * 兜底额度桶 `system:unknown`，它不是一个真实 actor id——拿它去查 actors 表只会白付一次
   * 往返）。两字段**成对**使用：`actorId` 是机器可归因的键，`actorName` 是给人看的标签。
   */
  actorId?: string | null;
  /**
   * 触发本次判断的写入者**显示名**（v1.81.0）。
   *
   * 命名照 `actor_id` 列名派生（audit 先例，`actorName` 而非 `name`）。解析规则与条目
   * 投影同一份 `ActorProfileService` 契约：软删保留真名、真孤儿 → null。
   */
  actorName?: string | null;
  /** provider 往返耗时（毫秒；skipped/未调用 → null） */
  latencyMs?: number | null;
  /**
   * 判断输入（jsonb 原样）。结构 = `{questions, state}`；`status='skipped'` 时为占位
   * `{skipped:true, reason:'judgment_rate_limited'}`（**保 NOT NULL 不变量**，杜绝 23502）。
   * 序列化硬顶 16KB（超限截断 + `truncated:true`）。
   */
  request: Record<string, unknown>;
  /**
   * 判断输出（jsonb 原样）：成功 = 归一化结果 + raw 摘要；失败 = `{error}`（≤2000 字符，
   * **不含 api key、不含上游错误体**）；skipped → null。硬顶与 request 同为 16KB。
   */
  response: Record<string, unknown> | null;
  /** 落库时间（分页全序 = `created_at DESC, id DESC`，同刻多行也不错行） */
  createdAt: string | Date;
}

/**
 * 判断日志查询响应（`GET /experiences/judgments`；admin ∪ owner ∪ reviewer）。
 *
 * 参数：`operation` / `status`（`@IsIn` 白名单——拼错必须 400，不给静默空页）、
 * `experienceId`（UUID）、`from`/`to`（ISO 时间窗）、`page` + `pageSize`（**≤50**）。
 *
 * ⚠️ **导出训练集的正确姿势**：按 `from`/`to` 时间窗**切片翻页** + 每片用 `total` 自检，
 * **禁止 `page++` 裸翻**（翻页途中新写入会插入已翻过的区间，导致漏行）。
 * 单页体量上限 ≈ 50 × (16KB×2) ≈ 1.6MB——消费方据此设超时与流式处理。
 */
export interface ExperienceJudgmentsResponse {
  /** 当前页日志行（按 created_at DESC, id DESC 全序） */
  items: ExperienceJudgmentLog[];
  /** 满足过滤条件的总行数（分页前；导出时的自检基准） */
  total: number;
  /** 当前页码（1 起） */
  page: number;
  /** 每页条数（服务端上限 50） */
  pageSize: number;
}
