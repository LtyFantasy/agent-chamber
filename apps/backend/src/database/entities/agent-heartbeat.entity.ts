import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { AgentStatus } from '@agent-chamber/shared';
import { Actor } from './actor.entity';

@Entity('agent_heartbeats')
@Index(['agentId'])
export class AgentHeartbeat {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'agent_id' })
  agentId: string;

  @Column({
    type: 'enum',
    enum: AgentStatus,
    enumName: 'agent_status',
  })
  status: AgentStatus;

  @Column({ type: 'int', nullable: true, name: 'latency_ms' })
  latencyMs: number | null;

  @Column({ type: 'int', nullable: true, name: 'memory_mb' })
  memoryMb: number | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, name: 'cpu_percent' })
  cpuPercent: number | null;

  @Column({ type: 'int', default: 0, name: 'active_tasks' })
  activeTasks: number;

  @Column({ type: 'int', default: 0, name: 'queue_depth' })
  queueDepth: number;

  @Column({ type: 'int', default: 0, name: 'processed_events' })
  processedEvents: number;

  @Column({ type: 'int', default: 0, name: 'error_count' })
  errorCount: number;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_error_at' })
  lastErrorAt: Date | null;

  @Column({ type: 'jsonb', default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: false })
  timestamp: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => Actor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent: Actor;
}
