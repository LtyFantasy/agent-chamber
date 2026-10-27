/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 平台 **hint 基建模块**（v1.92.0-dev 阶段一）：通用内核 / 去重窗口 / 埋点 /
 *     code 元数据注册表 / 事实袋 / 触发器拦截器 的**唯一装配点**（`@Global()`）。
 *
 * [代码职责]
 *   - `@Global()`：hint 是**横切基建**，任何领域模块（docspace / memory / 新挂面）
 *     都要注入去重窗口与注册表，逐个 import 只会制造模块图噪音。
 *   - provider 清单：`HintDedupService`（去重窗口单例——**跨 service 共享同一份窗口**）、
 *     `HintRegistry`（元数据目录门面）、`HINT_FACT_PROVIDERS`（事实袋求值器数组；
 *     **本模块给的是 standalone / 测试缺省 `[]`，生产由 AppModule 遮蔽**——见下条不变量）。
 *   - **跨域消费方例外（v1.94.0-dev，security 族）**：`SecurityHintProvider` 是**唯一**
 *     由本模块自己 provide + export 的领域 provider——它的判据零领域依赖（只读事实载荷里的
 *     标量 + 模式表的 label），放在 `modules/hints/` 内不违反下面的「依赖方向」不变量
 *     （它不 import docspace / memory / task）。其余领域 provider（memory / task）仍各自
 *     归属自己的模块并 export（它们的判据要查库，天然属于领域）。
 *     为什么不让它另开一个模块：为一个零依赖的纯映射 provider 建模块只会多一处装配面，
 *     而它需要的 `HintRegistry` 恰好在本模块内。
 *
 * [权威文档]
 *   - 主文档: 线上 docs/api-definition.md §2.7「hints 信封（advisory 提示）」
 *
 * [关键不变量]
 *   - **`HintDedupService` 必须是单例**：五个 docspace 消费方共享同一份窗口，各模块
 *     自行 `providers: [HintDedupService]` 会得到**各自的窗口**（同一 hint 被重复送达，
 *     表现为「去重失效」而没有任何报错）——所以它只在这里注册（docspace.module 已移除
 *     本地注册），token 同一 class，消费方注入代码不变。
 *   - **`HINT_FACT_PROVIDERS` 的值由根注入器解析**：拦截器是 AppModule 注册的
 *     `APP_INTERCEPTOR`，它读到的就是这里（**或 AppModule 覆盖后**）的值。Nest 语义：
 *     **模块自有的 provider 优先于被 import 模块的同名 token** ⇒ AppModule 的
 *     `useFactory(...HINT_FACT_PROVIDER_CHAIN)` 在生产遮蔽本模块的 `useValue: []`，
 *     而 standalone 测试模块（只 import 本模块）仍拿到空数组缺省。
 *     接入新 provider 时**改 `config/app-hint-provider-chain.ts` 单源清单**，而不是在
 *     领域模块内各自重注册（后者对拦截器不可见——它不 import 那些模块）。
 *   - **依赖方向**：本模块（及整个 `modules/hints/`）不得 import docspace / memory
 *     模块代码；领域语义一律经 provider / profile 注入。
 *
 * [关联代码]
 *   - modules/hints/hint-core.ts / hint-emit.ts / hint-log.ts — 纯函数与接线层
 *   - modules/hints/hint-dedup.service.ts — 去重窗口（单例）
 *   - modules/hints/hint-registry.ts — 元数据目录（阶段二装配依据）
 *   - modules/hints/security-hint.provider.ts — security 族 provider（**本模块 provide/export
 *     的唯一领域 provider**，理由见 [代码职责] 的「跨域消费方例外」）
 *   - modules/hints/hint.interceptor.ts — 拦截器（APP_INTERCEPTOR 注册在 app.module.ts）
 *   - config/app-hint-provider-chain.ts — **provider 装配单源清单**（AppModule 据此
 *     聚合 `HINT_FACT_PROVIDERS`；本模块的 `useValue: []` 只是缺省）
 *   - app.module.ts — 模块与拦截器注册点（顺序：Response → Logging → AccessQuery → Hint）
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面（是否出现第二份去重窗口）
 *   □ 新增本模块自有领域 provider 前，先确认它零领域依赖（否则应归属其领域模块）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Global, Module } from '@nestjs/common';
import { HINT_FACT_PROVIDERS } from './hint.interceptor';
import { HintDedupService } from './hint-dedup.service';
import { HintRegistry } from './hint-registry';
import { SecurityHintProvider } from './security-hint.provider';

@Global()
@Module({
  providers: [
    // 去重窗口：**单例**（跨模块共享同一份窗口；见文件头不变量）
    HintDedupService,
    // code 元数据目录门面（阶段一无生产消费方；阶段二 provider 注入使用）
    HintRegistry,
    // security 族 provider（零领域依赖，故归本模块；见文件头「跨域消费方例外」）
    SecurityHintProvider,
    // 事实袋求值器：**standalone / 测试缺省**（空数组 ⇒ HintInterceptor 快路径②直通）；
    // 生产由 AppModule 的 providers 遮蔽为 `useFactory(...HINT_FACT_PROVIDER_CHAIN)`
    // （见文件头不变量——Nest 语义：模块自有 provider 优先于被 import 模块的同名 token）
    { provide: HINT_FACT_PROVIDERS, useValue: [] },
  ],
  // SecurityHintProvider 必须 export：AppModule 的 useFactory `inject` 要解析到它
  // （未导出 ⇒ 启动期 "Nest can't resolve dependencies"，不是请求期 500）
  exports: [HintDedupService, HintRegistry, SecurityHintProvider, HINT_FACT_PROVIDERS],
})
export class HintsModule {}
