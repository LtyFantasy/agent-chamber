import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActorUnification1781364902335 implements MigrationInterface {
  name = 'ActorUnification1781364902335';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_agent_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "api_keys" DROP CONSTRAINT "api_keys_created_by_fkey"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP CONSTRAINT "agents_owner_id_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_agent_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" DROP CONSTRAINT "topic_participants_topic_id_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "messages_topic_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "messages_reply_to_id_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "task_comments" DROP CONSTRAINT "task_comments_task_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" DROP CONSTRAINT "task_comments_reply_to_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_activities" DROP CONSTRAINT "task_activities_task_id_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "tasks_list_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "tasks_topic_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_id_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "board_lists" DROP CONSTRAINT "board_lists_board_id_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "boards" DROP CONSTRAINT "boards_topic_id_fkey"`);
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" DROP CONSTRAINT "agent_heartbeats_agent_id_fkey"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_api_keys_agent_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_api_keys_key_hash"`);
    await queryRunner.query(`DROP INDEX "public"."idx_api_keys_revoked"`);
    await queryRunner.query(`DROP INDEX "public"."idx_agents_owner_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_agents_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_agents_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_agents_last_active"`);
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_user_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_token_hash"`);
    await queryRunner.query(`DROP INDEX "public"."idx_users_username"`);
    await queryRunner.query(`DROP INDEX "public"."idx_users_email"`);
    await queryRunner.query(`DROP INDEX "public"."idx_users_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_users_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_users_role"`);
    await queryRunner.query(`DROP INDEX "public"."idx_wd_agent_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_wd_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_wd_next_retry"`);
    await queryRunner.query(`DROP INDEX "public"."idx_wd_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tp_topic_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tp_participant"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tp_active"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_topic_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_sender"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_reply_to"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_type"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_messages_search"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_comments_task_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_comments_author"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_comments_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_activities_task_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_activities_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_dependencies_unique"`);
    await queryRunner.query(`DROP INDEX "public"."idx_task_dependencies_depends_on"`);
    await queryRunner.query(`DROP INDEX "public"."idx_milestones_topic_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_list_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_topic_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_assignee"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_priority"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_due_date"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_parent_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_search"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_status_priority"`);
    await queryRunner.query(`DROP INDEX "public"."idx_tasks_milestone_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_board_lists_board_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_board_lists_position"`);
    await queryRunner.query(`DROP INDEX "public"."idx_board_lists_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_board_list_mapped_status_unique"`);
    await queryRunner.query(`DROP INDEX "public"."idx_boards_topic_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_boards_creator"`);
    await queryRunner.query(`DROP INDEX "public"."idx_boards_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_topics_status"`);
    await queryRunner.query(`DROP INDEX "public"."idx_topics_creator"`);
    await queryRunner.query(`DROP INDEX "public"."idx_topics_last_message"`);
    await queryRunner.query(`DROP INDEX "public"."idx_topics_deleted_at"`);
    await queryRunner.query(`DROP INDEX "public"."idx_topics_status_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_cursor"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_resource"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_type_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_delivered"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_actor"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_topic_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_events_board_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_entity"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_actor"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_created"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_action"`);
    await queryRunner.query(`DROP INDEX "public"."idx_ahb_agent_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_ahb_timestamp"`);
    // users/agents 的 updated_at 等公共字段即将迁移到 actors，旧 trigger 会引用不存在的列
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_users_updated_at" ON "users"`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_agents_updated_at" ON "agents"`);
    await queryRunner.query(
      `CREATE TYPE "public"."actors_type_enum" AS ENUM('human', 'agent', 'system')`,
    );
    await queryRunner.query(
      `CREATE TABLE "actors" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."actors_type_enum" NOT NULL DEFAULT 'human', "display_name" character varying(100), "avatar_url" text, "status" character varying(20) NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_d8608598c2c4f907a78de2ae461" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT id FROM users INTERSECT SELECT id FROM agents) THEN
                    RAISE EXCEPTION 'users and agents share at least one id; actor unification cannot proceed';
                END IF;
            END $$;
        `);
    await queryRunner.query(`
            INSERT INTO actors (id, type, display_name, avatar_url, status, created_at, updated_at, deleted_at)
            VALUES ('00000000-0000-0000-0000-000000000000', 'system', NULL, NULL, 'active', now(), now(), NULL)
            ON CONFLICT (id) DO NOTHING;
        `);
    await queryRunner.query(`
            INSERT INTO actors (id, type, display_name, avatar_url, status, created_at, updated_at, deleted_at)
            SELECT id, 'human', display_name, avatar_url, status, created_at, updated_at, deleted_at
            FROM users;
        `);
    await queryRunner.query(`
            INSERT INTO actors (id, type, display_name, avatar_url, status, created_at, updated_at, deleted_at)
            SELECT id, 'agent', name, avatar_url, status::text, created_at, updated_at, deleted_at
            FROM agents;
        `);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "avatar_url"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "status"`);

    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "updated_at"`);
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN "deleted_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "display_name"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "avatar_url"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "status"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "created_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "updated_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "deleted_at"`);
    await queryRunner.query(
      `ALTER TABLE "topic_participants" DROP CONSTRAINT "topic_participants_pkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD CONSTRAINT "topic_participants_pkey" PRIMARY KEY ("topic_id", "participant_id")`,
    );
    await queryRunner.query(`ALTER TABLE "topic_participants" DROP COLUMN "participant_type"`);

    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "sender_type"`);

    await queryRunner.query(`ALTER TABLE "task_comments" DROP COLUMN "author_type"`);

    await queryRunner.query(`ALTER TABLE "task_activities" DROP COLUMN "actor_type"`);

    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "assignee_type"`);

    await queryRunner.query(`ALTER TABLE "boards" DROP COLUMN "creator_type"`);

    await queryRunner.query(`ALTER TABLE "topics" DROP COLUMN "creator_type"`);

    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN "actor_type"`);

    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN "actor_type"`);
    await queryRunner.query(`DROP TYPE "public"."actor_type"`);

    await queryRunner.query(
      `UPDATE "api_keys" SET "permissions" = '{"scopes":["read","write"]}' WHERE "permissions" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agents" SET "webhook_events" = '{new_message,mention,task_update}'::event_type[] WHERE "webhook_events" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agents" SET "webhook_timeout_ms" = 30000 WHERE "webhook_timeout_ms" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agents" SET "webhook_retry_max" = 3 WHERE "webhook_retry_max" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agents" SET "model_config" = '{}'::jsonb WHERE "model_config" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agents" SET "rate_limit" = '{"requests_per_minute":60,"tokens_per_day":100000}'::jsonb WHERE "rate_limit" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "auth_provider" = 'local' WHERE "auth_provider" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "preferences" = '{}'::jsonb WHERE "preferences" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "webhook_deliveries" SET "headers" = '{}'::jsonb WHERE "headers" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "topic_participants" SET "notification_settings" = '{"mute":false,"mentions_only":false}'::jsonb WHERE "notification_settings" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "messages" SET "mentions" = '[]'::jsonb WHERE "mentions" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "messages" SET "metadata" = '{}'::jsonb WHERE "metadata" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "messages" SET "edit_history" = '[]'::jsonb WHERE "edit_history" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "task_comments" SET "content_format" = 'markdown' WHERE "content_format" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "task_activities" SET "meta" = '{}'::jsonb WHERE "meta" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "tasks" SET "description_format" = 'markdown' WHERE "description_format" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "tasks" SET "custom_fields" = '{}'::jsonb WHERE "custom_fields" IS NULL`,
    );
    await queryRunner.query(`UPDATE "board_lists" SET "color" = '#e5e7eb' WHERE "color" IS NULL`);
    await queryRunner.query(`UPDATE "boards" SET "color" = '#6366f1' WHERE "color" IS NULL`);
    await queryRunner.query(
      `UPDATE "boards" SET "settings" = '{"archived_lists_visible":false,"allow_wip_limit":true}'::jsonb WHERE "settings" IS NULL`,
    );
    await queryRunner.query(`UPDATE "topics" SET "agenda" = '[]'::jsonb WHERE "agenda" IS NULL`);
    await queryRunner.query(
      `UPDATE "topics" SET "settings" = '{"allow_agent_proposal":true,"vote_threshold":3}'::jsonb WHERE "settings" IS NULL`,
    );
    await queryRunner.query(`UPDATE "audit_logs" SET "source" = 'api' WHERE "source" IS NULL`);
    await queryRunner.query(
      `UPDATE "agent_heartbeats" SET "active_tasks" = 0 WHERE "active_tasks" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agent_heartbeats" SET "queue_depth" = 0 WHERE "queue_depth" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agent_heartbeats" SET "processed_events" = 0 WHERE "processed_events" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agent_heartbeats" SET "error_count" = 0 WHERE "error_count" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "agent_heartbeats" SET "meta" = '{}'::jsonb WHERE "meta" IS NULL`,
    );
    await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "permissions" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "api_keys" ALTER COLUMN "permissions" SET DEFAULT '{"scopes":["read","write"]}'`,
    );
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "id" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "webhook_events" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "webhook_timeout_ms" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "webhook_retry_max" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "model_config" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "rate_limit" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "agents" ALTER COLUMN "rate_limit" SET DEFAULT '{"requests_per_minute":60,"tokens_per_day":100000}'`,
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "uq_users_username"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "uq_users_email"`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "auth_provider" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'editor'`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "preferences" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "webhook_deliveries" ALTER COLUMN "headers" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "notification_settings" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "notification_settings" SET DEFAULT '{"mute":false,"mentions_only":false}'`,
    );
    await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "mentions" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "metadata" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "edit_history" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "task_comments" ALTER COLUMN "content_format" SET NOT NULL`,
    );

    await queryRunner.query(`ALTER TABLE "task_activities" ALTER COLUMN "meta" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ALTER COLUMN "dependency_type" DROP DEFAULT`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."task_dependencies_dependency_type_enum" AS ENUM('blocks', 'relates_to', 'duplicates')`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ALTER COLUMN "dependency_type" TYPE "public"."task_dependencies_dependency_type_enum" USING "dependency_type"::text::"public"."task_dependencies_dependency_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ALTER COLUMN "dependency_type" SET DEFAULT 'blocks'`,
    );
    await queryRunner.query(`ALTER TABLE "milestones" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE TYPE "public"."milestones_status_enum" AS ENUM('planned', 'active', 'completed', 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TABLE "milestones" ALTER COLUMN "status" TYPE "public"."milestones_status_enum" USING "status"::text::"public"."milestones_status_enum"`,
    );
    await queryRunner.query(`ALTER TABLE "milestones" ALTER COLUMN "status" SET DEFAULT 'planned'`);
    await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "description_format" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "custom_fields" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "board_lists" ALTER COLUMN "color" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "boards" ALTER COLUMN "color" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "boards" ALTER COLUMN "settings" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "boards" ALTER COLUMN "settings" SET DEFAULT '{"archived_lists_visible":false,"allow_wip_limit":true}'`,
    );
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "agenda" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "settings" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "topics" ALTER COLUMN "settings" SET DEFAULT '{"allow_agent_proposal":true,"vote_threshold":3}'`,
    );
    await queryRunner.query(`ALTER TABLE "events" ALTER COLUMN "cursor" DROP DEFAULT`);
    await queryRunner.query(`DROP SEQUENCE "events_cursor_seq"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "source" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "active_tasks" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "queue_depth" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "processed_events" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "error_count" SET NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "agent_heartbeats" ALTER COLUMN "meta" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agent_heartbeats" ALTER COLUMN "timestamp" DROP DEFAULT`);

    // 在重新添加外键前清理孤立的外键记录，避免迁移失败
    // 这些记录指向已不存在的父表行，属于无效数据
    await queryRunner.query(
      `DELETE FROM "task_dependencies" WHERE "task_id" NOT IN (SELECT "id" FROM "tasks")`,
    );
    await queryRunner.query(
      `DELETE FROM "task_dependencies" WHERE "depends_on_task_id" NOT IN (SELECT "id" FROM "tasks")`,
    );
    await queryRunner.query(
      `DELETE FROM "task_comments" WHERE "task_id" NOT IN (SELECT "id" FROM "tasks")`,
    );
    await queryRunner.query(
      `UPDATE "task_comments" SET "reply_to_id" = NULL WHERE "reply_to_id" IS NOT NULL AND "reply_to_id" NOT IN (SELECT "id" FROM "task_comments")`,
    );
    await queryRunner.query(
      `DELETE FROM "task_activities" WHERE "task_id" NOT IN (SELECT "id" FROM "tasks")`,
    );
    await queryRunner.query(
      `UPDATE "messages" SET "reply_to_id" = NULL WHERE "reply_to_id" IS NOT NULL AND "reply_to_id" NOT IN (SELECT "id" FROM "messages")`,
    );
    await queryRunner.query(
      `UPDATE "tasks" SET "parent_id" = NULL WHERE "parent_id" IS NOT NULL AND "parent_id" NOT IN (SELECT "id" FROM "tasks")`,
    );
    await queryRunner.query(
      `UPDATE "tasks" SET "milestone_id" = NULL WHERE "milestone_id" IS NOT NULL AND "milestone_id" NOT IN (SELECT "id" FROM "milestones")`,
    );
    await queryRunner.query(
      `UPDATE "boards" SET "topic_id" = NULL WHERE "topic_id" IS NOT NULL AND "topic_id" NOT IN (SELECT "id" FROM "topics")`,
    );
    await queryRunner.query(
      `DELETE FROM "messages" WHERE "topic_id" NOT IN (SELECT "id" FROM "topics")`,
    );
    await queryRunner.query(
      `UPDATE "tasks" SET "topic_id" = NULL WHERE "topic_id" IS NOT NULL AND "topic_id" NOT IN (SELECT "id" FROM "topics")`,
    );
    await queryRunner.query(
      `DELETE FROM "topic_participants" WHERE "topic_id" IS NOT NULL AND "topic_id" NOT IN (SELECT "id" FROM "topics")`,
    );
    await queryRunner.query(
      `DELETE FROM "board_lists" WHERE "board_id" NOT IN (SELECT "id" FROM "boards")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_57384430aa1959f4578046c9b8" ON "api_keys" ("key_hash") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8ca464af5c64010902e8538a5b" ON "agents" ("owner_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_a7838d2ba25be1342091b6695f" ON "refresh_tokens" ("token_hash") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b383987bfa6e6a8745085621d0" ON "users" ("email") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_a8eaa8aae9df08c92ddd446996" ON "users" ("username") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_47a340074173ac16958ea6744d" ON "webhook_deliveries" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3a9f7804d9ba197e1e0af695c6" ON "webhook_deliveries" ("agent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a97ec34eb69ec8031389582189" ON "topic_participants" ("participant_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d230942443f830304aab4ceba6" ON "topic_participants" ("topic_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_87183e91f31c528f4abc1cdc51" ON "messages" ("type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_54e66104dd534ed1c191e44096" ON "messages" ("reply_to_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_22133395bd13b970ccd0c34ab2" ON "messages" ("sender_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_543169865f32797584105b3fad" ON "messages" ("topic_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_76901a920ba9ec5be8dbd64d74" ON "task_comments" ("author_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ba9e465cfc707006e60aae5994" ON "task_comments" ("task_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6c16dbc1f4693fc90f1a7f87a9" ON "task_activities" ("task_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_26dedda08faccdb95aff99e112" ON "task_dependencies" ("depends_on_task_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_34abffd156d4d10466f5f254ef" ON "task_dependencies" ("task_id", "depends_on_task_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_218788423bd30c25f0eed48031" ON "milestones" ("topic_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b03c99063a4eaf084f069a4d5a" ON "tasks" ("parent_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bd213ab7fa55f02309c5f23bbc" ON "tasks" ("priority") `,
    );
    await queryRunner.query(`CREATE INDEX "IDX_6086c8dafbae729a930c04d865" ON "tasks" ("status") `);
    await queryRunner.query(
      `CREATE INDEX "IDX_855d484825b715c545349212c7" ON "tasks" ("assignee_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8cdb0faa4204a82b0cd8445d91" ON "tasks" ("topic_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f69dc09246817393a46eb2a47c" ON "tasks" ("list_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a5a390b2d8439a00a09d912f30" ON "board_lists" ("board_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_board_list_mapped_status_unique" ON "board_lists" ("board_id", "mapped_status") WHERE ((mapped_status IS NOT NULL) AND (deleted_at IS NULL))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3b21985113674a7d8241856d06" ON "boards" ("creator_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_addb25dcface64ca83bd4e2808" ON "boards" ("topic_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4f2581d11c46de072a66b2f1a9" ON "topics" ("creator_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_31293492ae5785f4d1703b114d" ON "topics" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d8c1f99a84b35bd0ea1c0883c0" ON "events" ("event_type", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cf9e0d36f1df70984788a6d849" ON "events" ("resource_type", "resource_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bd5f472327e3e99580d6ba1afc" ON "events" ("cursor") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2cd10fda8276bb995288acfbfb" ON "audit_logs" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_177183f29f438c488b5e8510cd" ON "audit_logs" ("actor_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7421efc125d95e413657efa3c6" ON "audit_logs" ("entity_type", "entity_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f53c992915f2952916e0b73b03" ON "agent_heartbeats" ("agent_id") `,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_unique_admin"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_unique_admin" ON "users" ("role") WHERE ((role)::text = 'admin'::text)`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "FK_7350a5d7ce8de0cca0b068e3b1b" FOREIGN KEY ("agent_id") REFERENCES "actors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "FK_983d7eb19ca94bb8e343293068e" FOREIGN KEY ("created_by") REFERENCES "actors"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD CONSTRAINT "FK_9c653f28ae19c5884d5baf6a1d9" FOREIGN KEY ("id") REFERENCES "actors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD CONSTRAINT "FK_8ca464af5c64010902e8538a5ba" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4" FOREIGN KEY ("user_id") REFERENCES "actors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_a3ffb1c0c8416b9fc6f907b7433" FOREIGN KEY ("id") REFERENCES "actors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "FK_3a9f7804d9ba197e1e0af695c61" FOREIGN KEY ("agent_id") REFERENCES "actors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD CONSTRAINT "FK_d230942443f830304aab4ceba67" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_543169865f32797584105b3fad5" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_54e66104dd534ed1c191e44096f" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" ADD CONSTRAINT "FK_ba9e465cfc707006e60aae59946" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" ADD CONSTRAINT "FK_000653d0d548707e8fe796bdbcd" FOREIGN KEY ("reply_to_id") REFERENCES "task_comments"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_activities" ADD CONSTRAINT "FK_6c16dbc1f4693fc90f1a7f87a96" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_1ae6688b1bd90fffe857f4cb707" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_26dedda08faccdb95aff99e112e" FOREIGN KEY ("depends_on_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_39abeb50240a7312a00786c9b24" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_f69dc09246817393a46eb2a47c5" FOREIGN KEY ("list_id") REFERENCES "board_lists"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_8cdb0faa4204a82b0cd8445d919" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_b03c99063a4eaf084f069a4d5a7" FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "board_lists" ADD CONSTRAINT "FK_a5a390b2d8439a00a09d912f307" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "boards" ADD CONSTRAINT "FK_addb25dcface64ca83bd4e28088" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ADD CONSTRAINT "FK_f53c992915f2952916e0b73b030" FOREIGN KEY ("agent_id") REFERENCES "actors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" DROP CONSTRAINT "FK_f53c992915f2952916e0b73b030"`,
    );
    await queryRunner.query(
      `ALTER TABLE "boards" DROP CONSTRAINT "FK_addb25dcface64ca83bd4e28088"`,
    );
    await queryRunner.query(
      `ALTER TABLE "board_lists" DROP CONSTRAINT "FK_a5a390b2d8439a00a09d912f307"`,
    );
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_b03c99063a4eaf084f069a4d5a7"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_8cdb0faa4204a82b0cd8445d919"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_f69dc09246817393a46eb2a47c5"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_39abeb50240a7312a00786c9b24"`);
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_26dedda08faccdb95aff99e112e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_1ae6688b1bd90fffe857f4cb707"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_activities" DROP CONSTRAINT "FK_6c16dbc1f4693fc90f1a7f87a96"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" DROP CONSTRAINT "FK_000653d0d548707e8fe796bdbcd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" DROP CONSTRAINT "FK_ba9e465cfc707006e60aae59946"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_54e66104dd534ed1c191e44096f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_543169865f32797584105b3fad5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" DROP CONSTRAINT "FK_d230942443f830304aab4ceba67"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "FK_3a9f7804d9ba197e1e0af695c61"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "FK_a3ffb1c0c8416b9fc6f907b7433"`);
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" DROP CONSTRAINT "FK_8ca464af5c64010902e8538a5ba"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" DROP CONSTRAINT "FK_9c653f28ae19c5884d5baf6a1d9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP CONSTRAINT "FK_983d7eb19ca94bb8e343293068e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" DROP CONSTRAINT "FK_7350a5d7ce8de0cca0b068e3b1b"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_f53c992915f2952916e0b73b03"`);
    await queryRunner.query(`DROP INDEX "public"."idx_unique_admin"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_board_list_mapped_status_unique"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_7421efc125d95e413657efa3c6"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_177183f29f438c488b5e8510cd"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2cd10fda8276bb995288acfbfb"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bd5f472327e3e99580d6ba1afc"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_cf9e0d36f1df70984788a6d849"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d8c1f99a84b35bd0ea1c0883c0"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_31293492ae5785f4d1703b114d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_4f2581d11c46de072a66b2f1a9"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_addb25dcface64ca83bd4e2808"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3b21985113674a7d8241856d06"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a5a390b2d8439a00a09d912f30"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f69dc09246817393a46eb2a47c"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8cdb0faa4204a82b0cd8445d91"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_855d484825b715c545349212c7"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_6086c8dafbae729a930c04d865"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_bd213ab7fa55f02309c5f23bbc"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_b03c99063a4eaf084f069a4d5a"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_218788423bd30c25f0eed48031"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_34abffd156d4d10466f5f254ef"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_26dedda08faccdb95aff99e112"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_6c16dbc1f4693fc90f1a7f87a9"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ba9e465cfc707006e60aae5994"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_76901a920ba9ec5be8dbd64d74"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_543169865f32797584105b3fad"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_22133395bd13b970ccd0c34ab2"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_54e66104dd534ed1c191e44096"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_87183e91f31c528f4abc1cdc51"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_d230942443f830304aab4ceba6"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a97ec34eb69ec8031389582189"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3a9f7804d9ba197e1e0af695c6"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_47a340074173ac16958ea6744d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a8eaa8aae9df08c92ddd446996"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_b383987bfa6e6a8745085621d0"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a7838d2ba25be1342091b6695f"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8ca464af5c64010902e8538a5b"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_57384430aa1959f4578046c9b8"`);
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "timestamp" SET DEFAULT now()`,
    );
    await queryRunner.query(`ALTER TABLE "agent_heartbeats" ALTER COLUMN "meta" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "error_count" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "processed_events" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "queue_depth" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ALTER COLUMN "active_tasks" DROP NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "audit_logs" ALTER COLUMN "source" DROP NOT NULL`);
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "events_cursor_seq" OWNED BY "events"."cursor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ALTER COLUMN "cursor" SET DEFAULT nextval('"events_cursor_seq"')`,
    );
    await queryRunner.query(
      `ALTER TABLE "topics" ALTER COLUMN "settings" SET DEFAULT '{"vote_threshold": 3, "allow_agent_proposal": true}'`,
    );
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "settings" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "topics" ALTER COLUMN "agenda" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "boards" ALTER COLUMN "settings" SET DEFAULT '{"allow_wip_limit": true, "archived_lists_visible": false}'`,
    );
    await queryRunner.query(`ALTER TABLE "boards" ALTER COLUMN "settings" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "boards" ALTER COLUMN "color" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "board_lists" ALTER COLUMN "color" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "custom_fields" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "tasks" ALTER COLUMN "description_format" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "milestones" ALTER COLUMN "status" DROP DEFAULT`);
    await queryRunner.query(
      `ALTER TABLE "milestones" ALTER COLUMN "status" TYPE character varying(20) USING "status"::text`,
    );
    await queryRunner.query(`ALTER TABLE "milestones" ALTER COLUMN "status" SET DEFAULT 'planned'`);
    await queryRunner.query(`DROP TYPE "public"."milestones_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ALTER COLUMN "dependency_type" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ALTER COLUMN "dependency_type" TYPE character varying(20) USING "dependency_type"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ALTER COLUMN "dependency_type" SET DEFAULT 'blocks'`,
    );
    await queryRunner.query(`DROP TYPE "public"."task_dependencies_dependency_type_enum"`);
    await queryRunner.query(`ALTER TABLE "task_activities" ALTER COLUMN "meta" DROP NOT NULL`);

    await queryRunner.query(
      `ALTER TABLE "task_comments" ALTER COLUMN "content_format" DROP NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "edit_history" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "metadata" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ALTER COLUMN "mentions" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "notification_settings" SET DEFAULT '{"mute": false, "mentions_only": false}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ALTER COLUMN "notification_settings" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" ALTER COLUMN "headers" DROP NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "preferences" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'observer'`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "auth_provider" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "uq_users_email" UNIQUE ("email")`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "uq_users_username" UNIQUE ("username")`,
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`);
    await queryRunner.query(
      `ALTER TABLE "agents" ALTER COLUMN "rate_limit" SET DEFAULT '{"tokens_per_day": 100000, "requests_per_minute": 60}'`,
    );
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "rate_limit" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "model_config" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "webhook_retry_max" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "webhook_timeout_ms" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "webhook_events" DROP NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "agents" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ALTER COLUMN "permissions" SET DEFAULT '{"scopes": ["read", "write"]}'`,
    );
    await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "permissions" DROP NOT NULL`);

    await queryRunner.query(
      `CREATE TYPE "public"."actor_type" AS ENUM('human', 'agent', 'system')`,
    );
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD "actor_type" "public"."actor_type"`);

    await queryRunner.query(`ALTER TABLE "events" ADD "actor_type" "public"."actor_type"`);

    await queryRunner.query(
      `ALTER TABLE "topics" ADD "creator_type" "public"."actor_type" NOT NULL DEFAULT 'human'`,
    );

    await queryRunner.query(
      `ALTER TABLE "boards" ADD "creator_type" "public"."actor_type" NOT NULL DEFAULT 'human'`,
    );

    await queryRunner.query(`ALTER TABLE "tasks" ADD "assignee_type" "public"."actor_type"`);

    await queryRunner.query(
      `ALTER TABLE "task_activities" ADD "actor_type" "public"."actor_type" NOT NULL DEFAULT 'human'`,
    );

    await queryRunner.query(
      `ALTER TABLE "task_comments" ADD "author_type" "public"."actor_type" NOT NULL DEFAULT 'human'`,
    );

    await queryRunner.query(
      `ALTER TABLE "messages" ADD "sender_type" "public"."actor_type" NOT NULL DEFAULT 'human'`,
    );

    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD "participant_type" "public"."actor_type" NOT NULL DEFAULT 'human'`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" DROP CONSTRAINT "topic_participants_pkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD CONSTRAINT "topic_participants_pkey" PRIMARY KEY ("topic_id", "participant_id", "participant_type")`,
    );
    await queryRunner.query(`ALTER TABLE "users" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "status" character varying(20) NOT NULL DEFAULT 'active'`,
    );
    await queryRunner.query(`ALTER TABLE "users" ADD "avatar_url" text`);
    await queryRunner.query(`ALTER TABLE "users" ADD "display_name" character varying(100)`);
    await queryRunner.query(`ALTER TABLE "agents" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `ALTER TABLE "agents" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD "status" "public"."agent_status" NOT NULL DEFAULT 'pending'`,
    );
    await queryRunner.query(`ALTER TABLE "agents" ADD "avatar_url" text`);
    await queryRunner.query(`
            UPDATE "users" SET
                "display_name" = a.display_name,
                "avatar_url" = a.avatar_url,
                "status" = a.status,
                "created_at" = a.created_at,
                "updated_at" = a.updated_at,
                "deleted_at" = a.deleted_at
            FROM "actors" a
            WHERE "users"."id" = a."id";
        `);
    await queryRunner.query(`
            UPDATE "agents" SET
                "avatar_url" = a.avatar_url,
                "status" = a.status::agent_status,
                "created_at" = a.created_at,
                "updated_at" = a.updated_at,
                "deleted_at" = a.deleted_at
            FROM "actors" a
            WHERE "agents"."id" = a."id";
        `);
    await queryRunner.query(`DROP TABLE "actors"`);
    await queryRunner.query(`DROP TYPE "public"."actors_type_enum"`);
    await queryRunner.query(
      `CREATE INDEX "idx_ahb_timestamp" ON "agent_heartbeats" ("timestamp") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_ahb_agent_id" ON "agent_heartbeats" ("agent_id", "timestamp") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_action" ON "audit_logs" ("action", "created_at") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_audit_created" ON "audit_logs" ("created_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_audit_actor" ON "audit_logs" ("actor_id", "actor_type", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_entity" ON "audit_logs" ("entity_type", "entity_id", "created_at") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_events_board_id" ON "events" ("board_id") `);
    await queryRunner.query(`CREATE INDEX "idx_events_topic_id" ON "events" ("topic_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_events_actor" ON "events" ("actor_id", "actor_type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_events_delivered" ON "events" ("delivered") WHERE (delivered = false)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_events_type_created" ON "events" ("event_type", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_events_resource" ON "events" ("resource_type", "resource_id") `,
    );
    await queryRunner.query(`CREATE INDEX "idx_events_cursor" ON "events" ("cursor") `);
    await queryRunner.query(
      `CREATE INDEX "idx_topics_status_created" ON "topics" ("status", "created_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_topics_deleted_at" ON "topics" ("deleted_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_topics_last_message" ON "topics" ("last_message_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_topics_creator" ON "topics" ("creator_id", "creator_type") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_topics_status" ON "topics" ("status") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_boards_deleted_at" ON "boards" ("deleted_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_boards_creator" ON "boards" ("creator_id", "creator_type") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_boards_topic_id" ON "boards" ("topic_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_board_list_mapped_status_unique" ON "board_lists" ("board_id", "mapped_status") WHERE ((mapped_status IS NOT NULL) AND (deleted_at IS NULL))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_board_lists_deleted_at" ON "board_lists" ("deleted_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_board_lists_position" ON "board_lists" ("board_id", "position") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_board_lists_board_id" ON "board_lists" ("board_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_tasks_milestone_id" ON "tasks" ("milestone_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_status_priority" ON "tasks" ("status", "priority") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_tasks_search" ON "tasks" ("search_vector") `);
    await queryRunner.query(`CREATE INDEX "idx_tasks_deleted_at" ON "tasks" ("deleted_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_parent_id" ON "tasks" ("parent_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_due_date" ON "tasks" ("due_date") WHERE ((deleted_at IS NULL) AND (completed_at IS NULL))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_priority" ON "tasks" ("priority") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_status" ON "tasks" ("status") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_assignee" ON "tasks" ("assignee_id", "assignee_type") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_topic_id" ON "tasks" ("topic_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tasks_list_id" ON "tasks" ("list_id", "position") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_milestones_topic_id" ON "milestones" ("topic_id") `);
    await queryRunner.query(
      `CREATE INDEX "idx_task_dependencies_depends_on" ON "task_dependencies" ("depends_on_task_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_task_dependencies_unique" ON "task_dependencies" ("task_id", "depends_on_task_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_task_activities_created" ON "task_activities" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_task_activities_task_id" ON "task_activities" ("task_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_task_comments_deleted_at" ON "task_comments" ("deleted_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_task_comments_author" ON "task_comments" ("author_id", "author_type") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_task_comments_task_id" ON "task_comments" ("task_id", "created_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_messages_search" ON "messages" ("search_vector") `);
    await queryRunner.query(`CREATE INDEX "idx_messages_deleted_at" ON "messages" ("deleted_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_messages_created_at" ON "messages" ("created_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_messages_type" ON "messages" ("type") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_messages_reply_to" ON "messages" ("reply_to_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_messages_sender" ON "messages" ("sender_id", "sender_type", "created_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_messages_topic_id" ON "messages" ("topic_id", "created_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tp_active" ON "topic_participants" ("topic_id", "is_active") WHERE (is_active = true)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tp_participant" ON "topic_participants" ("participant_id", "participant_type") WHERE (is_active = true)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_tp_topic_id" ON "topic_participants" ("topic_id") WHERE (is_active = true)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_wd_created" ON "webhook_deliveries" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_wd_next_retry" ON "webhook_deliveries" ("next_retry_at") WHERE (status = 'pending'::webhook_status)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_wd_status" ON "webhook_deliveries" ("status") WHERE (status = 'pending'::webhook_status)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_wd_agent_id" ON "webhook_deliveries" ("agent_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_role" ON "users" ("role") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_users_deleted_at" ON "users" ("deleted_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_users_status" ON "users" ("status") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_email" ON "users" ("email") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_users_username" ON "users" ("username") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_user_id" ON "refresh_tokens" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agents_last_active" ON "agents" ("last_active_at") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(`CREATE INDEX "idx_agents_deleted_at" ON "agents" ("deleted_at") `);
    await queryRunner.query(
      `CREATE INDEX "idx_agents_status" ON "agents" ("status") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_agents_owner_id" ON "agents" ("owner_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_api_keys_revoked" ON "api_keys" ("revoked_at", "deleted_at") WHERE ((revoked_at IS NULL) AND (deleted_at IS NULL))`,
    );
    await queryRunner.query(`CREATE INDEX "idx_api_keys_key_hash" ON "api_keys" ("key_hash") `);
    await queryRunner.query(
      `CREATE INDEX "idx_api_keys_agent_id" ON "api_keys" ("agent_id") WHERE (deleted_at IS NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent_heartbeats" ADD CONSTRAINT "agent_heartbeats_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "boards" ADD CONSTRAINT "boards_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "board_lists" ADD CONSTRAINT "board_lists_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "board_lists"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "task_comments"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "messages_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_participants" ADD CONSTRAINT "topic_participants_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
