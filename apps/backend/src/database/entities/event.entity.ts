import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { EventType, ActorType } from '@agent-chamber/shared';

@Entity('events')
@Index(['cursor'])
@Index(['resourceType', 'resourceId'])
@Index(['eventType', 'createdAt'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: EventType,
    enumName: 'event_type',
    name: 'event_type',
  })
  eventType: EventType;

  @Column({ type: 'varchar', length: 50, nullable: false, name: 'resource_type' })
  resourceType: string;

  @Column({ type: 'uuid', nullable: false, name: 'resource_id' })
  resourceId: string;

  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actorId: string | null;

  /** 执行者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  actorType: ActorType | null;

  @Column({ type: 'uuid', nullable: true, name: 'topic_id' })
  topicId: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'board_id' })
  boardId: string | null;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;

  @Column({ type: 'bigint', name: 'cursor' })
  cursor: string;

  @Column({ type: 'boolean', default: false })
  delivered: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'delivered_at' })
  deliveredAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
