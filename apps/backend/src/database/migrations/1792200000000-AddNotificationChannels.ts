/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 二期（多用户化）数据层：**渠道绑定表** `user_notification_channels`
 *     （per-user provider 绑定 + tombstone 解绑 + 验证不变量）+ `notification_deliveries`
 *     新增 `recipient_user_id` 归属列与索引。
 *
 * [代码职责]
 *   - 建 1 张表 + 2 条索引 + 1 条 FK（裸 SQL）；`notification_deliveries` 加 1 列 + 1 索引
 *   - 逐列镜像实体 `user-notification-channel.entity.ts`（+ `notification-delivery.entity.ts`
 *     的新列/新索引）
 *   - `down()` 供本仓 migration 往返验证链使用（生产回滚走 DEPLOY.md 的 additive-only 口径）
 *
 * [权威文档]
 *   - 主文档: 线上 `docs/spec.md` §3.2.33（数据模型：逐列契约 / partial unique / tombstone / FK）
 *
 * [关键不变量]
 *   - **手写裸 SQL，禁止裸 `migration:generate` 提交**：`gen_random_uuid()` 默认值 +
 *     **部分唯一索引**（`WHERE ...`）都是 TypeORM 元数据表达不了的形态——generate 会把
 *     部分唯一索引判成"元数据里不存在"而产出 DROP INDEX（本仓 2026-09-17 起禁止裸 generate）。
 *   - **漂移预测（batch 协议，逐条点名；实测必须逐条对齐）**：本迁移的**下游 diff 逐条为**：
 *       ① `DROP INDEX "public"."uq_user_notification_channels_user_provider"`
 *          ← 部分唯一？不——这是**无谓词**的 `UNIQUE(user_id, provider)`，但实体侧**刻意零
 *          `@Index`**（照 memory 批先例：部分索引族一律裸 SQL，实体不建模），故进 [B] 段。
 *       ② `DROP INDEX "public"."uq_user_notification_channels_verified_address"`
 *          ← **部分唯一**（`WHERE unbound_at IS NULL AND last_test_status='ok'`）——TypeORM
 *          元数据**无法表达谓词**，建模只会让谓词成为不可见盲区，故刻意不建模，进 [B] 段。
 *       **不产生**的项（建模到位 ⇒ 零产物，逐条点名）：
 *       - **FK 零产物**：实体用 `@ManyToOne` + `@JoinColumn({ foreignKeyConstraintName:
 *         'user_notification_channels_user_id_fkey' })` **逐字同名**建模 ⇒ 门禁按名字命中
 *         同一约束，不产生 `DROP CONSTRAINT`（对照 memory 批：那批 FK 未建模 ⇒ 2 条 DROP
 *         CONSTRAINT）。约束名必须与下方裸 SQL 逐字相同。
 *       - **`notification_deliveries` 新列/新索引零产物**：`recipient_user_id` 由实体
 *         `@Column({ name: 'recipient_user_id' })` 显式建模；`idx_notification_deliveries_
 *         recipient_user` 由实体**同名** `@Index(...)` 声明 ⇒ 门禁按"表 + 名"命中（照
 *         `idx_notification_deliveries_created` 先例）。
 *       - **PK 不进 diff**（约束支撑索引被排除）——但 `DEFAULT gen_random_uuid()` **进**比对：
 *         实体必须保持 `@PrimaryGeneratedColumn('uuid')`。
 *     **出现任何计划外新增项 = 缺陷**（改迁移或实体去凑，**绝不给基线加豁免行**）。
 *   - **部分唯一的语义（本表的核心防线）**：只有**真正收到过测试消息的地址**才占槽——
 *     未验证 claim 不占槽（防地址预占 griefing）、tombstone 不占槽（地址可释放重绑）。
 *     「占用地址」本身就是归属证明。**没有这条索引，一个未验证的 claim 就能永久占死一个地址**。
 *   - **`unbound_at`（tombstone）而不是真删**：解绑后判据"该 user 无任意 feishu 行"恒假 ⇒
 *     播种永不复活；真删会让播种在下次重启时把已解绑的用户重新绑上（D4「解绑不复活」）。
 *   - **FK `ON DELETE CASCADE` 永不触发**：用户软删在 `actors.deleted_at`（`users` 无
 *     `deleted_at` 列），故 CASCADE 只在**硬删** `users` 行时发生（admin DB 人工窗口）；
 *     实际失效路径 = 候选查询显式过滤 `actor.deleted_at IS NULL`（见 access 剖面方法）。
 *     声明这条 FK 是为了"渠道绑定是用户私有数据、随用户消失"的语义显式化。
 *   - **`source` / `last_test_status` 是值域列**（`env_seed|user` / `ok|failed|seeded`）：
 *     库侧不加 CHECK（本仓值域一律由应用层单源常量守卫，见实体文件头）。
 *
 * [关联代码]
 *   - database/entities/user-notification-channel.entity.ts — 列契约（本迁移逐列镜像）
 *   - database/entities/notification-delivery.entity.ts — 加列的实体侧
 *   - database/entities/index.ts — barrel 注册（glob 自动加载，barrel 供 e2e 断言一致性）
 *   - test/migration-drift-baseline.txt — 漂移基线（本迁移使其 [B] 段 +2 条 DROP INDEX）
 *   - test/user-notification-channels-schema.e2e-spec.ts — 逐列对齐 / PK 默认值 / 列级默认值 /
 *     部分唯一谓词（门禁盲区）/ FK 行为 / barrel↔glob 守卫
 *
 * [持久踩坑]
 *   NOTIFY-PARTIAL-UNIQUE-INFIXED(部分唯一被当全量): TypeORM 的 schema diff **看不见索引谓词**
 *     ——若把部分唯一索引也用 `@Index` 建模（同名同列），门禁会认为它"匹配"、谓词悄悄丢失也不报错。
 *     安全方向: 部分索引一律裸 SQL + 不建模（落 [B] 段可见），谓词由 schema e2e 的 indexdef 断言守卫。
 *
 * [铁律关联] #11(注释强制) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 逐列比对实体与本迁移（列名 / 类型 / 可空 / 默认值 / 索引名 / FK 名）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications 二期建表迁移（plan §D2 逐列契约，additive-only）。
 *
 * 时间戳续 `1792100000000`（保持 1792x 递增序列）：**不能用真实当前毫秒值**——本仓既有迁移的
 * 时间戳是取整递增的"未来"值，用更小的真实时间戳会让本迁移排在既有迁移之前，破坏 TypeORM
 * 的 pending 顺序与迁移链语义。
 *
 * 事务范围（同经验库族 / memory 批纠偏结论）：data-source.ts 未设 `migrationsTransactionMode`，
 * TypeORM 0.3.30 缺省 `'all'` ⇒ 本批 pending 迁移共用同一事务，故 `SET LOCAL
 * lock_timeout = '5s'` **自本迁移起生效到链尾**（有意保护：拿不到锁即 abort，不留长锁队列）。
 * 本迁移对 `notification_deliveries`（存量表）做 ALTER，锁超时尤其重要。
 *
 * down()：**仅本仓往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only 口径
 * （新表无存量读写方，出问题停用代码即可，不回滚 DDL）。`IF EXISTS` 防御保证幂等。
 */
export class AddNotificationChannels1792200000000 implements MigrationInterface {
  name = 'AddNotificationChannels1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表/改表锁 5s 超时（长事务占 ACCESS EXCLUSIVE 锁时放弃而非无限排队）。
    //    ⚠️ SET LOCAL 作用域 = 本批迁移共用的那一个事务（transaction='all'），见文件头。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // =====================================================
    // 2. user_notification_channels（渠道绑定：per-user provider + tombstone 解绑 + 验证锚点）
    //
    // 列契约逐条对应 plan §D2（宽度的 rationale 见实体文件头）：
    // - `id uuid PK DEFAULT gen_random_uuid()`：漏 DEFAULT 会被漂移门禁判成列级漂移。
    // - `user_id uuid NOT NULL` + FK → users(id) ON DELETE CASCADE（约束名两侧逐字相同）。
    // - `provider varchar(30)`：值域单源 = config `NOTIFY_PROVIDER_TOKENS`（一期恒 'feishu'）。
    // - `recipient_address varchar(255)`：open_id（多 provider 预留同宽）。
    // - `enabled bool NOT NULL DEFAULT false`：**缺省关闭**（出境功能唯一可接受缺省）。
    // - `last_test_status varchar(20) NULL`：`ok|failed|seeded`——NULL = 从未测试过。
    // - `last_test_address varchar(255) NULL`：**验证不变量的 DB 锚点**——通过测试时的地址；
    //   置 enabled=true 的服务端不变量 = `last_test_address = recipient_address`。
    // - `source varchar(20) NOT NULL DEFAULT 'user'`：`env_seed|user`。
    // - `unbound_at timestamptz NULL`：**解绑 tombstone**（不真删，见文件头不变量）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE user_notification_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        provider VARCHAR(30) NOT NULL,
        recipient_address VARCHAR(255) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        last_test_at TIMESTAMPTZ,
        last_test_status VARCHAR(20),
        last_test_address VARCHAR(255),
        source VARCHAR(20) NOT NULL DEFAULT 'user',
        unbound_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT user_notification_channels_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // =====================================================
    // 3. 两条唯一索引（**刻意裸 SQL、实体侧不建模**——见文件头漂移预测 ①②）
    //
    // ① `uq_user_notification_channels_user_provider`：一个用户对一个 provider 只有一行
    //    （PUT upsert 的落点；tombstone 行同样占这一个槽 ⇒ 重绑复活同一行）。
    // ② `uq_user_notification_channels_verified_address`：**部分唯一**——
    //    `WHERE unbound_at IS NULL AND last_test_status='ok'`。
    //    只有真正收到过测试消息的地址才占槽；未验证 claim 不占槽、tombstone 不占槽。
    //    ⚠️ **谓词是门禁盲区**（TypeORM 元数据表达不了），由 schema e2e 的 indexdef 断言守卫。
    // =====================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_notification_channels_user_provider
      ON user_notification_channels (user_id, provider)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_notification_channels_verified_address
      ON user_notification_channels (provider, recipient_address)
      WHERE unbound_at IS NULL AND last_test_status = 'ok'
    `);

    // =====================================================
    // 4. notification_deliveries：加归属列 + 索引（additive-only，存量行 NULL）
    //
    // `recipient_user_id uuid NULL`：这条投递属于哪个平台用户（多用户化后 admin 可按用户
    // 过滤）。NULL = 存量行 / 无法归属（无 FK：投递记录是排障证据，须比用户行活得久）。
    // ⚠️ 索引 `idx_notification_deliveries_recipient_user` 由实体**同名** `@Index` 建模
    //    （见 notification-delivery.entity.ts）⇒ 不产生漂移产物。
    // =====================================================
    await queryRunner.query(`
      ALTER TABLE notification_deliveries
      ADD COLUMN recipient_user_id UUID
    `);
    await queryRunner.query(`
      CREATE INDEX idx_notification_deliveries_recipient_user
      ON notification_deliveries (recipient_user_id)
    `);
  }

  /**
   * 回滚（**仅本仓 migration 往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only 口径）。
   *
   * `IF EXISTS` 防御：往返链与共享开发库上的重复执行都必须幂等。
   * 顺序 = up 的逆序：先撤 `notification_deliveries` 的索引与列，再删新表（DROP TABLE 连带
   * 删掉表上的索引与 FK 约束，故无需逐条 DROP INDEX / DROP CONSTRAINT）。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    // 与 up 同一把锁超时（m11）：回滚同样要改存量表结构，长事务占锁时应当放弃而非无限排队。
    // ⚠️ SET LOCAL 的作用域 = 本批迁移共用的那个事务（transaction='all'）。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_notification_deliveries_recipient_user`);
    await queryRunner.query(
      `ALTER TABLE notification_deliveries DROP COLUMN IF EXISTS recipient_user_id`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS user_notification_channels`);
  }
}
