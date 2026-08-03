import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave 2: 幂等键 clientRequestId（v1.26.0-dev）。
 *
 * 新建 idempotency_records 表，作用域 (actor_id, client_request_id)，
 * 为 task/topic/message 三创建端点提供重放安全。
 *
 * up():
 *   1. CREATE TABLE idempotency_records（PK uuid, actor_id uuid NOT NULL,
 *      client_request_id varchar(64) NOT NULL, entity_type varchar(20) NOT NULL,
 *      entity_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()）
 *   2. CREATE UNIQUE INDEX uq_idempotency_actor_key
 *      ON idempotency_records (actor_id, client_request_id)
 *
 * down():
 *   1. DROP INDEX IF EXISTS uq_idempotency_actor_key
 *   2. DROP TABLE idempotency_records
 *
 * 设计决策：
 *   - actor_id 裸 uuid 不加 FK，对齐项目惯例（board_members/topic_participants 等）
 *   - client_request_id 不强制 UUID，允许 agent 使用语义串（如 "pm-agent-20260726-001"）
 *   - entity_type 枚举 'task'/'topic'/'message'，varchar(20) 有扩展余地
 *   - 唯一索引作用域为 (actor_id, client_request_id)，跨 actor 同 key 互不影响
 */
export class AddIdempotencyRecords1785102000000 implements MigrationInterface {
  name = 'AddIdempotencyRecords1785102000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "idempotency_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "actor_id" uuid NOT NULL,
        "client_request_id" varchar(64) NOT NULL,
        "entity_type" varchar(20) NOT NULL,
        "entity_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_idempotency_records" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_idempotency_actor_key"
      ON "idempotency_records" ("actor_id", "client_request_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_idempotency_actor_key"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_records"`);
  }
}
