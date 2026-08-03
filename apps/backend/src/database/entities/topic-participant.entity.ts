/**
 * [前端 Response] apps/web/src/types/index.ts (TopicParticipant interface)
 * [注意] 修改字段时需同步检查前端 TopicParticipant Response 类型
 */
import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ActorType } from '@agent-chamber/shared';
import { Topic } from './topic.entity';

@Entity('topic_participants')
@Index(['topicId'])
@Index(['participantId'])
export class TopicParticipant {
  @PrimaryColumn({ type: 'uuid', name: 'topic_id' })
  topicId: string;

  @PrimaryColumn({ type: 'uuid', name: 'participant_id' })
  participantId: string;

  /** 参与者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  participantType: ActorType;

  @Column({ type: 'varchar', length: 30, default: 'member' })
  role: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'joined_at' })
  joinedAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'left_at' })
  leftAt: Date | null;

  /**
   * 参与者状态（单一事实源，替代 isActive）
   * - invited: 已被邀请但尚未 join
   * - active: 活跃参与者（已 join）
   * - left: 已离开/被移除（保留历史行）
   */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string;

  @Column({
    type: 'jsonb',
    default: { mute: false, mentions_only: false },
    name: 'notification_settings',
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notificationSettings: Record<string, any>;

  /** 该参与者在该话题中最后阅读的消息 ID，用于未读计数 */
  @Column({ type: 'uuid', nullable: true, name: 'last_read_message_id' })
  lastReadMessageId: string | null;

  @ManyToOne(() => Topic, (topic) => topic.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic;
}
