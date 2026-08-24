import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill: creator 写入成员表（Board 任务 4b1ddd1c）。
 *
 * 背景：board.service.create() / docspace.service.create() 历史上只给 invitedAgentIds
 * 写成员行，creator 不落表——成员列表 API 缺 creator、按成员表算可见性的查询路径
 * （AccessQueryService.computeAccessibleBoardIds / computeAccessibleDocSpaceIds）对
 * creator 不命中。应用层修复后，存量资源需本 migration 补齐 creator 成员行。
 *
 * 语义约定（与应用层 create() 写入行为严格一致）：
 *   - role='editor'（creator 实际能力=可写，与 isCreator 语义对齐；不新增 owner 枚举）
 *   - invited_by=NULL 标记「非授予产生」——这是 down() 精确回滚的判别键
 *
 * down() 安全性核实结论（2026-08-21，代码走查 board/docspace 两 service）：
 *   - addEditor 新建 editor 行：invitedBy = 资源 creatorId，恒非 NULL
 *   - inviteAgent / update(invitedAgentIds) 写 member 行：invitedBy = creatorId，恒非 NULL
 *   - member→editor 升级：保留原 invitedBy（来源路径均非 NULL）
 *   ⇒ 所有「授予/升级」产生的 editor 行 invited_by 均非 NULL，down() 按
 *     invited_by IS NULL 过滤不会误删。
 *
 * 已知边界（可接受，注释留档）：
 *   1. ConsolidateMembership(1785100000000) 3a 从 settings.editorIds jsonb 回填的
 *      editor 行 invited_by 为 NULL——若其 actor 恰为该资源 creator，down() 会一并删除。
 *      该行与本 migration 要补的行语义完全相同（creator=editor），删除后 creator 仍经
 *      isCreator 直比保有全部权限，仅成员列表少一行展示，无权限损失。
 *   2. creator_id IS NOT NULL 守卫为防御性：当前 schema 两列均 NOT NULL，
 *      保留守卫防历史/环境差异下 NULL 进 PK 列炸迁移。
 */
export class BackfillCreatorMembership1787300000000 implements MigrationInterface {
  name = 'BackfillCreatorMembership1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // board_members：creator → editor 行。NOT EXISTS 防与既有任意 role 行撞 PK；
    // ON CONFLICT DO NOTHING 兜底并发/重复执行
    await queryRunner.query(`
      INSERT INTO "board_members" ("board_id", "actor_id", "role", "invited_by")
      SELECT b."id", b."creator_id", 'editor', NULL
      FROM "boards" b
      WHERE b."deleted_at" IS NULL
        AND b."creator_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "board_members" bm
          WHERE bm."board_id" = b."id" AND bm."actor_id" = b."creator_id"
        )
      ON CONFLICT ("board_id", "actor_id") DO NOTHING
    `);

    // doc_space_members：同款处理
    await queryRunner.query(`
      INSERT INTO "doc_space_members" ("space_id", "actor_id", "role", "invited_by")
      SELECT d."id", d."creator_id", 'editor', NULL
      FROM "doc_spaces" d
      WHERE d."deleted_at" IS NULL
        AND d."creator_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "doc_space_members" dm
          WHERE dm."space_id" = d."id" AND dm."actor_id" = d."creator_id"
        )
      ON CONFLICT ("space_id", "actor_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 精确回滚：只删「actor = 资源 creator 且 role='editor' 且 invited_by IS NULL」的行
    // ——即本 migration up() 的写入特征。禁止按 role='editor' 裸删（会误删 addEditor
    // 授予行，见文件头核实结论）。USING join 替代子查询，走 PK 索引。
    await queryRunner.query(`
      DELETE FROM "board_members" bm
      USING "boards" b
      WHERE bm."board_id" = b."id"
        AND bm."actor_id" = b."creator_id"
        AND bm."role" = 'editor'
        AND bm."invited_by" IS NULL
    `);

    await queryRunner.query(`
      DELETE FROM "doc_space_members" dm
      USING "doc_spaces" d
      WHERE dm."space_id" = d."id"
        AND dm."actor_id" = d."creator_id"
        AND dm."role" = 'editor'
        AND dm."invited_by" IS NULL
    `);
  }
}
