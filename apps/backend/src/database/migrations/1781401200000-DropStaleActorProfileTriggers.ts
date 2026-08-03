import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ActorUnification 迁移把 users/agents 的公共生命周期字段上提到 actors 表，
 * 但遗留了引用 users.updated_at / agents.updated_at 的 trigger。
 * 这些 trigger 在更新 user/agent 记录时会报错 "record \"new\" has no field \"updated_at\""，
 * 因此需要清理。
 */
export class DropStaleActorProfileTriggers1781401200000 implements MigrationInterface {
  name = 'DropStaleActorProfileTriggers1781401200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_users_updated_at" ON "users"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_agents_updated_at" ON "agents"`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 回滚时 actors 表仍存在 updated_at，但 users/agents 表已没有该字段，
    // 因此不需要也不应该重新创建这些 trigger；这里留空。
  }
}
