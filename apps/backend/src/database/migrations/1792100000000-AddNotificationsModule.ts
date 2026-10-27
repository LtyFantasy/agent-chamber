/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Notifications 模块（外部 IM 通知出口，一期）数据层：投递记录表
 *     `notification_deliveries`（append-only 终态行）+ 1 条时间序索引
 *
 * [代码职责]
 *   - 建 1 张表 + 1 条索引（裸 SQL）；逐列镜像实体 `notification-delivery.entity.ts`
 *   - down() 供本仓 migration 往返验证链使用（生产回滚走 DEPLOY.md 的 additive-only 口径）
 *
 * [权威文档]
 *   - 主文档: plan `nightcrawler-black-hawk-devil-dinosaur.md` §6 数据层（逐列契约 + 索引清单 +
 *     漂移预测协议）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，S7 批次落线上 `docs/spec.md`；落点后本定位符
 *     改为线上文档。
 *
 * [关键不变量]
 *   - **手写裸 SQL，禁止裸 `migration:generate` 提交**：`gen_random_uuid()` 默认值 +
 *     显式命名索引都是"实体元数据表达得了、但 generate 草稿不可信"的形态（本仓 2026-09-17 起
 *     禁止裸 generate 提交；见 test/migration-drift.e2e-spec.ts 的 DRIFT-GENERATE-DANGEROUS）。
 *   - **漂移预测（batch 协议，逐条点名；实测必须逐条对齐）**：本迁移的**下游 diff = 0 条**。
 *     理由：本表所有列都由实体 `@Column` 显式建模（含 `name` 映射），且那一条时间序索引在实体侧
 *     以**同名** `@Index('idx_notification_deliveries_created', ['createdAt'])` 声明——TypeORM
 *     比对时按"表 + 名"命中同一索引 ⇒ 不产生 DROP INDEX 项（对照 memory 批：那批实体刻意零
 *     `@Index` ⇒ [B] 段 +6 条 DROP INDEX）。
 *     - **无 FK** ⇒ 不产生 CONSTRAINT 项（`event_id` 是弱关联，见实体文件头）。
 *     - **PK 不进 diff**（约束支撑索引被排除；同 `experience_entries` / memory 批先例）——
 *       但 `DEFAULT gen_random_uuid()` **进**比对：漏写默认值会被判成列级漂移，故实体必须
 *       保持 `@PrimaryGeneratedColumn('uuid')`（本仓驱动侧与 `gen_random_uuid()` 等价）。
 *     **出现任何新增项 = 缺陷**（改迁移或实体去凑，**绝不给基线加豁免行**）。
 *   - **`event_id` 刻意无 FK**：日志类行不随主体删除（同 `memory_formation_events` /
 *     `experience_judgments` 先例）——投递记录是排障证据，必须比事件行活得久。
 *   - **无 `updated_at` / 无 `deleted_at`**：append-only 终态行（一行只写一次，终态不可变）。
 *     retention 清理是 **DELETE**（plan §11 TODO），不是软删列。
 *   - **索引只有一条**：`(created_at)` 服务 admin 列表的 `createdAt DESC` 分页。contract 明写
 *     "无查询路径不顺手补"——新增索引必须同时改实体同名 `@Index`，否则落 [B] 段噪声。
 *
 * [关联代码]
 *   - database/entities/notification-delivery.entity.ts — 列契约（本迁移逐列镜像）
 *   - database/entities/index.ts — barrel 注册（glob 自动加载，barrel 供 e2e 断言一致性）
 *   - test/migration-drift-baseline.txt — 漂移基线（本迁移**不**使其任何分段变化）
 *   - test/notifications-schema.e2e-spec.ts — 逐列对齐 / PK 默认值 / 列级默认值 / indexdef / barrel↔glob 守卫（S6 批次）
 *
 * [持久踩坑]
 *   NOTIFY-DRIFT-NAMELESS-INDEX(索引漏名字): 若实体侧写成 `@Index(['createdAt'])`（无显式名），
 *     TypeORM 期望名会是 `IDX_<hash>`，与裸 SQL 的 `idx_notification_deliveries_created` 不匹配
 *     ⇒ 门禁落 [A] 段（"命名差异"）+ 一条 CREATE INDEX 假期望。安全方向: **索引名两侧逐字相同**。
 *
 * [铁律关联] #11(注释强制) #20(契约即设计)
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 逐列比对实体与本迁移（列名 / 类型 / 可空 / 默认值 / 索引名）
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications 模块建表迁移（plan §6 逐列契约）。
 *
 * 时间戳续 `1792000000000`（保持 1790x/1792x 递增序列）：**不能用真实当前毫秒值**
 * ——本仓既有迁移的时间戳是取整递增的"未来"值（最新 1792000000000），
 * 用更小的真实时间戳会让本迁移排在既有迁移之前，破坏 TypeORM 的 pending 顺序与
 * 迁移链语义。
 *
 * 事务范围（同经验库族 / memory 批纠偏结论）：data-source.ts 未设 `migrationsTransactionMode`，
 * TypeORM 0.3.30 缺省 `'all'` ⇒ 本批 pending 迁移共用同一事务，故 `SET LOCAL
 * lock_timeout = '5s'` **自本迁移起生效到链尾**（有意保护：拿不到锁即 abort，
 * 不留长锁队列）。
 *
 * down()：**仅本仓往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only 口径
 * （新表无存量读写方，出问题停用代码即可，不回滚 DDL）。
 * ⚠️ down 内**不 DROP EXTENSION pgcrypto**：`gen_random_uuid()` 是共享函数
 * （PG13+ 内建），且其他模块依赖扩展。
 */
export class AddNotificationsModule1792100000000 implements MigrationInterface {
  name = 'AddNotificationsModule1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表锁 5s 超时（长事务占 ACCESS EXCLUSIVE 锁时放弃而非无限排队）。
    //    ⚠️ SET LOCAL 作用域 = 本批迁移共用的那一个事务（transaction='all'），见文件头。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // =====================================================
    // 2. notification_deliveries（投递记录：只落终态，append-only）
    //
    // 列契约逐条对应 plan §6（宽度的 rationale 见实体文件头）：
    // - `id uuid PK DEFAULT gen_random_uuid()`：漏 DEFAULT 会被漂移门禁判成列级漂移。
    // - `recipient varchar(255)`：email / slack 预留宽度（同列承载多 provider）。
    // - `category varchar(30)`：值域单源 = config `NOTIFY_CATEGORIES`（落库值域 ⊂ 该数组）。
    // - `event_id uuid NULL`：**刻意无 FK**——日志类行不随主体删除（见文件头不变量）。
    // - `status varchar(20)`：`success` | `failed`，**无 pending**（终态两态闭合）。
    // - `attempts int DEFAULT 1`：投递行只在"有过尝试"时产生 ⇒ 恒 ≥ 1。
    // - `last_error text NULL`：**截断 500 字符是应用层契约**（列宽 text 不代劳）。
    // - **无 updated_at / 无 deleted_at**：一行一写，终态不可变。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE notification_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel VARCHAR(30) NOT NULL,
        recipient VARCHAR(255) NOT NULL,
        category VARCHAR(30) NOT NULL,
        event_id UUID,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        status VARCHAR(20) NOT NULL,
        attempts INT NOT NULL DEFAULT 1,
        last_error TEXT,
        response_status INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 3. 唯一索引：idx_notification_deliveries_created
    //
    // 服务 admin 只读列表的 `createdAt DESC` 分页（唯一的查询形态）。
    // ⚠️ **名字必须与实体 `@Index('idx_notification_deliveries_created', ['createdAt'])` 逐字相同**
    // ——否则漂移门禁把本索引判成"实体未建模"的裸 SQL 产物落 [B] 段（见文件头踩坑）。
    // 刻意**不建** (status, created_at) 等复合索引：无查询路径（plan §6 契约），勿顺手补。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_notification_deliveries_created
      ON notification_deliveries (created_at)
    `);
  }

  /**
   * 回滚（**仅本仓 migration 往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only 口径
   * ——新表无存量读写方，出问题停用代码即可，不回滚 DDL）。
   *
   * `IF EXISTS` 防御：往返链与共享开发库上的重复执行都必须幂等。
   * DROP TABLE 连带删掉表上的索引，故无需逐条 DROP INDEX。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS notification_deliveries`);
  }
}
