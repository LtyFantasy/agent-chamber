/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别内核的 DI 装配点：按配置选择 provider 实现 + 暴露只读配置对象 + **启动诊断**
 *
 * [代码职责]
 *   - `JUDGMENT_PROVIDER` token → **两态分派**：
 *     `typesafe` → `TypeSafeJudgmentProvider`（官方云 REST，一等公民）/ 其余 → `NoopJudgmentProvider`
 *   - `JUDGMENT_CONFIG` token → 缺省补齐后的只读配置（配额服务与调用点读限流额度）
 *   - **四条诊断 warn + 两条启动 INFO**（Logger 归属层；config 工厂保持纯函数）：
 *     ① config 产出的 `warnings`（数值键解析回退 / 键间不变量 / 能力白名单）逐条 warn；
 *     ② `JUDGMENT_PROVIDER` 设了非法/退役值（如 `jev`）⇒ warn 一行（判别实际是关的）；
 *     ③ 真 provider 在 dev/test 缺 key ⇒ 降级 none + warn 一行；
 *     ④ 真启用 ⇒ INFO 一行（provider + model + **解析后的 endpoint host+path**）；
 *     ⑤ 每个**已启用能力** ⇒ INFO 一行（名称 + 出境字段 + 触发者，与 `.env.example`
 *        和 fail-fast 文案同源——见 config 的 `JUDGMENT_CAPABILITY_DECLARATIONS`）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域
 *     `none|typesafe` / 失败标签 / "启用 = 文本出境"声明）
 *   - 补充: plan `kate-bishop-moon-girl-sam-alexander.md` §批次 2（装配 + 出境声明三处同源）
 *
 * [关键不变量]
 *   - **provider 缺 key 时不得静默联网**：production 已在 config 工厂抛错；dev/test 在此
 *     **显式降级为 none 并 warn 一行**（只出现键名，不出现值）——"缺 key 却打真网关"会让每次
 *     调用白等一轮超时。
 *   - `JUDGMENT_CONFIG` 必须**有缺省兜底**：e2e 的 ConfigModule 只 load jwt 一项，
 *     `config.get('judgment')` 会是 undefined——此处回落 `none` + 缺省数值，保证服务在任何
 *     装配下都拿到完整形状（测试再按需 override）。
 *   - **诊断文案里的 URL 一律经 `new URL()` 解析、只取 host + path**：env 带 userinfo 时字符串
 *     切分会把凭证写进启动日志（`href` 同样含 userinfo，**禁止打 href**）。
 *   - **`new URL()` 必须 try/catch**：畸形 URL 不得让诊断行变成启动期抛错源。
 *   - **退役/非法值 warn 的判据**（三条件缺一不可）：`env 原值 trim 后非空` **且**
 *     `配置解析结果 === 'none'` **且** `原值 !== 'none'`。⚠️ **必须 trim 后判非空**——
 *     docker compose 的 `${JUDGMENT_PROVIDER:-}` 在 .env 缺该键时注**空串**，裸判"已设置"
 *     会对每个默认 OSS 部署 100% 误报。
 *   - **回显值必须净化**：`sanitizeLogValue`（单源在 `config/judgment.config.ts`）——剔除
 *     `\r\n` + 截断 32 + key 形态脱敏（防用户把 key 误填进 `JUDGMENT_PROVIDER` 后被启动日志回显）。
 *   - **config `warnings` 只做透传打印**：文案在 config 侧已净化（键名 / 常量 / 合法值域 /
 *     经同一净化函数处理的能力名），本层**不得**在其上再拼接 env 原值。
 *   - **本层不认识"能力"**：能力启用判定在 config 的 `isJudgmentCapabilityEnabled`，
 *     逐能力 INFO 只打印 config 声明表的文字（内核不硬编码任何能力名）。
 *   - 两个 token 都可被 `overrideProvider` 替换（e2e 用内存 fake provider 断言接线时序）。
 *
 * [关联代码]
 *   - ../../config/judgment.config.ts — 配置来源、provider 值域、能力声明表与生产 fail-fast
 *   - judgment-capability.interface.ts — token 与接口定义（`JUDGMENT_PROVIDER` 常量在此）
 *   - typesafe.judgment-provider.ts / noop.judgment-provider.ts — 两个实现
 *   - judgment.module.ts — 两个 token 的装配与导出（ExperienceModule 等消费方 import 它）
 *   - judgment-runner.service.ts / modules/experience/experience-judgment.service.ts — 消费者
 *
 * [持久踩坑]
 *   JUDGMENT-USERINFO-LOG(userinfo 进日志): `https://user:pass@host/...` 直接字符串切分会把
 *     凭证写进启动日志（启动日志是长期的、会被翻查的）。安全方向: `new URL()` + 只取 host/path。
 *   JUDGMENT-THIRD-PARTY-ENDPOINT(默认端点=第三方): 曾指"用户选 jev 却不把端点设成自建网关 ⇒
 *     正文发往维护者的私有网关"。**已随 jev 退役（v1.83.0）闭合**：内置 jev 缺省端点已删除、
 *     网关相关的旧配置键不再读取，值域只剩需自持 key 的官方云 REST。
 *   JUDGMENT-EMPTY-ENV-STRING(空串当"已设置"): compose `${VAR:-}` 注空串 ⇒ 裸判 `process.env`
 *     非空会对默认部署 100% 误报。安全方向: 一律 `?.trim()` 后判非空。
 *   JUDGMENT-WARNING-VALUE-LEAK(告警里夹 env 原值): "配置写错了所以要告警"最自然的写法是把用户
 *     填的原值打出来——而该位置最常见的三种输入恰好是 key、带 userinfo 的 URL、含 `\n` 的注入串。
 *     安全方向: 告警只说**键名 + 期望形态 + 回落缺省值**，原值不进日志（单测钉死"输出不含原值"）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 token 必须同时给出"生产/测试各拿什么"的装配说明
 *   □ 新增 provider 必须同步本文件分派 + config 值域 + 两份 spec 的矩阵用例（枚举一致性
 *     断言会当场红）
 *   □ 新增能力必须同步 config 的声明表 + `.env.example` 出境声明 + 注册表（单测会红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_TYPESAFE_BASE_URL,
  DEFAULT_TYPESAFE_MODEL,
  JUDGMENT_CAPABILITY_DECLARATIONS,
  isJudgmentCapabilityEnabled,
  sanitizeLogValue,
  type JudgmentConfig,
} from '../../config/judgment.config';
import { JUDGMENT_PROVIDER, type JudgmentProvider } from './judgment-capability.interface';
import { buildTypesafeSystemoneUrl } from './judgment.transport';
import { NoopJudgmentProvider } from './noop.judgment-provider';
import { TypeSafeJudgmentProvider } from './typesafe.judgment-provider';

/** 只读配置对象的注入 token（配额服务读三级额度；e2e 可 override） */
export const JUDGMENT_CONFIG = 'JUDGMENT_CONFIG';

/**
 * 配置缺省兜底（e2e ConfigModule 未 load judgment 工厂时的形状保证；值 = config 工厂缺省）。
 *
 * ⚠️ **加键必须同步这里与 `judgmentConfigProvider` 的产出**：`JudgmentConfig` 的类型标注会让
 * 漏字段变成编译期报错（fail-closed），故不存在"少一个键静默吃 undefined"的窗口。
 */
const JUDGMENT_CONFIG_FALLBACK: JudgmentConfig = {
  provider: 'none',
  baseUrl: DEFAULT_TYPESAFE_BASE_URL,
  apiKey: null,
  typesafeModel: null,
  timeoutMs: 8000,
  rateLimitPerHour: 60,
  globalRateLimitPerHour: 240,
  capabilityRateLimitPerHour: 120,
  // 兜底形状：无能力白名单（除恒启用的 record_check 外全关；provider=none 本就全关）
  capabilities: [],
  // 兜底形状没有配置来源（未 load 工厂）⇒ 无可告警的配置组合异常
  warnings: [],
};

/** 诊断日志的 Logger（**Logger 归属层 = 本文件**；config 工厂保持纯函数无 Logger） */
const logger = new Logger('JudgmentProvider');

/**
 * 解析 `judgment` 配置（缺省兜底；见文件头不变量）。
 *
 * @param config Nest ConfigService（app 由 app.module 的 load 数组注入；e2e 可能没有）
 * @returns 完整配置形状
 */
export function resolveJudgmentConfig(config: ConfigService): JudgmentConfig {
  return config.get<JudgmentConfig>('judgment') ?? JUDGMENT_CONFIG_FALLBACK;
}

/**
 * 诊断用的端点文案：**经 `new URL()` 解析，只取 host + path**（见文件头不变量）。
 *
 * @param absoluteUrl 真实发包端点（绝对 URL）
 * @returns `host + path`，或解析失败时的固定文案
 */
function describeEndpoint(absoluteUrl: string): string {
  try {
    const url = new URL(absoluteUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    // 畸形 URL 退化为固定文案（**不打 href**：它可能带 userinfo）
    return '<unparseable endpoint>';
  }
}

/**
 * provider 选择工厂（两态分派 + 退役/非法值 warn，见文件头）。
 *
 * @param config ConfigService
 * @returns 真实现或 noop（noop ⇒ 调用点短路：不调用、不写日志、不占额度）
 */
export function createJudgmentProvider(config: ConfigService): JudgmentProvider {
  const settings = resolveJudgmentConfig(config);

  // 配置组合异常**响亮化**（plan PM-N6）：config 工厂产 `warnings`（它保持纯函数无 Logger），
  // 由本层（Logger 归属层）逐条打一行 warn。文案在 config 侧已净化（只有键名 / 常量 /
  // 合法值域 / 经同一净化函数处理的能力名，**绝不含 env 原值**）——不可在其上再拼 env 原值。
  for (const warning of settings.warnings) logger.warn(warning);

  // 退役/非法值 warn（判据三条件见文件头 [关键不变量]）：`raw` 非空 + 解析落 none +
  // raw 不是合法值 'none' ⇒ 用户 .env 里留着退役值（jev）或拼错的值，而实际判别是关的。
  // ⚠️ 判非空**必须基于 trim 后的值**：compose 的 `${JUDGMENT_PROVIDER:-}` 在 .env 缺该键时
  // 注空串，裸判 `process.env` 非空会对每个默认部署误报。
  const raw = process.env.JUDGMENT_PROVIDER?.trim();
  if (raw && settings.provider === 'none' && raw !== 'none') {
    logger.warn(
      `JUDGMENT_PROVIDER=${sanitizeLogValue(raw)} is not valid (jev was retired in v1.83.0) — ` +
        'every judgment capability is DISABLED; set typesafe (+TYPESAFE_API_KEY) or none.',
    );
  }

  if (settings.provider === 'typesafe') {
    const provider = createTypesafeProvider(settings);
    if (provider.enabled) logEnabledCapabilities(settings);
    return provider;
  }

  return new NoopJudgmentProvider();
}

/**
 * 逐能力启动 INFO（名称 + 出境字段 + 触发者）。
 *
 * 只列**当前真正启用**的能力：`record_check` 恒启用（不受白名单管辖），受管能力须在白名单里。
 * 文案全部取自 config 的声明表（**内核不硬编码能力名**）——用户读的这三处（`.env.example`、
 * fail-fast、启动日志）因此不会各说各话。
 *
 * @param settings 完整配置（provider 已确认是启用的 typesafe）
 */
function logEnabledCapabilities(settings: JudgmentConfig): void {
  for (const declaration of JUDGMENT_CAPABILITY_DECLARATIONS) {
    if (!isJudgmentCapabilityEnabled(settings, declaration.name)) continue;
    logger.log(
      `judgment capability ENABLED — name=${declaration.name} ` +
        `egress: ${declaration.egressFields}; trigger: ${declaration.trigger}`,
    );
  }
}

/**
 * typesafe 分支：缺 key 降级 + 启动 INFO（见文件头）。
 *
 * @param settings 完整配置
 * @returns 官方 REST provider，或降级后的 noop
 */
function createTypesafeProvider(settings: JudgmentConfig): JudgmentProvider {
  if (!settings.apiKey) {
    // 到这里说明不是 production（production 已在 config 工厂抛错）。降级为 none + 一行 warn：
    // 只出现键名，不出现值；文案明确告知"判别被关闭"，避免运维以为在跑。
    logger.warn(
      'JUDGMENT_PROVIDER=typesafe but TYPESAFE_API_KEY is empty — every judgment capability is ' +
        'DISABLED (running as provider=none). Set TYPESAFE_API_KEY to enable them (see .env.example).',
    );
    return new NoopJudgmentProvider();
  }

  // typesafe 分支下 model 恒非 null（config 保证）；兜底复用同一缺省常量（缺省单源在 config）
  const model = settings.typesafeModel ?? DEFAULT_TYPESAFE_MODEL;
  // ⚠️ 行首的 `entry judgment ENABLED` 是**沿用下来的运维 grep 契约**（`.env.example` 的
  // "生效自检"与线上 DEPLOY.md 都按它筛行）。判别已通用化，但改这半个字面量会让所有既有
  // 排障指引当场失效——改名属于独立批次（连同文档一起改），本批不动。
  logger.log(
    `entry judgment ENABLED — provider=typesafe model=${model} ` +
      `endpoint=${describeEndpoint(buildTypesafeSystemoneUrl(settings.baseUrl))}`,
  );
  return new TypeSafeJudgmentProvider({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model,
    timeoutMs: settings.timeoutMs,
  });
}

/** `JUDGMENT_PROVIDER` 的 Nest provider 定义（JudgmentModule 展开并导出） */
export const judgmentProviderProvider: Provider = {
  provide: JUDGMENT_PROVIDER,
  inject: [ConfigService],
  useFactory: createJudgmentProvider,
};

/** `JUDGMENT_CONFIG` 的 Nest provider 定义 */
export const judgmentConfigProvider: Provider = {
  provide: JUDGMENT_CONFIG,
  inject: [ConfigService],
  useFactory: resolveJudgmentConfig,
};
