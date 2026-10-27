/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - AppModule **hint 事实求值器（provider）链的单源清单**：拦截器 `HintInterceptor`
 *     拿到的 provider 数组 = 本清单（由 `app.module.ts` 的 `useFactory` 聚合为
 *     `HINT_FACT_PROVIDERS` token 的值），并支持**观察期 kill switch**。
 *
 * [代码职责]
 *   - 导出 `HINT_FACT_PROVIDER_CHAIN`（数组序 = 求值序）；`app.module.ts` 只做
 *     `inject: [...HINT_FACT_PROVIDER_CHAIN]` 的机械展开。
 *   - 导出 **纯函数** `resolveHintProviderChain(disabled?)`：按 kill switch 键过滤链。
 *     显式入参（不读 env）——env 的读取只在 `app.module.ts` 的 `useFactory` 里发生，
 *     本函数因此可单测、可复用（无隐式全局态）。
 *   - 守卫 = `src/app.module.spec.ts`（断言链内容与顺序，**不 boot 应用**）
 *     + `src/config/app-hint-provider-chain.spec.ts`（kill switch 纯函数矩阵）。
 *
 * [权威文档]
 *   - 发行裁剪: 线上 docs/integrations/oss-dual-repo.md §11（Memory 模块与 DI 链同门）
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *   - 补充: 线上 docs/modules/hint-system.md §3（多 provider 合并求值）与 §5（观察期仪器）
 *
 * [关键不变量]
 *   - **清单里放的是类对象且必须值导入**：`app.module.ts` 按它做 DI 注入——`import type`
 *     会被 TS 擦除（清单变空 ⇒ 生产零 provider ⇒ 提示静默消失且无任何报错）。
 *   - **每个 provider 必须由某个被 AppModule import 的模块 export**（当前 =
 *     `MemoryModule` 导出 `MemoryNominationHintProvider`、`TaskModule` 导出
 *     `TaskHygieneHintProvider`）：未导出则 `useFactory` 的 `inject` 解析不到，
 *     **启动期**报 "Nest can't resolve dependencies"（不是请求期 500）。
 *   - **顺序有意义**：全部 provider 按链序求值后**合并**候选（阶段三决策 6，「首个胜出」
 *     已退役），但顺序仍决定：① 同 code 归属（后写覆盖前写，实际同 code 分属不同
 *     provider 属配置错误）② 无 priority 声明时的候选传入序。
 *   - **kill switch 的键是稳定标识**（`security_scan` / `task_hygiene` / `memory_nomination`）
 *     ——**禁跟随类名重构改**：线上 operator 按 env 值操作，键漂移会让开关静默失效（关不掉）。
 *     未知 token 一律忽略（多写一个词不该把链清空——fail-open）。
 *   - 改本清单 = 行为变更：同步 `app.module.spec.ts` 的断言与本注释。
 *
 * [关联代码]
 *   - src/app.module.ts — 唯一消费方（providers 内 `useFactory` 聚合 + kill switch 过滤）
 *   - src/app.module.spec.ts — 链内容守卫（与 `APP_INTERCEPTOR_CHAIN` 同一套模式）
 *   - src/config/app-hint-provider-chain.spec.ts — kill switch 纯函数单测
 *   - src/config/app-interceptor-chain.ts — 同款「清单 + 守卫」先例（拦截器链序单源）
 *   - src/modules/hints/hints.module.ts — 本清单缺席时的缺省（`useValue: []`，生产被遮蔽）
 *   - src/modules/memory/memory-nomination-hint.provider.ts — 提名提醒（通用触发）
 *   - src/modules/task/task-hygiene-hint.provider.ts — task 纪律族三码
 *   - src/modules/hints/security-hint.provider.ts — security 族（**零领域依赖，由
 *     `HintsModule` 自己 provide/export**——其余两个 provider 归属各自的领域模块；
 *     这是清单里唯一的「基建模块自持 provider」形态，理由见 hints.module.ts 的文件头）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增 provider 时四处齐步：本清单 + app.module.spec.ts + 所属模块 exports + 该
 *     provider 自己的文件头
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import type { Type } from '@nestjs/common';
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import { MemoryNominationHintProvider } from '../modules/memory/memory-nomination-hint.provider';
import { TaskHygieneHintProvider } from '../modules/task/task-hygiene-hint.provider';
import { SecurityHintProvider } from '../modules/hints/security-hint.provider';

/**
 * provider 条目 = kill switch 键 + 类引用（一一对应，键是**稳定标识**）。
 *
 * 为什么不直接用类名当键：类名会被重构（`MemoryNominationHintProvider` →
 * 别的名字），而 env `HINT_PROVIDERS_DISABLED` 的值写在线上的运维配置里——
 * 键跟随类名漂移 = 开关静默失效。
 */
interface HintProviderEntry {
  /** kill switch 键（env `HINT_PROVIDERS_DISABLED` 的值域；稳定标识） */
  key: string;
  /** provider 类（值导入，见文件头不变量） */
  provider: Type<unknown>;
}

/**
 * provider 清单（**数组序 = 求值序**，不变量见文件头）。
 *
 * - `SecurityHintProvider`：security 族单码（凭证粘贴）。**置首位**的 rationale =
 *   链序决定**无 priority 声明时的候选传入序**：doc upsert 这类响应里，docspace 域侧的
 *   nomination 提示与凭证提示可能同响应共存，凭证先入队 ⇒ 在 ≤3 预算下优先占槽。
 *   ⚠️ 只保护 **budget ≥ 1** 档的相对序；**budget = 0**（域侧已挂满 3 条）时所有 provider
 *   候选都落 `slot_truncated`——那是已接受的缺口（域侧占满是既有语义，见 hints §5）。
 * - `TaskHygieneHintProvider`：task 纪律族三码（完工无结果证据 / 依赖引导 / 对已完工任务评论）。
 * - `MemoryNominationHintProvider`：写路径「该提名了」提示——task 状态变更 / task 评论 /
 *   topic 消息 / doc upsert 四类事实 × 记忆项目绑定（active）× 触发者对资源有 write 权限。
 *
 * 顺序 rationale（其余两条）：task 纪律是**单响应内的即时纠偏**（写错姿势立刻提醒），提名是
 * **事后思考引导**；前者排在后面那两者之中更靠前的位置，且同样决定无 priority 声明时的
 * 候选传入序。
 */
const HINT_PROVIDER_ENTRIES: readonly HintProviderEntry[] = [
  { key: 'security_scan', provider: SecurityHintProvider },
  { key: 'task_hygiene', provider: TaskHygieneHintProvider },
  // 必须在 DI 注入前裁剪；注入后的 kill switch 无法修复缺少 MemoryModule 的依赖。
  ...(MEMORY_FEATURE_ENABLED
    ? [{ key: 'memory_nomination', provider: MemoryNominationHintProvider }]
    : []),
];

/** hint 事实求值器链（**数组序 = 求值序**，不变量见文件头） */
export const HINT_FACT_PROVIDER_CHAIN: readonly Type<unknown>[] = HINT_PROVIDER_ENTRIES.map(
  (entry) => entry.provider,
);

/**
 * 按 kill switch 过滤 provider 链（**纯函数**，不读 env——env 只在 app.module 读）。
 *
 * @param disabled 逗号分隔的 kill switch 键（如 `task_hygiene,memory_nomination`）；
 *   缺省 / 空串 / 全空白 ⇒ 全链。未知 token 忽略（fail-open：不因拼错而清空链）。
 * @returns 仍启用的 provider 类（引用同 {@link HINT_FACT_PROVIDER_CHAIN}）
 */
export function resolveHintProviderChain(disabled?: string): readonly Type<unknown>[] {
  if (!disabled) return HINT_FACT_PROVIDER_CHAIN;
  const tokens = new Set(
    disabled
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
  if (tokens.size === 0) return HINT_FACT_PROVIDER_CHAIN;
  return HINT_PROVIDER_ENTRIES.filter((entry) => !tokens.has(entry.key)).map(
    (entry) => entry.provider,
  );
}

/**
 * **app.module 的 useFactory 胶水**（抽成具名函数以便单测——匿名工厂无法被断言，而
 * 「kill switch 真的把实例滤掉了」这件事必须可证）。
 *
 * 为什么不直接测 AppModule 的 provider 元数据：`app.module.spec.ts` 刻意**不 import
 * AppModule**（import 全模块图 = 拉起重型启动面，见该文件头）。把逻辑抽到这里，
 * 守卫既有真实覆盖又不动那条纪律。
 *
 * @param providers DI 注入的**实例全集**（顺序 = `inject` 展开顺序 = 链序）
 * @param disabled env `HINT_PROVIDERS_DISABLED` 原值
 * @returns 过滤后的实例（顺序保持链序；未启用者被剔除）
 */
export function applyHintProviderKillSwitch(
  providers: readonly unknown[],
  disabled?: string,
): readonly unknown[] {
  const enabled = resolveHintProviderChain(disabled);
  return providers.filter((provider) =>
    enabled.includes((provider as object).constructor as never),
  );
}
