/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - 经验库第二期（自治治理面）Schema：空间成员角色表 + 判断日志表 + 条目判定快照列
 *
 * [代码职责]
 *   - 建 `experience_space_members` / `experience_judgments` 两表 + judgments 两条索引
 *     + `experience_entries.judgment` 增列 + judgments 表级 autovacuum 收紧
 *   - down() 供本仓 migration 往返验证链使用（生产回滚走 DEPLOY.md 的 additive-only 口径）
 *
 * [权威文档]
 *   - 主文档: .kimi/plans/plan-experience-base-p2.md §1.1（成员表逐列）/§1.2（日志表逐列+索引）
 *     /§1.3（entries 增列）/§1.4（migration 与漂移门禁协议）
 *   - 补充: 线上 DocSpace `docs/database.md` — 两新表节（批 6 文档收口后以线上为权威副本）
 *
 * [关键不变量]
 *   - **手写裸 SQL，禁止裸 `migration:generate` 提交**：本迁移产物里两条索引（含 DESC 排序）
 *     与表级 reloptions 是 TypeORM 元数据表达不了的形态，generate 只会产出"删掉真实索引"
 *     的 DROP（见 test/migration-drift.e2e-spec.ts 的 DRIFT-GENERATE-DANGEROUS）。
 *   - **漂移预测（批 1 协议，只读门禁核对过才允许更新基线）**：本迁移的**唯一下游 diff**
 *     = 2 条 `DROP INDEX "public"."idx_experience_judgments_*"`（实体刻意不声明 `@Index`，
 *     同形先例 `uq_experience_feedback_*`）；两新表 PK 不进 diff（约束支撑索引被排除）、
 *     `judgment` 增列（jsonb nullable 无默认）不进 diff。**出现其它新增项 = 缺陷**
 *     （改迁移或实体，不许给实体加 `@Index` 去凑预测）。
 *   - `judgment` 增列**不带默认值**（存量行 NULL = 未判，正确语义）；`judgment` 是缓存列，
 *     事实源是同迁移建的 `experience_judgments` 日志表。
 *   - 两新表**无 FK、无 actor 外键**：actor 硬删后成员授权行/判断日志行须存活
 *     （usage-stats/audit_logs 先例；日志是训练语料，不可随条目或 actor 消失）。
 *   - `experience_space_members.role` **无 DEFAULT**（默认值 = 默认授权，见实体注释）。
 *   - down() **逆序 + `IF EXISTS` 防御**（先 judgments/members 两表、后 entries 列），
 *     保证往返链（phase2 down → phase1 down）在干净库/共享库上都幂等。
 *
 * [关联代码]
 *   - database/entities/experience-space-member.entity.ts — 成员表实体（列契约）
 *   - database/entities/experience-judgment-record.entity.ts — 日志表实体（列契约）
 *   - database/entities/experience-entry.entity.ts — `judgment` 列（select:false 缓存）
 *   - test/migration-drift-baseline.txt — 漂移基线（本迁移使其 +2 条 B 段条目）
 *   - test/experience.e2e-spec.ts — 表存在性 5 表断言 + 往返套件（本迁移的守卫）
 *
 * [持久踩坑]
 *   EXPERIENCE-PHASE2-INDEX-DRIFT(预测核对): 若给两新表实体补 `@Index`（"让 diff 干净"的
 *     诱惑），diff 会从 2 条 DROP INDEX 变成 IDX_<hash> 命名差异对——门禁不会更干净，
 *     只会把裸 SQL 索引事实源撕成两份。安全方向: 索引只写在本迁移，实体保持零 `@Index`。
 *
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 经验库第二期迁移 —— 空间成员角色 + 判断日志 + 条目判定快照列（plan §11 批 1）。
 *
 * 类名用下划线分隔（`AddExperiencePhase2_1790200000000`）而非既有"标题拼时间戳"惯例：
 * 本迁移标题以数字结尾（Phase2），直接拼接会得到 `...Phase21790200000000` 这种
 * 人眼无法切分的标识符；下划线只影响类名与 `migrations.name` 记录值，不影响执行。
 *
 * 事务范围（2026-09-22 批 1 审查纠偏，**旧注释"每个 migration 单事务"是错的**）：
 * data-source.ts 与 app.module.ts 均未设 `migrationsTransactionMode`，TypeORM 0.3.30 缺省
 * = `'all'`（`MigrationExecutor.js` 构造器 `this.transaction = "all"`）——**本批全部 pending
 * 迁移（含本条）共用同一个事务**。故 `SET LOCAL lock_timeout = '5s'` 自本迁移起**一直生效
 * 到链尾**（不是"只作用于本条"）：时间戳更大的后续 migration **继承** 5s lock_timeout
 * （拿不到锁即 abort，不留长锁队列）——这是有意保护。
 * 推论：若某条迁移需要**别的** lock_timeout（或需要无超时），必须在本条内**显式重设**，
 * 不能假设每条迁移的默认值相互独立；也**不要**把"链尾迁移会继承 5s"当成 bug 去改。
 * 同源正确表述先例：`1789807743843-AlignEntityContractDrift.ts` 文件头（已写对）。
 *
 * 时间戳续 `1790100000000`（AddExperienceSearchEvents），保持经验库族连续。
 */
export class AddExperiencePhase2_1790200000000 implements MigrationInterface {
  name = 'AddExperiencePhase2_1790200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表/改表锁 5s 超时（长事务占 ACCESS EXCLUSIVE 锁时放弃而非无限排队）。
    //    ⚠️ SET LOCAL 的作用域 = 本批迁移共用的那**一个事务**（transaction='all'），
    //    自本迁移起生效到链尾，见文件头事务范围说明。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // =====================================================
    // 2. experience_space_members（终审权委托：owner / reviewer）
    //
    // 单空间隐式单例 ⇒ **无 space_id 列**（未来多空间 = 重建 PK + UNIQUE(space_id, actor_id)，
    // 不是免费加列，见实体注释）。actor_id 即 PK：一 actor 至多一行授权。
    // role 无 DEFAULT（默认值 = 默认授权）；无 FK（actor 硬删后授权行存活）；
    // 无 updated_at（角色变更走 PATCH 覆盖，历史查 audit_logs）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE experience_space_members (
        actor_id UUID PRIMARY KEY,
        role VARCHAR(20) NOT NULL,
        invited_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // =====================================================
    // 3. experience_judgments（append-only 判断日志 = 训练语料 + observe 复核数据）
    //
    // request NOT NULL：`skipped`（限流跳过）也必须写占位对象——保住 NOT NULL 不变量，
    // 杜绝录入主流程被 23502 连带打挂。response 可空（skipped 行 null）。
    // 无 FK（entry 软删/硬删后日志保留；语料价值不随条目生命周期终结）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE experience_judgments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        experience_id UUID,
        operation VARCHAR(32) NOT NULL,
        provider VARCHAR(32) NOT NULL,
        model VARCHAR(64),
        status VARCHAR(16) NOT NULL,
        actor_type VARCHAR(16),
        actor_id UUID,
        request JSONB NOT NULL,
        response JSONB,
        latency_ms INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // =====================================================
    // 4. judgments 两条索引（**实体侧刻意不声明 @Index**，见文件头预测）
    //
    // ① 分页全序 (created_at DESC, id DESC)：同刻多行也必须有序，否则 `page++` 翻页
    //    会漏行/重复（同模块 experience.service.ts 既有全序不变量）。
    // ② 条目级复核/配对 (experience_id, created_at DESC)：按条目取"终审时刻之前的最新一条"。
    // `status` 刻意不建索引（低基数 4 值）；4 周复查若失败率查询变高频，再评估
    // `(created_at DESC) WHERE status <> 'ok'` 部分索引（plan §1.2 [B] 段登记）。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_experience_judgments_created_at_id
      ON experience_judgments (created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_experience_judgments_experience_created_at
      ON experience_judgments (experience_id, created_at DESC)
    `);

    // =====================================================
    // 5. experience_entries.judgment（判定快照缓存列）
    //
    // 可空、无默认值：存量行 NULL = "未判"（正确语义，不需要 backfill）。
    // 实体侧 `select: false`（jsonb 大列，列表 getMany 不白 detoast）。
    // ⚠️ 本列是缓存：事实源是上面的日志表；改内容重判失败时必须在同事务置回 NULL。
    // =====================================================
    await queryRunner.query(`ALTER TABLE experience_entries ADD COLUMN judgment JSONB`);

    // =====================================================
    // 6. 日志表表级 autovacuum 收紧
    //
    // 日志是纯 append 表但**每行 jsonb 体积大**（≤16KB×2），默认 scale_factor 0.2
    // 会让死元组长期堆积（同经验库族先例 0.02）。可在事务内执行（VACUUM 本身不可）。
    // =====================================================
    await queryRunner.query(`
      ALTER TABLE experience_judgments
      SET (autovacuum_vacuum_scale_factor = 0.02)
    `);
  }

  /**
   * 回滚（**仅本仓 migration 往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only
   * 口径——两新表/新列无存量读写方，出问题停用代码即可，不回滚 DDL）。
   *
   * 逆序 + `IF EXISTS` 防御：往返链（phase2 down → phase1 down → phase1 up → phase2 up）
   * 与共享开发库上的重复执行都必须幂等。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS experience_judgments`);
    await queryRunner.query(`DROP TABLE IF EXISTS experience_space_members`);
    await queryRunner.query(`ALTER TABLE experience_entries DROP COLUMN IF EXISTS judgment`);
  }
}
