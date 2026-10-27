/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块（外部 IM 通知出口，一期）投递记录：**只落终态**（success / failed）的
 *     append-only 行——"这条通知到底有没有发出去"的唯一事实来源（admin 只读列表端点的数据面）。
 *
 * [代码职责]
 *   - `notification_deliveries` 表逐列定义（**无 updated_at**：一行只写一次，终态不可变）
 *   - `NOTIFICATION_DELIVERY_STATUSES`：`status` 列值域单源（`success` | `failed`，**无 pending**）
 *   - `NotificationDeliveryStatus` 类型导出（写路径与 admin 过滤共用）
 *   - `SYSTEM_ALERT_DELIVERY_CATEGORY`：系统告警（运维类别）的专用 `category` 值（见该常量注释）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §6 数据层（逐列契约 + 索引清单 +
 *     漂移预测协议）/ §3 直发链路与事件链路（event_id 的两种取值的出处）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/spec.md` /
 *     `docs/api-definition.md`（admin 列表端点 + 抑制类不落表的边界声明）；落点后本定位符改为
 *     线上文档。
 *
 * [关键不变量]
 *   - **只落终态**：`status ∈ {success, failed}`，**没有 `pending`**。抑制类事件（自回声 /
 *     类别关 / L1 / L2 命中）**完全不落表**——它们不是"投递"，只是"没投递"。语义后果：
 *     "表里没有" ≠ "通知没发生过"，排障必须靠发送前 INFO（category + eventId 对账锚点）
 *     与连续 failed 的周期 warn（见 orchestrator 文件头）。admin 端点文档必须写明这条边界。
 *   - **`event_id` 无 FK（刻意）**：弱关联。事件表按游标长期留存但**不保证与投递行同生命周期**
 *     （投递记录可能被 retention 清理、事件行可能因运维 SQL 处置）——日志类行不建 FK 是本仓
 *     既有纪律（同 `memory_formation_events` / `experience_judgments` 先例）。**不做 `@ManyToOne`**：
 *     关系只用在查询里显式 join，不引入 ORM 级联语义。
 *   - **`event_id` 为 NULL 的合法场景有三个**：① 直发端点（`category='direct'`，没有事件源）；
 *     ② L2 超额摘要（`category='digest'`，聚合多个事件、不属于任何一个）；③ 系统告警
 *     （`category='system_alert'`，由运行期健康状态触发、没有平台事件行）。事件链路的九个
 *     可开关类别**必须带 eventId**——这条区分让"事件触发的通知"在数据面可分辨。
 *   - **`category` 值域有四个来源**：可开关类别单源 = `config/notifications.config.ts` 的
 *     `NOTIFY_CATEGORIES`；外加本文件声明的 `DIGEST_DELIVERY_CATEGORY`（L2 摘要专用，
 *     刻意不进前者——它不是用户能开关的东西，见该常量注释）、`DIRECT_TEST_DELIVERY_CATEGORY`
 *     （test 端点的验证投递，plan §D5；同样不进前者）与 `SYSTEM_ALERT_DELIVERY_CATEGORY`
 *     （系统告警，运维类别、用户不可静音；同样不进前者）。四个来源都**只在真实出境后落行**。
 *     config 侧只 `import type`
 *     （**编译期擦除，零运行期耦合**——实体文件不得成为 config 工厂的运行期依赖，
 *     否则 entities barrel 的 require 会拖进整个 ConfigModule）。
 *   - **`attempts` 恒 ≥ 1**（DB `DEFAULT 1` + 实体 `default: 1`）：投递行只在**有过投递尝试**时
 *     才产生，0 次尝试的行不存在。e2e 不变量断言 `attempts >= 1`。
 *   - **`last_error` 截断 500 字符且不回显 secret**：写入侧负责截断（本列宽度是 text，截断是
 *     **应用层契约**——provider 错误文案可能夹带 token / 响应体原文，见 provider 工厂文件头）。
 *   - **唯一索引 = `idx_notification_deliveries_created`**：与 migration 裸 SQL **同名**声明
 *     （`@Index('idx_...', [...])`）——否则漂移门禁会把它判成"实体未建模"的裸 SQL 产物落进
 *     [B] 段（memory 批 7 条 DROP INDEX 同源）。**无查询路径就不补第二个索引**（plan §6 契约）。
 *   - **本表无 `deleted_at` / 无 `updated_at`**：append-only 终态行。retention 清理是**删除**行
 *     （见 plan §11 的 TODO），不是软删。
 *
 * [关联代码]
 *   - database/migrations/1792100000000-AddNotificationsModule.ts — 建表 + 唯一索引（裸 SQL，逐列镜像本文件）
 *   - config/notifications.config.ts — `NOTIFY_CATEGORIES`（`category` 列落库值域的单源）
 *   - modules/notifications/notify-orchestrator.service.ts — 事件链路写路径（终态落库）
 *   - modules/notifications/notify-delivery.repository.ts — 投递记录写入与 admin 列表读（唯一入口）
 *   - database/entities/index.ts — barrel 注册（glob 自动加载，barrel 供 e2e 断言一致性）
 *   - test/notifications-schema.e2e-spec.ts — 逐列对齐 / PK 默认值 / 列级默认值 / indexdef / barrel↔glob 守卫（S6 批次）
 *
 * [持久踩坑]
 *   NOTIFY-DELIVERY-SILENT-GAP(表里没有 ≠ 没发生): 只落终态意味着抑制类事件在数据面**完全不可见**。
 *     若把"查投递记录"当成排障唯一手段，会得出"通知从来没触发过"的错误结论。安全方向:
 *     发送前 INFO 对账锚点（category + eventId，可 grep）+ 连续 5 条 failed 周期 warn +
 *     admin 端点文档写明此边界。
 *   NOTIFY-LAST-ERROR-ECHO(错误原文夹带凭据): 上游（飞书）错误体可能回显 token 片段或请求原文。
 *     安全方向: 写入侧截断 500 字符 + provider 层只落"错误码与短描述"，**绝不落响应体原文**。
 *
 * [铁律关联] #11(注释强制) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 加列 / 改列必须同步 migration（本表所有 DDL 都是手写裸 SQL）与 test/notifications-schema.e2e-spec.ts（S6 批次，逐列对齐 + 列级默认值守卫）
 *   □ 新增 `@Index` 必须与 migration 的索引**同名**（否则漂移门禁落 [B] 段）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { NotifyCategory } from '../../config/notifications.config';

/**
 * 投递状态值域（**单源**：写路径落库判定 + admin 列表端点 `status` 过滤的 `@IsIn` 白名单）。
 *
 * **无 `pending`**（刻意）：投递行只在拿到 provider 终态之后写——两态闭合让"查得到 = 已收口"，
 * 若引入 pending 就必须同时引入超时收敛器（一期不做，代价是崩溃即丢，见 plan §3）。
 */
export const NOTIFICATION_DELIVERY_STATUSES = ['success', 'failed'] as const;

/** 投递状态类型（`status` 列的落库值域） */
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/**
 * L2 超额摘要的专用 `category` 值（**刻意不在 `NOTIFY_CATEGORIES` 里**）。
 *
 * rationale：摘要不是"可开关的通知类别"——它是节流机制的产物（用户开不了也关不掉它，
 * 关掉节流才会让它消失）。把它塞进 `NOTIFY_CATEGORIES` 会让用户在 `.env.example` 里
 * 看到一个能"启用/禁用"的假开关。故它是本列的**第二个合法来源**，单独在此声明。
 *
 * 为什么摘要要落库（而不是只打日志）：本表的存在意义 = **出境审计**（"我们发给你看过什么"）。
 * 摘要确实出境了，不记 = 审计面留一个洞。
 */
export const DIGEST_DELIVERY_CATEGORY = 'digest';

/**
 * test 端点的专用 `category` 值（**刻意不在 `NOTIFY_CATEGORIES` 里**）。
 *
 * rationale：`POST /notification-settings/me/channels/:provider/test` 是**用户主动发起的
 * 一次验证投递**，不是事件触发、也不是 agent 直发——它是本列的**第三个来源**（plan §D5）。
 * 不并入 `direct` 是让运维/用户能区分"测试消息"与"agent 直发"，两者排障动作完全不同。
 */
export const DIRECT_TEST_DELIVERY_CATEGORY = 'direct_test';

/**
 * 系统告警的专用 `category` 值（**刻意不在 `NOTIFY_CATEGORIES` 里**）。
 *
 * rationale：`system_alert` 是**运维类别**，不是"用户能开关的通知类别"（路线 B：
 * `NotifyOrchestrator.sendSystemAlert()` 收件人 = admin 账号绑定的渠道；不进设置页、用户不可静音）。
 * 把它塞进 `NOTIFY_CATEGORIES` 会让用户在 `.env.example` / 偏好接口里看到一个能关掉系统告警的
 * 假开关——那等于给"平台自己病了而没人知道"开一条静默通道。故它是本列的**第四个合法来源**。
 *
 * 本类别同样**只在真实出境后落行**（`attempts ≥ 1` 的终态审计语义不变）：`disabled` /
 * `no_admin` / `no_channel` / `rate_limited` 等**未投递路径一律不落表**——它们的证据是日志
 * （`grep "system_alert"`），不是投递记录。
 */
export const SYSTEM_ALERT_DELIVERY_CATEGORY = 'system_alert';

/** `category` 列的完整落库值域（可开关类别 ∪ L2 摘要 ∪ test 端点验证投递 ∪ 系统告警） */
export type NotificationDeliveryCategory =
  | NotifyCategory
  | typeof DIGEST_DELIVERY_CATEGORY
  | typeof DIRECT_TEST_DELIVERY_CATEGORY
  | typeof SYSTEM_ALERT_DELIVERY_CATEGORY;

/**
 * 通知投递记录（**append-only 终态行**；见文件头 [关键不变量]）。
 *
 * 为什么这张表存在（而不是只打日志）：投递是**出境**行为，用户有权知道"发出去过什么、
 * 成功没有、失败原因是什么"。日志会被轮转、grep 会漏，只有表能支撑 admin 只读列表。
 */
@Entity('notification_deliveries')
@Index('idx_notification_deliveries_created', ['createdAt'])
// Notifications 二期（多用户化）：按平台用户过滤投递记录（admin 列表新参数 recipientUserId）。
// ⚠️ 索引名必须与 migration `1792200000000` 的裸 SQL **逐字相同**（见文件头不变量）。
@Index('idx_notification_deliveries_recipient_user', ['recipientUserId'])
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 出口渠道 = provider key（一期恒 `feishu`）。
   *
   * 宽 30 与 `recipient` 的宽 255 一起为多 provider（email / slack）预留——新增 provider 叶子
   * 只加值不加列。
   */
  @Column({ type: 'varchar', length: 30, nullable: false })
  channel: string;

  /** 收件人地址（飞书 = open_id；email / slack 预留同一列，宽度 255） */
  @Column({ type: 'varchar', length: 255, nullable: false })
  recipient: string;

  /**
   * 通知类别（值域单源 = `NOTIFY_CATEGORIES` ∪ 本文件三个专用类别常量；见文件头不变量）。
   *
   * `direct` 是唯一 `eventId` 为 NULL 的**可开关**类别（直发端点无事件源）；
   * `digest`（L2 超额摘要）与 `system_alert`（系统告警）同样 `eventId` 为 NULL
   * （前者聚合多个事件、后者由运行期健康状态触发，都不属于任何事件行）。
   */
  @Column({ type: 'varchar', length: 30, nullable: false })
  category: NotificationDeliveryCategory;

  /**
   * 触发本通知的事件 ID（**无 FK**，弱关联；直发为 NULL）。
   *
   * 用途：与发送前 INFO（对账锚点）配对，把"日志里看到的一次发送"钉到"表里的这一行"。
   */
  @Column({ type: 'uuid', nullable: true, name: 'event_id' })
  eventId: string | null;

  /** 通知标题（已渲染：如 `[完工] <任务标题>`；≤200 字符由渲染层保证） */
  @Column({ type: 'varchar', length: 200, nullable: false })
  title: string;

  /** 通知正文（渲染层已截断摘要 + 深链；直发为 agent 自填正文） */
  @Column({ type: 'text', nullable: false })
  body: string;

  /**
   * 投递终态（`success` | `failed`；值域单源见文件头）。
   * 无默认值——每次投递必须显式写出结果（缺省会让"未写"与"success"混淆）。
   */
  @Column({ type: 'varchar', length: 20, nullable: false })
  status: NotificationDeliveryStatus;

  /** 投递尝试次数（**恒 ≥ 1**；指数退避重试后记实际尝试数） */
  @Column({ type: 'int', nullable: false, default: 1 })
  attempts: number;

  /** 失败原因（成功恒 NULL；**截断 500 字符且绝不回显 secret**，见文件头不变量） */
  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  /** provider HTTP 响应状态码（网络层失败 / 未拿到响应时为 NULL） */
  @Column({ type: 'int', nullable: true, name: 'response_status' })
  responseStatus: number | null;

  /** 落库时刻（本表**只有** created_at：append-only 无更新语义） */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** 送达时刻（success 时写入；failed 恒 NULL——"失败"没有送达时刻） */
  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  deliveredAt: Date | null;

  /**
   * 这条投递属于哪个平台用户（**`users.id` = `actors.id`**；NULL = 存量行 / 无法归属）。
   *
   * 用途：多用户化后 admin 列表按用户过滤（`GET /notifications/deliveries?recipientUserId=`），
   * 让运维能查"某个人收到过什么"。**无 FK**（同 `event_id`：投递记录是排障证据，必须比用户行
   * 活得久——用户被硬删后记录仍应回答"我们向他发过什么"）。
   *
   * ⚠️ 值域：批 1 仅 test 端点路径落值；编排器 deliver / L2 摘要 / 直发三路径是**批 2**
   * （`RecordDeliveryInput` 扩展也在批 2）。故本列在批 1 之后仍可能大量为 NULL——那是
   * "尚未归属"而非"不属于任何人"。
   */
  @Column({ type: 'uuid', nullable: true, name: 'recipient_user_id' })
  recipientUserId: string | null;
}
