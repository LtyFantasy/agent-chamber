/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别服务的 **TypeSafe 官方云 REST 客户端**：一次 `POST {根}/v1/systemone` 完成
 *     七维软判定（完整度 / 可复用性 / 信号质量 / 重复度 / 类型归类 / 领域归类 / 准入建议）
 *
 * [代码职责]
 *   - 组装 `{state, model, questions}` → POST 官方 REST → 逐字段白名单归一化 → 结果对象
 *   - 失败分类（transport / timeout / HTTP 固定标签 / 空体·非 JSON / 白名单校验失败）
 *   - 快照元数据组装：provider / model（响应自报）/ judgedAt / **rubricVersion**（rubric 代际）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域
 *     `none|typesafe` 配置表 / 失败标签表 / provider 列语义 / "启用 = 条目文本出境"声明）
 *   - 补充: .kimi/plans/plan-experience-base-p2.md §3.2（失败分类口径，与已退役的 jev 网关适配器同构）
 *   - 补充: TypeSafe 官方文档 — REST `POST /v1/systemone` 契约 与 `TYPESAFE_*` env 约定
 *
 * [关键不变量]
 *   - **零新依赖**：Node 22 全局 `fetch` + `AbortSignal.timeout`（不引入 SDK / 不引入重试退避；
 *     observe 期 fail-open 优先于完整性，过载窗口的代价由固定标签单列承担）。
 *   - **快照 `model` 恒取响应自报值**（`extractJudgmentModel(响应)`）：config 的
 *     `typesafeModel` **只是请求参数**（可请求 `jev-latest` 而响应自报 `jev-1.13.0`）——
 *     两者语义不同，不得互相顶替。
 *   - **请求体 = 实际发包体** `{state, model, questions}`：日志 `request` 载荷就是它
 *     （questions / state 单源来自 rubric，不事后重造；模型名也留档）。
 *   - **连接可能被复用，但每次 fetch 绑定各自的响应体；REST 无信封 id，故无 id 错配面**
 *     （R5 逐字口径——已退役的 jev 传输的"响应 id 必须相等"防串包逻辑在这里**没有对应物**，勿照抄）。
 *   - **`redirect: 'error'`**：防 307/308 把带 key 与正文的 POST 原样重发到第三方。
 *     **`redirect: 'error'` 命中亦落 transport 分类，排障先看 baseUrl 是否带重定向**（R6 逐字）。
 *   - **超时判别先于一切**：`TimeoutError`（`AbortSignal.timeout` 在 Node 22 的名称）与
 *     `AbortError`（部分环境/手动 abort）都判 `status: 'timeout'`；**fetch 阶段与 body 读阶段
 *     同口径**——body 读阶段超时若记成 error，会把超时混进"真故障"，失败率分母即失真。
 *   - **失败固定标签集**（**永不 throw**、**不落上游错误体原文**、**不落 key**）：
 *     transport / timeout / `rejected the credential (HTTP 401|403)` /
 *     `validation failed (HTTP 422)` / `rate limited (HTTP 429) — upstream asks for backoff` /
 *     `overloaded (HTTP 529) — upstream asks for backoff` / 其它 `HTTP <status>` /
 *     空体·非 JSON / 白名单校验失败（`rawShape` **只存键名**）。
 *   - **`baseUrl` 是官方 API 根（不含 `/v1`）**：本文件拼 `{根}/v1/systemone` 并
 *     `replace(/\/+$/,'')` 规整尾斜杠；用户误填 `.../v1` ⇒ 404（`.env.example` 已明写）。
 *
 * [关联代码]
 *   - judgment-rubric.ts — 问题集组装与归一化（本文件只负责传输与解析；**零改动复用**）
 *   - judgment-provider.interface.ts — 输入/输出契约（`JudgmentOutcome`）
 *   - config/judgment.config.ts — baseUrl / apiKey / typesafeModel / timeoutMs 来源
 *   - judgment-provider.factory.ts — 实例装配 + 启动诊断（endpoint host+path 由本文件的
 *     `buildTypesafeSystemoneUrl` 单源提供）
 *
 * [持久踩坑]
 *   JUDGMENT-BODY-READ-TIMEOUT(body 读阶段超时): 连接已建立、body 未读完时 `response.text()`
 *     会拒绝。若按"解析失败 → error"处理，超时被计成真故障，4 周复查的失败率与 429/529
 *     占比全被污染。安全方向: catch 内**先**判 TimeoutError|AbortError → timeout。
 *   JUDGMENT-ERROR-BODY(错误体泄漏): 422/429 的响应体会回显请求片段（含正文与 key 形态串）。
 *     把原文写进日志/语料表 = 用日志当密钥回显通道。安全方向: 只记固定标签 + 状态码。
 *   JUDGMENT-DOUBLE-V1(端点重复前缀): 用户把 `.../v1` 填进 `TYPESAFE_BASE_URL` ⇒ 请求打到
 *     `/v1/v1/systemone` 404。安全方向: 本文件规整尾斜杠；启动 INFO 打印解析后的 host+path，
 *     一眼可判错配。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增失败分类必须同时给出 `status` 映射（timeout vs error）与"不进日志"的敏感信息边界
 *   □ 改请求体形状必须同步 rubric 契约与 docs/experience-base.md 的 request 形状小表
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type {
  ExperienceCheckInput,
  JudgmentFailedOutcome,
  JudgmentOkOutcome,
  JudgmentOutcome,
  JudgmentProvider,
} from './judgment-provider.interface';
import {
  EXPERIENCE_JUDGMENT_RUBRIC_VERSION,
  buildJudgmentState,
  buildRubricQuestions,
  extractJudgmentModel,
  normalizeJevAnswers,
  type ExperienceJudgmentDims,
} from './judgment-rubric';

/** 判定提供方名（落 `experience_judgments.provider`；值域见 config 的 `JUDGMENT_PROVIDERS`） */
export const TYPESAFE_PROVIDER_NAME = 'typesafe';

/** 单次调用的构造参数（由 config 提供；本类不做任何配置解析） */
export interface TypeSafeProviderOptions {
  /** 官方 **API 根**（如 https://api.typesafe.ai；**不含 `/v1`**） */
  baseUrl: string;
  /** 官方 API Key（`Authorization: Bearer`；绝不进日志、不入库、不进响应） */
  apiKey: string;
  /** 请求里带的模型（`TYPESAFE_DEFAULT_MODEL`，缺省 `jev-latest`） */
  model: string;
  /** 硬顶超时（毫秒） */
  timeoutMs: number;
}

/**
 * 官方判定端点（`{API 根}/v1/systemone`）。
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
 * TypeSafe 官方 REST 判别提供方（真联网实现）。
 *
 * 线程安全 / 无状态：每次调用独立 POST，不保存会话、不做重试（见文件头不变量）。
 */
export class TypeSafeJudgmentProvider implements JudgmentProvider {
  readonly name = TYPESAFE_PROVIDER_NAME;
  readonly enabled = true;

  /** 实际发包端点（构造期一次算出，避免每次调用重复规整） */
  private readonly endpoint: string;

  constructor(private readonly options: TypeSafeProviderOptions) {
    this.endpoint = buildTypesafeSystemoneUrl(options.baseUrl);
  }

  /**
   * 执行一次录入判定（**永不 throw**，见文件头）。
   *
   * @param input 条目内容 + 当次词表快照
   * @returns ok（归一化快照）/ error（各类失败）/ timeout（硬顶超时）
   */
  async checkEntry(input: ExperienceCheckInput): Promise<JudgmentOutcome> {
    const questions = buildRubricQuestions(input.availableDomains);
    const state = buildJudgmentState(input);
    // 日志事实源 = 实际发包体（questions / state 单源 + 当次模型名，不事后重造）
    const request = { state, model: this.options.model, questions } as Record<string, unknown>;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.options.timeoutMs),
        // 防 307/308 把带 key 与正文的 POST 原样重发到第三方（命中同样落 transport 分类）
        redirect: 'error',
      });
    } catch (err: unknown) {
      return isTimeoutError(err)
        ? this.timedOut(request, startedAt)
        : this.failed(
            'judgment provider transport error (network unreachable / DNS / TLS / redirect refused)',
            request,
            startedAt,
          );
    }

    if (!response.ok) {
      // 错误体只用于分类，**原文不进日志、不落库**（见文件头踩坑）
      return this.failed(await classifyHttpError(response), request, startedAt);
    }

    let rawText: string;
    try {
      rawText = await response.text();
    } catch (err: unknown) {
      // body 读阶段（连接已建立、body 未读完）必须与 fetch 阶段同口径分码（见文件头不变量）
      return isTimeoutError(err)
        ? this.timedOut(request, startedAt)
        : this.failed(
            'judgment provider transport error while reading the response body',
            request,
            startedAt,
          );
    }

    const text = rawText.trim();
    if (!text) {
      // 空体兜底：归一 fail-open（error 落日志，主流程 200），不让调用点炸 500
      return this.failed('judgment provider returned an empty body', request, startedAt);
    }

    const parsed = parseJsonObject(text);
    if (!parsed) {
      return this.failed(
        `judgment provider response is not JSON (${text.length} chars of unexpected body)`,
        request,
        startedAt,
      );
    }

    const dims = normalizeJevAnswers(parsed.answers, input.availableDomains);
    if (!dims) {
      // 白名单校验失败 / 整体形状破损 → status=error 且**不落快照**（宁可不落，也不落半真快照）
      return this.failed(
        'judgment provider answers failed whitelist validation',
        request,
        startedAt,
        Object.keys(parsed),
      );
    }

    return this.ok(dims, parsed, request, startedAt);
  }

  /** 组装成功结果（快照 model = **响应自报**，见文件头不变量） */
  private ok(
    dims: ExperienceJudgmentDims,
    parsed: Record<string, unknown>,
    request: Record<string, unknown>,
    startedAt: number,
  ): JudgmentOkOutcome {
    return {
      status: 'ok',
      judgment: {
        provider: this.name,
        model: extractJudgmentModel(parsed),
        judgedAt: new Date().toISOString(),
        // rubric 代际标记（v1.82.0）：快照据此可辨"这条评语出自哪一代问题集"
        rubricVersion: EXPERIENCE_JUDGMENT_RUBRIC_VERSION,
        ...dims,
      },
      request,
      // 语料价值：raw 原样留档（含 probabilities / usage），便于未来训练与复核
      response: { normalized: dims, raw: parsed },
      latencyMs: Date.now() - startedAt,
    };
  }

  /** 组装失败结果（`rawShape` 只在白名单失败时给，且**只含键名**） */
  private failed(
    error: string,
    request: Record<string, unknown>,
    startedAt: number,
    rawShape?: readonly string[],
  ): JudgmentFailedOutcome {
    return {
      status: 'error',
      request,
      response: rawShape ? { error, rawShape: [...rawShape] } : { error },
      latencyMs: Date.now() - startedAt,
    };
  }

  /** 组装超时结果（与 error 分码：失败率分母口径依赖它） */
  private timedOut(request: Record<string, unknown>, startedAt: number): JudgmentFailedOutcome {
    return {
      status: 'timeout',
      request,
      response: { error: `judgment provider timed out after ${this.options.timeoutMs}ms` },
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * 超时判别：`AbortSignal.timeout` 在 Node 22 抛 `TimeoutError`（DOMException），部分环境或
 * 手动 abort 为 `AbortError`——两者同判 timeout（文件头不变量）。
 *
 * @param err fetch / body 读取抛出的异常
 * @returns true = 超时
 */
function isTimeoutError(err: unknown): boolean {
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
async function classifyHttpError(response: Response): Promise<string> {
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
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
