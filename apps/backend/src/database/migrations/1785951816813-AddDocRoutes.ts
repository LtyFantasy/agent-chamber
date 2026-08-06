import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * doc_routes 建表迁移（v1.42 批次 B5：INDEX.md 意图路由结构化）
 *
 * 设计要点：
 * - 全加法：新表不影响任何存量表/数据，符合迁移兼容铁律
 * - 裸 uuid 无 FK（对齐 task_doc_links 惯例）：doc 软删后路由行仍保留（校验在 Service 层），
 *   避免 FK 级联删除丢失路由策展数据；doc 存在性与归属由写时校验保证（DOC_ROUTE_DOC_NOT_FOUND）
 * - id 用 gen_random_uuid()（对齐 AddDocSpaceModule 建表写法；PG13+ 内置，无需 uuid-ossp 扩展）
 * - space_id 索引：overview 内嵌按空间全量拉取（批次 B5 overview routes 段）+ GET /doc-spaces/:id/routes
 * - 已知边界：写时校验只保证写入当下可解析；doc 后续编辑致 headingPath 悬空属批次 C 异步校验范围
 *
 * down() 直接 DROP 表（新表无存量数据依赖，可安全逆序）。
 */
export class AddDocRoutes1785951816813 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS doc_routes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        space_id UUID NOT NULL,
        intent VARCHAR(200) NOT NULL,
        category VARCHAR(100),
        primary_doc_id UUID NOT NULL,
        primary_heading_path VARCHAR(512),
        secondary_doc_id UUID,
        secondary_heading_path VARCHAR(512),
        code_entry VARCHAR(512),
        sort_order INT NOT NULL DEFAULT 0,
        created_by UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_doc_routes_space_id ON doc_routes (space_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS doc_routes`);
  }
}
