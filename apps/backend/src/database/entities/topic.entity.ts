/**
 * [前端 Response] apps/web/src/types/index.ts (Topic / TopicDetail interface)
 * [注意] 修改字段时需同步检查前端 Topic Response 类型
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { TopicStatus, ActorType } from '@agent-chamber/shared';
import { TopicParticipant } from './topic-participant.entity';
import { Message } from './message.entity';
import { Board } from './board.entity';

@Entity('topics')
@Index(['status'])
@Index(['creatorId'])
export class Topic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'jsonb', default: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agenda: Record<string, any>[];

  @Column({
    type: 'enum',
    enum: TopicStatus,
    enumName: 'topic_status',
    default: TopicStatus.DRAFT,
  })
  status: TopicStatus;

  @Column({ type: 'jsonb', default: { allow_agent_proposal: true, vote_threshold: 3 } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: Record<string, any>;

  @Column({ type: 'uuid', nullable: false, name: 'creator_id' })
  creatorId: string;

  /** 创建者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  creatorType: ActorType;

  @Column({ type: 'int', default: 0, name: 'message_count' })
  messageCount: number;

  @Column({ type: 'int', default: 0, name: 'participant_count' })
  participantCount: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_message_at' })
  lastMessageAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @OneToMany(() => TopicParticipant, (tp) => tp.topic)
  participants: TopicParticipant[];

  @OneToMany(() => Message, (message) => message.topic)
  messages: Message[];

  @OneToMany(() => Board, (board) => board.topic)
  boards: Board[];
}
