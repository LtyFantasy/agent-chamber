/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别内核的**唯一联网实现**：把"能力"（问题集 / state / 归一化）与"传输"（发包 / 失败面）
 *     组合起来，对任意能力产出一致的 `JudgmentOutcome`
 *
 * [代码职责]
 *   - `run(capability, input)`：组装 `{state, model, questions}` → 传输层 → 能力归一化 →
 *     补观测元数据（provider / model / judgedAt / rubricVersion）
 *   - 失败面（transport / timeout / HTTP / 空体·非 JSON / 白名单失败）统一映射成结果对象
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（失败标签 / provider 列语义）
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（provider 通用化 + 元数据归属）
 *
 * [关键不变量]
 *   - **本类不认识任何具体能力**：`I`/`O` 由调用点给定；问题集与 state 一律来自 `capability`
 *     （内核**不得**硬编码任何能力的字段名）——否则"内核"只是换了个目录的经验库。
 *   - **快照 `rubricVersion` 恒取能力声明值**、**`model` 恒取响应自报值**：前者是"这条评语出自
 *     哪一代问题集"，后者是"哪个模型打的"——两者都**不由调用点传入**（调用点传的只是请求模型）。
 *   - **请求体 = 实际发包体 = 日志载荷来源**：`{state, model, questions}` 三键单源，不事后重造。
 *   - **连接可能被复用，但每次 fetch 绑定各自的响应体；REST 无信封 id，故无 id 错配面**
 *     （历史 jev 传输的"响应 id 必须相等"防串包逻辑在这里**没有对应物**，勿照抄）。
 *   - **`run` 永不 throw**、**不落上游错误体原文**、**不落 key**（由传输层保证）。
 *   - **能力归一化返回 null ⇒ status=error 且不落快照**（"宁可不落，也不落半真快照"）。
 *
 * [关联代码]
 *   - judgment.transport.ts — 传输与失败分类（端点构造 / timeout 分码 / 分类文案）
 *   - judgment-capability.interface.ts — `JudgmentCapability` / `JudgmentOutcome` 契约
 *   - noop.judgment-provider.ts — 关闭态实现（provider=none）
 *   - judgment-provider.factory.ts — 按 config 选择实现（含 dev 缺 key 降级 + 退役值 warn）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增失败分类必须同时给出 `status` 映射与"不进日志"的敏感信息边界
 *   □ 改请求体形状 = 改所有能力的发问契约：同步 `docs/experience-base.md` 的 request 形状小表
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type {
  JudgmentCapability,
  JudgmentFailedOutcome,
  JudgmentMeta,
  JudgmentOkOutcome,
  JudgmentOutcome,
  JudgmentProvider,
} from './judgment-capability.interface';
import { extractJudgmentModel, postSystemone } from './judgment.transport';

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
 * TypeSafe 官方 REST 判别提供方（真联网实现，**能力无关**）。
 *
 * 线程安全 / 无状态：每次调用独立 POST，不保存会话、不做重试（详见传输层文件头）。
 */
export class TypeSafeJudgmentProvider implements JudgmentProvider {
  readonly name = TYPESAFE_PROVIDER_NAME;
  readonly enabled = true;

  constructor(private readonly options: TypeSafeProviderOptions) {}

  /**
   * 执行一次判别（**永不 throw**，见文件头）。
   *
   * @param capability 能力（问题集 / state / 归一化的提供方）
   * @param input 能力输入
   * @returns ok（归一化 `value` + 观测 `meta`）/ error（各类失败）/ timeout（硬顶超时）
   */
  async run<I, O>(
    capability: JudgmentCapability<I, O>,
    input: I,
  ): Promise<JudgmentOutcome<O>> {
    const questions = capability.buildQuestions(input);
    const state = capability.buildState(input);
    // 日志事实源 = 实际发包体（questions / state 单源 + 当次模型名，不事后重造）
    const request = { state, model: this.options.model, questions } as Record<string, unknown>;
    const startedAt = Date.now();

    const transport = await postSystemone(
      {
        baseUrl: this.options.baseUrl,
        apiKey: this.options.apiKey,
        timeoutMs: this.options.timeoutMs,
      },
      request,
    );
    if (transport.status === 'failed') {
      // 失败也要留档"问了什么"（语料要能复现输入）；标签与分码由传输层保证
      return { ...transport.outcome, request };
    }

    const body = transport.body;
    const value = capability.normalize(body, input);
    if (!value) {
      // 白名单校验失败 / 整体形状破损 → status=error 且**不落快照**（宁可不落，也不落半真快照）
      return this.failed(
        'judgment provider answers failed whitelist validation',
        request,
        startedAt,
        Object.keys(body),
      );
    }

    return this.ok(capability, value, body, request, startedAt);
  }

  /** 组装成功结果（`meta.model` = **响应自报**、`meta.rubricVersion` = 能力声明，见文件头） */
  private ok<I, O>(
    capability: JudgmentCapability<I, O>,
    value: O,
    body: Record<string, unknown>,
    request: Record<string, unknown>,
    startedAt: number,
  ): JudgmentOkOutcome<O> {
    const meta: JudgmentMeta = {
      provider: this.name,
      model: extractJudgmentModel(body),
      judgedAt: new Date().toISOString(),
      // rubric 代际标记：快照/日志据此可辨"这条评语出自哪一代问题集"
      rubricVersion: capability.rubricVersion,
    };
    return {
      status: 'ok',
      value,
      meta,
      request,
      // 语料价值：raw 原样留档（含 probabilities / usage），便于未来训练与复核
      response: { normalized: value, raw: body },
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
}
