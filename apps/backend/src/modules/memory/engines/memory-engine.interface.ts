/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块的**引擎端口**：Chamber 账本 ↔ 引擎（Hument Hub，HTTP loopback）之间的
 *     唯一契约面。引擎是**可选增强**——端口缺席（MEMORY_ENGINE=none）时 Chamber 完全可用
 *
 * [代码职责]
 *   - `MemoryEngine`：**十三个动词**——六个写/读动词（nominate / inspectNomination / recall /
 *     correct / inspectCorrection / readMemory）+ 五个 **alpha.5/alpha.6 投影读面**（getGraphView /
 *     getMemoryView / getMemoryViewHistory / getMemoryViewRepresentation / **getMemoryRelations**）
 *     + **alpha.19 的两个 usage 读面**（getUsageSummary / getUsageTrace），均 GET、只读，全部
 *     **never-throw** + 判别式联合返回
 *   - `MemoryEngineTarget`：**per-project** 引擎调用目标（workspace / actor / credential_ref
 *     来自 `memory_projects` 注册表绑定列，**不由本层派生**）
 *   - 归一化结果形状（提名回执 / 召回 / 更正 / 记忆详情）+ 失败面（timeout / unreachable /
 *     http + error.code）
 *   - `Hument*` 前缀类型 = **Hument 合同镜像**（snake_case 原样；见 [关键不变量]）
 *   - DI token `MEMORY_ENGINE_RAW`（**裸引擎**：工厂产出，无任何包装；e2e/单测的
 *     `overrideProvider` 装配点）与 `MEMORY_ENGINE`（**服务层消费面**：裸引擎外面套
 *     `InstrumentedMemoryEngine` 做运行时健康上报；两者值都可能为 null = 关闭态）
 *   - `healthCheck()`：**仅探针使用**的就绪探测（免鉴权、无 target；结果只进探针路）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3 MemoryEngine 端口与三态 / §7 状态机映射表
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 合同事实源（只读）: Hument 仓 `contracts/openapi/hument-v1.yaml` +
 *     `contracts/schema/{memory-nomination,memory-nomination-response,memory-nomination-inspect,
 *     memory-nomination-inspect-response,memory-inspect-request,memory-inspect-response,
 *     recall-request,recall-response,memory-correction-request,memory-correction-response,
 *     memory-correction-inspect-request,error}.schema.json`
 *
 * [关键不变量]
 *   - **never-throw 是硬契约**：一切失败（超时 / DNS / 连接拒绝 / 非 2xx / 体不可解析 /
 *     缺关键 id）都落在 `{ok:false, failure}`，由**服务层**翻译成 §6 的 HTTP 语义与错误码。
 *     端口层抛异常 = 让一次外部引擎抖动变成 Chamber 500（与铁律 #9「代理层透传」同源纪律）。
 *   - **判别式联合而非"结果 + 错误标记"**：调用点必须按 `ok` 分派，新增失败分类时编译器
 *     当场点名（"忘了处理某类失败"编译期即红）。
 *   - **顶层归一化字段用 camelCase，嵌套契约对象原样 snake_case（`Hument*` 前缀）**：
 *     归一化只发生在本端口自有的顶层字段（`engineNominationId` 等，见方案 §3 的写法）；
 *     召回 items / trace、记忆详情的 memory / representations / anchors 是**合同镜像**，
 *     改名 = 每个消费点都要在脑内做一次映射（漂移源），故逐字保留。
 *     五个 **view 动词更进一步：整族零归一化**（连顶层都逐字透传，见下方 views 段的说明）。
 *   - **view 族（五读面）只发凭据头**：GET、无 body、无 `Content-Type`、**无幂等键、无诊断头**
 *     （那两者是写动词的语义：一个防重复形成、一个驱动 outcome 轴）。`workspace_id`/`actor_id`
 *     /`scope` 走 query，`scope` **恒 `actor_private`**（由本层填，不由调用方传入）。
 *     ⚠️ 第五个（`getMemoryRelations`）的**引擎路由不在 `/v1/memory-views/` 下**
 *     （合同是 `/v1/memories/{memory_id}/relations`，与 `…/sources` 同族），但 query 三件套
 *     与 header **逐字复用**同一套派生（合同的 `Relation{WorkspaceID,ActorID,Scope}` 三个
 *     参数都是 `required: true`，`scope` 的值域同样只有 `actor_private`）。
 *   - **query 只拼已校验的字段**：未填即 `undefined` ⇒ **该键不出现在 URL 上**——平台不设自己的
 *     默认值，引擎默认档生效并在响应 `budget` 里回声（自设默认值 = 响应 budget 与平台认知两个真相）。
 *   - **`created_from`/`created_to` 逐字字符串**：引擎侧是 `*time.Time`，平台若做 Date 转换会把
 *     RFC3339 变成别的串（`String(date)` = RFC2822）被引擎 400。**校验在 DTO、透传在引擎**。
 *   - **`temporal_context` 一期不发送**（方案 §3）：Hument 合同允许该字段，但 Chamber 无
 *     可信时间上下文来源，自造时间戳 = 把幻觉写进形成正文的输入面。
 *   - **`target` 不由本层派生**：workspace / actor / credential_ref 全部来自调用方（注册表），
 *     引擎**不认识**项目、绑定、权限——任何"引擎自己找 workspace"的设计都会把权限判定
 *     从 Chamber 侧偷走。
 *   - **`name` 与 config 值域同域**（`none|fake|hument`）；关闭态**不用 Noop 类**：`MEMORY_ENGINE`
 *     token 的值就是 `null`，服务层的 `assertEngineAvailable` 是唯一的闸（见工厂文件头）。
 *   - **双 token 的分工不可合并**：`MEMORY_ENGINE_RAW` 是**装配层**（工厂产出原样实现），
 *     `MEMORY_ENGINE` 是**观测层**（`InstrumentedMemoryEngine` 包装 + 健康上报）。服务层只认
 *     后者；e2e/单测只 replace 前者——这样包装层在生产与测试里**走同一条路径**（测试替身
 *     不绕过观测层，否则"上报逻辑没被装配"这类缺陷永远测不出来）。
 *   - **`healthCheck` 不是第十四个业务动词**：它没有 `target`（免鉴权、不落任何平台状态），
 *     且**不走健康上报**（结果只进探针路，见 `InstrumentedMemoryEngine` 的注释）——把它与
 *     业务动词混计会让探针每 2 分钟给自己记一次"业务调用成功/失败"。
 *   - **幂等键不由本层拼**（在 hument.engine 内按路由固定拼装）：`nominate` = `chamber-<账本id>`、
 *     `correct` = `chamber-correct-<新账本id>`、`recall` = 每次新 uuid——拼装规则单源在引擎实现，
 *     调用方只给**账本 id**（自造键 = 同一次提名在重发时变成两次形成）。
 *
 * [关联代码]
 *   - hument.engine.ts — 唯一真联网实现（十三端点 + 固定 header；`requestJson` 是唯一传输原语）
 *   - fake.engine.ts — 进程内确定性实现（**仅 test/e2e**；production MEMORY_ENGINE=fake fail-fast）
 *   - formation-state.mapper.ts — 本端口产出信号 → §7 formation_state 的纯函数映射
 *   - memory-engine.factory.ts — `MEMORY_ENGINE` token 的装配（none → null）
 *   - ../../config/memory.config.ts — engine / baseUrl / timeoutMs 来源
 *   - ../ledger.repository.ts — 重放用账本读（`findForReplay`，`chamber-<账本id>` 的 id 来源）
 *   - ../memory-views.service.ts — view 五动词的唯一消费方（权限过滤 + 信封装配）
 *
 * [持久踩坑]
 *   MEMORY-ENGINE-THROW(引擎异常穿透): 在端口层 `throw` 会把"Hub 没起来"变成请求 500，
 *     而 memory 是可选增强——正确形态是 `{ok:false, failure:{kind:'unreachable'}}` →
 *     服务层 503 + `MEMORY_UNAVAILABLE(14000)`（文案含 reason）。安全方向: 全部 catch。
 *   MEMORY-SNAKE-RENAME(snake→camel 批量改名): 对召回 items / 记忆详情做"顺手归一化"，
 *     会让每一个消费点的字段名都要重新对照合同核验（且合同新增字段时静默丢字段）。
 *     安全方向: 只归一化端口自有的顶层字段，契约对象逐字透传（view 族整族不归一化）。
 *
 * [修改检查]
 *   □ 已读 [权威文档] + Hument 合同，确认字段名/必填/上限与合同一致（**禁止凭记忆写字段**）
 *   □ 新增动词必须同步：工厂分派 + hument/fake 两个实现 + 单测矩阵 + 服务层错误映射
 *     ⚠️ **`ScriptedEngine implements MemoryEngine`（test/memory.e2e-spec.ts）也必须补同名方法**
 *     ——jest-e2e 的 ts-jest 未关 diagnostics，漏一个接口实现就整包红
 *   □ 新增失败分类必须给出 §7 映射（`formation-state.mapper.ts` 的哪一行）与调用方动作
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { MemoryEngineName } from '../../../config/memory.config';

/**
 * DI token（工厂的装配点；值为 `MemoryEngine` 实例，**关闭态为 `null`**）。
 *
 * ⚠️ **字符串值不可改**：e2e/单测按它 `overrideProvider` 注入 FakeEngine，改名 = 静默落到
 * 真实现（真的会去打 Hub，而测试全绿）。
 */
export const MEMORY_ENGINE = 'MEMORY_ENGINE';

/**
 * DI token：**裸引擎**（未包装的 `HumentEngine` / `FakeEngine`；关闭态为 `null`）。
 *
 * ⚠️ **字符串值不可改**：e2e/单测按它 `overrideProvider` 注入替身（包装层由工厂在它外面套
 * `InstrumentedMemoryEngine`）——改名 = 静默落到真实现（真的会去打 Hub，而测试全绿）。
 *
 * 与 `MEMORY_ENGINE` 的分工见文件头不变量「双 token 的分工不可合并」。
 */
export const MEMORY_ENGINE_RAW = 'MEMORY_ENGINE_RAW';

/**
 * 引擎调用目标（**per-project**；全部来自 `memory_projects` 注册表绑定列，不由本层派生）。
 *
 * ⚠️ `credentialRef` **非机密**（Hument 合同：non-secret binding credential reference）——
 * 但它仍是绑定凭据的引用，**不进日志、不进遥测**（只在 HTTP 头上出现）。
 */
export interface MemoryEngineTarget {
  /** Hument workspace（`memory_projects.engine_workspace_id`；每项目独立 workspace） */
  workspaceId: string;
  /** Hument actor（`memory_projects.engine_actor_id`；服务 actor，不落用户身份） */
  actorId: string;
  /** 绑定凭据引用（`memory_projects.engine_credential_ref`；→ `X-Hument-Credential-Ref`） */
  credentialRef: string;
}

/**
 * 引擎失败分类（**固定四值**，见文件头 never-throw 与 §7 映射）。
 *
 * - `timeout`：客户端超时（**无回执**）⇒ §7 归 `unknown`（Chamber 不可恢复，同 key 重发）
 * - `unreachable`：连接拒绝 / DNS / TLS / 重定向被拒（**请求未到达**）⇒ §7 归 `failed`
 * - `http`：拿到非 2xx 回执（带 `httpStatus` + 解析出的 `engineCode` / `retryable`）
 * - `invalid_response`：2xx 但体不可解析或缺关键 id（Hument 合同违规 / 中间层改写）
 *   ⇒ §7 落到**默认行**（`unknown`，fail-safe，绝不落 committed）
 */
export type MemoryEngineFailureKind = 'timeout' | 'unreachable' | 'http' | 'invalid_response';

/**
 * Hument **admission 失败因**（`error.details.admission_cause`；合同值域 = 闭合三值）。
 *
 * 值域单源 = Hument 仓 `internal/domain/memory_nomination_admission.go`：
 * - `prefix_unresolved`：namespace 前缀未结算（**两分支**：早先提名在途 / 终拒未结算）
 * - `quota_exceeded`：scope + workspace + actor 三元配额耗尽
 * - `exact_content`：内容完全重复（同 digest 的 current representation 已存在）
 *
 * ⚠️ **闭合词表**：未登记的值一律丢弃（不猜第四因）——前向兼容靠"兜底桶"而不是推断。
 */
export const HUMENT_ADMISSION_CAUSES = [
  'prefix_unresolved',
  'quota_exceeded',
  'exact_content',
] as const;

/** admission 失败因（见 {@link HUMENT_ADMISSION_CAUSES}） */
export type HumentAdmissionCause = (typeof HUMENT_ADMISSION_CAUSES)[number];

/**
 * Hument **failure class**（`diagnostics.failure.failure_class`；合同值域 = 闭合三值）。
 *
 * 值域单源 = Hument 仓 `internal/domain/formation.go` 的 `FormationAttemptFailureClass`。
 * ⚠️ 它是**引擎自报证据**（provenance），平台的**唯一动作权威**是 `hintCode` / `formationState`
 * ——`failureClass` 永不单独驱动重试。
 */
export const HUMENT_FAILURE_CLASSES = [
  'retryable_transient',
  'terminal_rejection',
  'provider_outcome_unknown',
] as const;

/** 引擎自报失败类别（见 {@link HUMENT_FAILURE_CLASSES}） */
export type HumentFailureClass = (typeof HUMENT_FAILURE_CLASSES)[number];

/**
 * 引擎失败面（**不含上游错误体原文**）。
 *
 * Hument 错误体形状 = `{error:{code,message,request_id,retryable,details}}`；我们**解析不丢**
 * `code` / `retryable` / `request_id`（方案 §3：三者落遥测，§7 的 error.code 三族靠它分派），
 * 但**不搬运 `message` / `details` 原文**——错误体可能回显请求片段（判决/判别的同类踩坑
 * JUDGMENT-ERROR-BODY 同族：日志会成为回显通道）。
 *
 * **窄化例外（b4d41314）**：`details` 里只放行白名单键 `admission_cause`（闭合三值），
 * 因为 409 的处置动作**逐因不同**（等一轮 retry / 退避 retry / 放弃），而原因只在那个键里。
 * 其余 `details` 键继续整体丢弃。
 */
export interface MemoryEngineFailure {
  /** 失败分类（调用方据此落 §7 映射行，勿只看 message 文案） */
  kind: MemoryEngineFailureKind;
  /** 固定诊断文案（**不含上游原文**；排障靠 kind + httpStatus + engineCode 三件套） */
  message: string;
  /** `kind='http'` 时的 HTTP 状态码 */
  httpStatus?: number;
  /** Hument `error.code`（如 `binding_not_found` / `invalid_argument` / `overloaded`） */
  engineCode?: string;
  /** Hument `error.retryable`（方案 §7 的 error.code 三族分派依据之一） */
  retryable?: boolean;
  /** Hument `error.request_id`（回执体）或响应头 `X-Request-ID`（两者取先解析到的） */
  requestId?: string;
  /**
   * 引擎 admission 失败因（**仅** `409 ∧ error.code='conflict' ∧ retryable=false` 时才可能在场）。
   *
   * ⚠️ HTTP 错误体只有这一个诊断键（另有既有的 `requestId`）：`engineReasonCode` /
   * `errorDetail` / `failureClass` **只存在于 200 回执**的 `diagnostics` 里，放在本接口上就是
   * 死字段。故 503 的 `data.engineDiagnostics` **只会含 `{requestId}`**。
   */
  admissionCause?: HumentAdmissionCause;
  /**
   * 上游 429 的 `Retry-After`（**秒**；仅在 `httpStatus=429` 且头是合法非负整数时在场）。
   *
   * Usage 读面按它透出平台 429 + `Retry-After`；其他动词不消费（保持 `undefined`）。
   */
  retryAfterSeconds?: number;
  /**
   * Usage 读面的**平台侧**拒绝因（**不是上游文本**；`kind='invalid_response'` 时由本层
   * normalizer 判定，见 `hument.engine.ts` 的 usage 段）。
   *
   * - `target_mismatch`：响应 `target.workspace_id/actor_id/scope` 与请求目标不符
   *   （服务层 → `engine_identity_invalid`，不是版本信号）
   * - `schema_mismatch`：`schema_version`/`time_basis`/必需容器不符（服务层 → 版本不支持）
   * - `cursor_invalid`：`has_more=true` 但 `next_cursor` 为空/非字符串（回执不可信）
   */
  usageRejection?: 'target_mismatch' | 'schema_mismatch' | 'cursor_invalid';
  /** 本次调用耗时（毫秒；超时也记实际等待时长） */
  latencyMs: number;
}

/**
 * 引擎调用结果（判别式联合；**永不 throw**，见文件头）。
 *
 * @typeParam T 成功面的归一化产物（提名回执 / 召回 / 更正 / 记忆详情）
 */
export type MemoryEngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: MemoryEngineFailure };

/**
 * 提名回执（归一化**顶层**字段；方案 §3 端口签名逐字）。
 *
 * ⚠️ `jobState` / `outcome` / `reasonCode` / `durable` **都是可选的**——Hument 合同里它们
 * 不在 `memory-nomination-response` 的 required 列表内（`job_state` / `canonical_nomination_id`
 * / `memory_id` / `error_code` 均可缺席）。把可选写成必填 = 逼实现方造假值。
 */
export interface MemoryNominationResult {
  /** 引擎侧提名 ID（Hument `nomination_id`；落 `memory_nominations.engine_nomination_id`） */
  engineNominationId: string;
  /**
   * canonical 提名 ID（alias 回执才有意义；落 `engine_canonical_nomination_id`）。
   * canonical 行自身通常不带（或等于本行），**alias 行恒不带 ids**（方案 §2）。
   */
  canonicalNominationId?: string;
  /** 引擎判定为重复（alias）：本行不形成新记忆，映射只认 canonical 行 */
  duplicate: boolean;
  /** Hument `job_state` 原值（**不是** formation_state；§7 回退轴） */
  jobState?: string;
  /** 引擎明示延后（§7：`outcome=deferred` 或本标志 ⇒ `submitted` + 同 key 重发） */
  deferred: boolean;
  /** `diagnostics.outcome`（**§7 优先轴**；缺 header 时缺席 ⇒ 回退 job_state） */
  outcome?: string;
  /**
   * `diagnostics.reason_code`（**§7 同轴并列**；合同闭合枚举含
   * `no_change_validated` / `provider_outcome_unknown` / `provider_rejected` /
   * `validation_rejected` / `stored_diagnostic_invalid` 等）。
   */
  reasonCode?: string;
  /**
   * `diagnostics.failure.error_detail`（**仅 `outcome ∈ {rejected, unknown}` 出现**；
   * 合同闭合枚举 60+ 值，平台只做形态门、不硬编词表——越界整值丢弃）。
   *
   * ⚠️ 它是**引擎自报证据**：动作权威仍是 `hintCode` / `formationState`。
   */
  errorDetail?: string;
  /** `diagnostics.failure.failure_class`（同上，闭合三值；证据而非动作依据） */
  failureClass?: HumentFailureClass;
  /** 引擎形成的记忆 ID 列表（`diagnostics.mutation.memory_ids`；**committing 不采纳**） */
  memoryIds: string[];
  /** 引擎自报可重试性（提名回执的 `error_code` 场景 + 错误体 `retryable` 的合流处） */
  retryable?: boolean;
  /** 引擎侧错误码（提名回执 `error_code` 或错误体 `error.code`） */
  engineCode?: string;
  /** 回执 `request_id` / 响应头 `X-Request-ID`（遥测用） */
  requestId?: string;
  /**
   * 提名是否已耐久落盘（Hument `durable`）。
   * ⚠️ `false` ⇒ §7 「请求未到达」行（`failed` + 同 key 重发安全）。
   */
  durable?: boolean;
}

/** 提名入参（装配与截断由服务层完成，本层只负责发包） */
export interface NominateMemoryInput {
  /** 账本行 id（幂等键来源：`chamber-<账本id>`；方案 §3 定死，**调用方不自造键**） */
  ledgerId: string;
  /** 记忆类别（Hument `category`：描述性提示，≤64 UTF-8 bytes） */
  category: string;
  /**
   * 形成正文（方案 §4 装配产物或 contentOverride；Hument 上限 8192 **字符**
   * （合同 `maxLength: 8192`），平台侧另按 8192 UTF-8 bytes 截断）。
   * ⚠️ **重放必须用账本冻结原文**（`findForReplay`），永不重装配。
   */
  content: string;
  /** 审计理由（Hument ≤1024；平台侧同闸；**永不截断**——它进形成正文的关键依据区） */
  rationale: string;
  /** 来源 locator（`chamber://...`；Hument `source_locators` ≤4） */
  sourceLocators: string[];
}

/**
 * 提名 inspect 入参（**纯只读，不推进 job**；方案 §3）。
 *
 * 二选一（Hument 合同 `oneOf`）：给 `nominationId` 或 `memoryId`，**不得同时给**。
 * 用判别式联合在编译期挡住"两个都给"。
 */
export type InspectNominationInput =
  | { nominationId: string; memoryId?: never }
  | { memoryId: string; nominationId?: never };

/** 召回入参（方案 §3：`mode` 定死 `manual`、`scopes` 缺省、`view` 透传、预算三参透传） */
export interface RecallMemoryInput {
  /** 查询词（Hument ≤16384 字符，required） */
  query: string;
  /** 视图（`current` | `history`；**透传**，由调用方决定） */
  view?: string;
  /** 预算：最大条数（Hument `max_items` ≤128） */
  maxItems?: number;
  /** 预算：最大 token（Hument `max_tokens` ≤262144） */
  maxTokens?: number;
  /** 预算：最大字节（Hument `max_bytes` ≤1048576） */
  maxBytes?: number;
  /** 上下文身份（Hument required；**由调用方传入**——引擎不派生，方案 §3） */
  contextIdentity: string;
  /** 上下文世代（Hument required；同上） */
  contextEpoch: number;
}

/** 更正入参（方案 §3：`rationale` 用**冻结原文**，绝不重装配） */
export interface CorrectMemoryInput {
  /** 新账本行 id（幂等键来源：`chamber-correct-<新账本id>`；方案 §3 定死） */
  newLedgerId: string;
  /** 被更正的旧 memory id（须已形成且 active——由调用方预检，引擎只负责发包） */
  oldMemoryId: string;
  /** 更正后的新 memory id（须已形成且 active） */
  newMemoryId: string;
  /** 审计理由（冻结原文；≤1024 UTF-8 bytes；Hument 侧声明"永不作为来源权威"） */
  rationale: string;
}

/**
 * 更正 inspect 入参（**纯只读**）：按 `correctionId` 或幂等键二者之一。
 *
 * rationale：§6 更正"中断同参续跑"与 §7 恢复通道都需要**先看回执再决定**；Hument 合同
 * 的 `memory-correction-inspect-request` 正是这个面（`oneOf`：correction_id | idempotency_key）。
 */
export type InspectCorrectionInput =
  | { correctionId: string; idempotencyKey?: never }
  | { idempotencyKey: string; correctionId?: never };

/** 更正回执（归一化顶层） */
export interface MemoryCorrectionResult {
  /** 引擎侧更正 ID（落 `memory_nominations.engine_correction_id`） */
  engineCorrectionId: string;
  /** 回执回带的旧 memory id（对账用） */
  oldMemoryId?: string;
  /** 回执回带的新 memory id（对账用） */
  newMemoryId?: string;
  /**
   * 是否幂等重放命中（Hument `replay`）：`true` = 该更正**早已落库**，本次只是回放回执。
   * ⚠️ 中断续跑（同 key 重发）靠它区分"已达成"与"刚达成"。
   */
  replay?: boolean;
}

/**
 * 召回条目（**Hument 合同镜像**，snake_case 逐字；`recall-response.schema.json` items）。
 *
 * 只镜像合同的 required + 可选字段，**不加索引签名**：合同是
 * `additionalProperties: false`，多出来的键本就不该存在；加签名会让字段名写错静默通过。
 */
export interface HumentRecallItem {
  memory_id: string;
  namespace_id: string;
  representation_id: string;
  kind: string;
  scope: string;
  resolution: string;
  available_resolution: string;
  active_resolution: string;
  body: string;
  digest: string;
  score: number;
  byte_estimate: number;
  token_estimate: number;
  anchor_state: string;
  current: boolean;
  memory_status: string;
  currentness_digest: string;
  anchor_projection_digest: string;
  /** 条目锚（可选） */
  anchors?: HumentRecallAnchor[];
  /** 矛盾摘要（可选） */
  contradiction_digest?: string;
  /** 取代摘要（可选） */
  supersession_digest?: string;
  /** 记忆创建时刻（可选） */
  memory_created_at?: string;
  /** 表示创建时刻（可选） */
  representation_created_at?: string;
  /** 深读入口（可选；本层不透传语义） */
  depth_entry?: Record<string, unknown>;
}

/** 召回条目内的锚（Hument 合同镜像；`recall-response.schema.json` items[].anchors） */
export interface HumentRecallAnchor {
  anchor_id: string;
  source_ref: string;
  external_revision: string;
  content_digest: string;
  state: string;
}

/**
 * 召回追踪（**Hument 合同镜像**，snake_case 逐字）。
 *
 * 只镜像 required 字段 + `chosen_resolution` / `advisory` / `shadow` 三个可选关键位；
 * 复合字段（budget / candidates / watermarks / advisory）保持 `unknown`——平台侧只用它落
 * 遥测（条数 / 过滤数），**不做语义消费**（方案 §6 recall 响应由账本侧装配）。
 */
export interface HumentRecallTrace {
  policy_version: string;
  query_digest: string;
  binding_id: string;
  presentation_event_id: string;
  source_scopes: string[];
  home_cell_id: string;
  coordinator_scope: string;
  watermarks: unknown[];
  candidates: unknown[];
  suppressed_item_ids: string[];
  selected_item_ids: string[];
  budget: Record<string, unknown>;
  provider_calls: number;
  presentation_pending: boolean;
  chosen_resolution?: string;
  shadow?: unknown;
  advisory?: Record<string, unknown>;
}

/** 召回结果（归一化顶层 + 合同镜像嵌套；方案 §3） */
export interface MemoryRecallResult {
  /** 引擎侧召回 ID（Hument `recall_id`；落 `memory_recall_events.engine_recall_id`） */
  recallId: string;
  /** 呈现事件 ID（Hument `trace.presentation_event_id` 或顶层 `presentation_event_id`） */
  presentationEventId?: string;
  /** 召回条目（合同镜像） */
  items: HumentRecallItem[];
  /** 执行追踪（合同镜像） */
  trace: HumentRecallTrace;
}

/** 记忆详情（**Hument 合同镜像**；`memory-inspect-response.schema.json` memory 对象） */
export interface HumentMemoryDetail {
  memory_id: string;
  namespace_id: string;
  kind: string;
  workspace_id: string;
  actor_id: string;
  scope: string;
  available_resolution: string;
  active_resolution: string;
  status: string;
  provenance: Record<string, unknown>;
  confidence?: number | null;
  evidence: string[];
  contradiction: string[];
  /** 取代链（**在 memory 内部**——服务层据此装配召回项的 supersession 语义） */
  supersession: string[];
  created_at: string;
}

/** 记忆表示（**Hument 合同镜像**；≤5 条） */
export interface HumentMemoryRepresentation {
  representation_id: string;
  namespace_id: string;
  memory_id: string;
  revision_id: string;
  mutation_id: string;
  source_ref: string;
  current: boolean;
  resolution: string;
  body: string;
  digest: string;
  created_at: string;
}

/** 记忆锚（**Hument 合同镜像**；≤128 条） */
export interface HumentMemoryAnchor {
  anchor_id: string;
  namespace_id: string;
  memory_id: string;
  binding_id: string;
  adapter: string;
  source_ref: string;
  external_revision: string;
  content_digest: string;
  source_receipt_id: string;
  source_receipt_digest: string;
  last_checked_at: string;
  revalidation_state: string;
}

/**
 * 记忆详情结果（**响应拍平**：`memory` / `representations` / `anchors` 三层原样，方案 §3）。
 *
 * ⚠️ **不重排、不裁剪**：`representations ≤5` / `anchors ≤128` 是 Hument 的返回上界，
 * 本层不得再自行截断（截断会让"为什么这条记忆只有 3 个表示"变成不可考）。
 */
export interface MemoryReadResult {
  memory: HumentMemoryDetail;
  representations: HumentMemoryRepresentation[];
  anchors: HumentMemoryAnchor[];
  /** Hument `partial`：本次投影是否被服务端裁剪（`true` = 非完整视图，须透出） */
  partial: boolean;
}

// ══════════════════════════════════════════════════════════════════════════
// Memory view（引擎投影读面；hument alpha.5 四读面 + alpha.6 关系建议读面 =
// graph / detail / history / representation / **relations**）
//
// ⚠️ **整族逐字透传，本层零归一化**（与召回/详情不同）：五个响应 schema 全是
// `additionalProperties: false`，任何"顺手 camelCase"都会让平台层的 `engine` 块与合同漂移，
// 且合同新增字段时静默丢失（`MEMORY-SNAKE-RENAME` 同族）。故结果类型一律 `Hument*` 前缀 +
// snake_case 字段，**原样塞进响应**（服务层只过滤 `nodes[]` / `edges[]` / `cases[]` 的
// **内容**，不改形状）。
//
// ⚠️ 第五个 `HumentMemoryRelations` 的镜像形状**不在本段**（它自成一段，见文件尾）：
// 它虽然与前面四个同属"引擎投影读面"，但合同上不是 `memory-view-*` 家族
// （路由 = `/v1/memories/{memory_id}/relations`，schema = `memory-relations-response`）。
//
// 合同事实源（只读）: `contracts/schema/memory-view-{memory-graph-response,memory-detail-response,
// representation-history-response,representation-detail-response,target}.schema.json` +
// `workbench-projection-page` / `workbench-graph-edge` / `workbench-representation-body` /
// `workbench-relation-audit-locator`，以及 `contracts/openapi/hument-v1.yaml` 的 `MemoryView*` 参数。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 投影分页块（合同 `workbench-projection-page.schema.json`；四响应共用）。
 *
 * ⚠️ `total_kind` 是合同 `const: "exact"`——**它必须留在镜像里**：`total` 只有在"精确计数"
 * 的口径下才能当进度条分母用，丢了它消费方就无从判断分母可不可信。
 */
export interface HumentProjectionPage {
  total: number;
  total_kind: 'exact';
  loaded: number;
  next_cursor: string;
  partial: boolean;
  truncated: boolean;
  truncation_reason: string;
}

/** 视图目标回声（合同 `memory-view-target.schema.json`；服务端认定的调用上下文，非请求体） */
export interface HumentMemoryViewTarget {
  target_id: string;
  workspace_id: string;
  actor_id: string;
  binding_id: string;
  scope: string;
}

/** 关系边的审计定位器（合同 `workbench-relation-audit-locator.schema.json`） */
export interface HumentRelationAuditLocator {
  status: string;
  journal_event_id: string;
  revision_id: string;
  mutation_id: string;
}

/** 关系边（合同 `workbench-graph-edge.schema.json`；graph `edges[]` 与 detail `relations.items[]` 同形） */
export interface HumentGraphEdge {
  relation_id: string;
  from_id: string;
  to_id: string;
  /** 五类（值域单源 = shared `MEMORY_VIEW_RELATION_TYPES`） */
  type: string;
  created_at: string;
  audit_locator: HumentRelationAuditLocator;
}

/** graph 节点（合同 `memory-view-memory-graph-response` 的 `nodes[]`） */
export interface HumentGraphNode {
  memory_id: string;
  kind: string;
  scope: string;
  status: string;
  active_resolution: string;
  available_resolution: string;
  /** 展示标签（契约上限 80） */
  label: string;
  /** 预览片段（**契约上限 512，引擎默认档 160**——平台不自设默认值，未传即引擎默认） */
  preview: string;
  label_resolution: string;
  /** `confidence` 是否存在（**不是**置信度本身：graph 面刻意不吐置信度值） */
  confidence_present: boolean;
  contradiction_count: number;
  supersession_count: number;
  anchor_state: string;
  /** 边界标记（引擎语义；平台只透传） */
  boundary: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * graph 响应的 `filters` 回声（合同 `memory-view-memory-graph-response` 的 `filters`）。
 *
 * ⚠️ **这是响应域，比请求域多一个 `any`**（六个过滤器键各多一个 `any` = "本维度未过滤"）。
 * 请求 DTO 只用请求域（shared `MEMORY_VIEW_GRAPH_FILTERS_ANY` 单列了这条不对称）。
 */
export interface HumentGraphFiltersEcho {
  kind: string;
  status: string;
  active_resolution: string;
  available_resolution: string;
  anchor_state: string;
  created_from: string | null;
  created_to: string | null;
  relation_type: string;
}

/** graph 响应的预算回声（合同 `budget`；**真实生效值**，含引擎默认档） */
export interface HumentGraphBudget {
  node_limit: number;
  edge_limit: number;
  neighborhood_limit: number;
  preview_scalars: number;
  depth: number;
}

/** graph 响应（合同 `memory-view-memory-graph-response.schema.json` 全文） */
export interface HumentMemoryGraphView {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: HumentMemoryViewTarget;
  snapshot_digest: string;
  mode: string;
  center_memory_id: string;
  filters: HumentGraphFiltersEcho;
  budget: HumentGraphBudget;
  node_page: HumentProjectionPage;
  edge_page: HumentProjectionPage;
  /**
   * 被省略的边数 = 命中任一**已加载节点**的边数 − 实际返回数。
   *
   * ⚠️ browse 边只取**两端点都在本次节点页内**的边 ⇒ 端点分落两页的边**永远画不出来**，
   * 这不是"边不存在"（平台侧治理条必须写明，防误判）。
   */
  omitted_edge_count: number;
  nodes: HumentGraphNode[];
  edges: HumentGraphEdge[];
  redaction: string;
}

/** 引擎侧记忆元数据（detail 的 `memory` 对象；**与 19.16 的 `HumentMemoryDetail` 不同形**——
 * 那个多 `namespace_id`/`workspace_id`/`actor_id`，本形多 `updated_at`/`confidence_present`） */
export interface HumentViewMemoryDetail {
  memory_id: string;
  kind: string;
  scope: string;
  status: string;
  available_resolution: string;
  active_resolution: string;
  /** 来源全谱（**与内容同级可见**，见 views 族注释） */
  provenance: Record<string, unknown>;
  confidence_present: boolean;
  confidence: number | null;
  evidence: string[];
  contradiction: string[];
  supersession: string[];
  created_at: string;
  updated_at: string;
}

/**
 * 分辨率阶梯槽（合同 `ladder[]`，**恒 5 项** = R0..R4 各一）。
 *
 * `current` 就是**一份完整的表示正文**（≤64KiB）：前端拿到 detail 即可直接渲染当前正文，
 * **不必再请求** representation 端点。
 * `historical_count` **每个槽都带**——同一 (memory, resolution) 恰好一行 `is_current=1`，
 * 旧行计入该计数，故"有当前"与"有旧版本"可以并存（重新形成后的常态）。
 */
export interface HumentLadderSlot {
  resolution: string;
  state: string;
  /** = 默认呈现层级（**必填布尔**；与 `available_resolution` 不是一回事） */
  active: boolean;
  current: HumentRepresentationBody | null;
  historical_count: number;
}

/** 表示正文（合同 `workbench-representation-body.schema.json`；正文 ≤64KiB） */
export interface HumentRepresentationBody {
  representation_id: string;
  resolution: string;
  revision_id: string;
  mutation_id: string;
  source_ref: string;
  current: boolean;
  body: string;
  digest: string;
  original_bytes: number;
  body_truncated: boolean;
  created_at: string;
}

/** 锚（合同 detail `sections.anchors.items[]`；≤128） */
export interface HumentViewAnchor {
  anchor_id: string;
  adapter: string;
  source_ref: string;
  external_revision: string;
  content_digest: string;
  source_receipt_id: string;
  source_receipt_digest: string;
  last_checked_at: string;
  revalidation_state: string;
}

/** detail 响应（合同 `memory-view-memory-detail-response.schema.json` 全文） */
export interface HumentMemoryViewDetail {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: HumentMemoryViewTarget;
  snapshot_digest: string;
  memory: HumentViewMemoryDetail;
  sections: {
    representations: { page: HumentProjectionPage; ladder: HumentLadderSlot[] };
    anchors: { page: HumentProjectionPage; items: HumentViewAnchor[] };
    relations: { page: HumentProjectionPage; items: HumentGraphEdge[] };
  };
  redaction: string;
}

/**
 * 历史版本条目（合同 history `items[]`；≤100）。
 *
 * ⚠️ `current` **引擎只查 `is_current = 0` ⇒ 恒 false**（前端不渲染这个标记）；
 * `preview` 上限 4KiB（比 graph 节点的 preview 宽松一个量级）。
 */
export interface HumentRepresentationHistoryItem {
  representation_id: string;
  resolution: string;
  revision_id: string;
  mutation_id: string;
  current: boolean;
  preview: string;
  digest: string;
  original_bytes: number;
  preview_truncated: boolean;
  created_at: string;
}

/** history 响应（合同 `memory-view-representation-history-response.schema.json` 全文） */
export interface HumentMemoryViewHistory {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: HumentMemoryViewTarget;
  snapshot_digest: string;
  memory_id: string;
  resolution: string;
  page: HumentProjectionPage;
  items: HumentRepresentationHistoryItem[];
  redaction: string;
}

/** representation 响应（合同 `memory-view-representation-detail-response.schema.json` 全文） */
export interface HumentMemoryViewRepresentation {
  schema_version: string;
  request_id: string;
  auth_kind: string;
  authority: string;
  target: HumentMemoryViewTarget;
  snapshot_digest: string;
  memory_id: string;
  representation: HumentRepresentationBody;
  redaction: string;
}

/**
 * graph 查询入参（**Hument 合同参数的全集镜像**，15 字段；snake_case 逐字 = 直接进 query）。
 *
 * 由调用方的 DTO 决定**填哪些**：未填即 `undefined`、**不进 query**（平台不设自己的默认值，
 * 引擎默认档生效并在响应 `budget` 里回声）。
 *
 * v1 的平台 DTO 只暴露其中 12 个：`mode` / `center_memory_id` / `neighborhood_limit`
 * （neighborhood 模式）本批缓行——**入参类型仍是全集**（引擎能力不因为本批 UI 选择而缩水）。
 */
export interface HumentMemoryGraphViewQuery {
  /** `browse` | `neighborhood`（v1 平台不发 ⇒ 引擎默认 browse） */
  mode?: string;
  center_memory_id?: string;
  kind?: string;
  status?: string;
  active_resolution?: string;
  available_resolution?: string;
  anchor_state?: string;
  /** RFC3339 字符串**逐字透传**（引擎侧是 `*time.Time`；平台侧禁止 Date 转换——`String(date)`
   * 会变成 RFC2822 串被引擎 400） */
  created_from?: string;
  created_to?: string;
  relation_type?: string;
  node_limit?: number;
  edge_limit?: number;
  neighborhood_limit?: number;
  preview_scalars?: number;
  /** 翻页游标（**同时绑 snapshot 与 query_digest**：携 cursor 改任一过滤器 ⇒ 引擎 400） */
  cursor?: string;
}

/** detail 的关系分页入参（合同 `relation_limit` / `relation_cursor`；两个都可选） */
export interface HumentMemoryViewRelationsQuery {
  relation_limit?: number;
  relation_cursor?: string;
}

/** history 分页入参（合同 `history_limit` / `cursor`） */
export interface HumentMemoryViewHistoryQuery {
  history_limit?: number;
  cursor?: string;
}

// ══════════════════════════════════════════════════════════════════════════
// 关系建议读面（hument alpha.6；`GET /v1/memories/{memory_id}/relations`）
//
// 合同事实源（只读）: `contracts/schema/memory-relations-response.schema.json` 全文 +
// `contracts/openapi/hument-v1.yaml` 的 `Relation{WorkspaceID,ActorID,Scope}` 参数
// （三者**都是 required**，`scope` 值域只有 `actor_private`）。
//
// ⚠️ **这是"JEV 判定的语义关系建议"，与 detail 的 `sections.relations`（引擎内拓扑/更正链）
// 是两件事**：后者是记忆之间**已落库的边**（`derived_from`/`supports`/… 五类，审计定位器齐），
// 本读面是 JEV 对"新记忆 vs 候选旧记忆"给出的**作者自报**分类建议
// （`duplicate`/`supplement`/`supersedes`/`conflict`/`unrelated`/`uncertain`），
// **不落库、不调 Jev、也不改变任何关系**（schema 里 `advisory_only` 是 `const: true`）。
//
// ⚠️ 枚举字段一律 `string` + 注释（与 graph/detail 同款）：合同新增枚举值时平台不需要改一行
// 代码就继续透传；把枚举写成字面量联合 = 平台多一份与合同竞速的值域副本。
// ⚠️ **唯独两个 `const` 写成字面量类型**（`source_state` / `advisory_only`）：它们是 schema 里的
// **信任语义常量**（"作者自报"+"仅建议"），不是可扩展的值域——类型层钉住它们，
// 消费方读这两个字段时拿到的就不是"某个字符串"而是"合同级承诺"。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 批量关系的用量（合同 `advisories[].usage`；三键**都可选**——引擎全 0/未计时时整个对象可为 `{}`）。
 *
 * `cost_micros` 是**微元**（1e-6 计价单位）不是分：消费方做金额换算前先确认币种口径（合同未声明）。
 */
export interface HumentRelationAdvisoryUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost_micros?: number;
}

/**
 * 本次判定的**覆盖度**（合同 `advisories[].coverage`）。
 *
 * `status` / `reason` 是**值域开放**的字符串（合同只声明 `type: string`，没给 enum）——
 * 平台不得为它编造值域；`orient_truncated` / `budget_incomplete` 是"这次判定**没看全**"的
 * 两个显式信号（任一为 true ⇒ 结论不完整，消费方不该把"没有这条关系"读成"确定无关"）。
 */
export interface HumentRelationAdvisoryCoverage {
  /** 被判定的新记忆（= 请求路径上的那条） */
  new_memory_id: string;
  status: string;
  reason?: string;
  /** 参评的候选旧记忆条数（**引擎侧口径**：未经平台来源过滤） */
  candidate_count: number;
  orient_truncated: boolean;
  budget_incomplete: boolean;
}

/**
 * 一条关系建议（合同 `advisories[].cases[]`）。
 *
 * ⚠️ **`old_memory_id` / `new_memory_id` 里谁是"另一条记忆"取决于读侧方向**（引擎按被查询
 * 的那条记忆产出视图）：new 侧读 ⇒ `old_memory_id` 是另一条；**old 侧读 ⇒ `new_memory_id`
 * 是另一条**（事实源 = `internal/adapter/sqlite/relation_advisory.go` + 其自测
 * `TestRelationAdvisoryReadOldMemoryReturnsOnlyItsPair`）。
 * ⇒ 平台侧**不能恒取 `old_memory_id`** 做来源过滤（old 侧下它等于本请求记忆本身，过滤会恒 no-op
 * 而 `label`/`reason`/`confidence` 直接越权交付）；正确口径见平台 `otherSideMemoryId`：
 * **过滤对象 = 与本请求不同的那一侧**，两侧同真（自指）/同假（不属本次请求）⇒ fail-closed 丢弃。
 */
export interface HumentRelationAdvisoryCase {
  case_id: string;
  /** 被判定的新记忆（与 `old_memory_id` 对称出现；**不一定**是本次请求的那条） */
  new_memory_id: string;
  /** 被比较的旧记忆（**不一定**是本请求的那条；哪一侧是"另一条"见上方类型注释） */
  old_memory_id: string;
  /** `duplicate` | `supplement` | `supersedes` | `conflict` | `unrelated` | `uncertain`（**可选**） */
  label?: string;
  /** `advisory` | `defer`（`defer` = 引擎自己也没把握，建议人工复核） */
  decision: string;
  reason: string;
  /** 0–1（可选；**不是**校准过的概率，只是模型自报） */
  confidence?: number;
  /** 各类别自报概率（可选；键=类别名，值=0–1） */
  probabilities?: Record<string, number>;
  /** 契约级常量：本条内容由**作者自报**，未经平台或引擎背书 */
  source_state: 'author_reported';
  /** 契约级常量：**仅建议**，不得当作裁决执行 */
  advisory_only: true;
}

/**
 * 一次判定作业的建议块（合同 `advisories[]`）。
 *
 * `state` 是**作业状态机**六态（`queued` / `attempt_started` / `receipt_saved` / `complete` /
 * `defer` / `unknown`）——**非 `complete` 的块里 `cases` 可能为空或不全**，那是"还没跑完"，
 * 不是"没有关系"。`error_code` 只在失败态出现。
 */
export interface HumentRelationAdvisory {
  job_id: string;
  /**
   * 引擎认定的"本次查询命中的记忆"（= 被授权的那条，**new 侧读与 old 侧读都是它**）。
   *
   * ⚠️ 平台**逐块复核**它等于本请求的 engineMemoryId，不等于 ⇒ 整块丢弃 + `droppedAdvisoryCount`
   * （引擎按构造保证一致，但归因不明的块其 `state`/`coverage`/`usage` 一个字都不该交付）。
   */
  matched_memory_id: string;
  /** 本块的 new 侧记忆（**new 侧读时 = 本请求那条；old 侧读时是另一条**——见 case 类型注释） */
  new_memory_id: string;
  /** 作业状态（六值，见上；**值域开放**，未知值按"未完成"读） */
  state: string;
  reason?: string;
  error_code?: string;
  coverage: HumentRelationAdvisoryCoverage;
  cases: HumentRelationAdvisoryCase[];
  /** 判定所用模型名（可选；平台只透传，不做质量背书） */
  model?: string;
  request_sha256?: string;
  receipt_sha256?: string;
  usage: HumentRelationAdvisoryUsage;
  created_at: string;
  attempted_at?: string;
  receipt_saved_at?: string;
  finished_at?: string;
  /** 契约级常量：本块内容**作者自报** */
  source_state: 'author_reported';
  /** 契约级常量：**仅建议** */
  advisory_only: true;
}

/**
 * 关系建议响应（合同 `memory-relations-response.schema.json` 全文）。
 *
 * ⚠️ **空 `advisories` 数组是合法 200**（= 引擎侧没有针对这条记忆的判定作业，
 * 而**不是**"这条记忆没有关系"——关系本身在 detail 的 `sections.relations` 里）。
 * ⚠️ `truncated` = "还有匹配的作业超出本次有界投影"（引擎口径），**不是**分页游标
 * （本端点没有 cursor：合同里就没有 limit/cursor 参数）。
 */
export interface HumentMemoryRelations {
  schema_version: string;
  memory_id: string;
  truncated: boolean;
  advisories: HumentRelationAdvisory[];
}

// ══════════════════════════════════════════════════════════════════════════
// Usage 读面（hument alpha.19；`GET /v1/usage/summary` + `/v1/usage/trace`）
//
// 合同事实源（只读）: `~/.hument/chamber-dev/upgrade-alpha19/usage-summary.schema.json` +
// `usage-trace.schema.json` + `hument-v1.yaml` 的两个 usage path。
//
// ⚠️ **整族逐字透传**（与 views 同纪律）：引擎块逐字保留 snake_case，平台**不归一化**
// 内部字段；唯一被拿掉的是 `target`（见 `MemoryEngineUsage*` 的说明——身份回声只在外层
// camelCase `target`，不透出 binding_id/namespace_id）。
//
// ⚠️ **null / absent / 0 是三态**：`input_tokens: null`（未知）≠ `0`（已知为零）≠
// 字段缺席（合同里 required 的字段缺席 ⇒ 回执破损）。normalizer 只判容器与 schema，
// 不把 null 归并成 0（unknown actual billing is not zero）。
// ══════════════════════════════════════════════════════════════════════════

/** Usage 目标回声（合同 `target`；**内部校验用**，不直接交付给调用方） */
export interface HumentUsageTarget {
  binding_id: string;
  namespace_id: string;
  workspace_id: string;
  actor_id: string;
  /** 合同 const：恒 `actor_private` */
  scope: string;
}

/** Usage 过滤器回声（合同 `filter`；键值都是**开放字符串**，平台不收窄） */
export interface HumentUsageFilter {
  operation?: string;
  provider_operation?: string;
  model?: string;
  since?: string;
  until?: string;
}

/** Usage 计数块（合同 `totals.counts`；12 键全 required） */
export interface HumentUsageCounts {
  evidence_rows: number;
  entities: number;
  logical_calls: number;
  generations: number;
  batches: number;
  known_physical_calls: number;
  /** `null` = 未知（与 0 不同） */
  physical_calls: number | null;
  unknown_physical_units: number;
  http_429: number;
  retries: number;
  /** `null` = 未知 */
  cache_reuses: number | null;
  /** `null` = 未知 */
  replay_count: number | null;
}

/** Usage token 块（合同 `totals.tokens`；9 键全 required，已知小计 + 可空合计） */
export interface HumentUsageTokens {
  known_input_tokens: number;
  input_tokens: number | null;
  unknown_input_rows: number;
  known_output_tokens: number;
  output_tokens: number | null;
  unknown_output_rows: number;
  known_total_tokens: number;
  total_tokens: number | null;
  unknown_total_rows: number;
}

/** Usage 成本块（合同 `totals.cost`；actual 未知**不是 0**，币种合同未声明） */
export interface HumentUsageCost {
  status: string;
  actual_micros: number | null;
  known_estimated_micros: number;
  estimated_micros: number | null;
  unknown_estimated_rows: number;
}

/** Usage 时长块（合同 `totals.duration`） */
export interface HumentUsageDuration {
  known_physical_ms: number;
  physical_ms: number | null;
  unknown_physical_rows: number;
}

/** Usage 汇总块（合同 `totals`；**覆盖完整匹配集**，与 trace 页大小无关） */
export interface HumentUsageTotals {
  counts: HumentUsageCounts;
  tokens: HumentUsageTokens;
  cost: HumentUsageCost;
  duration: HumentUsageDuration;
}

/** Usage 分组（合同 summary `groups[]`；`model` 可缺席，`model_basis` required） */
export interface HumentUsageGroup {
  operation: string;
  provider_operation: string;
  model?: string;
  model_basis: string;
  totals: HumentUsageTotals;
}

/** Usage 覆盖度来源（合同 `coverage.sources[]`） */
export interface HumentUsageCoverageSource {
  source: string;
  status: string;
  reasons: string[];
}

/**
 * Usage 覆盖度（合同 `coverage`）。
 *
 * `excluded_untimed_rows` 是**覆盖债**：有时间窗过滤时，没有物理开始时间的证据行不计入
 * totals，但必须在这里报出来——把它读成 0 = 把"没统计到"伪装成"没有"。
 */
export interface HumentUsageCoverage {
  status: string;
  scope: string;
  sources: HumentUsageCoverageSource[];
  excluded_untimed_rows: number;
}

/** Usage summary 响应（合同 `usage-summary.schema.json` 全文） */
export interface HumentUsageSummary {
  schema_version: string;
  target: HumentUsageTarget;
  filter: HumentUsageFilter;
  time_basis: string;
  snapshot: string;
  as_of: string;
  totals: HumentUsageTotals;
  groups: HumentUsageGroup[];
  coverage: HumentUsageCoverage;
}

/**
 * Usage trace 行（合同 `usage-trace.schema.json` 的 `rows[]`）。
 *
 * required 字段显式声明；optional 字段**逐字**镜像 schema（开放字符串一律 `string`，
 * 平台不硬编词表——合同新增枚举值时不需要改平台代码）。
 */
export interface HumentUsageTraceRow {
  id: string;
  evidence_kind: string;
  source: string;
  operation: string;
  provider_operation: string;
  entity_id: string;
  model_basis: string;
  elapsed_ms: number | null;
  time_source: string;
  request_bytes: number | null;
  response_bytes: number | null;
  response_complete: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_source: string;
  token_basis: string;
  actual_cost_micros: number | null;
  estimated_cost_micros: number | null;
  cost_status: string;
  physical_calls_unknown: boolean;
  cache_reuses: number | null;
  adapter_elapsed_ms: number | null;
  // ── optional（合同未列入 required；缺一不影响整块可用） ──
  logical_call_id?: string;
  generation_id?: string;
  generation_number?: number;
  batch_id?: string;
  batch_ordinal?: number;
  invocation_id?: string;
  attempt_id?: string;
  attempt_ordinal?: number;
  call_id?: string;
  physical_ordinal?: number;
  provider?: string;
  profile_id?: string;
  requested_model?: string;
  resolved_model?: string;
  model?: string;
  state?: string;
  started_at?: string;
  finished_at?: string;
  request_digest?: string;
  response_digest?: string;
  bytes_source?: string;
  request_disposition?: string;
  http_status?: number;
  quota_exhausted?: boolean;
  retry_not_before?: string;
  cost_source?: string;
}

/**
 * Usage trace 响应（合同 `usage-trace.schema.json` 全文）。
 *
 * ⚠️ `next_cursor` 可选；`has_more=true` 时**必须非空**（否则 `invalid_response`）。
 * ⚠️ `limit` 是**生效页大小**（省略请求时 = Hub 配置的 `usage.trace_page_size`，DefaultFile 100）。
 * 平台永远显式发 limit（1–200），故 `limit=0`（无上限）不会从本平台产生。
 */
export interface HumentUsageTrace {
  schema_version: string;
  target: HumentUsageTarget;
  filter: HumentUsageFilter;
  time_basis: string;
  snapshot: string;
  as_of: string;
  rows: HumentUsageTraceRow[];
  total_rows: number;
  limit: number;
  next_cursor?: string;
  has_more: boolean;
  totals: HumentUsageTotals;
  coverage: HumentUsageCoverage;
}

/**
 * summary 查询入参（Hument 合同参数的全集镜像；`scope` **刻意没有**）。
 *
 * 未填即 `undefined` ⇒ 该键**不出现在 URL**（平台不设自己的默认值；默认时间窗由服务层在
 * 首次请求生成绝对 since/until 后显式传入）。
 */
export interface HumentUsageSummaryQuery {
  operation?: string;
  provider_operation?: string;
  model?: string;
  /** RFC3339 字符串**逐字透传**（禁止 Date 转换） */
  since?: string;
  /** RFC3339 字符串**逐字透传**（区间右开） */
  until?: string;
}

/**
 * trace 查询入参（summary 全集 + `limit`/`cursor`）。
 *
 * ⚠️ `limit` 由服务层**总是显式给出**（默认 100，范围 1–200）；`cursor` 绑定
 * target + filter + 数据快照——带 cursor 翻页时每页必须重复相同 limit/filter。
 */
export interface HumentUsageTraceQuery extends HumentUsageSummaryQuery {
  limit?: number;
  cursor?: string;
}

/**
 * 平台交付的 engine 块（**summary**）：合同全文**去掉 `target`**。
 *
 * 为什么去掉：合同 `target` 含 `binding_id` / `namespace_id`（引擎侧身份），平台只在外层
 * camelCase `target` 回声 `workspaceId` / `actorId` / `scope`，**不交付** binding/namespace/
 * credentialRef。normalizer 已在引擎层校验过它（workspace/actor/scope 必须与请求一致）。
 */
export type MemoryEngineUsageSummary = Omit<HumentUsageSummary, 'target'>;

/** 平台交付的 engine 块（**trace**）：合同全文**去掉 `target`**（理由同上） */
export type MemoryEngineUsageTrace = Omit<HumentUsageTrace, 'target'>;

/** 引擎端口（实现方：`HumentEngine` 真联网 / `FakeEngine` 仅测试注入；关闭态 = `null`）。
 *
 * 十三个动词全部 `(target, input)` 形状：**目标（谁的 workspace/actor/凭据）与载荷分离**——
 * 载荷可被重放（账本冻结列），目标来自注册表（可换绑），两者混在一个对象里迟早互相污染。
 *
 * 后五个（`getGraphView` / `getMemoryView` / `getMemoryViewHistory` /
 * `getMemoryViewRepresentation` / `getMemoryRelations`）= **引擎投影读面**（alpha.5 四读面 +
 * alpha.6 关系建议读面），与前面六个的差别：
 * ① 它们是 **GET**（无 body、无 Content-Type、无幂等键、无诊断头，只带凭据头）；
 * ② 整族**逐字透传**（无顶层归一化，见上方 [关键不变量] 段的说明）；
 * ③ **纯读**：不触发 Recall/Formation/Provider/Jev，也不改 active resolution。
 *
 * 最后两个（`getUsageSummary` / `getUsageTrace`）= **alpha.19 usage 读面**，与投影读面的
 * 差别只在 query 词表（**禁 scope**、summary 无分页、trace limit/cursor）与响应校验
 * （`schema_version`/`time_basis`/target 回声）。它们同样 GET、只读、无幂等键。
 */
export interface MemoryEngine {
  /** 引擎名（与 config 值域同域：`hument` / `fake`） */
  readonly name: MemoryEngineName;
  /** 提交提名（幂等键 = `chamber-<账本id>`；**同 key 重发**是唯一的续跑方式） */
  nominate(
    target: MemoryEngineTarget,
    input: NominateMemoryInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>>;
  /** 提名 inspect（**纯只读，不推进 job**；带 diagnostics 头） */
  inspectNomination(
    target: MemoryEngineTarget,
    input: InspectNominationInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>>;
  /** 召回（`mode=manual` 定死；幂等键 = 每次新 uuid） */
  recall(
    target: MemoryEngineTarget,
    input: RecallMemoryInput,
  ): Promise<MemoryEngineResult<MemoryRecallResult>>;
  /** 更正（幂等键 = `chamber-correct-<新账本id>`） */
  correct(
    target: MemoryEngineTarget,
    input: CorrectMemoryInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>>;
  /** 更正 inspect（**纯只读**；中断续跑与恢复通道用） */
  inspectCorrection(
    target: MemoryEngineTarget,
    input: InspectCorrectionInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>>;
  /** 按 memory_id 读一条记忆（**零副作用**；响应拍平透出） */
  readMemory(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<MemoryReadResult>>;
  /** 记忆关系图投影（GET；只读；`browse` 边只取两端点同页） */
  getGraphView(
    target: MemoryEngineTarget,
    query: HumentMemoryGraphViewQuery,
  ): Promise<MemoryEngineResult<HumentMemoryGraphView>>;
  /** 单条记忆的分节详情 + 五槽分辨率阶梯（GET；只读） */
  getMemoryView(
    target: MemoryEngineTarget,
    memoryId: string,
    query: HumentMemoryViewRelationsQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewDetail>>;
  /** 某一分辨率的**旧版本**列表（GET；只读；`current` 恒 false） */
  getMemoryViewHistory(
    target: MemoryEngineTarget,
    memoryId: string,
    resolution: string,
    query: HumentMemoryViewHistoryQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewHistory>>;
  /** 单份表示正文（GET；只读；不改 active resolution） */
  getMemoryViewRepresentation(
    target: MemoryEngineTarget,
    memoryId: string,
    representationId: string,
  ): Promise<MemoryEngineResult<HumentMemoryViewRepresentation>>;
  /**
   * 一条记忆的**关系建议**（GET；只读；作者自报、仅建议）。
   *
   * ⚠️ **无 query**（合同只收 `workspace_id`/`actor_id`/`scope` 三件套，没有 limit/cursor——
   * 有界性由引擎的 `truncated` 承担）；⚠️ **纯读**：GET 不调 Jev、不写关系、不写更正。
   */
  getMemoryRelations(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<HumentMemoryRelations>>;
  /**
   * 已记录用量汇总（`GET /v1/usage/summary`；**GET、只读、无分页**）。
   *
   * 身份 = 精确 binding + namespace + workspace + actor + `actor_private`（`target` 决定，
   * 平台不派生）；**禁止 scope query 参数**（本层不拼）。summary **没有 limit/cursor**——
   * `totals` 永远覆盖完整匹配集。
   */
  getUsageSummary(
    target: MemoryEngineTarget,
    query: HumentUsageSummaryQuery,
  ): Promise<MemoryEngineResult<HumentUsageSummary>>;
  /**
   * 已记录用量明细（`GET /v1/usage/trace`；**GET、只读、分页**）。
   *
   * `totals` 覆盖完整匹配集，**与页大小无关**（不得从 rows 重算）；`next_cursor` 可选，
   * `has_more=true` 时缺失 ⇒ 回执破损。
   */
  getUsageTrace(
    target: MemoryEngineTarget,
    query: HumentUsageTraceQuery,
  ): Promise<MemoryEngineResult<HumentUsageTrace>>;
  /**
   * 就绪探测（`GET /v1/health/ready`；**免鉴权、无 target**，never-throw）。
   *
   * 只有**运行时健康探针**（`EngineHealthProbeService`）使用；结果只进探针路的状态机，
   * **不参与业务调用的健康计数**（见文件头「healthCheck 不是第十四个业务动词」）。
   *
   * 判据：2xx 且响应体满足 ready 合同 ⇒ `{ok:true, value:undefined}`；其余一律
   * `{ok:false, failure}`（存储不可用时 hub 回 503 `cell_unavailable`——那正是一次失败）。
   */
  healthCheck(): Promise<MemoryEngineResult<void>>;
}
