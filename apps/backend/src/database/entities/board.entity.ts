/**
 * [前端 Response] apps/web/src/types/index.ts (Board / BoardDetail interface)
 * [注意] 修改字段时需同步检查前端 Board Response 类型
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
import { ActorType } from '@agent-chamber/shared';
import { Topic } from './topic.entity';
import { BoardList } from './board-list.entity';

@Entity('boards')
@Index(['topicId'])
@Index(['creatorId'])
export class Board {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, name: 'topic_id' })
  topicId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 7, default: '#6366f1' })
  color: string;

  @Column({ type: 'uuid', nullable: false, name: 'creator_id' })
  creatorId: string;

  /** 创建者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  creatorType: ActorType;

  @Column({ type: 'jsonb', default: { archived_lists_visible: false, allow_wip_limit: true } })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: Record<string, any>;

  @Column({ type: 'int', default: 0, name: 'task_count' })
  taskCount: number;

  @Column({ type: 'int', default: 0, name: 'completed_task_count' })
  completedTaskCount: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @ManyToOne(() => Topic, (topic) => topic.boards, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'topic_id' })
  topic: Topic | null;

  @OneToMany(() => BoardList, (list) => list.board)
  lists: BoardList[];
}
