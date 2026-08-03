import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 全文搜索触发器：自动维护 messages/tasks 的 search_vector
 * - messages: content 变化时自动更新 tsvector
 * - tasks: title/description 变化时自动更新 tsvector
 * - 回填现有数据的 search_vector
 */
export class AddSearchVectorTriggers1780381916726 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // =====================================================
    // 1. Message search_vector 触发器
    // =====================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_message_search_vector()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content THEN
          NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_messages_search_vector
      BEFORE INSERT OR UPDATE ON messages
      FOR EACH ROW
      EXECUTE FUNCTION maintain_message_search_vector()
    `);

    // =====================================================
    // 2. Task search_vector 触发器
    // =====================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_task_search_vector()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description THEN
          NEW.search_vector := to_tsvector('simple', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.description, ''));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_tasks_search_vector
      BEFORE INSERT OR UPDATE ON tasks
      FOR EACH ROW
      EXECUTE FUNCTION maintain_task_search_vector()
    `);

    // =====================================================
    // 3. 回填现有数据
    // =====================================================
    await queryRunner.query(`
      UPDATE messages
      SET search_vector = to_tsvector('simple', COALESCE(content, ''))
      WHERE search_vector IS NULL
    `);

    await queryRunner.query(`
      UPDATE tasks
      SET search_vector = to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(description, ''))
      WHERE search_vector IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers first (depend on functions)
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_tasks_search_vector ON tasks`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_messages_search_vector ON messages`);

    // Then drop functions
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_task_search_vector()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_message_search_vector()`);
  }
}
