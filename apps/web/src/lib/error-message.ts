/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Web 错误呈现的**通道分级**：哪些错误的文案能原样上屏，哪些一律换成本地（i18n）文案
 *
 * [代码职责]
 *   - `errorMessageOf(error, fallback)`：错误对象 → 用户可见一句话（**全仓唯一实现**，禁止再抄副本）
 *   - `loginErrorKeyOf(error)`：登录失败 → auth 命名空间 i18n key（code → 文案映射单源）
 *   - `httpStatusOf` / `businessErrorCode`：给调用方做分叉用的读数（只读数，不产文案）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `Agent Chamber` → `docs/frontend/frontend-architecture.md` §错误处理
 *     — 通道分级规则与「页面错误态 / mutation toast / 全局兜底 toast」三层接线范式
 *
 * [关键不变量]
 *   - **只有 HTTP 4xx 且响应体带数字业务 code 时才透传服务端 message**。理由（两条都不是风格问题）：
 *     ① 5xx 的 message 是服务器内部措辞，可能带 SQL/堆栈线索；
 *     ② 无 response（断网/超时/取消）时 `error.message` 是 **axios 英文原文**
 *        （'Network Error' / 'timeout of 15000ms exceeded'）——中文界面直接夹生，且不告诉用户下一步。
 *   - **服务端 message 上屏前一律经 sanitize**（去换行 + 折叠空白 + 截断 300）：它是外部**不可信输入**，
 *     未截断的多行文本会撑破 toast/AlertDialog 的单行布局（同族先例：后端批量导入把裸
 *     `QueryFailedError.message` 写进 200 响应体的逐条 error 字段，
 *     `apps/backend/src/modules/docspace/doc-error.helper.ts` — 该面是**响应体**契约、
 *     不落顶层 4xx message，故本批只守前端 toast/错误态通道，契约面登记 F4）。
 *     调用方传的 `fallback` 则**原样返回**：那是本仓自己的 i18n 文案、不是外部输入，再洗一遍
 *     只会连"文案里混进了奇怪字符"这种真问题一起掩盖掉（清洗的目的是防外人，不是防自家人）。
 *   - 本文件**不持有任何用户可见字面量**：兜底文案由调用方传（页面里是 i18n 结果，非 React 通道
 *     走 `getApiMessage()`），否则又多一个文案漂移源。
 *
 * [关联代码]
 *   - `agent-chamber/apps/web/src/lib/api.ts` — 响应拦截器：给错误对象附业务 `code`、401 统一登出
 *   - `agent-chamber/apps/web/src/app/providers.tsx` — 全局 `QueryCache.onError` 兜底 toast（首载失败）
 *   - `agent-chamber/apps/web/src/lib/notify.ts` — toast 通道（命令式壳）
 *   - `agent-chamber/apps/web/src/i18n/api-messages.ts` — 非 React 通道的文案入口
 *
 * [持久踩坑]
 *   - SILENT-QUERY-FAIL(卡 240c74d6): `response?.data?.message || err.message || fallback` 这套三段式
 *     兜底把 axios 英文原文与 5xx 服务端措辞一并送上屏（断网时用户看到 'Network Error'）；同源的
 *     另一半是列表页**根本没接 `isError`**，失败渲染成空态 = 静默失败。安全方向：文案走本文件，
 *     失败态走「`isError && data === undefined` → 错误态 + 重试」。详情: 卡 240c74d6（本批）/ F3（剩余页面）
 *
 * [修改检查]（固定模板，不逐文件定制）
 *   □ 已读 [权威文档] 确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */

import { ErrorCode } from '@agent-chamber/shared';

/** 服务端 message 进屏前的截断上限（单行文案；超长一律截尾，防撑破 toast/AlertDialog 布局） */
const MAX_SERVER_MESSAGE_LENGTH = 300;

/**
 * axios 风格错误对象的最小结构。
 * 只声明本文件真正读的字段——不把 axios 类型引进来（本文件是纯函数层，要在非 React
 * 环境如 `QueryCache.onError` 里跑）。
 */
interface ErrorLike {
  response?: { status?: unknown; data?: { code?: unknown; message?: unknown } };
  /** 注：axios 网络层失败时这是**字符串**（'ERR_NETWORK' / 'ECONNABORTED'），不是业务码 */
  code?: unknown;
}

/** 任意抛出物 → 可安全取字段的形状（null/undefined 也收敛成空对象，免判空） */
function asErrorLike(error: unknown): ErrorLike {
  return (error ?? {}) as ErrorLike;
}

/**
 * 读 HTTP 状态码。
 *
 * @param error 任意抛出物
 * @returns 状态码；**无 response 时 null**——调用方据此区分「断网/超时」与「服务端答了错」
 */
export function httpStatusOf(error: unknown): number | null {
  const status = asErrorLike(error).response?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * 读后端 `{code, message}` 信封里的业务错误码。
 *
 * **只认 number**：axios 自有的 `error.code` 是字符串（'ERR_NETWORK'），读错了会把断网
 * 误判成「服务端答了业务错」——这正是通道分级最怕的假阳性。故只读 `response.data.code`。
 *
 * @param error 任意抛出物
 * @returns 数字业务码；缺失/非数字时 null
 */
export function businessErrorCode(error: unknown): number | null {
  const code = asErrorLike(error).response?.data?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * 服务端 message → 可上屏的一句话（去换行 + 折叠空白 + 截断）。
 *
 * @param error 任意抛出物
 * @returns 清洗后的文案；服务端没给非空字符串 message 时 null（由调用方兜底）
 */
function sanitizeServerMessage(error: unknown): string | null {
  const message = asErrorLike(error).response?.data?.message;
  if (typeof message !== 'string') return null;
  const cleaned = message.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_SERVER_MESSAGE_LENGTH);
}

/**
 * 错误对象 → 用户可见文案（**通道分级**，单源）。
 *
 * 分级规则（[关键不变量] 的可执行形态）：
 * - 4xx + 数字业务 code ⇒ 透传服务端 message（如 400 校验原因、403 缺 scope、409 冲突修复指引）；
 * - 5xx / 无 code / 无 response（断网、超时）⇒ 一律 fallback。
 *
 * @param error 任意抛出物（axios 错误、plain Error、甚至非 Error）
 * @param fallback 兜底文案，**由调用方给**（页面传 i18n 结果）
 * @returns 上屏用的一句话
 */
export function errorMessageOf(error: unknown, fallback: string): string {
  const status = httpStatusOf(error);
  if (status === null || status < 400 || status >= 500) return fallback;
  if (businessErrorCode(error) === null) return fallback;
  return sanitizeServerMessage(error) ?? fallback;
}

/**
 * 登录失败能落到的 auth 命名空间 key。
 *
 * 刻意用**字面量联合**（而非 `string`）：next-intl 的 `t()` key 有编译期校验，
 * 返回类型收窄到合法键集后调用点无需 `as any`，新增键时编译器会提醒同步。
 */
export type LoginErrorKey =
  | 'loginFailed'
  | 'loginErrorInvalidCredentials'
  | 'loginErrorAccountDisabled'
  | 'loginErrorRateLimited';

/** 兜底 key（服务端没给可识别 code、或压根没到服务端时用） */
export const LOGIN_ERROR_KEY_GENERIC: LoginErrorKey = 'loginFailed';

/**
 * 登录失败 → i18n key（**code → 文案映射单源**）。
 *
 * 为什么不透传服务端 message：后端 401 的 message 是英文（'Invalid credentials' /
 * 'Account is disabled'），中文界面直接夹生，且「密码错」与「账号停用」两句都不告诉用户
 * 下一步。故按 (status, code) 映射到本地文案：
 * - 401 + TOKEN_INVALID(1008) ⇒ 邮箱或密码错误。文案里带一句「若账号已被停用请联系管理员」：
 *   后端对**密码错**与**软删/不存在的账号**都回 1008（刻意不泄露账号是否存在，卡 e6926d73），
 *   前端无法区分，故用一句把另一条路径也覆盖掉——不是把两者说成同一回事；
 * - 401 + AGENT_DISABLED(1001) ⇒ 账号已停用（这一条后端给了明确码，可以直说）；
 * - 429 / RATE_LIMITED ⇒ 登录过于频繁（限流是登录爆破的补偿控制，必须告诉用户"等一下"）。
 *
 * @param error 任意抛出物
 * @returns auth 命名空间下的文案 key
 */
export function loginErrorKeyOf(error: unknown): LoginErrorKey {
  const status = httpStatusOf(error);
  const code = businessErrorCode(error);

  if (status === 401 && code === ErrorCode.TOKEN_INVALID) return 'loginErrorInvalidCredentials';
  if (status === 401 && code === ErrorCode.AGENT_DISABLED) return 'loginErrorAccountDisabled';
  // 429 同时认 status 与业务码：拦截器会给 429 附 RATE_LIMITED(429)，但直连/代理层
  // 自造的 429（如网关限流）可能没有本仓信封，两条都收才不会漏成「通用失败」。
  if (status === 429 || code === ErrorCode.RATE_LIMITED) return 'loginErrorRateLimited';

  return LOGIN_ERROR_KEY_GENERIC;
}
