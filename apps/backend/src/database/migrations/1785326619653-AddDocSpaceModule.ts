import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DocSpace 模块建表迁移
 *
 * 包含：
 * - pg_trgm 扩展启用（官方 postgres 镜像自带 contrib，注释注明）
 * - 6 张新表：doc_spaces / doc_space_members / doc_categories / docs / doc_sections / task_doc_links
 * - GIN 索引：doc_sections.search_vector + doc_sections.content (trgm) + docs.title (trgm)
 * - 常规 btree 索引
 * - Partial unique indexes: doc_categories(space_id,slug) / docs(space_id,path)
 * - CHECK 约束：doc_spaces(topic_id IS NULL OR board_id IS NULL)
 * - searchVector 维护 trigger（doc_sections，照 message 先例）
 * - docCount 维护 trigger（docs INSERT/软删/恢复 → doc_spaces.doc_count ±1，单一事实源）
 *
 * down() 完整 drop（不卸载 pg_trgm 扩展，注释说明共享扩展不删）
 */
export class AddDocSpaceModule1785326619653 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // =====================================================
    // 0. pg_trgm 扩展
    // postgres:15 官方镜像自带 contrib，无需额外安装
    // =====================================================
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // =====================================================
    // 1. doc_spaces
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE doc_spaces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(128) NOT NULL,
        description TEXT,
        topic_id UUID,
        board_id UUID,
        creator_id UUID NOT NULL,
        settings JSONB DEFAULT '{}'::jsonb,
        doc_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT chk_doc_spaces_binding CHECK (topic_id IS NULL OR board_id IS NULL)
      )
    `);

    // =====================================================
    // 2. doc_space_members
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE doc_space_members (
        space_id UUID NOT NULL REFERENCES doc_spaces(id) ON DELETE CASCADE,
        actor_id UUID NOT NULL,
        role VARCHAR(20) DEFAULT 'member',
        invited_by UUID,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (space_id, actor_id)
      )
    `);

    // =====================================================
    // 3. doc_categories
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE doc_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(128) NOT NULL,
        description TEXT,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 4. docs
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE docs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        category_id UUID,
        path VARCHAR(512) NOT NULL,
        title VARCHAR(200) NOT NULL,
        summary VARCHAR(500),
        doc_type VARCHAR(64),
        tags TEXT[] DEFAULT '{}',
        source VARCHAR(128) DEFAULT 'native',
        content_hash VARCHAR(64),
        section_count INT DEFAULT 0,
        token_estimate INT DEFAULT 0,
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 5. doc_sections
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE doc_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id UUID NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        position INT NOT NULL,
        heading_path VARCHAR(512),
        heading_level SMALLINT DEFAULT 0,
        content TEXT NOT NULL,
        token_estimate INT DEFAULT 0,
        search_vector TSVECTOR,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // =====================================================
    // 6. task_doc_links
    // =====================================================
    await queryRunner.query(`
      CREATE TABLE task_doc_links (
        task_id UUID NOT NULL,
        doc_id UUID NOT NULL,
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (task_id, doc_id)
      )
    `);

    // =====================================================
    // 7. GIN 索引（search_vector + trgm）
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_doc_sections_search_vector
      ON doc_sections USING GIN (search_vector)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_doc_sections_content_trgm
      ON doc_sections USING GIN (content gin_trgm_ops)
    `);

    await queryRunner.query(`
      CREATE INDEX idx_docs_title_trgm
      ON docs USING GIN (title gin_trgm_ops)
    `);

    // =====================================================
    // 8. 常规 btree 索引
    // =====================================================
    await queryRunner.query(`
      CREATE INDEX idx_docs_space_id ON docs (space_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_docs_category_id ON docs (category_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_doc_sections_doc_id_position ON doc_sections (doc_id, position)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_task_doc_links_doc_id ON task_doc_links (doc_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_doc_spaces_topic_id ON doc_spaces (topic_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_doc_spaces_board_id ON doc_spaces (board_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_doc_spaces_creator_id ON doc_spaces (creator_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_doc_space_members_actor_id ON doc_space_members (actor_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_doc_categories_space_id ON doc_categories (space_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_docs_created_by ON docs (created_by)
    `);

    // =====================================================
    // 9. Partial unique indexes（仅对未删除行生效）
    // =====================================================
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_doc_categories_space_slug
      ON doc_categories (space_id, slug)
      WHERE deleted_at IS NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_docs_space_path
      ON docs (space_id, path)
      WHERE deleted_at IS NULL
    `);

    // =====================================================
    // 10. searchVector 维护 trigger（doc_sections）
    // 照抄 message 先例：to_tsvector('simple', ...)
    // content + headingPath 拼接入向量
    // =====================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_doc_section_search_vector()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content
           OR NEW.heading_path IS DISTINCT FROM OLD.heading_path THEN
          NEW.search_vector := to_tsvector('simple',
            COALESCE(NEW.heading_path, '') || ' ' || COALESCE(NEW.content, '')
          );
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_doc_sections_search_vector
      BEFORE INSERT OR UPDATE ON doc_sections
      FOR EACH ROW
      EXECUTE FUNCTION maintain_doc_section_search_vector()
    `);

    // =====================================================
    // 11. docCount 维护 trigger（docs → doc_spaces.doc_count）
    //
    // 单一事实源：应用层禁写 doc_spaces.doc_count，
    // 全部由该 trigger 自动维护。
    //
    // 教训：v1.27 双写 bug——应用层与 trigger 同时更新计数导致不一致，
    // 本次严格只由 trigger 更新。
    // =====================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_doc_space_doc_count()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          -- 新建文档（未删除）
          IF NEW.deleted_at IS NULL THEN
            UPDATE doc_spaces SET doc_count = doc_count + 1 WHERE id = NEW.space_id;
          END IF;
        ELSIF TG_OP = 'UPDATE' THEN
          -- 软删除：从未删除 → 已删除
          IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
            UPDATE doc_spaces SET doc_count = doc_count - 1 WHERE id = NEW.space_id;
          -- 恢复：从已删除 → 未删除
          ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
            UPDATE doc_spaces SET doc_count = doc_count + 1 WHERE id = NEW.space_id;
          END IF;
        ELSIF TG_OP = 'DELETE' THEN
          -- 硬删除（通常不走，软删除才是主路径；防御性减一）
          IF OLD.deleted_at IS NULL THEN
            UPDATE doc_spaces SET doc_count = doc_count - 1 WHERE id = OLD.space_id;
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_docs_doc_count
      AFTER INSERT OR UPDATE OR DELETE ON docs
      FOR EACH ROW
      EXECUTE FUNCTION maintain_doc_space_doc_count()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ⚠️ 不卸载 pg_trgm 扩展（共享扩展，其他模块/未来可能依赖）

    // Drop triggers first (depend on functions)
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_docs_doc_count ON docs`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_doc_sections_search_vector ON doc_sections`,
    );

    // Drop functions
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_doc_space_doc_count()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_doc_section_search_vector()`);

    // Drop tables (CASCADE to handle FK deps)
    await queryRunner.query(`DROP TABLE IF EXISTS task_doc_links`);
    await queryRunner.query(`DROP TABLE IF EXISTS doc_sections`);
    await queryRunner.query(`DROP TABLE IF EXISTS docs`);
    await queryRunner.query(`DROP TABLE IF EXISTS doc_categories`);
    await queryRunner.query(`DROP TABLE IF EXISTS doc_space_members`);
    await queryRunner.query(`DROP TABLE IF EXISTS doc_spaces`);

    // Note: pg_trgm extension is NOT dropped — it may be used by other modules
  }
}
