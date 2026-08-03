/**
 * [前端 Response] apps/web/src/types/index.ts (AuditLog interface)
 * [注意] 修改字段时需同步检查前端 AuditLog Response 类型
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { AuditAction, ActorType } from '@agent-chamber/shared';

@Entity('audit_logs')
@Index(['entityType', 'entityId'])
@Index(['actorId'])
@Index(['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: AuditAction,
    enumName: 'audit_action',
  })
  action: AuditAction;

  @Column({ type: 'varchar', length: 50, nullable: false, name: 'entity_type' })
  entityType: string;

  @Column({ type: 'uuid', nullable: false, name: 'entity_id' })
  entityId: string;

  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  /** 执行者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  actorType: ActorType | null;

  @Column({ type: 'jsonb', nullable: true, name: 'old_data' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldData: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true, name: 'new_data' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newData: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diff: Record<string, any> | null;

  @Column({ type: 'inet', nullable: true, name: 'ip_address' })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'request_id' })
  requestId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'session_id' })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 30, default: 'api' })
  source: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
