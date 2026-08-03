import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('idempotency_records')
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'actor_id' })
  actorId: string;

  @Column({ type: 'varchar', length: 64, nullable: false, name: 'client_request_id' })
  clientRequestId: string;

  @Column({ type: 'varchar', length: 20, nullable: false, name: 'entity_type' })
  entityType: string;

  @Column({ type: 'uuid', nullable: false, name: 'entity_id' })
  entityId: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
