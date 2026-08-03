import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Batch 2: 成员/权限收敛进关系表 + Board 权限自治。
 *
 * up():
 *   1. 新建 board_members 表（PK(board_id, actor_id)，board_id FK→boards ON DELETE CASCADE）
 *   2. topic_participants 加 status 列（invited|active|left），由 is_active 回填
 *   3. 回填 board_members：
 *      a. boards.settings.editorIds → role='editor'（含独立看板，不经 topic join）
 *      b. boards.settings.invitedAgentIds → role='member'
 *      c. 关联 topic 的 active participants → role='member'（权限等价回填，R5 缓解）
 *   4. topics.settings.invitedAgentIds → topic_participants(status='invited')，ON CONFLICT DO NOTHING
 *   5. 清理 settings jsonb 四字段
 *   6. 删 topic_participants.is_active
 *   7. 防御校验（DO $$）
 *
 * down():
 *   逆序：恢复 is_active → 反写 jsonb → 删 status → drop board_members
 *
 * 生产审计实测细节：
 *   (a) topics invited jsonb 4 条全是陈旧重复（actor 已 active）→ ON CONFLICT DO NOTHING
 *   (b) 独立看板（topic_id=NULL）有 editorIds → 搬迁不经 topic join
 *   (c) topic creator 的参与者行 role=member → 保持原样
 */
export class ConsolidateMembership1785100000000 implements MigrationInterface {
  name = 'ConsolidateMembership1785100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 1. 新建 board_members 表
    // board_id FK→boards ON DELETE CASCADE：有意偏离项目「无 DB FK」惯例。
    // 理由：board_members 是 board 的组成数据，board 删除后成员行无独立存在意义。
    // actor_id / invited_by 裸 uuid（沿用项目惯例，不建 FK 到 actors）。
    // =========================================================================
    await queryRunner.query(`
      CREATE TABLE "board_members" (
        "board_id" uuid NOT NULL,
        "actor_id" uuid NOT NULL,
        "role" varchar(20) NOT NULL DEFAULT 'member',
        "invited_by" uuid NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_board_members" PRIMARY KEY ("board_id", "actor_id"),
        CONSTRAINT "FK_board_members_board_id" FOREIGN KEY ("board_id")
          REFERENCES "boards"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_board_members_actor_id" ON "board_members" ("actor_id")`,
    );

    // =========================================================================
    // 2. topic_participants 加 status 列，回填
    // =========================================================================
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD COLUMN "status" varchar(20) NOT NULL DEFAULT 'active'`,
    );
    // is_active=false → status='left'
    await queryRunner.query(`
      UPDATE "topic_participants" SET "status" = 'left' WHERE "is_active" = false
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_topic_participants_status" ON "topic_participants" ("status")`,
    );

    // =========================================================================
    // 3. 回填 board_members（顺序即优先级，role 取高 editor>member）
    // =========================================================================

    // 3a. editorIds → role='editor'（含独立看板，不经 topic join）
    await queryRunner.query(`
      INSERT INTO "board_members" ("board_id", "actor_id", "role")
      SELECT b.id, e.actor_id::uuid, 'editor'
      FROM "boards" b,
           jsonb_array_elements_text(
             CASE WHEN b.settings ? 'editorIds'
                  THEN b.settings->'editorIds'
                  ELSE '[]'::jsonb
             END
           ) AS e(actor_id)
      WHERE b.deleted_at IS NULL
      ON CONFLICT ("board_id", "actor_id") DO NOTHING
    `);

    // 3b. invitedAgentIds → role='member'（生产 0 条，规则保留）
    await queryRunner.query(`
      INSERT INTO "board_members" ("board_id", "actor_id", "role")
      SELECT b.id, i.actor_id::uuid, 'member'
      FROM "boards" b,
           jsonb_array_elements_text(
             CASE WHEN b.settings ? 'invitedAgentIds'
                  THEN b.settings->'invitedAgentIds'
                  ELSE '[]'::jsonb
             END
           ) AS i(actor_id)
      WHERE b.deleted_at IS NULL
      ON CONFLICT ("board_id", "actor_id") DO NOTHING
    `);

    // 3c. 关联 topic 的 active participants → role='member'（权限等价回填，R5 缓解）
    await queryRunner.query(`
      INSERT INTO "board_members" ("board_id", "actor_id", "role")
      SELECT DISTINCT b.id, tp.participant_id, 'member'
      FROM "boards" b
      JOIN "topic_participants" tp ON tp.topic_id = b.topic_id
      WHERE b.deleted_at IS NULL
        AND b.topic_id IS NOT NULL
        AND tp.status = 'active'
      ON CONFLICT ("board_id", "actor_id") DO NOTHING
    `);

    // =========================================================================
    // 4. topics.settings.invitedAgentIds → topic_participants(status='invited')
    //    ON CONFLICT DO NOTHING：不得覆盖已有 active/left 行（实测细节 a）
    //    invitedHumanIds 同理（生产零数据，SQL 通配）
    // =========================================================================
    await queryRunner.query(`
      INSERT INTO "topic_participants" ("topic_id", "participant_id", "role", "status", "joined_at")
      SELECT t.id, i.actor_id::uuid, 'member', 'invited', now()
      FROM "topics" t,
           jsonb_array_elements_text(
             CASE WHEN t.settings ? 'invitedAgentIds'
                  THEN t.settings->'invitedAgentIds'
                  ELSE '[]'::jsonb
             END
           ) AS i(actor_id)
      WHERE t.deleted_at IS NULL
      ON CONFLICT ("topic_id", "participant_id") DO NOTHING
    `);

    // invitedHumanIds（生产零数据，通配覆盖）
    await queryRunner.query(`
      INSERT INTO "topic_participants" ("topic_id", "participant_id", "role", "status", "joined_at")
      SELECT t.id, h.actor_id::uuid, 'member', 'invited', now()
      FROM "topics" t,
           jsonb_array_elements_text(
             CASE WHEN t.settings ? 'invitedHumanIds'
                  THEN t.settings->'invitedHumanIds'
                  ELSE '[]'::jsonb
             END
           ) AS h(actor_id)
      WHERE t.deleted_at IS NULL
      ON CONFLICT ("topic_id", "participant_id") DO NOTHING
    `);

    // =========================================================================
    // 5. 防御校验（必须在 jsonb 清理之前执行——editorIds 计数依赖 settings 原文）
    // =========================================================================
    await queryRunner.query(`
      DO $$ DECLARE
        editor_count int;
        bm_count int;
        bad_status_count int;
      BEGIN
        -- board_members 行数不应少于 editorIds 总条数
        SELECT COUNT(*) INTO editor_count FROM (
          SELECT 1 FROM "boards" b,
            jsonb_array_elements_text(
              CASE WHEN b.settings ? 'editorIds'
                   THEN b.settings->'editorIds'
                   ELSE '[]'::jsonb
              END
            ) AS e(actor_id)
          WHERE b.deleted_at IS NULL
        ) sub;
        SELECT COUNT(*) INTO bm_count FROM "board_members";
        IF bm_count < editor_count THEN
          RAISE EXCEPTION 'ConsolidateMembership: board_members count (%) < editorIds total (%). Data loss suspected.', bm_count, editor_count;
        END IF;

        -- topic_participants.status 只能为 invited/active/left
        SELECT COUNT(*) INTO bad_status_count
        FROM "topic_participants"
        WHERE "status" NOT IN ('invited', 'active', 'left');
        IF bad_status_count > 0 THEN
          RAISE EXCEPTION 'ConsolidateMembership: % topic_participants row(s) have invalid status.', bad_status_count;
        END IF;
      END $$
    `);

    // =========================================================================
    // 6. 清理 settings jsonb 四字段
    // =========================================================================
    await queryRunner.query(
      `UPDATE "topics" SET "settings" = "settings" - 'invitedAgentIds' - 'invitedHumanIds' WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "boards" SET "settings" = "settings" - 'invitedAgentIds' - 'editorIds' WHERE "deleted_at" IS NULL`,
    );

    // =========================================================================
    // 7. 删除依赖 is_active 的触发器，然后删列，再用 status 重建触发器
    // =========================================================================
    // 触发器 trg_topics_participant_count 依赖 is_active 列，必须先删
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_topics_participant_count ON "topic_participants"`,
    );
    // 删列
    await queryRunner.query(`ALTER TABLE "topic_participants" DROP COLUMN "is_active"`);
    // 重建触发器函数与触发器：用 status 替代 is_active
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_topic_participant_count()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
          UPDATE topics SET participant_count = participant_count + 1 WHERE id = NEW.topic_id;
        ELSIF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
          UPDATE topics SET participant_count = participant_count + CASE WHEN NEW.status = 'active' THEN 1 ELSE -1 END WHERE id = NEW.topic_id;
        ELSIF TG_OP = 'DELETE' AND OLD.status = 'active' THEN
          UPDATE topics SET participant_count = GREATEST(participant_count - 1, 0) WHERE id = OLD.topic_id;
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_topics_participant_count
      AFTER INSERT OR DELETE OR UPDATE OF status
      ON "topic_participants"
      FOR EACH ROW
      EXECUTE FUNCTION maintain_topic_participant_count()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // =========================================================================
    // 逆序恢复
    // =========================================================================

    // 1. Drop new trigger, restore is_active, recreate old trigger
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_topics_participant_count ON "topic_participants"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD COLUMN "is_active" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(`
      UPDATE "topic_participants" SET "is_active" = false WHERE "status" = 'left'
    `);
    // 恢复旧触发器函数与触发器
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_topic_participant_count()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.is_active = TRUE THEN
          UPDATE topics SET participant_count = participant_count + 1 WHERE id = NEW.topic_id;
        ELSIF TG_OP = 'UPDATE' AND OLD.is_active != NEW.is_active THEN
          UPDATE topics SET participant_count = participant_count + CASE WHEN NEW.is_active THEN 1 ELSE -1 END WHERE id = NEW.topic_id;
        ELSIF TG_OP = 'DELETE' AND OLD.is_active = TRUE THEN
          UPDATE topics SET participant_count = GREATEST(participant_count - 1, 0) WHERE id = OLD.topic_id;
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_topics_participant_count
      AFTER INSERT OR DELETE OR UPDATE OF is_active
      ON "topic_participants"
      FOR EACH ROW
      EXECUTE FUNCTION maintain_topic_participant_count()
    `);

    // 2. 从关系表反写 jsonb 四字段
    // editorIds：由 board_members role='editor' 行生成
    await queryRunner.query(`
      UPDATE "boards" b SET "settings" = jsonb_set(
        COALESCE(b."settings", '{}'::jsonb),
        '{editorIds}',
        COALESCE((
          SELECT jsonb_agg(bm.actor_id)
          FROM "board_members" bm
          WHERE bm.board_id = b.id AND bm.role = 'editor'
        ), '[]'::jsonb)
      )
    `);

    // board invitedAgentIds：由 board_members role='member' 行生成
    // 注释：反写为尽力恢复——3c 的 topic 回填行会进入 board invitedAgentIds，
    // 与迁移前不等价但权限等价。
    await queryRunner.query(`
      UPDATE "boards" b SET "settings" = jsonb_set(
        COALESCE(b."settings", '{}'::jsonb),
        '{invitedAgentIds}',
        COALESCE((
          SELECT jsonb_agg(bm.actor_id)
          FROM "board_members" bm
          WHERE bm.board_id = b.id AND bm.role = 'member'
        ), '[]'::jsonb)
      )
    `);

    // topic invitedAgentIds：由 topic_participants status='invited' 行生成
    await queryRunner.query(`
      UPDATE "topics" t SET "settings" = jsonb_set(
        COALESCE(t."settings", '{}'::jsonb),
        '{invitedAgentIds}',
        COALESCE((
          SELECT jsonb_agg(tp.participant_id)
          FROM "topic_participants" tp
          WHERE tp.topic_id = t.id AND tp.status = 'invited'
        ), '[]'::jsonb)
      )
    `);

    // invitedHumanIds 反写空数组（生产零数据，down 不试图精确恢复）
    await queryRunner.query(`
      UPDATE "topics" t SET "settings" = jsonb_set(
        COALESCE(t."settings", '{}'::jsonb),
        '{invitedHumanIds}',
        '[]'::jsonb
      )
    `);

    // 3. 删 status 列
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_topic_participants_status"`);
    await queryRunner.query(`ALTER TABLE "topic_participants" DROP COLUMN "status"`);

    // 4. Drop board_members
    await queryRunner.query(`DROP TABLE IF EXISTS "board_members"`);
  }
}
