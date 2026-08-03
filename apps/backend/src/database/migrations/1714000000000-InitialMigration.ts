import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialMigration1714000000000 implements MigrationInterface {
  name = 'InitialMigration1714000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =====================================================
    // 1. Extensions
    // =====================================================
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // =====================================================
    // 2. Enums
    // =====================================================
    await queryRunner.query(`
      CREATE TYPE user_role AS ENUM ('admin', 'observer')
    `);
    await queryRunner.query(`
      CREATE TYPE agent_status AS ENUM ('active', 'disabled', 'pending')
    `);
    await queryRunner.query(`
      CREATE TYPE topic_status AS ENUM ('draft', 'open', 'active', 'voting', 'paused', 'closed', 'archived')
    `);
    await queryRunner.query(`
      CREATE TYPE message_type AS ENUM ('chat', 'proposal', 'vote', 'task', 'system', 'artifact', 'status_update', 'thinking')
    `);
    await queryRunner.query(`
      CREATE TYPE task_status AS ENUM ('backlog', 'todo', 'in_progress', 'review', 'done', 'blocked', 'archived')
    `);
    await queryRunner.query(`
      CREATE TYPE event_type AS ENUM ('new_message', 'task_update', 'mention', 'topic_status_change', 'system', 'agent_joined', 'agent_left', 'task_assigned')
    `);
    await queryRunner.query(`
      CREATE TYPE actor_type AS ENUM ('human', 'agent', 'system')
    `);
    await queryRunner.query(`
      CREATE TYPE priority AS ENUM ('p0', 'p1', 'p2', 'p3')
    `);
    await queryRunner.query(`
      CREATE TYPE webhook_status AS ENUM ('pending', 'success', 'failed')
    `);
    await queryRunner.query(`
      CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete', 'login', 'logout', 'reset_api_key', 'toggle_agent', 'pause_topic', 'resume_topic')
    `);

    // =====================================================
    // 3. Tables
    // =====================================================

    // users
    await queryRunner.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255),
        auth_provider VARCHAR(30) DEFAULT 'local',
        auth_provider_id VARCHAR(255),
        display_name VARCHAR(100),
        avatar_url TEXT,
        role user_role NOT NULL DEFAULT 'observer',
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        preferences JSONB DEFAULT '{}',
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ,
        CONSTRAINT uq_users_username UNIQUE (username),
        CONSTRAINT uq_users_email UNIQUE (email)
      )
    `);

    // refresh_tokens (CRITICAL - must not be omitted)
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // agents
    await queryRunner.query(`
      CREATE TABLE agents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        avatar_url TEXT,
        webhook_url TEXT,
        webhook_secret TEXT,
        webhook_events event_type[] DEFAULT '{new_message,mention,task_update}',
        webhook_timeout_ms INT DEFAULT 30000,
        webhook_retry_max INT DEFAULT 3,
        capabilities TEXT[],
        system_prompt TEXT,
        model_config JSONB DEFAULT '{}',
        rate_limit JSONB DEFAULT '{"requests_per_minute": 60, "tokens_per_day": 100000}',
        status agent_status NOT NULL DEFAULT 'pending',
        last_active_at TIMESTAMPTZ,
        version VARCHAR(30),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // api_keys
    await queryRunner.query(`
      CREATE TABLE api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        key_hash VARCHAR(255) NOT NULL,
        key_prefix VARCHAR(8) NOT NULL,
        name VARCHAR(100) NOT NULL,
        permissions JSONB DEFAULT '{"scopes": ["read", "write"]}',
        ip_whitelist INET[],
        last_used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        deleted_at TIMESTAMPTZ
      )
    `);

    // topics
    await queryRunner.query(`
      CREATE TABLE topics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        agenda JSONB DEFAULT '[]',
        status topic_status NOT NULL DEFAULT 'draft',
        settings JSONB DEFAULT '{"allow_agent_proposal": true, "vote_threshold": 3}',
        creator_id UUID NOT NULL,
        creator_type actor_type NOT NULL DEFAULT 'human',
        message_count INT NOT NULL DEFAULT 0,
        participant_count INT NOT NULL DEFAULT 0,
        last_message_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // topic_participants
    await queryRunner.query(`
      CREATE TABLE topic_participants (
        topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        participant_id UUID NOT NULL,
        participant_type actor_type NOT NULL DEFAULT 'human',
        role VARCHAR(30) NOT NULL DEFAULT 'member',
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        left_at TIMESTAMPTZ,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notification_settings JSONB DEFAULT '{"mute": false, "mentions_only": false}',
        PRIMARY KEY (topic_id, participant_id, participant_type)
      )
    `);

    // messages
    await queryRunner.query(`
      CREATE TABLE messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL,
        sender_type actor_type NOT NULL DEFAULT 'human',
        type message_type NOT NULL DEFAULT 'chat',
        content TEXT NOT NULL,
        content_format VARCHAR(20) NOT NULL DEFAULT 'markdown',
        mentions JSONB DEFAULT '[]',
        metadata JSONB DEFAULT '{}',
        reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        reply_count INT NOT NULL DEFAULT 0,
        edited_at TIMESTAMPTZ,
        edit_history JSONB DEFAULT '[]',
        search_vector TSVECTOR,
        sort_order INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // boards
    await queryRunner.query(`
      CREATE TABLE boards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        color VARCHAR(7) DEFAULT '#6366f1',
        creator_id UUID NOT NULL,
        creator_type actor_type NOT NULL DEFAULT 'human',
        settings JSONB DEFAULT '{"archived_lists_visible": false, "allow_wip_limit": true}',
        task_count INT NOT NULL DEFAULT 0,
        completed_task_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // board_lists
    await queryRunner.query(`
      CREATE TABLE board_lists (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        position INT NOT NULL DEFAULT 0,
        wip_limit INT,
        mapped_status task_status,
        color VARCHAR(7) DEFAULT '#e5e7eb',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // tasks
    await queryRunner.query(`
      CREATE TABLE tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        list_id UUID NOT NULL REFERENCES board_lists(id) ON DELETE CASCADE,
        topic_id UUID REFERENCES topics(id) ON DELETE SET NULL,
        parent_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        description_format VARCHAR(20) DEFAULT 'markdown',
        status task_status NOT NULL DEFAULT 'backlog',
        priority priority NOT NULL DEFAULT 'p2',
        assignee_id UUID,
        assignee_type actor_type,
        due_date TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        estimated_hours DECIMAL(6,2),
        actual_hours DECIMAL(6,2),
        labels TEXT[],
        cover_image_url TEXT,
        position INT NOT NULL DEFAULT 0,
        custom_fields JSONB DEFAULT '{}',
        search_vector TSVECTOR,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // task_comments
    await queryRunner.query(`
      CREATE TABLE task_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author_id UUID NOT NULL,
        author_type actor_type NOT NULL DEFAULT 'human',
        content TEXT NOT NULL,
        content_format VARCHAR(20) DEFAULT 'markdown',
        reply_to_id UUID REFERENCES task_comments(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);

    // task_activities
    await queryRunner.query(`
      CREATE TABLE task_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        action VARCHAR(50) NOT NULL,
        field_name VARCHAR(50),
        old_value TEXT,
        new_value TEXT,
        meta JSONB DEFAULT '{}',
        actor_id UUID NOT NULL,
        actor_type actor_type NOT NULL DEFAULT 'human',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // events (non-partitioned for MVP)
    await queryRunner.query(`
      CREATE TABLE events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type event_type NOT NULL,
        resource_type VARCHAR(50) NOT NULL,
        resource_id UUID NOT NULL,
        actor_id UUID,
        actor_type actor_type,
        payload JSONB NOT NULL DEFAULT '{}',
        cursor BIGSERIAL,
        delivered BOOLEAN NOT NULL DEFAULT FALSE,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // agent_heartbeats
    await queryRunner.query(`
      CREATE TABLE agent_heartbeats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        status agent_status NOT NULL,
        latency_ms INT,
        memory_mb INT,
        cpu_percent DECIMAL(5,2),
        active_tasks INT DEFAULT 0,
        queue_depth INT DEFAULT 0,
        processed_events INT DEFAULT 0,
        error_count INT DEFAULT 0,
        last_error TEXT,
        last_error_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}',
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // audit_logs
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        action audit_action NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id UUID NOT NULL,
        actor_id UUID,
        actor_type actor_type,
        old_data JSONB,
        new_data JSONB,
        diff JSONB,
        ip_address INET,
        user_agent TEXT,
        request_id UUID,
        session_id VARCHAR(255),
        source VARCHAR(30) DEFAULT 'api',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // webhook_deliveries
    await queryRunner.query(`
      CREATE TABLE webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        event_type event_type NOT NULL,
        payload JSONB NOT NULL,
        payload_size_bytes INT,
        target_url TEXT NOT NULL,
        method VARCHAR(10) NOT NULL DEFAULT 'POST',
        headers JSONB DEFAULT '{}',
        request_body TEXT,
        response_status INT,
        response_body TEXT,
        response_headers JSONB,
        response_time_ms INT,
        status webhook_status NOT NULL DEFAULT 'pending',
        retry_count INT NOT NULL DEFAULT 0,
        max_retries INT NOT NULL DEFAULT 3,
        next_retry_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ
      )
    `);

    // =====================================================
    // 4. Indexes
    // =====================================================
    // users
    await queryRunner.query(
      `CREATE INDEX idx_users_username ON users(username) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_users_status ON users(status) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_users_deleted_at ON users(deleted_at)`);
    await queryRunner.query(`CREATE INDEX idx_users_role ON users(role) WHERE deleted_at IS NULL`);

    // refresh_tokens
    await queryRunner.query(`CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id)`);
    await queryRunner.query(
      `CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens(token_hash)`,
    );

    // agents
    await queryRunner.query(
      `CREATE INDEX idx_agents_owner_id ON agents(owner_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_agents_status ON agents(status) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_agents_deleted_at ON agents(deleted_at)`);
    await queryRunner.query(
      `CREATE INDEX idx_agents_last_active ON agents(last_active_at DESC) WHERE deleted_at IS NULL`,
    );

    // api_keys
    await queryRunner.query(
      `CREATE INDEX idx_api_keys_agent_id ON api_keys(agent_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash)`);
    await queryRunner.query(
      `CREATE INDEX idx_api_keys_revoked ON api_keys(revoked_at, deleted_at) WHERE revoked_at IS NULL AND deleted_at IS NULL`,
    );

    // topics
    await queryRunner.query(
      `CREATE INDEX idx_topics_status ON topics(status) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_topics_creator ON topics(creator_id, creator_type) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_topics_last_message ON topics(last_message_at DESC NULLS LAST) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_topics_deleted_at ON topics(deleted_at)`);
    await queryRunner.query(
      `CREATE INDEX idx_topics_status_created ON topics(status, created_at DESC) WHERE deleted_at IS NULL`,
    );

    // topic_participants
    await queryRunner.query(
      `CREATE INDEX idx_tp_topic_id ON topic_participants(topic_id) WHERE is_active = TRUE`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tp_participant ON topic_participants(participant_id, participant_type) WHERE is_active = TRUE`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tp_active ON topic_participants(topic_id, is_active) WHERE is_active = TRUE`,
    );

    // messages
    await queryRunner.query(
      `CREATE INDEX idx_messages_topic_id ON messages(topic_id, created_at DESC) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_messages_sender ON messages(sender_id, sender_type, created_at DESC) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_messages_reply_to ON messages(reply_to_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_messages_type ON messages(type) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_messages_created_at ON messages(created_at DESC) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_messages_deleted_at ON messages(deleted_at)`);
    await queryRunner.query(
      `CREATE INDEX idx_messages_search ON messages USING GIN(search_vector)`,
    );

    // boards
    await queryRunner.query(
      `CREATE INDEX idx_boards_topic_id ON boards(topic_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_boards_creator ON boards(creator_id, creator_type) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_boards_deleted_at ON boards(deleted_at)`);

    // board_lists
    await queryRunner.query(
      `CREATE INDEX idx_board_lists_board_id ON board_lists(board_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_board_lists_position ON board_lists(board_id, position) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_board_lists_deleted_at ON board_lists(deleted_at)`);

    // tasks
    await queryRunner.query(
      `CREATE INDEX idx_tasks_list_id ON tasks(list_id, position) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tasks_topic_id ON tasks(topic_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, assignee_type) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tasks_status ON tasks(status) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tasks_priority ON tasks(priority) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tasks_due_date ON tasks(due_date) WHERE deleted_at IS NULL AND completed_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_tasks_parent_id ON tasks(parent_id) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(`CREATE INDEX idx_tasks_deleted_at ON tasks(deleted_at)`);
    await queryRunner.query(`CREATE INDEX idx_tasks_search ON tasks USING GIN(search_vector)`);
    await queryRunner.query(
      `CREATE INDEX idx_tasks_status_priority ON tasks(status, priority) WHERE deleted_at IS NULL`,
    );

    // task_comments
    await queryRunner.query(
      `CREATE INDEX idx_task_comments_task_id ON task_comments(task_id, created_at DESC) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_task_comments_author ON task_comments(author_id, author_type) WHERE deleted_at IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_task_comments_deleted_at ON task_comments(deleted_at)`,
    );

    // task_activities
    await queryRunner.query(
      `CREATE INDEX idx_task_activities_task_id ON task_activities(task_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_task_activities_created ON task_activities(created_at DESC)`,
    );

    // events
    await queryRunner.query(`CREATE INDEX idx_events_cursor ON events(cursor)`);
    await queryRunner.query(
      `CREATE INDEX idx_events_resource ON events(resource_type, resource_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_events_type_created ON events(event_type, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_events_delivered ON events(delivered) WHERE delivered = FALSE`,
    );
    await queryRunner.query(`CREATE INDEX idx_events_actor ON events(actor_id, actor_type)`);

    // agent_heartbeats
    await queryRunner.query(
      `CREATE INDEX idx_ahb_agent_id ON agent_heartbeats(agent_id, timestamp DESC)`,
    );
    await queryRunner.query(`CREATE INDEX idx_ahb_timestamp ON agent_heartbeats(timestamp DESC)`);

    // audit_logs
    await queryRunner.query(
      `CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_actor ON audit_logs(actor_id, actor_type, created_at DESC)`,
    );
    await queryRunner.query(`CREATE INDEX idx_audit_created ON audit_logs(created_at DESC)`);
    await queryRunner.query(`CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC)`);

    // webhook_deliveries
    await queryRunner.query(
      `CREATE INDEX idx_wd_agent_id ON webhook_deliveries(agent_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_wd_status ON webhook_deliveries(status) WHERE status IN ('pending')`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_wd_next_retry ON webhook_deliveries(next_retry_at) WHERE status = 'pending'`,
    );
    await queryRunner.query(`CREATE INDEX idx_wd_created ON webhook_deliveries(created_at DESC)`);

    // =====================================================
    // 5. Triggers
    // =====================================================
    // Generic updated_at trigger function
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // Bind updated_at triggers
    const updatedAtTables = [
      'users',
      'agents',
      'topics',
      'messages',
      'boards',
      'board_lists',
      'tasks',
      'task_comments',
      'webhook_deliveries',
    ];
    for (const table of updatedAtTables) {
      await queryRunner.query(`
        CREATE TRIGGER trg_${table}_updated_at
        BEFORE UPDATE ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
      `);
    }

    // Topic message stats trigger
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_topic_message_stats()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.deleted_at IS NULL THEN
          UPDATE topics
          SET message_count = message_count + 1,
              last_message_at = NEW.created_at
          WHERE id = NEW.topic_id;
        ELSIF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
          UPDATE topics
          SET message_count = GREATEST(message_count - 1, 0),
              last_message_at = (
                SELECT MAX(created_at)
                FROM messages
                WHERE topic_id = OLD.topic_id AND deleted_at IS NULL
              )
          WHERE id = OLD.topic_id;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_topics_message_stats
      AFTER INSERT OR DELETE OR UPDATE OF deleted_at ON messages
      FOR EACH ROW
      EXECUTE FUNCTION maintain_topic_message_stats()
    `);

    // Topic participant count trigger
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_topic_participant_count()
      RETURNS TRIGGER AS $$
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
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_topics_participant_count
      AFTER INSERT OR DELETE OR UPDATE OF is_active ON topic_participants
      FOR EACH ROW
      EXECUTE FUNCTION maintain_topic_participant_count()
    `);

    // Board task stats trigger
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_board_task_stats()
      RETURNS TRIGGER AS $$
      DECLARE
        v_board_id UUID;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          SELECT bl.board_id INTO v_board_id FROM board_lists bl WHERE bl.id = NEW.list_id;
          UPDATE boards
          SET task_count = task_count + 1,
              completed_task_count = completed_task_count + CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END
          WHERE id = v_board_id;
        ELSIF TG_OP = 'DELETE' THEN
          SELECT bl.board_id INTO v_board_id FROM board_lists bl WHERE bl.id = OLD.list_id;
          UPDATE boards
          SET task_count = GREATEST(task_count - 1, 0),
              completed_task_count = GREATEST(completed_task_count - CASE WHEN OLD.status = 'done' THEN 1 ELSE 0 END, 0)
          WHERE id = v_board_id;
        ELSIF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
          SELECT bl.board_id INTO v_board_id FROM board_lists bl WHERE bl.id = NEW.list_id;
          UPDATE boards
          SET completed_task_count = completed_task_count
            + CASE WHEN NEW.status = 'done' AND OLD.status != 'done' THEN 1 ELSE 0 END
            - CASE WHEN OLD.status = 'done' AND NEW.status != 'done' THEN 1 ELSE 0 END
          WHERE id = v_board_id;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_tasks_board_stats
      AFTER INSERT OR DELETE OR UPDATE OF status, list_id ON tasks
      FOR EACH ROW
      EXECUTE FUNCTION maintain_board_task_stats()
    `);

    // Message reply count trigger
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION maintain_message_reply_count()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.reply_to_id IS NOT NULL THEN
          UPDATE messages SET reply_count = reply_count + 1 WHERE id = NEW.reply_to_id;
        ELSIF TG_OP = 'DELETE' AND OLD.reply_to_id IS NOT NULL THEN
          UPDATE messages SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = OLD.reply_to_id;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_messages_reply_count
      AFTER INSERT OR DELETE ON messages
      FOR EACH ROW
      EXECUTE FUNCTION maintain_message_reply_count()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_messages_reply_count ON messages`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_tasks_board_stats ON tasks`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_topics_participant_count ON topic_participants`,
    );
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_topics_message_stats ON messages`);
    const updatedAtTables = [
      'users',
      'agents',
      'topics',
      'messages',
      'boards',
      'board_lists',
      'tasks',
      'task_comments',
      'webhook_deliveries',
    ];
    for (const table of updatedAtTables) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS trg_${table}_updated_at ON ${table}`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_message_reply_count()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_board_task_stats()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_topic_participant_count()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS maintain_topic_message_stats()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS update_updated_at_column()`);

    // Drop tables
    await queryRunner.query(`DROP TABLE IF EXISTS webhook_deliveries`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_heartbeats`);
    await queryRunner.query(`DROP TABLE IF EXISTS events`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_activities`);
    await queryRunner.query(`DROP TABLE IF EXISTS task_comments`);
    await queryRunner.query(`DROP TABLE IF EXISTS tasks`);
    await queryRunner.query(`DROP TABLE IF EXISTS board_lists`);
    await queryRunner.query(`DROP TABLE IF EXISTS boards`);
    await queryRunner.query(`DROP TABLE IF EXISTS messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS topic_participants`);
    await queryRunner.query(`DROP TABLE IF EXISTS topics`);
    await queryRunner.query(`DROP TABLE IF EXISTS api_keys`);
    await queryRunner.query(`DROP TABLE IF EXISTS agents`);
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_tokens`);
    await queryRunner.query(`DROP TABLE IF EXISTS users`);

    // Drop enums
    await queryRunner.query(`DROP TYPE IF EXISTS webhook_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS audit_action`);
    await queryRunner.query(`DROP TYPE IF EXISTS priority`);
    await queryRunner.query(`DROP TYPE IF EXISTS actor_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS event_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS task_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS message_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS topic_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS agent_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_role`);
  }
}
