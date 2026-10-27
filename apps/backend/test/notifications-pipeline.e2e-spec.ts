/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 一期 S6 **事件 → 投递贯通** 的端到端契约：真实事件（真 `EventService.create`
 *     经真 `TaskService` 业务路径发出 / 直接发原始事件）→ 真 `NotifyOrchestrator` 六段管线 →
 *     **内存 fake provider 出口**断言 → 终态落库核对。
 *
 * [代码职责]
 *   - 钉死事件链路每一段的**行为面**（不是"函数被调了"，而是"这一条到底有没有出境"）：
 *     类别开关（开/关两侧）、`task_done` 跃迁判据、L1 per-resource、L2 全局闸 + 摘要合并、
 *     自回声、topic 参与（active 过滤 + system 短路）、`task_assigned` 两入口（assign/PATCH）、
 *     `doc_updated` 纯重切短路
 *   - 钉死**终态落库**（`notification_deliveries` 行 status/attempts/category/event_id）与
 *     **抑制类不落表**（自回声 / 类别关 / L1 / L2 命中在数据面无行 —— 这是 admin 列表文档
 *     写明的边界，本套件是它的行为守卫）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §8 S6（e2e 贯通清单）/
 *     §5 类别→事件映射表 / §9 测试契约 / §10 验收标准（dev 实测逐条）
 *
 * [关键不变量]（改动断言前先想清楚在防什么）
 *   - **`@OnEvent(..., {async:true})` 走 setImmediate**：`await eventService.create()` 返回时
 *     **投递还没发生**。正向断言必须 `waitFor(...)` 轮询、负向断言必须 `settle()` 等够
 *     （抑制类走的是"无 DB 查询的早退"，ms 级完成；300ms 是宽松上界）。**禁止写完就断言**。
 *   - **L1 键 = `<资源分量>:<userId>`，不含类别**（`task:<id>:<uid>` / `topic:<id>:<uid>` /
 *     `doc:<id>:<uid>`）⇒ 同一资源的不同类别共用一个窗口、**但每个人各有各的**（批 2 棒 B）。
 *     前者决定 `PATCH {assigneeId}` 的断言写法：`update()` 会**同发** `TASK_UPDATE` +
 *     `TASK_ASSIGNED`，两条同键 ⇒ 只第一条放行；要确定性地看到 `[指派]`，必须把
 *     `task_updated` 类别临时关掉（关掉的类别在 L1 **之前**早退，不占窗口）。
 *     后者决定**多用户用例的可行性**：⑯ 靠"两个人各收一条"来证明窗口没被互相压制。
 *   - **L2 是 per-user（键 = `userId`，批 2 棒 B）记账、且窗口是进程内内存态**：
 *     `beforeEach` 必须清 `l2Windows`（否则用例互相吃额度）。⚠️ 任何**探针/断言**要用新键
 *     （`ownerActorId` 而不是投递地址）——用旧键取不到窗口的表现是**超时**而不是断言失败。
 *   - **L1 / topic 参与缓存同款**：`beforeEach` 清 `l1` / `topicParticipation`，否则前一个用例
 *     的同资源窗口会压掉后一个用例。
 *   - **`settings` 是编排器构造期的快照**：类别白名单 / L2 条数只能靠**测试内临时改写**
 *     `settings`（`withSettings`）覆盖"开关两侧"，改回在 `finally`。这仍是真配置闸
 *     （`settings.categories.includes(...)` 是生产同一行代码），不是绕过。
 *     ⚠️ **临时改写的作用域必须覆盖"全部事件都处理完"**：`withSettings` 的 `finally` 一还原，
 *     还没跑到的 handler 就会按**新配置**判。只等"摘要出现"是不够的（摘要在第 3 条就 flush，
 *     第 4 条可能还在 setImmediate 队列里）——⑥ 用 `waitForState` 做显式屏障（见其注释）。
 *   - **二期批 2 起，"该谁收"来自 per-user 绑定，不再是 `FEISHU_RECIPIENT_OPEN_ID` 单值**：
 *     本套件靠 D4 播种（`feishuAppId`/`Secret`/`recipientOpenId` 三件套齐 ⇒ 启动时给唯一
 *     OWNER 落一条 `env_seed` 绑定）把收件人"造"出来——**这同时就是升级日的生产路径**。
 *     不给凭据 ⇒ 播种静默跳过 ⇒ 零候选 ⇒ 所有正向用例齐刷刷"没投递"。
 *   - **owner 的类别偏好必须显式全开**：用户缺省是 `DEFAULT_NOTIFY_CATEGORIES`（只含
 *     `task_done` + `direct`），本套件要覆盖 topic/doc/task_updated ⇒ 不打开就全被偏好层拦掉，
 *     症状与"路由坏了"一模一样。
 *   - **任务类用例的操作者必须是 `foreignAgentId`（别人名下的人），不是本套件的 agent**
 *     （二期批 2 的 per-candidate 自回声：`event.actorId ∈ 我的 agents` ⇒ 不通知我）。
 *   - **provider 调用与台账写入是两步**：`waitFor(sentFor(...))` 只等到第一步，读
 *     `notification_deliveries` 必须用 `waitForDeliveryRows()` 轮询（否则高负载下偶发读到
 *     未提交的 INSERT）。
 *   - **topic 参与判定的口径 = `topic_participants.status='active'`**：`invited` / `left`
 *     都不算参与。⚠️ `topic_participants` 有 DB CHECK `(status != 'active' OR joined_at IS NOT NULL)`
 *     ⇒ 造 active 行**必须**同时给 `joinedAt`。
 *   - **`doc_deleted` 渲染不查库**（行已软删，只信事件载荷）；其余 doc 类别渲染回库取 path/title
 *     ⇒ 造行是前提（资源缺失 = 幻影事件，渲染返回 null、**连 L2 额度都不占**）。
 *   - **v2 起正文明细含归属信息**（task = `看板「…」 · <操作者>`（指派类追 `→ 指派给 …`）；
 *     topic = `<发言人>：<摘要>`；doc = `空间「…」 · <标题>`）⇒ 断言必须造出**真看板 / 真空间 /
 *     真 actor 行**，否则拿到的是兜底 `?`（这正是"降级不丢弃"的可见形态）。
 *   - **正文宽度分三层**（见 orchestrator 的 [关键不变量]）：topic **100**（预览语义）、
 *     task / doc **200**（归属是消息本体，截尾 = 通知失去意义）、direct 2000。
 *     ⇒ 本套件的 task / doc 断言可以钉**整串**（fixture 约 100~160 字符落在 200 内），
 *     topic 断言则只有 100 可用。
 *   - **零出口不落表**：`providers.length === 0` 时 `deliver()` 直接丢弃 + INFO，**不写投递行**
 *     （"投递行 = 尝试过一次"的语义）。本套件 fake 恰好一个出口，故每一条放行 = 一行记录。
 *
 * [关联代码]
 *   - test/notifications.e2e-spec.ts — S4 端点级 e2e（直发 / admin 列表；本文件补事件链路）
 *   - test/notifications-schema.e2e-spec.ts — 同批次的表结构门禁（本文件负责行为面，它负责列面）
 *   - src/modules/notifications/notify-orchestrator.service.ts — 被测管线（六段）
 *   - src/modules/notifications/notify-direct.service.ts — 直发链路（不在本文件射程内）
 *   - src/modules/task/task.service.ts — `assign()` / `update()` 的 `TASK_ASSIGNED` + 跃迁载荷挂点
 *   - test/task-hygiene-hint.e2e-spec.ts — 本文件的装配模板（真 PG + 真 HTTP + 真守卫 + TaskModule）
 *
 * [持久踩坑]
 *   NOTIFY-PIPE-E2E-ASYNC(写完就断言): 见上"setImmediate"条——这是本文件最容易写错的一点，
 *     错了的表现是**间歇性红**（本地快、CI 慢），而不是稳定失败。
 *   NOTIFY-PIPE-E2E-L1-CROSS(跨用例 L1 污染): L1 窗口 300/600s，远长于一次测试运行 ⇒
 *     不复位内存态会让"第二个用例莫名不投"。安全方向: beforeEach 清三个内存态。
 *   NOTIFY-PIPE-E2E-DIGEST-N(摘要条数与直觉不符): L2 摘要在**第一个超额的投递尝试**上触发，
 *     此刻被压制的计数只有 1（后续超额只记账、不重发摘要，窗口内 ≤1 条）⇒ 发 4 条 + 额度 2
 *     得到的是"2 条 + 摘要说另有 1 条"，**不是 1 条**。这是实现语义，不是 bug。
 *
 * [铁律关联] #17(测试契约) #18(不变量检查) #23(jsonb/真库行为)
 * =============================================================================
 */

/**
 * Notifications 一期 S6 —— 事件 → 投递贯通的端到端契约（真实 PG + 真实 HTTP + 真实编排器）。
 *
 * 为什么必须打真库 + 真 HTTP（而不是 mock 链）：
 *   - 编排器的判据长在**库内事实**上——topic 参与（`topic_participants` 的 status）、渲染回库
 *     （task/doc/topic/message 行）、跃迁载荷（业务路径真的写进了 `fromStatus/toStatus`）。
 *     mock 仓储只能证明"查询被发出去了"，证明"真库真的过滤/取到了"只有真 PG 能给出。
 *   - `task_assigned` 两入口（POST /tasks/:id/assign 与 PATCH {assigneeId}）是 S1 的**业务写
 *     路径改动**，只有走真端点才能证明事件真的发了（伪造事件测试不到 S1）。
 *
 * 出口用内存 fake（**不联网**）：`NOTIFY_PROVIDER_LIST` 整体替换，记录出境面并返回可控终态。
 * 真实飞书叶子的 HTTP 行为由 `feishu.notify-provider.spec.ts`（mock fetch）覆盖。
 *
 * 环境：本地开发库 chamber-postgres（8744），PG 不可达时整套降级跳过；清理**按
 * `recipient = RECIPIENT` 精确删投递行**（RECIPIENT 带 RUN 后缀且是本套件唯一收件人 ⇒ 摘要行
 * 也覆盖得到——摘要正文里没有任何 RUN 文本，靠正文特征删不掉）。
 */
import { Global, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import request = require('supertest');
import {
  API_PREFIX,
  ActorType,
  AgentStatus,
  EventType,
  MessageType,
  ParticipantStatus,
  ResourceType,
  TaskStatus,
  TopicStatus,
  UserRole,
} from '@agent-chamber/shared';
import { SnakeNamingStrategy } from '../src/database/snake-naming.strategy';
import * as entities from '../src/database/entities';
import { Actor } from '../src/database/entities/actor.entity';
import { Agent } from '../src/database/entities/agent.entity';
import { ApiKey } from '../src/database/entities/api-key.entity';
import { Board } from '../src/database/entities/board.entity';
import { BoardList } from '../src/database/entities/board-list.entity';
import { BoardMember } from '../src/database/entities/board-member.entity';
import { Doc } from '../src/database/entities/doc.entity';
import { DocSpace } from '../src/database/entities/doc-space.entity';
import { Message } from '../src/database/entities/message.entity';
import { Task } from '../src/database/entities/task.entity';
import { Topic } from '../src/database/entities/topic.entity';
import { TopicParticipant } from '../src/database/entities/topic-participant.entity';
import { User } from '../src/database/entities/user.entity';
import { DIGEST_DELIVERY_CATEGORY } from '../src/database/entities/notification-delivery.entity';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { ApiKeyAuthService } from '../src/common/services/api-key-auth.service';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { JwtOrApiKeyGuard } from '../src/common/guards/jwt-or-api-key.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { CommonModule } from '../src/common/common.module';
import { PermissionModule } from '../src/common/permission.module';
import { TaskModule } from '../src/modules/task/task.module';
import { HintsModule } from '../src/modules/hints/hints.module';
import { EventService } from '../src/modules/event/event.service';
import { NotificationsModule } from '../src/modules/notifications/notifications.module';
import { NotifyOrchestrator } from '../src/modules/notifications/notify-orchestrator.service';
import {
  NOTIFICATIONS_CONFIG_FALLBACK,
  NOTIFY_CATEGORY,
  NOTIFY_CATEGORIES,
  type NotifyCategory,
  type NotificationsConfig,
} from '../src/config/notifications.config';
import {
  NOTIFY_PROVIDER_LIST,
  type DeliveryOutcome,
  type NotifyProvider,
  type RenderedNotification,
} from '../src/modules/notifications/notify-provider.interface';

/** 本地开发库连接（与既有真 PG 套件的 TEST_DB_* 覆盖约定一致） */
const DB_CONFIG = {
  host: process.env.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 8744),
  username: process.env.TEST_DB_USERNAME ?? 'chamber',
  password: process.env.TEST_DB_PASSWORD ?? 'chamber_password',
  database: process.env.TEST_DB_DATABASE ?? 'agent_chamber',
};

/** 本套件自用 JWT 密钥（不读 env，避免污染同 worker 内其他套件） */
const JWT_SECRET = 'notifications-pipeline-e2e-secret';

/** 本次运行的唯一后缀（隔离数据：username / 标题 / 收件人互不串味） */
const RUN = `ntfp-${Date.now().toString(36)}`;

/** owner 的平台 username（写进配置 ⇒ 编排器启动时解析成 actorId，自回声与 topic 参与才生效） */
const OWNER_USERNAME = `ntfpowner${RUN}`.slice(0, 50);

/** 收件人 open_id（fake 出口只用它当 L2 窗口维度，不发任何真实请求；RUN 后缀让清理可精确定位） */
const RECIPIENT = `ou_${RUN}`;

/**
 * **第二个候选用户**的收件地址（Notifications 二期批 2 的多用户端到端用；同样带 RUN 后缀）。
 *
 * 为什么需要第二个人：本棒把节流与投递从"部署级单 Owner"泛化成 per-user——"各收各的"这件事
 * 单用户套件**在结构上就证明不了**（只有一个收件人时，键里带不带 userId 看起来一模一样）。
 */
const SECOND_RECIPIENT = `ou_second_${RUN}`;

/** 深链基址（渲染层单源：所有 link 都由它拼接） */
const WEB_BASE = 'https://platform.example.com';

/**
 * 测试用 notifications 配置（经 ConfigModule.load 注入，`config.get('notifications')` 可取）。
 *
 * ⚠️ `categories` 全开：本套件的**主语是"某条事件该不该出境"**，先把类别闸全开，让
 * "跃迁判据 / L1 / L2 / 自回声"各自成为**唯一的**拦截理由；类别开关本身由专门的用例
 * （临时改写 `settings.categories`）覆盖两侧。
 *
 * ⚠️ `globalRateLimit: 50`：L2 是 per-recipient 记账，本套件所有事件都发往同一个 `RECIPIENT`——
 * 留足够余量让"与 L2 无关"的用例不必操心额度；L2 用例自己在 `withSettings` 里收到 2。
 */
const NOTIFY_TEST_CONFIG: NotificationsConfig = {
  ...NOTIFICATIONS_CONFIG_FALLBACK,
  enabled: true,
  categories: [...NOTIFY_CATEGORIES],
  providers: ['feishu'],
  feishuRecipientOpenId: RECIPIENT,
  webBaseUrl: WEB_BASE,
  ownerUsernames: [OWNER_USERNAME],
  // ⚠️ **二期批 2 起这两把"假凭据"是必需的**：收件人不再取自 `FEISHU_RECIPIENT_OPEN_ID`，
  // 而是取"有 deliveryEligible 绑定的用户"——绑定由 D4 播种（`seedFromEnv`）落库，而播种的
  // 前提是 feishu 三键齐（appId / appSecret / recipientOpenId）。**给假值即可**（本套件的出口是
  // 内存 fake，不发任何真实请求，密钥只参与"能不能播种"这一个判据）；不给 ⇒ 播种静默跳过 ⇒
  // 零候选 ⇒ 整条事件链路一条都不投（症状是所有用例齐刷刷"没投递"）。
  // 这条路径正是**升级日的生产路径**（env_seed 行升级后立即恢复投递的回归门）。
  feishuAppId: 'cli_pipeline_e2e',
  feishuAppSecret: 'pipeline-e2e-secret',
  taskThrottleSeconds: 300,
  docThrottleSeconds: 600,
  topicThrottleSeconds: 600,
  globalRateLimit: 50,
  globalRateWindowSeconds: 600,
};

/** 成功终态（`deliveredAt` 由 fake 在每次发送时补齐） */
const SUCCESS_OUTCOME: DeliveryOutcome = {
  status: 'success',
  attempts: 1,
  responseStatus: 200,
  lastError: null,
  deliveredAt: null,
};

/**
 * 内存 fake 出口（**不联网**）：记录每次投递的出境面，返回可控终态。
 *
 * 与 S4 套件的 fake 同形——本套件只需要"出境面 + 是否出境"，不需要重试预算。
 */
const fakeProvider = {
  key: 'feishu',
  sent: [] as RenderedNotification[],
  async send(notification: RenderedNotification): Promise<DeliveryOutcome> {
    fakeProvider.sent.push(notification);
    return { ...SUCCESS_OUTCOME, deliveredAt: new Date() };
  },
  reset(): void {
    fakeProvider.sent = [];
  },
};

/**
 * 测试用认证模块（镜像生产 AuthModule 的 @Global() 形态：方法级 guard 在**声明它的模块**
 * 上下文实例化，其 @InjectRepository 依赖要从那里解析）。
 */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get('jwt.secret'),
        signOptions: { expiresIn: '2h' },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([User, ApiKey, Agent]),
  ],
  providers: [JwtStrategy, ApiKeyAuthService, JwtAuthGuard, JwtOrApiKeyGuard, RolesGuard],
  exports: [
    JwtModule,
    PassportModule,
    TypeOrmModule,
    ApiKeyAuthService,
    JwtAuthGuard,
    JwtOrApiKeyGuard,
    RolesGuard,
  ],
})
class PipelineE2eAuthModule {}

/**
 * 测试根模块：真库 + 真认证 + TaskModule（业务写路径与真 `EventService`）+ NotificationsModule。
 *
 * `TaskModule` 是**双用途**的：① 提供 POST /tasks/:id/assign 与 PATCH /tasks/:id 两个真端点
 * （`task_assigned` 两入口的 S1 事实）；② 它 import `EventModule` 并导出 `EventService`——本套件
 * 借此对非 task 类别（topic/doc）**发真事件**（落库 + `emit('event.created')` 全走生产代码）。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => ({
          jwt: { secret: JWT_SECRET, expiresIn: '2h' },
          notifications: NOTIFY_TEST_CONFIG,
        }),
      ],
    }),
    // 编排器的 @OnEvent 订阅 + EventService 的 emit 都需要 EventEmitter2（生产由 AppModule 提供）
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      migrationsRun: false,
      logging: false,
    }),
    PipelineE2eAuthModule,
    // TaskService / EventService 依赖的 ActorProfileService / OwnerProxyService 由 @Global() 两模块提供
    CommonModule,
    PermissionModule,
    TaskModule,
    // `@Global()` hint 基建：TaskModule 内的 `TaskHygieneHintProvider` 注入 `HintRegistry`
    // （不 import 它 ⇒ 启动期 "Nest can't resolve dependencies of the TaskHygieneHintProvider"）。
    // 本套件不需要 hint 链本身（不注册 HINT_FACT_PROVIDERS 生产链），只需注册表可解析。
    HintsModule,
    NotificationsModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseInterceptor }],
})
class PipelineE2eModule {}

/** 编排器私有内存态（测试内复位用；`settings` 用于临时改写开关两侧） */
interface OrchestratorInternals {
  settings: NotificationsConfig;
  l1: { clear(): void };
  /**
   * L2 窗口表。⚠️ **键 = `userId`**（批 2 棒 B 起；此前是投递地址，**含** `recipientUserId` 字段）
   * ——探针与复位都必须按新键，否则"找不到窗口"会表现为超时而不是断言失败。
   */
  l2Windows: Map<
    string,
    { recipientUserId: string; summarySent: boolean; suppressed: Map<string, number> }
  >;
  topicParticipation: { clear(): void };
  /** 二期批 2：per-user 快照缓存（跨用例必须清——否则前一个用例的快照会被后一个复用） */
  snapshots: { clear(): void };
  /**
   * 系统告警的量控桶（进程内 Map）。本套件只发一条告警，复位是**防御性**的：
   * 将来加用例时不会因上一个用例占额而莫名 rate_limited。
   */
  systemAlertBuckets: { clear(): void };
}

/** 投递行投影（本套件查询用到的字段） */
interface DeliveryRow {
  category: string;
  status: string;
  attempts: number;
  event_id: string | null;
  channel: string;
}

describe('Notifications 事件 → 投递贯通 — 真实 PG + 真实 HTTP + 真实编排器', () => {
  let app: INestApplication;
  let ds: DataSource;
  let orchestrator: NotifyOrchestrator;
  let eventService: EventService;
  let dbAvailable = false;

  /** owner 的 actorId（自回声用例的对照锚点） */
  let ownerActorId: string;
  /** agent A：看板创建者（对任务有 write）——发起一切任务操作 */
  let agentAId: string;
  let agentAKey: string;
  /** agent B：被指派人（只需存在且未软删） */
  let agentBId: string;
  let agentBKey: string;
  /** 一个与本操作者无关的 actor（topic「他人发言」的发送者） */
  let otherActorId: string;
  /** **第二个候选用户**（有绑定、偏好与 owner 相反：关 `task_done`）——多用户端到端用 */
  let secondUserId: string;
  /**
   * **外部操作者**：另一个人类名下的 agent（不是收件人的 agent）。
   *
   * 为什么需要它（Notifications 二期批 2）：自回声从"全局 owner 名单"改成 **per-candidate**
   * （`event.actorId == 我 ∪ ∈ 我的 agents` ⇒ 跳过）。本套件的收件人是 `ownerActorId`，而
   * agentA / agentB 都是**他的** agent —— 它们触发的事件按新语义**不该通知他**。故凡"应当投递"
   * 的任务用例，操作者必须换成"别人的人"（真实场景：其他人类/他们的 agent 在我的看板里干活）。
   */
  let foreignAgentId: string;
  let foreignAgentKey: string;

  const created = {
    actorIds: [] as string[],
    userIds: [] as string[],
    agentIds: [] as string[],
    keyIds: [] as string[],
    boardIds: [] as string[],
    taskIds: [] as string[],
    topicIds: [] as string[],
    docIds: [] as string[],
    docSpaceIds: [] as string[],
    eventIds: [] as string[],
    /**
     * 本套件**补种**的通知渠道行（只在库里没有 admin 可用渠道时才建；见系统告警用例）。
     * ⚠️ 绝不删除库中已存在的渠道行——它们是别的套件/环境的事实。
     */
    notificationChannelIds: [] as string[],
  };

  // ─── 时间/派发助手（见文件头 [关键不变量]） ─────────────────────────

  /** 等一次异步派发落地（`{async:true}` 走 setImmediate + 内部 await 链） */
  async function settle(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 轮询等待条件成立（正向断言专用；超时抛错——宁可红也不假绿） */
  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`waitFor timeout: ${label}`);
  }

  /** 全类别打开的偏好映射（owner fixture 用；见其注释） */
  function allCategoriesEnabled(): Record<string, boolean> {
    return Object.fromEntries(NOTIFY_CATEGORIES.map((category) => [category, true]));
  }

  /** 轮询等待内存态谓词成立（用于"事件已处理完"这类**没有 DB 痕迹**的屏障） */
  async function waitForState(
    predicate: () => boolean,
    label: string,
    timeoutMs = 8000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`waitForState timeout: ${label}`);
  }

  /** 编排器私有内存态（TS private 只是编译期修饰符，测试内复位需要拿到它） */
  function internals(): OrchestratorInternals {
    return orchestrator as unknown as OrchestratorInternals;
  }

  /** 清四个进程内内存态：L1 / L2 / topic 参与 / **per-user 快照**（跨用例污染的唯一来源） */
  function resetOrchestratorState(): void {
    const state = internals();
    state.l1.clear();
    state.l2Windows.clear();
    state.snapshots?.clear();
    state.topicParticipation.clear();
    state.systemAlertBuckets?.clear();
  }

  /**
   * 临时改写配置（开关两侧覆盖 / L2 条数收小）并在 `finally` 还原。
   *
   * 为什么可以这么做：`settings` 是编排器构造期读出的快照对象，而生产闸门就是
   * `settings.categories.includes(...)` / `settings.globalRateLimit` 这几行——改写它等价于
   * "用另一份配置启动"，仍然打真代码路径（不是绕过判定）。
   */
  async function withSettings<T>(
    patch: Partial<NotificationsConfig>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const target = internals().settings as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) saved[key] = target[key];
    Object.assign(target, patch);
    try {
      return await fn();
    } finally {
      Object.assign(target, saved);
    }
  }

  /** 全类别去掉若干个（构造"某些 token 关掉"的白名单） */
  function withoutCategories(...tokens: NotifyCategory[]): NotifyCategory[] {
    return [...NOTIFY_CATEGORIES].filter((category) => !tokens.includes(category));
  }

  // ─── 数据构造 ───────────────────────────────────────────────────

  /**
   * 建一个 agent（actor + agents + api_key），返回明文 API Key。
   *
   * @param label 显示名后缀
   * @param ownerId 人类 owner（缺省 = 本套件的收件人 `ownerActorId`；**外部操作者**要传别人）
   */
  async function createAgent(
    label: string,
    ownerId: string = ownerActorId,
  ): Promise<{ id: string; rawKey: string }> {
    const displayName = `Ntfp Agent ${label} ${RUN}`;
    const actor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.AGENT,
        displayName,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(actor.id);
    const agent = await ds.getRepository(Agent).save(
      ds.getRepository(Agent).create({
        id: actor.id,
        actor,
        ownerId,
        name: displayName,
        webhookEvents: [],
        capabilities: null,
        modelConfig: {},
        rateLimit: {},
      }),
    );
    created.agentIds.push(agent.id);
    const rawKey = `ask_${RUN}_${label}`;
    const saved = await ds.getRepository(ApiKey).save(
      ds.getRepository(ApiKey).create({
        agentId: agent.id,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.substring(0, 8),
        name: 'Default Key',
        permissions: { scopes: ['read', 'write'] },
        createdBy: ownerActorId,
      }),
    );
    created.keyIds.push(saved.id);
    return { id: actor.id, rawKey };
  }

  /** 建「看板 → 列 → 任务」链（`creatorId = agent A` ⇒ 对任务有 write，PATCH/assign 放行） */
  async function createBoardChain(
    label: string,
  ): Promise<{ boardId: string; listId: string; taskId: string }> {
    const board = await ds.getRepository(Board).save(
      ds.getRepository(Board).create({
        name: `ntfp board ${RUN} ${label}`,
        creatorId: agentAId,
        settings: { visibility: 'open' },
        taskCount: 0,
        completedTaskCount: 0,
      }),
    );
    created.boardIds.push(board.id);
    // ⚠️ **二期批 2 必需**：任务事件的操作者是**外部 agent**（见 `foreignAgentId` 的注释），
    // 它要对任务有 write ⇒ 必须是该看板的 editor（BoardPolicy `write` = creator | editor | owner-proxy）。
    await ds.getRepository(BoardMember).save(
      ds.getRepository(BoardMember).create({
        boardId: board.id,
        actorId: foreignAgentId,
        role: 'editor',
        invitedBy: agentAId,
      }),
    );
    const list = await ds.getRepository(BoardList).save(
      ds.getRepository(BoardList).create({
        boardId: board.id,
        name: `ntfp list ${RUN} ${label}`,
        position: 0,
      }),
    );
    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId: list.id,
        title: `Ntfp Task ${RUN} ${label}`,
        description: null,
        position: 0,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);
    return { boardId: board.id, listId: list.id, taskId: task.id };
  }

  /** 在同一列下再挂一个任务（指定初始状态/描述） */
  async function createTask(
    listId: string,
    label: string,
    opts: { status?: TaskStatus; description?: string | null; position?: number } = {},
  ): Promise<string> {
    const task = await ds.getRepository(Task).save(
      ds.getRepository(Task).create({
        listId,
        title: `Ntfp Task ${RUN} ${label}`,
        description: opts.description ?? null,
        position: opts.position ?? 1,
        status: opts.status ?? TaskStatus.TODO,
        customFields: {},
      }),
    );
    created.taskIds.push(task.id);
    return task.id;
  }

  /** 造「话题 + 参与行 + 一条消息」三元组（返回 messageId，供事件 resourceId 用） */
  async function createTopicThread(
    label: string,
    opts: { ownerStatus: ParticipantStatus | null; messageType?: MessageType; content?: string },
  ): Promise<{ topicId: string; messageId: string }> {
    const topic = await ds.getRepository(Topic).save(
      ds.getRepository(Topic).create({
        title: `Ntfp Topic ${RUN} ${label}`,
        description: null,
        creatorId: agentAId,
        status: TopicStatus.ACTIVE,
      }),
    );
    created.topicIds.push(topic.id);
    if (opts.ownerStatus !== null) {
      // ⚠️ active 行必须带 joinedAt（DB CHECK: status != 'active' OR joined_at IS NOT NULL）
      await ds.getRepository(TopicParticipant).save(
        ds.getRepository(TopicParticipant).create({
          topicId: topic.id,
          participantId: ownerActorId,
          role: 'member',
          status: opts.ownerStatus,
          joinedAt: opts.ownerStatus === ParticipantStatus.ACTIVE ? new Date() : null,
          leftAt: opts.ownerStatus === ParticipantStatus.LEFT ? new Date() : null,
          notificationSettings: { mute: false, mentions_only: false },
        }),
      );
    }
    const message = await ds.getRepository(Message).save(
      ds.getRepository(Message).create({
        topicId: topic.id,
        senderId: otherActorId,
        type: opts.messageType ?? MessageType.CHAT,
        content: opts.content ?? `ntfp message ${RUN} ${label}`,
      }),
    );
    return { topicId: topic.id, messageId: message.id };
  }

  /** 造「DocSpace + Doc」对（doc 渲染要回库取 path/title ⇒ 必须有真行） */
  async function createDoc(
    label: string,
  ): Promise<{ docId: string; path: string; title: string; spaceId: string; spaceName: string }> {
    const spaceName = `ntfp space ${RUN}`;
    const space = await ds.getRepository(DocSpace).save(
      ds.getRepository(DocSpace).create({
        name: spaceName,
        slug: `ntfp-space-${RUN}`,
        creatorId: agentAId,
      }),
    );
    created.docSpaceIds.push(space.id);
    const path = `ntfp/${RUN}/${label}.md`;
    const title = `Ntfp Doc ${RUN} ${label}`;
    const doc = await ds.getRepository(Doc).save(
      ds.getRepository(Doc).create({
        spaceId: space.id,
        path,
        title,
        createdBy: agentAId,
      }),
    );
    created.docIds.push(doc.id);
    return { docId: doc.id, path, title, spaceId: space.id, spaceName };
  }

  /** 发一条真事件（真落库 + 真 emit）并记 id（清理用） */
  async function emit(dto: Parameters<EventService['create']>[0]): Promise<string> {
    const saved = await eventService.create(dto);
    created.eventIds.push(saved.id);
    return saved.id;
  }

  // ─── 断言助手 ───────────────────────────────────────────────────

  /** 按深链尾段（资源 id）筛出该资源的所有出境通知 */
  function sentFor(resourceId: string): RenderedNotification[] {
    return fakeProvider.sent.filter((n) => n.link !== null && n.link.endsWith(`/${resourceId}`));
  }

  /** L2 超额摘要（category='digest'） */
  function digests(): RenderedNotification[] {
    return fakeProvider.sent.filter((n) => n.category === DIGEST_DELIVERY_CATEGORY);
  }

  /** 读某事件的投递行（抑制类必须为 0 行） */
  async function deliveryRowsForEvent(eventId: string): Promise<DeliveryRow[]> {
    return ds.query(
      `SELECT category, status, attempts, event_id, channel
         FROM notification_deliveries WHERE event_id = $1 ORDER BY created_at DESC`,
      [eventId],
    );
  }

  /**
   * 等某事件的投递行落库（**不要用 `waitFor(sentFor(...))` 代替本助手**）。
   *
   * ⚠️ 为什么必须轮询：投递链路是"先调 provider、后写台账"两步（`deliver()` 内），
   * `fakeProvider.sent` 有值只说明**第一步**发生了——紧接着读 `notification_deliveries`
   * 会撞上尚未提交的 INSERT（负载高时稳定复现，本地轻载时偶发）。这是断言与实现的
   * 时序契约，不是路由行为。
   */
  async function waitForDeliveryRows(eventId: string, min = 1): Promise<DeliveryRow[]> {
    const deadline = Date.now() + 8000;
    let rows: DeliveryRow[] = [];
    while (Date.now() < deadline) {
      rows = await deliveryRowsForEvent(eventId);
      if (rows.length >= min) return rows;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return rows;
  }

  /** 带身份的 HTTP 助手（agent A 通道 = 真 sha256 API Key 校验） */
  function req() {
    // ⚠️ 操作用的是**外部 agent**（`foreignAgentKey`）而不是本套件收件人名下的 agent：
    //    二期批 2 的 per-candidate 自回声是"`event.actorId ∈ 我的 agents` ⇒ 不通知我"，
    //    若由收件人自己的 agent 操作，"应当投递"的用例会被自回声整体吃掉（症状与路由坏了相同）。
    const agent = request(app.getHttpServer());
    return {
      patch: (path: string) =>
        agent.patch(`${API_PREFIX}${path}`).set('X-API-Key', foreignAgentKey),
      post: (path: string) => agent.post(`${API_PREFIX}${path}`).set('X-API-Key', foreignAgentKey),
    };
  }

  // ─── 生命周期 ───────────────────────────────────────────────────

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      ...DB_CONFIG,
      entities: Object.values(entities).filter((entity) => typeof entity === 'function'),
      namingStrategy: new SnakeNamingStrategy(),
      synchronize: false,
      logging: false,
    });
    try {
      await ds.initialize();
    } catch (err) {
      console.warn(
        `[notifications-pipeline e2e] PG unavailable, suite skipped: ${(err as Error).message}`,
      );
      return;
    }

    // 表必须在（S2 迁移链产物）——缺表即环境未跑迁移，显式失败而非静默跳过
    const tables = (await ds.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = 'notification_deliveries'`,
    )) as { table_name: string }[];
    expect(tables.map((t) => t.table_name)).toEqual(['notification_deliveries']);

    // owner 必须先存在：编排器在 app.init()（onModuleInit）里解析 NOTIFY_OWNER_USERNAMES
    const ownerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntfp Owner ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(ownerActor.id);
    const owner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: ownerActor.id,
        actor: ownerActor,
        username: OWNER_USERNAME,
        email: `ntfp-owner-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        // ⚠️ **全类别显式打开**：用户缺省偏好是 `DEFAULT_NOTIFY_CATEGORIES`（只含
        // `task_done` + `direct`，见 dto 的读取归一）；本套件的主语是"某条事件该不该出境"，
        // 需要把每个类别都变成**可达**状态，否则 topic / doc / task_updated 会被偏好层整体拦掉
        // （症状与"路由坏了"一模一样）。偏好层本身由单测的类别偏好用例覆盖。
        preferences: { notificationCategories: allCategoriesEnabled() },
      }),
    );
    created.userIds.push(owner.id);
    ownerActorId = owner.id;

    const agentA = await createAgent('a');
    agentAId = agentA.id;
    agentAKey = agentA.rawKey;
    const agentB = await createAgent('b');
    agentBId = agentB.id;
    agentBKey = agentB.rawKey;

    // 外部人类 + 其名下的 agent（任务的**操作者**；见 `foreignAgentId` 的注释）
    const foreignOwnerActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntfp Foreign Owner ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(foreignOwnerActor.id);
    const foreignOwner = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: foreignOwnerActor.id,
        actor: foreignOwnerActor,
        username: `ntfpforeign${RUN}`.slice(0, 50),
        email: `ntfp-foreign-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: {},
      }),
    );
    created.userIds.push(foreignOwner.id);
    // 外部操作者必须挂在**别人**名下：`agents.owner_id` 非空且有 FK ⇒ 先建一个真 user 行
    const foreignAgent = await createAgent('op', foreignOwner.id);
    foreignAgentId = foreignAgent.id;
    foreignAgentKey = foreignAgent.rawKey;

    const otherActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntfp Other ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(otherActor.id);
    otherActorId = otherActor.id;

    // ── 二期批 2：**第二个真实候选用户**（多用户端到端：各自偏好 / 各自的 L1-L2 窗口 / 各自的地址）
    // 偏好刻意与 owner 相反：**关掉 `task_done`**（其余全开）⇒ 同一条任务通知"他收不到、owner 收到"。
    const secondActor = await ds.getRepository(Actor).save(
      ds.getRepository(Actor).create({
        type: ActorType.HUMAN,
        displayName: `Ntfp Second ${RUN}`,
        status: AgentStatus.ACTIVE,
      }),
    );
    created.actorIds.push(secondActor.id);
    const secondUser = await ds.getRepository(User).save(
      ds.getRepository(User).create({
        id: secondActor.id,
        actor: secondActor,
        username: `ntfpsecond${RUN}`.slice(0, 50),
        email: `ntfp-second-${RUN}@example.com`,
        authProvider: 'local',
        role: UserRole.EDITOR,
        preferences: { notificationCategories: { ...allCategoriesEnabled(), task_done: false } },
      }),
    );
    created.userIds.push(secondUser.id);
    secondUserId = secondUser.id;
    // 他的投递渠道（**手工插一条 deliveryEligible 行**——走 web 端点要 JWT + 两步验证，
    // 而本套件的主语是路由/节流，不是绑定流程本身；谓词与播种路径完全一致）
    await ds.query(
      `INSERT INTO user_notification_channels
         (user_id, provider, recipient_address, enabled, last_test_status, last_test_address, source)
       VALUES ($1, 'feishu', $2, TRUE, 'ok', $2, 'user')`,
      [secondUserId, SECOND_RECIPIENT],
    );

    dbAvailable = true;

    const moduleRef = await Test.createTestingModule({ imports: [PipelineE2eModule] })
      // 出口整体换成内存 fake（**不联网**）——事件链路与直发链路共用这个 token
      .overrideProvider(NOTIFY_PROVIDER_LIST)
      .useValue([fakeProvider as unknown as NotifyProvider])
      .compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 逐字对齐：校验管道 + 全局前缀（响应信封由 APP_INTERCEPTOR 提供）
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix(API_PREFIX);
    await app.init();

    orchestrator = app.get(NotifyOrchestrator);
    eventService = app.get(EventService);
  }, 180000);

  afterAll(async () => {
    if (!dbAvailable) return;
    if (app) await app.close();
    // 一律 try/catch：一条 FK 报错不得吞掉后续清理
    const sweep = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        console.warn(
          `[notifications-pipeline e2e] cleanup ${label} skipped: ${(err as Error).message}`,
        );
      }
    };
    // 投递行无 FK：按收件人精确删（RECIPIENT 唯一且带 RUN ⇒ 摘要行也在内，见文件头说明）
    await sweep('notification_deliveries', () =>
      ds.query(`DELETE FROM notification_deliveries WHERE recipient = $1`, [RECIPIENT]),
    );
    // 系统告警行的收件人是 **admin 的地址**（不是 RECIPIENT）⇒ 按标题里的 RUN 精确删，
    // 绝不宽删 `category='system_alert'`（那会清掉别的运行/环境留下的告警历史）
    await sweep('system alert deliveries', () =>
      ds.query(
        `DELETE FROM notification_deliveries
          WHERE category = 'system_alert' AND title LIKE $1`,
        [`%${RUN}%`],
      ),
    );
    // 事件行无 FK 且无清理义务，但本套件发的行按 actor/id 精确删（避免共享库留垃圾）
    if (created.actorIds.length > 0 || created.eventIds.length > 0) {
      await sweep('events', () =>
        ds.query(`DELETE FROM events WHERE actor_id = ANY($1::uuid[]) OR id = ANY($2::uuid[])`, [
          created.actorIds,
          created.eventIds,
        ]),
      );
    }
    if (created.topicIds.length > 0) {
      await sweep('messages', () =>
        ds.query(`DELETE FROM messages WHERE topic_id = ANY($1::uuid[])`, [created.topicIds]),
      );
      await sweep('topic_participants', () =>
        ds.query(`DELETE FROM topic_participants WHERE topic_id = ANY($1::uuid[])`, [
          created.topicIds,
        ]),
      );
      await sweep('topics', () =>
        ds.query(`DELETE FROM topics WHERE id = ANY($1::uuid[])`, [created.topicIds]),
      );
    }
    if (created.taskIds.length > 0) {
      await sweep('task_activities', () =>
        ds.query(`DELETE FROM task_activities WHERE task_id = ANY($1::uuid[])`, [created.taskIds]),
      );
      await sweep('tasks', () =>
        ds.query(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [created.taskIds]),
      );
    }
    if (created.boardIds.length > 0) {
      await sweep('board_lists', () =>
        ds.query(`DELETE FROM board_lists WHERE board_id = ANY($1::uuid[])`, [created.boardIds]),
      );
      await sweep('boards', () =>
        ds.query(`DELETE FROM boards WHERE id = ANY($1::uuid[])`, [created.boardIds]),
      );
    }
    if (created.docIds.length > 0) {
      await sweep('docs', () =>
        ds.query(`DELETE FROM docs WHERE id = ANY($1::uuid[])`, [created.docIds]),
      );
    }
    if (created.docSpaceIds.length > 0) {
      await sweep('doc_spaces', () =>
        ds.query(`DELETE FROM doc_spaces WHERE id = ANY($1::uuid[])`, [created.docSpaceIds]),
      );
    }
    for (const id of created.keyIds)
      await sweep('api_key', () => ds.getRepository(ApiKey).delete({ id }));
    // 只删本套件补种的渠道行（见 created.notificationChannelIds 的注释）
    for (const id of created.notificationChannelIds) {
      await sweep('notification_channel', () =>
        ds.query(`DELETE FROM user_notification_channels WHERE id = $1`, [id]),
      );
    }
    for (const id of created.agentIds)
      await sweep('agent', () => ds.getRepository(Agent).delete({ id }));
    for (const id of created.userIds)
      await sweep('user', () => ds.getRepository(User).delete({ id }));
    for (const id of created.actorIds)
      await sweep('actor', () => ds.getRepository(Actor).delete({ id }));
    await ds.destroy();
  }, 90000);

  beforeEach(() => {
    if (!dbAvailable) return;
    fakeProvider.reset();
    resetOrchestratorState();
  });

  // ══════════════════════════════════════════════════════════════════
  // ① 真业务路径贯通 + 终态落库（plan §8 S6「投递终态落库断言」）
  // ══════════════════════════════════════════════════════════════════

  it('① 真 update 到 done ⇒ 投 [完工] + 落一行 task_done/success 且 event_id 指向那次 TASK_UPDATE', async () => {
    if (!dbAvailable) return;
    const { taskId } = await createBoardChain('done-real');

    await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.DONE }).expect(200);

    await waitFor(() => sentFor(taskId).length >= 1, 'task_done delivery');
    const [notification] = sentFor(taskId);
    expect(notification.category).toBe(NOTIFY_CATEGORY.TASK_DONE);
    expect(notification.title).toBe(`[完工] Ntfp Task ${RUN} done-real`);
    expect(notification.link).toBe(`${WEB_BASE}/tasks/${taskId}`);
    expect(notification.recipient).toBe(RECIPIENT);

    // 终态落库：category/status/attempts/channel 与"事件链路必须带 eventId"的约定
    const eventRows = (await ds.query(
      `SELECT id FROM events WHERE resource_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1`,
      [taskId, EventType.TASK_UPDATE],
    )) as { id: string }[];
    expect(eventRows).toHaveLength(1);

    const rows = await waitForDeliveryRows(eventRows[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: NOTIFY_CATEGORY.TASK_DONE,
      status: 'success',
      channel: 'feishu',
      event_id: eventRows[0].id,
    });
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // ② task_done 跃迁判据（改已完成任务的描述 ≠ 完工）
  // ══════════════════════════════════════════════════════════════════

  it('② 改已完成任务的描述（patchDescription 无跃迁载荷）⇒ 落 task_updated，**绝不落 task_done**', async () => {
    if (!dbAvailable) return;
    const { listId } = await createBoardChain('patch-desc');
    const taskId = await createTask(listId, 'patch-desc-done', {
      status: TaskStatus.DONE,
      description: `origin paragraph ${RUN}`,
    });

    await req()
      .patch(`/tasks/${taskId}/description`)
      .send({ oldString: `origin paragraph ${RUN}`, newString: `edited paragraph ${RUN}` })
      .expect(200);

    await waitFor(() => sentFor(taskId).length >= 1, 'task_updated delivery');
    await settle();
    const notifications = sentFor(taskId);
    // 跃迁判据为假 ⇒ 类别是 task_updated（不是 task_done）——"改描述"被误报成"完工"是 §11 列明的风险
    expect(notifications).toHaveLength(1);
    expect(notifications[0].category).toBe(NOTIFY_CATEGORY.TASK_UPDATED);
    expect(notifications[0].title).toBe(`[任务更新] Ntfp Task ${RUN} patch-desc-done`);
    expect(notifications.filter((n) => n.category === NOTIFY_CATEGORY.TASK_DONE)).toHaveLength(0);
  });

  it('③ 同上事件在 `task_updated` 类别关闭时**完全不投**（类别开关的"关"侧）', async () => {
    if (!dbAvailable) return;
    const { listId } = await createBoardChain('patch-desc-off');
    const taskId = await createTask(listId, 'patch-desc-off-done', {
      status: TaskStatus.DONE,
      description: `origin paragraph ${RUN}`,
    });

    await withSettings(
      { categories: withoutCategories(NOTIFY_CATEGORY.TASK_UPDATED) },
      async () => {
        await req()
          .patch(`/tasks/${taskId}/description`)
          .send({ oldString: `origin paragraph ${RUN}`, newString: `edited paragraph ${RUN}` })
          .expect(200);
        await settle();
        expect(sentFor(taskId)).toHaveLength(0);
      },
    );

    // 抑制类**不落表**：事件存在，投递表无对应行（admin 列表看不到它们——文档写明的边界）
    const eventRows = (await ds.query(
      `SELECT id FROM events WHERE resource_id = $1 AND event_type = $2 ORDER BY created_at DESC LIMIT 1`,
      [taskId, EventType.TASK_UPDATE],
    )) as { id: string }[];
    expect(eventRows).toHaveLength(1);
    expect(await deliveryRowsForEvent(eventRows[0].id)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // ④ 类别开关矩阵（开/关各 token 的行为，以文档类别为样本——无 HTTP 依赖）
  // ══════════════════════════════════════════════════════════════════

  it('④ 类别开关：关闭的 token 静默不投、开启的 token 投（doc_created 两侧 + doc_moved 关闭侧）', async () => {
    if (!dbAvailable) return;

    // 关：doc_created 不在白名单 ⇒ 不投、不落表
    // ⚠️ `settle()` 必须在 `withSettings` **内部**：`await emit()` 返回时 handler 还没跑
    //    （setImmediate），此时还原白名单会让"关"侧静默失效——本用例第一版就栽在这。
    const off = await createDoc('cat-off');
    const offEvent = await withSettings(
      { categories: withoutCategories(NOTIFY_CATEGORY.DOC_CREATED) },
      async () => {
        const id = await emit({
          eventType: EventType.DOC_CREATED,
          resourceType: ResourceType.DOC,
          resourceId: off.docId,
          payload: {},
        });
        await settle();
        return id;
      },
    );
    expect(sentFor(off.docId)).toHaveLength(0);
    expect(await deliveryRowsForEvent(offEvent)).toHaveLength(0);

    // 开：doc_created 在白名单 ⇒ 投，标题 = [新文档] <path>
    const on = await createDoc('cat-on');
    const onEvent = await emit({
      eventType: EventType.DOC_CREATED,
      resourceType: ResourceType.DOC,
      resourceId: on.docId,
      payload: {},
    });
    await waitFor(() => sentFor(on.docId).length >= 1, 'doc_created on');
    const [notification] = sentFor(on.docId);
    expect(notification.category).toBe(NOTIFY_CATEGORY.DOC_CREATED);
    expect(notification.title).toBe(`[新文档] ${on.path}`);
    expect(notification.link).toBe(`${WEB_BASE}/docs/${on.docId}`);
    expect((await waitForDeliveryRows(onEvent))[0]).toMatchObject({
      category: NOTIFY_CATEGORY.DOC_CREATED,
      status: 'success',
    });

    // 另一个 token 的关闭侧（doc_moved）：行为面同一闸门（同样把 settle 放在 withSettings 内）
    const { docId: movedDocId } = await createDoc('cat-moved');
    const movedEvent = await withSettings(
      { categories: withoutCategories(NOTIFY_CATEGORY.DOC_MOVED) },
      async () => {
        const id = await emit({
          eventType: EventType.DOC_MOVED,
          resourceType: ResourceType.DOC,
          resourceId: movedDocId,
          payload: {},
        });
        await settle();
        return id;
      },
    );
    expect(sentFor(movedDocId)).toHaveLength(0);
    expect(await deliveryRowsForEvent(movedEvent)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑤ L1 per-resource 合并（同 task 两次完工跃迁 ⇒ 1 条）
  // ══════════════════════════════════════════════════════════════════

  it('⑤ L1 per-resource：同一 task 两次 done 跃迁 ⇒ 只投 1 条（窗口命中不落表）', async () => {
    if (!dbAvailable) return;
    const { taskId } = await createBoardChain('l1');

    // 第一次跃迁：投
    await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.DONE }).expect(200);
    await waitFor(() => sentFor(taskId).length >= 1, 'first done');

    // 回退（task_updated，同资源的 L1 键 ⇒ 已命中）、再跃迁到 done（task_done ⇒ 同样命中）
    await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.IN_PROGRESS }).expect(200);
    await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.DONE }).expect(200);
    await settle();

    const notifications = sentFor(taskId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].category).toBe(NOTIFY_CATEGORY.TASK_DONE);

    // 后两次跃迁的事件行都在，但投递表**没有任何**指向它们的行（L1 命中不落表）
    const events = (await ds.query(
      `SELECT id FROM events WHERE resource_id = $1 AND event_type = $2`,
      [taskId, EventType.TASK_UPDATE],
    )) as { id: string }[];
    expect(events.length).toBe(3);
    // 轮询到"至少一行落库"再断言总数：`sentFor` 有值只说明 provider 被调过（台账 INSERT 还在路上）
    let rows = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      rows = 0;
      for (const event of events) rows += (await deliveryRowsForEvent(event.id)).length;
      if (rows >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rows).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑥ L2 全局闸 + 摘要合并（额度 2 + 4 条事件 ⇒ 2 条 + 1 条摘要）
  // ══════════════════════════════════════════════════════════════════

  it('⑥ L2 全局闸：额度收到 2、发 4 条事件 ⇒ 2 条直发 + 1 条摘要（文案 + 根链接 + 不占额度）', async () => {
    if (!dbAvailable) return;

    // 4 个**不同资源**（同资源会被 L1 先压掉，L2 就测不到了）
    const chains = await Promise.all([
      createBoardChain('l2-1'),
      createBoardChain('l2-2'),
      createBoardChain('l2-3'),
      createBoardChain('l2-4'),
    ]);

    await withSettings({ globalRateLimit: 2 }, async () => {
      for (const chain of chains) {
        await emit({
          eventType: EventType.TASK_UPDATE,
          resourceType: ResourceType.TASK,
          resourceId: chain.taskId,
          // 操作者 = 外部 agent（本人名下 agent 的动作按二期自回声**不通知本人**）
          actorId: foreignAgentId,
          actorType: ActorType.AGENT,
          payload: {
            taskId: chain.taskId,
            action: 'updated',
            status: TaskStatus.DONE,
            fromStatus: TaskStatus.TODO,
            toStatus: TaskStatus.DONE,
          },
        });
      }
      await waitFor(() => digests().length >= 1, 'l2 digest');
      // ⚠️ **显式屏障：必须等 4 条事件全部处理完再退出 `withSettings`**。
      //    只等"摘要出现"是不够的——摘要在**第 3 条**处理时就 flush 了，第 4 条的 handler 可能还在
      //    setImmediate 队列里；此刻若还原 `globalRateLimit`（2 → 50），第 4 条会按 50 的额度**直接
      //    放行**（实测：直发 3 条而非 2 条）。本屏障的判据 = "窗口已发过摘要 ∧ 又有新的记账"，
      //    即"第 3 条处理完（`summarySent`）**且**第 4 条也处理完（`suppressed` 非空）"。
      await waitForState(() => {
        // ⚠️ 窗口键是 **userId**（批 2 棒 B 起；此前是投递地址）——探针也必须按新键取，
        //    否则这个屏障永远不满足（表现为 5s 超时，而不是断言失败，很容易误读成"偶发"）。
        const window = internals().l2Windows.get(ownerActorId) as
          | { summarySent: boolean; suppressed: Map<string, number> }
          | undefined;
        return window !== undefined && window.summarySent && window.suppressed.size > 0;
      }, 'all four events handled (digest sent + 4th buffered)');
    });
    await settle();

    // 放行 2 条（额度），超额部分合并成 1 条摘要（窗口内 ≤1 条、不占额度）
    const direct = fakeProvider.sent.filter((n) => n.category !== DIGEST_DELIVERY_CATEGORY);
    expect(direct).toHaveLength(2);
    expect(digests()).toHaveLength(1);

    const [digest] = digests();
    expect(digest.title).toBe('[通知汇总]');
    // ⚠️ 摘要在"第一个超额尝试"上 flush ⇒ 此刻被压制的计数是 1（见文件头踩坑）
    expect(digest.body).toBe('另有 1 条通知（task_done×1）');
    // "根链接" = web 基址本身（摘要聚合多个资源，没有单一资源可指向）
    expect(digest.link).toBe(WEB_BASE);
    expect(digest.recipient).toBe(RECIPIENT);
    // 摘要行落库：category='digest' 且 event_id 为 NULL（它不属于任何一个事件）
    const digestRows = (await ds.query(
      `SELECT category, status, event_id FROM notification_deliveries
        WHERE recipient = $1 AND category = $2`,
      [RECIPIENT, DIGEST_DELIVERY_CATEGORY],
    )) as { category: string; status: string; event_id: string | null }[];
    expect(digestRows).toHaveLength(1);
    expect(digestRows[0]).toMatchObject({
      category: DIGEST_DELIVERY_CATEGORY,
      status: 'success',
      event_id: null,
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑦ 自回声抑制（owner 触发的操作不通知 owner）
  // ══════════════════════════════════════════════════════════════════

  it('⑦ 自回声：owner actor 触发的事件不投、不落表（对照：owner 真的被解析出来了）', async () => {
    if (!dbAvailable) return;
    const { taskId } = await createBoardChain('self-echo');

    const eventId = await emit({
      eventType: EventType.TASK_UPDATE,
      resourceType: ResourceType.TASK,
      resourceId: taskId,
      actorId: ownerActorId,
      actorType: ActorType.HUMAN,
      payload: {
        taskId,
        action: 'updated',
        status: TaskStatus.DONE,
        fromStatus: TaskStatus.TODO,
        toStatus: TaskStatus.DONE,
      },
    });

    await settle();
    expect(sentFor(taskId)).toHaveLength(0);
    expect(await deliveryRowsForEvent(eventId)).toHaveLength(0);

    // 对照（**必须有**，否则"自回声"恒为真也会让上面两条绿）：同一个资源、换成**别人**触发
    // ⇒ 投得出去。这条同时证明"收件人真的在候选集合里 + 路由真的放行他"——自回声挡的是
    // "我自己做的事"，不是"没人在候选里"（二期批 2 起没有全局 owner 名单可对照了）。
    const control = await createBoardChain('self-echo-control');
    const controlEventId = await emit({
      eventType: EventType.TASK_UPDATE,
      resourceType: ResourceType.TASK,
      resourceId: control.taskId,
      actorId: foreignAgentId,
      actorType: ActorType.AGENT,
      payload: {
        taskId: control.taskId,
        action: 'updated',
        status: TaskStatus.DONE,
        fromStatus: TaskStatus.TODO,
        toStatus: TaskStatus.DONE,
      },
    });
    await waitFor(() => sentFor(control.taskId).length >= 1, 'self-echo control delivery');
    expect((await waitForDeliveryRows(controlEventId)).length).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑧ topic 类别（active 参与过滤 + system 短路）
  // ══════════════════════════════════════════════════════════════════

  it('⑧ topic：owner 是 active 参与者 + 他人发消息 ⇒ 投 [话题]（标题/摘要/深链）', async () => {
    if (!dbAvailable) return;
    const thread = await createTopicThread('active', {
      ownerStatus: ParticipantStatus.ACTIVE,
      content: `ntfp hello ${RUN}`,
    });

    const eventId = await emit({
      eventType: EventType.NEW_MESSAGE,
      resourceType: ResourceType.MESSAGE,
      resourceId: thread.messageId,
      topicId: thread.topicId,
      actorId: otherActorId,
      actorType: ActorType.HUMAN,
      payload: { messageId: thread.messageId, type: MessageType.CHAT },
    });

    await waitFor(() => sentFor(thread.topicId).length >= 1, 'topic delivery');
    const [notification] = sentFor(thread.topicId);
    expect(notification.category).toBe(NOTIFY_CATEGORY.TOPIC);
    expect(notification.title).toBe(`[话题] Ntfp Topic ${RUN} active`);
    // 出境摘要 = **发言人显示名 + 消息正文**（截断 100 字符，v2 归属），与 config 的出境声明对齐
    expect(notification.body).toBe(`Ntfp Other ${RUN}：ntfp hello ${RUN}`);
    expect(notification.link).toBe(`${WEB_BASE}/topics/${thread.topicId}`);
    expect((await waitForDeliveryRows(eventId))[0]).toMatchObject({
      category: NOTIFY_CATEGORY.TOPIC,
      status: 'success',
    });
  });

  it('⑨ topic：owner 在该话题是 left（非 active）⇒ 不投、不落表', async () => {
    if (!dbAvailable) return;
    const thread = await createTopicThread('left', { ownerStatus: ParticipantStatus.LEFT });

    const eventId = await emit({
      eventType: EventType.NEW_MESSAGE,
      resourceType: ResourceType.MESSAGE,
      resourceId: thread.messageId,
      topicId: thread.topicId,
      actorId: otherActorId,
      actorType: ActorType.HUMAN,
      payload: { messageId: thread.messageId, type: MessageType.CHAT },
    });

    await settle();
    expect(sentFor(thread.topicId)).toHaveLength(0);
    expect(await deliveryRowsForEvent(eventId)).toHaveLength(0);
  });

  it('⑩ topic：payload.type === system ⇒ 不投（机器噪音不是"有人说话"）', async () => {
    if (!dbAvailable) return;
    const thread = await createTopicThread('system', {
      ownerStatus: ParticipantStatus.ACTIVE,
      messageType: MessageType.SYSTEM,
    });

    const eventId = await emit({
      eventType: EventType.NEW_MESSAGE,
      resourceType: ResourceType.MESSAGE,
      resourceId: thread.messageId,
      topicId: thread.topicId,
      actorId: otherActorId,
      actorType: ActorType.HUMAN,
      payload: { messageId: thread.messageId, type: MessageType.SYSTEM },
    });

    await settle();
    expect(sentFor(thread.topicId)).toHaveLength(0);
    expect(await deliveryRowsForEvent(eventId)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑨ task_assigned 两入口（S1 的业务写路径事实：真端点实发事件）
  // ══════════════════════════════════════════════════════════════════

  it('⑪ assign 两入口：POST /tasks/:id/assign 与 PATCH {assigneeId} 各投一条 [指派]', async () => {
    if (!dbAvailable) return;

    // 入口一：POST /tasks/:id/assign（assign() 只发 TASK_ASSIGNED，无 L1 竞争）
    const viaEndpoint = await createBoardChain('assign-endpoint');
    await req()
      .post(`/tasks/${viaEndpoint.taskId}/assign`)
      .send({ assigneeId: agentBId })
      .expect(201);
    await waitFor(() => sentFor(viaEndpoint.taskId).length >= 1, 'assign endpoint delivery');
    const [viaEndpointNotification] = sentFor(viaEndpoint.taskId);
    expect(viaEndpointNotification.category).toBe(NOTIFY_CATEGORY.TASK_ASSIGNED);
    expect(viaEndpointNotification.title).toBe(`[指派] Ntfp Task ${RUN} assign-endpoint`);
    // v2 归属：正文 = 「看板「<看板名>」 · <操作者>」+ 指派尾段「 → 指派给 <被指派人>」**整串完整**
    // （task 正文上限 200 ⇒ 本 fixture 约 106 字符的正文不再被截；100 的旧宽度下这里必被截尾）
    expect(viaEndpointNotification.body).toBe(
      `看板「ntfp board ${RUN} assign-endpoint」 · Ntfp Agent op ${RUN} → 指派给 Ntfp Agent b ${RUN}`,
    );

    // 入口二：PATCH /tasks/:id {assigneeId}（update() 同发 TASK_UPDATE + TASK_ASSIGNED）
    // ⚠️ 两条事件共用 L1 键 `task:<id>` ⇒ 只第一条放行。要确定性地看到 [指派]，把 task_updated
    //    类别临时关掉（关掉的类别在 L1 之前早退、不占窗口）——这正是"两入口各发各的"的证明：
    //    若 update() 没发 TASK_ASSIGNED，本用例会因为"什么都不投"而红。
    const viaPatch = await createBoardChain('assign-patch');
    await withSettings(
      { categories: withoutCategories(NOTIFY_CATEGORY.TASK_UPDATED) },
      async () => {
        await req().patch(`/tasks/${viaPatch.taskId}`).send({ assigneeId: agentBId }).expect(200);
        await waitFor(() => sentFor(viaPatch.taskId).length >= 1, 'assign patch delivery');
      },
    );

    const notifications = sentFor(viaPatch.taskId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].category).toBe(NOTIFY_CATEGORY.TASK_ASSIGNED);
    expect(notifications[0].title).toBe(`[指派] Ntfp Task ${RUN} assign-patch`);

    // 两个入口的事件都真落库（TASK_ASSIGNED 曾是死枚举，S1 才补上发出方）
    for (const taskId of [viaEndpoint.taskId, viaPatch.taskId]) {
      const rows = (await ds.query(
        `SELECT id FROM events WHERE resource_id = $1 AND event_type = $2`,
        [taskId, EventType.TASK_ASSIGNED],
      )) as { id: string }[];
      expect(rows).toHaveLength(1);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑩ doc_updated 纯重切短路
  // ══════════════════════════════════════════════════════════════════

  it('⑫ doc 纯重切短路：DOC_UPDATED + rechunked=true ⇒ 不投；普通 DOC_UPDATED ⇒ 投 [文档更新]', async () => {
    if (!dbAvailable) return;

    // 短路侧：内容没变的纯重切通知它只是噪音
    const rechunked = await createDoc('rechunked');
    const shortCircuitEvent = await emit({
      eventType: EventType.DOC_UPDATED,
      resourceType: ResourceType.DOC,
      resourceId: rechunked.docId,
      payload: { rechunked: true },
    });
    await settle();
    expect(sentFor(rechunked.docId)).toHaveLength(0);
    expect(await deliveryRowsForEvent(shortCircuitEvent)).toHaveLength(0);

    // 正侧：普通更新照投
    const updated = await createDoc('updated');
    const updateEvent = await emit({
      eventType: EventType.DOC_UPDATED,
      resourceType: ResourceType.DOC,
      resourceId: updated.docId,
      payload: { rechunked: false },
    });
    await waitFor(() => sentFor(updated.docId).length >= 1, 'doc_updated delivery');
    const [notification] = sentFor(updated.docId);
    expect(notification.category).toBe(NOTIFY_CATEGORY.DOC_UPDATED);
    expect(notification.title).toBe(`[文档更新] ${updated.path}`);
    // v2 归属：正文 = `空间「<空间名>」 · <文档标题>`（spaceId 取自 doc 行，非事件载荷）
    expect(notification.body).toBe(`空间「ntfp space ${RUN}」 · ${updated.title}`);
    expect((await waitForDeliveryRows(updateEvent))[0]).toMatchObject({
      category: NOTIFY_CATEGORY.DOC_UPDATED,
      status: 'success',
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑫ doc_deleted 整空间删除（A1 回归守卫：space 行已软删仍须取到空间名）
  // ══════════════════════════════════════════════════════════════════

  it('⑬ doc_deleted 整空间删除：doc 行与 space 行同批软删 ⇒ 空间名仍取到（不是 `?`）', async () => {
    if (!dbAvailable) return;
    const { docId, path, title, spaceId, spaceName } = await createDoc('space-delete');

    // 复刻 `docspace.service.ts` `remove()` 的**真实时序**：同一事务里先软删空间内全部 doc、
    // 再软删 space 行，之后才逐条 emit `DOC_DELETED`（见该 service 的 transaction 块）。
    // ⚠️ 走裸 SQL 而非 repo.softDelete：这里要模拟的是"行已软删"这一**事实**，裸 UPDATE 最直白，
    //    也不依赖实体侧的软删 API。
    await ds.query(`UPDATE docs SET deleted_at = NOW() WHERE id = $1`, [docId]);
    await ds.query(`UPDATE doc_spaces SET deleted_at = NOW() WHERE id = $1`, [spaceId]);

    const eventId = await emit({
      eventType: EventType.DOC_DELETED,
      resourceType: ResourceType.DOC,
      resourceId: docId,
      // 同上：操作者不能是本套件收件人名下的 agent
      actorId: foreignAgentId,
      payload: { spaceId, docId, path, title },
    });

    await waitFor(() => sentFor(docId).length >= 1, 'doc_deleted (space soft-deleted) delivery');
    const [notification] = sentFor(docId);
    expect(notification.category).toBe(NOTIFY_CATEGORY.DOC_DELETED);
    expect(notification.title).toBe(`[文档删除] ${path}`);
    // 关键断言：渲染层若退回**不带 `withDeleted`** 的查询，真 PG 会因 `@DeleteDateColumn`
    // 过滤而恒 null ⇒ 这里会变成 `空间「?」 · <title>`（A1 的回归守卫）。
    expect(notification.body).toBe(`空间「${spaceName}」 · ${title}`);
    expect((await waitForDeliveryRows(eventId))[0]).toMatchObject({
      category: NOTIFY_CATEGORY.DOC_DELETED,
      status: 'success',
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑰ 系统告警全链路（路线 B：admin 账号渠道 + `system_alert` 终态行）
  // ══════════════════════════════════════════════════════════════════

  it('⑰ system_alert：sendSystemAlert 走真库 ⇒ 真终态行（event_id=null）+ 固定运维页深链', async () => {
    if (!dbAvailable) return;

    // ① 收件人 = **admin 账号**（不是本套件的 owner）。唯一索引 `idx_unique_admin` 决定
    //    "不能建第二个 admin" ⇒ 库里已有就复用，没有才补种（补种行 afterAll 按 id 删）。
    const admins = (await ds.query(
      `SELECT u.id, a.status, a.deleted_at AS "deletedAt"
         FROM users u JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' LIMIT 1`,
    )) as Array<{ id: string; status: string; deletedAt: string | null }>;
    let adminId = admins[0]?.id;
    let adminUnusable =
      admins.length > 0 && (Boolean(admins[0].deletedAt) || admins[0].status !== 'active');
    if (!adminId) {
      const adminActor = await ds.getRepository(Actor).save(
        ds.getRepository(Actor).create({
          type: ActorType.HUMAN,
          displayName: `Ntfp Admin ${RUN}`,
          status: AgentStatus.ACTIVE,
        }),
      );
      created.actorIds.push(adminActor.id);
      const admin = await ds.getRepository(User).save(
        ds.getRepository(User).create({
          id: adminActor.id,
          actor: adminActor,
          username: `ntfpa${RUN}`.slice(0, 50),
          email: `ntfp-admin-${RUN}@example.com`,
          authProvider: 'local',
          role: UserRole.ADMIN,
          preferences: {},
        }),
      );
      created.userIds.push(admin.id);
      adminId = admin.id;
      adminUnusable = false;
    }

    // ② 该 admin 的 eligible 渠道（谓词与生产单源一致）：有就复用，没有才补种
    let targetAddress: string | null = null;
    if (!adminUnusable) {
      const channels = (await ds.query(
        `SELECT recipient_address FROM user_notification_channels
          WHERE user_id = $1 AND enabled = TRUE AND unbound_at IS NULL
            AND last_test_status IN ('ok', 'seeded')
          ORDER BY created_at ASC LIMIT 1`,
        [adminId],
      )) as Array<{ recipient_address: string }>;
      targetAddress = channels[0]?.recipient_address ?? null;
      if (!targetAddress) {
        targetAddress = `ou_sysalert_${RUN}`;
        const inserted = (await ds.query(
          `INSERT INTO user_notification_channels
             (user_id, provider, recipient_address, enabled, last_test_status, last_test_address, source)
           VALUES ($1, 'feishu', $2, TRUE, 'ok', $2, 'user')
           RETURNING id`,
          [adminId, targetAddress],
        )) as Array<{ id: string }>;
        created.notificationChannelIds.push(inserted[0].id);
      }
    }

    // 标题带 RUN：afterAll 靠它精确删本用例写下的终态行
    const title = `[engine alert] arm=auth consecutive=3 ${RUN}`;
    const body = [
      `workspace=demo ${RUN}`,
      'engineCode=quota_exceeded',
      '处置：检查引擎凭据与配额',
      '恢复：本通知为恢复确认，无需处置。',
    ].join('\n');

    const outcome = await orchestrator.sendSystemAlert({
      source: 'memory-engine',
      kind: 'alert',
      arm: 'auth',
      title,
      body,
      occurredAt: new Date().toISOString(),
    });

    if (adminUnusable) {
      // 环境里唯一的 admin 已被软删（唯一索引不许再建第二个）⇒ 只断言**断态不落表**
      expect(outcome).toBe('admin_soft_deleted');
      expect(fakeProvider.sent.filter((item) => item.category === 'system_alert')).toHaveLength(0);
      return;
    }

    expect(outcome).toBe('delivered');

    // 出境面：category / 固定运维页（`/memory`）/ 收件人 = admin 的渠道地址
    const alerts = fakeProvider.sent.filter(
      (notification) => notification.category === 'system_alert',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eventId: null,
      recipient: targetAddress,
      link: `${WEB_BASE}/memory`,
    });
    // 正文宽度（1000）保住了处置/恢复指引——复用 200 会切掉这两行
    expect(alerts[0].body).toContain('处置：');
    expect(alerts[0].body).toContain('恢复：');

    // 终态行：`event_id = NULL`（告警没有事件源）、attempts ≥ 1、归属 = admin
    const rows = (await ds.query(
      `SELECT category, status, attempts, event_id AS "eventId",
              recipient_user_id AS "recipientUserId"
         FROM notification_deliveries WHERE title = $1`,
      [title],
    )) as Array<{
      category: string;
      status: string;
      attempts: number;
      eventId: string | null;
      recipientUserId: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'system_alert',
      status: 'success',
      eventId: null,
      recipientUserId: adminId,
    });
    expect(rows[0].attempts).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑱ `admin_soft_deleted` 可达性（真软删 actor + 真 PG；review S3）
  // ⚠️ 本用例持有「全局唯一 admin 的软删窗口」（~10-50ms）：并行 e2e worker（maxWorkers: 2）
  // 若恰在窗口内于 beforeAll 查 `deleted_at IS NULL` 的 admin，可能 401 或撞 idx_unique_admin。
  // 窗口已压到最小 + finally 按原值还原；属「测唯一 admin 断态」的固有待价。
  // ══════════════════════════════════════════════════════════════════

  it('⑱ admin_soft_deleted：真软删 admin 的 actor ⇒ 断态可命中、零出境、零新增行（finally 还原）', async () => {
    if (!dbAvailable) return;

    // ① 取得唯一 admin（`idx_unique_admin` 只允许一个）。没有才补种；**不新建第二个 admin**。
    const admins = (await ds.query(
      `SELECT u.id, a.deleted_at AS "deletedAt"
         FROM users u JOIN actors a ON a.id = u.id
        WHERE u.role = 'admin' LIMIT 1`,
    )) as Array<{ id: string; deletedAt: string | null }>;
    let adminId = admins[0]?.id ?? null;
    let originalDeletedAt: string | null = admins[0]?.deletedAt ?? null;

    if (!adminId) {
      const adminActor = await ds.getRepository(Actor).save(
        ds.getRepository(Actor).create({
          type: ActorType.HUMAN,
          displayName: `Ntfp SoftDelete Admin ${RUN}`,
          status: AgentStatus.ACTIVE,
        }),
      );
      created.actorIds.push(adminActor.id);
      const admin = await ds.getRepository(User).save(
        ds.getRepository(User).create({
          id: adminActor.id,
          actor: adminActor,
          username: `ntfpsd${RUN}`.slice(0, 50),
          email: `ntfp-softdelete-${RUN}@example.com`,
          authProvider: 'local',
          role: UserRole.ADMIN,
          preferences: {},
        }),
      );
      created.userIds.push(admin.id);
      adminId = admin.id;
      originalDeletedAt = null;
    }

    // 本用例的标题带 RUN ⇒ 计数与 afterAll 清理都可精确定位
    const title = `[engine alert] soft-deleted admin ${RUN}`;
    const countRows = async (): Promise<number> => {
      const result = (await ds.query(
        `SELECT count(*)::int AS n FROM notification_deliveries
          WHERE category = 'system_alert' AND title = $1`,
        [title],
      )) as Array<{ n: number }>;
      return result[0].n;
    };
    const beforeRows = await countRows();

    try {
      // ② **真软删**：直接 UPDATE `deleted_at`（与 `@DeleteDateColumn` 的落库形态一致，
      //    不依赖实体 API 的级联语义——本用例要测的正是"库里那一列真的变了"之后的行为）。
      await ds.query(`UPDATE actors SET deleted_at = NOW() WHERE id = $1`, [adminId]);

      // ③ 顺带核实 TypeORM 行为前提：eager 关系对软删 relation 置 null。
      //    若这条前提漂移（或哪处查询加了 withDeleted），`admin_soft_deleted` 分支会**静默不可达**、
      //    告警继续发往已删账号——这正是 S3 要防的缺陷，故这里先把它钉死。
      const adminUser = await ds.getRepository(User).findOne({ where: { role: UserRole.ADMIN } });
      expect(adminUser).not.toBeNull();
      expect(adminUser?.actor ?? null).toBeNull();

      // ④ 运行时断态：不投递、不落表
      const outcome = await orchestrator.sendSystemAlert({
        source: 'memory-engine',
        kind: 'alert',
        arm: 'availability',
        title,
        body: 'workspace=demo\n处置：无需处置（账号已删）',
        occurredAt: new Date().toISOString(),
      });
      expect(outcome).toBe('admin_soft_deleted');
      expect(fakeProvider.sent.filter((item) => item.category === 'system_alert')).toHaveLength(0);
      expect(await countRows()).toBe(beforeRows);
    } finally {
      // ⑤ **必须还原现场**：唯一索引只允许一个 admin，不能靠"再建一个"绕过；
      //    并发套件可能正在读 admin（还原到**原始值**而不是硬置 null）。
      await ds.query(`UPDATE actors SET deleted_at = $2 WHERE id = $1`, [
        adminId,
        originalDeletedAt,
      ]);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // ⑪ 终态不变量（本套件写下的每一行）
  // ══════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════
  // ⑮⑯ 多用户端到端（批 2 棒 B：per-user 偏好 / 逐用户 L1 窗口 / 各自的投递地址）
  // ══════════════════════════════════════════════════════════════════

  it('⑮ 多用户各自偏好：同一事件 owner 收、第二个人不收（他关掉了 task_done）', async () => {
    if (!dbAvailable) return;
    const { boardId, taskId } = await createBoardChain('multi-pref');
    // ⚠️ 第二个人必须**也进这张看板的成员表**：否则"他没收到"是被**注意力层**挡掉的
    // （open 看板人人可读，但只有成员/creator/被指派者才该被打扰），那就不是在测偏好层了。
    await ds.getRepository(BoardMember).save(
      ds.getRepository(BoardMember).create({
        boardId,
        actorId: secondUserId,
        role: 'viewer',
        invitedBy: agentAId,
      }),
    );

    await req().patch(`/tasks/${taskId}`).send({ status: TaskStatus.DONE }).expect(200);

    await waitFor(() => sentFor(taskId).length >= 1, 'multi-user task_done delivery');
    // 等够（负向断言：第二个人**不该**有第二条）——抑制走的是"无 DB 查询的早退"，ms 级完成
    await settle();
    const delivered = sentFor(taskId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].recipient).toBe(RECIPIENT);
  });

  it('⑯ 逐用户 L1 / L2：同一个话题两人都开 ⇒ **各收一条、各发各的地址**（窗口不互相压制）', async () => {
    if (!dbAvailable) return;
    const thread = await createTopicThread('multi-topic', {
      ownerStatus: ParticipantStatus.ACTIVE,
    });
    // 第二个人也进这个话题（active + joinedAt，见 topic_participants 的 DB CHECK）
    await ds.getRepository(TopicParticipant).save(
      ds.getRepository(TopicParticipant).create({
        topicId: thread.topicId,
        participantId: secondUserId,
        role: 'member',
        status: ParticipantStatus.ACTIVE,
        joinedAt: new Date(),
        leftAt: null,
        notificationSettings: { mute: false, mentions_only: false },
      }),
    );

    await emit({
      eventType: EventType.NEW_MESSAGE,
      resourceType: ResourceType.MESSAGE,
      resourceId: thread.messageId,
      topicId: thread.topicId,
      actorId: otherActorId,
      actorType: ActorType.HUMAN,
      payload: { messageId: thread.messageId, type: MessageType.CHAT },
    });

    // 两人各一条——这同时是**逐用户 L1 窗口**的端到端证据：共享一个 `topic:<id>` 窗口时，
    // 第一个人会把这个窗口占掉，第二个人一条都收不到（而日志上表现为正常的 l1_throttle）。
    await waitFor(() => sentFor(thread.topicId).length >= 2, 'both recipients');
    const recipients = sentFor(thread.topicId)
      .map((notification) => notification.recipient)
      .sort();
    expect(recipients).toEqual([RECIPIENT, SECOND_RECIPIENT].sort());
  });

  it('⑭ 终态不变量：本套件写下的每一行 status ∈ {success, failed} 且 attempts ≥ 1', async () => {
    if (!dbAvailable) return;
    const rows = (await ds.query(
      `SELECT status, attempts FROM notification_deliveries WHERE recipient = $1`,
      [RECIPIENT],
    )) as Array<{ status: string; attempts: number }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['success', 'failed']).toContain(row.status);
      expect(row.attempts).toBeGreaterThanOrEqual(1);
    }
  });
});
