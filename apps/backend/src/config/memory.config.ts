/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块（Hument 集成一期 + 二期自助开通）的**配置工厂**：`MEMORY_ENGINE` /
 *     `HUMENT_BASE_URL` / `HUMENT_TIMEOUT_MS` 三键 + 自助开通四键（`HUMENT_PROVISIONING_ENABLED`
 *     / `HUMENT_OPERATOR_SOCKET_PATH` / `HUMENT_OPERATOR_BINDING_ID` /
 *     `HUMENT_PROVISIONING_TENANT_ID`）解析 + 生产 fail-fast。
 *     memory 是**可选增强**：未配置引擎（缺省 `none`）时 Chamber 完全可用
 *
 * [代码职责]
 *   - `registerAs('memory')` 产出 `MemoryConfig`（engine / humentBaseUrl / humentTimeoutMs /
 *     自助开通四字段 / **探针开关**（`healthProbeEnabled`）/ warnings）；
 *     **纯函数、无 Logger**（warn 的打印归属引擎工厂，见 [关键不变量]）
 *   - `describeEndpoint`：端点诊断文案（host+path；**禁止 href/userinfo**）——引擎工厂启动 INFO
 *     与健康告警日志共用的**单源**
 *   - `MEMORY_ENGINE_PROVIDERS`：config 面值域（`none|fake|hument`；**落库值域更窄**）
 *   - `resolveMemoryConfig(config)` + `MEMORY_ENGINE_FALLBACK`：e2e 内联 ConfigModule
 *     未 load 本工厂时的缺省兜底（照 judgment 先例）
 *   - 解析防御：非法 `MEMORY_ENGINE` → `none`；非法 `HUMENT_TIMEOUT_MS` → 缺省；
 *     超 120s 上限 → 回落缺省 + 一条 warning；`HUMENT_PROVISIONING_ENABLED !== 'true'` → 关闭；
 *     `HUMENT_BASE_URL` scheme ∉ {http,https} → **所有环境 warn-only**（不回显原值、不回落）；
 *     `MEMORY_HEALTH_PROBE_ENABLED=false` 才关探针
 *   - **production-only fail-fast**：`MEMORY_ENGINE=fake` 拒；`hument` 缺显式 `HUMENT_BASE_URL` 拒；
 *     **自助开通 enabled 却缺 `HUMENT_OPERATOR_SOCKET_PATH` 拒**
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3 MemoryEngine 端口与三态
 *     （config 三件套 / 引擎闸双组 / 超时不等式）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: 线上 DocSpace `DEPLOY.md` — 部署 env 块（生产 fail-fast 的处置文案）
 *
 * [关键不变量]
 *   - **超时不等式（注解即契约）**：`HUMENT_TIMEOUT_MS ≥ 2 × <Hub provider timeout> + 余量`
 *     **且** `HUMENT_TIMEOUT_MS < 120000`（120s 上限）。
 *     缺省 90000 对"dev 建议的 provider timeout 25000"成立：2×25000 = 50000，余 40000ms
 *     （往返 + 服务端收尾），且 90000 < 120000 ✓。
 *     不等式理由：**Hument 服务端无写超时**（方案 §1）——客户端先超时放弃而服务端仍在跑时，
 *     我们既拿不到回执、也无法回滚，只能落 `unknown`（**Chamber 不可恢复**，§7 第 10 行）。
 *     故：**调低客户端超时必须同步调低 Hub 侧 provider timeout**；provider timeout 调低会
 *     升高 unknown 出现率（方案 §3：dev 建议 25000，别更低）。
 *   - **缺省 `none`（缺省关闭）**：`undefined` / 非法值一律视为 `none`——memory 是增强项，
 *     配置缺失不得阻断启动（与 judgment 的 provider 解析同纪律）。非法值的启动可见性由
 *     引擎工厂的 warn 承担（本文件是纯函数）。
 *   - **落库值域 ⊂ config 值域**：`fake` **只存在于 config 面**（shared `MEMORY_ENGINES` 只有
 *     `none|hument`）——FakeEngine 仅由测试注入进程内端口，落库出现 fake 即数据缺陷；
 *     production 下 `MEMORY_ENGINE=fake` **启动即崩**（fake 会把每一次形成都伪装成成功）。
 *   - **production 下 `hument` 必须显式给 `HUMENT_BASE_URL`**：缺省值 `http://127.0.0.1:8099`
 *     是**本机 dev 便利**；生产静默指向 loopback = "以为接了 Hub 其实没接"（每次调用白等
 *     一轮超时后落 unknown）。照 judgment "typesafe 缺 key 即抛"同形：**缺键在 production 抛、
 *     dev/test 回落到缺省**。
 *   - **数值非法一律回落缺省 + 一条 warning**（judgment N5 同规）：NaN / 非正数回落；
 *     空白串视同"未配置"（compose 的 `${VAR:-}` 注空串，裸判"已设置"会对默认部署 100% 误报）。
 *   - **warnings 只允许含已净化片段**：键名 / 常量 / 解析成功的正整数——**绝不内嵌 env 原值**
 *     （畸形值可能是 key 或带 userinfo 的 URL）。本文件的 warnings **一概不回显 env 原值**；
 *     引擎工厂的"非法 MEMORY_ENGINE"warn 复用 `sanitizeLogValue`（单源在 judgment.config.ts；
 *     两处各写一份 = 迟早有一处漏脱敏）。
 *   - **本文件绝不回显凭据**：`engine_credential_ref` 是**每项目**的注册表列，不经 env；
 *     自助开通的凭据引用**按项目派生**（`ref-<slug>`），同样**不经 env**——本文件只出现键名。
 *   - **自助开通四键缺省关闭**：`HUMENT_PROVISIONING_ENABLED !== 'true'` ⇒ 关闭；
 *     关闭时 `operatorSocketPath` 为 `null`（消费方据此判定"自动注册不可用"）——
 *     与 `engine` 的"缺省 none 不阻断启动"同纪律：建项目照常，只是三键必须显式传。
 *   - **自助开通 enabled 但缺 socket 路径**：production **拒启动**（照 `HUMENT_BASE_URL` 先例：
 *     "以为开着其实没开"的静默降级比启动崩更难排）；dev/test 降级为一条 warning +
 *     `operatorSocketPath=null`（本地无 Hub 也能起后端）。
 *   - **`enabled` 但 `engine !== 'hument'`** 是一条组合异常 warning（不是 fail-fast）：
 *     自动注册只在 `engine=hument` 的创建分支可达，配了却用不上属于"配错了"。
 *   - **打印归引擎工厂**：本文件只把问题描述成 `warnings[]`，由持 Logger 的
 *     `createMemoryEngine` 逐条 warn（Logger 归属层单源）。
 *
 * [关联代码]
 *   - modules/memory/engines/memory-engine.factory.ts — 本配置的消费方 + 诊断日志归属层
 *     （`MEMORY_ENGINE` 与自助开通的 `MEMORY_PROVISIONING` 两个 token 都在这里装配）
 *   - modules/memory/engines/hument.engine.ts — humentBaseUrl / humentTimeoutMs 的唯一消费者
 *   - modules/memory/engines/hument-provisioning.client.ts — 自助开通四字段的唯一消费者
 *     （凭据引用**不在其中**：它按 slug 派生，见该文件的 `buildProvisioningCredentialRef`）
 *   - modules/memory/engines/memory-engine.interface.ts — `MemoryEngineName` 的类型来源
 *   - config/judgment.config.ts — `sanitizeLogValue` 单源 + production fail-fast 与数值解析先例
 *   - docker-compose.yml / .env.example — 三键 + 自助开通四键的透传与用户文档
 *
 * [持久踩坑]
 *   MEMORY-DEFAULT-LOOPBACK-PROD(生产用 dev 缺省端点): `MEMORY_ENGINE=hument` 却不给
 *     `HUMENT_BASE_URL` ⇒ 打到 127.0.0.1:8099（容器里是它自己）。症状是"引擎配了但每次
 *     unknown"，排障要翻到超时链路才看得出来。安全方向: production 缺键即抛（本文件）。
 *   MEMORY-FAKE-PROD(测试引擎进生产): `fake` 把每次形成伪装成 committed ⇒ 账本记满
 *     `engine_memory_ids`，而 Hub 里什么都没有（召回时整批过滤掉，却没有任何报错）。
 *     安全方向: production 拒绝 `fake`（本文件），且落库值域不含 fake（shared 词表）。
 *   MEMORY-PROVISION-SILENT-OFF(自助开通静默关闭): `HUMENT_PROVISIONING_ENABLED=true` 却漏配
 *     `HUMENT_OPERATOR_SOCKET_PATH` ⇒ 自动注册根本没装配，而"建项目不传三键"仍退回 400
 *     （运维看到的是"功能好像没做"，而不是"配置缺一项"）。安全方向: production 缺键即抛（本文件）。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增键必须同时更新 .env.example、docker-compose.yml 透传、本文件的 fail-fast 文案
 *     与 `resolveMemoryConfig` 的兜底形状（`MemoryConfig` 类型标注会让漏字段编译期即红）
 *   □ 改动超时缺省必须同步 .env.example 的不等式注释（两处各写一份 = 迟早漂移）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { registerAs } from '@nestjs/config';
import type { ConfigService } from '@nestjs/config';
import { MEMORY_ENGINES } from '@agent-chamber/shared';

/**
 * 只读配置对象的注入 token（服务层的引擎闸与健康告警都读它）。
 *
 * ⚠️ **字符串值不可改**：e2e/单测按它 `overrideProvider` 注入配置对象。
 * 归属从引擎工厂迁到本文件（2026-10-23，卡 26c43f52）：`EngineHealthTracker` 需要它，
 * 而引擎工厂需要 tracker（装配包装层）——token 留在工厂会形成循环 import。
 * 工厂仍 `export { MEMORY_CONFIG }`（re-export），既有 import 路径零改动。
 */
export const MEMORY_CONFIG = 'MEMORY_CONFIG';

/**
 * config 面的引擎值域（顺序 = 文档与启动诊断的呈现顺序）。
 *
 * ⚠️ 与落库值域（shared `MEMORY_ENGINES` = `none|hument`）**刻意不同**：`fake` 只允许
 * 通过 config 注入（测试/本地演练），**永不落库**——`memory_projects.engine` 出现 fake
 * 即数据缺陷（见文件头不变量）。值域一致性由 `memory.config.spec.ts` 的
 * "config 值域 − fake === 落库值域"断言钉住。
 */
export const MEMORY_ENGINE_PROVIDERS = ['none', 'fake', 'hument'] as const;

/** config 面的引擎名 */
export type MemoryEngineName = (typeof MEMORY_ENGINE_PROVIDERS)[number];

/** 落库值域（转发 shared 单源；导出供一致性断言与文档引用，勿在此另写数组） */
export const MEMORY_PERSISTED_ENGINES: readonly MemoryEngineName[] = MEMORY_ENGINES;

/**
 * Hument Hub 的缺省端点（**本机 loopback**；生产必须显式覆盖，见文件头不变量）。
 *
 * rationale：Hument 默认监听 8099（容器内 127.0.0.1 指向容器自身）。dev 零配置起步；
 * production 由 fail-fast 强制显式配置（否则"以为接了其实没接"）。
 */
export const DEFAULT_HUMENT_BASE_URL = 'http://127.0.0.1:8099';

/**
 * 单次引擎调用的客户端硬顶（毫秒）。
 *
 * rationale（超时不等式，见文件头）：90000 ≥ 2×25000（dev 建议的 Hub provider timeout）+ 余量，
 * 且 < 120000。**它是最后一道防线**：客户端先放弃 → 无回执 → 落 `unknown`（不可恢复）。
 */
export const DEFAULT_HUMENT_TIMEOUT_MS = 90000;

/** 客户端超时上限（毫秒；方案 §3 不等式 `HUMENT_TIMEOUT_MS < 120s` 的上界，超限回落缺省） */
export const HUMENT_TIMEOUT_CEILING_MS = 120000;

/**
 * 端点诊断文案：**经 `new URL()` 解析，只取 host + path**。
 *
 * rationale（安全）：env 带 userinfo（`https://user:pass@host/...`）时，字符串切分会把凭证
 * 写进长期保留的启动/告警日志；`href` 同样含 userinfo，**禁止打 href**。
 *
 * 归属：本函数是**纯格式化**（无 Logger、无副作用），与 config 的纯函数纪律同档；消费方 =
 * 引擎工厂的启动 INFO 与健康告警的**日志字段**（`EngineHealthTracker`）。⚠️ **告警的 Topic
 * 文案禁止出现 host**（只进日志）——见 tracker 的文案闭集。
 *
 * @param absoluteUrl 端点原文（可能是畸形串）
 * @returns `host + path`，或解析失败时的固定文案
 */
export function describeEndpoint(absoluteUrl: string): string {
  try {
    const url = new URL(absoluteUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    // 畸形 URL 退化为固定文案（**不打 href**：它可能带 userinfo）
    return '<unparseable endpoint>';
  }
}

/**
 * 缺省 manager binding id（Hub 侧预置的 operator binding；自助开通 socket 请求体 `binding_id`）。
 *
 * rationale：operator 面用一个固定的、capability 受限的 manager binding 换 bootstrap code；
 * 它是**运维一次性预置**的（`binding add --id binding-ops-chamber ...`），不是逐项目派生。
 */
export const DEFAULT_HUMENT_OPERATOR_BINDING_ID = 'binding-ops-chamber';

/** 缺省租户 id（自助开通注册体 `tenant_id`；dev/prod 可覆盖为各自租户名） */
export const DEFAULT_HUMENT_PROVISIONING_TENANT_ID = 'chamber';

/**
 * ⚠️ **自助开通的 `credential_ref` 刻意不是配置键**：它**按项目派生**（`ref-<slug>`，
 * 单源 = `hument-provisioning.client.ts` 的 `buildProvisioningCredentialRef`）。
 *
 * 理由（Hub 侧硬约束，不是风格）：注册面给每个项目**裸 INSERT** 一行
 * `hument_catalog_credential_references`，而 `credential_ref` 是那张表的**主键** ⇒
 * ref 与注册 **1:1**，部署级共享一个 ref 会让第二个项目必然 409（dev 实机走查实锤）。
 * 配置面不暴露这个键 = 让"配错成共享 ref"在结构上不可能发生。
 */

/**
 * 本工厂产出的配置形状（DI 层用 `resolveMemoryConfig` 取；见引擎工厂）。
 *
 * 单独导出类型：引擎工厂的兜底常量与解析结果共用它——漏字段在编译期即红（fail-closed），
 * 不存在"少一个键静默吃 undefined"的窗口。
 */
export interface MemoryConfig {
  /**
   * 引擎实现选择（`none` = 关闭；引擎动词端点 503 `MEMORY_UNAVAILABLE`，本地数据端点照常）。
   *
   * ⚠️ `fake` 与落库值域的关系见 `MEMORY_ENGINE_PROVIDERS` 注释。
   */
  engine: MemoryEngineName;
  /** 端点（**含协议与端口**，不含路径——引擎内拼 `/v1/...`） */
  humentBaseUrl: string;
  /** 单次调用客户端硬顶（毫秒；不等式见文件头） */
  humentTimeoutMs: number;
  /** 是否启用「建项目自动注册 Hub workspace/binding」（缺省 false = 关闭，见文件头不变量） */
  provisioningEnabled: boolean;
  /**
   * launcher Unix socket 绝对路径（`<hub root>/run/hument-control.sock`）。
   *
   * `null` = 自动注册不可用：未启用，或（dev/test）启用却漏配 socket 路径。
   * 消费方（引擎工厂）据此把 `MEMORY_PROVISIONING` token 置 `null`。
   */
  operatorSocketPath: string | null;
  /** manager binding id（socket 请求体 `binding_id`；缺省见 `DEFAULT_HUMENT_OPERATOR_BINDING_ID`） */
  operatorBindingId: string;
  /** 注册体 `tenant_id`（缺省 `chamber`） */
  provisioningTenantId: string;
  /**
   * 是否启用 `GET /v1/health/ready` 探针（env `MEMORY_HEALTH_PROBE_ENABLED`；缺省 **true**）。
   *
   * `false` = 只保留**业务流量**判据（A 臂的 callCons/callFirstAt 与 B 臂）——用于
   * "Hub 探活由运维侧负责，平台不要额外打点"的部署偏好。⚠️ 它**只关探针**：
   * 时间窗求值（tick）与告警投递照常（否则关掉探针 = 连"连续失败 5 次已告警"的恢复都发不出）。
   */
  healthProbeEnabled: boolean;
  /**
   * 配置组合异常描述（**已净化**：键名 / 常量 / 解析成功的正整数，**绝不含 env 原值**）。
   * 空数组 = 无异常。打印由持 Logger 的引擎工厂做（本文件纯函数纪律）。
   */
  warnings: string[];
}

/**
 * 配置缺省兜底（e2e 内联 ConfigModule 未 load 本工厂时的形状保证；值 = 本工厂缺省）。
 *
 * ⚠️ 常量名沿用派发指令（`MEMORY_ENGINE_FALLBACK`），语义 = **完整配置**兜底形状
 * （与 judgment 的 `JUDGMENT_CONFIG_FALLBACK` 同角色）：加键必须同步这里与 `registerAs` 产出。
 */
export const MEMORY_ENGINE_FALLBACK: MemoryConfig = {
  engine: 'none',
  humentBaseUrl: DEFAULT_HUMENT_BASE_URL,
  humentTimeoutMs: DEFAULT_HUMENT_TIMEOUT_MS,
  // 自助开通缺省关闭 ⇒ socket 路径为 null（消费方据此把 provider 置 null）
  provisioningEnabled: false,
  operatorSocketPath: null,
  operatorBindingId: DEFAULT_HUMENT_OPERATOR_BINDING_ID,
  provisioningTenantId: DEFAULT_HUMENT_PROVISIONING_TENANT_ID,
  // 探针缺省**开**：零流量形态下它是唯一的"引擎不可用"证据
  healthProbeEnabled: true,
  // 兜底形状没有配置来源（未 load 工厂）⇒ 无可告警的配置组合异常
  warnings: [],
};

/**
 * 解析 `memory` 配置（缺省兜底；见文件头）。
 *
 * @param config Nest ConfigService（app 由 app.module 的 load 数组注入；e2e 可能没有）
 * @returns 完整配置形状
 */
export function resolveMemoryConfig(config: ConfigService): MemoryConfig {
  return config.get<MemoryConfig>('memory') ?? MEMORY_ENGINE_FALLBACK;
}

/**
 * 端点 scheme 问题（`http`/`https` 之外一律报问题；**只产出净化的警告文案**）。
 *
 * ⚠️ **文案不回显任何 env 片段**（连解析出的 protocol 也不打）：畸形值可能是 key 形态或
 * 带 userinfo 的 URL，protocol 部分同样可能来自用户误填。
 *
 * @param baseUrl 解析后的端点（已 trim / 已回落缺省）
 * @returns 警告文案，或 null（形态合法）
 */
function describeBaseUrlSchemeProblem(baseUrl: string): string | null {
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // 畸形串（完全解析不出来）
    return (
      'HUMENT_BASE_URL is not a parseable absolute URL with an http/https scheme — every engine ' +
      'call will fail as unreachable until it is fixed (value omitted from this log on purpose).'
    );
  }
  if (protocol === 'http:' || protocol === 'https:') return null;
  return (
    'HUMENT_BASE_URL uses an unsupported scheme — only http/https work; every engine call will ' +
    'fail until it is fixed (value omitted from this log on purpose).'
  );
}

/**
 * 正整数解析（缺失 / NaN / 非正数 → null）。
 *
 * @param raw env 原始字符串
 * @returns 合法正整数（向下取整），或 null
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

/**
 * 解析客户端超时（回落 + 上限钳制 + warning 产出）。
 *
 * 三段判据：① 非法值（非空且解析不出正整数）⇒ 回落缺省 + 一条 warning；
 * ② 超过 120s 上限 ⇒ **回落缺省** + 一条 warning（超限值不是"更大的耐心"，而是违反不等式：
 * 服务端无写超时，客户端等的越久，unknown 窗口越大，且会拖住调用方的连接）；
 * ③ 其余照用。
 *
 * @returns `{timeoutMs, warnings}`
 */
function resolveTimeoutMs(): { timeoutMs: number; warnings: string[] } {
  const warnings: string[] = [];
  const raw = process.env.HUMENT_TIMEOUT_MS;
  const parsed = parsePositiveInt(raw);

  // 空白串不算配置错误（compose `${VAR:-}` 注空串的误报守卫）
  if (Boolean(raw?.trim()) && parsed === null) {
    warnings.push(
      `HUMENT_TIMEOUT_MS is not a positive integer — falling back to the default of ` +
        `${DEFAULT_HUMENT_TIMEOUT_MS} ms (the configured value was ignored).`,
    );
    return { timeoutMs: DEFAULT_HUMENT_TIMEOUT_MS, warnings };
  }

  const value = parsed ?? DEFAULT_HUMENT_TIMEOUT_MS;
  if (value >= HUMENT_TIMEOUT_CEILING_MS) {
    warnings.push(
      `HUMENT_TIMEOUT_MS (${value} ms) reaches the ${HUMENT_TIMEOUT_CEILING_MS} ms ceiling — ` +
        `falling back to the default of ${DEFAULT_HUMENT_TIMEOUT_MS} ms. The client timeout must ` +
        'stay below 120s and at least 2x the Hub provider timeout, otherwise a slow formation ' +
        'ends as an unrecoverable "unknown" with no receipt.',
    );
    return { timeoutMs: DEFAULT_HUMENT_TIMEOUT_MS, warnings };
  }

  return { timeoutMs: value, warnings };
}

export default registerAs('memory', (): MemoryConfig => {
  // trim 归一：`.env` 尾随空格 / CRLF 污染不得把合法值判成非法（与引擎工厂非法值 warn
  // 的判据必须同口径，否则会出现"配了 hument 却落 none + 一条矛盾 warn"）
  const requested = process.env.MEMORY_ENGINE?.trim();
  // 非法 / 缺失一律 none（增强项，缺省关闭；启动可见性由引擎工厂 warn 承担）
  const engine: MemoryEngineName = (MEMORY_ENGINE_PROVIDERS as readonly string[]).includes(
    requested ?? '',
  )
    ? (requested as MemoryEngineName)
    : 'none';

  // 空白串视同"未配置"⇒ 回落缺省（compose `${VAR:-}` 注空串）；显式空白也按未配置处理
  const baseUrl = process.env.HUMENT_BASE_URL?.trim() || DEFAULT_HUMENT_BASE_URL;
  const isProduction = process.env.NODE_ENV === 'production';

  // ── 端点 scheme 校验（**所有环境 warn-only**）───────────────────────────────
  // rationale：引擎只会用 http/https 发请求；`ftp://` / 漏写协议的 `127.0.0.1:8099` 之类
  // 会在每次调用时抛 TypeError → 全量落 unreachable（症状是"引擎配了但每次都不可用"）。
  // **不回显 env 原值**（可能是带 userinfo 的 URL），也**不回落缺省**：生产回落 loopback
  // = 指向容器自身（见文件头踩坑 MEMORY-DEFAULT-LOOPBACK-PROD），静默改端点比响亮失败更糟。
  // 失败本身会被运行时告警（A 臂）接住——这里只负责让"配错了"在启动日志里可见。
  const schemeWarning = describeBaseUrlSchemeProblem(baseUrl);

  if (engine !== 'none' && isProduction) {
    // production-only fail-fast（照 judgment.config.ts 同形先例）：
    // ⚠️ 文案只出现键名 / 合法值域 / 逃生阀，绝不回显值。
    if (engine === 'fake') {
      throw new Error(
        'MEMORY_ENGINE=fake is a test-only engine and is refused in production: it would report ' +
          'every nomination as committed while nothing is ever stored in a Hub. Set ' +
          'MEMORY_ENGINE=hument (+HUMENT_BASE_URL) or MEMORY_ENGINE=none to disable the memory ' +
          'engine (Chamber stays fully usable without it). See .env.example.',
      );
    }
    // hument 必须**显式**给端点：缺省 loopback 是 dev 便利，生产静默指向它会变成
    // "引擎配了但每次都 unknown"（见文件头踩坑）
    if (!process.env.HUMENT_BASE_URL?.trim()) {
      throw new Error(
        'MEMORY_ENGINE=hument requires an explicit HUMENT_BASE_URL in production (the default ' +
          `http://127.0.0.1:8099 is local-dev only and would point the backend at itself). Set ` +
          'HUMENT_BASE_URL to the Hub endpoint, or set MEMORY_ENGINE=none to disable the memory ' +
          'engine (Chamber stays fully usable without it). See .env.example.',
      );
    }
  }

  const timeout = resolveTimeoutMs();

  // ── 自助开通（二期；缺省关闭）──────────────────────────────────────────────
  // 布尔解析沿用仓内约定（`process.env.X === 'true'`，与 DB_SSL / MINIO_USE_SSL 同口径）；
  // 其余键空白串视同"未配置"→ 回落缺省（compose `${VAR:-}` 注空串的误报守卫）
  const provisioningEnabled = process.env.HUMENT_PROVISIONING_ENABLED === 'true';
  const explicitSocketPath = process.env.HUMENT_OPERATOR_SOCKET_PATH?.trim() || null;
  const operatorBindingId =
    process.env.HUMENT_OPERATOR_BINDING_ID?.trim() || DEFAULT_HUMENT_OPERATOR_BINDING_ID;
  const provisioningTenantId =
    process.env.HUMENT_PROVISIONING_TENANT_ID?.trim() || DEFAULT_HUMENT_PROVISIONING_TENANT_ID;

  const warnings = [...timeout.warnings];
  if (schemeWarning) warnings.push(schemeWarning);
  let operatorSocketPath = explicitSocketPath;

  if (provisioningEnabled && !operatorSocketPath) {
    // 「配了开关却没给 socket」= 自动注册根本没装配，而"建项目不传三键"仍退回 400 ——
    // 运维看到的是"功能好像没做"（见文件头踩坑 MEMORY-PROVISION-SILENT-OFF）
    if (isProduction) {
      throw new Error(
        'HUMENT_PROVISIONING_ENABLED=true requires HUMENT_OPERATOR_SOCKET_PATH in production ' +
          '(the Hub launcher control socket, e.g. <hub root>/run/hument-control.sock). Without it ' +
          'auto-registration is not wired at all and creating a project without the engine ' +
          'binding triple would fail with a plain 400. Set the socket path, or set ' +
          'HUMENT_PROVISIONING_ENABLED=false to disable auto-registration. See .env.example.',
      );
    }
    // dev/test：降级为"不可用"而不是拒启动（本地无 Hub 也要能起后端）；消费方见 token=null
    warnings.push(
      'HUMENT_PROVISIONING_ENABLED=true was set without HUMENT_OPERATOR_SOCKET_PATH — ' +
        'auto-registration is DISABLED on this deployment (creating a project without the engine ' +
        'binding triple will answer 400). Set the socket path to enable it.',
    );
    operatorSocketPath = null;
  }

  if (provisioningEnabled && engine !== 'hument') {
    // 组合异常（不是 fail-fast）：自动注册只在 engine=hument 的创建分支可达
    warnings.push(
      'HUMENT_PROVISIONING_ENABLED=true has no effect while MEMORY_ENGINE is not "hument": ' +
        'auto-registration is only reachable from the engine=hument create branch.',
    );
  }

  // 探针开关：缺省**开**；只有显式 `false` 才关（`true`/空/缺省一律开——与仓内
  // `=== 'true'` 的布尔约定相反，因为这里的缺省态是"开"）。大小写/空白归一后再判。
  const rawProbeToggle = process.env.MEMORY_HEALTH_PROBE_ENABLED?.trim().toLowerCase();
  const healthProbeEnabled = rawProbeToggle !== 'false';
  if (rawProbeToggle && rawProbeToggle !== 'true' && rawProbeToggle !== 'false') {
    // 值域外的写法（no / off / 0 / yes…）目前会**静默判开**——运维以为关了其实还在探。
    // 只 warn 不改判据（缺省态是开，改成 fail-fast 会打断既有部署）。
    warnings.push(
      'MEMORY_HEALTH_PROBE_ENABLED is not "true"/"false" — treated as ENABLED, so the readiness ' +
        'probe keeps running. Set it to "false" to disable the probe.',
    );
  }

  return {
    /** 引擎实现选择（`none` = 关闭：引擎动词 503、本地数据端点照常） */
    engine,
    /** 端点（含协议与端口，不含路径；引擎内拼 `/v1/...`） */
    humentBaseUrl: baseUrl,
    /** 客户端硬顶（缺省 90000ms；不等式见文件头） */
    humentTimeoutMs: timeout.timeoutMs,
    /** 自助开通开关（缺省 false；见文件头不变量） */
    provisioningEnabled,
    /** 自动注册不可用时为 null（未启用，或 dev 缺 socket 路径降级） */
    operatorSocketPath,
    /** manager binding id（缺省 binding-ops-chamber） */
    operatorBindingId,
    /** 注册体 tenant_id（缺省 chamber） */
    provisioningTenantId,
    /** 探针开关（缺省开；`MEMORY_HEALTH_PROBE_ENABLED=false` 才关） */
    healthProbeEnabled,
    /** 配置组合异常（已净化；由引擎工厂启动时逐条 warn；空数组 = 无异常） */
    warnings,
  };
});

/**
 * 引擎名是否**可落库**（防 fake 进 `memory_projects.engine`）。
 *
 * rationale：`fake` 是 config 面合法的测试实现，但落库列的值域更窄（shared `MEMORY_ENGINES`）；
 * 把判据做成导出函数 = 服务层与单测共用一个口径（不各写一遍数组比较）。
 *
 * @param engine 解析后的引擎名
 * @returns true = 允许写入 `memory_projects.engine`
 */
export function isPersistableMemoryEngine(engine: MemoryEngineName): boolean {
  return MEMORY_PERSISTED_ENGINES.includes(engine);
}
