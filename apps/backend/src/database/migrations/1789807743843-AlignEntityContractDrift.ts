import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 实体↔迁移契约漂移对齐（Board 任务 28a3e799，plan doctor-strange-america-chavez-moon-girl §2 D1-D4）
 *
 * 权威文档：线上 DocSpace `docs/database.md` §9.8（漂移门禁与基线分级）+ 对应表的小节；
 *           部署/回滚语义 → 线上 `DEPLOY.md`（回滚节：additive-only 约定的例外）
 *
 * ── 漂移清单来源（28 条，全部实测，勿凭记忆改写）─────────────────────────────
 * 门禁 `test/migration-drift.e2e-spec.ts` 在全新临时库跑完全链后与实体元数据比对，恒差
 * 81 条；其中 **[C] 列级真漂移 28 条 = 24 条 `SET NOT NULL` 缺失 + task_activities 两列
 * 类型不一致**（基线 `test/migration-drift-baseline.txt` 旧 [C] 段逐条列出）：
 *   - 24 列：8 张表（attachments / doc_categories / doc_routes / doc_sections /
 *     doc_space_members / doc_spaces / docs / task_doc_links）共 24 个实体声明 NOT NULL
 *     而迁移链建出的列可空。
 *   - `task_activities.old_value/new_value`：迁移链建的是 `text`
 *     （`1714000000000-InitialMigration.ts:282-283`，全链无任何 migration 改其类型），
 *     实体声明 `jsonb`（`task-activity.entity.ts:32,36`）。
 *
 * ── 成因有日期：2026-05-24 手工 DDL 未入账 ───────────────────────────────────
 * `memory/2026-05-24.md` 记录当时**手工**在生产执行 `ALTER ... TYPE jsonb USING to_jsonb(...)`
 * 修好了 jsonb，**从未写成 migration** —— 这就是漂移根因。故：
 *   **生产 / dev 两列早已是 jsonb；`text` 形态只存在于全新 migration 链产物。**
 * 痛点落在 chamber 安装者：链产物 text 列 → `GET /tasks/:id/activities` 的
 * oldValue/newValue 回**字符串**；生产 jsonb → 回**对象** ⇒ 同一 API 两套返回类型 =
 * 真实契约分叉（消费方唯一读点 `task.service.ts:1555` 原样出网；前端 0 引用）。
 *
 * ── 三类环境形态（本 migration 在各环境的行为，部署前对照）────────────────────
 *   生产：  24 列 0 行 NULL / is_nullable=YES（2026-09-19 只读扫描实证）；
 *           两列已是 jsonb ⇒ 回填零行；SET NOT NULL **不重写表**；两列走 skip 分支**零重写**。
 *   dev：   同为可空；两列已是 jsonb（被 synchronize 归一化过）⇒ 同上。
 *   全新链：空表（chamber 安装 / 门禁临时库）；两列是 text ⇒ 回填零行；SET NOT NULL
 *           不重写表；两列 = **整表重写**（空表或表量级小，无压力）。
 *
 * ── up() 顺序（刻意，勿调）────────────────────────────────────────────────
 *   ① 条件回填（防御性；生产零操作已实证）
 *   ② 24 列 SET NOT NULL —— **按表合并 8 条 ALTER**（减少锁获取次数，语义等同逐列）
 *   ③ task_activities 两列守卫式类型转换 —— **放最后**：最贵、报错归因最清晰
 *
 * ── 为什么手写而不用 `migration:generate`（本仓铁律）────────────────────────
 * `PostgresQueryRunner.js:752-753`：类型不一致时 generate 产出 **DROP COLUMN + ADD COLUMN**
 * 对 —— text→jsonb 会被写成"删列再建列"，**静默销毁全部历史值**。generate 只可打草稿参考，
 * 产出必须逐条人工审，禁止直接提交（spec 头 DRIFT-GENERATE-DANGEROUS）。
 * 文件头**不挂 AGENT-CODE-HOOK**：本仓 50 个 migration 无一挂载；migration 是 append-only
 * 的一次性 DDL（已记账的 migration 永不可改，见 plan R3），"修改本文件前必读"的帧不成立，
 * 相关信息已由上方针标注与下方不变量承载。
 *
 * ── 开头 `SET LOCAL lock_timeout='5s'` ────────────────────────────────────
 * 限的是**锁获取**：长事务占表锁时 5s 放弃而非无限排队（`1788439433261` 先例）。
 * 扫描本身无压力：实测 2M 行 SET NOT NULL 扫描 ~55ms 且**不产生 relfilenode 变化**（不重写表）。
 * ⚠️ **本 migration 必须是最大时间戳**：`MigrationExecutor` transaction='all' 下全部 pending
 * 共用**单事务**，SET LOCAL 会溢出到同一事务内的后续 migration。同事务还有一处红利：
 * 失败 = 整批回滚、migrations 表不写行、**无半应用态**，重试安全。
 *
 * ── 部署前提（不满足则响亮失败，不会静默）──────────────────────────────────
 * 必须**直连 PG**。事务级连接池（pgbouncer transaction pooling）会在事务边界换连接，而本
 * migration 依赖的 `pg_temp.to_jsonb_safe` 是**会话级**对象，换连接即丢 → 迁移失败。
 * 生产路径 = deploy.sh 停服后显式 `migration:run`（宿主机直连）⇒ 满足该前提。
 *
 * ── down() 是**单向声明**（三路评审一致的 BLOCKING 修正）────────────────────
 * down() **只回退 24 列 DROP NOT NULL**；task_activities 的类型收窄**刻意不可逆**。理由：
 *   ① up() 在生产/dev 走 skip 从未改类型，"对称" down() 会把**生产 jsonb 降回 text**
 *      —— 回滚反而重新引入本任务要修的漂移；
 *   ② 本仓回滚约定 = additive-only + 恢复流程（`DEPLOY.md`），不靠 migration:revert 降 schema；
 *   ③ 实测 jsonb→text 对 JSON **字符串值**产出带引号文本（`"第一段"` 而非 `第一段`），
 *      静默污染数据。
 * ⇒ **revert 不回退类型收窄；事故恢复走 `DEPLOY.md` 恢复流程。**
 *
 * ADR 代价（已知并接受）：jsonb 收窄与 24 列 NOT NULL 在 transaction='all' 下同事务，
 * **不可分离回退**。"拆两条 migration"已驳回 —— 单事务下拆分无风险隔离收益。
 */
export class AlignEntityContractDrift1789807743843 implements MigrationInterface {
  name = 'AlignEntityContractDrift1789807743843';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 锁获取 5s 超时（见文件头）；TypeORM 每 migration 事务内生效
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // =========================================================================
    // ① 条件回填（防御性；生产实测零操作）
    // =========================================================================

    // docs.source **不回填** —— 前置检查，有 NULL 即响亮失败。
    // 'native' 是「可写」授权侧（doc.entity.ts:108-115）：source='native' 才允许写；
    // NULL 源文档若被静默回填成 'native' = 把不可写文档静默放行成可写，代价不可逆。
    // 生产 0 行 NULL 已实证（2026-09-19 只读扫描）；此检查是 chamber 老库的防呆。
    // 异常文案必须可操作：chamber compose 下 migrationsRun=true 会让它表现为**后端启动失败**
    //（fail-closed 方向正确），但安装者要看得懂怎么修。批量默认 native 是错误处置。
    await queryRunner.query(`
      DO $$
      DECLARE v_null_count bigint;
      BEGIN
        SELECT count(*) INTO v_null_count FROM "docs" WHERE "source" IS NULL;
        IF v_null_count > 0 THEN
          RAISE EXCEPTION
            'docs.source 有 % 行 NULL，本 migration 拒绝回填：source 是「可写」授权字段（doc.entity.ts:108-115），NULL 无法安全推断（默认 native = 静默放行写入）。处置：先人工核对这 % 行，显式赋值为 native 或 ingest（禁止批量默认 native），再重跑：UPDATE docs SET source = ''<native|ingest>'' WHERE source IS NULL;',
            v_null_count, v_null_count;
        END IF;
      END $$;
    `);

    // 回填规则（逐表合并一条 UPDATE；`WHERE <本表任一列> IS NULL` 限定受影响行）：
    //   created_at            → now()                        （无更早来源可用）
    //   updated_at            → COALESCE(created_at, now())  （**继承优先**，不伪造"刚刚更新"）
    //   int / smallint        → 0
    //   settings (jsonb)      → '{}'::jsonb
    //   tags (text[])         → '{}'::text[]
    // 注意 SQL 语义：所有 SET 表达式读到的是**本行旧值**，故 updated_at 里的 created_at
    // 是回填前的 created_at —— 这正是"继承优先"要的效果，勿改成引用新值。
    await queryRunner.query(`
      UPDATE "attachments" SET
        "created_at" = COALESCE("created_at", now()),
        "updated_at" = COALESCE("updated_at", "created_at", now())
      WHERE "created_at" IS NULL OR "updated_at" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "doc_categories" SET
        "created_at" = COALESCE("created_at", now()),
        "sort_order" = COALESCE("sort_order", 0),
        "updated_at" = COALESCE("updated_at", "created_at", now())
      WHERE "created_at" IS NULL OR "sort_order" IS NULL OR "updated_at" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "doc_routes" SET
        "created_at" = COALESCE("created_at", now()),
        "updated_at" = COALESCE("updated_at", "created_at", now())
      WHERE "created_at" IS NULL OR "updated_at" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "doc_sections" SET
        "created_at" = COALESCE("created_at", now()),
        "heading_level" = COALESCE("heading_level", 0),
        "token_estimate" = COALESCE("token_estimate", 0),
        "updated_at" = COALESCE("updated_at", "created_at", now())
      WHERE "created_at" IS NULL OR "heading_level" IS NULL
         OR "token_estimate" IS NULL OR "updated_at" IS NULL
    `);

    // doc_space_members.role：creator 行约定 = role='editor' 且 invited_by IS NULL
    //（doc-space-member.entity.ts:43-44：create() 写 editor、inviteAgent 写 member 且带 invitedBy）。
    // ⚠️ **COALESCE 不可省**：本 UPDATE 同时修 created_at，created_at IS NULL 的行会被整行 SET；
    // 此时裸 CASE 会把该行**既有** role='editor' 重判成 'member' = 静默降权。COALESCE 保证
    // 只填 NULL，不动既有值。
    await queryRunner.query(`
      UPDATE "doc_space_members" SET
        "created_at" = COALESCE("created_at", now()),
        "role" = COALESCE("role", CASE WHEN "invited_by" IS NULL THEN 'editor' ELSE 'member' END)
      WHERE "created_at" IS NULL OR "role" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "doc_spaces" SET
        "created_at" = COALESCE("created_at", now()),
        "doc_count" = COALESCE("doc_count", 0),
        "settings" = COALESCE("settings", '{}'::jsonb),
        "updated_at" = COALESCE("updated_at", "created_at", now())
      WHERE "created_at" IS NULL OR "doc_count" IS NULL
         OR "settings" IS NULL OR "updated_at" IS NULL
    `);

    // docs：source 刻意不在回填集合内（见上）；其余 5 列与同款规则
    await queryRunner.query(`
      UPDATE "docs" SET
        "created_at" = COALESCE("created_at", now()),
        "updated_at" = COALESCE("updated_at", "created_at", now()),
        "section_count" = COALESCE("section_count", 0),
        "token_estimate" = COALESCE("token_estimate", 0),
        "tags" = COALESCE("tags", '{}'::text[])
      WHERE "created_at" IS NULL OR "updated_at" IS NULL OR "section_count" IS NULL
         OR "token_estimate" IS NULL OR "tags" IS NULL
    `);

    await queryRunner.query(`
      UPDATE "task_doc_links" SET
        "created_at" = COALESCE("created_at", now())
      WHERE "created_at" IS NULL
    `);

    // =========================================================================
    // ② 24 列 SET NOT NULL —— 按表合并 8 条（[C] 段 24 条 SET NOT NULL 逐列对应）
    // 回填后无 NULL，故 SET NOT NULL 不会失败；PG 14+ 对已通过校验的表仅加约束，不重写表。
    // =========================================================================
    await queryRunner.query(`
      ALTER TABLE "attachments"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "updated_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_categories"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "sort_order" SET NOT NULL,
        ALTER COLUMN "updated_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_routes"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "updated_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_sections"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "heading_level" SET NOT NULL,
        ALTER COLUMN "token_estimate" SET NOT NULL,
        ALTER COLUMN "updated_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_space_members"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "role" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_spaces"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "doc_count" SET NOT NULL,
        ALTER COLUMN "settings" SET NOT NULL,
        ALTER COLUMN "updated_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "docs"
        ALTER COLUMN "created_at" SET NOT NULL,
        ALTER COLUMN "section_count" SET NOT NULL,
        ALTER COLUMN "source" SET NOT NULL,
        ALTER COLUMN "tags" SET NOT NULL,
        ALTER COLUMN "token_estimate" SET NOT NULL,
        ALTER COLUMN "updated_at" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "task_doc_links"
        ALTER COLUMN "created_at" SET NOT NULL
    `);

    // =========================================================================
    // ③ task_activities.old_value / new_value：text → jsonb（守卫式，可观测降级）
    // =========================================================================

    // 转换函数：合法 JSON 文本原样转；非法降级为 JSON **字符串**（保数据不丢）并 RAISE WARNING；
    // NULL 透传。放在 pg_temp（会话级）—— 见文件头"部署前提"，必须直连 PG。
    // ⚠️ 降级只保证"值不丢"，不保证"形状不变"：调用方拿到的仍是同一段文本。
    await queryRunner.query(`
      CREATE FUNCTION pg_temp.to_jsonb_safe(input text) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE
        parsed jsonb;
      BEGIN
        IF input IS NULL THEN
          RETURN NULL;
        END IF;
        BEGIN
          parsed := input::jsonb;
        EXCEPTION WHEN others THEN
          -- 裸文本 / 空串 / 半截 JSON 都走这里：降级为 JSON 字符串，绝不丢数据
          RAISE WARNING 'to_jsonb_safe: not valid JSON, degraded to JSON string: %', left(input, 120);
          RETURN to_jsonb(input);
        END;
        RETURN parsed;
      END $$;
    `);

    // 逐列独立守卫（**两列各一个 DO 块，一列异常形态不会让另一列静默跳过**）。
    // 守卫用 `::regclass` + pg_attribute 而非 information_schema：
    //   - regclass 与 ALTER TABLE **同一 search_path 解析**，按构造一致；
    //   - information_schema 不限定 schema 时遇多 schema 同名表 → `more than one row` 硬报错；
    //   - 且子查询 0 行命中时 `NULL <> 'jsonb'` 走 ELSE → **静默跳过 + 打印与事实相反的
    //     "already jsonb"**。regclass 形态两个坑都消掉：列未命中即 RAISE EXCEPTION，响亮失败。
    // 谓词用 `<> 'jsonb'` 而非 `= 'text'`：varchar 等异形态也进转换（方向可接受——宁可失败
    // 也不要静默留下非 jsonb 列）。
    await queryRunner.query(`
      DO $$
      DECLARE
        v_type text;
      BEGIN
        SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
          FROM pg_attribute a
         WHERE a.attrelid = 'task_activities'::regclass
           AND a.attname = 'old_value'
           AND NOT a.attisdropped;
        IF v_type IS NULL THEN
          RAISE EXCEPTION 'task_activities.old_value 未命中（regclass 解析到 %）：schema 或列名与预期不符，拒绝静默跳过',
            'task_activities'::regclass;
        END IF;
        IF v_type <> 'jsonb' THEN
          ALTER TABLE "task_activities" ALTER COLUMN "old_value" TYPE jsonb
            USING pg_temp.to_jsonb_safe("old_value");
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        v_type text;
      BEGIN
        SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
          FROM pg_attribute a
         WHERE a.attrelid = 'task_activities'::regclass
           AND a.attname = 'new_value'
           AND NOT a.attisdropped;
        IF v_type IS NULL THEN
          RAISE EXCEPTION 'task_activities.new_value 未命中（regclass 解析到 %）：schema 或列名与预期不符，拒绝静默跳过',
            'task_activities'::regclass;
        END IF;
        IF v_type <> 'jsonb' THEN
          ALTER TABLE "task_activities" ALTER COLUMN "new_value" TYPE jsonb
            USING pg_temp.to_jsonb_safe("new_value");
        END IF;
      END $$;
    `);

    // 会话级对象显式回收（本 migration 事务结束后会话可能被复用，勿留残留函数）
    await queryRunner.query(`DROP FUNCTION pg_temp.to_jsonb_safe(text)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 同款锁获取超时（DROP NOT NULL 同样需 ACCESS EXCLUSIVE）
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // ⚠️ 只回退 24 列 nullability；**task_activities 的类型收窄刻意不回退** —— 理由见文件头
    // "down() 是单向声明"。事故恢复走 `DEPLOY.md` 恢复流程，不要在这里补反向 TYPE 变更。
    await queryRunner.query(`
      ALTER TABLE "attachments"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "updated_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_categories"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "sort_order" DROP NOT NULL,
        ALTER COLUMN "updated_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_routes"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "updated_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_sections"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "heading_level" DROP NOT NULL,
        ALTER COLUMN "token_estimate" DROP NOT NULL,
        ALTER COLUMN "updated_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_space_members"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "role" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "doc_spaces"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "doc_count" DROP NOT NULL,
        ALTER COLUMN "settings" DROP NOT NULL,
        ALTER COLUMN "updated_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "docs"
        ALTER COLUMN "created_at" DROP NOT NULL,
        ALTER COLUMN "section_count" DROP NOT NULL,
        ALTER COLUMN "source" DROP NOT NULL,
        ALTER COLUMN "tags" DROP NOT NULL,
        ALTER COLUMN "token_estimate" DROP NOT NULL,
        ALTER COLUMN "updated_at" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "task_doc_links"
        ALTER COLUMN "created_at" DROP NOT NULL
    `);
  }
}
