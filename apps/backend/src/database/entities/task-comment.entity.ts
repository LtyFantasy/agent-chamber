/**
 * [前端 Response] apps/web/src/types/index.ts (Comment interface)
 * [注意] 修改字段时需同步检查前端 Comment Response 类型
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
  Index,
  OneToMany,
} from 'typeorm';
import { ActorType } from '@agent-chamber/shared';
import { Task } from './task.entity';

@Entity('task_comments')
@Index(['taskId'])
@Index(['authorId'])
export class TaskComment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false, name: 'task_id' })
  taskId: string;

  @Column({ type: 'uuid', nullable: false, name: 'author_id' })
  authorId: string;

  /** 作者类型，已从数据库列转为内存字段，由 Service 在需要时填充 */
  authorType: ActorType;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'author_name' })
  authorName: string | null;

  @Column({ type: 'text', nullable: false })
  content: string;

  @Column({ type: 'varchar', length: 20, default: 'markdown', name: 'content_format' })
  contentFormat: string;

  @Column({ type: 'uuid', nullable: true, name: 'reply_to_id' })
  replyToId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at', select: false })
  deletedAt: Date | null;

  @ManyToOne(() => Task, (task) => task.comments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @ManyToOne(() => TaskComment, (comment) => comment.replies, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reply_to_id' })
  replyTo: TaskComment | null;

  @OneToMany(() => TaskComment, (comment) => comment.replyTo)
  replies: TaskComment[];
}
