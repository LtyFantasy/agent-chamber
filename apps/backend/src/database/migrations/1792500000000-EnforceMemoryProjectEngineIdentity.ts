/**
 * =============================================================================
 * AGENT-CODE-HOOK | 修改本文件前必读
 * =============================================================================
 * [功能概念]
 *   - Memory 当前完整引擎身份唯一性（永久历史归属仍由 claims 承担）
 * [代码职责]
 *   - 阻写锁内预检重复，再创建非软删项目的部分唯一索引；不修改任何业务数据
 * [权威文档]
 *   - 线上 DocSpace docs/database.md §4.35、docs/architecture.md §3.2.14
 *   - DEPLOY.md — 兼容错误翻译提交先行，保留索引时不能回滚到此前版本
 * [关键不变量]
 *   - archived 仍可读，必须参与唯一约束；软删释放当前位置但不释放永久 claim
 *   - 预检与索引谓词一致；冲突只报告有界项目 UUID，不输出引擎接线
 *   - 实体不加 @Index：本迁移是索引单源；down 仅供隔离测试往返
 * [关联代码]
 *   - modules/memory/memory-project.service.ts — 精确 23505 转业务 409
 *   - test/memory-project-engine-identity.e2e-spec.ts — 真 PG / 失败无损 / 回滚守卫
 * [修改检查]
 *   □ 已读 [权威文档]，确认修改符合设计意图
 *   □ 已核对 [关键不变量] 与 [关联代码] 的影响面
 *   □ 行为、合同、不变量或归属变化时，同步更新文档侧 AGENT-DOC-HOOK
 *   □ 如需修复缺陷，先完成根因分析、影响面评估、风险匹配测试与验证
 * =============================================================================
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

/** 当前身份结构约束；保持 1792x 迁移顺序，不迁就有冲突的历史数据。 */
export class EnforceMemoryProjectEngineIdentity1792500000000 implements MigrationInterface {
  /** TypeORM 迁移账标识；末尾时间戳保持迁移链顺序。 */
  name = 'EnforceMemoryProjectEngineIdentity1792500000000';

  /** 阻止预检后的并发写窗口；重复时中止整个迁移事务，留给 operator 受控处置。 */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    // 常规 CREATE INDEX 本身使用 SHARE；提前拿同一锁允许读、阻止 INSERT/UPDATE。
    await queryRunner.query(`LOCK TABLE memory_projects IN SHARE MODE`);
    const conflicts: Array<{ id: string }> = await queryRunner.query(`
      SELECT id FROM (
        SELECT id, COUNT(*) OVER (
          PARTITION BY engine, engine_workspace_id, engine_actor_id, engine_credential_ref
        ) AS identity_count
        FROM memory_projects
        WHERE engine_workspace_id IS NOT NULL
          AND engine_actor_id IS NOT NULL
          AND engine_credential_ref IS NOT NULL
          AND deleted_at IS NULL
      ) AS identities
      WHERE identity_count > 1
      ORDER BY id
      LIMIT 21
    `);
    if (conflicts.length > 0) {
      // 最多展示 20 个 UUID，额外取一行只用于响亮标记截断，避免升级日志无界放大。
      const ids = conflicts.slice(0, 20).map(({ id }) => id).join(', ');
      const truncated = conflicts.length > 20 ? ' (truncated to 20 ids; more conflicts exist)' : '';
      throw new Error(
        `uq_memory_projects_engine_triple: duplicate current engine identities; ` +
          `conflicting project ids: ${ids}${truncated}. ` +
          'No project was changed. Ask an operator to resolve ownership; archiving does not release the identity.',
      );
    }
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_memory_projects_engine_triple
      ON memory_projects (engine, engine_workspace_id, engine_actor_id, engine_credential_ref)
      WHERE engine_workspace_id IS NOT NULL
        AND engine_actor_id IS NOT NULL
        AND engine_credential_ref IS NOT NULL
        AND deleted_at IS NULL
    `);
  }

  /** 隔离测试的往返入口；生产产物回滚保留此加法约束，禁止执行 down。 */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_memory_projects_engine_triple`);
  }
}
