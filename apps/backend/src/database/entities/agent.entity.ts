/**
 * [前端 Response] apps/web/src/types/index.ts (Agent interface)
 * [注意] 修改字段时需同步检查前端 Agent Response 类型
 *
 * Agent 已降级为 agent profile 子类，公共字段上提到 Actor。
 * 通过 getter/setter 保持对旧代码的兼容（avatarUrl/status/createdAt/updatedAt/deletedAt）。
 */
import {
  Entity,
  Column,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { AgentStatus, EventType } from '@agent-chamber/shared';
import { Actor } from './actor.entity';
import { User } from './user.entity';
import { ApiKey } from './api-key.entity';
import { WebhookDelivery } from './webhook-delivery.entity';

@Entity('agents')
@Index(['ownerId'])
export class Agent {
  /** 主键即外键，指向 actors.id */
  @PrimaryColumn('uuid')
  id: string;

  @OneToOne(() => Actor, (actor) => actor.agent, { eager: true, cascade: true })
  @JoinColumn({ name: 'id' })
  actor: Actor;

  get avatarUrl(): string | null {
    return this.actor?.avatarUrl ?? null;
  }

  set avatarUrl(value: string | null) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.avatarUrl = value;
  }

  get status(): AgentStatus {
    return (this.actor?.status as AgentStatus) ?? AgentStatus.PENDING;
  }

  set status(value: AgentStatus) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.status = value;
  }

  get createdAt(): Date {
    return this.actor?.createdAt;
  }

  set createdAt(value: Date) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.createdAt = value;
  }

  get updatedAt(): Date {
    return this.actor?.updatedAt;
  }

  set updatedAt(value: Date) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.updatedAt = value;
  }

  get deletedAt(): Date | null {
    return this.actor?.deletedAt ?? null;
  }

  set deletedAt(value: Date | null) {
    if (!this.actor) {
      this.actor = new Actor();
    }
    this.actor.deletedAt = value;
  }

  @Column({ type: 'uuid', nullable: false, name: 'owner_id' })
  ownerId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true, name: 'webhook_url' })
  webhookUrl: string | null;

  @Column({ type: 'text', nullable: true, name: 'webhook_secret', select: false })
  webhookSecret: string | null;

  @Column({
    type: 'enum',
    enum: EventType,
    enumName: 'event_type',
    array: true,
    default: [EventType.NEW_MESSAGE, EventType.MENTION, EventType.TASK_UPDATE],
    name: 'webhook_events',
  })
  webhookEvents: EventType[];

  @Column({ type: 'int', default: 30000, name: 'webhook_timeout_ms' })
  webhookTimeoutMs: number;

  @Column({ type: 'int', default: 3, name: 'webhook_retry_max' })
  webhookRetryMax: number;

  @Column({ type: 'text', array: true, nullable: true })
  capabilities: string[] | null;

  @Column({ type: 'text', nullable: true, name: 'system_prompt' })
  systemPrompt: string | null;

  @Column({ type: 'jsonb', default: {}, name: 'model_config' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelConfig: Record<string, any>;

  @Column({ type: 'jsonb', default: { requests_per_minute: 60, tokens_per_day: 100000 } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rateLimit: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_active_at' })
  lastActiveAt: Date | null;

  @Column({ type: 'varchar', length: 30, nullable: true })
  version: string | null;

  @ManyToOne(() => User, (user) => user.agents, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'owner_id' })
  owner: User;

  @OneToMany(() => ApiKey, (apiKey) => apiKey.agent)
  apiKeys: ApiKey[];

  @OneToMany(() => WebhookDelivery, (wd) => wd.agent)
  webhookDeliveries: WebhookDelivery[];
}
