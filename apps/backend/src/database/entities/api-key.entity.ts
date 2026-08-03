import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  DeleteDateColumn,
} from 'typeorm';
import { Actor } from './actor.entity';

@Entity('api_keys')
@Index(['keyHash'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'agent_id' })
  agentId: string;

  @Column({ type: 'varchar', length: 255, nullable: false, name: 'key_hash' })
  keyHash: string;

  @Column({ type: 'varchar', length: 8, nullable: false, name: 'key_prefix' })
  keyPrefix: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({ type: 'jsonb', default: { scopes: ['read', 'write'] } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  permissions: Record<string, any>;

  @Column({ type: 'inet', array: true, nullable: true, name: 'ip_whitelist' })
  ipWhitelist: string[] | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_used_at' })
  lastUsedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revokedAt: Date | null;

  @Column({ type: 'text', nullable: true, name: 'revoked_reason' })
  revokedReason: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy: string | null;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @ManyToOne(() => Actor, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'agent_id' })
  agent: Actor;

  @ManyToOne(() => Actor, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator: Actor | null;
}
