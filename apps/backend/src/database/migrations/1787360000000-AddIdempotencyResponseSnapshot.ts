import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddIdempotencyResponseSnapshot — idempotency_records 增 response_snapshot / request_hash 两列。
 *
 * 背景（Board 任务 7d918c7b，v1.63.0）：现有幂等记录只存 entityId——对「创建」语义
 * （task/topic/message）重放时从 entityId 查回实体即可；但 DocSpace 写族是「更新」语义
 * （upsert/patch/move），重放时文档已被首次请求改写，从 entityId 查回的是**当前状态**
 * 而非「首次结果」。两列支撑 DocSpace 写入口的幂等重放契约：
 * - response_snapshot jsonb NULL：首次成功响应的完整快照（更新语义的重放无法从
 *   entityId 查回首次结果，这是现模式未覆盖的差异点，用户拍板存快照）
 * - request_hash varchar(64) NULL：canonical payload 的 SHA-256；同 key 重放时 hash
 *   不符 → 409 IDEMPOTENCY_KEY_CONFLICT（防同 key 不同 payload 的静默写丢失）
 *
 * 兼容性：纯增 nullable 列，存量行（task/topic/message 幂等记录）两列为 NULL，
 * 零数据迁移、零锁风险；既有三处幂等实现不写这两列，行为不变。
 *
 * 附带修复：补建 uq_idempotency_actor_key 唯一索引（IF NOT EXISTS）。该索引由
 * 1785102000000 创建，但实体此前缺 @Index 装饰器，synchronize 模式启动会删掉它
 * （94502fef 漂移的一例，2026-08-21 本地库实证被删）——幂等并发防线（23505 catch）
 * 依赖该索引，缺失时并发同 key 双写全部成功。生产库索引健在则本语句 no-op。
 */
export class AddIdempotencyResponseSnapshot1787360000000 implements MigrationInterface {
  name = 'AddIdempotencyResponseSnapshot1787360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idempotency_records" ADD COLUMN "response_snapshot" jsonb NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_records" ADD COLUMN "request_hash" character varying(64) NULL`,
    );
    // 幂等并发防线：同库已有该索引时 no-op（IF NOT EXISTS）；建索引前已确认无重复键
    // 数据（有重复时 CREATE UNIQUE INDEX 会失败——fail-closed，需先人工清重）
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_idempotency_actor_key"
       ON "idempotency_records" ("actor_id", "client_request_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 精确 down：只删本 migration 新增的两列。⚠️ 不 drop uq_idempotency_actor_key——
    // 该索引是 1785102000000 的职责（本 migration 只是 IF NOT EXISTS 补建，可能未实际创建）
    await queryRunner.query(
      `ALTER TABLE "idempotency_records" DROP COLUMN IF EXISTS "response_snapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_records" DROP COLUMN IF EXISTS "request_hash"`,
    );
  }
}
