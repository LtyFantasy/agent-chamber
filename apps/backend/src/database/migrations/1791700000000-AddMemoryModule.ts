/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 模块（Hument 集成一期）：提名账本（`memory_nominations`）+ 项目注册表
 *     （`memory_projects`）+ 两张遥测表（形成尝试 / 召回），Schema 一次建齐
 *
 * [代码职责]
 *   - 建 4 张表 + **7 条索引**（含 3 条部分唯一/部分索引）+ **2 条 FK**（全 RESTRICT）
 *   - down() 供本仓 migration 往返验证链使用（生产回滚走 DEPLOY.md 的 additive-only 口径）
 *
 * [权威文档]
 *   - 主文档: 实现方案 `catwoman-blade-wolfsbane.md` §2 数据模型（逐列契约 + 索引清单 +
 *     漂移预测协议）/ §7 状态机映射表（formation_state 值域）
 *     ⚠️ **闭环缺口（已知）**：方案未落 DocSpace，coder D 批次落线上 `docs/spec.md` /
 *     `docs/architecture.md`；落点后本定位符改为线上文档。
 *   - 补充: 线上 DocSpace `docs/integrations/hument-integration-research.md` — 集成形态与门禁
 *
 * [关键不变量]
 *   - **手写裸 SQL，禁止裸 `migration:generate` 提交**：本迁移的 7 条索引里 3 条带谓词
 *     （TypeORM 元数据表达不了），generate 只会产出"删掉真实索引"的 DROP
 *     （见 test/migration-drift.e2e-spec.ts 的 DRIFT-GENERATE-DANGEROUS）。
 *   - **漂移预测（batch 协议，逐条点名；实测必须逐条对齐）**：本迁移的**全部**下游 diff
 *     = 7 条 DROP INDEX + 2 条 DROP CONSTRAINT，一条不多一条不少：
 *       ① DROP INDEX "public"."uq_memory_projects_slug"                     ← 部分唯一（slug, WHERE deleted_at IS NULL）
 *       ② DROP INDEX "public"."idx_memory_nominations_project_status"       ← 部分（project_id, status, WHERE deleted_at IS NULL）
 *       ③ DROP INDEX "public"."idx_memory_nominations_project_category"     ← 部分（project_id, category, WHERE deleted_at IS NULL）
 *       ④ DROP INDEX "public"."uq_memory_nominations_client_key"            ← 无谓词（nominator_id, client_request_id）
 *       ⑤ DROP INDEX "public"."uq_memory_nominations_correction_of"         ← 部分唯一（correction_of, WHERE correction_of IS NOT NULL AND deleted_at IS NULL AND status <> 'withdrawn'）
 *       ⑥ DROP INDEX "public"."idx_memory_formation_events_project_created" ← 无谓词（project_id, created_at）
 *       ⑦ DROP INDEX "public"."idx_memory_recall_events_project_created"    ← 无谓词（project_id, created_at）
 *       + DROP CONSTRAINT "memory_nominations_project_id_fkey"（FK RESTRICT）
 *       + DROP CONSTRAINT "memory_nominations_correction_of_fkey"（自引用 FK RESTRICT）
 *     **出现其它新增项 = 缺陷**（改迁移或实体去凑，绝不给实体补 `@Index` —— 那只会造出
 *     第二条索引事实源与 IDX_<hash> 命名差噪声）。
 *     4 张表的 PK 不进 diff（约束支撑索引被排除；同 experience_entries 先例）；
 *     **遥测两表刻意无 FK** ⇒ 不产生 CONSTRAINT 项（先例=日志不随主体删除）。
 *   - **FK 只此 2 条且全 `ON DELETE RESTRICT`**：删项目/删旧账本行前必须显式处置；
 *     遥测两表**不建 FK**（日志须比主体活得久，owner 排障证据）。
 *   - 全 PK 一律 `UUID PRIMARY KEY DEFAULT gen_random_uuid()`：漏 DEFAULT 会被漂移门禁
 *     判成列级漂移（[C] 段）。
 *   - `bindings` / `source_refs` 的 jsonb 默认 `'[]'::jsonb` 必须与实体 `default: []` 对齐
 *     （jsonb 的 defaultEqual 走深比较，不比对字面量文本；但类型必须真是 jsonb）。
 *   - `correction_of` 的部分唯一索引是**并发仲裁者**（同一 old 至多一行有效更正）；
 *     谓词含 `status <> 'withdrawn'` ⇒ 更正未达成（新行 withdrawn）自动释放唯一位。
 *
 * [关联代码]
 *   - database/entities/memory-project.entity.ts / memory-nomination.entity.ts /
 *     memory-formation-event.entity.ts / memory-recall-event.entity.ts — 列契约（本迁移镜像）
 *   - database/entities/index.ts — barrel 注册（glob 自动加载，barrel 供 e2e 断言一致性）
 *   - test/migration-drift-baseline.txt — 漂移基线（本迁移使其 [B] 段 +9 条）
 *   - test/memory-schema.e2e-spec.ts — 逐列对齐 / PK 默认值 / FK confdeltype / indexdef 谓词守卫
 *
 * [持久踩坑]
 *   MEMORY-DRIFT-PREDICTION(预测核对): 本迁移的 diff 已被逐条点名（7+2）。跑门禁时若多出
 *     一条（尤其形如 `ALTER TABLE ... ALTER COLUMN id SET DEFAULT ...`），**先怀疑 PK
 *     DEFAULT 或 jsonb 默认值写错**，不要去改基线。安全方向: 逐条比对点名清单，
 *     出现计划外项 = 改迁移/实体。
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
 * Memory 模块建表迁移（memory 分支 PoC 数据层；方案 §2 逐列契约）。
 *
 * 时间戳续 `1791600000000`（保持 1790x 递增序列）：**不能用真实当前毫秒值**
 * ——本仓既有迁移的时间戳是取整递增的"未来"值（最新 1791600000000），
 * 用更小的真实时间戳会让本迁移排在既有迁移之前，破坏 TypeORM 的 pending 顺序与
 * 迁移链语义。
 *
 * 事务范围（同经验库族纠偏结论）：data-source.ts 未设 `migrationsTransactionMode`，
 * TypeORM 0.3.30 缺省 `'all'` ⇒ 本批 pending 迁移共用同一事务，故 `SET LOCAL
 * lock_timeout = '5s'` **自本迁移起生效到链尾**（有意保护：拿不到锁即 abort，
 * 不留长锁队列）。
 *
 * down()：**仅本仓往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only 口径
 * （4 张新表无存量读写方，出问题停用代码即可，不回滚 DDL）。
 * ⚠️ down 内**不 DROP EXTENSION pgcrypto**：`gen_random_uuid()` 是共享函数
 * （PG13+ 内建），且其他模块依赖扩展。
 */
export class AddMemoryModule1791700000000 implements MigrationInterface {
  name = 'AddMemoryModule1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表锁 5s 超时（长事务占 ACCESS EXCLUSIVE 锁时放弃而非无限排队）。
    //    ⚠️ SET LOCAL 作用域 = 本批迁移共用的那一个事务（transaction='all'），见文件头。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // =====================================================
    // 2. memory_projects（项目注册表：绑定列表 + 可空引擎绑定 + 权限锚点）
    //
    // 引擎三列**全可空**（铁约束：memory 是可选增强，未绑引擎时 Chamber 完全可用）。
    // engine 值域 = none|hument（词表在 shared；fake 只测试注入不落库）。
    // created_by 无 FK（actor 硬删后项目存活，usage-stats 先例）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE memory_projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(128) NOT NULL,
        bindings JSONB NOT NULL DEFAULT '[]'::jsonb,
        engine VARCHAR(16) NOT NULL DEFAULT 'none',
        engine_workspace_id VARCHAR(128),
        engine_actor_id VARCHAR(128),
        engine_credential_ref VARCHAR(128),
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 3. memory_nominations（提名账本 = 引擎外耐久载体，映射单源）
    //
    // 两条 FK 全 ON DELETE RESTRICT：删项目/删旧行须显式处置（记忆是资产）。
    // correction_of 是**自引用** FK（更正链）；`content`/`rationale` 在实体侧 select:false。
    // engine_memory_ids 可空（alias 行恒 NULL；withdrawn 行必须清空——服务层不变式）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE memory_nominations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES memory_projects(id) ON DELETE RESTRICT,
        nominator_id UUID NOT NULL,
        nominator_type VARCHAR(16) NOT NULL,
        category VARCHAR(64) NOT NULL,
        subject TEXT NOT NULL,
        scope TEXT NOT NULL,
        effective_note TEXT,
        content TEXT NOT NULL,
        content_truncated BOOLEAN NOT NULL DEFAULT false,
        rationale TEXT NOT NULL,
        source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        engine_nomination_id VARCHAR(128),
        engine_canonical_nomination_id VARCHAR(128),
        engine_job_id VARCHAR(128),
        engine_memory_ids JSONB,
        formation_state VARCHAR(16) NOT NULL DEFAULT 'submitted',
        deferred BOOLEAN NOT NULL DEFAULT false,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        correction_of UUID REFERENCES memory_nominations(id) ON DELETE RESTRICT,
        engine_correction_id VARCHAR(128),
        review_at TIMESTAMPTZ,
        client_request_id VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 4. memory_formation_events（每次形成尝试一行；append-only）
    //
    // **刻意无 FK**（先例 experience_judgments/usage-stats/audit_logs）：日志须比主体
    // 活得久——`ledger_id` 只是弱关联，账本行删除后"为什么当初没形成"仍可复查。
    // `outcome` 是 Hument **原始信号**（24 宽，六态词表在 shared），不是归一化后的
    // formation_state。无 updated_at / deleted_at（只追加）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE memory_formation_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL,
        ledger_id UUID NOT NULL,
        category VARCHAR(64) NOT NULL,
        outcome VARCHAR(24) NOT NULL,
        reason_code VARCHAR(64),
        latency_ms INT,
        quota_consumed BOOLEAN NOT NULL DEFAULT false,
        input_tokens INT,
        output_tokens INT,
        retry_count INT NOT NULL DEFAULT 0,
        recovery_path VARCHAR(32),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // =====================================================
    // 5. memory_recall_events（每次召回一行，**失败也落**；append-only）
    //
    // **刻意无 FK**（项目/actor 均不建）：召回历史是引擎可用性分母。
    // `query_hash` = sha256（**只落摘要不落查询原文**，防遥测表变敏感语料仓）。
    // `view` 值域由端点契约（coder C）定，数据层只钉列宽 8。
    // 无 updated_at / deleted_at（只追加）。
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE memory_recall_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL,
        actor_id UUID NOT NULL,
        query_hash VARCHAR(64) NOT NULL,
        view VARCHAR(8) NOT NULL,
        outcome VARCHAR(16) NOT NULL,
        item_count INT NOT NULL DEFAULT 0,
        filtered_count INT NOT NULL DEFAULT 0,
        unmapped_count INT NOT NULL DEFAULT 0,
        engine_recall_id VARCHAR(128),
        request_id VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // =====================================================
    // 6. 索引 ①：uq_memory_projects_slug（**部分唯一**）
    //
    // 谓词 `deleted_at IS NULL` 让软删项目释放 slug（重建同名项目不被 23505 挡）；
    // slug 仅展示/过滤辅助，路径参数只认 uuid。
    // ⚠️ 谓词与索引不可分离——去掉谓词 = 软删项目永久占位 slug。
    // =====================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_memory_projects_slug
      ON memory_projects (slug)
      WHERE deleted_at IS NULL
    `);

    // =====================================================
    // 7. 索引 ②③：账本两条部分索引（列表按状态 / 按类别过滤）
    //
    // 两条都带 `WHERE deleted_at IS NULL`：软删行不进任何列表扫描（软删对读写一律 404）。
    // 刻意**不建** (project_id, formation_state)：低基数值 + 扫描集合是"非终态"，走部分
    // 索引收益不明（方案 §2 的索引清单即契约，勿"顺手补"）。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_memory_nominations_project_status
      ON memory_nominations (project_id, status)
      WHERE deleted_at IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX idx_memory_nominations_project_category
      ON memory_nominations (project_id, category)
      WHERE deleted_at IS NULL
    `);

    // =====================================================
    // 8. 索引 ④：幂等键唯一（**无谓词**，刻意）
    //
    // `(nominator_id, client_request_id)` 无 `deleted_at IS NULL`：幂等键跨软删仍生效
    // ——软删行不得把 key 让给新请求复用（复用会让"同 key 同 payload 重放"语义破裂）。
    // client_request_id 可空：PG 默认 NULL 不参与唯一冲突（未传 key 的提名不受约束）。
    // =====================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_memory_nominations_client_key
      ON memory_nominations (nominator_id, client_request_id)
    `);

    // =====================================================
    // 9. 索引 ⑤：更正唯一位（**部分唯一**，并发仲裁者）
    //
    // 三重谓词缺一不可：
    // - `correction_of IS NOT NULL`：普通提名不受约束（否则 NULL 值本身也占一位，
    //   PG 虽允许多 NULL，但显式写出意图更清晰且便于 EXPLAIN 判读）
    // - `deleted_at IS NULL`：软删的更正让位
    // - `status <> 'withdrawn'`：**更正未达成 ⇒ 新行 withdrawn ⇒ 释放唯一位**
    //   （否则同一 old 永久无法再更正——见 nomination 实体 [持久踩坑]）
    // 应用层另需预检旧行 status='active'（引擎三约束先于 DB 拦截）。
    // =====================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_memory_nominations_correction_of
      ON memory_nominations (correction_of)
      WHERE correction_of IS NOT NULL AND deleted_at IS NULL AND status <> 'withdrawn'
    `);

    // =====================================================
    // 10. 索引 ⑥⑦：两张遥测表的 (project_id, created_at)
    //
    // 唯一的查询形态 = "某项目的时间窗扫描"（按时间倒序取最近 N 条 / 时间窗统计），
    // 故复合列序固定 (project_id, created_at)。无谓词（遥测表无软删列）。
    // 遥测表高频追加、几乎不更新 ⇒ **不调 autovacuum**（经验库族调参是因为计数列高频
    // UPDATE；此处 append-only，默认策略正确，勿照抄 ALTER TABLE ... SET reloptions）。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_memory_formation_events_project_created
      ON memory_formation_events (project_id, created_at)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_memory_recall_events_project_created
      ON memory_recall_events (project_id, created_at)
    `);
  }

  /**
   * 回滚（**仅本仓 migration 往返验证链使用**；生产回滚走 DEPLOY.md 的 additive-only
   * 口径——4 张新表无存量读写方，出问题停用代码即可，不回滚 DDL）。
   *
   * 顺序依赖：nominations 持有指向 projects 的 FK、且自引用 ⇒ 必须先删 nominations 再删
   * projects（DROP TABLE 会连带删掉表上索引与 FK，故无需逐条 DROP INDEX）。
   * 全部 `IF EXISTS` 防御：往返链与共享开发库上的重复执行都必须幂等。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS memory_recall_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS memory_formation_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS memory_nominations`);
    await queryRunner.query(`DROP TABLE IF EXISTS memory_projects`);
  }
}
