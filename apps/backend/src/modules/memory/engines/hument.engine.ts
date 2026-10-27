/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎端口的**唯一真联网实现**：Chamber ↔ Hument Hub（HTTP，loopback，≤90s）
 *     **十三个端点**：六个写/读动词（nominations / nominations-inspect / memory-inspect /
 *     recalls / memory-corrections / memory-corrections-inspect）+ 五个投影读面
 *     （alpha.5 的 memory-views graph / memories/:id / memories/:id/history/:resolution /
 *     memories/:id/representations/:rid + alpha.6 的 memories/:id/relations + alpha.19 的
 *     /v1/usage/summary|trace，均 GET）
 *
 * [代码职责]
 *   - `HUMENT_ROUTES`：十三端点路径单源（合同事实源 = Hument `contracts/openapi/hument-v1.yaml`）
 *   - `requestJson`：**唯一的 HTTP 传输原语**（POST/GET 共用；超时 + 错误分类 + never-throw）；
 *     `postJson` 只是它的薄委托（见 [关键不变量]）
 *   - 固定 header 装配：写动词 `Content-Type: application/json`（逐字）/ `Idempotency-Key`
 *     （按路由规则）/ `X-Hument-Credential-Ref` / `X-Hument-Nomination-Diagnostics: v1`
 *     （**提名与提名 inspect 双路由**）；**读面五端点只带凭据头**
 *   - 固定请求体装配（`schema_version` 逐字、`intent:'remember'`、`mode:'manual'`、
 *     **`temporal_context` 不发送**、`scopes` 缺省）；读面**无 body**，参数全在 query
 *   - 传输 + 超时 + 错误体解析 + 归一化（全部 **never-throw**，见 [关键不变量]）
 *   - `healthCheck()`：**运行时健康探针**用的就绪探测（`GET /v1/health/ready`，**免鉴权、
 *     无 target**，5s 短超时，2xx 但体不满足 ready 合同 ⇒ `invalid_response`）——它不是业务
 *     动词，不进健康计数（见 memory-engine.interface.ts 文件头「healthCheck 不是第十二个业务动词」）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3 MemoryEngine 端口与三态（固定 header /
 *     错误体解析不丢 / 超时不等式 / `mode:"manual"` / `temporal_context` 一期不发送 / 响应拍平）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 合同事实源（只读）: Hument 仓 `contracts/openapi/hument-v1.yaml`（十三端点的 parameters/
 *     requestBody/响应码）+ `contracts/schema/*.schema.json`（字段名/必填/上限）
 *
 * [关键不变量]
 *   - **never-throw**：一切失败都落 `{ok:false, failure}`（timeout / unreachable / http /
 *     invalid_response），由服务层翻成 §6 的 HTTP 语义。**禁止把上游 4xx 包装成 500**（铁律 #9）：
 *     409 是 conflict（人工处置）、403/400 的 error.code 决定 config_invalid/param_invalid。
 *     读面同纪律：引擎 409（`snapshot_stale`）与 400（`invalid_argument`）都原样落
 *     `failure.http` + `engineCode`，由服务层落 502/14004 逐字透传（**不是** 503）。
 *   - **失败分类学只允许一份**：全部错误分类收口在 `requestJson`；并列两份（POST 一份、GET 一份）
 *     = 迟早漂移（例如只给一侧补了超时判别，另一侧静默全变 unreachable）。
 *   - **`requestJson` 的四条不可丢**：① `AbortSignal.timeout`（丢了超时分类整条消失）②
 *     `redirect:'error'`（防 307/308 把**带凭据头**的请求原样重发到第三方——GET 同样带凭据头）
 *     ③ `X-Request-ID` 提取 + 错误体兜底 ④ 错误体只用于分类、原文不落库。
 *   - **query 只拼已校验字段**：`undefined` 的键**完全不出现**在 URL 上（既不写 `"undefined"`
 *     也不写空串）——平台不设自己的默认值，引擎默认档生效并在响应 `budget` 里回声。
 *   - **错误体解析不丢**（方案 §3）：Hument 错误体 = `{error:{code,message,request_id,retryable,details}}`；
 *     我们**保留 `code` / `retryable` / `request_id`**（§7 的三族 error.code 分派 + 遥测靠它），
 *     但**不搬运 `message` / `details` 原文**（错误体可能回显请求片段；先例 = JUDGMENT-ERROR-BODY）。
 *     **b4d41314 窄化例外**：`details` 只放行白名单键 `admission_cause`（闭合三值），且仅在门控
 *     `409 ∧ code='conflict' ∧ retryable=false` 下附加；其余键继续整体丢弃。
 *   - **引擎诊断统一安全门**（b4d41314）：所有**引擎供给的诊断字符串**在进入平台对象前过门——
 *     `admissionCause` 三值白名单 / `engineReasonCode` `^[a-z0-9_]{1,64}$` / `errorDetail`
 *     `^[a-z0-9_.:-]{1,128}$`（**越界整值丢弃，不截断**）/ `failureClass` 三值 /
 *     `requestId` 对齐 hument `validRemoteRequestID`（len 1..128 + `[A-Za-z0-9]` ∪
 *     ``!#$%&'*+-.^_`|~``）。丢弃而不是抛协议错：错误面必须**可分类可处置**（platform never-throw），
 *     这一点与 hument 整响应判 `ProtocolError` 不同（**不是**"与 hument 一致"）。
 *   - **诊断头双路由**：`X-Hument-Nomination-Diagnostics: v1` 在 `nominations` 与
 *     `nominations/inspect` **都发**（方案 §3 定死）。缺它 ⇒ Hument 静默省略 diagnostics ⇒
 *     §7 的 outcome 轴整体降级为 job_state 回退（已知退化路径，配单测）。
 *     **读面五端点不发**它（没有 outcome 可驱动）。
 *   - **幂等键规则单源**（方案 §3）：nominate = `chamber-<账本id>`、correct =
 *     `chamber-correct-<新账本id>`、**recall 每次新 uuid**。键由本文件拼装——调用方只给账本 id
 *     （自造键 = 同一次提名重发时变成两次形成；换键重发是**禁止**的）。**读面五端点无幂等键**
 *     （只读、非变更动作，重发同 URL 无副作用，也就没有"重放命中"可言）。
 *   - **`context_identity` / `context_epoch` 由调用方传入**（方案 §3）：引擎**不派生**——
 *     自造上下文身份 = 把"这次召回归属哪个对话"这个事实编出来。
 *   - **`temporal_context` 一期不发送**（方案 §3）：Chamber 无可信时间上下文来源。
 *   - **`redirect: 'error'`**：防 307/308 把带凭据引用与正文的 POST 原样重发到第三方
 *     （先例 = judgment.transport.ts）。
 *   - **超时判别先于一切**：`TimeoutError`（`AbortSignal.timeout` 在 Node 22 的名称）与
 *     `AbortError` 都判 `timeout`；**fetch 阶段与 body 读阶段同口径**（body 读阶段超时若记成
 *     unreachable，会把"客户端先放弃"误报成"Hub 没起来"）。
 *   - **2xx 但体破损 ⇒ `invalid_response`**：Hument 合同 `additionalProperties:false`，
 *     缺 required 字段（如 `nomination_id` / `recall_id`）说明回执不可信——**绝不猜字段**
 *     （猜出来的是假事实，§7 默认行 → unknown）。
 *   - **读面五端点整族逐字透传**：本文件的 `normalizeMemoryGraphView` 等五个归一化**只判
 *     "缺关键容器 ⇒ null"**，既不逐字段校验（那是与合同竞速的第二个漂移面），也**返回原对象**
 *     （重建对象 = 丢掉一个平台没有认知的字段）。详见 memory-engine.interface.ts 的 view 段。
 *   - **本层不认识项目/权限**：`target` 原样进 header/body；没有任何"引擎自己找 workspace"的分支。
 *     读面的 `scope` 恒 `actor_private`（本层填死，调用方不给）。
 *   - **零新依赖**：Node 22 全局 `fetch` + `AbortSignal.timeout` + `URLSearchParams` +
 *     `node:crypto.randomUUID`。两个原语（超时判别 / JSON 对象解析）**刻意在本文件重写**而不是
 *     import judgment.transport：让 memory 引擎不依赖判别内核（跨模块耦合），两处都 <15 行且判据逐字一致。
 *
 * [关联代码]
 *   - memory-engine.interface.ts — 端口契约与归一化结果形状（本文件的产物）
 *   - fake.engine.ts — 同契约的测试实现（十动词逐一对应，含四个 view）
 *   - memory-engine.factory.ts — 装配点（hument 分支传 baseUrl/timeoutMs）
 *   - ../../config/memory.config.ts — humentBaseUrl / humentTimeoutMs 来源
 *   - ../memory-views.service.ts — 四个 view 动词的唯一消费方
 *   - modules/judgment/judgment.transport.ts — 传输层先例（never-throw / 分类标签 / redirect:error）
 *
 * [持久踩坑]
 *   MEMORY-NO-DIAGNOSTICS-HEADER(漏发诊断头): 只在提名路由发头、inspect 漏发 ⇒ 重放/inspect
 *     场景下 outcome 轴整体缺席，`committing` 与 `no_change_validated` 只能靠 job_state 回退判
 *     （前者不采纳 ids 尚可，后者会被记成 committed ⇒ **把"无需记忆"记成"已形成"**）。
 *     安全方向: 两条路由固定发头（本文件 HEADER 装配单源），单测按 URL 断言两次都带。
 *   MEMORY-ERROR-BODY(错误体泄漏): 把 4xx/5xx 的错误体原文落日志 = 用日志当回显通道
 *     （错误体常回显请求片段）。安全方向: 只保留 code/retryable/request_id 三个标量；
 *     **b4d41314 窄化**：仅 `details.admission_cause` 白名单键放行（闭合三值、经门控），
 *     其余 `details` 键仍整体丢弃。
 *   MEMORY-DIAGNOSTIC-GATE(诊断字符串直通): 引擎供给的诊断值原样进平台对象 = 把不受信文本
 *     送进响应/遥测（`error_detail` 合同是闭集枚举，但**平台不硬编 60+ 值**，只做强形态门）。
 *     安全方向: 五道门（`asAdmissionCause` / `gateEngineReasonCode` / `gateErrorDetail` /
 *     `asFailureClass` / `gateRequestId`）逐值过滤；`errorDetail` **越界整值丢弃**（截断会把
 *     非法值变成另一个"合法长相"的串，等于半信半疑地采纳垃圾）；未知 `admission_cause`
 *     丢弃 + warn（日志里只落 sanitize+截断摘要）。
 *   MEMORY-VIEW-QUERY-UNDEFINED(未传参数被写成 "undefined"): 无脑 `String(value)` 拼 query 会把
 *     `undefined` 变成合法字符串 `"undefined"`——枚举参数直接 400、数字参数变成 NaN。
 *     安全方向: 只有 `!== undefined` 才 append（`requestJson` 单点收口，单测钉住）。
 *
 * [修改检查]
 *   □ 已读 [权威文档] + Hument 合同，逐字段核对（**禁止凭记忆写字段名/上限**）
 *   □ 新增端点必须同步：端口接口 + FakeEngine 同名方法 + 工厂 + 单测矩阵
 *   □ 改 header 或请求体形状必须同步 §3 的固定清单与 `hument.engine.spec.ts` 断言
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { MemoryEngineName } from '../../../config/memory.config';
import {
  HUMENT_ADMISSION_CAUSES,
  HUMENT_FAILURE_CLASSES,
  type HumentAdmissionCause,
  type HumentFailureClass,
} from './memory-engine.interface';
import type {
  CorrectMemoryInput,
  HumentMemoryAnchor,
  HumentMemoryDetail,
  HumentMemoryGraphView,
  HumentMemoryRelations,
  HumentMemoryRepresentation,
  HumentMemoryViewDetail,
  HumentMemoryViewHistory,
  HumentMemoryViewHistoryQuery,
  HumentMemoryViewRepresentation,
  HumentMemoryViewRelationsQuery,
  HumentMemoryGraphViewQuery,
  HumentUsageSummary,
  HumentUsageSummaryQuery,
  HumentUsageTrace,
  HumentUsageTraceQuery,
  HumentRecallItem,
  HumentRecallTrace,
  InspectCorrectionInput,
  InspectNominationInput,
  MemoryCorrectionResult,
  MemoryEngine,
  MemoryEngineFailure,
  MemoryEngineResult,
  MemoryEngineTarget,
  MemoryNominationResult,
  MemoryReadResult,
  MemoryRecallResult,
  NominateMemoryInput,
  RecallMemoryInput,
} from './memory-engine.interface';

/**
 * 十端点路径（**单源**；路径取自 Hument `contracts/openapi/hument-v1.yaml`）。
 *
 * ⚠️ 只含路径不含主机：主机来自 `MEMORY_ENGINE`/`HUMENT_BASE_URL` 配置（本文件不做配置解析）。
 */
export const HUMENT_ROUTES = {
  /** 提交提名（POST；header：Idempotency-Key + 诊断头） */
  nominations: '/v1/memory/nominations',
  /** 提名 inspect（POST；**只读**，不推进 job；header：诊断头，**无** Idempotency-Key） */
  nominationsInspect: '/v1/memory/nominations/inspect',
  /** 记忆详情（POST；`readMemory`；只读，无幂等键） */
  memoryInspect: '/v1/memory/inspect',
  /** 召回（POST；header：每次新 uuid 的 Idempotency-Key） */
  recalls: '/v1/recalls',
  /** 更正（POST；header：`chamber-correct-<新账本id>`） */
  corrections: '/v1/memory-corrections',
  /** 更正 inspect（POST；只读，按 correction_id 或幂等键二选一） */
  correctionsInspect: '/v1/memory-corrections/inspect',
  /** 记忆关系图投影（**GET**；只读；无幂等键无诊断头） */
  memoryViewsGraph: '/v1/memory-views/graph',
  /**
   * 单条记忆的分节详情 + 五槽分辨率阶梯（**GET**；只读）。
   *
   * 路径里的 `{memory_id}` 是**引擎侧** id（`memory_id` 值域 minLength 1 / maxLength 128），
   * 不是平台 UUID——调用方负责只传本项目映射过的 id（服务层已判过）。
   */
  memoryViewsDetail: (memoryId: string): string =>
    `/v1/memory-views/memories/${encodeURIComponent(memoryId)}`,
  /** 同一记忆某一分辨率的**旧版本**列表（**GET**；只读） */
  memoryViewsHistory: (memoryId: string, resolution: string): string =>
    `/v1/memory-views/memories/${encodeURIComponent(memoryId)}/history/${encodeURIComponent(
      resolution,
    )}`,
  /** 单份表示正文（**GET**；只读；不改 active resolution） */
  memoryViewsRepresentation: (memoryId: string, representationId: string): string =>
    `/v1/memory-views/memories/${encodeURIComponent(memoryId)}/representations/${encodeURIComponent(
      representationId,
    )}`,
  /**
   * 一条记忆的**关系建议**（**GET**；只读；作者自报）。
   *
   * ⚠️ **路径不在 `/v1/memory-views/` 下**：合同把本端点与 `/v1/memories/{id}/sources` 同族
   * （"对一条已授权记忆的附加读"），schema 也不是 `memory-view-*` 家族
   * （= `memory-relations-response`）。平台侧它仍归"views 读面"路由族（同一套闸门与信封），
   * 但**引擎路径必须逐字照合同**——写成 memory-views 前缀会 404。
   *
   * ⚠️ **无 query 参数可拼**（合同只有 `Relation{WorkspaceID,ActorID,Scope}` 三件套，
   * 都是 required；有界性由响应的 `truncated` 承担，没有 limit/cursor）。
   */
  memoryRelations: (memoryId: string): string =>
    `/v1/memories/${encodeURIComponent(memoryId)}/relations`,
  /**
   * 已记录用量汇总（**GET**；只读；无分页）。
   *
   * ⚠️ alpha.19 新增；旧 Hub（alpha.14 及更早）对这个路径回 **404**——平台把它翻成
   * `engine_version_unsupported`（升级 Hub，不是重试）。
   */
  usageSummary: '/v1/usage/summary',
  /** 已记录用量明细（**GET**；只读；limit/cursor 分页） */
  usageTrace: '/v1/usage/trace',
  /**
   * 就绪探测（**GET**；**免鉴权**、无 query、无 body）。
   *
   * 合同事实：`/v1/health/ready` 200 = `HealthReady`（`status:"ready"` + service/version/
   * contract_version/degraded_cells），503 = `ErrorResponse`（`code:"cell_unavailable"`）。
   * `/v1/health/live` 恒 200（只证明进程在），**探针用 ready**——存储不可用才是"引擎不可用"
   * 的真实形态。
   */
  healthReady: '/v1/health/ready',
} as const;

/** 诊断头名（Hument `NominationDiagnostics` 参数；**提名与提名 inspect 双路由固定发送**） */
export const HUMENT_DIAGNOSTICS_HEADER = 'X-Hument-Nomination-Diagnostics';

/** 诊断头值（合同 enum 单值 `v1`） */
export const HUMENT_DIAGNOSTICS_VALUE = 'v1';

/** 绑定凭据引用头名（non-secret；→ 每项目的 `engine_credential_ref`） */
export const HUMENT_CREDENTIAL_HEADER = 'X-Hument-Credential-Ref';

/** 幂等键头名 */
export const HUMENT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** 请求体 `schema_version`（合同 const；**逐字**，写错即 400） */
export const HUMENT_NOMINATION_SCHEMA_VERSION = 'hument-memory-nomination-v1';

/** 提名 inspect 请求体 `schema_version`（合同 const） */
export const HUMENT_NOMINATION_INSPECT_SCHEMA_VERSION = 'hument-memory-nomination-inspect-v1';

/** 提名意图（合同 const；Hument 用它区分提名来源） */
export const HUMENT_NOMINATION_INTENT = 'remember';

/** 召回模式（方案 §3 定死 `manual`：自动注入留到未来开门四件套） */
export const HUMENT_RECALL_MODE = 'manual';

/**
 * 投影读面（五端点：memory-views 四个 + memories/:id/relations）恒传的作用域。
 *
 * rationale：Chamber 的每个项目 = 一个独立 workspace + 一个服务 actor，读面**只借自己的
 * 私有作用域**，绝不跨作用域借读（`owner_shared`/`workspace_shared` 是引擎侧的共享语义，
 * 平台没有对应的授权模型可以拿来背书）。故本值由**引擎层填死**、不进 DTO：
 * 客户端自带 `scope` 会被平台 `forbidNonWhitelisted` 拒成 400（fail-closed 是设计意图）。
 */
export const HUMENT_VIEW_SCOPE = 'actor_private';

/**
 * Usage 读面的作用域（合同同样 const `actor_private`）。
 *
 * ⚠️ **独立常量、独立 query builder**：usage 端点**只收** workspace_id/actor_id + 四个
 * 过滤器（summary）或再加 limit/cursor（trace），**不收 scope**（合同描述明确 "Unknown or
 * repeated query keys ... rejected"，且 plan 定死禁 scope）。不要复用 `viewScopeQuery`
 * （它带 scope）——那是另一个端点的合同。
 */
export const HUMENT_USAGE_SCOPE = 'actor_private';

/** 请求 ID（Hument 每个响应都带 `X-Request-ID`，required） */
const HUMENT_REQUEST_ID_HEADER = 'X-Request-ID';

/** 429 的 `Retry-After` 头（秒；Hument 合同用 delta-seconds） */
const HUMENT_RETRY_AFTER_HEADER = 'Retry-After';

/** `Retry-After` 上限（秒）——防上游给一个荒谬值把客户端挂死一天 */
const HUMENT_RETRY_AFTER_MAX_SECONDS = 3600;

/**
 * 解析 `Retry-After`（只认**非负整数秒**；HTTP-date 形态视为不可解析 ⇒ undefined）。
 *
 * @param value 响应头原值
 * @returns 1..3600 的整数秒；不可解析/非正 ⇒ undefined
 */
export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, HUMENT_RETRY_AFTER_MAX_SECONDS);
}

/**
 * 就绪探测的**短超时**（毫秒）。
 *
 * rationale：探针是"引擎还活着吗"的快速脉搏，不是业务调用。用业务硬顶（缺省 90s）会让一次
 * 探测拖满一个 cron 周期（120s），探针排队、告警延迟、且 `tick()` 的时间窗求值被拖住。
 * 5s 覆盖本机 loopback 与同机容器的正常往返（生产 Hub 的 ready 需要 ~8s 冷启动，
 * 那一段时间探针本就该判失败——首轮失败不会告警，连续 3 次才会）。
 */
export const HUMENT_HEALTH_TIMEOUT_MS = 5000;

/** 就绪合同：`status` 的 const 值（`contracts/schema/health-ready.schema.json`） */
const HUMENT_HEALTH_READY_STATUS = 'ready';

/** 就绪合同：`service` 的 const 值 */
const HUMENT_HEALTH_SERVICE = 'hument';

/** 就绪合同：`contract_version` 的 const 值 */
const HUMENT_HEALTH_CONTRACT_VERSION = 'hument-runtime-0.1';

/** 内容类型（**逐字** `application/json`：加 charset 等后缀在部分网关会变成不匹配） */
const CONTENT_TYPE_JSON = 'application/json';

/**
 * 提名幂等键（`chamber-<账本id>`；方案 §3 定死）。
 *
 * @param ledgerId 账本行 id（`memory_nominations.id`）
 * @returns Hument `Idempotency-Key` 值（可见 ASCII，符合合同 `^[!-~]+$`）
 */
export function buildNominationIdempotencyKey(ledgerId: string): string {
  return `chamber-${ledgerId}`;
}

/**
 * 更正幂等键（`chamber-correct-<新账本id>`；方案 §3 定死）。
 *
 * ⚠️ 用**新账本行**的 id（不是被更正的旧行）：更正本身是一次新主张，幂等域挂在它上面。
 *
 * @param newLedgerId 更正产生的新账本行 id
 * @returns Hument `Idempotency-Key` 值
 */
export function buildCorrectionIdempotencyKey(newLedgerId: string): string {
  return `chamber-correct-${newLedgerId}`;
}

/** 传输层可识别的普通对象（`Record<string, unknown>` 的窄化结果） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空字符串取值（空串 / 非字符串 → undefined；合同里这些字段都是 minLength 1） */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 布尔取值（非布尔 → undefined；**不用 truthy 判断**——`"false"` 这种脏值不能被当成 true） */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** 字符串数组取值（非数组 → undefined；元素过滤非字符串） */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** 本文件的诊断门日志器（只在"丢弃了一个引擎自报值"时出声；不含原值） */
const logger = new Logger('HumentEngine');

/**
 * 日志用的值摘要（sanitize + 截断；**原值不进日志**——诊断值是不受信文本）。
 *
 * @param value 被丢弃的引擎自报字符串
 * @returns 只含安全字符、最多 32 字符的摘要
 */
function sanitizeForLog(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/g, '');
  return cleaned.length > 32 ? `${cleaned.slice(0, 32)}...` : cleaned;
}

/**
 * `details.admission_cause` 的**闭合词表门**（未登记值 → undefined）。
 *
 * ⚠️ 不做推断（不猜"第四因"）：未知值 = 兜底桶，动作由 `conflict_manual` 承接。
 */
function asAdmissionCause(value: unknown): HumentAdmissionCause | undefined {
  if (typeof value !== 'string') return undefined;
  return (HUMENT_ADMISSION_CAUSES as readonly string[]).includes(value)
    ? (value as HumentAdmissionCause)
    : undefined;
}

/**
 * `diagnostics.reason_code` 的**形态门**（开词表：hument 是闭合枚举，平台只约束形态）。
 *
 * 上限 64 对齐遥测列 `reason_code varchar(64)`——超长值写不进列，宁可当场丢弃。
 */
const ENGINE_REASON_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function gateEngineReasonCode(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  return raw !== undefined && ENGINE_REASON_CODE_PATTERN.test(raw) ? raw : undefined;
}

/**
 * `diagnostics.failure.error_detail` 的**形态门**：`^[a-z0-9_.:-]{1,128}$`。
 *
 * ⚠️ **越界整值丢弃，不截断**：截断会把非法值变成另一个"合法长相"的串——等于半信半疑地
 * 采纳垃圾；而平台不硬编 60+ 闭集词表（避免第二份漂移面），故只能做形态门。
 */
const ERROR_DETAIL_PATTERN = /^[a-z0-9_.:-]{1,128}$/;

function gateErrorDetail(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  return raw !== undefined && ERROR_DETAIL_PATTERN.test(raw) ? raw : undefined;
}

/** `diagnostics.failure.failure_class` 的闭合词表门（未登记值 → undefined） */
function asFailureClass(value: unknown): HumentFailureClass | undefined {
  if (typeof value !== 'string') return undefined;
  return (HUMENT_FAILURE_CLASSES as readonly string[]).includes(value)
    ? (value as HumentFailureClass)
    : undefined;
}

/**
 * `request_id` 的安全门——**逐字对齐** hument `internal/adapter/codex/client.go` 的
 * `validRemoteRequestID`：长度 1..128 + 字符集 `[A-Za-z0-9]` ∪ ``!#$%&'*+-.^_`|~``。
 *
 * ⚠️ hument 按**字节**量长度，这里按 JS 字符量——两者在 ASCII 字符集下等价（非 ASCII
 * 字符过不了字符集检查），故无需 Buffer 转换。
 */
const REQUEST_ID_MAX_LENGTH = 128;
const REQUEST_ID_ALLOWED_PUNCTUATION = "!#$%&'*+-.^_`|~";

function gateRequestId(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (raw === undefined || raw.length > REQUEST_ID_MAX_LENGTH) return undefined;
  for (const character of raw) {
    if ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')) {
      continue;
    }
    if (character >= '0' && character <= '9') continue;
    if (!REQUEST_ID_ALLOWED_PUNCTUATION.includes(character)) return undefined;
  }
  return raw;
}

/**
 * 超时判别（`AbortSignal.timeout` 在 Node 22 抛 `TimeoutError`；部分环境/手动 abort 为
 * `AbortError`）——两者同判 timeout（文件头不变量）。
 *
 * @param err fetch / body 读取抛出的异常
 * @returns true = 超时
 */
export function isHumentTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * 解析 Hument 错误体（`{error:{code,message,request_id,retryable,details}}`）的**诊断标量**。
 *
 * ⚠️ 取 `code` / `retryable` / `request_id`：它们是 §7 分派与遥测的输入；`message` 与
 * `details` 的**其余键**原样丢弃（见文件头踩坑）。唯一的 `details` 例外是
 * `admission_cause`（闭合三值，b4d41314）——它决定 409 的处置动作，且**只在本函数里
 * 做词表门**；"只有 409+conflict+retryable=false 才附加"的第二道门在 `requestJson`。
 *
 * 体不是该形状时返回空对象（**不是失败**——状态码本身已经足以分类，缺 code 就按 §7 默认行
 * 走 fail-safe）。
 *
 * @param body 已解析的响应体（任意 unknown）
 * @returns 解析出的标量（缺省字段一律 undefined）
 */
export function parseHumentErrorEnvelope(body: unknown): {
  engineCode?: string;
  retryable?: boolean;
  requestId?: string;
  admissionCause?: HumentAdmissionCause;
} {
  if (!isRecord(body)) return {};
  const error = body.error;
  if (!isRecord(error)) return {};

  const parsed: {
    engineCode?: string;
    retryable?: boolean;
    requestId?: string;
    admissionCause?: HumentAdmissionCause;
  } = {
    engineCode: asNonEmptyString(error.code),
    retryable: asBoolean(error.retryable),
    requestId: gateRequestId(error.request_id),
  };

  // `details` 只白名单放行 admission_cause；未登记值丢弃 + warn（**原值不进日志**）
  const details = error.details;
  if (isRecord(details) && 'admission_cause' in details) {
    const raw = details.admission_cause;
    const cause = asAdmissionCause(raw);
    if (cause !== undefined) {
      parsed.admissionCause = cause;
    } else {
      logger.warn(
        `dropped unknown admission_cause (type=${typeof raw}` +
          `${typeof raw === 'string' ? `, value=${sanitizeForLog(raw)}` : ''})`,
      );
    }
  }

  return parsed;
}

/** 客户端超时文案（固定标签；不含上游原文） */
const FAILURE_MESSAGE_TIMEOUT = 'Hument call timed out (no receipt)';

/** 连接失败文案（固定标签；未到达 Hub） */
const FAILURE_MESSAGE_UNREACHABLE =
  'Hument transport error (network unreachable / DNS / TLS / redirect refused)';

/** 空体 / 非 JSON 文案 */
const FAILURE_MESSAGE_BODY_UNREADABLE = 'Hument returned an unreadable body';

/** 缺关键字段文案（2xx 但违反合同） */
const FAILURE_MESSAGE_CONTRACT = 'Hument response violates the nomination contract';

/** 引擎构造参数（由工厂从 config 传入；本文件不做配置解析） */
export interface HumentEngineSettings {
  /** Hub 端点（含协议与端口，可带尾斜杠；**不含路径**） */
  baseUrl: string;
  /** 客户端硬顶（毫秒；不等式见 config/memory.config.ts 文件头） */
  timeoutMs: number;
}

/**
 * Hument Hub 引擎（方案 §3；六端点 + 固定 header + never-throw）。
 *
 * 无状态：目标（workspace/actor/credential）逐调用从 `target` 传入——引擎实例可在项目间复用，
 * 且"某次调用用了谁的凭据"永远显式出现在调用点（不在实例字段里藏着）。
 */
export class HumentEngine implements MemoryEngine {
  readonly name: MemoryEngineName = 'hument';

  /** 规范化后的端点前缀（去掉尾斜杠；路由自带前导 `/v1`） */
  private readonly baseUrl: string;

  /** 客户端硬顶（毫秒） */
  private readonly timeoutMs: number;

  constructor(settings: HumentEngineSettings) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = settings.timeoutMs;
  }

  /**
   * 提交提名（幂等键 = `chamber-<账本id>`；诊断头固定发送）。
   *
   * @param target 引擎调用目标（workspace/actor/credential）
   * @param input 提名载荷（**账本冻结列**；重放原样重发，永不重装配）
   * @returns 归一化提名回执（含 diagnostics 的 outcome/reasonCode/memoryIds）
   */
  async nominate(
    target: MemoryEngineTarget,
    input: NominateMemoryInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    const headers: Record<string, string> = {
      [HUMENT_IDEMPOTENCY_HEADER]: buildNominationIdempotencyKey(input.ledgerId),
      [HUMENT_CREDENTIAL_HEADER]: target.credentialRef,
      // ⚠️ 双路由固定发送（本文件不变量）：缺它 = outcome 轴整体降级
      [HUMENT_DIAGNOSTICS_HEADER]: HUMENT_DIAGNOSTICS_VALUE,
    };
    const body: Record<string, unknown> = {
      schema_version: HUMENT_NOMINATION_SCHEMA_VERSION,
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      intent: HUMENT_NOMINATION_INTENT,
      category: input.category,
      content: input.content,
      rationale: input.rationale,
      // ⚠️ temporal_context **刻意不发**（方案 §3；见文件头不变量）
    };
    // 纯著述（无来源）时不发空数组：合同允许 `[]`，但"不发"更接近"没有来源引用"的语义
    if (input.sourceLocators.length > 0) body.source_locators = input.sourceLocators;

    return this.postJson(HUMENT_ROUTES.nominations, headers, body, normalizeNominationResult);
  }

  /**
   * 提名 inspect（**纯只读，不推进 job**；诊断头固定发送，**无**幂等键）。
   *
   * @param target 引擎调用目标
   * @param input 按 `nominationId` 或 `memoryId` 二选一（编译期已挡"两个都给"）
   * @returns 归一化提名回执（形状与 nominate 一致）
   */
  async inspectNomination(
    target: MemoryEngineTarget,
    input: InspectNominationInput,
  ): Promise<MemoryEngineResult<MemoryNominationResult>> {
    const headers: Record<string, string> = {
      [HUMENT_CREDENTIAL_HEADER]: target.credentialRef,
      [HUMENT_DIAGNOSTICS_HEADER]: HUMENT_DIAGNOSTICS_VALUE,
    };
    const body: Record<string, unknown> = {
      schema_version: HUMENT_NOMINATION_INSPECT_SCHEMA_VERSION,
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
    };
    if ('nominationId' in input && input.nominationId) body.nomination_id = input.nominationId;
    else if ('memoryId' in input && input.memoryId) body.memory_id = input.memoryId;

    return this.postJson(
      HUMENT_ROUTES.nominationsInspect,
      headers,
      body,
      normalizeNominationResult,
    );
  }

  /**
   * 召回（`mode=manual` 定死、`scopes` 缺省、`view` 与预算三参透传；幂等键 = 每次新 uuid）。
   *
   * @param target 引擎调用目标
   * @param input 查询 + 上下文身份/世代（**由调用方传入**）
   * @returns 召回结果（顶层归一化 + 合同镜像 items/trace）
   */
  async recall(
    target: MemoryEngineTarget,
    input: RecallMemoryInput,
  ): Promise<MemoryEngineResult<MemoryRecallResult>> {
    const headers: Record<string, string> = {
      // 每次新 uuid：召回**不是**幂等动作（它是呈现事件），重发同 key 只会回放旧呈现
      [HUMENT_IDEMPOTENCY_HEADER]: randomUUID(),
      [HUMENT_CREDENTIAL_HEADER]: target.credentialRef,
    };
    const body: Record<string, unknown> = {
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      query: input.query,
      context_identity: input.contextIdentity,
      context_epoch: input.contextEpoch,
      mode: HUMENT_RECALL_MODE,
      // ⚠️ scopes 刻意缺省（方案 §3）：作用域由 Hument 侧绑定策略决定，Chamber 不自选
    };
    if (input.view !== undefined) body.view = input.view;
    if (input.maxItems !== undefined) body.max_items = input.maxItems;
    if (input.maxTokens !== undefined) body.max_tokens = input.maxTokens;
    if (input.maxBytes !== undefined) body.max_bytes = input.maxBytes;

    return this.postJson(HUMENT_ROUTES.recalls, headers, body, normalizeRecallResult);
  }

  /**
   * 更正（幂等键 = `chamber-correct-<新账本id>`）。
   *
   * @param target 引擎调用目标
   * @param input 旧/新 memory id + **冻结原文** rationale
   * @returns 更正回执（含 `replay`：中断续跑靠它区分"已达成"与"刚达成"）
   */
  async correct(
    target: MemoryEngineTarget,
    input: CorrectMemoryInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    const headers: Record<string, string> = {
      [HUMENT_IDEMPOTENCY_HEADER]: buildCorrectionIdempotencyKey(input.newLedgerId),
      [HUMENT_CREDENTIAL_HEADER]: target.credentialRef,
    };
    const body: Record<string, unknown> = {
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      old_memory_id: input.oldMemoryId,
      new_memory_id: input.newMemoryId,
    };
    // rationale 是**可选**字段（合同只有 maxLength）；空串不发（空理由无审计价值且可能被运行时拒）
    if (input.rationale.length > 0) body.rationale = input.rationale;

    return this.postJson(HUMENT_ROUTES.corrections, headers, body, normalizeCorrectionResult);
  }

  /**
   * 更正 inspect（**纯只读**）：按 `correctionId` 或幂等键二选一。
   *
   * rationale：§6 更正"中断同参续跑"先回查回执，才能判断是否需要重发。
   *
   * @param target 引擎调用目标
   * @param input 二选一（编译期已挡"两个都给"）
   * @returns 更正回执（形状与 correct 一致）
   */
  async inspectCorrection(
    target: MemoryEngineTarget,
    input: InspectCorrectionInput,
  ): Promise<MemoryEngineResult<MemoryCorrectionResult>> {
    const headers: Record<string, string> = {
      [HUMENT_CREDENTIAL_HEADER]: target.credentialRef,
    };
    const body: Record<string, unknown> = {
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
    };
    if ('correctionId' in input && input.correctionId) body.correction_id = input.correctionId;
    else if ('idempotencyKey' in input && input.idempotencyKey) {
      body.idempotency_key = input.idempotencyKey;
    }

    return this.postJson(
      HUMENT_ROUTES.correctionsInspect,
      headers,
      body,
      normalizeCorrectionResult,
    );
  }

  /**
   * 按 memory_id 读一条记忆（**零副作用**；响应拍平：memory / representations ≤5 / anchors）。
   *
   * @param target 引擎调用目标
   * @param memoryId 引擎侧 memory id（来自账本 `engine_memory_ids` 映射）
   * @returns 记忆详情（合同镜像，**不再截断**）
   */
  async readMemory(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<MemoryReadResult>> {
    const headers: Record<string, string> = {
      [HUMENT_CREDENTIAL_HEADER]: target.credentialRef,
    };
    const body: Record<string, unknown> = {
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      memory_id: memoryId,
    };

    return this.postJson(HUMENT_ROUTES.memoryInspect, headers, body, normalizeReadMemoryResult);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 投影读面（alpha.5 四读面 + alpha.6 关系建议读面；GET、只读、整族逐字透传）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 记忆关系图投影（GET；只读）。
   *
   * 三个约束写在调用点而不是这里：① `scope` 恒 `actor_private`；② 未填的查询参**不进 URL**；
   * ③ `created_from/to` 是**已校验的字符串**，本层不做任何时间转换。
   */
  async getGraphView(
    target: MemoryEngineTarget,
    query: HumentMemoryGraphViewQuery,
  ): Promise<MemoryEngineResult<HumentMemoryGraphView>> {
    return this.requestJson(
      {
        method: 'GET',
        route: HUMENT_ROUTES.memoryViewsGraph,
        query: {
          ...this.viewScopeQuery(target),
          mode: query.mode,
          center_memory_id: query.center_memory_id,
          kind: query.kind,
          status: query.status,
          active_resolution: query.active_resolution,
          available_resolution: query.available_resolution,
          anchor_state: query.anchor_state,
          created_from: query.created_from,
          created_to: query.created_to,
          relation_type: query.relation_type,
          node_limit: query.node_limit,
          edge_limit: query.edge_limit,
          neighborhood_limit: query.neighborhood_limit,
          preview_scalars: query.preview_scalars,
          cursor: query.cursor,
        },
        headers: this.viewHeaders(target),
      },
      normalizeMemoryGraphView,
    );
  }

  /** 单条记忆的分节详情 + 五槽分辨率阶梯（GET；只读） */
  async getMemoryView(
    target: MemoryEngineTarget,
    memoryId: string,
    query: HumentMemoryViewRelationsQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewDetail>> {
    return this.requestJson(
      {
        method: 'GET',
        route: HUMENT_ROUTES.memoryViewsDetail(memoryId),
        query: {
          ...this.viewScopeQuery(target),
          relation_limit: query.relation_limit,
          relation_cursor: query.relation_cursor,
        },
        headers: this.viewHeaders(target),
      },
      normalizeMemoryViewDetail,
    );
  }

  /**
   * 某一分辨率的**旧版本**列表（GET；只读）。
   *
   * ⚠️ 返回项的 `current` 恒 `false`（引擎只查 `is_current = 0`）——这不是"没有当前版本"，
   * 而是这个端点的语义就是"旧版本列表"。
   */
  async getMemoryViewHistory(
    target: MemoryEngineTarget,
    memoryId: string,
    resolution: string,
    query: HumentMemoryViewHistoryQuery,
  ): Promise<MemoryEngineResult<HumentMemoryViewHistory>> {
    return this.requestJson(
      {
        method: 'GET',
        route: HUMENT_ROUTES.memoryViewsHistory(memoryId, resolution),
        query: {
          ...this.viewScopeQuery(target),
          history_limit: query.history_limit,
          cursor: query.cursor,
        },
        headers: this.viewHeaders(target),
      },
      normalizeMemoryViewHistory,
    );
  }

  /** 单份表示正文（GET；只读；**不改 active resolution**） */
  async getMemoryViewRepresentation(
    target: MemoryEngineTarget,
    memoryId: string,
    representationId: string,
  ): Promise<MemoryEngineResult<HumentMemoryViewRepresentation>> {
    return this.requestJson(
      {
        method: 'GET',
        route: HUMENT_ROUTES.memoryViewsRepresentation(memoryId, representationId),
        query: this.viewScopeQuery(target),
        headers: this.viewHeaders(target),
      },
      normalizeMemoryViewRepresentation,
    );
  }

  /**
   * 一条记忆的**关系建议**（GET；只读；作者自报、仅建议）。
   *
   * ⚠️ 引擎侧**不调 Jev**（合同明示："GET does not invoke Jev or commit a relation or
   * correction"）：它只读已落库的判定作业。故本动词与其他读面同档——失败不落任何平台状态。
   */
  async getMemoryRelations(
    target: MemoryEngineTarget,
    memoryId: string,
  ): Promise<MemoryEngineResult<HumentMemoryRelations>> {
    return this.requestJson(
      {
        method: 'GET',
        route: HUMENT_ROUTES.memoryRelations(memoryId),
        query: this.viewScopeQuery(target),
        headers: this.viewHeaders(target),
      },
      normalizeMemoryRelations,
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // Usage 读面（alpha.19；GET、只读、禁 scope、summary 无分页）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 已记录用量汇总（GET；只读；**无分页**）。
   *
   * query 只拼 `workspace_id`/`actor_id` + 已给的四个过滤器；**没有 scope、没有 limit、
   * 没有 cursor**（合同 summary 不接受分页参数；传了会被旧/新 Hub 400 或忽略，平台不发）。
   */
  async getUsageSummary(
    target: MemoryEngineTarget,
    query: HumentUsageSummaryQuery,
  ): Promise<MemoryEngineResult<HumentUsageSummary>> {
    return this.requestUsageJson(
      HUMENT_ROUTES.usageSummary,
      target,
      {
        operation: query.operation,
        provider_operation: query.provider_operation,
        model: query.model,
        since: query.since,
        until: query.until,
      },
      (parsed) => validateUsageSummary(parsed, target),
    );
  }

  /**
   * 已记录用量明细（GET；只读；`limit` 由服务层显式给出，`cursor` 原样透传）。
   *
   * ⚠️ 每页必须重复相同 limit/filter（cursor 绑定 target + filter + 数据快照）；
   * 本层只负责编码 query，不校验"与上一页一致"（那是调用方纪律，引擎会按合同拒绝）。
   */
  async getUsageTrace(
    target: MemoryEngineTarget,
    query: HumentUsageTraceQuery,
  ): Promise<MemoryEngineResult<HumentUsageTrace>> {
    return this.requestUsageJson(
      HUMENT_ROUTES.usageTrace,
      target,
      {
        operation: query.operation,
        provider_operation: query.provider_operation,
        model: query.model,
        since: query.since,
        until: query.until,
        limit: query.limit,
        cursor: query.cursor,
      },
      (parsed) => validateUsageTrace(parsed, target),
    );
  }

  /**
   * 就绪探测（`GET /v1/health/ready`；**免鉴权、无 target、无 query**；never-throw）。
   *
   * 三条纪律（改本方法前逐条确认）：
   * 1. **复用 `requestJson`**：超时分类 / `redirect:'error'` / `X-Request-ID` 提取全部继承，
   *    不另写一份传输（失败分类学只允许一份，见文件头不变量）；
   * 2. **不带凭据头**（也不带诊断头 / 幂等键）：ready 端点免鉴权，带上凭据引用 = 让一次
   *    健康探测变成凭据使用事件（还会把 `403 + binding_not_found` 这类"凭据坏了"混进
   *    "引擎不可用"的判据里——探针只该回答存储与进程是否就绪）；
   * 3. **2xx 但体不满足 ready 合同 ⇒ `invalid_response`**（对齐 hument 自家探活
   *    `internal/adapter/system/hub_health.go` 的 malformed=失败语义）：中间层改写/版本错配
   *    时，宁可判失败也不要"200 就算健康"。
   *
   * 合同核对（hument `contracts/schema/health-ready.schema.json`）：required =
   * `status`(const ready) / `service`(const hument) / `version`(非空串) /
   * `contract_version`(const hument-runtime-0.1) / `degraded_cells`(string[])。
   * **多余字段容忍**（合同 `additionalProperties:false`，但前向兼容靠"必需项齐备"判定：
   * 引擎新增字段时不该让平台误报告警；真换了合同版本 ⇒ `contract_version` 不再匹配 ⇒ 判失败）。
   *
   * @returns 判据见上（`value` 恒 `undefined`——探针只关心成功/失败）
   */
  async healthCheck(): Promise<MemoryEngineResult<void>> {
    return this.requestJson(
      {
        method: 'GET',
        route: HUMENT_ROUTES.healthReady,
        headers: {},
        timeoutMs: HUMENT_HEALTH_TIMEOUT_MS,
      },
      normalizeHealthReady,
    );
  }

  /**
   * 投影读面的固定 query 三件套（`workspace_id` / `actor_id` / `scope`）。
   *
   * `scope` 是**合同 required**（`MemoryViewScope` 与 `RelationScope` 都是 required:true）
   * ——五端点都必须带，
   * 漏了就是 400；值恒 `actor_private`（见 `HUMENT_VIEW_SCOPE`）。
   */
  private viewScopeQuery(target: MemoryEngineTarget): Record<string, string> {
    return {
      workspace_id: target.workspaceId,
      actor_id: target.actorId,
      scope: HUMENT_VIEW_SCOPE,
    };
  }

  /**
   * 投影读面的固定 header（**只有**凭据引用）。
   *
   * 五个 GET 都**不带** `Content-Type`（无 body）、**不带** `Idempotency-Key`（只读、非变更动作）、
   * **不带**诊断头（那是提名 outcome 轴的东西，这里没有 outcome 可驱动）。
   */
  private viewHeaders(target: MemoryEngineTarget): Record<string, string> {
    return { [HUMENT_CREDENTIAL_HEADER]: target.credentialRef };
  }

  /**
   * Usage 读面的 GET 传输（**独立于 view 的 query 三件套**，见 `HUMENT_USAGE_SCOPE`）。
   *
   * `rejection` 是本层 normalizer 给出的平台侧拒绝因（target/schema/cursor）。它必须挂到
   * `failure.usageRejection` 上——`requestJson` 的通用 `invalid_response` 无法区分
   * "合同版本不匹配"与"身份回声不符"，而服务层对两者的 HTTP 动作完全不同（503 版本 vs
   * 503 身份）。上游原文不进 rejection（枚举值由本层定义）。
   */
  private async requestUsageJson<T>(
    route: string,
    target: MemoryEngineTarget,
    filters: Record<string, string | number | undefined>,
    validate: (parsed: Record<string, unknown>) => UsageValidation<T>,
  ): Promise<MemoryEngineResult<T>> {
    let rejection: NonNullable<MemoryEngineFailure['usageRejection']> | undefined;
    const result = await this.requestJson(
      {
        method: 'GET',
        route,
        // ⚠️ 只有 workspace_id / actor_id + 过滤器；**没有 scope**（usage 合同拒收）
        query: { workspace_id: target.workspaceId, actor_id: target.actorId, ...filters },
        headers: this.viewHeaders(target),
      },
      (parsed) => {
        const verdict = validate(parsed);
        if (!verdict.ok) {
          rejection = verdict.rejection;
          return null;
        }
        return verdict.value;
      },
    );
    if (!result.ok && rejection !== undefined && result.failure.kind === 'invalid_response') {
      return { ok: false, failure: { ...result.failure, usageRejection: rejection } };
    }
    return result;
  }

  /**
   * 一次 POST 的完整失败面收口（**永不 throw**；见文件头不变量）。
   *
   * ⚠️ 本方法是 `requestJson` 的**薄委托**（保留是为了不动六个既有调用点）：
   * 失败分类学只允许有一份实现——并列两份 = 迟早漂移（例如只给 GET 补了超时判别）。
   *
   * @param route `HUMENT_ROUTES` 的路径
   * @param headers 路由固定 header（本函数补 `Content-Type`）
   * @param body 请求体（已按合同装配）
   * @param normalize 体 → 归一化产物（**返回 null = 合同破损** ⇒ `invalid_response`）
   * @returns 判别式联合
   */
  private async postJson<T>(
    route: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    normalize: (parsed: Record<string, unknown>, requestId: string | undefined) => T | null,
  ): Promise<MemoryEngineResult<T>> {
    return this.requestJson({ method: 'POST', route, headers, body }, normalize);
  }

  /**
   * **唯一的 HTTP 传输原语**（POST 与 GET 共用；永不 throw）。
   *
   * 四条不变量（改本方法前逐条确认，任何一条丢了都是静默事故）：
   * 1. `AbortSignal.timeout(timeoutMs)`——丢了它，**超时分类整条消失**（全部落 `unreachable`），
   *    服务层会把"引擎还在想"报成"引擎没起来"（重试语义完全不同）；
   * 2. `redirect: 'error'`——防 307/308 把**带凭据头**的请求原样重发到第三方（GET 同样带凭据头）；
   * 3. `X-Request-ID` 提取 + 错误体 `request_id` 兜底（响应头优先）——排障与遥测的唯一关联键；
   * 4. 错误体**只用于分类**（`code`/`retryable`/`request_id`），**原文不进日志、不落库**
   *    （错误体常回显请求片段，日志会成为回显通道；先例 JUDGMENT-ERROR-BODY）。
   *
   * 分类学：fetch 抛错 ⇒ `timeout`（TimeoutError/AbortError）/ `unreachable`；非 2xx ⇒ `http`
   * + `httpStatus` + `engineCode` + `retryable` + `requestId`；2xx 不可解析 ⇒ `invalid_response`；
   * `normalize` 返回 null ⇒ `invalid_response`。**体读阶段与 fetch 阶段同口径**。
   *
   * @param request `method` / `route` / 可选 `query`（`undefined` 字段**不出现**在 URL 上）/
   *   `headers` / 可选 `body`（仅 POST；有 body 才补 `Content-Type`）/ 可选 `timeoutMs` 覆盖
   * @param normalize 体 → 产物（返回 null = 合同破损）
   * @returns 判别式联合
   */
  private async requestJson<T>(
    request: {
      method: 'GET' | 'POST';
      route: string;
      query?: Record<string, string | number | undefined>;
      headers: Record<string, string>;
      body?: Record<string, unknown>;
      timeoutMs?: number;
    },
    normalize: (parsed: Record<string, unknown>, requestId: string | undefined) => T | null,
  ): Promise<MemoryEngineResult<T>> {
    const startedAt = Date.now();
    const failure = (
      kind: MemoryEngineFailure['kind'],
      message: string,
      extra: Omit<MemoryEngineFailure, 'kind' | 'message' | 'latencyMs'> = {},
    ): MemoryEngineResult<T> => ({
      ok: false,
      failure: { kind, message, latencyMs: Date.now() - startedAt, ...extra },
    });

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query ?? {})) {
      // ⚠️ `undefined` 不序列化：未传的参数必须**完全不出现**（`URLSearchParams` 对 undefined
      //    会写成字符串 "undefined"，那是一个合法但语义荒谬的枚举值）
      if (value !== undefined) params.append(key, String(value));
    }
    const search = params.toString();
    const url = `${this.baseUrl}${request.route}${search ? `?${search}` : ''}`;

    // GET 不带 body、也不带 Content-Type（无载荷可声明的类型）
    const isPost = request.method === 'POST';
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: isPost
          ? { 'Content-Type': CONTENT_TYPE_JSON, ...request.headers }
          : request.headers,
        ...(isPost ? { body: JSON.stringify(request.body ?? {}) } : {}),
        signal: AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
        // 防 307/308 把带凭据引用（与正文）的请求原样重发到第三方（先例 judgment.transport.ts）
        redirect: 'error',
      });
    } catch (err: unknown) {
      return isHumentTimeoutError(err)
        ? failure('timeout', FAILURE_MESSAGE_TIMEOUT)
        : failure('unreachable', FAILURE_MESSAGE_UNREACHABLE);
    }

    // 请求 ID：优先响应头（Hument required）；错误体里的 request_id 作兜底。
    // ⚠️ 两者都要过 gateRequestId（对齐 hument `validRemoteRequestID`）：响应头也可能是
    //    被中间层改写过的脏值，它同样会进响应 `engineDiagnostics`。
    const headerRequestId = gateRequestId(response.headers.get(HUMENT_REQUEST_ID_HEADER));
    // 429 的重试窗口（只在非 2xx 分支消费；放这里是因为响应头只在 fetch 返回后可读）
    const retryAfterSeconds = parseRetryAfterSeconds(
      response.headers.get(HUMENT_RETRY_AFTER_HEADER),
    );

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (err: unknown) {
      // body 读阶段（连接已建立、body 未读完）必须与 fetch 阶段**同口径**分码
      return isHumentTimeoutError(err)
        ? failure('timeout', FAILURE_MESSAGE_TIMEOUT, { requestId: headerRequestId })
        : failure('unreachable', `${FAILURE_MESSAGE_UNREACHABLE} while reading the response body`, {
            requestId: headerRequestId,
          });
    }

    const parsed = parseJsonObject(rawText);

    if (!response.ok) {
      // 错误体只用于分类（code/retryable/request_id/admission_cause），**原文不进日志、不落库**
      const envelope = parseHumentErrorEnvelope(parsed);
      // admissionCause 的**第二道门**：只有 `409 ∧ code='conflict' ∧ retryable=false` 才透传。
      // ⚠️ `retryable === false` 的判据依赖 hument `error.schema.json` 把 `retryable` 列为
      //    required——缺失即 undefined，不满足门控（**宁可丢诊断，也不猜**）。
      const admissionCause =
        response.status === 409 &&
        envelope.engineCode === 'conflict' &&
        envelope.retryable === false
          ? envelope.admissionCause
          : undefined;
      return failure('http', `Hument returned HTTP ${response.status}`, {
        httpStatus: response.status,
        engineCode: envelope.engineCode,
        retryable: envelope.retryable,
        requestId: headerRequestId ?? envelope.requestId,
        ...(admissionCause !== undefined ? { admissionCause } : {}),
        // 429 的可行动窗口（其他状态码不消费；非整数/非正/超上限一律丢弃）
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
    }

    if (!parsed) {
      // 2xx 但空体/非 JSON：回执不可信（合同破损），**绝不猜字段**
      return failure('invalid_response', FAILURE_MESSAGE_BODY_UNREADABLE, {
        requestId: headerRequestId,
      });
    }

    const value = normalize(parsed, headerRequestId);
    if (value === null) {
      return failure('invalid_response', FAILURE_MESSAGE_CONTRACT, { requestId: headerRequestId });
    }
    return { ok: true, value };
  }
}

/**
 * Usage 合同常量（`contracts/schema/usage-{summary,trace}.schema.json` 的两个 const 值）。
 *
 * 它们是**版本信号**：schema_version 不符 ⇒ 旧 Hub/改写中间层；time_basis 不符 ⇒
 * "totals 到底按什么时间口径统计"变了，静默接受会让窗口语义失真。
 */
const HUMENT_USAGE_SCHEMA_VERSION = 'hument-usage-v1';
const HUMENT_USAGE_TIME_BASIS = 'physical_started_at';

/** Usage 合同 `target.scope` 的 const 值 */
const HUMENT_USAGE_TARGET_SCOPE = 'actor_private';

/**
 * Usage 响应的**顶层键白名单**（合同 `additionalProperties: false`）。
 *
 * ⚠️ 拒绝未知顶层键而不是"原样透传"：未来异常/新版本 Hub 若在顶层加一个身份字段
 * （如 `binding_id` / `workspace_key`），透传即等于平台把它交付给调用方——这与
 * "engine 块不出现 binding/namespace/credential" 的安全边界冲突。合同是闭合的，
 * 拒绝未知键 = 版本/合同不匹配，由服务层翻成 `engine_version_unsupported`。
 */
const USAGE_SUMMARY_KEYS = new Set([
  'schema_version',
  'target',
  'filter',
  'time_basis',
  'snapshot',
  'as_of',
  'totals',
  'groups',
  'coverage',
]);

/**
 * trace 顶层键白名单（**显式列出，不用 summary 全集展开**）。
 *
 * ⚠️ trace 合同**没有 `groups`**（groups 是 summary 的维度）；展开 summary 全集会让
 * `groups: []` 这种异常响应被当作合法 trace 透传，形成"合同外字段被接受"的残留。
 */
const USAGE_TRACE_KEYS = new Set([
  'schema_version',
  'target',
  'filter',
  'time_basis',
  'snapshot',
  'as_of',
  'totals',
  'coverage',
  'rows',
  'total_rows',
  'limit',
  'next_cursor',
  'has_more',
]);

/** 顶层键白名单校验（未知键 ⇒ 合同破损） */
function hasOnlyUsageKeys(parsed: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(parsed).every((key) => allowed.has(key));
}

/** Usage 响应校验结论（见 `requestUsageJson` 的说明） */
type UsageValidation<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      rejection: NonNullable<MemoryEngineFailure['usageRejection']>;
    };

/**
 * 校验 usage 响应的**身份回声**（合同 `target`）。
 *
 * 判据分层（**决定服务层的 HTTP 动作**）：
 * - `target` 不是对象 ⇒ `schema_mismatch`（回执形状不可信）
 * - `binding_id` / `namespace_id` 缺失或非串 ⇒ `target_mismatch`（身份证据不完整，
 *   平台不会替引擎猜"这就是本项目的 binding"）
 * - `workspace_id` / `actor_id` 与请求目标不符，或 `scope !== actor_private` ⇒
 *   `target_mismatch`（**跨身份交付**，绝不能当版本问题重试）
 *
 * @returns 通过时 `null`
 */
function usageTargetRejection(
  parsed: Record<string, unknown>,
  expected: MemoryEngineTarget,
): 'schema_mismatch' | 'target_mismatch' | null {
  const target = parsed.target;
  if (!isRecord(target)) return 'schema_mismatch';
  if (!asNonEmptyString(target.binding_id) || !asNonEmptyString(target.namespace_id)) {
    return 'target_mismatch';
  }
  if (
    target.workspace_id !== expected.workspaceId ||
    target.actor_id !== expected.actorId ||
    target.scope !== HUMENT_USAGE_TARGET_SCOPE
  ) {
    return 'target_mismatch';
  }
  return null;
}

/** 公共容器校验（两个 schema 相同的那部分）；返回 rejection 或 null */
function usageEnvelopeRejection(parsed: Record<string, unknown>): 'schema_mismatch' | null {
  if (parsed.schema_version !== HUMENT_USAGE_SCHEMA_VERSION) return 'schema_mismatch';
  if (parsed.time_basis !== HUMENT_USAGE_TIME_BASIS) return 'schema_mismatch';
  if (!asNonEmptyString(parsed.snapshot) || !asNonEmptyString(parsed.as_of))
    return 'schema_mismatch';
  if (!isRecord(parsed.filter)) return 'schema_mismatch';
  if (!isRecord(parsed.totals)) return 'schema_mismatch';
  if (!isRecord(parsed.coverage)) return 'schema_mismatch';
  return null;
}

/** summary 归一化（返回 null = `invalid_response`，rejection 见上） */
function validateUsageSummary(
  parsed: Record<string, unknown>,
  expected: MemoryEngineTarget,
): UsageValidation<HumentUsageSummary> {
  if (!hasOnlyUsageKeys(parsed, USAGE_SUMMARY_KEYS)) {
    return { ok: false, rejection: 'schema_mismatch' };
  }
  const envelopeRejection = usageEnvelopeRejection(parsed);
  if (envelopeRejection) return { ok: false, rejection: envelopeRejection };
  const targetRejection = usageTargetRejection(parsed, expected);
  if (targetRejection) return { ok: false, rejection: targetRejection };
  if (!Array.isArray(parsed.groups)) return { ok: false, rejection: 'schema_mismatch' };
  // **原对象返回**（不重建）：重建会丢掉一个平台没有认知的字段
  return { ok: true, value: parsed as unknown as HumentUsageSummary };
}

/** trace 归一化（额外校验分页容器与 cursor 自洽） */
function validateUsageTrace(
  parsed: Record<string, unknown>,
  expected: MemoryEngineTarget,
): UsageValidation<HumentUsageTrace> {
  if (!hasOnlyUsageKeys(parsed, USAGE_TRACE_KEYS)) {
    return { ok: false, rejection: 'schema_mismatch' };
  }
  const envelopeRejection = usageEnvelopeRejection(parsed);
  if (envelopeRejection) return { ok: false, rejection: envelopeRejection };
  const targetRejection = usageTargetRejection(parsed, expected);
  if (targetRejection) return { ok: false, rejection: targetRejection };

  if (!Array.isArray(parsed.rows)) return { ok: false, rejection: 'schema_mismatch' };
  if (
    typeof parsed.total_rows !== 'number' ||
    !Number.isInteger(parsed.total_rows) ||
    parsed.total_rows < 0
  ) {
    return { ok: false, rejection: 'schema_mismatch' };
  }
  if (typeof parsed.limit !== 'number' || !Number.isInteger(parsed.limit) || parsed.limit < 0) {
    return { ok: false, rejection: 'schema_mismatch' };
  }
  if (typeof parsed.has_more !== 'boolean') return { ok: false, rejection: 'schema_mismatch' };

  // cursor 自洽：`has_more=true` ⇒ next_cursor 必须非空；显式给了 next_cursor 也不能是空串
  if (parsed.next_cursor !== undefined && !asNonEmptyString(parsed.next_cursor)) {
    return { ok: false, rejection: 'cursor_invalid' };
  }
  if (parsed.has_more === true && !asNonEmptyString(parsed.next_cursor)) {
    return { ok: false, rejection: 'cursor_invalid' };
  }

  return { ok: true, value: parsed as unknown as HumentUsageTrace };
}

/**
 * JSON 字符串 → 普通对象（非对象 / 解析失败 → null）。
 *
 * @param text 响应体原文
 * @returns 已解析对象或 null
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 就绪合同归一化（`GET /v1/health/ready` 的 200 体；**返回 null = 合同破损**）。
 *
 * 判据 = hument `contracts/schema/health-ready.schema.json` 的 required 集 + 三个 const 值
 * （逐条见 `healthCheck` 的注释）。多余字段容忍（前向兼容），缺失/取值不符一律 null
 * ——`requestJson` 据此落 `invalid_response`（2xx 但不可信 ≠ 健康）。
 *
 * @param parsed 已解析的响应体对象
 * @returns `undefined`（健康）或 `null`（合同破损）
 */
function normalizeHealthReady(parsed: Record<string, unknown>): void | null {
  const healthy =
    parsed.status === HUMENT_HEALTH_READY_STATUS &&
    parsed.service === HUMENT_HEALTH_SERVICE &&
    typeof parsed.version === 'string' &&
    parsed.version.length > 0 &&
    parsed.contract_version === HUMENT_HEALTH_CONTRACT_VERSION &&
    Array.isArray(parsed.degraded_cells) &&
    parsed.degraded_cells.every((cell) => typeof cell === 'string' && cell.length > 0);
  // ⚠️ 返回 `undefined` 而不是 `true`：端口签名是 `MemoryEngineResult<void>`，
  //    判据只表达成功/失败（`requestJson` 用 `=== null` 判破损，undefined 安全穿过）
  return healthy ? undefined : null;
}

/**
 * 提名回执归一化（nominations / nominations-inspect **共用一个归一**）。
 *
 * 字段来源（合同事实源逐条对齐）：
 * - `nomination_id`（required）→ `engineNominationId`（缺 ⇒ 合同破损 → null）
 * - `canonical_nomination_id` / `job_state` / `memory_id` / `error_code`（均 optional）
 * - `duplicate` / `deferred` / `durable`（required 布尔）
 * - `diagnostics.{outcome,reason_code}` 与 `diagnostics.mutation.memory_ids`
 *   （⚠️ diagnostics 头是我们固定发送的，缺它 = 合同外的退化路径；此时三字段缺席，
 *   §7 自动回退 job_state 轴）
 * - `diagnostics.failure.{error_detail,failure_class}`（**仅 `outcome ∈ {rejected, unknown}`
 *   出现**；b4d41314 起进 `result.value` 作引擎证据，两个值都过形态/词表门）
 *
 * `memoryIds` 的兜底：诊断缺失时用回执的 `memory_id` 单值（方案 §1："一次提名可形成多个
 * memory，`diagnostics.mutation.memory_ids` 恒含主 id"——故无诊断时单值仍可采信）。
 */
function normalizeNominationResult(
  parsed: Record<string, unknown>,
  requestId: string | undefined,
): MemoryNominationResult | null {
  const engineNominationId = asNonEmptyString(parsed.nomination_id);
  if (!engineNominationId) return null;

  const diagnostics = isRecord(parsed.diagnostics) ? parsed.diagnostics : undefined;
  const mutation = diagnostics && isRecord(diagnostics.mutation) ? diagnostics.mutation : undefined;
  const diagnosticMemoryIds = asStringArray(mutation?.memory_ids);
  const singleMemoryId = asNonEmptyString(parsed.memory_id);
  const failure = diagnostics && isRecord(diagnostics.failure) ? diagnostics.failure : undefined;

  return {
    engineNominationId,
    canonicalNominationId: asNonEmptyString(parsed.canonical_nomination_id),
    duplicate: asBoolean(parsed.duplicate) === true,
    jobState: asNonEmptyString(parsed.job_state),
    deferred: asBoolean(parsed.deferred) === true,
    outcome: diagnostics ? asNonEmptyString(diagnostics.outcome) : undefined,
    // reason_code 过形态门（开词表）：遥测列 varchar(64) 写不下的值当场丢弃
    reasonCode: diagnostics ? gateEngineReasonCode(diagnostics.reason_code) : undefined,
    // 终拒/unknown 的引擎证据（两个都过门；越界值整值丢弃而不是截断）
    errorDetail: failure ? gateErrorDetail(failure.error_detail) : undefined,
    failureClass: failure ? asFailureClass(failure.failure_class) : undefined,
    memoryIds: diagnosticMemoryIds ?? (singleMemoryId ? [singleMemoryId] : []),
    retryable: asBoolean(parsed.retryable),
    engineCode: asNonEmptyString(parsed.error_code),
    requestId,
    durable: asBoolean(parsed.durable),
  };
}

/** 召回结果归一化（顶层归一 + items/trace 合同镜像透传） */
function normalizeRecallResult(parsed: Record<string, unknown>): MemoryRecallResult | null {
  const recallId = asNonEmptyString(parsed.recall_id);
  // `items` / `trace` 都是合同 required：缺任一即回执不可信（绝不当作"零结果"）
  if (!recallId || !Array.isArray(parsed.items) || !isRecord(parsed.trace)) return null;

  const trace = parsed.trace;
  return {
    recallId,
    presentationEventId:
      asNonEmptyString(parsed.presentation_event_id) ??
      asNonEmptyString(trace.presentation_event_id),
    items: parsed.items as HumentRecallItem[],
    trace: trace as unknown as HumentRecallTrace,
  };
}

/** 更正回执归一化（correct / corrections-inspect **共用**） */
function normalizeCorrectionResult(parsed: Record<string, unknown>): MemoryCorrectionResult | null {
  const engineCorrectionId = asNonEmptyString(parsed.correction_id);
  if (!engineCorrectionId) return null;
  return {
    engineCorrectionId,
    oldMemoryId: asNonEmptyString(parsed.old_memory_id),
    newMemoryId: asNonEmptyString(parsed.new_memory_id),
    replay: asBoolean(parsed.replay),
  };
}

/** 记忆详情归一化（**拍平**：memory / representations / anchors 三层原样） */
function normalizeReadMemoryResult(parsed: Record<string, unknown>): MemoryReadResult | null {
  const memory = parsed.memory;
  if (!isRecord(memory) || !asNonEmptyString(memory.memory_id)) return null;
  if (!Array.isArray(parsed.representations) || !Array.isArray(parsed.anchors)) return null;

  return {
    memory: memory as unknown as HumentMemoryDetail,
    representations: parsed.representations as HumentMemoryRepresentation[],
    anchors: parsed.anchors as HumentMemoryAnchor[],
    partial: asBoolean(parsed.partial) === true,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 读面归一化（**整族逐字透传**：只做"缺关键结构 ⇒ null"的存在性判定）
//
// ⚠️ 判据的粒度是刻意的：**只判"缺了它整块就没法用"的容器字段**（数组 / 对象 / 关键 id），
// 不逐字段校验（那会把合同新增可选字段变成平台侧硬失败）。`additionalProperties:false` 的
// 形状正确性由**引擎**保证，平台多一层逐字段校验 = 多一处与合同竞速的漂移面。
// 返回的是**原对象**（不是重建的对象）：重建一次就丢掉了一个"没有平台认知的字段"。
// ⚠️ **唯一例外**：relations 多判一层 `advisories[].cases` 是数组——因为**服务层要重建它**
// （逐 case 来源过滤），缺它会抛 TypeError 变 500（见 `normalizeMemoryRelations` 的论证）。
// ──────────────────────────────────────────────────────────────────────────

/** graph 响应归一化：`nodes`/`edges` 是数组、两个 page 块与 budget 是对象、`snapshot_digest` 非空 */
function normalizeMemoryGraphView(parsed: Record<string, unknown>): HumentMemoryGraphView | null {
  if (!asNonEmptyString(parsed.snapshot_digest)) return null;
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
  if (!isRecord(parsed.node_page) || !isRecord(parsed.edge_page)) return null;
  if (!isRecord(parsed.budget)) return null;
  return parsed as unknown as HumentMemoryGraphView;
}

/** detail 响应归一化：`memory.memory_id` 非空 + `sections` 三分块结构齐（ladder 恒 5 项） */
function normalizeMemoryViewDetail(parsed: Record<string, unknown>): HumentMemoryViewDetail | null {
  const memory = parsed.memory;
  if (!isRecord(memory) || !asNonEmptyString(memory.memory_id)) return null;
  const sections = parsed.sections;
  if (!isRecord(sections)) return null;
  const representations = sections.representations;
  const anchors = sections.anchors;
  const relations = sections.relations;
  if (!isRecord(representations) || !Array.isArray(representations.ladder)) return null;
  if (!isRecord(anchors) || !Array.isArray(anchors.items)) return null;
  if (!isRecord(relations) || !Array.isArray(relations.items)) return null;
  return parsed as unknown as HumentMemoryViewDetail;
}

/** history 响应归一化：`memory_id`/`resolution` 非空 + `page` 是对象 + `items` 是数组 */
function normalizeMemoryViewHistory(
  parsed: Record<string, unknown>,
): HumentMemoryViewHistory | null {
  if (!asNonEmptyString(parsed.memory_id) || !asNonEmptyString(parsed.resolution)) return null;
  if (!isRecord(parsed.page) || !Array.isArray(parsed.items)) return null;
  return parsed as unknown as HumentMemoryViewHistory;
}

/** representation 响应归一化：`memory_id` 非空 + `representation.representation_id` 非空 */
function normalizeMemoryViewRepresentation(
  parsed: Record<string, unknown>,
): HumentMemoryViewRepresentation | null {
  if (!asNonEmptyString(parsed.memory_id)) return null;
  const representation = parsed.representation;
  if (!isRecord(representation) || !asNonEmptyString(representation.representation_id)) return null;
  return parsed as unknown as HumentMemoryViewRepresentation;
}

/**
 * relations 响应归一化：`memory_id` 非空 + `advisories` 是数组 + **每个 advisory 的 `cases` 是数组**。
 *
 * ⚠️ **为什么这里比兄弟归一化严一格（多判一层 `cases`）**：服务层要按来源可见性**逐 case 过滤**
 * 并重建 `advisories`（`advisory.cases.filter(...)`）——`cases` 缺席时那行会抛 `TypeError`，
 * 把"引擎答了个平台只读懂一半的形状"变成 **500**（违反 never-throw 的服务层对应面：
 * 铁律 #9 的同类——不是"引擎答错"却报成"平台崩了"）。合同里 `cases` 是 **required**，
 * 故判它是零误伤的；判到 `null` 即 `invalid_response` ⇒ 服务层 502/14004。
 *
 * 仍**不逐字段校验**（`case_id`/`label`/`reason`… 一律不查）：那是与合同竞速的第二份漂移面。
 */
function normalizeMemoryRelations(parsed: Record<string, unknown>): HumentMemoryRelations | null {
  if (!asNonEmptyString(parsed.memory_id)) return null;
  const advisories = parsed.advisories;
  if (!Array.isArray(advisories)) return null;
  for (const advisory of advisories) {
    if (!isRecord(advisory) || !Array.isArray(advisory.cases)) return null;
  }
  return parsed as unknown as HumentMemoryRelations;
}
