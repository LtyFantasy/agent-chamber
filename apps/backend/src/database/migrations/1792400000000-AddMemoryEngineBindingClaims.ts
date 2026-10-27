/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 引擎身份**永久占用**：新建 `memory_engine_binding_claims` 并回填全部历史
 *     项目的完整非 `none` 绑定三元组（含 archived / soft-deleted）
 *
 * [代码职责]
 *   - 建表（四列 NOT NULL + `engine <> 'none'` CHECK + 四列单条唯一索引）
 *   - 全量回填：`withDeleted` 口径、确定性 winner（active > archived > soft-deleted，
 *     同档 `created_at` / `id` 升序）、`ON CONFLICT DO NOTHING`
 *   - `up()` 可重跑（部署后 / 回滚后重跑回填并对账），`down()` 仅供本仓往返验证链
 *
 * [权威文档]
 *   - 主文档: 会话计划 `constantine-pantha-lockjaw.md` §2.3（fail-closed 引擎身份占用）/
 *     §3.1.2（migration 与回填规则）/ §3.4.1（确定性 winner / 重跑幂等）
 *   - 补充: 线上 DocSpace `docs/database.md` — Memory 表结构与 mutation 约定
 *
 * [关键不变量]
 *   - **只读 `memory_projects`，绝不修改/删除项目或 Hub 数据**：本迁移的写面只有新表。
 *   - **winner 规则固定**：先按「未软删 active」→「未软删 archived」→「已软删」分档，
 *     同档按 `created_at` 升序、再按 `id` 升序。禁止依赖物理行序 / 无 ORDER BY 的窗口。
 *   - **重跑幂等**：`CREATE TABLE/INDEX IF NOT EXISTS` + `ON CONFLICT DO NOTHING`；
 *     已存在的 claim（含线上运行期创建/改绑写入的）绝不被回填改写或抢走。
 *   - **四列唯一索引是并发仲裁者**，不塞 jsonb（jsonb 整列等值永不命中，铁律 #23）。
 *   - **`project_id` 无 FK**：项目硬删后 claim 必须保留，否则删项目等于释放身份。
 *   - `SET LOCAL lock_timeout = '5s'`：拿不到锁即 abort，不留长锁队列（沿用 1791700000000
 *     起的迁移链约定；本迁移自身也会显式重设）。
 *
 * [关联代码]
 *   - database/entities/memory-engine-binding-claim.entity.ts — 列契约（本迁移镜像）
 *   - modules/memory/memory-project.service.ts — 运行期创建/改绑写 claim 并回读归属
 *   - test/memory-schema.e2e-spec.ts — 列 / NOT NULL / CHECK / 唯一索引守卫
 *   - test/memory-engine-binding-claims.e2e-spec.ts — winner 确定性 / 重跑 / 并发 409
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
 * 引擎身份永久占用表 + 历史回填（expand-only）。
 *
 * 时间戳续 `1792300000000` 保持既有 1792x 递增序列；**不要换成真实当前毫秒值**
 * （会把本迁移排到既有迁移之前，破坏 TypeORM pending 顺序）。
 *
 * 为什么回填也要在 `up()` 里且可重跑：部署时 migration 先于新代码运行（旧代码仍在服务），
 * 部署后 / 回滚后需要重跑同一回填并对账「完整绑定但本项目 claim 缺失数 = 0」。
 */
export class AddMemoryEngineBindingClaims1792400000000 implements MigrationInterface {
  name = 'AddMemoryEngineBindingClaims1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);

    // ------------------------------------------------------------------
    // 1. 新表：永久占用记录。
    //    - 四列 NOT NULL：不允许半配置占用
    //    - CHECK engine <> 'none'：none 不是引擎身份
    //    - project_id 无 FK：项目硬删后 claim 必须保留（删项目 ≠ 释放身份）
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS memory_engine_binding_claims (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        engine VARCHAR(16) NOT NULL,
        engine_workspace_id VARCHAR(128) NOT NULL,
        engine_actor_id VARCHAR(128) NOT NULL,
        engine_credential_ref VARCHAR(128) NOT NULL,
        project_id UUID NOT NULL,
        first_claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_memory_engine_binding_claims_engine_not_none
          CHECK (engine <> 'none')
      )
    `);

    // ------------------------------------------------------------------
    // 2. 四列单条唯一索引 = 并发仲裁者。
    //    显式列序与运行期回读条件一致；无部分谓词（claim 没有 deleted_at 概念）。
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_engine_binding_claims_triple
      ON memory_engine_binding_claims (
        engine,
        engine_workspace_id,
        engine_actor_id,
        engine_credential_ref
      )
    `);

    // ------------------------------------------------------------------
    // 3. 回填全部历史项目（**不按 status 过滤**，含 archived / soft-deleted）。
    //
    //    winner 分档：未软删 active(0) > 未软删 archived(1) > 已软删(2)；
    //    同档 created_at ASC、id ASC（确定性，不依赖物理顺序）。
    //    first_claimed_at = 同四列**全部项目**的 MIN(created_at)（真正首次占用时间；owner 仍按 winner）。
    //    ON CONFLICT DO NOTHING：重跑 / 部署后补跑不会改写已被占用的归属或首次时间。
    // ------------------------------------------------------------------
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          p.id AS project_id,
          p.engine,
          p.engine_workspace_id,
          p.engine_actor_id,
          p.engine_credential_ref,
          p.created_at,
          MIN(p.created_at) OVER (
            PARTITION BY
              p.engine,
              p.engine_workspace_id,
              p.engine_actor_id,
              p.engine_credential_ref
          ) AS first_claimed_at,
          ROW_NUMBER() OVER (
            PARTITION BY
              p.engine,
              p.engine_workspace_id,
              p.engine_actor_id,
              p.engine_credential_ref
            ORDER BY
              CASE
                WHEN p.deleted_at IS NOT NULL THEN 2
                WHEN p.status = 'active' THEN 0
                WHEN p.status = 'archived' THEN 1
                ELSE 2
              END,
              p.created_at ASC,
              p.id ASC
          ) AS winner_rank
        FROM memory_projects p
        WHERE p.engine <> 'none'
          AND p.engine_workspace_id IS NOT NULL
          AND btrim(p.engine_workspace_id) <> ''
          AND p.engine_actor_id IS NOT NULL
          AND btrim(p.engine_actor_id) <> ''
          AND p.engine_credential_ref IS NOT NULL
          AND btrim(p.engine_credential_ref) <> ''
      )
      INSERT INTO memory_engine_binding_claims (
        engine,
        engine_workspace_id,
        engine_actor_id,
        engine_credential_ref,
        project_id,
        first_claimed_at
      )
      SELECT
        engine,
        engine_workspace_id,
        engine_actor_id,
        engine_credential_ref,
        project_id,
        first_claimed_at
      FROM ranked
      WHERE winner_rank = 1
      ON CONFLICT (engine, engine_workspace_id, engine_actor_id, engine_credential_ref)
      DO NOTHING
    `);
  }

  /**
   * 回滚（仅本仓 migration 往返验证链使用）。
   *
   * ⚠️ 生产回滚走 additive-only 口径：本表是 expand-only 产物，代码回滚时直接停用即可；
   * 删除本表会**释放全部历史占用**，等于打开跨项目冒领面，禁止在生产执行 `down()`。
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS memory_engine_binding_claims`);
  }
}
