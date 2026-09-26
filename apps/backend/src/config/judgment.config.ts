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
 *     rateLimitPerHour（actor 额度）/ globalRateLimitPerHour（全局总闸）/
 *     capabilityRateLimitPerHour（能力子额度）/ capabilities（受管能力白名单）/
 *     warnings（配置组合异常描述）
 *   - 键读取：provider=typesafe → `TYPESAFE_*`；**其余一律** baseUrl = TypeSafe 官方缺省根、
 *     apiKey = null（none 下 apiKey 无消费者——工厂只在 typesafe 分支读它）
 *   - 解析防御：provider 非法值 → none；timeout / 三级额度非法值 → 回缺省；model 空串 → 回缺省；
 *     `JUDGMENT_CAPABILITIES` 非法/未实现名 → 丢弃 + 一条 warning
 *   - **三级成本闸是软闸**（见 [关键不变量]）：全局总闸 → 能力子额度 → actor 额度，缺省
 *     240 / 120 / 60 每小时**每实例**
 *   - **production-only fail-fast**：provider=typesafe 缺 key、端点非 https 时仅生产启动即崩
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/experience-base.md` — 判别服务章（provider 值域
 *     `none|typesafe` / 失败标签 / "启用 = 文本出境"声明）
 *   - 补充: 线上 DocSpace `docs/spec.md` — `JudgmentCapability` 与能力值域
 *   - 补充: 线上 DocSpace `DEPLOY.md` — 判别服务 env 块与生产切换 runbook
 *
 * [关键不变量]
 *   - **`undefined` / 非法 provider 值一律视为 `none`**（缺省关闭）：判别服务是 observe
 *     期增强，配置缺失不能阻断录入主流程。**退役值 `jev` 走同一条路**——解析落 none
 *     且不抛错（启动可见性由工厂的 warn 承担，见工厂文件头）。
 *   - **`JUDGMENT_CAPABILITIES` 缺省 = 空集**（除 `record_check` 外一切能力默认关）：新增判别
 *     能力必须**显式开启**才有出境流量——"默认关"是出境类功能的唯一可接受缺省。
 *     `record_check`（经验库录入判定）**恒不受本键管辖**：它由 `JUDGMENT_PROVIDER` 单独管辖，
 *     在本键里列它只会得到一条 warning（见下方常量注释）。
 *   - **本文件保持纯函数、无 Logger**：一切 warn / info 落 provider 工厂（Logger 归属层）。
 *   - **出境声明三处同源**：`JUDGMENT_CAPABILITY_DECLARATIONS` 是本文件内的单源，
 *     `.env.example` 逐能力、生产 fail-fast 文案、启动 INFO 逐能力都引用同一段文字
 *     （三处各写一遍 = 迟早有一处漏更新，而漏的那处正是用户读的那处）。
 *   - **缺 key 只在 production 抛错**（照 attachment-url.config.ts 的 production-only 先例）：
 *     dev/test 允许无 key 启动（e2e 内联 ConfigModule 不 load 本工厂；本地零配置起步），
 *     由 provider 工厂把它降级成 none 并 warn 一行（见 judgment-provider.factory.ts）。
 *   - **typesafe 端点的 scheme 硬闸（仅 production）**：非 `https:` 即抛，只有 `localhost` /
 *     `127.0.0.1` 放行 http（照 plugins/kimi-code/hooks/session-start.mjs 的 S6 白名单）；
 *     解析失败的畸形串同样视为不安全——否则文本与 key 会以明文过网。
 *   - **`TYPESAFE_DEFAULT_MODEL` 空串也回落缺省**（`?.trim() || `）：docker compose 的
 *     `${VAR:-}` 会注入空串，空串当请求 model 发出 = 官方 422（arch R4）。
 *   - **解析防御是硬要求**（arch 复核 N5）：`JUDGMENT_TIMEOUT_MS` / `JUDGMENT_RATE_LIMIT` /
 *     `JUDGMENT_GLOBAL_RATE_LIMIT` / `JUDGMENT_CAPABILITY_RATE_LIMIT` 的 NaN / 非正数一律
 *     回落缺省——"配置写错就静默关闭限流"是最糟的失败模式。
 *   - **三级成本闸是软闸，不是账单硬承诺**：全局总闸（`globalRateLimitPerHour`）→ 能力子额度
 *     （`capabilityRateLimitPerHour`）→ actor 额度（`rateLimitPerHour`），三级**都**是**进程内
 *     内存**计数器——每实例每滑动小时、**重启清零**、**多副本上界 ×N**（无共享存储，单实例
 *     部署前提与录入限流同规）。挡的是异常风暴（脚本 bug / 重放 / 单 actor 刷量），真实账单
 *     上限 ≈ 闸值 × 单次判定的输入体量（出境量口径见 `.env.example`）。
 *   - **配置组合异常必须响亮**：本工厂产 `warnings: string[]`（解析回退各一条 + 键间不变量
 *     `capability ≤ global` 违反一条 + 能力键相关三条），由持有 Logger 的 provider 工厂在启动时
 *     统一打印——本文件仍是**纯函数无 Logger**，只负责"把问题描述出来"（plan PM-N6）。
 *   - **warnings 文案只允许含已净化片段**（键名 / 常量 / 合法值域：缺省值或**解析成功的**
 *     正整数 / 经 `sanitizeLogValue` 净化的能力名）：**绝不内嵌 env 原值**——畸形值可能是 key
 *     （`apikey_…`）或带 userinfo 的 URL，原样回显即 `JUDGMENT-USERINFO-LOG` 同族泄漏。
 *   - **空白串不算配置错误**：`.trim()` 后为空视同"未配置"（compose 的 `${VAR:-}` 在 .env 缺键
 *     时注空串），**不产生 warning**——否则每个默认部署都会误报（JUDGMENT-EMPTY-ENV-STRING 同源坑）。
 *   - **本文件绝不回显 key 值**（错误文案只出现键名 / 入口 URL / 逃生阀）：配置错误信息会进
 *     启动日志。
 *
 * [关联代码]
 *   - modules/judgment/typesafe.judgment-provider.ts — 官方 REST 客户端（唯一真实现）
 *   - modules/judgment/noop.judgment-provider.ts — 关闭态实现（provider=none）
 *   - modules/judgment/judgment-provider.factory.ts — provider 选择 + 诊断日志
 *     （含退役值 `jev` 的启动 warn 与逐能力启动 INFO）
 *   - modules/judgment/judgment-runner.service.ts — 能力启用判定（`isJudgmentCapabilityEnabled`）
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
import { EXPERIENCE_JUDGMENT_OPERATION } from '@agent-chamber/shared';

/**
 * 判别服务提供方值域（非法值 / 退役值一律视为 none；顺序 = 文档与 help 文案的呈现顺序）。
 *
 * 值域收窄史：`jev`（自托管 jev MCP 网关适配器）在 v1.83.0 退役——**不再列在这里**，
 * 旧 .env 残留该值时解析落 none（工厂随之打一行 warn）。
 */
export const JUDGMENT_PROVIDERS = ['none', 'typesafe'] as const;
export type JudgmentProviderName = (typeof JUDGMENT_PROVIDERS)[number];

/**
 * 已实现能力的**出境声明**（`JUDGMENT_CAPABILITIES` 管辖面的单源）。
 *
 * 每个能力一行，字段含义：
 * - `name`：能力名（≡ `EXPERIENCE_JUDGMENT_OPERATIONS` 值域成员，落日志表 `operation` 列）
 * - `governs`：是否**受** `JUDGMENT_CAPABILITIES` 管辖（`false` = 恒启用，见 [关键不变量]）
 * - `egressFields`：**出境字段**（启用该能力后，哪些数据会离开本机网络）——用户读的就是它
 * - `trigger`：**触发者**（谁、在什么条件下会触发一次付费调用）
 *
 * ⚠️ **三处同源**：`.env.example` 的逐能力出境声明、生产 fail-fast 文案、启动 INFO 逐能力
 * 行都引用本表的文字。改这里必须同步 `.env.example`（有单测钉住本表与注册表一致）。
 */
export const JUDGMENT_CAPABILITY_DECLARATIONS: readonly {
  name: string;
  governs: boolean;
  egressFields: string;
  trigger: string;
}[] = [
  {
    name: EXPERIENCE_JUDGMENT_OPERATION.RECORD_CHECK,
    governs: false,
    egressFields:
      'entry title / summary / excerpt (≤2000 chars) / signals / domains / env fingerprint / ' +
      'suspected-duplicate candidates (id, title, quality)',
    trigger: 'creating or editing an experience entry (record_check)',
  },
  {
    name: EXPERIENCE_JUDGMENT_OPERATION.RERANK,
    governs: true,
    egressFields:
      'the search query text plus up to 50 candidate rows (section title + a UTF-8 byte-bounded ' +
      'excerpt ≈240B each; no docId / docPath / position)',
    trigger:
      'an agent-initiated DocSpace search with sort=relevance inside the rerank paging window',
  },
];

/**
 * 受 `JUDGMENT_CAPABILITIES` 管辖的能力名（`governs: true` 的那些）。
 *
 * 派生自声明表（**不另写一份数组**）：声明表加一行而这里忘了改，症状是"新能力永远开不了"
 * 或"用户配了却不生效"，且没有任何报错。
 */
export const GOVERNED_JUDGMENT_CAPABILITIES: readonly string[] =
  JUDGMENT_CAPABILITY_DECLARATIONS.filter((entry) => entry.governs).map((entry) => entry.name);

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
  /**
   * **全局**总闸：每实例每滑动小时的判定总数（跨 actor；env `JUDGMENT_GLOBAL_RATE_LIMIT`，缺省 240）。
   *
   * rationale（plan arch B1-3 / PM F1-2）：单 actor 额度挡不住"actor 数放大"，也挡不住一次
   * 批处理 / 重放打爆账单——全局闸是**实例级**兜底，同时守住总出境量。
   */
  globalRateLimitPerHour: number;
  /**
   * **单能力**子额度：每实例每滑动小时、**单个判别能力**的判定数
   * （env `JUDGMENT_CAPABILITY_RATE_LIMIT`，缺省 120；本批能力 = `record_check` + `rerank`）。
   *
   * 语义：`> globalRateLimitPerHour` 时**本闸永不生效**（全局闸必定先触发）——不抛错（判别是
   * 增强项，配置组合错误不该阻断启动），改为产一条 warning 由工厂响亮打印（见文件头不变量）。
   */
  capabilityRateLimitPerHour: number;
  /**
   * 受 `JUDGMENT_CAPABILITIES` 管辖的**已启用能力**（小写归一；缺省空集）。
   *
   * 语义：`record_check`（经验库录入判定）**恒不在其中**（不受管辖）；其余能力只有出现在这里
   * 才算开启（缺省关 = 无出境流量）。非法名 / 未实现名被丢弃并产一条 warning。
   */
  capabilities: string[];
  /**
   * 配置组合异常描述（**已净化**：键名 / 常量 / 合法正整数值 / 经净化的能力名，**绝不含
   * env 原值**）。
   *
   * 空数组 = 无异常。产出规则：数值键解析回退各一条 + 键间不变量（capability ≤ global /
   * actor ≤ global）违反各一条 + 能力键三条（列了恒启用能力 / 未知名 / 配了能力却 provider=none）。
   * **打印由持 Logger 的 provider 工厂做**（本文件纯函数纪律，见文件头）。
   */
  warnings: string[];
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

/**
 * 每实例每小时的**全局**判定总闸缺省（跨 actor）。
 *
 * rationale：取 actor 额度的 4 倍——正常规模下约 4 个"满额 actor"才撞总闸（不误伤多用户并发），
 * 而单点风暴（脚本 bug / 重放 / 单 actor 之外的放大）仍被实例级兜住。
 * ⚠️ 它是**共享桶**：只统计真正放行的请求（service 的 `countRejected=false`）——被拒尝试不占位，
 * 故额度不会被连续刷钉满，窗口滑过即自动恢复（终审 F1）。
 */
const DEFAULT_GLOBAL_RATE_LIMIT_PER_HOUR = 240;

/**
 * 每实例每小时**单个能力**的判定子额度缺省（本批能力 = `record_check` + `rerank`）。
 *
 * rationale：取全局闸的一半——给后续能力（如文档搜索 rerank）留隔离位：**每个能力最多消耗自己的
 * 子额度**（≤ 全局闸），故单一能力的风暴吃不满全局预算，经验库判定（不可再生语料）不会归零。
 * 该承诺的前提 = "各能力子额度 ≤ 全局闸"（越界由启动 warn 点明）；共享桶只计放行（同全局闸）。
 * **恒 ≤ 全局缺省**，故缺省组合不产不变量 warning。
 */
const DEFAULT_CAPABILITY_RATE_LIMIT_PER_HOUR = 120;

/** 允许走明文 http 的主机（仅本机；照 session-start.mjs 的 S6 scheme 白名单，不做闭类扩展） */
const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * 正整数解析（**单一解析函数**：`resolvePositiveInt` 与 warnings 判据共用，防两处判据漂移）。
 *
 * @param raw env 原始字符串
 * @returns 合法正整数（向下取整），或 null（缺失 / NaN / 非正数）
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

/**
 * 正整数解析防御（照 experience.constants.ts 的 `resolveCreateRateLimit` 形态）。
 *
 * @param raw env 原始字符串
 * @param fallback 非法时回落值（缺省值单源在本文件）
 * @returns 合法正数或 fallback
 */
function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  return parsePositiveInt(raw) ?? fallback;
}

/**
 * 该 env 值是否触发了"解析回退"（供 warnings 产出）。
 *
 * **空白串不算**配置错误：compose 的 `${VAR:-}` 在 .env 缺键时注入空串，裸判"已设置"会对每个
 * 默认部署 100% 误报（与工厂退役值 warn 的误报守卫同源）。
 */
function isParseFallback(raw: string | undefined): boolean {
  return Boolean(raw?.trim()) && parsePositiveInt(raw) === null;
}

/**
 * 解析四个数值旋钮并产出配置组合异常描述（**已净化**，见文件头不变量）。
 *
 * 顺序固定（超时 / actor / 全局 / 能力，再键间不变量）——warnings 的数组顺序即启动日志顺序，
 * 稳定可断言。
 */
function resolveNumericKnobs(): {
  timeoutMs: number;
  rateLimitPerHour: number;
  globalRateLimitPerHour: number;
  capabilityRateLimitPerHour: number;
  warnings: string[];
} {
  const knobs = {
    timeoutMs: resolvePositiveInt(process.env.JUDGMENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    rateLimitPerHour: resolvePositiveInt(
      process.env.JUDGMENT_RATE_LIMIT,
      DEFAULT_RATE_LIMIT_PER_HOUR,
    ),
    globalRateLimitPerHour: resolvePositiveInt(
      process.env.JUDGMENT_GLOBAL_RATE_LIMIT,
      DEFAULT_GLOBAL_RATE_LIMIT_PER_HOUR,
    ),
    capabilityRateLimitPerHour: resolvePositiveInt(
      process.env.JUDGMENT_CAPABILITY_RATE_LIMIT,
      DEFAULT_CAPABILITY_RATE_LIMIT_PER_HOUR,
    ),
  };

  const warnings: string[] = [];
  // 解析回退逐键一条：**只回显键名与回落缺省值**——env 原值可能是 key 或带 userinfo 的 URL，
  // 原样回显即 JUDGMENT-USERINFO-LOG 同族泄漏（见文件头"warnings 只允许含已净化片段"）。
  const fallbackRows: Array<[key: string, raw: string | undefined, value: number, unit: string]> = [
    ['JUDGMENT_TIMEOUT_MS', process.env.JUDGMENT_TIMEOUT_MS, knobs.timeoutMs, 'ms'],
    [
      'JUDGMENT_RATE_LIMIT',
      process.env.JUDGMENT_RATE_LIMIT,
      knobs.rateLimitPerHour,
      'per hour (actor)',
    ],
    [
      'JUDGMENT_GLOBAL_RATE_LIMIT',
      process.env.JUDGMENT_GLOBAL_RATE_LIMIT,
      knobs.globalRateLimitPerHour,
      'per hour (global)',
    ],
    [
      'JUDGMENT_CAPABILITY_RATE_LIMIT',
      process.env.JUDGMENT_CAPABILITY_RATE_LIMIT,
      knobs.capabilityRateLimitPerHour,
      'per hour (capability)',
    ],
  ];
  for (const [key, raw, value, unit] of fallbackRows) {
    if (isParseFallback(raw)) {
      warnings.push(
        `${key} is not a positive integer — falling back to the default of ${value} ${unit} ` +
          '(the configured value was ignored).',
      );
    }
  }

  // 键间不变量：**两级额度都必须 ≤ 全局总闸**，否则该级永不生效（全局闸先触发）——capability
  // 越界让"能力隔离位"失效，actor 越界让"单 actor 封顶"名存实亡（终审 F5）。
  // ⚠️ 回显的是**解析后的正整数**（合法值域）——不是 env 原值。
  if (knobs.capabilityRateLimitPerHour > knobs.globalRateLimitPerHour) {
    warnings.push(
      `JUDGMENT_CAPABILITY_RATE_LIMIT (${knobs.capabilityRateLimitPerHour}/h) exceeds ` +
        `JUDGMENT_GLOBAL_RATE_LIMIT (${knobs.globalRateLimitPerHour}/h) — the per-capability ` +
        'sub-limit can never bind (the global gate fires first); lower ' +
        'JUDGMENT_CAPABILITY_RATE_LIMIT to at most the global limit.',
    );
  }
  if (knobs.rateLimitPerHour > knobs.globalRateLimitPerHour) {
    warnings.push(
      `JUDGMENT_RATE_LIMIT (${knobs.rateLimitPerHour}/h per actor) exceeds ` +
        `JUDGMENT_GLOBAL_RATE_LIMIT (${knobs.globalRateLimitPerHour}/h) — the per-actor limit ` +
        'can never bind (the global gate fires first); lower JUDGMENT_RATE_LIMIT to at most ' +
        'the global limit.',
    );
  }

  return { ...knobs, warnings };
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

/**
 * `JUDGMENT_CAPABILITIES` 的键名（单源：警告文案与 `.env.example` 引用同一字面量）。
 *
 * 值是**逗号分隔的能力名列表**（如 `rerank`）；缺省空集（除恒启用的 `record_check` 外全关）。
 */
export const JUDGMENT_CAPABILITIES_ENV_KEY = 'JUDGMENT_CAPABILITIES';

/** key 形态前缀（`apikey_` = TypeSafe 官方 key 形态；`sk_` = 常见 LLM key 形态）——命中即脱敏回显 */
const KEY_SHAPED = /^(apikey|sk)[_-]/;

/**
 * 日志回显净化：剔除换行控制字符 + 截断 32 字符 + **key 形态脱敏**。
 *
 * rationale：被回显的是 `.env` 里的原值（**可注入内容**）——不净化就能凭 `\n` 伪造一条日志行，
 * 或凭超长值刷屏；32 只是"够看清填错的是什么"。**key 形态必须脱敏**：把 key 误填进配置键是
 * 最常见的配置手滑，而启动日志会被长期保留、反复翻查（与 config 工厂"绝不回显 key"同源纪律）。
 * 顺序 = 先剔换行 → 再截断 → **最后脱敏**（截断会切掉 key 后半，脱敏必须看最终回显串）。
 *
 * 单源在本文件：`judgment-provider.factory.ts` 的退役值 warn 与 `resolveCapabilityKnobs` 的
 * 非法能力名 warn **共用同一净化函数**（两处各写一份 = 迟早有一处漏脱敏）。
 *
 * @param raw 待回显的 env 原值
 * @returns 单行、受限长度、key 形态已脱敏的回显串
 */
export function sanitizeLogValue(raw: string): string {
  const single = raw.replace(/[\r\n]/g, '').slice(0, 32);
  if (KEY_SHAPED.test(single)) {
    // 只留前缀（用户据此就能看出"我填的是 key，不是配置值"）
    return `${single.slice(0, single.indexOf('_') + 1)}***`;
  }
  return single;
}

/**
 * 解析 `JUDGMENT_CAPABILITIES` 能力白名单并产出对应 warnings（**已净化**）。
 *
 * 规则（顺序固定，warnings 数组顺序即启动日志顺序）：
 * ① `record_check`（恒不受管辖）被列出 ⇒ 一条 warning、**不**入选（用户以为能关它，必须告知）；
 * ② 未实现 / 拼错的名字 ⇒ 一条 warning（名字经 `sanitizeLogValue` 净化）、**不**入选；
 * ③ 其余合法名 ⇒ 小写归一后入选（去重，保持出现顺序）。
 *
 * @param provider 解析后的 provider（用于键间组合检查）
 * @returns `{ capabilities, warnings }`
 */
function resolveCapabilityKnobs(provider: JudgmentProviderName): {
  capabilities: string[];
  warnings: string[];
} {
  const raw = process.env[JUDGMENT_CAPABILITIES_ENV_KEY];
  const capabilities: string[] = [];
  const warnings: string[] = [];

  // 空白串视同"未配置"（compose `${VAR:-}` 注空串的误报守卫，与数值键同源纪律）
  const tokens = (raw ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const name = token.toLowerCase();
    if (name === EXPERIENCE_JUDGMENT_OPERATION.RECORD_CHECK) {
      warnings.push(
        `${JUDGMENT_CAPABILITIES_ENV_KEY} lists "${name}" — entry pre-checks are ALWAYS on and ` +
          'are governed by JUDGMENT_PROVIDER alone; the entry was ignored.',
      );
      continue;
    }
    if (!GOVERNED_JUDGMENT_CAPABILITIES.includes(name)) {
      warnings.push(
        `${JUDGMENT_CAPABILITIES_ENV_KEY}: "${sanitizeLogValue(name)}" is not an implemented ` +
          `capability — the entry was ignored (known: ${GOVERNED_JUDGMENT_CAPABILITIES.join(', ')}).`,
      );
      continue;
    }
    if (!capabilities.includes(name)) capabilities.push(name);
  }

  // 组合异常：配了能力却把 provider 关了 ⇒ 所有能力都不会生效（用户很可能以为配了就跑了）。
  if (capabilities.length > 0 && provider === 'none') {
    warnings.push(
      `${JUDGMENT_CAPABILITIES_ENV_KEY} enables ${capabilities.join(', ')} but ` +
        'JUDGMENT_PROVIDER=none — every capability stays OFF until JUDGMENT_PROVIDER=typesafe ' +
        '(+TYPESAFE_API_KEY) is set.',
    );
  }

  return { capabilities, warnings };
}

/**
 * 能力是否启用（纯函数：调用点与单测共用同一判据）。
 *
 * `record_check` **恒启用**（不受 `JUDGMENT_CAPABILITIES` 管辖——它由 `JUDGMENT_PROVIDER`
 * 单独管辖，见文件头不变量）；其余能力必须在白名单里。`provider.enabled` 由调用点单独判
 * （本函数只回答"这个能力被配置允许了吗"）。
 *
 * @param config 解析后的判别配置
 * @param capabilityName 能力名
 * @returns true = 允许调用
 */
export function isJudgmentCapabilityEnabled(
  config: JudgmentConfig,
  capabilityName: string,
): boolean {
  if (capabilityName === EXPERIENCE_JUDGMENT_OPERATION.RECORD_CHECK) return true;
  return config.capabilities.includes(capabilityName);
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
          'https://console.typesafe.ai/keys, or set JUDGMENT_PROVIDER=none to disable every ' +
          'judgment capability. ⚠️ Enabling it sends data to the TypeSafe cloud API — that ' +
          'traffic leaves your network. Per-capability egress fields: ' +
          JUDGMENT_CAPABILITY_DECLARATIONS.map(
            (entry) => `${entry.name} → ${entry.egressFields}`,
          ).join('; ') +
          '. See .env.example.',
      );
    }
    // typesafe 端点 scheme 硬闸（见文件头不变量）：http 只放行本机
    if (provider === 'typesafe' && !isSecureEndpoint(baseUrl)) {
      throw new Error(
        'JUDGMENT_PROVIDER=typesafe requires an https TYPESAFE_BASE_URL in production ' +
          '(http is only allowed for localhost / 127.0.0.1). Set TYPESAFE_BASE_URL to the https ' +
          'API root — default https://api.typesafe.ai, and do NOT append /v1 — or set ' +
          'JUDGMENT_PROVIDER=none to disable every judgment capability. See .env.example.',
      );
    }
  }

  // 四个数值旋钮 + 配置组合异常一次解出（解析防御与 warnings 判据**共用同一解析函数**，
  // 防"回落了却不告警"的判据漂移——见 resolveNumericKnobs）
  const knobs = resolveNumericKnobs();
  // 能力白名单 + 其 warnings（键间组合检查需要 provider，故在 provider 解析之后跑）
  const capabilityKnobs = resolveCapabilityKnobs(provider);

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
    timeoutMs: knobs.timeoutMs,
    /** 单 actor 每小时额度（60 缺省；非法值回落；create/update 共用） */
    rateLimitPerHour: knobs.rateLimitPerHour,
    /** 全局总闸（240 缺省；非法值回落；跨 actor、每实例） */
    globalRateLimitPerHour: knobs.globalRateLimitPerHour,
    /** 单能力子额度（120 缺省；非法值回落；按能力名分别记账） */
    capabilityRateLimitPerHour: knobs.capabilityRateLimitPerHour,
    /** 受 `JUDGMENT_CAPABILITIES` 管辖的已启用能力（小写归一；缺省空集） */
    capabilities: capabilityKnobs.capabilities,
    /** 配置组合异常（**已净化**；由 provider 工厂在启动时逐条 warn；空数组 = 无异常） */
    warnings: [...knobs.warnings, ...capabilityKnobs.warnings],
  };
});
