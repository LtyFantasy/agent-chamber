import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 经验库（Experience Base）建表迁移 —— `experience_entries` + `experience_feedback`
 *
 * 手写裸 SQL（**禁止裸 `migration:generate` 提交**）：本迁移的绝大多数产物 TypeORM
 * 元数据表达不了——GIN（含 trgm opclass）、环境指纹表达式 btree、排序部分表达式索引、
 * 双 UNIQUE 仲裁索引、FK。用 generate 只会产出"删掉这些真实约束"的 DROP
 * （见 test/migration-drift.e2e-spec.ts 的 DRIFT-GENERATE-DANGEROUS 踩坑条）。
 *
 * 索引设计的四条实证取舍（改动前必读，plan v1.3 §1.3）：
 * 1. **trgm 索引只建 content 一条**：`similarity()` 是函数打分、**不走索引**，只有 `%`
 *    操作符走；而 `%` 受 `pg_trgm.similarity_threshold`（默认 0.3）约束 ≠ 我们的
 *    SCORE_FLOOR 0.08，加 `%` 预过滤会收紧召回面、与"异词汇召回"契约相反。故 trgm
 *    通道**接受 Seq Scan 打分**（量级：万条 × 64KB 上限单次 q 约百 ms 级，可接受）。
 *    title/summary **刻意不建** trgm 索引，但它们的 similarity 照常参与打分——
 *    **索引与通道解耦**，勿"顺手补索引"。
 * 2. **`sort=recent`（updated_at DESC）不加索引 = 有意取舍**：小表 seq scan 正确；
 *    `intent` 同理不建索引（受控五值选择性差，走了也是白读）。两者都写明防误补。
 * 3. **`env` 用四条表达式 btree 而非 GIN**：`GIN jsonb_path_ops` 服务不了 `->>` 谓词
 *    （实测），四个 `((env->>'k'))` 谓词各自命中自己的表达式索引。
 * 4. **计数列一律不进索引**：`helped_count` / `not_helpful_count` 每次反馈都 UPDATE，
 *    进索引 = 整行不可 HOT（写放大实证）。排序索引只含 `distinct_helped_count`。
 *
 * trigger 的 COALESCE 铁律（33% 毒化实证）：`NULL || 'x'` = NULL，拼接表达式里**任何
 * 一段缺 COALESCE，该段为 NULL 时整行 search_vector 变 NULL**，该行对 q 通道永久
 * 不可搜且零报错。故逐段 COALESCE，段数 = 参与向量的列数（5 段）。
 *
 * autovacuum：`experience_entries` 被反馈高频 UPDATE（计数三列），默认 scale_factor 0.2
 * 在小表上迟迟不触发 → 死元组长期堆积；`experience_feedback` 亦有改判更新路径。
 *
 * down()：**仅本仓验证链（migration 往返测试）使用**；**生产回滚走 DEPLOY.md 的
 * additive-only 口径**（新表无存量读写方，生产遇问题只需停用代码，不回滚 DDL）。
 * 顺序不可换：trigger → function → **先 feedback 后 entries**（feedback 持有指向
 * entries 的 FK）。
 */
export class AddExperienceEntries1790000000000 implements MigrationInterface {
  name = 'AddExperienceEntries1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 建表锁 5s 超时（长事务占 ACCESS EXCLUSIVE 锁时放弃而非无限排队）。
    //    ⚠️ 事务范围（2026-09-22 批 1 审查纠偏）：`migrationsTransactionMode` 未设 ⇒
    //    TypeORM 0.3.30 缺省 'all'，**本批 pending 迁移共用同一事务**，故本条 SET LOCAL
    //    会**一直生效到链尾**（后续更大时间戳的 migration 继承 5s lock_timeout，拿不到锁
    //    即 abort 不留长锁队列——有意保护）。需要别的超时须在本条内显式重设。
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // 2. pg_trgm 幂等兜底（AddDocSpaceModule 已启用；官方 postgres 镜像自带 contrib。
    //    此处不重复承担启用职责，只为迁移链在干净库上自足）
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // =====================================================
    // 3. experience_entries（带伤疤的实战笔记）
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE experience_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(200) NOT NULL,
        summary VARCHAR(500) NOT NULL,
        content TEXT NOT NULL,
        intent VARCHAR(32) NOT NULL,
        signals TEXT[] NOT NULL DEFAULT '{}',
        env JSONB NOT NULL DEFAULT '{}',
        domains TEXT[] NOT NULL DEFAULT '{}',
        quality VARCHAR(32) NOT NULL DEFAULT 'unverified',
        helped_count INT NOT NULL DEFAULT 0,
        not_helpful_count INT NOT NULL DEFAULT 0,
        distinct_helped_count INT NOT NULL DEFAULT 0,
        last_helped_at TIMESTAMPTZ,
        created_by_type VARCHAR(16) NOT NULL,
        created_by_id UUID NOT NULL,
        source_project VARCHAR(128),
        verified_by UUID,
        verified_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        search_vector TSVECTOR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 4. experience_feedback（(entry, actor) 去重 + 埋点）
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE experience_feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        experience_id UUID NOT NULL REFERENCES experience_entries(id) ON DELETE CASCADE,
        actor_type VARCHAR(16) NOT NULL,
        actor_id UUID NOT NULL,
        outcome VARCHAR(16) NOT NULL,
        client_request_id VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // =====================================================
    // 5. 数组 GIN（signals / domains）
    //
    // 查询形态钉死 `&&` overlap / `@>` 包含 —— **禁 `= ANY`**（实测 Seq Scan，
    // GIN 完全用不上）。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_signals
      ON experience_entries USING GIN (signals)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_domains
      ON experience_entries USING GIN (domains)
    `);

    // =====================================================
    // 6. 全文向量 GIN（英文/标识符通道）
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_search_vector
      ON experience_entries USING GIN (search_vector)
    `);

    // =====================================================
    // 7. trgm 索引 —— **仅此一条**（见文件头取舍 1）
    //
    // 只服务 content；title/summary 走 similarity() 打分但**不建索引**
    // （打分不走索引，建了只增加写放大）。**勿因"漏了 title/summary"补索引**。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_content_trgm
      ON experience_entries USING GIN (content gin_trgm_ops)
    `);

    // =====================================================
    // 8. 环境指纹表达式 btree ×4（os / tool / version / runtime）
    //
    // 键名白名单与 entity 的 ExperienceEnv 一致；键受控故无需 GIN 的通配能力，
    // 精确相等谓词用 btree 表达式索引即可（GIN jsonb_path_ops 服务不了 `->>`，实测）。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_env_os
      ON experience_entries ((env->>'os'))
    `);

    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_env_tool
      ON experience_entries ((env->>'tool'))
    `);

    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_env_version
      ON experience_entries ((env->>'version'))
    `);

    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_env_runtime
      ON experience_entries ((env->>'runtime'))
    `);

    // =====================================================
    // 9. 排序部分表达式索引（sort=most_used 的缺省分层排序）
    //
    // 分层 = ① verified 层优先（quality='verified' DESC）② 去重有效命中数
    // ③ 新鲜度 ④ id 兜底定序（分页稳定）；部分谓词 `deleted_at IS NULL` 让软删行走索引外。
    // 计数列刻意**不在**本索引里（见文件头取舍 4）。
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_experience_entries_sort
      ON experience_entries
        ((quality = 'verified') DESC, distinct_helped_count DESC, updated_at DESC, id)
      WHERE deleted_at IS NULL
    `);

    // =====================================================
    // 10. 反馈表双唯一（仲裁语义不同，缺一不可）
    //
    // ① 去重仲裁者：同一 (entry, actor) 只有一行，重复反馈走 ON CONFLICT **改判**。
    //    这是 `distinct_helped_count` 的正确性前提。
    // ② 幂等重放：同 key 同 payload → idempotentReplay；同 key 不同 payload →
    //    409 / 9002 IDEMPOTENCY_KEY_CONFLICT（复用现成分码）。
    // =====================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_experience_feedback_experience_actor
      ON experience_feedback (experience_id, actor_type, actor_id)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_experience_feedback_actor_key
      ON experience_feedback (actor_type, actor_id, client_request_id)
    `);

    // =====================================================
    // 11. search_vector 维护 trigger
    //
    // 普通列 + BEFORE INSERT/UPDATE（**不是生成列**：生成列缺 typeorm_metadata
    // 登记会炸漂移门禁，全仓零生成列先例）。
    // 向量取 title/summary/signals/domains/content 五段，'simple' 配置
    // （消息/doc_sections 同款先例）：'simple' 不做事后词干化，标识符类 token
    // （ECONNREFUSED / ereresolve）保持原样最利于精确匹配。
    // `intent` 不进向量：受控五值已是独立过滤参数，进向量只会让 q 命中面被枚举值污染。
    // =====================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_experience_entry_search_vector()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT'
           OR NEW.title IS DISTINCT FROM OLD.title
           OR NEW.summary IS DISTINCT FROM OLD.summary
           OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.signals IS DISTINCT FROM OLD.signals
           OR NEW.domains IS DISTINCT FROM OLD.domains THEN
          NEW.search_vector := to_tsvector('simple',
            COALESCE(NEW.title, '') || ' ' ||
            COALESCE(NEW.summary, '') || ' ' ||
            COALESCE(array_to_string(NEW.signals, ' '), '') || ' ' ||
            COALESCE(array_to_string(NEW.domains, ' '), '') || ' ' ||
            COALESCE(NEW.content, '')
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_experience_entries_search_vector
      BEFORE INSERT OR UPDATE ON experience_entries
      FOR EACH ROW
      EXECUTE FUNCTION maintain_experience_entry_search_vector()
    `);

    // =====================================================
    // 12. 表级 autovacuum 收紧
    //
    // entries：计数三列每次反馈都 UPDATE（高频小更新）→ 死元组按默认 0.2 阈值
    // 迟迟不清理；feedback：改判路径同样 UPDATE 该行。
    // 可在事务内执行（VACUUM 本身不可，那是独立运维动作）。
    // =====================================================
    await queryRunner.query(`
      ALTER TABLE experience_entries
      SET (autovacuum_vacuum_scale_factor = 0.02)
    `);

    await queryRunner.query(`
      ALTER TABLE experience_feedback
      SET (autovacuum_vacuum_scale_factor = 0.02)
    `);
  }

  /**
   * 回滚（**仅本仓 migration 往返验证链使用**；生产回滚走 DEPLOY.md 的
   * additive-only 口径——新表无存量读写方，出问题停用代码即可，不回滚 DDL）。
   *
   * 顺序依赖：trigger 依赖 function；feedback 依赖 entries（FK）。
   * 刻意不卸载 pg_trgm 扩展（共享扩展，其他模块依赖）。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_experience_entries_search_vector ON experience_entries`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_experience_entry_search_vector()`);

    // 先 feedback 后 entries（FK 依赖方向）
    await queryRunner.query(`DROP TABLE IF EXISTS experience_feedback`);
    await queryRunner.query(`DROP TABLE IF EXISTS experience_entries`);
  }
}
