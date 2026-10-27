/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期（多用户化）的**渠道绑定表**：`user_notification_channels` 逐行 = 一个
 *     平台用户对某个 IM provider 的绑定（open_id + 启用态 + 验证锚点 + tombstone 解绑）。
 *     把通知出口从"部署级单 Owner"演进为"per-user 渠道绑定"的数据面底座。
 *
 * [代码职责]
 *   - `user_notification_channels` 表逐列定义（**含 FK `users.id ON DELETE CASCADE`**）
 *   - `USER_NOTIFICATION_CHANNEL_SOURCES` / `USER_NOTIFICATION_CHANNEL_TEST_STATUSES`：
 *     两个值域列的单源常量（写入路径与读取归一都引用它）
 *   - **`DELIVERY_ELIGIBLE_LAST_TEST_STATUSES` + `deliveryEligibleWhere()`**：
 *     **deliveryEligible 谓词的单源**（`enabled=true ∧ unbound_at IS NULL ∧
 *     last_test_status IN ('ok','seeded')`）——四处复用（候选查询 / test 前置判定 /
 *     零绑定锚点计数 / 批 2 的直发 `recipient_not_bound` 判定），见下方常量注释
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/spec.md` §3.2.33（数据模型逐列 + partial unique + tombstone + FK）/
 *     `docs/api-definition.md` §20.3（路由语义与六端点，deliveryEligible 单源）/
 *     skill `notifications/feishu-setup.md` §4（播种语义）
 *
 * [关键不变量]
 *   - **建模 (b)：`@ManyToOne` + `@JoinColumn({ foreignKeyConstraintName })` 逐字同名**：
 *     裸 SQL 里 FK 约束名是 `user_notification_channels_user_id_fkey`，实体必须**同名**声明，
 *     否则漂移门禁会把裸 SQL 的 FK 判成"实体未建模"落 [B] 段（对照 memory 批 2 条 DROP CONSTRAINT）。
 *   - **索引刻意零 `@Index`**（照 memory 批先例）：两条唯一索引里有一条是**部分唯一**
 *     （`WHERE unbound_at IS NULL AND last_test_status='ok'`）——TypeORM 元数据**表达不了谓词**，
 *     建模只会让"谓词丢了"成为不可见盲区。两条都裸 SQL + 不建模 ⇒ 落 [B] 段可见（迁移头已点名）。
 *     谓词由 `test/user-notification-channels-schema.e2e-spec.ts` 的 indexdef 断言守卫。
 *   - **`enabled` 的语义不是"用户想不想收"，而是"这个地址可用吗"**：置 `true` 有一个**服务端
 *     不变量**——`last_test_address = recipient_address ∧ last_test_status ∈ ('ok','seeded')`
 *     （见 notification-settings.service.ts 的 PUT 条件更新）。**"未验证"是 UI 陈述，不是投递闸门**
 *     ——但"置 true 却从没验证过"必须被服务端拒绝（否则用户以为开了、实际永远不投递）。
 *   - **`seeded` = 投递可信但徽标不冒充已验证**：D4 播种行写 `last_test_status='seeded'` +
 *     `last_test_address=recipient_address`（**播种行同样满足验证不变量**，否则升级日"已配
 *     RECIPIENT_OPEN_ID"的用户会被自己的验证门挡在门外——静默全灭）。
 *   - **`unbound_at` 是 tombstone、不是软删**：解绑置 `unbound_at=now`（不真删）。真删会让
 *     播种判据"该 user 无任意 feishu 行"在下一次进程重启时**重新成立 ⇒ 复活已解绑的绑定**
 *     （D4「解绑不复活」的唯一实现方式）。tombstone 行对用户不可见（GET 过滤 + DELETE 404）。
 *   - **`source` 不参与任何判据**（`env_seed` 只是"从哪来的"标签）：播种判据用**单调事实**
 *     「该 user 无任意 feishu 行（含 tombstone）」，不用会被业务动作覆写的 `source`
 *     （用户改一下地址就把 `source` 从 `env_seed` 覆写为 `user`，判据若依赖它就会二次播种）。
 *   - **FK `ON DELETE CASCADE` 永不触发**（用户软删在 `actors.deleted_at`，`users` 无
 *     `deleted_at` 列）：实际失效路径 = 候选查询显式过滤 `actor.deleted_at IS NULL`。
 *     FK 只是把"渠道绑定是用户私有数据"的语义显式化（admin DB 硬删用户时连带清理）。
 *   - **无 `deleted_at`**：解绑语义已由 `unbound_at` 承担，再加软删列会造出两个"不活跃"信号
 *     （哪个为准？）——`unbound_at` 是唯一真相。
 *
 * [关联代码]
 *   - database/migrations/1792200000000-AddNotificationChannels.ts — 建表迁移（逐列镜像本文件）
 *   - database/entities/index.ts — barrel 注册（glob 自动加载，barrel 供 e2e 断言一致性）
 *   - database/entities/user.entity.ts — FK 目标（`users.id`）
 *   - modules/notifications/notification-settings.service.ts — 六端点的服务侧（本实体的主写路径）
 *   - modules/notifications/notify-orchestrator.service.ts — 播种（D4）写路径 + 批 2 的候选查询
 *   - config/notifications.config.ts — `NOTIFY_PROVIDER_TOKENS`（`provider` 列落库值域单源）
 *   - test/user-notification-channels-schema.e2e-spec.ts — 逐列 / PK 默认值 / 部分唯一谓词 / FK 守卫
 *
 * [持久踩坑]
 *   NOTIFY-CHANNEL-VERIFY-BYPASS(验证门被绕过): 若置 `enabled=true` 时不校验验证态，用户会
 *     "看起来开好了"而实际永远不投递（或反之：未验证地址也投递 = 拿一个可能不是自己的地址当出口）。
 *     安全方向: 置 true 走**条件更新**（`WHERE last_test_address=recipient_address AND
 *     last_test_status IN ('ok','seeded')`），不满足返回 400；播种行写全 `last_test_address`。
 *   NOTIFY-CHANNEL-TOMBSTONE-REVIVE(解绑复活): 真删行会让播种判据在重启后重新成立。
 *     安全方向: tombstone（`unbound_at`）——判据"无任意 feishu 行"对 tombstone 行恒假。
 *
 * [铁律关联] #11(注释强制) #18(不变量检查) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 加列 / 改列必须同步 migration（本表 DDL 全是手写裸 SQL）与 schema e2e
 *   □ 新增值域必须同 commit 改本文件的常量数组与读取归一
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * `source` 列的值域：这条绑定**从哪来的**（`env_seed` = D4 从部署 env 播种 / `user` = 用户自建）。
 *
 * ⚠️ **不参与任何判据**（见文件头不变量）：播种判据用"该 user 无任意 feishu 行"这一单调事实，
 * 因为 `source` 会被用户改地址这一业务动作覆写（`user` 覆盖 `env_seed`）——依赖它做判据
 * 会在"用户改过地址"之后二次播种。
 */
export const USER_NOTIFICATION_CHANNEL_SOURCES = ['env_seed', 'user'] as const;

/** `source` 列类型 */
export type UserNotificationChannelSource = (typeof USER_NOTIFICATION_CHANNEL_SOURCES)[number];

/**
 * `last_test_status` 列的值域（`ok` | `failed` | `seeded`；NULL = 从未测试过）。
 *
 * - `ok`：测试消息**确认送达**（地址可用，占地址槽）；
 * - `failed`：测试消息**地址相关失败**（写态纪律：只有 `delivery_failed` 落 failed——配置 /
 *   限流类 reason 不写验证态，那是"此刻的运维状态"不是"这个地址的判决"）；
 * - `seeded`：D4 播种行——投递可信（地址来自可信部署配置）但**徽标不冒充已验证**，
 *   UI 渲染成「已导入·未验证」。`seeded` 与 `ok` 同属投递资格（见 deliveryEligible）。
 */
export const USER_NOTIFICATION_CHANNEL_TEST_STATUSES = ['ok', 'failed', 'seeded'] as const;

/** `last_test_status` 列类型 */
export type UserNotificationChannelTestStatus =
  (typeof USER_NOTIFICATION_CHANNEL_TEST_STATUSES)[number];

/**
 * **deliveryEligible 谓词的测试态分量**（单源；配合 `enabled=true` 与 `unbound_at IS NULL`）。
 *
 * `ok` = 测试通过；`seeded` = 部署导入（投递可信）。`failed` 与 NULL 都不具备投递资格——
 * NULL 是"从未测过"（PUT 置 enabled=true 会被服务端不变量拒绝，见文件头），`failed` 是"测过
 * 且失败"。**排除 `failed` 与 NULL 是本谓词的核心**：否则一个地址打错一次仍会持续投递失败。
 *
 * ⚠️ 谓词的**可执行形状**（`deliveryEligibleWhere()`）刻意**不在本文件**：实体文件只允许导出
 * 类（`entities/index.ts` 的 barrel↔glob 守卫按"导出的函数 = 实体类"对账，多导一个函数会让
 * 那条守卫报假阳性）。它住在 `modules/notifications/notification-channel-eligibility.ts`。
 */
export const DELIVERY_ELIGIBLE_LAST_TEST_STATUSES: readonly UserNotificationChannelTestStatus[] = [
  'ok',
  'seeded',
];

/**
 * 用户通知渠道绑定（per-user provider 绑定；见文件头 [关键不变量]）。
 *
 * 为什么这张表存在（而不是继续用部署级 env 单 Owner）：多用户模型下"发给谁"必须由**每个用户
 * 自己的绑定**决定——部署级单值既无法表达"多个用户各自的地址"，也无法表达"用户自己解绑/静音"。
 */
@Entity('user_notification_channels')
export class UserNotificationChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 绑定所属的平台用户（`users.id` = `actors.id`） */
  @Column({ type: 'uuid', nullable: false, name: 'user_id' })
  userId: string;

  /**
   * 关联用户（**FK 建模 (b)**：约束名与裸 SQL 逐字同名 ⇒ 漂移零产物，见文件头不变量）。
   *
   * `onDelete: 'CASCADE'` 只在**硬删** `users` 行时发生（软删在 `actors.deleted_at`，
   * 永不触发 CASCADE）——声明它是为了"渠道绑定随用户消失"的语义显式化。
   */
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'user_notification_channels_user_id_fkey',
  })
  user: User;

  /** 出口 provider（值域单源 = config `NOTIFY_PROVIDER_TOKENS`；一期恒 `feishu`） */
  @Column({ type: 'varchar', length: 30, nullable: false })
  provider: string;

  /** 收件地址（飞书 = open_id；宽度 255 与投递记录 `recipient` 同） */
  @Column({ type: 'varchar', length: 255, nullable: false, name: 'recipient_address' })
  recipientAddress: string;

  /**
   * 该地址是否可用（**缺省 false**；`true` 有服务端不变量，见文件头）。
   *
   * 语义 = "这个地址可用吗"（不是"用户想不想收"）——临时静音走同列的 false，但保留验证态
   * （PUT enabled=false 任意放行；再置 true 时验证态还在 ⇒ 立刻可用）。
   */
  @Column({ type: 'boolean', nullable: false, default: false })
  enabled: boolean;

  /** 最近一次测试消息的发送时刻（从未测试为 NULL） */
  @Column({ type: 'timestamptz', nullable: true, name: 'last_test_at' })
  lastTestAt: Date | null;

  /**
   * 最近一次测试消息的**验证态**（`ok|failed|seeded`；NULL = 从未测试过；值域单源见文件头）。
   *
   * ⚠️ 写态纪律（plan §D5 test 端点）：**只有 `delivery_failed`（地址相关）写 `failed`**；
   * 配置 / 限流类 reason（`no_provider` / `notify_disabled` / `category_disabled` /
   * `rate_limited`）**不写验证态**——"此刻的运维状态 ≠ 这个地址的判决"。
   */
  @Column({ type: 'varchar', length: 20, nullable: true, name: 'last_test_status' })
  lastTestStatus: UserNotificationChannelTestStatus | null;

  /**
   * **验证不变量的 DB 锚点**：通过测试（或播种）时的地址。
   *
   * 置 `enabled=true` 的服务端不变量 = `last_test_address = recipient_address`——地址一变就
   * 清空它（PUT 按地址是否变化分叉：变 ⇒ 清验证态 + 清 tombstone + `source='user'`）。
   * 有了它，"改地址后旧验证态仍然有效"这种绕过验证门的路径不可能存在。
   */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'last_test_address' })
  lastTestAddress: string | null;

  /** 绑定来源（`env_seed|user`；**不参与判据**，见文件头不变量） */
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'user' })
  source: UserNotificationChannelSource;

  /**
   * 解绑时刻（**tombstone**，不真删；NULL = 未解绑；见文件头不变量）。
   *
   * 解绑 = `enabled=false` + `unbound_at=now`；tombstone 行对用户不可见（GET 过滤 / DELETE 404），
   * 但**保留在表里**以让播种判据（"该 user 无任意 feishu 行"）恒假 ⇒ 解绑永不复活。
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'unbound_at' })
  unboundAt: Date | null;

  /** 行创建时刻 */
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  /** 行更新时刻（`@UpdateDateColumn` 由 TypeORM 在 save 时刷新） */
  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
