/**
 * [前端 Response] apps/web/src/types/index.ts (Message interface)
 * [注意] 修改字段时需同步检查前端 Message Response 类型
 * [差异] 前端 senderName/senderAvatar 由 Service 层注入，本 Entity 中不存在
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { MessageType, ActorType } from '@agent-chamber/shared';
import { Topic } from './topic.entity';

@Entity('messages')
@Index(['topicId'])
@Index(['senderId'])
@Index(['replyToId'])
@Index(['type'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'topic_id' })
  topicId: string;

  @Column({ type: 'uuid', nullable: false, name: 'sender_id' })
  senderId: string;

  /** 发送者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  senderType: ActorType;

  @Column({
    type: 'enum',
    enum: MessageType,
    enumName: 'message_type',
    default: MessageType.CHAT,
  })
  type: MessageType;

  @Column({ type: 'text', nullable: false })
  content: string;

  @Column({ type: 'varchar', length: 20, default: 'markdown', name: 'content_format' })
  contentFormat: string;

  @Column({ type: 'jsonb', default: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mentions: Record<string, any>[];

  @Column({ type: 'jsonb', default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>;

  @Column({ type: 'uuid', nullable: true, name: 'reply_to_id' })
  replyToId: string | null;

  @Column({ type: 'int', default: 0, name: 'reply_count' })
  replyCount: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'edited_at' })
  editedAt: Date | null;

  @Column({ type: 'jsonb', default: [], name: 'edit_history' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editHistory: Record<string, any>[];

  @Column({ type: 'tsvector', nullable: true, name: 'search_vector', select: false })
  searchVector: string | null;

  @Column({ type: 'int', nullable: true, name: 'sort_order' })
  sortOrder: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @ManyToOne(() => Topic, (topic) => topic.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic;

  @ManyToOne(() => Message, (message) => message.replies, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reply_to_id' })
  replyTo: Message | null;

  @OneToMany(() => Message, (message) => message.replyTo)
  replies: Message[];
}
