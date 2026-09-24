/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 判别服务（经验库）的 DI 装配点：按配置选择 provider 实现 + 暴露只读配置对象
 *
 * [代码职责]
 *   - `JUDGMENT_PROVIDER` token → **两态分派**：
 *     `typesafe` → `TypeSafeJudgmentProvider`（官方云 REST，一等公民）/ 其余 → `NoopJudgmentProvider`
 *   - `JUDGMENT_CONFIG` token → 缺省补齐后的只读配置（service 读限流额度用）
 *   - **两条诊断 + 一条启动 INFO**（Logger 归属层；config 工厂保持纯函数）：
 *     ① 真 provider 在 dev/test 缺 key ⇒ 降级 none + warn 一行；
 *     ② `JUDGMENT_PROVIDER` 设了非法/退役值（如 `jev`）⇒ warn 一行（判别实际是关的）；
 *     ③ 真启用 ⇒ INFO 一行（provider + model + **解析后的 endpoint host+path**）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域
 *     `none|typesafe` / 失败标签 / "启用 = 条目文本出境"声明）
 *   - 补充: .kimi/plans/plan-experience-base-p2.md §3.1（配置）/§3.2（provider 抽象）
 *
 * [关键不变量]
 *   - **provider 缺 key 时不得静默联网**：production 已在 config 工厂抛错；dev/test 在此
 *     **显式降级为 none 并 warn 一行**（只出现键名，不出现值）——"缺 key 却打真网关"会让每次
 *     录入白等一轮超时。
 *   - `JUDGMENT_CONFIG` 必须**有缺省兜底**：e2e 的 ConfigModule 只 load jwt 一项，
 *     `config.get('judgment')` 会是 undefined——此处回落 `none` + 缺省数值，保证服务在任何
 *     装配下都拿到完整形状（测试再按需 override）。
 *   - **诊断文案里的 URL 一律经 `new URL()` 解析、只取 host + path**：env 带 userinfo 时字符串
 *     切分会把凭证写进启动日志（`href` 同样含 userinfo，**禁止打 href**）。
 *   - **`new URL()` 必须 try/catch**：畸形 URL 不得让诊断行变成启动期抛错源——解析失败退化为
 *     固定文案（同样不打 href）。
 *   - **退役/非法值 warn 的判据**（三条件缺一不可）：`env 原值 trim 后非空` **且**
 *     `配置解析结果 === 'none'` **且** `原值 !== 'none'`。合法值集合**单源复用 config 解析
 *     结果**（不另写硬编码枚举）；⚠️ **必须 trim 后判非空**——docker compose 的
 *     `${JUDGMENT_PROVIDER:-}` 在 .env 缺该键时注**空串**，裸判"已设置"会对每个默认 OSS
 *     部署 100% 误报（与 config 的 JUDGMENT-EMPTY-MODEL 同源坑）。
 *   - **回显值必须净化**：剔除 `\r\n` 控制字符 + 截断 32 + **key 形态脱敏**（`^(apikey|sk)_`
 *     前缀值只回显前缀 + `***`，防用户把 key 误填进 JUDGMENT_PROVIDER 后被启动日志回显）——
 *     `.env` 是可注入内容，原样回显能伪造日志行（与下面 userinfo 纪律同源）。
 *   - 两个 token 都可被 `overrideProvider` 替换（e2e 用内存 fake provider 断言接线时序）。
 *
 * [关联代码]
 *   - config/judgment.config.ts — 配置来源、provider 值域与生产 fail-fast（缺省单源）
 *   - judgment-provider.interface.ts — token 与接口定义（`JUDGMENT_PROVIDER` 常量在此）
 *   - typesafe.judgment-provider.ts / noop.judgment-provider.ts — 两个实现
 *   - modules/experience/experience-judgment.service.ts — 两个 token 的消费者
 *
 * [持久踩坑]
 *   JUDGMENT-USERINFO-LOG(userinfo 进日志): `https://user:pass@host/...` 直接字符串切分会把
 *     凭证写进启动日志（启动日志是长期的、会被翻查的）。安全方向: `new URL()` + 只取 host/path。
 *   JUDGMENT-THIRD-PARTY-ENDPOINT(默认端点=第三方): 曾指"用户选 jev 却不把端点设成自建网关 ⇒
 *     条目正文发往维护者的私有网关"。**已随 jev 退役（v1.83.0）闭合**：内置 jev 缺省端点已
 *     删除、网关相关的旧配置键不再读取，值域只剩需自持 key 的官方云 REST。
 *   JUDGMENT-EMPTY-ENV-STRING(空串当"已设置"): compose `${VAR:-}` 注空串 ⇒ 裸判 `process.env`
 *     非空会对默认部署 100% 误报。安全方向: 一律 `?.trim()` 后判非空（见 [关键不变量]）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 token 必须同时给出"生产/测试各拿什么"的装配说明
 *   □ 新增 provider 必须同步本文件分派 + config 值域 + 两份 spec 的矩阵用例（枚举一致性
 *     断言会当场红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_TYPESAFE_BASE_URL,
  DEFAULT_TYPESAFE_MODEL,
  type JudgmentConfig,
} from '../../../config/judgment.config';
import { JUDGMENT_PROVIDER, type JudgmentProvider } from './judgment-provider.interface';
import { NoopJudgmentProvider } from './noop.judgment-provider';
import { buildTypesafeSystemoneUrl, TypeSafeJudgmentProvider } from './typesafe.judgment-provider';

/** 只读配置对象的注入 token（service 读 `rateLimitPerHour`；e2e 可 override） */
export const JUDGMENT_CONFIG = 'JUDGMENT_CONFIG';

/** 配置缺省兜底（e2e ConfigModule 未 load judgment 工厂时的形状保证；值 = 工厂缺省） */
const JUDGMENT_CONFIG_FALLBACK: JudgmentConfig = {
  provider: 'none',
  baseUrl: DEFAULT_TYPESAFE_BASE_URL,
  apiKey: null,
  typesafeModel: null,
  timeoutMs: 8000,
  rateLimitPerHour: 60,
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

/** key 形态前缀（`apikey_` = TypeSafe 官方 key 形态；`sk_` = 常见 LLM key 形态）——命中即脱敏回显 */
const KEY_SHAPED = /^(apikey|sk)_/;

/**
 * 日志回显净化：剔除换行控制字符 + 截断 32 字符 + **key 形态脱敏**（见文件头"回显值必须净化"）。
 *
 * rationale：被回显的是 `.env` 里的原值（可注入内容）——不净化就能凭 `\n` 伪造一条日志行，
 * 或凭超长值刷屏；32 只是"够看清填错的是什么"（远超任何合法 provider 名）。
 * **key 形态必须脱敏**：把 key 误填进 `JUDGMENT_PROVIDER` 是最常见的配置手滑，而启动日志会被
 * 长期保留、反复翻查——形态命中即只回显前缀 + `***`（与 config 工厂"绝不回显 key"同源纪律）。
 * 顺序 = 先剔换行 → 再截断 → **最后脱敏**（截断会切掉 key 后半，脱敏必须看最终回显串）。
 *
 * @param raw 待回显的 env 原值
 * @returns 单行、受限长度、key 形态已脱敏的回显串
 */
function sanitizeForLog(raw: string): string {
  const single = raw.replace(/[\r\n]/g, '').slice(0, 32);
  if (KEY_SHAPED.test(single)) {
    // 只留前缀（用户据此就能看出"我填的是 key，不是 provider 名"）
    return `${single.slice(0, single.indexOf('_') + 1)}***`;
  }
  return single;
}

/**
 * provider 选择工厂（两态分派 + 退役/非法值 warn，见文件头）。
 *
 * @param config ConfigService
 * @returns 真实现或 noop（noop ⇒ service 短路：不调用、不写日志、不占额度）
 */
export function createJudgmentProvider(config: ConfigService): JudgmentProvider {
  const settings = resolveJudgmentConfig(config);

  // 退役/非法值 warn（判据三条件见文件头 [关键不变量]）：`raw` 非空 + 解析落 none +
  // raw 不是合法值 'none' ⇒ 用户 .env 里留着退役值（jev）或拼错的值，而实际判别是关的。
  // ⚠️ 判非空**必须基于 trim 后的值**：compose 的 `${JUDGMENT_PROVIDER:-}` 在 .env 缺该键时
  // 注空串，裸判 `process.env` 非空会对每个默认部署误报。
  const raw = process.env.JUDGMENT_PROVIDER?.trim();
  if (raw && settings.provider === 'none' && raw !== 'none') {
    logger.warn(
      `JUDGMENT_PROVIDER=${sanitizeForLog(raw)} is not valid (jev was retired in v1.83.0) — ` +
        'entry pre-checks are DISABLED; set typesafe (+TYPESAFE_API_KEY) or none.',
    );
  }

  if (settings.provider === 'typesafe') return createTypesafeProvider(settings);

  return new NoopJudgmentProvider();
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
      'JUDGMENT_PROVIDER=typesafe but TYPESAFE_API_KEY is empty — entry pre-checks are DISABLED ' +
        '(running as provider=none). Set TYPESAFE_API_KEY to enable them (see .env.example).',
    );
    return new NoopJudgmentProvider();
  }

  // typesafe 分支下 model 恒非 null（config 保证）；兜底复用同一缺省常量（缺省单源在 config）
  const model = settings.typesafeModel ?? DEFAULT_TYPESAFE_MODEL;
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

/** `JUDGMENT_PROVIDER` 的 Nest provider 定义（ExperienceModule 直接展开） */
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
