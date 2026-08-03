import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 权限模型重构：observer → editor
 * 1. role 列从 ENUM 改为 VARCHAR(20)（兼容新角色值并支持未来扩展）
 * 2. 将现有 observer 用户升级为 editor
 * 3. 添加 admin 唯一 partial index（确保系统中只有一个管理员）
 */
export class UpdateUserRoleToEditor1780917029000 implements MigrationInterface {
  name = 'UpdateUserRoleToEditor1780917029000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. 将 role 列从 ENUM 改为 VARCHAR(20)
    await queryRunner.query(`
      ALTER TABLE users ALTER COLUMN role TYPE varchar(20)
    `);

    // 2. 将现有 observer 用户更新为 editor
    await queryRunner.query(`
      UPDATE users SET role = 'editor' WHERE role = 'observer'
    `);

    // 3. 创建 admin 唯一 partial index（确保只有一个 admin）
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_unique_admin ON users (role) WHERE role = 'admin'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 1. 删除 admin 唯一 partial index
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_unique_admin
    `);

    // 2. 将 editor 用户回退为 observer
    await queryRunner.query(`
      UPDATE users SET role = 'observer' WHERE role = 'editor'
    `);

    // 3. 将 role 列改回 ENUM（TypeORM 原 enum 值）
    await queryRunner.query(`
      ALTER TABLE users ALTER COLUMN role TYPE varchar(20)
    `);
  }
}
