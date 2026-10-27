/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎的 **DI 装配点**：按配置选择实现（`hument` → HumentEngine / `fake` → FakeEngine /
 *     `none` → `null`）+ 启动诊断；同处装配**自助开通客户端**（`MEMORY_PROVISIONING` token）
 *
 * [代码职责]
 *   - `createMemoryEngine(config)`：三态分派；`none` 返回 `null`（**关闭态不是类**，见 [关键不变量]）
 *   - `createInstrumentedMemoryEngine(raw, tracker)`：观测层装配（`raw === null` ⇒ `null`）
 *   - `createMemoryProvisioning(config)`：自助开通开关 + socket 路径齐备才构造
 *     `HumentProvisioningClient`，否则返回 `null`（**关闭态不是类**，同引擎纪律）
 *   - **四个 token 的 provider 定义**：`MEMORY_ENGINE_RAW`（裸引擎）/ `MEMORY_ENGINE`
 *     （观测层包装）/ `MEMORY_CONFIG` / `MEMORY_PROVISIONING`
 *   - **三条诊断 + 一条启动 INFO**（Logger 归属层；config 工厂保持纯函数）：
 *     ① config 产出的 `warnings` 逐条 warn；② 非法/未知 `MEMORY_ENGINE` 值 ⇒ warn 一行
 *     （实际是关的）；③ hument 启用 ⇒ INFO 一行（解析后的 endpoint host+path，不打 href）；
 *     ④ 自助开通启用 ⇒ INFO 一行（socket 路径 / 绑定 id / 租户，**不打凭据 ref 值**）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §3（config 三件套 / 引擎闸双组 / none 缺省）
 *     ⚠️ **闭环缺口（已知）**：方案未上 DocSpace，coder D 批次落线上 `docs/spec.md`。
 *   - 补充: 线上 DocSpace `DEPLOY.md` — 部署 env 块（生效自检按启动 INFO 行筛）
 *
 * [关键不变量]
 *   - **关闭态 = `null`（不用 Noop 类）**：引擎六动词**没有一个是"关闭态也能跑"的**
 *     （不像判别的 noop 只需返回 error 结果）——用 Noop 就要写六个必然不可达的桩，
 *     而真正的闸是服务层的 `assertEngineAvailable`（它要区分 `not_configured` /
 *     `project_engine_unbound` 两个 reason，那**只有服务层知道**）。故：token 值为 null，
 *     服务层拿 null ⇒ 503 `MEMORY_UNAVAILABLE(14000)`。
 *   - **`MEMORY_CONFIG` 必须有缺省兜底**：e2e 的 ConfigModule 只 load jwt 一项，
 *     `config.get('memory')` 会 undefined——回落 `MEMORY_ENGINE_FALLBACK`（engine=none），
 *     保证服务层在任何装配下都拿到完整形状（测试再按需 override）。
 *   - **非法/未知 `MEMORY_ENGINE` 值必须响亮**（判据三条件缺一不可）：`env 原值 trim 后非空`
 *     **且** `解析结果 === 'none'` **且** `原值 !== 'none'`。⚠️ 必须 trim 后判非空——
 *     compose 的 `${MEMORY_ENGINE:-}` 在 .env 缺该键时注**空串**，裸判"已设置"会对每个默认
 *     部署 100% 误报。回显值经 `sanitizeLogValue`（**防用户把 key 误填进本键**）。
 *   - **诊断文案里的 URL 一律经 `new URL()` 解析、只取 host + path**：env 带 userinfo 时
 *     字符串切分会把凭证写进启动日志（`href` 同样含 userinfo，**禁止打 href**）；
 *     实现单源 = `config/memory.config.ts` 的 `describeEndpoint`（健康告警复用同一份；
 *     `new URL()` 的 try/catch 也在那里）。
 *   - **双 token 的装配分工**：`MEMORY_ENGINE_RAW` = 本工厂产出（无包装），`MEMORY_ENGINE` =
 *     包装层（`InstrumentedMemoryEngine`）。服务层只注入后者；e2e/单测只 replace 前者。
 *     **禁止把包装层合并进 `createMemoryEngine`**——纯函数分派必须可单测（不依赖 tracker）。
 *   - **config 的 `warnings` 只做透传打印**：文案在 config 侧已净化（只有键名 / 常量 /
 *     解析成功的正整数），本层**不得**在其上再拼 env 原值。
 *   - **本层不做配置校验**：fail-fast 在 config 工厂（production 拒 fake / 拒缺 baseUrl /
 *     拒 enabled 缺 socket 路径）；本层只分派 + 打日志——同一份判据写两处 = 迟早一处漏改。
 *   - **`MEMORY_PROVISIONING` 关闭态同样是 `null`**（不是 Noop 客户端）：自助开通是**可选**
 *     且只服务 create 一个分支——`null` 让服务层"自动注册不可用"与"没配"共用一条判定，
 *     不需要客户端自己回答"我能不能注册"。
 *   - **装配期只剩一道闸门：baseUrl 形态**（`resolveOperatorOrigin`）。原先还有一道
 *     "派生 `credential_ref` 的 KEY_SHAPED 形态闸门"，**已随该字段按 slug 派生而删除**：
 *     `ref-<slug>` 恒以 `ref-` 开头 ⇒ 结构性不可能命中 key 形态；把闸门留着只会留下
 *     "配置面有一个凭据键"的错觉（而那个键已因 Hub 侧主键约束被删）。
 *   - **config 的 `warnings` 只由 `createMemoryEngine` 打印一次**：两个 provider 都会注入
 *     ConfigService 并解析同一份配置，各打一遍 = 同一异常在启动日志里出现两次
 *     （`createMemoryProvisioning` 因此刻意不碰 warnings）。
 *   - 三个 token 都可被 `overrideProvider` 替换（e2e 用 FakeEngine / 替身注册客户端断言全链路）。
 *
 * [关联代码]
 *   - ../../config/memory.config.ts — 配置来源、值域、生产 fail-fast、`MEMORY_ENGINE_FALLBACK`
 *   - memory-engine.interface.ts — 端口与 `MEMORY_ENGINE` token
 *   - hument.engine.ts / fake.engine.ts — 两个引擎实现
 *   - hument-provisioning.client.ts — `MEMORY_PROVISIONING` token 的实现（自助开通）
 *   - config/judgment.config.ts — `sanitizeLogValue` 净化单源
 *   - modules/memory/memory.module.ts — 本工厂三个 provider 的装配点与导出
 *
 * [持久踩坑]
 *   MEMORY-EMPTY-ENV-STRING(空串当"已设置"): compose `${VAR:-}` 注空串 ⇒ 裸判 `process.env`
 *     非空会对默认部署 100% 误报"你配的引擎名非法"。安全方向: 一律 `?.trim()` 后判非空。
 *   MEMORY-USERINFO-LOG(userinfo 进日志): `https://user:pass@host/...` 直接字符串切分会把
 *     凭证写进长期保留的启动日志。安全方向: `new URL()` + 只取 host/path。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 token 必须同时给出"生产/测试各拿什么"的装配说明
 *   □ 新增实现必须同步本文件分派 + config 值域 + 两份 spec 的矩阵用例（枚举一致性断言会当场红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  describeEndpoint,
  resolveMemoryConfig,
  MEMORY_CONFIG,
} from '../../../config/memory.config';
import { sanitizeLogValue } from '../../../config/judgment.config';
import { FakeEngine } from './fake.engine';
import { HumentEngine } from './hument.engine';
import {
  HumentProvisioningClient,
  HumentProvisioningConfigError,
} from './hument-provisioning.client';
import { InstrumentedMemoryEngine } from './instrumented-memory.engine';
import { MEMORY_ENGINE, MEMORY_ENGINE_RAW, type MemoryEngine } from './memory-engine.interface';
import { EngineHealthTracker } from '../engine-health-tracker.service';

/** `MEMORY_CONFIG` 的注入 token（定义已迁到 config/memory.config.ts；此处 re-export 保持既有路径） */
export { MEMORY_CONFIG };

/** 诊断日志的 Logger（**Logger 归属层 = 本文件**；config 工厂保持纯函数无 Logger） */
const logger = new Logger('MemoryEngine');

/**
 * 引擎选择工厂（三态分派 + 诊断，见文件头）。
 *
 * @param config ConfigService
 * @returns `HumentEngine` / `FakeEngine`，或 `null`（关闭态：服务层据此 503）
 */
export function createMemoryEngine(config: ConfigService): MemoryEngine | null {
  const settings = resolveMemoryConfig(config);

  // 配置组合异常**响亮化**：config 工厂产 `warnings`（它保持纯函数无 Logger），
  // 由本层逐条打一行 warn。文案在 config 侧已净化（只有键名 / 常量 / 合法正整数）。
  for (const warning of settings.warnings) logger.warn(warning);

  // 非法/未知值 warn（判据三条件见文件头不变量）：`raw` 非空 + 解析落 none + raw 不是 'none'
  // ⇒ 用户 .env 里拼错了引擎名，而实际引擎是关的。⚠️ 判非空基于 **trim 后**的值。
  const raw = process.env.MEMORY_ENGINE?.trim();
  if (raw && settings.engine === 'none' && raw !== 'none') {
    logger.warn(
      `MEMORY_ENGINE=${sanitizeLogValue(raw)} is not a valid engine (known: none, fake, hument) — ` +
        'the memory engine is DISABLED (memory verbs will answer MEMORY_UNAVAILABLE).',
    );
  }

  if (settings.engine === 'hument') {
    logger.log(
      `memory engine ENABLED — engine=hument endpoint=${describeEndpoint(settings.humentBaseUrl)} ` +
        `timeoutMs=${settings.humentTimeoutMs}`,
    );
    return new HumentEngine({
      baseUrl: settings.humentBaseUrl,
      timeoutMs: settings.humentTimeoutMs,
    });
  }

  if (settings.engine === 'fake') {
    // ⚠️ 只在非 production 可达（production 已在 config 工厂 fail-fast 拒启动）——
    // 这行 INFO 是本地/e2e 的"我用的不是真 Hub"信号，防止把 fake 结果当成集成结论。
    logger.log('memory engine ENABLED — engine=fake (test/e2e only; no Hub traffic)');
    return new FakeEngine();
  }

  return null;
}

/**
 * 自助开通客户端的 Nest provider token。
 *
 * ⚠️ **字符串值不可改**：e2e/单测按它 `overrideProvider` 注入替身，改名 = 静默落到真实现
 * （真会去连 launcher socket 打 Hub）。**关闭态为 `null`**（同 `MEMORY_ENGINE` 纪律）。
 */
export const MEMORY_PROVISIONING = 'MEMORY_PROVISIONING';

/**
 * 自助开通客户端工厂（启用 + socket 路径齐备才构造；否则 `null`）。
 *
 * ⚠️ **本函数不打印 config 的 `warnings`**：那条路径的 Logger 归属是 `createMemoryEngine`
 * （两个 provider 都会跑，各打一遍 = 同一异常在启动日志里出现两次）。
 *
 * @param config ConfigService
 * @returns `HumentProvisioningClient`，或 `null`（关闭态：create 退回现有 400 语义）
 */
export function createMemoryProvisioning(config: ConfigService): HumentProvisioningClient | null {
  const settings = resolveMemoryConfig(config);
  if (!settings.provisioningEnabled || !settings.operatorSocketPath) return null;

  // ⚠️ 这里**没有** KEY_SHAPED 闸门了：凭据引用现在**按 slug 派生**（`ref-<slug>`，
  // 单源 = client 的 `buildProvisioningCredentialRef`），恒以 `ref-` 前缀开头 ⇒
  // 结构性不可能命中 `^(apikey|sk)[_-]`。原闸门存在的前提是"ref 由部署配置传入"，
  // 那条路径已因 Hub 侧主键约束（credential_ref 与注册 1:1）被删除。
  let client: HumentProvisioningClient;
  try {
    client = new HumentProvisioningClient({
      baseUrl: settings.humentBaseUrl,
      operatorSocketPath: settings.operatorSocketPath,
      operatorBindingId: settings.operatorBindingId,
      tenantId: settings.provisioningTenantId,
    });
  } catch (err: unknown) {
    // 构造期的形态闸门（畸形 baseUrl / Origin 退化）——文案只出现键名与形态，绝不回显值
    const reason =
      err instanceof HumentProvisioningConfigError ? err.reason : 'the client could not be built';
    return provisioningAssemblyFailure(reason);
  }

  logger.log(
    `memory provisioning ENABLED — operator socket=${settings.operatorSocketPath} ` +
      `bindingId=${settings.operatorBindingId} tenantId=${settings.provisioningTenantId}`,
  );
  return client;
}

/**
 * 自助开通**装配失败**的统一姿态（与 config 层"enabled 却缺 socket 路径"同档）。
 *
 * rationale（评审 S-6）：装配失败 = 自动注册不可用。production 下静默降级会让运维以为
 * "功能没做"（实际是配置写坏了）⇒ 拒启动（与 `HUMENT_BASE_URL` 缺键先例同形）；
 * dev/test 降级为一条 warn，文案必须点明**用户可见后果**（不传三键的 create 会回 400）。
 *
 * @param reason 已净化的原因描述（**只含键名与形态，绝不含 env 原值**）
 * @returns 永远 `null`（调用方按 null 走"关闭态"语义）
 * @throws Error production 下拒启动
 */
function provisioningAssemblyFailure(reason: string): null {
  const message =
    `auto-registration is DISABLED because its configuration is unusable (${reason}). ` +
    'Creating a project WITHOUT the engine binding triple will answer 400 (as if the feature were ' +
    'not built). Fix the setting, or set HUMENT_PROVISIONING_ENABLED=false to disable ' +
    'auto-registration on purpose. See .env.example.';
  if (process.env.NODE_ENV === 'production') throw new Error(message);
  logger.warn(message);
  return null;
}

/**
 * 观测层工厂：**裸引擎外面套一层 `InstrumentedMemoryEngine`**（`raw === null` ⇒ `null`）。
 *
 * 「未配置 ≠ 故障」的结构保证就在这里：未配置时整条观测链**不存在**（没有引擎可观测，
 * 探针也据此短路），而不是"观测一个空对象然后报它不健康"。
 *
 * @param raw 裸引擎（`MEMORY_ENGINE_RAW`；可能为 null）
 * @param tracker 健康状态机（app-scoped 单例）
 * @returns 包装后的引擎，或 null（关闭态）
 */
export function createInstrumentedMemoryEngine(
  raw: MemoryEngine | null,
  tracker: EngineHealthTracker,
): MemoryEngine | null {
  return raw ? new InstrumentedMemoryEngine(raw, tracker) : null;
}

/**
 * `MEMORY_ENGINE_RAW` 的 Nest provider 定义：**裸引擎**（工厂产出，无任何包装）。
 *
 * ⚠️ 它是 e2e/单测唯一的 `overrideProvider` 装配点（替换后包装层仍由工厂套上，
 * 故"上报逻辑"在测试里同样被执行）——见 memory-engine.interface.ts 的双 token 不变量。
 */
export const memoryEngineRawProvider: Provider = {
  provide: MEMORY_ENGINE_RAW,
  inject: [ConfigService],
  useFactory: createMemoryEngine,
};

/** `MEMORY_ENGINE` 的 Nest provider 定义（观测层；MemoryModule 展开并导出） */
export const memoryEngineProvider: Provider = {
  provide: MEMORY_ENGINE,
  inject: [MEMORY_ENGINE_RAW, EngineHealthTracker],
  useFactory: createInstrumentedMemoryEngine,
};

/** `MEMORY_CONFIG` 的 Nest provider 定义（缺省兜底见 config 的 `MEMORY_ENGINE_FALLBACK`） */
export const memoryConfigProvider: Provider = {
  provide: MEMORY_CONFIG,
  inject: [ConfigService],
  useFactory: resolveMemoryConfig,
};

/** `MEMORY_PROVISIONING` 的 Nest provider 定义（关闭态 = null；见 token 注释） */
export const memoryProvisioningProvider: Provider = {
  provide: MEMORY_PROVISIONING,
  inject: [ConfigService],
  useFactory: createMemoryProvisioning,
};
