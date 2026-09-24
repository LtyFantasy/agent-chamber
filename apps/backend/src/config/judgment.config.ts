/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库判别服务：录入七维 rubric 软判定（observe 期，只标注不拒绝）
 *     · provider=typesafe = **直连 TypeSafe 官方云 REST**（一把官方 key 即启用）
 *     · provider=none     = 完全关闭（不调用、不写日志、不占额度）
 *     · provider=jev（自托管 MCP 网关适配器）= **已于 v1.83.0 退役**：值域不再接受，解析落
 *       none，工厂启动打一行 warn；网关相关的旧配置键不再读取
 *
 * [代码职责]
 *   - 提供 `judgment.*` 配置：provider / baseUrl / apiKey / typesafeModel / timeoutMs /
 *     rateLimitPerHour
 *   - 键读取：provider=typesafe → `TYPESAFE_*`；**其余一律** baseUrl = TypeSafe 官方缺省根、
 *     apiKey = null（none 下 apiKey 无消费者——工厂只在 typesafe 分支读它）
 *   - 解析防御：provider 非法值 → none；timeout / rateLimit 非法值 → 回缺省；model 空串 → 回缺省
 *   - **production-only fail-fast**：provider=typesafe 缺 key、端点非 https 时仅生产启动即崩
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域
 *     `none|typesafe` / 失败标签 / "启用 = 条目文本出境"声明）
 *   - 补充: .kimi/plans/plan-experience-base-p2.md §3.1（配置 + 解析防御 + fail-fast 先例）
 *   - 补充: 线上 DocSpace `DEPLOY.md` — 判别服务 env 块与生产切换 runbook
 *
 * [关键不变量]
 *   - **`undefined` / 非法 provider 值一律视为 `none`**（缺省关闭）：判别服务是 observe
 *     期增强，配置缺失不能阻断录入主流程。**退役值 `jev` 走同一条路**——解析落 none
 *     且不抛错（启动可见性由工厂的 warn 承担，见工厂文件头）。
 *   - **缺 key 只在 production 抛错**（照 attachment-url.config.ts 的 production-only 先例）：
 *     dev/test 允许无 key 启动（e2e 内联 ConfigModule 不 load 本工厂；本地零配置起步），
 *     由 provider 工厂把它降级成 none 并 warn 一行（见 judgment-provider.factory.ts）。
 *   - **typesafe 端点的 scheme 硬闸（仅 production）**：非 `https:` 即抛，只有 `localhost` /
 *     `127.0.0.1` 放行 http（照 plugins/kimi-code/hooks/session-start.mjs 的 S6 白名单）；
 *     解析失败的畸形串同样视为不安全——否则条目正文与 key 会以明文过网。
 *   - **`TYPESAFE_DEFAULT_MODEL` 空串也回落缺省**（`?.trim() || `）：docker compose 的
 *     `${VAR:-}` 会注入空串，空串当请求 model 发出 = 官方 422（arch R4）。
 *   - **解析防御是硬要求**（arch 复核 N5）：`JUDGMENT_TIMEOUT_MS` / `JUDGMENT_RATE_LIMIT`
 *     的 NaN / 非正数一律回落缺省——"配置写错就静默关闭限流"是最糟的失败模式。
 *   - **本文件绝不回显 key 值**（错误文案只出现键名 / 入口 URL / 逃生阀）：配置错误信息会进
 *     启动日志。
 *   - **本文件保持纯函数、无 Logger**：一切 warn / info 落 provider 工厂（Logger 归属层）。
 *
 * [关联代码]
 *   - modules/experience/judgment/typesafe.judgment-provider.ts — 官方 REST 客户端（唯一真实现）
 *   - modules/experience/judgment/noop.judgment-provider.ts — 关闭态实现（provider=none）
 *   - modules/experience/judgment/judgment-provider.factory.ts — provider 选择 + 诊断日志
 *     （含退役值 `jev` 的启动 warn）
 *   - modules/experience/experience-judgment.service.ts — 限流额度与日志落库
 *   - app.module.ts — 本工厂的注册点（load 数组）
 *
 * [持久踩坑]
 *   P2-#1(密钥静默回退): 缺 key 静默当成"已启用"会让每次判定都打真网关并失败一轮。
 *     安全方向: production 抛、dev/test 显式降级为 none 并留一行 warn。
 *   JUDGMENT-EMPTY-MODEL(空串当模型): compose `${VAR:-}` 注空串 ⇒ `model:""` 直发官方 422。
 *     安全方向: `?.trim() || DEFAULT_TYPESAFE_MODEL`，缺省值单源在常量。
 *   JUDGMENT-RETIRED-PROVIDER(退役值被静默吞掉): 旧 .env 里留着已退役的值（如 `jev`）时，
 *     只解析成 none 而无任何信号 ⇒ 用户以为"配了却没跑"（或反向以为在跑）。
 *     安全方向: 解析仍落 none，但工厂按 **trim 后的非空原值** 打一行 warn（判据与净化写法
 *     见工厂文件头，含 compose `${VAR:-}` 注空串的误报守卫）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增键必须同时更新 .env.example、docker-compose.yml 透传与本文件的 fail-fast 文案
 *   □ 新增 provider 必须同步工厂分派 + config/factory 两份 spec 的矩阵用例
 *     （枚举一致性断言会当场红），并更新 shared DTO / entity 的 provider 注释
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { registerAs } from '@nestjs/config';

/**
 * 判别服务提供方值域（非法值 / 退役值一律视为 none；顺序 = 文档与 help 文案的呈现顺序）。
 *
 * 值域收窄史：`jev`（自托管 jev MCP 网关适配器）在 v1.83.0 退役——**不再列在这里**，
 * 旧 .env 残留该值时解析落 none（工厂随之打一行 warn）。
 */
export const JUDGMENT_PROVIDERS = ['none', 'typesafe'] as const;
export type JudgmentProviderName = (typeof JUDGMENT_PROVIDERS)[number];

/**
 * 缺省的 TypeSafe 官方 **API 根**（**不含 `/v1`**；provider 内拼 `{root}/v1/systemone`）。
 *
 * rationale：与官方 SDK 的 `TYPESAFE_BASE_URL` 语义逐字对齐（官方 [ENV 页]）——已经配过
 * 官方 SDK 的用户零摩擦复用同一把键。`.env.example` 明写"勿带 /v1，否则 404"。
 */
export const DEFAULT_TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/**
 * 缺省的 TypeSafe 模型（官方**浮动别名**，缺省值单源在本常量）。
 *
 * rationale：`jev-latest` 随官方发版漂移 ⇒ 需要跨批次**可比性**时钉版本 ID（如 `jev-1.13.0`）。
 * 注意它只是**请求参数**：落库快照的 `model` 恒取响应自报值（见 typesafe provider 文件头）。
 */
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';

/**
 * 本工厂产出的配置形状（DI 层用 `JUDGMENT_CONFIG` token 注入；见 judgment-provider.factory.ts）。
 *
 * 单独导出类型：service 的限流额度与 provider 的传输参数都读它——两处共用一个类型，
 * 避免"配置字段名在两个文件里各写一遍"的漂移。
 */
export interface JudgmentConfig {
  /**
   * 请求的提供方（`none` = 完全跳过判定：不调用、不写日志、不占额度）。
   *
   * **值语义**（它落 `experience_judgments.provider` 列）：标识的是**适配器（端点 + 传输）**，
   * **不表示厂商或云归属**；对照与导出请以日志表的 `provider` + `model` 两列为准，
   * 不要据此推断厂商。历史行里可能出现已退役的 `jev`（v1.83.0 前写入），读法见文档。
   */
  provider: JudgmentProviderName;
  /**
   * 端点（当前值语义**恒为** TypeSafe 官方 **API 根**，不含 `/v1`；provider 内拼
   * `/v1/systemone`）。
   *
   * 退役值 `jev` 解析落 `none` 时本字段同样填官方缺省根（`none` 下无消费者，工厂只在
   * typesafe 分支读它）。
   */
  baseUrl: string;
  /** 当前 provider 的 API Key（null = 未配置；production 已在下方抛错，dev/test 由工厂降级 none） */
  apiKey: string | null;
  /**
   * typesafe 请求里带的模型（`TYPESAFE_DEFAULT_MODEL`，缺省 `jev-latest`；空串回落缺省）。
   *
   * **仅 provider=typesafe 时为非 null**（其余 provider 没有这个语义，不伪造一个模型名）。
   * ⚠️ 它**只是请求参数**：落库快照的 `model` 恒取上游响应自报值（两者可以不同）。
   */
  typesafeModel: string | null;
  /** 单次判定硬顶（毫秒） */
  timeoutMs: number;
  /** 单 actor 每小时额度（create 与 update 判定共用） */
  rateLimitPerHour: number;
}

/**
 * 单次判定的硬顶超时（毫秒）。
 *
 * rationale（plan §3.1）：8s 是"录入路径可容忍的附加延迟"与"网络抖动不至于天天超时"的
 * 折中；客户端（MCP 工具/脚本）超时必须 ≥10s（写进 api-definition 与工具 description），
 * 否则会在服务端仍在等待判定时先断开，把一次成功录入看成失败。
 */
const DEFAULT_TIMEOUT_MS = 8000;

/** 单 actor 每小时的判定额度（create 与 update 判定**共用**；skipped 占位行也计入） */
const DEFAULT_RATE_LIMIT_PER_HOUR = 60;

/** 允许走明文 http 的主机（仅本机；照 session-start.mjs 的 S6 scheme 白名单，不做闭类扩展） */
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * 正整数解析防御（照 experience.constants.ts 的 `resolveCreateRateLimit` 形态）。
 *
 * @param raw env 原始字符串
 * @param fallback 非法时回落值（缺省值单源在本文件）
 * @returns 合法正数或 fallback
 */
function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

/**
 * 端点是否安全（https，或**本机** http）。
 *
 * 为什么不判字符串前缀：env 值可能带 userinfo / 大写 / 尾斜杠 / 畸形串——用 `new URL()`
 * 解析才是权威判据；**解析失败一律视为不安全**（production 下走抛错：宁可启动失败，
 * 也不让条目正文与 key 明文过网）。
 *
 * @param endpoint 端点原文
 * @returns true = https 或本机 http
 */
function isSecureEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(parsed.hostname);
}

export default registerAs('judgment', (): JudgmentConfig => {
  // **trim 归一**：`.env` 尾随空格 / CRLF 污染（手改文件常见）不得把合法值判成非法——
  // 判据与 provider 工厂的退役值 warn（也读 trim 后的原值）必须同一口径，否则会出现
  // "配了 typesafe 却落 none + 一条矛盾 warn"的诡异组合。
  const requested = process.env.JUDGMENT_PROVIDER?.trim();
  // 非法 / 缺失 / **退役值（jev）** 一律 none（observe 期增强，缺省关闭；退役值的启动可见性
  // 由 provider 工厂的 warn 承担——本工厂是纯函数，不打日志）
  const provider: JudgmentProviderName = (JUDGMENT_PROVIDERS as readonly string[]).includes(
    requested ?? '',
  )
    ? (requested as JudgmentProviderName)
    : 'none';

  // typesafe 之外的 provider（含 none）统一取官方缺省根 + null key：它们不打真网关，
  // baseUrl/apiKey 没有消费者（工厂只在 typesafe 分支读）——填缺省让形状恒完整、不造假值
  const isTypesafe = provider === 'typesafe';
  const baseUrl = isTypesafe
    ? process.env.TYPESAFE_BASE_URL?.trim() || DEFAULT_TYPESAFE_BASE_URL
    : DEFAULT_TYPESAFE_BASE_URL;
  const apiKey = isTypesafe ? process.env.TYPESAFE_API_KEY?.trim() || null : null;
  // model 只在 typesafe 生效；其余 provider 无此语义 ⇒ null（不伪造模型名）
  const typesafeModel = isTypesafe
    ? process.env.TYPESAFE_DEFAULT_MODEL?.trim() || DEFAULT_TYPESAFE_MODEL
    : null;

  if (provider !== 'none' && process.env.NODE_ENV === 'production') {
    // production-only fail-fast（照 attachment-url.config.ts:72-78 先例）：
    // 生产明确要求启用却没给 key ⇒ 启动即崩。dev/test 允许无 key（降级为 none）。
    // ⚠️ 文案只出现键名 / key 入口 / 逃生阀，绝不回显值。
    if (provider === 'typesafe' && !apiKey) {
      throw new Error(
        'JUDGMENT_PROVIDER=typesafe requires TYPESAFE_API_KEY in production. Get a key at ' +
          'https://console.typesafe.ai/keys, or set JUDGMENT_PROVIDER=none to disable entry ' +
          'pre-checks. ⚠️ Enabling it sends entry text (title / summary / excerpt / signals / ' +
          'domains, plus the title and quality of suspected-duplicate candidates) to the ' +
          'TypeSafe cloud API — that traffic leaves your network. See .env.example.',
      );
    }
    // typesafe 端点 scheme 硬闸（见文件头不变量）：http 只放行本机
    if (provider === 'typesafe' && !isSecureEndpoint(baseUrl)) {
      throw new Error(
        'JUDGMENT_PROVIDER=typesafe requires an https TYPESAFE_BASE_URL in production ' +
          '(http is only allowed for localhost / 127.0.0.1). Set TYPESAFE_BASE_URL to the https ' +
          'API root — default https://api.typesafe.ai, and do NOT append /v1 — or set ' +
          'JUDGMENT_PROVIDER=none to disable entry pre-checks. See .env.example.',
      );
    }
  }

  return {
    /** 请求的提供方（`none` = 完全跳过判定，不写日志不占额度） */
    provider,
    /** 端点（typesafe = API 根不含 /v1；none 下填官方缺省根，无消费者） */
    baseUrl,
    /** API Key（仅 typesafe 非 null；进 HTTP 头，**绝不入日志、不入库、不进响应**） */
    apiKey,
    /** typesafe 的请求模型（缺省 jev-latest；空串回落；其余 provider 恒 null） */
    typesafeModel,
    /** 单次判定硬顶（8s 缺省；非法值回落） */
    timeoutMs: resolvePositiveInt(process.env.JUDGMENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    /** 单 actor 每小时额度（60 缺省；非法值回落；create/update 共用） */
    rateLimitPerHour: resolvePositiveInt(
      process.env.JUDGMENT_RATE_LIMIT,
      DEFAULT_RATE_LIMIT_PER_HOUR,
    ),
  };
});
