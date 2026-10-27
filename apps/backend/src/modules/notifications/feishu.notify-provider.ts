/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 飞书（自建应用）私聊出口 —— Notifications 模块一期首发的唯一 provider（S3 真身）。
 *     两跳 HTTP：① `auth/v3/tenant_access_token/internal` 换应用凭证 ② `im/v1/messages`
 *     以 `receive_id_type=open_id` 发纯文本私聊。
 *
 * [代码职责]
 *   - `FeishuNotifyProvider`：实现 `NotifyProvider` 端口；`key = 'feishu'`
 *   - **token 生命周期**：进程内缓存（`expire` 秒 − 提前 5min 刷新）+ **in-flight promise 去重**
 *     （N 并发只发 1 次 token 请求，形态抄 `usage-stats-buffer.service.ts` 的 `inFlight`）
 *     + 收到鉴权类错误码时清缓存重取并重试 1 次
 *   - **错误分派**：把一切失败折进 `DeliveryOutcome`（见下表），并把"是否值得退避重试"与
 *     "是否要清 token 缓存"标在内部失败对象上
 *   - **退避**：`base * 2^(n-1)`（缺省 1s / 2s / 4s），上限由调用方预算压（见 `NotifySendOptions`）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §3 架构（FeishuProvider 段）/
 *     §8 S3 实施步骤 / §12 需要 Owner 配合（应用创建 + 凭据 + open_id 获取）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/api-definition.md`；
 *     落点后本定位符改为线上文档。
 *
 * [关键不变量]
 *   - **never-throw**（端口硬契约）：所有失败（超时 / DNS / 401 / 429 / code!==0 / 体不可解析）
 *     都折成 `failed` 终态——本文件由编排器的 fire-and-forget 管线调用，抛出即崩进程
 *     （plan §2 探针实证，本仓无全局 unhandledRejection 处理器）。`send` 外层还有一层
 *     catch-all：连"我们没预料到的异常"（如被替换成抛异常的 fetch）也只返回 failed。
 *   - **HTTP 200 不代表成功**：飞书业务错误同样是 `200 + body.code !== 0`。**判据是 code，
 *     不是状态码**——只按 `res.ok` 判成功会把"token 无效"记成送达。
 *   - **绝不回显 `app_secret` / `tenant_access_token` / 响应体原文**：`lastError` 只放
 *     "分类 + code + 上游 msg（压成单行、截断 200 字符）"；**body 原文一律不进日志**（可能回显
 *     凭据），响应体不可解析时只报"多少字符的意外内容"。写入侧另有 500 字符截断。
 *   - **token 缓存命中判据含提前量**：`now < expiresAt - 5min`。提前量是必须的——token 在
 *     "还剩 10 秒"时仍然算命中，但一次 8s 超时的请求正好会把它用过期（plan §3）。
 *   - **in-flight 去重只对"同一个 token 请求"生效**：`tokenInFlight` 被 N 个并发 `send` 共享
 *     ⇒ 上游只看到 1 次 `tenant_access_token/internal`。失败结果同样共享（N 个调用方一起失败，
 *     这正确：它们本来都会失败），且**不写缓存**⇒ 下一次调用重新取。
 *   - **鉴权重试只有一次**：清缓存 + 重取 + 重试 1 次；第 2 次鉴权失败即收口（否则一个配错的
 *     app_id 会被每条通知放大成 3 次无用请求 —— 那是"用放大错误来掩盖错误"）。
 *   - **频控不自动重试，只标识**：`429` 与飞书频控码族的窗口是**分钟级**，而我们的退避是
 *     秒级——重试既救不回来又多耗一次额度。故 `rate_limited` 记 `retryable: false`，
 *     由 `lastError` 的 `rate_limited` 前缀暴露给 admin 列表与运维。
 *   - **`key` 恒为 `'feishu'`**：与 config 值域、投递记录 `channel` 列同一个名字（三处同源）。
 *   - **出境面只有 `RenderedNotification`**：本文件不做内容加工（只把 title / body / link 拼成
 *     一条纯文本），新增外发内容必须回到编排器的渲染层去加（见 config 的 `NOTIFY_EGRESS_FIELDS`）。
 *
 * [错误分派表]（`AttemptFailure.kind` → retryable / clearToken；**按"跳"分列**——同一个 code
 * 族在两跳上的正确处置不同，见下）
 *   | 跳      | kind               | 触发                                            | 重试 | 清缓存 |
 *   |---------|--------------------|--------------------------------------------------|------|--------|
 *   | token   | `timeout`          | TimeoutError / AbortError（fetch 或读体阶段）     | 是   | 否     |
 *   | token   | `network`          | 连接拒绝 / DNS / TLS / redirect:error            | 是   | 否     |
 *   | token   | `invalid_response` | 体空 / 非 JSON / 缺 `tenant_access_token`         | 是   | 否     |
 *   | token   | `rate_limited`     | HTTP 429（**先于体可解析性**）或频控码族           | 否   | 否     |
 *   | token   | `http`             | 其余非 2xx（5xx 可重试，4xx 不重试）               | 视码 | 否     |
 *   | token   | `business`         | 200 且 `code !== 0`（凭据 / 应用级拒绝）           | 否   | 否     |
 *   | 发消息  | `timeout`          | 同 token 跳                                       | 是   | 否     |
 *   | 发消息  | `network`          | 同 token 跳                                       | 是   | 否     |
 *   | 发消息  | `invalid_response` | 体空 / 非 JSON（HTTP 已回；交付状态不可判定）      | 是   | 否     |
 *   | 发消息  | `rate_limited`     | HTTP 429（**先于体可解析性**）或频控码族           | 否   | 否     |
 *   | 发消息  | `auth`             | code 族 `999916*` 或 HTTP 401/403                | 1 次 | **是** |
 *   | 发消息  | `http`             | 其余非 2xx（⚠️ 先判状态再判 code；5xx 可重试）      | 视码 | 否     |
 *   | 发消息  | `business`         | 200 且 `code !== 0`（receive_id 非法、机器人不在会话…）| 否 | 否   |
 *   ⚠️ **为什么 token 跳没有 `auth`**：刚取到（或正要用）的 token 被拒，能做的只有"重取"——而
 *      这里还没到发消息那一步，清缓存重取毫无意义；同族码在 token 跳 = 应用/凭据本身被拒
 *      （app_id 不存在、secret 错、应用停用），归 `business` 且不重试（重试一个配错的 secret
 *      只会把错误放大成 N 倍请求）。`auth` 的"清缓存 + 重取一次"只有**发消息**跳才说得通。
 *   ⚠️ 码族判断**不穷举**：只按族前缀 + 小集合分流，其余一律 `business` 并把 code+msg 记下——
 *      飞书新增错误码时我们的行为是"不重试 + 记下来"，而不是"猜错族"。msg 截断入错误串，
 *      运维能据此人工归类（这也是码族不穷举的补偿）。
 *
 * [关联代码]
 *   - notify-provider.interface.ts — 端口契约（`RenderedNotification` / `DeliveryOutcome` /
 *     `NotifySendOptions` 重试预算）
 *   - notifications-provider.factory.ts — 本类的装配点（`NOTIFY_PROVIDERS` 含 feishu 时构造，
 *     注入 config 的飞书键与 `httpTimeoutMs`）
 *   - notify-orchestrator.service.ts — 唯一调用方（终态落库；只传通知，不传预算 ⇒ 事件链路档）
 *   - ../../config/notifications.config.ts — `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
 *     `NOTIFY_HTTP_TIMEOUT_MS` 的来源
 *   - feishu.notify-provider.spec.ts — token 缓存 / 去重 / 分派 / 退避 / never-throw 单测
 *
 * [持久踩坑]
 *   NOTIFY-FEISHU-HTTP-200-IS-NOT-OK(200 当成功): 飞书业务错误也是 200 + `code!==0`，
 *     只按 `res.ok` 判成功会把"token 无效 / 收件人非法"记成成功送达（投递表一片绿、用户一条
 *     收不到）。安全方向: 一律先判 `code`（见 [关键不变量]）+ 单测钉死"200 + code=99991661"。
 *   NOTIFY-FEISHU-SECRET-ECHO(错误串带凭据): 上游错误体/异常原文可能夹带 app_secret 或 token
 *     片段。安全方向: `lastError` 只由**我们拼的固定标签 + code + 截断 msg** 构成；
 *     响应体原文一律不进日志/不落库。
 *   NOTIFY-FEISHU-STALE-TOKEN-STAMPEDE(过期 token 风暴): 无提前量 ⇒ 有效期边界上每条通知都
 *     触发一次换 token；无 in-flight 去重 ⇒ N 条并发通知发 N 次 token 请求（飞书侧会限流）。
 *     安全方向: 提前 5min 刷新 + `tokenInFlight` 共享同一 promise。
 *
 * [铁律关联] #11(注释强制) #17(测试契约) #18(不变量检查)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 改错误分派必须同步 [错误分派表] + spec 的分派矩阵（表与代码同 commit）
 *   □ 新增任何进入日志/错误串的内容：先问"它可能是凭据吗"（见 [关键不变量] 第二条）
 *   □ 改重试/退避语义必须同时看 `NotifySendOptions` 的预算夹逼（直发链路 ≤2 次 / ≤10s）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  DeliveryFailureKind,
  DeliveryOutcome,
  NotifyProvider,
  NotifySendOptions,
  RenderedNotification,
} from './notify-provider.interface';

/** 飞书出口的渠道标识（= 投递记录 `channel` 列取值；单源在本常量与 config 值域的一致性） */
export const FEISHU_PROVIDER_KEY = 'feishu';

/** 换 `tenant_access_token` 的端点（自建应用形态；body = `{app_id, app_secret}`） */
const FEISHU_TENANT_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

/** 发消息端点（收件人类型走 query：`?receive_id_type=open_id`） */
const FEISHU_MESSAGES_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';

/**
 * 提前刷新量（毫秒）。
 *
 * rationale：token 的 `expire` 是"还剩多久算有效"，但一次请求本身可能耗掉 8s（超时档）——
 * 不留提前量就会出现"检查时有效、发出去时已过期"的窗口期，表现为偶发的 99991661
 * （只在有效期边界附近、只在慢请求上复现，是最难排的一类）。
 */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 上游没给 `expire` 时的兜底 TTL（秒）。飞书实弹值为 7200——兜底取同一个数，不为省事取小值 */
const DEFAULT_TOKEN_TTL_SECONDS = 7200;

/**
 * 事件链路档：最多 3 次尝试（1s / 2s 退避）。
 *
 * rationale：事件链路是 fire-and-forget（没人等结果），退避到 2s 不心疼；plan §3 给的就是
 * "指数退避 ≤3 次"。直发链路的 ≤2 次 / ≤10s 由调用方经 `NotifySendOptions` 显式传入
 * （见 notify-provider.interface.ts）——**本文件不读 env**，预算只从调用方来。
 */
const EVENT_CHAIN_MAX_ATTEMPTS = 3;

/**
 * `maxAttempts` 的封顶（防"手滑的 1000 次"）。
 *
 * 这是**每次投递**的网络预算：调用方传什么都不该让一条通知打上千次上游；且退避是
 * `base * 2^(n-1)`，指数项会当场溢出成不可等待的数字（见 resolveMaxAttempts）。
 */
const MAX_ATTEMPTS_CEILING = 10;

/** 退避基准（毫秒）：第 n 次重试前等 `base * 2^(n-1)`；测试注入 0 免等 */
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;

/** `lastError` 的最大长度（写入侧另有 500 字符截断，这里是第一道） */
const LAST_ERROR_MAX_LENGTH = 200;

/** 上游 `msg` 的截断长度（单条错误串里最多留这么多字符） */
const UPSTREAM_MSG_MAX_LENGTH = 200;

/**
 * 鉴权类错误码的**族前缀**（**只对"发消息跳"生效**，见文件头 [错误分派表] 的"跳"列）。
 *
 * `999916xx` 是飞书 token/鉴权一族的编码段（99991661 token 无效、99991663/99991664 等应用级
 * 鉴权失败）。在**发消息**时按前缀判族 ⇒ 清缓存重取 + 重试一次（新增同族码也自动享受这条
 * 正确的处置）；而在**取 token** 时同一族码意味着"应用/凭据本身被拒"——刚刚才取过 token，
 * 再取一次没有任何意义，故那里落 `business` 且不重试（清缓存更是无从谈起：缓存本来就是空的）。
 */
const AUTH_CODE_PREFIX = '999916';

/**
 * 频控类错误码的**小集合**（非穷举，见 [错误分派表] 的 ⚠️）。
 *
 * 99991400 = 飞书通用频率限制；230002 / 230020 = im 侧发信频控码。未列出的码一律 `business`
 * （不重试 + code/msg 入错误串）——"不重试"是最保守的一侧，码族认错只会少一次无用重试。
 */
const RATE_LIMIT_CODES = new Set<string>(['99991400', '230002', '230020']);

/** 判定"这个 HTTP 状态本身就说明鉴权不过"（token 被拒的另一种表达） */
function isAuthHttpStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/** 超时判别：`AbortSignal.timeout` 抛 `TimeoutError`，部分环境/手动 abort 为 `AbortError` */
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** 截断（**不回显原文**是本文件的纪律，截断只用于把"我们拼的标签 + code + msg"压进列宽） */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 上游 `msg` 净化：压成单行（防日志注入 / 多行刷屏）+ 截断；非字符串/空 ⇒ `-` */
function normalizeUpstreamMessage(msg: unknown): string | null {
  if (typeof msg !== 'string' || msg.length === 0) return null;
  return msg.replace(/\s+/g, ' ').trim();
}

/** 错误码归一显示（可能是 number / string / undefined） */
function formatCode(code: unknown): string {
  if (code === null || code === undefined) return '-';
  const text = String(code);
  return text.length > 0 ? text : '-';
}

/**
 * 判成功：`code` **严格**等于 `0` 或 `'0'`。
 *
 * ⚠️ 不能用 `Number(code) === 0` 松判：`{"code":""}` / `{"code":[]}` 都会被强转成 0 ⇒
 * 把一个"上游根本没给我们 code"的响应判成**送达成功**（投递表一片绿、用户一条收不到，且
 * 事后无从排查——因为记录说成功了）。这里宁可 fail-closed：不确定 ⇒ 不算成功。
 */
function isSuccessCode(code: unknown): boolean {
  return code === 0 || code === '0';
}

/**
 * 解析 `maxAttempts`（**消毒 + 封顶**）。
 *
 * 非法（缺失 / NaN / 非数 / <1）⇒ 回落事件链路档；合法值夹到 `[1, MAX_ATTEMPTS_CEILING]`。
 * 封顶的理由：这是**每次投递**的网络预算，一个手滑的 `maxAttempts: 1000` 会变成一条通知打
 * 1000 次上游（且退避是 `base * 2^(n-1)`——指数项会当场溢出成不可等待的数字）。
 */
function resolveMaxAttempts(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return EVENT_CHAIN_MAX_ATTEMPTS;
  }
  return Math.min(MAX_ATTEMPTS_CEILING, Math.floor(requested));
}

/**
 * 解析 `budgetMs`（**消毒**；返回 `null` = 无总预算）。
 *
 * 非法（NaN / 非数 / <1）⇒ 归一为 **0 = "进门即已耗尽"**（一次都不发，投递行仍记 attempts=1 的
 * 短路语义）。为什么不回落成"无上限"：一个写错的预算（如 `budgetMs: NaN`）在直发链路上会让
 * 端点把 agent 客户端拖到超时——**"没有预算"是最危险的那种解释**，fail-closed 才是对称的。
 */
function resolveBudgetMs(requested: number | undefined): number | null {
  if (requested === undefined) return null;
  if (!Number.isFinite(requested) || requested < 1) return 0;
  return Math.floor(requested);
}

/** 该 code 是否属于鉴权族 */
function isAuthCode(code: unknown): boolean {
  if (code === null || code === undefined) return false;
  return String(code).startsWith(AUTH_CODE_PREFIX);
}

/** 该 code 是否属于频控族 */
function isRateLimitCode(code: unknown): boolean {
  if (code === null || code === undefined) return false;
  return RATE_LIMIT_CODES.has(String(code));
}

/** 退避等待（**本文件唯一的时间副作用**；测试把基准置 0 即可免等） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 响应体读取（**防御性解析**：体读失败与体不可解析都要分类，而不是让异常冒到调用点）。
 *
 * `kind` 是**判别式的一部分**而不是调用点自己猜：读体阶段超时应与 fetch 阶段同判 `timeout`
 * （连接已建立、体未读完 ≠ 我们收到了一个坏响应）。调用点按 `kind` 原样透传。
 *
 * 失败描述**只含"体长多少字符"**，绝不含体内容——响应体可能回显凭据（见文件头不变量）。
 */
async function readJsonObject(
  response: Response,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: 'timeout' | 'invalid_response'; reason: string }
> {
  let text: string;
  try {
    text = await response.text();
  } catch (err: unknown) {
    return isTimeoutError(err)
      ? {
          ok: false,
          kind: 'timeout',
          reason: 'timed out while reading the response body',
        }
      : {
          ok: false,
          kind: 'invalid_response',
          reason: 'the response body could not be read',
        };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: 'invalid_response', reason: 'the response body was empty' };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, body: parsed as Record<string, unknown> };
    }
  } catch {
    // 落到下面统一的"非 JSON 对象"分支（不打印异常原文）
  }
  return {
    ok: false,
    kind: 'invalid_response',
    reason: `the response body was not a JSON object (${trimmed.length} chars of unexpected body)`,
  };
}

/**
 * 失败分类（内部类型；**不外泄**——最终只折进 `DeliveryOutcome.lastError`）。
 */
type FeishuFailureKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'auth'
  | 'rate_limited'
  | 'business';

interface AttemptFailure {
  /** 分类（见文件头 [错误分派表]） */
  kind: FeishuFailureKind;
  /** 本次尝试拿到的 HTTP 状态（未拿到响应 = null） */
  responseStatus: number | null;
  /** 失败短描述（已净化 / 已截断；可直接进 `lastError` 与日志） */
  error: string;
  /** 是否值得退避重试（由 `deliverWithRetry` 消费） */
  retryNext: boolean;
  /** 是否需要清空 token 缓存（鉴权类） */
  clearToken?: boolean;
  /**
   * **是否可归因到"这个收件地址"**（Notifications 二期 M6；只由**发消息跳**的拒绝分支设置）。
   *
   * 判据（只在这一处收口，避免消费方各自解释 `lastError` 文本）：
   * - 发消息跳拿到 **4xx** 或 **业务码非 0**（分派表里写明的 `receive_id 非法 / 机器人不在会话`）
   *     ⇒ `true`（重试同一个地址不会变好）；
   * - 其余（传输层 / 5xx / 鉴权 / 频控 / 体不可解析 / token 跳的一切）⇒ `false`/未设。
   *
   * ⚠️ **`auth` 分支刻意不算地址问题**：401/403 是应用凭据或权限，不是"这个人收不到"。
   */
  addressAttributable?: boolean;
  /**
   * 本次请求实际使用的 token（仅"发消息跳"的失败带；token 跳 / 未发字节的失败为 undefined）。
   *
   * 用途：`clearToken` 前比对缓存——只有"缓存里还是这个被拒的 token"时才清，
   * 免得误伤并发调用刚换上的新 token（见 `deliverWithRetry` 注释）。
   */
  usedToken?: string;
}

/** 一次尝试的结果（判别式联合：成功必须带真实回执状态，漏处理编译期即红） */
type AttemptResult = { failure: null; responseStatus: number } | { failure: AttemptFailure };

/** token 获取结果（判别式联合：调用点必须分别处理，漏一支编译期就红） */
type TokenResult = { token: string } | { failure: AttemptFailure };

/**
 * 本 provider 的构造参数（**由工厂注入 config 的飞书键**，见 notifications-provider.factory.ts）。
 *
 * 后三个字段只服务测试：退避基准置 0 免等、`fetchImpl` / `now` 可注入以摆脱全局态与真实时钟
 * （先例 `judgment.transport.ts` / `usage-stats-buffer.service.ts` 的依赖注入形态）。
 */
export interface FeishuProviderOptions {
  /** 自建应用 App ID（未配置 null ⇒ 每次投递短路为 failed，不发任何请求） */
  appId: string | null;
  /** 自建应用 App Secret（**绝不出现在日志 / 错误串 / 投递记录里**） */
  appSecret: string | null;
  /** provider HTTP 超时（毫秒；来自 `NOTIFY_HTTP_TIMEOUT_MS`） */
  httpTimeoutMs: number;
  /** 退避基准（毫秒；测试传 0） */
  retryBaseDelayMs?: number;
  /** HTTP 客户端（缺省 = **调用时**取全局 `fetch`，故单测后装 mock 也能命中） */
  fetchImpl?: typeof fetch;
  /** 时钟（测试控制 token 过期；缺省 `Date.now`） */
  now?: () => number;
}

/**
 * 飞书私聊 provider（一期唯一实现；生命周期 = 进程，持有 token 缓存与 in-flight 句柄）。
 *
 * 无状态的部分（HTTP 编排、错误分派）与有状态的部分（token 缓存）刻意放在一个类里：
 * 缓存的**唯一**用途就是给 `send` 用，拆出去只会让"谁清缓存"变成跨文件问题。
 */
@Injectable()
export class FeishuNotifyProvider implements NotifyProvider {
  /** 渠道标识（= `channel` 列） */
  readonly key = FEISHU_PROVIDER_KEY;

  private readonly logger = new Logger(FeishuNotifyProvider.name);

  private readonly appId: string | null;
  private readonly appSecret: string | null;
  private readonly httpTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  /** 缓存的 token（`expiresAtMs` 是**上游给的绝对失效时刻**，不是剩余秒数） */
  private cachedToken: { value: string; expiresAtMs: number } | null = null;

  /**
   * 在途 token 请求（**N 并发只发 1 次**：后到者共享同一个 promise）。
   *
   * 形态抄 `usage-stats-buffer.service.ts` 的 `inFlight`：置位 → await → finally 清位。
   * ⚠️ 失败结果同样被共享（并发调用方一起失败）——这正确，它们本来都会失败；
   * 且失败**不写缓存**，下一次调用会重新发起。
   */
  private tokenInFlight: Promise<TokenResult> | null = null;

  constructor(options: FeishuProviderOptions) {
    // trim 归一：.env 尾随空格 / CRLF 污染不得把合法值判成非法；空串 ⇒ null（未配置）
    this.appId = options.appId?.trim() || null;
    this.appSecret = options.appSecret?.trim() || null;
    this.httpTimeoutMs = options.httpTimeoutMs > 0 ? options.httpTimeoutMs : 1;
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    // 缺省 fetch 用**包装函数**而不是 `globalThis.fetch` 的直接引用：单测在构造之后安装
    // `globalThis.fetch = jest.fn()` 也能命中（引用会被早绑定，包装函数不会）。
    this.fetchImpl =
      options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
  }

  /**
   * 发一条通知（**永不 throw**；见文件头 [关键不变量]）。
   *
   * @param notification 已渲染的通知（出境面）
   * @param opts 重试预算（缺省 = 事件链路档：≤3 次、无总预算上限）
   * @returns 终态（失败也 resolve）
   */
  async send(
    notification: RenderedNotification,
    opts?: NotifySendOptions,
  ): Promise<DeliveryOutcome> {
    const startedAt = this.now();
    // 可变计数器（**attempts 如实记**）：catch-all 也要能报出"到底试了几次"
    const counter = { attempts: 0 };
    try {
      return await this.deliverWithRetry(notification, opts, startedAt, counter);
    } catch (err: unknown) {
      // 最后防线：连"我们没预料到的异常"也只返回 failed（如 fetch 被替换成抛异常的 mock、
      // 或未来某次重构漏了一个 await）。端口契约不允许抛出——调用方是 fire-and-forget 管线。
      // ⚠️ 原始异常文本同样先过**凭据抹除**再截断：异常消息里可能夹着 URL / key / token
      //    （纵深防御——`lastError` 会落库并进 admin 列表，见 sanitizeUpstreamMessage 注释）。
      const reason = truncate(
        this.redactSecrets(
          String((err as Error)?.message ?? err)
            .replace(/\s+/g, ' ')
            .trim(),
        ),
        LAST_ERROR_MAX_LENGTH,
      );
      this.logger.warn(
        `feishu send aborted by an unexpected error (category=${notification.category}): ${reason}`,
      );
      return {
        status: 'failed',
        attempts: Math.max(1, counter.attempts),
        responseStatus: null,
        lastError: `unexpected error: ${reason}`,
        deliveredAt: null,
        // M6：我们没预料到的异常 ⇒ 不能归因到地址（保守：不写验证态）
        failureKind: 'provider',
      };
    }
  }

  /**
   * 带预算的投递主循环（短路 → 尝试 → 分派 → 退避）。
   *
   * @param notification 成品通知
   * @param opts 调用方预算（见 `NotifySendOptions`）
   * @param startedAt `send` 进入时刻（预算起算点）
   * @param counter 尝试计数（引用传递，供 catch-all 读取）
   * @returns 终态
   */
  private async deliverWithRetry(
    notification: RenderedNotification,
    opts: NotifySendOptions | undefined,
    startedAt: number,
    counter: { attempts: number },
  ): Promise<DeliveryOutcome> {
    const maxAttempts = resolveMaxAttempts(opts?.maxAttempts);
    const budgetMs = resolveBudgetMs(opts?.budgetMs);
    /** 总预算的绝对截止时刻（null = 事件链路档，只受单次超时约束） */
    const deadline = budgetMs === null ? null : startedAt + budgetMs;

    // 短路 ①：没有收件人。编排器已经不发（config 未配），这里是**防御层**——本文件是出口端口，
    // 不能假设调用方永远填好字段。attempts: 1 = "尝试过一次"（未发字节，见端口不变量）。
    if (!notification.recipient) {
      counter.attempts = 1;
      return this.finalFailure(
        1,
        null,
        'no recipient configured (FEISHU_RECIPIENT_OPEN_ID is empty)',
        // M6：这是**部署配置**问题，不是地址被拒 ⇒ 明确归 provider（不写验证态）
        'provider',
      );
    }

    // 短路 ②：凭据缺失。启动期 config 已对 production 做 fail-fast；dev/test 下这里兜住，
    // 免得把"没配凭据"表现成一次真实的 401（那会把排障引向"凭据错了"而不是"凭据没配"）。
    if (!this.appId || !this.appSecret) {
      counter.attempts = 1;
      return this.finalFailure(
        1,
        null,
        'feishu credentials are not configured (FEISHU_APP_ID / FEISHU_APP_SECRET)',
        // M6：同上——凭据未配是应用级问题（`responseStatus` 为 null，不显式归因会被推成 transport）
        'provider',
      );
    }

    /** 鉴权重试闸：整个 `send` 只允许一次"清缓存重取"（见文件头不变量） */
    let authRetried = false;
    let lastFailure: AttemptFailure | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // 预算进门即已耗尽（非法 / 非正 budgetMs 归一为 0，见 resolveBudgetMs）⇒ 一次都不发。
      // ⚠️ 计数必须在这次检查**之后**才自增：先自增会让"报了 2 次、实际只发 1 次"这类虚报
      //    混进投递表（attempts 是运维判断"是上游抖还是我们疯了"的唯一依据）。
      if (deadline !== null && this.now() >= deadline) {
        lastFailure = lastFailure ?? {
          kind: 'timeout',
          responseStatus: null,
          error: `retry budget of ${budgetMs}ms was exhausted before the first attempt`,
          retryNext: false,
        };
        break;
      }

      counter.attempts = attempt;

      const result = await this.attemptOnce(notification, deadline, authRetried);
      if (result.failure === null) {
        return {
          status: 'success',
          attempts: attempt,
          // 真实回执状态（不硬编码 200）：上游回 201/202 时投递表要记我们真正收到的那个码
          responseStatus: result.responseStatus,
          lastError: null,
          deliveredAt: new Date(),
        };
      }
      const failure = result.failure;

      // 清缓存**仅当缓存里仍是本次请求所用的那个 token**：否则会误伤另一个并发调用刚换上的
      // 新 token（把 N 并发下的 token 抖动放大成反复重取）。
      if (failure.clearToken && this.cachedToken?.value === failure.usedToken) {
        this.cachedToken = null;
      }
      if (failure.kind === 'auth') authRetried = true;
      lastFailure = failure;

      // 分派：不值得重试（business / rate_limited / 第二次鉴权失败）或多试无益（已是最后一次）
      if (!failure.retryNext || attempt === maxAttempts) break;

      const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
      // 退避会吃掉预算 ⇒ 现在收口，而不是"等到超预算再发一次注定来不及的请求"
      if (deadline !== null && this.now() + delay >= deadline) {
        lastFailure = {
          ...failure,
          error: `${failure.error} (retry budget of ${budgetMs}ms left no room for the ${delay}ms backoff)`,
          retryNext: false,
        };
        break;
      }
      await sleep(delay);
    }

    this.logger.warn(
      `feishu delivery failed after ${counter.attempts} attempt(s) ` +
        `(category=${notification.category}, kind=${lastFailure?.kind ?? 'unknown'}): ` +
        `${lastFailure?.error ?? 'unknown failure'}`,
    );
    return this.finalFailure(counter.attempts, lastFailure);
  }

  /**
   * 一次尝试：确保 token → 发消息 → 分派。
   *
   * @param notification 成品通知
   * @param deadline 总预算截止时刻（null = 无）
   * @param authRetried 是否已经用过"鉴权重试"名额（决定本次鉴权失败的 retryNext）
   * @returns `{ failure: null, responseStatus }` = 成功；否则失败分类
   */
  private async attemptOnce(
    notification: RenderedNotification,
    deadline: number | null,
    authRetried: boolean,
  ): Promise<AttemptResult> {
    const tokenResult = await this.acquireToken(deadline);
    if ('failure' in tokenResult) return { failure: tokenResult.failure };
    return this.postMessage(tokenResult.token, notification, deadline, authRetried);
  }

  /**
   * 取 `tenant_access_token`（缓存命中 → 直返；在途 → 共享；否则发一次）。
   *
   * @param deadline 总预算截止时刻（决定这次请求自己的超时上界）
   * @returns token，或失败分类
   */
  private async acquireToken(deadline: number | null): Promise<TokenResult> {
    const cached = this.cachedToken;
    if (cached && this.now() < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return { token: cached.value };
    }
    // 在途去重：N 并发只让上游看到 1 次 token 请求（见文件头不变量）
    if (this.tokenInFlight) return this.tokenInFlight;

    const running = this.fetchTenantAccessToken(deadline);
    this.tokenInFlight = running;
    try {
      return await running;
    } finally {
      // 只有创建者清位（后到者走上面的早返回分支，不碰这个字段）
      this.tokenInFlight = null;
    }
  }

  /**
   * 换一次 `tenant_access_token`（**HTTP 200 不代表成功**：判 `code` 见文件头不变量）。
   *
   * @param deadline 总预算截止时刻
   * @returns token（并写入缓存），或失败分类
   */
  private async fetchTenantAccessToken(deadline: number | null): Promise<TokenResult> {
    const what = 'the tenant_access_token request';
    // 生效超时（**夹逼到剩余预算**）：既用于 signal，也用于错误串——两处必须是同一个数字，
    // 否则直发小预算下我们会报一个不真实的超时值（"超时 8000ms"而其实 900ms 就放弃了）
    const timeoutMs = this.effectiveTimeoutMs(deadline);
    let response: Response;
    try {
      response = await this.fetchImpl(FEISHU_TENANT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        // ⚠️ 这是 secret 的唯一去处：请求体。不进日志、不进错误串、不进投递记录。
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
        signal: AbortSignal.timeout(timeoutMs),
        // 防 307/308 把带 secret 的 POST 原样重发到第三方
        redirect: 'error',
      });
    } catch (err: unknown) {
      return { failure: this.classifyThrown(err, what, timeoutMs) };
    }

    const parsed = await readJsonObject(response);

    // ⚠️ **429 先判，先于"体能不能解析"**（与 postMessage 同一条纪律）：飞书频控是分钟级窗口，
    //    若因为体不可解析而落进 invalid_response（可重试），我们会白发两次请求，还把真实原因
    //    （限流）藏在 "not JSON" 后面——排障的人会去查代理，而不是去查额度。
    if (response.status === 429 || (parsed.ok && isRateLimitCode(parsed.body.code))) {
      return {
        failure: {
          kind: 'rate_limited',
          responseStatus: response.status,
          error:
            `${what} was rate limited (HTTP ${response.status}, ` +
            `code=${formatCode(parsed.ok ? parsed.body.code : undefined)}, ` +
            `msg=${parsed.ok ? this.sanitizeUpstreamMessage(parsed.body.msg) : '-'})`,
          retryNext: false,
        },
      };
    }

    if (!parsed.ok) {
      return {
        failure: {
          // 体读阶段超时与 fetch 阶段同判 timeout（见 readJsonObject 注释）
          kind: parsed.kind,
          responseStatus: response.status,
          error: `${what} returned HTTP ${response.status} but ${parsed.reason}`,
          retryNext: true,
        },
      };
    }
    const body = parsed.body;
    const code = body.code;
    const msg = this.sanitizeUpstreamMessage(body.msg);

    if (!response.ok) {
      return {
        failure: {
          kind: 'http',
          responseStatus: response.status,
          error: `${what} returned HTTP ${response.status} (code=${formatCode(code)}, msg=${msg})`,
          retryNext: response.status >= 500,
        },
      };
    }
    if (!isSuccessCode(code)) {
      // token 端点的非零 code = 凭据/配置问题（app_id 不存在、secret 错、应用被停用…）：
      // **不重试**——重试一个配错的 secret 只会把错误放大成 N 倍请求。code+msg 记下来给人看。
      return {
        failure: {
          kind: 'business',
          responseStatus: response.status,
          error: `${what} was rejected (code=${formatCode(code)}, msg=${msg})`,
          retryNext: false,
        },
      };
    }

    const rawToken = body.tenant_access_token;
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return {
        failure: {
          kind: 'invalid_response',
          responseStatus: response.status,
          error: `${what} succeeded (code=0) but carried no tenant_access_token — check the response contract`,
          retryNext: true,
        },
      };
    }

    const ttlSecondsRaw = Number(body.expire);
    const ttlSeconds =
      Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0
        ? Math.floor(ttlSecondsRaw)
        : DEFAULT_TOKEN_TTL_SECONDS;
    this.cachedToken = { value: rawToken, expiresAtMs: this.now() + ttlSeconds * 1000 };
    // ⚠️ 只打 TTL，绝不打 token 本身
    this.logger.log(`feishu tenant_access_token refreshed (expires in ${ttlSeconds}s)`);
    return { token: rawToken };
  }

  /**
   * 发一条私聊文本（`im/v1/messages?receive_id_type=open_id`）。
   *
   * @param token 有效的 tenant_access_token
   * @param notification 成品通知（title / body / link 拼成纯文本，见 `buildMessageText`）
   * @param deadline 总预算截止时刻
   * @param authRetried 是否已用过鉴权重试名额
   * @returns `{ failure: null, responseStatus }` = 成功（带**真实回执状态**）；否则失败分类
   */
  private async postMessage(
    token: string,
    notification: RenderedNotification,
    deadline: number | null,
    authRetried: boolean,
  ): Promise<AttemptResult> {
    const what = 'the im/v1/messages request';
    // 生效超时（与 token 跳同一套夹逼；见 fetchTenantAccessToken 注释）
    const timeoutMs = this.effectiveTimeoutMs(deadline);
    let response: Response;
    try {
      response = await this.fetchImpl(`${FEISHU_MESSAGES_URL}?receive_id_type=open_id`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: notification.recipient,
          msg_type: 'text',
          // 飞书文本消息的 content 是**字符串化的 JSON**（双层编码，不是嵌套对象）
          content: JSON.stringify({ text: buildMessageText(notification) }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err: unknown) {
      return { failure: this.classifyThrown(err, what, timeoutMs) };
    }

    const parsed = await readJsonObject(response);
    // ⚠️ **429 必须先判，先于"体能不能解析"**：飞书频控是分钟级窗口，若因为体不可解析而落进
    //    invalid_response（可重试），我们会白发两次请求，并且把真实原因（限流）藏在
    //    "not JSON" 后面——排障的人会去查代理，而不是去查额度。
    if (response.status === 429 || (parsed.ok && isRateLimitCode(parsed.body.code))) {
      return {
        failure: {
          kind: 'rate_limited',
          responseStatus: response.status,
          error:
            `${what} was rate limited (HTTP ${response.status}, ` +
            `code=${formatCode(parsed.ok ? parsed.body.code : undefined)}, ` +
            `msg=${parsed.ok ? this.sanitizeUpstreamMessage(parsed.body.msg, token) : '-'})`,
          retryNext: false,
        },
      };
    }

    if (!parsed.ok) {
      // HTTP 已回但内容不认（代理错误页 / 空体 / 读体中断）⇒ 交付状态**不可判定**。归"可重试"：
      // 与超时同口径（plan §3"传输层不确定 → 重放"），且真发过一次的代价是重复提醒，
      // 比"静默丢一条通知"轻。kind 由 readJsonObject 判（读体超时 → timeout）。
      return {
        failure: {
          kind: parsed.kind,
          responseStatus: response.status,
          error: `${what} returned HTTP ${response.status} but ${parsed.reason}`,
          retryNext: true,
        },
      };
    }
    const body = parsed.body;
    const code = body.code;
    // 带上本次在用的 token：上游 msg 若把凭据回显出来，这里连同 app_secret 一起抹掉
    const msg = this.sanitizeUpstreamMessage(body.msg, token);

    if (isAuthCode(code) || isAuthHttpStatus(response.status)) {
      // 鉴权族：**清缓存 + 重取 + 重试 1 次**。第二次再失败即收口（见文件头不变量）。
      return {
        failure: {
          kind: 'auth',
          responseStatus: response.status,
          error:
            `${what} was rejected by the auth layer (HTTP ${response.status}, ` +
            `code=${formatCode(code)}, msg=${msg})`,
          retryNext: !authRetried,
          clearToken: true,
          // 被拒的是**这个** token：调用方据此判断"缓存是否该清"（见 deliverWithRetry 注释）
          usedToken: token,
        },
      };
    }

    if (!response.ok) {
      // 非 2xx 且不是上面两类：**HTTP 层拒绝**。⚠️ 这一支必须在判 code 之前——飞书的错误体
      // 里 `code` 可能是 0（网关/代理自己回的 500 就是这种形状），先判 code 会把 5xx 判成成功。
      // 5xx 归可重试（对端抖了），4xx 不重试（请求本身有问题）。
      return {
        failure: {
          kind: 'http',
          responseStatus: response.status,
          error: `${what} returned HTTP ${response.status} (code=${formatCode(code)}, msg=${msg})`,
          retryNext: response.status >= 500,
          // M6：发消息跳的 4xx = 这次请求被拒（不是上游抖）⇒ 可归因到地址；5xx 不算
          addressAttributable: response.status < 500,
        },
      };
    }

    if (!isSuccessCode(code)) {
      // 其余业务错误（receive_id 非法 / 机器人不在会话 / 应用无 im 权限…）：**不重试**，
      // 重试只会重复同一个拒绝。code+msg 记下来给运维（码族不穷举的补偿，见文件头）。
      return {
        failure: {
          kind: 'business',
          responseStatus: response.status,
          error: `${what} was rejected (HTTP ${response.status}, code=${formatCode(code)}, msg=${msg})`,
          retryNext: false,
          // M6：分派表把发消息跳的 business 明确记为「receive_id 非法 / 机器人不在会话」——
          // 即"这个收件人收不到"。⚠️ 已知代价：这一支同时覆盖"应用无 im 权限"（应用级问题），
          // 它会被一并记成 failed；取舍见 notify-provider.interface.ts 的 failureKind 注释
          // （宁可让配错权限的部署看到"验证失败"，也不让一个真的错地址永远显示"未验证"）。
          addressAttributable: true,
        },
      };
    }

    // 成功：把**真实**回执状态带回去（不硬编码 200——上游回 201/202 时投递表要记真值）
    return { failure: null, responseStatus: response.status };
  }

  /**
   * 上游 `msg` 净化：压成单行 → **抹掉凭据** → 截断。
   *
   * 为什么要抹：`msg` 是**上游可控文本**，我们把它放进 `lastError`（落库 + admin 列表 + 日志）。
   * 正常情况下上游不会回显凭据，但"正常情况下不会"不是一条可以依赖的契约——真出现时，
   * 泄漏方向是"我们的密钥进了对方的响应体、又被我们自己记进投递记录"，代价不可逆。
   * 抹除发生在**截断之前**：先删完整出现，再截断（截断后再抹会漏掉跨越边界的完整出现）。
   *
   * @param msg 上游 `msg`
   * @param tokenInUse 本次请求在用的 token（可能是刚被清缓存的那个，故显式传入）
   * @returns 可安全入日志/落库的短文本（无 msg ⇒ `-`）
   */
  private sanitizeUpstreamMessage(msg: unknown, tokenInUse?: string): string {
    const normalized = normalizeUpstreamMessage(msg);
    if (normalized === null) return '-';
    return truncate(this.redactSecrets(normalized, [tokenInUse]), UPSTREAM_MSG_MAX_LENGTH);
  }

  /**
   * 抹掉"可能是我们凭据"的字面出现（**大小写不敏感**），换成 `[redacted]`。
   *
   * 为什么大小写不敏感：上游回显/异常原文里的大小写不该决定我们是否泄漏——`APP_SECRET` 写成
   * `App_Secret` 就漏出去了，正是那种"测试全绿、生产出事"的形态（纵深防御，成本一次正则）。
   * 也用于 catch-all 的异常文本（见 `send`）：连"我们没预料到的异常"也不给凭据留通道。
   *
   * @param text 待净化文本
   * @param extraSecrets 额外要抹的值（如本次请求在用的 token）
   * @returns 抹除后的文本（未命中任何凭据时原样返回）
   */
  private redactSecrets(text: string, extraSecrets: Array<string | undefined> = []): string {
    let out = text;
    for (const secret of [this.appSecret, this.cachedToken?.value, ...extraSecrets]) {
      if (!secret || secret.length === 0) continue;
      // 凭据里可能有正则元字符（`.`、`+`、`$`…）：转义后再构造，否则会命中不该命中的文本
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'gi'), '[redacted]');
    }
    return out;
  }

  /**
   * 传输层异常分类（固定标签 + **本次实际生效的**超时毫秒数；**不回显异常原文**，抄 judgment
   * transport 纪律）。
   *
   * @param err fetch / 读体阶段抛出的异常
   * @param what 是哪一跳（token / 发消息）
   * @param timeoutMs 本次请求实际使用的超时（可能是被预算夹逼过的值）
   */
  private classifyThrown(err: unknown, what: string, timeoutMs: number): AttemptFailure {
    if (isTimeoutError(err)) {
      return {
        kind: 'timeout',
        responseStatus: null,
        error: `${what} timed out after ${timeoutMs}ms`,
        retryNext: true,
      };
    }
    return {
      kind: 'network',
      responseStatus: null,
      error: `${what} failed at the transport layer (network unreachable / DNS / TLS / redirect refused)`,
      retryNext: true,
    };
  }

  /**
   * 本次请求可用的超时（**夹逼到剩余预算**）。
   *
   * 不夹逼的话，"总预算 10s"会被"一次 8s 超时 + 1s 退避 + 再一次 8s 超时"轻易穿破——
   * 直发端点的 agent 客户端早就超时了，而我们还在那儿等第二次。
   */
  private effectiveTimeoutMs(deadline: number | null): number {
    if (deadline === null) return this.httpTimeoutMs;
    const remaining = deadline - this.now();
    return Math.max(1, Math.min(this.httpTimeoutMs, Math.floor(remaining)));
  }

  /** 折成终态 `failed`（错误串：`kind: 描述`，已按列宽截断） */
  private finalFailure(
    attempts: number,
    failure: AttemptFailure | null,
    overrideError?: string,
    failureKind?: DeliveryFailureKind,
  ): DeliveryOutcome {
    const error =
      overrideError ?? (failure ? `${failure.kind}: ${failure.error}` : 'delivery failed');
    return {
      status: 'failed',
      attempts: Math.max(1, attempts),
      responseStatus: failure?.responseStatus ?? null,
      lastError: truncate(error, LAST_ERROR_MAX_LENGTH),
      deliveredAt: null,
      // M6：归因分类（显式 override 优先；否则由失败自身的"地址可归因"位 + 是否拿到 HTTP 响应推出）
      failureKind:
        failureKind ??
        (failure
          ? failure.addressAttributable
            ? 'address'
            : failure.responseStatus === null
              ? 'transport'
              : 'provider'
          : 'provider'),
    };
  }
}

/**
 * 拼飞书纯文本消息体：`title` 换行 `body` 换行 `link`。
 *
 * 为什么在 provider 里拼：飞书文本消息是**单一 text 字段**，而渲染层刻意把三者分开
 * （出境面 = `RenderedNotification` 的独立字段，便于换渠道时各取所需）。空段跳过——
 * `link` 在未配 `NOTIFY_WEB_BASE_URL` 时为 null，拼出尾部空行会让消息尾部多一个空行。
 */
function buildMessageText(notification: RenderedNotification): string {
  return [notification.title, notification.body, notification.link ?? '']
    .filter((part) => part.length > 0)
    .join('\n');
}
