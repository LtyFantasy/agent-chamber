/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块（外部 IM 通知出口，一期）装配：投递记录仓储 + 事件编排器 +
 *     provider 抽象层（接口/工厂/叶子）。**普通 `@Module`**（一期无动态模块需求；见 [关键不变量]）。
 *
 * [代码职责]
 *   - `forFeature` 的实体清单（**漏一个 = 启动即崩**，见 [关键不变量]）
 *   - provider 定义展开：`notifyProviderListProvider`（`NOTIFY_PROVIDER_LIST` token）
 *   - controller 装配（S4）：`NotificationsController` 两个端点——`POST messages` 直发
 *     （`JwtOrApiKeyGuard`：agent 用 API Key、人类用 JWT）与 `GET deliveries` admin 只读列表
 *     （`JwtAuthGuard + RolesGuard + @Roles(ADMIN)`）；编排器另靠 `@OnEvent` 驱动，不需要 HTTP 面
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/architecture.md` §3.2.16（模块职责与装配）/ `docs/api-definition.md`
 *     §20（端点契约）/ `docs/spec.md` §3.2.33（数据层：forFeature 清单对应的表）
 *
 * [关键不变量]
 *   - **`forFeature` 必须覆盖编排器实际注入的每一个仓储**，一个不多一个不少：
 *     `NotificationDelivery`（投递记录，经 repository）+ `Task` / `Message` / `Topic` / `Doc`
 *     （渲染时回库取标题与摘要）+ `User`（播种归属解析 + 直发 creator 路由）+
 *     `TopicParticipant`（topic 参与判定）+ `Board` / `DocSpace`（**v2 归属**：渲染时取看板名 /
 *     空间名）+ `UserNotificationChannel`（**二期**：渠道绑定——播种 / 候选查询 / 零绑定锚点）。
 *     ⚠️ **漏注册的症状是"应用启动即崩"**（`Nest can't resolve dependencies ... "TaskRepository"`），
 *     不是请求期 500——因为编排器的依赖在 DI 容器构造时就要求解（先例 memory.module.ts 的
 *     血泪注释：`PermissionModule` 虽是 @Global 但**不导出仓储**，故本模块必须自持）。
 *   - **自持直查，不 import 他域模块**（依赖方向钉死，先例 `topic.module.ts`：TopicModule 直查
 *     Attachment 而不 import AttachmentsModule，避免 AttachmentsModule→TopicModule 反向依赖）。
 *     本模块只**读**他域的表（`Task` / `Message` / `Topic` / `Doc` / **`Board` / `DocSpace`**
 *     （v2 归属：看板名 / 空间名）/ `User` / `TopicParticipant`），不调用它们的 service——
 *     单向依赖，无环。
 *     ⚠️ 外部 provider 依赖只有 **`@Global()` 基建服务**（`ActorProfileService`——v2 归属的
 *     显示名解析，由 `CommonModule` 全局导出；**二期批 2**：`AccessQueryService`——权限剖面
 *     推导（`PermissionModule` @Global 导出，`BoardMember`/`DocSpaceMember` 由它内部查，
 *     不进本模块 forFeature）。"不 import 他域模块"约束的是**业务域模块**，基建不在此列——
 *     否则每个模块都要重复 import，正是 `CommonModule`/`PermissionModule` 要消灭的东西。
 *   - **不注册任何全局 provider**（无 APP_GUARD / APP_INTERCEPTOR / APP_FILTER）：鉴权与拦截器
 *     链归 AppModule，本模块只提供自己的能力面（memory.module.ts 同纪律）。
 *   - **`EventModule` 不 import**：`@OnEvent` 走 Nest 的全局 EventEmitter2（由 AppModule 的
 *     `EventEmitterModule.forRoot()` 提供，`@nestjs/event-emitter` 的 EventEmitter2 是可注入的
 *     **全局** provider）——import EventModule 只会把 `EventService` 拖进本模块依赖图（不需要）。
 *   - **编排器是 default-scope 单例**（Nest provider 缺省作用域）：内存态节流/缓存必须在整个进程
 *     内共享。⚠️ **禁止给 `NotifyOrchestrator` 加 `Scope.REQUEST`**——那会让每条消息一个新实例，
 *     节流窗口与 owner 缓存全部失效（且 `@OnEvent` 的订阅注册会变成 N 份）。
 *   - **provider 列表由工厂按配置装配**：`NOTIFY_PROVIDER_LIST` 的值是 `NotifyProvider[]`
 *     （可为空数组 = 无出口）；e2e 可用 `overrideProvider` 换成内存 fake 断言全链路。
 *   - **deliveryEligible 谓词单源**（Notifications 二期）：`enabled=true ∧ unbound_at IS NULL ∧
 *     last_test_status IN ('ok','seeded')`——**唯一实现 = `notification-channel-eligibility.ts`
 *     的 `deliveryEligibleWhere()`**，本模块四处复用：① 零绑定锚点计数（orchestrator 启动诊断）
 *     ② direct 无绑定预警 ③ **编排器候选查询**（批 2 已落地）④ 快照的渠道读取。
 *     ⚠️ **test 端点的前置闸刻意更宽**（m7）：它只排除 tombstone（`unbound_at IS NULL`）——
 *     验证动作必须允许"未验证"的地址发起，否则第一次验证永远做不到（自锁）。
 *     ⚠️ **禁止在任何地方手写第二份这个三元组**（漂移 = 有的路径认 `seeded`、有的不认 ⇒
 *     升级日静默漏投）。
 *   - **forFeature 清单在批 2 之后**仍是一期/二期那 11 个实体**一个不多一个不少**（编排器注入
 *     的仓储面没变）：权限判据（`AccessQueryService`）走 `@Global()` 的 `PermissionModule`
 *     ——它的 `BoardMember` / `DocSpaceMember` **不进本模块清单**（进了就是第二个仓储实例 +
 *     一份没人守的重复清单）。新增/删除注入点时 `notifications.module.spec.ts` 会双向报红。
 *   - **部署级出境总闸**（Notifications 二期）：`NOTIFY_PLATFORM_RATE_LIMIT` /
 *     `NOTIFY_PLATFORM_RATE_WINDOW_SECONDS`，唯一消费入口 = `NotifyOrchestrator.consumePlatformGate()`
 *     （全局一个窗口，与 per-user L2 是两种粒度）。**两条消费路径都已接线**：test 端点（批 1）
 *     与事件路径（批 2 棒 B）。超额丢弃的候选**计入各用户 L2 的 suppressed 分布**（摘要可见）
 *     ——而**摘要（digest）本身豁免总闸**（它是总闸丢弃的补偿信号）。
 *     ⚠️ **关系声明**：`platformRateLimit < perUserL2 × enabledBindings` 时总闸**先于** per-user
 *     L2 生效（N≥5 个活跃绑定用户即进入这个区间），per-user 摘要机制随之被架空——启动自洽
 *     WARN 会显式报出这条不等式（见 orchestrator 的 `runStartupDiagnostics`）。
 *   - **`notification_deliveries.recipient_user_id` 的四条写路径已全部贯通**（批 2 棒 B 收口）：
 *     编排器 deliver（→ `NotifyRecipient.userId`）/ L2 摘要（→ `L2Window.recipientUserId`）/
 *     直发（→ 调用 agent 的 `ownerId`）/ test 端点。存量行仍可能为 NULL——那是"**尚未归属**"
 *     而非"不属于任何人"（admin 的 `recipientUserId` 过滤刻意不命中 NULL 行）。
 *   - **直发的收件人 = 调用 agent 的 `ownerId`**（批 2 棒 B；不再是部署级单 Owner）：
 *     `NotifyOrchestrator.resolveDirectTarget()` 取该用户的**主投递渠道**，无
 *     `deliveryEligible` 绑定 ⇒ `recipient_not_bound`。故本模块**不再有任何"部署级收件人"**
 *     概念——`FEISHU_RECIPIENT_OPEN_ID` 只剩"D4 播种的地址来源"这一个身份。
 *   - **设置面单向依赖编排器**：`NotificationSettingsService` → `NotifyOrchestrator`（复用 provider
 *     兜底 / 总闸 / 配置），**反向禁止**（编排器不认识设置服务）。
 *     写路径与本编排器的**唯一耦合面 = 两个幂等的失效动作**：`invalidateUser(userId)`（渠道
 *     upsert / 渠道解绑 / prefs PUT / prefs DELETE / 渠道测试 五个调用点）与
 *     `invalidateTopic(topicId)`（`AGENT_JOINED`/`AGENT_LEFT` 事件钩子一个调用点）。
 *     ⚠️ **`invalidateUser` 必须连在途重建一起摘牌**（MAJOR-1 之后的行为）：只删缓存键会漏掉
 *     "重建在途 → 用户解绑 → 摘了个不存在的键 → 重建落地把**写前**快照写回并留 60-70s"
 *     这条时序。⚠️ **残留（显式接受）**：写路径的 DB 提交与内存摘牌之间没有可跨越的事务边界
 *     ⇒ 正在处理的那一次路由仍可能读到写前事实（一次事件的窗口，不是 60s）；关掉的是"陈旧值
 *     被缓存"那一半。要消掉这一半得把缓存与写路径放进同一个事务/失效通道，与"单实例内存缓存"
 *     的前提冲突。
 *
 * [关联代码]
 *   - notify-orchestrator.service.ts — 事件编排器（本模块的核心，见其文件头七段管线）
 *   - notifications.controller.ts — HTTP 面（S4：直发 + admin 只读列表）
 *   - notify-direct.service.ts — 直发链路（S4：幂等 / 入口节流 / 信封）
 *   - notifications-provider.factory.ts — provider 列表工厂（本模块展开它的 provider 定义）
 *   - notify-delivery.repository.ts — 投递记录唯一读写入口
 *   - notify-provider.interface.ts / feishu.notify-provider.ts — 出口端口与一期唯一实现
 *   - notifications.constants.ts — 分页缺省 / 直发预算 / 信封 reason 值域单源
 *   - ../../database/entities/index.ts — 实体 barrel（glob 自动加载面；本模块 import 具体实体文件）
 *   - ../../app.module.ts — 本模块的注册点（imports 追加）
 *
 * [持久踩坑]
 *   NOTIFY-FORFEATURE-MISSING(仓储漏注册): 编排器注入 9 个仓储，漏一个 = **启动即崩**
 *     （不是请求期 500）；而单测/e2e 若直接 new 出编排器就完全查不出。安全方向: 本清单与
 *     编排器构造函数的 `@InjectRepository` 逐项对齐（改一处必改两处；module.spec.ts 用
 *     Nest 元数据做双向对账，本文件不维护第三份手写清单）。
 *
 * [铁律关联] #11(注释强制) #12(跨模块先扫描)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 编排器新增 `@InjectRepository` 必须同步本文件 `forFeature`（否则启动即崩）
 *   □ 新增 provider 叶子必须同步工厂分派 + config 值域（两份 spec 的矩阵断言会红）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationDelivery } from '../../database/entities/notification-delivery.entity';
import { Agent } from '../../database/entities/agent.entity';
import { Board } from '../../database/entities/board.entity';
import { Doc } from '../../database/entities/doc.entity';
import { DocSpace } from '../../database/entities/doc-space.entity';
import { Message } from '../../database/entities/message.entity';
import { Task } from '../../database/entities/task.entity';
import { Topic } from '../../database/entities/topic.entity';
import { TopicParticipant } from '../../database/entities/topic-participant.entity';
import { User } from '../../database/entities/user.entity';
import { UserNotificationChannel } from '../../database/entities/user-notification-channel.entity';
import { notifyProviderListProvider } from './notifications-provider.factory';
import { NotifyDeliveryRepository } from './notify-delivery.repository';
import { NotifyDirectService } from './notify-direct.service';
import { NotifyOrchestrator } from './notify-orchestrator.service';
import { NotificationsController } from './notifications.controller';
import { NotificationSettingsController } from './notification-settings.controller';
import { NotificationSettingsService } from './notification-settings.service';

/**
 * Notifications 模块（外部 IM 通知出口，一期）。
 *
 * 定位：**可选出口** —— `NOTIFY_ENABLED=false`（缺省）时本模块一切静默（编排器 `onModuleInit`
 * 直接 return，不读库、不起定时器、不发通知），平台行为与没有这个模块完全一致。
 *
 * ⚠️ 模块必须存在（即使 HTTP 面被摘掉也无所谓），否则 `@OnEvent` 订阅不会注册
 * （编排器是"装配即订阅"）；HTTP 面只是 S4 加的两个入口。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // 投递记录（经 NotifyDeliveryRepository 写入；forFeature 供 repository 注入）
      NotificationDelivery,
      // 渲染时回库取标题/摘要的四个内容实体（见文件头不变量：自持直查，不 import 他域模块）
      Task,
      Message,
      Topic,
      Doc,
      // v2 归属：渲染时取「看板名」与「空间名」（`name` 列；只读，不 import Board/DocSpace 模块）
      Board,
      DocSpace,
      // 启动解析 owner username → actorId
      User,
      // topic 参与判定（owner 是否 active 参与者）
      TopicParticipant,
      // Notifications 二期：渠道绑定（D4 播种 / 零绑定锚点计数 / 批 2 候选查询）
      UserNotificationChannel,
      // Notifications 二期：agent creator 的 direct 无绑定预警（agents.owner_id）
      Agent,
    ]),
  ],
  // S4 + 二期设置面：三个 controller —— POST messages（直发，JwtOrApiKeyGuard）+
  // GET deliveries（admin 只读）+ notification-settings 六端点（JWT 人类，类级守卫）。
  // ⚠️ 守卫仍按方法/类各自声明（消费方不同），不要提升成统一类级
  controllers: [NotificationsController, NotificationSettingsController],
  providers: [
    // 投递记录唯一读写入口（永不抛，见其文件头）
    NotifyDeliveryRepository,
    // 事件编排器（default-scope 单例——节流窗口与缓存必须进程内共享，见文件头不变量）
    NotifyOrchestrator,
    // 直发链路（default-scope 单例——幂等表与入口窗口同样必须进程内共享）
    NotifyDirectService,
    // 二期：通知设置面（default-scope 单例——per-user 测试窗口必须进程内共享）。
    // 它注入 NotifyOrchestrator（复用 sendThroughProvider / consumePlatformGate / 配置解析），
    // **方向单向**：编排器不认识本服务（禁反向依赖，否则 DI 图成环）
    NotificationSettingsService,
    // provider 抽象层装配（NOTIFY_PROVIDER_LIST token；值为 NotifyProvider[]，可为空）
    notifyProviderListProvider,
  ],
  // 导出编排器与仓储：供同进程内的其他模块/后续批次复用
  // （不导出 provider 列表——它是本模块的内部装配细节；controller/service 只在本模块内用）
  exports: [NotifyOrchestrator, NotifyDeliveryRepository],
})
export class NotificationsModule {}
