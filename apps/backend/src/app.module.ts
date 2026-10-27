/**
 * =============================================================================
 * AGENT-HOOK | 修改本文件前必读
 * =============================================================================
 * [设计文档]
 *   - 主文档: docs/architecture.md §3.1 (整体架构)
 *   - 发行边界: 线上 docs/integrations/oss-dual-repo.md §11 (Memory 临时关闭与恢复)
 * [关键不变量]
 *   - Memory 的 App/Health 模块、配置工厂与 hint DI 链必须共用 MEMORY_FEATURE_ENABLED；
 *     只删本模块注册会被 HealthModule 重开，或因 hint 依赖缺席而启动失败。
 *
 * [踩坑索引] D5(PermissionModule注册) D6(ConfigModule.load漏挂namespace) GUARD-ORDER(APP_GUARD位次)
 *
 * [铁律关联] #4(文档优先)
 *
 * [详细踩坑]（最多 5 条）
 *   D5: PermissionModule 为 @Global() 模块，导入 AppModule 后全局可用。
 *       各 Feature Module 无需重复导入 PermissionModule 即可注入 PermissionService。
 *       见 memory/2026-06-05.md
 *   D6: `registerAs('xxx')` 只在**本文件 load 数组**挂载后才可被 `config.get('xxx')` 读到；
 *       漏挂不会报错——消费方落兜底 + 工厂 warn 文案与 env 原值自相矛盾
 *       （2026-10-07 memory PoC 冒烟实证：MEMORY_ENGINE=hument 被判 none，
 *       单测/e2e 全部内联 ConfigModule 无一拦下）。回归守卫 = src/app.module.spec.ts。
 *   GUARD-ORDER: APP_GUARD 数组**顺序即执行顺序**，且它排在所有控制器级 `@UseGuards`
 *       之前。`ApiKeyScopeGuard` 依赖 `JwtAuthGuard` 的 X-API-Key 分支先装配
 *       `request.agent`——把它挪到 JwtAuthGuard 之前 = 守卫恒直通（静默失效，现有测试
 *       全绿也发现不了）。同类：新增读 `request.user`/`request.agent` 的全局守卫，
 *       位次一律紧跟在对应装配者之后。见 2026-10-16 卡 72566c2e。
 *       **ThrottlerGuard 也吃这条**（2026-10-17 F4 项3 复审 MAJOR-2）：其 `actor` 桶的
 *       tracker 读 `request.agent` / `request.user`（common/utils/throttler-trackers.ts），
 *       故位次必须仍在 JwtAuthGuard 之后——**倒退 = actor 桶静默退化为 IP 桶**
 *       （automcp 双实例共享配额，30/min/IP），且单测/e2e 全绿（它们不 boot AppModule）。
 *       护栏 = memory-recall-throttle.spec 的 APP_GUARD 位次断言（结构提取，非文本包含）。
 *
 * [修改检查]
 *   □ 已读 [设计文档] 确认修改符合设计意图
 *   □ 如果设计文档已过时，同步更新文档（铁律 #12）
 *   □ 修复 Bug 见 change-checklists.md §8
 * =============================================================================
 */
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { MEMORY_FEATURE_ENABLED } from '@agent-chamber/shared';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { RequestIdMiddleware } from './common/interceptors/request-id.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { ApiKeyScopeGuard } from './common/guards/api-key-scope.guard';
import { PermissionModule } from './common/permission.module';
import { CommonModule } from './common/common.module';

// ConfigModule.load 单源清单（D6：禁止回退为内联数组 + 各自 import，见 ./config/app-config-loads.ts 文件头）
import { APP_CONFIG_LOADS } from './config/app-config-loads';
// 全局拦截器链序单源（同款「清单 + 守卫」模式；链序不变量见该文件头）
import { APP_INTERCEPTOR_CHAIN } from './config/app-interceptor-chain';
// hint 事实求值器链单源（同款「清单 + 守卫」模式）：本文件据此聚合 HINT_FACT_PROVIDERS——
// HintsModule 的 `useValue: []` 只是 standalone / 测试缺省，生产由下面的 useFactory 遮蔽；
// 观察期 kill switch（HINT_PROVIDERS_DISABLED）经 resolveHintProviderChain 纯函数过滤
import {
  applyHintProviderKillSwitch,
  HINT_FACT_PROVIDER_CHAIN,
} from './config/app-hint-provider-chain';

import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { AgentModule } from './modules/agent/agent.module';
import { TopicModule } from './modules/topic/topic.module';
import { BoardModule } from './modules/board/board.module';
import { DocSpaceModule } from './modules/docspace/docspace.module';
import { TaskModule } from './modules/task/task.module';
import { EventModule } from './modules/event/event.module';
import { SseModule } from './modules/sse/sse.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AvatarModule } from './modules/avatars/avatar.module';
import { SkillModule } from './modules/skill/skill.module';
import { AuditModule } from './modules/audit/audit.module';
import { SearchModule } from './modules/search/search.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { RoundtableModule } from './modules/roundtable/roundtable.module';
import { DownloadsModule } from './modules/downloads/downloads.module';
import { AttachmentModule } from './modules/attachments/attachment.module';
import { HealthModule } from './health/health.module';
import { UsageStatsModule } from './modules/usage-stats/usage-stats.module';
import { ExperienceModule } from './modules/experience/experience.module';
// Memory 模块（Hument 集成一期；**可选增强**：未配 MEMORY_ENGINE 时引擎动词 503、本地端点照常）
import { MemoryModule } from './modules/memory/memory.module';
// Notifications 模块（外部 IM 通知出口，一期；**可选出口**：NOTIFY_ENABLED=false 缺省时
// 编排器 onModuleInit 直接 return，不读库、不起定时器、不发通知）。
// ⚠️ 本期无 controller：模块存在的意义是**注册 @OnEvent('event.created') 订阅**（S4 才挂端点）
import { NotificationsModule } from './modules/notifications/notifications.module';
// hint 基建（阶段一抽核）：@Global 提供去重窗口单例 + code 元数据注册表；
// HintInterceptor 的注册位次由 config/app-interceptor-chain.ts 单源给出（必须排在
// ResponseInterceptor 之后——它读的是业务载荷，不是已包装的信封）
import { HintsModule } from './modules/hints/hints.module';
// hint 事实求值器注入 token（**值导入**：Symbol 是运行期值，没有 import type 形态）
import { HINT_FACT_PROVIDERS } from './modules/hints/hint.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // app.config 已删除（review-0831 任务 e013af33：apiPrefix/port 死配置零消费，
      // 端口由 main.ts process.env.PORT 直读，前缀由 shared API_PREFIX 单源）
      // load 清单单源 = config/app-config-loads.ts（D6 踩坑：内联清单曾漏挂 memoryConfig，
      // 引擎静默落 none；守卫 = src/app.module.spec.ts）
      load: APP_CONFIG_LOADS,
    }),
    // 事件总线（M1 圆桌计划决策 2）：@nestjs/event-emitter forRoot() 默认 global: true，
    // 注册一次全模块可注入 EventEmitter2。EventService.create() 末尾 emit('event.created')，
    // 12 个事件写入方零改动；roundtable 模块用 @OnEvent('event.created') 订阅。
    EventEmitterModule.forRoot(),
    // 连接选项由 database/typeorm-options.ts 的工厂单点提供（**禁止在此写内联选项对象**：
    // 两份选项必然漂移，而这一份是生产运行时唯一事实源）。工厂化是为了让「连接级会话
    // 默认值 extra 确实被装配」成为可单测断言的事实——见 typeorm-options.spec.ts。
    TypeOrmModule.forRoot(buildTypeOrmOptions()),
    // A6 登录限流（@nestjs/throttler，内存存储，单实例生产足够）。
    // v2 收窄决策：全局默认不设有效限流（limit 极大 = 实际关闭），避免误伤
    // events/poll 游标轮询、SSE 长连接、platform-mcp 编排（一次语义调用 = 多次 REST）
    // 等高频路径；仅 auth.controller 的 login/register 用 @Throttle 收紧（见该文件常量）。
    // ttl 单位为毫秒（@nestjs/throttler v5 API）。
    //
    // `actor` 命名桶（F4 项3，2026-10-17）：**声明这里是必需的，不是预留**。ThrottlerGuard
    // 在 onModuleInit 里只把**本数组声明的桶**装进 `this.throttlers` 并逐个迭代
    // （throttler.guard.js onModuleInit + canActivate 的 `for (const namedThrottler of this.throttlers)`），
    // 所以不在此声明，路由上的 `@Throttle({ actor: … })` 只会写入一段**永不被读的元数据**
    // ——守卫照跑，限流静默不存在。
    //
    // 惰性的只是 limit 值，**不是执行**：命名桶对**全部端点**每请求多做一次
    // increment + 一次定时器（handleRequest 无条件跑，与路由是否标了 actor 桶无关）——
    // 生产 <100rps 的量级下可接受（S-N5/A-C4）。将来若某热点路径被这层开销咬到，
    // **逃生口 = 给本条目加 skipIf 闸门**（按 context 短路该桶），不要去改守卫。
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: parseInt(process.env.THROTTLE_GLOBAL_LIMIT || '100000', 10),
      },
      { name: 'actor', ttl: 60_000, limit: 100_000 },
    ]),
    PermissionModule,
    CommonModule,
    AuthModule,
    UserModule,
    AgentModule,
    TopicModule,
    BoardModule,
    DocSpaceModule,
    TaskModule,
    EventModule,
    SseModule,
    DashboardModule,
    AvatarModule,
    SkillModule,
    AuditModule,
    SearchModule,
    WebhookModule,
    MonitoringModule,
    // 圆桌模式（M1 计划阶段 3）：WS 控制面（/ws/runner）+ runner 注册表 + 座位管理
    // REST + 注入管线（@OnEvent('event.created') 触发，见 roundtable.service.ts）
    RoundtableModule,
    // 下载分发（M1「最后一公里」P2）：公开提供 install-runner.sh / runner bundle / 对接指南，
    // 供 curl | bash 一键安装链路使用；无 DB 依赖、全 @Public()
    DownloadsModule,
    // MinIO 媒体附件（P0）：上传代理校验链 + 全鉴权读取 + 配额事务，
    // 见 modules/attachments/（plan wiccan-carnage-rocket）
    AttachmentModule,
    HealthModule,
    // 接口/MCP 调用频率统计（批 1 采集核心）：全局拦截器采集 REST 调用 →
    // 内存按 UTC 小时桶聚合 → 定期 flush 进 api_usage_stats_hourly
    // （plan rocket-batwoman-booster-gold；批 2 追加查询面与上报端点）
    UsageStatsModule,
    // 经验库（平台第四资源，批 2 后端）：8 端点 + 检索三路融合 + 反馈计数联动 +
    // 零命中埋点轻表；本批**不进**全局 /search、不发 events/SSE（plan §3 末段决策）
    ExperienceModule,
    // Memory 模块（Hument 集成一期）：12 端点；引擎是**可选增强**——
    // 未配引擎时本地数据端点 200、引擎动词 503（plan §3 引擎闸双组）
    // 发行门必须与 HealthModule/config/hint 同源，避免从健康检查重新装配 Memory。
    // 关闭模式不注册控制器或后台服务；机制见 docs/integrations/oss-dual-repo.md §11。
    ...(MEMORY_FEATURE_ENABLED ? [MemoryModule] : []),
    // hint 基建（阶段一抽核）：@Global——去重窗口单例 + 注册表 + 事实袋拦截器；
    // 阶段一无 provider（事实袋恒空）⇒ HintInterceptor 为全局直通，行为零变化
    HintsModule,
    // 通知出口（一期）：事件链路编排器（@OnEvent('event.created')）+ provider 抽象层 +
    // 投递记录写入口。**可选出口**——NOTIFY_ENABLED=false（缺省）时编排器 onModuleInit 直接
    // return（不读库、不起定时器、不发通知），平台行为与没有这个模块一致。
    // 本期**无 controller**：模块存在的意义是注册事件订阅（两端点属 S4，plan §8）
    NotificationsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    // 全局拦截器链：顺序 = 单源常量（不变量见 config/app-interceptor-chain.ts 文件头——
    // ResponseInterceptor 必须最外层，读业务载荷的 HintInterceptor 必须排在它之后）。
    // ⚠️ 本数组的位次只承诺 AppModule 内这几条的相对次序；**被 import 的模块**注册的
    // 全局拦截器（如 UsageStatsModule 的 UsageStatsInterceptor）会排在它们**之后**
    // （更内层）——需要更内层语义时不要靠「挪到本数组末尾」实现。
    ...APP_INTERCEPTOR_CHAIN.map((useClass) => ({ provide: APP_INTERCEPTOR, useClass })),
    {
      // hint 事实求值器链（阶段二落地 / 阶段三加 kill switch）：**在此覆盖 HintsModule 的
      // `useValue: []` 缺省**（Nest 语义：模块自有 provider 优先于被 import 模块的同名
      // token；HintsModule 是 @Global 也逃不过这条）。链序与成员的**单源在
      // config/app-hint-provider-chain.ts**：`inject` 机械展开**全集**（DI 只解析已被
      // 模块装配的实例，无法按 env 少注入），筛选发生在 factory 内——观察期 kill switch
      // `HINT_PROVIDERS_DISABLED`（逗号分隔的**稳定键**，如 `task_hygiene`）经纯函数
      // `resolveHintProviderChain` 解析。
      // ⚠️ 与阶段二的口径差别：这里**不再「不排序不筛选」**——筛选是刻意加的（关掉某
      // provider 族的逃生通道）；**仍不排序**（顺序单源 = 清单数组序）。
      provide: HINT_FACT_PROVIDERS,
      useFactory: (...providers: unknown[]) =>
        // 胶水抽成具名纯函数（config/app-hint-provider-chain.ts）：匿名工厂不可断言，
        // 而「kill switch 真的把实例滤掉了」必须可证（守卫 = 该文件的 spec）
        applyHintProviderKillSwitch(providers, process.env.HINT_PROVIDERS_DISABLED),
      inject: [...HINT_FACT_PROVIDER_CHAIN],
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      // API Key scopes 执行面（2026-10-16 卡 72566c2e）：**位次必须在 JwtAuthGuard 之后**
      // ——本守卫读 `request.agent`，而该字段由上一守卫的 X-API-Key 分支装配；颠倒位次
      // 等于守卫恒直通（静默失效，且现有测试全绿也发现不了）。
      // 判定逻辑单源 = common/utils/api-key-scope.ts（HTTP 与 WS 握手共用）；
      // 豁免面被 config/agent-scope-exemptions.ts 的清单 + 同名 spec 双向相等断言钉死。
      provide: APP_GUARD,
      useClass: ApiKeyScopeGuard,
    },
    {
      // 全局限流 Guard：配合上方 ThrottlerModule 的极宽松默认值，实际只对
      // 显式标注 @Throttle 的端点（auth login/register、memory recall）生效。
      // ⚠️ **位次不可前移**：`actor` 命名桶（F4 项3）的 tracker 读 `request.agent` /
      // `request.user`，两者由 JwtAuthGuard 装配——挪到它之前 = 身份维失效、actor 桶
      // 静默退化成 IP 桶（护栏见 memory-recall-throttle.spec 的 APP_GUARD 位次断言）。
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
