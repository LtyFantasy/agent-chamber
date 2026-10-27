/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块装配：4 实体仓储 + 权限内核 + 四个业务服务 + 引擎端口/配置 provider
 *     + **引擎健康查询面**（`ENGINE_HEALTH_VIEW`，`/health/ready` 的 `optional.memoryEngine` 唯一来源）
 *
 * [代码职责]
 *   - `forFeature` 的实体清单（**漏一个 = 首个请求 500**，见 [关键不变量]）
 *   - 服务与控制器注册、引擎 provider 展开（**双 token**）、对外导出面
 *   - **Usage 两读面**（alpha.19）：`MemoryUsageService` + 进程内并发闸 + 路径级 no-store
 *     中间件（`configure()` 只挂在两条 usage GET 上）
 *   - 阶段二新增：`MemoryNominationHintProvider`（写路径"该提名了"提示；**必须 export**
 *     ——AppModule 的 `HINT_FACT_PROVIDERS` 工厂按类引用注入它）
 *   - 卡 26c43f52 新增：`EngineHealthTracker`（双臂状态机）+ `EngineHealthProbeService`
 *     （120s 就绪探针）
 *   - 卡 5e6cb000 新增：`engineHealthViewProvider`（**派生只读 provider**，token =
 *     `ENGINE_HEALTH_VIEW`）+ `NotificationsModule` import（告警推送端口，替代原 Topic 通道）
 *
 * [权威文档]
 *   - 主文档: 线上 DocSpace `docs/architecture.md` §3.2.14（memory 小节：模块依赖声明
 *     Memory→Notifications 永久单向边 / Health→Memory / `ENGINE_HEALTH_VIEW` 一节）
 *   - 补充: 线上 `docs/api-definition.md` §19.2（三通道 / 健康五 token = **告警态视图**，
 *     `degraded` 可被任何登录用户诱发，**不得作为自动摘流/自动重启判据**）
 *
 * [关键不变量]
 *   - **`forFeature` 必须覆盖四个服务用到的**全部**实体**：方法级 `JwtOrApiKeyGuard` 在
 *     **声明它的模块上下文**里实例化，其 `@InjectRepository(User)` 从本模块解析；而三个
 *     Policy 依赖的 Topic/Board/DocSpace/BoardList/TopicParticipant/BoardMember/DocSpaceMember
 *     由 `@Global()` PermissionModule 的 forFeature 提供（本模块**不重复注册**，重复会让
 *     DI 出现第二个仓储实例）——所以这里只补 memory 自己的 + 来源回取用到的内容实体。
 *     漏注册 = 应用启动后首个请求 DI 炸，而单测/e2e 因 `overrideGuard` 全部漏网（先例
 *     experience.module.ts / attachment.module.ts 的血泪注释）。
 *     **唯一例外 = `MemoryEngineBindingClaim`**：它由 `MemoryProjectService` 在事务内用
 *     `manager.getRepository()` 访问（必须与项目 save 同事务），实体元数据由
 *     `database/typeorm-options.ts` 的 barrel 全局加载；**不要**为它注入仓储 provider。
 *   - **`Agent` / `Actor` 仓储**刻意不在此注册**：提名者归属名走 `@Global()` CommonModule 的
 *     `ActorProfileService`（它内部注册 Actor+User+Agent，软删 `deletedAt` 的
 *     `withDeleted + addSelect` 与 agent 名回退链都收口在那里，见该服务 R1/R9）。
 *     为"批量查 agents"再在本模块 forFeature(Agent) = 第二个仓储实例 + 把那段踩坑复制一遍。
 *   - **引擎 provider 是双 token**（`memoryEngineRawProvider` + `memoryEngineProvider`）：
 *     `MEMORY_ENGINE_RAW` 在 `MEMORY_ENGINE=none` 时**就是 `null`**（关闭态不是类，见工厂文件头），
 *     `MEMORY_ENGINE` = 裸引擎外套 `InstrumentedMemoryEngine`（raw 为 null ⇒ 包装层同样 null）。
 *     服务层只注入 `MEMORY_ENGINE`；e2e/单测只 override `MEMORY_ENGINE_RAW`——包装层在生产与
 *     测试里走同一条路径（测试替身不绕过观测层）。`MEMORY_PROVISIONING`（二期自助开通）同
 *     纪律：未启用或缺 socket 路径即 `null`，create 的"全缺三键"分支据此退回现有 400。
 *   - **`ScheduleModule.forRoot()` 不在这里**：它已由 `attachment.module.ts` 全局注册一次；
 *     本模块只声明 `@Cron` 方法（`EngineHealthProbeService`）。重复 `forRoot` = 同一个探针 cron
 *     被调度两次（单测看不出，生产表现为告警计数翻倍）。
 *   - **告警通道依赖单向且永久**：MemoryModule → NotificationsModule（`EngineHealthTracker`
 *     调 `NotifyOrchestrator.sendSystemAlert()`）。**notify 侧禁止依赖 memory 的任何 provider**
 *     ——反向一条边就成 DI 环。原 Memory → Topic 边已随 Topic 通道拆除（卡 5e6cb000）。
 *   - **`ENGINE_HEALTH_VIEW` 是单一派生只读 provider**（token 与 provider 分开命名，照
 *     `MEMORY_ENGINE` / `memoryEngineProvider` 先例）：`read()` 每次请求现算、**不缓存不自持状态**
 *     ——缓存会把"告警已恢复"滞后到下一次刷新，而这条视图的全部价值就是"此刻是否在告警"。
 *     判定顺序固定：`engine==null ⇒ disabled` → `availability.alerted ⇒ down`（**只有 A 臂产出
 *     down**；B 臂 = 单项目绑定坏，是 `degraded`）→ `auth.alerted ⇒ degraded` →
 *     `!healthProbeEnabled ⇒ unknown` → `lastProbeOkAt===null ⇒ unknown`（启动首轮窗口，
 *     无证据不报 up）→ `up`。`engine == null` 的 null/undefined 歧义在本模块收敛（`!engine`）。
 *     **exports 只加这个 token（tracker 不导出）**：消费方只有 health 模块，面越窄越好。
 *   - **本模块不注册任何全局 provider**（无 APP_GUARD/APP_INTERCEPTOR）：鉴权走全局兜底 +
 *     方法级声明。
 *   - **`MemoryLedgerRepository` 必须在本模块 provide**：它是重放的唯一入口
 *     （`content`/`rationale` 是 `select:false`），不导出给别的模块（重放语义不外泄）。
 *
 * [关联代码]
 *   - memory.controller.ts — 12 端点（方法级守卫在此声明）
 *   - memory-project/-formation/-recall/-correction.service.ts — 四个 business service
 *   - memory-nomination-hint.provider.ts — 写路径"该提名了"提示 provider（阶段二；
 *     AppModule 的 provider chain 按类引用注入，故本模块 **export** 它）
 *   - memory-access.service.ts — 权限内核（三处同源约束的唯一实现）
 *   - engine-health-tracker.service.ts — 引擎运行时健康状态机（告警置位/派发/心跳/快照）
 *   - engine-health-probe.service.ts — 120s 就绪探针（@Cron；调度器由 attachment.module 注册）
 *   - ../notifications/notifications.module.ts — 告警推送端口（`NotifyOrchestrator` 已导出）
 *   - ../health/health.module.ts / health.controller.ts — `ENGINE_HEALTH_VIEW` 的消费方
 *   - ../../common/services/actor-profile.service.ts — 提名者归属名/删除标记的批量解析源
 *     （@Global CommonModule 导出，本模块不注册它的仓储）
 *   - engines/memory-engine.factory.ts — 两个 provider 的定义处
 *   - ledger.repository.ts — 重放读取器
 *   - ../../app.module.ts — 本模块的注册点
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 新增注入依赖时先确认它由哪个模块导出（@Global 与否），再决定 import 还是 forFeature
 *   □ 改 `ENGINE_HEALTH_VIEW` 的判定顺序必须同步 health.controller.spec 的五态映射用例
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  Logger,
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MemoryProject } from '../../database/entities/memory-project.entity';
import { MemoryNomination } from '../../database/entities/memory-nomination.entity';
import { MemoryFormationEvent } from '../../database/entities/memory-formation-event.entity';
import { MemoryRecallEvent } from '../../database/entities/memory-recall-event.entity';
// ⚠️ 绑定解析用到的四个平台实体（topic/board/docSpace/boardList）**必须在本模块 forFeature**：
// `PermissionModule` 虽是 @Global，但**只导出** PermissionService / AccessQueryService /
// OwnerProxyService——`TypeOrmModule.forFeature` 产生的仓储 provider **不外泄**。
// 漏注册的症状 = 应用**启动即崩**（`Nest can't resolve dependencies ... "DocSpaceRepository"`），
// 而不是请求期 500（e2e 首次运行实测到的缺陷，见文件头不变量）
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Topic } from '../../database/entities/topic.entity';
import { Board } from '../../database/entities/board.entity';
import { BoardList } from '../../database/entities/board-list.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSection } from '../../database/entities/doc-section.entity';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { TaskComment } from '../../database/entities/task-comment.entity';
import { User } from '../../database/entities/user.entity';
import { MEMORY_CONFIG, type MemoryConfig } from '../../config/memory.config';
import { MemoryLedgerRepository } from './ledger.repository';
import {
  memoryConfigProvider,
  memoryEngineProvider,
  memoryEngineRawProvider,
  memoryProvisioningProvider,
} from './engines/memory-engine.factory';
import { MEMORY_ENGINE, type MemoryEngine } from './engines/memory-engine.interface';
import { MemoryAccessService } from './memory-access.service';
import { MemoryProjectService } from './memory-project.service';
import { MemoryFormationService } from './memory-formation.service';
import { MemoryRecallService } from './memory-recall.service';
import { MemoryCorrectionService } from './memory-correction.service';
import { MemoryViewsService } from './memory-views.service';
import { MEMORY_USAGE_CLOCK, MemoryUsageService } from './memory-usage.service';
import { MemoryUsageConcurrencyGate } from './memory-usage-concurrency.gate';
import { MemoryUsageNoStoreMiddleware } from './memory-usage-no-store.middleware';
// 阶段二：写路径"该提名了"提示的 provider（记忆项目绑定 × 裁决词命中）；
// **必须 export**——AppModule 的 `HINT_FACT_PROVIDERS` 工厂按 config/app-hint-provider-chain.ts
// 单源清单注入它，未导出 = 启动期 "Nest can't resolve dependencies"（见 memory.module.ts 文件头）
import { MemoryNominationHintProvider } from './memory-nomination-hint.provider';
import { MemoryController } from './memory.controller';
import { EngineHealthTracker } from './engine-health-tracker.service';
import { EngineHealthProbeService } from './engine-health-probe.service';
// ⚠️ **告警通道的依赖方向是单向的（且永久）**：MemoryModule → NotificationsModule。
// tracker 只调 `NotifyOrchestrator.sendSystemAlert()`；**notify 侧禁止依赖 memory 的任何
// provider**（反向一条边 = DI 环）。`ScheduleModule.forRoot()` **不在这里**：它已在
// attachment.module.ts 全局注册一次，重复注册 = 同一个 cron 被调度两次（探针翻倍）。
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * 引擎健康告警态（**五 token 闭集**，语义见 `engineHealthViewProvider` 的判定顺序）。
 *
 * ⚠️ 它是**告警态视图**，不是"引擎可用性"的判决：`degraded`（B 臂）可被任何登录用户诱发
 * （项目 403），**不得作为自动摘流/自动重启判据**；`disabled` 指纹可接受（引擎未配置）。
 */
export type EngineHealthStatus = 'disabled' | 'down' | 'degraded' | 'unknown' | 'up';

/**
 * 健康视图端口（只读；唯一实现 = 下方派生 provider）。
 *
 * 消费方 = `HealthController./health/ready` 的 `optional.memoryEngine`（可选注入：
 * 单测隔离时 view 不可用 ⇒ 该桶省略）。
 */
export interface EngineHealthView {
  /** 现算当前告警态（每次调用都读 tracker 快照，不缓存） */
  read(): EngineHealthStatus;
}

/**
 * `ENGINE_HEALTH_VIEW` 的注入 token。
 *
 * ⚠️ **字符串值不可改**：health 模块与单测按它注入替身。
 */
export const ENGINE_HEALTH_VIEW = 'ENGINE_HEALTH_VIEW';

/**
 * 引擎健康视图的派生只读 provider（token 与 provider 分开命名，照 `MEMORY_ENGINE` 先例）。
 *
 * 为什么用派生 provider 而不是给 tracker 加一个公开方法 + 直接导出 tracker：判定顺序里含
 * `engine == null`（配置态）与 `healthProbeEnabled`（配置态），把它们留在**装配层**可以让
 * tracker 只关心状态机；同时 exports 面只多一个窄 token（tracker 不导出）。
 *
 * 启动时打一行 INFO（`engine health view: engine=assembled|none probe=on|off`）——补上
 * 旧 Topic 自检行被删后"部署到底有没有健康视图"的可见性。
 */
export const engineHealthViewProvider: Provider = {
  provide: ENGINE_HEALTH_VIEW,
  inject: [MEMORY_ENGINE, EngineHealthTracker, MEMORY_CONFIG],
  useFactory: (
    engine: MemoryEngine | null,
    tracker: EngineHealthTracker,
    config: MemoryConfig,
  ): EngineHealthView => {
    // 启动可见性：装配期打一次（不随请求打）
    const logger = new Logger('EngineHealthView');
    logger.log(
      `engine health view: engine=${engine ? 'assembled' : 'none'} ` +
        `probe=${config.healthProbeEnabled ? 'on' : 'off'}`,
    );

    return {
      /** 判定顺序固定（改顺序 = 改语义，必须同步 health.controller.spec 的五态用例） */
      read: (): EngineHealthStatus => {
        // ① 引擎未装配：不是故障，是"这个部署没开 memory 引擎"
        if (!engine) return 'disabled';
        const snapshot = tracker.getHealthSnapshot();
        // ② A 臂告警 = 引擎/存储不可用（**唯一**产出 `down` 的臂）
        if (snapshot.availability.alerted) return 'down';
        // ③ B 臂告警 = 某个项目的绑定坏（引擎活着）⇒ 降级
        if (snapshot.auth.alerted) return 'degraded';
        // ④ 探针关闭：没有持续证据，只有业务流量计数 ⇒ unknown（不能凭"没告警"报 up）
        if (!config.healthProbeEnabled) return 'unknown';
        // ⑤ 启动首轮窗口：还没有一次成功探针 ⇒ 无证据不报 up
        if (snapshot.lastProbeOkAt === null) return 'unknown';
        // ⑥ 无未恢复告警 + 至少一轮探针成功
        return 'up';
      },
    };
  },
};

/**
 * Memory 模块（Hument 集成一期）。
 *
 * 定位：**可选增强** —— 未配置引擎时 Chamber 完全可用（本地端点照常，引擎动词 503）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // memory 自己的四张表
      MemoryProject,
      MemoryNomination,
      MemoryFormationEvent,
      MemoryRecallEvent,
      // 来源回取与冻结用到的内容实体（读路径的可见性判定在 MemoryAccessService，
      // 摘录正文的取用在 MemoryFormationService）
      Doc,
      DocSection,
      Message,
      Task,
      TaskComment,
      // 绑定解析用到的四个平台实体（见文件头不变量：PermissionModule 不导出它们的仓储）
      DocSpace,
      Topic,
      Board,
      BoardList,
      // 方法级 JwtOrApiKeyGuard 的 @InjectRepository(User) 从本模块解析（见文件头不变量）
      User,
    ]),
    // 引擎运行时告警的推送通道（tracker → NotifyOrchestrator；单向永久依赖，见上方注释）
    NotificationsModule,
  ],
  controllers: [MemoryController],
  providers: [
    // 权限内核（三处同源约束的唯一实现）
    MemoryAccessService,
    // 账本重放读取器（**不导出**：重放语义只在本模块内使用）
    MemoryLedgerRepository,
    // 四个业务服务（注册表 / 提名+形成账本 / 召回 / 更正编排）
    MemoryProjectService,
    MemoryFormationService,
    MemoryRecallService,
    MemoryCorrectionService,
    // 引擎投影读面（hument alpha.5 四读面；与 recall 解耦的独立服务）
    MemoryViewsService,
    // Usage 两读面（hument alpha.19）：并发闸是**进程内单例**（app-scoped）
    MemoryUsageService,
    MemoryUsageConcurrencyGate,
    // 默认时间窗时钟端口（生产 = 真实时钟；e2e 可 override 以证明「第二页不重算 now」）
    { provide: MEMORY_USAGE_CLOCK, useValue: () => new Date() },
    // 路径级 `Cache-Control: no-store` 中间件（只在 configure 的两条 usage 路由上挂载）
    MemoryUsageNoStoreMiddleware,
    // 阶段二：写路径"该提名了"提示的 provider（hint 拦截器按事实袋求值；
    // **必须在本模块 provide**——它的 Repository 依赖全部来自本模块 forFeature）
    MemoryNominationHintProvider,
    // 引擎运行时健康观测（卡 26c43f52）：双臂状态机（app-scoped 单例）+ 120s 探针
    EngineHealthTracker,
    EngineHealthProbeService,
    // 引擎健康查询面（卡 5e6cb000）：派生只读视图（导出给 health 模块）
    engineHealthViewProvider,
    // 引擎端口与配置（工厂定义；none ⇒ token 值为 null）
    // ⚠️ 双 token：`MEMORY_ENGINE_RAW` = 裸引擎（e2e override 点），`MEMORY_ENGINE` = 观测层包装
    memoryEngineRawProvider,
    memoryEngineProvider,
    memoryConfigProvider,
    // 自助开通客户端（工厂定义；未启用 / 缺 socket 路径 ⇒ token 值为 null）
    memoryProvisioningProvider,
  ],
  // 导出供同进程复用（web / platform-mcp 走 REST，不经 Nest DI）——模块惯例。
  // ⚠️ `MemoryNominationHintProvider` 的导出是**功能性**的（不是惯例）：AppModule 的
  // `HINT_FACT_PROVIDERS` 工厂（config/app-hint-provider-chain.ts 单源）按类引用注入它，
  // 撤销导出 = 启动期 DI 红（见文件头不变量）。
  // ⚠️ `ENGINE_HEALTH_VIEW` 同理：health 模块的 `optional.memoryEngine` 只认这个 token；
  // **tracker 刻意不导出**（消费方不需要它，面越窄越好）。
  exports: [
    MemoryProjectService,
    MemoryFormationService,
    MemoryRecallService,
    MemoryNominationHintProvider,
    ENGINE_HEALTH_VIEW,
  ],
})
export class MemoryModule implements NestModule {
  /**
   * Usage 两路由的 `Cache-Control: no-store`（见中间件文件头：必须 middleware，不能
   * interceptor/filter——guard 401 与 throttler 429 不经过 interceptor）。
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(MemoryUsageNoStoreMiddleware)
      .forRoutes(
        { path: 'memory/projects/:id/usage/summary', method: RequestMethod.GET },
        { path: 'memory/projects/:id/usage/trace', method: RequestMethod.GET },
      );
  }
}
