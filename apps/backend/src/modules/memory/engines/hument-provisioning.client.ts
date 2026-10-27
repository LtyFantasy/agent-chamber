/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - memory 自助开通的**在线注册客户端**：把"新建 memory 项目"从"运维手工在 Hub 上
 *     add binding"变成后端自动完成 —— Chamber ↔ Hument **operator 面**（loopback，
 *     与业务面 `/v1/memory/*` 是两套认证）的三步链：
 *       ① launcher Unix socket 取一次性 bootstrap code；
 *       ② `POST /v1/operator/bootstrap` 用 code 换 10 分钟 cookie；
 *       ③ `POST /v1/operator/projects` 一次注册 workspace/actor/credential_ref/binding/
 *          grants/capabilities 六表，读回派生的三键交调用方落库。
 *
 * [代码职责]
 *   - `issueBootstrapCode()`：Unix socket 单行 JSON 交换（`{"schema_version":"hument-launcher-v1",
 *     "operation":"issue_operator_bootstrap","binding_id":...}` → 单行 JSON 响应）
 *   - `provision(slug, displayName?)`：三段链的编排 + **202 半成品态**的读回/重放推进 + 归一化产物；
 *     注册体带**可选** `display_name`（alpha.4 FEEDBACK-12；省略则 Hub 默认 = workspace_id）；
 *     **整条链受 120s 墙钟 deadline 约束**，每个阶段再各有独立预算（socket 5s / bootstrap 15s /
 *     register 20s / 读回 GET 10s，见阶段常量）
 *   - `disableProject(slug)`：**孤儿 workspace 善后**（alpha.4 FEEDBACK-11）——同一条
 *     socket→bootstrap 链取 cookie 后 `PATCH {projects}/{tenant}/{project}` body
 *     `{state:'disabled'}`；**独立墙钟**（socket 5s / bootstrap 15s / PATCH 10s，总 30s，评审 S-2
 *     收紧到调用方超时之下），**never-throw**，供 `MemoryProjectService` 在复核确认本地无行后
 *     best-effort 收口用
 *   - `resolveOperatorOrigin()`：构造**启动期**的 `Origin` 形态闸门（畸形 baseUrl 直接拒装配，
 *     见 [关键不变量]）
 *   - 传输纪律**逐条沿用 `hument.engine.ts`**：never-throw 判别式联合 / `redirect:'error'` /
 *     超时判别（`timeout` 与 `unreachable` 分开）/ 错误体只取标量 / 凭据与 cookie 值不落日志
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md`（memory 一期）§3 传输纪律；
 *     本文件是**二期自助开通**（plan `ms-marvel-wolverine-nebula.md` 批次 2）的落地，
 *     设计决策 1-7 已在 plan 定案。
 *   - 合同事实源（只读，**alpha.3 批次 1 实测逐条验证；alpha.4 增量 = FEEDBACK-11/12**）: hument 仓
 *     `contracts/schema/operator-project-register-request.schema.json`（11 字段全必填 +
 *     可选 `display_name`）+ `contracts/schema/operator-project-state-request.schema.json`
 *     （生命周期 PATCH body = `{state: active|disabled}`）+
 *     `internal/adapter/sqlite/project_registration.go`（六表一次写）+ launcher
 *     `launcher_control.go` / `paths_runtime.go`（socket 路径 = `<root>/run/hument-control.sock`，
 *     0600）+ `operator_auth.go`（Origin / Sec-Fetch-Site / 禁 query / 拒 agent 凭据头）
 *
 * [关键不变量]
 *   - **never-throw**：一切失败（socket 拒绝/超时、HTTP 网络错、超时、非 2xx、体破损）都落
 *     `{ok:false, failure}`，由 `MemoryProjectService.create` 翻成 §6 的 HTTP 语义。
 *     端口层 `throw` = 让一次 Hub 抖动变成 Chamber 500（铁律 #9 同源纪律）。
 *   - **三步链与 cookie 不缓存**：bootstrap code 是**一次性**、cookie 只有 10 分钟 TTL——
 *     本项目每次 provision 都现取现换。缓存 = 用一个过期凭据反复撞 401，且掩盖了
 *     "socket 已不可用"这个更贵的故障信号。
 *   - **Origin 必须是 scheme+host（无尾斜杠、无路径）**，`Sec-Fetch-Site: same-origin` 固定发送：
 *     operator 面强制校验二者与 `Host` 严格一致（实测 trailing slash 即拒）。本文件用
 *     `new URL(baseUrl).origin` 取，**不做字符串拼接**（拼错一个 `/` 就是 403 而排障成本极高）。
 *     构造期先过 `resolveOperatorOrigin()` 闸门：解析失败 / 非 http(s) / 带 path / origin 退化成
 *     `'null'` 一律抛 `HumentProvisioningConfigError`（**畸形配置不得变成运行期裸 TypeError 或
 *     `Origin: null`**——后者会被 operator 面拒成 403 而文案不点出根因）。装配姿态由工厂决定
 *     （production 拒启动 / dev 降级 warn）。
 *   - **GET 读回不带 Origin、禁 query**（合同明文：读回是 GET，认证只认 Cookie + Sec-Fetch-Site）：
 *     带上 Origin 或任何 query 参数会被 operator 面拒。
 *   - **注册体 11 字段全必填**（合同 `required` 逐字）：少一个字段 = 400 `invalid_argument`，
 *     而错误文案不会告诉你缺哪个（合同 `additionalProperties:false` 双向严格）。
 *     **第 12 个键 `display_name` 是唯一的可选键**（alpha.4 FEEDBACK-12）：省略时不出现该键
 *     （Hub 默认取 `workspace_id`），显式给则必须 trim 后非空（Hub 侧有效 UTF-8、`null` 被拒）。
 *   - **201/200 的 echo 必须与请求一致**（`project_id`/`workspace_id`/`actor_id`/`binding_id`）：
 *     落库的三键要能指回 Hub 注册表里那一行；Hub 回显了**不同**的值时归 `invalid_response`
 *     并**不落库**（字段缺席不判失败——只判"回了但不一致"，避免把 Hub 的裁剪当成错误）。
 *   - **幂等键 = `chamber-provision-<slug>`（plan 决策 4）**：202 半成品态必须用**同一个 key**
 *     重 POST 才能推进（换 key = 要么重复建六表、要么把已完成的登记变成 conflict）。
 *   - **错误体只取标量**（`parseHumentErrorEnvelope` 复用 hument.engine 单源）：错误体可能回显
 *     请求片段；`code` / `retryable` / `request_id` 是分派与遥测的输入，**原文不进日志**。
 *   - **凭据与 cookie 值不进日志**：`credential_ref` 是引用名（非机密）可入日志，
 *     `code` 与 `hument_operator_session` 的值一律不入（它们就是这一轮的通行证）。
 *   - **`credential_ref` 按项目派生（`ref-<slug>`），不是部署级配置**：Hub 注册面给每个项目
 *     **裸 INSERT** 一行 `hument_catalog_credential_references`，而 `credential_ref` 是那张表的
 *     **主键** ⇒ ref 与注册 **1:1**，复用必 409（dev 实机走查实锤）。故本文件不接受外部传入的
 *     ref（`HumentProvisioningSettings` 里没有这个字段），一律由 `buildProvisioningCredentialRef`
 *     从 slug 派生——**结构性保证逐项目唯一**，也让"派生值像不像真 key"这一类校验不再需要
 *     （`ref-` 前缀恒不可能命中 KEY_SHAPED）。
 *   - **202 的有界推进 + 总墙钟（决策 6 的加强版）**：观测到 202 后先轮询读回
 *     `HUMENT_PROVISIONING_POLL_ATTEMPTS × POLL_INTERVAL_MS`（3 × 2s）→ 仍未知则**同 key** 重
 *     POST 一次 → 再不成即失败。**轮询期间单次 GET 失败即弃链（不重投）**：读回失败说明认证/
 *     服务面已经不稳，继续重投只会在 Hub 留下第二个半成品；此时失败带 `mayHaveLanded`（见下）。
 *   - **整条链受 `HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS`（120s）墙钟约束**：各阶段预算取
 *     `min(阶段硬顶, 剩余预算)`，预算耗尽即归 `timeout` 失败。**不让各阶段硬顶叠加**
 *     （5+15+20+3×(2+10)+15+20 = 111s < 120s，墙钟是兜底而不是主约束）。
 *   - **`mayHaveLanded` 只对"无定论"的失败置位**：观测到过 202 之后的失败（读回失败 / 重投
 *     失败 / 墙钟耗尽 / 未收敛）标 `true`——登记**可能**已在 Hub 侧落，调用方的正确措辞是
 *     "同 slug 同参重试安全"（服务层据此统一映射 `provisioning_timeout`）。
 *     有定论的回答**不置位**：`state=disabled`、echo 不一致、409 —— 它们的处置是读
 *     `engineCode` 而不是盲目重试。
 *   - **`error_code` 一路带出**：202 体与读回体里的 `error_code` 都进 `failure.engineCode`，
 *     且 `state === 'disabled'` **立即失败**（不轮询、不重投——那是运维面的确定性结论）。
 *   - **`display_name` 只在 create 时体内提交，注册后**改名**仍不可行**：alpha.4 起
 *     `POST /v1/operator/projects` 接受可选 `display_name`（FEEDBACK-12，与激活在同一事务里
 *     原子写入；响应结构不变、无新 echo 字段），故项目名在**注册那一刻**就与 Hub 侧对齐。
 *     但**注册后的改名**依旧走不通：那需要 `workspace_admin` 能力，而本客户端持有的是
 *     manager binding（capability 锁死，实测 403 `scope_denied`）——改名仍以 Chamber 侧
 *     `memory_projects.name` 为准（见 `PATCH /memory/projects/:id`）。
 *   - **同一 Idempotency-Key 换 `display_name` ⇒ Hub 409**（request digest 覆盖 `display_name`）：
 *     孤儿 workspace 上"换个名字重试同 slug"必然被拒。处置分层（评审 S-3a）：**同名重试只在
 *     disable 未落地时能自愈**（digest 一致 ⇒ 重放推进）；若善后已经把 workspace 置为
 *     `disabled`，同名重试也打不开它 ⇒ **需运维先 re-enable**，或**显式传三键**绕过注册
 *     （但**不得复用**那个已禁的 workspace）。见踩坑 MEMORY-PROVISION-RENAME-DIGEST。
 *   - **`disableProject` 的幂等键 = `chamber-disable-<slug>`**（每个命令新 key；同 key 重放返回
 *     **历史 receipt**（`replay:true`）而**不重新执行、不改当前状态**）。⚠️ receipt 里的 `state`
 *     是**该命令的结果快照**，不是项目当前实时状态——所以只判"这条命令是否落地成 disabled"，
 *     绝不用它推断项目现在的状态（要实时状态得读 GET，本客户端不做）。
 *   - **`disableProject` 的成功判据 = HTTP 200 ∧ `state==='disabled'`**（含 `replay:true` 的
 *     历史 receipt）——`replay:true` 同样代表"该 key 的命令已落地为 disabled"，可判 ok；
 *     200 但 state 不是 disabled / 非 200 / 体破损一律落对应失败面。它是 create 已失败之后的
 *     **善后**，不是业务动作：**独立墙钟**（不复用 provision 的 120s 起点）、**绝不 throw**、
 *     调用方对它**只做 best-effort**（失败绝不影响原报错路径）。
 *   - **传输可注入**（`transport` / `sleep` 构造参数）：单测替换 socket 交换与轮询等待
 *     （仿 `hument.engine.spec.ts` 替换 `global.fetch` 的模式），HTTP 面仍走全局 `fetch`。
 *   - **零新依赖**：`node:net`（socket）+ Node 22 全局 `fetch` + `AbortSignal.timeout`。
 *
 * [关联代码]
 *   - memory-project.service.ts — 唯一消费者（create 的"全缺三键 + engine=hument"分支；
 *     以及 save 失败后 best-effort 调 `disableProject` 的孤儿善后）
 *   - memory-engine.factory.ts — `MEMORY_PROVISIONING` token 的装配（config disabled → null）
 *   - hument.engine.ts — 传输纪律先例（`parseHumentErrorEnvelope` / `isHumentTimeoutError` 复用）
 *   - ../../config/memory.config.ts — socket 路径 / binding id / tenant 来源（**不含 credential_ref**：
 *     那个字段按 slug 派生，是 Hub 侧主键约束决定的，不是配置）
 *   - dto/project.dto.ts — 三键的 Swagger 语义文案（"缺省自动注册"）
 *
 * [持久踩坑]
 *   MEMORY-PROVISION-COOKIE-HOARD(复用 cookie): cookie TTL 只有 10 分钟且 code **一次性**——
 *     任何形式的缓存/复用都会在 10 分钟后变成一串 401，而日志里只看到"注册失败"。
 *     安全方向: 每次 provision 现取现换（本文件），单测按"每次调用都先 bootstrap"断言。
 *   MEMORY-PROVISION-ORIGIN-SLASH(Origin 尾斜杠): `Origin: http://host:8099/` 会被 operator 面
 *     判成"跨源"直接 403，而 `Host` 校验的失败文案不提示 Origin 的形态问题。
 *     安全方向: 一律 `new URL(baseUrl).origin`（本文件），单测断言无尾斜杠。
 *   MEMORY-PROVISION-ORIGIN-UNGUARDED(畸形 baseUrl 到运行期才炸): 裸用 `new URL(baseUrl)` 时
 *     `HUMENT_BASE_URL=http://` 在**启动期**抛裸 TypeError（后端直接起不来，且不告诉运维是哪个键），
 *     而 `HUMENT_BASE_URL=hub:8099` 解析成功但 `origin` 退化成字符串 `'null'`（每个请求 403）。
 *     安全方向: 构造期闸门（`resolveOperatorOrigin`），装配姿态交给工厂（production 拒启动 /
 *     dev warn），文案只出现键名。
 *   MEMORY-PROVISION-LANDED-HEDGE(把"有定论"当成"未知"): 一律把失败说成"可能已登记"会让
 *     `state=disabled` / 409 这类确定性结论被误报成"重试安全"，调用方白试一轮且掩盖真因。
 *     安全方向: 只有观测到过 202 之后的**无定论**失败才置 `mayHaveLanded`（本文件）。
 *   MEMORY-PROVISION-SHARED-REF(共享 credential_ref): Hub 注册面对每个项目**裸 INSERT**
 *     `hument_catalog_credential_references`，而 `credential_ref` 是那张表的**主键** ⇒
 *     与注册 1:1。任何"部署级共享一个 ref"的配置（如统一的 `ref-chamber-auto`）都会让
 *     **第二个项目起必然 409 conflict**（dev 实机走查实锤），而首例成功会掩盖它（看起来像
 *     "偶发冲突"）。安全方向: 按 slug 派生 `ref-<slug>`（本文件），配置面**不暴露**这个键。
 *   MEMORY-PROVISION-RENAME-DIGEST(同 slug 换名重试): Hub 的幂等 request digest **覆盖
 *     `display_name`**——孤儿 workspace 上"改个名字重试同 slug"必然 409（看起来像"注册被拒"
 *     而非"名字变了"）。安全方向: 同 slug 重试必须**同名**（digest 一致 ⇒ 重放推进），
 *     或显式传三键绕过注册（本文件 + service 的孤儿注释）。
 *   MEMORY-PROVISION-DISABLE-RECEIPT(receipt 当成实时状态): `disableProject` 的 200 receipt
 *     里 `state` 是**该命令的结果快照**，`replay:true` 的历史 receipt 同样回 `disabled`——
 *     但它**不代表项目当前实时状态**（旧 key 重放不改当前状态）。拿它当"项目现在是 disabled"
 *     用会得出错误结论。安全方向: 只判"这条命令是否已落地为 disabled"（本文件），
 *     实时状态需另走 GET。
 *
 * [修改检查]
 *   □ 已读 [权威文档] + hument operator 合同，逐字段核对（**禁止凭记忆写字段名/上限**）
 *   □ 改三步链任一环必须同步 plan 决策 1-7 与 `memory-project.service.ts` 的错误映射
 *   □ 新增失败分类必须给出服务层的 reason 映射（`provisioning_*` 四值）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { connect } from 'node:net';
import { isHumentTimeoutError, parseHumentErrorEnvelope } from './hument.engine';

/**
 * operator 面端点（**单源**；路径取自 hument `contracts/openapi`，与业务面 `/v1/memory/*`
 * 是两套认证：operator 面走 bootstrap-cookie，业务面走 `X-Hument-Credential-Ref`）。
 */
export const HUMENT_OPERATOR_ROUTES = {
  /** 用一次性 code 换 10 分钟 operator session cookie（POST） */
  bootstrap: '/v1/operator/bootstrap',
  /** 注册（POST）/ 读回（GET `{routes.projects}/{tenantId}/{projectId}`） */
  projects: '/v1/operator/projects',
} as const;

/** launcher 协议头版本（合同 const；**逐字**，写错即 `invalid_request`） */
export const HUMENT_LAUNCHER_SCHEMA_VERSION = 'hument-launcher-v1';

/** launcher 取 bootstrap code 的操作名（合同 const 单值） */
export const HUMENT_LAUNCHER_OPERATION = 'issue_operator_bootstrap';

/** operator session cookie 名（从 `set-cookie` 解析；**值不入日志**） */
export const HUMENT_OPERATOR_COOKIE_NAME = 'hument_operator_session';

/**
 * Hub 侧项目**注册态**（operator 面 202 体与读回体的 `state` 字段值域）。
 *
 * ⚠️ 用命名常量而不是字面量比较（两条理由）：① 平台 lint 的 `no-magic-string-compare`
 * 把 `active` / `disabled` 列为既有 magic string（它们在别处是 AgentStatus/ApiKeyStatus 的值，
 * 与本处**同字不同域**——写常量能把"这是 Hub 合同的注册态"这件事显式化）；
 * ② 它们是 Hub 合同值，集中一处才能在合同变更时一次改全。
 *
 * 合同事实源（只读）：hument operator `project_registration` 的读回体 schema。
 */
export const HUMENT_PROJECT_STATES = {
  /** 登记生效（Hub 侧 target 已热生效） */
  ACTIVE: 'active',
  /** 被运维关闭——**确定性结论**：轮询与重投都不会改变它 */
  DISABLED: 'disabled',
} as const;

/** 内容类型（**逐字** `application/json`：加 charset 后缀在部分网关会变成不匹配） */
const CONTENT_TYPE_JSON = 'application/json';

/** operator 面强制的同源标记（缺它即 403；**GET 与 POST 都带**） */
const SEC_FETCH_SITE_VALUE = 'same-origin';

/** `Origin` 请求头名 */
const ORIGIN_HEADER = 'Origin';

/** `Sec-Fetch-Site` 请求头名 */
const SEC_FETCH_SITE_HEADER = 'Sec-Fetch-Site';

/** 注册后 Hub 侧 target 的固定 actor 名（plan 决策 2；**服务身份，不是用户身份**） */
export const HUMENT_PROVISIONING_ACTOR_ID = 'chamber';

/** 适配器名（照抄 dev catalog 既有业务 binding 口径：`neutral`） */
export const HUMENT_PROVISIONING_ADAPTER = 'neutral';

/** 授权面（照抄既有业务 binding：仅 actor 私有作用域，不跨 actor 共享） */
export const HUMENT_PROVISIONING_GRANTS = ['actor_private'] as const;

/**
 * 能力面（**注册体必须自带更正能力**；**刻意不含** project_register/catalog 写能力）。
 *
 * - `inspect_read`：提名 / 召回 / inspect 这类只读面。
 * - `runtime_private_write`：**更正（`correct`）的引擎侧门槛**——缺了它，引擎在 authorization
 *   阶段直接 403 `source_access_denied`，平台侧只能看到"链接失败、旧主张仍 current"。
 *   实证：2026-10-18 卡 `c91bfa8f`（存量 7 条 binding 全部缺授）+ 10-21 `liuli-memory` /
 *   `mingjun-mind` 两条**新注册** binding 重犯（旧口径"照抄既有业务 binding"抄的正是 10-09
 *   手工注册的缺陷口径）。把能力面收在这里 = 断根：此后自动注册的项目一次到位。
 *
 * ⚠️ 刻意**仍不含** catalog 写能力（`project_register` 等）：自助注册只该拿到"自己在
 * workspace 内读写"的权限，catalog 由 operator 面管。
 */
export const HUMENT_PROVISIONING_CAPABILITIES = ['inspect_read', 'runtime_private_write'] as const;

/**
 * 注册体 `credential_ref` 的派生（**按 slug 派生**：`ref-<slug>`）。
 *
 * ⚠️ **必须逐项目唯一**——这是 Hub 侧的硬约束，不是风格选择：注册面给每个项目**裸 INSERT**
 * 一行 `hument_catalog_credential_references`（`credential_ref TEXT PRIMARY KEY`，
 * `internal/adapter/sqlite/project_registration.go:205`），即 **credential_ref 与注册 1:1**；
 * 第二个项目复用同一个 ref ⇒ Hub 直接 409 `conflict`（dev 实机走查实锤：共享 ref 的第二个
 * auto create 必失败）。
 *
 * ⚠️ **无需在 Hub 侧预置**：`neutral` adapter 的 ref 是**目录引用**（不解析成实际端点凭据），
 * 所以它不需要 `credentials.env` 里有对应行——这正是本方案能"零运维步骤"自助开通的依据。
 *
 * 命名与既有运维惯例一致（`ref-chamber-main-01` 等）：`ref-` 前缀 + 项目自身标识。
 *
 * @param slug 项目 slug（= Hub `project_id` / `workspace_id`）
 * @returns 该项目**专属**的凭据引用名（可见 ASCII，符合 Hub 的 ref 形态要求）
 */
export function buildProvisioningCredentialRef(slug: string): string {
  return `ref-${slug}`;
}

/**
 * socket 交换硬顶（毫秒）。
 *
 * rationale：这是**本机 IPC**（一行 JSON 往返），对齐 Hub 自己客户端的 5s 量级即可；
 * 它**刻意不复用 `HUMENT_TIMEOUT_MS`**（那个 90s 是给"形成 LLM 长跑"的，套在 socket 上
 * 会让一次 create 请求白等一分半）。
 */
export const HUMENT_OPERATOR_SOCKET_TIMEOUT_MS = 5000;

/** bootstrap 换 cookie 的 HTTP 硬顶（毫秒；operator 面是纯登记动作，无需引擎级耐心） */
export const HUMENT_PROVISIONING_BOOTSTRAP_TIMEOUT_MS = 15000;

/** 注册 POST 的 HTTP 硬顶（毫秒；Hub 侧要一次写六张表，给比 bootstrap 更宽的预算） */
export const HUMENT_PROVISIONING_REGISTER_TIMEOUT_MS = 20000;

/** 读回 GET 的 HTTP 硬顶（毫秒；纯读，窄预算即可——读回卡住说明服务面已经不健康） */
export const HUMENT_PROVISIONING_POLL_TIMEOUT_MS = 10000;

/**
 * 202 半成品态的读回轮询次数与间隔（决策 6：有界，不无限等）。
 *
 * ⚠️ 3 × 2s = 6s 的读回窗口是**有意的短窗**：Hub 的 `preparing` 正常在秒级收敛；等下去
 * 只会把一次 create 请求拖长，而"挂住的请求"比"明确失败"更难排障（消费方拿不到任何信号）。
 */
export const HUMENT_PROVISIONING_POLL_ATTEMPTS = 3;

/** 202 半成品态的读回间隔（毫秒） */
export const HUMENT_PROVISIONING_POLL_INTERVAL_MS = 2000;

/**
 * 整条链的墙钟上限（毫秒）——**各阶段硬顶的兜底**，不是主约束。
 *
 * rationale：单阶段预算之和 = 5 + 15 + 20 + 3×(2+10) + 15 + 20 = 111s < 120s；给 9s 余量。
 * 有了它，"某阶段慢但没超硬顶"也不会把一次 HTTP 请求拖成分钟级（`POST /memory/projects`
 * 是同步接口，调用方的网关/客户端超时远比 120s 短）。
 */
export const HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS = 120000;

/**
 * 孤儿善后 PATCH 的 HTTP 硬顶（毫秒）——**只用于 `disableProject`**。
 *
 * rationale：那是 create **已经失败之后**的善后动作，不能再把调用方拖长；生命周期 PATCH 只是
 * 一次 loopback 的 Catalog 事务（写状态 + 命令审计），10s 已宽裕（评审 S-2：收紧到调用方超时之下）。
 */
export const HUMENT_PROVISIONING_DISABLE_TIMEOUT_MS = 10000;

/**
 * 孤儿善后链的**独立**墙钟上限（毫秒）——**刻意不复用 provision 的 120s**。
 *
 * rationale（评审 S-2）：善后必须自己起算，且**收紧到调用方超时之下**——
 * socket 5s + bootstrap 15s + PATCH 10s = 30s **正好顶满**，不再留余量。
 * 复用 provision 的起点是错的：那个起点在 create 失败时往往已经耗掉大半预算，等于让善后
 * 继承一个"别人已经花过"的剩余量——最坏情况下善后连一次请求都发不出。
 *
 * ⚠️ 孤儿路径的**最坏总耗时 = provision 墙钟（120s）+ 本 30s**，但它只在极罕见路径上发生
 * （见 service：并发冲突/本地有行的路径经前提复核**根本不发起** disable）。
 */
export const HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS = 30000;

/**
 * 注册幂等键（plan 决策 4：`chamber-provision-<slug>`）。
 *
 * ⚠️ 202 半成品态**必须用同一个 key** 重 POST 才能推进读回；换 key = 重复建六表或 conflict。
 *
 * @param slug 项目 slug（= Hub 侧 `project_id` / `workspace_id`）
 * @returns Hument `Idempotency-Key` 值
 */
export function buildProvisioningIdempotencyKey(slug: string): string {
  return `chamber-provision-${slug}`;
}

/**
 * 生命周期（disable）命令的幂等键（`chamber-disable-<slug>`）。
 *
 * ⚠️ **每个命令一枚新 key**：Hub 的幂等粒度是"命令"，同 key 重放返回**历史 receipt**
 * （`replay:true`）而**不重新执行**（旧 key 也**不会**把项目状态改回去）。本方法恒按 slug
 * 派生同一枚 key，是因为平台对同一 slug 只会发出一次善后 disable（best-effort，失败即止）——
 * 若日后要支持"再次 disable"，必须换 key（否则只是读回旧 receipt）。
 *
 * @param slug 项目 slug（= Hub 侧 `project_id` / `workspace_id`）
 * @returns Hument `Idempotency-Key` 值
 */
export function buildDisableIdempotencyKey(slug: string): string {
  return `chamber-disable-${slug}`;
}

/** 注册体 `binding_id` 派生（plan 决策 2：`binding-http-<slug>`） */
export function buildProvisioningBindingId(slug: string): string {
  return `binding-http-${slug}`;
}

/** 失败分类（与 `MemoryEngineFailureKind` 同口径；服务层据此映射 `provisioning_*` reason） */
export type HumentProvisioningFailureKind = 'timeout' | 'unreachable' | 'http' | 'invalid_response';

/**
 * 失败面（**不含上游错误体原文、不含 code/cookie 值**；见文件头不变量）。
 *
 * 形状沿用 `MemoryEngineFailure`：`kind` 是分派输入，`engineCode` / `requestId` 是遥测输入。
 */
export interface HumentProvisioningFailure {
  /** 失败分类（调用方据此落 reason，勿只读 message 文案） */
  kind: HumentProvisioningFailureKind;
  /** 固定诊断文案（**不含上游原文 / 不含 code / cookie 值**） */
  message: string;
  /** `kind='http'` 时的 HTTP 状态码（409 由服务层翻成 conflict） */
  httpStatus?: number;
  /** Hument `error.code`（如 `invalid_argument` / `unauthenticated` / `scope_denied`） */
  engineCode?: string;
  /** Hument `error.retryable`（分派依据之一） */
  retryable?: boolean;
  /** Hument `error.request_id`（回执体）或响应头 `X-Request-ID`（可入日志） */
  requestId?: string;
  /**
   * **登记可能已经在 Hub 侧落库**（语义 hedged；见文件头不变量）。
   *
   * 只在**观测到过 202** 之后的**无定论**失败上置位（读回失败 / 重投失败 / 墙钟耗尽 / 未收敛）；
   * 有定论的回答（`state=disabled` / echo 不一致 / 409）**不置位**——它们的处置是读 `engineCode`。
   * 服务层据此把 reason 统一落到 `provisioning_timeout`（"同 slug 同参重试安全"才是正确措辞）。
   */
  mayHaveLanded?: boolean;
  /** 本次调用耗时（毫秒；超时也记实际等待时长） */
  latencyMs: number;
}

/** 注册成功面：派生的三键 + 是否重放（200 = 已登记过的同参重放） */
export interface HumentProvisionedWorkspace {
  /** Hub 侧 workspace id（= slug） */
  workspaceId: string;
  /** Hub 侧 actor id（固定 `chamber`） */
  actorId: string;
  /** Hub 侧凭据引用（= `ref-<slug>`，**按项目派生**；见 `buildProvisioningCredentialRef`） */
  credentialRef: string;
  /** true = Hub 回 200（已登记的同参重放）；false = 201（本次新登记） */
  replay: boolean;
}

/** 判别式联合（**永不 throw**，见文件头不变量） */
export type HumentProvisioningResult =
  | { ok: true; value: HumentProvisionedWorkspace }
  | { ok: false; failure: HumentProvisioningFailure };

/** 孤儿善后成功面：生命周期命令已落地为 disabled */
export interface HumentDisabledProject {
  /**
   * 命令结果快照（恒为 `disabled`）。
   *
   * ⚠️ 这是**该命令的结果**，不是项目当前实时状态（见文件头不变量与踩坑
   * MEMORY-PROVISION-DISABLE-RECEIPT）。
   */
  state: typeof HUMENT_PROJECT_STATES.DISABLED;
  /** true = Hub 回放了同 key 的历史 receipt（该命令此前已落地），而非本次执行 */
  replay: boolean;
}

/**
 * 孤儿善后结果（判别式联合，**永不 throw**）。
 *
 * 失败面**复用 `HumentProvisioningFailure`**（同分类口径）——调用方是 best-effort 消费者，
 * 只需要"成功 / 失败 + 错误类型名"。
 */
export type HumentDisableResult =
  | { ok: true; value: HumentDisabledProject }
  | { ok: false; failure: HumentProvisioningFailure };

/**
 * 客户端构造参数（由工厂从 `MemoryConfig` 传入；本文件不做配置解析）。
 *
 * ⚠️ **刻意不含 HTTP 超时**：operator 面的四个阶段各有自己的硬顶（见阶段常量），
 * **不复用引擎的 `HUMENT_TIMEOUT_MS`**——那个 90s 是给"形成 LLM 长跑"的，套在纯登记动作上
 * 会把一次 create 请求拖成分量级（见 S-1 的评审结论）。
 *
 * ⚠️ **刻意不含 `credentialRef`**：凭据引用**按项目派生**（`ref-<slug>`），不是部署级配置——
 * 它必须逐项目唯一（Hub 侧 `credential_ref` 是主键，见 `buildProvisioningCredentialRef`）。
 */
export interface HumentProvisioningSettings {
  /** Hub 端点（含协议与端口，可带尾斜杠；**不含路径**——路径由本文件拼） */
  baseUrl: string;
  /** launcher Unix socket 绝对路径（`<hub root>/run/hument-control.sock`） */
  operatorSocketPath: string;
  /** manager binding id（socket 请求体 `binding_id`；Hub 侧预置的 operator binding） */
  operatorBindingId: string;
  /** tenant id（注册体 `tenant_id`） */
  tenantId: string;
}

/**
 * launcher socket 交换传输（**可注入**：单测替换它来构造 socket 成功/报错/超时三态）。
 *
 * 语义：请求串写入后半关（shutdown write），读到 EOF 即为完整响应。
 */
export interface ProvisioningSocketTransport {
  /**
   * @param socketPath Unix socket 绝对路径
   * @param request 单行 JSON 请求串（**含结尾换行**）
   * @param timeoutMs 硬顶（超时抛 name='TimeoutError' 的错误）
   * @returns 响应原文（可能为空串）
   */
  exchange(socketPath: string, request: string, timeoutMs: number): Promise<string>;
}

/** socket 超时错误（`name` 与 `AbortSignal.timeout` 同名，便于统一判别） */
class ProvisioningSocketTimeoutError extends Error {
  constructor() {
    super('hument launcher socket timed out');
    this.name = 'TimeoutError';
  }
}

/**
 * 配置形态错误（**装配期**抛出，绝不落进运行期）。
 *
 * 唯一消费方 = `memory-engine.factory.ts` 的装配闸门（production 拒启动 / dev 降级 warn）。
 * `reason` 只含**键名与形态描述**，**绝不含 env 原值**（值可能是带 userinfo 的 URL）。
 */
export class HumentProvisioningConfigError extends Error {
  constructor(readonly reason: string) {
    super(`hument provisioning is misconfigured: ${reason}`);
    this.name = 'HumentProvisioningConfigError';
  }
}

/**
 * 求 operator 面的 `Origin`（并**校验 baseUrl 形态**，见文件头不变量）。
 *
 * 四条判据（任一不过即抛，调用方决定装配姿态）：
 * ① 能被 `new URL()` 解析（否则运行期每次请求都炸，且文案不指向键名）；
 * ② 协议是 http / https（`hub:8099` 会解析成 protocol `hub:` 且 `origin` 退化为 `'null'`）；
 * ③ 不带 path（带 path 说明配错了——本层自己拼 `/v1/...`，多出的 path 会让路由变成
 *    `/path/v1/operator/...`，而失败文案只会说 404）；
 * ④ `origin` 非空且不是字面量 `'null'`（兜底，防 ② 之外的退化路径）。
 *
 * @param baseUrl `HUMENT_BASE_URL` 原文
 * @returns `scheme://host[:port]`（**无尾斜杠、无路径**）
 * @throws HumentProvisioningConfigError
 */
export function resolveOperatorOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HumentProvisioningConfigError('HUMENT_BASE_URL is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HumentProvisioningConfigError('HUMENT_BASE_URL must use the http or https scheme');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new HumentProvisioningConfigError(
      'HUMENT_BASE_URL must not carry a path (the client appends /v1/operator/... itself)',
    );
  }
  if (!url.host) {
    throw new HumentProvisioningConfigError('HUMENT_BASE_URL must carry a host');
  }
  if (!url.origin || url.origin === 'null') {
    throw new HumentProvisioningConfigError('HUMENT_BASE_URL does not yield a usable origin');
  }
  return url.origin;
}

/**
 * 真实 socket 传输：`node:net` 连 Unix socket → 写请求 → 半关 → 读至 EOF。
 *
 * rationale（本文件不变量）：**零新依赖**地实现一行 JSON 的请求-响应；`socket.end(request)`
 * 同时完成"写 + shutdown write"，服务端读到 EOF 才收尾并回一行 JSON。
 *
 * ⚠️ 三条收口路径（缺一条都会让分类说谎，见文件头不变量）：
 * ① `'end'` = 正常 EOF（读到完整响应）；
 * ② `'close'` **兜底**（对端 RST / 硬关时可能既无 `'end'` 也无 `'error'`——不兜底就白等满
 *    超时，把"对端崩了"误报成 `timeout`）；有半包数据按读到的内容交给上层判体破损，
 *    完全空则归 `unreachable`；
 * ③ `'error'` = 连接层错误（ENOENT / ECONNREFUSED）。
 *
 * @param socketPath Unix socket 绝对路径
 * @param request 单行 JSON 请求串（含结尾换行）
 * @param timeoutMs 硬顶（毫秒）
 * @returns 响应原文
 */
export const exchangeOverUnixSocket: ProvisioningSocketTransport['exchange'] = (
  socketPath,
  request,
  timeoutMs,
) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    let settled = false;
    let sawEnd = false;

    /** 单次收口（销毁 socket + 清定时器；幂等——'error'/'close'/'timeout' 可能连发） */
    const finish = (error: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? '');
    };

    // 显式定时器而不是 `socket.setTimeout`：后者是**空闲**超时（有数据流就重置），
    // 而我们要的是"这次交换的总时长"闸门（服务端只回一行，不该有持续流量）
    const timer = setTimeout(() => finish(new ProvisioningSocketTimeoutError()), timeoutMs);

    // UTF-8 解码交给 socket（逐 chunk `toString` 会把跨 chunk 的多字节字符切坏）
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      sawEnd = true;
      finish(null, buffer);
    });
    socket.on('close', () => {
      if (sawEnd) return; // 正常路径已收口
      if (buffer.length > 0) finish(null, buffer);
      else finish(new Error('hument launcher socket closed before returning a response'));
    });
    socket.on('error', (err: Error) => finish(err));
  });

/** 缺省等待实现（单测替换成 no-op 以免真等 5×2s） */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 固定诊断文案（**不含上游原文**） */
const FAILURE_MESSAGE_TIMEOUT = 'Hument operator call timed out (no receipt)';
const FAILURE_MESSAGE_UNREACHABLE =
  'Hument operator transport error (socket / network unreachable, DNS, TLS, or redirect refused)';
const FAILURE_MESSAGE_BODY_UNREADABLE = 'Hument operator returned an unreadable body';
const FAILURE_MESSAGE_CONTRACT = 'Hument operator response violates the registration contract';

/** 传输层可识别的普通对象（`Record<string, unknown>` 的窄化结果） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空字符串取值（空串 / 非字符串 → undefined） */
function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

/** 正则元字符转义（cookie 名拼进正则前必须转义；当前常量无元字符，但别让它成为隐式前提） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * operator session cookie 的匹配式（**锚定在 cookie 段首**）。
 *
 * ⚠️ 必须有 `(?:^|[;,]\\s*)` 前缀：不锚定时 `x-hument_operator_session=evil` 这类
 * **其它 cookie 名后缀**也会命中（把攻击者可控的值当成通行证）。
 * ⚠️ 分隔符要同时接受 `;` 与 `,`：`getSetCookie()` 逐个返回时分隔符是段首（`^`），
 * 而 `get('set-cookie')` 的兜底是**逗号粘连**的多条 cookie（cookie 值按 RFC 6265 不含逗号，
 * 故 `,` 在这里无歧义）。
 */
const OPERATOR_COOKIE_PATTERN = new RegExp(
  `(?:^|[;,]\\s*)${escapeRegExp(HUMENT_OPERATOR_COOKIE_NAME)}=([^;,\\s]+)`,
);

/**
 * 从 `set-cookie` 里解析 operator session cookie 值（**值只在本函数返回值里流转，绝不入日志**）。
 *
 * 兼容两种取法：`getSetCookie()`（undici 逐条返回，最准确）与 `get('set-cookie')`
 * （逗号粘连的兜底）。用**锚定**正则只匹配目标 cookie 段，避免被其它 cookie 干扰。
 *
 * @param headers 响应头（`undefined` = 调用方没带——视同无 cookie，由调用方判失败）
 * @returns cookie 值，或 undefined
 */
function parseOperatorSessionCookie(headers: Headers | undefined): string | undefined {
  if (!headers) return undefined;
  const candidates: string[] =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const joined = headers.get('set-cookie');
  if (joined) candidates.push(joined);
  for (const raw of candidates) {
    const match = OPERATOR_COOKIE_PATTERN.exec(raw);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** 一次 POST/GET 的传输产物（**永不 throw**：失败已收口成 failure） */
type OperatorHttpOutcome =
  | {
      ok: true;
      status: number;
      parsed: Record<string, unknown> | null;
      requestId?: string;
      /** bootstrap 响应头（仅 POST 带；cookie 解析用，**值不入日志**） */
      cookieHeaders?: Headers;
    }
  | { ok: false; failure: HumentProvisioningFailure };

/**
 * Hument operator 面注册客户端（见文件头；**不实现 `MemoryEngine`**）。
 *
 * 无状态：`slug` 逐调用传入，实例可在项目间复用（与 `HumentEngine` 同纪律）。
 */
export class HumentProvisioningClient {
  /** 规范化后的端点前缀（去尾斜杠；路径自带前导 `/v1`） */
  private readonly baseUrl: string;

  /** `Origin` 头值（scheme+host，**无尾斜杠无路径**——构造期已过闸门，见 `resolveOperatorOrigin`） */
  private readonly origin: string;

  private readonly settings: HumentProvisioningSettings;

  private readonly transport: ProvisioningSocketTransport['exchange'];

  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * @param settings 由工厂从 `MemoryConfig` 传入
   * @param transport socket 交换实现（单测替换）
   * @param sleep 轮询等待实现（单测替换成 no-op）
   * @throws HumentProvisioningConfigError baseUrl 畸形（装配姿态由工厂决定，见文件头不变量）
   */
  constructor(
    settings: HumentProvisioningSettings,
    transport: ProvisioningSocketTransport['exchange'] = exchangeOverUnixSocket,
    sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.settings = settings;
    this.baseUrl = settings.baseUrl.replace(/\/+$/, '');
    // ⚠️ 构造期闸门：畸形 baseUrl 必须**在这里**变成可处置的配置错误，而不是运行期裸 TypeError
    // 或 `Origin: null`（见文件头不变量与踩坑 MEMORY-PROVISION-ORIGIN-UNGUARDED）
    this.origin = resolveOperatorOrigin(settings.baseUrl);
    this.transport = transport;
    this.sleep = sleep;
  }

  /**
   * 注册一个项目的 Hub 侧 workspace/actor/credential_ref/binding（三步链 + 202 推进）。
   *
   * 整条链受 `HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS` 墙钟约束：每个阶段开跑前检查剩余预算，
   * 耗尽即归 `timeout` 失败（不再发起该阶段请求）。
   *
   * @param slug 项目 slug（= Hub `project_id` / `workspace_id`）
   * @param displayName 可选初始展示名（Hub `display_name`；trim 后非空才提交，否则该键不出现
   *   ——省略时 Hub 侧默认取 `workspace_id`）
   * @returns 派生的三键 + replay 标记，或失败面（**永不 throw**）
   */
  async provision(slug: string, displayName?: string): Promise<HumentProvisioningResult> {
    const startedAt = Date.now();
    // ①② 取一次性 code → 换 operator session cookie（`openSession` 内含两步；
    // cookie **每次现取现换、不缓存**——见文件头不变量）
    // 此处尚未观测到 202 ⇒ 任何失败都是"未登记"语义（不置 mayHaveLanded）
    const session = await this.openSession(startedAt);
    if (!session.ok) return session;
    // ③ 注册（含 202 半成品态的有界推进 + 墙钟约束）
    return this.register(slug, session.value, startedAt, displayName);
  }

  /**
   * 孤儿 workspace 善后：把 Hub 侧已登记但本地落库失败的项目置为 `disabled`。
   *
   * 语义（文件头不变量 + alpha.4 FEEDBACK-11）：disabled 保留记忆与审计、拒新业务、重启保持、
   * 可被运维**恢复**——比"活着的孤儿"安全得多（alpha.3 时代只能打日志 + 等运维手术）。
   *
   * 三条纪律：
   * ① **独立墙钟**：自己 `Date.now()` 起算（`HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS`），
   *    **绝不复用** provision 的时间线——那是 create 已失败后的善后，不能继承"已被花掉"的预算；
   * ② **never-throw**：与 `provision` 同纪律（socket/HTTP/超时/非 2xx/体破损都落失败面）；
   * ③ **单命令一枚幂等键**（`chamber-disable-<slug>`）：200 + `replay:true` 是"该 key 的命令
   *    此前已落地为 disabled"的历史 receipt ⇒ 同样判 ok（**但它不代表当前实时状态**）。
   *
   * @param slug 项目 slug（= Hub `project_id`）
   * @returns `{state:'disabled', replay}` 或失败面（**永不 throw**）
   */
  async disableProject(slug: string): Promise<HumentDisableResult> {
    const startedAt = Date.now();
    const totalTimeoutMs = HUMENT_PROVISIONING_DISABLE_TOTAL_TIMEOUT_MS;
    const session = await this.openSession(startedAt, totalTimeoutMs);
    if (!session.ok) return session;

    // 墙钟前置检查（NIT-1，对齐 openSession 既有形态——它同样在发起阶段请求前先看剩余预算）：
    // 换 cookie 已把预算耗光时**不再发 PATCH**，直接归 timeout（免得白等整个阶段硬顶，
    // 也免得在预算外的时刻发出不可控的写命令）
    if (this.remainingBudgetMs(startedAt, totalTimeoutMs) <= 0) {
      return {
        ok: false,
        failure: this.deadlineFailure(startedAt, 'lifecycle-command', false, totalTimeoutMs),
      };
    }

    const url = `${this.baseUrl}${HUMENT_OPERATOR_ROUTES.projects}/${encodeURIComponent(
      this.settings.tenantId,
    )}/${encodeURIComponent(slug)}`;
    // 生命周期命令走 PATCH（合同 operator-project-state-request.schema.json：body 只有 state，
    // additionalProperties:false）。头与注册 POST 同构（Origin / Sec-Fetch-Site / Cookie）+
    // 幂等键（**必须**，Hub 按它做命令去重与历史 receipt 回放）。
    const outcome = await this.sendOperator(
      'PATCH',
      url,
      {
        'Content-Type': CONTENT_TYPE_JSON,
        [ORIGIN_HEADER]: this.origin,
        [SEC_FETCH_SITE_HEADER]: SEC_FETCH_SITE_VALUE,
        Cookie: `${HUMENT_OPERATOR_COOKIE_NAME}=${session.value}`,
        'Idempotency-Key': buildDisableIdempotencyKey(slug),
      },
      { state: HUMENT_PROJECT_STATES.DISABLED },
      startedAt,
      HUMENT_PROVISIONING_DISABLE_TIMEOUT_MS,
      totalTimeoutMs,
    );
    if (!outcome.ok) return outcome;

    // 只有 200 是"命令已落地"的 receipt（202 = 未定论；其余非 2xx = 拒），一律按 http 分类
    if (outcome.status !== 200) {
      return {
        ok: false,
        failure: {
          kind: 'http',
          message: `Hument operator lifecycle command returned HTTP ${outcome.status}`,
          httpStatus: outcome.status,
          ...scalarsOf(outcome.parsed),
          requestId: outcome.requestId,
          latencyMs: Date.now() - startedAt,
        },
      };
    }

    const state = asNonEmptyString(outcome.parsed?.state);
    if (state !== HUMENT_PROJECT_STATES.DISABLED) {
      // 200 但命令结果不是 disabled（含字段缺席）= 回执与命令不符，绝不当作善后成功
      return {
        ok: false,
        failure: {
          kind: 'invalid_response',
          message:
            'Hument accepted the lifecycle command (HTTP 200) but the receipt does not report ' +
            "state='disabled' — the orphan workspace was NOT confirmed as disabled (Chamber-side " +
            'orphan handling must not claim success on an unconfirmed receipt). Hument 生命周期回执未确认 disabled',
          httpStatus: 200,
          requestId: outcome.requestId,
          latencyMs: Date.now() - startedAt,
        },
      };
    }

    return {
      ok: true,
      value: {
        state: HUMENT_PROJECT_STATES.DISABLED,
        // replay 缺席按 false（真 Hub 恒回该字段；缺失时保守视为"本次执行"）
        replay: outcome.parsed?.replay === true,
      },
    };
  }

  /**
   * 剩余墙钟预算（毫秒；可为负——`<= 0` 即视为耗尽）。
   *
   * @param startedAt 计时起点
   * @param totalTimeoutMs 该条链的墙钟上限（provision 120s / 善后 40s；见阶段常量）
   */
  private remainingBudgetMs(
    startedAt: number,
    totalTimeoutMs: number = HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  ): number {
    return totalTimeoutMs - (Date.now() - startedAt);
  }

  /**
   * 阶段硬顶取 `min(阶段预算, 剩余墙钟)`（毫秒，下限 1ms）。
   *
   * rationale：不让"某阶段的硬顶"越过总墙钟——否则一次慢 + 一次慢就能把 create 请求拖过 deadline，
   * 而 deadline 的意义正是给调用方一个**可预期的上界**。
   */
  private stageTimeoutMs(
    startedAt: number,
    stageTimeoutMs: number,
    totalTimeoutMs: number = HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  ): number {
    return Math.max(1, Math.min(stageTimeoutMs, this.remainingBudgetMs(startedAt, totalTimeoutMs)));
  }

  /** 墙钟耗尽的统一失败（`mayHaveLanded` 由调用方按"是否见过 202"覆盖） */
  private deadlineFailure(
    startedAt: number,
    stage: string,
    mayHaveLanded: boolean,
    totalTimeoutMs: number = HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  ): HumentProvisioningFailure {
    return {
      kind: 'timeout',
      message:
        `Hument operator provisioning exceeded the ${totalTimeoutMs} ms ` +
        `wall-clock deadline (stage: ${stage}) — no receipt`,
      mayHaveLanded,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * socket 取一次性 bootstrap code（三步链第 ① 步）。
   *
   * @returns code 串，或失败面
   */
  private async issueBootstrapCode(): Promise<
    { ok: true; value: string } | { ok: false; failure: HumentProvisioningFailure }
  > {
    const start = Date.now();
    // 单行 JSON 请求（含结尾换行）；`binding_id` = Hub 侧预置的 manager binding
    const request =
      JSON.stringify({
        schema_version: HUMENT_LAUNCHER_SCHEMA_VERSION,
        operation: HUMENT_LAUNCHER_OPERATION,
        binding_id: this.settings.operatorBindingId,
      }) + '\n';

    let raw: string;
    try {
      raw = await this.transport(
        this.settings.operatorSocketPath,
        request,
        HUMENT_OPERATOR_SOCKET_TIMEOUT_MS,
      );
    } catch (err: unknown) {
      // socket 面的 timeout / unreachable 与 HTTP 面**同口径分类**
      const kind: HumentProvisioningFailureKind = isHumentTimeoutError(err)
        ? 'timeout'
        : 'unreachable';
      return {
        ok: false,
        failure: {
          kind,
          message:
            kind === 'timeout'
              ? 'Hument launcher socket timed out (no bootstrap code)'
              : 'Hument launcher socket is unreachable (no bootstrap code)',
          latencyMs: Date.now() - start,
        },
      };
    }

    const parsed = parseJsonObject(raw);
    if (!parsed) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_response',
          message: FAILURE_MESSAGE_CONTRACT,
          latencyMs: Date.now() - start,
        },
      };
    }
    // 失败响应带 `error` 标量（invalid_request / invalid_binding_id / unsupported_operation /
    // request_too_large）——**只取 code 标量**，原文不进日志
    const errorCode = asNonEmptyString(parsed.error);
    if (errorCode) {
      return {
        ok: false,
        failure: {
          kind: 'http',
          message: 'Hument launcher refused the bootstrap request',
          engineCode: errorCode,
          latencyMs: Date.now() - start,
        },
      };
    }
    const code = asNonEmptyString(parsed.code);
    if (!code) {
      // 缺 code 且无 error = 回执不可信（绝不猜字段）
      return {
        ok: false,
        failure: {
          kind: 'invalid_response',
          message: FAILURE_MESSAGE_CONTRACT,
          latencyMs: Date.now() - start,
        },
      };
    }
    return { ok: true, value: code };
  }

  /**
   * 注册（三步链第 ③ 步 + 202 推进，决策 4/6）。
   *
   * 201 = 新登记 / 200 = 同参重放 / 202 = 半成品态（读回 3×2s → 同 key 重投一次）。
   *
   * ⚠️ 观测到 202 之后的**每一种**失败都置 `mayHaveLanded`（见文件头不变量）：登记可能已在
   * Hub 侧落，调用方的正确措辞是"同 slug 同参重试安全"。有定论的回答（`state=disabled`、
   * echo 不一致、重投后的 4xx/5xx）**不置位**。
   *
   * @param slug 项目 slug
   * @param cookie 已换取的 operator session cookie 值
   * @param startedAt 计时起点（同时是墙钟 deadline 起点）
   * @param displayName 可选初始展示名（trim 后非空才进注册体；否则该键不出现）
   * @returns 派生的三键 + replay 标记，或失败面
   */
  private async register(
    slug: string,
    cookie: string,
    startedAt: number,
    displayName?: string,
  ): Promise<HumentProvisioningResult> {
    const idempotencyKey = buildProvisioningIdempotencyKey(slug);
    // 注册体 11 字段**全必填**（合同 required 逐字；少一个 = 400 invalid_argument，见文件头不变量）
    const body: Record<string, unknown> = {
      tenant_id: this.settings.tenantId,
      project_id: slug,
      workspace_id: slug,
      actor_id: HUMENT_PROVISIONING_ACTOR_ID,
      credential_ref: buildProvisioningCredentialRef(slug),
      binding_id: buildProvisioningBindingId(slug),
      adapter: HUMENT_PROVISIONING_ADAPTER,
      grants: [...HUMENT_PROVISIONING_GRANTS],
      capabilities: [...HUMENT_PROVISIONING_CAPABILITIES],
      formation_enabled: true,
      relation_advisory_enabled: false,
    };
    // 第 12 个键 `display_name` 是**可选**的（alpha.4 FEEDBACK-12）：trim 后非空才带上——
    // 省略时 Hub 侧默认取 `workspace_id`（旧版 Hub 也照旧接受这份 11 键体，兼容形态不变）
    const normalizedDisplayName = displayName?.trim();
    if (normalizedDisplayName) body.display_name = normalizedDisplayName;

    const attempt = await this.postRegister(body, idempotencyKey, cookie, startedAt);
    if (!attempt.ok) return attempt;

    // 201/200 = 直出结论（⚠️ echo 必须与请求一致——落库三键要能指回 Hub 注册表那一行）
    if (attempt.status === 201 || attempt.status === 200) {
      return this.settle(slug, attempt, startedAt, null);
    }

    // 202 = preparing / outcome_unknown：先读回（有界），仍未知再同 key 重 POST 一次
    if (attempt.status === 202) {
      // 202 体里的 state / error_code 是**Hub 的第一手答复**，先读再决定要不要轮询：
      // `state=disabled` 是确定性结论（运维把该项目禁了），轮询/重投都无意义
      const state = asNonEmptyString(attempt.parsed?.state);
      const errorCode = asNonEmptyString(attempt.parsed?.error_code);
      if (state === HUMENT_PROJECT_STATES.DISABLED) {
        return {
          ok: false,
          failure: {
            kind: 'http',
            message:
              'Hument reports this project is DISABLED on the Hub side (registration landed but ' +
              'the project is switched off by an operator) — polling and re-posting cannot change ' +
              'that, and nothing was saved in Chamber. Hub-side operator action is required. ' +
              'Hument 侧项目已被运维禁用',
            httpStatus: 202,
            ...(errorCode ? { engineCode: errorCode } : {}),
            requestId: attempt.requestId,
            latencyMs: Date.now() - startedAt,
          },
        };
      }

      // ⚠️ 此后的一切失败都带 mayHaveLanded（202 已观测到，登记可能已落）
      const landed = (failure: HumentProvisioningFailure): HumentProvisioningResult => ({
        ok: false,
        failure: { ...failure, mayHaveLanded: true },
      });

      for (let i = 0; i < HUMENT_PROVISIONING_POLL_ATTEMPTS; i += 1) {
        // 睡之前先看预算：宁可立刻判超时，也不睡满再发现已经没时间了
        const wait = Math.min(
          HUMENT_PROVISIONING_POLL_INTERVAL_MS,
          this.remainingBudgetMs(startedAt),
        );
        if (wait <= 0) {
          return landed(this.deadlineFailure(startedAt, 'read-back-wait', true));
        }
        await this.sleep(wait);
        const polled = await this.readProjectStatus(slug, cookie, startedAt);
        // ⚠️ 读回失败即**弃链**（决策：不重投）——见文件头不变量
        if (!polled.ok) return landed(polled.failure);
        if (polled.value.state === HUMENT_PROJECT_STATES.ACTIVE) return this.successOf(slug, false);
        if (polled.value.state === HUMENT_PROJECT_STATES.DISABLED) {
          return {
            ok: false,
            failure: {
              kind: 'http',
              message:
                'Hument reports this project is DISABLED on the Hub side (read-back) — an operator ' +
                'switched it off; nothing was saved in Chamber. Hub-side operator action is ' +
                'required. Hument 侧项目已被运维禁用',
              httpStatus: 202,
              ...(polled.value.errorCode ? { engineCode: polled.value.errorCode } : {}),
              latencyMs: Date.now() - startedAt,
            },
          };
        }
      }

      // 同 Idempotency-Key 重投一次（换 key = 重复建六表 / conflict，见文件头不变量）：
      // 重投前**重新换一枚 cookie**（第一枚可能已随首次调用消耗掉 TTL 预算的绝大部分）
      const renewed = await this.openSession(startedAt);
      if (!renewed.ok) return landed(renewed.failure);
      const retry = await this.postRegister(body, idempotencyKey, renewed.value, startedAt);
      if (!retry.ok) return landed(retry.failure);
      if (retry.status === 201 || retry.status === 200) {
        return this.settle(slug, retry, startedAt, true);
      }
      // 重投后**仍 202** = 半成品态未收敛（无定论 ⇒ landed）
      if (retry.status === 202) {
        return landed({
          kind: 'invalid_response',
          message:
            'Hument registration stayed in the preparing state after the bounded read-back and a ' +
            'same-key re-post — no receipt: the outcome is unknown on the Hub side (operator ' +
            'surgery may be required). Hument 注册半成品态未收敛',
          httpStatus: retry.status,
          requestId: retry.requestId,
          latencyMs: Date.now() - startedAt,
        });
      }
      // 重投后**其它状态码**（400/403/409/5xx）= Hub 给了确定性答复 ⇒ 按 http 分类并带标量，
      // 不再笼统说成"停在 preparing"（engineCode/retryable 是消费方的处置依据）。
      // ⚠️ 仍置 `mayHaveLanded`：这是**重投**的答复，而首次那发已经回了 202（那次的结果依旧未知）
      // ——两者是不同的事实，不能因为后者有定论就把前者当没发生过。
      return landed({
        kind: 'http',
        message:
          `Hument operator re-post answered HTTP ${retry.status} — the registration did NOT ` +
          'converge (the first attempt is still unaccounted for); see data.engineCode for the ' +
          'Hub-side cause. Hument 重投被拒',
        httpStatus: retry.status,
        ...scalarsOf(retry.parsed),
        requestId: retry.requestId,
        latencyMs: Date.now() - startedAt,
      });
    }

    // 首次注册的其它状态码（409 conflict / 4xx / 5xx）统一按 http 分类，由服务层按 status 翻 reason。
    // ⚠️ 这里还没有 202，所以**不置** mayHaveLanded：4xx/409 是确定性答复，且 409 的处置是
    // 对齐 Hub 侧登记（不是盲目重试）。
    return {
      ok: false,
      failure: {
        kind: 'http',
        message: `Hument operator registration returned HTTP ${attempt.status}`,
        httpStatus: attempt.status,
        ...scalarsOf(attempt.parsed),
        requestId: attempt.requestId,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * 201/200 的收口：先验 echo 一致性（N-8），一致才给成功产物。
   *
   * @param slug 项目 slug
   * @param attempt 201/200 的响应
   * @param startedAt 计时起点
   * @param mayHaveLanded 失败时的 hedged 标记（重投路径传 true；首次路径传 null = 不置位）
   * @returns 成功产物，或 `invalid_response` 失败面
   */
  private settle(
    slug: string,
    attempt: OperatorHttpOutcome,
    startedAt: number,
    mayHaveLanded: boolean | null,
  ): HumentProvisioningResult {
    if (attempt.ok && this.echoMatches(attempt.parsed, slug)) {
      return this.successOf(slug, attempt.status === 200);
    }
    const failure: HumentProvisioningFailure = {
      kind: 'invalid_response',
      message:
        `Hument accepted the registration (HTTP ${attempt.ok ? attempt.status : '?'}) but its ` +
        'echo does not match the requested ids (project_id/workspace_id/actor_id/binding_id). ' +
        'Persisting it would write engine binding columns that do NOT point back at that Hub ' +
        'registry row — so nothing was saved locally; the Hub may hold a differently-shaped ' +
        'registration and needs alignment. Hument 回执与请求不一致',
      httpStatus: attempt.ok ? attempt.status : undefined,
      requestId: attempt.ok ? attempt.requestId : undefined,
      latencyMs: Date.now() - startedAt,
    };
    return {
      ok: false,
      failure: mayHaveLanded === null ? failure : { ...failure, mayHaveLanded },
    };
  }

  /**
   * 201/200 回执的 echo 是否与请求一致（只判**回了但不一致**，字段缺席不判失败）。
   *
   * rationale（文件头不变量）：落库的三键必须能指回 Hub 注册表里这一行。Hub 若回显了不同的
   * `workspace_id`/`actor_id`/`binding_id`，说明它解析到了另一行——静默落库等于写坏映射。
   *
   * @param parsed 201/200 响应体
   * @param slug 项目 slug
   * @returns true = 一致（或缺席）
   */
  private echoMatches(parsed: Record<string, unknown> | null, slug: string): boolean {
    if (!parsed) return true;
    const expected: Record<string, string> = {
      project_id: slug,
      workspace_id: slug,
      actor_id: HUMENT_PROVISIONING_ACTOR_ID,
      binding_id: buildProvisioningBindingId(slug),
    };
    for (const [key, want] of Object.entries(expected)) {
      const got = asNonEmptyString(parsed[key]);
      if (got !== undefined && got !== want) return false;
    }
    return true;
  }

  /**
   * 取一枚 operator session cookie（每次注册/重投都现取现换，见文件头不变量）。
   *
   * @param startedAt 计时起点
   * @returns cookie 值，或失败面
   */
  private async openSession(
    startedAt: number,
    totalTimeoutMs: number = HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  ): Promise<{ ok: true; value: string } | { ok: false; failure: HumentProvisioningFailure }> {
    // 墙钟前置检查：预算耗尽就不再发起这一阶段的请求（免得白等整个阶段硬顶）
    if (this.remainingBudgetMs(startedAt, totalTimeoutMs) <= 0) {
      return {
        ok: false,
        failure: this.deadlineFailure(startedAt, 'bootstrap-code', false, totalTimeoutMs),
      };
    }
    const code = await this.issueBootstrapCode();
    if (!code.ok) return code;
    if (this.remainingBudgetMs(startedAt, totalTimeoutMs) <= 0) {
      return {
        ok: false,
        failure: this.deadlineFailure(startedAt, 'bootstrap-exchange', false, totalTimeoutMs),
      };
    }

    const bootstrap = await this.postOperator(
      HUMENT_OPERATOR_ROUTES.bootstrap,
      {
        'Content-Type': CONTENT_TYPE_JSON,
        [ORIGIN_HEADER]: this.origin,
        [SEC_FETCH_SITE_HEADER]: SEC_FETCH_SITE_VALUE,
      },
      { code: code.value },
      startedAt,
      HUMENT_PROVISIONING_BOOTSTRAP_TIMEOUT_MS,
      totalTimeoutMs,
    );
    if (!bootstrap.ok) return bootstrap;
    if (bootstrap.status !== 200) {
      return {
        ok: false,
        failure: {
          kind: 'http',
          message: `Hument operator bootstrap returned HTTP ${bootstrap.status}`,
          httpStatus: bootstrap.status,
          ...scalarsOf(bootstrap.parsed),
          requestId: bootstrap.requestId,
          latencyMs: Date.now() - startedAt,
        },
      };
    }

    // cookie 值只在这里取用，**绝不回显/落日志**
    const cookie = parseOperatorSessionCookie(bootstrap.cookieHeaders);
    if (!cookie) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_response',
          message:
            'Hument operator bootstrap succeeded but returned no operator session cookie — cannot ' +
            'authenticate the registration call. Hument 未回 session cookie',
          requestId: bootstrap.requestId,
          latencyMs: Date.now() - startedAt,
        },
      };
    }
    return { ok: true, value: cookie };
  }

  /**
   * POST 注册（带 Cookie + 幂等键；注册体 = 11 必填 + 可选 `display_name`，见文件头不变量）。
   *
   * @param body 注册体（11 必填字段，可选带 `display_name`）
   * @param idempotencyKey 幂等键（`chamber-provision-<slug>`）
   * @param cookie operator session cookie 值
   * @param startedAt 计时起点
   * @returns 状态码 + 已解析体，或失败面
   */
  private async postRegister(
    body: Record<string, unknown>,
    idempotencyKey: string,
    cookie: string,
    startedAt: number,
  ): Promise<OperatorHttpOutcome> {
    return this.postOperator(
      HUMENT_OPERATOR_ROUTES.projects,
      {
        'Content-Type': CONTENT_TYPE_JSON,
        [ORIGIN_HEADER]: this.origin,
        [SEC_FETCH_SITE_HEADER]: SEC_FETCH_SITE_VALUE,
        Cookie: `${HUMENT_OPERATOR_COOKIE_NAME}=${cookie}`,
        'Idempotency-Key': idempotencyKey,
      },
      body,
      startedAt,
      HUMENT_PROVISIONING_REGISTER_TIMEOUT_MS,
    );
  }

  /**
   * GET 读回注册态（**不带 Origin、禁 query**——合同明文，见文件头不变量）。
   *
   * @param slug 项目 slug（= `project_id`）
   * @param cookie operator session cookie 值
   * @param startedAt 计时起点
   * @returns `state` + `error_code`（都可能是 undefined），或失败面
   */
  private async readProjectStatus(
    slug: string,
    cookie: string,
    startedAt: number,
  ): Promise<
    | { ok: true; value: { state: string | undefined; errorCode: string | undefined } }
    | { ok: false; failure: HumentProvisioningFailure }
  > {
    const url = `${this.baseUrl}${HUMENT_OPERATOR_ROUTES.projects}/${encodeURIComponent(
      this.settings.tenantId,
    )}/${encodeURIComponent(slug)}`;
    const outcome = await this.httpGet(
      url,
      {
        [SEC_FETCH_SITE_HEADER]: SEC_FETCH_SITE_VALUE,
        Cookie: `${HUMENT_OPERATOR_COOKIE_NAME}=${cookie}`,
      },
      startedAt,
      HUMENT_PROVISIONING_POLL_TIMEOUT_MS,
    );
    if (!outcome.ok) return outcome;
    if (outcome.status < 200 || outcome.status >= 300) {
      return {
        ok: false,
        failure: {
          kind: 'http',
          message: `Hument operator read-back returned HTTP ${outcome.status}`,
          httpStatus: outcome.status,
          ...scalarsOf(outcome.parsed),
          requestId: outcome.requestId,
          latencyMs: Date.now() - startedAt,
        },
      };
    }
    return {
      ok: true,
      value: {
        state: outcome.parsed ? asNonEmptyString(outcome.parsed.state) : undefined,
        // `error_code` 一路带出（如 `disabled`）——消费方按它判"确定性结论 vs 继续等"
        errorCode: outcome.parsed ? asNonEmptyString(outcome.parsed.error_code) : undefined,
      },
    };
  }

  /** 成功产物装配（replay = HTTP 200；三键全部按派生规则回填，Hub 侧登记值与本处同源） */
  private successOf(slug: string, replay: boolean): HumentProvisioningResult {
    return {
      ok: true,
      value: {
        workspaceId: slug,
        actorId: HUMENT_PROVISIONING_ACTOR_ID,
        credentialRef: buildProvisioningCredentialRef(slug),
        replay,
      },
    };
  }

  /**
   * 一次带体的 operator 请求（POST 注册 / bootstrap；PATCH 生命周期命令）（**永不 throw**；
   * 纪律与 `HumentEngine.postJson` 逐条一致）。
   *
   * @param method HTTP 方法（`POST` = 注册/bootstrap；`PATCH` = 生命周期命令）
   * @param route `HUMENT_OPERATOR_ROUTES` 的路径（本方法自己拼 `baseUrl`）
   * @param headers 路由固定 header（`Content-Type` 已由调用方给全）
   * @param body 请求体
   * @param startedAt 墙钟起点（阶段硬顶会与剩余预算取小）
   * @param stageTimeoutMs 该阶段的 HTTP 硬顶（毫秒）
   * @param totalTimeoutMs 该条链的墙钟上限（provision 120s / 善后 40s）
   * @returns 状态码 + 已解析体 + cookie 头，或失败面
   */
  private async postOperator(
    route: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    startedAt: number,
    stageTimeoutMs: number,
    totalTimeoutMs: number = HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  ): Promise<OperatorHttpOutcome & { cookieHeaders?: Headers }> {
    return this.sendOperator(
      'POST',
      `${this.baseUrl}${route}`,
      headers,
      body,
      startedAt,
      stageTimeoutMs,
      totalTimeoutMs,
    );
  }

  /**
   * 带体的 operator 请求的**共体**（POST/PATCH 共用；`never-throw` + `redirect:'error'`）。
   *
   * @param method HTTP 方法
   * @param url 完整 URL（**无 query**）
   * @param headers 固定 header（含认证与幂等键）
   * @param body 请求体（生命周期命令 body 只有 `state`）
   * @param startedAt 墙钟起点
   * @param stageTimeoutMs 该阶段硬顶
   * @param totalTimeoutMs 该条链墙钟上限
   * @returns 状态码 + 已解析体 + cookie 头，或失败面
   */
  private async sendOperator(
    method: 'POST' | 'PATCH',
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    startedAt: number,
    stageTimeoutMs: number,
    totalTimeoutMs: number,
  ): Promise<OperatorHttpOutcome & { cookieHeaders?: Headers }> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.stageTimeoutMs(startedAt, stageTimeoutMs, totalTimeoutMs)),
        // 防 307/308 把带 cookie / 请求体的调用原样重发到第三方（先例 judgment.transport.ts）
        redirect: 'error',
      });
    } catch (err: unknown) {
      return this.transportFailure(err, startedAt);
    }
    const read = await this.readBody(response, startedAt);
    if (!read.ok) return read;
    return { ...read.outcome, cookieHeaders: response.headers };
  }

  /**
   * 一次 operator GET（**不带 Origin、禁 query**；见文件头不变量）。
   *
   * @param url 完整 URL（路径已编码，**无 query**）
   * @param headers 认证头（Cookie + Sec-Fetch-Site）
   * @param startedAt 墙钟起点
   * @param stageTimeoutMs 该阶段的 HTTP 硬顶（毫秒）
   * @param totalTimeoutMs 该条链的墙钟上限
   * @returns 状态码 + 已解析体，或失败面
   */
  private async httpGet(
    url: string,
    headers: Record<string, string>,
    startedAt: number,
    stageTimeoutMs: number,
    totalTimeoutMs: number = HUMENT_PROVISIONING_TOTAL_TIMEOUT_MS,
  ): Promise<OperatorHttpOutcome> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.stageTimeoutMs(startedAt, stageTimeoutMs, totalTimeoutMs)),
        redirect: 'error',
      });
    } catch (err: unknown) {
      return this.transportFailure(err, startedAt);
    }
    const read = await this.readBody(response, startedAt);
    return read.ok ? read.outcome : read;
  }

  /** 传输层失败的统一分类（fetch 阶段与 body 读阶段**同口径**） */
  private transportFailure(
    err: unknown,
    startedAt: number,
  ): { ok: false; failure: HumentProvisioningFailure } {
    const kind: HumentProvisioningFailureKind = isHumentTimeoutError(err)
      ? 'timeout'
      : 'unreachable';
    return {
      ok: false,
      failure: {
        kind,
        message: kind === 'timeout' ? FAILURE_MESSAGE_TIMEOUT : FAILURE_MESSAGE_UNREACHABLE,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * 读响应体 + 归一化（**错误体只取标量**；2xx 且体破损 = invalid_response）。
   *
   * @param response fetch 响应
   * @param startedAt 计时起点
   * @returns 已解析体，或失败面
   */
  private async readBody(
    response: Response,
    startedAt: number,
  ): Promise<
    { ok: true; outcome: OperatorHttpOutcome } | { ok: false; failure: HumentProvisioningFailure }
  > {
    const headerRequestId = asNonEmptyString(response.headers.get('X-Request-ID'));

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (err: unknown) {
      const failure = this.transportFailure(err, startedAt).failure;
      // body 读阶段（连接已建、体未读完）与 fetch 阶段**同口径**，只是带上已拿到的 request id
      return {
        ok: false,
        failure: {
          ...failure,
          message: `${failure.message} while reading the response body`,
          requestId: headerRequestId,
        },
      };
    }

    const parsed = parseJsonObject(rawText);

    if (!response.ok) {
      const envelope = parseHumentErrorEnvelope(parsed);
      return {
        ok: true,
        outcome: {
          ok: true,
          status: response.status,
          parsed,
          requestId: headerRequestId ?? envelope.requestId,
        },
      };
    }

    if (!parsed) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_response',
          message: FAILURE_MESSAGE_BODY_UNREADABLE,
          requestId: headerRequestId,
          latencyMs: Date.now() - startedAt,
        },
      };
    }
    return {
      ok: true,
      outcome: { ok: true, status: response.status, parsed, requestId: headerRequestId },
    };
  }
}

/**
 * 从已解析错误体里抽标量三件套（**只取 code/retryable/request_id**，原文丢弃）。
 *
 * @param parsed 已解析响应体（可为 null）
 * @returns 可并入 failure 的标量（缺省字段不出现）
 */
function scalarsOf(parsed: Record<string, unknown> | null): {
  engineCode?: string;
  retryable?: boolean;
} {
  const envelope = parseHumentErrorEnvelope(parsed);
  const out: { engineCode?: string; retryable?: boolean } = {};
  if (envelope.engineCode !== undefined) out.engineCode = envelope.engineCode;
  if (envelope.retryable !== undefined) out.retryable = envelope.retryable;
  return out;
}
