/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别内核的**传输层**：一次 `POST {根}/v1/systemone` 的完整失败面收口
 *     （TypeSafe 官方云 REST，平台唯一的判别联网点）
 *
 * [代码职责]
 *   - `buildTypesafeSystemoneUrl`：端点构造（API 根 → 真实发包端点，单源）
 *   - `postSystemone`：发包 + 超时 + HTTP 分类 + 空体/非 JSON 兜底，**永不 throw**
 *   - `extractJudgmentModel`：从响应体取上游**自报**模型标识（观测字段，限长列宽）
 *   - `isTimeoutError` / `classifyHttpError` / `parseJsonObject`：分类原语（单测直击）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（失败标签表 / provider 列语义）
 *   - 补充: TypeSafe 官方文档 — REST `POST /v1/systemone` 契约 与 `TYPESAFE_*` env 约定
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（"transport 上移内核"）
 *
 * [关键不变量]
 *   - **零新依赖**：Node 22 全局 `fetch` + `AbortSignal.timeout`（不引入 SDK / 不引入重试退避；
 *     observe 期 fail-open 优先于完整性，过载窗口的代价由固定标签单列承担）。
 *   - **超时判别先于一切**：`TimeoutError`（`AbortSignal.timeout` 在 Node 22 的名称）与
 *     `AbortError`（部分环境/手动 abort）都判 `timeout`；**fetch 阶段与 body 读阶段同口径**
 *     ——body 读阶段超时若记成 error，会把超时混进"真故障"，失败率分母即失真。
 *   - **`redirect: 'error'`**：防 307/308 把带 key 与正文的 POST 原样重发到第三方。
 *     命中亦落 transport 分类（排障先看 baseUrl 是否带重定向）。
 *   - **失败固定标签集**（**永不 throw**、**不落上游错误体原文**、**不落 key**）：
 *     transport / timeout / `rejected the credential (HTTP 401|403)` /
 *     `validation failed (HTTP 422)` / `rate limited (HTTP 429) — upstream asks for backoff` /
 *     `overloaded (HTTP 529) — upstream asks for backoff` / 其它 `HTTP <status>` /
 *     空体·非 JSON（形状破损由能力侧白名单判定，本层只判"能不能解析成对象"）。
 *   - **`baseUrl` 是官方 API 根（不含 `/v1`）**：本层拼 `{根}/v1/systemone` 并
 *     `replace(/\/+$/,'')` 规整尾斜杠；用户误填 `.../v1` ⇒ 404（`.env.example` 已明写）。
 *   - **快照 `model` 恒取响应自报值**（`extractJudgmentModel`）：config 的 `typesafeModel`
 *     **只是请求参数**（可请求 `jev-latest` 而响应自报 `jev-1.13.0`）——两者语义不同。
 *   - **传输层不认识"能力"**：它只收发 JSON，归一化在能力侧（本层不做任何形状判断）。
 *
 * [关联代码]
 *   - judgment-capability.interface.ts — `JudgmentOutcome` 契约（本层产出失败面）
 *   - typesafe.judgment-provider.ts — 组合本层 + 能力（发问/归一化/元数据）
 *   - judgment-provider.factory.ts — 启动 INFO 复用 `buildTypesafeSystemoneUrl` 打印真端点
 *   - config/judgment.config.ts — baseUrl / apiKey / typesafeModel / timeoutMs 来源
 *
 * [持久踩坑]
 *   JUDGMENT-BODY-READ-TIMEOUT(body 读阶段超时): 连接已建立、body 未读完时 `response.text()`
 *     会拒绝。若按"解析失败 → error"处理，超时被计成真故障，失败率与 429/529 占比全被污染。
 *     安全方向: catch 内**先**判 TimeoutError|AbortError → timeout（单测两条各钉一次）。
 *   JUDGMENT-ERROR-BODY(错误体泄漏): 422/429 的响应体会回显请求片段（含正文与 key 形态串）。
 *     把原文写进日志/语料表 = 用日志当密钥回显通道。安全方向: 只记固定标签 + 状态码。
 *   JUDGMENT-DOUBLE-V1(端点重复前缀): 用户把 `.../v1` 填进 `TYPESAFE_BASE_URL` ⇒ 请求打到
 *     `/v1/v1/systemone` 404。安全方向: 本层规整尾斜杠；启动 INFO 打印解析后的 host+path。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增失败标签必须同时给出"timeout vs error"的归属与"不进日志"的敏感信息边界
 *   □ 改请求体形状必须同步能力的 `buildState`/`buildQuestions` 与文档的 request 形状小表
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { JudgmentFailedOutcome } from './judgment-capability.interface';

/** 模型标识限长（`experience_judgments.model` 列宽 varchar(64)） */
export const JUDGMENT_MODEL_MAX_LENGTH = 64;

/**
 * 官方判别端点（`{API 根}/v1/systemone`）。
 *
 * 导出给 provider 工厂的启动 INFO 复用——诊断行打印的端点必须是**真实发包端点**，
 * 否则"用户以为开了其实没开"的盲区依旧（两处各拼一次 URL 迟早漂移）。
 *
 * @param baseUrl 官方 API 根（可带尾斜杠；**勿带 `/v1`**）
 * @returns 绝对端点 URL
 */
export function buildTypesafeSystemoneUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/systemone`;
}

/**
 * 从响应体取模型标识（自报值；非字符串或空 → `'unknown'`；限长 64）。
 *
 * rationale：`model` 是**观测字段**（"这批评语是哪个模型打的"），不是判定输入——即使它
 * 被上游改写也不该让整次判定失败，故做保守兜底而不是报错。
 */
export function extractJudgmentModel(body: Record<string, unknown>): string {
  const raw = body.model;
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown';
  return raw.trim().slice(0, JUDGMENT_MODEL_MAX_LENGTH);
}

/** 单次发包的构造参数（由 provider 从 config 传入；本层不做任何配置解析） */
export interface SystemoneTransportOptions {
  /** 官方 **API 根**（如 https://api.typesafe.ai；**不含 `/v1`**） */
  baseUrl: string;
  /** 官方 API Key（`Authorization: Bearer`；绝不进日志、不入库、不进响应） */
  apiKey: string;
  /** 硬顶超时（毫秒） */
  timeoutMs: number;
}

/**
 * 传输结果：`ok` 带已解析响应体；`failed` 带**固定标签**与 timeout/error 归属。
 *
 * 判别式联合而非"解析结果 + 错误标记"：调用点（provider）必须按 `status` 分派，
 * 编译器会在新增分支时当场点名（"忘了处理某类失败"编译期即红）。
 */
export type SystemoneTransportResult =
  | { status: 'ok'; body: Record<string, unknown> }
  | { status: 'failed'; outcome: Omit<JudgmentFailedOutcome, 'request'> };

/**
 * 发一次判别请求（**永不 throw**）。
 *
 * @param options 端点 / key / 超时
 * @param body 发包体（`{state, model, questions}`；由能力组装，本层原样序列化）
 * @returns 已解析响应体，或失败（含 `error`/`timeout` 归属与固定标签）
 */
export async function postSystemone(
  options: SystemoneTransportOptions,
  body: Record<string, unknown>,
): Promise<SystemoneTransportResult> {
  const endpoint = buildTypesafeSystemoneUrl(options.baseUrl);
  const startedAt = Date.now();
  const transportError = (text: string): SystemoneTransportResult => ({
    status: 'failed',
    outcome: { status: 'error', response: { error: text }, latencyMs: Date.now() - startedAt },
  });
  const timeout = (): SystemoneTransportResult => ({
    status: 'failed',
    outcome: {
      status: 'timeout',
      response: { error: `judgment provider timed out after ${options.timeoutMs}ms` },
      latencyMs: Date.now() - startedAt,
    },
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
      // 防 307/308 把带 key 与正文的 POST 原样重发到第三方（命中同样落 transport 分类）
      redirect: 'error',
    });
  } catch (err: unknown) {
    return isTimeoutError(err)
      ? timeout()
      : transportError(
          'judgment provider transport error (network unreachable / DNS / TLS / redirect refused)',
        );
  }

  if (!response.ok) {
    // 错误体只用于分类，**原文不进日志、不落库**（见文件头踩坑）
    return transportError(await classifyHttpError(response));
  }

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (err: unknown) {
    // body 读阶段（连接已建立、body 未读完）必须与 fetch 阶段同口径分码（见文件头不变量）
    return isTimeoutError(err)
      ? timeout()
      : transportError(
          'judgment provider transport error while reading the response body',
        );
  }

  const text = rawText.trim();
  if (!text) {
    // 空体兜底：归一 fail-open（error 落日志，主流程 200），不让调用点炸 500
    return transportError('judgment provider returned an empty body');
  }

  const parsed = parseJsonObject(text);
  if (!parsed) {
    return transportError(
      `judgment provider response is not JSON (${text.length} chars of unexpected body)`,
    );
  }

  return { status: 'ok', body: parsed };
}

/**
 * 超时判别：`AbortSignal.timeout` 在 Node 22 抛 `TimeoutError`（DOMException），部分环境或
 * 手动 abort 为 `AbortError`——两者同判 timeout（文件头不变量）。
 *
 * @param err fetch / body 读取抛出的异常
 * @returns true = 超时
 */
export function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * HTTP 非 200 的分类文案（**不含上游错误体原文**，见文件头踩坑）。
 *
 * 401/403、422、429、529 各自点名（消费方动作不同：查 key / 修问题集或正文 / 退避重试），
 * 其余只回状态码。429/529 的固定尾巴 `— upstream asks for backoff` 是复查口径的一部分。
 *
 * @param response 非 ok 的响应（**体被读出后丢弃**：只为让连接可复用）
 * @returns 固定分类文案
 */
export async function classifyHttpError(response: Response): Promise<string> {
  const status = response.status;
  // 读体仅为确保连接可复用；内容丢弃（不进日志、不落库、不进语料）
  await response.text().catch(() => '');
  if (status === 401 || status === 403) {
    return `judgment provider rejected the credential (HTTP ${status})`;
  }
  if (status === 422) return 'judgment provider validation failed (HTTP 422)';
  if (status === 429) {
    return 'judgment provider rate limited (HTTP 429) — upstream asks for backoff';
  }
  if (status === 529) {
    return 'judgment provider overloaded (HTTP 529) — upstream asks for backoff';
  }
  return `judgment provider returned HTTP ${status}`;
}

/** JSON 字符串 → 对象（非对象 / 解析失败 → null） */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
