import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { EventType, WebhookStatus } from '@agent-chamber/shared';
import { Actor } from './actor.entity';

@Entity('webhook_deliveries')
@Index(['agentId'])
@Index(['status'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'agent_id' })
  agentId: string;

  @Column({
    type: 'enum',
    enum: EventType,
    enumName: 'event_type',
    name: 'event_type',
  })
  eventType: EventType;

  @Column({ type: 'jsonb', nullable: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;

  @Column({ type: 'int', nullable: true, name: 'payload_size_bytes' })
  payloadSizeBytes: number | null;

  @Column({ type: 'text', nullable: false, name: 'target_url' })
  targetUrl: string;

  @Column({ type: 'varchar', length: 10, default: 'POST' })
  method: string;

  @Column({ type: 'jsonb', default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers: Record<string, any>;

  @Column({ type: 'text', nullable: true, name: 'request_body' })
  requestBody: string | null;

  @Column({ type: 'int', nullable: true, name: 'response_status' })
  responseStatus: number | null;

  @Column({ type: 'text', nullable: true, name: 'response_body' })
  responseBody: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'response_headers' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseHeaders: Record<string, any> | null;

  @Column({ type: 'int', nullable: true, name: 'response_time_ms' })
  responseTimeMs: number | null;

  @Column({
    type: 'enum',
    enum: WebhookStatus,
    enumName: 'webhook_status',
    default: WebhookStatus.PENDING,
  })
  status: WebhookStatus;

  @Column({ type: 'int', default: 0, name: 'retry_count' })
  retryCount: number;

  @Column({ type: 'int', default: 3, name: 'max_retries' })
  maxRetries: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'next_retry_at' })
  nextRetryAt: Date | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'failed_at' })
  failedAt: Date | null;

  @ManyToOne(() => Actor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent: Actor;
}
